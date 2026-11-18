// ===== tests/ds-suite.test.js =====
// DeepSeek 官方「全家桶」适配层的回归测试（node 直接跑，不联网、不发请求）
//   node tests/ds-suite.test.js
//
// 为什么这些断言值得写：这一层做的事全都"看不见"——
//   · 请求里多出来的 tools / title / safety_check / latest_reminder 字段；
//   · 流式响应里 server_tool_event 被翻成气泡里的轨迹与来源卡片；
//   · annotations 的 Unicode 码点下标被换算成 UTF-16 下标，再插成正文里的引用角标；
//   · 附件的 file_id 落成 {type:'file'} 内容块。
// 任何一处算错，界面上都不会报错：要么静默少一个来源，要么角标插错位置，要么整轮 400。
// 所以这里逐条钉死形状。

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

var sandbox = {
  console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
  String: String, Number: Number, Boolean: Boolean, Promise: Promise,
  parseInt: parseInt, parseFloat: parseFloat, isFinite: isFinite, isNaN: isNaN,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  atob: function (s) { return Buffer.from(String(s), 'base64').toString('binary'); },
  btoa: function (s) { return Buffer.from(String(s), 'binary').toString('base64'); },
  escapeHtml: function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  showToast: function () {},
  save: function () { sandbox.__saved++; },
  __saved: 0,
  saveSettings: function () {},
  renderSidebar: function () {},
  isCapacitor: function () { return false; },
  document: { getElementById: function () { return null; } },
  currentConv: function () { return null; },
  settings: {},
  state: { conversations: [] }
};
vm.createContext(sandbox);
var www = path.join(__dirname, '..', 'www');
vm.runInContext(fs.readFileSync(path.join(www, 'ds-suite.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(www, 'auto-title.js'), 'utf8'), sandbox);
var dbSrc = fs.readFileSync(path.join(www, 'db.js'), 'utf8');
vm.runInContext(extractFn(dbSrc, 'defaultDsSuiteSettings'), sandbox);
vm.runInContext(extractFn(dbSrc, 'migrateDsSuiteSettings'), sandbox);
// auto-title 的 atShouldTitle 依赖 state.conversations 判定"会话还在不在"
sandbox.state.conversations = [];

var OFFICIAL = { id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', template: 'deepseek' };
var RELAY = { id: 'p2', name: '中转', baseUrl: 'https://relay.example.com/deepseek', apiKey: 'sk-y', template: 'deepseek' };

// ---------- 官方识别 ----------
console.log('\n[dsIsOfficial / dsModelSupportsSuite]');
(function () {
  ok('api.deepseek.com 认作官方', sandbox.dsIsOfficial(OFFICIAL) === true);
  ok('带 /v1 后缀也认', sandbox.dsIsOfficial({ baseUrl: 'https://api.deepseek.com/v1' }) === true);
  ok('子域也认', sandbox.dsIsOfficial({ baseUrl: 'https://platform.deepseek.com' }) === true);
  // 中转站的 baseUrl 里常带 deepseek 字样，但它不实现这些扩展字段 —— 这是最容易搞错的一条
  ok('地址路径里带 deepseek 的中转站不算官方', sandbox.dsIsOfficial(RELAY) === false, RELAY.baseUrl);
  ok('空 provider 不炸', sandbox.dsIsOfficial(null) === false && sandbox.dsIsOfficial({}) === false);
  ok('模板是 deepseek 但地址不是官方 → 不算', sandbox.dsIsOfficial({ template: 'deepseek', baseUrl: 'https://api.openai.com' }) === false);

  ok('deepseek-flash 支持', sandbox.dsModelSupportsSuite('deepseek-flash') === true);
  ok('空模型名按支持处理', sandbox.dsModelSupportsSuite('') === true);
  // v3.0.18：官方渠道**按地址全量放行**，不再按模型名适配。
  //   依据是 2026-11-18 真 key 实测：deepseek-v4-pro 带 tools/title/元信息 完全正常。
  ok('v4-pro 也放行（不按模型名逐个适配）', sandbox.dsModelSupportsSuite('deepseek-v4-pro') === true);
  ok('以后的新模型名也放行', sandbox.dsModelSupportsSuite('deepseek-v5-ultra') === true);
  // 但「本机记住的拒绝」要能压住它
  sandbox.settings.dsSuite = sandbox.settings.dsSuite || {};
  sandbox.settings.dsSuite.nativeBlock = {};
  sandbox.dsNoteNativeReject({ id: 'pX' }, 'deepseek-v9-test', 400, 'tools not supported');
  ok('撞过 400 的模型 24h 内不再试', sandbox.dsModelSupportsSuite('deepseek-v9-test', { id: 'pX' }) === false);
  ok('别的模型不受影响', sandbox.dsModelSupportsSuite('deepseek-flash', { id: 'pX' }) === true);
  ok('另一个接口的同名模型不受影响', sandbox.dsModelSupportsSuite('deepseek-v9-test', { id: 'pY' }) === true);
  delete sandbox.settings.dsSuite.nativeBlock;
})();

// ---------- URL 拼装 ----------
console.log('\n[dsJoinUrl]');
(function () {
  ok('基础拼接', sandbox.dsJoinUrl('https://api.deepseek.com', '/files') === 'https://api.deepseek.com/files');
  ok('去掉重复斜杠', sandbox.dsJoinUrl('https://api.deepseek.com/', '/files') === 'https://api.deepseek.com/files');
  // 历史迁移会把 /v1 留在地址里；再补一次 /v1 就成了 /v1/v1/...
  ok('地址已带 /v1 时不再补版本段', sandbox.dsJoinUrl('https://api.deepseek.com/v1', '/v1/tools/asr') === 'https://api.deepseek.com/v1/tools/asr',
    sandbox.dsJoinUrl('https://api.deepseek.com/v1', '/v1/tools/asr'));
  ok('地址带 /v1 + 无版本路径', sandbox.dsJoinUrl('https://api.deepseek.com/v1', '/files') === 'https://api.deepseek.com/v1/files');
})();

// ---------- 设置迁移 ----------
console.log('\n[migrateDsSuiteSettings]');
(function () {
  var def = vm.runInContext('defaultDsSuiteSettings()', sandbox);
  ok('默认启用', def.enabled === true);
  ok('默认服务端联网工具开', def.webTools === true);
  ok('默认会话标题开', def.title === true);
  ok('safetyCheck 字段已删除（v3.0.18 按用户要求整体移除）', def.safetyCheck === undefined);
  ok('默认用户元信息开', def.userMeta === true);
  ok('默认文件输入开', def.files === true);
  ok('默认仅文字解析', def.fileMode === 'text');

  var m = vm.runInContext('migrateDsSuiteSettings({safetyCheck: true, fileMode: "rich", userMeta: false})', sandbox);
  ok('用户改过的字段保留', m.fileMode === 'rich' && m.userMeta === false, JSON.stringify(m));
  ok('老库里的 safetyCheck 被清掉', m.safetyCheck === undefined);
  ok('nativeBlock 默认是空对象', m.nativeBlock && typeof m.nativeBlock === 'object');
  ok('缺的字段补默认', m.enabled === true && m.files === true);
  var bad = vm.runInContext('migrateDsSuiteSettings({fileMode: "???", enabled: "yes"})', sandbox);
  ok('非法 fileMode 归位 text', bad.fileMode === 'text');
  ok('非布尔值不当作 true', bad.enabled === true || bad.enabled === false);
  var none = vm.runInContext('migrateDsSuiteSettings(null)', sandbox);
  ok('null 返回默认', none.enabled === true && none.fileMode === 'text');
})();

// ---------- 请求注入 ----------
console.log('\n[dsEnrichPayload]');
(function () {
  sandbox.settings.dsSuite = vm.runInContext('defaultDsSuiteSettings()', sandbox);

  var p = {};
  sandbox.dsEnrichPayload(p, { webSearch: true, title: true, provider: OFFICIAL, model: 'deepseek-flash' });
  ok('注入服务端工具', Array.isArray(p.tools) && p.tools.length === 2, JSON.stringify(p.tools));
  ok('工具只写 type（Chat Completions 形状）', p.tools[0].type === 'deepseek_web_search' && p.tools[1].type === 'deepseek_read_url' &&
    p.tools[0].name === undefined && p.tools[0].function === undefined);
  ok('不强制 tool_choice（官方不接受强制指定）', p.tool_choice === undefined);
  ok('注入会话标题', p.title && p.title.enabled === true);
  ok('内容安全默认不注入', p.safety_check === undefined);

  var p2 = {};
  sandbox.dsEnrichPayload(p2, { webSearch: false, title: false, provider: OFFICIAL, model: 'deepseek-flash' });
  ok('联网关着就不带 tools', p2.tools === undefined);
  ok('不同意标题就不带 title', p2.title === undefined);

  var p3 = {};
  sandbox.dsEnrichPayload(p3, { webSearch: true, title: true, provider: RELAY, model: 'deepseek-flash' });
  ok('非官方接口一个字段都不注', p3.tools === undefined && p3.title === undefined && p3.safety_check === undefined);

  // v3.0.18：官方渠道按地址全量放行 —— pro 也注（实测它真的支持）
  var p4 = {};
  sandbox.dsEnrichPayload(p4, { webSearch: true, title: true, provider: OFFICIAL, model: 'deepseek-v4-pro' });
  ok('官方 pro 同样注入（不再按模型名排除）', Array.isArray(p4.tools) && p4.title && p4.title.enabled === true);

  var p5 = {};
  sandbox.dsEnrichPayload(p5, { webSearch: true, title: true, provider: OFFICIAL, model: 'deepseek-flash' });
  ok('请求里永远没有 safety_check', p5.safety_check === undefined);

  sandbox.settings.dsSuite.enabled = false;
  var p6 = {};
  sandbox.dsEnrichPayload(p6, { webSearch: true, title: true, provider: OFFICIAL, model: 'deepseek-flash' });
  ok('总开关关掉后什么都不注', p6.tools === undefined && p6.title === undefined);
  sandbox.settings.dsSuite.enabled = true;
})();

// ---------- latest_reminder ----------
console.log('\n[dsInjectReminder]');
(function () {
  var msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '第二问' }
  ];
  var out = sandbox.dsInjectReminder(msgs);
  ok('插在最后一条 user 之前', out.length === 5 && out[3].role === 'latest_reminder' && out[4].content === '第二问',
    JSON.stringify(out.map(function (m) { return m.role; })));
  var rm = out[3].content;
  // 官方要求 **5 段**：date,weekday,location,platform,language。location 可以空，但逗号不能省
  //   （写成 4 段会被真接口 400：latest_reminder must have at least 5 comma-separated fields）
  ok('格式必须是 5 段（location 留空也要两个连续逗号）',
    /^\d{4}-\d{2}-\d{2},星期[日一二三四五六],,(App|Web),中文$/.test(rm), rm);
  ok('刚好 5 段', rm.split(',').length === 5, String(rm.split(',').length));
  ok('不改原数组', msgs.length === 4);

  var twice = sandbox.dsInjectReminder(out);
  ok('已经有一条就不再插', twice.filter(function (m) { return m.role === 'latest_reminder'; }).length === 1);

  sandbox.settings.dsSuite.userMeta = false;
  var off = sandbox.dsInjectReminder(msgs);
  ok('关掉后不插', off.length === 4);
  sandbox.settings.dsSuite.userMeta = true;

  var noUser = sandbox.dsInjectReminder([{ role: 'system', content: 's' }]);
  ok('没有 user 消息就不插', noUser.length === 1);
})();

// ---------- 标题 ----------
console.log('\n[dsWantTitle / dsApplyTitle]');
(function () {
  var conv = { id: 'c1', title: '对话 1', titleAutoEligible: true, activePath: ['m1'],
    messageMap: { m1: { id: 'm1', role: 'user', content: '帮我看看这个模型' } } };
  sandbox.state.conversations = [conv];
  ok('新建会话首轮 → 要标题', sandbox.dsWantTitle(conv) === true);

  sandbox.settings.autoTitle = { enabled: false };
  ok('自动命名总开关关掉 → 不要', sandbox.dsWantTitle(conv) === false);
  sandbox.settings.autoTitle = { enabled: true };

  conv.titleSetByUser = true;
  ok('用户手改过 → 不要', sandbox.dsWantTitle(conv) === false);
  delete conv.titleSetByUser;

  conv.titleAuto = { done: true };
  ok('已经命名过 → 不要', sandbox.dsWantTitle(conv) === false);
  delete conv.titleAuto;

  ok('非新建会话 → 不要', sandbox.dsWantTitle({ id: 'c2', titleAutoEligible: false, activePath: [], messageMap: {} }) === false);

  var got = sandbox.dsApplyTitle(conv, '标题：DeepSeek 全家桶接入');
  ok('服务端标题剥掉「标题：」前缀后写回', got === true && conv.title === 'DeepSeek 全家桶接入', conv.title);
  ok('置 done，下游不再发额外请求', conv.titleAuto && conv.titleAuto.done === true && conv.titleAuto.stage === 'server');

  var conv2 = { id: 'c3', title: '我自己起的', titleSetByUser: true, titleAutoEligible: true, activePath: [], messageMap: {} };
  sandbox.state.conversations = [conv, conv2];
  ok('手改过的会话绝不被覆盖', sandbox.dsApplyTitle(conv2, '新名字') === false && conv2.title === '我自己起的');
})();

// ---------- 流式事件 → 轨迹 + 来源 ----------
console.log('\n[dsConsumeChoice / trace & sources]');
(function () {
  var st = sandbox.dsNewTurn();
  // 一次搜索（流式：call_started → call_completed）
  var started = { type: 'call_started', step: 0, call: {
    index: 0, id: 'c_a', type: 'deepseek_web_search', kind: 'search',
    action: { type: 'search', queries: ['DeepSeek 全家桶', 'deepseek_web_search'] }, status: 'running' } };
  var ch1 = sandbox.dsConsumeChoice({ server_tool_event: started }, st);
  ok('call_started 产生一条 running 轨迹', ch1 === true && st.trace.length === 1 && st.trace[0].status === 'running');
  ok('轨迹带中文标签与搜索词组', st.trace[0].label === '搜索' && st.trace[0].argText === '「DeepSeek 全家桶」「deepseek_web_search」',
    JSON.stringify(st.trace[0]));

  var completed = { type: 'call_completed', step: 0, call: {
    index: 0, id: 'c_a', type: 'deepseek_web_search', kind: 'search',
    action: { type: 'search', queries: ['DeepSeek 全家桶'] }, status: 'completed',
    sources: [
      { type: 'url', url: 'https://a.example/1', title: '第一篇', snippet: 's', site_name: '站点A', published_at: '2026-11-13T00:00:00+00:00' },
      { type: 'url', url: 'https://b.example/2', title: '第二篇', site_name: '站点B' }
    ] } };
  sandbox.dsConsumeChoice({ server_tool_event: completed }, st);
  ok('call_completed 就地更新（不新增一条）', st.trace.length === 1 && st.trace[0].status === 'ok');
  ok('条数进 summary', st.trace[0].summary === '2 条', st.trace[0].summary);
  ok('来源被收集', st.sources.length === 2 && st.sources[0].url === 'https://a.example/1');
  ok('来源带站点与日期', st.sources[0].site === '站点A' && st.sources[0].date === '2026-11-13', JSON.stringify(st.sources[0]));

  // 深度搜索：打开网页 / 页内查找
  sandbox.dsConsumeChoice({ server_tool_event: { type: 'call_started', step: 1, call: {
    index: 0, id: 'c_b', type: 'deepseek_web_search', kind: 'deep_search',
    action: { type: 'open_page', url: 'https://c.example/page' }, status: 'running' } } }, st);
  sandbox.dsConsumeChoice({ server_tool_event: { type: 'call_completed', step: 1, call: {
    index: 0, id: 'c_b', type: 'deepseek_web_search', kind: 'deep_search',
    action: { type: 'open_page', url: 'https://c.example/page' }, status: 'completed',
    page: { url: 'https://c.example/page', title: '被打开的页', published_at: '2026-01-02' } } } }, st);
  var opened = st.trace.filter(function (t) { return t.label === '打开网页'; })[0];
  ok('打开网页是独立的一步', !!opened, JSON.stringify(st.trace.map(function (t) { return t.label; })));
  ok('打开网页算"已读"，来源标记 fetched', opened && opened.summary === '已读');
  ok('page 也进来源，且标为已抓正文',
    st.sources.some(function (s) { return s.url === 'https://c.example/page' && s.fetched === true; }));

  // 失败的调用
  sandbox.dsConsumeChoice({ server_tool_event: { type: 'call_started', step: 2, call: {
    index: 0, id: 'c_c', type: 'deepseek_read_url', kind: 'read_link',
    action: { type: 'read_link', url: 'https://d.example' }, status: 'running' } } }, st);
  sandbox.dsConsumeChoice({ server_tool_event: { type: 'call_completed', step: 2, call: {
    index: 0, id: 'c_c', type: 'deepseek_read_url', kind: 'read_link',
    action: { type: 'read_link', url: 'https://d.example' }, status: 'failed',
    error: { code: 'url_not_accessible' } } } }, st);
  var failed = st.trace.filter(function (t) { return t.label === '阅读链接'; })[0];
  ok('失败状态与错误码写进轨迹', failed && failed.status === 'error' && /url_not_accessible/.test(failed.summary), JSON.stringify(failed));

  // 去重
  sandbox.dsPushSources(st, [{ url: 'https://a.example/1', title: '重复' }]);
  ok('同一 URL 的重复来源被丢掉', st.sources.filter(function (s) { return s.url === 'https://a.example/1'; }).length === 1);

  // 最后一块里的完整数据
  var st2 = sandbox.dsNewTurn();
  sandbox.dsConsumeChoice({ delta: {
    title: '北京明天天气',
    annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.example/1', title: '第一篇', start_index: 0, end_index: 4 } }],
    server_tool_calls: [{ index: 0, reasoning_content: '', calls: [{
      index: 0, id: 'x1', type: 'deepseek_web_search', kind: 'search',
      action: { type: 'search', queries: ['北京天气'] }, status: 'completed',
      sources: [{ url: 'https://a.example/1', title: '第一篇' }] }] }]
  } }, st2);
  ok('delta.title 被接住', st2.title === '北京明天天气');
  ok('delta.annotations 被接住', st2.annotations.length === 1);
  ok('完整 server_tool_calls 被吸收成轨迹与来源', st2.trace.length === 1 && st2.sources.length === 1);
  ok('未知事件类型不炸', sandbox.dsConsumeChoice({ server_tool_event: { type: 'step_reasoning_done', step: 0 } }, st2) === false);
  ok('空 choice 不炸', sandbox.dsConsumeChoice(null, st2) === false);
})();

// ---------- 引用下标换算 ----------
console.log('\n[dsCitations]');
(function () {
  var text = '甲😀乙丙';
  ok('码点→UTF-16：BMP 字符 1:1', sandbox.dsCpToIdx(text, 0) === 0 && sandbox.dsCpToIdx(text, 1) === 1);
  // 「甲」1 码元，「😀」2 码元 → 码点 2 的位置在 UTF-16 是 3
  ok('码点→UTF-16：emoji 占 2 码元', sandbox.dsCpToIdx(text, 2) === 3, String(sandbox.dsCpToIdx(text, 2)));
  ok('越界回落到末尾', sandbox.dsCpToIdx(text, 99) === text.length);

  var cites = sandbox.dsCitations([
    { type: 'url_citation', url_citation: { url: 'https://a/1', title: 'A', start_index: 0, end_index: 2 } },
    { type: 'url_citation', url_citation: { url: 'https://b/2', title: 'B', start_index: 2, end_index: 4 } },
    { type: 'url_citation', url_citation: { url: 'https://a/1', title: 'A', start_index: 4, end_index: 5 } }
  ], text);
  ok('三条引用都解析出来', cites.length === 3);
  ok('同一 URL 共用一个编号（角标与来源卡片要对得上）',
    cites[0].ref === 1 && cites[1].ref === 2 && cites[2].ref === 1, JSON.stringify(cites.map(function (c) { return c.ref; })));
  ok('下标换算成 UTF-16', cites[1].start === 3 && cites[1].end === 5, JSON.stringify(cites[1]));
  ok('start > end 时自动交换', sandbox.dsCitations([{ url: 'u', start_index: 5, end_index: 2 }], 'abcdefgh')[0].start === 2);
  ok('没有 url 的注解被丢掉', sandbox.dsCitations([{ type: 'url_citation', url_citation: { title: 'x' } }], 'abc').length === 0);
})();

// ---------- 正文角标 ----------
console.log('\n[dsInjectCiteMarkers]');
(function () {
  var content = '上海今天多云。明天有雨。';
  var cites = [
    { url: 'https://a/1', title: '天气A', end: 7, ref: 1 },
    { url: 'https://b/2', title: '天气B', end: content.length, ref: 2 }
  ];
  var out = sandbox.dsInjectCiteMarkers(content, cites);
  ok('两处都插上了', (out.match(/class="cite-ref"/g) || []).length === 2, out);
  // 从后往前插 → 前一个角标的位置不受后一个影响；第 7 个字符之后应紧跟 1 号角标
  ok('先插后面的、再插前面的（前面的下标不被打歪）',
    out.indexOf('明天有雨。</p>') < 0 && out.indexOf('明天有雨。') > 0);
  ok('角标插在第一句句末之后', /上海今天多云。<\/span>|上海今天多云。<sup/.test(out.replace('</a></sup>', '</a></span>')) || out.indexOf('多云。<sup') > 0, out);
  ok('编号与来源一致', out.indexOf('>1</a>') > 0 && out.indexOf('>2</a>') > 0);
  ok('标题被转义进 title 属性', out.indexOf('title="天气A"') > 0);

  var withCode = '说明：\n```\nconst a = 1;\n```\n结束。';
  // 围栏内部：跳过（插进去会把代码弄坏，比少一个角标严重得多）
  var inFence = withCode.indexOf('const') + 5;
  var out2 = sandbox.dsInjectCiteMarkers(withCode, [{ url: 'u', end: inFence, ref: 1 }]);
  ok('代码块里的位置不插（插了会把代码弄坏）', out2 === withCode, out2);
  // 围栏之外（收尾的正文）：照常插
  var afterFence = withCode.indexOf('结束') + 2;
  var out3 = sandbox.dsInjectCiteMarkers(withCode, [{ url: 'u', end: afterFence, ref: 1 }]);
  ok('围栏之外的正文照常插', out3 !== withCode && out3.indexOf('结束<sup') > 0, out3);

  ok('空引用原样返回', sandbox.dsInjectCiteMarkers('abc', []) === 'abc');
  ok('null 安全', sandbox.dsInjectCiteMarkers('', null) === '');
})();

// ---------- 收尾落字段 ----------
console.log('\n[dsFinalize]');
(function () {
  var st = sandbox.dsNewTurn();
  sandbox.dsConsumeChoice({ server_tool_event: { type: 'call_started', step: 0, call: {
    index: 0, id: 'q1', type: 'deepseek_web_search', kind: 'search',
    action: { type: 'search', queries: ['x'] }, status: 'running' } } }, st);
  sandbox.dsConsumeChoice({ server_tool_event: { type: 'call_completed', step: 0, call: {
    index: 0, id: 'q1', type: 'deepseek_web_search', kind: 'search',
    action: { type: 'search', queries: ['x'] }, status: 'completed',
    sources: [{ url: 'https://a/1', title: 'A' }] } } }, st);
  st.annotations = [{ type: 'url_citation', url_citation: { url: 'https://a/1', title: 'A', start_index: 0, end_index: 3 } }];

  var msg = { content: '答案在这' };
  sandbox.dsFinalize(msg, st, msg.content);
  ok('轨迹落 msg.toolTrace', Array.isArray(msg.toolTrace) && msg.toolTrace.length === 1);
  ok('跑着的轨迹被收成 ok（不会永远转圈）', msg.toolTrace[0].status === 'ok');
  ok('来源落 msg.webSources', Array.isArray(msg.webSources) && msg.webSources.length === 1);
  ok('引用落 msg.citations', Array.isArray(msg.citations) && msg.citations.length === 1);

  // 回传字段：只有带 signature / page 的调用才值得留
  var st3 = sandbox.dsNewTurn();
  sandbox.dsAbsorbCalls([{ index: 0, calls: [
    { index: 0, id: 's1', type: 'deepseek_web_search', kind: 'search', action: { type: 'search', queries: ['x'] }, status: 'completed',
      sources: [{ url: 'https://a/1', title: 'A' }] },
    { index: 1, id: 'r1', type: 'deepseek_read_url', kind: 'read_link', action: { type: 'read_link', url: 'https://b/2' },
      status: 'completed', page: { url: 'https://b/2', title: 'B' }, signature: 'SIG-abc' }
  ] }], st3);
  var msg3 = { content: 'x' };
  sandbox.dsFinalize(msg3, st3, 'x');
  ok('回传里只留读过的网页（搜索结果不进后续上下文，留着是白占体积）',
    msg3.serverToolCalls && msg3.serverToolCalls.length === 1 && msg3.serverToolCalls[0].calls.length === 1 &&
    msg3.serverToolCalls[0].calls[0].signature === 'SIG-abc', JSON.stringify(msg3.serverToolCalls));

  // 超大 signature 整体丢弃（别把 data.json 撑爆）
  var st4 = sandbox.dsNewTurn();
  var big = new Array(20000).join('x');
  sandbox.dsAbsorbCalls([{ index: 0, calls: [
    { index: 0, id: 'r2', type: 'deepseek_read_url', kind: 'read_link', action: { type: 'read_link', url: 'https://b/3' },
      status: 'completed', page: { url: 'https://b/3' }, signature: big }
  ] }], st4);
  var msg4 = { content: 'x' };
  sandbox.dsFinalize(msg4, st4, 'x');
  ok('signature 总量超预算 → 整体不回传（请求仍能正常跑）', msg4.serverToolCalls === undefined);

  var echo = sandbox.dsAssistantEcho(msg3);
  ok('历史回传形状正确（role + content + server_tool_calls）',
    echo && echo.role === 'assistant' && typeof echo.content === 'string' && Array.isArray(echo.server_tool_calls));
  ok('没有服务端工具的普通消息不生成回传体', sandbox.dsAssistantEcho({ content: 'x' }) === null);
})();

// ---------- 附件 ----------
console.log('\n[dsPurposeFor / dsB64]');
(function () {
  sandbox.settings.dsSuite.fileMode = 'text';
  ok('图片 → user_data', sandbox.dsPurposeFor({ isImage: true, name: 'a.jpg' }) === 'user_data');
  ok('PDF → 仅文字解析', sandbox.dsPurposeFor({ name: 'a.pdf' }) === 'text_recognition');
  ok('Word → 仅文字解析', sandbox.dsPurposeFor({ name: 'a.docx' }) === 'text_recognition');
  ok('PPT → 仅文字解析', sandbox.dsPurposeFor({ name: 'a.pptx' }) === 'text_recognition');
  ok('纯文本 → user_data（不计解析费）', sandbox.dsPurposeFor({ name: 'a.txt' }) === 'user_data');
  ok('xlsx → user_data（上游转 Markdown）', sandbox.dsPurposeFor({ name: 'a.xlsx' }) === 'user_data');
  // 解析方式是**参数**（调用方传 dsCfg().fileMode），不是函数里自己读 settings
  ok('图文混排模式 → rich_layout_recognition', sandbox.dsPurposeFor({ name: 'a.pdf' }, 'rich') === 'rich_layout_recognition');

  var bytes = new Uint8Array([104, 105]);
  var b64 = sandbox.dsBytesToB64(bytes);
  ok('base64 往返一致', sandbox.dsB64ToBytes(b64)[0] === 104 && sandbox.dsB64ToBytes(b64)[1] === 105);
  var big = new Uint8Array(70000);
  for (var i = 0; i < big.length; i++) big[i] = i % 256;
  var bigB64 = sandbox.dsBytesToB64(big);
  var back = sandbox.dsB64ToBytes(bigB64);
  ok('大文件分块编码不丢字节', back.length === bitLength(big) && back[69999] === big[69999], String(back.length));

  ok('文件名里的引号/斜杠被清掉', sandbox.dsFileNameOf({ name: 'a"b/c\r\n.pdf' }).indexOf('"') < 0);
  ok('mime 按扩展名兜底', sandbox.dsMimeOf({ name: 'a.pdf' }) === 'application/pdf');
  ok('file 内容块形状', sandbox.dsFileBlock('file-api-1').type === 'file' && sandbox.dsFileBlock('file-api-1').file_id === 'file-api-1');
})();

function bitLength(u8) { return u8.length; }

// ---------- 与 chat.js / app.js 的接缝 ----------
// 这一段测的是"两个模块拼在一起时形状对不对"。它们在浏览器里跑，但函数本身是纯的
//   （不碰 DOM、不发请求），所以能直接抠出来在 node 里跑。
console.log('\n[接缝：buildFileContent / agentTraceHtml]');
(function () {
  var appSrc = fs.readFileSync(path.join(www, 'app.js'), 'utf8');
  var chatSrc = fs.readFileSync(path.join(www, 'chat.js'), 'utf8');
  vm.runInContext(extractFn(appSrc, 'buildFileContent'), sandbox);
  vm.runInContext(extractFn(chatSrc, 'agentTraceHtml'), sandbox);

  // 1) 附件：有 file_id 就用 file_id（图片与文档同一条规则）
  var msg = {
    role: 'user', content: '看看这个',
    files: [
      { name: 'a.pdf', isImage: false, binary: true, content: '', dsFileId: 'file-api-1' },
      { name: 'b.jpg', isImage: true, base64: 'QUJD', mimeType: 'image/jpeg', dsFileId: 'file-api-2' }
    ]
  };
  var parts = sandbox.buildFileContent(msg, { dsFiles: true });
  ok('有 file_id 时返回内容块数组', Array.isArray(parts), typeof parts);
  ok('文字在前、文件块在后', parts[0].type === 'text' && parts[0].text === '看看这个');
  ok('PDF 走 file 块', parts[1].type === 'file' && parts[1].file_id === 'file-api-1', JSON.stringify(parts[1]));
  ok('图片也走 file 块（不再每轮重发 base64）', parts[2].type === 'file' && parts[2].file_id === 'file-api-2', JSON.stringify(parts[2]));
  ok('不再出现 image_url', parts.every(function (p) { return p.type !== 'image_url'; }));

  // 2) 关掉全家桶：回到内联形态（老行为必须原样可用）
  var inline = sandbox.buildFileContent(msg, { dsFiles: false });
  ok('非全家桶时图片回到 image_url base64',
    inline.some(function (p) { return p.type === 'image_url' && /^data:image\/jpeg;base64,QUJD$/.test(p.image_url.url); }),
    JSON.stringify(inline));
  ok('非全家桶时二进制文档不塞空 content',
    inline.some(function (p) { return p.type === 'text' && /未能上传解析/.test(p.text); }));

  // 3) 纯文本附件：保持原来的字符串形态（不因为这次改动变成内容块）
  var textOnly = { role: 'user', content: '问一句', files: [{ name: 'a.txt', isImage: false, content: '文件内容' }] };
  var plain = sandbox.buildFileContent(textOnly, { dsFiles: true });
  ok('纯文本附件仍是字符串拼接', typeof plain === 'string' && plain.indexOf('文件内容') > 0, typeof plain);

  // 3b) 换了密钥之后，旧的 file_id 必须自动失效（否则整个请求 400）
  var tagA = sandbox.dsKeyTag('sk-aaaa');
  var tagB = sandbox.dsKeyTag('sk-bbbb');
  ok('密钥指纹稳定', tagA === sandbox.dsKeyTag('sk-aaaa') && tagA.length > 0);
  ok('不同密钥指纹不同', tagA !== tagB);
  ok('空密钥没有指纹', sandbox.dsKeyTag('') === '');
  ok('同密钥的 file_id 可用', sandbox.dsFileIdUsable({ dsFileId: 'f1', dsKeyTag: tagA }, tagA) === true);
  ok('换了密钥就不可用', sandbox.dsFileIdUsable({ dsFileId: 'f1', dsKeyTag: tagA }, tagB) === false);
  ok('没记录指纹的老数据按可用处理', sandbox.dsFileIdUsable({ dsFileId: 'f1' }, tagB) === true);
  ok('没有 file_id 一律不可用', sandbox.dsFileIdUsable({ dsFileId: '' }, tagA) === false);

  var stale = { role: 'user', content: '看这张图',
    files: [{ name: 'b.jpg', isImage: true, base64: 'QUJD', mimeType: 'image/jpeg', dsFileId: 'file-api-old', dsKeyTag: 'zzzzzz' }] };
  var staleParts = sandbox.buildFileContent(stale, { dsFiles: true, dsKeyTag: tagA });
  ok('密钥换了 → 图片回落内联 base64（不会把整轮打死）',
    staleParts.some(function (p) { return p.type === 'image_url'; }), JSON.stringify(staleParts));
  var staleDoc = { role: 'user', content: '看这份文档',
    files: [{ name: 'a.pdf', isImage: false, binary: true, content: '', dsFileId: 'file-api-old', dsKeyTag: 'zzzzzz' }] };
  var staleDocParts = sandbox.buildFileContent(staleDoc, { dsFiles: true, dsKeyTag: tagA });
  ok('失效的文档 file_id 退化成一句说明（而不是空正文/硬 400）',
    Array.isArray(staleDocParts) && staleDocParts.some(function (p) { return /未能上传解析/.test(p.text || ''); }),
    JSON.stringify(staleDocParts));

  // 4) 轨迹行：服务端工具的中文名与参数
  var traceHtml = sandbox.agentTraceHtml([
    { name: 'web_search', label: '深度搜索', argText: '「甲」「乙」', status: 'ok', summary: '3 条' },
    { name: 'web_search', label: '打开网页', argText: 'https://x/y', status: 'ok', summary: '已读' },
    { name: 'web_search', status: 'note', summary: '说明文字' }
  ]);
  ok('轨迹显示中文步骤名', traceHtml.indexOf('深度搜索') > 0 && traceHtml.indexOf('打开网页') > 0);
  ok('轨迹显示参数与结果', traceHtml.indexOf('「甲」「乙」') > 0 && traceHtml.indexOf('已读') > 0);
  ok('说明行单独渲染', traceHtml.indexOf('agent-trace-note') > 0);
  ok('统计里只算真正调用过的（说明行不算）', /已调用 2 个工具/.test(traceHtml), traceHtml.slice(0, 80));

  // 5) 静态接缝：这三处一旦被删掉，联网会静默退回客户端循环 / 标题会白花一次请求
  ok('sendFromMessage 用 dsServerToolsEligible 决定走服务端', /dsServerToolsEligible\(provider, conv\.model\)/.test(chatSrc));
  ok('sendFromMessage 注入扩展字段', /dsEnrichPayload\(reqBody/.test(chatSrc));
  ok('executeRequest 把 dsTurn 传下去', /reason: 'original', ds: dsTurn, conv: conv/.test(chatSrc));
  ok('executeStreamHttp 消费服务端事件', /dsConsumeChoice\(choice, dsTurn\)/.test(chatSrc));
  ok('收尾把轨迹/来源/引用落库', /dsFinalize\(assistantMsg, dsTurn, assistantMsg\.content\)/.test(chatSrc));
  ok('正文渲染插入引用角标', /dsInjectCiteMarkers\(text, msg\.citations\)/.test(chatSrc));
  ok('buildContext 把 dsFiles + 密钥指纹交给附件构建',
    /buildFileContent\(m, \{ dsFiles: dsFiles, dsKeyTag: dsFilesTag \}\)/.test(chatSrc));
})();


// ---------- 客户端引用角标（非官方渠道）----------
console.log('\n[dsLinkBracketCitations]');
(function () {
  var srcs = [
    { title: '来源一', url: 'https://a/1' },
    { title: '来源二', url: 'https://b/2' }
  ];
  var out = sandbox.dsLinkBracketCitations('冰岛人口 39.4 万 [1]，另一说 40.46 万 [2]。', srcs);
  ok('两个方括号都变成上标', (out.match(/class="cite-ref"/g) || []).length === 2, out);
  ok('编号指向对应来源', out.indexOf('https://a/1') > 0 && out.indexOf('https://b/2') > 0);
  ok('正文其余部分保持 markdown 原样（不被转义）',
    sandbox.dsLinkBracketCitations('**粗体** [1]', srcs).indexOf('**粗体**') >= 0);
  ok('超出来源数量的编号原样保留',
    sandbox.dsLinkBracketCitations('无关 [7]', srcs) === '无关 [7]');
  ok('没有来源时原样返回', sandbox.dsLinkBracketCitations('a [1]', []) === 'a [1]');
  ok('代码块里的不插',
    sandbox.dsLinkBracketCitations('```\nx[1]\n```', srcs).indexOf('cite-ref') < 0);
  ok('链接标题被转义', sandbox.dsLinkBracketCitations('x [1]', [{ url: 'u', title: 'a"b' }]).indexOf('&quot;') > 0);
})();

// ---------- OCR 标记清理 + 解析结果拼装 ----------
console.log('\n[dsStripOcrMarkup / dsOcrFile 契约]');
(function () {
  // 真实格式用的是**全角竖线**：<｜ref｜>标题<｜/ref｜><｜box｜>[[…]]<｜/box｜>
  var raw = '<｜ref｜>标题<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>正文第一段\n\n\n正文第二段';
  var clean = sandbox.dsStripOcrMarkup(raw);
  ok('去掉 ref/box 标记', clean.indexOf('ref') < 0 && clean.indexOf('box') < 0, clean);
  ok('去掉坐标数组', clean.indexOf('948') < 0, clean);
  ok('保留正文', clean.indexOf('正文第一段') > 0 && clean.indexOf('正文第二段') > 0);
  ok('折叠多余空行', clean.indexOf('\n\n\n') < 0);
  ok('空输入不炸', sandbox.dsStripOcrMarkup('') === '' && sandbox.dsStripOcrMarkup(null) === '');
  // 宽松匹配会误伤正文里的字面标记（文档里写代码时很常见），这里钉住"别删"
  ok('字面 <box> / <reference> 不被误删',
    sandbox.dsStripOcrMarkup('写 <box> 和 <reference>').indexOf('<box>') > 0);
  ok('字符上限变量存在且合理', sandbox.DS_OCR_MAX_CHARS >= 50000);
  ok('dsOcrFile 是函数', typeof sandbox.dsOcrFile === 'function');
})();

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
