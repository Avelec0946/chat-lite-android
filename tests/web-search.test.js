// ===== tests/web-search.test.js =====
// 联网搜索「工具层」的回归测试（node 直接跑，不联网）
//   node tests/web-search.test.js
//
// 为什么需要：v3.0.6 起联网搜索是**交给模型的工具**（function calling），不再是"每条消息自动检索"。
//   于是正确性集中在三件事上，且全都不联网也能测：
//     ① 工具有没有被正确描述（描述写错，模型就不会在该搜的时候搜、或在不该搜的时候乱搜）；
//     ② 参数解析与请求体是否正确（query / count / need_content）；
//     ③ 失败是否变成「给模型的文本」而不是「抛异常把对话搞崩」。
//   v3.0.5 的「把检索结果拼进上下文」那套断言已随实现一起删除 —— 那套行为本身被判定为错的。

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

var calls = [];
var responses = [];
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
  settings: {},
  state: { providers: [], abortController: null },
  fetch: function(url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: opts && opts.headers });
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

var dbSrc = fs.readFileSync(path.join(__dirname, '..', 'www', 'db.js'), 'utf8');
vm.runInContext(extractFn(dbSrc, 'clampNum'), sandbox);
vm.runInContext(extractFn(dbSrc, 'defaultWebSearchSettings'), sandbox);
vm.runInContext(extractFn(dbSrc, 'migrateWebSearchSettings'), sandbox);

// ---------- 设置迁移 ----------
console.log('\n[migrateWebSearchSettings]');
(function() {
  var def = vm.runInContext('defaultWebSearchSettings()', sandbox);
  ok('默认复用接口管理（mode=inherit）', def.mode === 'inherit', def.mode);
  ok('默认不自动开启', def.defaultOn === false);
  ok('默认摘要模式', def.contentMode === 'summary');
  ok('默认条数 6（工具上限 10）', def.count === 6);
  ok('已无 fetchTop 字段（抓取由模型决定）', def.fetchTop === undefined);
  ok('默认信任 DeepSeek 官方地址', /api\.deepseek\.com/.test(def.baseUrl));

  var m = vm.runInContext('migrateWebSearchSettings({count: 12})', sandbox);
  ok('count 越界收敛到 10（与工具定义一致）', m.count === 10, String(m.count));
  var m2 = vm.runInContext('migrateWebSearchSettings({contentMode: "fetch"})', sandbox);
  ok("老的 'fetch' 档迁移成 'content'", m2.contentMode === 'content', m2.contentMode);
  var m3 = vm.runInContext('migrateWebSearchSettings({contentMode: "weird"})', sandbox);
  ok('非法档位回落 summary', m3.contentMode === 'summary');
  var m4 = vm.runInContext('migrateWebSearchSettings({mode: "custom", apiKey: "sk-x"})', sandbox);
  ok('用户改过的字段保留', m4.mode === 'custom' && m4.apiKey === 'sk-x');
})();

// ---------- 工具定义 ----------
console.log('\n[工具定义]');
(function() {
  var defs = sandbox.WEB_TOOL_DEFS;
  ok('提供两个工具', Array.isArray(defs) && defs.length === 2, defs && defs.length);
  var names = defs.map(function(d) { return d.function.name; });
  ok('工具名是 web_search / fetch_url', names.indexOf('web_search') >= 0 && names.indexOf('fetch_url') >= 0, names.join(','));
  defs.forEach(function(d) {
    var f = d.function;
    ok('「' + f.name + '」描述说明了适用/不适用',
      typeof f.description === 'string' && f.description.length > 40 && /适用/.test(f.description), f.description);
    ok('「' + f.name + '」parameters 是合法 JSON Schema',
      !!(f.parameters && f.parameters.type === 'object' && Array.isArray(f.parameters.required) && f.parameters.required.length > 0));
  });
  var search = defs.filter(function(d) { return d.function.name === 'web_search'; })[0];
  ok('count 参数限了 1~10', search.function.parameters.properties.count.maximum === 10);
  ok('query 被标为必填', search.function.parameters.required.indexOf('query') >= 0);
})();

