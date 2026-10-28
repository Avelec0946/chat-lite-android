// ===== chat.js : 聊天核心模块（v2.0 拆分）=====
// 模块名：chat.js
// 版本：v84（cache-bust）
// 迁移日期：2026-07-27
// 来源：从 app.js 拆分
// 职责：消息发送、流式请求、原生请求、上下文构建、消息渲染辅助、编辑/重生成/删除、兄弟节点切换
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / escapeHtml / showToast /
//       ICON / uid / $ / messagesEl / currentConv / isCapacitor / CapStreamHttp / CapFilesystem /
//       getProvider / normalizeProvider / buildUpstreamPayload / modelToUpstreamId /
//       getActiveChain / getLastActiveMsg / getMsg / getBranchPath / renderMessages /
//       renderBreadcrumb / addLongPress / escapeSvg / renderTreeSVG /
//       parseImageActualSize / parseJsonField / showToast
// 加载顺序：在 conversation.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   消息渲染辅助：renderContent, renderEditMode, enterEditMode, saveEdit, cancelEdit,
//                 extractCodeBlocks, extractAiBody, closeBubbleContextMenu, flashBubbleMenuToast
//   兄弟节点：renderSiblingArrows, switchSibling, appendChildPath
//   消息操作：sendMessage, regenerate, deleteMessage, updateMessageContent, continueGeneration
//   上下文构建：buildContext, buildContextForContinue
//   请求执行：executeStreamHttp, executeRequest, executeNativeRequest
//   流式发送：sendFromMessage, sendFromMessageContinue, typewriterEffect
//   UI 状态：toggleSendStop, updateSendButton, setStatus
//
// 保留在 app.js：
//   init / 事件绑定 / state / 通用工具（showToast, escapeHtml, uid, isCapacitor）

// ===== 消息渲染辅助 =====
function closeBubbleContextMenu() {
  const m = document.getElementById('bubble-context-menu');
  if (m) m.remove();
}

function extractAiBody(content) {
  return (content || '').replace(/<status>[\s\S]*?<\/status>/g, '').trim();
}

function extractCodeBlocks(content) {
  const blocks = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const inner = m[0].replace(/^```[^\r\n]*\r?\n?/, '').replace(/\r?\n?```$/, '');
    blocks.push(inner);
  }
  return blocks;
}

function flashBubbleMenuToast() {
  if (typeof setStatus === 'function') {
    setStatus('saved');
    setTimeout(function() { setStatus(''); }, 1000);
  }
}

function renderSiblingArrows(msg, conv) {
  const parent = getMsg(conv, msg.parentId);
  if (!parent || !parent.children || parent.children.length <= 1) return '';
  const siblings = parent.children;
  const idx = siblings.indexOf(msg.id);
  if (idx < 0) return '';
  return `<span class="version-arrows branch-nav">
    <button class="version-arrow" onclick="switchSibling('${msg.id}', -1)" ${idx === 0 ? 'disabled' : ''}>◀</button>
    <span class="version-label">${idx + 1}/${siblings.length}</span>
    <button class="version-arrow" onclick="switchSibling('${msg.id}', 1)" ${idx >= siblings.length - 1 ? 'disabled' : ''}>▶</button>
  </span>`;
}

window.switchSibling = function(currentId, direction) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, currentId);
  if (!msg) return;
  const parent = getMsg(conv, msg.parentId);
  if (!parent || !parent.children) return;
  const siblings = parent.children;
  const idx = siblings.indexOf(currentId);
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= siblings.length) return;
  
  const newId = siblings[newIdx];
  const pathIdx = conv.activePath.indexOf(currentId);
  if (pathIdx >= 0) {
    conv.activePath[pathIdx] = newId;
    // Truncate any subsequent messages in activePath (they belong to old branch)
    conv.activePath = conv.activePath.slice(0, pathIdx + 1);
    // Append the new branch's children path
    appendChildPath(conv, newId);
  }
  save();
  renderMessages();
  renderBreadcrumb(conv);
};

function appendChildPath(conv, fromId) {
  const msg = conv.messageMap[fromId];
  if (!msg || !msg.children || msg.children.length === 0) return;
  // Follow the first child (preferred path)
  const nextId = msg.children[0];
  conv.activePath.push(nextId);
  appendChildPath(conv, nextId);
}

// ===== 渲染范围策略（v117）=====
// 助手正文：完整渲染（Markdown + LaTeX 公式 + 文本样式指令）
// 思维链  ：同样完整渲染
// 用户消息：默认不渲染公式与样式指令 —— 用户输入的是提示词，里面常出现
//          \scalebox 这类命令字面量，渲染出来反而看不出原文；
//          可在设置「常用偏好」中开启。Markdown 仍照常渲染（保持既有行为）。
function renderBody(msg) {
  var text = (msg && msg.content) || '';
  if (msg && msg.role === 'user' && !renderUserLatexEnabled()) {
    try {
      if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
        return marked.parse(text, { breaks: true, gfm: true });
      }
    } catch (e) { /* 落到最下面的纯文本兜底 */ }
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
  return renderMarkdownWithLatex(text);
}

function renderReasoning(text) {
  if (!text) return '';
  return renderMarkdownWithLatex(text);
}

function renderUserLatexEnabled() {
  try {
    // settings 由 app.js 以 const 声明；此处为运行时访问，不在加载期触碰（§3.2 第 7 条）
    return !!(typeof settings !== 'undefined' && settings && settings.renderUserLatex);
  } catch (e) {
    return false;                                   // TDZ 等异常一律按"不渲染"处理
  }
}

