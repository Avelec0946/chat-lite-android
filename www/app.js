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
if (isCapacitor()) {
  try {
    CapFilesystem = Capacitor.Plugins && Capacitor.Plugins.Filesystem;
    CapShare = Capacitor.Plugins && Capacitor.Plugins.Share;
    CapHttp = Capacitor.Plugins && Capacitor.Plugins.CapacitorHttp;
    CapStreamHttp = Capacitor.Plugins && Capacitor.Plugins.StreamHttp;
  } catch (e) {
    console.warn('Capacitor plugins init failed:', e);
  }
}

// ===== State =====
const state = {
  conversations: [],
  currentId: null,
  loading: false,
  abortController: null,
  settingsOpen: false,
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

const STORAGE_KEY = 'chatlite_data';
const SETTINGS_KEY = 'chatlite_settings';

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

// ===== IndexedDB (replaces localStorage for large data) =====
const IDB_NAME = 'chatlite_db';
const IDB_VER = 1;
const IDB_STORE = 'data';

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
let settings = loadSettings();
let isLongPress = false;

// ===== Helpers =====
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function showToast(msg, type) {
  var t = document.getElementById('app-toast');
  if (!t) { t = document.createElement('div'); t.id = 'app-toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast' + (type === 'warn' ? ' warn' : '');
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(function() { t.classList.remove('show'); }, 4000);
}

function parseJsonField(str, fallback) {
  str = (str || '').trim();
  if (!str || str === '{}') return fallback || {};
  try {
    var parsed = JSON.parse(str);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback || {};
    return parsed;
  } catch(e) {
    return fallback || {};
  }
}

function toggleProviderAuthFields() {
  var authType = document.getElementById('provider-auth-select').value;
  var headerRow = document.getElementById('provider-auth-header-row');
  var prefixRow = document.getElementById('provider-auth-prefix-row');
  if (!headerRow || !prefixRow) return;
  if (authType === 'bearer') {
    headerRow.style.display = 'none';
    prefixRow.style.display = 'none';
  } else if (authType === 'api-key') {
    headerRow.style.display = 'flex';
    prefixRow.style.display = 'none';
  } else if (authType === 'header') {
    headerRow.style.display = 'flex';
    prefixRow.style.display = 'flex';
  } else if (authType === 'query') {
    headerRow.style.display = 'flex';
    prefixRow.style.display = 'none';
  } else if (authType === 'none') {
    headerRow.style.display = 'none';
    prefixRow.style.display = 'none';
  }
}

// ===== Provider System =====
const PROVIDERS_KEY = 'chatlite_providers';
state.providers = [];

function getProvider(id) {
  var raw = (state.providers || []).find(function(p) { return p.id === id; }) || null;
  return raw ? normalizeProvider(raw) : null;
}

function normalizeBaseUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

// ===== Provider Templates =====
const PROVIDER_TEMPLATES = {
  openai: {
    endpointPath: '/v1/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: false, supportsVision: true, maxTokensField: 'max_tokens' }
  },
  deepseek: {
    endpointPath: '/v1/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: true, supportsVision: false, maxTokensField: 'max_tokens' }
  },
  azure: {
    endpointPath: '/openai/deployments/{model}/chat/completions',
    authType: 'api-key',
    authHeader: 'api-key',
    authPrefix: '',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: false, supportsVision: true, maxTokensField: 'max_tokens' }
  },
  custom: {
    endpointPath: '/v1/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: false, supportsVision: true, maxTokensField: 'max_tokens' }
  }
};

function getProviderTemplate(template) {
  return PROVIDER_TEMPLATES[template] || PROVIDER_TEMPLATES.openai;
}

function normalizeProvider(p) {
  if (!p || typeof p !== 'object') p = {};
  var template = getProviderTemplate(p.template);
  var baseUrl = normalizeBaseUrl(p.baseUrl);
  // If baseUrl still ends with a version path (legacy migration), strip it and put into endpointPath
  var endpointPath = p.endpointPath;
  if (!endpointPath) {
    var m = baseUrl.match(/^(.*)(\/v\d+)$/i);
    if (m) {
      baseUrl = m[1];
      endpointPath = m[2] + '/chat/completions';
    } else {
      endpointPath = template.endpointPath;
    }
  }
  return {
    id: p.id || uid(),
    name: p.name || '未命名接口',
    template: p.template || 'openai',
    baseUrl: baseUrl,
    endpointPath: endpointPath,
    apiKey: p.apiKey || '',
    authType: p.authType || template.authType,
    authHeader: p.authHeader || template.authHeader,
    authPrefix: p.authPrefix !== undefined ? p.authPrefix : template.authPrefix,
    extraHeaders: p.extraHeaders || {},
    extraQuery: p.extraQuery || {},
    models: normalizeModels(p.models),
    features: Object.assign({}, template.features, p.features || {}),
    createdAt: p.createdAt || Date.now()
  };
}

function normalizeModels(models) {
  if (!models) return [];
  // 兼容 OpenAI 标准格式 { data: [...] } 和其他平台 { models: [...] }
  if (!Array.isArray(models)) {
    if (models.data && Array.isArray(models.data)) models = models.data;
    else if (models.models && Array.isArray(models.models)) models = models.models;
  }
  if (typeof models === 'string') return models.split(/[,，]/).map(function(s) { return s.trim(); }).filter(Boolean).map(function(id) { return { id: id }; });
  if (!Array.isArray(models)) return [];
  return models.map(function(m) {
    if (typeof m === 'string') return { id: m };
    return { id: m.id || m.name, name: m.name || m.id, upstreamId: m.upstreamId || m.id || m.name };
  }).filter(function(m) { return m.id; });
}

function modelToUpstreamId(provider, modelId) {
  var model = (provider.models || []).find(function(m) { return m.id === modelId; });
  return (model && model.upstreamId) || modelId;
}

function resolveTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, function(m, k) { return vars[k] !== undefined ? vars[k] : m; });
}

