// ===== tests/auto-title.test.js =====
// 会话标题自动命名（v3.0.7）的纯逻辑回归测试
//   node tests/auto-title.test.js
//
// 为什么值得单测：这块的**正确性全在判断逻辑上**，不在网络。
//   最容易写错、也最贵的四个点：
//     ① 把用户亲手改的名字覆盖掉（用户会骂人，而且不可恢复）
//     ② 每条消息都触发一次（每轮多烧一次请求）
//     ③ 模型不听话时把「标题：《xxx》。理由是…」整段塞进侧栏（撑爆一行）
//     ④ 模型失败后回退到「对话 N」（这才是原本要解决的问题，等于白做）
//   这四条全都离线可测。

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var failures = 0;
var passes = 0;

function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + name); }
  else { failures++; console.log('  \u2717 ' + name + (detail ? '  \u2192 ' + detail : '')); }
}

function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  var i = src.indexOf('{', start);
  var depth = 0, inStr = false, esc = false, end = -1;
  for (; i < src.length; i++) {
    var c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

// ---------- 沙箱 ----------
var calls = [];
var responses = [];
var sidebarRenders = 0;

var sandbox = {
  console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
  String: String, Number: Number, Boolean: Boolean, Promise: Promise,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  AbortController: AbortController,
  window: { location: { hostname: 'localhost' } },
  document: { getElementById: function() { return null; } },
  isCapacitor: function() { return true; },   // 走直连分支
  renderSidebar: function() { sidebarRenders++; },
  save: function() { sandbox.__saved++; },
  __saved: 0,
  getProvider: function(id) {
    var all = (sandbox.state && sandbox.state.providers) || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  },
  // 真实 buildUpstreamPayload 在 providers.js，这里只需验证"请求长什么样"，用等价简化版：
  //   关键是把 thinkingEnabled 翻成 thinking:{type:'disabled'}（真实现见 providers.js:196）
  buildUpstreamPayload: function(provider, body) {
    var payload = Object.assign({}, body);
    if (payload.thinkingEnabled === false) payload.thinking = { type: 'disabled' };
    delete payload.thinkingEnabled;
    return {
      url: String(provider.baseUrl || '').replace(/\/+$/, '') + '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
      payload: payload
    };
  },
  settings: { autoTitle: { enabled: true } },
  state: {
    providers: [{ id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', template: 'deepseek' }],
    conversations: []
  },
  fetch: function(url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    var r = responses.shift();
    if (!r) return Promise.reject(new Error('没有预置响应'));
    if (r.reject) return Promise.reject(r.reject);
    if (r.hang) return new Promise(function() {});
    return Promise.resolve({
      ok: r.status ? (r.status >= 200 && r.status < 300) : true,
      status: r.status || 200,
      text: function() {
        return Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      }
    });
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'auto-title.js'), 'utf8'), sandbox);

// db.js 的默认值与迁移
var dbSrc = fs.readFileSync(path.join(__dirname, '..', 'www', 'db.js'), 'utf8');
vm.runInContext(extractFn(dbSrc, 'defaultAutoTitleSettings'), sandbox);
vm.runInContext(extractFn(dbSrc, 'migrateAutoTitleSettings'), sandbox);

// ---------- 造会话 ----------
var seq = 0;
function uid() { return 'm' + (++seq); }

// msgs: [{role, content, files}]
function makeConv(msgs, opts) {
  opts = opts || {};
  var map = {};
  var path_ = [];
  var parentId = null;
  (msgs || []).forEach(function(m) {
    var id = uid();
    map[id] = {
      id: id, role: m.role, content: m.content || '', parentId: parentId,
      children: [], title: '', files: m.files || [], versions: [{ content: m.content || '', timestamp: Date.now(), reason: m.reason || 'original' }], activeVersion: 0,
      source: m.source || ''
    };
    if (parentId) map[parentId].children.push(id);
    path_.push(id);
    parentId = id;
  });
  var conv = {
    id: opts.id || ('c' + (++seq)), title: opts.title || '对话 3',
    model: 'deepseek-v4-flash', providerId: 'p1',
    rootId: null, activePath: path_, messageMap: map
  };
  // v3.0.7: 新建会话带 titleAutoEligible；eligible:false 用来模拟"导入的老会话"
  if (opts.eligible !== false) conv.titleAutoEligible = true;
  if (opts.titleSetByUser) conv.titleSetByUser = true;
  if (opts.titleAuto) conv.titleAuto = opts.titleAuto;
  return conv;
}

function wait(ms) { return new Promise(function(r) { setTimeout(r, ms || 30); }); }

function reset() {
  calls.length = 0;
  responses.length = 0;
  sandbox.settings = { autoTitle: { enabled: true } };
  sandbox.state.conversations = [];
}

// ---------- 默认值 / 迁移 ----------
console.log('\n[默认值与迁移]');
(function() {
  var def = sandbox.defaultAutoTitleSettings();
  ok('默认开启（用户要求默认开）', def.enabled === true, JSON.stringify(def));
  ok('空/undefined → 默认开', sandbox.migrateAutoTitleSettings(undefined).enabled === true);
  ok('用户关过 → 尊重（false 不被默认值盖回 true）', sandbox.migrateAutoTitleSettings({ enabled: false }).enabled === false);
  ok('脏值（字符串 "false"）→ 视为开，不静默关功能', sandbox.migrateAutoTitleSettings({ enabled: 'false' }).enabled === true);
})();

// ---------- 截断式 ----------
console.log('\n[截断式]');
(function() {
  var t = sandbox.atTruncate('  帮我写一个\n\n**Python 脚本**，用来批量重命名文件，谢谢  ');
  // 16 个字符 = 帮我写一个(5) + 空格(6) + Python(12) + 空格(13) + 脚本， (16)
  ok('折叠换行与 markdown 记号', t === '帮我写一个 Python 脚本，…', JSON.stringify(t));
  var long = sandbox.atTruncate('这是一段非常非常长的第一句话用来测试标题截断的逻辑是否正确');
  ok('超长截断到 16 字 + 省略号', Array.from(long).length === 17 && long.slice(-1) === '…', long);
  var code = sandbox.atTruncate('```js\nconsole.log(1)\n```\n解释这段代码');
  ok('代码块被丢弃', code === '解释这段代码', JSON.stringify(code));
})();

// ---------- 模型输出清洗 ----------
console.log('\n[模型输出清洗]');
(function() {
  var f = sandbox.atSanitizeModelTitle;
  ok('「标题：《xxx》。」→ xxx', f('标题：《批量重命名脚本》。') === '批量重命名脚本', f('标题：《批量重命名脚本》。'));
  ok('带引号 → 去引号', f('"贪吃蛇游戏"') === '贪吃蛇游戏', f('"贪吃蛇游戏"'));
  ok('多行只取第一行', f('会话标题：写诗\n理由：因为用户要求') === '写诗', f('会话标题：写诗\n理由：因为用户要求'));
  ok('空 → 空串（调用方据此保持截断式）', f('   ') === '' && f(null) === '');
  ok('超长掐到 16 字', Array.from(f('一二三四五六七八九十一二三四五六七八')).length === 16);
})();

// ---------- 主流程 ----------
console.log('\n[主流程]');
(async function() {
  // 1) 首轮：立刻截断式 + 异步模型标题覆盖
  reset();
  var c1 = makeConv([{ role: 'user', content: '帮我写个批量重命名的脚本' }]);
  sandbox.state.conversations = [c1];
  responses.push({ body: { choices: [{ message: { content: '批量重命名脚本' } }] } });
  sandbox.maybeAutoTitle(c1);
  ok('同步就换掉了「对话 3」（模型慢也看不到旧标题）', c1.title === '帮我写个批量重命名的脚本', c1.title);
  await wait(40);
  ok('模型标题回来后覆盖截断式', c1.title === '批量重命名脚本', c1.title);
  ok('落了一次 done 标记', c1.titleAuto && c1.titleAuto.done === true && c1.titleAuto.stage === 'model', JSON.stringify(c1.titleAuto));
  ok('只发了一次请求', calls.length === 1, String(calls.length));

  // 2) 请求形状：关思考 + 小 max_tokens + 非流式
  var body = calls[0] && calls[0].body;
  ok('thinking 显式关闭（否则推理模型会把 max_tokens 吃光）',
    body && body.thinking && body.thinking.type === 'disabled', JSON.stringify(body && body.thinking));
  ok('不再携带 thinkingEnabled 字段', body && body.thinkingEnabled === undefined);
  ok('max_tokens 存在且很小', body && typeof body.max_tokens === 'number' && body.max_tokens <= 128, String(body && body.max_tokens));
  ok('stream=false', body && body.stream === false);

  // 3) 只做一次：第二轮不触发
  reset();
  var c2 = makeConv([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '第二条' }
  ], { titleAuto: { done: true, stage: 'model' } });
  sandbox.state.conversations = [c2];
  sandbox.maybeAutoTitle(c2);
  await wait(30);
  ok('已命名过 → 不动标题', c2.title === '对话 3', c2.title);
  ok('已命名过 → 不发请求', calls.length === 0, String(calls.length));

  // 4) 非首轮（两条 user，但没 done 标记 —— 老会话升级场景）
  reset();
  var c3 = makeConv([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '第二条' }
  ]);
  sandbox.state.conversations = [c3];
  sandbox.maybeAutoTitle(c3);
  await wait(30);
  ok('老会话（已有两轮）不补命名', c3.title === '对话 3' && calls.length === 0, c3.title + '/' + calls.length);

  // 5) 用户手改过 → 永远不碰
  reset();
  var c4 = makeConv([{ role: 'user', content: '帮我写个脚本' }], { title: '我的私人会话', titleSetByUser: true });
  sandbox.state.conversations = [c4];
  sandbox.maybeAutoTitle(c4);
  await wait(30);
  ok('用户起的名不被覆盖', c4.title === '我的私人会话', c4.title);
  ok('用户起的名 → 连请求都不发', calls.length === 0, String(calls.length));

  // 6) 生成途中用户手改 → 结果丢弃
  reset();
  var c5 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [c5];
  responses.push({ body: { choices: [{ message: { content: '模型起的名字' } }] } });
  sandbox.maybeAutoTitle(c5);
  c5.titleSetByUser = true;
  c5.title = '我改的';
  await wait(40);
  ok('生成期间被手改 → 模型结果丢弃', c5.title === '我改的', c5.title);

  // 7) 模型失败（HTTP 500 / 拒绝）→ 停在截断式，不回退「对话 N」
  reset();
  var c6 = makeConv([{ role: 'user', content: '分析这份财报' }]);
  sandbox.state.conversations = [c6];
  responses.push({ status: 500, body: { error: 'boom' } });
  sandbox.maybeAutoTitle(c6);
  await wait(40);
  ok('模型 500 → 保持截断式', c6.title === '分析这份财报', c6.title);

  reset();
  var c7 = makeConv([{ role: 'user', content: '分析这份财报' }]);
  sandbox.state.conversations = [c7];
  responses.push({ reject: new Error('network') });
  sandbox.maybeAutoTitle(c7);
  await wait(40);
  ok('网络异常 → 保持截断式', c7.title === '分析这份财报', c7.title);

  // 8) 模型返回空 content（推理模型把 token 吃光）→ 保持截断式
  reset();
  var c8 = makeConv([{ role: 'user', content: '写一首短诗' }]);
  sandbox.state.conversations = [c8];
  responses.push({ body: { choices: [{ message: { content: '' } }] } });
  sandbox.maybeAutoTitle(c8);
  await wait(40);
  ok('空 content → 保持截断式', c8.title === '写一首短诗', c8.title);

  // 9) 首条只有图片 → 「图片对话」，且不发请求
  reset();
  var c9 = makeConv([{ role: 'user', content: '', files: [{ name: 'a.jpg', isImage: true }] }]);
  sandbox.state.conversations = [c9];
  sandbox.maybeAutoTitle(c9);
  await wait(40);
  ok('纯图片首条 → 图片对话', c9.title === '图片对话', c9.title);
  ok('纯图片首条 → 不发模型请求', calls.length === 0, String(calls.length));

  // 10) 只有文本附件 → 用文件名兜底
  reset();
  var c10 = makeConv([{ role: 'user', content: '', files: [{ name: 'report.pdf', isImage: false }] }]);
  sandbox.state.conversations = [c10];
  sandbox.maybeAutoTitle(c10);
  await wait(30);
  ok('文本附件首条 → 用文件名兜底', c10.title === 'report.pdf', c10.title);

  // 11) 状态栏伪 user 不参与命名
  reset();
  var c11 = makeConv([{ role: 'user', content: '【格式要求】请按以下格式回答' }]);
  sandbox.state.conversations = [c11];
  sandbox.maybeAutoTitle(c11);
  await wait(30);
  ok('伪 user（状态栏指令）不拿来命名', c11.title === '对话 3', c11.title);

  // 12) 开关关掉 → 什么都不做
  reset();
  sandbox.settings = { autoTitle: { enabled: false } };
  var c12 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [c12];
  sandbox.maybeAutoTitle(c12);
  await wait(30);
  ok('关掉开关 → 保持「对话 N」', c12.title === '对话 3' && calls.length === 0);

  // 13) 会话已被删除 → 不写回（防止给不存在的会话改名）
  reset();
  var c13 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [];
  sandbox.maybeAutoTitle(c13);
  await wait(30);
  ok('会话已删除 → 标题不动', c13.title === '对话 3', c13.title);

  // 15) 语音通话首条（source:'voice'，versions.reason='voice'）→ 同样命名
  //     ★ 通话不是另一个应用：同一套会话 + 一层语音翻译，文本侧挂"首条消息落库"的事必须同步接进来。
  //       这条用例就是钉住它 —— 谁要是给 atTextOf 加个 role/source 过滤，这里会红。
  reset();
  var c15 = makeConv([{ role: 'user', content: '今天外面下雨了吗我看窗外有点阴', source: 'voice', reason: 'voice' }]);
  sandbox.state.conversations = [c15];
  responses.push({ body: { choices: [{ message: { content: '问天气' } }] } });
  sandbox.maybeAutoTitle(c15);
  ok('语音首条 → 同步截断占位', c15.title === '今天外面下雨了吗我看窗外有点阴', c15.title);
  await wait(40);
  ok('语音首条 → 模型标题覆盖', c15.title === '问天气', c15.title);

  // 16) 导入的老会话（没有 titleAutoEligible）→ 一律不碰
  reset();
  var c16 = makeConv([{ role: 'user', content: '老会话里的一条消息' }], { eligible: false, title: '对话 7' });
  sandbox.state.conversations = [c16];
  sandbox.maybeAutoTitle(c16);
  await wait(40);
  ok('老会话（无 titleAutoEligible）→ 不改名、不发请求',
    c16.title === '对话 7' && calls.length === 0, c16.title + '/' + calls.length);

  // 14) 没 provider / 没 key → 留在截断式，不抛异常
  reset();
  sandbox.state.providers = [];
  var c14 = makeConv([{ role: 'user', content: '在吗' }]);
  sandbox.state.conversations = [c14];
  sandbox.maybeAutoTitle(c14);
  await wait(40);
  ok('没有接口 → 截断式兜底，不抛异常', c14.title === '在吗', c14.title);
  sandbox.state.providers = [{ id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x' }];

  // ---------- 汇总 ----------
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures > 0) process.exit(1);
})();
