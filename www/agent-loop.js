// ===== agent-loop.js : 带工具的对话回合引擎（v3.0.8）=====
// 模块名：agent-loop.js
// 版本：v3（cache-bust；v3.0.12 工具能力登记 + 降级链；v3.0.13 文本工具协议）
// 新增日期：2026-10-28
//
// 职责：一轮「模型 → 工具调用 → 工具结果回填 → 再问模型」的完整循环。
//   它只管**请求与工具循环**，不碰消息树、不碰 DOM、不落库 —— 那三件事由调用方（chat.js）通过回调决定。
//
// 为什么单独成模块：
//   v3.0.5 的做法是「拿到用户消息 → 直接拿这句话去搜 → 把结果硬塞进上下文」。
//   那不是工具，那是检索管道：模型没有选择权，问「1+1 等于几」也会先去搜一次，多花一次计费；
//   用户问「帮我查一下 XX 官网的最新公告」，也没有机会让模型去抓具体那一页。
//   正确形态是 function calling：把 search / fetch 作为 tool 交给模型，由它决定要不要调、拿什么词调、
//   调几次、调完要不要再抓某个链接。
//
// 与其他路径的关系：
//   - **不动** chat.js 原有的三条流式/非流式路径（关着联网时走它们，零改动零风险）。
//   - 只在「会话开了联网」时由 chat.js 调用 agentRun；引擎自带 SSE 解析，因此需要一套独立的网络层
//     （APK 走 CapStreamHttp，Web 走 fetch，CapHttp 非流式兜底）。
//   - 语音通话不接（理由见看板 §2.4-F）。
//
// 依赖（运行时全局）：CapStreamHttp / CapHttp / isCapacitor / resolveChatWaitMs
//                     settings / saveSettings / modelToUpstreamId（能力登记用，仅运行时访问）

var AGENT_MAX_ROUNDS = 4;        // 总轮次上限（含最后一次纯作答）
var AGENT_MAX_TOOL_CALLS = 6;    // 单轮并发工具调用上限（模型偶尔一次要搜五六条，但别无限）

// ===== 工具能力登记（v3.0.12）=====
// 为什么需要它：v3.0.8 起「联网搜索」会把整轮对话切成「带 tools 的 agent 请求」。
//   但 `tools` 是**网关/接口**的能力，不是模型的智力 —— 同一把 key、同一个中转站里，
//   deepseek / claude / gpt / glm 收 tools，gemini 直接 503（详见下面「文本工具协议」一节）。
//   实测 api.kkaiapi.com（2026-10-29，同一条消息、只差 tools 字段）：
//     gemini-3.8-flash  无 tools → 200，有 tools → **503 model_temporarily_unavailable**（约 320ms 快速失败）
//     gemini-3.5-flash  同上
//     deepseek-v4.1-flash / gpt-6-luna / claude-sonnet-5 / glm-5.3  有无 tools 都是 200
//   v3.0.8~v3.0.11 没有任何地方记这件事，只有 chat.js 的 agentIsToolsUnsupported() 在
//   「看错误文案猜」—— 那套正则要求同时出现 tool 字样与 400/422，503 service_error 一条都不匹配，
//   于是整轮对话直接死在「HTTP 503: {…}」错误气泡里，看着像「联网搜索和别的提供方冲突」。
//
// 记的是什么：**原生 `tools` 字段能不能用**（'no' ≠ 这个模型不会调工具，只表示要改走文本协议）。
//
// 三条规则（这才是「从底层理顺」的落点，别再往回退）：
//   ① 能力**只能靠证据学**：判据是「同一轮换一条通道重发，成功了没有」，不是猜错误码/文案。
//      上游怎么表达「不收 tools」是它的事（400/422/404/405/501/503 都见过），客户端不押这个宝。
//   ② 学到的结论**要记住**（settings.toolCapability，按 provider|upstreamModel 存），
//      否则每发一条消息都先挨一次 503 —— 那是把一次性的学习成本变成永久成本。
//   ③ **联网是增强层，不是前置条件**：这一层任何失败都必须降级（文本协议 → 纯对话），
//      绝不能让「说话」这件事跟着失败。这是本节存在的根本理由。
var TOOL_CAP_TTL_MS = 7 * 24 * 3600 * 1000;        // 4xx 证据：请求形状不对，是模型/路由的稳定属性，记久一点
var TOOL_CAP_TTL_SOFT_MS = 24 * 3600 * 1000;       // 5xx 证据：也可能是上游抖动，一天后自动复验（最多一天撞一次）

