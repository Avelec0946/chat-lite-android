// ===== db.js : 存储层模块（v2.0 拆分） =====
// 模块名：db.js
// 版本：v74（cache-bust）
// 迁移日期：2026-07-26
// 来源：从 app.js 拆分
// 职责：IndexedDB 存储层 + 持久化函数
// 依赖：app.js 运行时提供 state / settings / showToast / isCapacitor / normalizeImageProvider
// 加载顺序：必须在 app.js 之前加载（本文件中的 defaultSettings 会被 app.js 顶层调用）
//
// 迁移清单：
//   常量：STORAGE_KEY, SETTINGS_KEY, IDB_NAME, IDB_VER, IDB_STORE, SETTINGS_IDB_KEY
//   变量：_saveQueue（save 的私有队列）
//   函数：openDB, idbPut, idbGet, save, defaultSettings, migrateSettings, saveSettings
//
// 保留在 app.js：
//   let settings = defaultSettings();  // 全局状态变量
//   let _settingsLoaded = false;       // initSettings 中维护
//   let isLongPress = false;           // 与存储无关

// ===== Storage Keys =====
const STORAGE_KEY = 'chatlite_data';
const SETTINGS_KEY = 'chatlite_settings';

// ===== IndexedDB (replaces localStorage for large data) =====
const IDB_NAME = 'chatlite_db';
const IDB_VER = 1;
const IDB_STORE = 'data';

// ===== settings 存储基底重构：localStorage → IndexedDB =====
// 旧基底 localStorage 配额仅 5-10MB，图库元数据 + imageProviders + modelPrompts 累积会撑爆
// IndexedDB 配额通常数百 MB 起步，按域名可达 GB 级，且无 QuotaExceededError 风险
// 启动时 init() 中 await initSettings() 从 IDB 加载或从 localStorage 迁移
const SETTINGS_IDB_KEY = 'chatlite_settings_v2';  // 与旧 localStorage 的 SETTINGS_KEY 区分，避免双写

function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}

function idbPut(key, val) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  });
}

function idbGet(key) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readonly');
      var req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  });
}

// ===== 会话持久化（IndexedDB + 浏览器模式同步到服务器） =====
var _saveQueue = Promise.resolve();
function save() {
  const conv = state.conversations.find(c => c.id === state.currentId);
  if (conv) conv.updatedAt = Date.now();
  // IndexedDB (async, fire-and-forget)
  var payload = { conversations: state.conversations, currentId: state.currentId, version: 2 };
  idbPut(STORAGE_KEY, payload).catch(function(e) {
    console.warn('IndexedDB save failed:', e);
    showToast('本地存储保存失败', 'warn');
  });
  // Sync to server (queued, with retry) — 仅浏览器模式需要，APK 无后端
  if (!isCapacitor()) {
    _saveQueue = _saveQueue.then(function() {
      return fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversations: state.conversations,
          currentId: state.currentId,
          deletedIds: state.deletedIds || []
        })
      }).then(function(resp) {
        if (!resp.ok) throw new Error('Server save failed: ' + resp.status);
        return resp.json();
      }).catch(function(err) {
        console.error('Server save error:', err);
        // Retry once after 2s
        return new Promise(function(resolve) {
          setTimeout(function() {
            fetch('/api/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                conversations: state.conversations,
                currentId: state.currentId,
                deletedIds: state.deletedIds || []
              })
            }).then(resolve).catch(resolve);
          }, 2000);
        });
      });
    });
  }
}

// ===== settings 默认值与迁移 =====
// settings 默认值（同步，不读存储）
function defaultSettings() {
  return {
    thinkingEnabled: true, apiKey: '', fontSize: '15', lineSpacing: '1.6',
    directMode: false, hapticFeedback: true, nativeStreamingMode: 'auto', nativeTimeoutMs: 120000,
    // v99: 生图专用总超时（毫秒，默认 600s=10 分钟；聊天 nativeTimeoutMs 不影响生图）
    imageNativeTimeoutMs: 600000,
    // v101: 生图 prompt 前缀体系（全局正面前缀/负面前缀/消息模板，参照酒馆思路自行实现）
    imagePromptPrefix: '',
    imageNegativePrefix: '',
    imagePromptTemplate: '',
    // B2: 分模型修饰语 {"<providerId>:<modelId>": {text: "修饰语\n\n===强调===\n强调内容"}}
    modelPrompts: {},
    // C5: 设置分组收折状态记忆 {groupKey: true=折叠/false=展开}
    groupCollapse: {},
    // F1: 生图 API 配置
    imageProviders: [],
    imageProviderId: null,
    images: []
  };
}

