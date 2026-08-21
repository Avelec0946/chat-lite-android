// ===== conversation.js : 会话管理模块（v2.0 拆分）=====
// 模块名：conversation.js
// 版本：v83（cache-bust）
// 迁移日期：2026-07-26
// 来源：从 app.js 拆分
// 职责：会话模型、会话列表渲染、消息渲染、分支树（SVG）、分支搜索、长按菜单、冲突对话框
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / escapeHtml / showToast /
//       ICON / uid / $ / convList / messagesEl / currentConv / isCapacitor / CapFilesystem /
//       parseJsonField / normalizeBaseUrl / getProvider / modelToUpstreamId / parseImageActualSize
// 加载顺序：在 db.js + haptics.js + providers.js + image-gen.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   会话模型：migrateV1toV2, newConversation, getMsg, getActiveChain, getLastActiveMsg,
//             computeBranchWords, getBranchPath, getBranchPathFromMap, restoreConversationState
//   会话渲染：renderSidebar, switchConversation, renderBreadcrumb, renderMessages,
//             showConflictDialog
//   交互：addLongPress, showBubbleContextMenu
//   分支树：renderTreeSVG, escapeSvg, svgNodeClick, svgNodeMenu, applyBranchZoom,
//           applyBranchCenter, showTreeNodeMenu, closeTreeNodeMenu, bindTreeNodeLongPress
//   分支搜索：openBranchDrawer, closeBranchDrawer, doBranchSearch, renderSearchResults,
//             navigateToSearchResult, branchSearchResults, branchSearchIdx
//
// 保留在 app.js：
//   const state = {...}  // 全局状态对象
//   const $ = id => document.getElementById(id)  // DOM 引用
//   const convList / messagesEl  // DOM 元素引用
//   saveConversation / deleteConversation  // 持久化（与 db.js 相关）
//   init / 事件绑定  // 应用入口

// ===== 会话模型 + 树辅助 =====
function migrateV1toV2(conv) {
  const map = {};
  const oldMsgs = conv.messages || [];
  if (oldMsgs.length === 0) {
    const rootId = uid();
    map[rootId] = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
    conv.rootId = rootId;
    conv.activePath = [rootId];
    conv.messageMap = map;
    delete conv.messages;
    return;
  }
  // Build tree from linear array
  const rootId = uid();
  map[rootId] = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  let prevId = rootId;
  const path = [rootId];
  for (const m of oldMsgs) {
    const id = m.id || uid();
    map[id] = {
      ...m,
      parentId: prevId,
      children: [],
      wordCount: countWords(m.content || ''),
      versions: m.versions || [{ content: m.content || '', timestamp: Date.now(), reason: 'original' }],
      activeVersion: m.activeVersion || 0
    };
    map[prevId].children.push(id);
    prevId = id;
    path.push(id);
  }
  conv.rootId = rootId;
  conv.activePath = path;
  conv.messageMap = map;
  delete conv.messages;
}

function newConversation() {
  const msgId = uid();
  const rootMsg = {
    id: msgId, role: 'system', content: '',
    parentId: null, children: [],
    title: '对话根节点', wordCount: 0,
    versions: [{ content: '', timestamp: Date.now(), reason: 'original' }],
    activeVersion: 0, files: [], editing: false, createdAt: Date.now()
  };
  return {
    id: uid(),
    title: '新对话',
    model: (state.providers && state.providers[0] && state.providers[0].models && state.providers[0].models[0] && state.providers[0].models[0].id) || 'deepseek-v4-flash',
    providerId: (state.providers && state.providers[0] && state.providers[0].id) || null,
    rootId: msgId,
    activePath: [msgId],
    messageMap: { [msgId]: rootMsg },
    createdAt: Date.now()
  };
}

function getMsg(conv, id) { return conv.messageMap[id]; }

function getActiveChain(conv) {
  return conv.activePath.map(id => conv.messageMap[id]).filter(Boolean);
}

function getLastActiveMsg(conv) {
  const chain = getActiveChain(conv);
  return chain[chain.length - 1] || null;
}

function computeBranchWords(conv, fromId) {
  let total = 0, visited = new Set(), stack = [fromId];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const msg = conv.messageMap[id];
    if (msg) {
      total += countWords(msg.content);
      stack.push(...(msg.children || []));
    }
  }
  return total;
}

function getBranchPath(conv, leafId) {
  const path = [];
  let current = leafId;
  while (current) {
    path.unshift(current);
    const msg = conv.messageMap[current];
    if (!msg || !msg.parentId) break;
    current = msg.parentId;
  }
  return path;
}

