// ===== image-gen.js : 生图功能模块（v2.0 拆分）=====
// 模块名：image-gen.js
// 版本：v78（cache-bust）
// 迁移日期：2026-07-26
// 来源：从 app.js 拆分
// 职责：生图接口管理、生图界面、图库、图片预览、图片存储、核心生图、完成通知
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / escapeHtml / showToast /
//       ICON / uid / $ / isCapacitor / CapFilesystem / Capacitor / normalizeBaseUrl /
//       parseJsonField / migrateImportedImagesToFilesystem / currentConv
// 加载顺序：在 db.js + haptics.js + providers.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   常量：IMAGE_PROVIDER_TEMPLATES, _IMAGE_SIZE_MAP, _GPT_IMAGE_SIZE_MAP,
//         IMAGE_STORE_DIR, _previewGestureDestroy
//   函数：getImageProviderTemplate, normalizeImageProvider, getImageProvider,
//         getCurrentImageProvider, saveImageProviders,
//         renderImageProviderList, openImageProviderEditor, closeImageProviderEditor,
//         saveImageProviderFromEditor, deleteImageProvider, renderImageProviderSelect,
//         updateImageGalleryCount, toggleImageView, updateImageAdvancedVisibility,
//         renderImageStream, showImagePreview, closeImagePreview, shareImage,
//         deleteImageFromGallery, saveImageToDevice, compressImageForGeneration,
//         writeImageFile, parseImageActualSize, readImageFile, deleteImageFile,
//         getImageDataUrl, buildImageSizeConfig, buildImageRequestPayload, base64ToBytes,
//         generateImage, fetchImageAsDataUrl, clearImageGallery, initImageView,
//         notifyImageComplete, migrateImportedImagesToFilesystem
//
// 保留在 app.js：
//   compressImageForUpload（聊天 Vision 图片上传，与生图无关）
//   compressImage / applyBackgroundImage / setBackgroundImage / removeBackgroundImage（会话背景图）
//   parseCharacterCard / generateCharacterCard（角色卡 PNG 导入/导出）

// ===== F1: 生图 Provider 模板（独立于聊天 PROVIDER_TEMPLATES）=====
const IMAGE_PROVIDER_TEMPLATES = {
  // Google Nano Banana / Gemini Image（gemini-2.5-flash-image / gemini-3-pro-image-preview）— generateContent 格式
  nano_banana: {
    endpointPath: '/v1beta/models/{model}:generateContent',
    authType: 'api-key',           // 默认 x-goog-api-key（中转平台可在 provider 配置改回 Bearer）
    authHeader: 'x-goog-api-key',
    authPrefix: '',
    requestFormat: 'gemini_image', // contents[].parts[].text + generationConfig.imageConfig
    responseFormat: 'gemini',      // candidates[0].content.parts[].inlineData.data
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: false, supportsBatch: false, maxBatch: 1, supportsResolution: true, supportsAspectRatio: true }
  },
  // OpenAI 新一代 GPT Image 模型（gpt-image-2 / gpt-image-1.5 / gpt-image-1）— flat 格式 + quality/output_format
  // 文生图走 /v1/images/generations；图生图走 /v1/images/edits（multipart/form-data）
  gpt_image: {
    endpointPath: '/v1/images/generations',
    editsPath: '/v1/images/edits',     // 图生图专用端点
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'gpt_image',    // flat 格式 + quality/output_format/moderation 参数
    responseFormat: 'b64_only',    // gpt-image 系列只返回 b64_json（无 url）
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: true, supportsBatch: false, maxBatch: 1, supportsQuality: true, supportsResolution: true, supportsAspectRatio: true }
  },
  // OpenAI DALL-E 兼容格式（kkaiapi 等三方平台，支持图生图/负面提示词/批量）
  openai_compat: {
    endpointPath: '/v1/images/generations',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'nested',       // 'nested' = input.messages[].content[].text; 'flat' = prompt
    responseFormat: 'url_or_b64',  // data[0].url 或 data[0].b64_json
    features: { supportsReferenceImage: true, supportsNegativePrompt: true, supportsCustomSize: true, supportsBatch: true, maxBatch: 4, supportsResolution: true, supportsAspectRatio: true }
  },
  // 标准 OpenAI DALL-E 格式（无图生图/无负面提示词，单张生成）
  openai_standard: {
    endpointPath: '/v1/images/generations',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'flat',
    responseFormat: 'url_or_b64',
    features: { supportsReferenceImage: false, supportsNegativePrompt: false, supportsCustomSize: true, supportsBatch: true, maxBatch: 1, supportsResolution: true, supportsAspectRatio: true }
  },
  custom: {
    endpointPath: '/v1/images/generations',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'nested',
    responseFormat: 'url_or_b64',
    features: { supportsReferenceImage: true, supportsNegativePrompt: true, supportsCustomSize: true, supportsBatch: true, maxBatch: 4, supportsResolution: true, supportsAspectRatio: true }
  }
};

function getImageProviderTemplate(template) {
  return IMAGE_PROVIDER_TEMPLATES[template] || IMAGE_PROVIDER_TEMPLATES.openai_compat;
}

function normalizeImageProvider(p) {
  if (!p || typeof p !== 'object') p = {};
  var template = getImageProviderTemplate(p.template);
  var baseUrl = normalizeBaseUrl(p.baseUrl);
  var endpointPath = p.endpointPath || template.endpointPath;
  var result = {
    id: p.id || uid(),
    name: p.name || '未命名生图接口',
    template: p.template || 'openai_compat',
    baseUrl: baseUrl,
    endpointPath: endpointPath,
    apiKey: p.apiKey || '',
    authType: p.authType || template.authType,
    authHeader: p.authHeader || template.authHeader,
    authPrefix: p.authPrefix !== undefined ? p.authPrefix : template.authPrefix,
    defaultModel: p.defaultModel || 'dall-e-3',
    features: Object.assign({}, template.features, p.features || {}),
    createdAt: p.createdAt || Date.now()
  };
  // 保留 editsPath（gpt_image 图生图专用端点）
  if (p.editsPath || template.editsPath) {
    result.editsPath = p.editsPath || template.editsPath;
  }
  return result;
}

function getImageProvider(id) {
  var list = settings.imageProviders || [];
  var raw = list.find(function(p) { return p.id === id; }) || null;
  return raw ? normalizeImageProvider(raw) : null;
}

function getCurrentImageProvider() {
  return getImageProvider(settings.imageProviderId);
}

// 生图 provider 列表持久化（写入 localStorage 的 settings.imageProviders）
function saveImageProviders() {
  saveSettings();
}
// ===== F1: 生图 Provider 管理 UI（复用聊天 provider 列表模式）=====
function renderImageProviderList() {
  var container = document.getElementById('image-provider-list');
  if (!container) return;
  var editor = document.getElementById('image-provider-editor');
  if (editor && container.contains(editor)) {
    container.parentNode.insertBefore(editor, container.nextSibling);
  }
  var list = settings.imageProviders || [];
  if (list.length === 0) {
    container.innerHTML = '<div class="provider-empty">暂无生图接口，点击上方按钮添加</div>';
    return;
  }
  container.innerHTML = list.map(function(p, i) {
    var templateLabel = p.template ? '[' + p.template.toUpperCase() + '] ' : '';
    return '<details class="provider-group" data-idx="' + i + '">' +
      '<summary class="provider-summary">' +
        '<span class="provider-name">' + escapeHtml(templateLabel + p.name) + '</span>' +
        '<div class="provider-actions">' +
          '<button class="btn btn-small image-provider-edit" data-idx="' + i + '">编辑</button>' +
          '<button class="btn btn-small image-provider-delete" data-idx="' + i + '" style="background:var(--bg3);color:var(--text)">删除</button>' +
        '</div>' +
      '</summary>' +
      '<div class="provider-detail">' +
        '<span class="provider-url">' + escapeHtml(p.baseUrl) + '</span>' +
        '<span class="provider-endpoint">' + escapeHtml(p.endpointPath || '') + '</span>' +
        '<span class="provider-models">默认模型: ' + escapeHtml(p.defaultModel || '-') + '</span>' +
      '</div>' +
    '</details>';
  }).join('');
  container.querySelectorAll('.image-provider-edit').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); openImageProviderEditor(parseInt(btn.dataset.idx)); });
  });
  container.querySelectorAll('.image-provider-delete').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); deleteImageProvider(parseInt(btn.dataset.idx)); });
  });
}

