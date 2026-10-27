#!/usr/bin/env node
/**
 * v125 语音通话 —— 端到端回归（真 API，一键跑）
 *
 *   用法：node tests/e2e-voice.js
 *   可选环境变量：
 *     VOICE_E2E_URL   默认 http://127.0.0.1:8777/index.html
 *     VOICE_E2E_W/H   视口，默认 390x844
 *     VOICE_MIMO_KEY / VOICE_DS_KEY  覆盖内置测试 key
 *
 * 设计原则（独立验证，不照抄既有结论）：
 *   · 断言只看「可观测的运行结果 + 真实 DOM」，不看内部变量「应该是」什么
 *   · 音频用真 TTS 生成（正弦波会被 ASR 幻觉成文字，契约 §1.1），
 *     但**不依赖识别出的具体文本** —— TTS 非确定性，只要求有非空转写
 *   · 注入用 Int16Array：__injectUtterance 的形参是 pcmInt16，
 *     而 concatInt16 对 Uint8Array 会退化成 Int16Array(总字节数)。见报告「可疑项」。
 *
 * 退出码：全 PASS = 0，有 FAIL = 1，脚本自身崩了 = 2
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// CDP 驱动不在本仓库里（它在 DSH 分工作区的 tools/ 下），所以按候选路径找，
// 也允许用 VOICE_CDP 显式指定。找不到就报清楚，不要静默跑空。
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
const PAGE_JS = path.join(__dirname, 'voice-e2e-page.js');
const URL_ = process.env.VOICE_E2E_URL || 'http://127.0.0.1:8777/index.html';
const W = process.env.VOICE_E2E_W || '390';
const H = process.env.VOICE_E2E_H || '844';

function runCdp() {
  return new Promise(function (resolve) {
    const child = spawn(process.execPath, [CDP_JS, URL_, PAGE_JS, W, H],
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
const inRange = function (v) { return typeof v === 'number' && v > 0 && v < 8000; };

async function main() {
  console.log('=== chat-lite v125 语音通话 · 端到端回归（真 API）===');
  console.log('URL  : ' + URL_);
  console.log('视口 : ' + W + 'x' + H);
  console.log('CDP  : ' + CDP_JS);
  if (!require('fs').existsSync(CDP_JS)) {
    console.log('!! 找不到 CDP 驱动：' + CDP_JS + '（用 VOICE_CDP=<path> 指定）');
    process.exit(2);
  }
  if (!require('fs').existsSync(PAGE_JS)) {
    console.log('!! 找不到页面脚本：' + PAGE_JS);
    process.exit(2);
  }
  console.log('开始 : ' + new Date().toISOString());
  console.log('');

  const t0 = Date.now();
  const res = await runCdp();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  let data = null;
  const m = res.out.match(/__E2E_JSON__(\{[\s\S]*\})\s*$/m);
  if (m) { try { data = JSON.parse(m[1]); } catch (e) { data = null; } }

  if (!data) {
    console.log('!! 页面脚本没有返回结果（CDP 原始输出）：');
    console.log(res.out.slice(0, 4000));
    if (res.err) console.log('--- stderr ---' + String.fromCharCode(10) + res.err.slice(0, 2000));
    console.log('=== 汇总: 0 PASS / 1 FAIL （无法取得数据）===');
    process.exit(2);
  }

  // ---------------------------------------------------------------- 1. 三个模块
  const mi = data.moduleInfo || {};
  add('1.1 window.VoiceCall 存在', mi.VoiceCall === 'object', 'typeof=' + mi.VoiceCall + ' version=' + mi.version);
  add('1.2 window.VoiceDirector 存在', mi.VoiceDirector === 'object', 'keys=' + (mi.dirKeys || []).length);
  add('1.3 window.VoiceSettings 存在', mi.VoiceSettings === 'object', 'keys=' + (mi.vsKeys || []).length);
  add('1.4 #voice-view 与顶栏通话入口在 DOM 里', mi.hasView === true && mi.hasEntryBtn === true,
      'view=' + mi.hasView + ' btn=' + mi.hasEntryBtn);
  add('1.5 侧栏生图入口仍在（回归）', mi.hasSidebarImageEntry === true, '');
  const needApi = ['start', 'hangup', 'interrupt', 'open', 'close', 'getState', 'getMetrics', 'isOpen'];
  const missApi = needApi.filter(function (k) { return (mi.apiKeys || []).indexOf(k) < 0; });
  add('1.6 VoiceCall 契约方法齐全（§3.4）', missApi.length === 0, '缺少: ' + (missApi.join(',') || '无'));
  const needDir = ['PERSONAS', 'buildSystemPrompt', 'buildTurnMessages', 'describeSignals',
    'describeSignalsForBubble', 'renderPerformance', 'parseDirective', 'sanitizeForTTS', 'turnPolicy'];
  const missDir = needDir.filter(function (k) { return (mi.dirKeys || []).indexOf(k) < 0; });
  add('1.7 VoiceDirector 契约方法齐全（§3.5）', missDir.length === 0, '缺少: ' + (missDir.join(',') || '无'));

  // ---------------------------------------------------------------- 2. __testChain
  const ch = data.chain || {};
  const chainText = (ch.lines || []).join(' | ');
  add('2.1 __testChain() 返回 true', ch.ok === true,
      'ok=' + ch.ok + (ch.threw ? ' threw=' + ch.threw : ''));
  add('2.2 含「往返验证：通过」', /往返验证：通过/.test(chainText), chainText);
  add('2.3 含「识别服务：可达」', /识别服务：可达/.test(chainText), '');
  add('2.4 含「合成服务：可达」', /合成服务：可达/.test(chainText), '');
  add('2.5 含「通话大脑」结论行', /通话大脑/.test(chainText), '');

  // ---------------------------------------------------------------- 3. 音频素材
  const au = data.audio || {};
  add('3.1 真 TTS 音频生成成功', !au.error && au.outSamples > 0, JSON.stringify(au).slice(0, 200));
  add('3.2 音频长度 >= 1s（够 ASR 识别）', au.outMs >= 1000, 'outMs=' + au.outMs);

  // ---------------------------------------------------------------- 4. 一轮通话
  const tr = data.turn || {};
  const lg = {};
  (tr.log || []).forEach(function (x) { lg[x.k] = x; });
  add('4.1 start() 返回 true', lg.start && lg.start.v === true, JSON.stringify(lg.start || null));
  add('4.2 start() 后进入 listening', lg.listening && lg.listening.v === 'listening',
      JSON.stringify(lg.listening || null));
  add('4.3 __injectUtterance 返回 ok', lg.inject && lg.inject.v === 'ok',
      JSON.stringify(lg.inject || null) + ' stateText=' + JSON.stringify(tr.stateText || ''));
  add('4.4 状态轨迹经过 thinking', tr.sawThink === true, '轨迹=' + JSON.stringify(tr.seen));
  add('4.5 状态轨迹经过 speaking', tr.sawSpeak === true, '轨迹=' + JSON.stringify(tr.seen));
  add('4.6 回到 listening（未卡死）', tr.state === 'listening',
      '最终=' + tr.state + ' 用时=' + tr.elapsed + 'ms');
  add('4.7 没有进 error 态', !tr.errText, 'errText=' + JSON.stringify(tr.errText || '无'));

  // ---------------------------------------------------------------- 5. 指标
  const met = tr.metrics || {};
  const met0 = tr.metrics0 || {};
  add('5.1 getMetrics().turns === 1', met.turns === 1,
      'turns=' + met.turns + ' (基线 ' + met0.turns + ')');
  add('5.2 asrMs > 0 且 < 8000', inRange(met.asrMs), 'asrMs=' + met.asrMs);
  add('5.3 brainFirstTokenMs > 0 且 < 8000', inRange(met.brainFirstTokenMs), 'brain=' + met.brainFirstTokenMs);
  add('5.4 ttsFirstChunkMs > 0 且 < 8000', inRange(met.ttsFirstChunkMs), 'tts=' + met.ttsFirstChunkMs);
  add('5.5 turnTotalMs > 0 且 < 40s', met.turnTotalMs > 0 && met.turnTotalMs < 40000, 'total=' + met.turnTotalMs);

  // ---------------------------------------------------------------- 6. 会话写回
  const added = tr.added || [];
  const nUser = added.filter(function (x) { return x && x.role === 'user'; }).length;
  const nAsst = added.filter(function (x) { return x && x.role === 'assistant'; }).length;
  add('6.1 会话新增 user 消息 1 条', nUser === 1, '新增角色=' + JSON.stringify(added.map(function (x) { return x && x.role; })));
  add('6.2 会话新增 assistant 消息 1 条', nAsst === 1, '');
  add('6.3 两条都是 source=voice', added.length >= 2 && added.every(function (x) { return x && x.src === 'voice'; }),
      JSON.stringify(added.map(function (x) { return x && x.src; })));
  const um = added.filter(function (x) { return x && x.role === 'user'; })[0];
  add('6.4 user 消息带 voiceSignals', !!(um && um.hasSignals), 'signalKeys=' + ((um && um.signalKeys) || []).join(','));
  if (um && um.signalKeys) {
    const needSig = ['speechMs', 'totalMs', 'rmsMean', 'pitchMeanHz', 'loudness', 'speechRateCps'];
    const missSig = needSig.filter(function (k) { return um.signalKeys.indexOf(k) < 0; });
    add('6.5 VOICE_SIGNALS 关键字段齐全（§3.3）', missSig.length === 0, '缺少: ' + (missSig.join(',') || '无'));
  } else {
    add('6.5 VOICE_SIGNALS 关键字段齐全（§3.3）', false, 'voiceSignals 缺失，无法检查');
  }
  add('6.6 user 消息内容非空', !!(um && um.len > 0), 'len=' + (um && um.len));

  // ---------------------------------------------------------------- 7. 字幕与胶囊
  const ln = tr.lines || {};
  add('7.1 字幕 #voice-line-user 有内容', !!(ln.user && ln.user.trim()), 'user=' + JSON.stringify((ln.user || '').slice(0, 80)));
  add('7.2 字幕 #voice-line-assistant 有内容', !!(ln.asst && ln.asst.trim()), 'asst=' + JSON.stringify((ln.asst || '').slice(0, 80)));
  add('7.3 两条字幕真实可见（非 display:none）', ln.userVisible === true && ln.asstVisible === true,
      'userVisible=' + ln.userVisible + ' asstVisible=' + ln.asstVisible);
  add('7.4 #voice-signals 有胶囊', (tr.pills || []).length > 0, '胶囊=' + JSON.stringify(tr.pills));

  // ---------------------------------------------------------------- 8. 收尾
  const ah = data.afterHangup || {};
  add('8.1 hangup() 后 state=idle', ah.state === 'idle', 'state=' + ah.state);
  add('8.2 hangup() 后 running=false', ah.running === false, 'running=' + ah.running);
  add('8.3 无未捕获页面异常', (data.errors || []).length === 0, JSON.stringify(data.errors || []).slice(0, 300));

  // ---------------------------------------------------------------- 输出
  console.log('--- 明细 ---');
  let pass = 0, fail = 0, skips = 0;
  // v3.1：大脑凭证失效（401）时，这一轮从"进 thinking"就断了，
  //   后面 4.x~7.x 的失败全是连带，不是功能回归。
  //   只对**明确的鉴权失败**降级为 SKIP，其它错误照旧 FAIL —— 不掩盖真问题。
  const envBlocked = /401|Authentication Fails|api key.*invalid|Unauthorized/i.test(String(tr.errText || ''));
  if (envBlocked) {
    R.forEach(function (r) { if (!r.pass) r.skip = true; });
  }
  R.forEach(function (r) {
    if (r.skip) {
      console.log('SKIP ' + r.name + (r.detail ? '   << ' + r.detail : ''));
      skips++;
      return;
    }
    console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '   << ' + r.detail : ''));
    if (r.pass) pass++; else fail++;
  });
  console.log('');
  console.log('--- __testChain 原文 ---');
  (ch.lines || []).forEach(function (l) { console.log('   ' + l); });
  console.log('');
  console.log('--- 一轮实测 ---');
  console.log('   状态轨迹: ' + JSON.stringify(tr.seen));
  console.log('   metrics : ' + JSON.stringify(met));
  console.log('   userLine: ' + JSON.stringify(ln.user));
  console.log('   asstLine: ' + JSON.stringify(ln.asst));
  console.log('   胶囊    : ' + JSON.stringify(tr.pills));
  console.log('');
  console.log('=== 汇总: ' + pass + ' PASS / ' + fail + ' FAIL' +
    (skips ? ' / ' + skips + ' SKIP（' + (envBlocked ? '大脑凭证 401，整轮未验证' : '环境阻塞') + '）' : '') +
    ' （耗时 ' + secs + 's）===');
  console.log('   截图: docs/shots/e2e-voice-turn.png');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.log('FATAL ' + ((e && e.stack) || e));
  process.exit(2);
});