function renderContent(msg) {
  let html = '';

  // 思维链（可折叠）：走与正文相同的完整渲染管线（Markdown + LaTeX + 样式指令）
  if (msg.reasoningContent) {
    html += `<details class="reasoning-details">
      <summary class="reasoning-summary">思考过程</summary>
      <div class="reasoning-content">${renderReasoning(msg.reasoningContent)}</div>
    </details>`;
  }

  // File attachments
  // v3.0.6: 图片附件只显示画面，**不带文件名**。看图的人看的是画面，`bili_poster-1793….gif`
  //   这种名字既看不懂、又会让每条附件占两行（4 张图就堆掉大半屏）。
  //   图片并成一行 56px 方块（横向排开，多了自动换行），文本附件仍是「文件名 (大小)」的标签
  //   —— 文本附件的名字是它唯一的身份，不能省。
  //   取图直接用 msg.files[].base64：那本来就是压缩到最长边 1024 的 JPEG，56px 方块够用，
  //   且不新增任何字段（data.json 体积不变）。
  if (msg.files && msg.files.length > 0) {
    const imgs = msg.files.filter(f => f && f.isImage);
    const docs = msg.files.filter(f => f && !f.isImage);
    if (imgs.length > 0) {
      html += '<div class="msg-thumbs">' + imgs.map(f => {
        const src = 'data:' + (f.mimeType || 'image/jpeg') + ';base64,' + (f.base64 || f.content || '');
        return `<img class="file-thumb" src="${src}" alt="" />`;
      }).join('') + '</div>';
    }
    if (docs.length > 0) {
      html += docs.map(f =>
        `<div class="file-tag" style="margin-bottom:4px">${escapeHtml(f.name)} (${formatSize(f.size)})</div>`
      ).join('');
    }
  }

  if (msg.isFileOnly) return html;

  // 正文：按渲染范围策略选管线（助手完整渲染；用户消息默认不渲染公式/指令）
  html += renderBody(msg);

  // Status bar: extract <status>...</status> and render as styled block
  // B3: 先把代码块替换成占位符，避免代码块内的 <status> 示例被误提取
  var content = msg.content || '';
  var _codeBlocks = [];
  var contentNoCode = content.replace(/```[\s\S]*?```/g, function(m) {
    var i = _codeBlocks.length; _codeBlocks.push(m); return '\u0000CB' + i + '\u0000';
  }).replace(/`[^`\n]+`/g, function(m) {
    var i = _codeBlocks.length; _codeBlocks.push(m); return '\u0000CB' + i + '\u0000';
  });
  var lastStatusStart = contentNoCode.lastIndexOf('<status>');
  var lastStatusEnd = contentNoCode.lastIndexOf('</status>');
  var statusMatch = null;
  if (lastStatusStart !== -1 && lastStatusEnd !== -1 && lastStatusEnd > lastStatusStart) {
    statusMatch = [contentNoCode.slice(lastStatusStart, lastStatusEnd + '</status>'.length), contentNoCode.slice(lastStatusStart + '<status>'.length, lastStatusEnd)];
  }
  if (statusMatch) {
    var statusHtml = renderMarkdownWithLatex(statusMatch[1].trim());
    var conv = currentConv();
    // B1: position 支持 effectiveStatusBar（继承全局）
    var sbEff = effectiveStatusBar(conv);
    var position = sbEff.position || 'bottom';
    var statusBarHtml = '<div class="status-bar status-bar-' + position + '">' + statusHtml + '</div>';
    if (position === 'top') {
      var reasoningEnd = html.indexOf('</details>');
      if (reasoningEnd !== -1) {
        reasoningEnd += '</details>'.length;
        html = html.slice(0, reasoningEnd) + statusBarHtml + html.slice(reasoningEnd);
      } else {
        html = statusBarHtml + html;
      }
    } else {
      html += statusBarHtml;
    }
    // Remove the raw <status> tags from rendered content
    html = html.replace(/&lt;status&gt;[\s\S]*?&lt;\/status&gt;/g, '');
    html = html.replace(/<status>[\s\S]*?<\/status>/g, '');
  }

  // Word count
  const wc = countWords(msg.content || '');
  if (wc > 0) {
    html += `<span class="msg-wordcount">${wc}字</span>`;
  }

  // Interrupted marker + continue button
  if (msg.interrupted) {
    const reason = msg.errorMsg ? escapeHtml(msg.errorMsg) : '生成中断';
    html += `<div class="interrupted-bar">
      <span class="interrupted-reason">⚠ ${reason}</span>
      <button class="continue-btn" onclick="continueGeneration('${msg.id}')">继续生成</button>
    </div>`;
  }

  return html;
}

function renderEditMode(msg) {
  return `<div class="edit-wrap">
    <textarea class="msg-edit-textarea" id="edit-ta-${msg.id}">${escapeHtml(msg.content)}</textarea>
    <div class="edit-resize-handle" data-for="${msg.id}"></div>
    <div class="edit-actions">
      <button class="save-btn">保存</button>
      <button class="cancel-btn">取消</button>
    </div>
  </div>`;
}

function enterEditMode(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg) { msg.editing = true; renderMessages(); }
}

function saveEdit(msgId, newContent) {
  const conv = currentConv();
  if (!conv || !conv.messageMap) return;
  const msg = getMsg(conv, msgId);
  if (!msg) return;

  if (msg.role === 'assistant') {
    const prevContent = msg.content;
    msg.versions.push({ content: prevContent, timestamp: Date.now(), reason: 'edited' });
    msg.activeVersion = 0;
    msg.content = newContent;
    msg.wordCount = countWords(newContent);
    msg.editing = false;
    save();
    renderMessages();
    return;
  }

  // User message - save old as version, create new branch, trigger AI regen
  if (newContent !== msg.content) {
    // Save old content as a version in the original message
    msg.versions.push({ content: msg.content, timestamp: Date.now(), reason: 'edited' });
    msg.activeVersion = 0;
    
    // Create a NEW node as sibling for the edited content
    var newId = uid();
    var newMsg = {
      id: newId,
      role: 'user',
      content: newContent,
      parentId: msg.parentId,
      children: [],
      title: newContent.substring(0, 30) + (newContent.length > 30 ? '...' : ''),
      wordCount: countWords(newContent),
      versions: [{ content: newContent, timestamp: Date.now(), reason: 'edited' }],
      activeVersion: 0,
      files: msg.files || [],
      createdAt: Date.now()
    };
    conv.messageMap[newId] = newMsg;
    
    // The NEW message is a child of the same parent
    var parent = getMsg(conv, msg.parentId);
    if (parent) parent.children.push(newId);
    
    // Update activePath: replace old msgId with newId, truncate after
    var mIdx = conv.activePath.indexOf(msgId);
    if (mIdx >= 0) {
      conv.activePath[mIdx] = newId;
      conv.activePath = conv.activePath.slice(0, mIdx + 1);
    }
    
    msg.editing = false;
    save();
    renderMessages();
    
    // Trigger AI regeneration for the new message (since it has no response)
    var ctx = buildContext(conv);
    setTimeout(function() { sendFromMessage(ctx); }, 100);
    return;
  }

  msg.editing = false;
  save();
  renderMessages();
}

function cancelEdit(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg) { msg.editing = false; renderMessages(); }
}

// ===== 消息操作 =====
async function sendMessage() {
  const text = chatInput.innerText.trim();
  if (!text && state.pendingFiles?.length === 0) return;
  // v3.0.6: 有附件还在压缩/读取就别发 —— 否则会把空内容的占位当成附件发出去
  if (state.pendingFiles?.some(f => f && f.loading)) return;

  const conv = currentConv();
  if (!conv || state.loading) return;

  const files = state.pendingFiles || [];
  state.pendingFiles = [];

  // Get parent (last active message)
  const parent = getLastActiveMsg(conv);

  // Build user message
  const userMsg = {
    id: uid(),
    role: 'user',
    content: text,
    parentId: parent ? parent.id : conv.rootId,
    children: [],
    title: text.substring(0, 30) + (text.length > 30 ? '...' : ''),
    wordCount: countWords(text),
    versions: [{ content: text, timestamp: Date.now(), reason: 'original' }],
    activeVersion: 0,
    files: files.map(f => ({ name: f.name, type: f.type, content: f.isImage ? f.content : f.content.slice(0, 500000), isImage: f.isImage, base64: f.base64, mimeType: f.mimeType, size: f.size })),
    createdAt: Date.now()
  };

  // Add to tree
  conv.messageMap[userMsg.id] = userMsg;
  if (parent) {
    parent.children.push(userMsg.id);
  }
  conv.activePath.push(userMsg.id);

  chatInput.innerText = '';
  updateSendButton();
  clearFilePreview();
  save();
  renderMessages();

  // Build API context
  const context = buildContext(conv);
  await sendFromMessage(context);
}

async function regenerate(msgId) {
  if (state.loading) return;
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (!msg || msg.role !== 'assistant') return;

  // Get parent user message
  const parentId = msg.parentId;
  const parent = getMsg(conv, parentId);

  // Save old version then remove from active path
  if (msg.content) {
    msg.versions.push({ content: msg.content, timestamp: Date.now(), reason: 'regenerated' });
    msg.activeVersion = 0;
  }

  // Pop this msg from active path
  const idx = conv.activePath.indexOf(msgId);
  if (idx >= 0) {
    conv.activePath = conv.activePath.slice(0, idx);
  }

  save();
  renderMessages();

  const context = buildContext(conv);
  await sendFromMessage(context);
}

function deleteMessage(msgId) {
  const conv = currentConv();
  if (!conv || !conv.messageMap || !conv.messageMap[msgId]) return;

  const msg = getMsg(conv, msgId);
  if (!msg || !msg.parentId) {
    showToast('根节点不能删除', 'warn');
    return;
  }

  if (!confirm('确定删除这条消息及其所有分支吗？')) return;

  // Collect all descendants to delete
  const idsToDelete = new Set();
  function collect(id) {
    idsToDelete.add(id);
    const node = conv.messageMap[id];
    if (node && node.children) {
      node.children.forEach(collect);
    }
  }
  collect(msgId);

  // Remove from parent's children list
  const parent = getMsg(conv, msg.parentId);
  if (parent && parent.children) {
    parent.children = parent.children.filter(id => !idsToDelete.has(id));
  }

  // Delete nodes from messageMap
  idsToDelete.forEach(id => {
    delete conv.messageMap[id];
  });

  // Rebuild activePath: find the deletion point and try to switch to a sibling
  const deleteIdx = conv.activePath.indexOf(msgId);
  if (deleteIdx >= 0) {
    // Truncate activePath to just before the deleted message
    conv.activePath = conv.activePath.slice(0, deleteIdx);

    // A2: If parent has remaining children, switch to the LAST available sibling
    // (主人偏好回退到倒数第一，而非第一)
    if (parent && parent.children && parent.children.length > 0) {
      const newChildId = parent.children[parent.children.length - 1];
      // Walk down the last-child chain to rebuild a complete activePath
      let cursor = newChildId;
      while (cursor) {
        conv.activePath.push(cursor);
        const cursorNode = conv.messageMap[cursor];
        cursor = (cursorNode && cursorNode.children && cursorNode.children.length > 0)
          ? cursorNode.children[cursorNode.children.length - 1]
          : null;
      }
    }
  } else {
    // Deleted message was not on active path, just filter out any deleted ids
    conv.activePath = conv.activePath.filter(id => !idsToDelete.has(id));
  }

  // Safety fallback
  if (conv.activePath.length === 0) {
    conv.activePath = [conv.rootId];
  }

  // If streaming is tied to a deleted message, stop loading state
  if (state.loading && state.abortController) {
    state.abortController.abort();
    state.loading = false;
    state.abortController = null;
  }

  state.selectedMsgId = null;
  save();
  renderMessages();
  showToast('消息已删除', 'info');
}

function updateMessageContent(msgId, content, reasoning) {
  const el = messagesEl.querySelector(`.message[data-id="${msgId}"] .msg-bubble`);
  if (!el) return;

  // Reasoning block (collapsible, at top)
  let reasoningEl = el.querySelector('.reasoning-block');
  if (reasoning) {
    if (!reasoningEl) {
      reasoningEl = document.createElement('div');
      reasoningEl.className = 'reasoning-block';
      reasoningEl.innerHTML = `<details class="reasoning-details">
        <summary class="reasoning-summary">思考过程</summary>
        <div class="reasoning-content rendered-reasoning"></div>
      </details>`;
      el.insertBefore(reasoningEl, el.firstChild);
    }
    const rContent = reasoningEl.querySelector('.rendered-reasoning');
    if (rContent) rContent.innerHTML = renderMarkdownWithLatex(reasoning);
  } else if (reasoningEl) {
    reasoningEl.remove();
  }

  // Content area
  let contentEl = el.querySelector('.rendered-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'rendered-content';
    // v3.0.5：锚点要先避开「联网来源」卡片 —— 否则流式期间新建的正文会插到来源下面，
    //   用户看到的是「先列来源、再出正文」。来源永远排在正文之后、操作按钮之前。
    const srcs = el.querySelector('.web-sources');
    const actions = el.querySelector('.msg-actions');
    const anchor = srcs || actions;
    if (anchor) {
      el.insertBefore(contentEl, anchor);
    } else {
      el.appendChild(contentEl);
    }
  }
  // 流式增量渲染：latex.js 内部对已渲染公式走 LRU 缓存，重复重渲的边际开销趋近于零
  contentEl.innerHTML = renderMarkdownWithLatex(content || '');

  // Highlight code blocks
  contentEl.querySelectorAll('pre code').forEach(block => {
    if (typeof hljs !== 'undefined') {
      hljs.highlightElement(block);
    }
  });

  scrollToBottom();
}

// ===== v3.0.11: 流式增量入口（唯一）=====
// 为什么要有这个东西：
//   模型吐字这个事件，代码里有**四条**到达路径：
//     ① APK 真流式      executeStreamHttp → consumeChunk
//     ② Web 流式        sendFromMessage 里的 fetch 循环
//     ③ Web 续写        sendFromMessageContinue 里的 fetch 循环
//     ④ 带工具的 agent  runAgentChat → agent-loop.js 的 onDelta（联网搜索开着时走它）
//   以前每条路径各自实现「累加 + 振感 + 节流重绘」，四份手抄。v3.0.8 加第 ④ 条时漏了振感，
//   于是出现「联网一开流式震动就没了」—— 看着像振感模块和联网模块互相影响，实际是同一件事写了四遍，
//   而新增的那一遍少抄了一行。副作用一旦绑在**传输路径**上，每加一条路径就会漏一次。
//   所以：路径只负责解析字节，把增量交到这里；振感/重绘/滚动只在这一个地方发生。
//   以后再加流式入口（语音接入、新供应商的非标 SSE）也必须调 applyStreamDelta，不许自己写累加。
var STREAM_RENDER_INTERVAL = 100;   // markdown 重绘节流（100ms ≈ 10fps）
var _streamRenderAt = 0;            // 同一时刻只有一条流（state.loading 互斥），单变量足够

// kind: 'content' | 'reasoning'
function applyStreamDelta(msg, kind, text) {
  if (!msg || !text) return;
  // 登记「当前正在流式的消息」：手指按屏期间暂停重绘，松手时 app.js 靠它补最后一次渲染。
  // 以前只有 APK 真流式登记，联网（agent 路径）没有 —— 滚动一下界面就不跟了。
  state._streamingMsg = msg;
  if (kind === 'reasoning') {
    msg.reasoningContent = (msg.reasoningContent || '') + text;
  } else {
    msg.content = (msg.content || '') + text;
    // 只对正文触发振感：思考链是模型的内部过程，震了反而会把「它开始说话了」这个信号冲淡。
    triggerHapticFeedback(text);
  }
  // 手指按着屏幕滚动时暂停重绘 —— innerHTML 重建会阻塞 touchmove
  if (state._isTouching) return;
  var now = Date.now();
  if (now - _streamRenderAt < STREAM_RENDER_INTERVAL) return;
  _streamRenderAt = now;
  updateMessageContent(msg.id, msg.content, msg.reasoningContent || '');   // 内部自带 scrollToBottom
}

async function continueGeneration(msgId) {
  const conv = currentConv();
  if (!conv || state.loading) return;

  const msg = getMsg(conv, msgId);
  if (!msg || !msg.interrupted) return;

  // Clear interrupted state
  msg.interrupted = false;
  msg.errorMsg = '';
  save();
  renderMessages();

  // Build context: system prompt + history up to this message
  const context = buildContextForContinue(conv, msg);
  await sendFromMessageContinue(context, msg);
}

// ===== B3: 状态栏指令构造（格式约定 templateRule + 规则约定 displayFields）=====
// 格式约定：定义状态栏字段/格式形式，生成指令与示例；留空则仅要求输出 <status> 标签，不指定字段
// 规则约定：字段的特殊规则说明，可留空；留空则不注入
function statusBarExample(rule) {
  return rule.split(/[,，、\s]+/).map(function(s) { return s.trim() + '：xxx'; }).filter(function(s) { return s !== '：xxx'; }).join('\\n');
}
function statusBarRuleText(sb) {
  var rule = (sb.templateRule || '').trim();
  var note = (sb.displayFields || '').trim();
  var parts = [];
  if (rule) {
    parts.push('【状态栏指令】每次回复末尾，请用 <status>...</status> 标签输出角色当前状态信息。状态栏应包含以下内容：' + rule + '。请根据上下文合理填写数值和描述，保持角色一致性。示例格式：\\n<status>\\n' + statusBarExample(rule) + '\\n</status>');
  } else {
    parts.push('【状态栏指令】每次回复末尾，请用 <status>...</status> 标签输出角色当前状态信息，内容请根据上下文合理填写，保持角色一致性。');
  }
  if (note) parts.push('【规则约定】' + note);
  return parts.join('\\n');
}
function statusBarMidText(sb) {
  var rule = (sb.templateRule || '').trim();
  if (rule) return '【格式提醒】回复末尾须包含 <status>...</status> 标签，内容包括：' + rule;
  return '【格式提醒】回复末尾须包含 <status>...</status> 标签输出状态信息，内容根据上下文合理填写';
}
function statusBarPostText(sb) {
  var rule = (sb.templateRule || '').trim();
  if (rule) return '【格式提醒】你的每次回复必须在最末尾包含 <status>...</status> 标签的状态栏，内容包括：' + rule + '。这是强制格式要求，不可省略。';
  return '【格式提醒】你的每次回复必须在最末尾包含 <status>...</status> 标签的状态栏，内容根据上下文合理填写。这是强制格式要求，不可省略。';
}
function statusBarUserText(sb) {
  var rule = (sb.templateRule || '').trim();
  if (rule) return '【格式要求】你必须在本次回复的最末尾，用 <status>...</status> 标签输出状态栏，内容包括：' + rule + '。这是强制要求，不可省略。';
  return '【格式要求】你必须在本次回复的最末尾，用 <status>...</status> 标签输出状态栏，内容根据上下文合理填写。这是强制要求，不可省略。';
}

// ===== 上下文构建 =====
// v131：加 opts —— 语音通话复用**同一个**构建器（opts.statusBar=false 只是不注入状态栏
//   那几条"输出格式"指令，历史/附件/图片/模型修饰/身份 一律与文本对话逐字相同）。
//   以前通话侧自己写了一份，于是"文本对话看得见附件、通话看不见"这种分叉必然发生（v130 已修过一次，
//   这次从根上只留一个实现）。
function buildContext(conv, opts) {
  const o = opts || {};
  const msgs = [];
  const sysParts = [];
  // v3.0.10 {forTitle:true}：标题命名专用档位。**只降载，不改结构** ——
  //   人设 / 强调 / 模型修饰 / 用户身份全部保留（"沉浸"的核心），
  //   剥掉的只有"输出格式类"指令：状态栏那几条会让标题模型也吐一个 <status> 块，然后被当成标题。
  const sb = (o.statusBar === false || o.forTitle) ? null : effectiveStatusBar(conv);
  const mp = effectiveModelPrompt(conv);

  // 会话级 systemPrompt
  if (conv.systemPrompt) sysParts.push(conv.systemPrompt);
  // 会话级 emphasis
  if (conv.emphasis) sysParts.push('【重要强调】' + conv.emphasis);
  // B2: 模型修饰（text 按 ===强调=== 分隔拆分为 systemPrompt + emphasis）
  if (mp && mp.text) {
    var sepIdx = mp.text.indexOf('===强调===');
    if (sepIdx >= 0) {
      var mpSys = mp.text.substring(0, sepIdx).trim();
      var mpEmp = mp.text.substring(sepIdx + 9).trim();
      if (mpSys) sysParts.push(mpSys);
      if (mpEmp) sysParts.push('【重要强调】' + mpEmp);
    } else {
      sysParts.push(mp.text.trim());
    }
  }
  // B3: 状态栏指令（格式约定 templateRule + 规则约定 displayFields）
  if (sb && sb.enabled) {
    sysParts.push(statusBarRuleText(sb));
  }
  // 用户身份（会话级）
  var userId = conv.userIdentity;
  if (userId) sysParts.push('用户身份：' + userId);

  if (sysParts.length > 0) {
    msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  }

  // Message history from active path
  const chain = getActiveChain(conv);
  var histIdx = 0;
  var sbMidCount = 0;
  for (const m of chain) {
    if (!m || m.role === 'system') continue;
    histIdx++;
    // v3.0.10: 标题请求只读"存在与数量"（图片 → ［图片 N 张］、附件 → ［附件：名字 (大小)］、
    //   正文各截 800 字）。理由不是省钱，是**会不会失败** —— 首条带 10 张图时原样复用
    //   上下文会再走一次多模态甚至超限。降载逻辑只有 atDigestForTitle 一处。
    let content;
    if (o.forTitle && typeof atDigestForTitle === 'function') {
      content = atDigestForTitle(m);
    } else {
      content = buildFileContent(m);
    }
    msgs.push({ role: m.role, content });

    // Mid-context injection: every 4 history messages, capped at 5 reminders
    if (sb && sb.enabled && histIdx % 4 === 0 && sbMidCount < 5) {
      msgs.push({ role: 'system', content: statusBarMidText(sb) });
      sbMidCount++;
    }
  }

  // Post-History Instruction: status bar reminder right before generation
  if (sb && sb.enabled) {
    msgs.push({ role: 'system', content: statusBarPostText(sb) });
    msgs.push({ role: 'user', content: statusBarUserText(sb) });
  }

  return msgs;
}

function buildContextForContinue(conv, targetMsg) {
  const msgs = [];
  const sysParts = [];
  const sb = effectiveStatusBar(conv);
  const mp = effectiveModelPrompt(conv);

  // 会话级 systemPrompt
  if (conv.systemPrompt) sysParts.push(conv.systemPrompt);
  // 会话级 emphasis
  if (conv.emphasis) sysParts.push('【重要强调】' + conv.emphasis);
  // B2: 模型修饰（text 按 ===强调=== 分隔拆分为 systemPrompt + emphasis）
  if (mp && mp.text) {
    var sepIdx = mp.text.indexOf('===强调===');
    if (sepIdx >= 0) {
      var mpSys = mp.text.substring(0, sepIdx).trim();
      var mpEmp = mp.text.substring(sepIdx + 9).trim();
      if (mpSys) sysParts.push(mpSys);
      if (mpEmp) sysParts.push('【重要强调】' + mpEmp);
    } else {
      sysParts.push(mp.text.trim());
    }
  }
  // B3: 状态栏指令（格式约定 templateRule + 规则约定 displayFields）
  if (sb && sb.enabled) {
    sysParts.push(statusBarRuleText(sb));
  }
  // 用户身份（会话级）
  var userId = conv.userIdentity;
  if (userId) sysParts.push('用户身份：' + userId);
  if (sysParts.length > 0) msgs.push({ role: 'system', content: sysParts.join('\\n\\n') });

  // Walk up from targetMsg to root, collect messages
  const chain = [];
  let current = targetMsg;
  while (current && current.parentId) {
    chain.unshift(current);
    current = conv.messageMap[current.parentId];
  }

  var histIdx = 0;
  var sbMidCount = 0;
  for (const m of chain) {
    if (!m || m.role === 'system') continue;
    histIdx++;
    let content = m.content;
    content = buildFileContent(m);
    msgs.push({ role: m.role, content });

    if (sb && sb.enabled && histIdx % 4 === 0 && sbMidCount < 5) {
      msgs.push({ role: 'system', content: statusBarMidText(sb) });
      sbMidCount++;
    }
  }

  if (sb && sb.enabled) {
    msgs.push({ role: 'system', content: statusBarPostText(sb) });
    msgs.push({ role: 'user', content: statusBarUserText(sb) });
  }

  return msgs;
}

// ===== v122: 等待模型返回的统一超时 =====
// 语义：从发出请求到「任意一块数据到达」之间的最长等待，每收到一块数据即重新计时。
// 同时覆盖两种场景：① 模型长时间静默思考（首字之前）② 已经出内容后中途卡住。
// 旧实现把值写死在 chat.js 内部（settings.nativeTimeoutMs，默认 120 秒）且没有任何 UI 入口，
// 而原生插件的读超时又写死 30 秒 —— 那个 120 秒的计时器实际上永远追不上，也没人能调。
function resolveChatWaitMs() {
  var v = parseInt(settings.chatWaitMs, 10);
  if (!(v > 0)) v = 300000;        // 默认 5 分钟
  if (v < 15000) v = 15000;        // 下限 15 秒
  if (v > 3600000) v = 3600000;    // 上限 60 分钟
  return v;
}

// v122: 部分中转会忽略 stream:true，整段返回普通 JSON。
// 这种响应里一个 data: 行都没有，走正常解析只会得到空回复 —— 这里兜底把正文与思维链抠出来。
function salvageNonStreamBody(text) {
  if (!text) return null;
  var s = String(text).trim();
  if (!s || (s.charAt(0) !== '{' && s.charAt(0) !== '[')) return null;
  try {
    var json = JSON.parse(s);
    if (Object.prototype.toString.call(json) === '[object Array]') json = json[0];
    if (!json || json.error) return null;
    var choice = json.choices && json.choices[0];
    var message = (choice && (choice.message || choice.delta)) || {};
    var content = message.content || '';
    var reasoning = message.reasoning_content || message.reasoning || message.thinking || '';
    if (!content && !reasoning) return null;
    return { content: content, reasoning: reasoning };
  } catch(e) { return null; }
}

// v122: 非 2xx 时原生会把响应体一起带回来（形如 `HTTP 401: {"error":{"message":"..."}}`）。
// 直接把整段 JSON 甩到界面上不好看，这里把里面的 message / detail 抠出来。
function prettyStreamError(msg) {
  if (!msg) return '未知错误';
  var m = String(msg);
  var i = m.indexOf('{');
  if (i < 0) return m;
  var head = m.slice(0, i).replace(/[:：]\s*$/, '');
  try {
    var j = JSON.parse(m.slice(i));
    var inner = j.error || j;
    var text = inner.message || inner.detail || (typeof inner.error === 'string' ? inner.error : '');
    if (text) return (head ? head + '：' : '') + text;
  } catch(e) {}
  return m;
}

// ===== 请求执行 =====
async function executeStreamHttp(req, assistantMsg, opts) {
  opts = opts || {};
  const existingContent = opts.existingContent || '';
  const existingReasoning = opts.existingReasoning || '';

  // 初始化内容（续接场景）
  assistantMsg.content = existingContent;
  assistantMsg.reasoningContent = existingReasoning;
  state._streamingMsg = assistantMsg;  // 记录当前流式消息（松手后立即渲染用）

  // 状态管理
  let streamId = null;
  let resolved = false;
  let chunkBuffer = '';
  // 渲染节流与振感统一由 applyStreamDelta 负责（v3.0.11），这里不再持有 lastRenderTime

  // v122: 完成度追踪 —— 只有「确认正常收尾」才算完成，否则保留内容并标记疑似截断
  let sawDone = false;      // 收到 [DONE]
  let finishReason = null;  // 收到 finish_reason
  let sseEventCount = 0;    // 解出的标准 SSE 事件数（为 0 说明对端根本没按流式返回）
  let gotData = false;      // 是否读到过原始数据
  let rawText = '';         // 原始文本（仅用于非流式兜底解析，限长）
  const earlyChunks = [];   // v122: streamId 返回前先到的分块，拿到 id 后回放
  let finalize = null;      // 供 abort 覆盖调用（done 在 Promise 作用域内，这里留个引用）

  // v122: 等待超时（空闲语义：每收到一块数据即重置）——由「常用偏好·等待超时」控制
  const waitMs = resolveChatWaitMs();
  let timeoutId = null;

  // 设置 abort（用于停止生成）
  state.abortController = new AbortController();
  const origAbort = state.abortController.abort.bind(state.abortController);
  state.abortController.abort = function() {
    if (streamId) {
      try { CapStreamHttp.cancelStream({ id: streamId }); } catch(e) {}
    }
    try { origAbort(); } catch(e) {}
    // v122: 用户主动停止必须在这里收尾 —— 原实现什么都不做，插件随后补发的 end 事件
    // 会被当成「正常完成」，于是停止后既没有 [已停止] 标记、也没有「继续生成」按钮
    if (finalize) finalize('stop', '用户打断');
  };

  // 移除 cursor-blink，显示首字后会替换
  const msgBubble = messagesEl.querySelector(`.message[data-id="${assistantMsg.id}"] .msg-bubble`);
  if (msgBubble) msgBubble.classList.remove('cursor-blink');

  return new Promise(async (resolve, reject) => {
    let chunkListener, endListener, errorListener;

    function cleanup() {
      clearTimeout(timeoutId);
      if (chunkListener && chunkListener.remove) chunkListener.remove();
      if (endListener && endListener.remove) endListener.remove();
      if (errorListener && errorListener.remove) errorListener.remove();
    }

    // kind: '' 正常完成 / 'stop' 用户停止 / 'truncated' 疑似截断 / 'length' 触发输出上限
    function done(kind, reason) {
      if (resolved) return;
      resolved = true;
      cleanup();
      state._streamingMsg = null;  // 清除流式消息标记
      if (kind) {
        assistantMsg.interrupted = true;
        assistantMsg.errorMsg = reason || '生成中断';
        if (kind === 'stop' && (!assistantMsg.content || assistantMsg.content === existingContent)) {
          assistantMsg.content = existingContent + '\n\n*[已停止]*';
        }
      }
      // 最终渲染 + 保存（内容一律保留 —— 绝不因为「没收全」而丢掉已经到达的部分）
      updateMessageContent(assistantMsg.id, assistantMsg.content, assistantMsg.reasoningContent || '');
      assistantMsg.versions[0] = {
        content: assistantMsg.content,
        timestamp: Date.now(),
        reason: opts.reason || 'original'
      };
      save();
      resolve();
    }
    finalize = done;

    // v122: 按行消费一段流式文本（行缓冲跨分包安全，分块被切断也不会丢字节）
    function consumeChunk(text) {
      if (!text) return;
      gotData = true;
      if (rawText.length < 300000) rawText += text;
      chunkBuffer += text;
      const lines = chunkBuffer.split('\n');
      chunkBuffer = lines.pop() || '';

      for (let rawLine of lines) {
        if (rawLine.charCodeAt(rawLine.length - 1) === 13) rawLine = rawLine.slice(0, -1);  // 去 \r
        if (!rawLine || rawLine.charAt(0) === ':') continue;   // 空行 / SSE 注释（心跳）
        if (rawLine.indexOf('data:') !== 0) continue;          // v122: 兼容 "data:" 与 "data: "
        const jsonStr = rawLine.slice(5).trim();
        if (jsonStr === '[DONE]') { sawDone = true; continue; }

        try {
          const json = JSON.parse(jsonStr);
          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          sseEventCount++;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;

          // 思考链增量 / 内容增量 —— 一律交给 applyStreamDelta（累加 + 振感 + 节流重绘）
          const reasoningText = delta.reasoning_content || delta.thinking || delta.chain_of_thought || '';
          if (reasoningText) applyStreamDelta(assistantMsg, 'reasoning', reasoningText);
          if (delta.content) applyStreamDelta(assistantMsg, 'content', delta.content);
        } catch(e) {}
      }
    }

    try {
      // 注册事件监听
      chunkListener = await CapStreamHttp.addListener('chunk', (data) => {
        // v122: streamId 还没返回时先暂存 —— 此前这一段分块会被直接丢弃
        if (streamId === null) { earlyChunks.push(data); return; }
        if (!data || data.id !== streamId) return;

        // idle timeout：收到任一有效 chunk 即重置计时器
        // 长程思考时模型持续返回 reasoning_content，不会被绝对总时长截断
        resetIdleTimeout();
        consumeChunk(data.chunk);
      });

      endListener = await CapStreamHttp.addListener('end', (data) => {
        if (streamId !== null && data && data.id && data.id !== streamId) return;

        // v122: 三者任一成立即视为「正常收尾」—— 原生 completed 标记 / 收到 [DONE] / 拿到 finish_reason
        const completed = (data && data.completed === true) || sawDone || !!finishReason;
        if (completed) {
          if (finishReason === 'length') {
            done('length', '已达模型单次输出上限，内容可能不完整，可点「继续生成」续写');
          } else {
            done('', '');
          }
          return;
        }

        // 一个 data: 行都没解出来 → 对端没按流式返回（部分中转会忽略 stream:true）
        if (sseEventCount === 0) {
          const salvaged = salvageNonStreamBody(rawText);
          if (salvaged) {
            // 整段到达也走同一个入口：它是「模型产出了一段文本」，不是另一种东西
            if (salvaged.reasoning) applyStreamDelta(assistantMsg, 'reasoning', salvaged.reasoning);
            if (salvaged.content) applyStreamDelta(assistantMsg, 'content', salvaged.content);
            done('', '');
          } else if (gotData) {
            done('truncated', '未收到标准流式数据，可点「继续生成」重试');
          } else {
            resolved = true;
            cleanup();
            reject(new Error('流式响应为空（未收到任何数据）'));
          }
          return;
        }

        // 有内容却没有完成标记 → 连接被提前关闭：保留内容并如实提示
        const hasOutput = (assistantMsg.content && assistantMsg.content !== existingContent) || assistantMsg.reasoningContent;
        if (hasOutput) {
          const detail = (data && data.error) ? '：' + prettyStreamError(data.error) : '';
          done('truncated', '连接被提前中断' + detail + '，回复可能不完整，可点「继续生成」续写');
        } else {
          done('truncated', '未收到有效内容，可点「继续生成」重试');
        }
      });

      errorListener = await CapStreamHttp.addListener('error', (data) => {
        if (streamId !== null && data && data.id && data.id !== streamId) return;
        if (resolved) return;
        if (gotData) {
          // v122: 已经流出一部分才失败 → 按「提前中断」收尾，保留内容、不再自动重发（避免重复计费）
          done('truncated', '连接中断：' + prettyStreamError(data && data.error) + '，回复可能不完整，可点「继续生成」续写');
        } else {
          resolved = true;
          cleanup();
          reject(new Error(prettyStreamError(data && data.error) || '流式请求错误'));
        }
      });

      // 超时（idle 语义：流式数据持续流动时不触发，仅无数据流动超过 waitMs 时触发）
      // 长程思考时模型持续返回 reasoning_content，每次收到 chunk 重置计时器，避免被绝对总时长截断
      function resetIdleTimeout() {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          if (resolved) return;
          if (streamId) {
            try { CapStreamHttp.cancelStream({ id: streamId }); } catch(e) {}
          }
          const secs = Math.round(waitMs / 1000);
          // v122: 超时不再是「静默成功」也不再清空内容 —— 一律保留并交给用户决定是否续写
          done('truncated', gotData
            ? ('已 ' + secs + ' 秒没有新数据，回复可能不完整，可点「继续生成」续写')
            : ('等待 ' + secs + ' 秒仍无响应，可点「继续生成」重试'));
        }, waitMs);
      }
      resetIdleTimeout();

      // 启动流式请求（stream 必须为 true）
      const payload = Object.assign({}, req.payload, { stream: true });
      const result = await CapStreamHttp.startStream({
        url: req.url,
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
        body: JSON.stringify(payload),
        // v122: 原生读超时必须晚于 JS 侧判定，否则原生会先掐断（npm 版写死 30 秒）。
        // 这两个键会被 npm 版插件忽略，因此两条路都安全。
        readTimeoutMs: waitMs + 15000,
        connectTimeoutMs: 30000
      });
      streamId = result.id;

      // v122: 回放暂存下来的早期分块
      if (earlyChunks.length) {
        const queued = earlyChunks.splice(0, earlyChunks.length);
        for (const c of queued) {
          if (!c || (c.id && c.id !== streamId)) continue;
          resetIdleTimeout();
          consumeChunk(c.chunk);
        }
      }

    } catch(err) {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(err);
      }
    }
  });
}

async function executeRequest(req, assistantMsg, opts) {
  const mode = settings.nativeStreamingMode || 'auto';

  if (isCapacitor()) {
    // 尝试方案 C（流式）
    if ((mode === 'stream' || mode === 'auto') && CapStreamHttp) {
      try {
        await executeStreamHttp(req, assistantMsg, opts);
        return;
      } catch(err) {
        // 用户取消不算错误
        if (assistantMsg.interrupted) return;
        // auto 模式下回退到方案 A
        if (mode === 'auto') {
          console.warn('[chat-lite] 流式请求失败，回退到非流式：', err.message);
          // 重置 assistantMsg 状态
          assistantMsg.content = opts.existingContent || '';
          assistantMsg.reasoningContent = opts.existingReasoning || '';
          assistantMsg.interrupted = false;
          assistantMsg.errorMsg = '';
          await executeNativeRequest(req, assistantMsg, opts);
          return;
        }
        // stream 模式下不回退，抛出错误
        throw err;
      }
    }
    // 方案 A 兜底
    await executeNativeRequest(req, assistantMsg, opts);
  } else {
    // 浏览器模式：原有 fetch 流式逻辑保持不变
    // 这部分逻辑在 sendFromMessage / sendFromMessageContinue 里
    return false;  // 返回 false 表示未处理，调用方继续走原有逻辑
  }
}

async function executeNativeRequest(req, assistantMsg, opts) {
  opts = opts || {};
  const existingContent = opts.existingContent || '';
  const existingReasoning = opts.existingReasoning || '';

  // 标记本次请求的取消状态
  state._nativeAborted = false;
  const myAbortFlag = { aborted: false };
  // 标记 typewriter 是否在跑（用于判断 abort 时是否需要立即显示停止标记）
  let typewriterRunning = false;

  // 覆写 state.abortController 的 abort
  // 关键改进：立即恢复 UI，不等 HTTP 响应返回
  if (state.abortController) {
    const origAbort = state.abortController.abort.bind(state.abortController);
    state.abortController.abort = function() {
      myAbortFlag.aborted = true;
      state._nativeAborted = true;
      // 立即恢复 UI 状态（让用户能新建对话、发送新消息）
      state.loading = false;
      state.abortController = null;
      updateSendButton();
      toggleSendStop();
      // 如果 typewriter 还没开始（HTTP 还在等响应），立即显示停止标记
      // 如果 typewriter 在跑，typewriter 自己会处理停止显示
      if (!typewriterRunning) {
        assistantMsg.interrupted = true;
        assistantMsg.errorMsg = '用户打断';
        if (!assistantMsg.content || assistantMsg.content === existingContent) {
          assistantMsg.content = existingContent + '\n\n*[已停止]*';
        } else {
          assistantMsg.content = assistantMsg.content + '\n\n*[已停止]*';
        }
        save();
        renderMessages();
        setStatus('err');
      }
      try { origAbort(); } catch(e) {}
    };
  }

  // v122: 超时配置 —— 与流式路径同源，统一读「常用偏好·等待超时」
  const timeoutMs = resolveChatWaitMs();
  let timeoutId = null;
  let timeoutFired = false;

  const httpOptions = {
    method: 'POST',
    url: req.url,
    headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
    data: typeof req.payload === 'string' ? req.payload : JSON.stringify(req.payload),
    responseType: 'json',
    connectTimeout: 30000,
    readTimeout: timeoutMs
  };

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timeoutFired = true;
      reject(new Error('请求超时（' + (timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      CapHttp.request(httpOptions),
      timeoutPromise
    ]);

    if (timeoutFired) return;
    clearTimeout(timeoutId);

    // 用户已取消，静默丢弃响应（UI 已在 abort 时恢复）
    if (myAbortFlag.aborted) {
      return;
    }

    // 错误响应
    if (response.status >= 400) {
      let errMsg = 'HTTP ' + response.status;
      if (response.data) {
        if (typeof response.data === 'string') {
          try { const j = JSON.parse(response.data); errMsg = j.error?.message || j.detail || errMsg; } catch(e) { errMsg = response.data; }
        } else {
          errMsg = response.data.error?.message || response.data.detail || errMsg;
        }
      }
      throw new Error(errMsg);
    }

    // 解析响应内容
    let respData = response.data;
    if (typeof respData === 'string') {
      try { respData = JSON.parse(respData); } catch(e) {
        throw new Error('响应解析失败：' + e.message);
      }
    }

    const choice = respData && respData.choices && respData.choices[0];
    if (!choice) throw new Error('响应格式异常：缺少 choices');
    const message = choice.message || {};
    const fullContent = existingContent + (message.content || '');
    const fullReasoning = existingReasoning + (message.reasoning_content || message.reasoning || message.thinking || '');

    // 思考链一次性显示
    if (fullReasoning) {
      assistantMsg.reasoningContent = fullReasoning;
      updateMessageContent(assistantMsg.id, existingContent, fullReasoning);
    }

    // content 用打字机动画
    const newContent = message.content || '';
    if (newContent) {
      typewriterRunning = true;
      try {
        await typewriterEffect(assistantMsg, existingContent, newContent, myAbortFlag);
      } finally {
        typewriterRunning = false;
      }
    } else {
      assistantMsg.content = fullContent;
    }

    // 如果动画过程中用户取消了，不再更新
    if (myAbortFlag.aborted) {
      return;
    }

    // 更新 versions
    assistantMsg.versions[0] = { content: fullContent, timestamp: Date.now(), reason: opts.reason || 'original' };
    assistantMsg.content = fullContent;
    save();
    setStatus('ok');
    // v122: 触顶提示 —— 因单次输出上限被截断时如实告知（这不是「抖动」，是模型自己的输出上限）
    if (choice && choice.finish_reason === 'length') {
      assistantMsg.interrupted = true;
      assistantMsg.errorMsg = '已达模型单次输出上限，内容可能不完整，可点「继续生成」续写';
      save();
      renderMessages();
    }
    // v67: 后台完成时缓存通知，切回前台显示
    if (state._isBackground) state._pendingTextNotify = '回复已完成';

  } catch (err) {
    clearTimeout(timeoutId);
    // 用户取消，静默处理（UI 已在 abort 时恢复）
    if (myAbortFlag.aborted || err.name === 'AbortError') {
      return;
    }
    throw err;
  }
}

// ===== 流式发送 =====
// ===== v3.0.8: 联网搜索 = 交给模型的工具 =====
// 这里只做三件事：把工具循环接到消息树上（渲染 / 保存 / 中断），以及把工具轨迹留在气泡里。
// 真正的「模型→工具→模型」循环在 agent-loop.js；工具定义与执行在 web-search.js。

// 工具轨迹的 HTML。默认展开 —— 用户最想知道的就是「它到底搜了什么词」，
// 折起来等于把这件事藏了（和来源卡片不一样：那是结果，这是决策过程）。
// v3.0.12：多两种条目 ——
//   status='skipped' 本轮**一条工具都没走通**（纯对话兜底），标题变「联网搜索未生效」
//   status='note'    说明性文字（例如「本接口不收原生 tools，已改用文本协议」），不影响标题
//   它们必须留在气泡里（而不是只弹一个会消失的 toast）：用户看到一条没有来源卡片的回答时，
//   唯一能解释「为什么没搜」的地方就是这里。
function agentTraceHtml(trace) {
  if (!trace || !trace.length) return '';
  var skipped = 0, called = 0;
  var items = trace.map(function(t) {
    if (t.status === 'skipped' || t.status === 'note') {
      if (t.status === 'skipped') skipped++;
      return '<div class="agent-trace-note">' + escapeHtml(t.summary || '本轮未联网') + '</div>';
    }
    called++;
    var name = t.name === 'fetch_url' ? '抓取网页' : (t.name === 'web_search' ? '搜索' : String(t.name));
    var arg = '';
    var a = t.args || {};
    if (t.name === 'fetch_url') arg = String(a.url || '');
    else if (a.query) arg = '「' + a.query + '」';
    var status = '';
    if (t.status === 'running') status = '<span class="agent-trace-spin"></span>';
    else if (t.status === 'error') status = '失败';
    else status = t.summary || '完成';
    return '<div class="agent-trace-item">' +
      '<span class="agent-trace-name">' + escapeHtml(name) + '</span>' +
      '<span class="agent-trace-arg">' + escapeHtml(arg) + '</span>' +
      '<span class="agent-trace-st">' + status + '</span>' +
    '</div>';
  }).join('');
  var head = called > 0 ? ('已调用 ' + called + ' 个工具') : (skipped > 0 ? '联网搜索未生效' : '联网搜索');
  return '<details class="agent-trace" open>' +
    '<summary class="agent-trace-summary">' + head + '</summary>' +
    '<div class="agent-trace-list">' + items + '</div>' +
  '</details>';
}

// 局部刷新轨迹（不重建整个消息列表 —— 流式期间重建会把刚渲染的正文冲掉再重画）
function updateAgentTrace(assistantMsg) {
  if (!assistantMsg) return;
  var bubble = messagesEl.querySelector('.message[data-id="' + assistantMsg.id + '"] .msg-bubble');
  if (!bubble) return;
  var html = agentTraceHtml(assistantMsg.toolTrace);
  var el = bubble.querySelector('.agent-trace');
  if (!html) { if (el) el.remove(); return; }
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  var node = tmp.firstElementChild;
  if (el) bubble.replaceChild(node, el);
  else bubble.insertBefore(node, bubble.firstChild);
}

// 来源去重（模型可能对同一页搜两次、或先搜到再抓正文 —— 卡片里不该出现两条一样的）
function agentDedupeSources(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var s = list[i];
    if (!s || !s.url || seen[s.url]) continue;
    seen[s.url] = 1;
    out.push({
      title: s.title || s.url,
      url: s.url,
      site: s.siteName || '',
      date: s.date || '',
      authority: (typeof s.authority === 'number') ? s.authority : -1,
      fetched: !!s.fetched
    });
  }
  return out;
}

// 跑一轮「带工具的对话」。返回 true = 已处理完（含按中断/错误收尾）。
//
// v3.0.12：这里**不再判断**「这个接口支不支持工具」，也不再靠错误文案猜（旧的
//   agentIsToolsUnsupported 正则已删）。判断与降级全部在 agent-loop.js 的 agentRunAdaptive 里，
//   依据是「去掉 tools 重发一次成不成功」这条证据 —— 上游用什么错误码表达「不支持」是它的事，
//   客户端不押这个宝。本函数只负责把结果画出来：
//     · toolsDropped = true → 在气泡里留一条「本轮未联网：该模型不支持工具调用」
//     · 真错误 → 抛给 sendFromMessage 的 catch（保持原来的错误气泡行为）
async function runAgentChat(provider, conv, context, assistantMsg) {
  var sources = [];
  var trace = [];
  assistantMsg.toolTrace = trace;

  function renderTrace() {
    try { updateAgentTrace(assistantMsg); } catch (e) {}
  }

  var res;
  try {
    res = await agentRunAdaptive({
      messages: context,
      tools: (typeof WEB_TOOL_DEFS !== 'undefined') ? WEB_TOOL_DEFS : null,
      maxRounds: 4,
      provider: provider,
      model: conv.model,
      // 工具模式一律直连：浏览器模式下的 /api/chat/completions 是本地代理，
      //   它不认识 tools / tool_choice，转发过去只会被丢掉（然后模型"凭空"不调工具）。
      buildRequest: function(msgs, tools) {
        var body = {
          messages: msgs,
          model: conv.model,
          stream: true,
          thinkingEnabled: conv.thinkingEnabled !== false
        };
        if (tools && tools.length) {
          body.tools = tools;
          body.tool_choice = 'auto';
        }
        return buildUpstreamPayload(provider, body);
      },
      execTool: function(name, args) {
        return runWebTool(name, args, {
          collectSources: function(list) { sources = sources.concat(list || []); }
        });
      },
      onDelta: function(kind, text) {
        // 走与其它三条流式路径同一个入口：累加 / 振感 / 节流重绘都收敛在 applyStreamDelta 里。
        // v3.0.11 之前这里是手抄的「累加 + 重绘」，漏了振感 —— 联网一开就没有流式震动。
        applyStreamDelta(assistantMsg, kind === 'content' ? 'content' : 'reasoning', text);
      },
      onToolStart: function(call) {
        trace.push({ name: call.name, args: call.parsedArgs || {}, status: 'running' });
        renderTrace();
        scrollToBottom();
      },
      onToolEnd: function(call, result) {
        for (var i = trace.length - 1; i >= 0; i--) {
          if (trace[i].status === 'running' && trace[i].name === call.name) {
            var meta = result.meta || {};
            trace[i].status = (meta.ok === false) ? 'error' : 'ok';
            if (call.name === 'fetch_url') {
              trace[i].summary = meta.ok === false ? '失败' : ('正文 ' + Math.round((meta.len || 0) / 100) / 10 + 'k 字');
            } else {
              trace[i].summary = (meta.ok === false) ? '失败' : ((meta.count || 0) + ' 条');
            }
            break;
          }
        }
        renderTrace();
      },
      onToolsDropped: function(err, engine) {
        // 这一轮才试出来的（事先不知道）：说一次，别每次发消息都念。
        //   engine='text' → 联网照常，只是换了通道；engine='plain' → 这轮真没搜。
        if (engine === 'text') {
          showToast('「' + (conv.model || '当前模型') + '」这条接口不收原生工具调用，已自动改用文本协议（联网照常）', 'success');
        } else {
          showToast('「' + (conv.model || '当前模型') + '」这条通道这次没走通，本轮按普通对话回答（联网未生效）', 'warn');
        }
      },
      signal: state.abortController ? state.abortController.signal : null
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      assistantMsg.interrupted = true;
      assistantMsg.errorMsg = '用户打断';
      save();
      renderMessages();
      return true;
    }
    // 失败时别把「正在跑」的轨迹留在气泡里一直转圈 —— 它其实已经结束了
    for (var ti = 0; ti < trace.length; ti++) {
      if (trace[ti].status === 'running') trace[ti].status = 'error';
    }
    renderTrace();
    throw e;   // 真错误交给 sendFromMessage 的 catch（保持原来的错误气泡行为）
  }

  // 降级过：把「这一轮用的是哪条工具通道」写进气泡（toast 会消失，气泡不会）
  if (res.engine === 'plain') {
    trace.push({
      name: 'web_search',
      args: {},
      status: 'skipped',
      summary: '本轮未联网：工具通道这次没走通（可稍后重试）'
    });
    renderTrace();
  } else if (res.nativeUnsupported) {
    trace.push({
      name: 'web_search',
      args: {},
      status: 'note',
      summary: '本接口不收原生工具调用，已自动改用文本协议（联网照常，工具调用记录见下方）'
    });
    renderTrace();
  }

  // ---- 收尾 ----
  // 模型可能一次都没调工具（它判断不需要联网）—— 那就和普通回答一样，什么都不加。
  assistantMsg.content = res.content || assistantMsg.content || '';
  assistantMsg.reasoningContent = res.reasoning || assistantMsg.reasoningContent || '';
  var srcs = agentDedupeSources(sources);
  if (srcs.length) assistantMsg.webSources = srcs;
  assistantMsg.versions[0] = { content: assistantMsg.content, timestamp: Date.now(), reason: 'original' };
  if (res.finishReason === 'length') {
    assistantMsg.interrupted = true;
    assistantMsg.errorMsg = '已达模型单次输出上限，内容可能不完整，可点「继续生成」续写';
  }
  if (state._isBackground) state._pendingTextNotify = '回复已完成';
  save();
  setStatus('ok');
  renderMessages();
  scrollToBottom();
  return true;
}

async function sendFromMessage(context) {
  const conv = currentConv();
  if (!conv) return;

  // v3.0.7 / v3.0.10: 会话标题自动命名 —— **分两段，两个入口**。
  //   ① 这里（发送时）：只做**截断占位**（首条消息前 16 字），不发任何请求。
  //      作用是不让用户在等待期间盯着「对话 13」，也不需要它知道标题什么时候会变。
  //   ② 收尾（finally，见本函数末尾）：autoTitleAfterReply —— 回复完成后才问模型要标题，
  //      这样概括的是"这一轮聊成了什么"而不是"你问了什么"。
  //   放这两处而不是 newChat()：新建时还没有任何消息，没东西可概括。
  if (typeof autoTitlePlaceholder === 'function') autoTitlePlaceholder(conv);

  state.loading = true;
  // Create AbortController for this request
  state.abortController = new AbortController();
  updateSendButton();
  toggleSendStop();
  setStatus('busy');

  // Add placeholder assistant message (tree node)
  const lastUser = getLastActiveMsg(conv);
  const assistantMsg = {
    id: uid(),
    role: 'assistant',
    content: '',
    reasoningContent: '',
    parentId: lastUser ? lastUser.id : conv.rootId,
    children: [],
    title: '回复',
    wordCount: 0,
    versions: [{ content: '', timestamp: Date.now(), reason: 'original' }],
    activeVersion: 0,
    files: [],
    createdAt: Date.now()
  };
  conv.messageMap[assistantMsg.id] = assistantMsg;
  if (lastUser) lastUser.children.push(assistantMsg.id);
  conv.activePath.push(assistantMsg.id);
  save();
  renderMessages();

  const lastMsgEl = messagesEl.lastElementChild;
  if (lastMsgEl) {
    const bubble = lastMsgEl.querySelector('.msg-bubble');
    if (bubble) bubble.classList.add('cursor-blink');
  }

  try {
    // Provider routing
  var provider = getProvider(conv.providerId);
  if (!provider) {
    assistantMsg.content = '**错误：** 请先在设置中添加接口';
    save(); renderMessages(); state.loading = false;
    toggleSendStop(); scrollToBottom(); return;
  }
  var isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('172.') || window.location.hostname.startsWith('10.') || window.location.hostname.endsWith('.local');
  var useDirect = isCapacitor() || settings.directMode || !isLocal;

  // ===== v3.0.8: 联网搜索 = 交给模型的工具 =====
  //   开关打开时，把 web_search / fetch_url 作为 tools 交给模型，**由它自己决定**要不要调、用什么词、调几次。
  //   （v3.0.5 是"拿到用户那句话直接去搜、结果硬塞进上下文"，那不是工具，是检索管道 —— 模型没有选择权。）
  //   v3.0.12：这里**不再**假设「接口支持 tools」。模型不支持时（如 kkaiapi 上的 gemini）由
  //   agentRunAdaptive 自己降级成普通对话，本函数只等结果 —— 联网失败绝不能让对话失败。
  if (typeof agentRunAdaptive === 'function' && typeof webSearchEnabled === 'function' && webSearchEnabled(conv)) {
    var wsReady = (typeof wsResolveTarget === 'function') ? wsResolveTarget() : { ok: false, reason: '联网搜索未就绪' };
    if (!wsReady.ok) {
      // 没配密钥/地址：不阻断这轮对话，只是没有工具可用
      showToast(wsReady.reason + '（本轮仍会正常回答，只是不能联网）', 'warn');
    } else {
      await runAgentChat(provider, conv, context, assistantMsg);
      return;
    }
  }

  var reqBody = {
    messages: context,
    model: conv.model,
    stream: !isCapacitor(),
    thinkingEnabled: conv.thinkingEnabled !== false
  };

  var req;
  if (useDirect) {
    req = buildUpstreamPayload(provider, reqBody);
  } else {
    req = {
      url: '/api/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      payload: Object.assign({}, reqBody, { provider: provider })
    };
  }

  // Capacitor 模式：走 executeRequest（根据配置选择流式/非流式）
  if (isCapacitor() && (CapHttp || CapStreamHttp)) {
    await executeRequest(req, assistantMsg, { reason: 'original' });
    return;
  }

  const resp = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.payload),
    signal: state.abortController?.signal
  });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 唯一真源是 assistantMsg 本身：增量的累加、重绘、振感都在 applyStreamDelta 里做，
    // 这里不再另存一份 fullContent（两份副本迟早会分叉）。

    // v122: web 流式路径此前完全没有超时 —— 请求卡住就永远等下去。
    // 这里补上与 APK 侧同源的空闲超时 + 完成度判定（用 var，catch 里也要读）
    var webWaitMs = resolveChatWaitMs();
    var webIdleTimer = null;
    var webSawDone = false;
    var webFinishReason = null;
    var webTimeoutReason = '';
    var webResetIdle = function() {
      clearTimeout(webIdleTimer);
      webIdleTimer = setTimeout(function() {
        webTimeoutReason = '已 ' + Math.round(webWaitMs / 1000) + ' 秒没有新数据，回复可能不完整，可点「继续生成」续写';
        try { if (state.abortController) state.abortController.abort(); } catch(e) {}
      }, webWaitMs);
    };
    webResetIdle();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      webResetIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.indexOf('data:') !== 0) continue;   // v122: 兼容 "data:" 与 "data: "
        const data = line.slice(5).trim();
        if (data === '[DONE]') { webSawDone = true; continue; }
        try {
          const json = JSON.parse(data);
          const ch0 = json.choices && json.choices[0];
          if (ch0 && ch0.finish_reason) webFinishReason = ch0.finish_reason;
          const delta = ch0 && ch0.delta;
          if (delta) {
            var reasoningText = delta.reasoning_content || delta.thinking || delta.chain_of_thought || '';
            if (reasoningText) applyStreamDelta(assistantMsg, 'reasoning', reasoningText);
            if (delta.content) applyStreamDelta(assistantMsg, 'content', delta.content);
          }
        } catch(e) {
          // Skip malformed lines
        }
      }
    }
    clearTimeout(webIdleTimer);

    // v122: 完成度收尾 —— ① 触顶 ② 没有完成标记就被关闭，都保留内容并如实标记
    if (webFinishReason === 'length') {
      assistantMsg.interrupted = true;
      assistantMsg.errorMsg = '已达模型单次输出上限，内容可能不完整，可点「继续生成」续写';
      assistantMsg.versions[0] = { content: assistantMsg.content || '', timestamp: Date.now(), reason: 'original' };
      save();
      renderMessages();
    } else if (!webSawDone && !webFinishReason && (assistantMsg.content || assistantMsg.reasoningContent)) {
      assistantMsg.interrupted = true;
      assistantMsg.errorMsg = '连接被提前中断，回复可能不完整，可点「继续生成」续写';
      assistantMsg.versions[0] = { content: assistantMsg.content || '', timestamp: Date.now(), reason: 'original' };
      save();
      renderMessages();
      setStatus('err');
      return;
    }

    // Update versions
    assistantMsg.versions[0] = { content: assistantMsg.content || '', timestamp: Date.now(), reason: 'original' };
    save();
    setStatus('ok');
    // v67: 后台完成时缓存通知，切回前台显示
    if (state._isBackground) state._pendingTextNotify = '回复已完成';

  } catch (err) {
    console.error('Send error:', err);
    // 保留已生成内容，标记为中断
    assistantMsg.interrupted = true;
    // v122: 空闲超时触发的 abort 要如实说明是「等待超时」，不能混成「用户打断」
    // v3.0.12: 错误文案统一在这里过一遍 prettyStreamError —— 之前只有原生流式那条路做了，
    //   agent 路径把原生带回来的 `HTTP 503: {…}` 整段 JSON 直接甩进气泡（同一个问题两种待遇，
    //   正是 §4.26 说的「同一件事写了 N 遍」）。现在四条路径一个出口。
    var errText = (typeof prettyStreamError === 'function') ? prettyStreamError(err && err.message) : (err && err.message);
    assistantMsg.errorMsg = webTimeoutReason || (err.name === 'AbortError' ? '用户打断' : errText);
    if (!assistantMsg.content) {
      // 如果完全没有内容，才显示错误
      assistantMsg.content = `**错误：** ${escapeHtml(errText)}`;
      assistantMsg.isError = true;
    }
    save();
    renderMessages();
    setStatus('err');
  } finally {
    state.loading = false;
    state.abortController = null;
    // 流式收尾的统一清理点：任何路径（含联网的 agent 路径）都在这里摘掉「正在流式」标记
    state._streamingMsg = null;
    updateSendButton();
    toggleSendStop();
    // v3.0.10: 回复完成 → 才问模型要会话标题。
    //   为什么这个 finally 就是**文本侧唯一的收尾点**：web 流式 / APK 真流式 / APK 非流式 /
    //   v3.0.8 的 agent 路径 / 报错 / 用户中断 —— 它们的 return 全都写在 try 里，必然经过这里。
    //   有内容才命名（打断了但有半截也算）；空回复或出错时保留发送时那个截断占位。
    if (typeof autoTitleAfterReply === 'function') autoTitleAfterReply(conv, assistantMsg);
    renderMessages();
    scrollToBottom();
  }
}

async function sendFromMessageContinue(context, assistantMsg) {
  const conv = currentConv();
  if (!conv) return;

  state.loading = true;
  state.abortController = new AbortController();
  updateSendButton();
  toggleSendStop();
  setStatus('busy');

  // Save existing content for continuation
  const existingContent = assistantMsg.content || '';
  const existingReasoning = assistantMsg.reasoningContent || '';

  renderMessages();
  const lastMsgEl = messagesEl.querySelector(`.message[data-id="${assistantMsg.id}"] .msg-bubble`);
  if (lastMsgEl) lastMsgEl.classList.add('cursor-blink');

  try {
    var provider = getProvider(conv.providerId);
    if (!provider) {
      assistantMsg.content = existingContent + '\n\n**错误：** 请先在设置中添加接口';
      save(); renderMessages(); state.loading = false;
      toggleSendStop(); scrollToBottom(); return;
    }
    var isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('172.') || window.location.hostname.startsWith('10.') || window.location.hostname.endsWith('.local');
    var useDirect = settings.directMode || !isLocal;

    var reqBody = {
      messages: context,
      model: conv.model,
      stream: !isCapacitor(),
      thinkingEnabled: conv.thinkingEnabled !== false
    };

    var req;
    if (useDirect) {
      req = buildUpstreamPayload(provider, reqBody);
    } else {
      req = {
        url: '/api/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        payload: Object.assign({}, reqBody, { provider: provider })
      };
    }

    // Capacitor 模式：走 executeRequest（根据配置选择流式/非流式）
    if (isCapacitor() && (CapHttp || CapStreamHttp)) {
      await executeRequest(req, assistantMsg, {
        existingContent: existingContent,
        existingReasoning: existingReasoning,
        reason: 'continued'
      });
      return;
    }

    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.payload),
      signal: state.abortController?.signal
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 续写的「已有内容」就在 assistantMsg 里（existingContent 就是它的快照），
    // 增量统一由 applyStreamDelta 追加，不再维护 fullContent 副本。

    // v122: 与 sendFromMessage 同源的空闲超时 + 完成度判定
    var webWaitMs = resolveChatWaitMs();
    var webIdleTimer = null;
    var webSawDone = false;
    var webFinishReason = null;
    var webTimeoutReason = '';
    var webResetIdle = function() {
      clearTimeout(webIdleTimer);
      webIdleTimer = setTimeout(function() {
        webTimeoutReason = '已 ' + Math.round(webWaitMs / 1000) + ' 秒没有新数据，回复可能不完整，可点「继续生成」续写';
        try { if (state.abortController) state.abortController.abort(); } catch(e) {}
      }, webWaitMs);
    };
    webResetIdle();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      webResetIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.indexOf('data:') !== 0) continue;   // v122: 兼容 "data:" 与 "data: "
        const data = line.slice(5).trim();
        if (data === '[DONE]') { webSawDone = true; continue; }
        try {
          const json = JSON.parse(data);
          const ch0 = json.choices && json.choices[0];
          if (ch0 && ch0.finish_reason) webFinishReason = ch0.finish_reason;
          const delta = ch0 && ch0.delta;
          if (delta) {
            var reasoningText2 = delta.reasoning_content || delta.thinking || delta.chain_of_thought || '';
            if (reasoningText2) applyStreamDelta(assistantMsg, 'reasoning', reasoningText2);
            if (delta.content) applyStreamDelta(assistantMsg, 'content', delta.content);
          }
        } catch(e) {}
      }
    }
    clearTimeout(webIdleTimer);

    // v122: 完成度收尾（与 sendFromMessage 同规则）
    if (webFinishReason === 'length') {
      assistantMsg.interrupted = true;
      assistantMsg.errorMsg = '已达模型单次输出上限，内容可能不完整，可点「继续生成」续写';
      save();
      renderMessages();
    } else if (!webSawDone && !webFinishReason &&
               ((assistantMsg.content || '') !== existingContent || (assistantMsg.reasoningContent || '') !== existingReasoning)) {
      assistantMsg.interrupted = true;
      assistantMsg.errorMsg = '连接被提前中断，回复可能不完整，可点「继续生成」续写';
      assistantMsg.versions[0] = { content: assistantMsg.content || '', timestamp: Date.now(), reason: 'continued' };
      save();
      renderMessages();
      setStatus('err');
      return;
    }

    assistantMsg.versions[0] = { content: assistantMsg.content || '', timestamp: Date.now(), reason: 'continued' };
    save();
    setStatus('ok');
    // v67: 后台完成时缓存通知，切回前台显示
    if (state._isBackground) state._pendingTextNotify = '回复已完成';

  } catch (err) {
    console.error('Continue error:', err);
    assistantMsg.interrupted = true;
    var contErrText = (typeof prettyStreamError === 'function') ? prettyStreamError(err && err.message) : (err && err.message);
    assistantMsg.errorMsg = webTimeoutReason || (err.name === 'AbortError' ? '用户打断' : contErrText);
    save();
    renderMessages();
    setStatus('err');
  } finally {
    state.loading = false;
    state.abortController = null;
    // 流式收尾的统一清理点：任何路径（含联网的 agent 路径）都在这里摘掉「正在流式」标记
    state._streamingMsg = null;
    updateSendButton();
    toggleSendStop();
    renderMessages();
    scrollToBottom();
  }
}

function typewriterEffect(msg, baseContent, newContent, abortFlag) {
  return new Promise((resolve) => {
    if (!newContent) { resolve(); return; }

    let i = 0;
    const chunkSize = 3;        // 每次显示 3 个字符
    const intervalMs = 20;      // 50fps
    let lastMarkdownRender = 0;
    const MARKDOWN_RENDER_INTERVAL = 300;  // markdown 渲染节流间隔

    // 初始渲染（创建 rendered-content div）
    updateMessageContent(msg.id, baseContent, msg.reasoningContent || '');

    const tick = () => {
      // 用户取消
      if (abortFlag && abortFlag.aborted) {
        msg.content = baseContent + newContent.slice(0, i) + '\n\n*[已停止]*';
        msg.interrupted = true;
        updateMessageContent(msg.id, msg.content, msg.reasoningContent || '');
        save();
        resolve();
        return;
      }
      i = Math.min(i + chunkSize, newContent.length);
      msg.content = baseContent + newContent.slice(0, i);

      const now = Date.now();
      const el = messagesEl.querySelector(`.message[data-id="${msg.id}"] .msg-bubble .rendered-content`);
      if (now - lastMarkdownRender > MARKDOWN_RENDER_INTERVAL) {
        // 节流的 markdown 渲染（解析格式）
        updateMessageContent(msg.id, msg.content, msg.reasoningContent || '');
        lastMarkdownRender = now;
      } else if (el) {
        // 快速 textContent 更新（纯文本，极快，不闪烁）
        el.textContent = msg.content;
        scrollToBottom();
      }

      if (i >= newContent.length) {
        // 最终完整渲染
        updateMessageContent(msg.id, msg.content, msg.reasoningContent || '');
        resolve();
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ===== UI 状态 =====
function toggleSendStop() {
  var send = document.getElementById('btn-send');
  var stop = document.getElementById('btn-stop');
  if (send) send.style.display = state.loading ? 'none' : 'flex';
  if (stop) stop.style.display = state.loading ? 'flex' : 'none';
}
function updateSendButton() {
  const hasText = chatInput.innerText.trim().length > 0;
  // v3.0.6: 附件先占位、再异步填内容 —— loading 中的那条还不算"可以发"
  const hasFiles = state.pendingFiles?.some(f => f && !f.loading);
  btnSend.disabled = (!hasText && !hasFiles) || state.loading;
}
function setStatus(type) {
  statusIndicator.className = type === 'ok' ? 'status-ok' : type === 'err' ? 'status-err' : 'status-ok';
}