function toolCapKey(provider, model) {
  var pid = (provider && provider.id) || '';
  var mid = model || '';
  // 用 upstreamId 而不是显示名：同一个模型在接口里改个显示名不该让结论失效
  try { if (typeof modelToUpstreamId === 'function') mid = modelToUpstreamId(provider, model) || mid; } catch (e) {}
  return pid + '|' + mid;
}

function toolCapStore() {
  if (typeof settings === 'undefined' || !settings) return null;
  if (!settings.toolCapability || typeof settings.toolCapability !== 'object' || Array.isArray(settings.toolCapability)) {
    settings.toolCapability = {};
  }
  return settings.toolCapability;
}

// 返回 'yes' | 'no' | 'unknown'。过期按 unknown 处理（宁可多试一次，不要永远封死）。
function toolCapState(provider, model) {
  var store = toolCapStore();
  if (!store) return 'unknown';
  var rec = store[toolCapKey(provider, model)];
  if (!rec || typeof rec !== 'object') return 'unknown';
  var at = typeof rec.at === 'number' ? rec.at : 0;
  var ttl = (typeof rec.ttl === 'number' && rec.ttl > 0) ? rec.ttl : TOOL_CAP_TTL_MS;
  if (!at || (Date.now() - at) > ttl) return 'unknown';
  if (rec.tools === true) return 'yes';
  if (rec.tools === false) return 'no';
  return 'unknown';
}

// 记一条结论。evidence 只存前 160 字（够定位是哪个错误码，又不至于把整段 JSON 塞进 settings）。
// status 决定这条证据能信多久：4xx（请求形状不对）→ 7 天；5xx / 没状态码（上游可能只是抖了一下）→ 1 天。
function toolCapLearn(provider, model, supported, evidence, status) {
  var store = toolCapStore();
  if (!store) return;
  var is4xx = (typeof status === 'number' && status >= 400 && status < 500);
  var ttl = (supported === true || is4xx) ? TOOL_CAP_TTL_MS : TOOL_CAP_TTL_SOFT_MS;
  store[toolCapKey(provider, model)] = {
    tools: supported === true,
    at: Date.now(),
    ttl: ttl,
    evidence: String(evidence || '').slice(0, 160)
  };
  try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) {}
}

// 清掉结论 = 「再试一次」。用户在会话里重新打开联网开关时调用（这是最自然的重试手势）。
function toolCapForget(provider, model) {
  var store = toolCapStore();
  if (!store) return;
  var k = toolCapKey(provider, model);
  if (!Object.prototype.hasOwnProperty.call(store, k)) return;
  delete store[k];
  try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) {}
}

// ===== SSE 解析 =====
// 只认 `data:` 行；跨分块的行用缓冲拼回来。
// 注意：一个 JSON 的 data 行可能被 TCP 切成两半 —— 这是流式最常见的坑，
//   所以必须按 \n 切完再处理，绝不假设一次 push 就是一个完整事件。
function agentCreateSseParser(onJson) {
  var buf = '';
  var done = false;
  return {
    push: function(text) {
      if (!text || done) return;
      buf += String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var lines = buf.split('\n');
      buf = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || line.charAt(0) === ':') continue;      // 空行 / 心跳注释
        if (line.indexOf('data:') !== 0) continue;          // id: / event: 之类一律不看
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; return; }
        if (!payload) continue;
        try { onJson(JSON.parse(payload)); } catch (e) { /* 单块坏了不影响整体 */ }
      }
    },
    isDone: function() { return done; },
    // 有些网关会忽略 stream:true，整段返回普通 JSON。这里把缓冲里剩下的半截交回去做兜底解析。
    rest: function() { var r = buf; buf = ''; return r; }
  };
}

