// ===== voice-settings.js : 语音通话设置面板绑定（v125）=====
// 职责：把 settings.voice 与设置面板「语音通话」分组的 DOM 双向绑定 + 保存 + 测试链路。
// 为什么独立成文件：voice.js 是运行时（采集/播放/请求），几千行；设置绑定是另一件事，
//   混在一起会让两边都难改。本文件只碰 DOM 与 settings，不碰音频与网络。
// 依赖：db.js（defaultVoiceSettings / saveSettings）、providers.js（state.providers / getProvider）、
//       app.js（showToast / $ / state / settings）
// 加载顺序：app.js 之后、voice.js 之前

(function (root) {
  'use strict';

  // MiMo 内置音色的展示信息。id 必须是上游认的那 9 个（写错上游会 400）。
  var VOICE_OPTIONS = [
    { id: 'Mia', label: 'Mia · 女声自然', desc: '通用、自然，适合日常闲聊' },
    { id: 'Chloe', label: 'Chloe · 女声温柔', desc: '偏软、偏暖，适合陪伴' },
    { id: '茉莉', label: '茉莉 · 女声清亮', desc: '中文女声，清亮' },
    { id: '冰糖', label: '冰糖 · 女声甜', desc: '中文女声，偏甜' },
    { id: '苏打', label: '苏打 · 中性', desc: '中性音色' },
    { id: '白桦', label: '白桦 · 男声沉稳', desc: '中文男声，沉稳' },
    { id: 'Milo', label: 'Milo · 男声明快', desc: '英文男声，明快' },
    { id: 'Dean', label: 'Dean · 男声低沉', desc: '英文男声，低沉' },
    { id: 'mimo_default', label: 'mimo_default · 默认', desc: '上游默认音色' }
  ];

  // 语音模型建议值（dat列表中给出，允许自由填写）
  var ASR_MODEL_SUGGESTIONS = ['mimo-v2.5-asr'];
  var TTS_MODEL_SUGGESTIONS = ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone'];

  // 人设列表从 voice-director 取（那边是真相来源），取不到时用兜底
  var FALLBACK_PERSONAS = [
    { id: 'warm', name: '温暖陪伴' },
    { id: 'bright', name: '元气伙伴' },
    { id: 'calm', name: '沉稳顾问' },
    { id: 'tease', name: '俏皮损友' }
  ];

  function $(id) { return document.getElementById(id); }
  function v() { return settings.voice || (settings.voice = defaultVoiceSettings()); }

  function getPersonas() {
    var PD = root.VoiceDirector;
    if (PD && Array.isArray(PD.PERSONAS) && PD.PERSONAS.length) return PD.PERSONAS;
    return FALLBACK_PERSONAS;
  }

  // 把 state.providers 填进渠道下拉。空选项 = 「内置直连 MiMo」，
  // 让没配过的用户也能开箱即用（走 settings.voice 里的默认地址）。
  function renderProviderSelect(sel, currentId, opts) {
    if (!sel) return;
    var list = (state.providers || []);
    var html = '';
    if (!opts || !opts.requireSelection) {
      html += '<option value="">内置直连（MiMo / DeepSeek 官方地址）</option>';
    }
    list.forEach(function (p) {
      html += '<option value="' + p.id + '">' + escapeHtml(p.name) +
        (p.models && p.models.length ? '（' + p.models.length + ' 个模型）' : '') + '</option>';
    });
    sel.innerHTML = html;
    sel.value = currentId || '';
    if (sel.value !== (currentId || '') && sel.options.length) sel.selectedIndex = 0;
  }

  function renderModelDatalist(dlId, models) {
    var dl = $(dlId);
    if (!dl) return;
    dl.innerHTML = (models || []).map(function (m) {
      return '<option value="' + escapeHtml(m) + '"></option>';
    }).join('');
  }

  function renderVoiceSelect() {
    var sel = $('voice-voice-id');
    if (!sel) return;
    var cur = v().voiceId || 'Mia';
    sel.innerHTML = VOICE_OPTIONS.map(function (o) {
      return '<option value="' + o.id + '">' + escapeHtml(o.label) + '</option>';
    }).join('');
    // 用户可能手填过不在列表里的音色 id（自定义部署），保留它
    if (!VOICE_OPTIONS.some(function (o) { return o.id === cur; })) {
      sel.innerHTML += '<option value="' + escapeHtml(cur) + '">' + escapeHtml(cur) + '（自定义）</option>';
    }
    sel.value = cur;
  }

  function renderPersonaSelect() {
    var sel = $('voice-persona');
    if (!sel) return;
    var list = getPersonas();
    var cur = v().personaId || 'warm';
    sel.innerHTML = list.map(function (p) {
      return '<option value="' + p.id + '">' + escapeHtml(p.name || p.id) + '</option>';
    }).join('');
    if (!list.some(function (p) { return p.id === cur; })) {
      sel.innerHTML += '<option value="' + escapeHtml(cur) + '">' + escapeHtml(cur) + '</option>';
    }
    sel.value = cur;
  }

  function currentVoiceLabel() {
    var st = v();
    if (st.cloneRefName) return '克隆音色';
    if (st.voiceDesign && st.voiceDesign.trim()) return '声音设计';
    if (/voicedesign/.test(st.ttsModel || '')) return '声音设计';
    if (/voiceclone/.test(st.ttsModel || '')) return '克隆音色';
    var o = VOICE_OPTIONS.filter(function (x) { return x.id === st.voiceId; })[0];
    return o ? o.label.split(' · ')[0] : (st.voiceId || 'Mia');
  }

  function syncCloneHint() {
    var el = $('voice-clone-hint');
    if (!el) return;
    var name = v().cloneRefName;
    el.textContent = name
      ? '已选参考音：' + name + '。合成时会临时切换到声音克隆模型。'
      : '参考音建议 5~20 秒清晰单人语音。留空则用上面的音色。';
  }

  function syncCustomPersonaRow() {
    var row = $('voice-custom-persona-row');
    var sel = $('voice-persona');
    if (!row) return;
    // 「自定义」人设才显示补充框；其余人设也允许补充（当作口味微调），保持可见更简单
    row.style.display = sel && sel.value === 'custom' ? '' : 'none';
  }

  // ===== 从 settings → DOM（打开设置面板、切换渠道、外部改动后调用）=====
  function syncVoiceSettingsUI() {
    var st = v();
    renderProviderSelect($('voice-asr-provider'), st.asrProviderId);
    renderProviderSelect($('voice-tts-provider'), st.ttsProviderId);
    renderProviderSelect($('voice-brain-provider'), st.brainProviderId, { requireSelection: false });
    if ($('voice-asr-model')) $('voice-asr-model').value = st.asrModel || '';
    if ($('voice-tts-model')) $('voice-tts-model').value = st.ttsModel || '';
    if ($('voice-brain-model')) $('voice-brain-model').value = st.brainModel || '';
    if ($('voice-design')) $('voice-design').value = st.voiceDesign || '';
    if ($('voice-custom-persona')) $('voice-custom-persona').value = st.customPersona || '';
    if ($('voice-barge-in')) $('voice-barge-in').checked = !!st.bargeIn;
    if ($('voice-show-transcript')) $('voice-show-transcript').checked = !!st.showTranscript;
    if ($('voice-show-signals')) $('voice-show-signals').checked = !!st.showSignals;
    if ($('voice-sensitivity')) $('voice-sensitivity').value = String(st.sensitivity);
    var sv = $('voice-sensitivity-value');
    if (sv) sv.textContent = Number(st.sensitivity).toFixed(2);
    if ($('voice-endpoint-ms')) $('voice-endpoint-ms').value = String(st.endpointSilenceMs);
    renderVoiceSelect();
    renderPersonaSelect();
    renderModelDatalist('voice-asr-model-suggestions', ASR_MODEL_SUGGESTIONS);
    renderModelDatalist('voice-tts-model-suggestions', TTS_MODEL_SUGGESTIONS);
    syncCloneHint();
    syncCustomPersonaRow();
    var nameEl = $('voice-voice-name');
    if (nameEl) nameEl.textContent = currentVoiceLabel();
  }

  // 当前选中渠道的模型目录 → 喂给模型输入框的建议列表
  function syncModelSuggestions(providerId, datalistId, fallbackModels) {
    var models = (fallbackModels || []).slice();
    if (providerId) {
      var p = (state.providers || []).filter(function (x) { return x.id === providerId; })[0];
      if (p && p.models && p.models.length) {
        // 只保留语音相关的模型名，避免把聊天模型也塞进建议（噪音）
        var audio = p.models.map(function (m) { return m.id; }).filter(function (id) {
          return /asr|tts|whisper|audio|speech|voice|transcri/i.test(id);
        });
        models = audio.length ? audio : models;
      }
    }
    renderModelDatalist(datalistId, models);
  }

  // ===== DOM → settings（改动即写内存，保存按钮统一落盘）=====
  function bind() {
    var st = v;

    var asrSel = $('voice-asr-provider');
    if (asrSel) asrSel.addEventListener('change', function () {
      st().asrProviderId = asrSel.value;
      syncModelSuggestions(asrSel.value, 'voice-asr-model-suggestions', ASR_MODEL_SUGGESTIONS);
    });
    var ttsSel = $('voice-tts-provider');
    if (ttsSel) ttsSel.addEventListener('change', function () {
      st().ttsProviderId = ttsSel.value;
      syncModelSuggestions(ttsSel.value, 'voice-tts-model-suggestions', TTS_MODEL_SUGGESTIONS);
    });
    var brainSel = $('voice-brain-provider');
    if (brainSel) brainSel.addEventListener('change', function () {
      st().brainProviderId = brainSel.value;
    });

    var bindText = function (id, key) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () { st()[key] = el.value; });
      el.addEventListener('change', function () { st()[key] = el.value; });
    };
    bindText('voice-asr-model', 'asrModel');
    bindText('voice-tts-model', 'ttsModel');
    bindText('voice-brain-model', 'brainModel');
    bindText('voice-design', 'voiceDesign');
    bindText('voice-custom-persona', 'customPersona');

    var vid = $('voice-voice-id');
    if (vid) vid.addEventListener('change', function () {
      st().voiceId = vid.value;
      var nameEl = $('voice-voice-name');
      if (nameEl) nameEl.textContent = currentVoiceLabel();
    });
    var per = $('voice-persona');
    if (per) per.addEventListener('change', function () {
      st().personaId = per.value;
      syncCustomPersonaRow();
    });

    var bindToggle = function (id, key) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () { st()[key] = !!el.checked; });
    };
    bindToggle('voice-barge-in', 'bargeIn');
    bindToggle('voice-show-transcript', 'showTranscript');
    bindToggle('voice-show-signals', 'showSignals');

    var sens = $('voice-sensitivity');
    if (sens) sens.addEventListener('input', function () {
      st().sensitivity = parseFloat(sens.value) || 0;
      var sv = $('voice-sensitivity-value');
      if (sv) sv.textContent = st().sensitivity.toFixed(2);
    });
    var ep = $('voice-endpoint-ms');
    if (ep) ep.addEventListener('change', function () {
      st().endpointSilenceMs = clampNum(ep.value, 300, 3000, 700);
      ep.value = String(st().endpointSilenceMs);
    });

    // 克隆参考音上传：只记文件名 + 把音频存到 Filesystem/CACHE，不把 base64 塞进 settings
    var up = $('btn-voice-clone-upload');
    var fileInput = $('voice-clone-file');
    if (up && fileInput) {
      up.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (f.size > 12 * 1024 * 1024) { showToast('参考音太大（上限 12MB）', 'warn'); fileInput.value = ''; return; }
        saveCloneRef(f).catch(function (e) {
          showToast('参考音保存失败：' + (e && e.message ? e.message : e), 'warn');
        });
      });
    }
    var clr = $('btn-voice-clone-clear');
    if (clr) clr.addEventListener('click', function () {
      st().cloneRefName = '';
      syncCloneHint();
      clearCloneRef().catch(function () {});
      showToast('已清除克隆参考音');
    });

    var testBtn = $('btn-voice-test');
    if (testBtn) testBtn.addEventListener('click', function () { testVoiceChain(testBtn); });
  }

  // ===== 克隆参考音存取 =====
  // APK: Filesystem(CACHE) 存二进制；Web: 存 IndexedDB（走 idbPut，量大也不怕）
  function saveCloneRef(file) {
    return fileToBase64(file).then(function (b64) {
      var name = 'voice-clone-ref.' + (file.name.split('.').pop() || 'wav');
      var done = function () {
        settings.voice.cloneRefName = name;
        settings.voice._cloneRefMime = file.type || '';
        saveSettings();
        syncCloneHint();
        showToast('参考音已保存');
      };
      if (typeof isCapacitor === 'function' && isCapacitor() && root.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem) {
        return Capacitor.Plugins.Filesystem.writeFile({
          path: name, data: b64.split(',')[1], directory: 'CACHE', recursive: true
        }).then(function () { done(); });
      }
      return idbPut('chatlite_voice_clone_ref', { name: name, mime: file.type, b64: b64 }).then(function () { done(); });
    });
  }

  function clearCloneRef() {
    var name = settings.voice && settings.voice.cloneRefName;
    if (!name) return Promise.resolve();
    if (typeof isCapacitor === 'function' && isCapacitor() && root.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem) {
      return Capacitor.Plugins.Filesystem.deleteFile({ path: name, directory: 'CACHE' }).catch(function () {});
    }
    return idbPut('chatlite_voice_clone_ref', null).catch(function () {});
  }

  // 读取参考音 → dataURL（供 TTS 声音克隆用）
  function loadCloneRef() {
    var name = settings.voice && settings.voice.cloneRefName;
    if (!name) return Promise.resolve(null);
    if (typeof isCapacitor === 'function' && isCapacitor() && root.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem) {
      return Capacitor.Plugins.Filesystem.readFile({ path: name, directory: 'CACHE' })
        .then(function (r) {
          var mime = (settings.voice && settings.voice._cloneRefMime) || 'audio/wav';
          return 'data:' + mime + ';base64,' + r.data;
        }).catch(function () { return null; });
    }
    return idbGet('chatlite_voice_clone_ref').then(function (r) {
      return r && r.b64 ? r.b64 : null;
    }).catch(function () { return null; });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('读取失败')); };
      fr.readAsDataURL(file);
    });
  }

  // ===== 测试语音链路 =====
  // 设计取舍：真发两次极短请求（ASR 用 0.3s 静音 wav、TTS 用「你好」），
  //   比只探 /models 更能证明「密钥对、协议对、模型在」。成本约几十 token。
  function testVoiceChain(btn) {
    var out = $('voice-test-result');
    var lines = [];
    var push = function (s) { lines.push(s); if (out) out.textContent = lines.join('\n'); };
    btn.disabled = true;
    push('正在测试…');
    var VC = root.VoiceCall;
    var test = (VC && typeof VC.__testChain === 'function')
      ? VC.__testChain(function (msg) { push(msg); })
      : Promise.reject(new Error('voice.js 未就绪'));
    test.then(function (ok) {
      push(ok ? '✓ 链路可用' : '✗ 有环节不通，看上面对应行');
      if (typeof showToast === 'function') showToast(ok ? '语音链路可用' : '语音链路有问题', ok ? 'ok' : 'warn');
    }).catch(function (e) {
      push('✗ ' + (e && e.message ? e.message : e));
    }).then(function () { btn.disabled = false; });
  }

  // ===== 初始化 =====
  function init() {
    // 设置面板打开时再渲染（元素一定存在；也顺便刷新渠道列表，用户可能刚加过渠道）
    var openBtn = $('btn-settings');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        // 让 app.js 的点击处理先跑完，再填表单
        setTimeout(syncVoiceSettingsUI, 0);
      });
    }
    // 渠道增删后同步
    if (root.document) {
      document.addEventListener('chatlite:providers-changed', function () {
        renderProviderSelect($('voice-asr-provider'), v().asrProviderId);
        renderProviderSelect($('voice-tts-provider'), v().ttsProviderId);
        renderProviderSelect($('voice-brain-provider'), v().brainProviderId);
      });
    }
    bind();
    // 首次尽力同步一次（若 DOM 已就绪且设置面板在 DOM 里）
    if ($('voice-asr-provider')) syncVoiceSettingsUI();
  }

  // 暴露给 voice.js 用（音色标签、克隆参考音）
  root.VoiceSettings = {
    init: init,
    sync: syncVoiceSettingsUI,
    currentVoiceLabel: currentVoiceLabel,
    loadCloneRef: loadCloneRef,
    VOICE_OPTIONS: VOICE_OPTIONS,
    // 后续可扩展：新增地方言预设等
    registerVoiceOption: function (opt) { if (opt && opt.id) VOICE_OPTIONS.push(opt); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
