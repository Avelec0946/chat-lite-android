// ===== haptics.js : 振感反馈模块（v2.0 拆分）=====
// 模块名：haptics.js
// 版本：v75（拆分）→ v115（修复 rich-haptics 永不回退隐患，见 _fallbackHaptic）
// 迁移日期：2026-07-26
// 来源：从 app.js 拆分
// 职责：流式输出振感反馈（五档质感分层）
// 依赖：app.js 运行时提供 CapHaptics / CapRichHaptics / settings.hapticFeedback
// 加载顺序：在 db.js 之后、gesture-helpers.js 之前加载
//
// 迁移清单：
//   状态变量：_hapticLastTriggered, _richHapticsInitStarted, _richHapticsReady,
//            _hapticEngineType, _hapticCharCount
//   常量：_HAPTIC_CHAR_ID, _HAPTIC_SOFT_ID, _HAPTIC_LOW_ID, _HAPTIC_CLICK_ID, _HAPTIC_THUD_ID
//   函数：_initStreamHaptics, triggerHapticFeedback
//
// 保留在 app.js：
//   let CapHaptics = null;       // 与其他 Capacitor 插件统一初始化
//   let CapRichHaptics = null;   // 与其他 Capacitor 插件统一初始化
//   settings.hapticFeedback      // 全局 settings 对象

// ===== C3: 流式振感反馈（针对 X 轴线性马达优化，参考小米/Redmi RichTap 调校）=====
// 使用 capacitor-rich-haptics 的 preload/playPreloaded 实现低延迟触觉。
// Android 12+ 走 VibrationEffect.Composition 原语（PRIMITIVE_TICK/CLICK/LOW_TICK/THUD），
// 真正发挥 X 轴线性马达的短促颗粒质感，避免连续嗡嗡震。
// 五档质感分层（强度按 1.4 倍可感知差设计，参考 Android 官方触觉指南）：
//   CHAR  TICK     intensity 0.18 sharpness 0.55  字符主路径，轻脆不扰人
//   SOFT  TICK     intensity 0.28 sharpness 0.55  逗号/空格次重音
//   LOW   LOW_TICK intensity 0.14 sharpness 0.35  每 10 字低频点缀破单调
//   CLICK CLICK    intensity 0.55 sharpness 0.85  。！？句末锐利清脆
//   THUD  THUD     intensity 0.72 sharpness 0.15  \n 段落低频沉闷收束
// throttle：CHAR 38ms / SOFT 50ms / LOW 38ms / CLICK 60ms / THUD 120ms
// 字符路径每 3 次用 play 覆盖抖动强度（±15%）模拟自然书写轻重，避免感觉适应
let _hapticLastTriggered = 0;
let _richHapticsInitStarted = false;
let _richHapticsReady = false;
let _hapticEngineType = 'none';
let _hapticCharCount = 0;
const _HAPTIC_CHAR_ID = 'streamChar';
const _HAPTIC_SOFT_ID = 'streamSoft';
const _HAPTIC_LOW_ID = 'streamLow';
const _HAPTIC_CLICK_ID = 'streamClick';
const _HAPTIC_THUD_ID = 'streamThud';

// 兜底链路：rich-haptics 不可用、或调用失败时走这里（CapHaptics -> navigator.vibrate）
function _fallbackHaptic(kind) {
  try {
    if (CapHaptics && typeof CapHaptics.impact === 'function') {
      CapHaptics.impact({ style: (kind === 'thud' || kind === 'click') ? 'MEDIUM' : 'LIGHT' });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      const ms = (kind === 'thud') ? 18 : (kind === 'click' ? 12 : (kind === 'soft' ? 8 : 5));
      navigator.vibrate(ms);
    }
  } catch (e) {}
}

// preload 的 Promise 统一接管，避免 unhandled rejection 污染控制台
function _preloadSafe(opt) {
  try {
    const p = CapRichHaptics.preload(opt);
    if (p && typeof p.catch === 'function') p.catch(function(){});
  } catch (e) {}
}

