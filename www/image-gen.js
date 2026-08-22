// ===== image-gen.js : 生图功能模块（v2.0 拆分）=====
// 模块名：image-gen.js
// 版本：v102（cache-bust，2026-08-22：新增 zhipu 格式族——智谱 CogView paas v4 官方端点 /api/paas/v4/images/generations（原 flat 走 /v1 致 405 实锤修复），请求体不含 n、size 枚举/自定义、quality 条件传，响应 url 临时链接 30 天下载转存）
// 迁移日期：2026-07-26
// 来源：从 app.js 拆分
// 职责：生图接口管理、生图界面、图库、图片预览、图片存储、核心生图、完成通知
// 依赖：app.js 运行时提供 state / settings / save / saveSettings / escapeHtml / showToast /
//       ICON / uid / $ / isCapacitor / CapFilesystem / Capacitor / normalizeBaseUrl /
//       parseJsonField / migrateImportedImagesToFilesystem / currentConv
// 加载顺序：在 db.js + haptics.js + providers.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   常量：IMAGE_FORMATS（格式注册表）, IMAGE_PROVIDER_PRESETS（提供方预设）, _IMAGE_SIZE_MAP, _GPT_IMAGE_SIZE_MAP,
//         IMAGE_STORE_DIR, _previewGestureDestroy
//   函数：getImageFormat, migrateImageTemplate, normalizeImageProvider, getImageProvider,
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

// ===== F1: 生图格式注册表（独立于聊天 PROVIDER_TEMPLATES）=====
// v95 重构（2026-08-21）：模板→格式注册表 + 提供方预设，声明与消费解耦
// 格式族覆盖 2026-08 主流格局：
//   flat          OpenAI 标准（DALL-E / xAI Grok Imagine / 智谱 CogView / 豆包 Seedream / 硅基流动 / 各中转）
//   gpt_image     OpenAI GPT Image（gpt-image-2/1.5/1）
//   gemini_image  Google Gemini generateContent（gemini-3-pro-image-preview / gemini-2.5-flash-image）
//   wanxiang      通义万相 nested（DashScope multimodal-generation，wan2.6-t2i / wan2.6-image / wan2.7-image）
const IMAGE_FORMATS = {
  flat: {
    label: 'OpenAI 标准（flat JSON）',
    endpointPath: '/v1/images/generations',
    editsPath: '/v1/images/edits',   // xAI / 部分兼容方支持图生图
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'flat',
    responseFormat: 'url_or_b64',
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: true, supportsBatch: true, maxBatch: 4, supportsResolution: true, supportsAspectRatio: true },
    // 请求体：{model, prompt, n, size}；带参考图时走 edits 端点（multipart，由 buildImageRequestPayload 转 FormData）
    buildBody: function(provider, ctx) {
      var body = { model: ctx.model, prompt: ctx.prompt, n: ctx.n, size: ctx.sizeConfig.size || '1024x1024' };
      if (ctx.refDataUrls.length > 0) {
        body._useEdits = true;
        body._refDataUrls = ctx.refDataUrls;
        body.n = 1;  // edits 端点通常仅单张
      }
      return body;
    },
    parseResponse: function(data) { return (data && data.data) || []; }
  },
  gpt_image: {
    label: 'GPT Image（gpt-image-2/1.5/1）',
    endpointPath: '/v1/images/generations',
    editsPath: '/v1/images/edits',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'gpt_image',
    responseFormat: 'b64_only',
    defaultModel: 'gpt-image-2',
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: true, supportsBatch: false, maxBatch: 1, supportsQuality: true, supportsResolution: false, supportsAspectRatio: true },
    // v103: gpt_image 尺寸集固定, resolution 应隐藏
    // 文生图 flat + quality/output_format/moderation；图生图走 edits 端点（multipart）
    buildBody: function(provider, ctx) {
      var body = { model: ctx.model, prompt: ctx.prompt, n: ctx.n, size: ctx.sizeConfig.size || 'auto', quality: ctx.quality || 'auto', output_format: 'png', moderation: 'auto' };
      if (ctx.refDataUrls.length > 0) {
        body._useEdits = true;
        body._refDataUrls = ctx.refDataUrls;
        body.n = 1;  // edits 端点只支持 n=1
      }
      return body;
    },
    parseResponse: function(data) { return (data && data.data) || []; }
  },
  gemini_image: {
    label: 'Gemini 原生（generateContent）',
    endpointPath: '/v1beta/models/{model}:generateContent',
    authType: 'bearer',           // 官方 AI Studio key 用 Bearer；需 x-goog-api-key 时在鉴权下拉切换
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'gemini_image',
    responseFormat: 'gemini',
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: false, supportsBatch: false, maxBatch: 1, supportsResolution: true, supportsAspectRatio: true },
    // contents[].parts[].text + generationConfig.imageConfig{aspectRatio, imageSize}；参考图作为 inline_data parts
    buildBody: function(provider, ctx) {
      var parts = [{ text: ctx.prompt }];
      for (var i = 0; i < ctx.refDataUrls.length; i++) {
        var refP = ctx.refDataUrls[i].split(',');
        var mime = (refP[0].match(/data:(.*?);base64/) || [])[1] || 'image/png';
        parts.push({ inline_data: { mime_type: mime, data: refP[1] || '' } });
      }
      var genConfig = { responseModalities: ['IMAGE'] };
      if (ctx.sizeConfig.imageConfig) genConfig.imageConfig = ctx.sizeConfig.imageConfig;
      return { contents: [{ parts: parts }], generationConfig: genConfig };
    },
    // candidates[0].content.parts[].inlineData.data
    parseResponse: function(data) {
      var results = [];
      var candidates = (data && data.candidates) || [];
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
      return results;
    }
  },
  wanxiang: {
    label: '通义万相（nested）',
    endpointPath: '/api/v1/services/aigc/multimodal-generation/generation',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'wanxiang',
    responseFormat: 'url_or_b64',
    features: { supportsReferenceImage: true, supportsNegativePrompt: true, supportsCustomSize: true, supportsBatch: true, maxBatch: 4, supportsResolution: true, supportsAspectRatio: true },
    // input.messages[].content[].text/image + parameters{prompt_extend, watermark, n, negative_prompt, size}
    buildBody: function(provider, ctx) {
      var contentParts = [{ type: 'text', text: ctx.prompt }];
      for (var i = 0; i < ctx.refDataUrls.length; i++) {
        contentParts.push({ type: 'image', image: ctx.refDataUrls[i].split(',')[1] });
      }
      var params = {
        prompt_extend: ctx.promptExtend,
        watermark: ctx.watermark,
        n: ctx.n,
        size: ctx.sizeConfig.size || '1024x1024'
      };
      if (ctx.negativePrompt) params.negative_prompt = ctx.negativePrompt;
      return { input: { messages: [{ role: 'user', content: contentParts }] }, parameters: params };
    },
    parseResponse: function(data) { return (data && data.data) || []; }
  },
  // v100: OpenRouter 新版图片 API（官方验证流程，非手搓）——
  // POST /api/v1/images，参考图走 JSON input_references 而非 multipart edits
  //（绕开中转站薄弱的 multipart edits；一个端点同时管文生图+图生图）
  openrouter_image: {
    label: 'OpenRouter 新版（input_references）',
    endpointPath: '/api/v1/images',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'openrouter_image',
    responseFormat: 'url_or_b64',
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: false, supportsBatch: false, maxBatch: 1, supportsResolution: false, supportsAspectRatio: false },
    buildBody: function(provider, ctx) {
      var body = { model: ctx.model, prompt: ctx.prompt, n: 1 };
      if (ctx.refDataUrls && ctx.refDataUrls.length > 0) {
        body.input_references = ctx.refDataUrls.map(function(d) {
          return { type: 'image_url', image_url: { url: d } };
        });
      }
      return body;
    },
    parseResponse: function(data) { return (data && data.data) || []; }
  },
  // v102: 智谱 CogView（paas v4 官方端点）——OpenAI 兼容但端点是 /api/paas/v4 而非 /v1，
  // 且请求体不含 n（智谱不支持）、size 支持枚举/自定义（512-2048 被 16 整除，最大 2^21 像素）、
  // quality 仅 cogview-4-250304 支持；响应 data[].url 临时链接 30 天（chat-lite 会下载转存）
  zhipu: {
    label: '智谱 CogView（paas v4）',
    endpointPath: '/api/paas/v4/images/generations',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'zhipu',
    responseFormat: 'url_or_b64',
    features: { supportsReferenceImage: false, supportsNegativePrompt: false, supportsCustomSize: true, supportsBatch: false, maxBatch: 1, supportsResolution: true, supportsAspectRatio: false, supportsQuality: true },
    buildBody: function(provider, ctx) {
      var body = { model: ctx.model, prompt: ctx.prompt };
      if (ctx.sizeConfig.size && ctx.sizeConfig.size !== 'auto') body.size = ctx.sizeConfig.size;
      if (ctx.quality && ctx.quality !== 'auto') body.quality = ctx.quality;
      return body;
    },
    parseResponse: function(data) { return (data && data.data) || []; }
  },
  minimax: {
    label: 'MiniMax 海螺（image-01）',
    endpointPath: '/v1/image_generation',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    requestFormat: 'minimax',
    responseFormat: 'url_or_b64',
    defaultModel: 'image-01',
    // v103: 新增格式族。MiniMax 走 /v1/image_generation，尺寸是 aspect_ratio（非 size），响应为
    // data.data.image_urls[]（URL 串）或 data.data[]（base64/dataURL 串）。  // v105: 图生图——同一端点加 subject_reference 数组（不入 edits/multipart），有参考图即同链路静默切换。
    features: { supportsReferenceImage: true, supportsNegativePrompt: false, supportsCustomSize: true, supportsBatch: true, maxBatch: 4, supportsResolution: false, supportsAspectRatio: true },
    // 请求体：{model, prompt, n, aspect_ratio, response_format}；不用 size
    buildBody: function(provider, ctx) {
      var body = { model: ctx.model, prompt: ctx.prompt, n: Math.max(1, Math.min(4, ctx.n || 1)) };
      var ratio = ctx.sizeConfig && ctx.sizeConfig.imageConfig && ctx.sizeConfig.imageConfig.aspectRatio || (ctx.sizeConfig && ctx.sizeConfig.aspectRatio);
      if (ratio && ratio !== 'auto') body.aspect_ratio = ratio;
      body.response_format = 'url';
      // v105: 参考图 → subject_reference（仅首图作为主体参考，官方当前仅支持 character/人像）
      if (ctx.refDataUrls && ctx.refDataUrls.length > 0) {
        body.subject_reference = [{ type: 'character', image_file: ctx.refDataUrls[0] }];
      }
      return body;
    },
    // 响应 data.data: {image_urls:[str]} | [ {url} ] | [b64 str | dataURL str]
    parseResponse: function(data) {
      var arr = (data && data.data) ? data.data : null;
      if (!arr) return [];
      if (Array.isArray(arr.image_urls)) arr = arr.image_urls;
      if (!Array.isArray(arr)) {
        var alt = arr && (arr.image_urls || arr.images);
        if (Array.isArray(alt)) arr = alt; else return [];
      }
      return arr.map(function(v) {
        if (v && typeof v === 'object') return v;           // 已是 {url}/{b64_json}
        v = String(v || '');
        if (/^https?:\/\//.test(v)) return { url: v };      // URL 串
        if (v.indexOf('data:') === 0) v = v.replace(/^data:image\/[^;]+;base64,/, ''); // dataURL 串
        if (v) return { b64_json: v };                      // 裸 base64 串
        return null;
      }).filter(Boolean);
    }
  }
};