// ===== 会话渲染 =====
function restoreConversationState() {
  if (state.conversations.length === 0) {
    const conv = newConversation();
    conv.title = '对话 1';
    state.conversations.push(conv);
    state.currentId = conv.id;
    save();
  }
}

function showConflictDialog(conflicts) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('conflict-dialog');
    var msg = document.getElementById('conflict-msg');
    var summary = document.getElementById('conflict-summary');
    
    // Build summary of conflicts
    var items = conflicts.map(function(cf) {
      var localTime = new Date(cf.local.updatedAt || 0).toLocaleTimeString();
      var serverTime = new Date(cf.server.updatedAt || 0).toLocaleTimeString();
      var localPreview = (cf.local.title || '无标题').substring(0, 40);
      var serverPreview = (cf.server.title || '无标题').substring(0, 40);
      return '<div class="conflict-item">' +
        '<div class="diff-head">' + localPreview + '</div>' +
        '<div class="diff-preview">本地修改: ' + localTime + '</div>' +
        '<div class="diff-preview">服务端修改: ' + serverTime + '</div>' +
        '</div>';
    }).join('');
    
    msg.textContent = '发现 ' + conflicts.length + ' 个对话在两边都有修改，请选择保留哪一方的数据：';
    summary.innerHTML = items;
    overlay.style.display = 'flex';
    
    function finish(choice) {
      overlay.style.display = 'none';
      // Clean up listeners
      var localBtn = document.getElementById('btn-conflict-local');
      var serverBtn = document.getElementById('btn-conflict-server');
      var cancelBtn = document.getElementById('btn-conflict-cancel');
      localBtn.replaceWith(localBtn.cloneNode(true));
      serverBtn.replaceWith(serverBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      resolve(choice);
    }
    
    document.getElementById('btn-conflict-local').addEventListener('click', function() {
      finish('local');
    }, {once: true});
    
    document.getElementById('btn-conflict-server').addEventListener('click', function() {
      finish('server');
    }, {once: true});
    
    document.getElementById('btn-conflict-cancel').addEventListener('click', function() {
      finish('cancel');
    }, {once: true});
  });
}

function renderSidebar() {
  const query = (document.getElementById('conv-search-input')?.value || '').trim().toLowerCase();
  const filtered = query 
    ? state.conversations.filter(c => c.title.toLowerCase().includes(query))
    : state.conversations;
  convList.innerHTML = filtered.map(c =>
    `<div class="conv-item${c.id === state.currentId ? ' active' : ''}" data-id="${c.id}">
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <button class="del-btn" data-id="${c.id}" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
    </div>`
  ).join('');

  // Click to switch
  convList.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (isLongPress) { isLongPress = false; return; }
      if (e.target.classList.contains('del-btn')) return;
      if (e.target.tagName === 'INPUT') return;
      switchConversation(el.dataset.id);
    });
  });

  // Rename conversation — only on long-press
  convList.querySelectorAll('.conv-title').forEach(span => {
    span.addEventListener('click', (e) => {
      const convItem = span.closest('.conv-item');
      if (!convItem || !convItem.classList.contains('long-press')) return;
      e.stopPropagation();
      const id = convItem.dataset.id;
      const conv = state.conversations.find(c => c.id === id);
      if (!conv) return;
      const oldTitle = conv.title;
      const input = document.createElement('input');
      input.className = 'conv-rename-input';
      input.value = oldTitle;
      input.addEventListener('blur', () => {
        conv.title = input.value.trim() || oldTitle;
        conv.updatedAt = Date.now();
        save();
        renderSidebar();
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = oldTitle; input.blur(); }
      });
      span.innerHTML = '';
      span.appendChild(input);
      input.focus();
      input.select();
    });
  });

  // Delete
  convList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      state.deletedIds = state.deletedIds || [];
      if (state.deletedIds.indexOf(id) < 0) state.deletedIds.push(id);
      if (state.conversations.length <= 1) { newChat(); return; }
      state.conversations = state.conversations.filter(c => c.id !== id);
      if (state.currentId === id) {
        state.currentId = state.conversations[state.conversations.length - 1].id;
        restoreConversationState();
      }
      save();
      renderSidebar();
      renderMessages();
      applyBackgroundImage();
      syncModelSelector();
    });
  });
}

function switchConversation(id) {
  if (state.loading) return;
  state.currentId = id;
  save();
  renderSidebar();
  renderMessages();
  applyBackgroundImage();
  syncModelSelector();
}

