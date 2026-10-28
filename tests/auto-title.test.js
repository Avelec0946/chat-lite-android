// ===== tests/auto-title.test.js =====
// 会话标题自动命名（v3.0.7 起，v3.0.10 改时机与上下文）的纯逻辑回归测试
//   node tests/auto-title.test.js
//
// 为什么值得单测：这块的正确性**全在判断逻辑上**，不在网络。最容易写错、也最贵的五条：
//   ① 把用户亲手改的名字覆盖掉（用户会骂人，而且不可恢复）
//   ② 每条消息都触发一次（每轮多烧一次请求）
//   ③ 模型不听话时把「标题：《xxx》。理由是…」整段塞进侧栏
//   ④ 模型失败后回退到「对话 N」（这才是原本要解决的问题，等于白做）
//   ⑤ **回复还没生成完就去命名**（v3.0.10 的核心约定：占位可以早，请求必须在回复之后）
// 这五条全都离线可测。

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
var ctxCalls = [];   // 记录 buildContext 的 opts（验证标题请求走了 forTitle 档位）

var sandbox = {
  console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
  String: String, Number: Number, Boolean: Boolean, Promise: Promise,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  AbortController: AbortController,
  window: { location: { hostname: 'localhost' } },
  document: { getElementById: function() { return null; } },
  isCapacitor: function() { return true; },   // 走直连分支
  renderSidebar: function() {},
  save: function() { sandbox.__saved++; },
  __saved: 0,
  getProvider: function(id) {
    var all = (sandbox.state && sandbox.state.providers) || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  },
  // 真实 buildContext 在 chat.js；这里用等价桩，只关心两件事：
  //   ① 是否收到 {forTitle:true}（沉浸档位）；② 返回的 messages 形状
  buildContext: function(conv, opts) {
    ctxCalls.push(opts || {});
    var msgs = [{ role: 'system', content: '【人设】你是明里。' }];
    (conv.activePath || []).forEach(function(id) {
      var m = conv.messageMap[id];
      if (!m || m.role === 'system') return;
      var c = (opts && opts.forTitle && typeof sandbox.atDigestForTitle === 'function')
        ? sandbox.atDigestForTitle(m)
        : (m.content || '');
      msgs.push({ role: m.role, content: c });
    });
    return msgs;
  },
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

function makeConv(msgs, opts) {
  opts = opts || {};
  var map = {};
  var path_ = [];
  var parentId = null;
  (msgs || []).forEach(function(m) {
    var id = uid();
    map[id] = {
      id: id, role: m.role, content: m.content || '', parentId: parentId,
      children: [], title: '', files: m.files || [],
      versions: [{ content: m.content || '', timestamp: Date.now(), reason: m.reason || 'original' }],
      activeVersion: 0, source: m.source || ''
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
  if (opts.eligible !== false) conv.titleAutoEligible = true;
  if (opts.titleSetByUser) conv.titleSetByUser = true;
  if (opts.titleAuto) conv.titleAuto = opts.titleAuto;
  return conv;
}

function wait(ms) { return new Promise(function(r) { setTimeout(r, ms || 30); }); }

function reset() {
  calls.length = 0;
  responses.length = 0;
  ctxCalls.length = 0;
  sandbox.__saved = 0;
  sandbox.settings = { autoTitle: { enabled: true } };
  sandbox.state.conversations = [];
  sandbox.state.providers = [{ id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', template: 'deepseek' }];
}

// 回复后的 assistantMsg 伪装
function reply(text, extra) {
  return Object.assign({ content: text }, extra || {});
}

// ---------- 默认值 / 迁移 ----------
console.log('\n[默认值与迁移]');
(function() {
  var def = sandbox.defaultAutoTitleSettings();
  ok('默认开启（用户要求默认开）', def.enabled === true, JSON.stringify(def));
  ok('空/undefined → 默认开', sandbox.migrateAutoTitleSettings(undefined).enabled === true);
  ok('用户关过 → 尊重', sandbox.migrateAutoTitleSettings({ enabled: false }).enabled === false);
  ok('脏值（字符串 "false"）→ 视为开，不静默关功能', sandbox.migrateAutoTitleSettings({ enabled: 'false' }).enabled === true);
})();

// ---------- 截断式 ----------
console.log('\n[截断式]');
(function() {
  var t = sandbox.atTruncate('  帮我写一个\n\n**Python 脚本**，用来批量重命名文件，谢谢  ');
  ok('折叠换行与 markdown 记号', t === '帮我写一个 Python 脚本，…', JSON.stringify(t));
  var long = sandbox.atTruncate('这是一段非常非常长的第一句话用来测试标题截断的逻辑是否正确');
  ok('超长截断到 16 字 + 省略号', Array.from(long).length === 17 && long.slice(-1) === '…', long);
  var code = sandbox.atTruncate('```js\nconsole.log(1)\n```\n解释这段代码');
  ok('代码块被丢弃', code === '解释这段代码', JSON.stringify(code));
})();

// ---------- 附件降载（标题请求专用） ----------
console.log('\n[附件降载 atDigestForTitle]');
(function() {
  var f = sandbox.atDigestForTitle;
  var m1 = f({ content: '看看这几张图', files: [{ name: 'a.jpg', isImage: true }, { name: 'b.jpg', isImage: true }] });
  ok('图片只给数量，不给内容', /［图片 2 张］/.test(m1) && !/base64/.test(m1), m1);
  var m2 = f({ content: '', files: [{ name: 'report.pdf', isImage: false, size: 12 * 1024 * 1024 }] });
  ok('文本附件给名字与大小', /report\.pdf/.test(m2) && /KB/.test(m2), m2);
  var m3 = f({ content: new Array(2001).join('字') });
  ok('正文截到 800 字 + 省略号', Array.from(m3).length === 801, String(Array.from(m3).length));
  ok('空消息有兜底', f({ content: '' }) === '［空消息］', f({ content: '' }));
})();

// ---------- 模型输出清洗 ----------
console.log('\n[模型输出清洗]');
(function() {
  var f = sandbox.atSanitizeModelTitle;
  ok('「标题：《xxx》。」→ xxx', f('标题：《批量重命名脚本》。') === '批量重命名脚本', f('标题：《批量重命名脚本》。'));
  ok('带引号 → 去引号', f('"贪吃蛇游戏"') === '贪吃蛇游戏', f('"贪吃蛇游戏"'));
  ok('多行只取第一行', f('会话标题：写诗\n理由：因为用户要求') === '写诗', f('会话标题：写诗\n理由：因为用户要求'));
  ok('空 → 空串', f('   ') === '' && f(null) === '');
  ok('超长掐到 16 字', Array.from(f('一二三四五六七八九十一二三四五六七八')).length === 16);
})();

// ---------- 主流程 ----------
console.log('\n[主流程]');
(async function() {
  // 1) 发送时占位：只改标题，不发请求
  //   ★ conv 里把 assistant 也造出来 —— 真实场景中 autoTitleAfterReply 是在回复落库之后才调的，
  //     所以"标题请求的上下文里能看到这一轮的回复"是设计目标（不然就退回"只看用户问了什么"了）。
  reset();
  var c1 = makeConv([
    { role: 'user', content: '帮我写个批量重命名的脚本' },
    { role: 'assistant', content: '这是一个用 Python 写的批量重命名脚本…' }
  ]);
  sandbox.state.conversations = [c1];
  sandbox.autoTitlePlaceholder(c1);
  ok('占位：标题立刻变成真内容', c1.title === '帮我写个批量重命名的脚本', c1.title);
  ok('占位：不发任何请求', calls.length === 0, String(calls.length));
  ok('占位：留 placeholderAt 但不标 done', !!(c1.titleAuto && c1.titleAuto.placeholderAt) && !c1.titleAuto.done, JSON.stringify(c1.titleAuto));

  // 2) 回复完成后才命名
  responses.push({ body: { choices: [{ message: { content: '批量重命名脚本' } }] } });
  sandbox.autoTitleAfterReply(c1, reply('这是一个用 Python 写的批量重命名脚本…'));
  await wait(40);
  ok('回复后：模型标题覆盖占位', c1.title === '批量重命名脚本', c1.title);
  ok('回复后：只发了一次请求', calls.length === 1, String(calls.length));
  ok('回复后：落 done + stage=model', c1.titleAuto.done === true && c1.titleAuto.stage === 'model', JSON.stringify(c1.titleAuto));

  // 3) 请求是"沉浸"的：走 buildContext({forTitle:true})，末尾追加标题指令
  ok('上下文走 forTitle 档位', ctxCalls.length === 1 && ctxCalls[0].forTitle === true, JSON.stringify(ctxCalls));
  var msgs = calls[0] && calls[0].body && calls[0].body.messages;
  ok('上下文里保留了人设（沉浸）', !!msgs && /【人设】/.test(msgs[0].content), msgs && msgs[0].content);
  ok('上下文里含 assistant 的回复（不只用户那句）', !!msgs && msgs.some(function(m) { return m.role === 'assistant'; }));
  var last = msgs && msgs[msgs.length - 1];
  ok('末尾追加的是 user 指令（不是 system）', !!last && last.role === 'user' && /标题/.test(last.content), JSON.stringify(last));

  // 4) 采样参数：关思考 + 小 max_tokens + 非流式
  var body = calls[0] && calls[0].body;
  ok('thinking 显式关闭（否则推理模型 content 是空串）', body && body.thinking && body.thinking.type === 'disabled', JSON.stringify(body && body.thinking));
  ok('不带 thinkingEnabled 字段', body && body.thinkingEnabled === undefined);
  ok('max_tokens 很小且存在', body && typeof body.max_tokens === 'number' && body.max_tokens <= 128);
  ok('stream=false', body && body.stream === false);

  // 5) 已命名过 → 不再发
  reset();
  var c2 = makeConv([{ role: 'user', content: '第一句' }, { role: 'assistant', content: '答' }],
    { titleAuto: { placeholderAt: 1, done: true, stage: 'model' } });
  sandbox.state.conversations = [c2];
  sandbox.autoTitleAfterReply(c2, reply('又答了一句'));
  await wait(30);
  ok('已命名 → 不发请求、不改名', calls.length === 0 && c2.title === '对话 3', c2.title);

  // 6) 空回复 / 错误回复 → 不命名，保留占位
  reset();
  var c3 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [c3];
  sandbox.autoTitlePlaceholder(c3);
  var titleAfterPlaceholder = c3.title;
  sandbox.autoTitleAfterReply(c3, reply(''));
  await wait(30);
  ok('空回复 → 不发请求', calls.length === 0, String(calls.length));
  ok('空回复 → 保留占位标题', c3.title === titleAfterPlaceholder, c3.title);

  sandbox.autoTitleAfterReply(c3, reply('**错误：** HTTP 500', { isError: true }));
  await wait(30);
  ok('错误回复 → 不发请求', calls.length === 0, String(calls.length));

  // 7) 被打断但有内容 → 照样命名（用户拍板：有内容就更新）
  reset();
  var c4 = makeConv([{ role: 'user', content: '讲讲唐朝' }]);
  sandbox.state.conversations = [c4];
  sandbox.autoTitlePlaceholder(c4);
  responses.push({ body: { choices: [{ message: { content: '唐朝历史' } }] } });
  sandbox.autoTitleAfterReply(c4, reply('唐朝（618—907）…', { interrupted: true }));
  await wait(40);
  ok('中断但有半截内容 → 照样命名', c4.title === '唐朝历史', c4.title);

  // 8) 用户手改过 → 占位与命名都不碰
  reset();
  var c5 = makeConv([{ role: 'user', content: '帮我写个脚本' }], { title: '我的私人会话', titleSetByUser: true });
  sandbox.state.conversations = [c5];
  sandbox.autoTitlePlaceholder(c5);
  sandbox.autoTitleAfterReply(c5, reply('好的'));
  await wait(30);
  ok('手改过 → 标题不变', c5.title === '我的私人会话', c5.title);
  ok('手改过 → 连占位都不做、不发请求', calls.length === 0 && !c5.titleAuto, JSON.stringify(c5.titleAuto));

  // 9) 生成途中被手改 → 结果丢弃
  reset();
  var c6 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [c6];
  sandbox.autoTitlePlaceholder(c6);
  responses.push({ body: { choices: [{ message: { content: '模型起的名字' } }] } });
  sandbox.autoTitleAfterReply(c6, reply('回复内容'));
  c6.titleSetByUser = true;
  c6.title = '我改的';
  await wait(40);
  ok('生成期间被手改 → 模型结果丢弃', c6.title === '我改的', c6.title);

  // 10) 老会话（没有 titleAutoEligible）→ 一律不碰
  reset();
  var c7 = makeConv([{ role: 'user', content: '老会话里的一条消息' }], { eligible: false, title: '对话 7' });
  sandbox.state.conversations = [c7];
  sandbox.autoTitlePlaceholder(c7);
  sandbox.autoTitleAfterReply(c7, reply('回复'));
  await wait(30);
  ok('老会话 → 不改名、不发请求', c7.title === '对话 7' && calls.length === 0, c7.title + '/' + calls.length);

  // 11) 非首轮（两条 user）→ 不碰
  reset();
  var c8 = makeConv([
    { role: 'user', content: '第一条' }, { role: 'assistant', content: '答' },
    { role: 'user', content: '第二条' }
  ]);
  sandbox.state.conversations = [c8];
  sandbox.autoTitlePlaceholder(c8);
  sandbox.autoTitleAfterReply(c8, reply('答'));
  await wait(30);
  ok('已两轮 → 不补命名', c8.title === '对话 3' && calls.length === 0, c8.title + '/' + calls.length);

  // 12) 纯图片首条 → 占位「图片对话」，但不问模型
  reset();
  var c9 = makeConv([{ role: 'user', content: '', files: [{ name: 'a.jpg', isImage: true }] }]);
  sandbox.state.conversations = [c9];
  sandbox.autoTitlePlaceholder(c9);
  ok('纯图片 → 占位「图片对话」', c9.title === '图片对话', c9.title);
  sandbox.autoTitleAfterReply(c9, reply('看到了，这是…'));
  await wait(30);
  ok('纯图片 → 不发模型请求', calls.length === 0, String(calls.length));

  // 13) 语音格式首条（source:'voice'）→ 同样处理
  reset();
  var c10 = makeConv([{ role: 'user', content: '今天外面下雨了吗我看窗外有点阴', source: 'voice', reason: 'voice' }]);
  sandbox.state.conversations = [c10];
  sandbox.autoTitlePlaceholder(c10);
  ok('语音首条 → 占位生效', c10.title === '今天外面下雨了吗我看窗外有点阴', c10.title);
  responses.push({ body: { choices: [{ message: { content: '窗外阴天是否下雨' } }] } });
  sandbox.autoTitleAfterReply(c10, reply('窗外阴，可能下雨'));
  await wait(40);
  ok('语音首条 → 回复后模型标题覆盖', c10.title === '窗外阴天是否下雨', c10.title);

  // 14) 关掉开关 → 什么都不做
  reset();
  sandbox.settings = { autoTitle: { enabled: false } };
  var c11 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [c11];
  sandbox.autoTitlePlaceholder(c11);
  sandbox.autoTitleAfterReply(c11, reply('好的'));
  await wait(30);
  ok('关开关 → 保持「对话 N」、不发请求', c11.title === '对话 3' && calls.length === 0, c11.title);

  // 15) 模型 500 / 空 content → 保留占位，不回退「对话 N」
  reset();
  var c12 = makeConv([{ role: 'user', content: '分析这份财报' }]);
  sandbox.state.conversations = [c12];
  sandbox.autoTitlePlaceholder(c12);
  responses.push({ status: 500, body: { error: 'boom' } });
  sandbox.autoTitleAfterReply(c12, reply('财报显示…'));
  await wait(40);
  ok('模型 500 → 保留占位标题', c12.title === '分析这份财报', c12.title);
  ok('模型 500 → 没落 done（还有机会）', !c12.titleAuto.done, JSON.stringify(c12.titleAuto));

  reset();
  var c13 = makeConv([{ role: 'user', content: '写一首短诗' }]);
  sandbox.state.conversations = [c13];
  sandbox.autoTitlePlaceholder(c13);
  responses.push({ body: { choices: [{ message: { content: '' } }] } });
  sandbox.autoTitleAfterReply(c13, reply('床前明月光'));
  await wait(40);
  ok('空 content → 保留占位标题', c13.title === '写一首短诗', c13.title);

  // 16) 会话已被删除 → 不写回
  reset();
  var c14 = makeConv([{ role: 'user', content: '帮我写个脚本' }]);
  sandbox.state.conversations = [];
  sandbox.autoTitlePlaceholder(c14);
  sandbox.autoTitleAfterReply(c14, reply('好的'));
  await wait(30);
  ok('会话已删除 → 标题不动', c14.title === '对话 3', c14.title);

  // 17) 没有接口 / 没 key → 占位照做，命名跳过，不抛异常
  reset();
  sandbox.state.providers = [];
  var c15 = makeConv([{ role: 'user', content: '在吗' }]);
  sandbox.state.conversations = [c15];
  sandbox.autoTitlePlaceholder(c15);
  sandbox.autoTitleAfterReply(c15, reply('在的'));
  await wait(30);
  ok('没有接口 → 占位兜底，不抛异常', c15.title === '在吗' && calls.length === 0, c15.title);

  // ---------- 汇总 ----------
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures > 0) process.exit(1);
})();