// ===== 单轮流式请求 =====
// 返回 { content, reasoning, toolCalls:[{id,name,args}], finishReason, sawData }
// 任何网络错误都 throw；调用方决定是降级还是报错。
async function agentStreamOnce(o) {
  o = o || {};
  var req = o.req;
  var onDelta = o.onDelta || function() {};
  var signal = o.signal || null;
  var waitMs = (typeof resolveChatWaitMs === 'function') ? resolveChatWaitMs() : 300000;

  var turn = { content: '', reasoning: '', toolCalls: [], finishReason: null };

  // tool_calls 是**按 index 分片**来的（首片带 id/name，后续片只带 arguments 的碎片）。
  // 不按 index 归并就会把并行调用的参数拼串（实测 DeepSeek 一次会发 2 个 search）。
  var acc = {};
  var parser = agentCreateSseParser(function(json) {
    var choice = json && json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) turn.finishReason = choice.finish_reason;
    var delta = choice.delta;
    if (!delta) return;
    var rc = delta.reasoning_content || delta.reasoning || delta.thinking || '';
    if (rc) { turn.reasoning += rc; onDelta('reasoning', rc); }
    if (delta.content) { turn.content += delta.content; onDelta('content', delta.content); }
    var tcs = delta.tool_calls;
    if (Array.isArray(tcs)) {
      for (var i = 0; i < tcs.length; i++) {
        var tc = tcs[i] || {};
        var idx = (typeof tc.index === 'number') ? tc.index : 0;
        var c = acc[idx] || (acc[idx] = { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        var f = tc.function || {};
        if (f.name) c.name = f.name;
        if (f.arguments) c.args += f.arguments;
      }
    }
  });

  function collectTools() {
    var keys = Object.keys(acc).map(function(k) { return parseInt(k, 10); }).sort(function(a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var c = acc[keys[i]];
      if (!c || !c.name) continue;
      out.push({ id: c.id || ('call_' + i), name: c.name, args: c.args || '{}' });
    }
    return out;
  }

  if (signal && signal.aborted) { var ae = new Error('已取消'); ae.name = 'AbortError'; throw ae; }

  // ---------- APK：CapStreamHttp ----------
  if (typeof isCapacitor === 'function' && isCapacitor() &&
      typeof CapStreamHttp !== 'undefined' && CapStreamHttp) {
    var streamId = null;
    var early = [];
    var settled = false;
    var chunkL = null, endL = null, errL = null;
    var idleId = null;
    var fail = null;

    var promise = new Promise(function(resolve, reject) {
      function cleanup() {
        clearTimeout(idleId);
        try { if (chunkL && chunkL.remove) chunkL.remove(); } catch (e) {}
        try { if (endL && endL.remove) endL.remove(); } catch (e) {}
        try { if (errL && errL.remove) errL.remove(); } catch (e) {}
      }
      function finish(reason) {
        if (settled) return;
        settled = true;
        cleanup();
        // 忽略 stream:true 的门关：一个 data: 都没解出来时，把原文交回去当普通 JSON 解析
        if (!turn.content && !turn.reasoning && !turn.toolCalls.length && !acc['0']) {
          var salv = agentSalvage(parser.rest());
          if (salv) { turn.content = salv.content; turn.reasoning = salv.reasoning; if (salv.toolCalls) turn.toolCalls = salv.toolCalls; }
        }
        turn.toolCalls = turn.toolCalls.length ? turn.toolCalls : collectTools();
        if (reason && reason !== 'ok') fail = new Error(reason);
        if (fail) reject(fail); else resolve(turn);
      }
      function resetIdle() {
        clearTimeout(idleId);
        idleId = setTimeout(function() {
          if (settled) return;
          if (streamId) { try { CapStreamHttp.cancelStream({ id: streamId }); } catch (e) {} }
          finish('等待 ' + Math.round(waitMs / 1000) + ' 秒没有新数据');
        }, waitMs);
      }

      (async function() {
        try {
          chunkL = await CapStreamHttp.addListener('chunk', function(d) {
            if (streamId === null) { early.push(d); return; }
            if (!d || d.id !== streamId) return;
            resetIdle();
            parser.push(d.chunk);
          });
          endL = await CapStreamHttp.addListener('end', function(d) {
            if (streamId !== null && d && d.id && d.id !== streamId) return;
            finish('ok');
          });
          errL = await CapStreamHttp.addListener('error', function(d) {
            if (streamId !== null && d && d.id && d.id !== streamId) return;
            if (settled) return;
            settled = true;
            cleanup();
            var msg = (d && d.error) ? String(d.error) : '流式请求错误';
            var ne = new Error(msg);
            // 原生插件把非 2xx 的响应体一起带回来（形如 `HTTP 503: {…}`）。
            // 把状态码单独摘出来 —— 上层判断「是不是能力问题」时要看它，不要每次都重新解析字符串。
            var sm = /HTTP\s+(\d{3})/.exec(msg);
            if (sm) { ne.status = parseInt(sm[1], 10); ne.body = msg.slice(0, 800); }
            reject(ne);
          });
          ;


          if (signal) {
            var onAbort = function() {
              if (streamId) { try { CapStreamHttp.cancelStream({ id: streamId }); } catch (e) {} }
              if (settled) return;
              settled = true;
              cleanup();
              var e2 = new Error('已取消'); e2.name = 'AbortError';
              reject(e2);
            };
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }

          resetIdle();
          var payload = Object.assign({}, req.payload, { stream: true });
          var res = await CapStreamHttp.startStream({
            url: req.url,
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
            body: JSON.stringify(payload),
            readTimeoutMs: waitMs + 15000,
            connectTimeoutMs: 30000
          });
          streamId = res && res.id;
          for (var i = 0; i < early.length; i++) {
            if (early[i] && early[i].id === streamId) parser.push(early[i].chunk);
          }
          early = [];
        } catch (e) {
          if (!settled) { settled = true; cleanup(); reject(e); }
        }
      })();
    });
    return promise;
  }

  // ---------- Web：fetch 流式 ----------
  var payloadWeb = Object.assign({}, req.payload, { stream: true });
  var resp = await fetch(req.url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
    body: JSON.stringify(payloadWeb),
    signal: signal || undefined
  });
  if (!resp.ok) {
    var text = '';
    try { text = await resp.text(); } catch (e) {}
    var inner = '';
    try { var j = JSON.parse(text); inner = (j.error && (j.error.message || j.error)) || j.detail || ''; } catch (e) { inner = text.slice(0, 200); }
    var httpErr = new Error('HTTP ' + resp.status + (inner ? '：' + inner : ''));
    httpErr.status = resp.status;
    httpErr.body = String(text).slice(0, 800);
    throw httpErr;
  }
  if (!resp.body || !resp.body.getReader) {
    // 极端环境（无 ReadableStream）：整段读回来当普通 JSON 处理
    var whole = await resp.text();
    var salv2 = agentSalvage(whole);
    if (salv2) return Object.assign(turn, salv2);
    return turn;
  }
  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  while (true) {
    var r = await reader.read();
    if (r.done) break;
    parser.push(decoder.decode(r.value, { stream: true }));
    if (parser.isDone()) break;
  }
  var salvage = agentSalvage(parser.rest());
  if (salvage && !turn.content && !turn.reasoning && !Object.keys(acc).length) {
    turn.content = salvage.content || '';
    turn.reasoning = salvage.reasoning || '';
  }
  turn.toolCalls = collectTools();
  return turn;
}

// 非流式响应兜底：有些网关忽略 stream:true，整段返回一个普通 completion。
// 这里把 content / reasoning / tool_calls 抠出来，至少不至于"开了联网就没回复"。
function agentSalvage(raw) {
  if (!raw) return null;
  var s = String(raw).trim();
  var i = s.indexOf('{');
  if (i < 0) return null;
  var j = null;
  try { j = JSON.parse(s.slice(i)); } catch (e) { return null; }
  var ch = j && j.choices && j.choices[0];
  if (!ch) return null;
  var msg = ch.message || ch.delta || {};
  var out = {
    content: typeof msg.content === 'string' ? msg.content : '',
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : ''
  };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    out.toolCalls = msg.tool_calls.map(function(tc, k) {
      return {
        id: tc.id || ('call_' + k),
        name: (tc.function && tc.function.name) || '',
        args: (tc.function && tc.function.arguments) || '{}'
      };
    }).filter(function(c) { return !!c.name; });
  }
  return out;
}