function renderBreadcrumb(conv) {
  const bar = document.getElementById('breadcrumb-bar');
  if (!bar) return;
  const chain = getActiveChain(conv);
  const display = chain.filter(m => m && m.role !== 'system');
  if (display.length < 1) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  let html = '';
  display.forEach((m, i) => {
    const label = m.title || m.content.substring(0, 20) + (m.content.length > 20 ? '...' : '') || '(空)';
    const icon = m.role === 'user' ? ICON.user : ICON.bot;
    const isLast = i === display.length - 1;
    // Show sibling count if this is the last node and parent has multiple children
    const children = m.children || [];
    const siblingLabel = (isLast && children.length > 1) ? ` +${children.length - 1}` : '';
    html += `<span class="breadcrumb-segment${isLast ? ' active' : ''}" data-id="${m.id}">${icon} ${escapeHtml(label)}${siblingLabel ? `<span style="font-size:10px;color:var(--text2)">${siblingLabel}</span>` : ''}</span>`;
    if (!isLast) html += '<span class="breadcrumb-sep">▸</span>';
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.breadcrumb-segment').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const newPath = getBranchPath(conv, id);
      conv.activePath = newPath;
      save();
      renderMessages();
      renderBreadcrumb(conv);
    });
  });
}

function renderMessages() {
  const conv = currentConv();
  messagesEl.innerHTML = '';
  emptyState.style.display = 'none';

  if (!conv || !conv.rootId) {
    emptyState.style.display = 'block';
    return;
  }

  const chain = getActiveChain(conv);
  // Filter out root system message for display
  const displayMsgs = chain.filter(m => m && m.role !== 'system');

  if (displayMsgs.length === 0) {
    emptyState.style.display = 'block';
    return;
  }

  displayMsgs.forEach((msg, idx) => {
    const isLastMsg = idx === displayMsgs.length - 1;
    const isSelected = state.selectedMsgId === msg.id;
    const div = document.createElement('div');
    div.className = `message ${msg.role}${msg.editing ? ' message-editing' : ''}${isSelected ? ' msg-selected' : ''}`;
    div.dataset.id = msg.id;

    const content = msg.editing ? renderEditMode(msg) : renderContent(msg);
    const deleteBtnHtml = `<button class="msg-action-btn delete-btn" title="删除">删除</button>`;

    div.innerHTML = `
      <div class="msg-bubble">
        ${msg.title && msg.title !== '对话根节点' ? `<div class="msg-title">${escapeHtml(msg.title)}</div>` : ''}
        ${content}
        ${renderSiblingArrows(msg, conv)}
        ${msg.role === 'assistant' && !msg.editing ? `
        <div class="msg-actions">
          <button class="msg-action-btn edit-btn" title="编辑">编辑</button>
          <button class="msg-action-btn regenerate-btn" title="重新生成" ${state.loading ? 'disabled' : ''}>重试</button>
          <button class="msg-action-btn copy-btn" title="复制全文">复制</button>
          ${deleteBtnHtml}
        </div>` : ''}
        ${msg.role === 'user' && !msg.editing && !msg.isFileOnly ? `
        <div class="msg-actions">
          <button class="msg-action-btn edit-btn" title="编辑">编辑</button>
          <button class="msg-action-btn copy-btn" title="复制全文">复制</button>
          ${deleteBtnHtml}
        </div>` : ''}
      </div>
    `;

    messagesEl.appendChild(div);

    const bubble = div.querySelector('.msg-bubble');
    // A6+D7: 长按 / 右键统一接管为自定义气泡菜单（替代系统菜单）
    addLongPress(bubble, (ev) => {
      const evt = ev || { clientX: 0, clientY: 0, preventDefault: () => {} };
      // 长按位置兜底：若 event 无坐标，取 bubble 中心
      if (!evt.clientX && !evt.clientY) {
        const r = bubble.getBoundingClientRect();
        evt.clientX = r.left + r.width / 2;
        evt.clientY = r.top + r.height / 2;
      }
      showBubbleContextMenu(evt, msg);
    });
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showBubbleContextMenu(e, msg);
    });

    const editBtn = div.querySelector('.edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => enterEditMode(msg.id));

    const regenBtn = div.querySelector('.regenerate-btn');
    if (regenBtn) regenBtn.addEventListener('click', () => regenerate(msg.id));

    const deleteBtn = div.querySelector('.delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteMessage(msg.id));

    const copyBtn = div.querySelector('.copy-btn');
    // D6: 单击"复制"按钮 = 复制 AI 正文（保持向后兼容）
    // 完整 4 变体复制走右键/长按自定义菜单
    if (copyBtn) copyBtn.addEventListener('click', () => {
      var text = (msg.role === 'assistant') ? extractAiBody(msg.content) : (msg.content || '');
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      }).catch(() => {});
    });

    if (msg.editing) {
      const textarea = div.querySelector('.msg-edit-textarea');
      const saveBtn = div.querySelector('.save-btn');
      const cancelBtn = div.querySelector('.cancel-btn');
      if (textarea) {
        textarea.focus();
        textarea.addEventListener('keydown', (e) => {
          // v90: 回车仅换行（textarea 默认），保存走保存按钮
          if (e.key === 'Escape') cancelEdit(msg.id);
        });
      }
      if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(msg.id, textarea?.value || ''));
      if (cancelBtn) cancelBtn.addEventListener('click', () => cancelEdit(msg.id));
    }
  });

  scrollToBottom();
}

