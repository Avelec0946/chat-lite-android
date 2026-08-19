// ===== Capacitor Environment Detection =====
// 在 Capacitor APK 环境下返回 true，浏览器/PWA 环境下返回 false
// 所有 APK 特有逻辑都用 isCapacitor() 分支隔离，主仓库同步时一眼能识别
function isCapacitor() {
  return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform && Capacitor.isNativePlatform();
}

// 动态导入 Capacitor 插件（仅 APK 模式可用，浏览器模式调用会抛错）
let CapFilesystem = null;
let CapShare = null;
let CapHttp = null;
let CapStreamHttp = null;
let CapHaptics = null;
let CapRichHaptics = null;
if (isCapacitor()) {
  try {
    CapFilesystem = Capacitor.Plugins && Capacitor.Plugins.Filesystem;
    CapShare = Capacitor.Plugins && Capacitor.Plugins.Share;
    CapHttp = Capacitor.Plugins && Capacitor.Plugins.CapacitorHttp;
    CapStreamHttp = Capacitor.Plugins && Capacitor.Plugins.StreamHttp;
    CapHaptics = Capacitor.Plugins && Capacitor.Plugins.Haptics;
    CapRichHaptics = Capacitor.Plugins && (Capacitor.Plugins.RichHaptics || Capacitor.Plugins['capacitor-rich-haptics']);
  } catch (e) {
    console.warn('Capacitor plugins init failed:', e);
  }
}

// ===== State =====
const state = {
  conversations: [],
  providers: [],  // v76 修复：从 providers.js 迁回此字段初始化（避免 TDZ 报错）
  currentId: null,
  loading: false,
  abortController: null,
  settingsOpen: false,
  _isBackground: false,  // v67: 追踪前后台状态用于完成通知
  _pendingTextNotify: null,  // v67: 文字回复后台完成时的待显示通知
  selectedMsgId: null,
  // Capacitor 特有：标记当前请求是否被用户取消（原生 HTTP 无法真正中断）
  _nativeAborted: false,
  // 标记数据是否已从 IndexedDB 加载完成
  _dataLoaded: false,
  // 标记用户是否正在触摸滚动（流式输出时暂停 DOM 更新，避免阻塞滚动）
  _isTouching: false,
  // 当前正在流式输出的 assistantMsg（松手后立即渲染）
  _streamingMsg: null,
};

// STORAGE_KEY / SETTINGS_KEY 已迁移到 db.js

// ===== Flat SVG Icons (stroke-based, consistent with toolbar) =====
const ICON = {
  user: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>',
  bot: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><rect x="4" y="8" width="16" height="12" rx="2"/><line x1="12" y1="4" x2="12" y2="8"/><circle cx="9" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1" fill="currentColor" stroke="none"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  palette: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><circle cx="12" cy="12" r="10"/><circle cx="8.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  ban: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

// IndexedDB 存储层（openDB / idbPut / idbGet / 常量）已迁移到 db.js
// SETTINGS_IDB_KEY 已迁移到 db.js
// 同步初始化默认值，init 中 await initSettings() 会从 IDB 覆盖
// defaultSettings 由 db.js 提供（db.js 先于 app.js 加载）
let settings = defaultSettings();
let _settingsLoaded = false;  // 标记 settings 是否已从 IDB 加载完成
let isLongPress = false;

// ===== Helpers =====
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function showToast(msg, type) {
  var t = document.getElementById('app-toast');
  if (!t) { t = document.createElement('div'); t.id = 'app-toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  var cls = 'toast';
  if (type === 'warn') cls += ' warn';
  else if (type === 'success') cls += ' success';
  else if (type === 'info') cls += ' info';
  else if (type === 'danger') cls += ' danger';
  t.className = cls;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(function() { t.classList.remove('show'); }, 4000);
}

// parseJsonField + toggleProviderAuthFields 已迁移到 providers.js

// Provider System（getProvider/PROVIDER_TEMPLATES/normalizeProvider 等） 已迁移到 providers.js

// 生图 Provider 模板与归一化（IMAGE_PROVIDER_TEMPLATES/normalizeImageProvider/getImageProvider 等） 已迁移到 image-gen.js

// normalizeProvider + normalizeModels 已迁移到 providers.js

// buildUpstreamPayload + loadProviders + saveProviders 已迁移到 providers.js

// migrateOldApiKey 已迁移到 providers.js

// renderModelSelector + syncModelSelector 已迁移到 providers.js

// ===== Vision: Image Upload =====
function compressImageForUpload(file) {
  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var maxDim = 1024;
        var w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function buildFileContent(m) {
  if (!m.files || m.files.length === 0 || m.role !== 'user') return m.content;
  var hasImages = m.files.some(function(f) { return f.isImage; });
  if (hasImages) {
    var parts = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (var f of m.files) {
      if (f.isImage) {
        parts.push({ type: 'image_url', image_url: { url: 'data:' + f.mimeType + ';base64,' + f.base64 } });
      } else {
        parts.push({ type: 'text', text: '--- ' + f.name + ' ---\n' + f.content });
      }
    }
    return parts;
  } else {
    var fileContext = m.files.map(function(f) { return '--- ' + f.name + ' ---\n' + f.content; }).join('\n\n');
    return m.content
      ? '用户附带了以下文件内容：\n' + fileContext + '\n\n用户消息：\n' + m.content
      : '用户附带了以下文件内容：\n' + fileContext;
  }
}

// Provider Management UI（renderProviderList/openProviderEditor/deleteProvider 等） 已迁移到 providers.js


// 生图 Provider 管理 UI（renderImageProviderList/openImageProviderEditor/deleteImageProvider 等） 已迁移到 image-gen.js

// 生图界面与图库（updateImageGalleryCount/toggleImageView/renderImageStream） 已迁移到 image-gen.js

// 图片预览与分享（showImagePreview/closeImagePreview/shareImage/deleteImageFromGallery） 已迁移到 image-gen.js

// F1: 保存图片到设备相册（APK 用 Filesystem 写入 Download 目录，浏览器用 a 下载）
async function saveImageToDevice(id) {
  var img = (settings.images || []).find(function(x) { return x.id === id; });
  if (!img) return;
  try {
    // 先获取 dataUrl（APK 模式从 Filesystem 读）
    var dataUrl = await getImageDataUrl(img);
    if (!dataUrl) { showToast('图片数据不可用', 'warn'); return; }
    if (isCapacitor() && CapFilesystem) {
      // 写入 Download 目录
      var base64Data = dataUrl.split(',')[1];
      var mime = (dataUrl.match(/data:(.*?);base64/) || [])[1] || 'image/png';
      var ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/webp' ? 'webp' : 'png');
      var fileName = 'chatlite_' + Date.now() + '.' + ext;
      var path = 'Download/' + fileName;
      await CapFilesystem.writeFile({
        path: path,
        data: base64Data,
        directory: 'EXTERNAL_STORAGE',
        recursive: true
      });
      showToast('已保存到 Download/' + fileName, 'success');
    } else {
      // 浏览器：触发下载
      var a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'chatlite_' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast('已触发下载', 'success');
    }
  } catch(e) {
    console.error('saveImageToDevice failed:', e);
    showToast('保存失败: ' + (e.message || e), 'warn');
  }
}

// 图片压缩与存储（compressImageForGeneration/writeImageFile/readImageFile/getImageDataUrl） 已迁移到 image-gen.js


// 生图请求构建（_IMAGE_SIZE_MAP/buildImageSizeConfig/buildImageRequestPayload/base64ToBytes） 已迁移到 image-gen.js

// 核心生图函数（generateImage/fetchImageAsDataUrl） 已迁移到 image-gen.js

// 图库清空与生图界面初始化（clearImageGallery/initImageView） 已迁移到 image-gen.js

// 生图完成通知（notifyImageComplete） 已迁移到 image-gen.js


// save / _saveQueue 已迁移到 db.js

async function loadData() {
  // Try IndexedDB first
  try {
    var data = await idbGet(STORAGE_KEY);
    if (data && data.conversations) {
      state.conversations = data.conversations || [];
      state.currentId = data.currentId || null;
      if (!data.version || data.version < 2) {
        for (const conv of state.conversations) {
          if (conv.messages && Array.isArray(conv.messages) && !conv.messageMap) migrateV1toV2(conv);
        }
      }
      return;
    }
  } catch(e) { console.warn('IndexedDB read failed:', e); }
  // Fallback: migrate from localStorage
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      var d = JSON.parse(raw);
      state.conversations = d.conversations || [];
      state.currentId = d.currentId || null;
      for (const conv of state.conversations) {
        if (conv.messages && Array.isArray(conv.messages) && !conv.messageMap) migrateV1toV2(conv);
      }
      // Migrate to IndexedDB
      await idbPut(STORAGE_KEY, { conversations: state.conversations, currentId: state.currentId, version: 2 });
      console.log('Migrated localStorage → IndexedDB');
    }
  } catch(e) {}
}

async function loadFromServer() {
  try {
    const resp = await fetch('/api/load');
    const data = await resp.json();
    if (data.conversations && data.conversations.length > 0) {
      // Server data is primary — replace localStorage baseline entirely
      state.conversations = data.conversations;
      state.currentId = data.currentId || state.currentId;
      state.deletedIds = data.deletedIds || [];
      // Migrate if needed
      for (const conv of state.conversations) {
        if (conv.messages && Array.isArray(conv.messages) && !conv.messageMap) {
          migrateV1toV2(conv);
        }
      }
      save(); // Persist to IndexedDB + sync to server
      return true;
    }
  } catch(e) {
    console.log('Server not available:', e.message);
  }
  return false;
}


// defaultSettings / migrateSettings 已迁移到 db.js

// 从 IndexedDB 异步加载 settings，首次启动时从旧 localStorage 迁移
// init() 中 await 调用；失败时使用内存中的默认值，不阻断启动
async function initSettings() {
  // 1. 先尝试从 IDB 读
  try {
    var idbData = await idbGet(SETTINGS_IDB_KEY);
    if (idbData && typeof idbData === 'object') {
      settings = migrateSettings(idbData);
      _settingsLoaded = true;
      return;
    }
  } catch(e) { console.warn('initSettings: IDB read failed:', e); }

  // 2. IDB 无数据：尝试从旧 localStorage 迁移（仅一次）
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      var s = JSON.parse(raw);
      settings = migrateSettings(s);
      // 写入 IDB，迁移成功后清理 localStorage
      try {
        await idbPut(SETTINGS_IDB_KEY, settings);
        localStorage.removeItem(SETTINGS_KEY);
        console.log('[chat-lite] settings 已从 localStorage 迁移到 IndexedDB');
      } catch(e2) {
        console.warn('[chat-lite] settings 迁移到 IDB 失败，保留 localStorage:', e2);
      }
      _settingsLoaded = true;
      return;
    }
  } catch(e) { console.warn('initSettings: localStorage 迁移失败:', e); }

  // 3. 都没有：使用默认值
  settings = defaultSettings();
  _settingsLoaded = true;
}

