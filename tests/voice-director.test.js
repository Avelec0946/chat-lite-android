// ===== tests/voice-director.test.js =====
// 纯逻辑单测：www/voice-director.js（契约 voice-模块-架构契约.md §3.5）
// 跑法：cd C:\Users\86176\chat-lite-android && node tests/voice-director.test.js
// 无第三方依赖，退出码非零表示有失败用例（qa-verify 直接看退出码）。
//
// 设计说明：
//   · 用 vm 把源码当普通脚本 eval 出来 —— 既验证"没挂 window 也能用"（node 直跑），
//     也验证"挂了 window 就走 window"（浏览器），不会把模块顶层污染测试进程的全局。

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = path.join(__dirname, '..', 'www', 'voice-director.js');
var CODE = fs.readFileSync(SRC, 'utf8');

// ---------- 加载器 ----------
// 1) 模拟浏览器：有 window，模块应挂到 window 上
function loadBrowserLike() {
  var fakeWindow = {};
  var sandbox = { window: fakeWindow, console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: SRC });
  return fakeWindow.VoiceDirector;
}
// 2) 模拟 node：没有 window，模块应挂到 globalThis 上
function loadNodeLike() {
  var sandbox = { console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: SRC });
  return sandbox.VoiceDirector;
}

// ---------- 极简断言框架 ----------
var passed = 0;
var failed = 0;
var failures = [];
var group = '';

function describe(name, fn) {
  group = name;
  fn();
}

function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failed++;
  failures.push('[' + group + '] ' + msg);
  return false;
}

function eq(actual, expected, msg) {
  var same = actual === expected;
  if (!same) {
    failures.push('[' + group + '] ' + msg +
      '\n      期望: ' + JSON.stringify(expected) +
      '\n      实际: ' + JSON.stringify(actual));
  }
  if (same) passed++; else failed++;
  return same;
}

function includes(haystack, needle, msg) {
  var s = String(haystack === null || haystack === undefined ? '' : haystack);
  return ok(s.indexOf(needle) >= 0, msg + '（没找到 ' + JSON.stringify(needle) + '）');
}

function notIncludes(haystack, needle, msg) {
  var s = String(haystack === null || haystack === undefined ? '' : haystack);
  return ok(s.indexOf(needle) < 0, msg + '（不该出现 ' + JSON.stringify(needle) + '，实际: ' + JSON.stringify(s.slice(0, 200)) + '）');
}

function noThrow(fn, msg) {
  try { fn(); passed++; return true; }
  catch (e) { failed++; failures.push('[' + group + '] ' + msg + ' 抛异常: ' + (e && e.message)); return false; }
}

// ============================================================
// 0. UMD 加载
// ============================================================
var VD = null;

describe('UMD 加载', function () {
  var browserLike = loadBrowserLike();
  ok(!!browserLike, '浏览器环境（有 window）应挂到 window.VoiceDirector');
  var nodeLike = loadNodeLike();
  ok(!!nodeLike, 'node 环境（无 window）应挂到 globalThis.VoiceDirector');
  if (browserLike) {
    ok(typeof browserLike.buildSystemPrompt === 'function', 'window 版暴露 buildSystemPrompt');
    ok(typeof browserLike.VERSION === 'string', 'window 版带 VERSION');
    eq(browserLike.VERSION, '125', 'VERSION 应为 v125');
  }
  VD = browserLike || nodeLike;
  ok(!!VD, '至少有一种加载方式可用');
  if (!VD) { console.error('模块没加载出来，后面的用例无法执行'); process.exit(1); }
});

// ============================================================
// 1. 对外 API 面（契约 §3.5 + Lead 补充）
// ============================================================
describe('API 面', function () {
  var required = [
    'PERSONAS', 'buildSystemPrompt', 'buildTurnMessages', 'describeSignals',
    'describeSignalsForBubble', 'renderPerformance', 'parseDirective', 'sanitizeForTTS',
    'turnPolicy', 'buildFillerPlan',
    // Lead 追加：流式增量解析
    'extractSpeechPartial', 'firstSentences'
  ];
  required.forEach(function (k) {
    ok(VD[k] !== undefined && VD[k] !== null, 'API 必须提供 ' + k);
  });
  ok(Array.isArray(VD.PERSONAS), 'PERSONAS 必须是数组');
});

// ============================================================
// 2. PERSONAS
// ============================================================
describe('PERSONAS', function () {
  var P = VD.PERSONAS;
  ok(P.length >= 4, '至少 4 个人设预设，实际 ' + P.length);

  var ids = P.map(function (p) { return p.id; });
  ['warm', 'bright', 'calm', 'tease'].forEach(function (id) {
    ok(ids.indexOf(id) >= 0, '必须有 id=' + id + '（settings.voice.personaId 默认 warm）');
  });

  P.forEach(function (p) {
    ok(!!p.id, '人设必须有 id');
    ok(!!p.name, '人设 ' + p.id + ' 必须有 name');
    ok(!!p.desc, '人设 ' + p.id + ' 必须有 desc（Lead 会用到）');
    ok(!!p.systemFlavor && p.systemFlavor.length > 10, '人设 ' + p.id + ' 应有像样的 systemFlavor');
    ok(!!p.pace, '人设 ' + p.id + ' 应有默认语速 pace');
    ok(!!p.tone, '人设 ' + p.id + ' 应有默认语气 tone');
    var normPace = VD.normalizePace(p.pace, '');
    ok(normPace === 'slow' || normPace === 'normal' || normPace === 'fast', '人设 ' + p.id + ' 的 pace 必须能归一化');
  });

  // 故意用默认值调用：老用户 personaId 可能是空/脏值
  eq(VD.getPersona('warm').id, 'warm', 'getPersona 精确命中');
  eq(VD.getPersona('不存在的人设').id, 'warm', 'getPersona 未知 id 回退到 warm');
  eq(VD.getPersona(null).id, 'warm', 'getPersona(null) 回退到 warm');
  eq(VD.getPersona(undefined).id, 'warm', 'getPersona(undefined) 回退到 warm');
  eq(VD.getPersona({ id: 'x', name: '临时', systemFlavor: '说话很快' }).name, '临时', 'getPersona 接受外部人设对象');
});

// ============================================================
// 3. buildSystemPrompt
// ============================================================
describe('buildSystemPrompt', function () {
  var sp = VD.buildSystemPrompt({ personaId: 'warm' });
  ok(typeof sp === 'string' && sp.length > 500, '提示词非空且足够长（实际 ' + sp.length + ' 字）');

  // 契约要求的关键约束词
  includes(sp, '打电话', '必须说明这是打电话不是发消息');
  includes(sp, '口语', '必须要求口语');
  includes(sp, '短句', '必须要求短句');
  includes(sp, '不要 Markdown', '必须禁止 markdown');
  includes(sp, 'emoji', '必须禁止 emoji');
  includes(sp, '括号', '必须禁止括号补充说明');
  includes(sp, '声音状态', '必须说明声音状态怎么用');
  includes(sp, 'JSON', '必须要求 JSON 输出');

  // Lead 的三条硬要求
  includes(sp, 'speech 必须排第一个', 'JSON 字段顺序：speech 第一');
  ok(sp.indexOf('{"speech":') >= 0, '必须给出单行紧凑 JSON 示例');
  notIncludes(sp, '\n  "speech"', '示例不能是缩进美化过的 JSON');
  includes(sp, '首先', '必须把「首先/其次/最后」列为禁止项');
  includes(sp, '总的来说', '必须把「总的来说」列为禁止项');
  includes(sp, '希望对你有帮助', '必须把「希望对你有帮助」列为禁止项');
  includes(sp, '我说错啥了', '应给出真人感的 speech 示例');

  // 默认档位 short
  var shortSp = VD.buildSystemPrompt({});
  includes(shortSp, '1~2 句', '默认 brevity=short 应为 1~2 句');
  var chattySp = VD.buildSystemPrompt({ brevity: 'chatty' });
  includes(chattySp, '3~4 句', 'brevity=chatty 应放宽到 3~4 句');
  var normalSp = VD.buildSystemPrompt({ brevity: 'normal' });
  includes(normalSp, '2~3 句', 'brevity=normal 应为 2~3 句');
  eq(VD.normalizeBrevity('  SHORT '), 'short', 'normalizeBrevity 容错');
  eq(VD.normalizeBrevity('乱写'), 'short', 'normalizeBrevity 未知值回退 short');

  // 人设注入
  var teaseSp = VD.buildSystemPrompt({ personaId: 'tease' });
  includes(teaseSp, '俏皮损友', '人设名应注入');
  includes(teaseSp, VD.getPersona('tease').systemFlavor.slice(0, 12), '人设 systemFlavor 应注入');
  var customSp = VD.buildSystemPrompt({ personaId: 'warm', customPersona: '说话带一点南方口音' });
  includes(customSp, '说话带一点南方口音', 'customPersona 应注入');
  var extraSp = VD.buildSystemPrompt({ extraRules: '不要提天气' });
  includes(extraSp, '不要提天气', 'extraRules 应注入');

  // 声音状态注入（对象 / 字符串两种入口）
  var sigObj = { speechMs: 5000, speechRateCps: 5.4, loudness: '高', pitchRangeSemitone: 6.2, speechRatio: 0.95 };
  var withSig = VD.buildSystemPrompt({ signals: sigObj });
  includes(withSig, '对方这一段的声音状态', '应注入声音状态小节');
  includes(withSig, '语速偏快', '信号应翻译成中文');
  includes(withSig, '这一轮请这样处理', '应给出针对信号的应对提示');
  var withText = VD.buildSystemPrompt({ signalsText: '对方说得又快又冲' });
  includes(withText, '对方说得又快又冲', 'signalsText 字符串入口应生效');

  // 空白 / 脏参数不能崩
  noThrow(function () { VD.buildSystemPrompt(); }, 'buildSystemPrompt() 无参不崩');
  noThrow(function () { VD.buildSystemPrompt(null); }, 'buildSystemPrompt(null) 不崩');
  noThrow(function () { VD.buildSystemPrompt({ personaId: null, signals: 'x', customPersona: 123 }); }, 'buildSystemPrompt 脏参数不崩');
  ok(VD.buildSystemPrompt({}).length > 0, '无参调用仍返回提示词');
});

