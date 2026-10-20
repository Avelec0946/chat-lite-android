// v125 B9：模拟"老用户"—— 存储里没有 settings.voice，刷新后应被迁移补全
// 需要真实重载页面，所以单独跑一次 CDP。
'use strict';
const jp = function (s) {
  try { return JSON.parse(String(s)); }
  catch (e) { return { __parseError: String(e && e.message), __raw: String(s).slice(0, 400) }; }
};

module.exports = async (ctx) => {
  const { ev, sleep, send, waitFor } = ctx;
  const out = {};

  // 1) 记录当前存储里 voice 的样子，然后删掉它并按真实持久化路径落盘
  out.before = jp(await ev([
    'JSON.stringify({',
    '  hasVoice: !!(settings.voice && typeof settings.voice === "object"),',
    '  lsHasVoice: (function(){ try { var r = localStorage.getItem("chatlite_settings"); if(!r) return "no-mirror";',
    '    var o = JSON.parse(r); return !!o.voice; } catch(e){ return "err:" + e.message; } })(),',
    '  fieldCount: settings.voice ? Object.keys(settings.voice).length : 0',
    '})'
  ].join('\n')));

  // 删字段 → 走 saveSettings()（同时写 IDB + localStorage 镜像）→ 再确认镜像里确实没有 voice
  out.deleted = jp(await ev([
    '(async function(){',
    '  delete settings.voice;',
    '  try { saveSettings(); } catch (e) { return JSON.stringify({ threw: String(e && e.message) }); }',
    '  await new Promise(function(r){ setTimeout(r, 900); });',
    '  var mirror = null, mirrorHasVoice = null;',
    '  try {',
    '    mirror = localStorage.getItem("chatlite_settings");',
    '    mirrorHasVoice = mirror ? ("voice" in JSON.parse(mirror)) : null;',
    '  } catch (e) { mirrorHasVoice = "err:" + e.message; }',
    '  var idbHasVoice = null;',
    '  try {',
    '    var d = await idbGet(SETTINGS_IDB_KEY);',
    '    idbHasVoice = d ? ("voice" in d) : null;',
    '  } catch (e) { idbHasVoice = "err:" + e.message; }',
    '  return JSON.stringify({ inMemoryHasVoice: "voice" in settings, mirrorHasVoice: mirrorHasVoice,',
    '    idbHasVoice: idbHasVoice, mirrorLen: mirror ? mirror.length : 0 });',
    '})()'
  ].join('\n')));

  if (out.deleted.mirrorHasVoice !== false) {
    // 持久化没删干净：后面的"重载迁移"就没意义了，直接如实返回
    out.abort = '存储里仍然存在 voice 字段，重载测试不成立';
    console.log('__MIGRATE_JSON__' + JSON.stringify(out));
    return;
  }

  // 2) 真重载
  await send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  const ready = await waitFor("document.readyState === 'complete' && typeof VoiceCall !== 'undefined' && typeof settings !== 'undefined' && !!settings", 30000);
  await sleep(1500);
  out.readyAfterReload = ready;

  // 3) 重载后检查迁移结果
  out.after = jp(await ev([
    'JSON.stringify({',
    '  hasVoice: !!(settings.voice && typeof settings.voice === "object"),',
    '  fieldCount: settings.voice ? Object.keys(settings.voice).length : 0,',
    '  defaults: settings.voice ? {',
    '    asrModel: settings.voice.asrModel, ttsModel: settings.voice.ttsModel,',
    '    voiceId: settings.voice.voiceId, personaId: settings.voice.personaId,',
    '    enabled: settings.voice.enabled, sensitivity: settings.voice.sensitivity,',
    '    endpointSilenceMs: settings.voice.endpointSilenceMs, minUtteranceMs: settings.voice.minUtteranceMs,',
    '    showTranscript: settings.voice.showTranscript, showSignals: settings.voice.showSignals,',
    '    autoHangupSilenceMs: settings.voice.autoHangupSilenceMs, ttsFormat: settings.voice.ttsFormat,',
    '    autoHangup: settings.voice.autoHangup, voiceProvidersIsArray: Array.isArray(settings.voice.voiceProviders)',
    '  } : null,',
    '  moduleTypes: { VoiceCall: typeof window.VoiceCall, VoiceDirector: typeof window.VoiceDirector,',
    '    VoiceSettings: typeof window.VoiceSettings },',
    '  viewExists: !!document.getElementById("voice-view"),',
    '  errors: window.__migErrors || []',
    '})'
  ].join('\n')));

  // 4) 迁移后通话能不能正常开（不该因缺字段而崩）
  out.usable = jp(await ev([
    '(async function(){',
    '  try {',
    '    var ok = await window.VoiceCall.start();',
    '    await new Promise(function(r){ setTimeout(r, 800); });',
    '    var st = window.VoiceCall.getState();',
    // v126：失败时要能读到原因，否则断言只能看 true/false，无法区分"没配密钥"与"真坏了"
    '    var txt = "";',
    '    try { var el = document.getElementById("voice-state-text"); txt = el ? String(el.textContent || "") : ""; } catch (e) {}',
    '    window.VoiceCall.hangup(); window.VoiceCall.close();',
    '    return JSON.stringify({ start: ok, state: st, text: txt });',
    '  } catch (e) { return JSON.stringify({ threw: String(e && e.message) }); }',
    '})()'
  ].join('\n')));

  console.log('__MIGRATE_JSON__' + JSON.stringify(out));
};