function addLongPress(el, callback) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const threshold = 600; // ms
  const moveThreshold = 15; // px

  const start = (e) => {
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX;
    startY = touch.clientY;
    timer = setTimeout(() => {
      timer = null;
      callback(e); // A6: 传 event 给 callback，便于自定义菜单定位
    }, threshold);
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const move = (e) => {
    if (!timer) return;
    const touch = e.touches ? e.touches[0] : e;
    if (Math.abs(touch.clientX - startX) > moveThreshold || Math.abs(touch.clientY - startY) > moveThreshold) {
      cancel();
    }
  };

  el.addEventListener('mousedown', start);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('touchmove', move, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
}

function showBubbleContextMenu(event, msg) {
  closeBubbleContextMenu();
  const sel = window.getSelection();
  const selectedText = sel ? sel.toString().trim() : '';

  const menu = document.createElement('div');
  menu.id = 'bubble-context-menu';
  menu.className = 'tree-node-menu bubble-context-menu';

  function addItem(label, onClick, isDanger) {
    const item = document.createElement('div');
    item.className = 'tree-menu-item' + (isDanger ? ' tree-menu-danger' : '');
    item.textContent = label;
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      closeBubbleContextMenu();
      try { onClick(); } catch(err) { console.error('[chat-lite] menu action failed:', err); }
    });
    menu.appendChild(item);
  }

  // D7: 复制选中文字（仅有选区时显示）
  if (selectedText) {
    addItem('复制选中', function() {
      navigator.clipboard.writeText(selectedText).then(flashBubbleMenuToast).catch(function(){});
    });
  }

  if (msg.role === 'assistant') {
    // D6: 复制 AI 正文（去 <status> 标签）
    addItem('复制正文', function() {
      navigator.clipboard.writeText(extractAiBody(msg.content)).then(flashBubbleMenuToast).catch(function(){});
    });
    // D6: 含思考过程
    if (msg.reasoningContent) {
      addItem('复制含思考', function() {
        const text = '【思考】\n' + (msg.reasoningContent || '') + '\n\n【正文】\n' + extractAiBody(msg.content);
        navigator.clipboard.writeText(text).then(flashBubbleMenuToast).catch(function(){});
      });
    }
    // D6: 纯 Markdown 源码
    addItem('复制 Markdown 源', function() {
      navigator.clipboard.writeText(msg.content || '').then(flashBubbleMenuToast).catch(function(){});
    });
    // D6: 单代码块（多个时合并复制并提示）
    const blocks = extractCodeBlocks(msg.content || '');
    if (blocks.length === 1) {
      addItem('复制代码块', function() {
        navigator.clipboard.writeText(blocks[0]).then(flashBubbleMenuToast).catch(function(){});
      });
    } else if (blocks.length > 1) {
      addItem('复制 ' + blocks.length + ' 个代码块', function() {
        navigator.clipboard.writeText(blocks.join('\n\n---\n\n')).then(flashBubbleMenuToast).catch(function(){});
      });
    }
  } else {
    // user msg: 复制全文
    addItem('复制全文', function() {
      navigator.clipboard.writeText(msg.content || '').then(flashBubbleMenuToast).catch(function(){});
    });
  }

  // 编辑（仅 user）
  if (msg.role === 'user') addItem('编辑', function() { enterEditMode(msg.id); });
  // 重新生成（仅 assistant）
  if (msg.role === 'assistant') addItem('重新生成', function() { regenerate(msg.id); });
  // 删除
  addItem('删除', function() {
    if (confirm('确定删除这条消息？')) deleteMessage(msg.id);
  }, true);

  // 定位
  let x, y;
  if (event.touches && event.touches.length) { x = event.touches[0].clientX; y = event.touches[0].clientY; }
  else if (event.changedTouches && event.changedTouches.length) { x = event.changedTouches[0].clientX; y = event.changedTouches[0].clientY; }
  else { x = event.clientX; y = event.clientY; }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // 边界检查：超出视口则向左/上偏移
  requestAnimationFrame(function() {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });

  setTimeout(function() {
    document.addEventListener('click', closeBubbleContextMenu, { once: true });
    document.addEventListener('contextmenu', closeBubbleContextMenu, { once: true });
    document.addEventListener('scroll', closeBubbleContextMenu, { once: true });
  }, 50);
}