// ============================================================
// 4. buildTurnMessages
// ============================================================
describe('buildTurnMessages', function () {
  var msgs = VD.buildTurnMessages({
    personaId: 'warm',
    history: [
      { role: 'user', content: '今天好累啊' },
      { role: 'assistant', content: '怎么啦，听着就没精神' }
    ],
    userText: '老板又改需求了'
  });
  ok(Array.isArray(msgs), '返回数组');
  eq(msgs[0].role, 'system', '第一条是 system');
  ok(msgs[0].content.length > 500, 'system 是完整提示词');
  eq(msgs.length, 4, 'system + 2 条历史 + 本轮 = 4 条');
  eq(msgs[1].role, 'user', '历史顺序保持');
  eq(msgs[3].role, 'user', '最后一条是本轮用户话');
  eq(msgs[3].content, '老板又改需求了', '本轮文本原样进入');

  // 长度控制
  var longHistory = [];
  for (var i = 0; i < 20; i++) {
    longHistory.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '第' + i + '句' });
  }
  var trimmed = VD.buildTurnMessages({ history: longHistory, userText: '现在', maxTurns: 3 });
  eq(trimmed.length, 1 + 6 + 1, 'maxTurns=3 只保留最近 6 条历史');
  eq(trimmed[1].role, 'user', '裁剪后必须从 user 开始（否则模型错位）');

  // 超长单条要截断
  var huge = VD.buildTurnMessages({
    history: [{ role: 'user', content: new Array(400).join('啰嗦') }],
    userText: '嗯',
    maxCharsPerMsg: 50
  });
  ok(huge[1].content.length <= 51, '超长历史应被截断（实际 ' + huge[1].content.length + '）');

  // 脏数据
  var dirty = VD.buildTurnMessages({
    history: [null, { role: 'system', content: '混进来的系统消息' }, { role: 'tool', content: 'x' }, { role: 'user', content: '  ' }],
    userText: '在吗'
  });
  eq(dirty.length, 2, 'system/工具/空内容的历史应被丢弃');
  noThrow(function () { VD.buildTurnMessages(); }, 'buildTurnMessages() 无参不崩');
  noThrow(function () { VD.buildTurnMessages({ history: '不是数组' }); }, 'history 非数组不崩');
});

// ============================================================
// 5. describeSignals
// ============================================================
describe('describeSignals', function () {
  // 空 / null / 无有效信号 → 空串（上层据此决定不注入）
  eq(VD.describeSignals({}), '', '空对象返回空串');
  eq(VD.describeSignals(null), '', 'null 返回空串');
  eq(VD.describeSignals(undefined), '', 'undefined 返回空串');
  eq(VD.describeSignals({ speechMs: 0, totalMs: 0 }), '', '全零信号返回空串');

  // 契约里的那段主路径
  var s1 = VD.describeSignals({
    speechMs: 5100, totalMs: 5100, speechRatio: 0.95, longPauseCount: 0,
    speechRateCps: 5.1, loudness: '中等偏高', pitchRangeSemitone: 5.2, rmsMean: 0.22
  });
  includes(s1, '5.1 秒', '应描述时长');
  includes(s1, '语速偏快', '应描述语速偏快');
  includes(s1, '音量偏高', '应描述音量');
  includes(s1, '音高起伏较大', '应描述音高起伏');
  includes(s1, '几乎没有停顿', '应描述几乎没停顿');
  includes(s1, '情绪比较激动', '应给出情绪综合结论');
  ok(s1.indexOf('rmsMean') < 0 && s1.indexOf('speechRateCps') < 0, '不能是字段罗列（不应出现英文字段名）');

  // 低落 / 泄气路径
  var s2 = VD.describeSignals({
    speechMs: 3000, speechRateCps: 2.4, loudness: '低', pitchRangeSemitone: 1.2,
    speechRatio: 0.5, longPauseCount: 2, trailingOff: true
  });
  includes(s2, '语速偏慢', '应描述语速偏慢');
  includes(s2, '音量偏低', '应描述音量偏低');
  includes(s2, '停顿', '应描述停顿');
  includes(s2, '句尾声音弱下去', '应描述尾音');

  // 正常平淡路径：不该硬塞情绪结论
  var s3 = VD.describeSignals({ speechMs: 2000, speechRateCps: 4.0, loudness: '中', pitchRangeSemitone: 2.2, speechRatio: 0.95 });
  includes(s3, '语速正常', '正常语速要能描述');
  notIncludes(s3, '情绪比较激动', '平淡的话不该说激动');

  // 句尾未减弱
  var s4 = VD.describeSignals({ speechMs: 2000, speechRateCps: 4.0, trailingOff: false });
  includes(s4, '句尾音量没有减弱', 'trailingOff=false 应描述');

  // maxClauses 截断
  var many = {
    speechMs: 6000, speechRateCps: 5.5, loudness: '高', pitchRangeSemitone: 8,
    speechRatio: 0.4, longPauseCount: 3, trailingOff: true
  };
  var cut = VD.describeSignals(many, { maxClauses: 2 });
  var mainPart = cut.split('。')[0];
  ok(mainPart.split('，').length <= 2, 'maxClauses=2 时主句最多 2 个小分句（实际: ' + mainPart + '）');

  // 极值不崩
  noThrow(function () {
    VD.describeSignals({ speechMs: 1e9, speechRateCps: 1e9, loudness: '???', pitchRangeSemitone: -5, speechRatio: 99, longPauseCount: 1e6, pauses: 'x' });
  }, '极值/脏数据不崩');
  noThrow(function () { VD.describeSignals({ pauses: [{ at: 1, ms: 800 }, { at: 2, ms: 700 }] }); }, 'pauses 数组不崩');
  var pauseOnly = VD.describeSignals({ speechMs: 4000, longPauseCount: 2, pauses: [{ ms: 900 }, { ms: 700 }] });
  includes(pauseOnly, '停顿了 2 次', 'longPauseCount 应被描述');
});

