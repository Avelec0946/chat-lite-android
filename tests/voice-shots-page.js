// v125 截图：真视口（ctx.shot 走 Page.captureScreenshot，cdp.js 已内置 Emulation override）
// 每个状态都用「真的让 VoiceCall 进到那个状态」的方式，而不是手改 data-state —— 手改只能验 CSS，
// 验不到 JS 有没有把类名/文案/按钮显隐切对。
'use strict';
const fs = require('fs');
const path = require('path');
const SHOTS = 'C:\\Users\\86176\\chat-lite-android\\docs\\shots';
const FIX = 'C:\\Users\\86176\\chat-lite-android\\tests\\fixtures';
const read = function (n) { return fs.readFileSync(path.join(FIX, n), 'utf8'); };
const jp = function (s) { try { return JSON.parse(String(s)); } catch (e) { return { __raw: String(s).slice(0, 300) }; } };

module.exports = async (ctx) => {
  const { ev, sleep, shot } = ctx;
  const W = await ev('innerWidth'), H = await ev('innerHeight');
  const tag = W + 'x' + H;
  const out = { viewport: tag, shots: [], geo: {} };

  await ev('window.__e2eKeys = { mimo: "sk-ct055gjomfb1sqdddezb1yt3xccvlxfs4q8uzb2lrmdny6xr", ds: "sk-46cc4725d23f4270a91499f1e9228d94" }; 1');
  await ev(read('voice-e2e-setup.js'));
  await sleep(300);

  // 统一的几何探针：重叠 / 溢出视口 / 关键块的位置
  const GEO = [
    '(function(){',
    '  var ids = ["voice-bar","voice-orb","voice-state-text","voice-subtitle","voice-signals","voice-controls","voice-timer","voice-hangup"];',
    '  var rs = [];',
    '  ids.forEach(function(id){',
    '    var e = document.getElementById(id);',
    '    if (!e) { rs.push({ id: id, missing: true }); return; }',
    '    var r = e.getBoundingClientRect();',
    '    rs.push({ id: id, t: Math.round(r.top), b: Math.round(r.bottom),',
    '      l: Math.round(r.left), r2: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) });',
    '  });',
    '  var by = {}; rs.forEach(function(x){ if (!x.missing) by[x.id] = x; });',
    '  // 纵向重叠（只看有内容、可见的块）',
    '  var bad = [];',
    '  var order = ["voice-bar","voice-orb","voice-state-text","voice-subtitle","voice-signals","voice-controls"];',
    '  for (var i=0;i<order.length-1;i++) {',
    '    var a = by[order[i]], b = by[order[i+1]];',
    '    if (!a || !b) continue;',
    '    if (a.b > b.t + 2) bad.push(order[i] + "(b=" + a.b + ") 压住 " + order[i+1] + "(t=" + b.t + ")");',
    '  }',
    '  // 溢出视口',
    '  var over = [];',
    '  rs.forEach(function(x){',
    '    if (x.missing) return;',
    '    if (x.t < -1 || x.b > innerHeight + 1 || x.l < -1 || x.r2 > innerWidth + 1)',
    '      over.push(x.id + " [" + x.t + "," + x.b + "] 视口 " + innerWidth + "x" + innerHeight);',
    '  });',
    '  // 横向溢出：哪些元素的 scrollWidth 超出可视宽（文字被截）',
    '  var clipped = [];',
    '  var probe = ["voice-line-user","voice-line-assistant","voice-signals","voice-state-text"];',
    '  probe.forEach(function(id){',
    '    var e = document.getElementById(id);',
    '    if (!e || e.style.display === "none") return;',
    '    if (e.scrollWidth > e.clientWidth + 2) clipped.push(id + " scrollW=" + e.scrollWidth + " clientW=" + e.clientWidth);',
    '  });',
    '  // 胶囊排布',
    '  var box = document.getElementById("voice-signals");',
    '  var pills = [];',
    '  if (box) {',
    '    var ks = box.querySelectorAll(".voice-signal");',
    '    var br = box.getBoundingClientRect();',
    '    for (var j=0;j<ks.length;j++) {',
    '      var r = ks[j].getBoundingClientRect();',
    '      pills.push({ text: ks[j].textContent, w: Math.round(r.width), l: Math.round(r.left), r2: Math.round(r.right),',
    '        row: Math.round(r.top) });',
    '    }',
    '  }',
    '  var orb = document.getElementById("voice-orb");',
    '  var wordsW = 0;',
    '  var la = document.getElementById("voice-line-assistant");',
    '  if (la) { var rr = la.getBoundingClientRect(); wordsW = Math.round(rr.width); }',
    '  var st = document.getElementById("voice-subtitle");',
    '  var stW = st ? Math.round(st.getBoundingClientRect().width) : 0;',
    '  return JSON.stringify({ blocks: rs, overlaps: bad, outsideViewport: over, clipped: clipped,',
    '    pills: pills, pillRows: (function(){ var s = {}; pills.forEach(function(p){ s[p.row] = 1; }); return Object.keys(s).length; })(),',
    '    orbSize: orb ? Math.round(orb.getBoundingClientRect().width) : 0,',
    '    subtitleWidth: stW, assistantLineWidth: wordsW,',
    '    state: window.VoiceCall.getState(),',
    '    dataState: document.getElementById("voice-view") ? document.getElementById("voice-view").getAttribute("data-state") : null,',
    '    stateText: (document.getElementById("voice-state-text")||{}).textContent,',
    '    timer: (document.getElementById("voice-timer")||{}).textContent });',
    '})()'
  ].join('\n');

  const snap = async (name, key) => {
    const g = jp(await ev(GEO));
    out.geo[key] = g;
    const ok = await shot(path.join(SHOTS, name));
    out.shots.push({ name: name, ok: ok, state: g.state });
    return g;
  };

  // ---- ① idle ----
  await ev('try{window.VoiceCall.hangup();window.VoiceCall.close();}catch(e){} 1');
  await sleep(400);
  await ev('window.VoiceCall.open(); 1');
  await sleep(600);
  await snap('voice-' + tag + '-idle.png', 'idle');

  // ---- ② listening（真 start） ----
  await ev('window.VoiceCall.start(); 1');
  await sleep(1800);
  await snap('voice-' + tag + '-listening.png', 'listening');

  // ---- ③ thinking：注入后立刻截（ASR 有 ~700ms 窗口） ----
  await ev(read('voice-e2e-audio.js'));
  await ev('window.VoiceCall.__injectUtterance(window.__e2ePcm); 1');
  let waited = 0;
  while (waited < 4000) { if (await ev('window.VoiceCall.getState()') === 'thinking') break; await sleep(60); waited += 60; }
  await snap('voice-' + tag + '-thinking.png', 'thinking');

  // ---- ④ speaking ----
  waited = 0;
  while (waited < 25000) { if (await ev('window.VoiceCall.getState()') === 'speaking') break; await sleep(120); waited += 120; }
  await sleep(500);
  await snap('voice-' + tag + '-speaking.png', 'speaking');

  // ---- ⑤ error ----
  await ev([
    'try{window.VoiceCall.hangup();window.VoiceCall.close();}catch(e){}',
    '// 造一个必然失败的渠道（key 错），把界面推到 error 态看观感',
    'window.__p = (state.providers||[]).slice();',
    'state.providers = state.providers.filter(function(p){return p.id!=="err-mimo";});',
    'state.providers.push({ id:"err-mimo", name:"Bad", template:"openai", baseUrl:"https://api.xiaomimimo.com",',
    '  endpointPath:"/v1/chat/completions", apiKey:"sk-bad", authType:"bearer", authHeader:"Authorization",',
    '  authPrefix:"Bearer ", extraHeaders:{}, extraQuery:{}, models:[], features:{} });',
    'settings.voice.asrProviderId="err-mimo"; settings.voice.ttsProviderId="err-mimo";',
    '1'
  ].join('\n'));
  await sleep(200);
  await ev('window.VoiceCall.start(); 1');
  await sleep(1500);
  await ev([
    '(function(){ var pcm = new Int16Array(16000);',
    '  for (var i=0;i<pcm.length;i++) pcm[i] = Math.round(6000*Math.sin(2*Math.PI*220*i/16000));',
    '  window.VoiceCall.__injectUtterance(pcm); return 1; })()'
  ].join('\n'));
  waited = 0;
  while (waited < 15000) { if (await ev('window.VoiceCall.getState()') === 'error') break; await sleep(150); waited += 150; }
  await sleep(400);
  await snap('voice-' + tag + '-error.png', 'error');
  await ev('state.providers = window.__p; 1');
  await ev(read('voice-e2e-setup.js'));
  await ev('try{window.VoiceCall.hangup();window.VoiceCall.close();}catch(e){} 1');
  await sleep(400);

  // ---- ⑥ 设置面板「语音通话」分组（含高级区） ----
  await ev('try { toggleSettings(true); } catch (e) {} 1');
  await sleep(900);
  // 展开语音分组
  await ev([
    '(function(){',
    '  var g = document.querySelector(\'[data-group-key="voice"]\');',
    '  if (!g) return "no-group";',
    '  if (g.tagName === "DETAILS") g.open = true;',
    '  var adv = document.getElementById("voice-advanced-details");',
    '  if (adv && adv.scrollIntoView) adv.scrollIntoView({ block: "center" });',
    '  return "ok";',
    '})()'
  ].join('\n'));
  await sleep(700);
  const settingsGeo = jp(await ev([
    '(function(){',
    '  var g = document.querySelector(\'[data-group-key="voice"]\');',
    '  var adv = document.getElementById("voice-advanced-details");',
    '  var tune = document.querySelectorAll(\'[id^="voice-tune-"]\');',
    '  var r = g ? g.getBoundingClientRect() : null;',
    '  var ar = adv ? adv.getBoundingClientRect() : null;',
    '  return JSON.stringify({ hasGroup: !!g, open: g ? (g.open !== undefined ? g.open : null) : null,',
    '    groupRect: r ? { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) } : null,',
    '    advRect: ar ? { t: Math.round(ar.top), b: Math.round(ar.bottom), h: Math.round(ar.height) } : null,',
    '    advCount: document.querySelectorAll("#voice-advanced-details").length,',
    '    tuneCount: tune.length,',
    '    hasTestBtn: !!document.getElementById("btn-voice-test"),',
    '    hasVoiceId: !!document.getElementById("voice-voice-id"),',
    '    panelVisible: (function(){ var p = document.getElementById("settings-panel");',
    '      return p ? getComputedStyle(p).display : null; })() });',
    '})()'
  ].join('\n')));
  out.settings = settingsGeo;
  out.shots.push({ name: 'voice-' + tag + '-settings.png', ok: await shot(path.join(SHOTS, 'voice-' + tag + '-settings.png')) });
  await ev('try { toggleSettings(false); } catch (e) {} 1');

  console.log('__SHOTS_JSON__' + JSON.stringify(out));
};
