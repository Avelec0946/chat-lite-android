// ===== 会话标题自动命名（v3.0.7）=====
//
// 用户诉求（2026-10-28）：「新会话能够根据第一条消息自动命名」。
//
// 改之前的现状：app.js newChat() 写死 conv.title = '对话 N'，
//   之后只能长按标题改名 —— 侧栏几十个会话全是「对话 12 / 对话 13」，只能点开认。
//   而且侧栏搜索是按 title 过滤的（conversation.js renderSidebar），标题没内容 = 搜索不可用。
//
// ★ 三条约定，动这个模块前先读：
//
// 1. **两段式，永远不留「对话 N」**：第一条用户消息落库后，先立刻用「截断式」把标题换成真内容
//    （零请求、零延迟、离线可用），紧接着异步问一次模型要个更贴的短标题，回来再覆盖。
//    模型慢 / 超时 / 报错 / 关掉开关 → 就停在截断式，**不回退**到「对话 N」。
//    为什么不"等模型回来再改"：模型动不动十几秒，那十几秒里用户看到的还是「对话 3」，
//    而截断式那 16 个字 99% 情况下已经够认了。
//
// 2. **只做一次，且绝不覆盖用户手改**：conv.titleAuto.done 落库防重复；
//    用户长按改名会置 conv.titleSetByUser = true（conversation.js），之后任何自动命名一律跳过，
//    生成途中被改名也直接丢弃结果。**别再加第二个判定条件**（比如"title 是否还是对话 N"还没被改），
//    两个判据必然有一天对不上。
//
// 3. **只有一处实现**：文本发送 / 语音通话 / 以后任何"新会话第一条消息"都必须调 maybeAutoTitle(conv)。
//    不要在 chat.js、voice.js 各写一份（看板 §4.24：同语义两处实现必然分叉）。
//    注意 voice.js 里的 msg.title = content.substring(0,24) 是**分支节点标题**，与会话名无关。
//
// 依赖（均为全局）：currentConv / getProvider / buildUpstreamPayload / isCapacitor /
//   settings / state / save / renderSidebar / escapeHtml

// 模型那一次请求的超时。故意比聊天短：标题迟到就没有价值了。
var AT_MODEL_TIMEOUT_MS = 10000;
// 标题字数上限（按 Unicode 码点算，一个汉字 = 1）
var AT_TITLE_MAX = 16;
// 送给模型的原文上限，避免第一条就甩上来一整篇长文
var AT_MODEL_INPUT_MAX = 600;

function atCfg() {
  var t = (typeof settings !== 'undefined' && settings && settings.autoTitle) || {};
  return { enabled: t.enabled !== false };   // 默认开
}

function atChars(s) {
  return Array.from ? Array.from(String(s || '')) : String(s || '').split('');
}

// 附件兜底文本。**别送去问模型**：模型看到的就是「图片对话」这四个字，
//   它能给出的最好结果也就是把四个字改写一遍 —— 白花一次请求，还可能改得更差。
var AT_FALLBACK_IMAGE = '图片对话';
var AT_FALLBACK_FILE = '文件对话';

// 从一条消息里取"可读文本"。只有附件没有正文时给一个人话兜底 ——
//   返回空串会让整个自动命名静默失效（用户发了图，会话就永远叫「对话 5」）。
function atTextOf(msg) {
  if (!msg) return '';
  var raw = String(msg.content || '');
  // 状态栏注入的伪 user（buildContext 拼的「【格式要求】…」）不是人写的，别拿它命名
  if (/^【格式要求】/.test(raw.trim())) return '';
  var txt = raw.trim();
  var files = msg.files || [];
  if (txt) return txt;
  if (!files.length) return '';
  var imgN = files.filter(function(f) { return f && f.isImage; }).length;
  if (imgN) return AT_FALLBACK_IMAGE;
  return files[0] && files[0].name ? files[0].name : AT_FALLBACK_FILE;
}

// 首轮判定：activePath 里用户消息恰好一条。
//   用 activePath 而不是"总消息数"：分支会话里回退到别的分支时，activePath 才是"这个会话现在在聊什么"。
function atFirstUserText(conv) {
  var path = (conv && conv.activePath) || [];
  var firstText = '';
  var userCount = 0;
  for (var i = 0; i < path.length; i++) {
    var m = conv.messageMap && conv.messageMap[path[i]];
    if (!m || m.role !== 'user') continue;
    userCount++;
    if (userCount === 1) firstText = atTextOf(m);
  }
  if (userCount !== 1) return '';
  return firstText;
}

// 截断式：去掉代码块 / markdown 记号 / 链接语法，折叠空白，掐 16 字。
function atTruncate(text) {
  var t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  var chars = atChars(t);
  if (chars.length > AT_TITLE_MAX) return chars.slice(0, AT_TITLE_MAX).join('') + '…';
  return t;
}