// ============================================================
// 6. describeSignalsForBubble
// ============================================================
describe('describeSignalsForBubble', function () {
  eq(VD.describeSignalsForBubble({}), '', '空信号返回空串');
  eq(VD.describeSignalsForBubble(null), '', 'null 返回空串');

  var b1 = VD.describeSignalsForBubble({
    speechMs: 5100, speechRateCps: 5.1, loudness: '中等偏高', pitchRangeSemitone: 5.2
  });
  includes(b1, '语速偏快', '标签串应含语速');
  includes(b1, '音量偏高', '标签串应含音量');
  includes(b1, '情绪偏高', '标签串应含情绪');
  includes(b1, ' · ', '标签之间用「 · 」分隔');

  var b2 = VD.describeSignalsForBubble({ speechMs: 3000, speechRateCps: 2.4, loudness: '低', pitchRangeSemitone: 1.2 });
  includes(b2, '语速偏慢', '慢速标签');
  includes(b2, '音量偏低', '低音量标签');

  // Lead 实测：只有语速/音量、没有 speechMs 时，也必须出标签（不能整段消失）
  var noDur = VD.describeSignalsForBubble({ speechRateCps: 5.1, loudness: '高', pitchStdHz: 40, longPauseCount: 0, trailingOff: false });
  ok(noDur.length > 0, '只有语速/音量、没有时长时不应返回空串（实际: ' + JSON.stringify(noDur) + '）');
  includes(noDur, '语速偏快', '无时长时仍应给出语速标签');
  includes(noDur, '音量偏高', '无时长时仍应给出音量标签');

  // 完全没有任何可用信号才返回空串
  eq(VD.describeSignalsForBubble({ foo: 1 }), '', '没有任何可用信号时才返回空串');

  var capped = VD.describeSignalsForBubble({
    speechMs: 6000, speechRateCps: 6, loudness: '高', pitchRangeSemitone: 8,
    longPauseCount: 3, trailingOff: true, clipping: true
  }, { maxLabels: 2 });
  eq(capped.split(' · ').length, 2, 'maxLabels=2 生效');
});

// ============================================================
// 7. renderPerformance
// ============================================================
describe('renderPerformance', function () {
  // 基础形态：（语气，语速）正文
  eq(
    VD.renderPerformance({ speech: '我回来了', emotion: '平静', tone: '温柔', pace: 'slow', volume: '中', nonverbals: [] }),
    '（温柔地，语速偏慢）我回来了',
    '基础组合'
  );
  // 语速三档
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', pace: 'slow' }), '语速偏慢', 'pace=slow');
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', pace: 'fast' }), '语速偏快', 'pace=fast');
  eq(VD.renderPerformance({ speech: 'x', tone: '温柔', pace: 'normal' }), '（温柔地）x', 'pace=normal 默认不写进括注');
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', pace: 'normal' }, { verbose: true }), '语速适中', 'verbose 时 normal 也写出来');
  // 数值型 pace 也能吃
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', pace: 0.7 }), '语速偏慢', 'pace=0.7 归一化成偏慢');
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', pace: 1.4 }), '语速偏快', 'pace=1.4 归一化成偏快');

  // 音量
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', volume: '高' }), '音量偏高', 'volume=高');
  includes(VD.renderPerformance({ speech: 'x', tone: '温柔', volume: '低' }), '音量偏低', 'volume=低');
  eq(VD.renderPerformance({ speech: 'x', tone: '温柔', volume: '中' }), '（温柔地）x', 'volume=中 默认不写');

  // nonverbals 融进括注
  var nv = VD.renderPerformance({ speech: '你可真行', tone: '调侃', nonverbals: ['轻笑'] });
  includes(nv, '带着笑意', 'nonverbal 轻笑 → 文字描述');
  includes(nv, '调侃地', 'tone 保留');
  var nv2 = VD.renderPerformance({ speech: '算了', nonverbals: ['叹气'] });
  includes(nv2, '叹了口气', '叹气应转成可念的描述');

  // 无 tone 时退到 emotion
  eq(VD.renderPerformance({ speech: '嗯', emotion: '疲惫', pace: 'slow' }), '（疲惫地，语速偏慢）嗯', '无 tone 用 emotion');

  // 空 / 脏
  eq(VD.renderPerformance(null), '', 'null 返回空串');
  eq(VD.renderPerformance({}), '', '没有 speech 返回空串');
  eq(VD.renderPerformance({ speech: '   ' }), '', '空白 speech 返回空串');
  eq(VD.renderPerformance({ speech: '就一句话' }), '就一句话', '没有任何表演信息时原样返回');
  noThrow(function () { VD.renderPerformance({ speech: 'x', tone: '非常非常非常非常长的语气描述', nonverbals: '不是数组' }); }, '脏参数不崩');
  ok(VD.renderPerformance({ speech: 'x', tone: '温柔' }).charAt(0) === '（', '括注必须以中文全角括号开头（TTS 才认）');
});

// ============================================================
// 8. parseDirective
// ============================================================
describe('parseDirective', function () {
  // 形态 A：纯 JSON
  var a = VD.parseDirective('{"speech":"我回来了","emotion":"平静","tone":"温柔","pace":"slow","volume":"中","nonverbals":[],"expectUser":true,"shouldYield":true}');
  eq(a.speech, '我回来了', '纯 JSON 解析 speech');
  eq(a.emotion, '平静', '纯 JSON 解析 emotion');
  eq(a.tone, '温柔', '纯 JSON 解析 tone');
  eq(a.pace, 'slow', '纯 JSON 解析 pace');
  eq(a.volume, '中', '纯 JSON 解析 volume');
  ok(Array.isArray(a.nonverbals), 'nonverbals 归一化成数组');
  eq(a.expectUser, true, 'expectUser 布尔化');
  eq(a.shouldYield, true, 'shouldYield 布尔化');
  eq(a._fallback, undefined, '正常解析不该有 _fallback 标记');

  // 形态 B：带代码块围栏
  var b = VD.parseDirective('\u0060\u0060\u0060json\n{"speech":"你猜","tone":"调侃","pace":"fast"}\n\u0060\u0060\u0060');
  eq(b.speech, '你猜', '代码块围栏里的 JSON 能解析');
  eq(b.pace, 'fast', '围栏形态属性正确');

  // 形态 C：前后有废话
  var c = VD.parseDirective('好的，这是你要的 JSON：\n{"speech":"行吧","emotion":"无奈"}\n希望有用。');
  eq(c.speech, '行吧', '前后有废话也能抠出 JSON');
  eq(c.emotion, '无奈', '前后有废话时属性也正确');

  // 形态 D：单引号 / 中文冒号 / 尾逗号
  var d = VD.parseDirective("{'speech':'我服了','tone':'无奈',}");
  eq(d.speech, '我服了', '单引号+尾逗号容错');

  // 属性缺省 → 默认值
  var e = VD.parseDirective('{"speech":"嗯"}');
  eq(e.pace, 'normal', 'pace 缺省 → normal');
  eq(e.volume, '中', 'volume 缺省 → 中');
  eq(e.emotion, '', 'emotion 缺省 → 空串');
  eq(e.shouldYield, true, 'shouldYield 缺省 → true');
  eq(e.expectUser, true, 'expectUser 缺省 → true');
  ok(Array.isArray(e.nonverbals) && e.nonverbals.length === 0, 'nonverbals 缺省 → 空数组');

  // 形态 E：彻底不是 JSON → 回退原文
  var f = VD.parseDirective('我今天真的很累了，想早点睡。');
  eq(f.speech, '我今天真的很累了，想早点睡。', '解析失败回退原文');
  eq(f._fallback, true, '回退应打标记便于调试');
  eq(f.shouldYield, true, '回退时默认值仍在');

  // 半截 JSON 但字段能捞出来
  var g = VD.parseDirective('{"speech":"我还没说完');
  eq(g.speech, '我还没说完', '半截 JSON 也能捞回 speech');

  // speech 里带转义
  var h = VD.parseDirective('{"speech":"他说\\"好\\"，然后走了"}');
  includes(h.speech, '他说', '转义引号不破坏解析');
  includes(h.speech, '然后走了', '转义后文本完整');

  // speech 是数组 / 对象
  var i2 = VD.parseDirective('{"speech":["第一句。","第二句。"]}');
  includes(i2.speech, '第一句', 'speech 为数组时拼接');

  // 文本里带 JSON 但要清洗
  var j = VD.parseDirective('{"speech":"**你好**呀 😊"}');
  eq(j.speech, '你好呀', 'speech 会过 sanitizeForTTS');

  // 入参为空
  eq(VD.parseDirective('').speech, '', '空串 → 空 speech');
  eq(VD.parseDirective(null).speech, '', 'null → 空 speech');
  noThrow(function () { VD.parseDirective({ speech: '对象直传' }); }, '对象直传不崩');
  eq(VD.parseDirective({ speech: '对象直传' }).speech, '对象直传', '对象直传能取到 speech');
});