function openImageProviderEditor(idx) {
  var editor = document.getElementById('image-provider-editor');
  if (!editor) return;
  var p = (idx !== undefined && idx >= 0) ? normalizeImageProvider((settings.imageProviders || [])[idx]) : null;
  editor.style.display = 'block';
  editor.dataset.editIdx = idx !== undefined ? idx : '';
  document.getElementById('img-provider-template-select').value = p ? p.template : 'openai_compat';
  document.getElementById('img-provider-name-input').value = p ? p.name : '';
  document.getElementById('img-provider-url-input').value = p ? p.baseUrl : '';
  document.getElementById('img-provider-endpoint-input').value = p ? (p.endpointPath || '') : '';
  document.getElementById('img-provider-key-input').value = p ? p.apiKey : '';
  document.getElementById('img-provider-default-model-input').value = p ? (p.defaultModel || '') : '';
  // 鉴权方式回填：与模板默认一致或未设则「跟随模板」
  var authSel = document.getElementById('img-provider-auth-select');
  if (authSel) {
    var authVal = '';
    if (p && p.authType) {
      var tmpl = getImageProviderTemplate(p.template);
      if (p.authType !== tmpl.authType || (p.authHeader && p.authHeader !== tmpl.authHeader)) {
        authVal = p.authType;
      }
    }
    authSel.value = authVal;
  }
  // A4: 编辑器紧邻被编辑项
  var container = document.getElementById('image-provider-list');
  if (idx !== undefined && idx >= 0) {
    var group = container.querySelector('.provider-group[data-idx="' + idx + '"]');
    if (group) {
      group.appendChild(editor);
      group.open = true;
    }
  } else {
    container.parentNode.insertBefore(editor, container);
  }
}

function closeImageProviderEditor() {
  var editor = document.getElementById('image-provider-editor');
  if (!editor) return;
  editor.style.display = 'none';
  var container = document.getElementById('image-provider-list');
  if (container && container.parentNode) {
    container.parentNode.insertBefore(editor, container.nextSibling);
  }
}

function saveImageProviderFromEditor() {
  var editor = document.getElementById('image-provider-editor');
  if (!editor) return;
  var template = document.getElementById('img-provider-template-select').value;
  var name = document.getElementById('img-provider-name-input').value.trim();
  var baseUrl = normalizeBaseUrl(document.getElementById('img-provider-url-input').value);
  var endpointPath = document.getElementById('img-provider-endpoint-input').value.trim();
  var apiKey = document.getElementById('img-provider-key-input').value.trim();
  var defaultModel = document.getElementById('img-provider-default-model-input').value.trim();
  if (!name || !baseUrl || !apiKey) {
    showToast('请填写接口名称、地址和密钥', 'warn');
    return;
  }
  if (!settings.imageProviders) settings.imageProviders = [];
  // 鉴权方式覆盖（空=跟随模板）
  var authSelect = document.getElementById('img-provider-auth-select');
  var authOverride = authSelect ? authSelect.value : '';
  var providerData = {
    template: template,
    name: name,
    baseUrl: baseUrl,
    endpointPath: endpointPath,
    apiKey: apiKey,
    defaultModel: defaultModel || 'dall-e-3'
  };
  if (authOverride === 'bearer') {
    providerData.authType = 'bearer';
    providerData.authHeader = 'Authorization';
    providerData.authPrefix = 'Bearer ';
  } else if (authOverride === 'api-key') {
    providerData.authType = 'api-key';
    providerData.authHeader = 'x-goog-api-key';
    providerData.authPrefix = '';
  } else if (authOverride === 'header') {
    providerData.authType = 'header';
    // authHeader/authPrefix 跟随模板
  }
  // authOverride === '' 时不设 authType，normalizeImageProvider 用模板默认
  var editIdx = editor.dataset.editIdx;
  if (editIdx !== '' && editIdx !== undefined && parseInt(editIdx) >= 0) {
    providerData.id = settings.imageProviders[parseInt(editIdx)].id;
    settings.imageProviders[parseInt(editIdx)] = normalizeImageProvider(providerData);
  } else {
    var newProvider = normalizeImageProvider(providerData);
    settings.imageProviders.push(newProvider);
    // 若首次添加，自动选中
    if (!settings.imageProviderId) settings.imageProviderId = newProvider.id;
  }
  saveImageProviders();
  renderImageProviderList();
  renderImageProviderSelect();
  updateImageGalleryCount();
  closeImageProviderEditor();
}

function deleteImageProvider(idx) {
  if (!settings.imageProviders || !settings.imageProviders[idx]) return;
  if (!confirm('确定删除生图接口「' + settings.imageProviders[idx].name + '」？')) return;
  var deletedId = settings.imageProviders[idx].id;
  settings.imageProviders.splice(idx, 1);
  if (settings.imageProviderId === deletedId) {
    settings.imageProviderId = settings.imageProviders.length > 0 ? settings.imageProviders[0].id : null;
  }
  saveImageProviders();
  renderImageProviderList();
  renderImageProviderSelect();
  closeImageProviderEditor();
}

// F1: 生图界面顶部接口选择下拉框
function renderImageProviderSelect() {
  var sel = document.getElementById('image-provider-select');
  if (!sel) return;
  var list = settings.imageProviders || [];
  if (list.length === 0) {
    sel.innerHTML = '<option disabled selected>请先在设置中添加生图接口</option>';
    return;
  }
  sel.innerHTML = list.map(function(p) {
    return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
  }).join('');
  if (settings.imageProviderId) sel.value = settings.imageProviderId;
  // 同步模型输入框
  var modelInput = document.getElementById('image-model-input');
  var current = getCurrentImageProvider();
  if (modelInput && current) modelInput.value = current.defaultModel || '';
}
// F1: 更新图库计数显示
function updateImageGalleryCount() {
  var el = document.getElementById('image-gallery-count');
  if (el) el.textContent = String((settings.images || []).length);
}

// F1: 切换生图界面显示
function toggleImageView(open) {
  var imageView = document.getElementById('image-view');
  if (!imageView) return;
  state.imageViewOpen = !!open;
  imageView.style.display = open ? 'flex' : 'none';
  var main = document.getElementById('main');
  var sidebarEl = document.getElementById('sidebar');
  if (open) {
    if (main) main.style.display = 'none';
    if (sidebarEl) sidebarEl.classList.add('hidden');
    renderImageProviderSelect();
    updateImageGalleryCount();
    renderImageStream();
    updateImageAdvancedVisibility();
  } else {
    if (main) main.style.display = '';
  }
}

// F1: 根据当前生图接口模板，显示/隐藏高级参数中的 quality / 负面提示词 / 参考图等字段
function updateImageAdvancedVisibility() {
  var provider = getCurrentImageProvider();
  var template = provider ? provider.template : 'openai_compat';
  var features = provider ? provider.features : null;
  // quality 行：仅 gpt_image 模板显示
  var qualityRow = document.getElementById('image-quality-row');
  if (qualityRow) qualityRow.style.display = (template === 'gpt_image') ? '' : 'none';
  // 分辨率选择：gpt_image 模板隐藏（gpt-image-2 只支持 1024 基础，分辨率无意义）
  var resSelect = document.getElementById('image-resolution-select');
  if (resSelect) resSelect.style.display = (template === 'gpt_image') ? 'none' : '';
  // 负面提示词：模板不支持时隐藏
  var negRow = document.getElementById('image-negative-prompt-row');
  if (negRow) negRow.style.display = (features && features.supportsNegativePrompt) ? '' : 'none';
  // 提示词扩展/水印：仅 openai_compat/custom 显示
  var promptExtendLabel = document.getElementById('image-prompt-extend-label');
  if (promptExtendLabel) promptExtendLabel.style.display = (template === 'openai_compat' || template === 'custom') ? '' : 'none';
  var watermarkLabel = document.getElementById('image-watermark-label');
  if (watermarkLabel) watermarkLabel.style.display = (template === 'openai_compat' || template === 'custom') ? '' : 'none';
  // 参考图按钮：始终显示，模板不支持时点击会提示（不再隐藏，避免用户找不到入口）
  var btnRef = document.getElementById('btn-image-ref');
  if (btnRef) btnRef.style.display = '';
  // gpt_image 模板：动态改「自由」option 文本提示用户（gpt-image-2 的 auto 默认返回 1:1，不读提示词宽高）
  var aspectSel = document.getElementById('image-aspect-select');
  if (aspectSel && aspectSel.options[0]) {
    aspectSel.options[0].text = (template === 'gpt_image') ? '自由（默认1:1）' : '自由';
  }
}