// 懒初始化 rich-haptics 并预加载五档模式（首次流式时触发，async 不阻塞）
function _initStreamHaptics() {
  if (_richHapticsInitStarted) return;
  // v3.0.3: 插件还没挂上时**不要**置位「已启动」—— 否则这一次白跑，
  //   之后所有的振感都会永久退到 CapHaptics（表现为「代码没改、振动变粗」）。
  if (!CapRichHaptics) return;
  _richHapticsInitStarted = true;
  CapRichHaptics.isSupported().then(function(r) {
    if (!r.supported || !r.userEnabled) return;
    _richHapticsReady = true;
    _hapticEngineType = r.engine || 'none';
    _preloadSafe({ id: _HAPTIC_CHAR_ID,  intensity: 0.18, sharpness: 0.55 });
    _preloadSafe({ id: _HAPTIC_SOFT_ID,  intensity: 0.28, sharpness: 0.55 });
    _preloadSafe({ id: _HAPTIC_LOW_ID,   intensity: 0.14, sharpness: 0.35 });
    _preloadSafe({ id: _HAPTIC_CLICK_ID, intensity: 0.55, sharpness: 0.85 });
    _preloadSafe({ id: _HAPTIC_THUD_ID,  intensity: 0.72, sharpness: 0.15 });
  }).catch(function(){});
}

// 根据内容节奏触发震感。content 为本次 delta.content（可选）
function triggerHapticFeedback(content) {
  if (!settings.hapticFeedback) return;
  if (!_richHapticsInitStarted) _initStreamHaptics();
  const now = Date.now();
  let kind = 'char';
  let gap = 38;
  if (content && content.length > 0) {
    const last = content[content.length - 1];
    if (last === '\n') { kind = 'thud'; gap = 120; }
    else if ('。！？.!?'.indexOf(last) >= 0) { kind = 'click'; gap = 60; }
    else if ('，,;；、'.indexOf(last) >= 0) { kind = 'soft'; gap = 60; }
    else if (last === ' ' || last === '\t') { kind = 'soft'; gap = 50; }
    else {
      _hapticCharCount++;
      if (_hapticCharCount % 10 === 0) { kind = 'low'; gap = 38; }
    }
  }
  if (now - _hapticLastTriggered < gap) return;
  _hapticLastTriggered = now;
  let id;
  if (kind === 'thud') id = _HAPTIC_THUD_ID;
  else if (kind === 'click') id = _HAPTIC_CLICK_ID;
  else if (kind === 'soft') id = _HAPTIC_SOFT_ID;
  else if (kind === 'low') id = _HAPTIC_LOW_ID;
  else id = _HAPTIC_CHAR_ID;
  try {
    if (CapRichHaptics && _richHapticsReady) {
      let p = null;
      try {
        p = CapRichHaptics.playPreloaded({ id: id });
      } catch (eRich) {
        // 同步抛错：立即摘掉 rich 标记并补一次兜底振动，后续不再重试
        _richHapticsReady = false;
        _fallbackHaptic(kind);
        return;
      }
      if (p && typeof p.catch === 'function') {
        // v115 修复：原实现在此处直接 return 且不接管 Promise，playPreloaded 一旦
        // reject 就整条链路静默失效；现在失败即摘掉标记并降级到 CapHaptics
        p.catch(function() {
          _richHapticsReady = false;
          _fallbackHaptic(kind);
        });
      }
      // 字符主路径每 3 次用 play 覆盖抖动强度（±15%），仅 composition 引擎下生效
      if (kind === 'char' && _hapticCharCount % 3 === 0 && _hapticEngineType === 'composition') {
        const jitter = 0.18 + (Math.random() * 0.06 - 0.03); // 0.15–0.21
        try {
          const p2 = CapRichHaptics.play({ intensity: jitter, sharpness: 0.55 });
          if (p2 && typeof p2.catch === 'function') p2.catch(function(){});
        } catch (e2) {}
      }
      return;
    }
    _fallbackHaptic(kind);
  } catch(e) {}
}

// ===== v3.0.3: 事件级振感（一次性动作的「起 — 落 — 收」）=====
// 与上面流式五档的分工：流式 = 按字符节拍连续轻敲；这里 = 一个动作从开始到结束的一小段手感。
// 为什么不用 triggerHapticFeedback：它为连续流设计（每次只响一下 + 时间闸门），
//   拿它表达「完成 / 失败」只能得到单点，做不到音型，听感就是「嗡一下就没了」。
// 做法：一段 2~3 拍的音型，Android 12+ 走 AHAP → VibrationEffect.Composition 原生合成
//   （拍与拍之间的间隔由系统按毫秒精确排期，不是 setTimeout 抖出来的）；
//   老设备 / 无 rich-haptics 时逐拍下发，或退到 CapHaptics。
var _HAPTIC_PATTERNS = {
  // 起手：两声极轻，像把内容「收」进去，不打扰
  //   d = 单拍时长（秒）。只在「没有 Composition 原语」的老引擎上用得到 ——
  //   那种马达只能做「指定时长 + 振幅」的一次脉冲，给每拍不同时长/振幅，
  //   才不至于变成两下一样的嗡嗡。有原语的机器忽略 d，走系统合成。
  imageStart: [
    { p: 'lowTick', i: 0.16, s: 0.40, t: 0,     d: 0.010 },
    { p: 'tick',    i: 0.26, s: 0.55, t: 0.055, d: 0.016 }
  ],
  // 完成：一轻一脆的上行双拍（对应文本模块句末 CLICK 的质感，但更收）
  imageDone: [
    { p: 'tick',  i: 0.20, s: 0.60, t: 0,     d: 0.010 },
    { p: 'click', i: 0.46, s: 0.85, t: 0.070, d: 0.022 }
  ],
  // 失败：一锐一闷的下行双拍 —— 听感是「关门」，不是「报警」
  imageFail: [
    { p: 'click', i: 0.48, s: 0.85, t: 0,     d: 0.020 },
    { p: 'thud',  i: 0.52, s: 0.15, t: 0.100, d: 0.045 }
  ],
  // 主动停止：单次快速回落，收得干净
  imageStop: [
    { p: 'quickFall', i: 0.30, s: 0.50, t: 0, d: 0.022 }
  ],
  // UI 微交互（展开/收起这类）：最轻的一下
  tap: [
    { p: 'lowTick', i: 0.12, s: 0.45, t: 0, d: 0.008 }
  ]
};