// ============================================================
// 9. extractSpeechPartial（流式增量解析）
// ============================================================
describe('extractSpeechPartial', function () {
  var p1 = VD.extractSpeechPartial('{"speech":"我');
  eq(p1.speech, '我', '半截能抠出已到的字');
  eq(p1.complete, false, '字符串未闭合 → complete=false');

  var p2 = VD.extractSpeechPartial('{"speech":"我回来了"');
  eq(p2.speech, '我回来了', '闭合但 JSON 未结束也是完整的 speech');
  eq(p2.complete, true, '字符串已闭合 → complete=true');

  var p3 = VD.extractSpeechPartial('{"speech":"我回来了","emotion":"平静","tone":"温柔","pace":"slow"}');
  eq(p3.speech, '我回来了', '完整 JSON 取 speech');
  eq(p3.complete, true, '完整 JSON complete=true');

  // 转义
  var p4 = VD.extractSpeechPartial('{"speech":"他说\\"你好\\"还说\\n走了');
  includes(p4.speech, '他说', '转义引号不掐断字符串');
  includes(p4.speech, '走了', '\\n 之后的内容也要拿回来');

  // unicode 转义
  var p5 = VD.extractSpeechPartial('{"speech":"\\u4f60\\u597d"}');
  eq(p5.speech, '你好', '\\uXXXX 正确解码');

  // 还没到 speech 字段
  var p6 = VD.extractSpeechPartial('{"spe');
  eq(p6.speech, '', '还没吐到 speech 值 → 空');
  eq(p6.complete, false, '未完成');

  var p7 = VD.extractSpeechPartial('{');
  eq(p7.speech, '', '刚开一个花括号 → 空');

  // 非 JSON 流的兜底（有的模型就是不听话）
  var p8 = VD.extractSpeechPartial('你好啊，我今天');
  eq(p8.json, false, '非 JSON 标记为 json=false');
  eq(p8.speech, '你好啊，我今天', '非 JSON 直接当文本用');
  eq(p8.complete, false, '没有句末标点 → complete=false');
  var p9 = VD.extractSpeechPartial('你好啊。');
  eq(p9.complete, true, '句末标点 → complete=true');

  // 空输入
  eq(VD.extractSpeechPartial('').speech, '', '空串');
  eq(VD.extractSpeechPartial(null).speech, '', 'null');
  noThrow(function () { VD.extractSpeechPartial('{"speech":"\\u12'); }, '半截 unicode 转义不崩');
  noThrow(function () { VD.extractSpeechPartial('{"speech":"a\\'); }, '半截反斜杠不崩');
});

// ============================================================
// 10. firstSentences
// ============================================================
describe('firstSentences', function () {
  var s1 = VD.firstSentences('你好。今天怎么样？我挺好的！');
  eq(s1.length, 3, '三句话切出三段');
  eq(s1[0], '你好。', '第一句');
  eq(s1[2], '我挺好的！', '第三句');

  eq(VD.firstSentences('还没说完的半句').length, 0, '没有句末标点 → 不返回半句');
  eq(VD.firstSentences('还没说完的半句', { keepTail: true }).length, 1, 'keepTail 时返回半句');

  // 省略号 / 问号 / 叹号连续不重复切
  var s2 = VD.firstSentences('嗯……我想想。行吧！');
  eq(s2.length, 3, '省略号连续符号只算一个句末，不额外切段');
  eq(s2[0], '嗯……', '省略号整段算一句');
  eq(s2[1], '我想想。', '第二句独立');

  // 小数不当句号
  var s3 = VD.firstSentences('温度是 3.14 度。');
  eq(s3.length, 1, '3.14 不能被切成两句');
  eq(s3[0], '温度是 3.14 度。', '小数完整保留');

  // 引号收尾
  var s4 = VD.firstSentences('他说「走吧。」然后挂了。');
  ok(s4.length >= 1, '中文引号能切');
  ok(s4[0].indexOf('「') >= 0, '保留引号');

  // 英文标点
  var s5 = VD.firstSentences('Hello there. How are you?');
  eq(s5.length, 2, '英文句号/问号也能切');

  // 空
  eq(VD.firstSentences('').length, 0, '空串 → 空数组');
  eq(VD.firstSentences(null).length, 0, 'null → 空数组');
  noThrow(function () { VD.firstSentences('x', '不是选项'); }, 'opts 非对象不崩');
});

// ============================================================
// 11. sanitizeForTTS
// ============================================================
describe('sanitizeForTTS', function () {
  // emoji 必须消失（不能让 TTS 念出"笑笑脸"）
  eq(VD.sanitizeForTTS('今天好开心😊'), '今天好开心', 'emoji 被剥离');
  eq(VD.sanitizeForTTS('好耶🎉🎉'), '好耶', '连续 emoji 被剥离');
  eq(VD.sanitizeForTTS('爱你❤️'), '爱你', '带变体选择符的 emoji 被剥离');
  eq(VD.sanitizeForTTS('👍'), '', '纯 emoji → 空串');
  eq(VD.sanitizeForTTS('👨‍👩‍👧一家人'), '一家人', 'ZWJ 组合 emoji 被剥离');

  // markdown
  eq(VD.sanitizeForTTS('**加粗**的文字'), '加粗的文字', '粗体记号剥离');
  eq(VD.sanitizeForTTS('# 标题'), '标题', '标题井号剥离');
  eq(VD.sanitizeForTTS('- 第一条\n- 第二条'), '第一条，第二条', '列表记号剥离');
  eq(VD.sanitizeForTTS('1. 第一步\n2. 第二步'), '第一步，第二步', '编号列表剥离');
  eq(VD.sanitizeForTTS('看这个[链接](https://a.com)吧'), '看这个链接吧', 'markdown 链接保留文字');
  eq(VD.sanitizeForTTS('用\u0060console.log\u0060就行'), '用console.log就行', '行内代码记号剥离');
  eq(VD.sanitizeForTTS('~~删掉~~'), '删掉', '删除线剥离');
  eq(VD.sanitizeForTTS('> 引用'), '引用', '引用符剥离');

  // URL
  var u1 = VD.sanitizeForTTS('你看 https://example.com/a?b=1 这个');
  notIncludes(u1, 'https', 'URL 被剥离');
  notIncludes(u1, 'example.com', 'URL 主体也被剥离');
  includes(u1, '你看', 'URL 前后的中文保留');
  notIncludes(VD.sanitizeForTTS('发到 a@b.com 吧'), 'a@b.com', '邮箱被剥离');

  // 括号里的英文注释（中文括注必须保留 —— 那是给 TTS 的表演提示）
  eq(VD.sanitizeForTTS('(laughs)好吧'), '好吧', '英文括注被剥离');
  eq(VD.sanitizeForTTS('（sighs）算了'), '算了', '全角英文括注被剥离');
  eq(VD.sanitizeForTTS('（温柔地，语速偏慢）我回来了'), '（温柔地，语速偏慢）我回来了', '中文括注必须保留（TTS 表演提示）');
  eq(VD.sanitizeForTTS('嗯（想了想）好'), '嗯（想了想）好', '中文括注不在句首也保留');

  // 中文标点保留
  eq(VD.sanitizeForTTS('真的吗？我不信！'), '真的吗？我不信！', '中文标点保留');
  eq(VD.sanitizeForTTS('一、二、三'), '一、二、三', '顿号保留');
  eq(VD.sanitizeForTTS('“你好”他说'), '“你好”他说', '中文引号保留');

  // 空白收敛
  eq(VD.sanitizeForTTS('  多   余    空格  '), '多余空格', '多余空白收敛（中文之间不留空格）');
  eq(VD.sanitizeForTTS('hello   world'), 'hello world', '英文之间保留单个空格');
  eq(VD.sanitizeForTTS('第一行\n第二行'), '第一行，第二行', '换行转成朗读停顿');
  eq(VD.sanitizeForTTS('前半句，\n\n后半句'), '前半句，后半句', '标点后换行不产生重复逗号');
  eq(VD.sanitizeForTTS(''), '', '空串');
  eq(VD.sanitizeForTTS(null), '', 'null');
  eq(VD.sanitizeForTTS('，，，'), '', '纯标点 → 空串');

  // 组合场景不崩
  noThrow(function () {
    VD.sanitizeForTTS('## 标题\n**要点**：见 https://x.com 😀（嗯……）"quoted" 1. 列表');
  }, '混合脏文本不崩');
  var mixed = VD.sanitizeForTTS('**注意**：记得带伞 ☔ https://weather.com');
  includes(mixed, '注意', '混合清洗后保留正文');
  notIncludes(mixed, '☔', '混合清洗后 emoji 消失');
  notIncludes(mixed, 'weather', '混合清洗后 URL 消失');
});

