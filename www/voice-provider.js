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
    // v3.0.2：编辑框会被塞进列表项里（与会话「接口管理」一致），所以重建列表前
    //   必须先把它挪到容器外面 —— 否则 innerHTML 一刷，里面那个编辑框就被销毁了。
    //   providers.js 是同一套处理（它踩过这个坑，注释写着 "A4"）。
    var ed0 = $('voice-provider-editor');
    if (ed0 && box.contains(ed0)) box.parentNode.insertBefore(ed0, box.nextSibling);
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
    // v3.0.2：不再因为"使用中"就默认展开 —— 同一个设置面板里，「接口管理」的列表是全部折叠的，
    //   语音这边却把当前项摊开，两块看起来像两套东西。当前项靠 badge + 边框就够认了。
    arr.forEach(function (p, idx) {
      var on = p.id === curId;
      var keyOk = !!String(p.apiKey || '').trim();
      var urlOk = !!String(p.baseUrl || '').trim();
      var badge = (!keyOk || !urlOk)
        ? '<span class="provider-badge provider-badge-warn">未填完</span>'
        : (on ? '<span class="provider-badge provider-badge-on">使用中</span>' : '');
      html += '<details class="provider-group" data-idx="' + idx + '">' +
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
    // 每次打开编辑框都清掉上一次的测试结果，避免"上一次通过"被当成这次的
    var tr = $('voice-provider-test-result');
    if (tr) { tr.textContent = ''; tr.className = 'provider-test-result'; }
    var tb = $('btn-test-voice-provider');
    if (tb) tb.disabled = false;
    ed.style.display = '';
    // v3.0.2：把编辑框放进被点的那一项里，并展开它 —— 会话「接口管理」就是这个行为
    //   （点哪一项的编辑，框就出现在哪一项下面）。以前语音是固定放在列表下方，
    //   接口一多就得往下找，两块面板的手感完全不一样。
    var box = $('voice-provider-list');
    if (box) {
      var group = (editingIdx >= 0)
        ? box.querySelector('.provider-group[data-idx="' + editingIdx + '"]')
        : null;
      if (group) { group.appendChild(ed); group.open = true; }
      else if (ed.parentNode !== box.parentNode) box.parentNode.insertBefore(ed, box.nextSibling);
    }
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

  // ---------------------------------------------------------------- 测试连接
  // v3.0.2：与会话「接口管理」的「测试连接」同一位置、同一套结果样式。
  //   差别只在探测深度：会话测 /models 一次 HTTP 就够；语音必须真的发一次识别 + 一次合成，
  //   再做一次往返（TTS 合成 → 回灌 ASR），因为"密钥对、模型名写错"只有往返能发现。
  function testProvider() {
    var res = $('voice-provider-test-result');
    if (!res) return;
    var curKey = ($('vp-api-key') && $('vp-api-key').value || '').trim();
    var curUrl = ($('vp-base-url') && $('vp-base-url').value || '').trim();
    if (!curUrl || !curKey) {
      res.textContent = '请填写接口地址和密钥';
      res.className = 'provider-test-result error';
      return;
    }
    // 自检读的是**已保存**的配置（voiceCfg），不是编辑框里的草稿。
    //   不点破的话，"改完 key → 测试通过 → 保存"会让人以为新 key 已验证，实际测的是旧的。
    var p = editingIdx >= 0 ? list()[editingIdx] : null;
    var savedKey = p ? String(p.apiKey || '').trim() : '';
    var savedUrl = p ? String(p.baseUrl || '').trim() : '';
    if (editingIdx < 0 || savedKey !== curKey || savedUrl !== curUrl) {
      res.textContent = '请先保存，再测试（测试用的是已保存的配置）';
      res.className = 'provider-test-result warn';
      return;
    }
    var VC = root.VoiceCall;
    if (!VC || typeof VC.__testChain !== 'function') {
      res.textContent = '当前版本不支持自检';
      res.className = 'provider-test-result error';
      return;
    }
    var btn = $('btn-test-voice-provider');
    if (btn) btn.disabled = true;
    res.textContent = '测试中…（识别 + 合成 + 往返，约 2~6 秒）';
    res.className = 'provider-test-result';

    // 自检是多级的（识别 → 合成 → 往返），只显示最后一句"链路不可用"等于把原因丢了。
    //   这里逐行累积：过程中滚动显示当前步骤，结束后把「结论 + 第一处失败原因」一起留下。
    var lines = [];
    function finish(ok, msg) {
      if (btn) btn.disabled = false;
      if (msg) { res.textContent = msg; res.className = 'provider-test-result error'; return; }
      // 不直接搬 testChain 的结论行 —— 那句是给通话界面写的（"按上面提示"，那边逐行显示）。
      //   这里是单行结果区，自己拼一句自洽的。
      var bad = '';
      for (var i = 0; i < lines.length; i++) {
        if (/不可达|未通过|跳过|失败/.test(lines[i])) { bad = lines[i]; break; }
      }
      if (ok) {
        var rp = lines.join(' ');
        res.textContent = '链路可用' + (rp.indexOf('往返验证：通过') >= 0 ? '（含往返验证）' : '') +
          (rp.indexOf('往返验证：未通过') >= 0 ? '；但往返验证未通过（可能模型/格式不匹配）' : '');
        res.className = 'provider-test-result success';
        return;
      }
      res.textContent = '链路不可用' + (bad ? '　·　' + bad : '');
      res.className = 'provider-test-result error';
    }

    try {
      var pr = VC.__testChain(function (line) {
        var s = String(line || '');
        if (s) lines.push(s);
        res.textContent = s;      // 过程中逐行滚动
      });
      if (pr && typeof pr.then === 'function') {
        pr.then(function (ok) { finish(!!ok); }, function (e) {
          finish(false, '测试失败：' + ((e && e.message) || e));
        });
      } else {
        finish(false, '自检没有返回结果');
      }
    } catch (e) {
      finish(false, '测试失败：' + ((e && e.message) || e));
    }
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
    var testBtn = $('btn-test-voice-provider');
    if (testBtn) testBtn.addEventListener('click', testProvider);

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