function buildUpstreamPayload(provider, body) {
  var p = normalizeProvider(provider);
  var url = new URL(resolveTemplate(p.endpointPath, {
    model: body.model,
    apiVersion: body.apiVersion || p.extraQuery['api-version'] || '2024-06-01'
  }), p.baseUrl);

  Object.entries(p.extraQuery || {}).forEach(function(kv) {
    url.searchParams.set(kv[0], kv[1]);
  });

  var headers = Object.assign({ 'Content-Type': 'application/json' }, p.extraHeaders || {});
  if (p.authType === 'bearer') {
    headers[p.authHeader] = (p.authPrefix || 'Bearer ') + p.apiKey;
  } else if (p.authType === 'api-key') {
    headers[p.authHeader] = p.apiKey;
  } else if (p.authType === 'header') {
    headers[p.authHeader] = (p.authPrefix || '') + p.apiKey;
  } else if (p.authType === 'query') {
    url.searchParams.set(p.authHeader || 'api_key', p.apiKey);
  }

  var payload = Object.assign({}, body);
  // Convert thinkingEnabled flag to thinking field
  // 只要用户明确关闭思考开关，就发送 thinking: { type: 'disabled' }
  // 不管模板的 supportsThinking 设置——大多数 OpenAI 兼容平台支持此字段，
  // 不支持的平台会忽略它，不会报错
  if (payload.thinkingEnabled === false) {
    payload.thinking = { type: 'disabled' };
  } else {
    // 开启思考时不发送 thinking 字段，让 API 用默认行为
    delete payload.thinking;
  }
  delete payload.thinkingEnabled;
  delete payload.apiVersion;
  delete payload.provider;
  if (p.features.maxTokensField && p.features.maxTokensField !== 'max_tokens' && payload.max_tokens !== undefined) {
    payload[p.features.maxTokensField] = payload.max_tokens;
    delete payload.max_tokens;
  }

  return { url: url.toString(), headers: headers, payload: payload };
}

function getModelsEndpoint(provider) {
  var p = normalizeProvider(provider);
  var template = getProviderTemplate(p.template);
  return resolveTemplate(p.modelsEndpoint || template.modelsEndpoint, { apiVersion: p.extraQuery['api-version'] || '2024-06-01' });
}

async function loadProviders() {
  try {
    var data = await idbGet(PROVIDERS_KEY);
    if (data && Array.isArray(data)) {
      state.providers = data.map(function(p) { return normalizeProvider(p); });
      return;
    }
  } catch(e) { console.warn('loadProviders failed:', e); }
  state.providers = [];
}

function saveProviders() {
  idbPut(PROVIDERS_KEY, state.providers).catch(function(e) {
    console.warn('saveProviders failed:', e);
    showToast('接口配置保存失败', 'warn');
  });
}

function migrateOldApiKey() {
  // One-time migration from old settings.apiKey to Provider system
  if (state.providers.length > 0) return; // already has providers
  var oldKey = settings.apiKey || '';
  if (!oldKey) return; // no old key to migrate
  var provider = normalizeProvider({
    name: 'DeepSeek',
    template: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: oldKey,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  });
  state.providers.push(provider);
  saveProviders();
  // Migrate conversations: match model name to provider
  for (var conv of state.conversations) {
    if (!conv.providerId) {
      var matched = state.providers.find(function(p) { return p.models && p.models.some(function(m) { return m.id === conv.model; }); });
      if (matched) conv.providerId = matched.id;
    }
  }
  // Clear old key
  delete settings.apiKey;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  console.log('Migrated old API key to Provider system');
}

function renderModelSelector() {
  var sel = $('model-select');
  if (!sel) return;
  if (!state.providers || state.providers.length === 0) {
    sel.innerHTML = '<option disabled selected>请先在设置中添加接口</option>';
    return;
  }
  var html = '';
  for (var p of state.providers) {
    var models = p.models || [];
    if (models.length === 0) continue;
    html += '<optgroup label="' + escapeHtml(p.name) + '">';
    for (var m of models) {
      var val = p.id + ':' + m.id;
      html += '<option value="' + escapeHtml(val) + '">' + escapeHtml(m.name || m.id) + '</option>';
    }
    html += '</optgroup>';
  }
  sel.innerHTML = html;
}