// F1: 渲染图片流（从 settings.images 全局图库读取，按时间倒序）
function renderImageStream() {
  var stream = document.getElementById('image-stream');
  if (!stream) return;
  var images = settings.images || [];
  if (images.length === 0) {
    stream.innerHTML = '<div class="image-empty" id="image-empty">' +
      '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
      '<h2>生图</h2><p>输入提示词，生成图片</p></div>';
    return;
  }
  // 时间倒序展示（最新在最底部，因为渲染时按数组顺序，新图 push 到末尾）
  var html = '';
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    // 优先用内存缓存的 dataUrl；APK 模式下 fileName 非空但 dataUrl 为空时先占位，异步加载
    var imgSrc = img.dataUrl || '';
    var needAsync = !imgSrc && !!img.fileName;
    // v69: 参考图缩略图示意（从 img.referenceImages 读取，不可点击）
    var refThumbsHtml = '';
    if (img.referenceImages && img.referenceImages.length > 0) {
      refThumbsHtml = '<div class="img-ref-thumbs">';
      for (var ri = 0; ri < img.referenceImages.length; ri++) {
        refThumbsHtml += '<img class="img-ref-thumb" src="' + img.referenceImages[ri] + '" alt="参考图' + (ri + 1) + '">';
      }
      refThumbsHtml += '<span class="img-ref-count">' + img.referenceImages.length + ' 张参考图</span></div>';
    }
    html += '<div class="image-msg user"><div class="img-bubble"><p>' + escapeHtml(img.prompt || '(无提示词)') + '</p>' + refThumbsHtml + '</div></div>';
    html += '<div class="image-msg assistant"><div class="img-bubble"><div class="image-card">' +
      '<img src="' + imgSrc + '" alt="生成的图片" data-image-id="' + img.id + '"' + (needAsync ? ' data-need-async="1"' : '') + '>' +
      '<div class="image-card-meta">' +
        '<span class="meta-tag">' + escapeHtml(img.model || '-') + '</span>' +
        '<span class="meta-tag">' + escapeHtml(img.actualSize || img.size || '-') + '</span>' +
        (img.negativePrompt ? '<span class="meta-tag">neg</span>' : '') +
      '</div>' +
      '<div class="image-card-actions">' +
        '<button class="img-action-btn" data-action="save" data-id="' + img.id + '">保存到相册</button>' +
        '<button class="img-action-btn" data-action="delete" data-id="' + img.id + '">删除</button>' +
      '</div>' +
    '</div></div></div>';
  }
  stream.innerHTML = html;
  // 异步加载 Filesystem 中的图片（APK 模式）
  stream.querySelectorAll('img[data-need-async="1"]').forEach(function(imgEl) {
    var imageId = imgEl.dataset.imageId;
    var imgObj = (settings.images || []).find(function(x) { return x.id === imageId; });
    if (imgObj) {
      getImageDataUrl(imgObj).then(function(dataUrl) {
        if (dataUrl) imgEl.src = dataUrl;
      });
    }
  });
  // 绑定图片点击预览
  stream.querySelectorAll('img[data-image-id]').forEach(function(imgEl) {
    imgEl.addEventListener('click', function() {
      showImagePreview(imgEl.src, imgEl.dataset.imageId);
    });
  });
  // 绑定操作按钮
  stream.querySelectorAll('.img-action-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var action = btn.dataset.action;
      var id = btn.dataset.id;
      if (action === 'delete') deleteImageFromGallery(id);
      else if (action === 'save') saveImageToDevice(id);
    });
  });
  // 滚到底部（最新内容）
  setTimeout(function() { stream.scrollTop = stream.scrollHeight; }, 0);
  // v66: 若生图请求进行中（如切出后切回），恢复加载占位提示
  if (state._imageGenerating) {
    var loadingRestored = document.createElement('div');
    loadingRestored.className = 'image-msg assistant';
    loadingRestored.id = 'image-loading-msg';
    loadingRestored.innerHTML = '<div class="img-bubble"><div class="image-loading"><div class="loading-spinner"></div><div class="loading-text">生成中（后台任务进行中）...</div></div></div>';
    stream.appendChild(loadingRestored);
    stream.scrollTop = stream.scrollHeight;
    var ind = document.getElementById('image-status-indicator');
    if (ind) ind.className = 'image-status-indicator loading';
    var sb = document.getElementById('btn-image-send');
    if (sb) { sb.classList.add('stopping'); sb.title = '点击停止生成'; }
  }
}
// v66: 大图预览（支持双指缩放 + 拖动 + 工具栏保存/分享）
var _previewGestureDestroy = null;
function showImagePreview(src, imgId) {
  if (_previewGestureDestroy) { _previewGestureDestroy(); _previewGestureDestroy = null; }
  var existing = document.querySelector('.image-preview-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  var toolbarHtml = imgId
    ? '<div class="image-preview-toolbar">' +
        '<button class="preview-save" data-id="' + imgId + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>保存</button>' +
        '<button class="preview-share" data-id="' + imgId + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>分享</button>' +
      '</div>'
    : '';
  overlay.innerHTML = '<button class="image-preview-close" title="关闭"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
    '<div class="image-preview-hint">单击退出 · 双击缩放 · 双指捏合 · 单指拖动</div>' +
    '<img src="' + src + '" alt="预览">' +
    toolbarHtml;
  document.body.appendChild(overlay);
  var imgEl = overlay.querySelector('img');
  if (imgEl && window.GestureHelpers) {
    _previewGestureDestroy = window.GestureHelpers.enableGestures(imgEl, { minScale: 1, maxScale: 5, doubleTapScale: 2 });
  }

  // v73: 单击退出 + 双击缩放
  // 社区经验：移动端双击只触发 1 次 click（不是 2 次），基于 click 的双击检测不可靠。
  // 改用 touchend 检测：单指 touchend 间隔 < 280ms 且位移 < 30px 视为双击。
  // 单击延迟 250ms（比双击窗口短，保证双击时能取消单击关闭）。
  // img 上的 gesture-helpers 双击缩放会被 overlay 的 touchend 拦截，这里统一处理。
  var lastTapTime = 0;
  var lastTapX = 0, lastTapY = 0;
  var singleTapTimer = null;
  // v78 修复：双指缩放后松开一指时，e.touches.length===1 不应触发 tap。
  //   用 _pinchActive 标志追踪 pinch 状态，pinch 结束后 300ms 内忽略 tap。
var _pinchActive = false;
var _pinchEndTime = 0;
// v79 修复：放大后单指拖动(pan)松开时，touchend 误触发 tap 关闭。
//   用 _panActive 标志追踪 pan 状态，pan 结束后 300ms 内忽略 tap。
var _panActive = false;
var _panEndTime = 0;
// v80: 记录 pan 起始坐标和位移标志，区分"拖动"与"单击"
var _panStartX = 0, _panStartY = 0, _panMoved = false;
// v81: 双击放大后保护期，防止放大后误触发关闭
var _lastZoomTime = 0;

  // 监听 img 上的 touchstart，检测双指按下
  if (imgEl) {
imgEl.addEventListener('touchstart', function(e) {
  if (e.touches.length === 2) {
    _pinchActive = true;
    // 双指按下时取消任何待执行的单击关闭
    if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
    // v82: 不重置 lastTapTime，避免干扰双击检测（双击由 overlay touchend 统一处理）
  } else if (e.touches.length === 1) {
    // v82: 放大状态(scale>1)下单指按下，预判可能开始 pan
    //   修复：原 indexOf('scale(1)') < 0 判断有误（初始 transform 为空也返回 -1）
    //   改为正则提取 scale 值，>1.05 才视为放大
    var tr = imgEl.style.transform || '';
    var scaleMatch = tr.match(/scale\(([\d.]+)/);
    var curScale = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
    if (curScale > 1.05) {
      _panActive = true;
      // v80: 记录起始坐标，touchend 时根据位移区分拖动/单击
      _panStartX = e.touches[0].clientX;
      _panStartY = e.touches[0].clientY;
      _panMoved = false;
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
      // v82: 不重置 lastTapTime，避免干扰双击检测
    }
  }
}, { passive: true });
    // 监听 touchend，追踪 pinch 结束
imgEl.addEventListener('touchend', function(e) {
  if (_pinchActive && e.touches.length < 2) {
    _pinchActive = false;
    _pinchEndTime = Date.now();
  }
if (_panActive && e.touches.length === 0) {
    _panActive = false;
    // v80: 检查位移，只有真正拖动才更新 _panEndTime（300ms 内忽略 tap）
    //   位移 <= 10px 视为单击，不更新 _panEndTime，允许 overlay tap 关闭预览
    if (e.changedTouches && e.changedTouches[0]) {
      var dx = Math.abs(e.changedTouches[0].clientX - _panStartX);
      var dy = Math.abs(e.changedTouches[0].clientY - _panStartY);
      _panMoved = (dx > 10 || dy > 10);
    }
    if (_panMoved) {
      _panEndTime = Date.now();
    }
  }
}, { passive: true });
  }


  function handleTapClose(e) {
    // e 可能是 touchend 或 click（鼠标）
    var x, y;
    if (e.changedTouches && e.changedTouches[0]) {
      x = e.changedTouches[0].clientX;
      y = e.changedTouches[0].clientY;
    } else {
      x = e.clientX;
      y = e.clientY;
    }
    var now = Date.now();
    var dt = now - lastTapTime;
    var dx = Math.abs(x - lastTapX);
    var dy = Math.abs(y - lastTapY);

if (dt < 180 && dx < 30 && dy < 30) {
    // 双击：取消单击关闭，执行缩放
    if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
    lastTapTime = 0;
    // 触发 img 的缩放（复用 gesture-helpers 的 zoomAt）
    if (imgEl && imgEl._gestureZoomAt) {
      var rect = overlay.getBoundingClientRect();
      imgEl._gestureZoomAt(x - rect.left, y - rect.top, 0);  // 0 = toggle
      // v81: 记录放大时间，400ms 内忽略 touchend 关闭，防止放大后误退出
      _lastZoomTime = Date.now();
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
    lastTapTime = now;
    lastTapX = x;
    lastTapY = y;
    // 单击：延迟 200ms 关闭（v81：从 250ms 缩短，加快反馈；双击窗口 180ms < 200ms，确保双击能取消）
    if (singleTapTimer) clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(function() {
      singleTapTimer = null;
      closeImagePreview();
    }, 200);
  }

  // touchend 在 img 和 overlay 上分别监听（img 的 gesture-helpers 不会阻止冒泡）
  overlay.addEventListener('touchend', function(e) {
    // 多指触摸（缩放/拖动）不处理
    if (e.touches.length > 0) return;
    // v78 修复：多指同时松开（changedTouches > 1）不处理
    if (e.changedTouches && e.changedTouches.length > 1) return;
// v78 修复：pinch 刚结束（300ms 内）不处理，避免松开一指时误触发 tap
    if (_pinchActive || (Date.now() - _pinchEndTime < 300)) {
      _pinchActive = false;
      return;
    }
// v79 修复：pan 刚结束（300ms 内）不处理，避免放大后拖动松开误触发 tap 关闭
    if (_panActive || (Date.now() - _panEndTime < 300)) {
      _panActive = false;
      return;
    }
    // v81: 双击放大后 400ms 保护期，防止放大后误触发关闭
    if (Date.now() - _lastZoomTime < 400) {
      return;
    }
    // 点击工具栏/关闭按钮：交给 click handler
    var t = e.target;
    if (t.closest('.image-preview-close') || t.closest('.image-preview-toolbar')) return;
    handleTapClose(e);
  });
  // 鼠标 click 兜底（桌面调试用）
  overlay.addEventListener('click', function(e) {
    if (e.target.closest('.image-preview-close')) {
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
      closeImagePreview();
      return;
    }
    if (e.target.closest('.image-preview-toolbar')) return;
    // 桌面端：触摸事件不触发，由 click 处理
    if (!('ontouchstart' in window)) handleTapClose(e);
  });

  var btnSave = overlay.querySelector('.preview-save');
  if (btnSave) btnSave.addEventListener('click', function(e) { e.stopPropagation(); saveImageToDevice(btnSave.dataset.id); });
  var btnShare = overlay.querySelector('.preview-share');
  if (btnShare) btnShare.addEventListener('click', function(e) {
    e.stopPropagation();
    shareImage(btnShare.dataset.id);
  });
  setTimeout(function() { var h = overlay.querySelector('.image-preview-hint'); if (h) h.style.display = 'none'; }, 3000);
}

function closeImagePreview() {
  if (_previewGestureDestroy) { _previewGestureDestroy(); _previewGestureDestroy = null; }
  var overlay = document.querySelector('.image-preview-overlay');
  if (overlay) overlay.remove();
}

// v66: 系统分享（Web Share API），不支持则降级为保存
async function shareImage(id) {
  var img = (settings.images || []).find(function(x) { return x.id === id; });
  if (!img) return;
  try {
    var dataUrl = await getImageDataUrl(img);
    if (!dataUrl) { showToast('图片数据不可用', 'warn'); return; }
    if (navigator.share && navigator.canShare) {
      var resp = await fetch(dataUrl);
      var blob = await resp.blob();
      var file = new File([blob], 'chatlite_' + id + '.png', { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '分享图片' });
        return;
      }
    }
    saveImageToDevice(id);
  } catch(e) {
    if (e.name !== 'AbortError') showToast('分享失败: ' + (e.message || e), 'warn');
  }
}

// F1: 从图库删除单张图片
function deleteImageFromGallery(id) {
  if (!confirm('确定从图库删除此图片？')) return;
  if (!settings.images) return;
  var idx = settings.images.findIndex(function(x) { return x.id === id; });
  if (idx < 0) return;
  var img = settings.images[idx];
  // 同步删除 Filesystem 中的图片文件（APK 模式）
  if (img.fileName) deleteImageFile(img.fileName);
  settings.images.splice(idx, 1);
  saveImageProviders(); // 持久化 settings
  renderImageStream();
  updateImageGalleryCount();
}
// F1: 压缩参考图（用于上传给生图 API，最大 1024px，JPEG 0.8）
function compressImageForGeneration(file) {
  return new Promise(function(resolve, reject) {
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
        // 返回 data URL（base64），生图 API 通常接受 data URL 或纯 base64
        resolve(canvas.toDataURL('image/png', 0.85));
      };
      img.onerror = function() { reject(new Error('图片加载失败')); };
      img.src = e.target.result;
    };
    reader.onerror = function() { reject(new Error('文件读取失败')); };
    reader.readAsDataURL(file);
  });
}

// F1: 图片文件存储（APK 模式用 Filesystem 分离存储，避免 localStorage 配额超限）
// settings.images 只存元数据 + fileName；dataUrl 在 APK 模式下存到 Filesystem，浏览器模式仍存 dataUrl
var IMAGE_STORE_DIR = 'chatlite_images';  // Filesystem 目录名（DATA）

// 把 dataUrl 写入 Filesystem，返回文件名（不含路径）
async function writeImageFile(dataUrl, imgId) {
  if (!isCapacitor() || !CapFilesystem) return null;
  try {
    var parts = dataUrl.split(',');
    var mime = (parts[0].match(/data:(.*?);base64/) || [])[1] || 'image/png';
    var ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/webp' ? 'webp' : 'png');
    var fileName = imgId + '.' + ext;
    await CapFilesystem.writeFile({
      path: IMAGE_STORE_DIR + '/' + fileName,
      data: parts[1] || '',
      directory: 'DATA',
      recursive: true,
      encoding: 'utf8'  // base64 是 ASCII，用 utf8 直写
    });
    return fileName;
  } catch (e) {
    console.warn('writeImageFile failed:', e);
    return null;
  }
}

// v68: 从 data URL 解析图片实际像素尺寸（支持 PNG/JPEG/WebP），失败返回 null
// 用途：gpt-image-2 等 API 返回的图片实际像素常小于请求 size 参数，需读取真实尺寸显示
function parseImageActualSize(dataUrl) {
  try {
    var commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) return null;
    var header = dataUrl.substring(0, commaIdx);  // "data:image/png;base64"
    var b64 = dataUrl.substring(commaIdx + 1);
    // 解码前 64 字节即可（所有格式的尺寸信息都在文件头）
    var binStr = atob(b64.substring(0, Math.min(b64.length, 64)));
    var bytes = new Uint8Array(binStr.length);
    for (var i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    // PNG: IHDR chunk 偏移 16-24（width 16-20, height 20-24, big-endian）
    if (header.indexOf('image/png') >= 0 && bytes.length >= 24) {
      var w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      var h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (w > 0 && h > 0) return w + 'x' + h;
    }
    // JPEG: 扫描 SOF0(0xC0) / SOF2(0xC2) marker，读取段内 5-8 字节（height, width, big-endian）
    if (header.indexOf('image/jpeg') >= 0 && bytes.length >= 4) {
      var idx = 2;  // 跳过 SOI(0xFFD8)
      while (idx + 8 < bytes.length) {
        if (bytes[idx] !== 0xFF) break;
        var marker = bytes[idx + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          var h2 = (bytes[idx + 5] << 8) | bytes[idx + 6];
          var w2 = (bytes[idx + 7] << 8) | bytes[idx + 8];
          if (w2 > 0 && h2 > 0) return w2 + 'x' + h2;
        }
        if (marker === 0xD8 || marker === 0xD9) break;  // SOI/EOI
        var segLen = (bytes[idx + 2] << 8) | bytes[idx + 3];
        idx += 2 + segLen;
      }
    }
    // WebP: RIFF header + VP8/VP8L/VP8X，简化处理（VP8 lossy 偏移 26-30）
    if (header.indexOf('image/webp') >= 0 && bytes.length >= 30) {
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38) {
        var w3 = ((bytes[26] | (bytes[27] << 8)) & 0x3FFF);
        var h3 = ((bytes[28] | (bytes[29] << 8)) & 0x3FFF);
        if (w3 > 0 && h3 > 0) return w3 + 'x' + h3;
      }
    }
    return null;
  } catch(e) {
    console.warn('parseImageActualSize failed:', e);
    return null;
  }
}

