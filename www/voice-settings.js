// ===== voice-settings.js : 语音通话设置面板绑定（v126）=====
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

  // v126：外放 / 耳机两套微调预设的字段定义。

  // 人设列表从 voice-director 取（那边是真相来源），取不到时用兜底
  var FALLBACK_PERSONAS = [
    { id: 'warm', name: '温暖陪伴' },
    { id: 'bright', name: '元气伙伴' },
    { id: 'calm', name: '沉稳顾问' },
    { id: 'tease', name: '俏皮损友' }
  ];

  function $(id) { return document.getElementById(id); }
  function v() { return settings.voice || (settings.voice = defaultVoiceSettings()); }

  // v126 新控件都是"改完立刻生效"：它们决定下一通电话听起来什么样，
  //   用户不会想到还要再点一次保存。已有控件仍由保存按钮统一落盘，互不影响。
  function persistVoice() {
    try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) {}
  }


  function clampRate(n) {
    if (!isFinite(n)) return 1;
    if (n < 0.6) return 0.6;
    if (n > 1.6) return 1.6;
    return n;
  }

  // 语速转人话。voice-director 里将来会有统一的 describeRate（气泡也要用同一套说法），
  //   有就用它的，没有就自己拼 —— 设置面板不该等另一个模块就位才能用。
  function describeRate(rate) {
    var PD = root.VoiceDirector;
    if (PD && typeof PD.describeRate === 'function') {
      try {
        var s = PD.describeRate(rate);
        if (s && typeof s === 'string') return s;
      } catch (e) {}
    }
    // 阈值和 voice-director 的口径保持一致（1.05 / 0.95），
    //   否则模块没加载时同一档语速会显示成两种说法。
    var n = String(Math.round(rate * 100) / 100);
    if (rate >= 1.05) return '偏快（' + n + '×）';
    if (rate <= 0.95) return '偏慢（' + n + '×）';
    return '正常语速';
  }

  function syncRateUI() {
    var n = clampRate(parseFloat(v().rate));
    var inp = $('voice-rate');
    if (inp) inp.value = String(n);
    var val = $('voice-rate-value');
    if (val) val.textContent = n.toFixed(2) + '×';
    var desc = $('voice-rate-desc');
    if (desc) desc.textContent = describeRate(n);
  }

  // 原生可能返回字符串、也可能返回对象，字段名各平台不统一；
  //   这里只做"尽力认"，认不出就原样显示，绝不因为路由名陌生就报错。
  function routeLabel(raw) {
    if (raw && typeof raw === 'object') raw = raw.route || raw.type || raw.name || raw.current || '';
    var text = String(raw || '');
    var s = text.toLowerCase();
    if (!s) return '';
    if (s.indexOf('speaker') >= 0) return '外放';
    if (s.indexOf('headset') >= 0 || s.indexOf('headphone') >= 0 || s.indexOf('wired') >= 0) return '耳机';
    if (s.indexOf('bluetooth') >= 0 || s.indexOf('a2dp') >= 0) return '蓝牙耳机';
    if (s.indexOf('earpiece') >= 0 || s.indexOf('receiver') >= 0) return '听筒';
    if (s.indexOf('auto') >= 0) return '自动';
    return text;
  }

  // 当前实际路由只在原生插件存在时才有意义；浏览器里显示一句话就好，不弹错。
  function syncRouteNow() {
    var out = $('voice-route-now');
    if (!out) return;
    var cap = root.Capacitor;
    var plugin = cap && cap.Plugins && cap.Plugins.AudioRoute;
    if (!plugin || typeof plugin.getRoute !== 'function') {
      out.textContent = '浏览器/未接入原生';
      return;
    }
    var apply = function (r) {
      var label = routeLabel(r);
      out.textContent = label || '未知（原生未返回）';
    };
    try {
      var p = plugin.getRoute();
      if (p && typeof p.then === 'function') {
        p.then(apply).catch(function () { out.textContent = '浏览器/未接入原生'; });
      } else {
        apply(p);
      }
    } catch (e) {
      out.textContent = '浏览器/未接入原生';
    }
  }

  function getPersonas() {
    var PD = root.VoiceDirector;
    if (PD && Array.isArray(PD.PERSONAS) && PD.PERSONAS.length) return PD.PERSONAS;
    return FALLBACK_PERSONAS;
  }

  // ===== v133：总开关 → 顶栏话筒入口的显隐 =====
  // 放在这里而不是 voice.js 的理由：这是「设置决定界面」，和设置面板同源；
  //   语音运行时只负责「被点开之后」的事，不该知道入口按钮长什么样。
  // v3.0：判定改成严格的「=== true」。默认关之后，"字段缺了/不是布尔值" 该按关处理，
  //   用 `!(x === false)` 会把 undefined 当开 —— 与"默认关"正好相反。
  function voiceEnabled() {
    var st = settings && settings.voice;
    return !!(st && st.enabled === true);
  }

  function syncEntryVisibility() {
    var btn = $('btn-open-voice-view');
    if (!btn) return voiceEnabled();
    var on = voiceEnabled();
    // 用 '' 复原、而不是写死 display：按钮的常态显示由 CSS（.btn）决定，写死会跟样式打架。
    btn.style.display = on ? '' : 'none';
    btn.setAttribute('aria-hidden', on ? 'false' : 'true');
    // 关掉时如果通话界面正开着，一起退出去。
    //   否则会出现「入口没了、全屏通话还在」的矛盾状态，且用户找不到回来的路。
    if (!on) {
      try {
        var VC = root.VoiceCall;
        if (VC && typeof VC.isOpen === 'function' && VC.isOpen()) {
          if (typeof VC.hangup === 'function') VC.hangup();
          if (typeof VC.close === 'function') VC.close();
        }
      } catch (e) {}
    }
    return on;
  }

  // settings 是 app.js 异步从 IndexedDB 读的；本文件在 DOMContentLoaded 就跑起来了，
  //   此刻 settings 还是默认值。不等它落定就同步，会出现「上次关掉了、刷新后图标又冒出来」。
  function whenSettingsReady(fn) {
    var tries = 0;
    (function tick() {
      var st = (typeof state !== 'undefined' && state) ? state : root.state;
      if ((st && st._dataLoaded) || ++tries > 120) { fn(); return; }
      setTimeout(tick, 50);
    })();
  }

  // v127：renderProviderSelect 已删除。
  //   它把「接口管理」里的聊天渠道填进语音的渠道下拉 —— 那正是 401 的源头：
  //   聊天渠道的地址是文本网关，拿它发 asr/tts 密钥对不上。语音现在有独立的
  //   「语音接口」管理（voice-provider.js），不再从 state.providers 取任何东西。

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
    // v3.0：总开关（默认关；没有该键 → 视为关，与 defaultVoiceSettings 一致）
    if ($('voice-enabled')) $('voice-enabled').checked = st.enabled === true;
    syncEntryVisibility();
    // v127：渠道下拉已移除 —— 语音走独立的「语音接口」（voice-provider.js 负责渲染）
    if ($('voice-asr-model')) $('voice-asr-model').value = st.asrModel || '';
    if ($('voice-tts-model')) $('voice-tts-model').value = st.ttsModel || '';
    if ($('voice-design')) $('voice-design').value = st.voiceDesign || '';
    if ($('voice-custom-persona')) $('voice-custom-persona').value = st.customPersona || '';
    if ($('voice-barge-in')) $('voice-barge-in').checked = !!st.bargeIn;
    if ($('voice-show-transcript')) $('voice-show-transcript').checked = !!st.showTranscript;
    if ($('voice-show-signals')) $('voice-show-signals').checked = !!st.showSignals;
    // v128：思考策略（follow / on / off），老用户没有该键 → 显示「跟随会话」
    if ($('voice-thinking')) {
      var tk = (st.thinking === 'on' || st.thinking === 'off') ? st.thinking : 'follow';
      $('voice-thinking').value = tk;
    }
    if ($('voice-sensitivity')) $('voice-sensitivity').value = String(st.sensitivity);
    var sv = $('voice-sensitivity-value');
    if (sv) sv.textContent = Number(st.sensitivity).toFixed(2);
    // v127：「说完判定」改由 voice.js 的「接话快慢」滑杆控制，这里不再回填
    renderVoiceSelect();
    renderPersonaSelect();
    renderModelDatalist('voice-asr-model-suggestions', ASR_MODEL_SUGGESTIONS);
    renderModelDatalist('voice-tts-model-suggestions', TTS_MODEL_SUGGESTIONS);
    syncCloneHint();
    syncCustomPersonaRow();
    // v126 新控件回填。老用户没有这些键，一律按默认值显示，别让面板出现空白控件。
    if ($('voice-timestamps')) $('voice-timestamps').checked = !!st.timestamps;
    if ($('voice-rate-mode')) $('voice-rate-mode').value = st.rateMode === 'pitch' ? 'pitch' : 'natural';
    if ($('voice-route-mode')) {
      $('voice-route-mode').value = (st.routeMode === 'speaker' || st.routeMode === 'headset') ? st.routeMode : 'auto';
    }
    syncRateUI();
    syncRouteNow();
    // v127：自动挂断（默认关）
    if ($('voice-auto-hangup')) $('voice-auto-hangup').checked = !!st.autoHangup;
    if ($('voice-auto-hangup-min')) {
      var mins = Math.round((Number(st.autoHangupSilenceMs) || 3600000) / 60000);
      $('voice-auto-hangup-min').value = String(mins);
      $('voice-auto-hangup-min').disabled = !st.autoHangup;
    }
    var nameEl = $('voice-voice-name');
    if (nameEl) nameEl.textContent = currentVoiceLabel();
  }

  // v127：建议列表改为从「语音接口」自己配的模型里取（不再读聊天渠道的模型目录）
  function syncModelSuggestions(datalistId, fallbackModels) {
    var models = (fallbackModels || []).slice();
    try {
      var VP = root.VoiceProvider;
      var p = (VP && typeof VP.current === 'function') ? VP.current() : null;
      if (p) {
        var mine = [];
        if (p.asrModel) mine.push(p.asrModel);
        if (p.ttsModel) mine.push(p.ttsModel);
        if (Array.isArray(p.models)) {
          p.models.forEach(function (m) {
            var id = (typeof m === 'string') ? m : (m && (m.id || m.name));
            if (id && mine.indexOf(id) < 0) mine.push(id);
          });
        }
        if (mine.length) models = mine.concat(models.filter(function (x) { return mine.indexOf(x) < 0; }));
      }
    } catch (e) {}
    renderModelDatalist(datalistId, models);
  }

  // ===== DOM → settings（改动即写内存；v126 新控件另外即时落盘，其余仍归保存按钮）=====
  function bind() {
    var st = v;

    // v127：渠道下拉已移除，改由 voice-provider.js 管理独立语音接口
    var bindText = function (id, key) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () { st()[key] = el.value; });
      el.addEventListener('change', function () { st()[key] = el.value; });
    };
    bindText('voice-asr-model', 'asrModel');
    bindText('voice-tts-model', 'ttsModel');
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

    // ===== v133：总开关 =====
    // 它改的是「入口在不在」，用户点完立刻要看结果，所以即时落盘 + 立刻刷顶栏，
    //   不等设置面板的「保存」按钮（那个按钮管的是别的字段）。
    // v3.0：顺手记「用户表过态」—— 默认关是一次性落地，用户一旦自己选过，
    //   迁移就再也不许按默认值覆盖他（见 db.js migrateVoiceSettings）。
    var enEl = $('voice-enabled');
    if (enEl) enEl.addEventListener('change', function () {
      st().enabled = !!enEl.checked;
      st().enabledSetByUser = true;
      persistVoice();
      syncEntryVisibility();
      if (typeof showToast === 'function') {
        showToast(enEl.checked ? '语音通话已开启，会话顶栏显示话筒入口' : '语音通话已关闭，会话顶栏话筒入口已隐藏');
      }
    });

    // v128：思考策略。改动即时落盘 —— 用户会在通话中调它来比较手感。
    var thinkSel = $('voice-thinking');
    if (thinkSel) thinkSel.addEventListener('change', function () {
      var v = thinkSel.value;
      st().thinking = (v === 'on' || v === 'off') ? v : 'follow';
      persistVoice();
    });

    var sens = $('voice-sensitivity');
    if (sens) sens.addEventListener('input', function () {
      st().sensitivity = parseFloat(sens.value) || 0;
      var sv = $('voice-sensitivity-value');
      if (sv) sv.textContent = st().sensitivity.toFixed(2);
    });
    // ===== v127：自动挂断（默认关，开了默认 1 小时）=====
    var ah = $('voice-auto-hangup');
    if (ah) ah.addEventListener('change', function () {
      st().autoHangup = !!ah.checked;
      var minEl = $('voice-auto-hangup-min');
      if (minEl) minEl.disabled = !ah.checked;
      persistVoice();
    });
    var ahMin = $('voice-auto-hangup-min');
    if (ahMin) ahMin.addEventListener('change', function () {
      var m = parseInt(ahMin.value, 10);
      if (!isFinite(m) || m < 1) m = 60;
      if (m > 720) m = 720;
      st().autoHangupSilenceMs = m * 60000;
      ahMin.value = String(m);
      persistVoice();
    });

    // ===== v126：时间感知 =====
    var ts = $('voice-timestamps');
    if (ts) ts.addEventListener('change', function () {
      st().timestamps = !!ts.checked;
      persistVoice();
    });

    // ===== v126：语速 =====
    // 拖动时只刷界面和内存（input 很密，每次落盘会写爆存储），松手（change）才持久化。
    var rateInp = $('voice-rate');
    if (rateInp) {
      var applyRate = function (commit) {
        var n = clampRate(parseFloat(rateInp.value));
        st().rate = n;
        var val = $('voice-rate-value');
        if (val) val.textContent = n.toFixed(2) + '×';
        var desc = $('voice-rate-desc');
        if (desc) desc.textContent = describeRate(n);
        if (commit) persistVoice();
      };
      rateInp.addEventListener('input', function () { applyRate(false); });
      rateInp.addEventListener('change', function () { applyRate(true); });
    }
    var rateMode = $('voice-rate-mode');
    if (rateMode) rateMode.addEventListener('change', function () {
      st().rateMode = rateMode.value === 'pitch' ? 'pitch' : 'natural';
      persistVoice();
    });

    // ===== v126：音频路由 =====
    var routeMode = $('voice-route-mode');
    if (routeMode) routeMode.addEventListener('change', function () {
      var v2 = routeMode.value;
      st().routeMode = (v2 === 'speaker' || v2 === 'headset') ? v2 : 'auto';
      persistVoice();
      // 手动模式不会立刻改原生输出（那要等通话启动时应用），
      //   这里刷新一下"当前实际路由"，让用户知道系统现在到底走的哪条路。
      syncRouteNow();
    });

    // v127：双预设两栏已移除（用户明确反对 15 个手填输入框）。
    //   现在由 voice.js 注入三档滑杆 + 折叠的高级参数，直接写 settings.voice 同名字段。


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
    // 通话界面里的齿轮打开的是同一个设置面板，那条路径不经过 btn-settings，
    //   这里补一次回填，免得面板显示的是上次打开时的旧值。
    var voiceOpenSettings = $('btn-voice-settings');
    if (voiceOpenSettings) {
      voiceOpenSettings.addEventListener('click', function () {
        setTimeout(syncVoiceSettingsUI, 0);
      });
    }
    bind();
    // 首次尽力同步一次（若 DOM 已就绪且设置面板在 DOM 里）
    if ($('voice-asr-model')) syncVoiceSettingsUI();
    // v133：入口显隐要等 settings 真读出来再定，否则会按默认值把已关掉的入口又显示一次
    whenSettingsReady(function () {
      syncEntryVisibility();
      if ($('voice-enabled')) $('voice-enabled').checked = (settings.voice || {}).enabled === true;
    });
    // v127：语音接口是独立配置，聊天渠道增删与它无关，不再监听 providers-changed
    if (root.VoiceProvider && typeof root.VoiceProvider.init === 'function') {
      try { root.VoiceProvider.init(); } catch (e) { console.warn('[voice-settings] VoiceProvider.init', e); }
    }
  }

  // 暴露给 voice.js 用（音色标签、克隆参考音）
  root.VoiceSettings = {
    init: init,
    sync: syncVoiceSettingsUI,
    // v133：供外部（测试 / 导入备份后）重新按 settings 刷一次顶栏入口
    syncEntry: syncEntryVisibility,
    isEnabled: voiceEnabled,
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