function syncModelSelector() {
  var conv = currentConv();
  if (!conv) return;
  if (conv.providerId && conv.model) {
    var val = conv.providerId + ':' + conv.model;
    var sel = $('model-select');
    if (sel && sel.querySelector('option[value="' + CSS.escape(val) + '"]')) {
      sel.value = val;
    } else {
      // Fallback: find first available
      var fallback = state.providers.find(function(p) { return p.models && p.models.length > 0; });
      if (fallback) {
        conv.providerId = fallback.id;
        conv.model = fallback.models[0].id;
        sel.value = fallback.id + ':' + fallback.models[0].id;
      }
    }
  } else if (state.providers.length > 0) {
    var p = state.providers[0];
    if (p.models && p.models.length > 0) {
      conv.providerId = p.id;
      conv.model = p.models[0].id;
      var sel2 = $('model-select');
      if (sel2) sel2.value = p.id + ':' + p.models[0].id;
    }
  }
}

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

// ===== Provider Management UI =====
function renderProviderList() {
  var container = document.getElementById('provider-list');
  if (!container) return;
  if (!state.providers || state.providers.length === 0) {
    container.innerHTML = '<div class="provider-empty">暂无接口，点击上方按钮添加</div>';
    return;
  }
  container.innerHTML = state.providers.map(function(p, i) {
    var templateLabel = p.template ? '[' + p.template.toUpperCase() + '] ' : '';
    var models = (p.models || []).map(function(m) { return m.name || m.id; }).join(', ') || '(无模型)';
    return '<div class="provider-item" data-idx="' + i + '">' +
      '<div class="provider-header">' +
        '<span class="provider-name">' + escapeHtml(templateLabel + p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="btn btn-small provider-edit" data-idx="' + i + '">编辑</button>' +
          '<button class="btn btn-small provider-delete" data-idx="' + i + '" style="background:var(--bg3);color:var(--text)">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="provider-detail">' +
        '<span class="provider-url">' + escapeHtml(p.baseUrl) + '</span>' +
        '<span class="provider-endpoint">' + escapeHtml(p.endpointPath || '') + '</span>' +
        '<span class="provider-models">模型: ' + escapeHtml(models) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  container.querySelectorAll('.provider-edit').forEach(function(btn) {
    btn.addEventListener('click', function() { openProviderEditor(parseInt(btn.dataset.idx)); });
  });
  container.querySelectorAll('.provider-delete').forEach(function(btn) {
    btn.addEventListener('click', function() { deleteProvider(parseInt(btn.dataset.idx)); });
  });
}

function openProviderEditor(idx) {
  var editor = document.getElementById('provider-editor');
  var p = (idx !== undefined && idx >= 0) ? normalizeProvider(state.providers[idx]) : null;
  editor.style.display = 'block';
  editor.dataset.editIdx = idx !== undefined ? idx : '';
  document.getElementById('provider-template-select').value = p ? p.template : 'openai';
  document.getElementById('provider-name-input').value = p ? p.name : '';
  document.getElementById('provider-url-input').value = p ? p.baseUrl : '';
  document.getElementById('provider-endpoint-input').value = p ? (p.endpointPath || '') : '';
  document.getElementById('provider-auth-select').value = p ? p.authType : 'bearer';
  document.getElementById('provider-auth-header-input').value = p ? (p.authHeader || '') : '';
  document.getElementById('provider-auth-prefix-input').value = p ? (p.authPrefix !== undefined ? p.authPrefix : '') : 'Bearer ';
  document.getElementById('provider-key-input').value = p ? p.apiKey : '';
  document.getElementById('provider-extra-headers-input').value = p ? JSON.stringify(p.extraHeaders || {}, null, 2) : '{}';
  document.getElementById('provider-extra-query-input').value = p ? JSON.stringify(p.extraQuery || {}, null, 2) : '{}';
  document.getElementById('provider-models-input').value = p ? (p.models || []).map(function(m) { return m.id; }).join(', ') : '';
  document.getElementById('provider-test-result').textContent = '';
  document.getElementById('provider-test-result').className = 'provider-test-result';
  toggleProviderAuthFields();
}

function closeProviderEditor() {
  document.getElementById('provider-editor').style.display = 'none';
}

async function testProviderConnection() {
  var baseUrl = normalizeBaseUrl(document.getElementById('provider-url-input').value);
  var apiKey = document.getElementById('provider-key-input').value.trim();
  var template = document.getElementById('provider-template-select').value;
  var endpointPath = document.getElementById('provider-endpoint-input').value.trim();
  var authType = document.getElementById('provider-auth-select').value;
  var authHeader = document.getElementById('provider-auth-header-input').value.trim();
  var authPrefix = document.getElementById('provider-auth-prefix-input').value;
  var extraHeaders = parseJsonField(document.getElementById('provider-extra-headers-input').value, {});
  var extraQuery = parseJsonField(document.getElementById('provider-extra-query-input').value, {});
  var resultEl = document.getElementById('provider-test-result');
  if (!baseUrl || !apiKey) {
    resultEl.textContent = '请填写 API 地址和密钥';
    resultEl.className = 'provider-test-result error';
    return;
  }
  var tempProvider = normalizeProvider({
    template: template,
    baseUrl: baseUrl,
    endpointPath: endpointPath,
    apiKey: apiKey,
    authType: authType,
    authHeader: authHeader,
    authPrefix: authPrefix,
    extraHeaders: extraHeaders,
    extraQuery: extraQuery
  });
  resultEl.textContent = '测试中...';
  resultEl.className = 'provider-test-result';
  try {
    var req = buildUpstreamPayload(tempProvider, { model: '', apiVersion: extraQuery['api-version'] || '2024-06-01' });
    // Derive models endpoint from chat URL instead of hardcoding /v1/models
    var modelsPath = req.url.replace(/\/chat\/completions/, '/models');
    var resp = await fetch(modelsPath, { headers: req.headers });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    var models = normalizeModels(data).map(function(m) { return m.id; });
    if (models.length > 0) {
      document.getElementById('provider-models-input').value = models.join(', ');
      resultEl.innerHTML = ICON.check + ' 连接成功，发现 ' + models.length + ' 个模型';
      resultEl.className = 'provider-test-result success';
    } else {
      resultEl.innerHTML = ICON.warn + ' 连接成功但未发现模型，请手动填写';
      resultEl.className = 'provider-test-result warn';
    }
  } catch(e) {
    resultEl.innerHTML = ICON.x + ' 连接失败: ' + e.message;
    resultEl.className = 'provider-test-result error';
  }
}

function saveProviderFromEditor() {
  var editor = document.getElementById('provider-editor');
  var template = document.getElementById('provider-template-select').value;
  var name = document.getElementById('provider-name-input').value.trim();
  var baseUrl = normalizeBaseUrl(document.getElementById('provider-url-input').value);
  var endpointPath = document.getElementById('provider-endpoint-input').value.trim();
  var authType = document.getElementById('provider-auth-select').value;
  var authHeader = document.getElementById('provider-auth-header-input').value.trim();
  var authPrefix = document.getElementById('provider-auth-prefix-input').value;
  var apiKey = document.getElementById('provider-key-input').value.trim();
  var extraHeaders = parseJsonField(document.getElementById('provider-extra-headers-input').value, {});
  var extraQuery = parseJsonField(document.getElementById('provider-extra-query-input').value, {});
  var modelsStr = document.getElementById('provider-models-input').value.trim();
  var models = modelsStr ? modelsStr.split(/[,，]/).map(function(s) { return s.trim(); }).filter(Boolean) : [];
  if (!name || !baseUrl || !apiKey) {
    showToast('请填写接口名称、地址和密钥', 'warn');
    return;
  }
  var providerData = {
    template: template,
    name: name,
    baseUrl: baseUrl,
    endpointPath: endpointPath,
    apiKey: apiKey,
    authType: authType,
    authHeader: authHeader,
    authPrefix: authPrefix,
    extraHeaders: extraHeaders,
    extraQuery: extraQuery,
    models: models
  };
  var editIdx = editor.dataset.editIdx;
  if (editIdx !== '' && editIdx !== undefined && parseInt(editIdx) >= 0) {
    // Preserve original id
    providerData.id = state.providers[parseInt(editIdx)].id;
    state.providers[parseInt(editIdx)] = normalizeProvider(providerData);
  } else {
    state.providers.push(normalizeProvider(providerData));
  }
  saveProviders();
  renderProviderList();
  renderModelSelector();
  syncModelSelector();
  closeProviderEditor();
}

function deleteProvider(idx) {
  if (!confirm('确定删除接口「' + state.providers[idx].name + '」？')) return;
  state.providers.splice(idx, 1);
  saveProviders();
  // Fix conversations referencing deleted provider
  for (var conv of state.conversations) {
    if (conv.providerId && !getProvider(conv.providerId)) {
      conv.providerId = null;
    }
  }
  save();
  renderProviderList();
  renderModelSelector();
  syncModelSelector();
}


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

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return { thinkingEnabled: true, apiKey: '', fontSize: '15', lineSpacing: '1.6', directMode: false };
}

function saveSettings() {
  settings.directMode = document.getElementById('direct-mode-check')?.checked || false;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ===== Conversation Model =====
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
    thinkingEnabled: settings.thinkingEnabled,
    systemPrompt: '',
    userIdentity: '',
    rootId: msgId,
    activePath: [msgId],
    messageMap: { [msgId]: rootMsg },
    createdAt: Date.now()
  };
}

// Tree helpers
function getMsg(conv, id) { return conv.messageMap[id]; }
function getActiveChain(conv) {
  return conv.activePath.map(id => conv.messageMap[id]).filter(Boolean);
}
function getLastActiveMsg(conv) {
  const chain = getActiveChain(conv);
  return chain[chain.length - 1] || null;
}
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
  await loadData(); // IndexedDB (async)
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

  // Apply settings to UI
  thinkingToggle.checked = settings.thinkingEnabled;
  // 初始化流式模式选择器
  const streamingModeSelect = document.getElementById('native-streaming-mode-select');
  if (streamingModeSelect) streamingModeSelect.value = settings.nativeStreamingMode || 'auto';
  applyDisplaySettings();

  // Thinking toggle auto-saves immediately
  thinkingToggle.addEventListener('change', () => {
    settings.thinkingEnabled = thinkingToggle.checked;
    saveSettings();
    const conv = currentConv();
    if (conv) {
      conv.thinkingEnabled = settings.thinkingEnabled;
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
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
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

  // Status bar toggle
  $('statusbar-toggle').addEventListener('change', function() {
    var show = this.checked;
    $('statusbar-template-row').style.display = show ? '' : 'none';
    $('statusbar-template-hint').style.display = show ? '' : 'none';
    $('statusbar-position-row').style.display = show ? '' : 'none';
  });

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

function restoreConversationState() {
  if (state.conversations.length === 0) {
    const conv = newConversation();
    conv.title = '对话 1';
    conv.thinkingEnabled = settings.thinkingEnabled;
    state.conversations.push(conv);
    state.currentId = conv.id;
    save();
  }
}


  // Character card: import PNG
  $('btn-import-card').addEventListener('click', () => { document.getElementById('card-import-file').click(); });
  document.getElementById('card-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const card = parseCharacterCard(buf);
      if (!card) { alert('未找到角色卡数据'); return; }
      const data = card.data || card;
      document.getElementById('card-editor').style.display = 'block';
      document.getElementById('card-name').value = data.name || '';
      document.getElementById('card-desc').value = data.description || '';
      document.getElementById('card-personality').value = data.personality || '';
      document.getElementById('card-scenario').value = data.scenario || '';
      var fmes = (data.first_mes || '');
      // Strip HTML-like content tags
      fmes = fmes.replace(/<content>/gi, '').replace(/<\/content>/gi, '');
      fmes = fmes.replace(/<StatusBlock>[\s\S]*?<\/StatusBlock>/gi, '');
      fmes = fmes.replace(/<status>[\s\S]*?<\/status>/gi, '');
      document.getElementById('card-firstmes').value = fmes.trim();
      document.getElementById('card-example').value = data.mes_example || '';
      document.getElementById('card-sysprompt').value = data.system_prompt || '';
      updateCardPreview();
      // Auto-fill system prompt
      var prompt = buildCardPrompt({
        name: document.getElementById('card-name').value,
        description: document.getElementById('card-desc').value,
        personality: document.getElementById('card-personality').value,
        scenario: document.getElementById('card-scenario').value,
        first_mes: document.getElementById('card-firstmes').value,
        mes_example: document.getElementById('card-example').value,
        system_prompt: document.getElementById('card-sysprompt').value
      });
      document.getElementById('system-prompt').value = prompt;
    } catch(err) { alert('导入失败: ' + err.message); }
    e.target.value = '';
  });

  $('btn-card-fill').addEventListener('click', () => {
    document.getElementById('card-editor').style.display = 'block';
    const p = updateCardPreview();
    document.getElementById('system-prompt').value = p;
  });

  $('btn-export-card').addEventListener('click', async () => {
    const avatarFile = document.getElementById('card-avatar').files[0];
    if (!avatarFile) { alert('请先选择头像 PNG 文件'); return; }
    try {
      const fields = {
        name: document.getElementById('card-name').value,
        description: document.getElementById('card-desc').value,
        personality: document.getElementById('card-personality').value,
        scenario: document.getElementById('card-scenario').value,
        first_mes: document.getElementById('card-firstmes').value,
        mes_example: document.getElementById('card-example').value,
        system_prompt: document.getElementById('card-sysprompt').value,
        creator: '',
        creator_notes: '',
        character_version: '1.0'
      };
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

  ['card-name','card-desc','card-personality','card-scenario','card-firstmes','card-example','card-sysprompt'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', updateCardPreview);
  });

function updateCardPreview() {
  var f = {
    name: document.getElementById('card-name').value,
    description: document.getElementById('card-desc').value,
    personality: document.getElementById('card-personality').value,
    scenario: document.getElementById('card-scenario').value,
    first_mes: document.getElementById('card-firstmes').value,
    mes_example: document.getElementById('card-example').value,
    system_prompt: document.getElementById('card-sysprompt').value
  };
  var p = buildCardPrompt(f);
  document.getElementById('card-preview').textContent = p || '(预览系统提示词)';
  return p;
}



// ===== Conflict resolution =====
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


// ===== Sidebar =====
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

function newChat() {
  if (state.loading) return;
  const conv = newConversation();
  conv.title = `对话 ${state.conversations.length + 1}`;
  conv.thinkingEnabled = settings.thinkingEnabled;
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

// ===== Messages Rendering =====
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
    addLongPress(bubble, () => {
      state.selectedMsgId = msg.id;
      renderMessages();
    });
    bubble.addEventListener('contextmenu', (e) => e.preventDefault());

    const editBtn = div.querySelector('.edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => enterEditMode(msg.id));

    const regenBtn = div.querySelector('.regenerate-btn');
    if (regenBtn) regenBtn.addEventListener('click', () => regenerate(msg.id));

    const deleteBtn = div.querySelector('.delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteMessage(msg.id));

    const copyBtn = div.querySelector('.copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      var text = msg.content || '';
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
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msg.id, textarea.value); }
          if (e.key === 'Escape') cancelEdit(msg.id);
        });
      }
      if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(msg.id, textarea?.value || ''));
      if (cancelBtn) cancelBtn.addEventListener('click', () => cancelEdit(msg.id));
    }
  });

  scrollToBottom();
}

