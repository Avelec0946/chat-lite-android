// ===== web-search.js : 联网搜索工具（DeepSeek Search / Fetch）=====
// 模块名：web-search.js
// 版本：v4（cache-bust）
// 新增日期：2026-10-28（v3.0.5）；v3.0.8 改为**工具调用**形态
//
// 职责：
//   ① 调用 DeepSeek 官方「网页搜索」与「网页抓取」接口
//      POST https://api.deepseek.com/v1/tools/search
//      POST https://api.deepseek.com/v1/tools/fetch
//   ② 把这两个接口包装成模型可调用的 **function calling 工具**（WEB_TOOL_DEFS + runWebTool）
//   ③ 会话级开关（conv.webSearch）：开着的会话，请求里带上 tools，由模型自己决定调不调
//   ④ 设置面板「联网搜索」分组的回填 / 保存 / 测试
//
// 依赖（均为运行时全局，不在本文件顶层执行）：
//   app.js      state / settings / isCapacitor / CapHttp / escapeHtml / showToast / save / saveSettings
//   providers.js normalizeBaseUrl / getProvider / normalizeProvider
//   db.js       defaultWebSearchSettings / migrateWebSearchSettings（默认值定义在那里，和 voice 同惯例）
//   agent-loop.js  agentRun —— 真正跑「模型→工具→模型」循环的地方（本文件只提供工具与执行体）
//
// 加载顺序：providers.js 之后、agent-loop.js 之前、chat.js 之前。
//
// ===== v3.0.8 的架构纠正（这一版最重要的说明）=====
// v3.0.5 做的是「拿到用户那句话 → 直接拿去搜 → 结果硬塞进上下文」。这不是工具，是检索管道：
//   · 模型没有选择权：问「1+1 等于几」也会先搜一次，白花一次计费；
//   · 无法改写查询：多轮追问里的「它」「这个」原样发给搜索引擎，搜出来的东西自然不对；
//   · 无法深挖：看到一条有价值的链接也没法再抓它的正文；
//   · 用户看不见它搜了什么，也不知道模型到底用没用这些资料。
// 现在改为 function calling：tools 交给模型，它自己决定要不要调、用什么词、调几次、要不要抓某一页；
//   客户端只负责执行工具、把结果按 role:'tool' 回填、再问它一遍（循环见 agent-loop.js）。
//
// ===== 仍然成立的约束 =====
// 1. 工具结果**只在本次请求的 messages 里**（role:'tool'），**绝不落库、绝不进 system**。
//    落库 → 下一轮会把上次的搜索结果再发一遍（重复计费 + 污染上下文）；
//    进 system → 前缀缓存每轮全废（§4.24）。
// 2. 工具执行失败**不抛异常**：把失败原因写进 role:'tool' 的内容，让模型自己决定换词/换页/直说查不到。
//    抛异常会整轮崩掉 —— 「搜索失败」不该等于「对话失败」。
// 3. 只有一处实现。语音通话将来若要接，也必须走 WEB_TOOL_DEFS + runWebTool + agentRun。

var WS_TIMEOUT_SEARCH = 20000;   // 搜索请求超时（含建连）
var WS_TIMEOUT_FETCH = 15000;    // 单页抓取超时
var WS_PER_RESULT_CHARS = 1800;  // 单条搜索结果给模型的上限（实测模型常一次搜 2~3 组，每条都给满会撑爆上下文）
var WS_FETCH_MAX_CHARS = 8000;   // 单页正文给模型的上限（about 3k token）
// 结果卡片里点击来源链接。
// APK：**不拦截**，让 Capacitor 的 WebViewClient 接管 → 系统浏览器（项目里没有 @capacitor/browser，
//      这是唯一可靠路径；自己 window.open 在 WebView 里会被拦掉，等于点了没反应）。
// Web：拦截后新开标签页，否则当前 SPA 会被导航走。
function wsOnSourceLinkClick(e) {
  var a = e.target && e.target.closest ? e.target.closest('a.web-source-link') : null;
  if (!a) return;
  if (typeof isCapacitor === 'function' && isCapacitor()) return;
  e.preventDefault();
  try { window.open(a.getAttribute('href'), '_blank', 'noopener'); } catch (err) {}
}

