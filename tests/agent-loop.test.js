// ===== tests/agent-loop.test.js =====
// 带工具对话循环的回归测试（node 直接跑，不联网）
//   node tests/agent-loop.test.js
//
// 为什么必须有：工具循环是"一句话说错就全错"的地方 ——
//   · tool_calls 是**按 index 分片**流下来的，归并错一个字节，参数就解析不出来；
//   · 参数是逐字符吐的（"{\"query\"" / ":" / "\"科技新闻\"" 各一块），不累积就是空参数；
//   · DeepSeek 一次会发**多个并行** tool_calls，按顺序而不是按 index 拼就会串味。
// 这些在网络正常时也看不出来（表现是"偶尔搜错东西"），只能靠断言钉住。

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

// ---- 构造一个假的流式响应：把字符串按任意切分喂给 reader ----
function makeResponse(chunks, opts) {
  opts = opts || {};
  var i = 0;
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    body: {
      getReader: function() {
        return {
          read: function() {
            if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            var v = chunks[i++];
            return Promise.resolve({ done: false, value: Buffer.from(v, 'utf8') });
          }
        };
      }
    },
    text: function() { return Promise.resolve(chunks.join('')); }
  };
}

var requests = [];       // 记录 buildRequest 被调用时的 tools 参数
var responses = [];      // 按调用顺序出队
var saves = 0;           // saveSettings 调用次数（能力登记要落盘，不能只改内存）
var sandbox = {
  console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
  String: String, Number: Number, Boolean: Boolean, Promise: Promise,
  parseInt: parseInt, parseFloat: parseFloat, isFinite: isFinite, isNaN: isNaN,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  AbortController: AbortController, TextDecoder: TextDecoder,
  Buffer: Buffer,
  isCapacitor: function() { return false; },
  resolveChatWaitMs: function() { return 5000; },
  // v3.0.12：能力登记要读写 settings / saveSettings；upstreamId 映射也要有，
  //   否则「key 该用 upstreamId 而不是显示名」这条断言测不到真东西。
  settings: { toolCapability: {} },
  saveSettings: function() { saves++; },
  modelToUpstreamId: function(provider, modelId) {
    var m = (provider && provider.models || []).filter(function(x) { return x.id === modelId; })[0];
    return (m && m.upstreamId) || modelId;
  },
  fetch: function(url, opts) {
    var r = responses.shift();
    if (!r) return Promise.reject(new Error('没有预置响应 #' + url));
    if (r.reject) return Promise.reject(r.reject);
    return Promise.resolve(r);
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'agent-loop.js'), 'utf8'), sandbox);

function sse(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function delta(d) { return sse({ choices: [{ index: 0, delta: d, finish_reason: null }] }); }
function finish(reason) { return sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }); }

// ---------- SSE 解析 ----------
console.log('\n[SSE 解析]');
(function() {
  var seen = [];
  var p = sandbox.agentCreateSseParser(function(j) { seen.push(j); });
  var line = delta({ content: '你好' });
  // 把一行切成三段喂进去（模拟 TCP 分包）
  p.push(line.slice(0, 10));
  p.push(line.slice(10, 25));
  ok('跨分块的行不会丢', seen.length === 0);
  p.push(line.slice(25));
  ok('拼完整后才触发一次回调', seen.length === 1 && seen[0].choices[0].delta.content === '你好');

  p.push('data: [DONE]\n\n');
  ok('[DONE] 被识别', p.isDone() === true);

  var seen2 = [];
  var p2 = sandbox.agentCreateSseParser(function(j) { seen2.push(j); });
  p2.push(': keep-alive\n\n');
  p2.push('event: message\n');
  p2.push(delta({ content: 'A' }));
  ok('心跳与 event 行被忽略', seen2.length === 1);
})();