// ===== Long press helper =====
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
      callback();
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

// Sibling navigation (branch switching)
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
  // Use lastIndexOf to find the LAST <status> tag (avoid matching examples in debug output)
  var content = msg.content || '';
  var lastStatusStart = content.lastIndexOf('<status>');
  var lastStatusEnd = content.lastIndexOf('</status>');
  var statusMatch = null;
  if (lastStatusStart !== -1 && lastStatusEnd !== -1 && lastStatusEnd > lastStatusStart) {
    statusMatch = [content.slice(lastStatusStart, lastStatusEnd + '</status>'.length), content.slice(lastStatusStart + '<status>'.length, lastStatusEnd)];
  }
  if (statusMatch) {
    var statusHtml = marked.parse(statusMatch[1].trim(), { breaks: true, gfm: true });
    var conv = currentConv();
    var position = (conv?.statusBar?.position) || 'bottom';
    var statusBarHtml = '<div class="status-bar status-bar-' + position + '">' + statusHtml + '</div>';
    if (position === 'top') {
      // Insert after reasoning, before main content
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

// ===== Regenerate =====
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

// ===== Delete Message =====
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

    // If parent has remaining children, switch to the first available sibling
    if (parent && parent.children && parent.children.length > 0) {
      const newChildId = parent.children[0];
      // Walk down the first-child chain to rebuild a complete activePath
      let cursor = newChildId;
      while (cursor) {
        conv.activePath.push(cursor);
        const cursorNode = conv.messageMap[cursor];
        cursor = (cursorNode && cursorNode.children && cursorNode.children.length > 0)
          ? cursorNode.children[0]
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
  showToast('消息已删除');
}

// ===== Send Message =====
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

function buildContext(conv) {
  const msgs = [];

  // System prompt
  const sysParts = [];
  if (conv.systemPrompt) {
    sysParts.push(conv.systemPrompt);
  }
  // Emphasis prompt (after system prompt, before status bar)
  if (conv.emphasis) {
    sysParts.push('【重要强调】' + conv.emphasis);
  }
  // Status bar instruction (before user identity)
  if (conv.statusBar && conv.statusBar.enabled) {
    var sbTemplate = conv.statusBar.template || '当前地点、当前行动、当前穿搭、内心独白';
    var sbExample = sbTemplate.split(/[,，、]/).map(function(s){ return s.trim()+'：xxx'; }).join('\\n');
    sysParts.push('【状态栏指令】每次回复末尾，请用 <status>...</status> 标签输出角色当前状态信息。状态栏应包含以下内容：' + sbTemplate + '。请根据上下文合理填写数值和描述，保持角色一致性。示例格式：\\n<status>【角色状态】\\n' + sbExample + '\\n</status>');
  }
  if (conv.userIdentity) {
    sysParts.push('用户身份：' + conv.userIdentity);
  }
  if (sysParts.length > 0) {
    msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  }

  // Message history from active path
  const chain = getActiveChain(conv);
  for (const m of chain) {
    if (!m || m.role === 'system') continue;
    let content = m.content;

    // Process files (text and images)
    content = buildFileContent(m);
    msgs.push({ role: m.role, content });

    // Mid-context injection: remind every 4 messages
    if (conv.statusBar && conv.statusBar.enabled && msgs.length % 4 === 0) {
      var sbTemplate = conv.statusBar.template || '当前地点、当前行动、当前穿搭、内心独白';
      msgs.push({ role: 'system', content: '【格式提醒】回复末尾须包含 <status>...</status> 标签，内容包括：' + sbTemplate });
    }
  }

  // Post-History Instruction: status bar reminder right before generation
  if (conv.statusBar && conv.statusBar.enabled) {
    var sbTemplate = conv.statusBar.template || '当前地点、当前行动、当前穿搭、内心独白';
    msgs.push({ role: 'system', content: '【格式提醒】你的每次回复必须在最末尾包含 <status>...</status> 标签的状态栏，内容包括：' + sbTemplate + '。这是强制格式要求，不可省略。' });
    msgs.push({ role: 'user', content: '【格式要求】你必须在本次回复的最末尾，用 <status>...</status> 标签输出状态栏，内容包括：' + sbTemplate + '。这是强制要求，不可省略。' });
  }

  return msgs;
}

// ===== Capacitor 原生流式 HTTP（方案 C：capacitor-stream-http 插件）=====
// 用 StreamHttp.startStream + chunk/end/error 事件实现真流式
// 首字延迟从"等完整响应"降到"等模型开始输出"
// 停止生成用 cancelStream 真正中断请求，不浪费 API 额度
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

      // 超时
      timeoutId = setTimeout(() => {
        if (streamId) {
          try { CapStreamHttp.cancelStream({ id: streamId }); } catch(e) {}
        }
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error('请求超时（' + (timeoutMs / 1000) + ' 秒）'));
      }, timeoutMs);

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

// ===== 统一请求入口：根据配置选择方案 A（非流式）或方案 C（流式）=====
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

// ===== Capacitor 原生 HTTP（方案 A：非流式 + 打字动画）=====
// 在 APK 模式下，fetch 流式不可靠，改用 CapacitorHttp 一次性请求 + typewriter 假动画
// 停止生成：原生请求无法真正中断，用 state._nativeAborted 标记，响应到达后丢弃
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

  } catch (err) {
    clearTimeout(timeoutId);
    // 用户取消，静默处理（UI 已在 abort 时恢复）
    if (myAbortFlag.aborted || err.name === 'AbortError') {
      return;
    }
    throw err;
  }
}

