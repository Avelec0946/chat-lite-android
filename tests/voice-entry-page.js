// v3.0 总开关（默认关）：CDP 页面脚本（由 tests/voice-entry.js 执行）
// 断言在 node 侧做，这里只负责「造环境 → 触发 → 观察」并把事实带出去。
'use strict';

module.exports = async (ctx) => {
  const { ev, sleep, shot } = ctx;
  const out = { cases: {} };
  const jp = function (s) {
    try { return JSON.parse(String(s)); } catch (e) { return { __raw: String(s).slice(0, 600) }; }
  };

  // ★ 不用 ctx.waitFor：它对「返回值 truthy」就算通过，而 ev() 出错时返回的是
  //   'EXC ...' 字符串（同样 truthy）—— 会把「脚本报错」当成「条件满足」。（看板 §4.25）
  async function until(expr, ms) {
    var t0 = Date.now(), last = null;
    while (Date.now() - t0 < ms) {
      last = await ev(expr);
      if (last === true) return { ok: true, last: last, ms: Date.now() - t0 };
      await sleep(250);
    }
    return { ok: false, last: last, ms: Date.now() - t0 };
  }
  async function reloadAndWait() {
    await ev('location.reload(); 1');
    await sleep(2200);
    return until('typeof state !== "undefined" && state._dataLoaded === true && typeof VoiceCall !== "undefined"', 25000);
  }

  // ---------------------------------------------------------------- E0 启动就绪
  out.readyWait = await until('typeof state !== "undefined" && state._dataLoaded === true', 20000);
  await sleep(400);
  out.cases.e0 = jp(await ev([
    '(function () {',
    '  // settings / state 是 app.js 顶层 const，不挂 window：只能按裸标识符读',
    '  var hasSettings = (typeof settings !== "undefined") && !!settings && !!settings.voice;',
    '  return JSON.stringify({',
    '    dataLoaded: typeof state !== "undefined" && !!state._dataLoaded,',
    '    settingsLoaded: hasSettings,',
    '    enabled: hasSettings ? settings.voice.enabled : "MISSING",',
    '    enabledSetByUser: hasSettings ? settings.voice.enabledSetByUser : "MISSING",',
    '    version: (window.VoiceCall && VoiceCall.version) || "",',
    '    cacheBust: (document.querySelector("script[src*=voice-settings]") || {}).src || ""',
    '  });',
    '})()'
  ].join('\n')));

  // 几何测量要真渲染：设置面板默认 display:none，里面元素 width 全是 0。
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
    '  var after = function (a, b) { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); };',
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

  // ---------------------------------------------------------------- E2 默认关（本次改动的重点）
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
    '    memEnabled: settings.voice.enabled,',
    '    btnExists: !!btn,',
    '    btnDisplay: btn ? getComputedStyle(btn).display : "",',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false,',
    '    ariaHidden: btn ? btn.getAttribute("aria-hidden") : "",',
    '    /// 关着不代表没配置：下面的语音接口 / 音色控件必须还在，随时能配',
    '    asrStill: !!document.getElementById("voice-asr-model"),',
    '    groupStillThere: !!document.querySelector("[data-group-key=voice]")',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E3 关着的时候进不去
  out.cases.e3 = jp(await ev([
    '(function () {',
    '  var r = null, err = "";',
    '  try { r = window.VoiceCall.open(); } catch (e) { err = String(e && e.message || e); }',
    '  var view = document.getElementById("voice-view");',
    '  var t = document.getElementById("app-toast");',
    '  return JSON.stringify({',
    '    openReturn: r === undefined ? "undefined" : r,',
    '    err: err,',
    '    isOpen: window.VoiceCall.isOpen(),',
    '    viewDisplay: view ? getComputedStyle(view).display : "",',
    '    toast: t ? (t.className + " | " + t.textContent.trim()) : ""',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E4 手动打开 → 入口出现 + 落盘
  await ev('document.getElementById("voice-enabled").click(); 1');
  await sleep(600);
  out.cases.e4 = jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  var ls = null;',
    '  try { var raw = localStorage.getItem("chatlite_settings"); if (raw) ls = JSON.parse(raw).voice; } catch (e) {}',
    '  return JSON.stringify({',
    '    checked: el.checked,',
    '    memEnabled: settings.voice.enabled,',
    '    setByUser: settings.voice.enabledSetByUser,',
    '    btnDisplay: getComputedStyle(btn).display,',
    '    btnVisible: btn.getBoundingClientRect().width > 0,',
    '    ariaHidden: btn.getAttribute("aria-hidden"),',
    '    lsEnabled: ls ? ls.enabled : "NO_LS",',
    '    lsSetByUser: ls ? ls.enabledSetByUser : "NO_LS"',
    '  });',
    '})()'
  ].join('\n')));

  // ---------------------------------------------------------------- E5 刷新后仍然是开（手动选择被尊重）
  out.cases.e5 = { wait: (await reloadAndWait()).ok };
  await sleep(700);
  Object.assign(out.cases.e5, jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  return JSON.stringify({',
    '    memEnabled: settings.voice.enabled,',
    '    checked: el ? el.checked : null,',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n'))));

  // ---------------------------------------------------------------- E6 再关掉 → 入口消失
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

  // ---------------------------------------------------------------- E7 刷新后仍然是关
  out.cases.e7 = { wait: (await reloadAndWait()).ok };
  await sleep(700);
  Object.assign(out.cases.e7, jp(await ev([
    '(function () {',
    '  var el = document.getElementById("voice-enabled");',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  return JSON.stringify({',
    '    memEnabled: settings.voice.enabled,',
    '    checked: el ? el.checked : null,',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n'))));

  // ---------------------------------------------------------------- E8 打开后点入口真能进通话界面
  await ev('document.getElementById("voice-enabled").click(); 1');
  await sleep(400);
  await ev('document.getElementById("btn-open-voice-view").click(); 1');
  await sleep(900);
  out.cases.e8 = jp(await ev([
    '(function () {',
    '  var view = document.getElementById("voice-view");',
    '  return JSON.stringify({',
    '    isOpen: window.VoiceCall.isOpen(),',
    '    viewDisplay: view ? getComputedStyle(view).display : "",',
    '    bodyClass: document.body.classList.contains("voice-view-open")',
    '  });',
    '})()'
  ].join('\n')));
  await shot('tools/out/v300-voice-open.png');
  await ev('try { window.VoiceCall.close(); } catch (e) {} 1');
  await sleep(400);

  // ---------------------------------------------------------------- E9 老库一次性落地
  // 老用户的库里 voice.enabled 已经是 true（v125~v133 的默认值），而迁移是「有值就不覆盖」——
  //   所以只改默认值对老用户完全不生效。这里造一个「有 true、但用户从没碰过开关」的库，
  //   刷新后必须变 false；E10 是对照：碰过开关的库不许被覆盖。
  await ev('(function(){settings.voice.enabled = true; settings.voice.enabledSetByUser = false; saveSettings(); return 1;})()');
  await sleep(900);
  out.cases.e9 = { wait: (await reloadAndWait()).ok };
  await sleep(700);
  Object.assign(out.cases.e9, jp(await ev([
    '(function () {',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  return JSON.stringify({',
    '    memEnabled: settings.voice.enabled,',
    '    setByUser: settings.voice.enabledSetByUser,',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n'))));

  await ev('(function(){settings.voice.enabled = true; settings.voice.enabledSetByUser = true; saveSettings(); return 1;})()');
  await sleep(900);
  out.cases.e10 = { wait: (await reloadAndWait()).ok };
  await sleep(700);
  Object.assign(out.cases.e10, jp(await ev([
    '(function () {',
    '  var btn = document.getElementById("btn-open-voice-view");',
    '  return JSON.stringify({',
    '    memEnabled: settings.voice.enabled,',
    '    btnVisible: btn ? (btn.getBoundingClientRect().width > 0) : false',
    '  });',
    '})()'
  ].join('\n'))));

  // ---------------------------------------------------------------- 截图（人工判读）
  await ev('(function(){var d=document.querySelector("[data-group-key=voice]");if(d)d.open=true;var p=document.getElementById("settings-panel");if(p&&getComputedStyle(p).display==="none")document.getElementById("btn-settings").click();return 1;})()');
  await sleep(700);
  await ev('(function(){var d=document.querySelector("[data-group-key=voice]");var b=document.getElementById("settings-body");if(d&&b)b.scrollTop=d.offsetTop-110;return 1;})()');
  await sleep(500);
  await shot('tools/out/v300-settings-voice.png');
  out.shotTops = jp(await ev('JSON.stringify({img:(function(){var d=document.querySelector("[data-group-key=image-provider]");return d?Math.round(d.getBoundingClientRect().top):-1;})(),voice:(function(){var d=document.querySelector("[data-group-key=voice]");return d?Math.round(d.getBoundingClientRect().top):-1;})()})'));

  console.log('__ENTRY_JSON__' + JSON.stringify(out));
};