// 状态栏有效值（直接读 conv，兼容旧 template 字段名）
function effectiveStatusBar(conv) {
  var sb = (conv && conv.statusBar) || null;
  if (!sb) return { enabled: false, templateRule: '', displayFields: '', position: 'bottom' };
  if (sb.template && !sb.templateRule) sb.templateRule = sb.template;
  return sb;
}
// B2: 读取模型级修饰语（考虑会话级禁用/覆盖）
function effectiveModelPrompt(conv) {
  if (!conv) return null;
  if (conv.modelPromptDisabled) return null;
  if (conv.modelPromptOverride) return { text: conv.modelPromptOverride };
  if (!settings.modelPrompts) return null;
  var key = (conv.providerId || '') + ':' + (conv.model || '');
  return settings.modelPrompts[key] || null;
}

// saveSettings 已迁移到 db.js

// ===== Conversation Model =====

// Tree helpers
function countWords(text) { return (text || '').length; }

// ===== Background Image =====
function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 1920;
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function applyBackgroundImage() {
  const conv = currentConv();
  const bgEl = document.getElementById('chat-bg');
  if (!bgEl) return;
  if (conv && conv.backgroundImage) {
    bgEl.style.backgroundImage = 'url(' + conv.backgroundImage + ')';
    bgEl.classList.add('active');
  } else {
    bgEl.style.backgroundImage = '';
    bgEl.classList.remove('active');
  }
  // 应用背景遮罩透明度（会话独立）
  const overlay = conv && conv.bgOverlay != null ? conv.bgOverlay : 0.3;
  bgEl.style.setProperty('--bg-overlay', overlay);
  // 同步设置面板里的滑块值
  const slider = document.getElementById('bg-overlay-slider');
  const valueEl = document.getElementById('bg-overlay-value');
  if (slider) slider.value = overlay;
  if (valueEl) valueEl.textContent = Math.round(overlay * 100) + '%';
}

async function setBackgroundImage(file) {
  const dataUrl = await compressImage(file);
  const conv = currentConv();
  if (!conv) return;
  conv.backgroundImage = dataUrl;
  conv.updatedAt = Date.now();
  save();
  applyBackgroundImage();
}

function removeBackgroundImage() {
  const conv = currentConv();
  if (!conv) return;
  delete conv.backgroundImage;
  conv.updatedAt = Date.now();
  save();
  applyBackgroundImage();
}


// ===== DOM refs =====
const $ = id => document.getElementById(id);
const convList = $('conv-list');
const messagesEl = $('messages');
const emptyState = $('empty-state');
const chatInput = $('chat-input');
const btnSend = $('btn-send');
const btnNew = $('btn-new-chat');
const btnUpload = $('btn-upload');
const fileInput = $('file-input');
const filePreview = $('file-preview');
const modelSelect = $('model-select');
const statusIndicator = $('status-indicator');
const settingsPanel = $('settings-panel');
const sidebarToggle = $('btn-sidebar-toggle');
const sidebar = $('sidebar');

// Settings panel elements
const thinkingToggle = $('thinking-toggle');
const systemPromptInput = $('system-prompt');
const userIdentityInput = $('user-identity');
const apiKeyInput = null; // deprecated, providers managed separately