// 打字机效果：逐字显示新增内容
// 性能优化：
// - 动画过程中用 textContent 快速更新（O(1)，不解析 markdown）
// - 每 300ms 做一次 markdown 渲染（marked.parse）
// - 动画结束时最终完整渲染
// - 不触发 save()（避免 IndexedDB 写入风暴）和 renderMessages()（避免全量重渲染）
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

// ===== Continue Generation =====
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

function buildContextForContinue(conv, targetMsg) {
  const msgs = [];

  // System prompt
  const sysParts = [];
  if (conv.systemPrompt) sysParts.push(conv.systemPrompt);
  // Emphasis prompt (after system prompt, before status bar)
  if (conv.emphasis) sysParts.push('【重要强调】' + conv.emphasis);
  // Status bar instruction (before user identity)
  if (conv.statusBar && conv.statusBar.enabled) {
    var sbTemplate = conv.statusBar.template || '当前地点、当前行动、当前穿搭、内心独白';
    var sbExample = sbTemplate.split(/[,，、]/).map(function(s){ return s.trim()+'：xxx'; }).join('\\n');
    sysParts.push('【状态栏指令】每次回复末尾，请用 <status>...</status> 标签输出角色当前状态信息。状态栏应包含以下内容：' + sbTemplate + '。请根据上下文合理填写数值和描述，保持角色一致性。示例格式：\\n<status>【角色状态】\\n' + sbExample + '\\n</status>');
  }
  if (conv.userIdentity) sysParts.push('用户身份：' + conv.userIdentity);
  if (sysParts.length > 0) msgs.push({ role: 'system', content: sysParts.join('\\n\\n') });

  // Walk up from targetMsg to root, collect messages
  const chain = [];
  let current = targetMsg;
  while (current && current.parentId) {
    chain.unshift(current);
    current = conv.messageMap[current.parentId];
  }

  for (const m of chain) {
    if (!m || m.role === 'system') continue;
    let content = m.content;
    content = buildFileContent(m);
    msgs.push({ role: m.role, content });

    // Mid-context injection: remind every 4 messages
    if (conv.statusBar && conv.statusBar.enabled && msgs.length % 4 === 0) {
      var sbTemplate = conv.statusBar.template || '当前地点、当前行动、当前穿搭、内心独白';
      msgs.push({ role: 'system', content: '【格式提醒】回复末尾须包含 <status>...</status> 标签，内容包括：' + sbTemplate });
    }
  }

  // Post-History Instruction: status bar reminder right before generation
  if (conv.statusBar && conv.statusBar.enabled) {
    var sbTemplate = conv.statusBar.template || '当前地点、当前行动、当前穿搭、内心独白';
    msgs.push({ role: 'system', content: '【格式提醒】你的每次回复必须在最末尾包含 <status>...</status> 标签的状态栏，内容包括：' + sbTemplate + '。这是强制格式要求，不可省略。' });
    msgs.push({ role: 'user', content: '【格式要求】你必须在本次回复的最末尾，用 <status>...</status> 标签输出状态栏，内容包括：' + sbTemplate + '。这是强制要求，不可省略。' });
  }

  return msgs;
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
            }
            updateMessageContent(assistantMsg.id, fullContent, fullReasoning);
          }
        } catch(e) {}
      }
    }

    assistantMsg.versions[0] = { content: fullContent, timestamp: Date.now(), reason: 'continued' };
    save();
    setStatus('ok');

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

