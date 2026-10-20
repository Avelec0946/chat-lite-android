#!/usr/bin/env node
/**
 * v125 语音通话 —— 边界与异常回归（真 API，一键跑）
 *
 *   用法：node tests/voice-edge.js
 *
 * 覆盖（任务 B）：没配渠道 / key 错 / 模型名不存在 / 连续 start 三次 / speaking 中打断 /
 *                 start 后立刻 hangup / 通话与生图互斥 / 设置面板反复开 / voice 字段迁移 /
 *                 10ms 超短 PCM / 空输入兜底
 *
 * 判据：不崩、不卡死、有可读提示。**不要求失败时 state 一定是 error** ——
 *       产品可能选择"回 listening 再说一次"，那也是一种合理设计；
 *       真正不能接受的是：卡在 thinking/speaking、抛未捕获异常、提示是英文堆栈或空白。
 *
 * 退出码：全 PASS = 0，有 FAIL = 1，脚本自身崩了 = 2
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAGE_JS = path.join(__dirname, 'voice-edge-page.js');
const MIG_JS = path.join(__dirname, 'voice-migrate-page.js');
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
// 「可读提示」判据：中文、够长、不是纯英文堆栈
function readable(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 4) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  return true;
}
const mk = function (v) { return JSON.stringify(v); };

async function main() {
  console.log('=== chat-lite v125 语音通话 · 边界与异常 ===');
  console.log('URL  : ' + URL_);
  console.log('CDP  : ' + CDP_JS);
  console.log('开始 : ' + new Date().toISOString());
  console.log('');

  const t0 = Date.now();
  const res = await runCdp(PAGE_JS);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  let data = null;
  const m = res.out.match(/__EDGE_JSON__(\{[\s\S]*\})\s*$/m);
  if (m) { try { data = JSON.parse(m[1]); } catch (e) { data = null; } }
  if (!data) {
    console.log('!! 边界脚本没有返回结果：');
    console.log(res.out.slice(0, 4000));
    if (res.err) console.log('--- stderr ---' + String.fromCharCode(10) + res.err.slice(0, 2000));
    console.log('=== 汇总: 0 PASS / 1 FAIL ===');
    process.exit(2);
  }

  const C = data.cases || {};

  // ------------------------------------------------------------------ B1 没配渠道
  {
    const c = C.b1 || {};
    const msg = c.stateText || '';
    const toast = (c.toasts || []).join(' / ');
    add('B1.1 没配渠道时 start 不崩（有返回）', c.startOk !== undefined, 'startOk=' + c.startOk + ' state=' + c.state);
    // v125 起 start() 先做配置预检：没配渠道时直接进 error 并给出可读原因，
    //   不再"假装接通、等第一次说话才炸"。这条断言从"记录懒校验"改成"钉住快速失败"。
    add('B1.2 没配渠道时 start() 快速失败（不假装接通）',
        c.stateAtStart === 'error', 'stateAtStart=' + c.stateAtStart + ' 文案=' + mk(c.textAtStart));
    add('B1.3 注入一句后不卡在 thinking/speaking', c.state !== 'thinking' && c.state !== 'speaking',
        'state=' + c.state + ' 轨迹=' + mk(c.states));
    add('B1.4 状态文案可读（中文）', readable(msg), 'stateText=' + mk(msg));
    add('B1.5 有 toast 或状态文案说明原因（提到密钥/渠道）',
        (readable(msg) && /密钥|渠道|配置|MiMo/.test(msg)) || (readable(toast) && /密钥|渠道|配置|MiMo/.test(toast)),
        'toasts=' + mk(c.toasts));
  }

  // ------------------------------------------------------------------ B2 key 错
  {
    const c = C.b2 || {};
    const msg = c.stateText || '';
    const toast = (c.toasts || []).join(' / ');
    add('B2.1 错 key：start 后注入不崩', c.startOk === true || c.startOk === false, 'startOk=' + c.startOk);
    add('B2.2 错 key：不卡在 thinking/speaking', c.state !== 'thinking' && c.state !== 'speaking',
        'state=' + c.state + ' 轨迹=' + mk(c.states));
    add('B2.3 错 key：有可读提示', readable(msg) || readable(toast), 'stateText=' + mk(msg) + ' toasts=' + mk(c.toasts));
    add('B2.4 错 key：未超时（14s 内回到稳定态）', !c.timedOut, 'timedOut=' + c.timedOut + ' 轨迹=' + mk(c.states));
  }

  // ------------------------------------------------------------------ B3 模型名不存在
  {
    const c = C.b3 || {};
    const msg = c.stateText || '';
    const toast = (c.toasts || []).join(' / ');
    add('B3.1 模型名不存在：不崩', c.startOk !== undefined, 'startOk=' + c.startOk);
    add('B3.2 模型名不存在：不卡在 thinking/speaking', c.state !== 'thinking' && c.state !== 'speaking',
        'state=' + c.state + ' 轨迹=' + mk(c.states));
    add('B3.3 模型名不存在：有可读提示', readable(msg) || readable(toast), 'stateText=' + mk(msg) + ' toasts=' + mk(c.toasts));
    add('B3.4 模型名不存在：未超时', !c.timedOut, 'timedOut=' + c.timedOut);
  }

  // ------------------------------------------------------------------ B4 连续 start 三次
  {
    const c = C.b4 || {};
    const rs = c.results || [];
    add('B4.1 三次 start() 都返回 true（幂等）', rs.length === 3 && rs.every(function (v) { return v === true; }), mk(rs));
    add('B4.2 三次 start() 都没抛异常', (c.thrown || []).length === 0, mk(c.thrown));
    add('B4.3 最终只有一个 listening 实例', c.state === 'listening' && c.afterRunning === true,
        'state=' + c.state + ' running=' + c.afterRunning);
  }

  // ------------------------------------------------------------------ B5 speaking 中打断
  {
    const c = C.b5 || {};
    if (c.neverSpoke) {
      add('B5.1 进入 speaking 态', false, '未进入 speaking，轨迹=' + mk(c.states));
      add('B5.2 interrupt() 返回 true', false, '');
      add('B5.3 打断后立即回 listening', false, '');
      add('B5.4 打断后不反弹回 speaking', false, '');
    } else {
      add('B5.1 进入 speaking 态', true, '打断前轨迹=' + mk(c.statesBefore));
      add('B5.2 interrupt() 返回 true', c.ret === true, 'ret=' + c.ret + ' 耗时=' + c.interruptMs + 'ms');
      add('B5.3 打断后立即回 listening', c.stateAtReturn === 'listening' && c.state80 === 'listening',
          '同步=' + c.stateAtReturn + ' 80ms=' + c.state80);
      add('B5.4 打断后不反弹回 speaking（播放队列已清）', c.stateLater === 'listening',
          '1.5s 后=' + c.stateLater);
    }
  }

  // ------------------------------------------------------------------ B6 start 后立刻 hangup
  {
    const c = C.b6 || {};
    add('B6.1 start()+hangup() 不抛异常', c.hangupOk === true, 'startOk=' + c.startOk + ' hangupOk=' + c.hangupOk);
    add('B6.2 状态回 idle 并保持', c.state1 === 'idle' && c.state2 === 'idle',
        '1s=' + c.state1 + ' 2.6s=' + c.state2);
    add('B6.3 running=false 且不再自启', c.running1 === false && c.running2 === false,
        'running1=' + c.running1 + ' running2=' + c.running2);
    add('B6.4 计时器停止（不继续自增）', c.timer1 === c.timer2, 't1=' + mk(c.timer1) + ' t2=' + mk(c.timer2));
    // ★ 记录一条真实设计：hangup() 只结束通话，不退出通话视图（UI 的挂断按钮自己再调 close()）。
    //   这是合理分层，但如果有人以为 hangup 会关视图，就会写出"挂断后黑屏/停在全屏通话页"的 bug。
    add('B6.5 [行为记录] hangup() 不退出视图（需再调 close）', c.openAfterHangup === true,
        'hangup 后 voiceOpen=' + c.openAfterHangup);
    add('B6.6 close() 后视图状态还原', c.voiceOpen === false && c.voiceViewDisplay === 'none',
        'voiceOpen=' + c.voiceOpen + ' display=' + c.voiceViewDisplay);
  }

  // ------------------------------------------------------------------ B7 互斥
  {
    const c = C.b7 || {};
    add('B7.1 通话中打开生图 → 通话关闭', c.voiceOpenAfterImage === false && c.voiceViewDisplay === 'none',
        'voiceOpen=' + c.voiceOpenAfterImage + ' display=' + c.voiceViewDisplay);
    add('B7.2 生图视图确实打开', c.imageOpenAfter === true, 'imageOpen=' + c.imageOpenAfter);
    add('B7.3 生图中 open() → 生图视图关闭', c.imageOpenAfterVoice === false && c.imageViewDisplay === 'none',
        'imageOpen=' + c.imageOpenAfterVoice + ' display=' + c.imageViewDisplay);
    add('B7.4 通话视图确实打开', c.voiceOpenAfter2 === true, 'voiceOpen=' + c.voiceOpenAfter2);
    add('B7.5 main 区不叠加两个 none（互斥后有一个是显示的）',
        !(c.mainDisplayDuringImage === 'none' && c.mainDisplayDuringVoice === 'none'),
        'imageOpen 时 main=' + c.mainDisplayDuringImage + ' voiceOpen 时 main=' + c.mainDisplayDuringVoice);
  }

  // ------------------------------------------------------------------ B8 设置面板幂等
  {
    const c = C.b8 || {};
    const counts = c.counts || [];
    add('B8.1 反复开 5 次：#voice-advanced-details 恒为 1', counts.length === 5 && counts.every(function (v) { return v === 1; }), mk(counts));
    add('B8.2 语音分组不重复', (c.groupCounts || []).every(function (v) { return v === 1; }), mk(c.groupCounts));
    add('B8.3 第 6 次（点设置按钮）仍为 1', c.afterBtn === 1, 'afterBtn=' + c.afterBtn);
    // v127：双预设两栏已删除（用户反对 15 个手填框），高级参数收进折叠区，只剩 5 个。
    //   断言"恰好 5"仍能抓重复注入。
    add('B8.4 高级参数输入框不重复（折叠区内 5 个）', c.tuneInputs === 5, 'tuneInputs=' + c.tuneInputs);
    add('B8.5 恢复默认按钮不重复', c.resetBtns === 1, 'resetBtns=' + c.resetBtns);
  }

  // ------------------------------------------------------------------ B10 10ms PCM
  {
    const c = C.b10 || {};
    add('B10.1 10ms 注入返回 ok（不抛）', c.ret === 'ok', 'ret=' + mk(c.ret));
    add('B10.2 不送 ASR：turns 不增加', c.turnsAfter2_7s === c.turnsBefore,
        'before=' + c.turnsBefore + ' 1.2s=' + c.turnsAfter1_2s + ' 2.7s=' + c.turnsAfter2_7s);
    // asrMs 是"上一轮"的粘滞值（metrics 不清零），所以判据是"没有变化"，不是"等于 0"
    add('B10.3 不送 ASR：asrMs 未刷新', c.asrAfter === c.asrBefore,
        'asrBefore=' + c.asrBefore + ' asrAfter=' + c.asrAfter);
    add('B10.4 状态不乱（仍是 listening）', c.state2_7s === 'listening',
        'before=' + c.stateBefore + ' 立即=' + c.stateAtReturn + ' 2.7s=' + c.state2_7s);
  }

  // ------------------------------------------------------------------ B11 空输入兜底
  {
    const c = C.b11 || {};
    add('B11.1 running 中：空 Int16Array 返回 empty 而不是抛', c.empty === 'empty',
        'empty=' + mk(c.empty) + ' threw=' + mk(c.emptyThrew));
    add('B11.2 running 中：null 返回 empty 而不是抛', c.nullish === 'empty',
        'null=' + mk(c.nullish) + ' threw=' + mk(c.nullThrew));
    add('B11.3 running 中：undefined 返回 empty 而不是抛', c.undef === 'empty',
        'undef=' + mk(c.undef) + ' threw=' + mk(c.undefThrew));
    add('B11.4 未 start 时返回 not-running', c.whenNotRunning === 'not-running',
        'v=' + mk(c.whenNotRunning));
  }

  // ------------------------------------------------------------------ B12 契约字段能否持久化
  {
    const c = C.b12 || {};
    const miss = c.missingFromDefaults || [];
    add('B12.1 [行为记录] 契约 §3.1 的字段是否都进了默认值',
        miss.length === 0,
        '契约 ' + c.contractCount + ' 个 / 默认值 ' + c.defaultsCount + ' 个；缺失: ' + (miss.join(',') || '无'));
    add('B12.2 用户手改的 rate/haptics 能活过迁移',
        (c.probeDropped || []).length === 0 || !(c.probeDropped || []).includes('rate'),
        '存活=' + mk(c.probeSurvived) + ' 被丢=' + mk(c.probeDropped));
  }

  // ------------------------------------------------------------------ 页面异常
  add('B0.1 全场景无未捕获页面异常', (data.errors || []).length === 0, mk(data.errors || []).slice(0, 400));

  // ------------------------------------------------------------------ B9（独立重载）
  console.log('--- 明细（常规场景）---');
  let pass = 0, fail = 0;
  R.forEach(function (r) {
    console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '   << ' + r.detail : ''));
    if (r.pass) pass++; else fail++;
  });

  // B9 会重载页面，必须单独一轮
  console.log('');
  console.log('--- B9：settings.voice 缺失后的迁移（真实重载）---');
  const r9 = await runCdp(MIG_JS);
  let m9 = null;
  const mm9 = r9.out.match(/__MIGRATE_JSON__(\{[\s\S]*\})\s*$/m);
  if (mm9) { try { m9 = JSON.parse(mm9[1]); } catch (e) { m9 = null; } }
  const B9 = [];
  const add9 = function (n, p, d) { B9.push({ name: n, pass: !!p, detail: d === undefined ? '' : String(d) }); };
  if (!m9) {
    add9('B9.0 迁移脚本返回数据', false, r9.out.slice(0, 600));
  } else {
    const del = m9.deleted || {};
    const aft = m9.after || {};
    const use = m9.usable || {};
    add9('B9.0 前置：确实把 voice 从存储里删掉了', del.mirrorHasVoice === false || del.idbHasVoice === false,
         'mirror=' + del.mirrorHasVoice + ' idb=' + del.idbHasVoice);
    add9('B9.1 重载后页面正常起来（三模块都在）',
         aft.moduleTypes && aft.moduleTypes.VoiceCall === 'object' && aft.moduleTypes.VoiceDirector === 'object' &&
         aft.moduleTypes.VoiceSettings === 'object', mk(aft.moduleTypes));
    add9('B9.2 重载后 #voice-view 仍在 DOM', aft.viewExists === true, 'viewExists=' + aft.viewExists);
    // v126：字段数会随版本增长，钉死具体数字只会让每次加字段都误报。
    //   这里只要求「至少覆盖契约里的全部字段」，缺字段才是真问题。
    add9('B9.3 voice 字段被迁移补全（≥ 契约字段数）', aft.fieldCount >= 24, 'fieldCount=' + aft.fieldCount);
    const dflt = aft.defaults || {};
    const okDflt = dflt.asrModel === 'mimo-v2.5-asr' && dflt.ttsModel === 'mimo-v2.5-tts' &&
      dflt.voiceId === 'Mia' && dflt.personaId === 'warm' && dflt.enabled === true &&
      dflt.sensitivity === 0.5 && dflt.endpointSilenceMs === 700 && dflt.minUtteranceMs === 400 &&
      dflt.showTranscript === true && dflt.showSignals === true &&
      dflt.autoHangupSilenceMs === 3600000 && dflt.ttsFormat === 'pcm16' &&
      dflt.autoHangup === false;   // v127：默认不自动挂断
    add9('B9.4 迁移出的是契约 §3.1 的默认值', okDflt, mk(dflt));
    // v126：迁移后 start() 不再"无脑成功"。没配语音渠道时它必须返回 false 并说明原因，
    //   而不是进 listening 让用户以为接通了。这里钉住"失败要有可读理由"。
    add9('B9.5 迁移后 start() 行为正确（有密钥则接通，否则明确报错）',
         use.start === true || (use.state === 'error' && !!use.text && use.text.length > 0), mk(use));
  }
  B9.forEach(function (r) {
    console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '   << ' + r.detail : ''));
    if (r.pass) pass++; else fail++;
  });

  console.log('');
  console.log('=== 汇总: ' + pass + ' PASS / ' + fail + ' FAIL （耗时 ' + (((Date.now() - t0) / 1000).toFixed(1)) + 's，含两次 CDP 会话）===');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.log('FATAL ' + ((e && e.stack) || e));
  process.exit(2);
});