// ============================================================
// 12. turnPolicy
// ============================================================
describe('turnPolicy', function () {
  // 还在说话
  var a = VD.turnPolicy('listening', { isSpeech: true });
  eq(a.action, 'continue', 'VAD 仍判说话 → continue');
  ok(!!a.reason, '必须给出 reason 便于调试');
  ok(!!a.thresholds, '必须回带阈值便于调试');

  // 说完了：静音超端点阈值
  var b = VD.turnPolicy('listening', { silentMs: 800, speechMs: 4200 });
  eq(b.action, 'yield', '静音 800ms ≥ 700ms → yield');
  eq(b.reason, 'endpoint-silence', 'reason 正确');

  // 再等等：静音 300ms
  var c = VD.turnPolicy('listening', { silentMs: 300, speechMs: 4200 });
  eq(c.action, 'wait', '静音不够 → wait');

  // 边界：正好 700ms
  eq(VD.turnPolicy('listening', { silentMs: 700, speechMs: 4000 }).action, 'yield', '边界值 700ms 应 yield');
  eq(VD.turnPolicy('listening', { silentMs: 699, speechMs: 4000 }).action, 'wait', '边界值 699ms 应 wait');

  // 硬阈值：静音很久
  var d = VD.turnPolicy('listening', { silentMs: 1600 });
  eq(d.action, 'yield', '超硬阈值 → yield');
  eq(d.reason, 'long-silence', '硬阈值 reason 正确');

  // 太短：可能是噪声
  eq(VD.turnPolicy('listening', { speechMs: 200, silentMs: 100 }).action, 'wait', '有效语音太短 → wait');
  eq(VD.turnPolicy('listening', { speechMs: 200, silentMs: 100 }).reason, 'too-short', 'too-short reason');
  // 但短的也不许死等：静音够久必须让位
  eq(VD.turnPolicy('listening', { speechMs: 200, silentMs: 1600 }).action, 'yield', '短语音+长静音 → yield（不能死等）');

  // 尾音拖长 → 再等等
  var e = VD.turnPolicy('listening', { silentMs: 120, tailDragMs: 400, speechMs: 2000 });
  eq(e.action, 'wait', '尾音拖长 → wait');
  eq(e.reason, 'tail-dragging', 'tail-dragging reason');
  // 但尾巴拖太久到硬阈值还是让位
  eq(VD.turnPolicy('listening', { silentMs: 1600, tailDragMs: 400, speechMs: 2000 }).action, 'yield', '拖尾但静音够久 → yield');

  // 句尾能量骤降 → 提前判说完
  var f = VD.turnPolicy('listening', { silentMs: 400, trailingOff: true, speechMs: 3000 });
  eq(f.action, 'yield', 'trailingOff + 400ms → yield');
  eq(f.reason, 'trailing-off', 'trailing-off reason');
  eq(VD.turnPolicy('listening', { silentMs: 200, trailingOff: true, speechMs: 3000 }).action, 'wait', 'trailingOff 但静音不够 → wait');

  // AI 说话时不做轮次判定（交给打断逻辑）
  eq(VD.turnPolicy('speaking', { silentMs: 2000 }).action, 'wait', 'speaking 状态不判 yield');
  eq(VD.turnPolicy('speaking', { silentMs: 2000 }).reason, 'assistant-busy', 'speaking 的 reason');
  eq(VD.turnPolicy('thinking', {}).action, 'wait', 'thinking 状态 wait');
  eq(VD.turnPolicy('idle', {}).reason, 'inactive', 'idle 状态不做判定');

  // ===== 端点自适应（Lead 实测要求）=====
  // 快 + 一处停顿都没有 → 收紧到 700*0.65=455，480ms 就该接上
  var fast = VD.turnPolicy('listening', { silentMs: 480, speechRateCps: 5.6, longPauseCount: 0, trailingOff: false });
  eq(fast.action, 'yield', '快语速（480ms/5.6cps/无停顿）应收紧端点并 yield');
  eq(fast.reason, 'endpoint-silence', '快语速应走自适应端点判定');
  eq(fast.thresholds.effectiveEndpointMs, 455, '快语速有效端点应为 455ms');
  eq(fast.thresholds.endpointMode, 'tightened', 'thresholds.endpointMode 应标 tightened');
  eq(fast.thresholds.endpointSilenceMs, 700, '基准值仍保留在 thresholds 里');

  // 慢语速 → 放宽到 700*1.25=875，900ms 才接
  var slow = VD.turnPolicy('listening', { silentMs: 900, speechRateCps: 3.1, longPauseCount: 0, trailingOff: false });
  eq(slow.action, 'yield', '慢语速（900ms/3.1cps）应放宽端点后 yield');
  eq(slow.thresholds.effectiveEndpointMs, 875, '慢语速有效端点应为 875ms');
  eq(slow.thresholds.endpointMode, 'relaxed', 'thresholds.endpointMode 应标 relaxed');

  // 同样 480ms，慢语速不许抢话
  var slow480 = VD.turnPolicy('listening', { silentMs: 480, speechRateCps: 3.1, longPauseCount: 0, trailingOff: false });
  eq(slow480.action, 'wait', '慢语速 480ms 必须继续等（不能抢话）');

  // 多处停顿 → 即使语速快也放宽（一边想一边说的人）
  var pausing = VD.turnPolicy('listening', { silentMs: 600, speechRateCps: 5.2, longPauseCount: 2 });
  eq(pausing.action, 'wait', '语速快但多处停顿 → 放宽，600ms 仍 wait');
  eq(pausing.thresholds.endpointMode, 'relaxed', '多处停顿走 relaxed 档');

  // 尾音掉下去 → 放宽（但 trailing-off 自己的短阈值会先接住）
  var trail = VD.turnPolicy('listening', { silentMs: 500, speechRateCps: 5.0, trailingOff: true });
  eq(trail.thresholds.endpointMode, 'relaxed', 'trailingOff 也走 relaxed 档');

  // 没有任何语速信息 → 保持基准，不能乱动
  var base = VD.turnPolicy('listening', { silentMs: 600, speechMs: 3000 });
  eq(base.thresholds.effectiveEndpointMs, 700, '无语速信息时用基准端点');
  eq(base.thresholds.endpointMode, 'base', '无语速信息时 mode=base');
  eq(base.action, 'wait', '无语速信息 600ms → wait');

  // 放宽后也不能越过硬阈值
  var hugeCfg = VD.turnPolicy('listening', { silentMs: 800, speechRateCps: 2.5 }, { endpointSilenceMs: 1200, hardSilenceMs: 1500 });
  ok(hugeCfg.thresholds.effectiveEndpointMs <= 1500, '放宽后的有效端点不得越过硬阈值（实际 ' + hugeCfg.thresholds.effectiveEndpointMs + '）');

  // cfg 覆盖
  var cfg = { endpointSilenceMs: 1200 };
  eq(VD.turnPolicy('listening', { silentMs: 900, speechMs: 3000 }, cfg).action, 'wait', 'cfg 端点阈值生效');
  eq(VD.turnPolicy('listening', { silentMs: 1300, speechMs: 3000 }, cfg).action, 'yield', 'cfg 端点阈值生效（超了）');
  // 字符串数字也认（设置面板存回来是字符串）
  eq(VD.turnPolicy('listening', { silentMs: 900, speechMs: 3000 }, { endpointSilenceMs: '1200' }).action, 'wait', 'cfg 字符串数值生效');

  // 犹豫：占比低 + 停顿多
  var g = VD.turnPolicy('listening', { silentMs: 200, speechMs: 2500, speechRatio: 0.4, longPauseCount: 2 });
  eq(g.action, 'wait', '含糊犹豫 → wait');
  eq(g.reason, 'hesitating', 'hesitating reason');

  // 脏输入
  noThrow(function () { VD.turnPolicy(); }, 'turnPolicy() 无参不崩');
  noThrow(function () { VD.turnPolicy(null, null, null); }, 'turnPolicy(null,null,null) 不崩');
  var h = VD.turnPolicy('listening', {});
  eq(h.action, 'wait', '没特征时保守 wait');
  ok(typeof h.reasonText === 'string' && h.reasonText.length > 0, 'reasonText 是给日志看的中文说明');
});