// 从 Filesystem 读取图片文件，返回 dataUrl
async function readImageFile(fileName) {
  if (!isCapacitor() || !CapFilesystem || !fileName) return null;
  try {
    var result = await CapFilesystem.readFile({
      path: IMAGE_STORE_DIR + '/' + fileName,
      directory: 'DATA',
      encoding: 'utf8'
    });
    var ext = fileName.split('.').pop().toLowerCase();
    var mime = ext === 'jpg' ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
    return 'data:' + mime + ';base64,' + result.data;
  } catch (e) {
    console.warn('readImageFile failed:', e);
    return null;
  }
}

// 删除 Filesystem 中的图片文件
async function deleteImageFile(fileName) {
  if (!isCapacitor() || !CapFilesystem || !fileName) return;
  try {
    await CapFilesystem.deleteFile({
      path: IMAGE_STORE_DIR + '/' + fileName,
      directory: 'DATA'
    });
  } catch (e) {
    console.warn('deleteImageFile failed:', e);
  }
}

// 获取图片 dataUrl：优先内存缓存 → Filesystem → dataUrl 字段（兼容旧数据）
async function getImageDataUrl(img) {
  if (!img) return null;
  // 旧数据/浏览器模式：dataUrl 直接存在 img.dataUrl
  if (img.dataUrl) return img.dataUrl;
  // APK 模式：从 Filesystem 读取
  if (img.fileName) {
    var dataUrl = await readImageFile(img.fileName);
    if (dataUrl) {
      img.dataUrl = dataUrl;  // 缓存到内存，避免重复 IO
      return dataUrl;
    }
  }
  return null;
}
// 返回 { size: 'WxH' 或 'auto', imageConfig: {aspectRatio, imageSize} 或 null }
var _IMAGE_SIZE_MAP = {
  '1K': { '1:1': '1024x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1792x1024', '9:16': '1024x1792' },
  '2K': { '1:1': '2048x2048', '4:3': '2048x1536', '3:4': '1536x2048', '16:9': '2048x1152', '9:16': '1152x2048' },
  '4K': { '1:1': '3072x3072', '4:3': '3840x2880', '3:4': '2880x3840', '16:9': '3840x2160', '9:16': '2160x3840' }
};
// gpt-image-2 只支持 4 个 size：1024x1024 / 1024x1536 / 1536x1024 / auto
// 16:9/4:3 统一映射到 1536x1024（横屏，最接近电影宽幅）；9:16/3:4 映射到 1024x1536（竖屏）
var _GPT_IMAGE_SIZE_MAP = {
  '1:1': '1024x1024',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
  '16:9': '1536x1024',
  '9:16': '1024x1536'
};
function buildImageSizeConfig(provider, resolution, aspect, customSize) {
  var template = provider ? provider.template : 'gpt_image';
  var result = { size: 'auto', imageConfig: null };
  // 自定义：直接用用户输入（支持 WxH 或 W:H）
  if (aspect === 'custom' && customSize) {
    if (template === 'nano_banana') {
      // Gemini 接受 aspectRatio "W:H"，也接受 size "WxH"（lumenfall 兼容层）
      if (/^\d+:\d+$/.test(customSize)) {
        result.imageConfig = { aspectRatio: customSize };
      } else {
        result.size = customSize;
      }
    } else {
      result.size = customSize;
    }
    return result;
  }
  // gpt_image 模板：只用 gpt-image-2 支持的 3 个固定 size + auto
  // 重要：gpt-image-2 的 size='auto' 是「模型默认比例」（通常 1:1），不会读提示词里的宽高描述
  if (template === 'gpt_image') {
    if (aspect === 'auto') {
      result.size = 'auto';  // 模型默认（不读提示词宽高）
    } else {
      result.size = _GPT_IMAGE_SIZE_MAP[aspect] || '1024x1024';
    }
    return result;
  }
  // auto 分辨率或 auto 宽高比 → 让模型自由
  if (resolution === 'auto' && aspect === 'auto') {
    return result;  // size='auto', imageConfig=null
  }
  if (template === 'nano_banana') {
    // Gemini：imageConfig = {aspectRatio, imageSize}
    var cfg = {};
    if (resolution !== 'auto') cfg.imageSize = resolution;  // "1K"/"2K"/"4K"
    if (aspect !== 'auto') cfg.aspectRatio = aspect;        // "1:1"/"16:9" 等
    result.imageConfig = Object.keys(cfg).length > 0 ? cfg : null;
    return result;
  }
  // OpenAI 系（dall-e 等）：size = "WxH" 或 "auto"
  if (resolution === 'auto' || aspect === 'auto') {
    // 一边 auto 一边具体：交给模型决定，返回 auto
    return result;
  }
  var sizeTable = _IMAGE_SIZE_MAP[resolution] || {};
  result.size = sizeTable[aspect] || '1024x1024';
  return result;
}