// ===== Branch drawer =====
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

let branchZoom = 1;

function closeBranchDrawer() {
  document.getElementById('branch-drawer').style.display = 'none';
  removePinchListeners();
  branchSearchResults = [];
  branchSearchIdx = -1;
  document.getElementById('branch-search-input').value = '';
  document.getElementById('branch-search-info').textContent = '';
}

// ===== Branch search =====
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

// Bind long-press on tree nodes after render
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

function toggleSettings(open) {
  state.settingsOpen = open;
  settingsPanel.style.display = open ? 'flex' : 'none';
  if (open) {
    renderProviderList();
    const conv = currentConv();
    thinkingToggle.checked = conv ? conv.thinkingEnabled : settings.thinkingEnabled;
    systemPromptInput.value = conv?.systemPrompt || '';
    $('emphasis-prompt').value = conv?.emphasis || '';
    userIdentityInput.value = conv?.userIdentity || '';
    // Display settings
    const fsSelect = document.getElementById('font-size-select');
    const lsSelect = document.getElementById('line-spacing-select');
    if (fsSelect) fsSelect.value = settings.fontSize || '15';
    if (lsSelect) lsSelect.value = settings.lineSpacing || '1.6';
    // Status bar settings (per-conversation)
    var sb = conv?.statusBar || { enabled: false, template: '', position: 'bottom' };
    $('statusbar-toggle').checked = sb.enabled;
    $('statusbar-template').value = sb.template || '';
    $('statusbar-position').value = sb.position || 'bottom';
    $('statusbar-template-row').style.display = sb.enabled ? '' : 'none';
    $('statusbar-template-hint').style.display = sb.enabled ? '' : 'none';
    $('statusbar-position-row').style.display = sb.enabled ? '' : 'none';
  }
}

