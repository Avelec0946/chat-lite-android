// v133 总开关：CDP 页面脚本（由 tests/voice-entry.js 执行）
// 断言在 node 侧做，这里只负责「造环境 → 触发 → 观察」并把事实带出去。
'use strict';
const path = require('path');

module.exports = async (ctx) => {
  const { ev, sleep, shot, waitFor } = ctx;
  const out = { cases: {} };
  const jp = function (s) {
    try { return JSON.parse(String(s)); } catch (e) { return { __raw: String(s).slice(0, 600) }; }
  };

  // ---------------------------------------------------------------- E0 启动就绪
  // ★ 不用 ctx.waitFor：它对「返回值 truthy」就算通过，而 ev() 出错时返回的是
  //   'EXC ...' 字符串（同样 truthy）—— 会把「脚本报错」当成「条件满足」。
  //   这里要求严格 === true，并把最后一次原始返回值带出去便于定位。
  async function until(expr, ms) {
    var t0 = Date.now(), last = null;
    while (Date.now() - t0 < ms) {
      last = await ev(expr);
      if (last === true) return { ok: true, last: last, ms: Date.now() - t0 };
      await sleep(250);
    }
    return { ok: false, last: last, ms: Date.now() - t0 };
  }
  out.readyWait = await until('typeof state !== "undefined" && state._dataLoaded === true', 20000);
  await sleep(400);
  out.cases.e0 = jp(await ev([
    '(function () {',
    '  // ★ settings / state 是 app.js 顶层的 const，不挂在 window 上：',
    '  //   只能按裸标识符读，写 window.settings 会永远是 undefined（是尺子坏了，不是产品坏了）',
    '  var hasSettings = (typeof settings !== "undefined") && !!settings && !!settings.voice;',
    '  return JSON.stringify({',
    '    dataLoaded: typeof state !== "undefined" && !!state._dataLoaded,',
    '    settingsLoaded: hasSettings,',
    '    onWindow: typeof window.settings,',
    '    enabled: hasSettings ? settings.voice.enabled : "MISSING",',
    '    version: (window.VoiceCall && VoiceCall.version) || "",',
    '    cacheBust: (document.querySelector("script[src*=voice-settings]") || {}).src || ""',
    '  });',
    '})()'
  ].join('\n')));

  // 几何测量要真渲染：设置面板默认 display:none，里面所有元素 width 都是 0。
  //   先打开它，后面的断言才不是"量了个空气"。（§4.12 尺子在说谎）
  await ev('(function(){var p=document.getElementById("settings-panel");if(p&&getComputedStyle(p).display==="none")document.getElementById("btn-settings").click();return 1;})()');
  await sleep(600);
  out.panelOpen = await ev('(function(){var p=document.getElementById("settings-panel");return p?getComputedStyle(p).display:"none";})()');

  // ---------------------------------------------------------------- E1 分组顺序 + Beta 标记
  out.cases.e1 = jp(await ev([
    '(function () {',
    '  var groups = [].slice.call(document.querySelectorAll("#settings-body .setting-group[data-group-key]"));',
    '  var keys = groups.map(function (g) { return g.getAttribute("data-group-key"); });',
    '  var img = document.querySelector("[data-group-key=image-provider]");',
    '  var voice = document.querySelector("[data-group-key=voice]");',
    '  var data = document.querySelector("[data-group-key=data]");',
    '  var after = function (a, b) {',
    '    // b 在 a 之后 -> 真',
    '    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);',
    '  };',
    '  var sum = voice ? voice.querySelector("summary") : null;',
    '  var beta = voice ? voice.querySelector(".setting-beta") : null;',
    '  var cs = beta ? getComputedStyle(beta) : null;',
    '  return JSON.stringify({',
    '    keys: keys,',
    '    orderOk: !!img && !!voice && !!data && after(img, voice) && after(voice, data),',
    '    voiceAfterImage: !!img && !!voice && after(img, voice),',
    '    voiceBeforeData: !!voice && !!data && after(voice, data),',
    '    summaryText: sum ? sum.textContent.replace(/\\s+/g, " ").trim() : "",',
    '    betaText: beta ? beta.textContent.trim() : "",',
    '    betaColor: cs ? cs.color : "",',
    '    betaFontSize: cs ? cs.fontSize : "",',
    '    betaVisible: beta ? (beta.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E2 总开关存在与初始态
  out.cases.e2 = jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  var row = el ? el.closest(".setting-row") : null;',
    '  var hint = document.querySelector("[data-group-key=voice] .setting-hint");',
    '  return JSON.stringify({',
    '    exists: !!el,',
    '    type: el ? el.type : "",',
    '    checked: el ? el.checked : null,',
    '    inVoiceGroup: !!(el && el.closest("[data-group-key=voice]")),',
    '    rowLabel: row ? row.querySelector("span").textContent.trim() : "",',
    '    hint: hint ? hint.textContent.trim() : "",',
    '    btnExists: !!btn,',
    '    btnDisplay: btn ? getComputedStyle(btn).display : "",',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E3 关掉 → 顶栏图标消失 + 落盘
  await ev('document.getElementById("voice-enabled").click(); 1');
  await sleep(600);
  out.cases.e3 = jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  var ls = null;',
    '  try { var raw = localStorage.getItem("chatlite_settings"); if (raw) ls = JSON.parse(raw).voice; } catch (e) {}',
    '  return JSON.stringify({',
    '    checked: el.checked,',
    '    memEnabled: settings.voice.enabled,',
    '    btnDisplay: getComputedStyle(btn).display,',
    '    btnVisible: btn.getBoundingClientRect().width > 0,',
    '    ariaHidden: btn.getAttribute("aria-hidden"),',
    '    lsEnabled: ls ? ls.enabled : "NO_LS",',
    '    // 关掉之后设置项还在（不清配置）',
    '    asrModelStill: (document.getElementById("voice-asr-model") || {}).value || "",',
    '    groupStillThere: !!document.querySelector("[data-group-key=voice]")',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E4 关掉后走 open() 也进不去
  out.cases.e4 = jp(await ev([
    '(function () {',
    '  var r = null, err = "";',
    '  try { r = window.VoiceCall.open(); } catch (e) { err = String(e && e.message || e); }',
    '  var view = document.getElementById("voice-view");',
    '  var t = document.getElementById("app-toast");',
    '  var toasts = t ? [(t.className + " | " + t.textContent.trim())] : [];',
    '  return JSON.stringify({',
    '    openReturn: r === undefined ? "undefined" : r,',
    '    err: err,',
    '    isOpen: window.VoiceCall.isOpen(),',
    '    viewDisplay: view ? getComputedStyle(view).display : "",',
    '    toasts: toasts.slice(-3)',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E5 刷新后仍然是关的（真落盘 + 启动时序）
  await ev('window.__reloadMark = 1; location.reload(); 1');
  await sleep(2500);
  const back = await until('typeof state !== "undefined" && state._dataLoaded === true && typeof VoiceCall !== "undefined"', 25000);
  await sleep(800);
  out.cases.e5 = jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  return JSON.stringify({',
    '    back: true,',
    '    memEnabled: settings.voice.enabled,',
    '    checked: el ? el.checked : null,',
    '    btnDisplay: btn ? getComputedStyle(btn).display : "",',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n')));
  out.cases.e5.back = back.ok;

  // ---------------------------------------------------------------- E6 再打开 → 图标回来 + 真能进通话界面
  // 刷新后设置面板回到关闭态（页面重载），开关照旧用 click 触发真实 change 事件。
  await ev('document.getElementById("voice-enabled").click(); 1');
  await sleep(500);
  out.cases.e6 = jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  return JSON.stringify({',
    '    checked: el.checked,',
    '    memEnabled: settings.voice.enabled,',
    '    btnDisplay: getComputedStyle(btn).display,',
    '    btnVisible: btn.getBoundingClientRect().width > 0,',
    '    ariaHidden: btn.getAttribute("aria-hidden")',
    '  });',
    '})()'
  ].join('\n')));

  // 点一下入口，确认通话界面真的能开（说明隐藏/显示只改了入口，没动到功能）
  await ev('document.getElementById("btn-open-voice-view").click(); 1');
  await sleep(900);
  out.cases.e7 = jp(await ev([
    '(function () {',
    '  var view = document.getElementById("voice-view");',
    '  return JSON.stringify({',
    '    isOpen: window.VoiceCall.isOpen(),',
    '    viewDisplay: view ? getComputedStyle(view).display : "",',
    '    bodyClass: document.body.classList.contains("voice-view-open")',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- 截图（人工判读）
  // ① 通话界面（开着）
  await shot('tools/out/v133-voice-open.png');
  await ev('try { window.VoiceCall.close(); } catch (e) {} 1');
  await sleep(500);

  // ② 设置面板：展开「语音通话」，滚到这一组
  await ev([
    '(function () {',
    '  var d = document.querySelector("[data-group-key=voice]");',
    '  if (d) d.open = true;',
    '  var p = document.getElementById("settings-panel");',
    '  if (p && getComputedStyle(p).display === "none") document.getElementById("btn-settings").click();',
    '  return 1;',
    '})()'
  ].join('\n'));
  await sleep(700);
  await ev([
    '(function () {',
    '  var d = document.querySelector("[data-group-key=voice]");',
    '  var body = document.getElementById("settings-body");',
    '  if (d && body) body.scrollTop = d.offsetTop - 12;',
    '  return d ? d.offsetTop : -1;',
    '})()'
  ].join('\n'));
  await sleep(600);
  out.cases.shot = {
    voiceTop: await ev('(function(){var d=document.querySelector("[data-group-key=voice]");return d?Math.round(d.getBoundingClientRect().top):-1;})()'),
    imgTop: await ev('(function(){var d=document.querySelector("[data-group-key=image-provider]");return d?Math.round(d.getBoundingClientRect().top):-1;})()'),
    scrollTop: await ev('Math.round(document.getElementById("settings-body").scrollTop)')
  };
  await shot('tools/out/v133-settings-voice.png');

  console.log('__ENTRY_JSON__' + JSON.stringify(out));
};