// ===== Init =====
async function init() {
  await loadData(); // IndexedDB (async) — 加载 conversations
  await initSettings(); // IndexedDB — 加载 settings（首次启动从 localStorage 迁移）
  state._dataLoaded = true;
  state.deletedIds = state.deletedIds || [];
  // Server is source of truth — always prefer server data
  // APK 模式无后端，跳过
  if (!isCapacitor()) {
    await loadFromServer();
  }
  // Migrate any old-format conversations
  for (const conv of state.conversations) {
    if (conv.messages && Array.isArray(conv.messages) && !conv.messageMap) {
      migrateV1toV2(conv);
    }
  }

  // Load providers from IndexedDB
  await loadProviders();
  migrateOldApiKey();
  renderModelSelector();

  // F1: 启动时迁移旧图片数据（localStorage 中残留 dataUrl 的图片转存 Filesystem）
  if (isCapacitor() && CapFilesystem && Array.isArray(settings.images)) {
    migrateImportedImagesToFilesystem();
  }

  // v70: 预申请通知权限（Android 13+ 需运行时授权，启动时在前台申请确保弹窗可见）
  if (isCapacitor() && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
    Capacitor.Plugins.LocalNotifications.requestPermissions().then(function(perm) {
      console.log('[Notify] permission:', perm.display);
    }).catch(function(e) { console.warn('[Notify] permission request failed:', e); });
  }

  // Apply settings to UI
  thinkingToggle.checked = settings.thinkingEnabled;
  // 初始化流式模式选择器
  const streamingModeSelect = document.getElementById('native-streaming-mode-select');
  if (streamingModeSelect) streamingModeSelect.value = settings.nativeStreamingMode || 'auto';
  // C3: 振感开关回填（默认开；老用户 settings 无此字段时按默认开处理）
  const hapticCheck = document.getElementById('haptic-feedback-check');
  if (hapticCheck) hapticCheck.checked = (settings.hapticFeedback !== false);
  applyDisplaySettings();

  // Thinking toggle auto-saves immediately (会话级)
  thinkingToggle.addEventListener('change', () => {
    settings.thinkingEnabled = thinkingToggle.checked;
    saveSettings();
    const conv = currentConv();
    if (conv) {
      conv.thinkingEnabled = thinkingToggle.checked;
      save();
    }
  });

  restoreConversationState();
  syncModelSelector();
  renderSidebar();
  renderMessages();
  applyBackgroundImage();

  // Capacitor 模式标记（CSS 用，隐藏 .web-only 元素）
  if (isCapacitor()) {
    document.body.classList.add('capacitor-mode');
    console.log('[chat-lite] Running in Capacitor (APK) mode');
  } else {
    console.log('[chat-lite] Running in Web mode');
  }

  // 触摸滚动监听：流式输出时，用户触摸滚动暂停 DOM 更新，松手后恢复
  // 避免 innerHTML 重建阻塞 touchmove 导致滚动不跟手
  messagesEl.addEventListener('touchstart', function() {
    state._isTouching = true;
  }, { passive: true });
  messagesEl.addEventListener('touchend', function() {
    state._isTouching = false;
    // 松手后立即渲染最新的流式内容
    if (state._streamingMsg) {
      updateMessageContent(state._streamingMsg.id, state._streamingMsg.content, state._streamingMsg.reasoningContent || '');
      // 如果在底部附近，滚到底
      const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      if (distFromBottom < 150) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }
  }, { passive: true });

  // 淡出开屏动画
  var splash = document.getElementById('splash-screen');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(function() { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 300);
  }

  // PWA install prompt handler
  var deferredPrompt;
  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    var banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';
    banner.innerHTML = '<span>安装为应用</span><button id="btn-install-now" class="btn btn-small">安装</button><button id="btn-install-dismiss" class="btn btn-small" style="background:var(--bg3);color:var(--text)">✕</button>';
    document.body.appendChild(banner);
    document.getElementById('btn-install-now').addEventListener('click', function() {
      if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
      banner.remove();
    });
    document.getElementById('btn-install-dismiss').addEventListener('click', function() { banner.remove(); });
  });
  window.addEventListener('appinstalled', function() {
    deferredPrompt = null;
    var b = document.getElementById('install-banner');
    if (b) b.remove();
  });

  // Event listeners
  btnSend.addEventListener('click', sendMessage);
  var btnStop = document.getElementById('btn-stop');
  if (btnStop) btnStop.addEventListener('click', function() {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
  });
  // v90: 回车仅换行（contenteditable 默认行为），发送走独立发送键 btn-send
  btnNew.addEventListener('click', newChat);
  $('conv-search-input').addEventListener('input', renderSidebar);
  $('btn-settings').addEventListener('click', () => toggleSettings(true));
  $('btn-close-settings').addEventListener('click', () => toggleSettings(false));
  $('btn-branch').addEventListener('click', () => { openBranchDrawer(); setTimeout(applyBranchCenter, 200); });
  $('btn-close-branch').addEventListener('click', closeBranchDrawer);
  // Branch search
  $('branch-search-input').addEventListener('input', doBranchSearch);
  $('btn-search-prev').addEventListener('click', () => navigateToSearchResult(-1));
  $('btn-search-next').addEventListener('click', () => navigateToSearchResult(1));
  $('btn-zoom-in').addEventListener('click', () => { branchZoom = branchZoom + 0.08; applyBranchZoom(); updateZoomInput(); });
  $('btn-zoom-out').addEventListener('click', () => { branchZoom = Math.max(branchZoom - 0.08, 0.1); applyBranchZoom(); updateZoomInput(); });
  $('zoom-input').addEventListener('change', () => {
    const v = parseInt($('zoom-input').value) / 100;
    if (v > 0) { branchZoom = v; applyBranchZoom(); }
    updateZoomInput();
  });
  $('zoom-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('zoom-input').blur(); });
  $('btn-export').addEventListener('click', exportConversation);
  $('btn-import').addEventListener('click', () => { document.getElementById('import-file-input').click(); });
  document.getElementById('import-file-input').addEventListener('change', importConversation);
  // 全量导出/导入按钮（APK 迁移用，按钮在设置面板里）
  var btnExportAll = document.getElementById('btn-export-all');
  if (btnExportAll) btnExportAll.addEventListener('click', exportAllData);
  var btnImportAll = document.getElementById('btn-import-all');
  if (btnImportAll) btnImportAll.addEventListener('click', () => { document.getElementById('import-all-file-input').click(); });
  var importAllInput = document.getElementById('import-all-file-input');
  if (importAllInput) importAllInput.addEventListener('change', importAllDataFromFile);
  document.querySelector('#branch-drawer .branch-drawer-backdrop').addEventListener('click', closeBranchDrawer);

  $('btn-save-settings').addEventListener('click', saveSettingsHandler);
  settingsPanel.querySelector('.settings-backdrop').addEventListener('click', () => toggleSettings(false));
  sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('hidden'));
  $('theme-checkbox').addEventListener('change', e => {
    document.body.classList.toggle('dark', e.target.checked);
  });

  // File upload
  btnUpload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
  chatInput.addEventListener('input', updateSendButton);

  // Model change
  modelSelect.addEventListener('change', () => {
    const conv = currentConv();
    if (conv) {
      const parts = modelSelect.value.split(':');
      if (parts.length >= 2) {
        conv.providerId = parts[0];
        conv.model = parts.slice(1).join(':');
      }
      save();
    }
  });

  // Background image
  $('btn-set-bg').addEventListener('click', () => $('bg-file-input').click());
  $('bg-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) setBackgroundImage(file);
    e.target.value = '';
  });
  $('btn-remove-bg').addEventListener('click', removeBackgroundImage);

  // 背景遮罩透明度（会话独立）
  $('bg-overlay-slider').addEventListener('input', (e) => {
    const conv = currentConv();
    if (!conv) return;
    const val = parseFloat(e.target.value);
    conv.bgOverlay = val;
    document.getElementById('bg-overlay-value').textContent = Math.round(val * 100) + '%';
    document.getElementById('chat-bg').style.setProperty('--bg-overlay', val);
  });
  $('bg-overlay-slider').addEventListener('change', () => { save(); });

  // Status bar toggle (B3: 含 displayFields 行控制)
  $('statusbar-toggle').addEventListener('change', function() {
    var show = this.checked;
    $('statusbar-template-row').style.display = show ? '' : 'none';
    var dfRow = document.getElementById('statusbar-display-fields-row');
    if (dfRow) dfRow.style.display = show ? '' : 'none';
    $('statusbar-template-hint').style.display = show ? '' : 'none';
    $('statusbar-position-row').style.display = show ? '' : 'none';
  });

  // 模型修饰复选框：本会话自定义
  var mpOverrideCheck = document.getElementById('model-prompt-override-check');
  if (mpOverrideCheck) {
    mpOverrideCheck.addEventListener('change', function() {
      var row = document.getElementById('model-prompt-override-row');
      if (row) row.style.display = this.checked ? '' : 'none';
    });
  }

  // 设置面板快速回顶/底按钮（滚动容器是 #settings-body；按钮挂在 settings-content 上不随内容滚）
  var settingsScrollCt = document.getElementById('settings-body');
  var settingsScrollBtn = document.getElementById('settings-scroll-btn');
  if (settingsScrollCt && settingsScrollBtn) {
    var updateScrollBtn = function() {
      var nearTop = settingsScrollCt.scrollTop < 200;
      var nearBottom = settingsScrollCt.scrollTop + settingsScrollCt.clientHeight >= settingsScrollCt.scrollHeight - 200;
      settingsScrollBtn.style.display = (nearTop && nearBottom) ? 'none' : '';
      settingsScrollBtn.innerHTML = (nearBottom && !nearTop) ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    };
    settingsScrollCt.addEventListener('scroll', updateScrollBtn);
    settingsScrollBtn.addEventListener('click', function() {
      var nearTop = settingsScrollCt.scrollTop < 200;
      var nearBottom = settingsScrollCt.scrollTop + settingsScrollCt.clientHeight >= settingsScrollCt.scrollHeight - 200;
      if (nearBottom && !nearTop) {
        settingsScrollCt.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        settingsScrollCt.scrollTo({ top: settingsScrollCt.scrollHeight, behavior: 'smooth' });
      }
    });
    // 打开面板时初始触发一次，避免按钮一直 display:none
    state._updateSettingsScrollBtn = updateScrollBtn;
  }

  // F1: 初始化生图界面事件监听
  initImageView();

  // Long press + drag to reorder conversations
  let longPressTimer = null;
  let dragCtx = null;

  function beginHold(el, clientY) {
    clearTimeout(longPressTimer);
    isLongPress = false;
    const rect = el.getBoundingClientRect();
    dragCtx = { el, id: el.dataset.id, startY: clientY, startTop: rect.top, height: rect.height, mode: 'wait' };
    longPressTimer = setTimeout(() => {
      if (!dragCtx || dragCtx.el !== el) return;
      isLongPress = true;
      dragCtx.mode = 'ready';
      convList.querySelectorAll('.conv-item.long-press').forEach(e => e.classList.remove('long-press'));
      el.classList.add('long-press');
    }, 500);
  }

  function continueHold(clientY) {
    if (!dragCtx) return;
    if (dragCtx.mode === 'wait') {
      if (Math.abs(clientY - dragCtx.startY) > 10) { clearTimeout(longPressTimer); dragCtx = null; }
    } else if (dragCtx.mode === 'ready') {
      if (Math.abs(clientY - dragCtx.startY) > 10) {
        dragCtx.mode = 'drag';
        dragCtx.dragStartY = clientY;
        dragCtx.el.classList.remove('long-press');
        dragCtx.el.classList.add('dragging');
        // Lock list, lift item to fixed position
        var rect = dragCtx.el.getBoundingClientRect();
        convList.style.overflow = 'hidden';
        dragCtx.el.style.position = 'fixed';
        dragCtx.el.style.left = rect.left + 'px';
        dragCtx.el.style.top = rect.top + 'px';
        dragCtx.el.style.width = rect.width + 'px';
        dragCtx.el.style.zIndex = '10';
        dragCtx.el.style.transition = 'none';
        dragCtx.fixedStartTop = rect.top;
        isLongPress = false;
      }
    } else if (dragCtx.mode === 'drag') {
      dragCtx.el.style.top = (dragCtx.fixedStartTop + (clientY - dragCtx.dragStartY)) + 'px';
      // Show drop position
      var items = [...convList.querySelectorAll('.conv-item:not(.dragging)')];
      convList.querySelectorAll('.drag-target').forEach(e => e.classList.remove('drag-target'));
      for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) { items[i].classList.add('drag-target'); break; }
      }
      // Auto-scroll near edges (speed proportional to proximity)
      var convRect = convList.getBoundingClientRect();
      var edgeZone = 60;
      var dist = 0, speed = 0;
      if (clientY < convRect.top + edgeZone) {
        dist = clientY - convRect.top;
        speed = -Math.round(20 * (1 - dist / edgeZone));
      } else if (clientY > convRect.bottom - edgeZone) {
        dist = convRect.bottom - clientY;
        speed = Math.round(20 * (1 - dist / edgeZone));
      }
      if (speed) convList.scrollTop += speed;
    }
  }

  function endHold() {
    clearTimeout(longPressTimer);
    if (dragCtx && dragCtx.mode === 'drag') {
      // Calculate drop index from visual positions
      var items = [...convList.querySelectorAll('.conv-item:not(.dragging)')];
      var dropIdx = items.length;
      var draggedRect = dragCtx.el.getBoundingClientRect();
      var draggedMid = draggedRect.top + draggedRect.height / 2;
      for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (draggedMid < r.top + r.height / 2) { dropIdx = i; break; }
      }
      // Reset element
      dragCtx.el.classList.remove('dragging');
      dragCtx.el.style.position = ''; dragCtx.el.style.left = '';
      dragCtx.el.style.top = ''; dragCtx.el.style.width = '';
      dragCtx.el.style.zIndex = ''; dragCtx.el.style.transition = '';
      convList.style.overflow = '';
      convList.querySelectorAll('.drag-target').forEach(e => e.classList.remove('drag-target'));
      // Reorder array
      var conv = state.conversations.find(c => c.id === dragCtx.id);
      var fromIdx = state.conversations.indexOf(conv);
      if (fromIdx >= 0) { state.conversations.splice(fromIdx, 1); state.conversations.splice(dropIdx, 0, conv); save(); }
      dragCtx = null; isLongPress = false; renderSidebar();
    } else {
      dragCtx = null;
    }
  }

  convList.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item || e.target.classList.contains('del-btn') || e.target.tagName === 'INPUT') return;
    beginHold(item, e.clientY);
  });
  document.addEventListener('mousemove', (e) => { if (dragCtx) continueHold(e.clientY); });
  document.addEventListener('mouseup', () => endHold());

  convList.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item || e.target.classList.contains('del-btn') || e.target.tagName === 'INPUT') return;
    beginHold(item, e.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (dragCtx) {
      if (dragCtx.mode === 'drag') e.preventDefault();
      continueHold(e.touches[0].clientY);
    }
  }, { passive: false });
  document.addEventListener('touchend', () => endHold());

  // Click elsewhere to dismiss long-press / message selection
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.conv-item')) {
      convList.querySelectorAll('.conv-item.long-press').forEach(el => el.classList.remove('long-press'));
    }
    if (state.selectedMsgId && !e.target.closest('.message')) {
      state.selectedMsgId = null;
      renderMessages();
    }
  });

  // Provider management
  $('btn-add-provider').addEventListener('click', function() { openProviderEditor(-1); });
  $('btn-close-provider-editor').addEventListener('click', closeProviderEditor);
  $('btn-test-provider').addEventListener('click', testProviderConnection);
  $('btn-save-provider').addEventListener('click', saveProviderFromEditor);
  $('provider-template-select').addEventListener('change', function() {
    var t = getProviderTemplate(this.value);
    document.getElementById('provider-endpoint-input').value = t.endpointPath;
    document.getElementById('provider-auth-select').value = t.authType;
    document.getElementById('provider-auth-header-input').value = t.authHeader;
    document.getElementById('provider-auth-prefix-input').value = t.authPrefix;
    toggleProviderAuthFields();
  });
  $('provider-auth-select').addEventListener('change', toggleProviderAuthFields);
  renderProviderList();

  // Enable send button on init
  updateSendButton();
}

