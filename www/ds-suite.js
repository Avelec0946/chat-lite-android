// ===== ds-suite.js : DeepSeek 官方「全家桶」适配层（v3.0.17）=====
// 模块名：ds-suite.js
// 版本：v1（cache-bust）
// 新增日期：2026-11-18
//
// 背景：DeepSeek 2026-11-13 把 App 里的对话能力整体开放到了 API 上 ——
//   · 服务端联网搜索 / 深度思考搜索（tools 里声明 deepseek_web_search）
//   · 阅读链接（deepseek_read_url）
//   · 文件输入（Files API 上传 → 对话里用 file_id 引用）
//   （模型内容安全 safety_check：v3.0.18 按用户要求**整体移除**，个人自用不需要）
//   · 会话标题（title，回答时顺带生成，不额外收费）
//   · 用户元信息（latest_reminder 消息：日期 / 平台 / 语言）
//   它们和「语言模型」不是一回事：搜索与抓取由**服务端**执行，客户端只渲染返回的内容块。
//
// 与 web-search.js / agent-loop.js 的分工（别混）：
//   · 这里管**官方接口的原生扩展**：一次请求里由服务端完成多步检索，客户端不做工具循环。
//   · web-search.js + agent-loop.js 管**客户端工具循环**：给「没有全家桶接口」的模型/网关用
//     （中转站、gemini、claude…），工具由我们执行。
//   同一条消息只走其中一条：`dsServerToolsEligible()` 为真走这里，否则走那条。**不要两条一起用** ——
//   官方文档明确「声明 deepseek_web_search 时不能与其他 tools 混用」（会 400）。
//
// 依赖（均为运行时全局）：
//   providers.js  normalizeBaseUrl / modelToUpstreamId
//   app.js        state / settings / saveSettings / showToast / escapeHtml / isCapacitor / CapHttp
//   chat.js       applyStreamDelta（**不在这里调**，流式增量仍由 chat.js 的唯一入口处理）
//   auto-title.js atShouldTitle / atApply / atSanitizeModelTitle
//
// 加载顺序：web-search.js 之后、agent-loop.js 之前、chat.js 之前。

// ===== §1 识别与常量 =====