// ===== 配置读取 =====
// settings.webSearch 由 db.js 的 migrateWebSearchSettings 保证字段齐全，
// 这里再兜一层：settings 尚未加载完成时（启动早期）也不能炸。
function wsCfg() {
  var w = (typeof settings !== 'undefined' && settings && settings.webSearch) || {};
  return {
    mode: w.mode === 'custom' ? 'custom' : 'inherit',
    providerId: w.providerId || '',
    baseUrl: w.baseUrl || 'https://api.deepseek.com',
    apiKey: w.apiKey || '',
    count: wsClampInt(w.count, 1, 50, 6),
    // 工具模式下只剩两档：给摘要（模型自己决定要不要再 fetch_url 抓正文）/ 直接给正文。
    //   v3.0.5 的第三档「正文+抓取」是把「该抓哪几条」写死在客户端 —— 那正是"替模型做决定"，
    //   现在这件事交给模型自己调 fetch_url。
    contentMode: (w.contentMode === 'content') ? 'content' : 'summary',
    showSources: w.showSources !== false,
    defaultOn: w.defaultOn === true
  };
}

function wsClampInt(v, min, max, fallback) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) n = fallback;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

// 会话级开关判定。只有显式 true 才算开 —— 缺字段 / null / 老数据一律按关处理
// （和 v3.0 语音总开关同一个教训：默认关之后，判定必须收紧成 === true）。
function webSearchEnabled(conv) {
  return !!(conv && conv.webSearch === true);
}

// ===== 密钥来源解析 =====
// 「复用接口管理」只认 DeepSeek 自己的接口：第三方中转站（kkaiapi / OneAPI 之类）
// 基本没有 /v1/tools/search，拿它们的 key 去搜只会得到 404，然后把「联网搜索坏了」算到我们头上。
// 所以自动挑选只从「地址含 api.deepseek.com」或「模板是 deepseek」里挑；
// 用户在设置里**显式**选了某个接口时，则尊重选择（他可能自己搭了兼容网关）。
function wsPickProvider(preferredId) {
  var list = (typeof state !== 'undefined' && state && Array.isArray(state.providers)) ? state.providers : [];
  if (!list.length) return null;
  if (preferredId) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === preferredId) return list[i];
  }
  for (var j = 0; j < list.length; j++) {
    if (list[j] && /api\.deepseek\.com/i.test(list[j].baseUrl || '')) return list[j];
  }
  for (var k = 0; k < list.length; k++) {
    if (list[k] && list[k].template === 'deepseek') return list[k];
  }
  return null;
}

// 解析出「用哪个地址、哪把 key」。返回 { ok, baseUrl, apiKey, label, reason }
// reason 是给用户看的短句，直接进 toast。
function wsResolveTarget() {
  var c = wsCfg();
  if (c.mode === 'custom') {
    var base = typeof normalizeBaseUrl === 'function' ? normalizeBaseUrl(c.baseUrl) : (c.baseUrl || '').replace(/\/+$/, '');
    if (!base) return { ok: false, reason: '联网搜索：自定义 API 地址为空' };
    if (!c.apiKey) return { ok: false, reason: '联网搜索：自定义 API 密钥为空' };
    return { ok: true, baseUrl: base, apiKey: c.apiKey, label: '自定义' };
  }
  var p = wsPickProvider(c.providerId);
  if (!p) return { ok: false, reason: '联网搜索：接口管理里没有 DeepSeek 接口，请到 设置 → 联网搜索 选择或自定义' };
  var pb = typeof normalizeBaseUrl === 'function' ? normalizeBaseUrl(p.baseUrl) : (p.baseUrl || '').replace(/\/+$/, '');
  if (!pb) return { ok: false, reason: '联网搜索：所选接口没有填 API 地址' };
  if (!p.apiKey) return { ok: false, reason: '联网搜索：所选接口「' + (p.name || 'DeepSeek') + '」没有填密钥' };
  return { ok: true, baseUrl: pb, apiKey: p.apiKey, label: p.name || 'DeepSeek' };
}

