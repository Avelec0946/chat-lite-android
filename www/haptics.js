// ===== haptics.js : 振感反馈模块（v2.0 拆分）=====
// 模块名：haptics.js
// 版本：v75（cache-bust）
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

// 懒初始化 rich-haptics 并预加载五档模式（首次流式时触发，async 不阻塞）
function _initStreamHaptics() {
  if (_richHapticsInitStarted) return;
  _richHapticsInitStarted = true;
  if (!CapRichHaptics) return;
  CapRichHaptics.isSupported().then(function(r) {
    if (!r.supported || !r.userEnabled) return;
    _richHapticsReady = true;
    _hapticEngineType = r.engine || 'none';
    CapRichHaptics.preload({ id: _HAPTIC_CHAR_ID,  intensity: 0.18, sharpness: 0.55 });
    CapRichHaptics.preload({ id: _HAPTIC_SOFT_ID,  intensity: 0.28, sharpness: 0.55 });
    CapRichHaptics.preload({ id: _HAPTIC_LOW_ID,   intensity: 0.14, sharpness: 0.35 });
    CapRichHaptics.preload({ id: _HAPTIC_CLICK_ID, intensity: 0.55, sharpness: 0.85 });
    CapRichHaptics.preload({ id: _HAPTIC_THUD_ID,  intensity: 0.72, sharpness: 0.15 });
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
      CapRichHaptics.playPreloaded({ id: id });
      // 字符主路径每 3 次用 play 覆盖抖动强度（±15%），仅 composition 引擎下生效
      if (kind === 'char' && _hapticCharCount % 3 === 0 && _hapticEngineType === 'composition') {
        const jitter = 0.18 + (Math.random() * 0.06 - 0.03); // 0.15–0.21
        CapRichHaptics.play({ intensity: jitter, sharpness: 0.55 });
      }
      return;
    }
    if (CapHaptics && typeof CapHaptics.impact === 'function') {
      CapHaptics.impact({ style: (kind === 'thud' || kind === 'click') ? 'MEDIUM' : 'LIGHT' });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      const ms = (kind === 'thud') ? 18 : (kind === 'click' ? 12 : (kind === 'soft' ? 8 : 5));
      navigator.vibrate(ms);
    }
  } catch(e) {}
}