// 官方主机：api.deepseek.com（也认 platform.deepseek.com 之类同域子站，方便以后换端）。
// **只认主机名**，不认「地址里带 deepseek 字样」—— 中转站的 baseUrl 常常写成
// https://relay.example.com/deepseek，那种转发器不会实现这些扩展字段，发过去只会 400。
var DS_OFFICIAL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*deepseek\.com(?::\d+)?(?:[\/?#]|$)/i;

// ★ v3.0.18：**官方渠道按地址全量放行，不再按模型名判断**。
//   原实现把 v4-pro 排除掉了（依据是文档那句"目前 V4.1-Flash 已支持"），
//   但 2026-11-18 拿真 key 实测：deepseek-v4-pro 带 tools/title/元信息 完全正常
//   （200、有 server_tool_event、server_tool_use 计费计数、delta.title 也有）。
//   官方以后一定会推新模型，逐个适配既跟不上也没必要 —— 只要地址是官方就发。
//   万一某个模型真不收，`dsNoteNativeReject()` 会记下来，下一条自动改走本机工具循环。
var DS_NATIVE_BLOCK_TTL_MS = 24 * 3600 * 1000;

function dsIsOfficial(provider) {
  if (!provider) return false;
  return DS_OFFICIAL_RE.test(String(provider.baseUrl || ''));
}

// 「这个官方模型能不能用全家桶」。**地址已经在调用处判过了，这里只查本机记住的拒绝**。
//   留这层是因为我们不再按模型名适配（官方会一直推新模型），但也不能让某个真不支持的
//   模型每次发消息都撞一次错 —— 撞过一次就记 24 小时，期间自动走本机工具循环。
function dsModelSupportsSuite(model, provider) {
  if (provider && dsNativeBlockRec(provider, model)) return false;
  return true;
}

function dsNativeBlockKey(provider, model) {
  return String((provider && provider.id) || '') + '|' + String(model || '');
}

function dsNativeBlockRec(provider, model) {
  try {
    var store = (typeof settings !== 'undefined' && settings && settings.dsSuite) ? settings.dsSuite : null;
    if (!store || !store.nativeBlock || typeof store.nativeBlock !== 'object') return null;
    var rec = store.nativeBlock[dsNativeBlockKey(provider, model)];
    if (!rec || typeof rec.at !== 'number') return null;
    if (Date.now() - rec.at > DS_NATIVE_BLOCK_TTL_MS) return null;
    return rec;
  } catch (e) { return null; }
}

// 记一条「这个官方模型不收服务端扩展」的证据。只在「错误带状态码 + 本轮一个字都没产出」时调。
function dsNoteNativeReject(provider, model, status, evidence) {
  try {
    if (typeof settings === 'undefined' || !settings) return;
    if (!settings.dsSuite || typeof settings.dsSuite !== 'object') settings.dsSuite = dsDefaultCfg();
    var d = settings.dsSuite;
    if (!d.nativeBlock || typeof d.nativeBlock !== 'object') d.nativeBlock = {};
    d.nativeBlock[dsNativeBlockKey(provider, model)] = {
      at: Date.now(),
      status: typeof status === 'number' ? status : 0,
      evidence: String(evidence || '').slice(0, 160)
    };
    if (typeof saveSettings === 'function') saveSettings();
  } catch (e) {}
}

function dsJoinUrl(baseUrl, path) {
  var b = String(baseUrl || '').replace(/\/+$/, '');
  var p = String(path || '');
  if (!p) return b;
  if (p.charAt(0) !== '/') p = '/' + p;
  // baseUrl 里可能带 /v1（历史迁移会把版本段留在地址里），这种情况不再补一次
  if (/\/v\d+$/i.test(b)) return b + p.replace(/^\/v\d+\//i, '/');
  return b + p;
}

// ===== §2 配置 =====

function dsDefaultCfg() {
  return {
    enabled: true,          // 总开关：官方接口下启用全家桶（关掉就当普通 OpenAI 兼容接口用）
    webTools: true,         // 服务端联网搜索 + 阅读链接
    title: true,            // 让服务端顺带生成会话标题（省一次额外请求，且不额外收费）
    userMeta: true,         // latest_reminder：把本机日期 / 平台 / 语言告诉模型
    files: true,            // 附件走 Files API（PDF / Office / 图片）
    fileMode: 'text'        // 文档解析方式：text = 只取文字；rich = 图文混排（图表也交给模型，贵一些）
  };
}

// settings.dsSuite 由 db.js 的迁移保证字段齐全；这里再兜一层（启动早期 settings 可能还没加载完）
function dsCfg() {
  var raw = (typeof settings !== 'undefined' && settings && settings.dsSuite) || {};
  var def = dsDefaultCfg();
  var out = {};
  for (var k in def) {
    if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
    if (typeof def[k] === 'boolean') out[k] = (raw[k] === undefined) ? def[k] : raw[k] === true;
    else out[k] = (typeof raw[k] === 'string' && raw[k]) ? raw[k] : def[k];
  }
  return out;
}

// 这一条消息要不要走「服务端工具」那条路。
// 判据只有三条：官方接口 + 模型支持 + 总开关/联网工具开着。**联网开关本身由调用方判**（conv.webSearch）。
function dsServerToolsEligible(provider, model) {
  var c = dsCfg();
  if (!c.enabled || !c.webTools) return false;
  if (!dsIsOfficial(provider)) return false;
  return dsModelSupportsSuite(model, provider);
}

// 附件能不能走 Files API
function dsFilesEligible(provider, model) {
  var c = dsCfg();
  if (!c.enabled || !c.files) return false;
  if (!dsIsOfficial(provider)) return false;
  return dsModelSupportsSuite(model, provider);
}

// ===== §3 请求注入 =====

// 服务端工具的声明形状（Chat Completions：只写 type，没有 name）
function dsServerToolDefs() {
  return [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }];
}

// 今天是星期几（latest_reminder 的 weekday 要用中文写）
function dsWeekdayCN(d) {
  return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()] || '';
}

function dsTodayStr(d) {
  d = d || new Date();
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

// 用户元信息消息。格式是官方规定的 `<date>,<weekday>,<location>,<platform>,<language>` ——
// **必须是 5 段**，location 可以留空但**逗号不能省**（写成 4 段会被 400：
//   "latest_reminder must have at least 5 comma-separated fields, got 4"  ← 真机请求实测）。
// 所以我们固定发 `日期,星期,,App,中文`（两个连续逗号之间就是空 location）。
// 不填 location 是因为拿不到可靠的地理位置：宁可空着，也不要瞎猜一个城市让模型据此作答。
function dsReminderMessage() {
  var d = new Date();
  var platform = (typeof isCapacitor === 'function' && isCapacitor()) ? 'App' : 'Web';
  return {
    role: 'latest_reminder',
    content: dsTodayStr(d) + ',' + dsWeekdayCN(d) + ',,' + platform + ',中文'
  };
}

// 把 latest_reminder 插到「最后一条 user 之前」（官方要求紧邻，后面必须跟 user，否则 400）。
// 只插本轮这一条：历史轮次的都插会让每次请求的前缀随历史长度变化，缓存反而更差；
// 官方也说「不回传也可以，只是缓存命中低一点」。
function dsInjectReminder(messages) {
  var out = (messages || []).slice();
  if (!dsCfg().userMeta) return out;
  var idx = -1;
  for (var i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0) return out;
  // 已经有一条就不要再插（重复插入会被上游判成不合法的序列）
  if (idx > 0 && out[idx - 1] && out[idx - 1].role === 'latest_reminder') return out;
  out.splice(idx, 0, dsReminderMessage());
  return out;
}

// 往请求体里注入扩展字段。o = { webSearch, title, provider, model }
// 返回注入后的 payload（原地改，调用方拿到的就是最终体）。
function dsEnrichPayload(payload, o) {
  o = o || {};
  var c = dsCfg();
  if (!c.enabled) return payload;
  var provider = o.provider || null;
  var model = o.model || '';
  if (!dsIsOfficial(provider) || !dsModelSupportsSuite(model, provider)) return payload;

  if (o.webSearch && c.webTools) {
    payload.tools = dsServerToolDefs();
    // 故意不传 tool_choice：官方对这两个工具不接受强制指定（传 required 会被当成 auto）
  }
  if (o.title && c.title) {
    payload.title = { enabled: true };
  }
  return payload;
}

// 会话标题要不要在这次请求里要：只在「新建会话的第一轮、还没定过名」时要。
// 判定直接复用 auto-title.js 的 atShouldTitle（唯一一处判定），再排掉已经完成的。
function dsWantTitle(conv) {
  if (!dsCfg().enabled || !dsCfg().title) return false;
  if (typeof atShouldTitle !== 'function') return false;
  try {
    if (!atShouldTitle(conv)) return false;
  } catch (e) { return false; }
  if (conv.titleAuto && conv.titleAuto.done) return false;
  return true;
}

// 服务端给了标题 → 写回。走 auto-title 的 atApply / 清洗，语义与模型命名完全一致
// （不覆盖手改、只在会话还活着时写、侧栏正在改名就不重建）。
function dsApplyTitle(conv, rawTitle) {
  if (!conv || !rawTitle) return false;
  if (typeof atSanitizeModelTitle !== 'function' || typeof atApply !== 'function') return false;
  var t = atSanitizeModelTitle(rawTitle);
  if (!t) return false;
  if (conv.titleSetByUser) return false;
  var prev = conv.titleAuto || {};
  conv.titleAuto = { placeholderAt: prev.placeholderAt || 0, done: true, stage: 'server', at: Date.now() };
  try { if (typeof save === 'function') save(); } catch (e) {}
  atApply(conv, t);
  return true;
}

// ===== §4 流式解析 =====
//
// 一次响应里可能出现的东西（Chat Completions）：
//   choice.server_tool_event   —— 与 delta 并列，一个 chunk 最多一个事件
//       step_reasoning_done {step}
//       call_started {step, call}   call 带完整 action（queries / url / pattern）
//       call_completed {step, call} call 带 status 与 sources / page / error（不带 signature）
//   choice.delta.title / annotations / server_tool_calls —— 只在最后那个 chunk 里发一次
//
// 我们把它翻成两样**已有界面的东西**（不新增一套 UI）：
//   · trace  —— 与 agentTraceHtml 同形状，气泡里那行「已调用 N 个工具」的步骤清单
//   · sources —— 与 renderWebSearchSourcesHtml 同形状，回复下面那张收折的来源卡片
function dsNewTurn() {
  return {
    trace: [],
    sources: [],
    annotations: [],
    calls: [],
    title: '',
    byId: {},
    lastPaint: 0
  };
}

function dsCallLabel(kind, actionType) {
  if (kind === 'image_search' || kind === 'deep_image_search') return '图片搜索';
  if (actionType === 'open_page') return '打开网页';
  if (actionType === 'find_in_page') return '页内查找';
  if (kind === 'read_link') return '阅读链接';
  if (kind === 'deep_search') return '深度搜索';
  return '搜索';
}

function dsCallArgText(call) {
  var a = (call && call.action) || {};
  if (a.queries && a.queries.length) return '「' + a.queries.join('」「') + '」';
  if (a.pattern) return '「' + a.pattern + '」';
  if (a.url) return String(a.url);
  if (call && call.page && call.page.url) return String(call.page.url);
  return '';
}

// 结果里能拿出多少条来源。搜索给 sources[]，打开网页/阅读链接给 page 单个。
function dsSourcesOfCall(call) {
  var out = [];
  if (!call) return out;
  var srcs = call.sources || (call.content && call.content.sources) || null;
  if (Array.isArray(srcs)) {
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i] || {};
      if (!s.url) continue;
      out.push({
        title: s.title || s.url,
        url: String(s.url),
        site: s.site_name || '',
        date: dsFmtDate(s.published_at),
        fetched: false
      });
    }
  }
  if (call.page && call.page.url) {
    out.push({
      title: call.page.title || call.page.url,
      url: String(call.page.url),
      site: '',
      date: dsFmtDate(call.page.published_at),
      fetched: true
    });
  }
  return out;
}