// ============================================================
// 13. buildFillerPlan
// ============================================================
describe('buildFillerPlan', function () {
  var a = VD.buildFillerPlan({ personaId: 'warm', index: 0 });
  var warmFillers = VD.getPersona('warm').fillers;
  eq(a.speech, VD.sanitizeForTTS(warmFillers[0]), 'index=0 取人设第一个补白词');
  ok(a.isFiller === true, '应标记 isFiller，便于播放层识别');
  eq(a.shouldYield, false, '补白词不交出话头');
  ok(!!a.tone, '补白也有语气');

  // 不同人设风格不同
  var warm0 = VD.buildFillerPlan({ personaId: 'warm', index: 0 }).speech;
  var tease0 = VD.buildFillerPlan({ personaId: 'tease', index: 0 }).speech;
  ok(warm0 !== tease0, '不同人设的补白词应不同（warm=' + warm0 + ' / tease=' + tease0 + '）');

  // 避免重复上一句用过的
  var avoid = VD.getPersona('warm').fillers[0];
  var b = VD.buildFillerPlan({ personaId: 'warm', avoid: avoid, index: 0 });
  ok(b.speech !== VD.sanitizeForTTS(avoid), 'avoid 应避开刚用过的补白词');

  // 越界索引回绕
  noThrow(function () { VD.buildFillerPlan({ personaId: 'warm', index: 999 }); }, 'index 越界不崩');
  ok(!!VD.buildFillerPlan({ personaId: 'warm', index: 999 }).speech, '越界索引也能给出补白词');

  // 未知人设回退
  ok(!!VD.buildFillerPlan({ personaId: '不存在' }).speech, '未知人设回退到默认补白词');
  ok(!!VD.buildFillerPlan().speech, '无参也能给出补白词');

  // 结果必须能直接送 TTS
  var plan = VD.buildFillerPlan({ personaId: 'bright', index: 1 });
  eq(plan.speech, VD.sanitizeForTTS(plan.speech), '补白词本身已是清洗后的文本');
});

// ============================================================
// 14. 端到端串起来（模拟一轮真实调用链）
// ============================================================
describe('端到端串起来', function () {
  var signals = {
    speechMs: 4200, totalMs: 5100, speechRatio: 0.82, longPauseCount: 1,
    rmsMean: 0.24, loudness: '高', pitchMeanHz: 205, pitchStdHz: 40, pitchRangeSemitone: 5.5,
    speechRateCps: 5.1, trailingOff: false, snrDb: 20
  };

  var sys = VD.buildSystemPrompt({ personaId: 'tease', signals: signals, brevity: 'short' });
  var sigText = VD.describeSignals(signals);
  var bubble = VD.describeSignalsForBubble(signals);
  var msgs = VD.buildTurnMessages({ system: sys, history: [], userText: '你昨晚又放我鸽子' });

  ok(sys.length > 500, '系统提示词生成');
  ok(sigText.length > 10, '声音状态描述生成: ' + sigText);
  ok(bubble.length > 5, '气泡标签生成: ' + bubble);
  eq(msgs.length, 2, 'system + 本轮 = 2 条消息');

  // 模型输出 → 解析 → 表演提示 → 送 TTS
  var modelOut = '{"speech":"啊？我哪有，你别冤枉好人啊。","emotion":"委屈","tone":"调侃","pace":"fast","volume":"中","nonverbals":["轻笑"],"expectUser":true,"shouldYield":true}';
  var d = VD.parseDirective(modelOut);
  eq(d.speech, '啊？我哪有，你别冤枉好人啊。', '解析出 speech');
  var perf = VD.renderPerformance(d);
  ok(perf.indexOf('（') === 0, '表演提示以括注开头: ' + perf);
  includes(perf, '调侃', '表演提示含语气');
  includes(perf, '语速偏快', '表演提示含语速');
  includes(perf, '啊？我哪有', '正文接在括注后面');
  eq(VD.sanitizeForTTS(perf), perf, '表演提示本身再过一遍 sanitize 不应被破坏（中文括注保留）');

  // 流式：半截 → 增量 → 切句
  var partial = VD.extractSpeechPartial('{"speech":"啊？我哪有，你别冤枉好人啊。');
  eq(partial.complete, false, '半截流未闭合');
  var sentences = VD.firstSentences(partial.speech);
  ok(sentences.length >= 1, '半截流也能切出完整句子: ' + JSON.stringify(sentences));

  // 轮次判定接到信号上
  var decision = VD.turnPolicy('listening', { silentMs: 760, speechMs: signals.speechMs, speechRatio: signals.speechRatio });
  eq(decision.action, 'yield', '静音够久 → 该我说话了');
});


// ============================================================
// 15. v126 describeClock（时间感知）
// ============================================================
// 时间戳全部用本地时间构造：测试在哪个时区跑都得到同一个"几点"，
//   否则 CI 换个 TZ 这里就红。
function vmTs(y, mo, d, h, mi, s) {
  return new Date(y, mo - 1, d, h, mi || 0, s || 0).getTime();
}

describe('describeClock', function () {
  // 关闭 / 非法入参：一律空串，调用方据此不往 prompt 里塞
  eq(VD.describeClock({ enabled: false, now: vmTs(2026, 10, 20, 22, 30) }), '', 'enabled=false 返回空串');
  eq(VD.describeClock({ now: '不是时间' }), '', 'now 非法字符串返回空串');
  eq(VD.describeClock({ now: NaN }), '', 'now=NaN 返回空串');
  eq(VD.describeClock({ now: 0 }), '', 'now=0 视为非法');
  eq(VD.describeClock(null), '', 'null 不崩且返回空串');
  noThrow(function () { VD.describeClock(); }, 'describeClock() 无参不崩');

  // 首轮：几月几日 + 星期几 + 几点（口语化，不能出现 ISO 或裸时间戳）
  var first = VD.describeClock({
    enabled: true, now: vmTs(2026, 10, 20, 22, 30),
    callStartedAt: vmTs(2026, 10, 20, 22, 30), lastTurnAt: 0, turnIndex: 0
  });
  includes(first, '10月20日', '首轮应说出几月几日');
  includes(first, '星期二', '首轮应说出星期几');
  includes(first, '晚上十点半', '首轮应把 22:30 说成人话');
  notIncludes(first, '2026-', '不许出现 ISO 日期');
  notIncludes(first, String(vmTs(2026, 10, 20, 22, 30)), '不许出现裸时间戳数字');
  // 时段与分钟的口语化
  includes(VD.describeClock({ now: vmTs(2026, 3, 5, 15, 15) }), '下午三点一刻', '15:15 → 下午三点一刻');
  includes(VD.describeClock({ now: vmTs(2026, 3, 5, 9, 5) }), '上午九点零五分', '09:05 → 上午九点零五分');
  includes(VD.describeClock({ now: vmTs(2026, 3, 5, 0, 0) }), '凌晨十二点整', '00:00 → 凌晨十二点整');
  includes(VD.describeClock({ now: vmTs(2026, 3, 5, 12, 5) }), '中午十二点零五分', '12:05 → 中午十二点零五分');

  // 后续轮：距上一句多久 + 通话已进行多久
  var later = VD.describeClock({
    enabled: true, now: vmTs(2026, 10, 20, 22, 36, 10),
    callStartedAt: vmTs(2026, 10, 20, 22, 31, 0),
    lastTurnAt: vmTs(2026, 10, 20, 22, 34, 0), turnIndex: 3
  });
  eq(later, '距对方上一句已经过了 2 分钟，这通电话已经打了 5 分钟。',
    '后续轮：间隔 + 通话时长，都用口语');
  includes(later, '距对方上一句', '必须说清距上一句多久');
  includes(later, '这通电话已经打了', '必须说清通话已进行多久');
  notIncludes(later, '10月20日', '后续轮不重复报日期');

  // 刚说完（几秒）不该报成"0 分钟"
  var quick = VD.describeClock({
    enabled: true, now: vmTs(2026, 10, 20, 22, 34, 2),
    callStartedAt: vmTs(2026, 10, 20, 22, 30, 0),
    lastTurnAt: vmTs(2026, 10, 20, 22, 34, 0), turnIndex: 2
  });
  includes(quick, '只隔了几秒', '几秒的间隔说「只隔了几秒」');

  // >10 分钟：必须明确说出"过了 X 分钟"
  var longGap = VD.describeClock({
    enabled: true, now: vmTs(2026, 10, 20, 22, 55, 0),
    callStartedAt: vmTs(2026, 10, 20, 22, 20, 0),
    lastTurnAt: vmTs(2026, 10, 20, 22, 32, 0), turnIndex: 9
  });
  includes(longGap, '过了 23 分钟', '>10 分钟要说「过了 23 分钟」');
  includes(longGap, '35 分钟', '通话时长用分钟');

  // >1 小时：小时 + 分钟
  var longHour = VD.describeClock({
    enabled: true, now: vmTs(2026, 10, 20, 23, 40, 0),
    callStartedAt: vmTs(2026, 10, 20, 22, 10, 0),
    lastTurnAt: vmTs(2026, 10, 20, 22, 30, 0), turnIndex: 12
  });
  includes(longHour, '1 小时 10 分钟', '>1 小时的间隔要说「X 小时 Y 分钟」');
  includes(longHour, '1 小时 30 分钟', '>1 小时的通话时长要说「X 小时 Y 分钟」');

  // 跨天：聊过零点必须点明
  var cross = VD.describeClock({
    enabled: true, now: vmTs(2026, 10, 21, 0, 10, 0),
    callStartedAt: vmTs(2026, 10, 20, 23, 50, 0),
    lastTurnAt: vmTs(2026, 10, 20, 23, 59, 0), turnIndex: 5
  });
  includes(cross, '已经到第二天了', '跨天必须说「已经到第二天了」');
  notIncludes(cross, '2026-', '跨天输出里也不许有 ISO 字符串');
});

