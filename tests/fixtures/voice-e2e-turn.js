// v125 e2e：start → 注入 → 观察轨迹 → 快照。只取数据，断言在 node 侧做。
(async function () {
  var log = [];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var st = function () { return window.VoiceCall.getState(); };
  var q = function (id) { return document.getElementById(id); };

  var conv0 = state.conversations.find(function (c) { return c.id === state.currentId; });
  var msgs0 = conv0 ? conv0.activePath.length : -1;
  var metrics0 = window.VoiceCall.getMetrics();

  var ok = await window.VoiceCall.start();
  log.push({ k: 'start', v: ok, state: st() });
  if (!ok) {
    return JSON.stringify({ fatal: 'start() returned false', log: log, state: st(),
      stateText: (q('voice-state-text') || {}).textContent || '' });
  }

  var waited = 0;
  while (waited < 8000) { if (st() === 'listening') break; await sleep(100); waited += 100; }
  log.push({ k: 'listening', v: st(), waited: waited });

  var pcm = window.__e2ePcm;
  if (!pcm || !pcm.length) return JSON.stringify({ fatal: 'no pcm to inject', log: log });
  var inj = window.VoiceCall.__injectUtterance(pcm);
  log.push({ k: 'inject', v: inj, samples: pcm.length, ms: Math.round(pcm.length / 16000 * 1000) });

  var seen = [], t0 = Date.now(), sawThink = false, sawSpeak = false, errText = '';
  while (Date.now() - t0 < 45000) {
    var s = st();
    if (seen[seen.length - 1] !== s) seen.push(s);
    if (s === 'thinking') sawThink = true;
    if (s === 'speaking') sawSpeak = true;
    if (s === 'error') { errText = (q('voice-state-text') || {}).textContent || ''; break; }
    if (s === 'listening' && sawThink) break;
    await sleep(120);
  }
  var elapsed = Date.now() - t0;
  var metrics = window.VoiceCall.getMetrics();

  var conv = state.conversations.find(function (c) { return c.id === state.currentId; });
  var added = [];
  if (conv && conv0 && conv.id === conv0.id) {
    conv.activePath.slice(msgs0).forEach(function (id) {
      var m = conv.messageMap[id];
      if (!m) { added.push(null); return; }
      added.push({
        role: m.role, src: m.source, len: (m.content || '').length,
        txt: String(m.content || '').slice(0, 60),
        hasSignals: !!m.voiceSignals,
        signalKeys: m.voiceSignals ? Object.keys(m.voiceSignals) : []
      });
    });
  }

  var lu = q('voice-line-user'), la = q('voice-line-assistant'), sig = q('voice-signals');
  var vis = function (el) { return !!el && el.style.display !== 'none' && el.offsetHeight > 0; };
  return JSON.stringify({
    log: log, seen: seen, sawThink: sawThink, sawSpeak: sawSpeak, errText: errText,
    elapsed: elapsed, state: st(), metrics: metrics, metrics0: metrics0,
    lines: {
      user: lu ? (lu.textContent || '') : null, userVisible: vis(lu),
      asst: la ? (la.textContent || '') : null, asstVisible: vis(la)
    },
    pills: sig ? Array.prototype.map.call(sig.querySelectorAll('.voice-signal'), function (e) { return e.textContent; }) : [],
    added: added, msgCountBefore: msgs0, msgCountAfter: conv ? conv.activePath.length : -1
  });
})()