// ===== 多轮循环 =====
// o = {
//   buildRequest: (messages, tools) => {url, headers, payload},   // tools 为 null 时不带工具
//   messages: [...],                                              // 初始上下文（不含工具消息）
//   tools: [...],                                                 // 工具定义
//   execTool: async (name, argsObj) => {text, meta},              // 单个工具的执行体
//   onDelta: (kind, text) => {},                                  // 'content' | 'reasoning'
//   onToolStart: (call) => {}, onToolEnd: (call, result) => {},
//   maxRounds, signal
// }
// 返回 { content, reasoning, toolCalls, finishReason, rounds, usedTools }
//   content / reasoning 是**跨轮累计**的（模型可能边说边搜），调用方据此渲染。
async function agentRun(o) {
  o = o || {};
  var msgs = (o.messages || []).slice();
  var tools = o.tools || null;
  var maxRounds = Math.max(1, o.maxRounds || AGENT_MAX_ROUNDS);
  var totalContent = '';
  var totalReasoning = '';
  var usedTools = [];
  var finishReason = null;
  var round = 0;

  for (round = 1; round <= maxRounds; round++) {
    // 最后一轮不再给工具：逼它把已有的材料写成回答，避免"无限搜索"
    var toolsThisRound = (round === maxRounds) ? null : tools;
    var req = o.buildRequest(msgs, toolsThisRound);
    var turn = await agentStreamOnce({
      req: req,
      signal: o.signal,
      onDelta: function(kind, text) {
        if (kind === 'content') totalContent += text;
        else totalReasoning += text;
        if (o.onDelta) o.onDelta(kind, text);
      }
    });
    finishReason = turn.finishReason || finishReason;

    if (!turn.toolCalls || !turn.toolCalls.length) {
      return {
        content: totalContent, reasoning: totalReasoning,
        toolCalls: [], finishReason: finishReason, rounds: round, usedTools: usedTools
      };
    }

    // 把这一轮的 tool_calls 原样回填（content 必须一起回填：模型可能边说边调）
    msgs.push({
      role: 'assistant',
      content: turn.content || '',
      tool_calls: turn.toolCalls.map(function(c) {
        return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args } };
      })
    });

    var calls = turn.toolCalls.slice(0, AGENT_MAX_TOOL_CALLS);
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      var parsed = {};
      try { parsed = JSON.parse(call.args || '{}'); } catch (e) { parsed = {}; }
      call.parsedArgs = parsed;
      if (o.onToolStart) o.onToolStart(call);
      var result;
      try {
        result = await o.execTool(call.name, parsed);
      } catch (e) {
        // 工具失败也算"有结果"：如实告诉模型，让它自己决定换个词还是直接说查不到。
        result = { text: '工具执行失败：' + ((e && e.message) || e), meta: { ok: false } };
      }
      if (!result || typeof result.text !== 'string') result = { text: '（工具没有返回内容）', meta: {} };
      usedTools.push({ name: call.name, args: parsed, ok: !(result.meta && result.meta.ok === false), meta: result.meta || {} });
      if (o.onToolEnd) o.onToolEnd(call, result);
      msgs.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }

  // 轮次用尽仍在调工具（理论上最后一轮没给 tools，走不到这里）
  return {
    content: totalContent, reasoning: totalReasoning,
    toolCalls: [], finishReason: finishReason, rounds: round - 1, usedTools: usedTools
  };
}