function dsFmtDate(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) {
    // 官方对 read_link 的 published_at 明确写了「格式不固定」，拿不到标准日期就原样展示
    return String(s).slice(0, 10);
  }
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function dsPushSources(st, list) {
  for (var i = 0; i < (list || []).length; i++) {
    var s = list[i];
    if (!s || !s.url) continue;
    var dup = false;
    for (var j = 0; j < st.sources.length; j++) {
      if (st.sources[j].url === s.url) { dup = true; break; }
    }
    if (!dup) st.sources.push(s);
  }
}

// 应用一个 server_tool_event
function dsApplyCallEvent(ev, st) {
  if (!ev || !ev.type || !st) return false;
  if (ev.type === 'step_reasoning_done') return false;
  var call = ev.call || null;
  if (!call) return false;
  var id = call.id || ('ds_' + st.trace.length);
  var actionType = (call.action && call.action.type) || '';
  var label = dsCallLabel(call.kind || '', actionType);
  var argText = dsCallArgText(call);
  var item = st.byId[id];

  if (ev.type === 'call_started') {
    if (item) return false;
    item = { name: 'web_search', label: label, argText: argText, args: {}, status: 'running' };
    st.byId[id] = item;
    st.trace.push(item);
    return true;
  }
  if (ev.type === 'call_completed') {
    if (!item) {
      item = { name: 'web_search', label: label, argText: argText, args: {}, status: 'running' };
      st.byId[id] = item;
      st.trace.push(item);
    }
    var failed = (call.status === 'failed' || call.error);
    item.status = failed ? 'error' : 'ok';
    if (failed) {
      var code = (call.error && call.error.code) || (call.error && call.error.error_code) || '';
      item.summary = code ? ('失败 ' + code) : '失败';
    } else {
      var n = dsSourcesOfCall(call).length;
      if (actionType === 'find_in_page') item.summary = call.page ? '找到了' : '未命中';
      else if (n) item.summary = label === '搜索' || label === '图片搜索' || label === '深度搜索' ? (n + ' 条') : '已读';
      else item.summary = '完成';
    }
    dsPushSources(st, dsSourcesOfCall(call));
    return true;
  }
  return false;
}