function currentConv() {
  return state.conversations.find(c => c.id === state.currentId);
}


  // Character card: import PNG → 大文本框完整呈现解析内容（角色卡栏目定位为解析工具，不自动填入提示词）
  $('btn-import-card').addEventListener('click', () => { document.getElementById('card-import-file').click(); });
  document.getElementById('card-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const card = parseCharacterCard(buf);
      if (!card) { alert('未找到角色卡数据'); return; }
      const data = card.data || card;
      const text = formatCardFields(data);
      if (!text) { alert('角色卡解析成功但内容为空'); return; }
      document.getElementById('card-editor').style.display = 'block';
      document.getElementById('card-content').value = text;
    } catch(err) { alert('导入失败: ' + err.message); }
    e.target.value = '';
  });

  // 快捷填入：暂不自动填入提示词，仅展开编辑器并提示手动复制
  $('btn-card-fill').addEventListener('click', () => {
    document.getElementById('card-editor').style.display = 'block';
    showToast('角色卡内容已在上方文本框完整呈现，请按需复制到系统提示词', 'info');
  });

  $('btn-export-card').addEventListener('click', async () => {
    const avatarFile = document.getElementById('card-avatar').files[0];
    if (!avatarFile) { alert('请先选择头像 PNG 文件'); return; }
    try {
      const fields = parseCardText(document.getElementById('card-content').value);
      const blob = await generateCharacterCard(fields, avatarFile);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (fields.name || 'character') + '.png';
      a.click();
      URL.revokeObjectURL(url);
    } catch(err) { alert('导出失败: ' + err.message); }
  });

  document.getElementById('card-avatar').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      document.getElementById('card-avatar-preview').src = URL.createObjectURL(file);
      document.getElementById('card-avatar-preview').style.display = 'block';
    }
  });


