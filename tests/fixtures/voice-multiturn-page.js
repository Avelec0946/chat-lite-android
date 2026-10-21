// v129：多轮通话回归（headless）
// 目的：验证「不管我说什么回复都一样」真的消失 —— 三轮不同的话，三轮不同的实质性回复。
// 只取数据，断言在 run 脚本里做。
(async function () {
  var K = window.__e2eKeys || {};
  var T = window.VoiceCall.__test;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var st = function () { return window.VoiceCall.getState(); };
  var q = function (id) { return document.getElementById(id); };

  async function makePcm(text) {
    var r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + K.mimo },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        messages: [{ role: 'assistant', content: text }],
        audio: { voice: 'Mia', format: 'pcm' }
      })
    });
    if (!r.ok) throw new Error('tts http ' + r.status);
    var j = await r.json();
    var b64 = j.choices[0].message.audio.data;
    var i16 = T.bytesToInt16(T.base64ToBytes(b64));
    var rs = new T.Resampler(24000, 16000);
    return T.floatToInt16(rs.process(T.int16ToFloat32(i16)));
  }

  var ok = await window.VoiceCall.start();
  if (!ok) return JSON.stringify({ fatal: 'start false', stateText: (q('voice-state-text') || {}).textContent });
  var waited = 0;
  while (waited < 8000) { if (st() === 'listening') break; await sleep(100); waited += 100; }

  var utterances = [
    '今天事情好多，我有点累。',
    '你说我这样一直加班值得吗？',
    '那你呢，你平时会累吗？'
  ];
  var turns = [];

  for (var i = 0; i < utterances.length; i++) {
    var pcm;
    try { pcm = await makePcm(utterances[i]); } catch (e) { turns.push({ i: i, err: String(e && e.message) }); continue; }
    var before = window.VoiceCall.getMetrics().turns;
    window.VoiceCall.__injectUtterance(pcm);
    var t0 = Date.now(), sawThink = false;
    while (Date.now() - t0 < 45000) {
      var s = st();
      if (s === 'thinking') sawThink = true;
      if (s === 'error') break;
      if (s === 'listening' && sawThink && window.VoiceCall.getMetrics().turns > before) break;
      await sleep(120);
    }
    await sleep(300);
    var d = window.VoiceCall.__debug();
    turns.push({
      i: i,
      said: utterances[i],
      asst: (q('voice-line-assistant') || {}).textContent || '',
      state: st(),
      ms: Date.now() - t0,
      brain: d.lastBrain ? {
        mode: d.lastBrain.mode, finish: d.lastBrain.finishReason, rawLen: d.lastBrain.rawLen,
        retried: !!d.lastBrain.retried, fallback: !!d.lastBrain.fallbackUsed,
        diagnosis: d.lastBrain.diagnosis || '', thinkChars: d.lastBrain.thinkingChars,
        prefix: d.lastBrain.prefix || '', raw: String(d.lastBrain.raw || '').slice(0, 200)
      } : null
    });
  }

  // 会话落库内容（回看时看到的就是这些）
  var conv = state.conversations.find(function (c) { return c.id === state.currentId; });
  var tail = (conv.activePath || []).slice(-8).map(function (id) {
    var m = conv.messageMap[id];
    return m ? { role: m.role, src: m.source, txt: String(m.content || '').slice(0, 80) } : null;
  });

  window.VoiceCall.hangup();
  return JSON.stringify({ turns: turns, tail: tail, errors: window.__e2eErrors || [] });
})()