// 从「完整 server_tool_calls」补全 trace / sources（非流式兜底、或落库后回看）。
function dsAbsorbCalls(calls, st) {
  if (!Array.isArray(calls)) return;
  st.calls = calls;
  for (var i = 0; i < calls.length; i++) {
    var step = calls[i] || {};
    var arr = step.calls || [];
    for (var j = 0; j < arr.length; j++) {
      var c = arr[j];
      if (!c) continue;
      dsApplyCallEvent({ type: 'call_started', step: step.index, call: c }, st);
      dsApplyCallEvent({ type: 'call_completed', step: step.index, call: c }, st);
    }
  }
}

// 每读到一个 SSE 事件就喂进来。返回 true = trace 有新变化（调用方负责重绘）。
function dsConsumeChoice(choice, st) {
  if (!choice || !st) return false;
  var changed = false;
  if (choice.server_tool_event) {
    changed = dsApplyCallEvent(choice.server_tool_event, st) || changed;
  }
  var delta = choice.delta;
  if (delta) {
    if (typeof delta.title === 'string' && delta.title) st.title = delta.title;
    if (Array.isArray(delta.annotations) && delta.annotations.length) st.annotations = delta.annotations;
    if (Array.isArray(delta.server_tool_calls) && delta.server_tool_calls.length) {
      dsAbsorbCalls(delta.server_tool_calls, st);
      changed = true;
    }
  }
  // 非流式（或网关整段返回）时这些挂在 message 上
  var msg = choice.message;
  if (msg) {
    if (typeof msg.title === 'string' && msg.title) st.title = msg.title;
    if (Array.isArray(msg.annotations) && msg.annotations.length) st.annotations = msg.annotations;
    if (Array.isArray(msg.server_tool_calls) && msg.server_tool_calls.length) {
      dsAbsorbCalls(msg.server_tool_calls, st);
      changed = true;
    }
  }
  return changed;
}

// 收尾：把 trace / sources / 引用写进 assistantMsg（与客户端工具循环落的是同一组字段，
// conversation.js 的渲染代码一行不用改）。
function dsFinalize(assistantMsg, st, content) {
  if (!assistantMsg || !st) return;
  for (var i = 0; i < st.trace.length; i++) {
    if (st.trace[i].status === 'running') st.trace[i].status = 'ok';
  }
  if (st.trace.length) assistantMsg.toolTrace = st.trace;
  if (st.sources.length) assistantMsg.webSources = st.sources;
  var cites = dsCitations(st.annotations, content);
  if (cites.length) assistantMsg.citations = cites;
  // 回传用：只留「能还原上下文」的最小集合。
  //   搜索结果（sources 那些 snippet）官方明确不进后续上下文，回传也没用，全丢；
  //   读过的网页靠 signature 还原，那个要留 —— 但它是整页加密正文，可能几十 KB，
  //   所以设总量上限：超过就整体不回传（网页不进上下文，但请求照常成功）。
  var keep = [];
  var totalSign = 0;
  for (var k = 0; k < (st.calls || []).length; k++) {
    var step = st.calls[k] || {};
    var arr = (step.calls || []).filter(function(c) {
      return c && (c.signature || (c.page && c.page.url && (c.kind === 'read_link' || c.action && c.action.type === 'open_page')));
    });
    if (!arr.length) continue;
    var slim = arr.map(function(c) {
      return {
        index: c.index,
        id: c.id,
        type: c.type,
        kind: c.kind,
        action: c.action,
        status: c.status || 'completed',
        page: c.page || null,
        signature: c.signature || ''
      };
    });
    for (var m = 0; m < slim.length; m++) totalSign += String(slim[m].signature || '').length;
    keep.push({ index: step.index, reasoning_content: '', calls: slim });
  }
  if (keep.length && totalSign <= DS_SIGNATURE_BUDGET) assistantMsg.serverToolCalls = keep;
}

var DS_SIGNATURE_BUDGET = 16000;   // 单条消息里 signature 的总字符上限（≈16KB，够 1~3 个网页）

// 消息 → 下一轮请求里的 assistant 消息体（原样回传 server_tool_calls，模型才能续上读过的网页）
function dsAssistantEcho(msg) {
  if (!msg || !msg.serverToolCalls || !msg.serverToolCalls.length) return null;
  return { role: 'assistant', content: msg.content || '', server_tool_calls: msg.serverToolCalls };
}