// 拼接 tools 端点。baseUrl 可能已经带了 /v1（历史迁移会把 /v1 留在地址里），
// 直接拼会变成 /v1/v1/tools/search。两个都覆盖。
function wsEndpointUrl(baseUrl, path) {
  var b = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v1$/i.test(b)) return b + path;
  return b + '/v1' + path;
}

// ===== HTTP =====
// 错误文案按官方文档的 HTTP 码映射（见 api-docs.deepseek.com/guides/search#错误）。
// 保留原始 message 拼在后面：用户要能一眼看出是密钥问题还是余额问题。
function wsHttpError(status, apiMsg) {
  var map = {
    400: '请求不合法',
    401: '密钥无效或缺失',
    402: '账户余额不足',
    403: '抓取被安全策略拒绝',
    404: '未能获取可用网页内容',
    408: '请求体读取超时',
    413: '请求体过大',
    429: '触发限速',
    500: '搜索服务内部错误',
    504: '下游请求超时'
  };
  var msg = map[status] || ('HTTP ' + status);
  if (apiMsg) msg += '：' + apiMsg;
  var err = new Error(msg);
  err.wsStatus = status;
  return err;
}

function wsPluckApiMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 200);
  if (data.error && data.error.message) return String(data.error.message).slice(0, 200);
  if (data.detail) return String(data.detail).slice(0, 200);
  return '';
}

// POST JSON。两条通道与 chat.js 的取舍一致：
//   APK 且原生 HTTP 插件可用 → 走 CapHttp（WebView 的 fetch 会被 CapacitorHttp patch，
//     但 POST 走的是 nativePromise，超时/取消都不受我们控制，所以显式接管更可控）
//   否则 → fetch（web 版；signal 直连 state.abortController，点停止能真取消）
// 返回 { data }，失败抛 Error。
async function wsPostJson(url, apiKey, body, timeoutMs) {
  var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };
  var payload = JSON.stringify(body);
  var sig = (typeof state !== 'undefined' && state && state.abortController) ? state.abortController.signal : null;
  if (sig && sig.aborted) { var ab = new Error('已取消'); ab.name = 'AbortError'; throw ab; }

  if (typeof isCapacitor === 'function' && isCapacitor() && typeof CapHttp !== 'undefined' && CapHttp) {
    var nativeP = CapHttp.request({
      method: 'POST',
      url: url,
      headers: headers,
      data: payload,
      responseType: 'json',
      connectTimeout: 15000,
      readTimeout: timeoutMs
    });
    var raced = await Promise.race([
      nativeP,
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('联网检索超时（' + Math.round(timeoutMs / 1000) + ' 秒）')); }, timeoutMs + 2000);
      })
    ]);
    var status = raced && typeof raced.status === 'number' ? raced.status : 0;
    var data = raced ? raced.data : null;
    if (status >= 400) throw wsHttpError(status, wsPluckApiMessage(data));
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { throw new Error('搜索响应解析失败'); }
    }
    return data || {};
  }

  var ctrl = null;
  var timer = null;
  var opts = { method: 'POST', headers: headers, body: payload };
  if (sig) {
    opts.signal = sig;
  } else {
    // 没有全局控制器时（理论上不会，兜底）自己计时
    ctrl = new AbortController();
    opts.signal = ctrl.signal;
  }
  timer = setTimeout(function() {
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
  }, timeoutMs);
  try {
    var resp = await fetch(url, opts);
    var text = await resp.text();
    var json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }
    if (!resp.ok) throw wsHttpError(resp.status, wsPluckApiMessage(json || text));
    if (!json) throw new Error('搜索响应解析失败');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ===== 搜索 / 抓取 =====