// F1: 构建生图 API 请求 URL 和 headers
function buildImageRequestPayload(provider, body) {
  var p = normalizeImageProvider(provider);
  var useEdits = !!(body && body._useEdits && p.editsPath);
  var endpointPath = useEdits ? (p.editsPath) : (p.endpointPath || '');
  // nano_banana 等模板用 {model} 占位符（model 从 body 中读）
  if (endpointPath.indexOf('{model}') >= 0 && body && body.model) {
    endpointPath = endpointPath.replace('{model}', encodeURIComponent(body.model));
  }
  var url = new URL(endpointPath, p.baseUrl).toString();
  var headers = {};
  var payload = body;
  if (p.authType === 'bearer') {
    headers[p.authHeader] = (p.authPrefix || 'Bearer ') + p.apiKey;
  } else if (p.authType === 'api-key') {
    headers[p.authHeader] = p.apiKey;
  } else if (p.authType === 'header') {
    headers[p.authHeader] = (p.authPrefix || '') + p.apiKey;
  } else if (p.authType === 'query') {
    url += (url.indexOf('?') >= 0 ? '&' : '?') + (p.authHeader || 'api_key') + '=' + encodeURIComponent(p.apiKey);
  }
  // gpt_image 图生图：构建 multipart/form-data
  if (useEdits) {
    var formData = new FormData();
    formData.append('model', body.model || '');
    formData.append('prompt', body.prompt || '');
    if (body.size && body.size !== 'auto') formData.append('size', body.size);
    if (body.quality) formData.append('quality', body.quality);
    if (body.output_format) formData.append('output_format', body.output_format);
    formData.append('n', String(body.n || 1));
    // 多张参考图：dataUrl → Blob，重复 append image 字段（OpenAI edits 端点支持多图，顺序即 append 顺序）
    var refArr = body._refDataUrls || (body._refDataUrl ? [body._refDataUrl] : []);
    for (var ri3 = 0; ri3 < refArr.length; ri3++) {
      var refParts = refArr[ri3].split(',');
      var refMime = (refParts[0].match(/data:(.*?);base64/) || [])[1] || 'image/png';
      var refExt = refMime === 'image/jpeg' ? 'jpg' : (refMime === 'image/webp' ? 'webp' : 'png');
      var refBytes = base64ToBytes(refParts[1] || '');
      var refBlob = new Blob([refBytes], { type: refMime });
      formData.append('image', refBlob, 'reference_' + (ri3 + 1) + '.' + refExt);
    }
    payload = formData;
    // 不设 Content-Type，让浏览器自动加 multipart boundary
  } else {
    headers['Content-Type'] = 'application/json';
  }
  return { url: url, headers: headers, payload: payload };
}

