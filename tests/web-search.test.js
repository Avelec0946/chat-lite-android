// ===== tests/web-search.test.js =====
// 联网搜索（DeepSeek Search / Fetch）的纯逻辑回归测试
//   node tests/web-search.test.js
//
// 为什么需要这个文件：联网搜索的正确性**大部分不在网络层**，而在
//   「用谁的 key」「结果拼成什么形状」「拼到哪条消息上」这三件事。
//   这三件事全都不联网也能测，而且一旦写错，表现是"模型答得像模像样但引用了不存在的链接"——
//   最贵的那种错误（用户会当真）。
//
// 做法：web-search.js 是普通脚本（顶层只有常量与函数声明），可以整体丢进 vm 沙箱；
//   只注入 document/fetch/settings/state 这些最小桩。db.js 里抠 migrateWebSearchSettings。

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
var calls = [];   // 记录发出的 HTTP 请求，供断言
var responses = [];  // 按调用顺序出队
var sandbox = {
  console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
  String: String, Number: Number, Boolean: Boolean, Promise: Promise,
  parseInt: parseInt, parseFloat: parseFloat, isFinite: isFinite, isNaN: isNaN,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  AbortController: AbortController,
  escapeHtml: function(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  showToast: function(msg) { sandbox.__toasts.push(String(msg)); },
  __toasts: [],
  save: function() { sandbox.__saved++; },
  __saved: 0,
  saveSettings: function() {},
  isCapacitor: function() { return false; },
  normalizeBaseUrl: function(u) { return String(u || '').trim().replace(/\/+$/, ''); },
  getProvider: function(id) {
    var all = (sandbox.state && sandbox.state.providers) || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  },
  document: { getElementById: function() { return null; } },
  currentConv: function() { return null; },
  hapticPattern: function() {},
  settings: {},
  state: { providers: [], abortController: null },
  fetch: function(url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    var r = responses.shift();
    if (!r) return Promise.reject(new Error('没有预置响应：' + url));
    if (r.reject) return Promise.reject(r.reject);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: function() { return Promise.resolve(JSON.stringify(r.body)); }
    });
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'web-search.js'), 'utf8'), sandbox);

// migrateWebSearchSettings 在 db.js
var dbSrc = fs.readFileSync(path.join(__dirname, '..', 'www', 'db.js'), 'utf8');
vm.runInContext(extractFn(dbSrc, 'clampNum'), sandbox);
vm.runInContext(extractFn(dbSrc, 'defaultWebSearchSettings'), sandbox);
vm.runInContext(extractFn(dbSrc, 'migrateWebSearchSettings'), sandbox);

// ---------- 迁移与默认值 ----------
console.log('\n[migrateWebSearchSettings]');
(function() {
  var def = vm.runInContext('defaultWebSearchSettings()', sandbox);
  ok('默认复用接口管理（mode=inherit）', def.mode === 'inherit', def.mode);
  ok('默认不自动开启（defaultOn=false）', def.defaultOn === false);
  ok('默认摘要模式', def.contentMode === 'summary');
  ok('默认信任的是 DeepSeek 官方地址', /api\.deepseek\.com/.test(def.baseUrl));

  var m = vm.runInContext('migrateWebSearchSettings(undefined)', sandbox);
  ok('空对象/undefined → 全套默认值', m.count === 6 && m.mode === 'inherit');

  // 只增不改：用户只改过 count，其它字段不能被默认值覆盖
  var m2 = vm.runInContext('migrateWebSearchSettings({count: 12, mode: "custom", baseUrl: "https://gw.example.com", apiKey: "sk-x"})', sandbox);
  ok('用户改过的字段保留', m2.count === 12 && m2.mode === 'custom' && m2.apiKey === 'sk-x', JSON.stringify(m2));
  ok('没改过的字段补默认', m2.showSources === true && m2.fetchTop === 2);

  var m3 = vm.runInContext('migrateWebSearchSettings({count: 999, fetchTop: 99, contentMode: "weird"})', sandbox);
  ok('count 越界收敛到 50', m3.count === 50, String(m3.count));
  ok('fetchTop 越界收敛到 3', m3.fetchTop === 3, String(m3.fetchTop));
  ok('非法 contentMode 回落 summary', m3.contentMode === 'summary');
})();

