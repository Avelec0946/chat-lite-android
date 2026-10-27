#!/usr/bin/env node
/**
 * v133 语音通话「总开关」+ 设置分组位置 + Beta 标记 —— 回归测试
 *
 *   用法：先起静态服务器（node/python 都行），再
 *         node tests/voice-entry.js
 *         VOICE_E2E_URL=http://127.0.0.1:8777/index.html node tests/voice-entry.js
 *
 * 覆盖：
 *   E1 设置面板顺序：生图 API → 语音通话 → 数据管理，且 summary 上有 Beta 徽标
 *   E2 总开关存在、默认开、在语音分组里，顶栏话筒入口可见
 *   E3 关掉 → 内存/落盘都是 false，顶栏入口 display:none，语音配置一条不动
 *   E4 关掉后 VoiceCall.open() 也进不去（有中文提示），通话界面不显示
 *   E5 **刷新之后仍然是关的** —— 这条最重要：settings 是异步读的，
 *      早一步同步就会按默认值把入口又显示出来（v133 专门为此加了等就绪）
 *   E6 再打开 → 入口回来，且点它能真的进通话界面（功能没被开关弄坏）
 *
 * 退出码：全 PASS = 0，有 FAIL = 1，脚本自身崩了 = 2
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAGE_JS = path.join(__dirname, 'voice-entry-page.js');
const URL_ = process.env.VOICE_E2E_URL || 'http://127.0.0.1:8777/index.html';
const W = process.env.VOICE_E2E_W || '390';
const H = process.env.VOICE_E2E_H || '844';

function resolveCdp() {
  if (process.env.VOICE_CDP) return process.env.VOICE_CDP;
  const cands = [
    path.join(ROOT, 'tools', 'cdp.js'),
    'D:\\Computer tools\\DSH分工作区\\chat-lite计划\\tools\\cdp.js',
    path.join(process.cwd(), 'tools', 'cdp.js')
  ];
  for (const c of cands) { try { if (require('fs').existsSync(c)) return c; } catch (e) {} }
  return cands[0];
}
const CDP_JS = resolveCdp();

function runCdp(script) {
  return new Promise(function (resolve) {
    const child = spawn(process.execPath, [CDP_JS, URL_, script, W, H],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { err += d; });
    child.on('close', function (code) { resolve({ code: code, out: out, err: err }); });
  });
}

const R = [];
function add(name, pass, detail) {
  R.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
}
const mk = function (v) { return JSON.stringify(v); };

async function main() {
  console.log('=== chat-lite v133 语音通话 · 分组位置 / Beta / 总开关 ===');
  console.log('URL  : ' + URL_);
  console.log('CDP  : ' + CDP_JS);
  console.log('');

  const t0 = Date.now();
  const res = await runCdp(PAGE_JS);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  let data = null;
  const m = res.out.match(/__ENTRY_JSON__(\{[\s\S]*\})\s*$/m);
  if (m) { try { data = JSON.parse(m[1]); } catch (e) { data = null; } }
  if (!data) {
    console.log('!! 页面脚本没有返回结果：');
    console.log(res.out.slice(0, 4000));
    if (res.err) console.log('--- stderr ---\n' + res.err.slice(0, 2000));
    console.log('=== 汇总: 0 PASS / 1 FAIL ===');
    process.exit(2);
  }
  const C = data.cases || {};

  // ---------------------------------------------------------------- E0 启动
  {
    const c = C.e0 || {};
    add('E0.1 设置与语音运行时都已就绪', c.dataLoaded === true && c.settingsLoaded === true,
        'dataLoaded=' + c.dataLoaded + ' settingsLoaded=' + c.settingsLoaded);
    add('E0.2 老用户默认 enabled=true（升级不静默关掉入口）', c.enabled === true, 'enabled=' + mk(c.enabled));
    add('E0.3 版本号已升到 v133', c.version === 'v133', 'version=' + mk(c.version));
    add('E0.4 voice-settings.js 走新 cache-bust 129', /voice-settings\.js\?v=129/.test(String(c.cacheBust)),
        'src=' + mk(c.cacheBust));
  }

  // ---------------------------------------------------------------- E1 分组顺序 / Beta
  {
    const c = C.e1 || {};
    add('E1.1 语音通话排在生图 API 之后', c.voiceAfterImage === true, 'keys=' + mk(c.keys));
    add('E1.2 语音通话排在数据管理之前（顺序完整）', c.orderOk === true,
        'voiceBeforeData=' + c.voiceBeforeData + ' keys=' + mk(c.keys));
    add('E1.3 summary 上有 Beta 徽标', c.betaText === 'Beta' && c.betaVisible === true,
        'beta=' + mk(c.betaText) + ' visible=' + c.betaVisible);
    add('E1.4 Beta 徽标有独立配色（不是继承正文色）', /rgb\(124, 58, 237\)/.test(String(c.betaColor)),
        'color=' + mk(c.betaColor) + ' fontSize=' + mk(c.betaFontSize));
    add('E1.5 summary 文案仍是「语音通话 + 全局·所有会话可用」',
        /语音通话/.test(String(c.summaryText)) && /Beta/.test(String(c.summaryText)) &&
        /全局·所有会话可用/.test(String(c.summaryText)), 'summary=' + mk(c.summaryText));
  }

  // ---------------------------------------------------------------- E2 开关初始态
  {
    const c = C.e2 || {};
    add('E2.1 总开关存在且是 checkbox', c.exists === true && c.type === 'checkbox', 'type=' + mk(c.type));
    add('E2.2 总开关在语音通话分组内', c.inVoiceGroup === true, 'inGroup=' + c.inVoiceGroup);
    add('E2.3 开关名称是「启用语音通话」', /启用语音通话/.test(String(c.rowLabel)), 'label=' + mk(c.rowLabel));
    add('E2.4 默认选中（与 enabled=true 一致）', c.checked === true, 'checked=' + mk(c.checked));
    add('E2.5 说明文字讲清了「关掉=顶栏不显示」', /顶栏/.test(String(c.hint)) && /保留|恢复/.test(String(c.hint)),
        'hint=' + mk(c.hint));
    add('E2.6 默认状态下顶栏话筒入口可见', c.btnVisible === true,
        'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
  }

  // ---------------------------------------------------------------- E3 关掉
  {
    const c = C.e3 || {};
    add('E3.1 取消勾选后 settings.voice.enabled=false', c.memEnabled === false, 'mem=' + mk(c.memEnabled));
    add('E3.2 顶栏话筒入口被隐藏（display:none）', c.btnDisplay === 'none' && c.btnVisible === false,
        'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
    add('E3.3 隐藏时同时置 aria-hidden', String(c.ariaHidden) === 'true', 'aria=' + mk(c.ariaHidden));
    add('E3.4 已落盘到 localStorage 镜像', c.lsEnabled === false, 'lsEnabled=' + mk(c.lsEnabled));
    add('E3.5 语音配置没被清掉（asr 模型还在、分组还在）',
        !!c.asrModelStill && c.groupStillThere === true,
        'asr=' + mk(c.asrModelStill) + ' group=' + c.groupStillThere);
  }

  // ---------------------------------------------------------------- E4 关掉后进不去
  {
    const c = C.e4 || {};
    const toast = (c.toasts || []).join(' / ');
    add('E4.1 关掉后 open() 返回 false（不是静默打开）', c.openReturn === false, 'return=' + mk(c.openReturn));
    add('E4.2 关掉后通话界面不显示', c.isOpen === false && c.viewDisplay === 'none',
        'isOpen=' + c.isOpen + ' display=' + mk(c.viewDisplay));
    add('E4.3 关掉后给的是中文提示，不是英文堆栈', /语音通话已在设置里关闭/.test(toast), 'toast=' + mk(toast));
  }

  // ---------------------------------------------------------------- E5 刷新后仍然关
  {
    const c = C.e5 || {};
    add('E5.1 刷新后读回 settings.voice.enabled=false', c.memEnabled === false, 'mem=' + mk(c.memEnabled));
    add('E5.2 刷新后开关仍是未勾选', c.checked === false, 'checked=' + mk(c.checked));
    add('E5.3 ★ 刷新后顶栏入口仍然隐藏（启动时序没把默认值刷回来）',
        c.btnVisible === false, 'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
  }

  // ---------------------------------------------------------------- E6 再打开
  {
    const c = C.e6 || {};
    add('E6.1 重新勾选后 enabled=true', c.memEnabled === true, 'mem=' + mk(c.memEnabled));
    add('E6.2 顶栏入口回来了', c.btnVisible === true && c.btnDisplay !== 'none',
        'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
    add('E6.3 aria-hidden 复位为 false', String(c.ariaHidden) === 'false', 'aria=' + mk(c.ariaHidden));
  }

  // ---------------------------------------------------------------- E7 点了能进
  {
    const c = C.e7 || {};
    add('E7.1 点入口能打开通话界面', c.isOpen === true, 'isOpen=' + c.isOpen);
    add('E7.2 body 带 voice-view-open，视图真的显示了',
        c.bodyClass === true && c.viewDisplay === 'flex',
        'bodyClass=' + c.bodyClass + ' display=' + mk(c.viewDisplay));
  }

  // ---------------------------------------------------------------- 汇总
  const pass = R.filter(function (r) { return r.pass; }).length;
  const fail = R.length - pass;
  console.log('');
  R.forEach(function (r) {
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
  });
  console.log('');
  if (data.cases && data.cases.shot) {
    console.log('截图判读位：语音组 top=' + data.cases.shot.voiceTop +
                ' / 生图组 top=' + data.cases.shot.imgTop +
                ' / scrollTop=' + data.cases.shot.scrollTop);
  }
  const errs = (res.out.match(/\[EXC\][^\n]*/g) || []);
  if (errs.length) {
    console.log('页面异常 ' + errs.length + ' 条：');
    errs.slice(0, 10).forEach(function (e) { console.log('   ' + e); });
  }
  console.log('');
  console.log('耗时 ' + secs + 's');
  console.log('=== 汇总: ' + pass + ' PASS / ' + fail + ' FAIL ===');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