// ===== 分支抽屉 + 搜索 =====
function openBranchDrawer() {
  const conv = currentConv();
  if (!conv) return;
  updateZoomInput();
  const drawer = document.getElementById('branch-drawer');
  const tree = document.getElementById('branch-tree');
  const info = document.getElementById('branch-info');
  drawer.style.display = 'flex';

  const totalWords = computeBranchWords(conv, conv.rootId);
  const chainLen = getActiveChain(conv).filter(m => m && m.role !== 'system').length;
  info.textContent = `分支总览 — ${chainLen} 条消息 · ${totalWords} 字`;

  tree.innerHTML = renderTreeSVG(conv);
  applyBranchZoom();
  initPinchZoom();
  bindTreeNodeLongPress();
}

function closeBranchDrawer() {
  document.getElementById('branch-drawer').style.display = 'none';
  removePinchListeners();
  branchSearchResults = [];
  branchSearchIdx = -1;
  document.getElementById('branch-search-input').value = '';
  document.getElementById('branch-search-info').textContent = '';
}

let branchSearchResults = [];
let branchSearchIdx = -1;

function doBranchSearch() {
  const input = document.getElementById('branch-search-input');
  const query = (input?.value || '').trim().toLowerCase();
  const info = document.getElementById('branch-search-info');
  const conv = currentConv();
  if (!query || !conv) {
    branchSearchResults = []; branchSearchIdx = -1;
    clearSearchHighlights();
    if (info) info.textContent = '';
    renderSearchResults(); // A1: 清空 query 时也需隐藏搜索结果面板
    return;
  }
  // Search all messages in the conversation
  branchSearchResults = [];
  for (const [id, msg] of Object.entries(conv.messageMap || {})) {
    if (msg.role === 'system') continue;
    const content = (msg.content || '').toLowerCase();
    const title = (msg.title || '').toLowerCase();
    const idx = content.indexOf(query);
    if (idx >= 0) {
      branchSearchResults.push({ id, pos: idx, text: content.substring(Math.max(0,idx-20), idx+query.length+40) });
    }
  }
  branchSearchIdx = branchSearchResults.length > 0 ? 0 : -1;
  if (info) info.textContent = branchSearchResults.length > 0 
    ? `${branchSearchResults.length} 条` : '无结果';
  updateSearchHighlights();
  renderSearchResults();
  if (branchSearchIdx >= 0) navigateToSearchResult(0);
}


function renderSearchResults() {
  const container = document.getElementById('branch-search-results');
  if (!container) return;
  if (branchSearchResults.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'block';
  const query = (document.getElementById('branch-search-input')?.value || '').trim();
  container.innerHTML = branchSearchResults.map((r, i) => {
    const conv = currentConv();
    const msg = conv?.messageMap?.[r.id];
    const role = msg?.role === 'user' ? ICON.user : ICON.bot;
    const text = escapeHtml(r.text);
    const hl = text.replace(new RegExp(escapeRegex(query), 'gi'), m => `<mark class="result-highlight">${m}</mark>`);
    return `<div class="branch-search-result" data-idx="${i}" onclick="jumpToSearchResult(${i})">
      <span class="result-role">${role}</span>
      <span class="result-text">${hl}</span>
    </div>`;
  }).join('');
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

window.jumpToSearchResult = function(idx) {
  branchSearchIdx = idx;
  navigateToSearchResult(0);
};

function updateSearchHighlights() {
  const svg = document.querySelector('.branch-svg');
  if (!svg) return;
  // Clear old highlights
  svg.querySelectorAll('.search-highlight').forEach(el => el.remove());
  // Add new highlights
  const resultIds = new Set(branchSearchResults.map(r => r.id));
  svg.querySelectorAll('.tree-node').forEach(g => {
    const onclick = g.getAttribute('onclick') || '';
    const idMatch = onclick.match(/'([^']+)'/);
    if (idMatch && resultIds.has(idMatch[1])) {
      const rect = g.querySelector('rect');
      if (rect) {
        const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hl.setAttribute('x', rect.getAttribute('x'));
        hl.setAttribute('y', rect.getAttribute('y'));
        hl.setAttribute('width', rect.getAttribute('width'));
        hl.setAttribute('height', rect.getAttribute('height'));
        hl.setAttribute('rx', '8');
        hl.setAttribute('fill', 'none');
        hl.setAttribute('stroke', 'var(--warning)');
        hl.setAttribute('stroke-width', '3');
        hl.classList.add('search-highlight');
        g.appendChild(hl);
      }
    }
  });
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => el.remove());
}