function wsFmtDate(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

// Search 请求。need_content 只在「正文」模式打开 —— 官方按次计费，与条数无关，
// 但正文会显著撑大上下文，所以摘要模式不要它。
async function wsSearch(query, opts) {
  opts = opts || {};
  var target = wsResolveTarget();
  if (!target.ok) throw new Error(target.reason);
  var c = wsCfg();
  var body = {
    query: String(query || '').slice(0, 128),
    count: wsClampInt(opts.count || c.count, 1, 50, 6)
  };
  // ori_question：用户原始问句，帮助搜索引擎理解指代（"它"、"这个"）。
  // 只有搜索词被系统改写（多轮追问时）才有价值；这里我们直接用原句，所以两者一致，不必重复传。
  if (opts.needContent) body.need_content = true;
  var data = await wsPostJson(wsEndpointUrl(target.baseUrl, '/tools/search'), target.apiKey, body, WS_TIMEOUT_SEARCH);
  var arr = (data && Array.isArray(data.results)) ? data.results : [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i];
    if (!r || typeof r !== 'object') continue;
    if (!r.url || !r.title) continue;
    out.push({
      idx: out.length + 1,
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.snippet || ''),
      summary: String(r.summary || ''),
      content: String(r.content || ''),
      siteName: r.site_name ? String(r.site_name) : '',
      date: wsFmtDate(r.date),
      authority: typeof r.authority === 'number' ? r.authority : -1,
      score: typeof r.rerank_score === 'number' ? r.rerank_score : 0
    });
  }
  return { results: out, target: target };
}

// Fetch 单页，返回 Markdown 正文。失败直接抛（调用方按「这一条降级」处理）。
async function wsFetchPage(url) {
  var target = wsResolveTarget();
  if (!target.ok) throw new Error(target.reason);
  var data = await wsPostJson(wsEndpointUrl(target.baseUrl, '/tools/fetch'), target.apiKey, { url: String(url).slice(0, 8192) }, WS_TIMEOUT_FETCH);
  return {
    title: (data && data.title) ? String(data.title) : '',
    content: (data && data.content) ? String(data.content) : ''
  };
}

// ===== 工具定义（交给模型的 function calling 描述）=====
// 这里是「联网搜索是一个工具」而不是「一条检索管道」的落点：
//   模型看到这两个函数的说明，自己判断这一问要不要联网、用什么词、要不要再抓某一页。
//   描述写得具体一点很关键 —— 写"搜索互联网"它会在问「你好」时也搜；
//   写清楚"只在需要实时/不确定信息时用"，它才会在常识问题上直接回答。
var WEB_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网，返回若干网页的标题、链接、摘要。适用：用户问当前或最近发生的事、你不确定或可能过时的信息、需要具体网页与数据、需要核对某事的现状。不适用：常识、推理、写作、代码等你能直接确定回答的问题 —— 那些情况不要调用。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索词，1~128 字符。支持 site:example.com、-site:example.com、-"排除短语"、"精确短语"、lang:zh,en、after:2025-01-01、before:2026 等运算符，可组合使用。'
          },
          count: {
            type: 'integer',
            description: '返回条数 1~10，默认 6。条数不影响计费，只影响本次能看到多少候选。',
            minimum: 1,
            maximum: 10
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '读取单个网页的正文（Markdown）。适用：搜索结果的摘要不足以回答、需要页面里的细节（名单/数据/公告原文/参数表）、或用户直接给了一个链接。不适用：只需要大致结论时（摘要已够，抓正文白花一次计费）。抓不到（被站点拦截、无需登录却要求登录、页面无正文）会返回错误说明。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页地址，必须是 http/https 完整 URL' }
        },
        required: ['url']
      }
    }
  }
];