// base64 字符串 → Uint8Array（用于构建 Blob）
function base64ToBytes(b64) {
  var binary = atob(b64);
  var len = binary.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
// F1: 核心生图函数 —— 调用 API、处理响应、存入图库
async function generateImage() {
  var promptInput = document.getElementById('image-prompt-input');
  var prompt = (promptInput ? promptInput.innerText.trim() : '');
  if (!prompt) {
    showToast('请输入提示词', 'warn');
    return;
  }
  var provider = getCurrentImageProvider();
  if (!provider) {
    showToast('请先在设置中添加生图接口', 'warn');
    return;
  }
  var modelInput = document.getElementById('image-model-input');
  var model = modelInput ? modelInput.value.trim() : '';
  if (!model) model = provider.defaultModel || 'dall-e-3';

  // 尺寸：从「分辨率 + 宽高比」两层下拉读取
  var resolutionSel = document.getElementById('image-resolution-select');
  var aspectSel = document.getElementById('image-aspect-select');
  var aspectCustom = document.getElementById('image-aspect-custom');
  var resolution = resolutionSel ? resolutionSel.value : '2K';
  var aspect = aspectSel ? aspectSel.value : 'auto';
  var customSize = (aspect === 'custom' && aspectCustom) ? aspectCustom.value.trim() : '';
  var sizeConfig = buildImageSizeConfig(provider, resolution, aspect, customSize);

  // 高级参数
  var negPromptEl = document.getElementById('image-negative-prompt');
  var batchNEl = document.getElementById('image-batch-n');
  var promptExtendEl = document.getElementById('image-prompt-extend');
  var watermarkEl = document.getElementById('image-watermark');
  var negativePrompt = negPromptEl ? negPromptEl.value.trim() : '';
  var n = Math.max(1, Math.min(4, parseInt(batchNEl ? batchNEl.value : '1') || 1));
  if (provider.features && provider.features.maxBatch) {
    n = Math.min(n, provider.features.maxBatch);
  }
  var promptExtend = promptExtendEl ? promptExtendEl.checked : true;
  var watermark = watermarkEl ? watermarkEl.checked : false;

  // 参考图（图生图）：多张数组，兼容旧字段 _imageRefDataUrl
  var refDataUrls = [];
  if (Array.isArray(state._imageRefDataUrls) && state._imageRefDataUrls.length > 0) {
    refDataUrls = state._imageRefDataUrls.map(function(r) { return r.dataUrl; });
  } else if (state._imageRefDataUrl) {
    refDataUrls = [state._imageRefDataUrl];  // 兼容旧字段
  }
  if (refDataUrls.length > 0 && provider.features && !provider.features.supportsReferenceImage) {
    showToast('当前接口模板不支持参考图，已忽略', 'warn');
    refDataUrls = [];
  }

  // 构建请求体
  var reqBody = { model: model };
  if (provider.template === 'nano_banana') {
    // Nano Banana / Gemini Image：generateContent 格式（Gemini 支持多图 parts）
    var parts = [{ text: prompt }];
    if (refDataUrls.length > 0) {
      // 多张参考图作为 inline_data（Gemini 原生支持多图 parts）
      for (var ri = 0; ri < refDataUrls.length; ri++) {
        var refParts = refDataUrls[ri].split(',');
        var refMime = (refParts[0].match(/data:(.*?);base64/) || [])[1] || 'image/png';
        parts.push({ inline_data: { mime_type: refMime, data: refParts[1] || '' } });
      }
    }
    reqBody.contents = [{ parts: parts }];
    var genConfig = { responseModalities: ['IMAGE'] };
    if (sizeConfig.imageConfig) genConfig.imageConfig = sizeConfig.imageConfig;
    reqBody.generationConfig = genConfig;
  } else if (provider.template === 'openai_compat' || provider.template === 'custom') {
    // nested 格式：input.messages[].content[].text/image
    var contentParts = [{ type: 'text', text: prompt }];
    if (refDataUrls.length > 0) {
      // 多张参考图作为 base64（去掉 data URL 前缀），通义万相 nested 支持多 image
      for (var ri2 = 0; ri2 < refDataUrls.length; ri2++) {
        var base64 = refDataUrls[ri2].split(',')[1];
        contentParts.push({ type: 'image', image: base64 });
      }
    }
    reqBody.input = { messages: [{ role: 'user', content: contentParts }] };
    reqBody.parameters = {
      prompt_extend: promptExtend,
      watermark: watermark,
      n: n,
      size: sizeConfig.size || '1024x1024'
    };
    if (negativePrompt && provider.features && provider.features.supportsNegativePrompt) {
      reqBody.parameters.negative_prompt = negativePrompt;
    }
  } else if (provider.template === 'gpt_image') {
    if (refDataUrls.length > 0) {
      // GPT Image 图生图：走 /v1/images/edits 端点，multipart/form-data，支持多图
      reqBody._useEdits = true;
      reqBody.prompt = prompt;
      reqBody.size = sizeConfig.size || 'auto';
      var qualitySel2 = document.getElementById('image-quality-select');
      reqBody.quality = qualitySel2 ? qualitySel2.value : 'auto';
      reqBody.output_format = 'png';
      reqBody.n = 1;  // edits 端点只支持 n=1
      // 多张参考图通过 FormData 重复 append image 字段传入（在主调用逻辑中处理）
      reqBody._refDataUrls = refDataUrls;
    } else {
      // GPT Image 文生图：走 /v1/images/generations 端点，flat JSON
      reqBody.prompt = prompt;
      reqBody.n = n;
      reqBody.size = sizeConfig.size || 'auto';
      var qualitySel = document.getElementById('image-quality-select');
      var quality = qualitySel ? qualitySel.value : 'auto';
      reqBody.quality = quality;
      reqBody.output_format = 'png';
      reqBody.moderation = 'auto';
    }
  } else {
    // openai_standard：flat 格式
    reqBody.prompt = prompt;
    reqBody.n = n;
    reqBody.size = sizeConfig.size || '1024x1024';
  }

  var req = buildImageRequestPayload(provider, reqBody);

  // 设置状态指示器
  var indicator = document.getElementById('image-status-indicator');
  if (indicator) { indicator.className = 'image-status-indicator loading'; }
  var sendBtn = document.getElementById('btn-image-send');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.classList.add('stopping'); sendBtn.title = '点击停止生成'; }

  // 显示用户消息气泡
  var stream = document.getElementById('image-stream');
  if (stream) {
    // 若是首次生成，清空 empty 提示
    var empty = document.getElementById('image-empty');
    if (empty) empty.remove();
    var userMsg = document.createElement('div');
    userMsg.className = 'image-msg user';
    // v69: 参考图缩略图示意（不可点击，仅展示）
    var refThumbsHtml = '';
    if (refDataUrls.length > 0) {
      refThumbsHtml = '<div class="img-ref-thumbs">';
      for (var ri = 0; ri < refDataUrls.length; ri++) {
        refThumbsHtml += '<img class="img-ref-thumb" src="' + refDataUrls[ri] + '" alt="参考图' + (ri + 1) + '">';
      }
      refThumbsHtml += '<span class="img-ref-count">' + refDataUrls.length + ' 张参考图</span></div>';
    }
    userMsg.innerHTML = '<div class="img-bubble"><p>' + escapeHtml(prompt) + '</p>' + refThumbsHtml + '</div>';
    stream.appendChild(userMsg);
    // 加载占位
    var loadingMsg = document.createElement('div');
    loadingMsg.className = 'image-msg assistant';
    loadingMsg.id = 'image-loading-msg';
    loadingMsg.innerHTML = '<div class="img-bubble"><div class="image-loading"><div class="loading-spinner"></div><div class="loading-text">生成中...</div></div></div>';
    stream.appendChild(loadingMsg);
    stream.scrollTop = stream.scrollHeight;
  }

  // 调用 API（gpt_image 图生图/nano_banana 生图较慢，超时 600s；其他 120s）
  // 注：app 切后台时 Android WebView 会暂停 JS，fetch 挂起但不会报错，切回前台后继续等待
  var timeoutMs = settings.nativeTimeoutMs || 120000;
  if ((provider.template === 'nano_banana' || reqBody._useEdits) && timeoutMs < 600000) timeoutMs = 600000;
  state._imageGenerating = true;  // 标记请求进行中，供 appStateChange 监听用
  try {
    var controller = new AbortController();
    state._imageAbortController = controller;  // v66: 暴露给停止按钮
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    var resp;
    try {
      resp = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: (req.payload instanceof FormData) ? req.payload : JSON.stringify(req.payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      var errText = '';
      try { errText = await resp.text(); } catch(e) {}
      throw new Error('HTTP ' + resp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
    }
    var data = await resp.json();
    // 移除加载占位
    var loadingEl = document.getElementById('image-loading-msg');
    if (loadingEl) loadingEl.remove();
    // 解析响应：统一归一化为 results = [{b64_json|url|revised_prompt}]
    var results = [];
    if (provider.template === 'nano_banana') {
      // Gemini 格式：candidates[0].content.parts[].inlineData.data
      var candidates = data.candidates || [];
      for (var ci = 0; ci < candidates.length; ci++) {
        var parts = (candidates[ci].content || {}).parts || [];
        for (var pi = 0; pi < parts.length; pi++) {
          var inlineData = parts[pi].inlineData || parts[pi].inline_data;
          if (inlineData && inlineData.data) {
            var mime = inlineData.mimeType || inlineData.mime_type || 'image/png';
            results.push({ b64_json: inlineData.data, mime: mime });
          }
        }
      }
    } else {
      // OpenAI 格式：data[].b64_json 或 data[].url
      results = (data.data || []) || [];
    }
    if (results.length === 0) throw new Error('响应中无图片数据');
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      var dataUrl = '';
      if (item.b64_json) {
        var mime = item.mime || 'image/png';
        dataUrl = 'data:' + mime + ';base64,' + item.b64_json;
      } else if (item.url) {
        // 下载 URL 转 base64
        dataUrl = await fetchImageAsDataUrl(item.url);
      }
      if (!dataUrl) continue;
      // v68: 从 base64 解码实际像素尺寸（gpt-image-2 返回的图片常被压缩，实际尺寸 < 请求 size 参数）
      var actualSize = parseImageActualSize(dataUrl) || '';
      // 存入图库：APK 模式把 dataUrl 存 Filesystem，settings.images 只存元数据+fileName，避免 localStorage 配额超限
      var newImgId = uid();
      var fileName = null;
      if (isCapacitor() && CapFilesystem) {
        fileName = await writeImageFile(dataUrl, newImgId);
      }
      var imgObj = {
        id: newImgId,
        // APK 模式 fileName 非空时不存 dataUrl（从 Filesystem 读）；浏览器模式或写入失败时仍存 dataUrl
        dataUrl: fileName ? null : dataUrl,
        fileName: fileName,
        thumbnailDataUrl: null,  // TODO: F2/F4 优化时再生成缩略图
        prompt: prompt,
        negativePrompt: negativePrompt,
        referenceImageId: null,
        referenceImages: (refDataUrls && refDataUrls.length > 0) ? refDataUrls.slice() : null,  // v69: 保存参考图 dataUrl（已压缩）用于消息流缩略图展示
        model: model,
        providerId: provider.id,
        size: sizeConfig.size || (sizeConfig.imageConfig ? JSON.stringify(sizeConfig.imageConfig) : ''),
        actualSize: actualSize,  // v68: 实际像素尺寸（如 '1248x832'），UI 优先显示
        resolution: resolution,
        aspect: aspect,
        createdAt: Date.now(),
        tags: [],
        source: 'f1_generate',
        starred: false,
        revisedPrompt: item.revised_prompt || ''
      };
      if (!settings.images) settings.images = [];
      settings.images.push(imgObj);
    }
    saveImageProviders();
    renderImageStream();
    updateImageGalleryCount();
    if (indicator) indicator.className = 'image-status-indicator ok';
    showToast('生成完成，共 ' + results.length + ' 张', 'success');
    // v70: 无论前后台都发系统通知（前台 toast + 通知栏，后台仅通知栏）
    notifyImageComplete(results.length);
  } catch(e) {
    var loadingEl2 = document.getElementById('image-loading-msg');
    if (loadingEl2) loadingEl2.remove();
    if (indicator) indicator.className = 'image-status-indicator err';
    var errMsg = e.name === 'AbortError' ? '请求超时（' + (timeoutMs / 1000) + 's）' : (e.message || '生成失败');
    // 在图片流中显示错误消息
    if (stream) {
      var errEl = document.createElement('div');
      errEl.className = 'image-msg assistant';
      errEl.innerHTML = '<div class="img-bubble"><div class="image-error">' + escapeHtml(errMsg) + '</div></div>';
      stream.appendChild(errEl);
      stream.scrollTop = stream.scrollHeight;
    }
    showToast(errMsg, 'warn');
    console.error('generateImage failed:', e);
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.classList.remove('stopping'); sendBtn.title = ''; }
    state._imageAbortController = null;  // v66: 清理引用
    state._imageGenerating = false;  // 清除请求进行中标记
  }
}

