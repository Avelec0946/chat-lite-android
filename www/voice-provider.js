// ===== voice-provider.js : 语音接口管理（v127）=====
// 职责：语音识别 / 合成用的接口（地址 + 密钥 + 模型），与「接口管理」里的聊天渠道**完全分开**。
//
// 为什么必须独立（这是用户实测 401 的根因）：
//   v125/v126 的语音复用「接口管理」里的聊天渠道。聊天渠道的 baseUrl 指向文本网关，
//   比如 MiMo Token Plan 是 https://token-plan-cn.xiaomimimo.com —— 那个网关只认
//   tp- 开头的 Token Plan 密钥。拿它去发语音请求，上游回
//   「HTTP 401: Invalid API Key」，而界面上看不出任何配置问题。
//   语音要的是 asr / tts 专用模型，地址和密钥本来就是另一套。
//
// 设计参照 image-gen.js 的生图接口管理（同一套交互：列表 + 编辑框 + 当前使用）。
//
// 依赖：db.js（normalizeVoiceProviders / saveSettings）、app.js（showToast / $）
// 加载顺序：db.js 之后、voice.js 之前

(function (root) {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function S() { return (typeof settings === 'object' && settings) ? settings : null; }
  function v() {
    var s = S();
    if (!s) return {};
    if (!s.voice || typeof s.voice !== 'object') {
      try {
        s.voice = (typeof defaultVoiceSettings === 'function') ? defaultVoiceSettings() : {};
      } catch (e) { s.voice = {}; }
    }
    return s.voice;
  }
  function toast(msg, type) {
    try { if (typeof showToast === 'function') showToast(msg, type || 'info'); } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 服务商预设。只放"确定能用"的地址；用户想填别的就选手动。
  //   MiMo 官方：/v1/chat/completions 同时承载 asr / tts / 声音设计 / 声音克隆。
  //   注意**不要**预设 token-plan-cn.xiaomimimo.com —— 那个网关只认 tp- 密钥，
  //   拿来配语音必然 401，正是用户踩过的坑。
  var PRESETS = {
    mimo: {
      name: 'MiMo 官方',
      baseUrl: 'https://api.xiaomimimo.com',
      endpointPath: '/v1/chat/completions',
      asrModel: 'mimo-v2.5-asr',
      ttsModel: 'mimo-v2.5-tts',
      models: ['mimo-v2.5-asr', 'mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone']
    }
  };

  function list() {
    var cfg = v();
    if (!Array.isArray(cfg.voiceProviders)) cfg.voiceProviders = [];
    return cfg.voiceProviders;
  }

  function persist() {
    try {
      if (typeof saveSettings === 'function') saveSettings();
    } catch (e) { console.warn('[voice-provider] saveSettings failed', e); }
  }

  function findById(id) {
    var arr = list();
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }

  function current() {
    var cfg = v();
    var arr = list();
    if (!arr.length) return null;
    var id = String(cfg.voiceProviderId || '');
    if (id) {
      var hit = findById(id);
      if (hit) return hit;
    }
    return arr[0];
  }

  // ---------------------------------------------------------------- 列表渲染
  function renderList() {
    var box = $('voice-provider-list');
    if (!box) return;
    var arr = list();
    var cfg = v();
    var curId = cfg.voiceProviderId || (arr[0] && arr[0].id) || '';

    if (!arr.length) {
      box.innerHTML = '<div class="provider-empty">还没有语音接口。点上面的「+ 添加语音接口」，选「MiMo 官方」预设，填上密钥就能用。</div>';
      renderPick();
      return;
    }

    // 复用项目既有的 provider-group / provider-summary / provider-detail 设计语言
    //   （生图接口、聊天接口都是这一套）。不另起一套 vp-* 样式，避免「同一件事三种长相」。
    var html = '';
    arr.forEach(function (p, idx) {
      var on = p.id === curId;
      var keyOk = !!String(p.apiKey || '').trim();
      var urlOk = !!String(p.baseUrl || '').trim();
      var badge = (!keyOk || !urlOk)
        ? '<span class="provider-badge provider-badge-warn">未填完</span>'
        : (on ? '<span class="provider-badge provider-badge-on">使用中</span>' : '');
      html += '<details class="provider-group" data-idx="' + idx + '"' + (on ? ' open' : '') + '>' +
        '<summary class="provider-summary">' +
        '<span class="provider-name">' + esc(p.name || '语音接口') + badge + '</span>' +
        '<div class="provider-actions">' +
        (on ? '' : '<button type="button" class="btn btn-small vp-use" data-idx="' + idx + '">使用</button>') +
        '<button type="button" class="btn btn-small vp-edit" data-idx="' + idx + '">编辑</button>' +
        '<button type="button" class="btn btn-small vp-del" data-idx="' + idx + '" style="background:var(--bg3);color:var(--text)">删除</button>' +
        '</div></summary>' +
        '<div class="provider-detail">' +
        '<span class="provider-url">' + esc(p.baseUrl || '(未填地址)') + '</span>' +
        '<span class="provider-endpoint">' + esc(p.endpointPath || '/v1/chat/completions') + '</span>' +
        '<span class="provider-models">识别 ' + esc(p.asrModel || '-') + ' · 合成 ' + esc(p.ttsModel || '-') + '</span>' +
        '</div></details>';
    });
    box.innerHTML = html;
    renderPick();
  }

  // 「当前使用」下拉：接口多了才显示，避免只有一个时还要多看一眼
  function renderPick() {
    var row = $('voice-provider-pick-row');
    var sel = $('voice-provider-pick');
    if (!row || !sel) return;
    var arr = list();
    if (arr.length <= 1) { row.style.display = 'none'; return; }
    row.style.display = '';
    var curId = v().voiceProviderId || (arr[0] && arr[0].id) || '';
    sel.innerHTML = arr.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name || '语音接口') + '</option>';
    }).join('');
    sel.value = curId;
  }

  // ---------------------------------------------------------------- 编辑框
  var editingIdx = -1;

  function openEditor(idx) {
    var ed = $('voice-provider-editor');
    if (!ed) return;
    editingIdx = (typeof idx === 'number') ? idx : -1;
    var p = editingIdx >= 0 ? list()[editingIdx] : null;
    if ($('vp-name')) $('vp-name').value = p ? (p.name || '') : '';
    if ($('vp-preset')) $('vp-preset').value = '';
    if ($('vp-base-url')) $('vp-base-url').value = p ? (p.baseUrl || '') : '';
    if ($('vp-endpoint')) $('vp-endpoint').value = p ? (p.endpointPath || '') : '/v1/chat/completions';
    if ($('vp-api-key')) $('vp-api-key').value = p ? (p.apiKey || '') : '';
    if ($('vp-asr-model')) $('vp-asr-model').value = p ? (p.asrModel || '') : '';
    if ($('vp-tts-model')) $('vp-tts-model').value = p ? (p.ttsModel || '') : '';
    ed.style.display = '';
    try { ed.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  function closeEditor() {
    var ed = $('voice-provider-editor');
    if (ed) ed.style.display = 'none';
    editingIdx = -1;
  }

  function applyPreset(key) {
    var p = PRESETS[key];
    if (!p) return;
    if ($('vp-name') && !$('vp-name').value.trim()) $('vp-name').value = p.name;
    if ($('vp-base-url')) $('vp-base-url').value = p.baseUrl;
    if ($('vp-endpoint')) $('vp-endpoint').value = p.endpointPath;
    if ($('vp-asr-model')) $('vp-asr-model').value = p.asrModel;
    if ($('vp-tts-model')) $('vp-tts-model').value = p.ttsModel;
  }

  function saveEditor() {
    var name = ($('vp-name') && $('vp-name').value || '').trim() || '语音接口';
    var baseUrl = ($('vp-base-url') && $('vp-base-url').value || '').trim();
    var endpoint = ($('vp-endpoint') && $('vp-endpoint').value || '').trim() || '/v1/chat/completions';
    var apiKey = ($('vp-api-key') && $('vp-api-key').value || '').trim();
    var asrModel = ($('vp-asr-model') && $('vp-asr-model').value || '').trim();
    var ttsModel = ($('vp-tts-model') && $('vp-tts-model').value || '').trim();

    if (!baseUrl) { toast('请填接口地址，例如 https://api.xiaomimimo.com', 'warn'); return; }
    if (!/^https?:\/\//i.test(baseUrl)) { toast('接口地址要以 http:// 或 https:// 开头', 'warn'); return; }
    if (!apiKey) { toast('请填 API 密钥', 'warn'); return; }

    var arr = list();
    var raw = {
      name: name, baseUrl: baseUrl, endpointPath: endpoint, apiKey: apiKey,
      asrModel: asrModel, ttsModel: ttsModel,
      models: [asrModel, ttsModel].filter(Boolean).map(function (m) { return { id: m }; })
    };

    if (editingIdx >= 0 && arr[editingIdx]) {
      raw.id = arr[editingIdx].id;
      raw.createdAt = arr[editingIdx].createdAt;
      arr[editingIdx] = (typeof normalizeVoiceProviders === 'function')
        ? normalizeVoiceProviders([raw])[0] : raw;
    } else {
      var made = (typeof normalizeVoiceProviders === 'function')
        ? normalizeVoiceProviders([raw])[0] : raw;
      arr.push(made);
      if (!v().voiceProviderId) v().voiceProviderId = made.id;
    }
    // 第一个接口自动成为当前使用，省掉一次点击
    if (!v().voiceProviderId && arr.length) v().voiceProviderId = arr[0].id;

    persist();
    closeEditor();
    renderList();
    toast('语音接口已保存', 'success');
    try { if (root.VoiceCall && typeof root.VoiceCall.onConfigChanged === 'function') root.VoiceCall.onConfigChanged(); } catch (e) {}
  }

  function useProvider(idx) {
    var p = list()[idx];
    if (!p) return;
    v().voiceProviderId = p.id;
    // 顺手把模型同步过来：用户选了接口，多半就是要用它配的模型
    if (p.asrModel) v().asrModel = p.asrModel;
    if (p.ttsModel) v().ttsModel = p.ttsModel;
    persist();
    renderList();
    toast('已切换到「' + (p.name || '语音接口') + '」', 'success');
    try { if (root.VoiceCall && typeof root.VoiceCall.onConfigChanged === 'function') root.VoiceCall.onConfigChanged(); } catch (e) {}
  }

  function removeProvider(idx) {
    var arr = list();
    var p = arr[idx];
    if (!p) return;
    if (!confirm('确定删除语音接口「' + (p.name || '语音接口') + '」？')) return;
    var wasCurrent = v().voiceProviderId === p.id;
    arr.splice(idx, 1);
    if (wasCurrent) v().voiceProviderId = arr.length ? arr[0].id : '';
    persist();
    renderList();
    toast('已删除', 'info');
    try { if (root.VoiceCall && typeof root.VoiceCall.onConfigChanged === 'function') root.VoiceCall.onConfigChanged(); } catch (e) {}
  }

  // ---------------------------------------------------------------- 绑定
  function bind() {
    var addBtn = $('btn-add-voice-provider');
    if (addBtn) addBtn.addEventListener('click', function () { openEditor(-1); });

    var presetSel = $('vp-preset');
    if (presetSel) presetSel.addEventListener('change', function () { applyPreset(presetSel.value); });

    var saveBtn = $('btn-save-voice-provider');
    if (saveBtn) saveBtn.addEventListener('click', saveEditor);
    var cancelBtn = $('btn-cancel-voice-provider');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

    var box = $('voice-provider-list');
    if (box) {
      box.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        var idxAttr = t.getAttribute('data-idx');
        if (idxAttr === null) return;
        var idx = parseInt(idxAttr, 10);
        if (t.classList.contains('vp-use')) useProvider(idx);
        else if (t.classList.contains('vp-edit')) openEditor(idx);
        else if (t.classList.contains('vp-del')) removeProvider(idx);
      });
    }

    var pick = $('voice-provider-pick');
    if (pick) pick.addEventListener('change', function () {
      v().voiceProviderId = pick.value;
      persist();
      renderList();
      try { if (root.VoiceCall && typeof root.VoiceCall.onConfigChanged === 'function') root.VoiceCall.onConfigChanged(); } catch (e) {}
    });
  }

  // 老用户迁移：v125/v126 用的是聊天渠道（asrProviderId / ttsProviderId）。
  //   那个配置本身就是错的（地址/密钥都不对），不能直接搬过来 —— 搬过来还是 401。
  //   这里只在"从没配过语音接口"时提示一次，让用户知道要去配。
  function migrateHint() {
    var cfg = v();
    var arr = list();
    if (arr.length) return;
    var hadOld = !!(cfg.asrProviderId || cfg.ttsProviderId);
    if (!hadOld) return;
    try {
      if (cfg._voiceProviderMigrateHinted) return;
      cfg._voiceProviderMigrateHinted = true;
      persist();
    } catch (e) {}
    setTimeout(function () {
      toast('语音接口已改为独立配置：请添加一个语音接口（地址 + 密钥），以前复用聊天渠道的配置不再生效', 'warn');
    }, 1500);
  }

  function init() {
    try {
      bind();
      renderList();
      migrateHint();
    } catch (e) {
      console.warn('[voice-provider] init failed', e);
    }
  }

  var API = {
    init: init,
    renderList: renderList,
    openEditor: openEditor,
    closeEditor: closeEditor,
    current: current,
    PRESETS: PRESETS
  };
  root.VoiceProvider = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