// ===== Conflict resolution =====


// ===== Sidebar =====


function newChat() {
  if (state.loading) return;
  const conv = newConversation();
  conv.title = `对话 ${state.conversations.length + 1}`;
  state.conversations.push(conv);
  state.currentId = conv.id;
  save();
  renderSidebar();
  renderMessages();
  syncModelSelector();
  applyBackgroundImage();
  chatInput.focus();
}

// ===== Breadcrumb =====

// ===== Messages Rendering =====

// ===== Long press helper =====

// ===== A6+D6+D7: 气泡自定义上下文菜单 =====
// 接管 contextmenu + addLongPress，含 4 种复制变体 + 复制选中文字


// 提取 AI 正文：去掉 <status>...</status> 标签

// 提取 markdown 代码块内容（去围栏）

// 复制成功反馈：复用 setStatus('saved') 机制

// 流式振感反馈（_initStreamHaptics / triggerHapticFeedback 及五档常量）已迁移到 haptics.js
// ===== C1: 回到底部按钮 =====
// 距底 >200px 显示，<200px 隐藏；点击平滑滚到底
function initScrollBottomButton() {
  if (document.getElementById('btn-scroll-bottom')) return;
  const btn = document.createElement('button');
  btn.id = 'btn-scroll-bottom';
  btn.className = 'btn-scroll-bottom';
  btn.title = '回到底部';
  btn.setAttribute('aria-label', '回到底部');
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  btn.style.display = 'none';
  // 插到 input-area 之前（浮在 input 上方右侧）
  const inputArea = document.getElementById('input-area');
  if (inputArea && inputArea.parentNode) {
    inputArea.parentNode.insertBefore(btn, inputArea);
  } else {
    document.body.appendChild(btn);
  }
  // 监听滚动
  const onScroll = function() {
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    btn.style.display = (distFromBottom > 200) ? 'flex' : 'none';
  };
  messagesEl.addEventListener('scroll', onScroll, { passive: true });
  // 点击平滑滚到底
  btn.addEventListener('click', function() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    btn.style.display = 'none';
  });
  // 初始检查一次
  requestAnimationFrame(onScroll);
}
document.addEventListener('DOMContentLoaded', initScrollBottomButton);

// Sibling navigation (branch switching)


// Touch-friendly resize for edit textarea
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('mousedown', onResizeStart);
  document.addEventListener('touchstart', onResizeStart, { passive: false });
});