// ===== §5 引用角标 =====
//
// 官方把引用放在 `annotations[]`（url_citation），start_index / end_index 按 **Unicode 码点**计。
// JS 的字符串下标是 UTF-16 码元 —— 中文同宽，但 emoji / 生僻字是 2 个码元，直接拿下标去切会错位。
function dsCpToIdx(s, cp) {
  if (!(cp > 0)) return 0;
  var str = String(s || '');
  var n = 0, i = 0;
  while (i < str.length && n < cp) {
    var code = str.codePointAt ? str.codePointAt(i) : str.charCodeAt(i);
    i += (code > 0xFFFF) ? 2 : 1;
    n++;
  }
  return i;
}

// annotations → [{url,title,start,end,ref}]（ref 是正文里的上标编号，按 URL 首次出现顺序编号，
// 与来源卡片里的序号一致 —— 卡片和角标指的是同一篇，编号必须相同，否则用户没法对照）
function dsCitations(annotations, content) {
  var out = [];
  var byUrl = {};
  var n = 0;
  var text = String(content || '');
  for (var i = 0; i < (annotations || []).length; i++) {
    var a = annotations[i] || {};
    var c = (a.type === 'url_citation' && a.url_citation) ? a.url_citation : a;
    if (!c || !c.url) continue;
    var url = String(c.url);
    if (!byUrl[url]) { n++; byUrl[url] = n; }
    var start = dsCpToIdx(text, typeof c.start_index === 'number' ? c.start_index : 0);
    var end = dsCpToIdx(text, typeof c.end_index === 'number' ? c.end_index : 0);
    if (end < start) { var t = start; start = end; end = t; }
    out.push({ url: url, title: c.title || '', start: start, end: end, ref: byUrl[url] });
  }
  return out;
}

// 某个位置是不是在代码块里（奇数个 ``` 之前 = 在里面）。
// 角标插进代码块会把代码弄坏 —— 那比"少一个角标"严重得多，所以宁可不插。
function dsInCodeBlock(text, pos) {
  var head = String(text || '').slice(0, pos);
  var fence = head.split('```').length - 1;
  return (fence % 2) === 1;
}

// 在正文里插上标。**从后往前插**，否则前面的插入会把后面的下标推歪。
// 返回插好标记的字符串；没插成的地方保持原样。
function dsInjectCiteMarkers(content, citations) {
  var text = String(content || '');
  if (!text || !citations || !citations.length) return text;
  var list = citations.slice().sort(function(a, b) { return b.end - a.end; });
  var inserted = 0;
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var pos = c.end;
    if (pos <= 0 || pos > text.length) continue;
    if (dsInCodeBlock(text, pos)) continue;
    var href = String(c.url).replace(/"/g, '%22');
    var title = String(c.title || c.url).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    var tag = '<sup class="cite-ref"><a href="' + href + '" title="' + title + '" rel="noopener noreferrer">' + c.ref + '</a></sup>';
    text = text.slice(0, pos) + tag + text.slice(pos);
    inserted++;
  }
  return inserted ? text : content;
}

// ===== §6 Files API =====
//
// 为什么值得走 Files API（而不是像现在这样把 base64 塞进 content）：
//   · PDF / Word / PPT / Excel 现在**根本读不了**（只支持文本），上传解析后模型能直接读；
//   · 同一张图/同一份文档在每一轮都被重新发一遍 base64，请求体会越来越大（上限 48 MiB），
//     换成 file_id 之后第二轮开始只发一个字符串。
//
// 上传在「选完附件」时就开始（不阻塞发送）：解析是上游做的，100 页 PDF 要几十秒，
// 等用户点发送再解析，那几十秒全砸在「已发送 → 还没回复」的空窗里。

// 二进制文档（需要上游解析的）扩展名
var DS_DOC_EXT_RE = /\.(pdf|docx?|pptx?|bmp|tiff?|gif|png|jpe?g|webp)$/i;
// 以 user_data 上传即可（上游自动转 Markdown / 直接收图），不花解析费
var DS_USERDATA_EXT_RE = /\.(txt|md|markdown|csv|json|xml|html?|js|ts|py|java|c|h|cpp|go|rs|sh|ya?ml|log|sql|xlsx?|epub|mobi)$/i;

function dsPurposeFor(file, mode) {
  var name = String((file && file.name) || '');
  var isImg = !!(file && file.isImage);
  if (isImg) return 'user_data';
  if (DS_USERDATA_EXT_RE.test(name)) return 'user_data';
  if (!DS_DOC_EXT_RE.test(name)) return 'user_data';   // 认不出来就按普通文件传，让上游判
  // PDF / Word / PPT 与扫描图片：文字模式更便宜；图文混排会把图裁出来一起进上下文
  if (/\.(pdf|docx?|pptx?)$/i.test(name) || /\.(bmp|tiff?)$/i.test(name)) {
    return (mode === 'rich') ? 'rich_layout_recognition' : 'text_recognition';
  }
  return 'user_data';
}