// ============================================================
// 16. v126 buildCallLayer（通话层）
// ============================================================
describe('buildCallLayer', function () {
  var layer = VD.buildCallLayer({ personaId: 'tease', brevity: 'normal' });

  includes(layer, '你正在和对方打电话，你说的每句话会被直接念出来，对方看不到文字',
    '必须说明这是打电话、对方看不到文字');
  includes(layer, '短句', '硬规则必须有「短句」');
  includes(layer, '口语', '硬规则必须有「口语」');
  includes(layer, 'Markdown', '必须禁止 Markdown');
  includes(layer, 'emoji', '必须禁止 emoji');
  includes(layer, '括号', '必须禁止念出括号里的动作');
  includes(layer, '2~3 句', 'brevity=normal 应带上句数上限');
  includes(layer, '俏皮损友', '人设名应注入');
  includes(layer, VD.getPersona('tease').systemFlavor.slice(0, 12), '人设 systemFlavor 应注入');
  includes(layer, '默认说话感觉', '应给出该人设的默认语气/语速/音量');

  // 通话层只管信道，不管输出协议：JSON 与状态栏都留在 voice.js
  notIncludes(layer, 'JSON', '通话层不许再写一遍 JSON 输出格式');
  notIncludes(layer, 'speech 必须排第一个', '通话层不许重复字段顺序要求');
  notIncludes(layer, '<status>', '通话层不许出现状态栏相关内容');

  // 默认档位 + 无额外设定
  var plain = VD.buildCallLayer({});
  includes(plain, '1~2 句', '默认 brevity=short 应为 1~2 句');
  notIncludes(plain, '额外设定', '没有 customPersona 时不该出现额外设定小节');

  var custom = VD.buildCallLayer({ personaId: 'warm', customPersona: '说话带一点南方口音' });
  includes(custom, '额外设定', 'customPersona 非空应追加额外设定小节');
  includes(custom, '说话带一点南方口音', 'customPersona 内容应注入');

  // 声音状态：字符串入口
  var sig = { speechMs: 5000, speechRateCps: 5.4, loudness: '高', pitchRangeSemitone: 6.2, speechRatio: 0.95 };
  var withSigText = VD.buildCallLayer({ signalsText: '对方说得又快又冲。', signals: sig });
  includes(withSigText, '对方这一段的声音状态', 'signalsText 非空应注入声音状态小节');
  includes(withSigText, '对方说得又快又冲。', 'signalsText 原文应保留');
  includes(withSigText, '这一轮请这样处理', '应带上 signalHints 的处理建议');
  // 对象入口
  includes(VD.buildCallLayer({ signals: sig }), '语速偏快', 'signals 对象入口应翻译成中文');

  // 时间感知：开 / 关
  var clock = { enabled: true, now: vmTs(2026, 10, 20, 22, 30), callStartedAt: vmTs(2026, 10, 20, 22, 30), lastTurnAt: 0, turnIndex: 0 };
  var withClock = VD.buildCallLayer({ clock: clock });
  includes(withClock, '现在的时间和通话进度', 'clock.enabled 时应插入时间小节');
  includes(withClock, '晚上十点半', '时间小节应使用 describeClock 的口语化结果');

  var noClock = VD.buildCallLayer({ clock: { enabled: false, now: vmTs(2026, 10, 20, 22, 30) } });
  notIncludes(noClock, '现在的时间和通话进度', 'clock 关闭时不该出现时间小节');
  notIncludes(noClock, '晚上十点半', 'clock 关闭时不该出现具体时间');

  noThrow(function () { VD.buildCallLayer(); }, 'buildCallLayer() 无参不崩');
  noThrow(function () { VD.buildCallLayer(null); }, 'buildCallLayer(null) 不崩');
  eq(VD.buildCallLayer({ personaId: 'warm' }), VD.buildCallLayer({ personaId: 'warm' }),
    '同参数两次调用结果一致（纯函数，无残留状态）');
});

// ============================================================
// 17. v126 buildCallMarker（开始 / 结束标记）
// ============================================================
describe('buildCallMarker', function () {
  var start = VD.buildCallMarker({ kind: 'start', at: vmTs(2026, 10, 20, 22, 30) });
  eq(start.role, 'system', '开始标记是 system 消息');
  eq(start.marker, 'call', '开始标记 marker=call');
  eq(start.content, '【语音通话开始 · 10月20日 22:30】', '开始标记文案');

  var end = VD.buildCallMarker({
    kind: 'end', at: vmTs(2026, 10, 20, 22, 42, 34),
    startedAt: vmTs(2026, 10, 20, 22, 30, 0), turns: 18
  });
  eq(end.role, 'system', '结束标记是 system 消息');
  eq(end.marker, 'call', '结束标记 marker=call');
  eq(end.content, '【语音通话结束 · 22:42 · 通话 12 分 34 秒 · 18 轮】', '结束标记文案');

  // 时长三档：不足 1 分钟用秒 / 超过 1 分钟用分秒 / 超过 1 小时用小时分
  var shortEnd = VD.buildCallMarker({
    kind: 'end', at: vmTs(2026, 10, 20, 22, 30, 34),
    startedAt: vmTs(2026, 10, 20, 22, 30, 0), turns: 2
  });
  eq(shortEnd.content, '【语音通话结束 · 22:30 · 通话 34 秒 · 2 轮】', '不足 1 分钟按秒算');

  var hourEnd = VD.buildCallMarker({
    kind: 'end', at: vmTs(2026, 10, 20, 23, 40, 0),
    startedAt: vmTs(2026, 10, 20, 22, 30, 0), turns: 40
  });
  eq(hourEnd.content, '【语音通话结束 · 23:40 · 通话 1 小时 10 分 · 40 轮】', '超过 1 小时按小时+分算');

  // 非法入参兜底：不抛、能省掉的片段就省掉
  var noArg = VD.buildCallMarker();
  eq(noArg.content, '【语音通话开始】', '无参时只有裸标记，不抛');
  eq(noArg.marker, 'call', '无参也带 marker');
  var bareEnd = VD.buildCallMarker({ kind: 'end' });
  eq(bareEnd.content, '【语音通话结束】', '结束标记无时间时只剩裸标记');
  var zeroTurns = VD.buildCallMarker({
    kind: 'end', at: vmTs(2026, 10, 20, 22, 30, 34),
    startedAt: vmTs(2026, 10, 20, 22, 30, 0), turns: 0
  });
  eq(zeroTurns.content, '【语音通话结束 · 22:30 · 通话 34 秒】', '0 轮时省略轮数');
  noThrow(function () { VD.buildCallMarker({ kind: 'end', at: 'x', startedAt: {}, turns: 'y' }); },
    '脏入参不抛');
  eq(VD.buildCallMarker({ kind: 'end', at: vmTs(2026, 10, 20, 22, 30, 0), startedAt: vmTs(2026, 10, 20, 23, 30, 0) }).content,
    '【语音通话结束 · 22:30】', 'at 早于 startedAt 时不硬算负时长');
});