// ===== 文本工具协议（v3.0.13）=====
// 为什么要有第二条工具通道：`tools` 字段是**网关**的能力，不是模型的智力。
//   实测（2026-10-29，api.kkaiapi.com，同一条消息只差 tools 字段）：
//     gemini-3.8-flash / gemini-3.5-flash  无 tools → 200，有 tools → 503 model_temporarily_unavailable（≈320ms）
//     deepseek-v4.1-flash / gpt-6-luna / claude-sonnet-5 / glm-5.3  有无 tools 都 200
//   同一批 gemini 在别的 harness 里照样能发起 tool call —— 说明**模型会调工具，是这条网关不收 tools 字段**。
//   那就别指望它：客户端自己补一层 —— 把工具说明写进提示词，让模型用一段固定格式的**文本**发起调用，
//   我们解析这段文本、执行、再把结果喂回去。效果与 function calling 等价，只是协议从 JSON 字段换成文本，
//   任何会说话的模型都能用（GPT-3.5 级也够）。
//
// 三条纪律：
//   ① 工具清单**只有一份真相**：从 WEB_TOOL_DEFS 生成（§4.24：两处实现必然分叉）。
//   ② 调用块**不能漏到界面上**：流式输出时按标记「拦截 + 尾巴回退」，用户只看到真正的回答。
//   ③ 它是**降级链中间那一环**，不是终点：文本协议也失败时还有纯对话兜底（§3.2 第 10 条）。
var TOOL_CALL_OPEN = '<tool_call>';
var TOOL_CALL_CLOSE = '</tool_call>';

function agentCompactParams(fnDef) {
  var p = (fnDef && fnDef.parameters) || {};
  var props = p.properties || {};
  var req = p.required || [];
  var parts = [];
  for (var k in props) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
    var d = props[k] || {};
    parts.push(k + ':' + (d.type || 'string') + (req.indexOf(k) >= 0 ? '(必填)' : '(可选)'));
  }
  return '{' + parts.join(', ') + '}';
}

// 从 WEB_TOOL_DEFS 生成协议说明；没有 WEB_TOOL_DEFS 时返回空串（调用方据此跳过文本通道）。
// 体量控制：工具描述本来就长（那是"什么时候该用/不该用"的判断依据，删了它会乱调工具），
//   所以这里只额外加三样东西 —— 日期（挂在 web_search 上）、一句链式提示、一个调用样例。
//   实测约 650 字符 ≈ 400~450 token，且放在 system 末尾（不抢开头权重）。
function agentToolProtocolPrompt(round, maxRounds) {
  var defs = (typeof WEB_TOOL_DEFS !== 'undefined' && Array.isArray(WEB_TOOL_DEFS)) ? WEB_TOOL_DEFS : null;
  if (!defs || !defs.length) return '';
  var dateHint = agentDateHint();
  var lines = [];
  lines.push('【工具调用协议】你可以联网。需要实时或不确定的信息时用下面的工具；常识、推理、写作、代码直接回答，不要调用。');
  for (var i = 0; i < defs.length; i++) {
    var f = defs[i] && (defs[i].function || defs[i]);
    if (!f || !f.name) continue;
    var desc = f.description || '';
    if (f.name === 'web_search') desc += dateHint;      // 日期挂在"决定怎么搜"的位置上
    lines.push('- ' + f.name + ' ' + agentCompactParams(f) + '：' + desc);
  }
  // 链式提示：模型天然倾向"搜一次就答"，不会主动去抓正文 —— 不写这句它就不抓（实测 gemini 就是）。
  lines.push('如果搜索结果的摘要不够（缺具体数字、原文表述、名单），就再调 fetch_url 把那一页正文抓下来，不要拿摘要猜。');
  lines.push('');
  lines.push('调用方式：**只输出下面这一段，前后不要有任何其它文字**：');
  lines.push(TOOL_CALL_OPEN);
  lines.push('{"name":"web_search","arguments":{"query":"要搜的词"}}');
  lines.push(TOOL_CALL_CLOSE);
  lines.push('客户端会执行它，并把结果作为下一条消息发给你。拿到结果后可以继续调用（再来一个同样的块），也可以直接作答；作答时不要再输出这个块。');
  if (round >= maxRounds) lines.push('【这是最后一次机会：不要再调用工具，直接用已有材料作答。】');
  return lines.join('\n');
}