// F1: 把图片 URL 下载为 data URL（避免外链失效）
async function fetchImageAsDataUrl(url) {
  try {
    var resp = await fetch(url);
    var blob = await resp.blob();
    return await new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { reject(new Error('FileReader 失败')); };
      reader.readAsDataURL(blob);
    });
  } catch(e) {
    console.warn('fetchImageAsDataUrl failed, fallback to url:', e);
    return url;  // 失败时回退为直接 URL（外链）
  }
}
// F1: 清空图库
function clearImageGallery() {
  if (!settings.images || settings.images.length === 0) {
    showToast('图库已为空', 'info');
    return;
  }
  if (!confirm('确定清空图库？共 ' + settings.images.length + ' 张图片，此操作不可撤销。')) return;
  settings.images = [];
  saveImageProviders();
  renderImageStream();
  updateImageGalleryCount();
  showToast('图库已清空', 'info');
}

// F1: 生图界面事件监听初始化
function initImageView() {
  var btnOpen = document.getElementById('btn-open-image-view');
  if (btnOpen) btnOpen.addEventListener('click', function() { toggleImageView(true); });

  var btnBack = document.getElementById('btn-image-back');
  if (btnBack) btnBack.addEventListener('click', function() { toggleImageView(false); });

  // 接口选择切换
  var imgProvSel = document.getElementById('image-provider-select');
  if (imgProvSel) imgProvSel.addEventListener('change', function() {
    settings.imageProviderId = imgProvSel.value;
    saveImageProviders();
    var modelInput = document.getElementById('image-model-input');
    var current = getCurrentImageProvider();
    if (modelInput && current) modelInput.value = current.defaultModel || '';
    updateImageAdvancedVisibility();
  });

  // 参考图选择
  var btnRef = document.getElementById('btn-image-ref');
  var refFileInput = document.getElementById('image-ref-file');
  if (btnRef && refFileInput) {
    btnRef.addEventListener('click', function() {
      // 模板不支持参考图时提示
      var provider = getCurrentImageProvider();
      if (provider && provider.features && !provider.features.supportsReferenceImage) {
        showToast('当前接口模板（' + provider.template + '）不支持参考图', 'warn');
        return;
      }
      refFileInput.click();
    });
    refFileInput.addEventListener('change', async function(e) {
      var files = e.target.files;
      if (!files || files.length === 0) return;
      // 多选：最多 16 张（OpenAI 上限）
      if (!state._imageRefDataUrls) state._imageRefDataUrls = [];
      var maxAdd = 16 - state._imageRefDataUrls.length;
      if (maxAdd <= 0) { showToast('最多 16 张参考图', 'warn'); e.target.value = ''; return; }
      var toAdd = Array.from(files).slice(0, maxAdd);
      try {
        for (var i = 0; i < toAdd.length; i++) {
          var dataUrl = await compressImageForGeneration(toAdd[i]);
          state._imageRefDataUrls.push({ dataUrl: dataUrl, name: toAdd[i].name, size: toAdd[i].size });
        }
        renderImageRefPreview();
        if (btnRef) btnRef.classList.add('has-ref');
        if (toAdd.length < files.length) showToast('已达 16 张上限，部分图片未添加', 'warn');
      } catch(err) {
        showToast('参考图加载失败: ' + (err.message || err), 'warn');
      }
      e.target.value = '';
    });
  }

  // 渲染参考图预览（多张）
  function renderImageRefPreview() {
    var preview = document.getElementById('image-ref-preview');
    if (!preview) return;
    var refs = state._imageRefDataUrls || [];
    if (refs.length === 0) {
      preview.classList.remove('has-ref');
      preview.innerHTML = '<img id="image-ref-thumb" alt="参考图"><span class="ref-info" id="image-ref-info">参考图</span><button class="ref-clear" id="image-ref-clear" title="移除全部">×</button>';
      bindRefClear();
      return;
    }
    preview.classList.add('has-ref');
    var html = '';
    refs.forEach(function(r, idx) {
      html += '<div class="ref-thumb-item" data-idx="' + idx + '">' +
        '<img src="' + r.dataUrl + '" alt="参考图' + (idx + 1) + '">' +
        '<span class="ref-order">' + (idx + 1) + '</span>' +
        '<button class="ref-item-clear" data-idx="' + idx + '" title="移除此图">×</button>' +
      '</div>';
    });
    html += '<span class="ref-info">' + refs.length + ' 张参考图</span>';
    html += '<button class="ref-clear" id="image-ref-clear" title="移除全部">清空</button>';
    preview.innerHTML = html;
    bindRefClear();
    // 绑定单张删除
    preview.querySelectorAll('.ref-item-clear').forEach(function(btn) {
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var idx = parseInt(btn.dataset.idx);
        if (!isNaN(idx) && state._imageRefDataUrls) {
          state._imageRefDataUrls.splice(idx, 1);
          renderImageRefPreview();
        }
      });
    });
  }

  function bindRefClear() {
    var refClear = document.getElementById('image-ref-clear');
    if (refClear) refClear.addEventListener('click', function() {
      state._imageRefDataUrls = [];
      renderImageRefPreview();
      var btnRef = document.getElementById('btn-image-ref');
      if (btnRef) btnRef.classList.remove('has-ref');
    });
  }

  // 宽高比自定义切换
  var aspectSel = document.getElementById('image-aspect-select');
  var aspectCustom = document.getElementById('image-aspect-custom');
  if (aspectSel && aspectCustom) {
    aspectSel.addEventListener('change', function() {
      aspectCustom.style.display = (aspectSel.value === 'custom') ? '' : 'none';
    });
  }

  // v90: 提示词输入回车仅换行（contenteditable 默认），生成走生成按钮
  var promptInput = document.getElementById('image-prompt-input');
  var sendBtn = document.getElementById('btn-image-send');
  if (promptInput) {
    promptInput.addEventListener('input', function() {
      var hasText = promptInput.innerText.trim().length > 0;
      if (sendBtn) sendBtn.disabled = !hasText;
    });
  }
  if (sendBtn) sendBtn.addEventListener('click', function() {
    // v66: 生成中点击则停止，否则触发生成
    if (state._imageGenerating && state._imageAbortController) {
      state._imageAbortController.abort();
      showToast('已停止生成', 'info');
    } else {
      generateImage();
    }
  });

  // 高级参数折叠
  var advToggle = document.getElementById('image-advanced-toggle');
  var advBody = document.getElementById('image-advanced-body');
  if (advToggle && advBody) {
    advToggle.addEventListener('click', function() {
      advToggle.classList.toggle('open');
      advBody.classList.toggle('open');
    });
  }

  // 设置面板 - 生图 API 分组按钮
  var btnAddImgProv = document.getElementById('btn-add-image-provider');
  if (btnAddImgProv) btnAddImgProv.addEventListener('click', function() { openImageProviderEditor(-1); });
  // 模板切换：自动填充推荐默认模型（仅新建时，编辑已有时不覆盖）
  var imgProvTmplSel = document.getElementById('img-provider-template-select');
  if (imgProvTmplSel) {
    imgProvTmplSel.addEventListener('change', function() {
      var editor = document.getElementById('image-provider-editor');
      var isnew = !editor || editor.dataset.editIdx === '';
      if (!isnew) return;  // 编辑已有时不覆盖
      var tmpl = imgProvTmplSel.value;
      var recommendedModel = '';
      if (tmpl === 'gpt_image') recommendedModel = 'gpt-image-2';
      else if (tmpl === 'nano_banana') recommendedModel = 'gemini-2.5-flash-image';
      else if (tmpl === 'openai_compat') recommendedModel = 'wanx2.1-t2i-turbo';
      else if (tmpl === 'openai_standard') recommendedModel = 'dall-e-3';
      var modelInput = document.getElementById('img-provider-default-model-input');
      if (modelInput && recommendedModel) modelInput.value = recommendedModel;
    });
  }
  var btnSaveImgProv = document.getElementById('btn-save-image-provider');
  if (btnSaveImgProv) btnSaveImgProv.addEventListener('click', saveImageProviderFromEditor);
  var btnCloseImgProv = document.getElementById('btn-close-image-provider-editor');
  if (btnCloseImgProv) btnCloseImgProv.addEventListener('click', closeImageProviderEditor);
  var btnClearGallery = document.getElementById('btn-clear-image-gallery');
  if (btnClearGallery) btnClearGallery.addEventListener('click', clearImageGallery);

  // 边缘滑动返回（从左边缘 24px 内向右滑动 >80px 触发）
  var imageView = document.getElementById('image-view');
  if (imageView) {
    var touchStartX = 0, touchStartY = 0, touchStartT = 0;
    var swiping = false;
    imageView.addEventListener('touchstart', function(e) {
      if (!state.imageViewOpen) return;
      var t = e.touches[0];
      if (t.clientX < 24) {
        swiping = true;
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        touchStartT = Date.now();
      }
    }, { passive: true });
    imageView.addEventListener('touchend', function(e) {
      if (!swiping) return;
      swiping = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - touchStartX;
      var dy = Math.abs(t.clientY - touchStartY);
      var dt = Date.now() - touchStartT;
      // 横向滑动 >80px，纵向偏移 <60px，时间 <500ms
      if (dx > 80 && dy < 60 && dt < 500) {
        toggleImageView(false);
      }
    }, { passive: true });
  }

  // Android 物理返回键拦截（ Capacitor 平台用 BackButton 事件）
  if (isCapacitor() && Capacitor.Plugins && Capacitor.Plugins.App) {
    var App = Capacitor.Plugins.App;
    App.addListener('backButton', function() {
      if (state.imageViewOpen) {
        toggleImageView(false);
      } else if (state.settingsOpen) {
        toggleSettings(false);
      } else {
        // 默认行为：退出应用（Capacitor 推荐方式）
        App.exitApp();
      }
    });
    // F1: 监听前后台切换，生图请求进行中时切后台不报错（请求继续在原生层等待，切回前台后正常处理）
    App.addListener('appStateChange', function(info) {
      var isActive = info.isActive;
      console.log('appStateChange:', isActive ? 'active' : 'background');
      state._isBackground = !isActive;  // v67: 追踪前后台状态
      if (isActive) {
        // 切回前台：恢复进行中任务的 UI 提示
        if (state._imageGenerating) {
          var indicator = document.getElementById('image-status-indicator');
          if (indicator) indicator.className = 'image-status-indicator loading';
          showToast('生图请求进行中，请稍候...', 'info');
        }
        if (state.loading) {
          showToast('回复请求进行中，请稍候...', 'info');
        }
        // v67: 后台期间文字回复已完成，显示待显示通知
        if (state._pendingTextNotify) {
          var n = state._pendingTextNotify;
          state._pendingTextNotify = null;
          showToast(n, 'success');
        }
      }
    });
  }
}
// v70: 生图完成系统通知（无论前后台都发，前台 toast + 通知栏，后台仅通知栏）
function notifyImageComplete(count) {
  if (!isCapacitor() || !Capacitor.Plugins || !Capacitor.Plugins.LocalNotifications) return;
  try {
    // v70: 权限已在 init 时预申请，这里直接检查并调度
    Capacitor.Plugins.LocalNotifications.checkPermissions().then(function(perm) {
      if (perm.display !== 'granted') {
        console.log('[Notify] permission not granted, skip');
        return;
      }
      Capacitor.Plugins.LocalNotifications.schedule({
        notifications: [{
          id: (Date.now() % 1000000) + 1,  // v70: 扩大 id 范围避免重复
          title: '生图完成',
          body: '共生成 ' + count + ' 张图片',
          schedule: { at: new Date(Date.now() + 200) }  // v70: 200ms 后触发确保立即
        }]
      }).then(function() {
        console.log('[Notify] image complete notification scheduled');
      }).catch(function(e) { console.warn('[Notify] schedule failed:', e); });
    }).catch(function(e) { console.warn('[Notify] checkPermissions failed:', e); });
  } catch(e) { console.warn('[Notify] error:', e); }
}
async function migrateImportedImagesToFilesystem() {
  if (!isCapacitor() || !CapFilesystem) return;
  var images = settings.images || [];
  var migrated = 0;
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    if (img.dataUrl && !img.fileName) {
      try {
        var fileName = await writeImageFile(img.dataUrl, img.id);
        if (fileName) {
          img.fileName = fileName;
          img.dataUrl = null;  // 剥离，释放 localStorage 空间
          migrated++;
        }
      } catch (e) {
        console.warn('migrate image failed:', img.id, e);
      }
    }
  }
  if (migrated > 0) {
    saveImageProviders();  // 持久化（此时 dataUrl 已剥离，settings 体积小）
    renderImageStream();
    console.log('已迁移 ' + migrated + ' 张图片到 Filesystem');
  }
}