// ============================================================
// 18. v126 resolveTuning（双套微调预设）
// ============================================================
describe('resolveTuning', function () {
  var base = { echoGuardMs: 250, bargeInHoldMs: 180, sensitivity: 0.5 };
  var preset = { echoGuardMs: 350, sensitivity: 0.8, 未知键: 1 };
  var merged = VD.resolveTuning(base, preset);

  eq(merged.echoGuardMs, 350, 'preset 合法数字应覆盖 base');
  eq(merged.sensitivity, 0.8, 'preset 合法小数应覆盖 base');
  eq(merged.bargeInHoldMs, 180, 'preset 没给的键保留 base');
  eq(merged['未知键'], undefined, '未知键应丢弃');
  eq(base.echoGuardMs, 250, '不许改入参 base');
  eq(base.sensitivity, 0.5, '不许改入参（小数）');
  ok(merged !== base, '必须返回新对象');

  // 非法值忽略：NaN / 非数字 / 超范围
  var bad = VD.resolveTuning(base, {
    echoGuardMs: 'abc', bargeInHoldMs: NaN, sensitivity: 2,
    endpointSilenceMs: 99999, leakFloor: -1
  });
  eq(bad.echoGuardMs, 250, '非数字忽略');
  eq(bad.bargeInHoldMs, 180, 'NaN 忽略');
  eq(bad.sensitivity, 0.5, '超上限忽略');
  eq(bad.endpointSilenceMs, undefined, '超范围且 base 没有 → 不新增');
  eq(bad.leakFloor, undefined, '低于下限忽略');

  // 空 / 脏 preset
  var empty = VD.resolveTuning(base, {});
  eq(JSON.stringify(empty), JSON.stringify(base), '空 preset 等于 base 的副本');
  eq(JSON.stringify(VD.resolveTuning(base)), JSON.stringify(base), 'preset 缺省时等于 base 的副本');
  eq(JSON.stringify(VD.resolveTuning(base, null)), JSON.stringify(base), 'preset=null 等于 base 的副本');
  noThrow(function () { VD.resolveTuning(); }, 'resolveTuning() 无参不崩');
  noThrow(function () { VD.resolveTuning(null, null); }, 'resolveTuning(null,null) 不崩');

  // 表单回填是字符串，也要认
  eq(VD.resolveTuning({}, { echoGuardMs: '300' }).echoGuardMs, 300, '数字字符串应被接受');
  eq(VD.resolveTuning({}, { echoGuardMs: '' }).echoGuardMs, undefined, '空字符串不算数字');
  eq(VD.resolveTuning({}, { echoGuardMs: true }).echoGuardMs, undefined, '布尔值不算数字');

  // 边界值算合法
  eq(VD.resolveTuning({}, { echoGuardMs: 0 }).echoGuardMs, 0, '下边界 0 合法');
  eq(VD.resolveTuning({}, { endpointSilenceMs: 3000 }).endpointSilenceMs, 3000, '上边界 3000 合法');
  eq(VD.resolveTuning({}, { endpointSilenceMs: 3001 }).endpointSilenceMs, undefined, '刚过上边界就忽略');
  eq(VD.resolveTuning({}, { endpointSilenceMs: 199 }).endpointSilenceMs, undefined, '低于下边界忽略');

  // 常量面
  ok(Array.isArray(VD.TUNING_KEYS), 'TUNING_KEYS 是数组');
  eq(VD.TUNING_KEYS.length, 7, 'TUNING_KEYS 共 7 个键');
  ['echoGuardMs', 'bargeInHoldMs', 'bargeInLeakFactor', 'leakFloor',
    'endpointSilenceMs', 'minUtteranceMs', 'sensitivity'].forEach(function (k) {
    ok(VD.TUNING_KEYS.indexOf(k) >= 0, 'TUNING_KEYS 必须含 ' + k);
    ok(!!VD.TUNING_RANGES[k], 'TUNING_RANGES 必须含 ' + k);
  });
  eq(VD.TUNING_RANGES.echoGuardMs.min, 0, 'echoGuardMs 下限 0');
  eq(VD.TUNING_RANGES.echoGuardMs.max, 1200, 'echoGuardMs 上限 1200');
  eq(VD.TUNING_RANGES.bargeInHoldMs.min, 80, 'bargeInHoldMs 下限 80');
  eq(VD.TUNING_RANGES.bargeInHoldMs.max, 800, 'bargeInHoldMs 上限 800');
  eq(VD.TUNING_RANGES.bargeInLeakFactor.min, 1.5, 'bargeInLeakFactor 下限 1.5');
  eq(VD.TUNING_RANGES.bargeInLeakFactor.max, 10, 'bargeInLeakFactor 上限 10');
  eq(VD.TUNING_RANGES.leakFloor.min, 0, 'leakFloor 下限 0');
  eq(VD.TUNING_RANGES.leakFloor.max, 1, 'leakFloor 上限 1');
});

// ============================================================
// 19. v126 describeRate（语速描述）
// ============================================================
describe('describeRate', function () {
  eq(VD.RATE_MIN, 0.6, 'RATE_MIN=0.6');
  eq(VD.RATE_MAX, 1.6, 'RATE_MAX=1.6');
  eq(VD.RATE_DEFAULT, 1.0, 'RATE_DEFAULT=1.0');

  eq(VD.describeRate(1.0), '正常语速', '1.0× 是正常语速');
  eq(VD.describeRate(1.2), '偏快（1.2×）', '1.2× 偏快');
  eq(VD.describeRate(0.8), '偏慢（0.8×）', '0.8× 偏慢');

  eq(VD.describeRate(1.04), '正常语速', '1.04× 仍算正常');
  eq(VD.describeRate(1.05), '偏快（1.05×）', '1.05× 起算偏快');
  eq(VD.describeRate(0.96), '正常语速', '0.96× 仍算正常');
  eq(VD.describeRate(0.95), '偏慢（0.95×）', '0.95× 起算偏慢');

  eq(VD.describeRate(undefined), '正常语速', '缺省语速按正常');
  eq(VD.describeRate('乱写'), '正常语速', '非法语速按正常');
  eq(VD.describeRate(2), '偏快（1.6×）', '超出上限按 1.6 描述');
  eq(VD.describeRate(0.1), '偏慢（0.6×）', '低于下限按 0.6 描述');
});

// ============================================================
// 20. v126 新 API 面
// ============================================================
describe('v126 API 面', function () {
  ['buildCallLayer', 'describeClock', 'buildCallMarker', 'resolveTuning', 'describeRate']
    .forEach(function (k) {
      eq(typeof VD[k], 'function', 'API 必须提供 ' + k);
    });
  ok(Array.isArray(VD.TUNING_KEYS), 'API 必须提供 TUNING_KEYS');
  ok(!!VD.TUNING_RANGES && VD.TUNING_RANGES.echoGuardMs, 'API 必须提供 TUNING_RANGES');
  eq(typeof VD.RATE_MIN, 'number', 'API 必须提供 RATE_MIN');
  eq(typeof VD.RATE_MAX, 'number', 'API 必须提供 RATE_MAX');
  eq(typeof VD.RATE_DEFAULT, 'number', 'API 必须提供 RATE_DEFAULT');
});

// ============================================================
// 结果
// ============================================================
var total = passed + failed;
if (failed > 0) {
  console.log('\n✗ 失败用例（' + failed + '/' + total + '）：');
  failures.forEach(function (f) { console.log('  · ' + f); });
  console.log('\n通过 ' + passed + ' / ' + total + '，失败 ' + failed);
  process.exit(1);
}
console.log('✓ 全部通过：' + passed + ' 项断言（voice-director.js）');