// 搜索结果转成「给模型读的文本」。
// 有编号、有 URL、有站点与日期 —— 编号是为了让它能写 [1][3] 这种引用，
// 日期是为了让它自己判断"这条是三年前的旧闻"。
function wsFormatSearchResult(query, results) {
  var now = new Date();
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  var stamp = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()) + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());
  if (!results || !results.length) {
    return '搜索「' + query + '」没有返回任何结果（' + stamp + '）。可以换个说法或换用更宽泛的词再试，或者直接告诉用户没查到。';
  }
  var lines = ['搜索「' + query + '」的结果（' + results.length + ' 条，' + stamp + '）：'];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    lines.push('');
    lines.push('[' + r.idx + '] ' + r.title);
    lines.push('URL: ' + r.url);
    var meta = [];
    if (r.siteName) meta.push(r.siteName);
    if (r.date) meta.push(r.date);
    if (r.authority >= 3) meta.push('权威来源');
    if (meta.length) lines.push(meta.join(' · '));
    var body = r.content || r.summary || r.snippet || '';
    body = String(body).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (body.length > WS_PER_RESULT_CHARS) body = body.slice(0, WS_PER_RESULT_CHARS) + '…（已截断）';
    if (body) lines.push(body);
  }
  lines.push('');
  lines.push('（正文不完整的条目可以再用 fetch_url 抓取；引用时用上面的编号，链接只能用这里给出的 URL。）');
  // 这句是**约束**，不是提示：实测模型拿到检索结果后会自动"补全"细节（编出没出现过的日期/数字/公司），
  // 而它编得越像真的越危险。放在工具结果末尾（逐轮变化的文本，不进 system，前缀缓存不受影响）。
  lines.push('以上是本次工具返回的全部材料。请只基于这些材料回答；材料里没有的具体数字、日期、人名、链接不要补全或推测；');
  lines.push('如果材料不足以回答，就直说没查到或资料不足，这比编一个答案有用。');
  return lines.join('\n');
}

// 工具执行体。返回 { text, meta } —— text 会作为 role:'tool' 的内容回填给模型。
// 失败不抛异常：把失败原因写进 text，模型自己决定换词/换页/直说查不到。
//   （抛异常会让整轮对话崩掉，这比"搜索失败"严重得多。）
async function runWebTool(name, args, ctx) {
  ctx = ctx || {};
  args = args || {};
  if (name === 'web_search') {
    var q = String(args.query || '').trim().slice(0, 128);
    if (!q) return { text: '搜索失败：query 不能为空。', meta: { ok: false } };
    var cfg = wsCfg();
    var count = wsClampInt(args.count, 1, 10, cfg.count);
    var needContent = cfg.contentMode === 'content';
    try {
      var data = await wsSearch(q, { count: count, needContent: needContent });
      if (ctx.collectSources && data.results.length) ctx.collectSources(data.results);
      return {
        text: wsFormatSearchResult(q, data.results),
        meta: { ok: true, count: data.results.length, query: q, empty: !data.results.length }
      };
    } catch (e) {
      return { text: '搜索失败：' + ((e && e.message) || e), meta: { ok: false, query: q } };
    }
  }
  if (name === 'fetch_url') {
    var url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { text: '抓取失败：url 必须是 http/https 完整地址。', meta: { ok: false } };
    try {
      var page = await wsFetchPage(url);
      var body = String(page.content || '');
      if (!body.trim()) return { text: '抓取「' + url + '」没有取到正文（可能被站点拦截，或页面没有可读内容）。', meta: { ok: false, url: url } };
      if (body.length > WS_FETCH_MAX_CHARS) body = body.slice(0, WS_FETCH_MAX_CHARS) + '\n…（正文过长，已截断）';
      if (ctx.collectSources) {
        ctx.collectSources([{ idx: 1, title: page.title || url, url: url, siteName: '', date: '', authority: -1, fetched: true }]);
      }
      return {
        text: '页面标题：' + (page.title || '(无)') + '\nURL: ' + url + '\n\n' + body,
        meta: { ok: true, url: url, title: page.title || '', len: body.length }
      };
    } catch (e) {
      return { text: '抓取「' + url + '」失败：' + ((e && e.message) || e), meta: { ok: false, url: url } };
    }
  }
  return { text: '未知工具「' + name + '」。可用工具只有 web_search 与 fetch_url。', meta: { ok: false } };
}

