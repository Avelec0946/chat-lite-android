// ===== io.js : 导入导出 + 角色卡 + 格式转换模块（v2.0 拆分）=====
// 模块名：io.js
// 版本：v84（cache-bust）
// 迁移日期：2026-07-27
// 来源：从 app.js 拆分
// 职责：数据导入导出、会话导入导出、角色卡 PNG 导入导出、DZMM/豆包格式转换
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / escapeHtml / showToast /
//       ICON / uid / $ / currentConv / isCapacitor / CapFilesystem / Capacitor / CapShare /
//       parseJsonField / migrateImportedImagesToFilesystem / normalizeProvider /
//       getProvider / normalizeImageProvider / renderSidebar / renderMessages / renderProviderList
// 加载顺序：在 chat.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   导入导出：exportAllData, importAllData, importAllDataFromFile, exportConversation,
//             importConversation, ensureDataLoaded, tryParseJSON
//   角色卡：parseCharacterCard, generateCharacterCard, buildCardPrompt, crc32
//   格式转换：convertDZMM, convertDoubao
//
// 保留在 app.js：
//   loadData / loadFromServer（数据加载，与 init 相关）

// ===== 导入导出 =====
async function ensureDataLoaded() {
  if (state._dataLoaded) return;
  // loadData() 在 init() 里被 await，这里轮询等待
  let tries = 0;
  while (!state._dataLoaded && tries < 50) {
    await new Promise(r => setTimeout(r, 100));
    tries++;
  }
}

async function exportAllData() {
  await ensureDataLoaded();
  showToast('正在导出数据，请稍候...', 'info');
  // 让 UI 有机会渲染 toast 再开始重活，避免点击后无反馈误解为卡死
  await new Promise(r => setTimeout(r, 50));

// v79 修复导出 OOM：settings.images 中可能残留 dataUrl/referenceImages/thumbnailDataUrl
//   大 base64 字段，序列化时产生 60MB+ 字符串，触发 Capacitor Bridge JSON 序列化 OOM。
//   导出时只保留元数据（fileName/width/height/prompt 等），图片文件已存 Filesystem，
//   导入后由 migrateImportedImagesToFilesystem 重新关联。
const exportSettings = Object.assign({}, settings);
if (Array.isArray(exportSettings.images)) {
  exportSettings.images = exportSettings.images.map(function(img) {
    if (!img || typeof img !== 'object') return img;
    var lite = Object.assign({}, img);
    if (lite.dataUrl) lite.dataUrl = null;
    if (lite.referenceImages) lite.referenceImages = null;
    if (lite.thumbnailDataUrl) lite.thumbnailDataUrl = null;
    return lite;
  });
}
const data = {
  version: 1,
  exportedAt: new Date().toISOString(),
  conversations: state.conversations,
  providers: state.providers,
  settings: exportSettings,
  currentId: state.currentId
};
  // 紧凑格式（无缩进），相比 null,2 节省约 30% 体积，备份格式不需要人工阅读
  const jsonText = JSON.stringify(data);
  const fileName = 'chat-lite-backup-' + new Date().toISOString().slice(0, 10) + '.json';

  if (isCapacitor() && CapFilesystem && CapShare) {
    try {
      const result = await CapFilesystem.writeFile({
        path: fileName,
        data: jsonText,           // 直接传 UTF-8 字符串，无需 base64 转换
        directory: 'CACHE',
        encoding: 'utf8',         // 关键：Filesystem 6.x 原生支持 UTF-8 写入
        recursive: true
      });
      await CapShare.share({
        title: 'chat-lite 数据备份',
        text: fileName,
        url: result.uri,
        dialogTitle: '保存备份文件到...'
      });
      showToast('已导出，请选择保存位置', 'success');
    } catch (err) {
      console.error('Export failed:', err);
      showToast('导出失败：' + (err.message || err), 'danger');
    }
  } else {
    // Web 模式
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出全部数据', 'success');
  }
}

