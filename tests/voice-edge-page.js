// v125 边界与异常：CDP 页面脚本（由 tests/voice-edge.js 执行）
// 每个场景独立「造环境 → 触发 → 观察」，断言在 node 侧做。
'use strict';
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const read = function (n) { return fs.readFileSync(path.join(FIX, n), 'utf8'); };
const jp = function (s) {
  try { return JSON.parse(String(s)); }
  catch (e) { return { __parseError: String(e && e.message), __raw: String(s).slice(0, 400) }; }
};

const ERR_WINDOW_MS = 14000;

module.exports = async (ctx) => {
  const { ev, sleep, shot, send, waitFor } = ctx;
  const out = { cases: {} };

  // ---------------------------------------------------------------- 公共工具
  // ★ 必须先把 key 放进页面：fixtures/voice-e2e-setup.js 读 window.__e2eKeys，
  //   漏了这一步，建出来的渠道 apiKey 是 undefined，后面所有场景都会变成「缺少 API 密钥」，
  //   看起来像产品 bug 其实是测试脚手架 bug（本套件第一版就这么错过一次）。
  await ev('window.__e2eKeys = ' + JSON.stringify({
    mimo: process.env.VOICE_MIMO_KEY || 'sk-ct055gjomfb1sqdddezb1yt3xccvlxfs4q8uzb2lrmdny6xr',
    ds: process.env.VOICE_DS_KEY || 'sk-46cc4725d23f4270a91499f1e9228d94'
  }) + '; 1');
  await ev([
    'window.__e2eErrors = [];',
    "window.addEventListener('error', function(e){ window.__e2eErrors.push('error: ' + (e.message||'')); });",
    "window.addEventListener('unhandledrejection', function(e){ window.__e2eErrors.push('rejection: ' + (e.reason && (e.reason.message||e.reason))); });",
    'window.__h = {',
    '  waitStates: async function (ms, stopAt) {',
    '    var seen = [], t0 = Date.now();',
    '    while (Date.now() - t0 < ms) {',
    '      var s = window.VoiceCall.getState();',
    '      if (seen[seen.length-1] !== s) seen.push(s);',
    '      if (stopAt && stopAt.indexOf(s) >= 0) return { seen: seen, ms: Date.now()-t0, state: s };',
    '      await new Promise(function(r){ setTimeout(r, 80); });',
    '    }',
    '    return { seen: seen, ms: Date.now()-t0, state: window.VoiceCall.getState(), timedOut: true };',
    '  },',
    '  reset: async function () {',
    '    try { window.VoiceCall.hangup(); } catch (e) {}',
    '    try { window.VoiceCall.close(); } catch (e) {}',
    '    await new Promise(function(r){ setTimeout(r, 250); });',
    '    return window.VoiceCall.getState();',
    '  },',
    '  setVoice: function (patch) {',
    '    var v = settings.voice;',
    '    Object.keys(patch).forEach(function (k) {',
    '      if (patch[k] === undefined) delete v[k]; else v[k] = patch[k];',
    '    });',
    '    return JSON.stringify(v);',
    '  },',
    '  mkProvider: function (id, name, base, key) {',
    '    return { id: id, name: name, template: "openai", baseUrl: base, endpointPath: "/v1/chat/completions",',
    '      apiKey: key, authType: "bearer", authHeader: "Authorization", authPrefix: "Bearer ",',
    '      extraHeaders: {}, extraQuery: {}, models: [], features: { supportsStreaming: true } };',
    '  },',
    '  text: function (id) { var e = document.getElementById(id); return e ? (e.textContent||"").trim() : null; },',
    '  toasts: function () {',
    '    var t = document.querySelectorAll(".toast, #toast-container > *, .toast-msg");',
    '    var r = []; for (var i=0;i<t.length;i++) r.push((t[i].textContent||"").trim());',
    '    return r.filter(Boolean);',
    '  },',
    '  tone: function (n) {',
    '    // 正弦波：只用来触发"上游报错"路径，不走真识别',
    '    var pcm = new Int16Array(n||16000);',
    '    for (var i=0;i<pcm.length;i++) pcm[i] = Math.round(6000*Math.sin(2*Math.PI*220*i/16000));',
    '    return pcm;',
    '  },',
    '  pillsAudit: function () {',
    '    var box = document.getElementById("voice-signals");',
    '    if (!box) return null;',
    '    var kids = box.querySelectorAll(".voice-signal");',
    '    var br = box.getBoundingClientRect();',
    '    var items = [];',
    '    for (var i=0;i<kids.length;i++) {',
    '      var r = kids[i].getBoundingClientRect();',
    '      items.push({ text: (kids[i].textContent||""), w: Math.round(r.width),',
    '        left: Math.round(r.left), right: Math.round(r.right) });',
    '    }',
    '    var merged = items.filter(function (x) { return /[·・]/.test(x.text); });',
    '    var overflow = items.filter(function (x) { return x.right > br.right + 1 || x.left < br.left - 1; });',
    '    return { count: items.length, items: items, mergedCount: merged.length,',
    '      mergedTexts: merged.map(function(x){return x.text;}),',
    '      overflowCount: overflow.length, boxW: Math.round(br.width),',
    '      boxLeft: Math.round(br.left), boxRight: Math.round(br.right) };',
    '  }',
    '};',
    '1'
  ].join('\n'));

  // ---------------------------------------------------------------- B1 没配任何渠道
  out.cases.b1 = await (async () => {
    await ev('window.__h.reset()');
    await ev([
      'window.__savedProviders = (state.providers||[]).slice();',
      'window.__savedApiKey = settings.apiKey;',
      'window.__savedConvProv = null;',
      'window.__h.setVoice({ asrProviderId:"", ttsProviderId:"", brainProviderId:"", brainModel:"" });',
      'state.providers = (state.providers||[]).filter(function(p){',
      '  return !/mimo|xiaomi|小米|deepseek|深度求索/i.test((p.name||"")+" "+(p.baseUrl||"")); });',
      'settings.apiKey = "";',
      'var c = state.conversations.find(function(x){return x.id===state.currentId;});',
      'if (c) { window.__savedConvProv = c.providerId; c.providerId = null; }',
      '1'
    ].join('\n'));
    const r = await ev([
      '(async function(){',
      '  var ok = await window.VoiceCall.start();',
      '  // ★ 关键：产品是「懒校验」—— start() 不探测渠道，错误要等真正发请求才暴露。',
      '  //   所以这里必须先等 listening，再注入一句话，才能观察到错误路径。',
      '  var w0 = await window.__h.waitStates(6000, ["listening","error"]);',
      '  var stateAtStart = window.VoiceCall.getState();',
      '  var textAtStart = window.__h.text("voice-state-text");',
      '  var toastsAtStart = window.__h.toasts();',
      '  if (stateAtStart !== "listening") {',
      '    return JSON.stringify({ startOk: ok, failedAtStart: true, stateAtStart: stateAtStart,',
      '      textAtStart: textAtStart, toastsAtStart: toastsAtStart, states: w0.seen,',
      '      state: stateAtStart, stateText: textAtStart, toasts: toastsAtStart });',
      '  }',
      '  window.VoiceCall.__injectUtterance(window.__h.tone(16000));',
      '  var w = await window.__h.waitStates(' + ERR_WINDOW_MS + ', ["error","listening"]);',
      '  await new Promise(function(r){ setTimeout(r, 300); });',
      '  return JSON.stringify({ startOk: ok, states: w.seen, state: window.VoiceCall.getState(),',
      '    stateAtStart: stateAtStart, textAtStart: textAtStart, toastsAtStart: toastsAtStart,',
      '    stateText: window.__h.text("voice-state-text"), toasts: window.__h.toasts(),',
      '    running: window.VoiceCall.isRunning(), timedOut: !!w.timedOut });',
      '})()'
    ].join('\n'));
    await ev([
      'state.providers = window.__savedProviders; settings.apiKey = window.__savedApiKey;',
      'var c = state.conversations.find(function(x){return x.id===state.currentId;});',
      'if (c) c.providerId = window.__savedConvProv;',
      'window.__h.reset();'
    ].join('\n'));
    await ev(read('voice-e2e-setup.js'));
    return jp(r);
  })();

  // ---------------------------------------------------------------- B2 key 是错的
  out.cases.b2 = await (async () => {
    await ev('window.__h.reset()');
    await ev([
      'window.__h.setVoice({ asrProviderId:"bad-mimo", ttsProviderId:"bad-mimo", brainProviderId:"e2e-ds", brainModel:"deepseek-chat" });',
      'state.providers = (state.providers||[]).filter(function(p){return p.id!=="bad-mimo";});',
      'state.providers.push(window.__h.mkProvider("bad-mimo","Bad MiMo","https://api.xiaomimimo.com","sk-invalid-key-for-qa-000000"));',
      '1'
    ].join('\n'));
    const r = await ev([
      '(async function(){',
      '  var ok = await window.VoiceCall.start();',
      '  if (!ok) return JSON.stringify({ startOk:false, state: window.VoiceCall.getState(),',
      '    stateText: window.__h.text("voice-state-text"), toasts: window.__h.toasts() });',
      '  await new Promise(function(r){ setTimeout(r, 400); });',
      '  var inj = window.VoiceCall.__injectUtterance(window.__h.tone(16000));',
      '  var w = await window.__h.waitStates(' + ERR_WINDOW_MS + ', ["error","listening"]);',
      '  await new Promise(function(r){ setTimeout(r, 400); });',
      '  return JSON.stringify({ startOk:true, inj: inj, states: w.seen, state: window.VoiceCall.getState(),',
      '    stateText: window.__h.text("voice-state-text"), toasts: window.__h.toasts(),',
      '    running: window.VoiceCall.isRunning(), timedOut: !!w.timedOut,',
      '    metrics: window.VoiceCall.getMetrics() });',
      '})()'
    ].join('\n'));
    await ev('state.providers = (state.providers||[]).filter(function(p){return p.id!=="bad-mimo";}); window.__h.reset(); 1');
    await ev(read('voice-e2e-setup.js'));
    return jp(r);
  })();

  // ---------------------------------------------------------------- B3 模型名不存在
  out.cases.b3 = await (async () => {
    await ev('window.__h.reset()');
    await ev('window.__h.setVoice({ asrProviderId:"e2e-mimo", ttsProviderId:"e2e-mimo", asrModel:"mimo-not-exist-asr", ttsModel:"mimo-v2.5-tts", brainProviderId:"e2e-ds", brainModel:"deepseek-chat" })');
    const r = await ev([
      '(async function(){',
      '  var ok = await window.VoiceCall.start();',
      '  if (!ok) return JSON.stringify({ startOk:false, state: window.VoiceCall.getState(),',
      '    stateText: window.__h.text("voice-state-text") });',
      '  await new Promise(function(r){ setTimeout(r, 400); });',
      '  window.VoiceCall.__injectUtterance(window.__h.tone(16000));',
      '  var w = await window.__h.waitStates(' + ERR_WINDOW_MS + ', ["error","listening"]);',
      '  await new Promise(function(r){ setTimeout(r, 400); });',
      '  return JSON.stringify({ startOk:true, states: w.seen, state: window.VoiceCall.getState(),',
      '    stateText: window.__h.text("voice-state-text"), toasts: window.__h.toasts(),',
      '    running: window.VoiceCall.isRunning(), timedOut: !!w.timedOut });',
      '})()'
    ].join('\n'));
    await ev('window.__h.reset(); 1');
    await ev(read('voice-e2e-setup.js'));
    return jp(r);
  })();

  // ---------------------------------------------------------------- B4 连续 start() 三次
  out.cases.b4 = await (async () => {
    await ev('window.__h.reset()');
    await ev(read('voice-e2e-setup.js'));
    const r = await ev([
      '(async function(){',
      '  var before = window.VoiceCall.__debug();',
      '  var thrown = [], ps = [];',
      '  for (var i=0;i<3;i++) {',
      '    try { ps.push(window.VoiceCall.start()); } catch (e) { thrown.push(String((e && e.message) || e)); }',
      '  }',
      '  var res = await Promise.all(ps.map(function(p){',
      '    return p.then(function(v){ return v; }, function(e){ return "REJECT:" + (e && e.message); });',
      '  }));',
      '  await new Promise(function(r){ setTimeout(r, 1500); });',
      '  var after = window.VoiceCall.__debug();',
      '  // 采集图单例的旁证：同一时刻只应有一个 script 处理器在工作 —— 用 AudioContext 的采样率与 vad 对象身份侧面看',
      '  var sameVad = null;',
      '  try { sameVad = !!after.vad; } catch (e) {}',
      '  return JSON.stringify({ results: res, thrown: thrown,',
      '    beforeState: before.state, state: window.VoiceCall.getState(),',
      '    afterRunning: after.running, captureRate: after.captureRate,',
      '    vadThr: after.vad && after.vad.thr, sameVad: sameVad,',
      '    activeTracks: (function(){',
      '      // 通过 getUserMedia 再取一次，看设备是否被占用（若前三次没清理会造成 track 泄漏）',
      '      return "n/a";',
      '    })() });',
      '})()'
    ].join('\n'));
    await ev('window.__h.reset(); 1');
    return jp(r);
  })();

  // ---------------------------------------------------------------- B5 speaking 中 interrupt()
  out.cases.b5 = await (async () => {
    await ev('window.__h.reset()');
    await ev(read('voice-e2e-audio.js'));
    const r = await ev([
      '(async function(){',
      '  var ok = await window.VoiceCall.start();',
      '  if (!ok) return JSON.stringify({ startOk:false });',
      '  await new Promise(function(r){ setTimeout(r, 500); });',
      '  window.VoiceCall.__injectUtterance(window.__e2ePcm);',
      '  var w1 = await window.__h.waitStates(25000, ["speaking","error"]);',
      '  if (window.VoiceCall.getState() !== "speaking") {',
      '    return JSON.stringify({ neverSpoke: true, states: w1.seen, state: window.VoiceCall.getState() });',
      '  }',
      '  await new Promise(function(r){ setTimeout(r, 250); });',
      '  var t0 = Date.now();',
      '  var ret = window.VoiceCall.interrupt();',
      '  var dt = Date.now() - t0;',
      '  var s0 = window.VoiceCall.getState();',
      '  await new Promise(function(r){ setTimeout(r, 80); });',
      '  var s1 = window.VoiceCall.getState();',
      '  await new Promise(function(r){ setTimeout(r, 1500); });',
      '  var s2 = window.VoiceCall.getState();',
      '  return JSON.stringify({ ret: ret, interruptMs: dt, stateAtReturn: s0, state80: s1, stateLater: s2,',
      '    statesBefore: w1.seen, metrics: window.VoiceCall.getMetrics(),',
      '    lineAsst: window.__h.text("voice-line-assistant") });',
      '})()'
    ].join('\n'));
    await ev('window.__h.reset(); 1');
    return jp(r);
  })();

  // ---------------------------------------------------------------- B6 start 后立刻 hangup
  out.cases.b6 = await (async () => {
    await ev('window.__h.reset()');
    const r = await ev([
      '(async function(){',
      '  window.VoiceCall.open();',
      '  var t1 = window.__h.text("voice-timer");',
      '  var p = window.VoiceCall.start();',
      '  var h = window.VoiceCall.hangup();',
      '  var ok = await p;',
      '  await new Promise(function(r){ setTimeout(r, 1000); });',
      '  var d1 = window.VoiceCall.__debug();',
      '  var tm1 = window.__h.text("voice-timer");',
      '  await new Promise(function(r){ setTimeout(r, 1600); });',
      '  var d2 = window.VoiceCall.__debug();',
      '  var tm2 = window.__h.text("voice-timer");',
      '  // hangup 只结束通话、不退出视图（UI 的挂断按钮自己再调 close）；单独验证 close',
      '  var openAfterHangup = state.voiceOpen;',
      '  window.VoiceCall.close();',
      '  await new Promise(function(r){ setTimeout(r, 300); });',
      '  return JSON.stringify({ startOk: ok, hangupOk: h, startReturn: ok,',
      '    state1: d1.state, state2: d2.state, running1: d1.running, running2: d2.running,',
      '    timerBefore: t1, timer1: tm1, timer2: tm2, turns1: d1.metrics.turns, turns2: d2.metrics.turns,',
      '    openAfterHangup: openAfterHangup,',
      '    voiceOpen: state.voiceOpen, bodyClass: document.body.className,',
      '    voiceViewDisplay: getComputedStyle(document.getElementById("voice-view")).display });',
      '})()'
    ].join('\n'));
    await ev('window.__h.reset(); 1');
    return jp(r);
  })();

  // ---------------------------------------------------------------- B7 互斥
  out.cases.b7 = await (async () => {
    await ev('window.__h.reset()');
    const r = await ev([
      '(async function(){',
      '  var o = {};',
      '  // ① 通话中打开生图',
      '  window.VoiceCall.open();',
      '  await new Promise(function(r){ setTimeout(r, 150); });',
      '  o.voiceOpenBefore = state.voiceOpen;',
      '  if (typeof toggleImageView === "function") toggleImageView(true);',
      '  await new Promise(function(r){ setTimeout(r, 300); });',
      '  o.imageOpenAfter = state.imageViewOpen;',
      '  o.voiceOpenAfterImage = state.voiceOpen;',
      '  o.voiceViewDisplay = getComputedStyle(document.getElementById("voice-view")).display;',
      '  o.bodyClass = document.body.className;',
      '  o.mainDisplayDuringImage = getComputedStyle(document.getElementById("main")).display;',
      '  if (typeof toggleImageView === "function") toggleImageView(false);',
      '  window.VoiceCall.close();',
      '  await new Promise(function(r){ setTimeout(r, 250); });',
      '  // ② 生图中调用 open()',
      '  if (typeof toggleImageView === "function") toggleImageView(true);',
      '  await new Promise(function(r){ setTimeout(r, 150); });',
      '  o.imageOpenBefore2 = state.imageViewOpen;',
      '  window.VoiceCall.open();',
      '  await new Promise(function(r){ setTimeout(r, 300); });',
      '  o.imageOpenAfterVoice = state.imageViewOpen;',
      '  o.imageViewDisplay = getComputedStyle(document.getElementById("image-view")).display;',
      '  o.voiceOpenAfter2 = state.voiceOpen;',
      '  o.mainDisplayDuringVoice = getComputedStyle(document.getElementById("main")).display;',
      '  return JSON.stringify(o);',
      '})()'
    ].join('\n'));
    await ev([
      'try { window.VoiceCall.hangup(); window.VoiceCall.close(); } catch(e){}',
      'if (typeof toggleImageView === "function") toggleImageView(false);',
      '1'
    ].join('\n'));
    return jp(r);
  })();

  // ---------------------------------------------------------------- B8 设置面板反复开 5 次 + 第 6 次走按钮
  out.cases.b8 = await (async () => {
    const r = await ev([
      '(async function(){',
      '  var counts = [], groups = [];',
      '  for (var i=0;i<5;i++) {',
      '    try { toggleSettings(true); } catch (e) {}',
      '    await new Promise(function(r){ setTimeout(r, 340); });',
      '    counts.push(document.querySelectorAll("#voice-advanced-details").length);',
      '    groups.push(document.querySelectorAll(\'[data-group-key="voice"]\').length);',
      '    try { toggleSettings(false); } catch (e) {}',
      '    await new Promise(function(r){ setTimeout(r, 180); });',
      '  }',
      '  // 第 6 次：点设置按钮（走 voice.js 的 hookAdvancedUI 路径）',
      '  var b = document.getElementById("btn-settings");',
      '  if (b) b.click();',
      '  await new Promise(function(r){ setTimeout(r, 600); });',
      '  var afterBtn = document.querySelectorAll("#voice-advanced-details").length;',
      '  var tuneInputs = document.querySelectorAll(\'[id^="voice-tune-"]\').length;',
      '  var resetBtns = document.querySelectorAll("#btn-voice-tune-reset").length;',
      '  var groupBodies = document.querySelectorAll(\'[data-group-key="voice"] .setting-group-body\').length;',
      '  try { toggleSettings(false); } catch (e) {}',
      '  return JSON.stringify({ counts: counts, groupCounts: groups, afterBtn: afterBtn,',
      '    tuneInputs: tuneInputs, resetBtns: resetBtns, groupBodies: groupBodies });',
      '})()'
    ].join('\n'));
    return jp(r);
  })();

  // ---------------------------------------------------------------- B10 注入 10ms 超短 PCM
  out.cases.b10 = await (async () => {
    await ev('window.__h.reset()');
    await ev(read('voice-e2e-setup.js'));
    const r = await ev([
      '(async function(){',
      '  var ok = await window.VoiceCall.start();',
      '  if (!ok) return JSON.stringify({ startOk:false });',
      '  await new Promise(function(r){ setTimeout(r, 500); });',
      '  var m0 = window.VoiceCall.getMetrics();',
      '  var s0 = window.VoiceCall.getState();',
      '  // 10ms @16k = 160 样本',
      '  var pcm = new Int16Array(160);',
      '  for (var i=0;i<160;i++) pcm[i] = Math.round(9000*Math.sin(2*Math.PI*300*i/16000));',
      '  var t0 = Date.now();',
      '  var ret = window.VoiceCall.__injectUtterance(pcm);',
      '  var s1 = window.VoiceCall.getState();',
      '  await new Promise(function(r){ setTimeout(r, 1200); });',
      '  var s2 = window.VoiceCall.getState();',
      '  var m1 = window.VoiceCall.getMetrics();',
      '  await new Promise(function(r){ setTimeout(r, 1500); });',
      '  var s3 = window.VoiceCall.getState();',
      '  var m2 = window.VoiceCall.getMetrics();',
      '  return JSON.stringify({ ret: ret, stateBefore: s0, stateAtReturn: s1, state1_2s: s2, state2_7s: s3,',
      '    turnsBefore: m0.turns, turnsAfter1_2s: m1.turns, turnsAfter2_7s: m2.turns,',
      '    asrBefore: m0.asrMs, asrAfter: m2.asrMs,',
      '    elapsed: Date.now()-t0, running: window.VoiceCall.isRunning() });',
      '})()'
    ].join('\n'));
    await ev('window.__h.reset(); 1');
    return jp(r);
  })();

  // ---------------------------------------------------------------- 小程序兜底：空数组 / null 注入
  out.cases.b11 = await (async () => {
    // ★ 必须在 running 下测：__injectUtterance 先判 running，未开始会直接返回 not-running，
    //   那样测的就不是「空输入兜底」而是「没开机」。第一版这里判错过。
    await ev('window.__h.reset(); 1');
    await ev(read('voice-e2e-setup.js'));
    await ev('window.VoiceCall.start(); 1');
    await sleep(1200);
    const r = await ev([
      '(async function(){',
      '  var res = {};',
      '  try { res.empty = window.VoiceCall.__injectUtterance(new Int16Array(0)); } catch (e) { res.emptyThrew = String(e && e.message); }',
      '  try { res.nullish = window.VoiceCall.__injectUtterance(null); } catch (e) { res.nullThrew = String(e && e.message); }',
      '  try { res.undef = window.VoiceCall.__injectUtterance(undefined); } catch (e) { res.undefThrew = String(e && e.message); }',
      '  // 未 start 时注入',
      '  try { res.notRunning = window.VoiceCall.__injectUtterance(new Int16Array(1000)); } catch (e) { res.notRunningThrew = String(e && e.message); }',
      '  return JSON.stringify(res);',
      '})()'
    ].join('\n'));
    const rr = jp(r);
    // 再补一次"未 start"的对照
    await ev('try { window.VoiceCall.hangup(); window.VoiceCall.close(); } catch (e) {} 1');
    await sleep(500);
    rr.whenNotRunning = await ev('String(window.VoiceCall.__injectUtterance(new Int16Array(1000)))');
    // ★ 必须 return：否则 IIFE 解析成 undefined，会把 out.cases.b11 覆盖掉
    return rr;
  })();

  // ---------------------------------------------------------------- B12 设置字段能否持久化
  // 契约 §3.1 列了 23 个字段。migrateVoiceSettings 只保留 defaultVoiceSettings() 里有的键，
  // 所以「读了但没进默认值」的字段会被静默丢掉 —— 这里逐个验证。
  out.cases.b12 = await (async () => {
    const r = await ev([
      '(function(){',
      '  var def = defaultVoiceSettings();',
      '  var contract = ["enabled","asrProviderId","asrModel","ttsProviderId","ttsModel","brainProviderId",',
      '    "brainModel","voiceId","voiceDesign","cloneRefName","personaId","customPersona","sensitivity",',
      '    "endpointSilenceMs","minUtteranceMs","bargeIn","bargeInThreshold","showTranscript","showSignals",',
      '    "autoHangupSilenceMs","ttsFormat","rate","haptics"];',
      '  var inDefaults = contract.filter(function(k){ return Object.prototype.hasOwnProperty.call(def,k); });',
      '  var missing = contract.filter(function(k){ return !Object.prototype.hasOwnProperty.call(def,k); });',
      '  // 模拟用户手改一个「不在默认值里」的字段，走一遍迁移看会不会被丢掉',
      '  var probe = { rate: 1.5, haptics: false, voiceId: "冰糖", custom: "x" };',
      '  var migrated = migrateVoiceSettings(probe);',
      '  var survived = Object.keys(probe).filter(function(k){ return Object.prototype.hasOwnProperty.call(migrated,k); });',
      '  var dropped  = Object.keys(probe).filter(function(k){ return !Object.prototype.hasOwnProperty.call(migrated,k); });',
      '  // voice.js 运行时到底读的是哪个键',
      '  var readsRate = null;',
      '  try { readsRate = (function(){ var v = voiceCfg(); var old = v.rate; v.rate = 1.7;',
      '    var got = window.VoiceCall.__test ? null : null; v.rate = old; return "n/a"; })(); } catch(e) {}',
      '  return JSON.stringify({ contractCount: contract.length, defaultsCount: Object.keys(def).length,',
      '    missingFromDefaults: missing, inDefaults: inDefaults.length,',
      '    probeSurvived: survived, probeDropped: dropped,' +
      '    migratedVoiceId: migrated.voiceId });',
      '})()'
    ].join('\n'));
    return jp(r);
  })();

  // ---------------------------------------------------------------- 舞台截图（便于人工判读）
  await ev('window.__h.reset(); 1');
  await ev(read('voice-e2e-setup.js'));
  await sleep(300);

  out.errors = jp(await ev('JSON.stringify(window.__e2eErrors || [])'));
  console.log('__EDGE_JSON__' + JSON.stringify(out));
};