// ===== UI：来源卡片 =====
function renderWebSearchSourcesHtml(sources) {
  if (!sources || !sources.length) return '';
  if (typeof settings !== 'undefined' && settings && settings.webSearch && settings.webSearch.showSources === false) return '';
  // 一次对话可能调好几次搜索，来源会越攒越多。卡片默认收折，但展开后也不能是一屏几百条 ——
  //   截到 12 条，标题里写清总数（"显示前 12 / 共 N 条"），用户想找的通常是前几条。
  var MAX_SHOW = 12;
  var shown = sources.slice(0, MAX_SHOW);
  var items = shown.map(function(s, i) {
    var meta = [];
    if (s.site) meta.push(escapeHtml(s.site));
    if (s.date) meta.push(escapeHtml(s.date));
    if (s.fetched) meta.push('已抓正文');
    return '<li class="web-source-item">' +
      '<a class="web-source-link" href="' + escapeHtml(s.url) + '" rel="noopener noreferrer">' +
        '<span class="web-source-idx">' + (i + 1) + '</span>' +
        '<span class="web-source-title">' + escapeHtml(s.title || s.url) + '</span>' +
      '</a>' +
      (meta.length ? '<span class="web-source-meta">' + meta.join(' · ') + '</span>' : '') +
    '</li>';
  }).join('');
  var countLabel = sources.length > shown.length
    ? ('联网来源 · 共 ' + sources.length + ' 条（显示前 ' + shown.length + '）')
    : ('联网来源 · ' + sources.length + ' 条');
  return '<details class="web-sources">' +
    '<summary class="web-sources-summary">' + countLabel + '</summary>' +
    '<ol class="web-source-list">' + items + '</ol>' +
  '</details>';
}

// ===== UI：设置面板 =====
function wsEl(id) { return document.getElementById(id); }

// 回填设置面板 + 绑定联动（只绑一次，用 dataset 标记 —— 与 applyGroupCollapseState 同思路）
function renderWebSearchSettings() {
  var c = wsCfg();
  var modeSel = wsEl('ws-mode-select');
  if (!modeSel) return;

  // 接口下拉：自动 + 接口管理里的所有接口（标明哪个是 DeepSeek 官方）
  var psel = wsEl('ws-provider-select');
  if (psel) {
    var list = (typeof state !== 'undefined' && state && Array.isArray(state.providers)) ? state.providers : [];
    var html = ['<option value="">自动（优先 DeepSeek 官方接口）</option>'];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      var tag = /api\.deepseek\.com/i.test(p.baseUrl || '') ? ' · DeepSeek' : '';
      html.push('<option value="' + escapeHtml(p.id) + '">' + escapeHtml((p.name || '未命名') + tag) + '</option>');
    }
    psel.innerHTML = html.join('');
    psel.value = c.providerId || '';
  }

  modeSel.value = c.mode;
  wsEl('ws-base-url').value = c.baseUrl || '';
  wsEl('ws-api-key').value = c.apiKey || '';
  wsEl('ws-count').value = String(c.count);
  wsEl('ws-content-mode').value = c.contentMode;
  wsEl('ws-show-sources').checked = c.showSources;
  wsEl('ws-default-on').checked = c.defaultOn;

  var chk = wsEl('websearch-toggle');
  if (chk) {
    var conv = (typeof currentConv === 'function') ? currentConv() : null;
    chk.checked = webSearchEnabled(conv);
    chk.disabled = !conv;
  }

  wsApplyModeRows();
  updateWsTargetHint();

  if (!modeSel.dataset.wsBound) {
    modeSel.dataset.wsBound = '1';
    modeSel.addEventListener('change', function() { wsApplyModeRows(); });
    var cm = wsEl('ws-content-mode');
    if (cm) cm.addEventListener('change', function() { wsApplyModeRows(); });
    var tbtn = wsEl('btn-test-web-search');
    if (tbtn) tbtn.addEventListener('click', function() { testWebSearchConnection(); });
  }
}

function wsApplyModeRows() {
  var mode = (wsEl('ws-mode-select') || {}).value || 'inherit';
  var inheritRow = wsEl('ws-provider-row');
  var inheritHint = wsEl('ws-provider-hint');
  var customRows = wsEl('ws-custom-rows');
  if (inheritRow) inheritRow.style.display = mode === 'inherit' ? '' : 'none';
  if (inheritHint) inheritHint.style.display = mode === 'inherit' ? '' : 'none';
  if (customRows) customRows.style.display = mode === 'custom' ? '' : 'none';
  updateWsTargetHint();
}