async function importAllData(jsonText, mode) {
  await ensureDataLoaded();
  mode = mode || 'overwrite';

  // 大文件 JSON.parse 会阻塞主线程，先提示用户避免误解为卡死
  showToast('正在解析数据，请稍候...', 'info');
  await new Promise(r => setTimeout(r, 50));

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    showToast('JSON 解析失败：' + e.message, 'danger');
    return;
  }
  if (!data.conversations && !data.providers) {
    showToast('文件格式不正确', 'danger');
    return;
  }
  if (data.version && data.version > 1) {
    showToast('备份文件版本过高，可能不兼容');
  }

  const modeText = mode === 'merge' ? '合并' : '覆盖';
  if (!confirm('即将以「' + modeText + '」方式导入数据。\n\n覆盖：直接替换当前所有数据\n合并：按 ID 去重，冲突时用导入数据替换本地\n\n确定继续吗？')) return;

  // APK 模式：导入前自动备份当前数据到 Cache（静默，不弹分享框）
  if (isCapacitor() && CapFilesystem && (state.conversations.length > 0 || (state.providers && state.providers.length > 0))) {
    try {
      const preBackup = {
        version: 1,
        exportedAt: new Date().toISOString(),
        conversations: state.conversations,
        providers: state.providers,
        settings: settings,
        currentId: state.currentId,
        _note: '导入前自动备份'
      };
      const backupName = 'chat-lite-pre-import-' + Date.now() + '.json';
      await CapFilesystem.writeFile({
        path: backupName,
        data: JSON.stringify(preBackup),   // 紧凑 + UTF-8 直写，避免 OOM
        directory: 'CACHE',
        encoding: 'utf8',
        recursive: true
      });
      console.log('导入前自动备份已保存：', backupName);
    } catch (e) {
      console.warn('导入前自动备份失败：', e);
      // 备份失败不阻断导入（用户已确认），仅提示
      showToast('注意：导入前自动备份失败，原数据将无法恢复', 'warn');
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // 让 UI 渲染 toast 后再做重活（替换 state + save + render）
  showToast('正在写入数据...', 'info');
  await new Promise(r => setTimeout(r, 50));

  // v85 修复导入旧备份时 OOM：
  //   旧备份 settings.images 含完整 dataUrl/referenceImages/thumbnailDataUrl（每张 1-5MB），
  //   若直接 Object.assign 进入全局 settings，后续 saveSettings 序列化时内存峰值翻倍触发 OOM。
  //   策略：assign 之前先剥离大字段（仅保留元数据），dataUrl 由后续 migrateImportedImagesToFilesystem 转存。
  //   注意：fileName 非空的图片文件已在 Filesystem，可直接剥离 dataUrl；
  //         fileName 为空的保留 dataUrl 给 migrate 用，但先剥离 referenceImages/thumbnailDataUrl。
  if (data.settings && Array.isArray(data.settings.images)) {
    data.settings.images = data.settings.images.map(function(img) {
      if (!img || typeof img !== 'object') return img;
      var lite = Object.assign({}, img);
      if (lite.fileName) {
        // 图片文件已在 Filesystem，dataUrl 可安全剥离
        if (lite.dataUrl) lite.dataUrl = null;
      }
      // referenceImages/thumbnailDataUrl 无论有无 fileName 都剥离（体积大且 migrate 不处理）
      if (lite.referenceImages) lite.referenceImages = null;
      if (lite.thumbnailDataUrl) lite.thumbnailDataUrl = null;
      return lite;
    });
  }

  if (mode === 'overwrite') {
    // 覆盖模式：直接替换
    if (data.conversations) state.conversations = data.conversations;
    if (data.providers) state.providers = data.providers;
    if (data.settings) {
      Object.assign(settings, data.settings);
      saveSettings();  // 走 IDB 持久化（不再用 localStorage）
    }
    if (data.currentId) {
      state.currentId = data.currentId;
    } else {
      state.currentId = state.conversations.length > 0 ? state.conversations[0].id : null;
    }
  } else {
    // 合并模式：按 ID 去重，冲突时导入数据优先覆盖
    if (data.conversations) {
      const importedIds = new Set(data.conversations.map(c => c.id));
      const kept = state.conversations.filter(c => !importedIds.has(c.id));
      state.conversations = kept.concat(data.conversations);
    }
    if (data.providers) {
      const importedPIds = new Set(data.providers.map(p => p.id));
      const keptP = (state.providers || []).filter(p => !importedPIds.has(p.id));
      state.providers = keptP.concat(data.providers);
    }
    if (data.settings) {
      Object.assign(settings, data.settings);
      saveSettings();  // 走 IDB 持久化
    }
    // currentId 保留本地当前选中的，除非本地没有了
    if (!state.conversations.find(c => c.id === state.currentId)) {
      state.currentId = state.conversations.length > 0 ? state.conversations[0].id : null;
    }
  }

  save();
  renderSidebar();
  renderModelSelector();
  if (state.currentId) renderMessages();
  // F1: 导入的图片若含 dataUrl（旧备份或浏览器导出），APK 模式下转存到 Filesystem，剥离 dataUrl 避免撑爆 localStorage
  if (isCapacitor() && CapFilesystem && Array.isArray(settings.images)) {
    migrateImportedImagesToFilesystem();
  }
  showToast('已' + modeText + '导入数据', 'success');
}

function importAllDataFromFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const modeEl = document.getElementById('import-mode-select');
  const mode = modeEl ? modeEl.value : 'overwrite';
  // 大文件警告（80MB 经验阈值，约对应 200-300MB 解析后内存峰值）
  if (file.size > 80 * 1024 * 1024) {
    if (!confirm('文件较大（' + Math.round(file.size / 1024 / 1024) + ' MB），导入可能耗时较长，且内存不足时有崩溃风险。\n\n建议先在数据充足设备上备份当前数据。\n\n是否继续？')) {
      e.target.value = '';
      return;
    }
  }
  showToast('正在读取文件...', 'info');
  const reader = new FileReader();
  reader.onload = (ev) => {
    importAllData(ev.target.result, mode);
  };
  reader.onerror = () => {
    showToast('文件读取失败', 'warn');
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function exportConversation() {
  const conv = currentConv();
  if (!conv) return;
  const data = { version: 2, exportedAt: new Date().toISOString(), conversation: conv };
  // 紧凑格式，与会话图片/长文累积场景兼容
  const jsonText = JSON.stringify(data);
  const fileName = `chat-lite-${conv.title || 'conversation'}-${new Date().toISOString().slice(0, 10)}.json`;

  if (isCapacitor() && CapFilesystem && CapShare) {
    // APK 模式：<a download> 在 WebView 里不生效，改用 Filesystem + Share
    // 修复（v1.3.0 批次1+）：encoding:'utf8' 直写，避免 base64 转换的内存峰值
    try {
      const result = await CapFilesystem.writeFile({
        path: fileName,
        data: jsonText,
        directory: 'CACHE',
        encoding: 'utf8',
        recursive: true
      });
      await CapShare.share({
        title: 'chat-lite 会话导出',
        text: fileName,
        url: result.uri,
        dialogTitle: '保存会话文件到...'
      });
      showToast('已导出，请选择保存位置', 'success');
    } catch (err) {
      console.error('Export conversation failed:', err);
      showToast('导出失败：' + (err.message || err), 'danger');
    }
  } else {
    // Web 模式
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function tryParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    let fixed = raw.trim();
    if (!fixed.startsWith('[')) fixed = '[' + fixed;
    if (!fixed.endsWith(']')) {
      fixed = fixed.replace(/,\s*$/, '');
      fixed = fixed + ']';
    }
    return JSON.parse(fixed);
  }
}

function importConversation(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = tryParseJSON(ev.target.result);
      let conv;
      
      // Format 1: chat-lite export
      if (data.version && data.conversation) {
        conv = data.conversation;
        if (!conv.id || !conv.messageMap) throw new Error('chat-lite format corrupted');
      }
      // Format 2: DZMM export
      else if (data.chatId && data.chat && data.messages) {
        conv = convertDZMM(data);
      }
      // Format 3: plain chat-lite conversation (no wrapper)
      else if (data.id && data.messageMap) {
        conv = data;
      }
      // Format 4: 豆包/类角色平台导出的会话数组（每个元素含 conversation_id + messages）
      else if (Array.isArray(data) && data.length > 0 && data[0].conversation_id && Array.isArray(data[0].messages)) {
        conv = convertDoubao(data[0]);
      }
      // Format 5: old v1 linear array
      else if (data.messages && Array.isArray(data.messages)) {
        conv = { messages: data.messages };
        migrateV1toV2(conv);
      }
      else {
        alert('不支持的格式，请导入 chat-lite 导出的 JSON 或 DZMM 导出的 JSON');
        return;
      }
      
      conv.id = uid();
      state.conversations.push(conv);
      state.currentId = conv.id;
      save();
      renderSidebar();
      renderMessages();
      // Match provider for imported conversation
      if (!conv.providerId && conv.model) {
        var matched = state.providers.find(function(p) { return p.models && p.models.some(function(m) { return m.id === conv.model; }); });
        if (matched) conv.providerId = matched.id;
        else if (state.providers.length > 0) { conv.providerId = state.providers[0].id; }
      }
      syncModelSelector();
    } catch (err) {
      alert('文件解析失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ===== 格式转换 =====
function convertDZMM(data) {
  const chat = data.chat || {};
  const chunks = chat.chunks || [];
  const messages = data.messages || [];
  
  // Build message lookup by chunk_id
  const chunkMsgs = {};
  for (const entry of messages) {
    chunkMsgs[entry.chunk_id] = entry.messages || [];
  }
  
  // Build chunk map  
  const chunkMap = {};
  for (const c of chunks) {
    chunkMap[c.id] = c;
  }
  
  // Find root chunks
  const roots = chunks.filter(c => !c.parent);
  const rootId = uid();
  const rootMsg = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  const messageMap = { [rootId]: rootMsg };
  
  // Helper to create a message node
  function createMsgNode(role, content, parentId) {
    const text = String(content || '');
    const node = {
      id: uid(), role, content: text,
      parentId, children: [],
      title: (role === 'user' ? (text.substring(0, 30) + (text.length > 30 ? '...' : '')) : '回复').replace(/\n/g, ' '),
      wordCount: countWords(text),
      versions: [{ content: text, timestamp: Date.now(), reason: 'import' }],
      activeVersion: 0, files: [], createdAt: Date.now()
    };
    messageMap[node.id] = node;
    messageMap[parentId].children.push(node.id);
    return node.id;
  }
  
  // Cache: chunkId → [nodeIds] so we can trace active path
  const chunkNodeIds = {};
  // Cache: chunkId → lastNodeId for child chunk attachment
  const chunkLastNode = {};
  
  // Walk the tree: create individual nodes per message, NOT merged
  function walk(chunkId, parentId) {
    const chunk = chunkMap[chunkId];
    if (!chunk) return parentId;
    
    // If already walked, just re-attach first node
    if (chunkLastNode[chunkId] !== undefined) {
      const lastId = chunkLastNode[chunkId];
      const nids = chunkNodeIds[chunkId] || [];
      if (nids.length > 0 && messageMap[nids[0]] && !messageMap[parentId].children.includes(nids[0])) {
        messageMap[nids[0]].parentId = parentId;
        messageMap[parentId].children.push(nids[0]);
      }
      return lastId;
    }
    
    const msgs = chunkMsgs[chunkId] || [];
    let lastId = parentId;
    
    // Create individual nodes for each message (NO merging)
    const nodeIds = [];
    for (const m of msgs) {
      const ct = (typeof m.content === 'string' ? m.content : String(m.content || ''));
      if (!ct) continue;
      lastId = createMsgNode(m.role || 'user', ct, lastId);
      nodeIds.push(lastId);
    }
    
    chunkNodeIds[chunkId] = nodeIds;
    chunkLastNode[chunkId] = lastId;
    
    // Walk children — they attach to lastId
    const children = (chunk.children || []).filter(c => chunkMap[c]);
    for (const childId of children) {
      walk(childId, lastId);
    }
    
    return lastId;
  }
  
  // Walk all chunks from each root
  for (const r of roots) {
    walk(r.id, rootId);
  }
  
  // Build activePath: follow chunk.active chain, use chunkNodeIds cache directly
  const convActivePath = [rootId];
  function followActive(chunkId) {
    const chunk = chunkMap[chunkId];
    if (!chunk) return;
    
    // Push all nodes from this chunk
    const nodeIds = chunkNodeIds[chunkId] || [];
    for (const nid of nodeIds) {
      convActivePath.push(nid);
    }
    
    // Find active child chunk and recurse
    const children = (chunk.children || []).filter(c => chunkMap[c]);
    const activeChild = children.find(c => chunkMap[c]?.active);
    if (activeChild) {
      followActive(activeChild);
    }
  }
  
  for (const r of roots) {
    if (chunkMap[r]?.active) {
      followActive(r.id);
      break;
    }
  }
  
  // If activePath failed, fallback to first-child chain
  if (convActivePath.length <= 1) {
    let cur = rootId;
    while (true) {
      const node = messageMap[cur];
      if (!node || !node.children || node.children.length === 0) break;
      cur = node.children[0];
      convActivePath.push(cur);
    }
  }


  return {
    id: uid(),
    title: chat.title || '导入的对话',
    model: 'deepseek-v4-flash',
    thinkingEnabled: true,
    systemPrompt: '',
    userIdentity: '',
    rootId,
    activePath: convActivePath,
    messageMap,
    createdAt: Date.now()
  };
}

function convertDoubao(convData) {
  const messages = convData.messages || [];
  const rootId = uid();
  const rootMsg = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  const messageMap = { [rootId]: rootMsg };
  const activePath = [rootId];
  let parentId = rootId;

  function createMsgNode(role, content) {
    const text = String(content || '');
    const node = {
      id: uid(), role, content: text,
      parentId,
      children: [],
      title: (role === 'user' ? (text.substring(0, 30) + (text.length > 30 ? '...' : '')) : '回复').replace(/\n/g, ' '),
      wordCount: countWords(text),
      versions: [{ content: text, timestamp: Date.now(), reason: 'import' }],
      activeVersion: 0, files: [], createdAt: Date.now()
    };
    messageMap[node.id] = node;
    messageMap[parentId].children.push(node.id);
    parentId = node.id;
    activePath.push(node.id);
    return node.id;
  }

  for (const m of messages) {
    if (m.content_type !== 'text') continue;
    const text = String(m.show_content || '');
    if (!text) continue;
    const role = m.user_type === 'user' ? 'user' : 'assistant';
    createMsgNode(role, text);
  }

  return {
    id: uid(),
    title: convData.conversation_name || convData.bot_name || '导入的对话',
    model: '',
    thinkingEnabled: true,
    systemPrompt: '',
    userIdentity: '',
    rootId,
    activePath,
    messageMap,
    createdAt: Date.now()
  };
}

// ===== 角色卡 =====
function parseCharacterCard(buffer) {
  const bytes = new Uint8Array(buffer);
  // PNG signature check
  const sig = [137,80,78,71,13,10,26,10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('Not a valid PNG file');
  
  let offset = 8;
  let charaJSON = null, ccv3JSON = null;
  
  while (offset < bytes.length) {
    const length = (bytes[offset] << 24) | (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3];
    const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
    const dataStart = offset + 8;
    
    if (type === 'tEXt') {
      const textBytes = bytes.slice(dataStart, dataStart + length);
      let nullIdx = -1;
      for (let i = 0; i < textBytes.length; i++) { if (textBytes[i] === 0) { nullIdx = i; break; } }
      if (nullIdx >= 0) {
        // Try UTF-8 first, fallback to Latin-1 (PNG spec default for tEXt)
        let keyword, value;
        try {
          const td8 = new TextDecoder('utf-8', {fatal:true});
          keyword = td8.decode(textBytes.slice(0, nullIdx));
          value = td8.decode(textBytes.slice(nullIdx + 1));
        } catch(e) {
          const td1 = new TextDecoder('latin1');
          keyword = td1.decode(textBytes.slice(0, nullIdx));
          value = td1.decode(textBytes.slice(nullIdx + 1));
        }
        function decodeB64(b64) {
          try {
            // atob gives bytes as 0-255 codepoints; convert via TextDecoder
            const raw = atob(b64);
            const buf = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
            return new TextDecoder('utf-8').decode(buf);
          } catch(e) { return null; }
        }
        function tryDecode(val) {
          try { return JSON.parse(val); } catch(e) {}
          var dec = decodeB64(val);
          if (dec) { try { return JSON.parse(dec); } catch(e) {} }
          return null;
        }
        if (keyword === 'chara') {
          charaJSON = tryDecode(value);
        } else if (keyword === 'ccv3') {
          ccv3JSON = tryDecode(value);
        }
      }
    }
    
    offset = dataStart + length + 4; // skip CRC
  }
  
  const result = ccv3JSON || charaJSON;
  // Prefer data field for V2/V3 cards
  if (result && result.data) {
    return result.data;
  }
  return result;
}
function generateCharacterCard(fields, avatarBuffer) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const srcBytes = new Uint8Array(e.target.result);
        // Validate PNG
        const sig = [137,80,78,71,13,10,26,10];
        for (let i = 0; i < 8; i++) if (srcBytes[i] !== sig[i]) throw new Error('Avatar must be a PNG file');
        
        // Build card JSON (V2 format via ccv3 for longer content support)
        const cardData = {
          data: {
            name: fields.name || '',
            description: fields.description || '',
            personality: fields.personality || '',
            scenario: fields.scenario || '',
            first_mes: fields.first_mes || '',
            mes_example: fields.mes_example || '',
            system_prompt: fields.system_prompt || '',
            creator: fields.creator || '',
            creator_notes: fields.creator_notes || '',
            character_version: fields.character_version || '1.0'
          }
        };
        const jsonStr = JSON.stringify(cardData);
        const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
        const tEXtData = 'ccv3\0' + b64;
        
        // Find IEND position in source
        let iendPos = -1;
        let offset = 8;
        while (offset < srcBytes.length - 8) {
          const len = (srcBytes[offset] << 24) | (srcBytes[offset+1] << 16) | (srcBytes[offset+2] << 8) | srcBytes[offset+3];
          const type = String.fromCharCode(srcBytes[offset+4], srcBytes[offset+5], srcBytes[offset+6], srcBytes[offset+7]);
          if (type === 'IEND') { iendPos = offset; break; }
          offset += 8 + len + 4;
        }
        if (iendPos < 0) { reject(new Error('Invalid PNG')); return; }
        
        // Build output: copy everything up to IEND, insert tEXt chunk, then IEND
        const beforeIEND = srcBytes.slice(0, iendPos);
        const iendChunk = srcBytes.slice(iendPos);
        
        const tEXtBytes = new TextEncoder().encode(tEXtData);
        const chunkLen = tEXtBytes.length;
        
        // Build chunk: length(4) + 'tEXt'(4) + data + CRC(4)
        const chunk = new Uint8Array(4 + 4 + chunkLen + 4);
        chunk[0] = (chunkLen >> 24) & 0xFF;
        chunk[1] = (chunkLen >> 16) & 0xFF;
        chunk[2] = (chunkLen >> 8) & 0xFF;
        chunk[3] = chunkLen & 0xFF;
        chunk[4] = 116; chunk[5] = 69; chunk[6] = 88; chunk[7] = 116; // 'tEXt'
        chunk.set(tEXtBytes, 8);
        
        // CRC32 (simplified)
        const crcData = chunk.slice(4, 8 + chunkLen);
        const crc = crc32(crcData);
        chunk[8 + chunkLen] = (crc >> 24) & 0xFF;
        chunk[8 + chunkLen + 1] = (crc >> 16) & 0xFF;
        chunk[8 + chunkLen + 2] = (crc >> 8) & 0xFF;
        chunk[8 + chunkLen + 3] = crc & 0xFF;
        
        const result = new Uint8Array(beforeIEND.length + chunk.length + iendChunk.length);
        result.set(beforeIEND, 0);
        result.set(chunk, beforeIEND.length);
        result.set(iendChunk, beforeIEND.length + chunk.length);
        
        resolve(new Blob([result], { type: 'image/png' }));
      } catch(err) { reject(err); }
    };
    reader.readAsArrayBuffer(avatarBuffer);
  });
}
function buildCardPrompt(fields) {
  const parts = [];
  if (fields.name) parts.push(fields.name);
  if (fields.description) parts.push(fields.description);
  if (fields.personality) parts.push('性格：' + fields.personality);
  if (fields.scenario) parts.push('场景：' + fields.scenario);
  const header = parts.length > 0 ? '[角色：' + parts.join('；') + ']' : '';
  const sys = fields.system_prompt || '';
  const example = fields.mes_example ? '\n# 对话示例\n' + fields.mes_example : '';
  return [header, sys, example].filter(Boolean).join('\n\n');
}
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