// 对从存储（IDB 或 localStorage）读出的 settings 应用字段迁移和归一化
function migrateSettings(s) {
  if (!s || typeof s !== 'object') return defaultSettings();
  // 迁移：旧版有 settings.global，提示词字段已回归会话级，移除 global
  if (s.global) {
    if (s.global.thinkingEnabled !== undefined && s.thinkingEnabled === undefined) {
      s.thinkingEnabled = s.global.thinkingEnabled;
    }
    delete s.global;
  }
  // 迁移：旧 modelPrompts[key] = {systemPrompt, emphasis} -> 合并为 {text}
  if (s.modelPrompts) {
    for (var k in s.modelPrompts) {
      var mp = s.modelPrompts[k];
      if (mp && mp.text === undefined && (mp.systemPrompt || mp.emphasis)) {
        var parts = [];
        if (mp.systemPrompt) parts.push(mp.systemPrompt);
        if (mp.emphasis) parts.push('===强调===\n' + mp.emphasis);
        mp.text = parts.join('\n\n');
        delete mp.systemPrompt;
        delete mp.emphasis;
      }
    }
  } else {
    s.modelPrompts = {};
  }
  // C5: 确保 groupCollapse 字段存在且为对象
  if (!s.groupCollapse || typeof s.groupCollapse !== 'object') s.groupCollapse = {};
  // F1: 生图 API 字段迁移（旧用户无此字段时补默认值，并对 imageProviders 做归一化）
  if (!Array.isArray(s.imageProviders)) s.imageProviders = [];
  else s.imageProviders = s.imageProviders.map(function(p) { return normalizeImageProvider(p); });
  if (typeof s.imageProviderId !== 'string') s.imageProviderId = null;
  // imageProviderId 指向不存在的 provider 时回退到首个
  if (s.imageProviderId && !s.imageProviders.some(function(p) { return p.id === s.imageProviderId; })) {
    s.imageProviderId = s.imageProviders.length > 0 ? s.imageProviders[0].id : null;
  }
  if (!Array.isArray(s.images)) s.images = [];
  return s;
}

// 异步写入 IndexedDB（替代 localStorage.setItem）
// 内存中 settings 已同步更新（调用方修改 settings.xxx 后调本函数持久化）
// 失败时仅提示，不影响内存数据；图片 dataUrl 已通过 Filesystem 分离存储，settings 通常体积可控
//
// v85 修复导入旧备份时 OOM：
//   旧判断 `img.dataUrl && img.fileName` 在导入旧备份（图片无 fileName）时为 false，
//   导致含大 base64 的 settings 直接走 idbPut，IDB structured clone 序列化时内存峰值翻倍触发 OOM。
//   修复：只要 images 中存在 dataUrl 就走剥离分支（无论是否有 fileName）。
function saveSettings() {
  settings.directMode = document.getElementById('direct-mode-check')?.checked || false;
  // 防御：剥离残留的图片 dataUrl（APK 模式下 dataUrl 应为 null，仅 fileName 引用 Filesystem）
  // v85: 避免 JSON.parse(JSON.stringify(settings)) 全量克隆（导入旧备份时 settings 含 60MB+ base64，全量序列化会 OOM）
  //      改为浅克隆顶层 + images 数组逐项浅克隆 + 剥离大字段，内存峰值从 2x 降到 1x + 少量浅克隆开销
  var toPersist = settings;
  var hasInlineImg = (settings.images || []).some(function(img) { return !!img.dataUrl || !!img.referenceImages || !!img.thumbnailDataUrl; });
  if (hasInlineImg) {
    toPersist = Object.assign({}, settings);
    toPersist.images = (settings.images || []).map(function(img) {
      if (!img || typeof img !== 'object') return img;
      var lite = Object.assign({}, img);
      if (lite.dataUrl) lite.dataUrl = null;
      if (lite.referenceImages) lite.referenceImages = null;
      if (lite.thumbnailDataUrl) lite.thumbnailDataUrl = null;
      return lite;
    });
  }
  // v97 方案B（最小冗余）：settings 同步镜像一份到 localStorage（不含大 base64，体积可控）。
  // IndexedDB 目录丢失时（2026-08-21 实测事故：WebView 更新/损坏重建清掉 app_webview/Default/IndexedDB），
  // localStorage 镜像可兜底恢复配置；读取时 IDB 优先、镜像兜底。镜像常驻不删除。
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toPersist));
  } catch(e) {
    console.warn('saveSettings: localStorage 镜像写入失败:', e);
  }
  // 异步写 IDB，不阻塞 UI；写入失败仅提示
  idbPut(SETTINGS_IDB_KEY, toPersist).then(function() {
    // 静默成功
  }).catch(function(e) {
    console.error('saveSettings: IDB write failed:', e);
    showToast('设置保存失败：' + (e && e.message ? e.message : e), 'warn');
  });
}