function saveSettingsHandler() {
  settings.thinkingEnabled = thinkingToggle.checked;
  // 流式模式（APK 专用）
  const streamingModeSelect = document.getElementById('native-streaming-mode-select');
  if (streamingModeSelect) settings.nativeStreamingMode = streamingModeSelect.value;
  // Display settings
  const fsSelect = document.getElementById('font-size-select');
  const lsSelect = document.getElementById('line-spacing-select');
  if (fsSelect) settings.fontSize = fsSelect.value;
  if (lsSelect) settings.lineSpacing = lsSelect.value;
  applyDisplaySettings();
  saveSettings();

  // Per-conversation: save prompts and status bar settings
  const conv = currentConv();
  if (conv) {
    conv.thinkingEnabled = thinkingToggle.checked;
    conv.systemPrompt = systemPromptInput.value.trim();
    conv.emphasis = $('emphasis-prompt').value.trim();
    conv.userIdentity = userIdentityInput.value.trim();
    conv.statusBar = {
      enabled: $('statusbar-toggle').checked,
      template: $('statusbar-template').value.trim(),
      position: $('statusbar-position').value
    };
    save();
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
async function ensureDataLoaded() {
  if (state._dataLoaded) return;
  // loadData() 在 init() 里被 await，这里轮询等待
  let tries = 0;
  while (!state._dataLoaded && tries < 50) {
    await new Promise(r => setTimeout(r, 100));
    tries++;
  }
}

// 导出全部数据（对话 + Provider + 设置）
// APK 模式：用 Filesystem 写入 + Share 分享；Web 模式：用 <a download>
async function exportAllData() {
  await ensureDataLoaded();

  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: state.conversations,
    providers: state.providers,
    settings: settings,
    currentId: state.currentId
  };
  const jsonText = JSON.stringify(data, null, 2);
  const fileName = 'chat-lite-backup-' + new Date().toISOString().slice(0, 10) + '.json';

  if (isCapacitor() && CapFilesystem && CapShare) {
    try {
      const result = await CapFilesystem.writeFile({
        path: fileName,
        data: btoa(unescape(encodeURIComponent(jsonText))),  // UTF-8 转 base64
        directory: 'CACHE',  // 临时目录，分享后系统会清理
        // 不传 encoding，Capacitor 会把 data 当 base64 字符串自动解码
        recursive: true
      });
      await CapShare.share({
        title: 'chat-lite 数据备份',
        text: fileName,
        url: result.uri,
        dialogTitle: '保存备份文件到...'
      });
      showToast('已导出，请选择保存位置');
    } catch (err) {
      console.error('Export failed:', err);
      showToast('导出失败：' + (err.message || err));
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
    showToast('已导出全部数据');
  }
}

// 导入全部数据
// mode: 'overwrite'（覆盖，默认）或 'merge'（按 ID 合并，冲突时导入数据优先）
async function importAllData(jsonText, mode) {
  await ensureDataLoaded();
  mode = mode || 'overwrite';

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    showToast('JSON 解析失败：' + e.message);
    return;
  }
  if (!data.conversations && !data.providers) {
    showToast('文件格式不正确');
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
        data: btoa(unescape(encodeURIComponent(JSON.stringify(preBackup, null, 2)))),
        directory: 'CACHE',
        recursive: true
      });
      console.log('导入前自动备份已保存：', backupName);
    } catch (e) {
      console.warn('导入前自动备份失败：', e);
    }
  }

  if (mode === 'overwrite') {
    // 覆盖模式：直接替换
    if (data.conversations) state.conversations = data.conversations;
    if (data.providers) state.providers = data.providers;
    if (data.settings) {
      Object.assign(settings, data.settings);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  showToast('已' + modeText + '导入数据');
}

// 文件选择回调（用于 importAllData 的 <input type="file">）
function importAllDataFromFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const modeEl = document.getElementById('import-mode-select');
  const mode = modeEl ? modeEl.value : 'overwrite';
  const reader = new FileReader();
  reader.onload = (ev) => {
    importAllData(ev.target.result, mode);
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function exportConversation() {
  const conv = currentConv();
  if (!conv) return;
  const data = { version: 2, exportedAt: new Date().toISOString(), conversation: conv };
  const jsonText = JSON.stringify(data, null, 2);
  const fileName = `chat-lite-${conv.title || 'conversation'}-${new Date().toISOString().slice(0, 10)}.json`;

  if (isCapacitor() && CapFilesystem && CapShare) {
    // APK 模式：<a download> 在 WebView 里不生效，改用 Filesystem + Share
    try {
      const result = await CapFilesystem.writeFile({
        path: fileName,
        data: btoa(unescape(encodeURIComponent(jsonText))),
        directory: 'CACHE',
        recursive: true
      });
      await CapShare.share({
        title: 'chat-lite 会话导出',
        text: fileName,
        url: result.uri,
        dialogTitle: '保存会话文件到...'
      });
      showToast('已导出，请选择保存位置');
    } catch (err) {
      console.error('Export conversation failed:', err);
      showToast('导出失败：' + (err.message || err));
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

// Tolerant JSON parse: handles truncated array exports that miss outer brackets
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

// Convert DZMM (dzmm.ai) export format to chat-lite tree
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

// Convert 豆包/类角色平台 export format to chat-lite tree
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

// Generate a PNG character card from fields + avatar image buffer
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

// Build system prompt from card fields
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

// CRC32 table
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crc32Table[i] = c;
}
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}


// ===== Start =====
document.addEventListener('DOMContentLoaded', init);