// 上一次事件振感的「占用截止时间」——两段音型不叠着放
var _hapticEventUntil = 0;

function _buildAHAP(steps) {
  var pattern = [];
  for (var i = 0; i < steps.length; i++) {
    pattern.push({
      Event: {
        EventType: 'HapticTransient',
        Time: steps[i].t,
        EventParameters: [
          { ParameterID: 'HapticIntensity', ParameterValue: steps[i].i },
          { ParameterID: 'HapticSharpness', ParameterValue: steps[i].s }
        ],
        // 非标准字段，Android 侧用它精确指定 Composition 原语
        _androidPrimitive: steps[i].p
      }
    });
  }
  return { Version: 1, Pattern: pattern };
}

function _fallbackKindFor(primitive) {
  if (primitive === 'thud' || primitive === 'quickFall') return 'thud';
  if (primitive === 'click') return 'click';
  return 'soft';
}

// 逐拍下发（老设备路径）：每拍一次 play()，间隔用 setTimeout
function _playHapticSteps(steps) {
  var useDuration = (_hapticEngineType !== 'composition');
  for (var i = 0; i < steps.length; i++) {
    (function(st, delay) {
      setTimeout(function() {
        try {
          if (CapRichHaptics && _richHapticsReady) {
            var opt = { intensity: st.i, sharpness: st.s };
            // 只有「没有原语」的引擎才传时长：原语引擎传了会退化成一次性脉冲，反而更糙
            if (useDuration && st.d) opt.duration = st.d;
            var p = CapRichHaptics.play(opt);
            if (p && typeof p.catch === 'function') p.catch(function(){});
            return;
          }
        } catch (e) { /* 落到兜底 */ }
        _fallbackHaptic(_fallbackKindFor(st.p));
      }, delay);
    })(steps[i], Math.round(steps[i].t * 1000));
  }
}

// 预热入口：引擎探测 + 五档/音型预加载是异步的，第一次振感如果赶上初始化未完成，
//   就只能退到 CapHaptics 的「粗一下」。生图这类「按下就想要手感」的场景要提前备好。
function prewarmHaptics() {
  try { _initStreamHaptics(); } catch (e) {}
}

// 对外唯一入口：hapticPattern('imageStart' | 'imageDone' | 'imageFail' | 'imageStop' | 'tap')
function hapticPattern(name) {
  try {
    if (typeof settings !== 'undefined' && settings && settings.hapticFeedback === false) return;
    var steps = _HAPTIC_PATTERNS[name];
    if (!steps || !steps.length) return;
    if (!_richHapticsInitStarted) _initStreamHaptics();
    var now = Date.now();
    if (now < _hapticEventUntil) return;               // 上一段还没放完，不叠
    var span = steps[steps.length - 1].t * 1000 + 260; // 尾音留够，避免两段黏在一起
    _hapticEventUntil = now + span;
    // 组合引擎：整段交给系统合成（间隔精确、只唤醒一次马达）
    if (CapRichHaptics && _richHapticsReady && _hapticEngineType === 'composition') {
      try {
        var p = CapRichHaptics.playAHAPFromString({ json: JSON.stringify(_buildAHAP(steps)) });
        if (p && typeof p.catch === 'function') {
          p.catch(function() { _playHapticSteps(steps); });
        }
        return;
      } catch (e) { /* 落到逐拍 */ }
    }
    _playHapticSteps(steps);
  } catch (e) { /* 振感失败绝不影响主流程 */ }
}