function dsB64ToBytes(b64) {
  try {
    var bin = atob(String(b64 || ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return new Uint8Array(0); }
}

function dsBytesToB64(bytes) {
  var arr = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || []);
  var CH = 0x8000;
  var out = '';
  for (var i = 0; i < arr.length; i += CH) {
    out += String.fromCharCode.apply(null, arr.subarray(i, i + CH));
  }
  return btoa(out);
}

function dsFileNameOf(file) {
  var n = String((file && file.name) || 'file');
  return n.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'file';
}

function dsMimeOf(file) {
  if (file && file.mimeType) return file.mimeType;
  if (file && file.type) return file.type;
  var n = String((file && file.name) || '').toLowerCase();
  if (/\.pdf$/.test(n)) return 'application/pdf';
  if (/\.docx?$/.test(n)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.pptx?$/.test(n)) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (/\.xlsx?$/.test(n)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.png$/.test(n)) return 'image/png';
  return 'application/octet-stream';
}

function dsHttpErr(status, body) {
  var map = {
    400: '文件无法解析或格式不支持',
    401: '密钥无效或缺失',
    402: '账户余额不足',
    408: '上传超时',
    413: '文件过大',
    429: '并发上传数超限（稍后重试）',
    500: '解析结果不完整',
    503: '服务繁忙',
    504: '解析超过时限'
  };
  var msg = map[status] || ('HTTP ' + status);
  var inner = '';
  try {
    var j = (typeof body === 'string') ? JSON.parse(body) : body;
    inner = (j && j.error && (j.error.message || j.error)) || (j && j.message) || '';
  } catch (e) { inner = ''; }
  if (inner && typeof inner === 'string') msg += '：' + inner.slice(0, 160);
  var err = new Error(msg);
  err.dsStatus = status;
  return err;
}

// multipart 上传的**唯一实现**（语音识别 /v1/tools/asr 也用它 —— 同为「一个文件 + 几个表单字段」，
// 写两份必然分叉：原生那条路的 boundary 拼法、base64File 的键名都是踩过一次才知道的）。
// parts = [{key, value, fileName?, contentType?}]；有 fileName 的按文件发，否则按普通字段。
// 返回解析后的 JSON 对象；失败抛 Error。
async function dsPostMultipart(baseUrl, apiKey, path, parts, opts) {
  opts = opts || {};
  var base = String(baseUrl || '').replace(/\/+$/, '');
  var key = String(apiKey || '');
  if (!base) throw new Error('接口地址为空');
  if (!key) throw new Error('密钥为空');
  var url = dsJoinUrl(base, path);
  var readMs = opts.readTimeoutMs || 120000;
  var list = parts || [];

  if (typeof isCapacitor === 'function' && isCapacitor() && typeof CapHttp !== 'undefined' && CapHttp) {
    // 原生 CapacitorHttp 的 formData 形态（base64File）：JS 侧的 FormData 过不了桥，
    // 而它的 dataType='formData' 分支会按 boundary 自己拼 multipart，二进制不经过 UTF-8 转码。
    var boundary = '----chatlite' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
    var data = list.map(function(p) {
      if (p.fileName) {
        return {
          type: 'base64File', key: p.key, value: String(p.value || ''),
          fileName: p.fileName, contentType: p.contentType || 'application/octet-stream'
        };
      }
      return { type: 'string', key: p.key, value: String(p.value == null ? '' : p.value) };
    });
    var res = await CapHttp.request({
      method: 'POST',
      url: url,
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Authorization': 'Bearer ' + key
      },
      data: data,
      dataType: 'formData',
      // OCR 的响应在结果之前会持续发换行符保活（官方文档明说），原生按 json 直接解析会失败，
      // 所以 OCR 那条传 text，回来自己 trim 再 JSON.parse。
      responseType: opts.responseType === 'text' ? 'text' : 'json',
      connectTimeout: 20000,
      readTimeout: readMs
    });
    var st = res && typeof res.status === 'number' ? res.status : 0;
    var body = res && res.data;
    if (typeof body === 'string') { try { body = JSON.parse(body.trim()); } catch (e) {} }
    if (st >= 400) throw dsHttpErr(st, body);
    return body || {};
  }

  // Web：浏览器原生 FormData（base64 → Blob，不经 CapacitorHttp 的 patch）
  var form = new FormData();
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (p.fileName) {
      var bytes = dsB64ToBytes(p.value);
      try {
        form.append(p.key, new Blob([bytes], { type: p.contentType || 'application/octet-stream' }), p.fileName);
      } catch (e) {
        form.append(p.key, new Blob([bytes]), p.fileName);
      }
    } else {
      form.append(p.key, String(p.value == null ? '' : p.value));
    }
  }
  var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = setTimeout(function() { try { if (ctrl) ctrl.abort(); } catch (e) {} }, readMs);
  try {
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
      body: form,
      signal: ctrl ? ctrl.signal : undefined
    });
    var txt = await resp.text();
    var json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!resp.ok) throw dsHttpErr(resp.status, json || txt);
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

