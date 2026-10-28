// ===== agent-loop.js : 带工具的对话回合引擎（v3.0.8）=====
// 模块名：agent-loop.js
// 版本：v1（cache-bust）
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

var AGENT_MAX_ROUNDS = 4;        // 总轮次上限（含最后一次纯作答）
var AGENT_MAX_TOOL_CALLS = 6;    // 单轮并发工具调用上限（模型偶尔一次要搜五六条，但别无限）

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
            reject(new Error(msg));
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
    throw new Error('HTTP ' + resp.status + (inner ? '：' + inner : ''));
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