// 模型输出清洗：只取第一行、剥「标题：」前缀、剥引号书名号、去句末标点、掐 16 字。
//   模型不听话时（爱输出「标题：《xxx》。以下是理由…」）全靠这里兜住。
function atSanitizeModelTitle(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  s = s.split(/\r?\n/)[0].trim();
  s = s.replace(/^(会话标题|标题|题目)\s*[:：]\s*/, '');
  s = s.replace(/^[#*\-\s]+/, '');
  // 首尾的引号/书名号/括号 与 句末标点 会互相挡路：
  //   `《批量重命名脚本》。` 里 `》` 不在末尾（末尾是 `。`），一次 replace 剥不干净。
  //   所以「剥首部 + 剥尾部标点」循环到不再变化为止（最多 3 轮）。
  for (var i = 0; i < 3; i++) {
    var before = s;
    s = s.replace(/^["'“”‘’「」『』《》【】\s]+/, '')
      .replace(/["'“”‘’「」『』《》【】。．.!！?？；;，,、\s]+$/, '');
    if (s === before) break;
  }
  s = s.replace(/\s+/g, ' ').trim();
  var chars = atChars(s);
  if (chars.length > AT_TITLE_MAX) s = chars.slice(0, AT_TITLE_MAX).join('');
  return s;
}

// 写回标题。三处都要检查，缺一个就会覆盖用户手改 / 给已删除的会话改名。
function atApply(conv, title) {
  if (!conv || !title) return;
  if (conv.titleSetByUser) return;
  if (typeof state !== 'undefined' && Array.isArray(state.conversations) && state.conversations.indexOf(conv) < 0) return;
  if (conv.title === title) return;
  conv.title = title;
  conv.updatedAt = Date.now();
  if (typeof save === 'function') save();
  // 用户正在长按改名（.conv-rename-input 在 DOM 里）时不要重建侧栏 —— innerHTML 会把输入框冲掉。
  // 数据已经写进 conv 了，下次渲染自然带上。
  var list = document.getElementById('conv-list');
  if (list && list.querySelector('.conv-rename-input')) return;
  if (typeof renderSidebar === 'function') renderSidebar();
}

// 发一次非流式、小 max_tokens 的请求。失败一律返回空串（由调用方停在上一步的截断式）。
async function atAskModel(conv, text) {
  if (!text || atChars(text).length < 2) return '';
  if (typeof getProvider !== 'function' || typeof buildUpstreamPayload !== 'function') return '';
  var provider = getProvider(conv.providerId);
  if (!provider || !provider.apiKey) return '';

  // 只有"直连"才发：web 版走本机中转时（/api/chat/completions）不给自己加一条路由 ——
  //   标题是锦上添花，不值得为它维护第二个后端入口。判定与 chat.js sendFromMessage 同源。
  var isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ||
    window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('172.') ||
    window.location.hostname.startsWith('10.') || window.location.hostname.endsWith('.local');
  var direct = (typeof isCapacitor === 'function' && isCapacitor()) ||
    (typeof settings !== 'undefined' && settings && settings.directMode === true) || !isLocal;
  if (!direct) return '';

  var body = {
    messages: [
      {
        role: 'system',
        content: '你负责给对话起标题。读用户的第一句话，用不超过 12 个字概括它。' +
          '只输出标题本身：不要引号、不要书名号、不要句号、不要「标题：」这类前缀、不要解释、不要换行。'
      },
      { role: 'user', content: atChars(text).slice(0, AT_MODEL_INPUT_MAX).join('') }
    ],
    model: conv.model,
    stream: false,
    max_tokens: 64,
    temperature: 0.3,
    // ★ 必须显式关思考：推理模型的 token 配额会先被 reasoning_content 吃光，
    //   max_tokens=64 时 content 直接是空串，标题永远生成不出来。
    thinkingEnabled: false
  };

  var req;
  try {
    req = buildUpstreamPayload(provider, body);
  } catch (e) {
    return '';
  }

  var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = setTimeout(function() { try { if (ctrl) ctrl.abort(); } catch (e) {} }, AT_MODEL_TIMEOUT_MS);
  try {
    // Capacitor 下 fetch 已被 CapacitorHttp patch（与 web-search.js 的 web 分支同一个通道），
    //   所以这里不另开原生请求；signal 之外再套一层 race，防止 patch 后 abort 不生效。
    var resp = await Promise.race([
      fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.payload),
        signal: ctrl ? ctrl.signal : undefined
      }),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('auto-title timeout')); }, AT_MODEL_TIMEOUT_MS + 800);
      })
    ]);
    if (!resp || !resp.ok) return '';
    var raw = await resp.text();
    var data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    if (!data) return '';
    var choice = (data.choices && data.choices[0]) || null;
    var content = choice && choice.message ? (choice.message.content || '') : '';
    return atSanitizeModelTitle(content);
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 主入口。同步返回（内部 fire-and-forget），**绝不阻塞聊天请求**。
// 调用点：chat.js sendFromMessage 开头（此时本轮 user 消息已落库）。
function maybeAutoTitle(conv) {
  try {
    if (!conv) return;
    if (!atCfg().enabled) return;                 // 用户关掉了这个功能
    if (conv.titleSetByUser) return;              // 用户自己起过名，永不再动
    var meta = conv.titleAuto || {};
    if (meta.done) return;                        // 只做一次

    var text = atFirstUserText(conv);
    if (!text) return;                            // 不是首轮 / 没内容

    // 先落 done 标记：这是"只做一次"的唯一闸门，也顺带挡住并发重复触发
    conv.titleAuto = { done: true, stage: 'fallback', at: Date.now() };
    if (typeof save === 'function') save();

    // 第一段：立刻换成真内容
    var fallback = atTruncate(text);
    if (fallback) atApply(conv, fallback);

    // 只有附件没有正文时，模型拿不到任何信息 —— 跳过第二段，省一次请求
    if (text === AT_FALLBACK_IMAGE || text === AT_FALLBACK_FILE) return;

    // 第二段：模型标题（失败就停在上一步）
    atAskModel(conv, text).then(function(title) {
      if (!title) return;
      if (conv.titleSetByUser) return;
      conv.titleAuto = { done: true, stage: 'model', at: Date.now() };
      if (typeof save === 'function') save();
      atApply(conv, title);
    }).catch(function() { /* 静默降级：截断式已经在界面上了 */ });
  } catch (e) {
    // 自动命名永远不能让聊天挂掉
  }
}