// 环境信息（只有日期，**不带时分**）：联网场景里模型必须先知道"今天"是哪天，
//   否则它会拿训练数据里的某个日期去拼搜索词 —— 实测 gemini 把"今天的科技新闻"搜成了
//   「今日科技新闻 2024年5月22日」，拿回一堆两年前的旧闻还当成今天的。
// 为什么只放日期：§4.24 的教训是「逐轮会变的东西绝不能进 system」—— 带上时分等于每分钟
//   换一次前缀，缓存全废；日期一天变一次，代价可以接受。
// ★ v3.0.14：日期不再单独占一行 system，而是**挂在 web_search 的工具说明上**。
//   两个理由：① 原生通道的 system 提示词因此**一个字符都不变**（DeepSeek 完全不受影响）；
//   ② 它出现在模型"决定怎么搜"的位置上，比在 system 开头更贴题，也不跟系统指令抢注意力。
// ★ v3.0.15：文案改成「本机日期」，并显式说明它从哪来、能用来干什么。
//   为什么要写清楚：这行字是**模型每次请求都读得到的事实**，不是搜索来的 ——
//   用户问「今天几号」它会直接答（这是对的：搜索引擎不知道"你的今天"），
//   但如果只写「当前日期」，模型会当成宇宙真理去讲，用户无从知道它其实来自设备时钟。
function agentTodayStr() {
  var d = new Date();
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

// 只到天、不带时分：带上时分等于每分钟换一次前缀，缓存全废（§4.24）。
function agentDateHint() {
  return '（本机日期 ' + agentTodayStr() + '：这是用户设备的当前日期。'
    + '问「今天几号」这类问题就按它回答，不必为此搜索；但拼搜索词时不要自己编日期，'
    + '需要「今天 / 最近」就直接写这些词，或用 after: 运算符。）';
}

// 原生通道：把日期拼进 web_search 的 description（工具定义本来就要发，等于零额外开销）。
// 只改 web_search，别的一个字段都不动 —— 其它工具的行为保持原样。
function agentToolsWithDate(tools) {
  if (!tools || !tools.length) return tools;
  var hint = agentDateHint();
  return tools.map(function(t) {
    var f = t && (t.function || t);
    if (!f || f.name !== 'web_search') return t;
    return { type: 'function', function: Object.assign({}, f, { description: (f.description || '') + hint }) };
  });
}

// 把协议说明并进**第一条 system**（不新开一条 system 消息：不少网关只认开头那一条，
// 多一条 system 会被静默丢掉甚至报错 —— 这个坑在语音侧已经踩过）。
// 说明块放在 system 的**末尾**（不是开头）：模型对"最近读到的指令"更敏感，
// 也避免它顶到用户原始系统提示词前面去抢注意力权重。
function agentWithProtocol(msgs, proto) {
  var out = (msgs || []).slice();
  if (!proto) return out;
  if (out[0] && out[0].role === 'system') {
    out[0] = Object.assign({}, out[0], { content: ((out[0].content || '') + '\n\n' + proto).trim() });
  } else {
    out.unshift({ role: 'system', content: proto });
  }
  return out;
}

// 流式拦截器：标记之前的文字照常往外送，标记之后一律扣住（那是给客户端看的，不是给用户看的）。
// 尾巴留 OPEN.length-1 个字符不发 —— 否则「<tool_ca」这种半个标记会被当正文漏出去。
function agentCreateCallSplitter(onText) {
  var buf = '';
  var blocked = false;
  var sent = '';
  var keep = TOOL_CALL_OPEN.length - 1;
  function emit(t) { if (!t) return; sent += t; if (onText) onText(t); }
  return {
    push: function(chunk) {
      if (blocked || !chunk) return;
      buf += chunk;
      var idx = buf.toLowerCase().indexOf(TOOL_CALL_OPEN);
      if (idx >= 0) {
        emit(buf.slice(0, idx));
        buf = buf.slice(idx);
        blocked = true;
        return;
      }
      if (buf.length > keep) {
        var cut = buf.length - keep;
        emit(buf.slice(0, cut));
        buf = buf.slice(cut);
      }
    },
    finish: function() {
      if (!blocked) { var t = buf; buf = ''; emit(t); }
      return blocked;
    },
    text: function() { return sent; }
  };
}

// 解析模型吐出来的调用块。宽松一点：name/arguments 是标准形状，但也接受 args/parameters/input
// 与 OpenAI 那种 {function:{name,arguments}} 嵌套 —— 模型不是编译器，格式差一点不该整轮作废。
function agentParseToolCalls(text) {
  var s = String(text || '');
  var out = [];
  function absorb(raw) {
    raw = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var j = null;
    try { j = JSON.parse(raw); } catch (e) { return; }
    var arr = Array.isArray(j) ? j : [j];
    for (var i = 0; i < arr.length; i++) {
      var one = arr[i] || {};
      var fn = one.function || one;
      var name = fn.name || fn.tool || fn.tool_name || '';
      if (!name) continue;
      var args = fn.arguments;
      if (args === undefined) args = fn.args;
      if (args === undefined) args = fn.parameters;
      if (args === undefined) args = fn.input;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e2) { args = {}; } }
      out.push({ id: 'txt_' + out.length, name: String(name), args: args || {} });
    }
  }
  var re = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  var m;
  while ((m = re.exec(s)) !== null) absorb(m[1]);
  if (!out.length) {
    // 没闭合（被 max_tokens 截断）：把标记之后的尾巴拿来试一次
    var oi = s.toLowerCase().lastIndexOf(TOOL_CALL_OPEN);
    if (oi >= 0) absorb(s.slice(oi + TOOL_CALL_OPEN.length).replace(/<\/tool_call>[\s\S]*$/i, ''));
  }
  return out;
}