function navigateToSearchResult(dir) {
  if (branchSearchResults.length === 0) return;
  branchSearchIdx = (branchSearchIdx + dir + branchSearchResults.length) % branchSearchResults.length;
  const result = branchSearchResults[branchSearchIdx];
  const info = document.getElementById('branch-search-info');
  if (info) info.textContent = `${branchSearchIdx + 1}/${branchSearchResults.length}`;
  // Find and scroll to the node in SVG
  const container = document.querySelector('.branch-drawer-body');
  const svg = document.querySelector('.branch-svg');
  if (!container || !svg) return;
  const nodes = svg.querySelectorAll('.tree-node');
  for (const g of nodes) {
    const onclick = g.getAttribute('onclick') || '';
    if (onclick.includes(result.id)) {
      // Scroll the container to make this node visible
      const transform = g.getAttribute('transform') || '';
      const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        const tx = parseFloat(match[1]), ty = parseFloat(match[2]);
        container.scrollTop = Math.max(0, ty * branchZoom - container.clientHeight / 2);
        container.scrollLeft = Math.max(0, tx * branchZoom - container.clientWidth / 2);
      }
      // Flash highlight
      g.style.outline = '3px solid var(--warning)';
      g.style.outlineOffset = '2px';
      g.style.zIndex = '10';
      setTimeout(() => { g.style.outline = ''; g.style.outlineOffset = ''; g.style.zIndex = ''; }, 1500);
      break;
    }
  }
}

