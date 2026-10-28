// ===== 会话标题自动命名（v3.0.7 起，v3.0.10 改了时机与上下文）=====
//
// 用户诉求（2026-10-28）：「新会话能够根据第一条消息自动命名」。
//
// 改之前的现状：app.js newChat() 写死 conv.title = '对话 N'，
//   之后只能长按标题改名 —— 侧栏几十个会话全是「对话 12 / 对话 13」，只能点开认。
//   而且侧栏搜索是按 title 过滤的（conversation.js renderSidebar），标题没内容 = 搜索不可用。
//
// ★ 四条约定，动这个模块前先读：
//
// 1. **两段式，两个入口**（v3.0.10）：
//    ① `autoTitlePlaceholder(conv)` —— 发送时调（chat.js sendFromMessage 开头 / voice.js addUserMsg 之后），
//       只把标题换成首条消息前 16 字，**不发任何请求**。用户不用盯着「对话 13」等回复。
//    ② `autoTitleAfterReply(conv, assistantMsg)` —— **回复完成后**才调（chat.js 的 finally / voice.js 的 callBrain 之后），
//       这时才问模型要标题。为什么挪到回复后：挂在落库处时标题概括的是"你问了什么"，
//       而首句常常是「在吗」「继续」，根本概括不出主题；回复后概括的是"这一轮聊成了什么"。
//    模型慢/超时/报错/关掉开关 → 停在①的占位，**不回退**到「对话 N」。
//
// 2. **标题请求是"沉浸"的，但只沉浸内容**（v3.0.10）：
//    上下文由 `buildContext(conv, {forTitle:true})` 生成 —— 人设 / 系统提示 / 强调 / 用户身份 /
//    角色卡 / 模型修饰语全部与会话同源。**两处刻意不沉浸**：
//      · `thinking` 必须显式关（否则推理模型的 token 被 reasoning_content 吃光，content 是空串）；
//      · 状态栏那几条输出格式指令必须剥掉（否则模型会对标题请求也吐一个 <status> 块，被当成标题）。
//    附件降载（只给"存在与数量"、正文各截 800 字）也在 buildContext 的那个档位里，不在这里。
//
// 3. **只做一次，且绝不覆盖用户手改**：conv.titleAuto.done 落库防重复；
//    用户长按改名会置 conv.titleSetByUser = true（conversation.js），之后任何自动命名一律跳过，
//    生成途中被改名也直接丢弃结果。**别再加第二个判定条件**（比如"title 是否还是对话 N"），
//    两个判据必然有一天对不上。
//
// 4. **只有一处实现**：文本与语音都只能调上面那两个入口，不要在 chat.js、voice.js 各写一份
//    （看板 §4.24：同语义两处实现必然分叉）。判定集中在 `atShouldTitle`，别在调用方重复写条件。
//    注意 voice.js 里的 msg.title = content.substring(0,24) 是**分支节点标题**，与会话名无关。
//
// 依赖（均为全局）：getProvider / buildUpstreamPayload / buildContext / isCapacitor /
//   settings / state / save / renderSidebar

// 模型那一次请求的超时。故意比聊天短：标题迟到就没有价值了。
var AT_MODEL_TIMEOUT_MS = 10000;
// 标题字数上限（按 Unicode 码点算，一个汉字 = 1）
var AT_TITLE_MAX = 16;
// 标题请求里每条消息的正文上限。标题只看开头，800 字够用；
//   也给"首条就甩上来一整篇长文/一堆附件"兜个底（附件本身另有降载，见 atDigestForTitle）。
var AT_DIGEST_MAX = 800;

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