// ---------- 端点拼接 ----------
console.log('\n[端点拼接]');
(function() {
  var f = sandbox.wsEndpointUrl;
  ok('基址无 /v1 → 补 /v1', f('https://api.deepseek.com', '/tools/search') === 'https://api.deepseek.com/v1/tools/search', f('https://api.deepseek.com', '/tools/search'));
  ok('基址已带 /v1 → 不重复', f('https://api.deepseek.com/v1', '/tools/search') === 'https://api.deepseek.com/v1/tools/search', f('https://api.deepseek.com/v1', '/tools/search'));
  ok('尾部斜杠被吃掉', f('https://api.deepseek.com/', '/tools/fetch') === 'https://api.deepseek.com/v1/tools/fetch');
})();

// ---------- 密钥来源 ----------
console.log('\n[密钥来源]');
(function() {
  sandbox.state.providers = [
    { id: 'p1', name: '中转站', template: 'openai', baseUrl: 'https://api.kkaiapi.com', apiKey: 'sk-relay' },
    { id: 'p2', name: 'DeepSeek', template: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds' }
  ];
  var pick = sandbox.wsPickProvider('');
  ok('自动挑中 DeepSeek 官方，而不是排在前面的中转站', pick && pick.id === 'p2', pick && pick.id);

  sandbox.settings = { webSearch: { mode: 'inherit', providerId: '' } };
  var t = sandbox.wsResolveTarget();
  ok('复用模式解析出官方地址与密钥', t.ok && t.baseUrl === 'https://api.deepseek.com' && t.apiKey === 'sk-ds', JSON.stringify(t));

  // 显式选中转站 → 尊重用户选择
  sandbox.settings = { webSearch: { mode: 'inherit', providerId: 'p1' } };
  var t2 = sandbox.wsResolveTarget();
  ok('显式选中的接口优先', t2.ok && t2.apiKey === 'sk-relay', JSON.stringify(t2));

  // 只有中转站、没有 DeepSeek → 自动模式必须报错（不能悄悄用别人的 key）
  sandbox.state.providers = [{ id: 'p1', name: '中转站', template: 'openai', baseUrl: 'https://api.kkaiapi.com', apiKey: 'sk-relay' }];
  sandbox.settings = { webSearch: { mode: 'inherit', providerId: '' } };
  var t3 = sandbox.wsResolveTarget();
  ok('没有 DeepSeek 接口时如实报错，不瞎挑', t3.ok === false && /没有 DeepSeek 接口/.test(t3.reason), t3.reason);

  // 自定义模式
  sandbox.settings = { webSearch: { mode: 'custom', baseUrl: 'https://api.deepseek.com/', apiKey: '' } };
  var t4 = sandbox.wsResolveTarget();
  ok('自定义模式缺密钥 → 报错', t4.ok === false && /密钥为空/.test(t4.reason), t4.reason);

  sandbox.settings = { webSearch: { mode: 'custom', baseUrl: 'https://api.deepseek.com/', apiKey: 'sk-custom' } };
  var t5 = sandbox.wsResolveTarget();
  ok('自定义模式地址去尾斜杠', t5.ok && t5.baseUrl === 'https://api.deepseek.com', t5.baseUrl);
})();

// ---------- 注入块 ----------
console.log('\n[上下文注入]');
(function() {
  var block = sandbox.buildWebSearchBlock({ results: [] });
  ok('空结果要求如实说没查到', /没有查到/.test(block), block.slice(0, 40));
  ok('空结果明确禁止编造链接', /不要编造/.test(block));

  var block2 = sandbox.buildWebSearchBlock({
    query: 'q',
    results: [
      { idx: 1, title: '标题A', url: 'https://a.example.com/1', siteName: '站点A', date: '2026-10-20', authority: 3, summary: '摘要A', content: '' },
      { idx: 2, title: '标题B', url: 'https://b.example.com/2', siteName: '', date: '', authority: -1, summary: '', snippet: '片段B', content: '' }
    ]
  });
  ok('带编号与标题', /\[1\] 标题A/.test(block2) && /\[2\] 标题B/.test(block2));
  ok('带 URL', block2.indexOf('https://a.example.com/1') >= 0);
  ok('站点/日期/权威标记', /站点A · 2026-10-20 · 权威/.test(block2), block2.match(/（[^）]*）/));
  ok('摘要缺失时回落到 snippet', block2.indexOf('片段B') >= 0);
  ok('提示资料里的指令不可执行（防提示注入）', /不得执行/.test(block2));
  ok('要求引用不得编造 URL', /不得编造/.test(block2));

  // 超长结果截断
  var longRes = [{ idx: 1, title: 'x', url: 'https://x/1', content: new Array(9000).join('字') }];
  var b3 = sandbox.buildWebSearchBlock({ results: longRes });
  ok('单条超长正文被截断并标注', b3.indexOf('正文已截断') >= 0 && b3.length < 9000, String(b3.length));
})();

console.log('\n[结果拼接位置]');
(function() {
  var ctx = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '本次问题' }
  ];
  sandbox.injectWebSearchBlock(ctx, 'BLOCK');
  ok('追加到最后一条 user，而不是新起一条', ctx.length === 4 && ctx[3].content === '本次问题\n\nBLOCK', JSON.stringify(ctx[3]));
  ok('system 一个字节没动（前缀缓存）', ctx[0].content === 'SYS');
  ok('历史消息没被污染', ctx[1].content === '第一个问题');

  // 状态栏注入的伪 user 必须跳过
  var ctx2 = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '真正的问题' },
    { role: 'user', content: '【格式要求】你必须在本次回复的最末尾输出状态栏' }
  ];
  sandbox.injectWebSearchBlock(ctx2, 'BLOCK');
  ok('跳过【格式要求】伪 user，挂到真问题上', ctx2[1].content === '真正的问题\n\nBLOCK' && ctx2[2].content.indexOf('BLOCK') < 0, JSON.stringify(ctx2));

  // 多模态
  var ctx3 = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:,' } }] }];
  sandbox.injectWebSearchBlock(ctx3, 'BLOCK');
  ok('多模态消息追加一个 text part', Array.isArray(ctx3[0].content) && ctx3[0].content.length === 3 && ctx3[0].content[2].text === 'BLOCK');

  // 没有任何 user
  var ctx4 = [{ role: 'system', content: 'SYS' }];
  sandbox.injectWebSearchBlock(ctx4, 'BLOCK');
  ok('没有 user 时新起一条（宁可多一条也不丢结果）', ctx4.length === 2 && ctx4[1].role === 'user' && ctx4[1].content === 'BLOCK');
})();