// ---------- 结果格式化 ----------
console.log('\n[结果格式化]');
(function() {
  var text = sandbox.wsFormatSearchResult('测试词', [
    { idx: 1, title: '标题A', url: 'https://a/1', siteName: '站点A', date: '2026-10-20', authority: 3, summary: '摘要A', content: '' },
    { idx: 2, title: '标题B', url: 'https://b/2', siteName: '', date: '', authority: -1, summary: '', snippet: '片段B', content: '' }
  ]);
  ok('带编号与标题', /\[1\] 标题A/.test(text) && /\[2\] 标题B/.test(text));
  ok('带 URL（模型只能引用这里给的链接）', text.indexOf('https://a/1') >= 0);
  ok('带站点/日期/权威标记', /站点A · 2026-10-20 · 权威来源/.test(text));
  ok('摘要缺失时回落 snippet', text.indexOf('片段B') >= 0);
  ok('提示可再抓正文', /fetch_url/.test(text));

  var empty = sandbox.wsFormatSearchResult('x', []);
  ok('空结果告诉它可以换词或直说没查到', /没有返回任何结果/.test(empty) && /没查到/.test(empty), empty.slice(0, 60));

  var longOne = sandbox.wsFormatSearchResult('x', [{ idx: 1, title: 't', url: 'u', content: new Array(9000).join('字') }]);
  ok('单条超长正文被截断并标注', longOne.indexOf('已截断') >= 0 && longOne.length < 9000, String(longOne.length));
})();