// 文本协议通道：一轮「模型 → 解析文本调用 → 工具 → 回填 → 再问模型」。
// 返回结构与 agentRun 一致（content 是**跨轮累计的可见正文**，不含被扣住的调用块）。
async function agentTextRun(o) {
  o = o || {};
  var msgs = (o.messages || []).slice();
  var maxRounds = Math.max(1, o.maxRounds || AGENT_MAX_ROUNDS);
  var totalContent = '';
  var totalReasoning = '';
  var usedTools = [];
  var finishReason = null;
  var rounds = 0;

  for (var round = 1; round <= maxRounds; round++) {
    rounds = round;
    var proto = agentToolProtocolPrompt(round, maxRounds);
    var splitter = agentCreateCallSplitter(function(t) { if (o.onDelta) o.onDelta('content', t); });
    var turn = await agentStreamOnce({
      req: o.buildRequest(agentWithProtocol(msgs, proto), null),   // 关键：**不带 tools 字段**
      signal: o.signal,
      onDelta: function(kind, text) {
        if (kind === 'content') splitter.push(text);
        else { totalReasoning += text; if (o.onDelta) o.onDelta('reasoning', text); }
      }
    });
    finishReason = turn.finishReason || finishReason;
    splitter.finish();
    totalContent += splitter.text();

    var calls = agentParseToolCalls(turn.content);
    if (!calls.length) {
      return {
        content: totalContent, reasoning: totalReasoning, toolCalls: [],
        finishReason: finishReason, rounds: round, usedTools: usedTools, engine: 'text'
      };
    }

    // 回填「模型自己说过的话」（含那个块）：它下一轮要能看见自己刚才发了什么
    msgs.push({ role: 'assistant', content: turn.content || '' });
    var results = [];
    var use = calls.slice(0, AGENT_MAX_TOOL_CALLS);
    for (var i = 0; i < use.length; i++) {
      var call = use[i];
      call.parsedArgs = call.args || {};
      if (o.onToolStart) o.onToolStart(call);
      var result;
      try {
        result = await o.execTool(call.name, call.parsedArgs);
      } catch (e) {
        result = { text: '工具执行失败：' + ((e && e.message) || e), meta: { ok: false } };
      }
      if (!result || typeof result.text !== 'string') result = { text: '（工具没有返回内容）', meta: {} };
      usedTools.push({ name: call.name, args: call.parsedArgs, ok: !(result.meta && result.meta.ok === false), meta: result.meta || {} });
      if (o.onToolEnd) o.onToolEnd(call, result);
      results.push('工具「' + call.name + '」的结果：\n' + result.text);
    }
    // 结果用 role:'user' 回填（不用 role:'tool'）：走文本协议的多半是不认 tools 字段的网关，
    //   role:'tool' 它们同样可能不认；用 user 是最兼容的写法。
    msgs.push({
      role: 'user',
      content: results.join('\n\n') + '\n\n（要继续调用工具就再输出一个 ' + TOOL_CALL_OPEN + ' 块；否则直接用上面的材料作答。）'
    });
  }

  return {
    content: totalContent, reasoning: totalReasoning, toolCalls: [],
    finishReason: finishReason, rounds: rounds, usedTools: usedTools, engine: 'text'
  };
}