function onResizeStart(e) {
  const handle = e.target.closest('.edit-resize-handle');
  if (!handle) return;
  e.preventDefault();
  const msgId = handle.dataset.for;
  const ta = document.getElementById(`edit-ta-${msgId}`);
  if (!ta) return;

  const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
  const startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
  const startW = ta.offsetWidth;
  const startH = ta.offsetHeight;

  const onMove = (ev) => {
    const cx = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX;
    const cy = ev.type === 'touchmove' ? ev.touches[0].clientY : ev.clientY;
    const dw = cx - startX;
    const dh = cy - startY;
    ta.style.width = Math.max(200, startW + dw) + 'px';
    ta.style.height = Math.max(100, startH + dh) + 'px';
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    // 智能滚动：只在用户处于底部附近（150px 内）时才自动滚动
    // 用户主动往上滑看历史内容时，不被强制拉回底部
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    if (distFromBottom < 150) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
}

// ===== Edit Message =====


// ===== Regenerate =====

// ===== Delete Message =====

// ===== Send Message =====


// ===== Capacitor 原生流式 HTTP（方案 C：capacitor-stream-http 插件）=====
// 用 StreamHttp.startStream + chunk/end/error 事件实现真流式
// 首字延迟从"等完整响应"降到"等模型开始输出"
// 停止生成用 cancelStream 真正中断请求，不浪费 API 额度

// ===== 统一请求入口：根据配置选择方案 A（非流式）或方案 C（流式）=====

// ===== Capacitor 原生 HTTP（方案 A：非流式 + 打字动画）=====
// 在 APK 模式下，fetch 流式不可靠，改用 CapacitorHttp 一次性请求 + typewriter 假动画
// 停止生成：原生请求无法真正中断，用 state._nativeAborted 标记，响应到达后丢弃

// 打字机效果：逐字显示新增内容
// 性能优化：
// - 动画过程中用 textContent 快速更新（O(1)，不解析 markdown）
// - 每 300ms 做一次 markdown 渲染（marked.parse）
// - 动画结束时最终完整渲染
// - 不触发 save()（避免 IndexedDB 写入风暴）和 renderMessages()（避免全量重渲染）


// ===== Continue Generation =====


// ===== Branch drawer =====

let branchZoom = 1;


// Pinch-zoom for mobile
let pinchState = null;
function initPinchZoom() {
  const container = document.querySelector('.branch-drawer-body');
  if (!container) return;
  container.addEventListener('touchstart', onPinchStart, {passive:false});
  container.addEventListener('touchmove', onPinchMove, {passive:false});
  container.addEventListener('touchend', onPinchEnd);
  // Desktop: Alt+wheel zoom, mouse drag pan
  container.addEventListener('wheel', onWheelZoom, {passive:false});
  container.addEventListener('mousedown', onMouseDown);
}

function removePinchListeners() {
  const container = document.querySelector('.branch-drawer-body');
  if (!container) return;
  container.removeEventListener('touchstart', onPinchStart);
  container.removeEventListener('touchmove', onPinchMove);
  container.removeEventListener('touchend', onPinchEnd);
  container.removeEventListener('wheel', onWheelZoom);
  container.removeEventListener('mousedown', onMouseDown);
  pinchState = null;
}

// Alt+wheel zoom on desktop
function onWheelZoom(e) {
  if (!e.altKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.05 : 0.05;
  const container = e.currentTarget;
  const rect = container.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const svgX = (container.scrollLeft + mx) / branchZoom;
  const svgY = (container.scrollTop + my) / branchZoom;
  branchZoom = Math.max(0.1, Math.min(branchZoom + delta, 50));
  applyBranchZoom();
  updateZoomInput();
  container.scrollLeft = svgX * branchZoom - mx;
  container.scrollTop = svgY * branchZoom - my;
}

// Mouse drag to pan on desktop
let mouseDrag = null;
function onMouseDown(e) {
  if (e.button !== 0) return;
  mouseDrag = { x: e.clientX, y: e.clientY, sx: e.currentTarget.scrollLeft, sy: e.currentTarget.scrollTop };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}
function onMouseMove(e) {
  if (!mouseDrag) return;
  const dx = mouseDrag.x - e.clientX, dy = mouseDrag.y - e.clientY;
  document.querySelector('.branch-drawer-body').scrollLeft = mouseDrag.sx + dx;
  document.querySelector('.branch-drawer-body').scrollTop = mouseDrag.sy + dy;
}
function onMouseUp() { mouseDrag = null; window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); }

function onPinchStart(e) {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const t1 = e.touches[0], t2 = e.touches[1];
  pinchState = {
    dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
    midX: (t1.clientX + t2.clientX) / 2,
    midY: (t1.clientY + t2.clientY) / 2,
    startZoom: branchZoom,
    container: document.querySelector('.branch-drawer-body'),
    svg: document.querySelector('.branch-svg')
  };
}

function onPinchMove(e) {
  if (!pinchState || e.touches.length !== 2) return;
  e.preventDefault();
  const t1 = e.touches[0], t2 = e.touches[1];
  const newDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  // Dead zone: skip if fingers barely moved (< 2px change)
  if (Math.abs(newDist - pinchState.dist) < 2) return;
  const scale = newDist / pinchState.dist;
  const newZoom = Math.max(0.1, Math.min(pinchState.startZoom * scale, 50));
  
  // Use the CURRENT pinch midpoint, not the initial one
  const curMidX = (t1.clientX + t2.clientX) / 2;
  const curMidY = (t1.clientY + t2.clientY) / 2;
  
  // Record the SVG coordinate under the CURRENT pinch midpoint BEFORE zoom
  const container = pinchState.container;
  const containerRect = container.getBoundingClientRect();
  const midScreenX = curMidX - containerRect.left;
  const midScreenY = curMidY - containerRect.top;
  const svgX = (container.scrollLeft + midScreenX) / pinchState.startZoom;
  const svgY = (container.scrollTop + midScreenY) / pinchState.startZoom;
  
  branchZoom = newZoom;
  applyBranchZoom();
  updateZoomInput();
  
  // After zoom, reposition so the same SVG coordinate is under the same screen position
  container.scrollLeft = svgX * newZoom - midScreenX;
  container.scrollTop = svgY * newZoom - midScreenY;
  pinchState.startZoom = newZoom;
}

function onPinchEnd() {
  pinchState = null;
}

// ===== SVG Tree Layout & Rendering =====


function updateZoomInput() {
  const inp = document.getElementById('zoom-input');
  if (inp) inp.value = Math.round(branchZoom * 100);
}

const NODE_COLORS = [
  { name: '默认', value: null },
  { name: '红', value: '#ef4444' },
  { name: '绿', value: '#22c55e' },
  { name: '蓝', value: '#3b82f6' },
  { name: '黄', value: '#eab308' },
  { name: '紫', value: '#a855f7' },
  { name: '橙', value: '#f97316' },
  { name: '灰', value: '#6b7280' },
];

window.svgNodeRename = function(nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, nodeId);
  if (!msg) return;
  const curColor = msg.color ? NODE_COLORS.findIndex(c => c.value === msg.color) : 0;
  const input = prompt(
    '右键菜单：\n• 选色: 输入 0-7 (当前:' + NODE_COLORS[curColor].name + ')\n• 改名: 直接输入新名称\n\n0.默认 1.红 2.绿 3.蓝 4.黄 5.紫 6.橙 7.灰',
    msg.title || ''
  );
  if (input === null) return;
  const n = parseInt(input);
  if (!isNaN(n) && n >= 0 && n <= 7) {
    msg.color = NODE_COLORS[n].value;
    save();
    openBranchDrawer();
    return;
  }
  if (input.trim()) {
    msg.title = input.trim();
    save();
    openBranchDrawer();
    renderMessages();
  }
};

// ===== Branch tree node context menu =====


// Bind long-press on tree nodes after render

window.svgNodeColor = function(nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, nodeId);
  if (!msg) return;
  const colorList = NODE_COLORS.map((c,i) => `${i}. ${c.name}`).join('\n');
  const idx = prompt('选择节点颜色:\n' + colorList + '\n输入数字:', msg.color ? NODE_COLORS.findIndex(c => c.value === msg.color).toString() : '0');
  if (idx !== null) {
    const ci = parseInt(idx) || 0;
    if (ci >= 0 && ci < NODE_COLORS.length) {
      msg.color = NODE_COLORS[ci].value;
      save();
      openBranchDrawer();
      renderMessages();
    }
  }
};