// 上传一份文件到 Files API。返回 { fileId, purpose }；失败抛 Error（调用方降级为内联 / 提示）。
// file = { name, base64, mimeType, isImage, size }
async function dsUploadFile(provider, file, opts) {
  opts = opts || {};
  var b64 = String((file && file.base64) || '');
  if (!b64) throw new Error('文件内容为空');
  var purpose = dsPurposeFor(file, dsCfg().fileMode);
  // 解析在上游进行、拿到响应才返回：文档最长 120 秒解析 + 120 秒上传，
  // 读超时必须按这个量级给，否则 100 页 PDF 会在本地先超时。
  var readMs = (purpose === 'user_data') ? 120000 : 260000;
  var data = await dsPostMultipart(
    provider && provider.baseUrl,
    provider && provider.apiKey,
    '/files',
    [
      { key: 'purpose', value: purpose },   // purpose 必须排在 file 之前（官方明确要求）
      { key: 'file', value: b64, fileName: dsFileNameOf(file), contentType: dsMimeOf(file) }
    ],
    { readTimeoutMs: (opts.readTimeoutMs || readMs) }
  );
  if (!data.id) throw new Error('上传返回里没有 file_id');
  return { fileId: String(data.id), purpose: purpose };
}

// ===== §6b 文档解析（跨渠道：官方 OCR → 文本）=====
//
// 为什么需要它：`file_id` 是 DeepSeek 账号范围内的存储凭证，换个模型提供方不认。
//   但"把 PDF 变成文字"跟最后用哪个模型回答毫无关系 —— 所以对非官方渠道，
//   我们用官方 OCR 接口把文件解析成文本，再把文本当普通上下文发过去。
//   质量与官方一致（同一套解析引擎，扫描件也能认），代价是丢掉"图文混排"里的图。
//
// 实测（2026-11-18，kkaiapi）：中转站既没有 /files 也没有 /v1/tools/ocr（都是 404），
//   所以解析必须用**官方 key**，与当前会话用哪家模型无关。