// ---------- tool_calls 分片归并 ----------
console.log('\n[tool_calls 归并]');
(function() {
  var chunks = [
    // 首片：两个并行调用，各带 id 与 name
    sse({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'fetch_url', arguments: '' } }
    ] } }] }),
    // 参数逐字符吐，且两个调用**交错**
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query"' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"url"' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"科技新闻 今天"}' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':"https://a.example.com/1"}' } }] } }] }),
    finish('tool_calls'),
    'data: [DONE]\n\n'
  ];
  responses.push(makeResponse(chunks));
  return vm.runInContext('agentStreamOnce', sandbox)({
    req: { url: 'u', headers: {}, payload: {} }
  }).then(function(turn) {
    ok('拿到 2 个并行调用', turn.toolCalls.length === 2, JSON.stringify(turn.toolCalls));
    ok('按 index 归并，参数不串味',
      turn.toolCalls[0].name === 'web_search' && turn.toolCalls[0].args === '{"query":"科技新闻 今天"}',
      turn.toolCalls[0].args);
    ok('第二个调用独立完整',
      turn.toolCalls[1].name === 'fetch_url' && turn.toolCalls[1].args === '{"url":"https://a.example.com/1"}',
      turn.toolCalls[1].args);
    ok('id 被保留（回填 role:tool 时要用）', turn.toolCalls[0].id === 'call_a' && turn.toolCalls[1].id === 'call_b');
    ok('finish_reason 被记下', turn.finishReason === 'tool_calls', turn.finishReason);
  });
})()
// ---------- 多轮循环 ----------
.then(function() {
  console.log('\n[多轮循环]');
  requests = []; responses = [];
  // 轮 1：模型只要一个搜索；轮 2：输出正文
  responses.push(makeResponse([
    sse({ choices: [{ delta: { reasoning_content: '需要查一下' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q1"}' } }] } }] }),
    finish('tool_calls'), 'data: [DONE]\n\n'
  ]));
  responses.push(makeResponse([
    delta({ content: '根据搜索结果，' }),
    delta({ content: '答案是 X[1]。' }),
    finish('stop'), 'data: [DONE]\n\n'
  ]));

  var execCalls = [];
  var deltas = [];
  return vm.runInContext('agentRun', sandbox)({
    messages: [{ role: 'user', content: '问题' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    buildRequest: function(msgs, tools) {
      requests.push({ tools: tools, messages: JSON.parse(JSON.stringify(msgs)) });
      return { url: 'u', headers: {}, payload: { messages: msgs } };
    },
    execTool: function(name, args) {
      execCalls.push({ name: name, args: args });
      return Promise.resolve({ text: '[1] 示例结果', meta: { ok: true, count: 1 } });
    },
    onDelta: function(kind, text) { deltas.push(kind + ':' + text); },
    onToolStart: function() {}, onToolEnd: function() {}
  }).then(function(res) {
    ok('跑了两轮', requests.length === 2, 'requests=' + requests.length);
    ok('第一轮带 tools、第二轮仍带（未到上限）', !!requests[0].tools && !!requests[1].tools);
    ok('工具被真实执行了一次', execCalls.length === 1 && execCalls[0].args.query === 'q1', JSON.stringify(execCalls));
    ok('回填了 assistant(tool_calls)', requests[1].messages.some(function(m) {
      return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0].id === 'c1';
    }));
    ok('回填了 role:tool 且带 tool_call_id', requests[1].messages.some(function(m) {
      return m.role === 'tool' && m.tool_call_id === 'c1' && m.content === '[1] 示例结果';
    }));
    ok('跨轮累计正文', res.content === '根据搜索结果，答案是 X[1]。', res.content);
    ok('思考内容也被收集', /需要查一下/.test(res.reasoning), res.reasoning);
    ok('usedTools 记录（供 UI 展示）', res.usedTools.length === 1 && res.usedTools[0].ok === true);
  });
})
// ---------- 工具失败不中断 ----------
.then(function() {
  console.log('\n[工具失败]');
  requests = []; responses = [];
  responses.push(makeResponse([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] } }] }),
    finish('tool_calls'), 'data: [DONE]\n\n'
  ]));
  responses.push(makeResponse([delta({ content: '没查到' }), finish('stop'), 'data: [DONE]\n\n']));
  return vm.runInContext('agentRun', sandbox)({
    messages: [],
    tools: [{}],
    buildRequest: function(msgs, tools) {
      requests.push({ tools: tools, messages: JSON.parse(JSON.stringify(msgs)) });
      return { url: 'u', headers: {}, payload: {} };
    },
    execTool: function() { return Promise.reject(new Error('限速 429')); }
  }).then(function(res) {
    var toolMsg = (requests[1].messages || []).filter(function(m) { return m.role === 'tool'; })[0];
    ok('工具抛异常不会让整轮崩掉', !!toolMsg, JSON.stringify(requests[1].messages));
    ok('失败原因如实回填给模型', !!toolMsg && /429/.test(toolMsg.content), toolMsg && toolMsg.content);
    ok('模型仍能继续作答', res.content === '没查到', res.content);
  });
})
// ---------- 轮次上限 ----------
.then(function() {
  console.log('\n[轮次上限]');
  requests = []; responses = [];
  // 每一轮都想调工具：给足 4 轮响应
  for (var i = 0; i < 4; i++) {
    responses.push(makeResponse([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + i, type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }),
      finish('tool_calls'), 'data: [DONE]\n\n'
    ]));
  }
  return vm.runInContext('agentRun', sandbox)({
    messages: [],
    tools: [{}],
    maxRounds: 3,
    buildRequest: function(msgs, tools) {
      requests.push({ tools: tools });
      return { url: 'u', headers: {}, payload: {} };
    },
    execTool: function() { return Promise.resolve({ text: 'r', meta: { ok: true } }); }
  }).then(function(res) {
    ok('跑满 maxRounds 就停（不无限搜）', requests.length === 3, 'requests=' + requests.length);
    ok('最后一轮**不带** tools（逼它作答）', requests[2].tools === null, JSON.stringify(requests[2].tools));
    ok('前几轮都带 tools', !!requests[0].tools && !!requests[1].tools);
  });
})
// ---------- 取消 ----------
.then(function() {
  console.log('\n[取消]');
  var ac = new AbortController();
  ac.abort();
  return vm.runInContext('agentRun', sandbox)({
    messages: [],
    tools: [{}],
    buildRequest: function() { return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); },
    signal: ac.signal
  }).then(function() {
    ok('已取消的 signal 应当抛 AbortError', false);
  }, function(e) {
    ok('已取消的 signal 抛 AbortError（不是静默返回空回答）', e && e.name === 'AbortError', e && e.message);
  });
})
// ---------- 工具能力登记（v3.0.12）----------
// 这一节钉住的是「开了联网搜索，对话就整个不可用」那个事故的结构性原因：
//   能力只能靠证据学（去掉 tools 重发一次）、学到的要记住、记住的要能过期/重置。
.then(function() {
  console.log('\n[工具能力登记]');
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  var capState = vm.runInContext('toolCapState', sandbox);
  var capLearn = vm.runInContext('toolCapLearn', sandbox);
  var capForget = vm.runInContext('toolCapForget', sandbox);

  sandbox.settings.toolCapability = {};
  saves = 0;
  ok('没有记录时是 unknown（该试还是得试）', capState(pv, 'alias') === 'unknown');
  capLearn(pv, 'alias', false, 'HTTP 503 model_temporarily_unavailable');
  ok('学到「不支持」', capState(pv, 'alias') === 'no');
  ok('结论已落盘（saveSettings 被调）', saves === 1, 'saves=' + saves);
  var keys = Object.keys(sandbox.settings.toolCapability);
  ok('key 用 upstreamId（改显示名不该让结论失效）', keys.length === 1 && keys[0] === 'pv1|real-model', keys.join(','));
  ok('证据保留（够定位是哪个错误码）', /503/.test(sandbox.settings.toolCapability['pv1|real-model'].evidence));

  capForget(pv, 'alias');
  ok('forget 后回到 unknown（用户重新打开开关 = 再试一次）', capState(pv, 'alias') === 'unknown');

  // 证据的「保质期」按错误类别分：4xx 说明请求形状不对（稳定结论），5xx 可能只是上游抖了一下
  capLearn(pv, 'alias', false, 'HTTP 422', 422);
  sandbox.settings.toolCapability['pv1|real-model'].at = Date.now() - 25 * 3600 * 1000;
  ok('4xx 证据 25 小时后仍然算数', capState(pv, 'alias') === 'no');
  sandbox.settings.toolCapability['pv1|real-model'].at = Date.now() - 8 * 24 * 3600 * 1000;
  ok('4xx 证据超过 7 天自动复验（不永久封死）', capState(pv, 'alias') === 'unknown');

  capLearn(pv, 'alias', false, 'HTTP 503', 503);
  sandbox.settings.toolCapability['pv1|real-model'].at = Date.now() - 25 * 3600 * 1000;
  ok('5xx 证据一天后自动复验（上游可能只是抖了）', capState(pv, 'alias') === 'unknown');

  capLearn(pv, 'alias', true, 'ok');
  ok('也能记「支持」', capState(pv, 'alias') === 'yes');

  // 没有 settings 时不能崩（早期调用/测试环境）
  var savedSettings = sandbox.settings;
  delete sandbox.settings;
  ok('没有 settings 时返回 unknown 而不是抛异常', capState(pv, 'alias') === 'unknown');
  sandbox.settings = savedSettings;
})
// ---------- 降级：这一轮才试出来不支持 ----------
.then(function() {
  console.log('\n[降级 · 试出来的]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  var dropped = [];
  // 第 1 次：带 tools → 503（实测 kkaiapi 上的 gemini 就是这个形状：约 320ms 快速失败）
  responses.push(makeResponse(['{"error":{"message":"The requested model is temporarily unavailable.","code":"model_temporarily_unavailable"}}'], { ok: false, status: 503 }));
  // 第 2 次：不带 tools → 正常流式
  responses.push(makeResponse([delta({ content: '直接回答' }), finish('stop'), 'data: [DONE]\n\n']));

  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [{ role: 'user', content: '那你自己联网搜索吧' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: 'x', meta: { ok: true } }); },
    onDelta: function() {},
    onToolsDropped: function(e) { dropped.push(e && e.message); }
  }).then(function(res) {
    ok('先带 tools 试了一次', !!requests[0].tools);
    ok('失败后**自动去掉 tools 重发**', requests.length === 2 && requests[1].tools === null, 'requests=' + requests.length);
    ok('这一轮照样有回答（对话不死）', res.content === '直接回答', res.content);
    ok('结果标明降级 + 原因 probe', res.toolsDropped === true && res.droppedReason === 'probe');
    ok('能力被记为 no', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'no');
    ok('回调一次（用来弹一次 toast，不是每条消息都弹）', dropped.length === 1 && /503/.test(dropped[0]), JSON.stringify(dropped));
  });
})
// ---------- 降级：事先已知不支持 → 连试都不试 ----------
.then(function() {
  console.log('\n[降级 · 已知不支持]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  var dropped = [];
  responses.push(makeResponse([delta({ content: '照常回答' }), finish('stop'), 'data: [DONE]\n\n']));
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); },
    onToolsDropped: function(e) { dropped.push(e); }
  }).then(function(res) {
    ok('只发一次请求（不再白撞 503）', requests.length === 1, 'requests=' + requests.length);
    ok('一次就没带 tools', requests[0].tools === null);
    ok('标明 known', res.droppedReason === 'known' && res.toolsDropped === true);
    ok('不重复弹提示', dropped.length === 0);
    ok('内容正常', res.content === '照常回答');
  });
})
// ---------- 不去工具的错不能算到工具头上 ----------
.then(function() {
  console.log('\n[降级 · 两次都失败]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  responses.push(makeResponse(['{"error":{"message":"tools rejected"}}'], { ok: false, status: 503 }));
  responses.push(makeResponse(['{"error":{"message":"upstream down"}}'], { ok: false, status: 500 }));
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [], tools: [{}], provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); }
  }).then(function() {
    ok('两次都失败时不该 resolve', false);
  }, function(e) {
    ok('抛出的是**去掉工具后**那个错误（更真实）', /upstream down/.test(e.message), e.message);
    ok('不把「上游挂了」误记成「不支持工具」', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'unknown');
  });
})
// ---------- 已经产生副作用就不重发 ----------
.then(function() {
  console.log('\n[降级 · 工具已执行后失败]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  var execCount = 0;
  // 轮 1：调工具 → 轮 2：503
  responses.push(makeResponse([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }),
    finish('tool_calls'), 'data: [DONE]\n\n'
  ]));
  responses.push(makeResponse(['{"error":{"message":"boom"}}'], { ok: false, status: 503 }));
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [], tools: [{}], provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { execCount++; return Promise.resolve({ text: 'r', meta: { ok: true } }); }
  }).then(function() {
    ok('工具跑过之后失败应当抛出（不该悄悄重来）', false);
  }, function(e) {
    ok('工具跑过之后失败 → 抛原错误', /boom/.test(e.message), e.message);
    ok('不重发（否则重复计费）', requests.length === 2 && execCount === 1, 'requests=' + requests.length + ' exec=' + execCount);
    ok('不记能力结论（失败点不在 tools 上）', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'unknown');
  });
})
// ---------- 取消不重发 ----------
.then(function() {
  console.log('\n[降级 · 取消]');
  requests = []; responses = [];
  var ac = new AbortController();
  ac.abort();
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [], tools: [{}], provider: { id: 'p' }, model: 'm', signal: ac.signal,
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); }
  }).then(function() {
    ok('已取消应当抛 AbortError', false);
  }, function(e) {
    ok('取消抛 AbortError 且不重发（只发了一次）', e && e.name === 'AbortError' && requests.length === 1,
      (e && e.message) + ' requests=' + requests.length);
  });
})
.then(function() {
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})
.catch(function(e) {
  console.error('\n[异常] 测试自身崩了：', e && e.stack || e);
  process.exit(2);
});