// ===== 带「工具通道自适应」的一轮（v3.0.12 / v3.0.13）=====
// chat.js 唯一该调的入口。它替调用方处理掉「这个模型/这条网关到底怎么用工具」这件事。
//
// 通道链（从强到弱，失败只降一级，**绝不把整轮打死**）：
//   ① native —— 标准 function calling（`tools` 字段），效果最好
//   ② text   —— 文本工具协议（本文件上半部分），给「不收 tools 字段」的网关用
//   ③ plain  —— 纯对话，一条工具都不给（最后的安全网）
//
// 已知 native 不行（cap='no'）→ 直接从 ② 开始，不再白撞一次 503。
// 每一级失败时：
//   · **已经产出过内容/跑过工具** → 立刻抛（重来会重复计费、也会推翻用户已看到的东西）
//   · **一个字都没产出** → 记下错误，降一级继续
// 降级成功后记一条能力结论（证据 = 上一级的错误），下次直接从合适的通道开始。
//
// 返回 agentRun 的结果，另加：
//   engine            'native' | 'text' | 'plain'
//   nativeUnsupported 本轮才试出来「原生工具不可用」（用来弹一次提示 / 留一条说明）
// 参数：与 agentRun 相同，另加 provider / model（能力登记）与 onToolsDropped(err, engine)。
async function agentRunAdaptive(o) {
  o = o || {};
  var hasKey = !!(o.provider && o.model);
  var cap = hasKey ? toolCapState(o.provider, o.model) : 'unknown';
  var hasTools = !!(o.tools && o.tools.length);
  var hasProto = !!agentToolProtocolPrompt(1, 99);

  var chain;
  if (!hasTools) chain = ['plain'];
  else if (cap === 'no') chain = hasProto ? ['text', 'plain'] : ['plain'];
  else chain = hasProto ? ['native', 'text', 'plain'] : ['native', 'plain'];

  var lastErr = null;
  var nativeTried = false;

  for (var i = 0; i < chain.length; i++) {
    var eng = chain[i];
    var produced = false;
    var opts = Object.assign({}, o, {
      // 原生通道：日期只挂在 web_search 的说明上（system 提示词一个字符都不动）
      tools: eng === 'native' ? agentToolsWithDate(o.tools) : o.tools,
      onDelta: function(kind, text) { produced = true; if (o.onDelta) o.onDelta(kind, text); },
      // 工具一开跑就算「已经产生副作用」：再重来一次等于再搜一次、再计一次费
      onToolStart: function(call) { produced = true; if (o.onToolStart) o.onToolStart(call); }
    });

    var res;
    try {
      if (eng === 'native') { nativeTried = true; res = await agentRun(opts); }
      else if (eng === 'text') res = await agentTextRun(opts);
      else res = await agentRun(Object.assign({}, opts, { tools: null, maxRounds: 1 }));
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;   // 用户打断：原样抛，不要降级重来
      if (produced) throw e;                       // 已经出过东西：真实中断，保留半截
      lastErr = e;
      continue;
    }

    res.engine = eng;
    // 原生通道试过且失败、后面某条通道成功了
    if (nativeTried && eng !== 'native') {
      var st = lastErr && lastErr.status;
      // ★ 只有「服务器明确拒了这次请求」（带 HTTP 状态码）才算「通道不兼容」的证据。
      //   超时 / 断网 / 空响应一律**不记** —— 实测踩过最典型的假阳性：deepseek 原生一次
      //   「等待 300 秒没有新数据」，被记成了「不支持 tools」，于是这个模型从此被推去走文本协议。
      //   判据是**结构化事实**（有没有状态码），不是猜错误文案。
      if (hasKey && typeof st === 'number') {
        toolCapLearn(o.provider, o.model, false, (lastErr && lastErr.message) || 'native tools rejected', st);
        res.nativeUnsupported = true;
      }
      res.nativeError = lastErr;
      if (o.onToolsDropped) { try { o.onToolsDropped(lastErr, eng, res.nativeUnsupported === true); } catch (e3) {} }
    }
    return res;
  }

  throw lastErr || new Error('请求失败');
}