// 逐页识别结果里带 `<ref>标题</ref><box>[[52,40,948,96]]</box>` 这类标记（坐标归一化到 0-1000）。
// 喂给模型前必须清掉，否则全是噪音。
function dsStripOcrMarkup(text) {
  return String(text || '')
    // 只认官方那种**全角竖线**包裹的标记 `<｜ref｜>…<｜/ref｜>`；不用宽松的 `<...ref...>` ——
    //   那会把正文里真正出现的 <box> / <reference> 也吃掉（文档里写代码时很常见）。
    .replace(/<｜[^｜<>]{1,12}｜>/g, '')
    .replace(/\[\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 单份文档喂给模型的字符上限。超了按页截断并如实标注 —— 悄悄截断比报错更坏。
var DS_OCR_MAX_CHARS = 120000;

// file = { name, base64, mimeType, size }；返回 { text, pageCount, truncated, purpose }
async function dsOcrFile(provider, file, opts) {
  opts = opts || {};
  var b64 = String((file && file.base64) || '');
  if (!b64) throw new Error('文件内容为空');
  if (!provider || !provider.baseUrl || !provider.apiKey) {
    throw new Error('没有可用的 DeepSeek 官方接口（文档解析要用它的 OCR）');
  }
  var purpose = (opts.mode === 'rich' || dsCfg().fileMode === 'rich') ? 'rich_layout_recognition' : 'text_recognition';
  // 官方：100 MiB / 1000 页 / 上传 120s / 总时长 180s → 读超时按总时长 + 余量
  var data = await dsPostMultipart(
    provider.baseUrl, provider.apiKey, '/v1/tools/ocr',
    [
      { key: 'purpose', value: purpose },
      { key: 'file', value: b64, fileName: dsFileNameOf(file), contentType: dsMimeOf(file) }
    ],
    { readTimeoutMs: opts.readTimeoutMs || 200000, responseType: 'text' }
  );
  // 识别开始后状态码就是 200，失败是以 {error} 正文返回的 —— 必须查 body
  if (data && data.error) {
    throw new Error('解析失败：' + ((data.error && data.error.message) || '未知错误'));
  }
  var pages = Array.isArray(data && data.pages) ? data.pages : [];
  var out = [];
  var total = 0;
  var truncated = false;
  for (var i = 0; i < pages.length; i++) {
    var t = dsStripOcrMarkup(pages[i] && pages[i].text);
    if (!t) continue;
    if (total + t.length > DS_OCR_MAX_CHARS) {
      var room = Math.max(0, DS_OCR_MAX_CHARS - total);
      if (room > 200) out.push(t.slice(0, room) + '…（本页余下内容已截断）');
      truncated = true;
      break;
    }
    out.push(t);
    total += t.length;
  }
  return {
    text: out.join('\n\n'),
    pageCount: pages.length || Number(data && data.page_count) || 0,
    truncated: truncated,
    purpose: purpose
  };
}

// 把正文里的 [n] 变成上标角标（**非官方渠道的引用方案**）。
//   只给「本轮有来源卡片」的回答用：用户自己在正文里写 [1]（文献引用、脚注）不该被改写，
//   而那些消息没有 webSources，天然被排除。
// 输入是 **markdown 源码**（渲染前），所以只能插 HTML、不能转义正文 —— 转义会把 **粗体** 变成字面星号。
function dsLinkBracketCitations(content, sources) {
  var text = String(content || '');
  if (!text || !sources || !sources.length) return text;
  var n = sources.length;
  var out = '';
  var i = 0;
  var re = /\[(\d{1,2})\]/g;
  var m;
  var hit = 0;
  while ((m = re.exec(text)) !== null) {
    var idx = parseInt(m[1], 10);
    if (!(idx >= 1 && idx <= n)) continue;
    var pos = m.index;
    if (dsInCodeBlock(text, pos)) continue;
    var src = sources[idx - 1] || {};
    var href = String(src.url || '').replace(/"/g, '%22');
    if (!href) continue;
    var title = String(src.title || src.url || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    out += text.slice(i, pos) +
      '<sup class="cite-ref"><a href="' + href + '" title="' + title + '" rel="noopener noreferrer">' + idx + '</a></sup>';
    i = pos + m[0].length;
    hit++;
  }
  if (!hit) return text;
  return out + text.slice(i);
}

// 附件 → 对话请求里的内容块
function dsFileBlock(fileId) {
  return { type: 'file', file_id: String(fileId) };
}

// 上传时用的密钥指纹（djb2 → base36，6 位）。
// 为什么需要：`file_id` **归属于上传它的账号**。用户把备份恢复到另一个 DeepSeek 账号上时，
//   历史消息里那些 file_id 会直接 400（整个请求失败、会话卡死）。带上指纹之后，
//   密钥换了就自动不用那些 file_id：图片回落到内联 base64（本来就存着），
//   二进制文档退化成一句「未能上传解析」—— 降级，但绝不会把整轮打死。
// 只存 6 位哈希，不是密钥本身。
function dsKeyTag(apiKey) {
  var s = String(apiKey || '');
  if (!s) return '';
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(-6);
}

// 这条消息里的 file_id 现在还能不能用（同一把密钥上传的才算数）
function dsFileIdUsable(file, tag) {
  if (!file || !file.dsFileId) return false;
  if (!file.dsKeyTag || !tag) return true;    // 老数据 / 没记录：按可用处理（那时候也没别的选择）
  return file.dsKeyTag === tag;
}

// ===== §7 设置面板 =====

// 面板上**只放开关，不放能力清单**：能力是否生效由"当前接口是不是官方"决定，
// 列一堆灰掉的选项只会让人以为是自己没配对。
function dsEl(id) { return document.getElementById(id); }

function renderDsSuiteSettings() {
  var c = dsCfg();
  var set = function(id, on) { var el = dsEl(id); if (el) el.checked = on === true; };
  set('ds-enabled', c.enabled);
  set('ds-web-tools', c.webTools);
  set('ds-title', c.title);
  set('ds-user-meta', c.userMeta);
  set('ds-files', c.files);
  var mode = dsEl('ds-file-mode');
  if (mode) mode.value = c.fileMode === 'rich' ? 'rich' : 'text';

  var hint = dsEl('ds-suite-state');
  if (!hint) return;
  var conv = (typeof currentConv === 'function') ? currentConv() : null;
  var pv = (conv && typeof getProvider === 'function') ? getProvider(conv.providerId) : null;
  var model = conv ? String(conv.model || '') : '';
  if (!pv) {
    hint.textContent = '当前没有选中接口。';
    hint.className = 'setting-hint ds-hint-bad';
    return;
  }
  var official = dsIsOfficial(pv);
  if (official) {
    // 官方渠道**按地址**全量放行：不列模型白名单（官方一直在推新模型）。
    //   只把「本机记住的拒绝」说出来，否则用户会以为开关坏了。
    var blocked = (typeof dsNativeBlockRec === 'function') ? dsNativeBlockRec(pv, model) : null;
    if (blocked) {
      hint.textContent = '当前会话：' + (pv.name || 'DeepSeek') + ' · ' + model +
        ' —— 这个模型上次拒了带工具/标题的请求（HTTP ' + (blocked.status || '?') + '），已自动改走本机工具循环；切换模型或 24 小时后会自动再试。';
      hint.className = 'setting-hint ds-hint-bad';
      return;
    }
    hint.textContent = '当前会话：' + (pv.name || 'DeepSeek') + ' · ' + model + ' —— 全家桶可用（服务端联网 / 标题 / 文件输入）。';
    hint.className = 'setting-hint';
  } else {
    hint.textContent = '当前会话用的不是 DeepSeek 官方接口（' + (pv.name || pv.id) + '），以下开关不生效；联网会继续走本机的工具循环。';
    hint.className = 'setting-hint ds-hint-bad';
  }
}

function saveDsSuiteSettingsFromForm() {
  if (typeof settings === 'undefined' || !settings) return;
  if (!settings.dsSuite || typeof settings.dsSuite !== 'object') settings.dsSuite = dsDefaultCfg();
  var d = settings.dsSuite;
  var get = function(id, def) { var el = dsEl(id); return el ? (el.checked === true) : def; };
  if (dsEl('ds-enabled')) d.enabled = get('ds-enabled', true);
  if (dsEl('ds-web-tools')) d.webTools = get('ds-web-tools', true);
  if (dsEl('ds-title')) d.title = get('ds-title', true);
  if (dsEl('ds-user-meta')) d.userMeta = get('ds-user-meta', true);
  if (dsEl('ds-files')) d.files = get('ds-files', true);
  var mode = dsEl('ds-file-mode');
  if (mode) d.fileMode = mode.value === 'rich' ? 'rich' : 'text';
}