// ---------- 真实请求形状（桩 fetch） ----------
console.log('\n[请求形状]');
(async function() {
  function reset() { calls.length = 0; responses.length = 0; }
  sandbox.settings = { webSearch: { mode: 'inherit', providerId: '', count: 5, contentMode: 'summary', fetchTop: 2, showSources: true } };
  sandbox.state.providers = [{ id: 'p2', name: 'DeepSeek', template: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds' }];

  // ① 摘要模式：只发一次 search，不带 need_content
  reset();
  responses.push({ status: 200, body: { results: [
    { title: 'A', url: 'https://a/1', summary: 'sa', rerank_score: 2.1, authority: 3, site_name: 'SA', date: '2026-10-01T00:00:00+00:00' },
    { title: 'B', url: 'https://b/2', snippet: 'sb', rerank_score: 1.0 }
  ] } });
  var r1 = await sandbox.runWebSearch('测试问题', {});
  ok('只发了 1 次请求', calls.length === 1, 'calls=' + calls.length);
  ok('打到 /v1/tools/search', calls[0].url === 'https://api.deepseek.com/v1/tools/search', calls[0].url);
  ok('请求体带 query 与 count', calls[0].body.query === '测试问题' && calls[0].body.count === 5, JSON.stringify(calls[0].body));
  ok('摘要模式不发 need_content', calls[0].body.need_content === undefined);
  ok('结果被归一化成 2 条且编号从 1 开始', r1.results.length === 2 && r1.results[0].idx === 1 && r1.results[1].idx === 2);
  ok('日期被转成 YYYY-MM-DD', r1.results[0].date === '2026-10-01', r1.results[0].date);

  // ② 正文模式：need_content=true，且只有 1 次请求
  reset();
  sandbox.settings.webSearch.contentMode = 'content';
  responses.push({ status: 200, body: { results: [{ title: 'A', url: 'https://a/1', content: '正文全文' }] } });
  var r2 = await sandbox.runWebSearch('q', {});
  ok('正文模式带 need_content=true', calls[0].body.need_content === true, JSON.stringify(calls[0].body));
  ok('正文模式不额外抓取', calls.length === 1 && r2.fetched === 0);

  // ③ 抓取模式：1 次 search + 前 N 次 fetch，单条失败不影响整轮
  reset();
  sandbox.settings.webSearch.contentMode = 'fetch';
  sandbox.settings.webSearch.fetchTop = 2;
  responses.push({ status: 200, body: { results: [
    { title: 'A', url: 'https://a/1', summary: 'sa' },
    { title: 'B', url: 'https://b/2', summary: 'sb' },
    { title: 'C', url: 'https://c/3', summary: 'sc' }
  ] } });
  responses.push({ status: 200, body: { title: 'A', content: '# A 全文' } });
  responses.push({ status: 404, body: { error: { message: 'no content' } } });   // 第二条抓取失败
  var r3 = await sandbox.runWebSearch('q', {});
  ok('抓取模式发 1+2 次请求', calls.length === 3, 'calls=' + calls.length);
  ok('失败的那条不阻断整轮', r3.results.length === 3 && r3.fetched === 1, 'fetched=' + r3.fetched);
  ok('成功的正文被写回', r3.results[0].content === '# A 全文' && r3.results[0].fetched === true);
  ok('只抓前 N 条（第 3 条没被抓）', r3.results[2].fetched !== true);

  // ④ 错误映射
  reset();
  sandbox.settings.webSearch.contentMode = 'summary';
  responses.push({ status: 401, body: { error: { message: 'Authentication Fails' } } });
  var err401 = null;
  try { await sandbox.runWebSearch('q', {}); } catch (e) { err401 = e; }
  ok('401 → 文案点明密钥问题并保留原始信息', !!err401 && /密钥无效/.test(err401.message) && /Authentication Fails/.test(err401.message), err401 && err401.message);
  ok('401 的状态码被带出来（供上层区分）', err401 && err401.wsStatus === 401);

  reset();
  responses.push({ status: 402, body: { error: { message: 'Insufficient Balance' } } });
  var err402 = null;
  try { await sandbox.runWebSearch('q', {}); } catch (e) { err402 = e; }
  ok('402 → 余额不足', !!err402 && /余额不足/.test(err402.message), err402 && err402.message);

  // ⑤ 检索失败不阻断：attachWebSearchToContext 必须把原 context 原样还回来
  reset();
  sandbox.settings.webSearch.contentMode = 'summary';
  sandbox.state.abortController = null;
  responses.push({ status: 500, body: { error: { message: 'boom' } } });
  var ctx = [{ role: 'system', content: 'SYS' }, { role: 'user', content: '问题' }];
  var res = await sandbox.attachWebSearchToContext({ webSearch: true }, ctx, { query: '问题' });
  ok('搜索失败时 context 原样返回（聊天照发）', res.context === ctx && ctx[1].content === '问题');
  ok('失败原因进 meta，供上层展示', res.meta && /内部错误/.test(res.meta.error), res.meta && res.meta.error);
  ok('失败时弹过一次提示', sandbox.__toasts.length >= 1);

  // ⑥ 开关关着 → 一个请求都不发
  reset();
  var res2 = await sandbox.attachWebSearchToContext({ webSearch: false }, ctx, { query: '问题' });
  ok('会话开关关着时不发请求', calls.length === 0 && res2.context === ctx);

  // ⑦ 成功路径：挂 sources、context 被注入
  reset();
  responses.push({ status: 200, body: { results: [{ title: 'A', url: 'https://a/1', summary: 'sa', site_name: 'SA', date: '2026-10-02T00:00:00+00:00' }] } });
  var ctx2 = [{ role: 'user', content: '问题' }];
  var res3 = await sandbox.attachWebSearchToContext({ webSearch: true }, ctx2, { query: '问题' });
  ok('成功时 context 被注入检索块', res3.context[0].content.indexOf('【联网搜索结果】') > 0);
  ok('sources 带标题/URL/站点/日期', res3.sources && res3.sources.length === 1 && res3.sources[0].site === 'SA' && res3.sources[0].date === '2026-10-02', JSON.stringify(res3.sources));

  // ---------- 来源卡片 ----------
  console.log('\n[来源卡片]');
  var html = sandbox.renderWebSearchSourcesHtml([
    { title: '<script>x</script>', url: 'https://a/1', site: 'SA', date: '2026-10-02', fetched: true },
    { title: '', url: 'https://b/2', site: '', date: '' }
  ]);
  ok('渲染出 details 容器与条数', /class="web-sources"/.test(html) && /联网来源 · 2 条/.test(html));
  ok('标题被转义（不执行注入的标签）', html.indexOf('<script>') < 0 && html.indexOf('&lt;script&gt;') > 0);
  ok('无标题时回落到 URL', html.indexOf('>https://b/2<') > 0);
  ok('抓过正文的条目标注出来', html.indexOf('已抓正文') > 0);
  ok('空数组不渲染任何东西', sandbox.renderWebSearchSourcesHtml([]) === '');

  sandbox.settings.webSearch.showSources = false;
  ok('关掉「显示来源」后不渲染', sandbox.renderWebSearchSourcesHtml([{ title: 't', url: 'u' }]) === '');
  sandbox.settings.webSearch.showSources = true;

  // ---------- 汇总 ----------
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(function(e) {
  console.error('\n[异常] 测试自身崩了：', e && e.stack || e);
  process.exit(2);
});
