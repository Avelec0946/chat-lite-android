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
    directMode: false, hapticFeedback: true, nativeStreamingMode: 'auto',
    // v122: 等待模型返回的空闲超时（毫秒，默认 300s=5 分钟）
    // 取代原 nativeTimeoutMs（120 秒、且没有任何 UI 入口）—— 那个值在原生 30 秒写死的读超时面前形同虚设
    chatWaitMs: 300000,
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
    // v123: 生图反馈振感（生成开始/完成/失败各一次轻反馈，默认开）
    imageHaptic: true,
    // v123: 每个生图渠道上次选中的模型 {providerId: model}，切渠道时恢复而不是覆盖
    imageModelByProvider: {},
    // v123: 最近使用过的生图提示词（最多 20 条，最新在前）
    imageRecentPrompts: [],
    // F1: 生图 API 配置
    imageProviders: [],
    imageProviderId: null,
    images: [],
    // v125: 语音通话（详见 voice-模块-架构契约.md §3.1）
    voice: defaultVoiceSettings()
  };
}

// v125: 语音通话设置的默认值。
//   独立成函数的原因：migrateSettings 也需要逐字段补默认（老用户没有 voice 字段），
//   两处共用同一份真相，避免"默认值写了两次、改一处忘一处"。
function defaultVoiceSettings() {
  return {
    enabled: true,
    asrProviderId: '',      // 空 = 用内置 MiMo 兜底
    asrModel: 'mimo-v2.5-asr',
    ttsProviderId: '',
    ttsModel: 'mimo-v2.5-tts',
    // v126：大脑一律跟随当前会话，不再单独设渠道/模型。
    //   用户原话「直接跟随会话窗口模型，不额外设置」——留两个空字段只会让人以为没生效。
    voiceId: 'Mia',
    voiceDesign: '',        // 非空则优先用声音设计模型
    cloneRefName: '',       // 克隆参考音（存文件系统，不存 base64）
    personaId: 'warm',
    customPersona: '',
    sensitivity: 0.5,
    endpointSilenceMs: 700,
    minUtteranceMs: 400,
    bargeIn: true,
    bargeInThreshold: 0.35,
    showTranscript: true,
    showSignals: true,
    autoHangupSilenceMs: 45000,
    ttsFormat: 'pcm16',
    // v125 修（QA 发现）：契约 §3.1 里写了 rate 但这里漏了，
    //   而 migrateVoiceSettings 只保留 defaultVoiceSettings() 里有的键 ——
    //   于是用户手写 rate 也会被**静默丢掉**，voice.js 读 voiceCfg().rate 永远拿到默认 1。
    //   这是「字段写了但用不了」的典型：没人报错，功能就是不存在。默认 1 = 正常速度。
    rate: 1.0,
    // v125 修（QA 发现）：契约里叫 haptics（复数），实现里读的是 haptic（单数）。
    //   两个都保留以避免再踩：haptic 是实际生效字段，haptics 作为兼容别名同步。
    haptic: true,
    haptics: true,

    // ===== v126 新增 =====
    // 时间感知（默认关）。关着的时候模型不知道"现在几点""隔了多久"，
    //   长时间挂着聊天会把隔两小时当成紧接着 —— 但多数人打电话并不需要这层，
    //   而且它每轮都要多占 prompt，所以默认关闭、由用户按需打开。
    timestamps: false,
    // 语速。rate 是倍率；rateMode 决定"变速时音高变不变"：
    //   natural = WSOLA 保持音高（像真人说快/说慢），pitch = 老式 playbackRate（会变尖）。
    //   默认 natural —— 变尖的加速一听就假，那是"调播放器"，不是"人在说话"。
    rate: 1.0,
    rateMode: 'natural',
    // 音频路由。auto = 问原生要实际路由（耳机/蓝牙/外放），
    //   speaker/headset 是手动钉死（原生不可用时的兜底，也给用户一个确定性选择）。
    routeMode: 'auto',
    // 双套微调预设：外放回声大需要更大的防自激窗口，耳机不需要。
    //   两套可以各调各的，也可以复制成一样（用户要求"可共享也可独立"）。
    tuningPresets: { speaker: {}, headset: {} }
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
  // v123: 生图相关的三个新字段（只增不改，老用户补默认值）
  if (typeof s.imageHaptic !== 'boolean') s.imageHaptic = true;
  if (!s.imageModelByProvider || typeof s.imageModelByProvider !== 'object') s.imageModelByProvider = {};
  if (!Array.isArray(s.imageRecentPrompts)) s.imageRecentPrompts = [];
  // v125: 语音通话字段迁移 —— 逐字段补默认（只增不改）
  //   不能整体用默认值覆盖：用户点过一次「音色」就只写了 voiceId，其余字段必须保住默认。
  //   类型也要校验：前端数字输入框存回来是字符串（"700"），range 存回来可能 NaN。
  s.voice = migrateVoiceSettings(s.voice);
  return s;
}

function migrateVoiceSettings(v) {
  var def = defaultVoiceSettings();
  if (!v || typeof v !== 'object') return def;
  var out = {};
  for (var k in def) {
    if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
    out[k] = Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined && v[k] !== null ? v[k] : def[k];
  }
  // 类型收敛
  out.enabled = !!out.enabled;
  out.bargeIn = !!out.bargeIn;
  out.showTranscript = !!out.showTranscript;
  out.showSignals = !!out.showSignals;
  out.haptic = !!out.haptic;
  out.sensitivity = clampNum(out.sensitivity, 0, 1, def.sensitivity);
  out.bargeInThreshold = clampNum(out.bargeInThreshold, 0.05, 1, def.bargeInThreshold);
  out.endpointSilenceMs = clampNum(out.endpointSilenceMs, 300, 3000, def.endpointSilenceMs);
  out.minUtteranceMs = clampNum(out.minUtteranceMs, 200, 3000, def.minUtteranceMs);
  out.autoHangupSilenceMs = clampNum(out.autoHangupSilenceMs, 5000, 600000, def.autoHangupSilenceMs);
  // v126 新增字段的收敛
  out.timestamps = !!out.timestamps;
  out.rate = clampNum(out.rate, 0.6, 1.6, def.rate);
  if (out.rateMode !== 'natural' && out.rateMode !== 'pitch') out.rateMode = def.rateMode;
  if (out.routeMode !== 'auto' && out.routeMode !== 'speaker' && out.routeMode !== 'headset') {
    out.routeMode = def.routeMode;
  }
  out.tuningPresets = normalizeTuningPresets(out.tuningPresets);
  ['asrProviderId','asrModel','ttsProviderId','ttsModel',
   'voiceId','voiceDesign','cloneRefName','personaId','customPersona'].forEach(function(k) {
    if (typeof out[k] !== 'string') out[k] = def[k];
  });
  // 模型名是必填项：空串会让上游报错，回落到默认
  if (!out.asrModel.trim()) out.asrModel = def.asrModel;
  if (!out.ttsModel.trim()) out.ttsModel = def.ttsModel;
  if (!out.voiceId.trim()) out.voiceId = def.voiceId;
  if (!out.personaId.trim()) out.personaId = def.personaId;
  return out;
}

// v126：双套微调预设的归一化。
//   为什么单独做：这两套值是"用户手调出来的"，键名和范围跟 voice.js 的 TUNING_FIELDS 一致；
//   但预设里只存"用户改过的项"，没改的项不该被写成默认值（否则以后改默认值，老用户永远收不到）。
//   所以这里只做三件事：确保 speaker/headset 两个对象存在、丢掉非法键、把值收敛成数字。
function normalizeTuningPresets(p) {
  var out = { speaker: {}, headset: {} };
  if (!p || typeof p !== 'object') return out;
  var ranges = {
    echoGuardMs: [0, 1200], bargeInHoldMs: [80, 800], bargeInLeakFactor: [1.5, 10],
    leakFloor: [0, 1], endpointSilenceMs: [200, 3000], minUtteranceMs: [100, 2000],
    sensitivity: [0, 1]
  };
  ['speaker', 'headset'].forEach(function (side) {
    var src = p[side];
    if (!src || typeof src !== 'object') return;
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(ranges, k)) continue;   // 未知键直接丢，防止脏数据长期驻留
      var r = ranges[k];
      var n = typeof src[k] === 'number' ? src[k] : parseFloat(src[k]);
      if (!isFinite(n)) continue;
      out[side][k] = Math.max(r[0], Math.min(r[1], n));
    }
  });
  return out;
}

// 数字收敛：接受字符串（表单回填），非法值回落默认
function clampNum(v, min, max, fallback) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
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
      // v124: v123 新增的缩略图内存副本。**只在有文件版时**剥离 ——
      //   APK 模式靠 thumbName 读盘、不需要这段 base64；浏览器模式没有 Filesystem，
      //   剥了就等于永远没有缩略图，所以保留。
      if (lite.thumbName && lite.thumbDataUrl) lite.thumbDataUrl = null;
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