// ===== 分支树 SVG =====
function renderTreeSVG(conv) {
  const NODE_W = 150, NODE_H = 50;
  const H_GAP = 24, V_GAP = 32;
  
  // Step 1: collect non-system nodes into levels, compute subtree widths
  const levels = {}; // depth -> [{id, msg, subtreeW}]
  const parentOf = {}; // childId -> parentId
  
  function measure(nodeId, depth) {
    const msg = conv.messageMap[nodeId];
    if (!msg) return 0;
    const isHidden = msg.role === 'system' && msg.parentId !== null;
    const children = msg.children || [];
    let childW = 0;
    for (const cid of children) {
      parentOf[cid] = nodeId;
      const w = measure(cid, isHidden ? depth : depth + 1);
      childW += w + (w > 0 ? H_GAP : 0);
    }
    childW = Math.max(0, childW - H_GAP);
    if (!isHidden) {
      if (!levels[depth]) levels[depth] = [];
      levels[depth].push({ id: nodeId, msg, subtreeW: Math.max(childW, NODE_W) });
    }
    return Math.max(childW, NODE_W);
  }
  
  measure(conv.rootId, 0);
  
  const maxDepth = Math.max(...Object.keys(levels).map(Number), 0);
  if (maxDepth === 0) return '<div style="padding:20px;color:var(--text2)">暂无分支</div>';
  
  // Step 2: assign x,y positions
  const positions = {};
  for (let d = 0; d <= maxDepth; d++) {
    const nodes = levels[d] || [];
    if (nodes.length === 0) continue;
    // Spread nodes evenly, using subtree widths
    const totalW = nodes.reduce((sum, n) => sum + n.subtreeW, 0) + (nodes.length - 1) * H_GAP;
    let x = 0;
    for (const node of nodes) {
      positions[node.id] = {
        x: x + node.subtreeW / 2,
        y: d * (NODE_H + V_GAP) + NODE_H / 2
      };
      x += node.subtreeW + H_GAP;
    }
  }
  
  // Step 3: build SVG
  const svgW = Math.max(
    Object.values(positions).reduce((max, p) => Math.max(max, p.x + NODE_W/2 + 20), 0),
    300
  );
  const svgH = (maxDepth + 1) * (NODE_H + V_GAP) + 20;
  
  let svg = `<svg class="branch-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">`;
  svg += `<defs><filter id="shadow"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.1"/></filter></defs>`;
  
  // Draw edges
  for (const [childId, parentId] of Object.entries(parentOf)) {
    const pp = positions[parentId];
    const cp = positions[childId];
    if (!pp || !cp) continue;
    const pMsg = conv.messageMap[parentId];
    if (pMsg && pMsg.role === 'system' && !pMsg.parentId) continue; // skip root edges
    const isActiveEdge = conv.activePath.includes(parentId) && conv.activePath.includes(childId);
    svg += `<line x1="${pp.x}" y1="${pp.y + NODE_H/2}" x2="${cp.x}" y2="${cp.y - NODE_H/2}" 
      stroke="${isActiveEdge ? 'var(--primary)' : 'var(--text2)'}" stroke-width="${isActiveEdge ? 2 : 1}" opacity="${isActiveEdge ? 0.8 : 0.3}"/>`;
  }
  
  // Draw nodes
  for (const [nodeId, pos] of Object.entries(positions)) {
    const msg = conv.messageMap[nodeId];
    if (!msg) continue;
    const isActive = conv.activePath.includes(nodeId);
    const hasChildren = (msg.children || []).length > 0;
    const iconChar = msg.role === 'user' ? 'U' : 'A';
    const rawTitle = (msg.title || msg.content || '');
    const cleanTitle = (typeof rawTitle === 'string' ? rawTitle : '').replace(/\s+/g, ' ').trim() || '(空)';
    // Truncate by visual width: CJK ≈ 2 units, ASCII ≈ 1 unit
    let title = '', w = 0, maxW = 16;
    for (const ch of cleanTitle) { 
      const cw = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
      if (w + cw > maxW) { title += '…'; break; }
      title += ch; w += cw;
    }
    const wc = msg.wordCount || countWords(msg.content || '');
    
    const bx = pos.x - NODE_W/2;
    const by = pos.y - NODE_H/2;
    const fillColor = msg.color || (isActive ? 'var(--primary)' : 'var(--bg2)');
    
    svg += `<g class="tree-node" onclick="svgNodeClick('${nodeId}')" oncontextmenu="event.preventDefault();svgNodeMenu(event,'${nodeId}')" data-node-id="${nodeId}" transform="translate(${bx},${by})">
      <rect x="0" y="0" width="${NODE_W}" height="${NODE_H}" rx="8" 
        fill="${fillColor}" 
        stroke="${isActive ? 'var(--primary)' : 'var(--border)'}" 
        stroke-width="${isActive ? 1.5 : 1}" filter="url(#shadow)"/>
      <circle cx="12" cy="14" r="5" fill="${msg.role === 'user' ? 'var(--bubble-user-to)' : 'var(--success)'}" opacity="${isActive ? 0.9 : 0.6}"/>
      <text x="12" y="17" font-size="8" font-weight="bold" fill="var(--on-primary)" text-anchor="middle" font-family="inherit">${iconChar}</text>
      <text x="24" y="18" font-size="11" font-weight="${isActive ? 'bold' : 'normal'}" 
        fill="${isActive ? 'var(--on-primary)' : 'var(--text)'}" font-family="inherit">${escapeSvg(title)}</text>
      <text x="24" y="36" font-size="10" fill="${isActive ? 'color-mix(in srgb, var(--on-primary) 70%, transparent)' : 'var(--text2)'}" font-family="inherit">${wc}字${hasChildren ? ' ▾' : ''}</text>
    </g>`;
  }
  
  svg += '</svg>';
  return svg;
}


function escapeSvg(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.svgNodeClick = function(nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const newPath = getBranchPath(conv, nodeId);
  conv.activePath = newPath;
  save();
  renderMessages();
  renderBreadcrumb(conv);
  closeBranchDrawer();
};

function applyBranchZoom() {
  const svg = document.querySelector('.branch-svg');
  if (!svg) return;
  const origW = parseInt(svg.getAttribute('data-orig-w') || svg.getAttribute('width'));
  const origH = parseInt(svg.getAttribute('data-orig-h') || svg.getAttribute('height'));
  if (!svg.hasAttribute('data-orig-w')) {
    svg.setAttribute('data-orig-w', origW);
    svg.setAttribute('data-orig-h', origH);
  }
  svg.setAttribute('width', Math.round(origW * branchZoom));
  svg.setAttribute('height', Math.round(origH * branchZoom));
}

function applyBranchCenter() {
  const container = document.querySelector('.branch-drawer-body');
  const svg = document.querySelector('.branch-svg');
  if (!container || !svg) return;
  const rootNode = svg.querySelector('.tree-node');
  if (!rootNode) return;
  const transformAttr = rootNode.getAttribute('transform') || '';
  const match = transformAttr.match(/translate\(([^,]+),\s*([^)]+)\)/);
  const tx = parseFloat(match?.[1]) || 0;
  const ty = parseFloat(match?.[2]) || 0;
  container.scrollLeft = Math.max(0, (tx + 90) * branchZoom - container.clientWidth / 2);
  container.scrollTop = Math.max(0, (ty + 22) * branchZoom - container.clientHeight / 2);
}