// ===== File Upload =====
state.pendingFiles = [];

function handleFileUpload(e) {
  const files = e.target.files;
  if (!files.length) return;

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      // Image: compress + base64
      compressImageForUpload(file).then(function(dataUrl) {
        var base64 = dataUrl.split(',')[1];
        state.pendingFiles.push({
          name: file.name,
          type: file.type,
          isImage: true,
          base64: base64,
          mimeType: file.type,
          content: base64,
          size: file.size
        });
        renderFilePreview();
      });
    } else {
      // Text: read as text
      var reader = new FileReader();
      reader.onload = function(ev) {
        state.pendingFiles.push({
          name: file.name,
          type: file.type || 'text/plain',
          isImage: false,
          content: ev.target.result,
          size: file.size
        });
        renderFilePreview();
      };
      reader.readAsText(file);
    }
  }
  fileInput.value = '';
}

function renderFilePreview() {
  if (state.pendingFiles.length === 0) {
    filePreview.style.display = 'none';
    return;
  }
  filePreview.style.display = 'flex';
  filePreview.innerHTML = state.pendingFiles.map((f, i) => {
    if (f.isImage) {
      return '<span class="file-tag file-tag-image">' +
        '<img src="data:' + f.mimeType + ';base64,' + f.base64 + '" class="file-thumb" />' +
        escapeHtml(f.name) +
        '<button class="remove-file" data-idx="' + i + '">✕</button></span>';
    }
    return '<span class="file-tag">' + escapeHtml(f.name) + ' (' + formatSize(f.size) + ')' +
      '<button class="remove-file" data-idx="' + i + '">✕</button></span>';
  }).join('');

  filePreview.querySelectorAll('.remove-file').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      state.pendingFiles.splice(idx, 1);
      renderFilePreview();
    });
  });
}

function clearFilePreview() {
  state.pendingFiles = [];
  filePreview.style.display = 'none';
  filePreview.innerHTML = '';
}

// ===== Settings =====
function applyDisplaySettings() {
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--lh', settings.lineSpacing);
}

// B1: 根据 tab 回填表单（conv tab 时 conv 字段优先，回退 global；global tab 时只读 global）
function fillSettingsForm() {
  var conv = currentConv();
  // 会话级字段（直接从 conv 读取，无全局继承）
  thinkingToggle.checked = conv ? (conv.thinkingEnabled !== false) : true;
  systemPromptInput.value = (conv && conv.systemPrompt) || '';
  $('emphasis-prompt').value = (conv && conv.emphasis) || '';
  userIdentityInput.value = (conv && conv.userIdentity) || '';
  var sb = effectiveStatusBar(conv);
  $('statusbar-toggle').checked = sb.enabled;
  var ruleEl = document.getElementById('statusbar-template-rule');
  var dfEl = document.getElementById('statusbar-display-fields');
  if (ruleEl) ruleEl.value = sb.templateRule || '';
  if (dfEl) dfEl.value = sb.displayFields || '';
  $('statusbar-position').value = sb.position || 'bottom';
  var showRows = sb.enabled ? '' : 'none';
  $('statusbar-template-row').style.display = showRows;
  var dfRow = document.getElementById('statusbar-display-fields-row');
  if (dfRow) dfRow.style.display = showRows;
  $('statusbar-template-hint').style.display = showRows;
  $('statusbar-position-row').style.display = showRows;
  // 全局偏好字段
  var dmCheck = document.getElementById('direct-mode-check');
  if (dmCheck) dmCheck.checked = settings.directMode || false;
  var smSelect = document.getElementById('native-streaming-mode-select');
  if (smSelect) smSelect.value = settings.nativeStreamingMode || 'auto';
  var hfCheck = document.getElementById('haptic-feedback-check');
  if (hfCheck) hfCheck.checked = settings.hapticFeedback !== false;
  var fsSelect = document.getElementById('font-size-select');
  var lsSelect = document.getElementById('line-spacing-select');
  if (fsSelect) fsSelect.value = settings.fontSize || '15';
  if (lsSelect) lsSelect.value = settings.lineSpacing || '1.6';
  // B2: 模型修饰
  var mpKey = conv ? ((conv.providerId || '') + ':' + (conv.model || '')) : '';
  var mpLabel = document.getElementById('model-prompts-key-label');
  if (mpLabel) mpLabel.textContent = mpKey || '(无当前会话)';
  var mp = (conv && settings.modelPrompts && settings.modelPrompts[mpKey]) || {};
  var mpTextEl = document.getElementById('model-prompt-text');
  if (mpTextEl) mpTextEl.value = mp.text || '';
  var mpDisableEl = document.getElementById('model-prompt-disable-check');
  if (mpDisableEl) mpDisableEl.checked = !!(conv && conv.modelPromptDisabled);
  var mpOverrideEl = document.getElementById('model-prompt-override-check');
  var mpOverrideRow = document.getElementById('model-prompt-override-row');
  var hasOverride = !!(conv && conv.modelPromptOverride);
  if (mpOverrideEl) mpOverrideEl.checked = hasOverride;
  if (mpOverrideRow) mpOverrideRow.style.display = hasOverride ? '' : 'none';
  var mpOverrideTextEl = document.getElementById('model-prompt-override');
  if (mpOverrideTextEl) mpOverrideTextEl.value = (conv && conv.modelPromptOverride) || '';
  // C5: 应用分组收折记忆状态
  applyGroupCollapseState();
}

// C5: 应用设置分组收折状态（根据 settings.groupCollapse 覆盖 HTML 默认 open）
function applyGroupCollapseState() {
  var gc = settings.groupCollapse || {};
  var groups = document.querySelectorAll('#settings-body .setting-group-collapsible[data-group-key]');
  groups.forEach(function(el) {
    var key = el.getAttribute('data-group-key');
    if (!key) return;
    // 绑定 toggle 事件（仅绑一次，用 dataset 标记）
    if (!el.dataset.collapseBound) {
      el.dataset.collapseBound = '1';
      el.addEventListener('toggle', function() {
        if (!settings.groupCollapse) settings.groupCollapse = {};
        settings.groupCollapse[key] = !el.open; // true=折叠, false=展开
        saveSettings();
      });
    }
    // 覆盖 HTML 默认 open：记忆为折叠则强制收起，记忆为展开则强制展开
    if (gc[key] === true) el.open = false;
    else if (gc[key] === false) el.open = true;
  });
}

function toggleSettings(open) {
  state.settingsOpen = open;
  settingsPanel.style.display = open ? 'flex' : 'none';
  if (open) {
    renderProviderList();
    renderImageProviderList();   // F1: 生图 API provider 列表
    updateImageGalleryCount();   // F1: 图库计数
    fillSettingsForm();
    // 刷新回顶/底按钮状态（等 DOM 布局完成）
    setTimeout(function() { if (state._updateSettingsScrollBtn) state._updateSettingsScrollBtn(); }, 0);
  }
}