// ---------- 工具执行 ----------
console.log('\n[runWebTool: web_search]');
(async function() {
  function reset() { calls.length = 0; responses.length = 0; }
  sandbox.settings = { webSearch: { mode: 'inherit', providerId: '', count: 6, contentMode: 'summary', showSources: true } };
  sandbox.state.providers = [{ id: 'p2', name: 'DeepSeek', template: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds' }];

  reset();
  responses.push({ status: 200, body: { results: [
    { title: 'A', url: 'https://a/1', summary: 'sa', rerank_score: 2.1, authority: 3, site_name: 'SA', date: '2026-10-01T00:00:00+00:00' },
    { title: 'B', url: 'https://b/2', snippet: 'sb' }
  ] } });
  var collected = [];
  var r1 = await sandbox.runWebTool('web_search', { query: '测试词', count: 3 }, { collectSources: function(l) { collected = collected.concat(l); } });
  ok('打到 /v1/tools/search', calls[0].url === 'https://api.deepseek.com/v1/tools/search', calls[0].url);
  ok('query 用的是模型写的词（不是用户原话）', calls[0].body.query === '测试词');
  ok('count 用模型给的值', calls[0].body.count === 3, String(calls[0].body.count));
  ok('摘要模式不发 need_content', calls[0].body.need_content === undefined);
  ok('返回给模型的文本带编号', r1.text.indexOf('[1] A') >= 0);
  ok('meta 记录条数（UI 要显示）', r1.meta.ok === true && r1.meta.count === 2);
  ok('来源被收集（供下方来源卡片）', collected.length === 2 && collected[0].url === 'https://a/1');

  reset();
  sandbox.settings.webSearch.contentMode = 'content';
  responses.push({ status: 200, body: { results: [{ title: 'A', url: 'https://a/1', content: '正文全文' }] } });
  var r2 = await sandbox.runWebTool('web_search', { query: 'q' });
  ok('正文模式带 need_content=true', calls[0].body.need_content === true);
  ok('正文写进了给模型的文本', r2.text.indexOf('正文全文') >= 0);

  reset();
  sandbox.settings.webSearch.contentMode = 'summary';
  var r3 = await sandbox.runWebTool('web_search', {});
  ok('缺 query 时不发请求、直接说明', calls.length === 0 && r3.meta.ok === false && /不能为空/.test(r3.text), r3.text);

  reset();
  responses.push({ status: 429, body: { error: { message: 'rate limited' } } });
  var r4 = await sandbox.runWebTool('web_search', { query: 'q' });
  ok('限速不抛异常，改成文本回填', r4.meta.ok === false && /触发限速/.test(r4.text), r4.text);
  ok('失败原因保留上游原文', /rate limited/.test(r4.text));

  console.log('\n[runWebTool: fetch_url]');
  reset();
  responses.push({ status: 200, body: { title: '页面标题', content: '# 正文\n内容' } });
  var collected2 = [];
  var f1 = await sandbox.runWebTool('fetch_url', { url: 'https://a/1' }, { collectSources: function(l) { collected2 = collected2.concat(l); } });
  ok('打到 /v1/tools/fetch', calls[0].url === 'https://api.deepseek.com/v1/tools/fetch', calls[0].url);
  ok('url 原样传入', calls[0].body.url === 'https://a/1');
  ok('返回标题与正文', f1.meta.ok === true && f1.text.indexOf('页面标题') >= 0 && f1.text.indexOf('# 正文') >= 0);
  ok('抓取过的页面也进来源列表（标 fetched）', collected2.length === 1 && collected2[0].fetched === true);

  reset();
  var f2 = await sandbox.runWebTool('fetch_url', { url: 'not-a-url' });
  ok('非法 url 不发请求', calls.length === 0 && f2.meta.ok === false, f2.text);

  reset();
  responses.push({ status: 404, body: { error: { message: 'no content' } } });
  var f3 = await sandbox.runWebTool('fetch_url', { url: 'https://a/2' });
  ok('抓不到时如实说失败（不编内容）', f3.meta.ok === false && /失败/.test(f3.text), f3.text);

  reset();
  var u1 = await sandbox.runWebTool('drop_database', {});
  ok('未知工具被拒绝', u1.meta.ok === false && /未知工具/.test(u1.text));

  reset();
  sandbox.settings = { webSearch: { mode: 'custom', baseUrl: 'https://api.deepseek.com', apiKey: '' } };
  var n1 = await sandbox.runWebTool('web_search', { query: 'q' });
  ok('没配密钥时不发请求，如实回报', calls.length === 0 && /密钥为空/.test(n1.text), n1.text);

  sandbox.settings = { webSearch: { mode: 'inherit', providerId: '', count: 6, contentMode: 'summary', showSources: true } };

  // ---------- 来源卡片 ----------
  console.log('\n[来源卡片]');
  var html = sandbox.renderWebSearchSourcesHtml([
    { title: '<script>x</script>', url: 'https://a/1', site: 'SA', date: '2026-10-02', fetched: true },
    { title: '', url: 'https://b/2', site: '', date: '' }
  ]);
  ok('渲染 details 容器与条数', /class="web-sources"/.test(html) && /联网来源 · 2 条/.test(html));
  ok('默认收折（不带 open）', html.indexOf('web-sources" open') < 0, html.slice(0, 60));
  ok('标题被转义', html.indexOf('<script>') < 0 && html.indexOf('&lt;script&gt;') > 0);
  ok('无标题时回落 URL', html.indexOf('>https://b/2<') > 0);
  ok('抓过正文的条目标注出来', html.indexOf('已抓正文') > 0);
  ok('空数组不渲染', sandbox.renderWebSearchSourcesHtml([]) === '');

  sandbox.settings.webSearch.showSources = false;
  ok('关掉「显示来源」后不渲染', sandbox.renderWebSearchSourcesHtml([{ title: 't', url: 'u' }]) === '');

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(function(e) {
  console.error('\n[异常] 测试自身崩了：', e && e.stack || e);
  process.exit(2);
});