window.svgNodeMenu = function(event, nodeId) {
  showTreeNodeMenu(event, nodeId);
};

function showTreeNodeMenu(event, nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, nodeId);
  if (!msg) return;

  // Remove any existing menu
  closeTreeNodeMenu();

  const isRoot = !msg.parentId;
  const menu = document.createElement('div');
  menu.id = 'tree-node-menu';
  menu.className = 'tree-node-menu';

  // Rename option
  const renameBtn = document.createElement('div');
  renameBtn.className = 'tree-menu-item';
  renameBtn.innerHTML = ICON.edit + ' 改名';
  renameBtn.addEventListener('click', function() {
    closeTreeNodeMenu();
    const newName = prompt('输入新名称:', msg.title || '');
    if (newName !== null && newName.trim()) {
      msg.title = newName.trim();
      save();
      openBranchDrawer();
      renderMessages();
    }
  });
  menu.appendChild(renameBtn);

  // Color option
  const colorBtn = document.createElement('div');
  colorBtn.className = 'tree-menu-item';
  colorBtn.innerHTML = ICON.palette + ' 选色';
  colorBtn.addEventListener('click', function() {
    closeTreeNodeMenu();
    const colorList = NODE_COLORS.map((c,i) => `${i}. ${c.name}`).join('\n');
    const curIdx = msg.color ? NODE_COLORS.findIndex(c => c.value === msg.color) : 0;
    const idx = prompt('选择颜色:\n' + colorList + '\n输入数字:', curIdx.toString());
    if (idx !== null) {
      const ci = parseInt(idx) || 0;
      if (ci >= 0 && ci < NODE_COLORS.length) {
        msg.color = NODE_COLORS[ci].value;
        save();
        openBranchDrawer();
      }
    }
  });
  menu.appendChild(colorBtn);

  // Delete option (not for root)
  if (!isRoot) {
    const delBtn = document.createElement('div');
    delBtn.className = 'tree-menu-item tree-menu-danger';
    delBtn.innerHTML = ICON.trash + ' 删除';
    delBtn.addEventListener('click', function() {
      closeTreeNodeMenu();
      if (confirm('确定删除这条消息及其所有分支吗？')) {
        deleteMessage(nodeId);
        openBranchDrawer();
      }
    });
    menu.appendChild(delBtn);
  } else {
    const rootHint = document.createElement('div');
    rootHint.className = 'tree-menu-item tree-menu-disabled';
    rootHint.innerHTML = ICON.ban + ' 根节点不可删除';
    menu.appendChild(rootHint);
  }

  // Position menu at click point
  let x, y;
  if (event.touches && event.touches.length > 0) {
    x = event.touches[0].clientX;
    y = event.touches[0].clientY;
  } else if (event.changedTouches && event.changedTouches.length > 0) {
    x = event.changedTouches[0].clientX;
    y = event.changedTouches[0].clientY;
  } else {
    x = event.clientX;
    y = event.clientY;
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Close on click outside
  setTimeout(function() {
    document.addEventListener('click', closeTreeNodeMenu, { once: true });
  }, 50);
}

function closeTreeNodeMenu() {
  const existing = document.getElementById('tree-node-menu');
  if (existing) existing.remove();
}

function bindTreeNodeLongPress() {
  const nodes = document.querySelectorAll('.branch-svg .tree-node');
  nodes.forEach(function(g) {
    const nodeId = g.getAttribute('data-node-id');
    if (!nodeId) return;
    addLongPress(g, function(e) {
      // Simulate event for positioning
      const fakeEvent = { clientX: g.getBoundingClientRect().left + 40, clientY: g.getBoundingClientRect().top + 20 };
      showTreeNodeMenu(fakeEvent, nodeId);
    });
  });
}

// ===== 辅助 =====
function getBranchPathFromMap(map, rootId, leafId) {
  const path = [];
  let cur = leafId;
  while (cur && cur !== rootId) {
    path.unshift(cur);
    const node = map[cur];
    if (!node || !node.parentId) break;
    cur = node.parentId;
  }
  path.unshift(rootId);
  return path;
}