// 发一次非流式、小 max_tokens 的请求。失败一律返回空串（由调用方保留占位标题）。
//
// v3.0.10 起改成**沉浸式**：上下文由 buildContext(conv, {forTitle:true}) 生成 ——
//   人设 / 系统提示词 / 强调 / 用户身份 / 角色卡 / 模型修饰语 全部与会话同源，
//   只有两处被降载（都在 buildContext 里，不在这里）：
//     ① 状态栏那几条输出格式指令被剥掉 —— 否则模型会对标题请求也吐一个 <status> 块；
//     ② 附件只留"存在与数量"、正文各截 800 字 —— 首条带 10 张图时不必再走一次多模态。
// 然后在最后追加一条 user 指令。**放在 user 而不是 system**：末尾指令的遵从率明显更高。
async function atAskModel(conv) {
  if (typeof getProvider !== 'function' || typeof buildUpstreamPayload !== 'function') return '';
  if (typeof buildContext !== 'function') return '';
  var provider = getProvider(conv.providerId);
  if (!provider || !provider.apiKey) return '';

  // 纯附件开头的会话（没有正文）：模型看到的只有「［图片 3 张］」，问它也只能改写这五个字
  var firstText = atFirstUserText(conv);
  if (!firstText) return '';
  if (firstText === AT_FALLBACK_IMAGE || firstText === AT_FALLBACK_FILE) return '';

  // 只有"直连"才发：web 版走本机中转时（/api/chat/completions）不给自己加一条路由 ——
  //   标题是锦上添花，不值得为它维护第二个后端入口。判定与 chat.js sendFromMessage 同源。
  var isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ||
    window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('172.') ||
    window.location.hostname.startsWith('10.') || window.location.hostname.endsWith('.local');
  var direct = (typeof isCapacitor === 'function' && isCapacitor()) ||
    (typeof settings !== 'undefined' && settings && settings.directMode === true) || !isLocal;
  if (!direct) return '';

  var ctx;
  try {
    ctx = buildContext(conv, { forTitle: true });
  } catch (e) {
    return '';
  }
  if (!ctx || !ctx.length) return '';
  // 复制一份再追加，避免污染 buildContext 的返回（它每次新建数组，但保持习惯）
  ctx = ctx.slice();
  ctx.push({
    role: 'user',
    content: '以上是这次对话的开头。请只输出一个不超过 12 个字的标题，概括这段对话在做什么。' +
      '不要引号、不要书名号、不要句号、不要「标题：」这类前缀、不要解释、不要换行。'
  });

  var body = {
    messages: ctx,
    model: conv.model,
    stream: false,
    max_tokens: 64,
    temperature: 0.3,
    // ★ 必须显式关思考：推理模型的 token 配额会先被 reasoning_content 吃光，
    //   max_tokens=64 时 content 直接是空串，标题永远生成不出来。
    //   注意"沉浸"只沉浸内容，**不沉浸采样参数** —— 这是有意的。
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

// ===== v3.0.10：时机改成「模型首轮回复完成后」，分两段，各有一个入口 =====
//
// 为什么要改（用户 2026-10-28）：
//   挂在「user 落库后」时，标题概括的是**你问了什么**；挂到「回复完成后」，概括的是**这一轮聊成了什么**。
//   首句常常是「在吗」「这个怎么弄」「继续」，只看这句根本概括不出主题。主流客户端也都是回复完才命名。
//
//   ① autoTitlePlaceholder(conv)  —— 发送时调（sendFromMessage 开头 / voice addUserMsg 之后）
//        只做截断占位，**不发任何请求**。作用是让用户在等待期间不用盯着「对话 13」。
//   ② autoTitleAfterReply(conv, assistantMsg) —— 回复完成时调（两条路径：chat.js 的 finally + voice 的 callBrain 之后）
//        真正问模型要标题。有内容才做（打断了但有半截也算），空回复/出错不碰。

// 公共判定：这个会话现在能不能参与自动命名（**不含**"做过没有"那一层，由调用方判断）。
function atShouldTitle(conv) {
  if (!conv) return false;
  if (!atCfg().enabled) return false;              // 用户关掉了这个功能
  if (conv.titleSetByUser) return false;           // 用户自己起过名，永不再动
  // ★ 只对**新建**会话生效（newConversation 落的标记）。
  //   为什么必须卡这一条：导入的老会话、升级前就存在的会话，标题是「对话 7」，
  //   而老版本没有 titleSetByUser 这个字段 —— 用户当年手改的名字早就无从分辨了。
  //   一旦让它们也进入自动命名，就会出现「编辑一条老消息重发，会话被悄悄改名」。
  //   老会话想要新名字，走长按重命名（那才是他明确表达的意思）。
  if (conv.titleAutoEligible !== true) return false;
  if (!atFirstUserText(conv)) return false;        // 不是首轮 / 没内容
  return true;
}

// 附件降载：只给 buildContext({forTitle:true}) 用。
//   **读它存在，不读它内容** —— 首条带 10 张图时，标题模型没必要再走一次多模态（会慢、会超限）。
//   正文各截 800 字：标题只需要看开头。
function atDigestForTitle(msg) {
  if (!msg) return '';
  var parts = [];
  var chars = atChars(msg.content || '');
  if (chars.length) {
    parts.push(chars.slice(0, AT_DIGEST_MAX).join('') + (chars.length > AT_DIGEST_MAX ? '…' : ''));
  }
  var files = msg.files || [];
  if (files.length) {
    var imgN = files.filter(function(f) { return f && f.isImage; }).length;
    if (imgN) parts.push('［图片 ' + imgN + ' 张］');
    files.filter(function(f) { return f && !f.isImage; }).forEach(function(f) {
      var kb = f.size ? ' (' + Math.round(f.size / 1024) + 'KB)' : '';
      parts.push('［附件：' + (f.name || '文件') + kb + '］');
    });
  }
  return parts.join('\n').trim() || '［空消息］';
}

// ① 占位。同步返回，无网络请求。
function autoTitlePlaceholder(conv) {
  try {
    if (!atShouldTitle(conv)) return;
    if (conv.titleAuto) return;                    // 已经占过位 / 已经命名
    var text = atFirstUserText(conv);
    if (!text) return;
    var fallback = atTruncate(text);
    if (!fallback) return;
    conv.titleAuto = { placeholderAt: Date.now() };
    if (typeof save === 'function') save();
    atApply(conv, fallback);
  } catch (e) {
    // 自动命名永远不能让聊天挂掉
  }
}

// ② 回复完成后命名。同样是同步返回、内部 fire-and-forget。
//   assistantMsg 用来判断"有没有内容"，缺省时退化为只看首条用户消息。
function autoTitleAfterReply(conv, assistantMsg) {
  try {
    if (!atShouldTitle(conv)) return;
    if (conv.titleAuto && conv.titleAuto.done) return;   // 只做一次
    if (conv.titleAuto && conv.titleAuto.posting) return; // 请求在飞，别重复发

    // 有内容才命名：空回复、纯错误回复都概括不出东西（此时保留占位标题）
    var reply = assistantMsg ? String(assistantMsg.content || '') : '';
    if (assistantMsg) {
      if (assistantMsg.isError) return;
      if (!reply.trim()) return;
    }

    conv.titleAuto = Object.assign({}, conv.titleAuto || {}, { posting: true });
    atAskModel(conv).then(function(title) {
      var prev = conv.titleAuto || {};
      if (!title) {
        // 失败：撤掉 posting，下次还有机会（比如用户再发一条消息触发…不过那已不是首轮）
        conv.titleAuto = { placeholderAt: prev.placeholderAt || 0 };
        if (typeof save === 'function') save();
        return;
      }
      if (conv.titleSetByUser) return;             // 期间被手改 → 丢弃
      conv.titleAuto = { placeholderAt: prev.placeholderAt || 0, done: true, stage: 'model', at: Date.now() };
      if (typeof save === 'function') save();
      atApply(conv, title);
    }).catch(function() {
      // 静默降级：占位标题已经在界面上了
    });
  } catch (e) {
    // 同上
  }
}
