// v125 e2e：CDP 页面脚本（由 tests/e2e-voice.js 通过 tools/cdp.js 执行）
// 只负责「取数据」，断言全部在 node 侧 —— 失败信息才可读。
'use strict';
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const SHOTS = path.join(__dirname, '..', 'docs', 'shots');
const read = function (n) { return fs.readFileSync(path.join(FIX, n), 'utf8'); };
const jp = function (s) {
  try { return JSON.parse(String(s)); }
  catch (e) { return { __parseError: String(e && e.message), __raw: String(s).slice(0, 500) }; }
};

module.exports = async (ctx) => {
  const { ev, sleep, shot } = ctx;
  const out = { ok: false };

  // 0) 页面侧异常收集 + 注入 key（不落盘，只在内存里）
  await ev('window.__e2eErrors = []; window.__e2eKeys = ' + JSON.stringify({
    // 仓库里不保存任何明文 key：缺了就是空串，由 node 侧（voice-e2e.js）先拦住
    // 并明确说「这段没验证」，而不是拿一把写死的 key 跑出一个"通过"。
    mimo: process.env.VOICE_MIMO_KEY || '',
    ds: process.env.VOICE_DS_KEY || ''
  }) + '; 1');
  await ev("window.addEventListener('error', function(e){ window.__e2eErrors.push('error: ' + (e.message || '')); }); " +
           "window.addEventListener('unhandledrejection', function(e){ window.__e2eErrors.push('rejection: ' + (e.reason && (e.reason.message || e.reason))); }); 1");

  // 1) 三个模块 + 契约方法
  out.moduleInfo = jp(await ev([
    'JSON.stringify({',
    "  VoiceCall: typeof window.VoiceCall,",
    "  VoiceDirector: typeof window.VoiceDirector,",
    "  VoiceSettings: typeof window.VoiceSettings,",
    "  version: window.VoiceCall ? window.VoiceCall.version : null,",
    "  apiKeys: window.VoiceCall ? Object.keys(window.VoiceCall).sort() : [],",
    "  dirKeys: window.VoiceDirector ? Object.keys(window.VoiceDirector).sort() : [],",
    "  vsKeys: window.VoiceSettings ? Object.keys(window.VoiceSettings).sort() : [],",
    "  viewport: innerWidth + 'x' + innerHeight,",
    "  hasView: !!document.getElementById('voice-view'),",
    "  hasEntryBtn: !!document.getElementById('btn-open-voice-view'),",
    "  hasSidebarImageEntry: !!document.getElementById('btn-open-image-view')",
    '})'
  ].join('\n')));

  // 2) 配渠道
  out.setup = jp(await ev(read('voice-e2e-setup.js')));

  // 3) __testChain
  out.chain = jp(await ev([
    '(async function(){',
    '  var lines = [];',
    '  var ok;',
    '  try { ok = await window.VoiceCall.__testChain(function(m){ lines.push(String(m)); }); }',
    '  catch (e) { return JSON.stringify({ ok:false, lines:lines, threw:String((e && e.message) || e) }); }',
    '  return JSON.stringify({ ok: ok, lines: lines });',
    '})()'
  ].join('\n')));

  // 4) 真 TTS 音频素材
  out.audio = jp(await ev(read('voice-e2e-audio.js')));

  // 5) 跑一轮
  out.turn = jp(await ev(read('voice-e2e-turn.js')));

  // 6) 截图留证
  try { out.shotOk = await shot(path.join(SHOTS, 'e2e-voice-turn.png')); } catch (e) { out.shotOk = false; }
  await sleep(300);

  // 7) hangup 收尾：状态 + 定时器残留
  await ev('window.VoiceCall.hangup(); 1');
  await sleep(700);
  out.afterHangup = jp(await ev([
    'JSON.stringify({',
    '  state: window.VoiceCall.getState(),',
    '  running: window.VoiceCall.isRunning(),',
    '  open: window.VoiceCall.isOpen(),',
    '  dbg: (function(){ try { return window.VoiceCall.__debug(); } catch(e){ return String(e); } })()',
    '})'
  ].join('\n')));

  // 8) 页面异常
  out.errors = jp(await ev('JSON.stringify(window.__e2eErrors || [])'));
  out.ok = true;

  console.log('__E2E_JSON__' + JSON.stringify(out));
};
