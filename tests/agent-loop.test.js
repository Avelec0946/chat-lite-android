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
  // v3.0.13：文本协议的工具清单从 WEB_TOOL_DEFS 生成（只有一份真相）
  WEB_TOOL_DEFS: [{ type: 'function', function: { name: 'web_search', description: '搜索互联网',
    parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' } }, required: ['query'] } } }],
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
//   能力只能靠证据学（换一条通道重发成不成功）、学到的要记住、记住的要能过期/重置。
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
  ok('学到「原生 tools 不可用」', capState(pv, 'alias') === 'no');
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

  var savedSettings = sandbox.settings;
  delete sandbox.settings;
  ok('没有 settings 时返回 unknown 而不是抛异常', capState(pv, 'alias') === 'unknown');
  sandbox.settings = savedSettings;
})
// ---------- 文本工具协议：解析 ----------
.then(function() {
  console.log('\n[文本协议 · 解析]');
  var parse = vm.runInContext('agentParseToolCalls', sandbox);
  var one = parse('我先查一下。\n<tool_call>\n{"name":"web_search","arguments":{"query":"今天科技新闻"}}\n</tool_call>');
  ok('标准形状能解析', one.length === 1 && one[0].name === 'web_search' && one[0].args.query === '今天科技新闻', JSON.stringify(one));
  var two = parse('<tool_call>{"name":"web_search","arguments":{"query":"a"}}</tool_call><tool_call>{"name":"fetch_url","arguments":{"url":"https://x"}}</tool_call>');
  ok('一个回复里多个块都能解析', two.length === 2 && two[1].name === 'fetch_url', JSON.stringify(two));
  var strArgs = parse('<tool_call>{"name":"web_search","arguments":"{\\"query\\":\\"b\\"}"}</tool_call>');
  ok('arguments 是字符串也能吃（模型常这么写）', strArgs.length === 1 && strArgs[0].args.query === 'b', JSON.stringify(strArgs));
  var fenced = parse('<tool_call>\n```json\n{"name":"web_search","args":{"query":"c"}}\n```\n</tool_call>');
  ok('包了 ```json 围栏也能吃', fenced.length === 1 && fenced[0].args.query === 'c', JSON.stringify(fenced));
  var openAI = parse('<tool_call>{"function":{"name":"web_search","arguments":{"query":"d"}}}</tool_call>');
  ok('OpenAI 嵌套形状也能吃', openAI.length === 1 && openAI[0].name === 'web_search', JSON.stringify(openAI));
  var truncated = parse('<tool_call>{"name":"web_search","arguments":{"query":"e"}}');
  ok('没闭合（被 max_tokens 截断）也能吃', truncated.length === 1 && truncated[0].args.query === 'e', JSON.stringify(truncated));
  ok('普通文本不会被误判成调用', parse('今天天气不错，没有工具调用。').length === 0);
})
// ---------- 文本工具协议：流式拦截 ----------
.then(function() {
  console.log('\n[文本协议 · 调用块不能漏到界面上]');
  var out = [];
  var sp = vm.runInContext('agentCreateCallSplitter', sandbox)(function(t) { out.push(t); });
  // 故意把标记切成三段，模拟 TCP 分包
  sp.push('我先查一下');
  sp.push('。<tool_');
  sp.push('call>\n{"name":"web_search"');
  sp.push(',"arguments":{"query":"x"}}\n</tool_call>');
  sp.finish();
  var text = out.join('');
  ok('标记之前的正文照常输出', text === '我先查一下。', JSON.stringify(text));
  ok('半个标记不会被当正文漏出去', text.indexOf('<tool') < 0, JSON.stringify(text));

  var out2 = [];
  var sp2 = vm.runInContext('agentCreateCallSplitter', sandbox)(function(t) { out2.push(t); });
  sp2.push('正常回答');
  sp2.push('，没有工具');
  sp2.finish();
  ok('没有调用时一个字都不少（尾巴要 flush）', out2.join('') === '正常回答，没有工具', JSON.stringify(out2.join('')));
})
// ---------- 降级链：原生失败 → 文本协议接上 ----------
.then(function() {
  console.log('\n[降级链 · 原生失败 → 文本协议]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  var dropped = [];
  // ① 原生带 tools → 503（实测 kkaiapi 上的 gemini 就是这个形状）
  responses.push(makeResponse(['{"error":{"message":"The requested model is temporarily unavailable.","code":"model_temporarily_unavailable"}}'], { ok: false, status: 503 }));
  // ② 文本协议 → 模型吐调用块
  responses.push(makeResponse([
    delta({ content: '<tool_call>\n{"name":"web_search","arguments":{"query":"今天科技新闻"}}\n</tool_call>' }),
    finish('tool_calls'), 'data: [DONE]\n\n'
  ]));
  // ③ 回填结果后 → 正常作答
  responses.push(makeResponse([delta({ content: '查到三条，第一条是……' }), finish('stop'), 'data: [DONE]\n\n']));

  var execCalls = [];
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '帮我查今天科技新闻' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) {
      requests.push({ tools: tools, messages: JSON.parse(JSON.stringify(msgs)) });
      return { url: 'u', headers: {}, payload: {} };
    },
    execTool: function(name, args) {
      execCalls.push({ name: name, args: args });
      return Promise.resolve({ text: '[1] 示例结果', meta: { ok: true, count: 1 } });
    },
    onDelta: function() {},
    onToolsDropped: function(e, engine) { dropped.push(engine); }
  }).then(function(res) {
    ok('第一次走原生（带 tools）', !!requests[0].tools);
    ok('第二次改走文本协议（不带 tools）', requests.length === 3 && requests[1].tools === null, 'requests=' + requests.length);
    ok('文本协议把工具说明并进第一条 system（不新开 system）',
      requests[1].messages[0].role === 'system' && /工具调用协议/.test(requests[1].messages[0].content) &&
      requests[1].messages.filter(function(m) { return m.role === 'system'; }).length === 1);
    // 日期只挂在 web_search 的工具说明上；**原生通道的 system 一个字符都不变**（DeepSeek 不受影响）
    ok('原生通道的 system 提示词没被注入任何东西',
      requests[0].messages[0].role === 'system' && requests[0].messages[0].content === '你是助手',
      JSON.stringify(requests[0].messages[0].content));
    // 日期必须是**运行时算出来的那个值**，不是写死的字符串
    var today = vm.runInContext('agentTodayStr()', sandbox);
    ok('日期挂在 web_search 的 description 上（原生），且用的是运行时值',
      (requests[0].tools[0].function.description || '').indexOf('本机日期 ' + today) >= 0,
      requests[0].tools[0].function.description);
    ok('文本协议的说明块里也带日期（同一个运行时值）',
      requests[1].messages[0].content.indexOf('本机日期 ' + today) >= 0);
    ok('日期只到天、不带时分（带时分等于每分钟换一次 system，前缀缓存全废）',
      !/\d{4}-\d{2}-\d{2}\s*\d{2}:/.test(requests[1].messages[0].content) &&
      !/\d{4}-\d{2}-\d{2}\s*\d{2}:/.test(requests[0].tools[0].function.description || ''));
    ok('除 web_search 外的工具定义原样不动',
      requests[0].tools.length === 1);
    ok('工具真的被执行了', execCalls.length === 1 && execCalls[0].args.query === '今天科技新闻', JSON.stringify(execCalls));
    ok('工具结果用 role:user 回填（兼容不认 tool 角色的网关）',
      requests[2].messages.some(function(m) { return m.role === 'user' && /示例结果/.test(m.content); }));
    ok('回填了模型自己说的那句（含调用块）',
      requests[2].messages.some(function(m) { return m.role === 'assistant' && /<tool_call>/.test(m.content); }));
    ok('最终回答正常', res.content === '查到三条，第一条是……', res.content);
    ok('调用块没有漏进正文', res.content.indexOf('<tool_call>') < 0);
    ok('engine 标为 text', res.engine === 'text');
    ok('标明「原生不支持」+ 回调一次', res.nativeUnsupported === true && dropped.length === 1 && dropped[0] === 'text');
    ok('能力被记为 no（下次直接走文本协议）', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'no');
  });
})
// ---------- 原生超时（没有状态码）不许被记成「不支持 tools」 ----------
// 这是实测踩过的假阳性：deepseek 原生一次「等待 300 秒没有新数据」被记成「不支持 tools」，
// 于是这个模型从此被推去走文本协议。判据必须是「服务器带状态码拒了」，不是「失败了」。
.then(function() {
  console.log('\n[降级链 · 超时不算证据]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  var dropped = [];
  responses.push({ reject: new Error('等待 300 秒没有新数据') });
  responses.push(makeResponse([delta({ content: '文本协议答的' }), finish('stop'), 'data: [DONE]\n\n']));
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); },
    onToolsDropped: function(e, engine, unsupported) { dropped.push([engine, unsupported]); }
  }).then(function(res) {
    ok('超时后照样降级并答出来', res.content === '文本协议答的' && res.engine === 'text');
    ok('但**不**记「原生工具不可用」', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'unknown');
    ok('结果里不标 nativeUnsupported', res.nativeUnsupported !== true);
    ok('回调如实告诉 UI「不是不支持，只是没走通」', dropped.length === 1 && dropped[0][1] === false);
  });
})
// ---------- 已知 no：直接走文本协议，不再白撞 503 ----------
.then(function() {
  console.log('\n[降级链 · 已知原生不可用]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  var dropped = [];
  sandbox.settings.toolCapability = {};
  vm.runInContext('toolCapLearn', sandbox)(pv, 'alias', false, 'HTTP 503', 503);
  responses.push(makeResponse([delta({ content: '照常回答' }), finish('stop'), 'data: [DONE]\n\n']));
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); },
    onToolsDropped: function(e, engine) { dropped.push(engine); }
  }).then(function(res) {
    ok('只发一次请求（不再白撞 503）', requests.length === 1, 'requests=' + requests.length);
    ok('一次就不带 tools', requests[0].tools === null);
    ok('engine=text、没有「刚试出来」标记', res.engine === 'text' && !res.nativeUnsupported);
    ok('不重复弹提示', dropped.length === 0);
    ok('内容正常', res.content === '照常回答');
  });
})
// ---------- 三条通道都不行：不误学、抛真实错误 ----------
.then(function() {
  console.log('\n[降级链 · 全都不行]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  responses.push(makeResponse(['{"error":{"message":"tools rejected"}}'], { ok: false, status: 503 }));
  responses.push(makeResponse(['{"error":{"message":"text proto rejected"}}'], { ok: false, status: 503 }));
  responses.push(makeResponse(['{"error":{"message":"upstream down"}}'], { ok: false, status: 500 }));
  return vm.runInContext('agentRunAdaptive', sandbox)({
    messages: [], tools: [{}], provider: pv, model: 'alias',
    buildRequest: function(msgs, tools) { requests.push({ tools: tools }); return { url: 'u', headers: {}, payload: {} }; },
    execTool: function() { return Promise.resolve({ text: '', meta: {} }); }
  }).then(function() {
    ok('三条通道都失败时不该 resolve', false);
  }, function(e) {
    ok('抛的是最后一条通道的错误（最接近真相）', /upstream down/.test(e.message), e.message);
    ok('三条通道都试过', requests.length === 3, 'requests=' + requests.length);
    ok('不把「上游挂了」误记成「原生工具不可用」', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'unknown');
  });
})
// ---------- 已经产生副作用就不重来 ----------
.then(function() {
  console.log('\n[降级链 · 工具已执行后失败]');
  requests = []; responses = [];
  var pv = { id: 'pv1', models: [{ id: 'alias', upstreamId: 'real-model' }] };
  sandbox.settings.toolCapability = {};
  var execCount = 0;
  // 轮 1：原生通道调工具 → 轮 2：503
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
    ok('不换通道重来（否则重复计费）', requests.length === 2 && execCount === 1, 'requests=' + requests.length + ' exec=' + execCount);
    ok('不记能力结论（失败点不在 tools 上）', vm.runInContext('toolCapState', sandbox)(pv, 'alias') === 'unknown');
  });
})
// ---------- 取消不重来 ----------
.then(function() {
  console.log('\n[降级链 · 取消]');
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
    ok('取消抛 AbortError 且不换通道重来', e && e.name === 'AbortError' && requests.length === 1,
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
