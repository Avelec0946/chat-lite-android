// ===== providers.js : 聊天接口管理模块（v2.0 拆分）=====
// 模块名：providers.js
// 版本：v76（cache-bust）
// 迁移日期：2026-07-26
// 来源：从 app.js 拆分
// 职责：聊天 Provider 系统的模板、归一化、UI 渲染、编辑、测试、保存、迁移
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / idbPut / idbGet /
//       escapeHtml / showToast / ICON / uid / $ / currentConv / parseJsonField（部分）
// 加载顺序：在 db.js + haptics.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   常量：PROVIDERS_KEY, PROVIDER_TEMPLATES
//   函数：getProvider, normalizeBaseUrl, getProviderTemplate,
//         normalizeProvider, normalizeModels,
//         modelToUpstreamId, resolveTemplate, buildUpstreamPayload,
//         getModelsEndpoint, loadProviders, saveProviders, migrateOldApiKey,
//         renderModelSelector, syncModelSelector,
//         renderProviderList, openProviderEditor, closeProviderEditor,
//         testProviderConnection, saveProviderFromEditor, deleteProvider,
//         parseJsonField, toggleProviderAuthFields
//
// 保留在 app.js：
//   state.providers = []  // 初始化在 app.js 中保留（与 state 全局对象绑定）
//   生图相关：IMAGE_FORMATS 格式注册表 / IMAGE_PROVIDER_PRESETS 提供方预设 / migrateImageTemplate /
//            normalizeImageProvider / getImageProvider / getCurrentImageProvider / saveImageProviders / renderImageProviderList
//            （已迁移至 image-gen.js，v95 起格式与预设解耦）
//   compressImageForUpload（视觉上传，与 provider 无关）

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
// 注意：state.providers 的初始化在 app.js 的 const state = {...} 中完成
// 不能在此处执行 state.providers = []，因为 providers.js 在 app.js 之前加载，
// 此时 state 处于 TDZ（const 声明），访问会抛出 ReferenceError

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
  // v97 方案B：IDB 无数据/失败时从 localStorage 镜像兜底（saveProviders 已双写）
  try {
    var rawLs = localStorage.getItem(PROVIDERS_KEY);
    if (rawLs) {
      var arr = JSON.parse(rawLs);
      if (Array.isArray(arr) && arr.length > 0) {
        state.providers = arr.map(function(p) { return normalizeProvider(p); });
        return;
      }
    }
  } catch(e) { console.warn('loadProviders: localStorage 镜像读取失败:', e); }
  state.providers = [];
}

function saveProviders() {
  // v97 方案B：localStorage 镜像（后台无感）+ IDB 主存
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(state.providers));
  } catch(e) {
    console.warn('saveProviders: localStorage 镜像写入失败:', e);
  }
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
  saveSettings();  // 走 IDB 持久化
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
// ===== Provider Management UI =====
function renderProviderList() {
  var container = document.getElementById('provider-list');
  if (!container) return;
  // A4: Move editor out of container before rebuilding to prevent destruction
  var editor = document.getElementById('provider-editor');
  if (editor && container.contains(editor)) {
    container.parentNode.insertBefore(editor, container.nextSibling);
  }
  if (!state.providers || state.providers.length === 0) {
    container.innerHTML = '<div class="provider-empty">暂无接口，点击上方按钮添加</div>';
    return;
  }
  container.innerHTML = state.providers.map(function(p, i) {
    var templateLabel = p.template ? '[' + p.template.toUpperCase() + '] ' : '';
    var models = (p.models || []).map(function(m) { return m.name || m.id; }).join(', ') || '(无模型)';
    // A5: Wrap each provider in <details> for collapsibility
    return '<details class="provider-group" data-idx="' + i + '">' +
      '<summary class="provider-summary">' +
        '<span class="provider-name">' + escapeHtml(templateLabel + p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="btn btn-small provider-edit" data-idx="' + i + '">编辑</button>' +
          '<button class="btn btn-small provider-delete" data-idx="' + i + '" style="background:var(--bg3);color:var(--text)">删除</button>' +
        '</div>' +
      '</summary>' +
      '<div class="provider-detail">' +
        '<span class="provider-url">' + escapeHtml(p.baseUrl) + '</span>' +
        '<span class="provider-endpoint">' + escapeHtml(p.endpointPath || '') + '</span>' +
        '<span class="provider-models">模型: ' + escapeHtml(models) + '</span>' +
      '</div>' +
    '</details>';
  }).join('');

  container.querySelectorAll('.provider-edit').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); openProviderEditor(parseInt(btn.dataset.idx)); });
  });
  container.querySelectorAll('.provider-delete').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); deleteProvider(parseInt(btn.dataset.idx)); });
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
  // A4: Move editor adjacent to the clicked provider item
  var container = document.getElementById('provider-list');
  if (idx !== undefined && idx >= 0) {
    var group = container.querySelector('.provider-group[data-idx="' + idx + '"]');
    if (group) {
      group.appendChild(editor);
      group.open = true;
    }
  } else {
    // Adding new: insert right after the "+ 娣诲姞鎺ュ彛" button (before the list)
    container.parentNode.insertBefore(editor, container);
  }
}

function closeProviderEditor() {
  var editor = document.getElementById('provider-editor');
  editor.style.display = 'none';
  // A4: Move editor back to its home position (after provider-list)
  var container = document.getElementById('provider-list');
  if (container && container.parentNode) {
    container.parentNode.insertBefore(editor, container.nextSibling);
  }
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