// 提供方预设：选预设自动填充地址/端点/格式/默认模型，保存后仍是独立记录可改
const IMAGE_PROVIDER_PRESETS = {
  openai_gpt_image: { label: 'OpenAI GPT Image', format: 'gpt_image', baseUrl: 'https://api.openai.com', defaultModel: 'gpt-image-2' },
  xai_grok: { label: 'xAI Grok Imagine', format: 'flat', baseUrl: 'https://api.x.ai', defaultModel: 'grok-imagine-image-2.0' },
  gemini: { label: 'Google Gemini', format: 'gemini_image', baseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-3-pro-image-preview' },
  wanxiang: { label: '阿里通义万相', format: 'wanxiang', baseUrl: 'https://dashscope.aliyuncs.com', defaultModel: 'wan2.6-t2i' },
  zhipu_cogview: { label: '智谱 CogView', format: 'zhipu', baseUrl: 'https://open.bigmodel.cn', defaultModel: 'cogview-4' },  // v102: 修正官方端点 /api/paas/v4（原 flat /v1 导致 405）
  minimax: { label: 'MiniMax 海螺', format: 'minimax', baseUrl: 'https://api.minimaxi.com', defaultModel: 'image-01' },  // v103: 新增 MiniMax（/v1/image_generation + aspect_ratio）
  openrouter: { label: 'OpenRouter 新版图片 API', format: 'openrouter_image', baseUrl: 'https://openrouter.ai', defaultModel: 'openai/gpt-image-2' },  // v100: 对齐官方 /api/v1/images + input_references（参考图走 JSON 不走 edits）
  doubao_seedream: { label: '豆包 Seedream', format: 'flat', baseUrl: 'https://ark.cn-beijing.volces.com', defaultModel: 'doubao-seedream-3-0-t2i-250415' },
  siliconflow: { label: '硅基流动', format: 'flat', baseUrl: 'https://api.siliconflow.cn', defaultModel: 'black-forest-labs/FLUX.1-schnell' },
  custom: { label: '自定义', format: null, baseUrl: '', defaultModel: '' }
};

// 旧模板名 → 格式名迁移（v95，老用户已保存的 provider 无感升级）
var _IMAGE_TEMPLATE_MIGRATE = {
  'gpt_image': 'gpt_image',
  'nano_banana': 'gemini_image',
  'openai_compat': 'wanxiang',
  'openai_standard': 'flat',
  'custom': 'flat'
};

function migrateImageTemplate(tpl) {
  if (IMAGE_FORMATS[tpl]) return tpl;            // 已是格式名
  return _IMAGE_TEMPLATE_MIGRATE[tpl] || 'flat'; // 旧模板名迁移，未知回退 flat
}

function getImageFormat(name) {
  return IMAGE_FORMATS[name] || IMAGE_FORMATS.flat;
}

function normalizeImageProvider(p) {
  if (!p || typeof p !== 'object') p = {};
  var formatName = migrateImageTemplate(p.template);
  var format = getImageFormat(formatName);
  var baseUrl = normalizeBaseUrl(p.baseUrl);
  var endpointPath = p.endpointPath;
  // v104: 显式端点残留通用默认（flat 的 /v1/images/generations）且当前格式族端点不同 → 跟随格式族（防 minimax 等走错端点）
  var flatDefault = IMAGE_FORMATS.flat ? IMAGE_FORMATS.flat.endpointPath : null;
  if (flatDefault && format.endpointPath && endpointPath === flatDefault && format.endpointPath !== flatDefault) endpointPath = null;
  // v100: 版本段剥离重写——baseUrl 以 /api、/api/vN、/vN 结尾都剥离（v96 正则漏 /api 结尾），
  // 且显式 endpointPath 也参与（v96 只处理默认端点，OpenRouter 显式 endpointPath 丢 /api 段的漏网实锤）
  var verMatch = baseUrl.match(/^(.*?)(\/api(\/v\d+)?|\/v\d+)$/i);
  var verPrefix = verMatch ? verMatch[2] : null;
  if (verMatch) baseUrl = verMatch[1];
  var path = endpointPath || format.endpointPath;
  if (verPrefix && path.indexOf('://') < 0 && path.indexOf(verPrefix) !== 0) {
    // 区分「纯 API 前缀（/api，OpenRouter 型）」与「版本段（/vN 或 /api/vN，硅基/火山型）」：
    // 纯前缀 → endpointPath 的 /vN 版本段保留；版本段 → endpointPath 的默认 /vN 剥掉（防重复）
    var baseIsPureApi = verPrefix === '/api';
    var stripped = baseIsPureApi ? path : path.replace(/^\/v\d+\//, '');
    path = verPrefix + (stripped.indexOf('/') === 0 ? stripped : '/' + stripped);
  }
  endpointPath = path;
  var result = {
    id: p.id || uid(),
    name: p.name || '未命名生图接口',
    template: formatName,          // 统一存格式名
    baseUrl: baseUrl,
    endpointPath: endpointPath,
    apiKey: p.apiKey || '',
    authType: p.authType || format.authType,
    authHeader: p.authHeader || format.authHeader,
    authPrefix: p.authPrefix !== undefined ? p.authPrefix : format.authPrefix,
    defaultModel: p.defaultModel || format.defaultModel || 'gpt-image-2',  // v103: 格式族 defaultModel 优先（minimax→image-01 等）
    requestFormat: format.requestFormat,
    responseFormat: format.responseFormat,
    // v106: features 一律以格式族定义为准（持久化 p.features 是旧版本派生的过期快照，
    // 会覆盖格式族最新能力演进，如 minimax supportsReferenceImage=false 旧快照挡图生图）；
    // features 为纯派生元数据且无用户编辑入口，故只读 format.features。
    features: Object.assign({}, format.features),
    createdAt: p.createdAt || Date.now()
  };
  // 保留 editsPath（图生图专用端点）；带版本前缀时同步修正
  var baseEdits = p.editsPath || format.editsPath;
  if (baseEdits) {
    if (verPrefix && baseEdits.indexOf('://') < 0 && baseEdits.indexOf(verPrefix) !== 0) {
      var baseIsPureApiE = verPrefix === '/api';
      var strippedE = baseIsPureApiE ? baseEdits : baseEdits.replace(/^\/v\d+\//, '');
      baseEdits = verPrefix + (strippedE.indexOf('/') === 0 ? strippedE : '/' + strippedE);
    }
    result.editsPath = baseEdits;
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
    var fmtName = migrateImageTemplate(p.template);
    var fmt = getImageFormat(fmtName);
    var templateLabel = fmt ? '[' + fmt.label + '] ' : '';
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
  var fmtName = p ? (p.requestFormat || p.template) : 'flat';
  // 提供方预设回填：按格式名+地址匹配预设，未匹配则自定义
  var presetSel = document.getElementById('img-provider-preset-select');
  if (presetSel) {
    var presetId = 'custom';
    if (p) {
      for (var pk in IMAGE_PROVIDER_PRESETS) {
        var pre = IMAGE_PROVIDER_PRESETS[pk];
        if (pre.format === fmtName && (!pre.baseUrl || pre.baseUrl === p.baseUrl)) { presetId = pk; break; }
      }
    }
    presetSel.value = presetId;
  }
  var formatSel = document.getElementById('img-provider-format-select');
  if (formatSel) formatSel.value = fmtName;
  document.getElementById('img-provider-name-input').value = p ? p.name : '';
  document.getElementById('img-provider-url-input').value = p ? p.baseUrl : '';
  document.getElementById('img-provider-endpoint-input').value = p ? (p.endpointPath || '') : '';
  document.getElementById('img-provider-key-input').value = p ? p.apiKey : '';
  document.getElementById('img-provider-default-model-input').value = p ? (p.defaultModel || '') : '';
  // 鉴权方式回填：与格式默认一致或未设则「跟随格式」
  var authSel = document.getElementById('img-provider-auth-select');
  if (authSel) {
    var authVal = '';
    if (p && p.authType) {
      var fmt = getImageFormat(fmtName);
      if (p.authType !== fmt.authType || (p.authHeader && p.authHeader !== fmt.authHeader)) {
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
  var format = document.getElementById('img-provider-format-select');
  var template = format ? format.value : 'flat';
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
    defaultModel: defaultModel || 'gpt-image-2'
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
    // authHeader/authPrefix 跟随格式
  } else if (authOverride === 'query') {
    providerData.authType = 'query';
    providerData.authHeader = 'api_key';
    providerData.authPrefix = '';
  } else if (authOverride === 'none') {
    providerData.authType = 'none';
  }
  // authOverride === '' 时不设 authType，normalizeImageProvider 用格式默认
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

// F1: 提供方预设联动填充（选预设→自动填格式/地址/端点占位/默认模型；仅空值填充，不覆盖已有）
function onImageProviderPresetChange() {
  var presetSel = document.getElementById('img-provider-preset-select');
  var preset = IMAGE_PROVIDER_PRESETS[presetSel ? presetSel.value : 'custom'];
  if (!preset) return;
  if (preset.format) {
    var fmt = getImageFormat(preset.format);
    var formatSel = document.getElementById('img-provider-format-select');
    if (formatSel) formatSel.value = preset.format;
    var urlInput = document.getElementById('img-provider-url-input');
    if (urlInput && !urlInput.value && preset.baseUrl) urlInput.value = preset.baseUrl;
    var modelInput = document.getElementById('img-provider-default-model-input');
    if (modelInput && !modelInput.value && preset.defaultModel) modelInput.value = preset.defaultModel;
    var endpointInput = document.getElementById('img-provider-endpoint-input');
    if (endpointInput && fmt.endpointPath) {
      // v104: 选预设时端点跟随格式。空值或残留 flat 通用默认时才覆盖，保留用户自定义端点
      var cur = (endpointInput.value || '').trim();
      var flatDef = IMAGE_FORMATS.flat ? IMAGE_FORMATS.flat.endpointPath : null;
      if (!cur || (flatDef && cur === flatDef && fmt.endpointPath !== flatDef)) endpointInput.value = fmt.endpointPath;
      endpointInput.placeholder = fmt.endpointPath;
    }
  }
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

// F1: 根据当前生图接口格式与能力，显示/隐藏高级参数中的 quality / 负面提示词 / 参考图等字段
function updateImageAdvancedVisibility() {
  var provider = getCurrentImageProvider();
  var fmt = provider ? (provider.requestFormat || provider.template) : 'flat';
  var features = provider ? provider.features : null;
  // v103: quality 行由 features.supportsQuality 驱动（gpt_image/zhipu 显示，其余隐藏）
  var qualityRow = document.getElementById('image-quality-row');
  if (qualityRow) qualityRow.style.display = (features && features.supportsQuality) ? '' : 'none';
  // v103: 分辨率选择由 features.supportsResolution 驱动（gpt_image 尺寸集固定/minimax 无分辨率 → 隐藏）
  var resSelect = document.getElementById('image-resolution-select');
  if (resSelect) resSelect.style.display = (features && features.supportsResolution) ? '' : 'none';
  // 负面提示词：格式不支持时隐藏
  var negRow = document.getElementById('image-negative-prompt-row');
  if (negRow) negRow.style.display = (features && features.supportsNegativePrompt) ? '' : 'none';
  // 提示词扩展/水印：仅通义万相（nested）显示
  var promptExtendLabel = document.getElementById('image-prompt-extend-label');
  if (promptExtendLabel) promptExtendLabel.style.display = (fmt === 'wanxiang') ? '' : 'none';
  var watermarkLabel = document.getElementById('image-watermark-label');
  if (watermarkLabel) watermarkLabel.style.display = (fmt === 'wanxiang') ? '' : 'none';
  // 参考图按钮：始终显示，格式不支持时点击会提示（不再隐藏，避免用户找不到入口）
  var btnRef = document.getElementById('btn-image-ref');
  if (btnRef) btnRef.style.display = '';
  // gpt_image 格式：动态改「自由」option 文本提示用户（gpt-image-2 的 auto 默认返回 1:1，不读提示词宽高）
  var aspectSel = document.getElementById('image-aspect-select');
  if (aspectSel && aspectSel.options[0]) {
    aspectSel.options[0].text = (fmt === 'gpt_image') ? '自由（默认1:1）' : '自由';
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
        // v100: 改 JPEG 输出——PNG 对照片体积大 3-5 倍，JPEG 上传更稳（透明通道在参考图场景无意义）
        resolve(canvas.toDataURL('image/jpeg', 0.85));
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
  var fmt = provider ? (provider.requestFormat || provider.template) : 'gpt_image';
  var result = { size: 'auto', imageConfig: null };
  // 自定义：直接用用户输入（支持 WxH 或 W:H）
  if (aspect === 'custom' && customSize) {
    if (fmt === 'gemini_image') {
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
  // gpt_image 格式：只用 gpt-image-2 支持的 3 个固定 size + auto
  // 重要：gpt-image-2 的 size='auto' 是「模型默认比例」（通常 1:1），不会读提示词里的宽高描述
  if (fmt === 'gpt_image') {
    if (aspect === 'auto') {
      result.size = 'auto';  // 模型默认（不读提示词宽高）
    } else {
      result.size = _GPT_IMAGE_SIZE_MAP[aspect] || '1024x1024';
    }
    return result;
  }
  // v103: minimax 尺寸走 aspect_ratio（无像素 WxH）
  if (fmt === 'minimax') {
    if (aspect === 'custom' && customSize) {
      if (/^\d+:\d+$/.test(customSize)) { result.imageConfig = { aspectRatio: customSize }; return result; }
      if (/^\d+x\d+$/i.test(customSize)) { var mm = customSize.match(/^(\d+)x(\d+)$/i); result.imageConfig = { aspectRatio: mm[1] + ':' + mm[2] }; return result; }
      return result; // 无法表达 → 按 auto
    }
    if (aspect !== 'auto') result.imageConfig = { aspectRatio: aspect };
    return result;
  }
  // auto 分辨率或 auto 宽高比 → 让模型自由
  if (resolution === 'auto' && aspect === 'auto') {
    return result;  // size='auto', imageConfig=null
  }
  if (fmt === 'gemini_image') {
    // Gemini：imageConfig = {aspectRatio, imageSize}
    var cfg = {};
    if (resolution !== 'auto') cfg.imageSize = resolution;  // "1K"/"2K"/"4K"
    if (aspect !== 'auto') cfg.aspectRatio = aspect;        // "1:1"/"16:9" 等
    result.imageConfig = Object.keys(cfg).length > 0 ? cfg : null;
    return result;
  }
  // OpenAI 系（dall-e/gpt-image/xAI 等）：size = "WxH" 或 "auto"
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
  // v101: prompt 前缀体系（全局前缀 + 消息模板 {prompt} 占位）
  prompt = combineImagePrefixes(settings.imagePromptPrefix || '', prompt, settings.imagePromptTemplate || '');
  var provider = getCurrentImageProvider();
  if (!provider) {
    showToast('请先在设置中添加生图接口', 'warn');
    return;
  }
  var modelInput = document.getElementById('image-model-input');
  var model = modelInput ? modelInput.value.trim() : '';
  if (!model) model = provider.defaultModel || 'dall-e-3';
  // v101: 模型特定提示词截断（dall-e-2/3、gpt-image 有字符上限）
  prompt = adaptPromptForModel(model, prompt);

  // 尺寸：从「分辨率 + 宽高比」两层下拉读取
  var resolutionSel = document.getElementById('image-resolution-select');
  var aspectSel = document.getElementById('image-aspect-select');
  var aspectCustom = document.getElementById('image-aspect-custom');
  var resolution = resolutionSel ? resolutionSel.value : '2K';
  var aspect = aspectSel ? aspectSel.value : 'auto';
  var customSize = (aspect === 'custom' && aspectCustom) ? aspectCustom.value.trim() : '';
  var sizeConfig = buildImageSizeConfig(provider, resolution, aspect, customSize);
  // v101: 模型特定尺寸上限（gpt_image 系 dall-e-3 1792 / gpt-image 1536，超出等比收窄）
  sizeConfig = adaptSizeForModel(provider.requestFormat || provider.template, model, sizeConfig);

  // 高级参数
  var negPromptEl = document.getElementById('image-negative-prompt');
  var batchNEl = document.getElementById('image-batch-n');
  var promptExtendEl = document.getElementById('image-prompt-extend');
  var watermarkEl = document.getElementById('image-watermark');
  var qualitySel = document.getElementById('image-quality-select');
  // v101: 负面前缀合并（全局负面前缀 + 输入框负面词）
  var negativePrompt = combineImagePrefixes(settings.imageNegativePrefix || '', negPromptEl ? negPromptEl.value.trim() : '', '');
  var n = Math.max(1, Math.min(4, parseInt(batchNEl ? batchNEl.value : '1') || 1));
  if (provider.features && provider.features.maxBatch) {
    n = Math.min(n, provider.features.maxBatch);
  }
  var promptExtend = promptExtendEl ? promptExtendEl.checked : true;
  var watermark = watermarkEl ? watermarkEl.checked : false;
  var quality = qualitySel ? qualitySel.value : 'auto';

  // 参考图（图生图）：多张数组，兼容旧字段 _imageRefDataUrl
  var refDataUrls = [];
  if (Array.isArray(state._imageRefDataUrls) && state._imageRefDataUrls.length > 0) {
    refDataUrls = state._imageRefDataUrls.map(function(r) { return r.dataUrl; });
  } else if (state._imageRefDataUrl) {
    refDataUrls = [state._imageRefDataUrl];  // 兼容旧字段
  }
  if (refDataUrls.length > 0 && provider.features && !provider.features.supportsReferenceImage) {
    showToast('当前接口格式不支持参考图，已忽略', 'warn');
    refDataUrls = [];
  }

  // 构建请求体：按格式注册表分发（requestFormat → buildBody），主流程无模板名硬编码
  var fmt = getImageFormat(provider.requestFormat || provider.template);
  var reqBody = fmt.buildBody(provider, {
    model: model,
    prompt: prompt,
    refDataUrls: refDataUrls,
    sizeConfig: sizeConfig,
    n: n,
    negativePrompt: negativePrompt,
    promptExtend: promptExtend,
    watermark: watermark,
    quality: quality
  });

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

  // v99: 生图专用超时（默认 600s），聊天 nativeTimeoutMs 不再影响生图
  // 注：app 切后台时 Android WebView 会暂停 JS，fetch 挂起但不会报错，切回前台后继续等待
  var timeoutMs = resolveImageTimeout(settings);
  state._imageGenerating = true;  // 标记请求进行中，供 appStateChange 监听用
  state._imageStopRequested = false;  // v99: 区分「用户停止」与「真超时」
  // v99: 进度反馈（loading 文本每秒更新）
  state._imageProgress = { phase: 'connecting', elapsed: 0, retry: null, done: 0, total: n };
  var progressTimer = setInterval(updateImageProgress, 1000);
  try {
    var controller = new AbortController();
    state._imageAbortController = controller;  // v66: 暴露给停止按钮
    var resp = await fetchWithImageRetry({
      url: req.url,
      headers: req.headers,
      payload: req.payload,
      timeoutMs: timeoutMs,
      maxTotalMs: 900000,  // v100: 总时长预算 15 分钟（含重试），防慢接口无限循环
      signal: controller.signal,
      onRetry: function(info) {
        state._imageProgress.phase = 'retry';
        state._imageProgress.retry = info;
        showToast('网络/服务异常，' + Math.max(1, Math.round(info.waitMs / 1000)) + 's 后自动重试（' + info.attempt + '/' + info.max + '）', 'info');
      }
    });
    state._imageProgress.phase = 'parsing';
    var data = await resp.json();
    // 移除加载占位
    var loadingEl = document.getElementById('image-loading-msg');
    if (loadingEl) loadingEl.remove();
    // 解析响应：按格式注册表分发（responseFormat → parseResponse），统一归一化为 results = [{b64_json|url|revised_prompt}]
    var fmtResp = getImageFormat(provider.requestFormat || provider.template);
    var results = fmtResp.parseResponse(data) || [];
    if (results.length === 0) throw new Error('响应中无图片数据');
    // v99: 多图计数——实际成功数 + 外链回退数（修复「虚报 N 张」黑箱 bug）
    var savedCount = 0;
    var fallbackCount = 0;
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      var dataUrl = '';
      if (item.b64_json) {
        var mime = (item.mime || item.media_type || 'image/png').toLowerCase();  // v107: 兼容 OpenRouter media_type
        dataUrl = 'data:' + mime + ';base64,' + item.b64_json;
      } else if (item.url) {
        // v99: 下载 URL 转 base64（30s 超时 + 20MB 上限）；失败回退外链并计数提示
        state._imageProgress.phase = 'download';
        state._imageProgress.done = i;
        state._imageProgress.total = results.length;
        dataUrl = await fetchImageAsDataUrl(item.url);
        if (!dataUrl) { fallbackCount++; dataUrl = item.url; }
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
      savedCount++;
    }
    // v99: 成功后熔断清零
    clearFailStreak(state._imageProviderFailStreak, provider.id);
    saveImageProviders();
    renderImageStream();
    updateImageGalleryCount();
    if (indicator) indicator.className = 'image-status-indicator ok';
    var doneMsg = '生成完成，共 ' + savedCount + ' 张' + (fallbackCount > 0 ? '（其中 ' + fallbackCount + ' 张为外链，可能过期）' : '');
    showToast(doneMsg, 'success');
    // v70: 无论前后台都发系统通知（前台 toast + 通知栏，后台仅通知栏）
    notifyImageComplete(savedCount);
  } catch(e) {
    var loadingEl2 = document.getElementById('image-loading-msg');
    if (loadingEl2) loadingEl2.remove();
    if (indicator) indicator.className = 'image-status-indicator err';
    // v99: 错误分类 + 停止/超时区分 + 熔断
    var imgErr = e.imageError || classifyImageError(null, '', e);
    var errMsg;
    if (e.name === 'AbortError') {
      errMsg = state._imageStopRequested ? '已停止生成' : (imgErr.hint || ('请求超时（' + Math.round(timeoutMs / 1000) + 's）'));
    } else {
      errMsg = imgErr.hint || (e.message || '生成失败');
      if (imgErr.attempts > 1) errMsg += '（已自动重试 ' + (imgErr.attempts - 1) + ' 次）';
    }
    if (state._imageProviderFailStreak) {
      var bs = bumpFailStreak(state._imageProviderFailStreak, provider.id, 3);
      if (bs.tripped) errMsg += ' ——该接口连续失败 ' + bs.count + ' 次，建议检查接口配置';
    }
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
    clearInterval(progressTimer);
    state._imageProgress = null;  // v99: 清理进度状态
    if (sendBtn) { sendBtn.disabled = false; sendBtn.classList.remove('stopping'); sendBtn.title = ''; }
    state._imageAbortController = null;  // v66: 清理引用
    state._imageGenerating = false;  // 清除请求进行中标记
    state._imageStopRequested = false;  // v99: 复位停止标记
  }
}

// ===== v99: 连接可信度加固核心 =====
// 错误分类：将任何失败归一化为 {type, retryable, hint}
// type: network | timeout | url-invalid | auth | quota | content-policy
//       | rate-limit | server | client | non-json | unknown
function classifyImageError(status, bodyText, err) {
  var text = String(bodyText || '') + ' ' + String((err && err.message) || '');
  var low = text.toLowerCase();
  if (status === null || status === undefined) {
    if (err && err.name === 'AbortError') {
      return { type: 'timeout', retryable: false, hint: '' };  // 由调用方区分「用户停止」与「真超时」
    }
    if (err && err.name === 'TypeError') {
      if (/construct|invalid url|\burl\b/.test(low)) {
        return { type: 'url-invalid', retryable: false, hint: 'API 地址格式错误，请检查是否以 http:// 或 https:// 开头' };
      }
      return { type: 'network', retryable: true, hint: '网络连接失败，已自动重试' };
    }
    return { type: 'network', retryable: true, hint: '网络连接失败，已自动重试' };
  }
  if (status === 401) {
    return { type: 'auth', retryable: false, hint: 'API 密钥无效（401），请检查该生图接口的密钥是否正确' };
  }
  if (status === 403) {
    if (/quota|insufficient|billing|credit|balance/i.test(low)) {
      return { type: 'quota', retryable: false, hint: '账户配额不足或欠费（403），请到对应平台充值或检查用量' };
    }
    return { type: 'auth', retryable: false, hint: '请求被拒绝（403），检查密钥权限或账户状态' };
  }
  if (status === 400) {
    if (/content_policy|moderation|refus|nsfw|violat|policy/i.test(low)) {
      return { type: 'content-policy', retryable: false, hint: '提示词被内容策略拒绝（400），请调整措辞后重试' };
    }
    return { type: 'client', retryable: false, hint: '请求参数有误（400）：' + (bodyText ? bodyText.slice(0, 120) : '检查提示词/尺寸/模型名') };
  }
  if (status === 404) {
    return { type: 'url-invalid', retryable: false, hint: '地址或端点错误（404）——检查 API 地址与 Endpoint 路径，以及 baseUrl 是否带版本路径（如 /api/v1）' };
  }
  if (status === 429) {
    if (/image_generation_user_error|content_policy|moderation|refus/i.test(low)) {
      return { type: 'content-policy', retryable: false, hint: '提示词被内容策略拒绝（429），请调整措辞后重试' };
    }
    return { type: 'rate-limit', retryable: true, hint: '接口限流（429），等待后自动重试' };
  }
  if (status >= 500 && status < 600) {
    return { type: 'server', retryable: true, hint: '服务端暂时异常（' + status + '），自动重试中' };
  }
  if (status >= 400 && status < 500) {
    return { type: 'client', retryable: false, hint: '请求被拒绝（' + status + '）：' + (bodyText ? bodyText.slice(0, 120) : '检查接口配置') };
  }
  return { type: 'unknown', retryable: false, hint: '未知响应（' + status + '）：' + (bodyText ? bodyText.slice(0, 120) : '') };
}

// 解析限流头：x-ratelimit-remaining-requests / x-ratelimit-reset-requests / retry-after
function readRateLimitHeaders(headers) {
  try {
    var remaining = headers.get('x-ratelimit-remaining-requests') || headers.get('x-ratelimit-remaining-tokens');
    var resetStr = headers.get('x-ratelimit-reset-requests');
    var retryAfter = headers.get('retry-after');
    var resetMs = 0;
    if (resetStr) {
      var m = resetStr.match(/(?:(\d+)m)?(\d+)s/);
      if (m) resetMs = (parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10)) * 1000;
    } else if (retryAfter) {
      var ra = parseInt(retryAfter, 10);
      if (!isNaN(ra) && ra >= 0) resetMs = ra * 1000;
    }
    var hasRemaining = remaining !== null && remaining !== undefined;
    if (!hasRemaining && resetMs === 0) return null;
    return { remaining: hasRemaining ? parseInt(remaining, 10) : null, resetMs: resetMs };
  } catch(e) {
    return null;
  }
}

// 可中断等待（重试退避用；abort 时抛 AbortError）
function sleepWithAbort(ms, signal) {
  return new Promise(function(resolve, reject) {
    if (signal && signal.aborted) {
      var ae = new Error('aborted');
      ae.name = 'AbortError';
      reject(ae);
      return;
    }
    var timer = setTimeout(function() {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      var ae = new Error('aborted');
      ae.name = 'AbortError';
      reject(ae);
    }
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

// 带重试的请求封装（v99 核心）：仅 network / rate-limit(429) / server(5xx) 自动重试，
// 429 尊重 Retry-After，退避 2s/4s + jitter，重试等待可被 signal（停止按钮）打断；
// 超时（单次超 timeoutMs）不重试；非 JSON 响应抛 non-json 分类；错误统一带 .imageError
function fetchWithImageRetry(opts) {
  var url = opts.url, headers = opts.headers || {}, payload = opts.payload;
  var timeoutMs = opts.timeoutMs || 600000;
  var signal = opts.signal || null;
  var maxRetries = (opts.maxRetries === undefined) ? 2 : opts.maxRetries;
  var onRetry = opts.onRetry || null;
  var maxTotalWaitMs = 60000;
  var totalWaitMs = 0;
  var lastErr = null;
  // v100: 总时长预算（整个生成流程含重试；默认 15 分钟，超过强制停止防无限重试循环）
  var maxTotalMs = opts.maxTotalMs || 900000;
  var startTime = Date.now();

  async function attemptOnce(attempt) {
    var timeoutFired = false;
    var externalAborted = false;
    if (signal && signal.aborted) externalAborted = true;
    var controller = new AbortController();
    var timer = setTimeout(function() { timeoutFired = true; controller.abort(); }, timeoutMs);
    if (signal && !signal.aborted) {
      signal.addEventListener('abort', function() { externalAborted = true; controller.abort(); });
    }
    var resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: (payload instanceof FormData) ? payload : JSON.stringify(payload),
        signal: controller.signal
      });
    } catch(e) {
      if (externalAborted) {
        var ue = new Error('已停止生成');
        ue.name = 'AbortError';
        throw ue;
      }
      if (timeoutFired) {
        var te = new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）');
        te.name = 'AbortError';
        te.imageError = { type: 'timeout', retryable: false, hint: '服务端响应超时——生成过慢或网络不稳，可稍后手动重试', status: null, attempts: attempt + 1 };
        throw te;
      }
      var ce = classifyImageError(null, '', e);
      ce.status = null; ce.attempts = attempt + 1;
      var ne = new Error(ce.hint || '网络错误');
      ne.name = 'NetworkError';
      ne.imageError = ce;
      throw ne;
    } finally {
      clearTimeout(timer);
    }
    var bodyText = '';
    try { bodyText = await resp.text(); } catch(e) { bodyText = ''; }
    if (!resp.ok) {
      var cls = classifyImageError(resp.status, bodyText, null);
      cls.status = resp.status;
      cls.attempts = attempt + 1;
      if (cls.type === 'rate-limit') {
        var rl = readRateLimitHeaders(resp.headers);
        if (rl && rl.resetMs > 0) cls.retryAfterMs = rl.resetMs;
      }
      var he = new Error(cls.hint || ('HTTP ' + resp.status));
      he.status = resp.status;
      he.imageError = cls;
      throw he;
    }
    var ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') === -1 && ct.indexOf('text/json') === -1 && ct.indexOf('+json') === -1) {
      var htmlHint = bodyText ? bodyText.slice(0, 100).replace(/\s+/g, ' ') : '';
      var nj = new Error('接口返回了非 JSON 内容（' + (ct.split(';')[0] || '未知') + '）——通常是地址/端点拼错或服务拦截页。检查 baseUrl 是否带版本路径（如 /api/v1 应整体填入 API 地址栏）。' + (htmlHint ? '响应开头：' + htmlHint : ''));
      nj.imageError = { type: 'non-json', retryable: false, hint: nj.message, status: resp.status, attempts: attempt + 1 };
      throw nj;
    }
    return new Response(bodyText, { status: resp.status, headers: resp.headers });
  }

  async function run() {
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      // v100: 总时长预算——整个生成流程（含所有重试与请求耗时）超过预算即强制停止，
      // 修复「慢接口连接中断 → 重试 → 新请求重新计时」导致的无限循环（kkaiapi 图生图 20 分钟无果实锤）
      if (Date.now() - startTime > maxTotalMs) {
        var be = new Error('生成总耗时超过预算（' + Math.round(maxTotalMs / 60000) + ' 分钟）');
        be.imageError = { type: 'timeout', retryable: false, hint: '生成总耗时超过预算（' + Math.round(maxTotalMs / 60000) + ' 分钟）——服务端响应过慢或接口不稳定，请检查接口或稍后重试', status: null, attempts: attempt + 1 };
        throw be;
      }
      try {
        return await attemptOnce(attempt);
      } catch(e) {
        lastErr = e;
        if (e.name === 'AbortError') throw e;
        var cls = (e.imageError || {});
        if (!cls.retryable || attempt >= maxRetries) throw e;
        var waitMs = cls.retryAfterMs || (Math.min(2000 * Math.pow(2, attempt), 10000) + Math.floor(Math.random() * 500));
        if (totalWaitMs + waitMs > maxTotalWaitMs) throw e;
        // v100: 剩余预算不足时不再等待（提前截停，避免重试等待拉长总耗时）
        if (waitMs > (maxTotalMs - (Date.now() - startTime))) {
          var be2 = new Error('生成总耗时超过预算（' + Math.round(maxTotalMs / 60000) + ' 分钟）');
          be2.imageError = { type: 'timeout', retryable: false, hint: '生成总耗时超过预算（' + Math.round(maxTotalMs / 60000) + ' 分钟）——服务端响应过慢或接口不稳定，请检查接口或稍后重试', status: null, attempts: attempt + 1 };
          throw be2;
        }
        totalWaitMs += waitMs;
        if (onRetry) onRetry({ type: cls.type, attempt: attempt + 1, max: maxRetries, waitMs: waitMs, status: cls.status });
        await sleepWithAbort(waitMs, signal);
      }
    }
    throw lastErr;
  }
  return run();
}

// v99: 生图专用超时（默认 600s，范围 60s~1h）；聊天 nativeTimeoutMs 不再影响生图
function resolveImageTimeout(settings) {
  var v = parseInt(settings.imageNativeTimeoutMs, 10);
  if (!isNaN(v) && v >= 60000 && v <= 3600000) return v;
  return 600000;
}

// ===== v101: 生图体验优化（思路取经 SillyTavern stable-diffusion 扩展，代码自行实现）=====
// prompt 前缀体系：全局前缀 + 消息模板 {prompt} 占位合并（酒馆 combinePrefixes 同款思路）
function combineImagePrefixes(prefix, prompt, template) {
  var tpl = (template === undefined || template === null || template === '') ? '{prompt}' : template;
  var core = tpl.indexOf('{prompt}') >= 0 ? tpl.replace(/\{prompt\}/g, prompt) : prompt;
  var parts = [];
  if (prefix && prefix.trim()) parts.push(prefix.trim());
  if (core && core.trim()) parts.push(core.trim());
  return parts.join(', ');
}

// 模型特定提示词截断（酒馆 generateOpenAiImage 同款：dall-e-2 1000 / dalle-3 4000 / gpt-image 32000 字符）
function adaptPromptForModel(model, prompt) {
  var m = String(model || '').toLowerCase();
  var limit = 0;
  if (m.indexOf('dall-e-2') >= 0) limit = 1000;
  else if (m.indexOf('dall-e-3') >= 0) limit = 4000;
  else if (m.indexOf('gpt-image') >= 0) limit = 32000;
  return (limit > 0 && prompt.length > limit) ? prompt.slice(0, limit) : prompt;
}

// 模型特定尺寸上限（酒馆同款：dall-e-3 最大 1792、gpt-image 最大 1536，超出等比收窄）
function adaptSizeForModel(fmt, model, sizeConfig) {
  if (fmt !== 'gpt_image') return sizeConfig;
  var m = String(model || '').toLowerCase();
  var cfg = sizeConfig || { size: 'auto', imageConfig: null };
  var size = cfg.size;
  if (!size || size === 'auto') return cfg;
  var mm = size.match(/^(\d+)x(\d+)$/i);
  if (!mm) return cfg;
  var w = parseInt(mm[1], 10), h = parseInt(mm[2], 10);
  var cap = 0;
  if (m.indexOf('dall-e-3') >= 0) cap = 1792;
  else if (m.indexOf('gpt-image') >= 0) cap = 1536;
  if (!cap) return cfg;
  if (w > cap) { h = Math.round(h * cap / w); w = cap; }
  if (h > cap) { w = Math.round(w * cap / h); h = cap; }
  return { size: w + 'x' + h, imageConfig: cfg.imageConfig };
}

// 模型下拉建议：当前接口默认模型 + 图库历史模型（去重，最多 20）
function getImageModelSuggestions(provider, images) {
  var seen = {};
  var list = [];
  function add(m) { if (m && typeof m === 'string' && !seen[m]) { seen[m] = 1; list.push(m); } }
  if (provider && provider.defaultModel) add(provider.defaultModel);
  var imgs = images || [];
  for (var i = imgs.length - 1; i >= 0 && list.length < 20; i--) {
    add(imgs[i].model);
  }
  return list;
}

// 刷新模型下拉建议（datalist）
function refreshImageModelSuggestions() {
  var dl = document.getElementById('image-model-suggestions');
  if (!dl) return;
  var provider = getCurrentImageProvider();
  var list = getImageModelSuggestions(provider, settings.images || []);
  dl.innerHTML = list.map(function(m) { return '<option value="' + escapeHtml(m) + '">'; }).join('');
}

// 生图设置输入绑定（前缀/模板等纯字符串设置项）
function bindImageSettingInput(id, key) {
  var el = document.getElementById(id);
  if (!el) return;
  el.value = settings[key] || '';
  el.addEventListener('change', function() {
    settings[key] = el.value.trim();
    saveImageProviders();
  });
}

// v99: 熔断计数（连续失败 ≥3 提示检查配置）
function bumpFailStreak(streak, providerId, threshold) {
  var n = (streak[providerId] || 0) + 1;
  streak[providerId] = n;
  return { count: n, tripped: n >= threshold };
}
function clearFailStreak(streak, providerId) {
  streak[providerId] = 0;
}

// v99: 进度反馈（loading 文本每秒更新：阶段 + 已等待秒数）
function updateImageProgress() {
  var p = state._imageProgress;
  if (!p) return;
  p.elapsed++;
  var el = document.getElementById('image-loading-msg');
  var textEl = el ? el.querySelector('.loading-text') : null;
  if (!textEl) return;
  var label = '生成中';
  var detail = '';
  if (p.phase === 'retry' && p.retry) {
    label = '网络异常';
    detail = ' ' + Math.max(1, Math.round(p.retry.waitMs / 1000)) + 's 后自动重试（' + p.retry.attempt + '/' + p.retry.max + '）';
  } else if (p.phase === 'download') {
    label = '下载图片';
    detail = ' ' + p.done + '/' + p.total;
  }
  var min = Math.floor(p.elapsed / 60);
  var sec = p.elapsed % 60;
  textEl.textContent = label + detail + '（已等待 ' + min + ' 分 ' + sec + ' 秒）';
}

// v99: 测试连接——用表单当前值（未保存）发最小请求验证 baseUrl/端点/鉴权
async function testImageProviderConnection() {
  var btn = document.getElementById('btn-test-image-provider');
  var resultEl = document.getElementById('image-provider-test-result');
  if (!btn || !resultEl) return;
  var urlInput = document.getElementById('img-provider-url-input');
  if (!urlInput || !urlInput.value.trim()) {
    resultEl.className = 'image-provider-test-result err';
    resultEl.textContent = '请先填写 API 地址';
    return;
  }
  btn.disabled = true;
  resultEl.className = 'image-provider-test-result';
  resultEl.textContent = '测试中（将发送 1 张最小生成请求）...';
  try {
    var nameInput = document.getElementById('img-provider-name-input');
    var endpointInput = document.getElementById('img-provider-endpoint-input');
    var keyInput = document.getElementById('img-provider-key-input');
    var formatSel = document.getElementById('img-provider-format-select');
    var authSel = document.getElementById('img-provider-auth-select');
    var presetSel = document.getElementById('img-provider-preset-select');
    var modelInput = document.getElementById('img-provider-default-model-input');
    var preset = IMAGE_PROVIDER_PRESETS[presetSel ? presetSel.value : 'custom'] || {};
    var formatName = (formatSel && formatSel.value) || preset.format || 'flat';
    var tmpProvider = {
      id: 'test-' + Date.now(),
      name: (nameInput && nameInput.value.trim()) || '测试',
      template: formatName,
      baseUrl: urlInput.value.trim(),
      endpointPath: endpointInput ? endpointInput.value.trim() : '',
      apiKey: keyInput ? keyInput.value.trim() : '',
      authType: (authSel && authSel.value) ? authSel.value : undefined,
      defaultModel: (modelInput && modelInput.value.trim()) || preset.defaultModel || 'gpt-image-2'
    };
    var norm = normalizeImageProvider(tmpProvider);
    var fmt = getImageFormat(norm.requestFormat || norm.template);
    var reqBody = fmt.buildBody(norm, {
      model: norm.defaultModel, prompt: 'test', refDataUrls: [],
      sizeConfig: { size: 'auto', imageConfig: null },
      n: 1, negativePrompt: '', promptExtend: false, watermark: false, quality: 'auto'
    });
    var req = buildImageRequestPayload(norm, reqBody);
    var controller = new AbortController();
    var resp = await fetchWithImageRetry({
      url: req.url, headers: req.headers, payload: req.payload,
      isFormData: false, timeoutMs: 10000, signal: controller.signal, maxRetries: 0
    });
    var data = await resp.json();
    var results = fmt.parseResponse(data) || [];
    resultEl.className = 'image-provider-test-result ok';
    resultEl.textContent = '连接成功 ✓（端点响应正常，' + (results.length > 0 ? '返回 ' + results.length + ' 张图片数据' : '请求已受理') + '）';
  } catch(e) {
    var cls = e.imageError || classifyImageError(null, '', e);
    resultEl.className = 'image-provider-test-result err';
    resultEl.textContent = '连接失败：' + (cls.hint || e.message || '未知错误');
  } finally {
    btn.disabled = false;
  }
}

// F1: 把图片 URL 下载为 data URL（避免外链失效）
// v99: 加 30s 超时 + 20MB 大小上限；失败返回 null（由调用方回退外链并计数提示）
async function fetchImageAsDataUrl(url) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 30000);
  try {
    var resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var blob = await resp.blob();
    if (blob.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB 上限');
    return await new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { reject(new Error('FileReader 失败')); };
      reader.readAsDataURL(blob);
    });
  } catch(e) {
    console.warn('fetchImageAsDataUrl failed, fallback to url:', e);
    return null;
  } finally {
    clearTimeout(timer);
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
    refreshImageModelSuggestions();  // v101: 切接口后刷新模型建议
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
      state._imageStopRequested = true;  // v99: 标记用户主动停止（区分超时）
      state._imageAbortController.abort();
      showToast('已停止生成', 'info');
    } else {
      generateImage();
    }
  });

  // v99: 测试连接按钮
  var testBtn = document.getElementById('btn-test-image-provider');
  if (testBtn) testBtn.addEventListener('click', testImageProviderConnection);

  // v101: 模型下拉建议（datalist）+ 生图设置输入绑定
  refreshImageModelSuggestions();
  bindImageSettingInput('image-prompt-prefix-input', 'imagePromptPrefix');
  bindImageSettingInput('image-negative-prefix-input', 'imageNegativePrefix');
  bindImageSettingInput('image-prompt-template-input', 'imagePromptTemplate');

  // v99: 生图超时设置（秒 → 内部 ms）
  var timeoutInput = document.getElementById('image-timeout-input');
  if (timeoutInput) {
    timeoutInput.value = String(Math.round((settings.imageNativeTimeoutMs || 600000) / 1000));
    timeoutInput.addEventListener('change', function() {
      var v = parseInt(timeoutInput.value, 10);
      if (!isNaN(v) && v >= 60 && v <= 3600) {
        settings.imageNativeTimeoutMs = v * 1000;
        saveImageProviders();
        showToast('生图超时已设为 ' + v + ' 秒', 'success');
      } else {
        timeoutInput.value = String(Math.round((settings.imageNativeTimeoutMs || 600000) / 1000));
        showToast('超时需在 60-3600 秒之间', 'warn');
      }
    });
  }

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
  // 提供方预设切换：自动填充格式/地址/默认模型（仅空值填充，编辑已有时不覆盖）
  var imgProvPresetSel = document.getElementById('img-provider-preset-select');
  if (imgProvPresetSel) imgProvPresetSel.addEventListener('change', onImageProviderPresetChange);
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