function saveSettingsHandler() {
  // 全局偏好
  settings.thinkingEnabled = thinkingToggle.checked;
  settings.directMode = document.getElementById('direct-mode-check')?.checked || false;
  const streamingModeSelect = document.getElementById('native-streaming-mode-select');
  if (streamingModeSelect) settings.nativeStreamingMode = streamingModeSelect.value;
  const hapticCheck = document.getElementById('haptic-feedback-check');
  if (hapticCheck) settings.hapticFeedback = hapticCheck.checked;
  const fsSelect = document.getElementById('font-size-select');
  const lsSelect = document.getElementById('line-spacing-select');
  if (fsSelect) settings.fontSize = fsSelect.value;
  if (lsSelect) settings.lineSpacing = lsSelect.value;
  applyDisplaySettings();
  saveSettings();

  // 会话级字段
  const conv = currentConv();
  if (conv) {
    conv.thinkingEnabled = thinkingToggle.checked;
    conv.systemPrompt = systemPromptInput.value.trim() || null;
    conv.emphasis = $('emphasis-prompt').value.trim() || null;
    conv.userIdentity = userIdentityInput.value.trim() || null;
    conv.statusBar = {
      enabled: $('statusbar-toggle').checked,
      templateRule: (document.getElementById('statusbar-template-rule') || {}).value ? (document.getElementById('statusbar-template-rule').value || '').trim() : '',
      displayFields: (document.getElementById('statusbar-display-fields') || {}).value ? (document.getElementById('statusbar-display-fields').value || '').trim() : '',
      position: $('statusbar-position').value
    };
    // B2: 模型修饰会话级覆盖
    var mpDisableEl = document.getElementById('model-prompt-disable-check');
    if (mpDisableEl) conv.modelPromptDisabled = mpDisableEl.checked;
    var mpOverrideEl = document.getElementById('model-prompt-override-check');
    var mpOverrideTextEl = document.getElementById('model-prompt-override');
    if (mpOverrideEl && mpOverrideEl.checked && mpOverrideTextEl) {
      conv.modelPromptOverride = mpOverrideTextEl.value.trim() || null;
    } else {
      conv.modelPromptOverride = null;
    }
    save();
  }

  // B2: 全局模型修饰语保存
  if (conv) {
    var mpKey = (conv.providerId || '') + ':' + (conv.model || '');
    var mpTextEl = document.getElementById('model-prompt-text');
    var newText = mpTextEl ? mpTextEl.value.trim() : '';
    if (newText) {
      settings.modelPrompts[mpKey] = { text: newText };
    } else {
      delete settings.modelPrompts[mpKey];
    }
    saveSettings();
  }

  toggleSettings(false);
}


// ===== Version Navigation =====
window.prevVersion = function(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg && msg.activeVersion > 0) {
    const curContent = msg.content;
    msg.content = msg.versions[msg.activeVersion - 1].content;
    msg.versions[msg.activeVersion - 1].content = curContent;
    msg.activeVersion--;
    msg.wordCount = countWords(msg.content);
    save();
    renderMessages();
  }
};

window.nextVersion = function(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg && msg.activeVersion < msg.versions.length - 1) {
    const curContent = msg.content;
    msg.content = msg.versions[msg.activeVersion + 1].content;
    msg.versions[msg.activeVersion + 1].content = curContent;
    msg.activeVersion++;
    msg.wordCount = countWords(msg.content);
    save();
    renderMessages();
  }
};

// ===== UI Helpers =====


function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

// ===== Sidebar close on mobile =====
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 768 && !sidebar.classList.contains('hidden')) {
    if (!sidebar.contains(e.target) && e.target !== sidebarToggle && !sidebarToggle.contains(e.target)) {
      sidebar.classList.add('hidden');
    }
  }
});

// ===== Import / Export =====

// 等待 IndexedDB 数据加载完成（避免导出空数据）

// 导出全部数据（对话 + Provider + 设置）
// APK 模式：用 Filesystem 写入 + Share 分享；Web 模式：用 <a download>
// 修复（v1.3.0 批次1+）：原方案 btoa(unescape(encodeURIComponent(jsonText))) 在大数据
//   （几十MB）时会同时持有 5 份字符串副本，峰值内存约 5x 数据量，触发 Android WebView OOM 卡退。
//   改用 Filesystem 6.x 原生 encoding:'utf8' 直接写文本，峰值降到 2x；JSON 也用紧凑格式省 30%+。

// 导入全部数据
// mode: 'overwrite'（覆盖，默认）或 'merge'（按 ID 合并，冲突时导入数据优先）
// 修复（v1.3.0 批次1+）：导入前自动备份原走 btoa(unescape(encodeURIComponent(...))) 路径，
//   若用户当前数据也大，导入大文件时会在备份步骤 OOM 崩溃，反而把当前数据搞丢。
//   改用 encoding:'utf8' 直接写文本，与 exportAllData 一致。

// F1: 把 settings.images 中残留的 dataUrl 转存到 Filesystem（导入旧备份后的清理）
// 图片迁移（migrateImportedImagesToFilesystem） 已迁移到 image-gen.js

// 文件选择回调（用于 importAllData 的 <input type="file">）
// 修复（v1.3.0 批次1+）：加 loading toast 提示，超大文件（>80MB）警告但不禁阻


// Tolerant JSON parse: handles truncated array exports that miss outer brackets


// Convert DZMM (dzmm.ai) export format to chat-lite tree

// Convert 豆包/类角色平台 export format to chat-lite tree

// ===== Debug: expose state for CDP inspection =====
window.__chatState = state;
window.__debugConv = function(id) {
  const conv = id ? state.conversations.find(c => c.id === id) : currentConv();
  if (!conv) return null;
  return {
    id: conv.id,
    title: conv.title,
    providerId: conv.providerId,
    model: conv.model,
    rootId: conv.rootId,
    activePath: conv.activePath,
    thinkingEnabled: conv.thinkingEnabled,
    messageCount: Object.keys(conv.messageMap || {}).length,
    tree: buildTreeDebug(conv),
    importSource: conv._importSource || null
  };
};
window.__debugList = function() {
  return state.conversations.map(c => ({
    id: c.id, title: c.title, msgCount: Object.keys(c.messageMap || {}).length,
    rootId: c.rootId, pathLen: (c.activePath||[]).length
  }));
};
window.__debugDump = function() {
  const conv = currentConv();
  if (!conv) return null;
  return JSON.parse(JSON.stringify(conv));
};

function buildTreeDebug(conv) {
  const visited = new Set();
  function walk(id, depth) {
    if (!id || visited.has(id)) return null;
    visited.add(id);
    const msg = conv.messageMap?.[id];
    if (!msg) return null;
    return {
      id: id.slice(0,8),
      role: msg.role,
      title: msg.title,
      wordCount: msg.wordCount || 0,
      content: (msg.content||'').substring(0, 60),
      children: (msg.children||[]).map(cid => walk(cid, depth+1)).filter(Boolean),
      inPath: (conv.activePath||[]).includes(id)
    };
  }
  return walk(conv.rootId, 0);
}


// ===== PNG Character Card utilities =====

// Parse a PNG file ArrayBuffer and extract character card JSON

// Generate a PNG character card from fields + avatar image buffer

// Build system prompt from card fields

// CRC32 table
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crc32Table[i] = c;
}


// ===== Start =====
document.addEventListener('DOMContentLoaded', init);
