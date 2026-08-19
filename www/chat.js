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

function renderContent(msg) {
  let html = '';

  // Reasoning content (collapsible, if exists)
  if (msg.reasoningContent) {
    html += `<details class="reasoning-details">
      <summary class="reasoning-summary">思考过程</summary>
      <div class="reasoning-content">${escapeHtml(msg.reasoningContent)}</div>
    </details>`;
  }

  // File attachments
  if (msg.files && msg.files.length > 0) {
    html += msg.files.map(f =>
      `<div class="file-tag" style="margin-bottom:4px">${escapeHtml(f.name)} (${formatSize(f.size)})</div>`
    ).join('');
  }

  if (msg.isFileOnly) return html;

  // Markdown content
  const rendered = marked.parse(msg.content || '', { breaks: true, gfm: true });
  html += rendered;

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
    var statusHtml = marked.parse(statusMatch[1].trim(), { breaks: true, gfm: true });
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
    if (rContent) rContent.textContent = reasoning;
  } else if (reasoningEl) {
    reasoningEl.remove();
  }

  // Content area
  let contentEl = el.querySelector('.rendered-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'rendered-content';
    const actions = el.querySelector('.msg-actions');
    if (actions) {
      el.insertBefore(contentEl, actions);
    } else {
      el.appendChild(contentEl);
    }
  }
  contentEl.innerHTML = marked.parse(content || '', { breaks: true, gfm: true });

  // Highlight code blocks
  contentEl.querySelectorAll('pre code').forEach(block => {
    if (typeof hljs !== 'undefined') {
      hljs.highlightElement(block);
    }
  });

  scrollToBottom();
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
function buildContext(conv) {
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
    let content = m.content;
    content = buildFileContent(m);
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
  let lastRenderTime = 0;
  const RENDER_INTERVAL = 100;  // markdown 渲染节流（100ms，约 10fps）

  // 超时
  const timeoutMs = settings.nativeTimeoutMs || 120000;
  let timeoutId = null;

  // 设置 abort（用于停止生成）
  state.abortController = new AbortController();
  const origAbort = state.abortController.abort.bind(state.abortController);
  state.abortController.abort = function() {
    if (streamId) {
      try { CapStreamHttp.cancelStream({ id: streamId }); } catch(e) {}
    }
    try { origAbort(); } catch(e) {}
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

    function done(interrupted) {
      if (resolved) return;
      resolved = true;
      cleanup();
      state._streamingMsg = null;  // 清除流式消息标记
      if (interrupted) {
        assistantMsg.interrupted = true;
        assistantMsg.errorMsg = '用户打断';
        if (!assistantMsg.content || assistantMsg.content === existingContent) {
          assistantMsg.content = existingContent + '\n\n*[已停止]*';
        }
      }
      // 最终渲染 + 保存
      updateMessageContent(assistantMsg.id, assistantMsg.content, assistantMsg.reasoningContent || '');
      assistantMsg.versions[0] = {
        content: assistantMsg.content,
        timestamp: Date.now(),
        reason: opts.reason || 'original'
      };
      save();
      resolve();
    }

    try {
      // 注册事件监听
      chunkListener = await CapStreamHttp.addListener('chunk', (data) => {
        if (data.id !== streamId) return;

        // idle timeout：收到任一有效 chunk 即重置计时器
        // 长程思考时模型持续返回 reasoning_content，不会被绝对总时长截断
        resetIdleTimeout();

        chunkBuffer += data.chunk;
        const lines = chunkBuffer.split('\n');
        chunkBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const json = JSON.parse(jsonStr);
            const choice = json.choices && json.choices[0];
            if (!choice) continue;
            const delta = choice.delta;
            if (!delta) continue;

            // 思考链增量
            const reasoningText = delta.reasoning_content || delta.thinking || delta.chain_of_thought || '';
            if (reasoningText) {
              assistantMsg.reasoningContent = (assistantMsg.reasoningContent || '') + reasoningText;
            }

            // 内容增量
            if (delta.content) {
              assistantMsg.content = (assistantMsg.content || '') + delta.content;
              // C3: 流式振感反馈（默认关，节流 100ms）
              triggerHapticFeedback(delta.content);
            }

            // 渲染节流：触摸滚动时暂停 DOM 更新（避免 innerHTML 重建阻塞 touchmove）
            const now = Date.now();
            if (!state._isTouching && now - lastRenderTime > RENDER_INTERVAL) {
              updateMessageContent(assistantMsg.id, assistantMsg.content, assistantMsg.reasoningContent || '');
              lastRenderTime = now;
            }
            if (!state._isTouching) scrollToBottom();
          } catch(e) {}
        }
      });

      endListener = await CapStreamHttp.addListener('end', (data) => {
        if (data.id !== streamId) return;
        done(false);
      });

      errorListener = await CapStreamHttp.addListener('error', (data) => {
        if (data.id !== streamId) return;
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(data.error || '流式请求错误'));
      });

      // 超时（idle 语义：流式数据持续流动时不触发，仅无数据流动超过 timeoutMs 时触发）
      // 长程思考时模型持续返回 reasoning_content，每次收到 chunk 重置计时器，避免被绝对总时长截断
      function resetIdleTimeout() {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          if (streamId) {
            try { CapStreamHttp.cancelStream({ id: streamId }); } catch(e) {}
          }
          if (resolved) return;
          resolved = true;
          cleanup();
          reject(new Error('请求超时（' + (timeoutMs / 1000) + ' 秒无数据流动）'));
        }, timeoutMs);
      }
      resetIdleTimeout();

      // 启动流式请求（stream 必须为 true）
      const payload = Object.assign({}, req.payload, { stream: true });
      const result = await CapStreamHttp.startStream({
        url: req.url,
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
        body: JSON.stringify(payload)
      });
      streamId = result.id;

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

  // 超时配置（默认 120 秒）
  const timeoutMs = (settings.nativeTimeoutMs || 120000);
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
async function sendFromMessage(context) {
  const conv = currentConv();
  if (!conv) return;

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
    let fullContent = '';
    let fullReasoning = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta) {
            var reasoningText = delta.reasoning_content || delta.thinking || delta.chain_of_thought || '';
            if (reasoningText) {
              fullReasoning += reasoningText;
              assistantMsg.reasoningContent = fullReasoning;
            }
            if (delta.content) {
              fullContent += delta.content;
              assistantMsg.content = fullContent;
              triggerHapticFeedback(delta.content); // C3: web 流式路径也触发振感（保险）
            }
            // Update display: pass both reasoning and content
            updateMessageContent(assistantMsg.id, fullContent, fullReasoning);
          }
        } catch(e) {
          // Skip malformed lines
        }
      }
    }

    // Update versions
    assistantMsg.versions[0] = { content: fullContent, timestamp: Date.now(), reason: 'original' };
    save();
    setStatus('ok');
    // v67: 后台完成时缓存通知，切回前台显示
    if (state._isBackground) state._pendingTextNotify = '回复已完成';

  } catch (err) {
    console.error('Send error:', err);
    // 保留已生成内容，标记为中断
    assistantMsg.interrupted = true;
    assistantMsg.errorMsg = err.name === 'AbortError' ? '用户打断' : err.message;
    if (!assistantMsg.content) {
      // 如果完全没有内容，才显示错误
      assistantMsg.content = `**错误：** ${escapeHtml(err.message)}`;
      assistantMsg.isError = true;
    }
    save();
    renderMessages();
    setStatus('err');
  } finally {
    state.loading = false;
    state.abortController = null;
    updateSendButton();
    toggleSendStop();
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
    let fullContent = existingContent;
    let fullReasoning = existingReasoning;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta) {
            var reasoningText2 = delta.reasoning_content || delta.thinking || delta.chain_of_thought || '';
            if (reasoningText2) {
              fullReasoning += reasoningText2;
              assistantMsg.reasoningContent = fullReasoning;
            }
            if (delta.content) {
              fullContent += delta.content;
              assistantMsg.content = fullContent;
              triggerHapticFeedback(delta.content); // C3: web 流式路径也触发振感（保险）
            }
            updateMessageContent(assistantMsg.id, fullContent, fullReasoning);
          }
        } catch(e) {}
      }
    }

    assistantMsg.versions[0] = { content: fullContent, timestamp: Date.now(), reason: 'continued' };
    save();
    setStatus('ok');
    // v67: 后台完成时缓存通知，切回前台显示
    if (state._isBackground) state._pendingTextNotify = '回复已完成';

  } catch (err) {
    console.error('Continue error:', err);
    assistantMsg.interrupted = true;
    assistantMsg.errorMsg = err.name === 'AbortError' ? '用户打断' : err.message;
    save();
    renderMessages();
    setStatus('err');
  } finally {
    state.loading = false;
    state.abortController = null;
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
  const hasFiles = state.pendingFiles?.length > 0;
  btnSend.disabled = (!hasText && !hasFiles) || state.loading;
}
function setStatus(type) {
  statusIndicator.className = type === 'ok' ? 'status-ok' : type === 'err' ? 'status-err' : 'status-ok';
}
