#!/usr/bin/env node
/**
 * v3.0 语音通话「总开关」+ 设置分组位置 + Beta 标记 —— 回归测试
 *
 *   用法：先起静态服务器（python -m http.server 8777 --bind 127.0.0.1，cwd 指向 www），再
 *         node tests/voice-entry.js
 *         VOICE_E2E_URL=http://127.0.0.1:8777/index.html node tests/voice-entry.js
 *
 * v3.0 起语音通话**默认关**（Beta 功能不默认占顶栏），所以本套件的主线是：
 *   E1 设置面板顺序（生图 API → 语音通话 → 数据管理）+ Beta 徽标
 *   E2 **默认关**：开关未勾选、顶栏无话筒图标、下面的配置项一条不少
 *   E3 关着的时候 VoiceCall.open() 进不去（有中文提示）
 *   E4 手动打开 → 图标出现、enabledSetByUser 置真、localStorage 镜像落盘
 *   E5 刷新后仍然是开（手动选择被尊重）
 *   E6 再关掉 → 图标消失
 *   E7 刷新后仍然是关
 *   E8 打开后点入口能真进通话界面（证明开关只动入口、没动功能）
 *   E9 **老库一次性落地**：库里 enabled=true 但用户从没碰过开关 → 迁移强制关
 *      （迁移是「有值就不覆盖」，只改默认值对老用户完全不生效，这条就是钉它）
 *   E10 对照：用户碰过开关（enabledSetByUser=true）→ 不许被覆盖
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
  console.log('=== chat-lite v3.0 语音通话 · 默认关 / 分组位置 / Beta / 总开关 ===');
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
    add('E0.2 ★ 默认 enabled=false（v3.0 起 Beta 功能不默认开）', c.enabled === false, 'enabled=' + mk(c.enabled));
    add('E0.3 默认 enabledSetByUser=false（用户还没表过态）', c.enabledSetByUser === false,
        'setByUser=' + mk(c.enabledSetByUser));
    // 只钉大版本线：3.0.x 都属于「v3.0 这条线」，小修改（3.0.1）不该让测试红
    add('E0.4 版本号已升到 v3.0 线', /^v3\.0(\.\d+)?$/.test(String(c.version)), 'version=' + mk(c.version));
    add('E0.5 voice-settings.js 走新 cache-bust 130', /voice-settings\.js\?v=130/.test(String(c.cacheBust)),
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
    add('E1.5 summary 文案是「语音通话 + Beta + 全局·所有会话可用」',
        /语音通话/.test(String(c.summaryText)) && /Beta/.test(String(c.summaryText)) &&
        /全局·所有会话可用/.test(String(c.summaryText)), 'summary=' + mk(c.summaryText));
  }

  // ---------------------------------------------------------------- E2 默认关
  {
    const c = C.e2 || {};
    add('E2.1 总开关存在且是 checkbox', c.exists === true && c.type === 'checkbox', 'type=' + mk(c.type));
    add('E2.2 总开关在语音通话分组内', c.inVoiceGroup === true, 'inGroup=' + c.inVoiceGroup);
    add('E2.3 开关名称是「启用语音通话」', /启用语音通话/.test(String(c.rowLabel)), 'label=' + mk(c.rowLabel));
    add('E2.4 默认未勾选（与 enabled=false 一致）', c.checked === false, 'checked=' + mk(c.checked));
    add('E2.5 说明文字讲清了「关掉=顶栏不显示」', /顶栏/.test(String(c.hint)) && /保留|恢复/.test(String(c.hint)),
        'hint=' + mk(c.hint));
    add('E2.6 ★ 默认状态下顶栏没有话筒图标', c.btnVisible === false && c.btnDisplay === 'none',
        'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
    add('E2.7 隐藏时同时置 aria-hidden', String(c.ariaHidden) === 'true', 'aria=' + mk(c.ariaHidden));
    add('E2.8 关着也保留语音配置（识别模型控件与分组都在）',
        c.asrStill === true && c.groupStillThere === true,
        'asrStill=' + c.asrStill + ' group=' + c.groupStillThere);
  }

  // ---------------------------------------------------------------- E3 关着进不去
  {
    const c = C.e3 || {};
    add('E3.1 关着时 open() 返回 false（不是静默打开）', c.openReturn === false, 'return=' + mk(c.openReturn));
    add('E3.2 关着时通话界面不显示', c.isOpen === false && c.viewDisplay === 'none',
        'isOpen=' + c.isOpen + ' display=' + mk(c.viewDisplay));
    add('E3.3 给的是中文提示，不是英文堆栈', /语音通话已在设置里关闭/.test(String(c.toast)), 'toast=' + mk(c.toast));
  }

  // ---------------------------------------------------------------- E4 手动打开
  {
    const c = C.e4 || {};
    add('E4.1 勾选后 enabled=true', c.memEnabled === true, 'mem=' + mk(c.memEnabled));
    add('E4.2 同时记下「用户表过态」enabledSetByUser=true', c.setByUser === true, 'setByUser=' + mk(c.setByUser));
    add('E4.3 顶栏话筒图标出现', c.btnVisible === true && c.btnDisplay !== 'none',
        'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
    add('E4.4 aria-hidden 复位为 false', String(c.ariaHidden) === 'false', 'aria=' + mk(c.ariaHidden));
    add('E4.5 两个字段都落盘到 localStorage 镜像', c.lsEnabled === true && c.lsSetByUser === true,
        'ls.enabled=' + mk(c.lsEnabled) + ' ls.setByUser=' + mk(c.lsSetByUser));
  }

  // ---------------------------------------------------------------- E5 刷新后仍开
  {
    const c = C.e5 || {};
    add('E5.1 刷新后页面恢复', c.wait === true, 'wait=' + c.wait);
    add('E5.2 刷新后仍是开（手动选择被尊重，不被 v3.0 默认值覆盖）', c.memEnabled === true, 'mem=' + mk(c.memEnabled));
    add('E5.3 刷新后开关仍是勾选', c.checked === true, 'checked=' + mk(c.checked));
    add('E5.4 刷新后图标仍在', c.btnVisible === true, 'visible=' + c.btnVisible);
  }

  // ---------------------------------------------------------------- E6 再关
  {
    const c = C.e6 || {};
    add('E6.1 取消勾选后 enabled=false', c.memEnabled === false, 'mem=' + mk(c.memEnabled));
    add('E6.2 图标立刻消失', c.btnVisible === false && c.btnDisplay === 'none',
        'display=' + mk(c.btnDisplay) + ' visible=' + c.btnVisible);
    add('E6.3 隐藏时置 aria-hidden=true', String(c.ariaHidden) === 'true', 'aria=' + mk(c.ariaHidden));
  }

  // ---------------------------------------------------------------- E7 刷新后仍关
  {
    const c = C.e7 || {};
    add('E7.1 刷新后页面恢复', c.wait === true, 'wait=' + c.wait);
    add('E7.2 ★ 刷新后仍然是关（启动时序没把默认值刷回来）', c.memEnabled === false, 'mem=' + mk(c.memEnabled));
    add('E7.3 刷新后图标仍然不在', c.btnVisible === false, 'visible=' + c.btnVisible);
  }

  // ---------------------------------------------------------------- E8 打开后能进
  {
    const c = C.e8 || {};
    add('E8.1 点入口能打开通话界面', c.isOpen === true, 'isOpen=' + c.isOpen);
    add('E8.2 body 带 voice-view-open，视图真的显示了',
        c.bodyClass === true && c.viewDisplay === 'flex',
        'bodyClass=' + c.bodyClass + ' display=' + mk(c.viewDisplay));
  }

  // ---------------------------------------------------------------- E9 老库一次性落地
  {
    const c = C.e9 || {};
    add('E9.1 刷新后页面恢复', c.wait === true, 'wait=' + c.wait);
    add('E9.2 ★ 老库 enabled=true 但没碰过开关 → 迁移强制关', c.memEnabled === false, 'mem=' + mk(c.memEnabled));
    add('E9.3 老库刷新后顶栏也不再显示图标', c.btnVisible === false, 'visible=' + c.btnVisible);
  }

  // ---------------------------------------------------------------- E10 碰过开关不覆盖
  {
    const c = C.e10 || {};
    add('E10.1 刷新后页面恢复', c.wait === true, 'wait=' + c.wait);
    add('E10.2 ★ 用户碰过开关（setByUser=true）→ 保持打开', c.memEnabled === true, 'mem=' + mk(c.memEnabled));
    add('E10.3 图标照常显示', c.btnVisible === true, 'visible=' + c.btnVisible);
  }

  // ---------------------------------------------------------------- E11 语音接口显示逻辑（v3.0.2）
  //   用户要求：语音的 key 管理要和「接口管理」在直觉上一致。
  {
    const c = C.e11 || {};
    add('E11.1 语音接口列表默认折叠（与「接口管理」一致，不再把"使用中"那条摊开）',
        c.listFolded === true, 'folded=' + mk(c.listFolded));
    add('E11.2 当前接口靠「使用中」徽标标识', c.hasBadge === true, 'badge=' + mk(c.hasBadge));
    add('E11.3 列表项按钮不被名称挤成竖排（高度正常）',
        typeof c.btnHeight === 'number' && c.btnHeight >= 28 && c.btnHeight <= 52, 'h=' + c.btnHeight);
    add('E11.4 ★ 编辑器里有「测试连接」（配完能当场验证密钥/模型）',
        c.hasTestBtn === true && c.hasTestResult === true,
        'btn=' + mk(c.hasTestBtn) + ' result=' + mk(c.hasTestResult));
    add('E11.5 保存按钮是主色按钮（与会话接口一致）', c.saveIsPrimary === true, 'primary=' + mk(c.saveIsPrimary));
    add('E11.6 ★ 编辑器嵌在被点的那一项里（不是固定挂在列表下方）',
        c.editorInGroup === true && c.groupOpen === true,
        'inGroup=' + mk(c.editorInGroup) + ' open=' + mk(c.groupOpen));
    add('E11.7 嵌进列表项时去掉独立圆角（由 details 的框承载）',
        String(c.editorRadius || '') === '0px', 'radius=' + mk(c.editorRadius));
  }

  // ---------------------------------------------------------------- 汇总
  const pass = R.filter(function (r) { return r.pass; }).length;
  const fail = R.length - pass;
  console.log('');
  R.forEach(function (r) {
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
  });
  console.log('');
  if (data.shotTops) {
    console.log('截图判读位：生图组 top=' + data.shotTops.img + ' / 语音组 top=' + data.shotTops.voice);
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