// 常驻提示：当前实际会用哪个接口 / 哪把 key（只显示名字和地址，不显示 key）。
// 这条很重要 —— 「复用」是个隐形行为，不写出来用户永远不知道它在用谁的钱。
function updateWsTargetHint() {
  var hint = wsEl('ws-target-hint');
  if (!hint) return;
  var t = wsResolveTarget();
  if (!t.ok) {
    hint.textContent = '当前不可用：' + t.reason.replace(/^联网搜索：/, '');
    hint.className = 'setting-hint ws-hint-bad';
    return;
  }
  hint.textContent = '当前使用：' + t.label + '（' + t.baseUrl + '）';
  hint.className = 'setting-hint';
}

// 保存（由 saveSettingsHandler 调用）。只读表单，不负责校验 —— 校验放在发送时，
// 因为「先填一半、点保存、以后再说」是正常用法，不该被拦住。
function saveWebSearchSettingsFromForm() {
  var modeSel = wsEl('ws-mode-select');
  if (!modeSel) return;
  if (!settings.webSearch) settings.webSearch = defaultWebSearchSettings();
  var w = settings.webSearch;
  w.mode = modeSel.value === 'custom' ? 'custom' : 'inherit';
  var psel = wsEl('ws-provider-select');
  w.providerId = psel ? (psel.value || '') : '';
  w.baseUrl = (wsEl('ws-base-url').value || '').trim() || 'https://api.deepseek.com';
  w.apiKey = (wsEl('ws-api-key').value || '').trim();
  w.count = wsClampInt(wsEl('ws-count').value, 1, 50, 6);
  var cm = wsEl('ws-content-mode').value;
  w.contentMode = (cm === 'content') ? 'content' : 'summary';
  w.showSources = wsEl('ws-show-sources').checked !== false;
  w.defaultOn = wsEl('ws-default-on').checked === true;
  // 会话级开关顺带落盘（面板里那个 checkbox 现在是**唯一**的开关入口）
  var chk = wsEl('websearch-toggle');
  var conv = (typeof currentConv === 'function') ? currentConv() : null;
  if (chk && conv) conv.webSearch = chk.checked === true;
  if (typeof save === 'function' && conv) save();
  updateWsTargetHint();
}

// 测试搜索：用当前表单里的值**直接**发一次真实请求（不要求先保存）。
// 和「接口管理」的测试连接同一个产品逻辑：改了配置先自检，别等聊天时才发现 key 错的。
async function testWebSearchConnection() {
  var box = wsEl('ws-test-result');
  if (!box) return;
  box.textContent = '检索中…';
  box.className = 'provider-test-result';
  var q = 'DeepSeek 最新消息';
  var savedCfg = settings.webSearch;
  try {
    // 临时把表单值写进 settings，让 wsResolveTarget/wsSearch 复用同一套解析逻辑
    settings.webSearch = Object.assign({}, savedCfg);
    var modeSel = wsEl('ws-mode-select');
    settings.webSearch.mode = modeSel && modeSel.value === 'custom' ? 'custom' : 'inherit';
    var psel = wsEl('ws-provider-select');
    settings.webSearch.providerId = psel ? (psel.value || '') : '';
    settings.webSearch.baseUrl = (wsEl('ws-base-url').value || '').trim() || 'https://api.deepseek.com';
    settings.webSearch.apiKey = (wsEl('ws-api-key').value || '').trim();
    var data = await wsSearch(q, { count: 3 });
    settings.webSearch = savedCfg;
    if (!data.results.length) {
      box.textContent = '搜索成功，但这条测试词没有结果（可换一条再试）';
      box.className = 'provider-test-result warn';
      return;
    }
    box.textContent = '搜索成功：' + data.results.length + ' 条，例如「' + data.results[0].title.slice(0, 30) + '」';
    box.className = 'provider-test-result success';
  } catch (e) {
    settings.webSearch = savedCfg;
    box.textContent = '搜索失败：' + ((e && e.message) || e);
    box.className = 'provider-test-result error';
  }
}
