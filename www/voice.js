// ===== voice.js : 语音通话运行时（v125）=====
// 模块名：voice.js
// 版本：v125（cache-bust，新文件首发）
// 职责：通话状态机、麦克风采集、VAD/端点检测、副语言信号提取、ASR/TTS/大脑请求、
//       流式 PCM 排期播放、打断、把每轮对话写回会话、界面接线、指标统计
// 依赖（全部为运行时访问，只在函数内触碰，避免 TDZ）：
//   app.js        state / settings / showToast / escapeHtml / uid / isCapacitor /
//                 CapHttp / CapStreamHttp / CapHaptics / currentConv
//   db.js         saveSettings / defaultVoiceSettings
//   providers.js  getProvider / normalizeProvider / buildUpstreamPayload
//   conversation.js  getMsg / getLastActiveMsg / getActiveChain / renderMessages
//   db.js         save()
//   haptics.js    （可选，不直接调用；振感本文件自带轻量实现）
//   voice-director.js  window.VoiceDirector（纯函数层，可能尚未就绪，全部 try/catch 兜底）
//   voice-settings.js  window.VoiceSettings（音色标签 / 克隆参考音）
// 加载顺序：app.js 之后（index.html 最后一个 script）
//
// 设计要点（务必保持）：
//   1. 纯逻辑（重采样 / WAV 封装 / PCM 拼接 / VAD / 信号 / 句子切分）全部是独立函数，
//      不碰 DOM 不碰网络，统一挂在 VoiceCall.__test 上，可在 node 里直接跑单测。
//   2. CapacitorHttp 的 POST 无法被 AbortController 真正取消 —— 所有请求都走
//      raceAbandon / withTimeout，到点就"放弃等待"并给可读提示，绝不让界面一直转圈。
//   3. 播放靠 AudioContext 手动排期（nextStartTime + 采样数精确推算），不用 setTimeout，
//      多段 PCM 首尾相接必须无缝。
//   4. 采集永远不把静音送进 ASR（服务端会把静音幻觉成文字），VAD 在客户端做门限。

(function (root) {
  'use strict';

  // =====================================================================================
  // 1. 常量与配置
  // =====================================================================================

  var VERSION = 'v125';

  // 采集 / 播放
  var CAPTURE_RATE = 16000;   // ASR 只接受 16k 单声道 16bit wav（已实测）
  var TTS_RATE = 24000;       // MiMo TTS 默认 24k 16bit 单声道
  var SCRIPT_BUFFER = 2048;   // ScriptProcessorNode 缓冲（48k 下约 42ms，够低延迟又不爆 CPU）
  var PREROLL_MS = 320;       // speech-start 之前保留的"前摇"，避免吞掉第一个字
  var SCHEDULE_LEAD = 0.06;   // 排期提前量（秒），防止调度抖动造成咔哒

  // 常见超时（毫秒）
  var T_ASR = 25000;
  var T_TTS = 30000;
  var T_BRAIN_FIRST = 45000;  // 大脑首字节
  var T_BRAIN_IDLE = 45000;   // 大脑空闲
  var T_CONNECT = 15000;

  // 交互参数（默认值；真机可从 settings.voice 覆盖，见 cfgNum 调用点）
  //   这三个是"必须在真机上才调得准"的量，写死在代码里等于把用户锁死在一种声学环境：
  //     echoGuardMs          —— AI 刚开口时的自激抑制窗口（外放/回声大就调大）
  //     bargeInHoldMs        —— 打断需要持续多久（误触发就调大）
  //     bargeInLeakFactor    —— 回漏阈值系数（自激就调大）
  var ECHO_GUARD_MS = 250;
  var BARGE_HOLD_MS = 180;
  var BARGE_LEAK_FACTOR = 3.2;
  var BARGE_LEAK_FLOOR = 0.004;
  // 允许的调节范围（防止用户在设置里填出离谱值把功能调死）
  var TUNING_RANGES = {
    echoGuardMs: [0, 1200],
    bargeInHoldMs: [80, 800],
    bargeInLeakFactor: [1.5, 10],
    endpointSilenceMs: [200, 5000],
    minUtteranceMs: [100, 5000],
    leakFloor: [0.001, 0.05]
  };
  var FILLER_DELAY_MS = 900;  // thinking 超过这么久没出第一句 → 先播语气词
  var MAX_TTS_CHARS = 140;    // 单次 TTS 文本上限（太长首包太慢）
  var MIN_TTS_CHARS = 2;
  var STATES = ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'error'];

  var STATE_TEXT = {
    idle: '准备就绪',
    connecting: '正在建立连接…',
    listening: '请说话',
    thinking: '我在想…',
    speaking: '',
    error: '出错了'
  };

  // VAD 默认参数（可被 settings.voice 覆盖）
  var VAD_DEFAULTS = {
    calibrateMs: 300,          // 开头这么久用于估底噪
    speechOnMs: 180,           // 连续超过阈值这么久才算开口
    endpointSilenceMs: 700,    // 说完之后的静音判定
    minUtteranceMs: 400,       // 太短的片段直接丢弃（不送 ASR）
    maxUtteranceMs: 30000,     // 最长话语上限，超了强制切
    sensitivity: 0.5,          // 0~1，越大越灵敏
    absFloor: 0.0035           // 绝对能量下限，防止全静音环境阈值趋近 0
  };

  // =====================================================================================
  // 2. 基础工具（纯函数 / 无副作用，可测）
  // =====================================================================================

  function num(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (isFinite(n) ? n : d);
  }

  function clamp(v, lo, hi) {
    v = num(v, lo);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function nowMs() {
    try { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  function makeErr(msg, code) {
    var e = new Error(msg);
    e.code = code || 'voice_error';
    return e;
  }

  function isAbort(e) {
    return !!(e && (e.code === 'voice_abort' || e.name === 'AbortError'));
  }

  function abortErr() { return makeErr('已放弃等待', 'voice_abort'); }

  // 数组深拷贝（纯）
  function copyArray(a) { return Array.prototype.slice.call(a); }

  function strOf(v) { return (v === null || v === undefined) ? '' : String(v); }

  // =====================================================================================
  // 3. 音频编解码（纯函数，可测）
  // =====================================================================================

  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function hasBuffer() {
    return (typeof Buffer !== 'undefined') && Buffer && typeof Buffer.from === 'function';
  }

  // Uint8Array -> base64（node 与浏览器都可用）
  function bytesToBase64(bytes) {
    if (!bytes) return '';
    var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    if (hasBuffer()) return Buffer.from(u8).toString('base64');
    var out = '', i, n = u8.length, b, c1, c2, c3;
    for (i = 0; i < n; i += 3) {
      b = u8[i];
      c1 = (i + 1 < n) ? u8[i + 1] : 0;
      c2 = (i + 2 < n) ? u8[i + 2] : 0;
      out += B64_CHARS.charAt((b >> 2) & 63);
      out += B64_CHARS.charAt(((b & 3) << 4) | ((c1 >> 4) & 15));
      out += (i + 1 < n) ? B64_CHARS.charAt(((c1 & 15) << 2) | ((c2 >> 6) & 3)) : '=';
      out += (i + 2 < n) ? B64_CHARS.charAt(c2 & 63) : '=';
    }
    return out;
  }

  // base64 -> Uint8Array
  function base64ToBytes(b64) {
    var s = strOf(b64).replace(/\s+/g, '');
    if (!s) return new Uint8Array(0);
    if (hasBuffer()) return new Uint8Array(Buffer.from(s, 'base64'));
    var bin = '';
    try { bin = atob(s); } catch (e) { return new Uint8Array(0); }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  // Int16Array -> 小端字节
  function int16ToBytes(i16) {
    var n = i16 ? i16.length : 0;
    var out = new Uint8Array(n * 2);
    for (var i = 0; i < n; i++) {
      var v = i16[i];
      if (v < 0) v += 65536;
      out[i * 2] = v & 0xff;
      out[i * 2 + 1] = (v >> 8) & 0xff;
    }
    return out;
  }

  // 小端字节 -> Int16Array（奇数字节截断到最后完整样本）
  function bytesToInt16(bytes) {
    var n = bytes ? (bytes.length >> 1) : 0;
    var out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var lo = bytes[i * 2], hi = bytes[i * 2 + 1];
      var v = lo | (hi << 8);
      out[i] = (v & 0x8000) ? (v - 65536) : v;
    }
    return out;
  }

  // Float32(-1..1) -> Int16
  function floatToInt16(f32) {
    var n = f32 ? f32.length : 0;
    var out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var v = f32[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      v = (v < 0) ? (v * 32768) : (v * 32767);
      out[i] = Math.round(v);
    }
    return out;
  }

  // Int16 -> Float32(-1..1)
  function int16ToFloat32(i16) {
    var n = i16 ? i16.length : 0;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = i16[i] / 32768;
    return out;
  }

  // 多段 Int16 拼接（纯；返回新的 Int16Array）
  function concatInt16(chunks) {
    var total = 0, i, j, k = 0;
    chunks = chunks || [];
    for (i = 0; i < chunks.length; i++) total += chunks[i] ? chunks[i].length : 0;
    var out = new Int16Array(total);
    for (i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (!c) continue;
      for (j = 0; j < c.length; j++) out[k++] = c[j];
    }
    return out;
  }

  // 帧能量（RMS，0..1）
  function frameRms(f32) {
    var n = f32 ? f32.length : 0;
    if (!n) return 0;
    var sum = 0, i, v;
    for (i = 0; i < n; i++) { v = f32[i]; sum += v * v; }
    return Math.sqrt(sum / n);
  }

  // 分贝
  function toDb(ratio) {
    if (!(ratio > 0)) return -100;
    return 20 * Math.log(ratio) / Math.LN10;
  }

  // WAV 封装：16bit 单声道 PCM -> 完整 wav 字节
  function encodeWav(pcmBytes, sampleRate) {
    var n = pcmBytes ? pcmBytes.length : 0;
    var rate = Math.max(8000, Math.round(num(sampleRate, CAPTURE_RATE)));
    var buf = new Uint8Array(44 + n);
    var dv = new DataView(buf.buffer);
    function tag(off, s) { for (var i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); }
    tag(0, 'RIFF');
    dv.setUint32(4, 36 + n, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    dv.setUint32(16, 16, true);        // fmt chunk 长度
    dv.setUint16(20, 1, true);         // PCM
    dv.setUint16(22, 1, true);         // 单声道
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true);  // byteRate
    dv.setUint16(32, 2, true);         // blockAlign
    dv.setUint16(34, 16, true);        // bitsPerSample
    tag(36, 'data');
    dv.setUint32(40, n, true);
    if (n) buf.set(pcmBytes, 44);
    return buf;
  }

  // 解析 wav 头（TTS 非流式返回的一定是 wav；流式 chunk 是裸 PCM 没有头）
  // 返回 {sampleRate, channels, bits, pcmOffset, dataBytes} 或 null
  function parseWavHeader(bytes) {
    if (!bytes || bytes.length < 12) return null;
    var riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    var wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff !== 'RIFF' || wave !== 'WAVE') return null;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 12;
    var rate = 0, channels = 1, bits = 16, dataOffset = -1, dataBytes = 0;
    while (pos + 8 <= bytes.length) {
      var id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      var size = dv.getUint32(pos + 4, true);
      if (id === 'fmt ' && pos + 8 + 16 <= bytes.length) {
        channels = dv.getUint16(pos + 10, true);
        rate = dv.getUint32(pos + 12, true);
        bits = dv.getUint16(pos + 22, true);
      } else if (id === 'data') {
        dataOffset = pos + 8;
        dataBytes = Math.min(size, bytes.length - dataOffset);
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (dataOffset < 0) {
      // 有些实现把 data 长度写成 0/0xFFFFFFFF（流式 wav）：兜底取到末尾
      dataOffset = 44;
      dataBytes = Math.max(0, bytes.length - 44);
    }
    return { sampleRate: rate || TTS_RATE, channels: channels || 1, bits: bits || 16, pcmOffset: dataOffset, dataBytes: dataBytes };
  }

  // 把任意 PCM 字节拆成「完整 16bit 样本 + 可能的半个字节尾巴」
  function splitPcmTail(carry, bytes) {
    var buf;
    if (carry && carry.length) {
      buf = new Uint8Array(carry.length + bytes.length);
      buf.set(carry, 0);
      buf.set(bytes, carry.length);
    } else {
      buf = bytes;
    }
    var even = buf.length & ~1;
    var nextCarry = (buf.length > even) ? buf.slice(even) : null;
    return { body: buf.subarray(0, even), carry: nextCarry };
  }

  // 线性插值重采样器（带相位连续性 —— 分块调用不会在每个块边界产生咔哒）
  function Resampler(inRate, outRate) {
    this.inRate = num(inRate, 48000);
    this.outRate = num(outRate, CAPTURE_RATE);
    this.ratio = this.inRate / this.outRate;
    this.pos = 0;        // 小数相位，可为负（虚拟索引 -1 = prev）
    this.prev = 0;       // 上一个块的最后一个样本
  }

  Resampler.prototype.process = function (input) {
    var n = input ? input.length : 0;
    if (n < 1) return new Float32Array(0);
    var ratio = this.ratio;
    var pos = this.pos;
    var prev = this.prev;
    var out = [];
    var guard = 0;
    var maxOut = Math.ceil(n / ratio) + 8;
    while (pos < n - 1 && guard < maxOut) {
      var i0 = Math.floor(pos);
      var frac = pos - i0;
      var s0, s1;
      if (i0 < 0) { s0 = prev; s1 = input[0]; }
      else { s0 = input[i0]; s1 = input[i0 + 1]; }
      out.push(s0 + (s1 - s0) * frac);
      pos += ratio;
      guard++;
    }
    this.pos = pos - n;
    this.prev = input[n - 1];
    return Float32Array.from(out);
  };

  // =====================================================================================
  // 3.5 语速：WSOLA 保音高时间伸缩（变速不变调）
  // =====================================================================================
  // 为什么自己写：AudioContext 的 playbackRate 会连带变调（1.3× 就尖得没法听），
  //   而语速是通话里最常调的参数。WSOLA 不去拉伸波形周期，而是"在波形里找与上一帧
  //   最像的位置接上"，所以音高不变，只改变时长。
  // 流式约束：TTS 是一块块 PCM 吐出来的。若每块独立处理，块边界必然产生周期性咔哒声，
  //   因此把"上一帧尾巴（对齐模板）/ 名义读取位置 / 交叠累加器 / 残留输入"全部放在
  //   闭包里跨调用保留 —— 这是本实现与一次性处理的本质区别。
  //   纯逻辑、不碰 AudioContext，可被单测直接调用。

  var RATE_MIN = 0.6;
  var RATE_MAX = 1.6;
  var STRETCH_FRAME_MS = 30;    // 帧长：30ms 够覆盖语音基频的 2~3 个周期
  var STRETCH_SEARCH_MS = 10;   // 对齐搜索窗 ±10ms，再宽只是白花 CPU

  // 语速统一入口：非法值回落 1（直通），越界夹到 0.6~1.6
  function clampRate(r) {
    var n = num(r, 1);
    if (!(n > 0)) return 1;
    var lo = (typeof root.VoiceDirector === 'object' && root.VoiceDirector && num(root.VoiceDirector.RATE_MIN, RATE_MIN)) || RATE_MIN;
    var hi = (typeof root.VoiceDirector === 'object' && root.VoiceDirector && num(root.VoiceDirector.RATE_MAX, RATE_MAX)) || RATE_MAX;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function makeTimeStretcher(rate, sampleRate) {
    var sr = num(sampleRate, TTS_RATE);
    if (!(sr > 0)) sr = TTS_RATE;
    var frameLen = Math.max(8, Math.round(sr * STRETCH_FRAME_MS / 1000));
    if (frameLen % 2) frameLen++;          // 50% 交叠要求偶数帧长
    var hopOut = frameLen >> 1;
    var searchWin = Math.max(2, Math.round(sr * STRETCH_SEARCH_MS / 1000));

    // 周期性汉宁窗：50% 交叠时相邻两窗之和恒为 1，重建后不会有音量起伏
    var win = new Float32Array(frameLen);
    for (var wi = 0; wi < frameLen; wi++) win[wi] = 0.5 - 0.5 * Math.cos(2 * Math.PI * wi / frameLen);

    var st = {
      rate: 1,
      sampleRate: sr,
      frameLen: frameLen,
      hopOut: hopOut,
      searchWin: searchWin,
      buf: new Float32Array(0),   // 尚未消费的输入（保留搜索窗，供下一块的帧对齐）
      bufStart: 0,                // buf[0] 在整个输入流里的绝对下标
      pos: 0,                     // 名义读取位置（小数）；按 hopOut * rate 前进
      totalIn: 0,                 // 已喂进来的真实样本总数（flush 的结束判据）
      acc: new Float32Array(frameLen),  // 交叠累加器：上一帧的后半段
      tail: null,                 // 上一帧后半段（未加窗），作为下一帧的对齐模板
      emitted: 0
    };
    st.rate = clampRate(rate);

    function appendBuf(input, isReal) {
      var add = input.length;
      var merged = new Float32Array(st.buf.length + add);
      merged.set(st.buf, 0);
      merged.set(input, st.buf.length);
      st.buf = merged;
      if (isReal !== false) st.totalIn += add;
    }

    function trimBuf() {
      // 下一帧的候选位置最早是 round(pos) - searchWin，再往前的输入永远不会用到
      var keepFrom = Math.round(st.pos) - st.searchWin;
      if (keepFrom <= st.bufStart) return;
      var cut = keepFrom - st.bufStart;
      if (cut >= st.buf.length) {
        st.buf = new Float32Array(0);
        st.bufStart = keepFrom;
        return;
      }
      var nb = new Float32Array(st.buf.length - cut);
      nb.set(st.buf.subarray(cut));
      st.buf = nb;
      st.bufStart = keepFrom;
    }

    function concatOut(chunks, total) {
      var out = new Float32Array(total);
      var off = 0;
      for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
      return out;
    }

    // 流边界：一句 TTS 结束就清空。不清空的话，flush 时补的静音尾巴会留到下一句，
    //   下一句开头几十毫秒会被当成"上一句的余音"混进去（听感是黏连 + 首字发虚）。
    function resetStream() {
      st.buf = new Float32Array(0);
      st.bufStart = 0;
      st.pos = 0;
      st.totalIn = 0;
      st.acc = new Float32Array(frameLen);
      st.tail = null;
      st.emitted = 0;
    }

    function generate(finishing) {
      var chunks = [];
      var total = 0;
      var bufEnd = st.bufStart + st.buf.length;
      var hopIn = hopOut * st.rate;
      while (true) {
        var target = Math.round(st.pos);
        if (finishing && target >= st.totalIn) break;
        if (target + st.searchWin + st.frameLen > bufEnd) break;   // 数据不够：留给下一块
        // 在名义位置附近找"与上一帧后半段最相似"的接点，接上就不响（相位连续）
        var bestStart = -1;
        var bestScore = -Infinity;
        if (!st.tail) {
          bestStart = target;
        } else {
          for (var d = -st.searchWin; d <= st.searchWin; d++) {
            var s = target + d;
            if (s < st.bufStart || s + st.frameLen > bufEnd) continue;
            var base = s - st.bufStart;
            var corr = 0;
            var energy = 0;
            for (var i = 0; i < hopOut; i++) {
              var x = st.buf[base + i];
              corr += x * st.tail[i];
              energy += x * x;
            }
            // 归一化互相关：否则会偏向响度更大的位置
            var score = energy > 1e-9 ? corr / Math.sqrt(energy) : 0;
            if (score > bestScore) { bestScore = score; bestStart = s; }
          }
        }
        if (bestStart < 0) bestStart = target;
        var fb = bestStart - st.bufStart;
        for (var j = 0; j < frameLen; j++) st.acc[j] += st.buf[fb + j] * win[j];
        var chunk = new Float32Array(hopOut);
        for (var m = 0; m < hopOut; m++) chunk[m] = st.acc[m];
        chunks.push(chunk);
        total += hopOut;
        st.emitted += hopOut;
        // 累加器左移一个 hop：本帧后半段留给下一帧叠加
        for (var q = 0; q < hopOut; q++) st.acc[q] = st.acc[q + hopOut];
        for (var q2 = hopOut; q2 < frameLen; q2++) st.acc[q2] = 0;
        if (!st.tail) st.tail = new Float32Array(hopOut);
        for (var t = 0; t < hopOut; t++) st.tail[t] = st.buf[fb + hopOut + t];
        st.pos += hopIn;
      }
      if (st.pos > st.searchWin) trimBuf();
      return concatOut(chunks, total);
    }

    return {
      process: function (input) {
        if (!input || !input.length) return new Float32Array(0);
        if (st.rate === 1) return input;      // 直通：零开销、零质量损失
        appendBuf(input, true);
        return generate(false);
      },
      // 一句话结束：把滞留的尾巴吐出来，否则每句都会丢掉最后几十毫秒
      flush: function () {
        var out = new Float32Array(0);
        if (st.buf.length) {
          // 末尾补零：搜索窗/帧长需要向右看，真实输入到头了用静音顶上
          appendBuf(new Float32Array(st.searchWin + st.frameLen + hopOut), false);
          out = generate(true);
          // 5ms 线性淡出：句子在任意相位被截断，直接切断会有"哒"的一声
          var fade = Math.min(out.length, Math.round(sr * 0.005));
          for (var i = 0; i < fade; i++) out[out.length - 1 - i] *= (i / fade);
        }
        resetStream();
        return out;
      },
      setRate: function (r) {
        st.rate = clampRate(r);
        return st.rate;
      },
      rate: function () { return st.rate; },
      config: function () {
        return { sampleRate: sr, frameLen: frameLen, hopOut: hopOut, searchWin: searchWin };
      }
    };
  }

  // =====================================================================================
  // 4. VAD 与端点检测（纯逻辑，可测）
  // =====================================================================================
  // 用法：
  //   var vad = createVad({...});
  //   vad.feed(rms, dtMs)  → 事件字符串 | null
  //      'calibrating' | 'speech-start' | 'endpoint-candidate' | 'force-end' | 'discard'
  //   vad.confirmEnd()     → 结束本段，返回这一段的统计（帧序列 / 底噪 / 阈值）
  //   vad.continueWait(ms) → 刚才只是短暂停顿，再等一会儿（把本地端点阈值往后推）
  //   vad.reset()          → 丢掉当前段，回到等下一句
  //
  // 与服务端事实对应：静音会被 ASR 幻觉成文字，所以"太短/没声音"的片段绝不外发。

  function createVad(opts) {
    var cfg = {
      calibrateMs: num(opts && opts.calibrateMs, VAD_DEFAULTS.calibrateMs),
      speechOnMs: num(opts && opts.speechOnMs, VAD_DEFAULTS.speechOnMs),
      endpointSilenceMs: num(opts && opts.endpointSilenceMs, VAD_DEFAULTS.endpointSilenceMs),
      minUtteranceMs: num(opts && opts.minUtteranceMs, VAD_DEFAULTS.minUtteranceMs),
      maxUtteranceMs: num(opts && opts.maxUtteranceMs, VAD_DEFAULTS.maxUtteranceMs),
      sensitivity: clamp(opts && opts.sensitivity, 0, 1) === undefined ? 0.5 : clamp(opts && opts.sensitivity, 0, 1),
      absFloor: num(opts && opts.absFloor, VAD_DEFAULTS.absFloor)
    };
    if (opts && opts.sensitivity !== undefined) cfg.sensitivity = clamp(opts.sensitivity, 0, 1);

    var st = {
      t: 0,                 // 累计时间
      phase: 'calibrate',   // calibrate | idle | speech
      calibSum: 0,
      calibN: 0,
      noiseFloor: cfg.absFloor,
      thr: cfg.absFloor * 3,
      aboveMs: 0,
      speechMs: 0,
      silenceMs: 0,
      frames: [],           // {t, rms, voiced}
      awaiting: false,      // 已经发过 endpoint-candidate，等调用方决定
      endAtMs: cfg.endpointSilenceMs,
      rmsSum: 0,
      rmsPeak: 0,
      voicedFrames: 0,
      calibPeak: 0
    };

    function openFactor() {
      // 灵敏度 0 → 系数 3.2（迟钝，要很大声才触发）；1 → 1.6（灵敏）
      return 3.2 - 1.6 * clamp(cfg.sensitivity, 0, 1);
    }

    function recalcThr() {
      var f = openFactor();
      var thr = st.noiseFloor * f;
      if (thr < cfg.absFloor) thr = cfg.absFloor;
      st.thr = thr;
      return thr;
    }

    function pushFrame(rms, voiced) {
      st.frames.push({ t: Math.round(st.t), rms: rms, voiced: !!voiced });
      if (voiced) {
        st.rmsSum += rms;
        st.voicedFrames++;
        if (rms > st.rmsPeak) st.rmsPeak = rms;
      }
    }

    function startSegment() {
      // 进入 speech 时，把计数归零重新来 —— 开口前的 180ms 也属于这句话
      st.speechMs = st.aboveMs;
      st.silenceMs = 0;
      st.frames = [];
      st.rmsSum = 0;
      st.rmsPeak = 0;
      st.voicedFrames = 0;
      st.awaiting = false;
      st.endAtMs = cfg.endpointSilenceMs;
      st.phase = 'speech';
    }

    function resetSegment() {
      st.phase = 'idle';
      st.aboveMs = 0;
      st.speechMs = 0;
      st.silenceMs = 0;
      st.frames = [];
      st.rmsSum = 0;
      st.rmsPeak = 0;
      st.voicedFrames = 0;
      st.awaiting = false;
      st.endAtMs = cfg.endpointSilenceMs;
    }

    var api = {
      cfg: cfg,
      state: st,

      // 当前阈值（供 barge-in 复用）
      threshold: function () { return st.thr; },
      noiseFloor: function () { return st.noiseFloor; },
      phase: function () { return st.phase; },

      feed: function (rms, dtMs) {
        rms = num(rms, 0);
        var dt = Math.max(1, num(dtMs, 20));
        st.t += dt;

        if (st.phase === 'calibrate') {
          st.calibSum += rms;
          st.calibN++;
          if (rms > st.calibPeak) st.calibPeak = rms;
          if (st.calibN * dt >= cfg.calibrateMs) {
            var mean = st.calibSum / Math.max(1, st.calibN);
            st.noiseFloor = Math.max(cfg.absFloor, mean);
            recalcThr();
            st.phase = 'idle';
            st.aboveMs = 0;
          }
          return 'calibrating';
        }

        if (st.phase === 'idle') {
          // 静默期缓慢跟踪底噪（只降不升得太快，避免被环境噪声带跑）
          if (rms < st.thr) {
            st.noiseFloor = st.noiseFloor * 0.97 + rms * 0.03;
            if (st.noiseFloor < cfg.absFloor) st.noiseFloor = cfg.absFloor;
            recalcThr();
          }
          if (rms > st.thr) {
            st.aboveMs += dt;
            if (st.aboveMs >= cfg.speechOnMs) {
              startSegment();
              pushFrame(rms, true);
              return 'speech-start';
            }
          } else {
            st.aboveMs = 0;
          }
          return null;
        }

        // phase === 'speech'
        var voiced = rms > st.thr;
        pushFrame(rms, voiced);
        if (voiced) {
          st.speechMs += dt;
          st.silenceMs = 0;
          st.awaiting = false;
          st.endAtMs = Math.max(cfg.endpointSilenceMs, st.endAtMs);   // 重新开口后恢复基础端点
        } else {
          st.silenceMs += dt;
        }
        var totalMs = st.speechMs + st.silenceMs;

        if (totalMs >= cfg.maxUtteranceMs) return 'force-end';

        if (!st.awaiting && st.silenceMs >= st.endAtMs) {
          if (st.speechMs < cfg.minUtteranceMs) return 'discard';
          st.awaiting = true;
          return 'endpoint-candidate';
        }
        return null;
      },

      // 确认"说完了"：返回本段统计
      confirmEnd: function () {
        var total = st.speechMs + st.silenceMs;
        var out = {
          speechMs: Math.round(st.speechMs),
          totalMs: Math.round(total),
          silenceMs: Math.round(st.silenceMs),
          frames: st.frames.slice(),
          noiseFloor: st.noiseFloor,
          thr: st.thr,
          rmsSum: st.rmsSum,
          rmsPeak: st.rmsPeak,
          voicedFrames: st.voicedFrames,
          tooShort: st.speechMs < cfg.minUtteranceMs
        };
        resetSegment();
        return out;
      },

      // 只是短暂停顿：再等 extraMs，然后重新判定
      continueWait: function (extraMs) {
        st.endAtMs = st.silenceMs + Math.max(120, num(extraMs, 400));
        st.awaiting = false;
        return st.endAtMs;
      },

      // 强制切（超过 maxUtteranceMs）
      forceEnd: function () { return api.confirmEnd(); },

      reset: function () { resetSegment(); },

      // 供 barge-in 用：只喂能量，不推进语句状态
      peekThreshold: function () { return st.thr; }
    };
    return api;
  }

  // =====================================================================================
  // 5. 副语言信号提取（契约 §3.3，纯逻辑，可测）
  // =====================================================================================
  // 设计：ASR 只给文本，声学特征必须自己算（实测 mimo-v2.5 读音频但不给声学特征）。
  //   这里全部在 16k 单声道 Int16 上算，帧长 20ms —— 与 VAD 的调度节奏一致。

  var SIGNAL_FRAME_MS = 20;
  var LONG_PAUSE_MS = 600;
  var PAUSE_MIN_MS = 120;

  // 自相关法基频：返回 Hz，或 0（无周期/静音）
  function pitchAutocorr(frame, sampleRate, minHz, maxHz) {
    var n = frame ? frame.length : 0;
    if (n < 64) return 0;
    var lo = Math.max(2, Math.floor(sampleRate / (maxHz || 400)));
    var hi = Math.min(n - 2, Math.ceil(sampleRate / (minHz || 70)));
    if (hi <= lo) return 0;

    // 去均值 + 算能量（自相关归一化用）
    var mean = 0, i, j;
    for (i = 0; i < n; i++) mean += frame[i];
    mean /= n;
    var energy = 0;
    for (i = 0; i < n; i++) { var d = frame[i] - mean; energy += d * d; }
    if (energy <= 1e-9) return 0;

    var best = 0, bestVal = 0;
    for (var lag = lo; lag <= hi; lag++) {
      var sum = 0, cnt = 0;
      for (j = 0; j + lag < n; j++) {
        sum += (frame[j] - mean) * (frame[j + lag] - mean);
        cnt++;
      }
      if (!cnt) continue;
      var norm = (sum / cnt) / (energy / n);
      if (norm > bestVal) { bestVal = norm; best = lag; }
    }
    if (bestVal < 0.3 || best === 0) return 0;   // 归一化自相关太低 → 认为是噪声
    return sampleRate / best;
  }

  // 主入口：从段 PCM 算 VOICE_SIGNALS
  // opts: {sampleRate, noiseFloor, onsetMs, thr}
  function computeSignals(pcmInt16, opts) {
    opts = opts || {};
    var rate = num(opts.sampleRate, CAPTURE_RATE);
    var n = pcmInt16 ? pcmInt16.length : 0;
    var frameLen = Math.max(1, Math.round(rate * SIGNAL_FRAME_MS / 1000));
    var totalMs = n ? Math.round(n / rate * 1000) : 0;
    var signals = {
      speechMs: 0, totalMs: totalMs, speechRatio: 0, pauses: [], longPauseCount: 0,
      rmsMean: 0, rmsPeak: 0, loudness: '低', voicedMs: 0,
      pitchMeanHz: 0, pitchStdHz: 0, pitchRangeSemitone: 0,
      speechRateCps: 0, trailingOff: false, onsetDelayMs: Math.round(num(opts.onsetMs, 0)),
      startEnergyJump: 1, clipping: false, snrDb: 0
    };
    if (!n) return signals;

    // ---- 逐帧能量 ----
    var frames = [];
    var i;
    for (i = 0; i + frameLen <= n; i += frameLen) {
      var sum = 0, peak = 0;
      for (var k = 0; k < frameLen; k++) {
        var s = pcmInt16[i + k] / 32768;
        sum += s * s;
        var a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
      frames.push({ t: Math.round(i / rate * 1000), rms: Math.sqrt(sum / frameLen), peak: peak });
    }
    if (!frames.length) return signals;

    var rmsVals = frames.map(function (f) { return f.rms; });
    var sorted = rmsVals.slice().sort(function (a, b) { return a - b; });
    // 底噪：优先用调用方给的（VAD 标定过），否则取 20 分位
    var noiseFloor = num(opts.noiseFloor, sorted[Math.floor(sorted.length * 0.2)] || 0.002);
    if (!(noiseFloor > 0)) noiseFloor = 0.002;
    var thr = num(opts.thr, noiseFloor * 2.2);

    var clipped = 0;
    for (i = 0; i < frames.length; i++) if (frames[i].peak >= 0.985) clipped++;

    // ---- 有声/停顿 ----
    var voicedFrames = 0, rmsSum = 0, rmsPeak = 0;
    var pauses = [], runStart = -1;
    for (i = 0; i < frames.length; i++) {
      var voiced = frames[i].rms > thr;
      if (voiced) {
        voicedFrames++;
        rmsSum += frames[i].rms;
        if (frames[i].rms > rmsPeak) rmsPeak = frames[i].rms;
        if (runStart >= 0) {
          var gapMs = frames[i].t - runStart;
          if (gapMs >= PAUSE_MIN_MS) {
            var rec = { at: runStart, ms: gapMs };
            pauses.push(rec);
            if (gapMs >= LONG_PAUSE_MS) signals.longPauseCount++;
          }
          runStart = -1;
        }
      } else if (runStart < 0) {
        runStart = frames[i].t;
      }
    }

    var voicedMs = Math.round(voicedFrames * SIGNAL_FRAME_MS);
    signals.voicedMs = voicedMs;
    signals.speechMs = voicedMs;
    signals.speechRatio = totalMs > 0 ? Math.round(voicedMs / totalMs * 100) / 100 : 0;
    signals.pauses = pauses;
    signals.rmsMean = voicedFrames ? rmsSum / voicedFrames : 0;
    signals.rmsPeak = rmsPeak;
    signals.clipping = clipped > Math.max(2, frames.length * 0.02);

    // ---- 响度分档 ----
    var m = signals.rmsMean;
    signals.loudness = m < 0.045 ? '低' : (m > 0.16 ? '高' : '中');

    // ---- 信噪比 ----
    signals.snrDb = Math.round(toDb(signals.rmsMean / noiseFloor) * 10) / 10;

    // ---- 基频（自相关）----
    var pitchFrame = Math.max(64, Math.round(rate * 0.04));   // 40ms 窗
    var pitches = [];
    for (i = 0; i + pitchFrame <= n; i += pitchFrame) {
      var seg = new Float32Array(pitchFrame);
      var segSum = 0;
      for (var q = 0; q < pitchFrame; q++) { seg[q] = pcmInt16[i + q] / 32768; segSum += seg[q] * seg[q]; }
      if (Math.sqrt(segSum / pitchFrame) <= thr) continue;    // 静音/噪声段不算基频
      var hz = pitchAutocorr(seg, rate, 70, 400);
      if (hz > 0) pitches.push(hz);
    }
    if (pitches.length) {
      var psum = 0;
      for (i = 0; i < pitches.length; i++) psum += pitches[i];
      var pmean = psum / pitches.length;
      var vsum = 0;
      for (i = 0; i < pitches.length; i++) { var dd = pitches[i] - pmean; vsum += dd * dd; }
      var pstd = Math.sqrt(vsum / pitches.length);
      var pmin = Math.min.apply(null, pitches), pmax = Math.max.apply(null, pitches);
      signals.pitchMeanHz = Math.round(pmean);
      signals.pitchStdHz = Math.round(pstd);
      // 半音跨度：12 * log2(max/min)
      signals.pitchRangeSemitone = pmin > 0 ? Math.round(12 * Math.log(pmax / pmin) / Math.LN2 * 10) / 10 : 0;
    }

    // ---- 句尾拖垮（犹豫/泄气）----
    if (voicedFrames >= 8) {
      var tailLen = Math.max(3, Math.round(200 / SIGNAL_FRAME_MS));
      var headLen = Math.max(3, Math.round(600 / SIGNAL_FRAME_MS));
      var pick = function (arr, from, len) {
        var out = [];
        for (var x = from; x < arr.length && x < from + len; x++) if (arr[x].rms > thr) out.push(arr[x].rms);
        return out;
      };
      var tail = pick(frames, frames.length - tailLen, tailLen);
      var head = pick(frames, Math.max(0, frames.length - tailLen - headLen), headLen);
      var avg = function (a) { if (!a.length) return 0; var s2 = 0; for (var y = 0; y < a.length; y++) s2 += a[y]; return s2 / a.length; };
      var tAvg = avg(tail), hAvg = avg(head);
      signals.trailingOff = (hAvg > 0 && tAvg > 0 && tAvg < hAvg * 0.55);
    }

    // ---- 起始能量跃升 ----
    if (frames.length >= 3) {
      signals.startEnergyJump = noiseFloor > 0
        ? Math.round(Math.max(1.5, frames[0].rms / noiseFloor) * 10) / 10
        : 1;
    }
    return signals;
  }

  // 拿到转写后回填字速（纯函数，返回新的 signals）
  function attachTranscriptToSignals(signals, text) {
    if (!signals) return signals;
    var t = strOf(text).replace(/[\s，。！？、；：,.!?;:"'“”‘’（）()\[\]…—\-]/g, '');
    var seconds = Math.max(0.2, (signals.speechMs || 0) / 1000);
    signals.speechRateCps = t.length ? Math.round((t.length / seconds) * 10) / 10 : 0;
    return signals;
  }

  // =====================================================================================
  // 6. 句子切分（供 TTS 流水线；纯函数，可测）
  // =====================================================================================
  // 中文标点为主，兼容英文。第一次切分只在强边界处切；太长的句子再按逗号/长度软切，
  // 因为 TTS 首包时间与文本长度正相关，长句会拖慢首字。

  var HARD_BREAK = '。！？!?…\n';
  var SOFT_BREAK = '，,、；;：:—';
  var SOFT_MAX = 42;      // 软切后的目标长度

  function splitSentences(text, opts) {
    var s = strOf(text);
    var minLen = num(opts && opts.minLen, MIN_TTS_CHARS);
    var hard = [];
    var buf = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      buf += ch;
      if (HARD_BREAK.indexOf(ch) >= 0) {
        // 连续的 。！？… 归到同一句（"是吗？！" 不该被拆开）
        while (i + 1 < s.length && HARD_BREAK.indexOf(s.charAt(i + 1)) >= 0) { buf += s.charAt(++i); }
        // 收尾引号跟着走
        while (i + 1 < s.length && '”"’\')）】」'.indexOf(s.charAt(i + 1)) >= 0) { buf += s.charAt(++i); }
        hard.push(buf);
        buf = '';
      }
    }
    if (buf.trim()) hard.push(buf);

    var out = [];
    for (var j = 0; j < hard.length; j++) {
      var piece = hard[j];
      var trimmed = piece.trim();
      if (!trimmed) continue;
      if (trimmed.length <= SOFT_MAX) { out.push(trimmed); continue; }
      // 软切：按逗号类标点累积，不超 SOFT_MAX
      var acc = '', parts = [];
      for (var k = 0; k < piece.length; k++) {
        acc += piece.charAt(k);
        var isSoft = SOFT_BREAK.indexOf(piece.charAt(k)) >= 0;
        if ((isSoft && acc.length >= 12) || acc.length >= SOFT_MAX) {
          parts.push(acc.trim());
          acc = '';
        }
      }
      if (acc.trim()) parts.push(acc.trim());
      for (var p = 0; p < parts.length; p++) if (parts[p]) out.push(parts[p]);
    }
    // 合并过短的碎片（"嗯。" "啊。" 单独合成很浪费）
    var merged = [];
    for (var q = 0; q < out.length; q++) {
      if (merged.length && out[q].length < minLen) merged[merged.length - 1] += out[q];
      else merged.push(out[q]);
    }
    return merged.filter(function (x) { return x && x.length >= minLen; });
  }

  // =====================================================================================
  // 7. 流式 JSON 增量提取（关键性能路径，纯函数，可测）
  // =====================================================================================
  // 实测：DeepSeek json_object 模式是流式吐 JSON 文本，speech 通常是第一个字段。
  //   等整个 JSON 到齐 = 多等 300ms+；这里边收边抠，一旦出现句子边界立刻送出合成。
  //
  // 语义：push(delta) 返回「本次新增的、已经成句的文本数组」。
  //       最终完整 JSON 到达后，用 VoiceDirector.parseDirective 校正一次（见 runtime）。

  function jsonUnescape(raw) {
    var s = strOf(raw);
    if (s.indexOf('\\') < 0) return s;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch !== '\\') { out += ch; continue; }
      var nx = s.charAt(++i);
      switch (nx) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'u': {
          var hex = s.substr(i + 1, 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else { out += 'u'; }
          break;
        }
        default: out += nx; break;
      }
    }
    return out;
  }

  // 从（可能不完整的）JSON 文本里抠出 key 对应字符串值。返回 {value, closed}
  function extractJsonString(rawJson, key) {
    var s = strOf(rawJson);
    if (!s) return { value: '', closed: false };
    var needle = '"' + key + '"';
    var k = s.indexOf(needle);
    if (k < 0) return { value: '', closed: false };
    var i = k + needle.length;
    // 跳过空白找冒号
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    if (s.charAt(i) !== ':') return { value: '', closed: false };
    i++;
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    if (s.charAt(i) !== '"') return { value: '', closed: false };
    i++;
    var start = i;
    var escaped = false;
    for (; i < s.length; i++) {
      var ch = s.charAt(i);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') return { value: jsonUnescape(s.slice(start, i)), closed: true };
    }
    return { value: jsonUnescape(s.slice(start, i)), closed: false };
  }

  // 增量句子提取器
  function createSpeechExtractor() {
    var st = { json: '', consumed: 0, emitted: [] };
    var api = {
      // 收一段 JSON 增量，返回本次新成句的文本
      push: function (delta) {
        if (!delta) return [];
        st.json += delta;
        var got = extractJsonString(st.json, 'speech');
        var full = got.value;
        var pending = full.slice(st.consumed);
        if (!pending) return [];
        var cut = -1;
        for (var i = 0; i < pending.length; i++) {
          if (HARD_BREAK.indexOf(pending.charAt(i)) >= 0) cut = i;
        }
        // 只有串已经闭合时，才把最后一段也当作完整句（否则等下一个边界）
        if (cut < 0) {
          if (!got.closed) return [];
          if (!pending.trim()) return [];
          st.consumed = full.length;
          return [pending.trim()];
        }
        var head = pending.slice(0, cut + 1);
        // 把紧跟的连标点一起吞掉
        var rest = pending.slice(cut + 1);
        var extra = 0;
        while (extra < rest.length && HARD_BREAK.indexOf(rest.charAt(extra)) >= 0) extra++;
        head += rest.slice(0, extra);
        st.consumed = full.length - rest.length + extra;
        var out = head.trim() ? [head.trim()] : [];
        return out;
      },
      // 收尾：把剩余没成句的尾巴也吐出来（只吐一次）
      flush: function () {
        var got = extractJsonString(st.json, 'speech');
        var rest = got.value.slice(st.consumed);
        st.consumed = got.value.length;
        rest = rest.trim();
        return rest ? [rest] : [];
      },
      speech: function () { return extractJsonString(st.json, 'speech').value; },
      raw: function () { return st.json; },
      reset: function () { st.json = ''; st.consumed = 0; st.emitted = []; }
    };
    return api;
  }

  // 从完整文本里抠第一句（brain 非流式兜底用）
  function firstSentence(text, maxLen) {
    var list = splitSentences(text, { minLen: 1 });
    if (list.length) return list[0];
    var s = strOf(text).trim();
    var cap = num(maxLen, MAX_TTS_CHARS);
    return s.length > cap ? s.slice(0, cap) : s;
  }

  // =====================================================================================
  // 8. 运行时状态容器
  // =====================================================================================

  var _vc = {
    state: 'idle',
    open: false,
    running: false,
    muted: false,
    stateEnteredAt: 0,
    startedAt: 0,
    lastTurnAt: 0,           // 上一轮开始的时刻（时间感知：大脑要知道"距上次说话多久"）
    callMarked: false,       // 本轮通话是否已写过"开始"标注（避免只写结束、留下孤立标注）
    turnId: 0,
    route: '',               // 当前音频路由缓存：'speaker' | 'headset'，见 currentRoute()
    routeAt: 0,

    // 音频
    audioCtx: null,          // 播放用的 AudioContext（24k 播放 / 也做采集解码）
    captureCtx: null,        // 采集专用（与播放分开，避免被打断逻辑影响）
    mediaStream: null,
    sourceNode: null,
    procNode: null,
    silentGain: null,
    resampler: null,
    vad: null,
    preroll: [],             // 最近 PREROLL_MS 的重采样样本（Int16 分块）
    segChunks: [],           // 当前这一段话语
    segSamples: 0,
    segOnsetMs: 0,
    lastFrameAt: 0,
    utterStartAt: 0,
    lastVoiceAt: 0,
    capturing: false,

    // 播放
    player: null,
    speaking: false,
    speakStartAt: 0,
    ttsChain: [],            // 待合成的句子（流水线）
    ttsActive: 0,
    ttsAbortGen: 0,

    // 打断
    bargeAboveMs: 0,
    leakRms: 0.01,
    interrupted: false,

    // 请求
    gate: null,              // 当前轮次的"放弃闸门"

    // 语气词预热
    fillerBuffers: [],
    fillerWarmToken: 0,

    // 指标
    metrics: { asrMs: 0, brainFirstTokenMs: 0, ttsFirstChunkMs: 0, turnTotalMs: 0, turns: 0, lastTurn: null },

    timerId: null,
    fillerTimer: null,
    autoHangTimer: null,
    signalHistory: []
  };

  // 会话上下文的快照（开始通话时抓一次；中途用户切走也能继续用）
  var _session = { convId: null, providerId: null, model: null };

  // =====================================================================================
  // 9. 安全访问全局（app.js / db.js / voice-director 都可能缺失或处于 TDZ）
  // =====================================================================================

  function S() {
    try { return (typeof settings !== 'undefined' && settings) ? settings : null; }
    catch (e) { return null; }
  }

  function ST() {
    try { return (typeof state !== 'undefined' && state) ? state : null; }
    catch (e) { return null; }
  }

  function voiceCfg() {
    var s = S();
    if (!s) return {};
    if (!s.voice || typeof s.voice !== 'object') {
      try {
        if (typeof defaultVoiceSettings === 'function') s.voice = defaultVoiceSettings();
        else s.voice = {};
      } catch (e) { s.voice = {}; }
    }
    return s.voice;
  }

  function cfgNum(key, dflt, lo, hi) {
    var v = voiceCfg()[key];
    var n = num(v, dflt);
    if (lo !== undefined) n = Math.max(lo, n);
    if (hi !== undefined) n = Math.min(hi, n);
    return n;
  }

  // 真机可调参数统一入口：读 settings.voice[key]，没有就用内置默认，并按 TUNING_RANGES 夹紧。
  //   范围夹紧很重要 —— 用户在设置面板填 30000 之类的值会把打断/端点彻底调死，
  //   到时候现象是"功能坏了"而不是"参数离谱"，排查成本极高。
  function tuning(key, dflt) {
    var range = TUNING_RANGES[key] || [undefined, undefined];
    return cfgNum(key, dflt, range[0], range[1]);
  }

  // ---- 音频路由（外放 / 耳机）----
  // 耳机和外放的声学环境差一个数量级：外放要用更大的防自激窗口、更钝的打断，
  //   耳机可以更灵敏。路由决定"用哪套预置"，所以必须先可靠地拿到当前路由。
  //   原生插件（AudioRoute）可能不存在、可能是异步的、也可能调用失败：
  //   三种情况都必须静默回落，绝不能让拿路由把通话搞挂。

  var ROUTE_TTL_MS = 4000;   // 插件查询结果的缓存时长（每块 PCM 都要读，不能每次都问原生）

  function normalizeRoute(v) {
    var s = strOf(v).toLowerCase();
    if (!s) return '';
    // earpiece（听筒）要当成外放，不能当耳机 —— 这一点真机实测过：
    //   原生插件在「没插任何耳机」的手机上会回报 earpiece（isSpeakerphoneOn() 默认 false
    //   + 手机确实有听筒硬件），但 WebView 的音频走的是 STREAM_MUSIC，
    //   没有耳机时是从**外放喇叭**出来的，不是听筒。
    //   若把 earpiece 归到耳机预设，正好把两套参数用反：外放回声大却用了灵敏的耳机参数，
    //   结果就是 AI 被自己的声音打断。听筒和外放在"麦克风会收到自己的声音"这件事上是一类的。
    if (s.indexOf('head') >= 0 || s.indexOf('blue') >= 0 ||
      s.indexOf('wired') >= 0 || s.indexOf('耳机') >= 0) return 'headset';
    if (s.indexOf('speaker') >= 0 || s.indexOf('loud') >= 0 || s.indexOf('外放') >= 0 ||
      s.indexOf('earpiece') >= 0 || s.indexOf('听筒') >= 0) return 'speaker';
    return '';
  }

  // 原生插件返回 { type, name }（Android 侧 AudioRoutePlugin 的契约），
  //   也可能只有字符串；统一抠出"能判断类型"的那个值
  function routeValueOf(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v !== 'object') return '';
    return v.route || v.value || v.type || v.name || '';
  }

  // 手动指定值（routeMode = speaker / headset 时）
  function manualRoute() {
    try {
      var m = strOf(voiceCfg().routeMode).toLowerCase();
      if (m === 'speaker' || m === 'headset') return m;
    } catch (e) {}
    return '';
  }

  function applyRoute(v) {
    var nr = normalizeRoute(v);
    if (!nr) return '';
    _vc.route = nr;
    _vc.routeAt = nowMs();
    return nr;
  }

  // 当前路由：原生插件 > routeMode 手动值 > speaker
  //   插件是异步的（Capacitor 都是 Promise）：同步路径先返回已知值/手动值，
  //   结果回来后写进缓存，下一次读取（下一块 PCM / 下一轮）就生效。
  function currentRoute() {
    var manual = manualRoute();
    try {
      var plugins = (root.Capacitor && root.Capacitor.Plugins) ? root.Capacitor.Plugins : null;
      var ar = plugins && plugins.AudioRoute;
      if (ar && typeof ar.getRoute === 'function') {
        var fresh = _vc.route && (nowMs() - (_vc.routeAt || 0)) < ROUTE_TTL_MS;
        if (fresh) return _vc.route;
        var res = ar.getRoute();
        if (res && typeof res.then === 'function') {
          try {
            res.then(function (r) { applyRoute(routeValueOf(r)); }, function () {});
          } catch (e) {}
        } else {
          var got = applyRoute(routeValueOf(res));
          if (got) return got;
        }
        if (_vc.route && (nowMs() - (_vc.routeAt || 0)) < ROUTE_TTL_MS) return _vc.route;
      }
    } catch (e) { /* 静默：插件失败等同于"拿不到" */ }
    if (manual) return manual;
    return _vc.route || 'speaker';
  }

  // 插件的路由变化事件：只更新缓存，不打断正在进行的通话
  //   （barge-in 参数是每块 PCM 读一次的，VAD 参数在每次开麦时读，下一次读取自然生效）
  var _routeHooked = false;
  function hookRouteChange() {
    if (_routeHooked) return;
    try {
      var plugins = (root.Capacitor && root.Capacitor.Plugins) ? root.Capacitor.Plugins : null;
      var ar = plugins && plugins.AudioRoute;
      if (!ar || typeof ar.addListener !== 'function') return;
      var handle = ar.addListener('routeChange', function (info) {
        try {
          if (applyRoute(routeValueOf(info))) refreshLiveTuning();
        } catch (e) {}
      });
      if (handle && typeof handle.catch === 'function') handle.catch(function () {});
      // 开拨前先问一次：插件是异步的，等第一块 PCM 到来时缓存里就有真实路由了
      try {
        var probe = ar.getRoute();
        if (probe && typeof probe.then === 'function') {
          probe.then(function (r) { applyRoute(routeValueOf(r)); }, function () {});
        } else {
          applyRoute(routeValueOf(probe));
        }
      } catch (e) {}
      _routeHooked = true;
    } catch (e) { /* 没有插件就没有事件 */ }
  }

  // 路由变了：把 VAD 已经快照下来的参数换成新预置
  //   （barge-in 那几项本来就是每块 PCM 读一次，不需要这里管；正在进行的这一句话也不打断）
  function refreshLiveTuning() {
    try {
      var vad = _vc.vad;
      if (!vad || !vad.cfg) return;
      vad.cfg.endpointSilenceMs = effectiveTuning('endpointSilenceMs', VAD_DEFAULTS.endpointSilenceMs);
      vad.cfg.minUtteranceMs = effectiveTuning('minUtteranceMs', VAD_DEFAULTS.minUtteranceMs);
    } catch (e) {}
  }

  // 生效参数 = settings.voice[key] 打底 + 当前路由预置覆盖
  //   预置里只存"用户改过的项"，所以只能逐项覆盖；非法值（非数字/越界）忽略 ——
  //   设置面板是自由输入，写错一个字符就会把打断阈值变成 NaN，现象是"功能突然坏了"。
  function effectiveTuning(key, dflt) {
    var range = TUNING_RANGES[key] || [undefined, undefined];
    var base = cfgNum(key, dflt, range[0], range[1]);
    var preset = null;
    try {
      var presets = voiceCfg().tuningPresets;
      if (presets && typeof presets === 'object') preset = presets[currentRoute()];
    } catch (e) { preset = null; }
    if (!preset || typeof preset !== 'object') return base;
    if (!Object.prototype.hasOwnProperty.call(preset, key)) return base;

    // 优先用通话层的统一合并器：它按 TUNING_KEYS 认识每个键的合法范围，
    //   超出范围的预置值直接忽略（保住 base），比本地夹紧更不容易把功能调死。
    try {
      var PD = root.VoiceDirector;
      if (PD && typeof PD.resolveTuning === 'function') {
        var baseObj = {};
        baseObj[key] = base;
        var merged = PD.resolveTuning(baseObj, preset);
        if (merged && typeof merged === 'object' && Object.prototype.hasOwnProperty.call(merged, key)) {
          var mv = merged[key];
          if (typeof mv === 'number' && isFinite(mv)) return mv;
        }
        return base;
      }
    } catch (e) { /* 合并器坏了就自己合并 */ }

    // 本地兜底：非数字或越界一律忽略
    var pv = preset[key];
    var pn = (typeof pv === 'number') ? pv : parseFloat(pv);
    if (!isFinite(pn)) return base;
    if (range[0] !== undefined && pn < range[0]) return base;
    if (range[1] !== undefined && pn > range[1]) return base;
    return pn;
  }

  function toast(msg, type) {
    try { if (typeof showToast === 'function') showToast(msg, type || 'info'); } catch (e) {}
  }

  function log() {
    try {
      var args = ['[voice]'].concat(copyArray(arguments));
      console.log.apply(console, args);
    } catch (e) {}
  }

  function warn() {
    try {
      var args = ['[voice]'].concat(copyArray(arguments));
      console.warn.apply(console, args);
    } catch (e) {}
  }

  // 通话振感：只有三处 —— 接通、被打断、挂断。
  //   读 settings.voice.haptic（db.js defaultVoiceSettings 定义，默认 true），
  //   === false 时全部关掉；字段缺失按"开"处理（与 db 默认值一致）。
  //   三层兜底：Capacitor.Plugins.Haptics → navigator.vibrate → 静默失败。
  //   注意 WebView 里 navigator.vibrate 往往被禁用，所以 APK 必须走原生插件。
  var HAPTIC_PATTERNS = {
    connect: { style: 'LIGHT', ms: 12 },    // 接通：最轻，只是"我在这儿"
    bargein: { style: 'MEDIUM', ms: 26 },   // 被打断：干脆一下，反馈"听到了，别说了停"
    hangup: { style: 'LIGHT', ms: [14, 40, 14] }  // 挂断：两下轻点，收束感
  };

  function hapticEnabled() {
    try {
      var cfg = voiceCfg();
      // 只认 haptic（单数，db.js 的字段名）；haptics 是早期笔误，兼容保留
      if (cfg.haptic === false) return false;
      if (cfg.haptic === undefined && cfg.haptics === false) return false;
      return true;
    } catch (e) { return true; }
  }

  function haptic(kind) {
    if (!hapticEnabled()) return false;
    var pat = HAPTIC_PATTERNS[kind] || HAPTIC_PATTERNS.connect;
    try {
      // ① Capacitor 原生 Haptics（APK 主路径）
      var plugins = (root.Capacitor && root.Capacitor.Plugins) ? root.Capacitor.Plugins : null;
      var CapH = (typeof CapHaptics !== 'undefined' && CapHaptics) ? CapHaptics : (plugins && plugins.Haptics);
      if (CapH && typeof CapH.impact === 'function') {
        var r = CapH.impact({ style: pat.style });
        if (r && typeof r.catch === 'function') r.catch(function () {});
        return true;
      }
      // ② 浏览器/WebView 的 vibrate
      if (root.navigator && typeof root.navigator.vibrate === 'function') {
        root.navigator.vibrate(pat.ms);
        return true;
      }
    } catch (e) { /* 静默：振感失败绝不能影响通话 */ }
    return false;
  }

  function el(id) {
    try {
      if (typeof document === 'undefined' || !document.getElementById) return null;
      return document.getElementById(id);
    } catch (e) { return null; }
  }

  function saveConvSafe() {
    try { if (typeof save === 'function') save(); } catch (e) { warn('save failed', e); }
  }

  function renderSafe() {
    try { if (typeof renderMessages === 'function') renderMessages(); } catch (e) { warn('render failed', e); }
  }

  function currentConvSafe() {
    try {
      if (typeof currentConv === 'function') return currentConv();
    } catch (e) {}
    return null;
  }

  // =====================================================================================
  // 10. 渠道解析（settings.voice.*ProviderId → 可用 provider；空串走内置直连）
  // =====================================================================================

  var MIMO_BASE = 'https://api.xiaomimimo.com';
  var MIMO_EP = '/v1/chat/completions';
  var DEEPSEEK_BASE = 'https://api.deepseek.com';
  var DEEPSEEK_EP = '/v1/chat/completions';

  function providersList() {
    try {
      var st = ST();
      return (st && Array.isArray(st.providers)) ? st.providers : [];
    } catch (e) { return []; }
  }

  function findProviderById(id) {
    if (!id) return null;
    try {
      if (typeof getProvider === 'function') {
        var p = getProvider(id);
        if (p) return p;
      }
    } catch (e) {}
    var list = providersList();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  // 在用户的渠道里找"像 MiMo 的"（名字/地址/模型名任一命中）
  function findMimoProvider() {
    var list = providersList();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      var hay = (strOf(p.name) + ' ' + strOf(p.baseUrl) + ' ' +
        (p.models || []).map(function (m) { return strOf(m && m.id); }).join(' ')).toLowerCase();
      if (hay.indexOf('mimo') >= 0 || hay.indexOf('xiaomi') >= 0 || hay.indexOf('小米') >= 0) return p;
    }
    return null;
  }

  function findDeepSeekProvider() {
    var list = providersList();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      var hay = (strOf(p.name) + ' ' + strOf(p.baseUrl) + ' ' +
        (p.models || []).map(function (m) { return strOf(m && m.id); }).join(' ')).toLowerCase();
      if (hay.indexOf('deepseek') >= 0 || hay.indexOf('深度求索') >= 0) return p;
    }
    return null;
  }

  function legacyKey() {
    var s = S();
    return (s && typeof s.apiKey === 'string') ? s.apiKey.trim() : '';
  }

  function builtinProvider(kind) {
    // kind: 'mimo' | 'deepseek'
    if (kind === 'deepseek') {
      var ds = findDeepSeekProvider();
      if (ds && ds.apiKey) return { provider: ds, builtin: false };
      return {
        provider: {
          id: '__builtin_deepseek', name: '内置 DeepSeek', template: 'deepseek',
          baseUrl: DEEPSEEK_BASE, endpointPath: DEEPSEEK_EP,
          apiKey: legacyKey(), authType: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ',
          extraHeaders: {}, extraQuery: {}, models: [{ id: 'deepseek-chat' }]
        },
        builtin: true
      };
    }
    var mm = findMimoProvider();
    if (mm) return { provider: mm, builtin: false };
    return {
      provider: {
        id: '__builtin_mimo', name: '内置 MiMo', template: 'openai',
        baseUrl: MIMO_BASE, endpointPath: MIMO_EP,
        apiKey: legacyKey(), authType: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ',
        extraHeaders: {}, extraQuery: {}, models: [{ id: 'mimo-v2.5-tts' }, { id: 'mimo-v2.5-asr' }]
      },
      builtin: true
    };
  }

  // 通话所用的会话：优先用开拨时抓的快照（中途切走也能继续用同一套人设）
  function callConv() {
    var conv = getConvById(_session.convId);
    return conv || currentConvSafe();
  }

  // 大脑一律跟随当前会话的渠道 + 模型。
  //   为什么不再给大脑单独选渠道：通话必须和会话是同一个"人"，
  //   否则声音换了一个、人设还是另一套，用户第一时间就会觉得不对劲。
  function resolveBrainProvider() {
    var conv = callConv();
    var convProvider = conv ? findProviderById(conv.providerId) : null;
    if (convProvider && convProvider.apiKey && canBeBrain(convProvider)) {
      return {
        provider: convProvider,
        model: strOf(conv.model) || pickChatModel(convProvider) || defaultModelFor('brain', convProvider),
        label: convProvider.name || convProvider.id
      };
    }
    // 会话没配（或渠道不可用）：① DeepSeek 直连 ② 任意"能当大脑"的渠道
    var ds = builtinProvider('deepseek');
    if (ds.provider.apiKey) return { provider: ds.provider, model: 'deepseek-chat', label: ds.provider.name };
    var hero = providersList().filter(canBeBrain)[0];
    if (hero) {
      var heroModel = pickChatModel(hero);
      if (heroModel) return { provider: hero, model: heroModel, label: hero.name || hero.id };
    }
    throw makeErr('没有可用的大模型渠道：请先在设置里添加接口（通话的大脑跟随当前会话）', 'voice_nokey');
  }

  // kind: 'asr' | 'tts' | 'brain' → { provider, model, label }
  //
  // v127 重要变更：ASR / TTS 只用「语音接口」（settings.voice.voiceProviders），
  //   **不再复用「接口管理」里的聊天渠道**。
  //   为什么必须分开：聊天渠道的 baseUrl 指向文本网关（如 token-plan-cn.xiaomimimo.com），
  //   那个网关只认自己的密钥前缀，拿它发 asr/tts 必然 401 —— 用户实测就是这个报错。
  //   而且聊天渠道的模型目录里全是文本模型，把 mimo-v2.5-asr 硬塞进去也发不对地址。
  function resolveVoiceProvider(kind) {
    var cfg = voiceCfg();
    if (kind === 'brain') return resolveBrainProvider();

    var modelKey = kind === 'asr' ? 'asrModel' : 'ttsModel';
    var wantModel = strOf(cfg[modelKey]).trim();

    // ① 选定的语音接口
    var vp = pickVoiceProvider();
    if (vp) {
      if (!vp.apiKey) {
        throw makeErr('语音接口「' + (vp.name || vp.id) + '」还没填 API 密钥', 'voice_nokey');
      }
      if (!vp.baseUrl) {
        throw makeErr('语音接口「' + (vp.name || vp.id) + '」还没填接口地址', 'voice_provider');
      }
      // 模型优先用接口自己的配置，其次用全局设置里的
      var own = kind === 'asr' ? vp.asrModel : vp.ttsModel;
      var model = wantModel || strOf(own).trim() || defaultModelFor(kind, vp);
      return { provider: vp, model: model, label: vp.name || vp.id };
    }

    // ② 没有语音接口：明确告诉用户去配，不要偷偷拿聊天渠道顶
    throw makeErr('还没有配置语音接口：请在「设置 → 语音通话 → 语音接口」里添加一个（填地址和密钥）', 'voice_nokey');
  }

  // 当前使用的语音接口：voiceProviderId 指定的那个，否则第一个
  function pickVoiceProvider() {
    var cfg = voiceCfg();
    var list = Array.isArray(cfg.voiceProviders) ? cfg.voiceProviders : [];
    if (!list.length) return null;
    var wantId = strOf(cfg.voiceProviderId).trim();
    if (wantId) {
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === wantId) return list[i];
    }
    return list[0] || null;
  }

  function firstModel(p) {
    try {
      if (p && p.models && p.models.length) return p.models[0].id || p.models[0].name || '';
    } catch (e) {}
    return '';
  }

  // 大脑渠道不能拿语音模型硬顶：mimo-v2.5-asr / mimo-v2.5-tts 都不是聊天模型，
  //   真选上了运行时必然 400。这里优先挑"像聊天模型"的，实在没有就返回 ''。
  var AUDIO_MODEL_RE = /(^|[-_./])(asr|tts|whisper|audio|speech|transcri|embedding|embed|rerank|voicedesign|voiceclone)([-_./]|$)/i;
  var CHAT_MODEL_RE = /deepseek|gpt-|o[134]|claude|gemini|qwen|glm|moonshot|kimi|mistral|llama|chat|instruct|v4|v3/i;

  function isAudioModel(id) { return AUDIO_MODEL_RE.test(strOf(id)); }

  function pickChatModel(p) {
    var models = [];
    try { models = (p && p.models) ? p.models : []; } catch (e) { models = []; }
    var ids = models.map(function (m) { return strOf(m && (m.id || m.name)); }).filter(Boolean);
    var chat = ids.filter(function (id) { return !isAudioModel(id); });
    if (!chat.length) return '';
    var preferred = chat.filter(function (id) { return CHAT_MODEL_RE.test(id); });
    return preferred[0] || chat[0];
  }

  // 这个渠道能不能当"大脑"用（至少得有一个非音频模型）
  function canBeBrain(p) {
    if (!p || !p.apiKey) return false;
    var models = (p.models || []).map(function (m) { return strOf(m && (m.id || m.name)); }).filter(Boolean);
    if (!models.length) return true;   // 没填模型目录：允许（运行时再用会话模型兜底）
    return models.some(function (id) { return !isAudioModel(id); });
  }

  function defaultModelFor(kind, p) {
    if (kind === 'asr') return 'mimo-v2.5-asr';
    if (kind === 'tts') return 'mimo-v2.5-tts';
    return p ? (firstModel(p) || 'deepseek-chat') : 'deepseek-chat';
  }

  // 组请求（复用 providers.js 的 buildUpstreamPayload，不重复实现鉴权/额外头）
  function buildReq(kind, body) {
    var resolved = resolveVoiceProvider(kind);
    var provider = resolved.provider;
    var payload = Object.assign({}, body, { model: resolved.model });
    var req;
    try {
      if (typeof buildUpstreamPayload === 'function') {
        req = buildUpstreamPayload(provider, payload);
      } else {
        throw new Error('no buildUpstreamPayload');
      }
    } catch (e) {
      var base = strOf(provider.baseUrl).replace(/\/+$/, '');
      var ep = strOf(provider.endpointPath) || '/v1/chat/completions';
      req = {
        url: base + ep,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + strOf(provider.apiKey) },
        payload: payload
      };
    }
    return { req: req, provider: provider, model: resolved.model, label: resolved.label };
  }

  // =====================================================================================
  // 11. 请求工具：放弃闸门 + 超时（CapacitorHttp 的 POST 无法被 abort，只能放弃等待）
  // =====================================================================================

  function createGate() {
    var g = {
      aborted: false,
      waiters: [],
      abort: function (reason) {
        if (g.aborted) return;
        g.aborted = true;
        var ws = g.waiters.slice();
        g.waiters.length = 0;
        for (var i = 0; i < ws.length; i++) {
          try { ws[i](reason || abortErr()); } catch (e) {}
        }
      },
      // 把 promise 挂到闸门上：闸门一拉，立刻以 abort 结束（原 promise 继续在后台跑，结果丢弃）
      race: function (promise, timeoutMs, label) {
        return new Promise(function (resolve, reject) {
          var settled = false;
          var timer = null;
          function finish(fn, arg) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            var idx = g.waiters.indexOf(onAbort);
            if (idx >= 0) g.waiters.splice(idx, 1);
            fn(arg);
          }
          function onAbort(reason) { finish(reject, reason); }
          if (g.aborted) { finish(reject, abortErr()); return; }
          g.waiters.push(onAbort);
          if (timeoutMs > 0) {
            timer = setTimeout(function () {
              finish(reject, makeErr(label + '超时（已放弃等待）', 'voice_timeout'));
            }, timeoutMs);
          }
          promise.then(function (v) { finish(resolve, v); },
                       function (e) { finish(reject, e); });
        });
      }
    };
    return g;
  }

  // 独立的一次性超时（不挂闸门）
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(makeErr(label + '超时（已放弃等待）', 'voice_timeout'));
      }, ms);
      promise.then(function (v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
                   function (e) { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    });
  }

  function isNativeHttp() {
    try {
      if (typeof isCapacitor !== 'function' || !isCapacitor()) return false;
      return (typeof CapHttp !== 'undefined' && CapHttp && typeof CapHttp.request === 'function');
    } catch (e) { return false; }
  }

  function hasStreamHttp() {
    try {
      if (typeof isCapacitor !== 'function' || !isCapacitor()) return false;
      return (typeof CapStreamHttp !== 'undefined' && CapStreamHttp &&
        typeof CapStreamHttp.startStream === 'function' && typeof CapStreamHttp.addListener === 'function');
    } catch (e) { return false; }
  }

  // 非流式 POST，返回 {status, data}
  function httpPost(req, timeoutMs) {
    var body = JSON.stringify(req.payload);
    if (isNativeHttp()) {
      return withTimeout(CapHttp.request({
        method: 'POST',
        url: req.url,
        headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
        data: body,
        responseType: 'json',
        connectTimeout: T_CONNECT,
        readTimeout: Math.max(5000, timeoutMs || T_ASR)
      }), (timeoutMs || T_ASR) + 2000, '语音请求');
    }
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var p = root.fetch(req.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
      body: body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (resp) {
      return resp.text().then(function (txt) {
        var data = txt;
        try { data = JSON.parse(txt); } catch (e) {}
        return { status: resp.status, data: data, text: txt };
      });
    });
    return withTimeout(p, timeoutMs || T_ASR, '语音请求');
  }

  function errTextFrom(data) {
    try {
      if (!data) return '';
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return data.slice(0, 300); }
      }
      var e = data.error || data;
      if (typeof e === 'string') return e;
      return e.message || e.detail || (e.error && (e.error.message || e.error)) || JSON.stringify(e).slice(0, 300);
    } catch (x) { return ''; }
  }

  // 流式 POST：SSE 逐行回调
  // opts: { onDelta(text), onEnd(), gate, timeoutMs, label }
  function ssePost(req, opts) {
    opts = opts || {};
    var gate = opts.gate || createGate();
    var firstAt = 0;
    var startAt = nowMs();
    var lastDataAt = 0;
    var idleMs = opts.idleMs || T_BRAIN_IDLE;
    var sawData = false;
    var rawText = '';

    function emit(delta) {
      if (delta) {
        sawData = true;
        if (!firstAt) firstAt = nowMs();
        if (opts.onDelta) { try { opts.onDelta(delta); } catch (e) { warn('onDelta', e); } }
      }
      lastDataAt = nowMs();
    }

    // 把一个 SSE 事件交给调用方（TTS 要从 delta.audio 里取音频）
    function emitChoice(choice, delta) {
      if (opts.onJson) { try { opts.onJson(choice, delta); } catch (e) { warn('onJson', e); } }
    }

    return new Promise(function (resolve, reject) {
      var settled = false;
      var idleTimer = null;
      var cleanup = null;

      function done(err) {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (cleanup) { try { cleanup(); } catch (e) {} }
        if (err) reject(err); else resolve({ text: rawText, firstAt: firstAt, startAt: startAt });
      }

      function resetIdle() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          done(makeErr('语音大脑长时间没有响应，已放弃等待', 'voice_timeout'));
        }, idleMs);
      }

      if (gate.aborted) { done(abortErr()); return; }
      var onAbort = function () { done(abortErr()); };
      gate.waiters.push(onAbort);
      var prevCleanup = null;

      resetIdle();

      function consumeLine(line) {
        if (!line) return;
        if (line.charAt(0) === ':') return;
        if (line.indexOf('data:') !== 0) return;
        var jsonStr = line.slice(5).trim();
        if (jsonStr === '[DONE]') return;
        try {
          var j = JSON.parse(jsonStr);
          var ch = j.choices && j.choices[0];
          if (!ch) return;
          var d = ch.delta || ch.message;
          emitChoice(ch, d);
          if (!d) return;
          var txt = d.content;
          if (typeof txt === 'string' && txt) { rawText += txt; emit(txt); }
        } catch (e) { /* 半行/非标准事件忽略 */ }
      }

      function finishAll() {
        // 有些中转忽略 stream:true，整段返回普通 JSON —— 兜底抠正文
        if (!sawData && rawText) {
          try {
            var j = JSON.parse(rawText);
            var c = j && j.choices && j.choices[0];
            var msg = c && (c.message || c.delta);
            if (msg && msg.content) emit(msg.content);
          } catch (e) {}
        }
        done(null);
      }

      try {
        if (hasStreamHttp()) {
          var streamId = null;
          var buf = '';
          var early = [];
          var listeners = [];
          cleanup = function () {
            for (var i = 0; i < listeners.length; i++) { try { listeners[i].remove && listeners[i].remove(); } catch (e) {} }
            try { if (streamId) CapStreamHttp.cancelStream({ id: streamId }); } catch (e) {}
            var idx = gate.waiters.indexOf(onAbort);
            if (idx >= 0) gate.waiters.splice(idx, 1);
          };
          var onChunk = function (data) {
            if (streamId !== null && data && data.id && data.id !== streamId) return;
            if (streamId === null) { early.push(data); return; }
            resetIdle();
            buf += strOf(data && data.chunk);
            var lines = buf.split('\n');
            buf = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var ln = lines[i];
              if (ln && ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
              consumeLine(ln);
            }
          };
          var onEnd = function (data) {
            if (streamId !== null && data && data.id && data.id !== streamId) return;
            if (buf) { consumeLine(buf.replace(/\r$/, '')); buf = ''; }
            finishAll();
          };
          var onErr = function (data) {
            if (streamId !== null && data && data.id && data.id !== streamId) return;
            done(makeErr('流式请求失败：' + errTextFrom(data && data.error), 'voice_stream'));
          };
          Promise.resolve(CapStreamHttp.addListener('chunk', onChunk)).then(function (h) { if (h) listeners.push(h); });
          Promise.resolve(CapStreamHttp.addListener('end', onEnd)).then(function (h) { if (h) listeners.push(h); });
          Promise.resolve(CapStreamHttp.addListener('error', onErr)).then(function (h) { if (h) listeners.push(h); });
          var payload = Object.assign({}, req.payload, { stream: true });
          CapStreamHttp.startStream({
            url: req.url,
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}),
            body: JSON.stringify(payload),
            readTimeoutMs: idleMs + 15000,
            connectTimeoutMs: T_CONNECT
          }).then(function (res) {
            streamId = res && res.id;
            if (early.length) {
              var q = early.splice(0, early.length);
              for (var i = 0; i < q.length; i++) onChunk(q[i]);
            }
          }).catch(function (e) { done(makeErr('无法开始流式请求：' + (e && e.message || e), 'voice_stream')); });
          return;
        }

        // Web：fetch + ReadableStream
        var ctrl = null;
        try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
        cleanup = function () {
          try { if (ctrl) ctrl.abort(); } catch (e) {}
          var idx = gate.waiters.indexOf(onAbort);
          if (idx >= 0) gate.waiters.splice(idx, 1);
        };
        var payload2 = Object.assign({}, req.payload, { stream: true });
        root.fetch(req.url, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }, req.headers || {}),
          body: JSON.stringify(payload2),
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (resp) {
          if (!resp.ok) {
            return resp.text().then(function (t) {
              done(makeErr('HTTP ' + resp.status + '：' + errTextFrom(t), 'voice_http'));
            });
          }
          if (!resp.body || !resp.body.getReader) {
            return resp.text().then(function (t) { rawText += t; finishAll(); });
          }
          var reader = resp.body.getReader();
          var decoder = new TextDecoder();
          var buf2 = '';
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) { if (buf2) consumeLine(buf2.replace(/\r$/, '')); finishAll(); return; }
              resetIdle();
              buf2 += decoder.decode(r.value, { stream: true });
              var lines = buf2.split('\n');
              buf2 = lines.pop() || '';
              for (var i = 0; i < lines.length; i++) {
                var ln = lines[i];
                if (ln && ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
                consumeLine(ln);
              }
              return pump();
            });
          }
          return pump();
        }).catch(function (e) {
          if (isAbort(e)) return;
          done(makeErr('请求失败：' + (e && e.message || e), 'voice_network'));
        });
      } catch (e) {
        done(makeErr('请求异常：' + (e && e.message || e), 'voice_exception'));
      }
    });
  }
  // =====================================================================================
  // 12. 播放器：AudioContext 手动排期（按采样数精确排，无缝衔接）
  // =====================================================================================

  // 播放器是懒创建的：第一次进入通话时挂到 _vc.audioCtx 上。幂等，重复调用无副作用。
  function ensurePlayer() {
    var ctx = ensureAudioCtx();
    if (!_vc.player) {
      _vc.player = createPlayer();
      _vc.player.attach(ctx);
      _vc.player.resetStream();
      log('播放器就绪', ctx.sampleRate + 'Hz');
    }
    return _vc.player;
  }

  function ensureAudioCtx() {
    if (_vc.audioCtx) return _vc.audioCtx;
    try {
      var Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) throw makeErr('当前环境不支持 AudioContext', 'voice_noaudio');
      _vc.audioCtx = new Ctor();
    } catch (e) {
      throw makeErr('无法创建音频上下文：' + (e && e.message || e), 'voice_noaudio');
    }
    return _vc.audioCtx;
  }

  function createPlayer() {
    var p = {
      ctx: null,
      dest: null,
      nextTime: 0,
      active: 0,
      killed: false,
      drainTimer: null,
      onDrained: null,
      resampler: null,
      rate: 1,             // 配置里的语速（0.6~1.6），保留给调试/展示
      rateMode: 'natural',
      playRate: 1,         // 真正交给 playbackRate 的倍数：natural 恒为 1（变速交给 WSOLA）
      stretcher: null,
      scheduledMs: 0,
      startedAtMs: 0
    };

    // 语速每块 PCM 读一次：设置里改完，下一块就生效，不用打断当前这句
    p.syncRate = function () {
      var cfg = {};
      try { cfg = voiceCfg() || {}; } catch (e) { cfg = {}; }
      var r = clampRate(cfg.rate);
      var mode = (strOf(cfg.rateMode) === 'pitch') ? 'pitch' : 'natural';
      p.rate = r;
      p.rateMode = mode;
      p.playRate = (mode === 'pitch') ? r : 1;
      if (mode === 'pitch' || r === 1) {
        p.stretcher = null;          // 1× 直通 / pitch 模式不用伸缩器
      } else if (!p.stretcher) {
        p.stretcher = makeTimeStretcher(r, TTS_RATE);
      } else {
        p.stretcher.setRate(r);
      }
    };

    function finishDrain() {
      if (p.active > 0) return;
      if (p.drainTimer) { clearTimeout(p.drainTimer); p.drainTimer = null; }
      var cb = p.onDrained;
      p.onDrained = null;
      if (cb) { try { cb(); } catch (e) { warn('onDrained', e); } }
    }

    p.attach = function (ctx) {
      p.ctx = ctx;
      p.dest = ctx.destination;
      try { p.syncRate(); } catch (e) { p.rate = 1; p.rateMode = 'natural'; p.playRate = 1; p.stretcher = null; }
    };

    p.resetStream = function () {
      var ctx = p.ctx;
      p.resampler = ctx ? new Resampler(TTS_RATE, ctx.sampleRate) : null;
      p.stretcher = null;   // 新的流：丢掉上一段残留相位，避免跨句拼接出咔哒
    };

    function pushFloat(out) {
      if (!p.ctx || !out || !out.length) return;
      var buf;
      try {
        buf = p.ctx.createBuffer(1, out.length, p.ctx.sampleRate);
        buf.getChannelData(0).set(out);
      } catch (e) { warn('createBuffer failed', e); return; }
      p.appendBuffer(buf);
    }

    // 24k 裸 PCM（Int16）→ 追加到播放排期
    p.appendPcm24 = function (bytes) {
      if (!p.ctx || !bytes || !bytes.length) return;
      if (!p.resampler) p.resetStream();
      var i16 = bytesToInt16(bytes);
      if (!i16.length) return;
      var f32 = int16ToFloat32(i16);
      try { p.syncRate(); } catch (e) { p.rate = 1; p.rateMode = 'natural'; p.playRate = 1; p.stretcher = null; }
      // 先做保音高伸缩，再重采样到设备采样率（WSOLA 按 24k 参数标定）
      if (p.rateMode === 'natural' && p.stretcher) {
        try { f32 = p.stretcher.process(f32); }
        catch (e) { warn('time-stretch failed', e); p.stretcher = null; }
      }
      if (!f32 || !f32.length) return;
      pushFloat(p.resampler.process(f32));
    };

    // 一句话的 PCM 到头了：把 WSOLA 里滞留的尾巴吐出来，否则每句都会丢掉最后几十毫秒
    p.flushStretch = function () {
      if (!p.stretcher || p.rateMode !== 'natural' || !p.resampler) return;
      var tail = null;
      try { tail = p.stretcher.flush(); } catch (e) { tail = null; }
      if (!tail || !tail.length) return;
      pushFloat(p.resampler.process(tail));
    };

    // 记录所有在播 source，打断时逐个 stop（用 gain 静音会有 ~1 帧延迟且恢复麻烦）
    var live = [];
    p.appendBuffer = function (buf) {
      if (!p.ctx || !buf) return;
      var ctx = p.ctx;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
      var now = ctx.currentTime;
      // natural 模式下 playRate 恒为 1（时长已在 WSOLA 里改过），pitch 模式才交给 playbackRate
      var pr = (p.playRate && p.playRate > 0) ? p.playRate : 1;
      var dur = buf.duration / pr;
      var at = Math.max(p.nextTime, now + SCHEDULE_LEAD);
      var src;
      try { src = ctx.createBufferSource(); } catch (e) { warn('createBufferSource failed', e); return; }
      src.buffer = buf;
      if (pr !== 1) { try { src.playbackRate.value = pr; } catch (e) {} }
      try { src.connect(p.dest); } catch (e) { warn('connect failed', e); return; }
      p.nextTime = at + dur;
      p.scheduledMs += dur * 1000;
      p.active++;
      if (p.drainTimer) { clearTimeout(p.drainTimer); p.drainTimer = null; }
      var finished = false;
      var onEnd = function () {
        if (finished) return;
        finished = true;
        var ix = live.indexOf(src);
        if (ix >= 0) live.splice(ix, 1);
        p.active = Math.max(0, p.active - 1);
        try { src.disconnect(); } catch (e) {}
        if (p.active === 0) {
          if (p.drainTimer) clearTimeout(p.drainTimer);
          p.drainTimer = setTimeout(finishDrain, 160);
        }
      };
      src.onended = onEnd;
      live.push(src);
      try { src.start(at); } catch (e) { warn('start failed', e); onEnd(); }
    };

    p.hardStop = function () {
      var list = live.splice(0, live.length);
      for (var i = 0; i < list.length; i++) {
        try { list[i].onended = null; } catch (e) {}
        try { list[i].stop(0); } catch (e) {}
        try { list[i].disconnect(); } catch (e) {}
      }
      p.active = 0;
      p.nextTime = 0;
      p.scheduledMs = 0;
      if (p.drainTimer) { clearTimeout(p.drainTimer); p.drainTimer = null; }
      p.onDrained = null;
      p.resetStream();
    };

    p.isIdle = function () {
      if (!p.ctx) return true;
      return p.active <= 0;
    };

    p.remainingMs = function () {
      if (!p.ctx) return 0;
      return Math.max(0, (p.nextTime - p.ctx.currentTime) * 1000);
    };

    return p;
  }

  // =====================================================================================
  // 13. 麦克风采集 + VAD 驱动
  // =====================================================================================

  function describeMediaError(e) {
    var name = strOf(e && e.name);
    var msg = strOf(e && e.message);
    if (name === 'NotAllowedError' || name === 'SecurityError' || /Permission|denied/i.test(msg)) {
      return '麦克风权限被拒绝。请在系统设置里允许 chat-lite 使用麦克风，然后重试。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没有找到麦克风设备。请确认设备已连接（或插好耳机）。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麦克风被其它应用占用，或者系统无法读取。请关掉其它录音应用后重试。';
    }
    if (name === 'OverconstrainedError') {
      return '当前麦克风不支持所需的音频参数。已尝试降级，仍失败。';
    }
    if (name === 'AbortError') {
      return '麦克风启动被中断，请重试。';
    }
    if (!root.isSecureContext) {
      return '当前页面不是安全上下文（需要 https 或 http://127.0.0.1），浏览器不允许调用麦克风。';
    }
    if (!root.navigator || !root.navigator.mediaDevices || !root.navigator.mediaDevices.getUserMedia) {
      return '当前环境不支持麦克风采集（navigator.mediaDevices 不可用）。APK 需要 WebView 授权。';
    }
    return '无法启动麦克风：' + (msg || name || '未知错误');
  }

  function buildVadFromSettings() {
    var cfg = voiceCfg();
    var sensitivity = cfgNum('sensitivity', 0.5, 0, 1);
    return createVad({
      sensitivity: sensitivity,
      // VAD 参数在每次开麦时读一次：路由预置在这里生效（通话中改设置，下次开麦才换）
      endpointSilenceMs: effectiveTuning('endpointSilenceMs', VAD_DEFAULTS.endpointSilenceMs),
      minUtteranceMs: effectiveTuning('minUtteranceMs', VAD_DEFAULTS.minUtteranceMs),
      maxUtteranceMs: VAD_DEFAULTS.maxUtteranceMs,
      calibrateMs: VAD_DEFAULTS.calibrateMs,
      speechOnMs: VAD_DEFAULTS.speechOnMs,
      absFloor: VAD_DEFAULTS.absFloor
    });
  }

  // 必须在用户手势里同步调用（第一个 await 之前就拿到 getUserMedia 的 promise）
  function beginCapture() {
    var ctx = ensureAudioCtx();
    var md = root.navigator && root.navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      return Promise.reject(makeErr(
        root.isSecureContext === false
          ? '当前页面不是安全上下文（需要 https 或 http://127.0.0.1），浏览器不允许调用麦克风。'
          : '当前环境不支持麦克风采集（navigator.mediaDevices 不可用）。APK 需要 WebView 授权。',
        'voice_nomedia'));
    }
    // 手势内同步发起，之后才 await —— Android 15 上非手势触发会被直接拒
    var gp;
    try {
      gp = md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (e) {
      return Promise.reject(makeErr(describeMediaError(e), 'voice_media'));
    }
    try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}

    return gp.then(function (stream) {
      return attachStream(stream);
    }).catch(function (e) {
      throw makeErr(describeMediaError(e), 'voice_media');
    });
  }

  function attachStream(stream) {
    var ctx = _vc.audioCtx;
    _vc.mediaStream = stream;
    var track = stream.getAudioTracks && stream.getAudioTracks()[0];
    if (track) {
      // 真机 WebView 的 track.label 是空串，不要用它做任何判断/显示
      try {
        track.onended = function () {
          if (_vc.running) {
            toast('麦克风已断开', 'warn');
            setState('error', '麦克风已断开');
          }
        };
      } catch (e) {}
    }
    var src;
    try { src = ctx.createMediaStreamSource(stream); } catch (e) {
      throw makeErr('无法读取麦克风音频流：' + (e && e.message || e), 'voice_media');
    }
    var proc;
    try { proc = ctx.createScriptProcessor(SCRIPT_BUFFER, 1, 1); } catch (e) {
      try { proc = ctx.createJavaScriptNode(SCRIPT_BUFFER, 1, 1); } catch (e2) {
        throw makeErr('当前环境不支持音频采集节点', 'voice_noaudio');
      }
    }
    var mute;
    try {
      mute = ctx.createGain();
      mute.gain.value = 0;   // 不把自己的声音放出去（防啸叫）
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
    } catch (e) { warn('capture graph', e); }

    _vc.sourceNode = src;
    _vc.procNode = proc;
    _vc.silentGain = mute;
    _vc.capturing = true;
    _vc.resampler = new Resampler(ctx.sampleRate, CAPTURE_RATE);
    _vc.vad = buildVadFromSettings();
    _vc.preroll = [];
    _vc.prerollSamples = 0;
    _vc.segChunks = [];
    _vc.segSamples = 0;
    _vc.segOnsetMs = 0;
    _vc.bargeAboveMs = 0;
    _vc.lastFrameAt = 0;
    _vc.lastLevelAt = 0;

    proc.onaudioprocess = function (ev) {
      if (!_vc.capturing) return;
      var block = ev && ev.inputBuffer ? ev.inputBuffer.getChannelData(0) : null;
      if (!block) return;
      var t = nowMs();
      var dt = _vc.lastFrameAt ? (t - _vc.lastFrameAt) : (block.length / ctx.sampleRate * 1000);
      _vc.lastFrameAt = t;
      if (dt > 400) dt = 400;    // 主线程卡顿后的补偿上限
      handleCaptureBlock(block, dt);
    };
    return { stream: stream, ctx: ctx, sampleRate: ctx.sampleRate };
  }

  function handleCaptureBlock(block, dtMs) {
    var rms = frameRms(block);
    // 重采样到 16k 并转 Int16
    var rs = _vc.resampler;
    var res = rs ? rs.process(block) : null;
    var i16 = (res && res.length) ? floatToInt16(res) : null;

    // ---- 前摇缓冲（speech-start 之前的声音也要留下，否则会吞第一个字）----
    if (i16 && i16.length) {
      _vc.preroll.push(i16);
      _vc.prerollSamples = (_vc.prerollSamples || 0) + i16.length;
      var maxPre = Math.round(CAPTURE_RATE * PREROLL_MS / 1000);
      while (_vc.prerollSamples > maxPre && _vc.preroll.length > 1) {
        var drop = _vc.preroll.shift();
        _vc.prerollSamples -= drop.length;
      }
    }

    // ---- orb 电平：聆听/说话期间持续跟随麦克风（节流 ~60ms，避免每帧写 DOM）----
    if (_vc.state === 'listening' || _vc.state === 'speaking') {
      var tLv = nowMs();
      if (tLv - (_vc.lastLevelAt || 0) > 60) {
        _vc.lastLevelAt = tLv;
        updateOrbLevel(rms);
      }
    }

    // ---- barge-in：AI 说话时麦克风还在采 ----
    if (_vc.state === 'speaking' && voiceCfg().bargeIn !== false) {
      var sinceSpeak = nowMs() - _vc.speakStartAt;
      // 三个量都可在设置里调：抑制窗口 / 持续时长 / 回漏系数
      // 每块 PCM 读一次 → 外放/耳机预置切换后，下一块就按新参数判定，不影响这通电话
      var echoGuard = effectiveTuning('echoGuardMs', ECHO_GUARD_MS);
      var holdMs = effectiveTuning('bargeInHoldMs', BARGE_HOLD_MS);
      var leakFactor = effectiveTuning('bargeInLeakFactor', BARGE_LEAK_FACTOR);
      var leakFloor = effectiveTuning('leakFloor', BARGE_LEAK_FLOOR);
      var thrBarge = Math.max(_vc.leakRms * leakFactor, _vc.vad ? _vc.vad.threshold() * 1.15 : 0.02);
      if (sinceSpeak > echoGuard && rms > thrBarge) {
        _vc.bargeAboveMs += dtMs;
        if (_vc.bargeAboveMs >= holdMs) {
          _vc.bargeAboveMs = 0;
          doBargeIn();
        }
      } else {
        _vc.bargeAboveMs = Math.max(0, _vc.bargeAboveMs - dtMs * 0.5);
      }
      // 记录"自播放回漏"的能量水平，用来抬 barge-in 阈值
      if (sinceSpeak > echoGuard) {
        _vc.leakRms = _vc.leakRms * 0.95 + rms * 0.05;
        if (_vc.leakRms < leakFloor) _vc.leakRms = leakFloor;
      }
    } else {
      _vc.bargeAboveMs = 0;
    }

    // ---- VAD ----
    if (_vc.state !== 'listening' && _vc.state !== 'speaking') return;
    if (_vc.muted) return;
    var vad = _vc.vad;
    if (!vad) return;
    var evt = vad.feed(rms, dtMs);

    if (evt === 'speech-start') {
      _vc.segChunks = _vc.preroll.slice();
      _vc.segSamples = _vc.prerollSamples || 0;
      _vc.utterStartAt = nowMs();
      _vc.segOnsetMs = Math.round(_vc.prerollSamples / CAPTURE_RATE * 1000);
      updateOrbLevel(rms);
      if (_vc.state !== 'speaking') setState('listening');
      return;
    }

    if (_vc.vad.phase() === 'speech' && i16 && i16.length) {
      _vc.segChunks.push(i16);
      _vc.segSamples += i16.length;
    }

    if (evt === 'endpoint-candidate') {
      onEndpointCandidate();
    } else if (evt === 'force-end') {
      finishUtterance('force');
    } else if (evt === 'discard') {
      // 太短：丢弃，回到等下一句（绝不送 ASR，否则静音会被幻觉成文字）
      vad.reset();
      _vc.segChunks = [];
      _vc.segSamples = 0;
    }
  }

  // 端点候选：交给 VoiceDirector.turnPolicy 决定"真说完"还是"再等等"
  function onEndpointCandidate() {
    var stats = _vc.vad.confirmEnd();
    var text = '';
    try {
      var conv = currentConvSafe();
      var last = conv ? getActiveChain(conv).filter(function (m) { return m && m.role === 'user'; }).pop() : null;
      text = last ? strOf(last.content) : '';
    } catch (e) {}
    var signals = computeSignalsFromSeg(stats, text);
    var cfg = voiceCfg();
    var suggestion = adaptiveEndpoint(signals, cfg);
    var decision = null;
    try {
      var PD = root.VoiceDirector;
      if (PD && typeof PD.turnPolicy === 'function') {
        decision = PD.turnPolicy(
          { phase: 'user-paused', hasSpeech: true, endpointSilenceMs: _vc.vad.cfg.endpointSilenceMs },
          { signals: signals, silenceMs: stats.silenceMs, speechMs: stats.speechMs, speechRateCps: signals.speechRateCps },
          { endpointSilenceMs: effectiveTuning('endpointSilenceMs', 700), action: suggestion, minUtteranceMs: effectiveTuning('minUtteranceMs', 400) }
        );
      }
    } catch (e) { decision = null; }

    var action = decision && decision.action ? decision.action : suggestion;
    if (action === 'wait' || action === 'continue') {
      _vc.vad.continueWait(num(decision && decision.waitMs, suggestion === 'wait' ? 600 : 400));
      return;
    }
    finishUtterance('policy');
  }

  // 自适应端点：语速快、无长停顿、句尾拖垮 → 更早收
  function adaptiveEndpoint(signals, cfg) {
    var base = effectiveTuning('endpointSilenceMs', 700);
    var rate = num(signals && signals.speechRateCps, 0);
    var longPauses = num(signals && signals.longPauseCount, 0);
    var trailing = !!(signals && signals.trailingOff);
    if (trailing) return 'end';
    if (rate > 4.5 && longPauses === 0) return 'end';
    if (longPauses >= 2 || (rate > 0 && rate < 2.2)) return 'wait';
    return base > 900 ? 'wait' : 'end';
  }

  function computeSignalsFromSeg(stats, transcript) {
    var pcm = concatInt16(_vc.segChunks || []);
    var sig = computeSignals(pcm, {
      sampleRate: CAPTURE_RATE,
      noiseFloor: stats ? stats.noiseFloor : undefined,
      thr: stats ? stats.thr : undefined,
      onsetMs: _vc.segOnsetMs
    });
    if (stats) {
      sig.totalMs = Math.max(sig.totalMs, Math.round((stats.speechMs || 0) + (stats.silenceMs || 0)));
      sig.speechMs = Math.round(stats.speechMs || sig.speechMs);
      sig.speechRatio = sig.totalMs ? Math.round(sig.speechMs / sig.totalMs * 100) / 100 : 0;
    }
    if (transcript) attachTranscriptToSignals(sig, transcript);
    return sig;
  }

  function finishUtterance(why) {
    var chunks = _vc.segChunks || [];
    var pcm = concatInt16(chunks);
    _vc.segChunks = [];
    _vc.segSamples = 0;
    _vc.vad.reset();
    if (!pcm.length) return;
    var durMs = Math.round(pcm.length / CAPTURE_RATE * 1000);
    var minMs = cfgNum('minUtteranceMs', 400, 50, 5000);
    if (durMs < minMs) {
      log('丢弃过短语音', durMs + 'ms');
      return;
    }
    runTurn(pcm, durMs, why);
  }

  function stopCapture() {
    _vc.capturing = false;
    try { if (_vc.procNode) { _vc.procNode.onaudioprocess = null; _vc.procNode.disconnect(); } } catch (e) {}
    try { if (_vc.sourceNode) _vc.sourceNode.disconnect(); } catch (e) {}
    try { if (_vc.silentGain) _vc.silentGain.disconnect(); } catch (e) {}
    try {
      if (_vc.mediaStream) {
        var tracks = _vc.mediaStream.getTracks ? _vc.mediaStream.getTracks() : [];
        for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      }
    } catch (e) {}
    _vc.procNode = null;
    _vc.sourceNode = null;
    _vc.silentGain = null;
    _vc.mediaStream = null;
    _vc.vad = null;
    _vc.preroll = [];
  }

  // =====================================================================================
  // 14. ASR
  // =====================================================================================

  function transcribe(pcm16, gate) {
    var built;
    try {
      var wav = encodeWav(int16ToBytes(pcm16), CAPTURE_RATE);
      var b64 = bytesToBase64(wav);
      built = buildReq('asr', {
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: b64, format: 'wav' } }]
        }]
      });
    } catch (e) {
      // 渠道/密钥没配好：返回 rejected promise，让调用方的 .catch 统一处理，
      // 绝不能同步抛出去 —— 那样会绕过 promise 链，界面永远卡在 thinking。
      return Promise.reject(e);
    }
    var t0 = nowMs();
    var reqPromise = httpPost(built.req, T_ASR).then(function (resp) {
      if (resp.status >= 400) {
        throw makeErr('识别失败 HTTP ' + resp.status + '：' + errTextFrom(resp.data), 'voice_asr');
      }
      var data = resp.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
      var ch = data && data.choices && data.choices[0];
      var msg = ch && ch.message;
      var text = msg ? strOf(msg.content) : '';
      if (!text && typeof data === 'string') text = data;
      return { text: text.trim(), ms: Math.round(nowMs() - t0) };
    });
    if (gate) return gate.race(reqPromise, T_ASR + 3000, '识别');
    return withTimeout(reqPromise, T_ASR + 3000, '识别');
  }

  // =====================================================================================
  // 15. TTS（流式 PCM；失败静音降级，不影响主流程）
  // =====================================================================================

  // 组装一次 TTS 请求体（含音色 / 声音设计 / 克隆）
  function buildTtsBody(text) {
    var cfg = voiceCfg();
    var model = strOf(cfg.ttsModel).trim() || 'mimo-v2.5-tts';
    var audio = {};
    var design = strOf(cfg.voiceDesign).trim();
    var cloneName = strOf(cfg.cloneRefName).trim();
    var body = { model: model, messages: [{ role: 'assistant', content: text }] };
    if (/voicedesign/.test(model) || (design && !cloneName)) {
      // 声音设计：user 放描述，assistant 放要念的文本
      body.model = /voicedesign/.test(model) ? model : 'mimo-v2.5-tts-voicedesign';
      body.messages = [
        { role: 'user', content: design || '一个自然、亲切的聊天声音' },
        { role: 'assistant', content: text }
      ];
    } else if (/voiceclone/.test(model) || cloneName) {
      body.model = /voiceclone/.test(model) ? model : 'mimo-v2.5-tts-voiceclone';
      audio.voice = '__CLONE_REF__';   // 运行时替换为 dataURL
    } else {
      audio.voice = strOf(cfg.voiceId).trim() || 'Mia';
    }
    audio.format = 'pcm';
    body.audio = audio;
    return body;
  }

  function resolveCloneVoice() {
    var VS = root.VoiceSettings;
    if (VS && typeof VS.loadCloneRef === 'function') {
      try {
        return Promise.resolve(VS.loadCloneRef()).then(function (d) { return d || ''; }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    return Promise.resolve('');
  }

  // 合成一句。onPcm(Uint8Array) 每收到一段裸 PCM 就回调（不缓冲整段）。
  // 返回 {firstChunkMs, totalBytes, cancelled}
  function ttsStream(text, opts) {
    opts = opts || {};
    var gate = opts.gate || createGate();
    var t0 = nowMs();
    var firstChunkMs = 0;
    var totalBytes = 0;
    var gotAudio = false;

    return resolveCloneVoice().then(function (cloneRef) {
      var body = buildTtsBody(text);
      if (body.audio && body.audio.voice === '__CLONE_REF__') {
        if (!cloneRef) {
          // 没有参考音就退回普通音色，别让整通电话崩掉
          body.model = strOf(voiceCfg().ttsModel).trim() || 'mimo-v2.5-tts';
          body.audio.voice = strOf(voiceCfg().voiceId).trim() || 'Mia';
          body.messages = [{ role: 'assistant', content: text }];
        } else {
          body.audio.voice = cloneRef;
        }
      }
      var built = buildReq('tts', body);
      var car = null;   // 半字节尾巴
      function feed(bytes) {
        if (!bytes || !bytes.length) return;
        var sp = splitPcmTail(car, bytes);
        car = sp.carry;
        if (!sp.body.length) return;
        totalBytes += sp.body.length;
        if (!firstChunkMs) firstChunkMs = Math.round(nowMs() - t0);
        if (opts.onPcm) { try { opts.onPcm(sp.body); } catch (e) { warn('onPcm', e); } }
      }

      var streamReq = Object.assign({}, built.req);
      streamReq.payload = Object.assign({}, built.req.payload, { stream: true });

      return ssePost(streamReq, {
        gate: gate,
        idleMs: T_TTS,
        onJson: function (choice, delta) {
          var a = delta && delta.audio;
          if (a && typeof a.data === 'string' && a.data) {
            gotAudio = true;
            feed(base64ToBytes(a.data));
          }
        }
      }).then(function () {
        if (gotAudio) return { firstChunkMs: firstChunkMs, totalBytes: totalBytes, cancelled: false };
        // 流式没给音频（对端忽略 stream:true）→ 回退非流式整段
        return ttsOnce(built, gate, t0).then(function (r) {
          return { firstChunkMs: r.firstChunkMs, totalBytes: r.totalBytes, cancelled: false };
        });
      });
    });
  }

  // 非流式兜底：返回 wav（24k），剥头后当裸 PCM 播
  function ttsOnce(built, gate, t0) {
    var req = { url: built.req.url, headers: built.req.headers, payload: built.req.payload };
    var p = httpPost(req, T_TTS).then(function (resp) {
      if (resp.status >= 400) throw makeErr('合成失败 HTTP ' + resp.status + '：' + errTextFrom(resp.data), 'voice_tts');
      var data = resp.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
      var ch = data && data.choices && data.choices[0];
      var audio = ch && ch.message && ch.message.audio;
      if (!audio || !audio.data) throw makeErr('合成返回里没有音频数据', 'voice_tts');
      var bytes = base64ToBytes(audio.data);
      var hdr = parseWavHeader(bytes);
      var pcm = hdr ? bytes.subarray(hdr.pcmOffset, hdr.pcmOffset + hdr.dataBytes) : bytes;
      return { pcm: pcm, firstChunkMs: Math.round(nowMs() - t0), totalBytes: pcm.length, sampleRate: hdr ? hdr.sampleRate : TTS_RATE };
    });
    var final = gate ? gate.race(p, T_TTS + 3000, '语音合成') : withTimeout(p, T_TTS + 3000, '语音合成');
    return final.then(function (r) {
      if (r.sampleRate && r.sampleRate !== TTS_RATE) {
        // 极少见：上游给了别的采样率，现场重采样一次
        var rs = new Resampler(r.sampleRate, TTS_RATE);
        r.pcm = int16ToBytes(rs.process(int16ToFloat32(bytesToInt16(r.pcm))));
      }
      return r;
    });
  }
  // =====================================================================================
  // 16. 界面接线（元素不存在必须容错，绝不抛错）
  // =====================================================================================

  var UI = {};

  function uiCache() {
    UI.view = el('voice-view');
    UI.orb = el('voice-orb');
    UI.stateText = el('voice-state-text');
    UI.subtitle = el('voice-subtitle');
    UI.lineUser = el('voice-line-user');
    UI.lineAsst = el('voice-line-assistant');
    UI.signals = el('voice-signals');
    UI.timer = el('voice-timer');
    UI.voiceName = el('voice-voice-name');
    UI.btnBack = el('btn-voice-back');
    UI.btnSettings = el('btn-voice-settings');
    UI.btnHangup = el('btn-voice-hangup');
    UI.btnMute = el('btn-voice-mute');
    UI.btnCall = el('btn-voice-call');
    UI.btnInterrupt = el('btn-voice-interrupt');
  }

  function setStateText(text) {
    if (UI.stateText) UI.stateText.textContent = strOf(text);
  }

  // 状态类：互斥，同一时刻只有一个。挂 #voice-orb（动画真源），#voice-view 同步镜像一份
  // （这样 .voice-orb.is-speaking 与 .voice-view.is-speaking 两套选择器都能命中，ui-polish 不必二选一）；
  // 同时给 #voice-view 写 data-state 供颜色变量切换用。
  function applyStateClass(stateName) {
    var list = [UI.orb, UI.view];
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!node || !node.classList) continue;
      for (var s = 0; s < STATES.length; s++) node.classList.remove('is-' + STATES[s]);
      node.classList.add('is-' + stateName);
    }
    if (UI.view) {
      try { UI.view.setAttribute('data-state', stateName); } catch (e) {}
    }
  }

  // 一次性动效类：挂在 #voice-orb 上，播完自动移除。
  //   is-interrupted —— 被打断时的骤停回弹（约 400ms）
  //   is-bargein      —— 与 is-interrupted 同时加（两个类共存不冲突）
  //   is-hangup       —— 挂断瞬间的一次性收束
  function flashEffect(primary, partner, ms) {
    var node = UI.orb;
    if (!node || !node.classList) return;
    var classes = [primary];
    if (partner) classes.push(partner);
    for (var i = 0; i < classes.length; i++) node.classList.add(classes[i]);
    setTimeout(function () {
      for (var j = 0; j < classes.length; j++) {
        try { node.classList.remove(classes[j]); } catch (e) {}
      }
    }, ms || 400);
  }


  function setState(next, detail) {
    if (STATES.indexOf(next) < 0) next = 'idle';
    var prev = _vc.state;
    _vc.state = next;
    _vc.stateEnteredAt = nowMs();
    try {
      applyStateClass(next);
      var txt = (detail !== undefined && detail !== null) ? strOf(detail) : (STATE_TEXT[next] || '');
      setStateText(txt);
      if (UI.btnCall) UI.btnCall.style.display = (next === 'idle' || next === 'error') ? '' : 'none';
      if (UI.btnHangup) UI.btnHangup.style.display = (next === 'idle' || next === 'error') ? 'none' : '';
      if (UI.btnInterrupt) {
        if (next === 'speaking') UI.btnInterrupt.classList.add('is-active');
        else UI.btnInterrupt.classList.remove('is-active');
      }
    } catch (e) { warn('setState ui', e); }
    // 跨会话持久化（app.js 的返回键逻辑会读它）
    try {
      var st = ST();
      if (st) st.voiceState = next;
    } catch (e) {}
    try {
      if (root.document && root.document.body) root.document.body.setAttribute('data-voice-state', next);
    } catch (e) {}
    if (prev !== next) log('state', prev, '→', next);
  }

  function setUserLine(text, streaming) {
    if (!UI.lineUser) return;
    var show = voiceCfg().showTranscript !== false;
    UI.lineUser.style.display = (show && text) ? '' : 'none';
    UI.lineUser.textContent = strOf(text);
  }

  function setAssistantLine(text, streaming) {
    if (!UI.lineAsst) return;
    var show = voiceCfg().showTranscript !== false;
    UI.lineAsst.style.display = (show && text) ? '' : 'none';
    UI.lineAsst.textContent = strOf(text);
    if (UI.lineAsst.classList) {
      if (streaming) UI.lineAsst.classList.add('is-streaming');
      else UI.lineAsst.classList.remove('is-streaming');
    }
  }

  function renderSignals(signals) {
    if (!UI.signals) return;
    if (voiceCfg().showSignals === false || !signals) { UI.signals.innerHTML = ''; return; }
    var tags = [];
    try {
      var PD = root.VoiceDirector;
      if (PD && typeof PD.describeSignalsForBubble === 'function') {
        var t = PD.describeSignalsForBubble(signals, {});
        if (Array.isArray(t)) tags = t;
        else if (typeof t === 'string' && t) {
          // v125 修（QA 发现）：director 侧用 ' · ' 作分隔符（voice-director.js 的 SIGNAL_SEP），
          //   这里原本只按 、,，/ 拆 → 4 个标签被当成 1 个，全部塞进同一个胶囊。
          //   这类「两侧各自都对、只是约定不一致」的 bug，数量断言查不出来（.voice-signal 数=1 也算"有"），
          //   只有截图能看见。分隔符取 SIGNAL_SEP 常量，避免再次分叉。
          var sep = (PD && PD.SIGNAL_SEP) ? PD.SIGNAL_SEP : ' · ';
          var re = new RegExp('[、,，\\/]|' + sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          tags = t.split(re).map(function (s) { return s.trim(); }).filter(Boolean);
        }
      }
    } catch (e) { tags = []; }
    if (!tags.length) {
      if (signals.speechRateCps) tags.push(signals.speechRateCps > 4.5 ? '语速偏快' : (signals.speechRateCps < 2.2 ? '语速偏慢' : '语速正常'));
      if (signals.loudness) tags.push('音量' + signals.loudness);
      if (signals.trailingOff) tags.push('句尾发虚');
      if (signals.longPauseCount > 0) tags.push('停顿' + signals.longPauseCount + '次');
    }
    UI.signals.innerHTML = tags.slice(0, 4).map(function (s) {
      return '<span class="voice-signal">' + escapeText(s) + '</span>';
    }).join('');
  }

  function escapeText(s) {
    try { if (typeof escapeHtml === 'function') return escapeHtml(s); } catch (e) {}
    return strOf(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function updateOrbLevel(rms) {
    try {
      var level = Math.round(clamp(rms * 8, 0, 1) * 100) / 100;
      if (UI.view) UI.view.style.setProperty('--voice-level', String(level));
      if (UI.orb) UI.orb.style.setProperty('--voice-level', String(level));
    } catch (e) {}
  }

  function tickTimer() {
    if (!UI.timer) return;
    var secs = _vc.startedAt ? Math.floor((Date.now() - _vc.startedAt) / 1000) : 0;
    var mm = Math.floor(secs / 60), ss = secs % 60;
    UI.timer.textContent = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function refreshVoiceName() {
    if (!UI.voiceName) return;
    try {
      var VS = root.VoiceSettings;
      if (VS && typeof VS.currentVoiceLabel === 'function') {
        UI.voiceName.textContent = strOf(VS.currentVoiceLabel());
        return;
      }
    } catch (e) {}
    UI.voiceName.textContent = strOf(voiceCfg().voiceId) || 'Mia';
  }

  // =====================================================================================
  // 17. 会话写回（照抄 chat.js 的消息结构；source='voice'）
  // =====================================================================================

  function newMsgId() {
    try { if (typeof uid === 'function') return uid(); } catch (e) {}
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function wordCount(text) {
    try { if (typeof countWords === 'function') return countWords(text); } catch (e) {}
    return strOf(text).length;
  }

  function getConvById(id) {
    try {
      var st = ST();
      if (!st || !Array.isArray(st.conversations)) return null;
      for (var i = 0; i < st.conversations.length; i++) if (st.conversations[i].id === id) return st.conversations[i];
    } catch (e) {}
    return null;
  }

  function getMsgSafe(conv, id) {
    try { if (typeof getMsg === 'function') return getMsg(conv, id); } catch (e) {}
    return conv && conv.messageMap ? conv.messageMap[id] : null;
  }

  function lastActiveMsg(conv) {
    try { if (typeof getLastActiveMsg === 'function') return getLastActiveMsg(conv); } catch (e) {}
    try {
      var p = conv.activePath || [];
      var id = p[p.length - 1];
      return conv.messageMap[id] || null;
    } catch (e) { return null; }
  }

  function appendMessage(conv, msg) {
    if (!conv || !conv.messageMap) return null;
    conv.messageMap[msg.id] = msg;
    var parent = msg.parentId ? getMsgSafe(conv, msg.parentId) : null;
    if (parent) {
      if (!parent.children) parent.children = [];
      parent.children.push(msg.id);
    }
    if (!conv.activePath) conv.activePath = [];
    conv.activePath.push(msg.id);
    return msg;
  }

  function addUserMsg(conv, text, signals) {
    if (!conv) return null;
    var parent = lastActiveMsg(conv);
    var msg = {
      id: newMsgId(),
      role: 'user',
      content: strOf(text),
      parentId: parent ? parent.id : conv.rootId,
      children: [],
      title: strOf(text).substring(0, 30) + (strOf(text).length > 30 ? '...' : ''),
      wordCount: wordCount(text),
      versions: [{ content: strOf(text), timestamp: Date.now(), reason: 'voice' }],
      activeVersion: 0,
      files: [],
      createdAt: Date.now(),
      source: 'voice',
      voiceSignals: signals || null
    };
    appendMessage(conv, msg);
    return msg;
  }

  function addAssistantPlaceholder(conv) {
    if (!conv) return null;
    var parent = lastActiveMsg(conv);
    var msg = {
      id: newMsgId(),
      role: 'assistant',
      content: '',
      reasoningContent: '',
      parentId: parent ? parent.id : conv.rootId,
      children: [],
      title: '语音回复',
      wordCount: 0,
      versions: [{ content: '', timestamp: Date.now(), reason: 'voice' }],
      activeVersion: 0,
      files: [],
      createdAt: Date.now(),
      source: 'voice'
    };
    appendMessage(conv, msg);
    return msg;
  }

  function updateAssistantMsg(conv, msg, text) {
    if (!conv || !msg) return;
    msg.content = strOf(text);
    msg.wordCount = wordCount(msg.content);
    msg.versions[0] = { content: msg.content, timestamp: Date.now(), reason: 'voice' };
    if (msg.title === '语音回复' && msg.content) msg.title = msg.content.substring(0, 24);
  }

  // 通话开始/结束各留一条系统标注：落进会话树，回看时能分出"哪段是打电话聊的"
  //   （渲染层会跳过 system 消息，所以不会变成气泡；聊天上下文同样会跳过它）。
  //   标注绝不能影响通话本身：任何一步失败都静默跳过（没有 conv、主任没实现、存储报错都算）。
  function appendCallMarker(kind) {
    try {
      var conv = getConvById(_session.convId) || currentConvSafe();
      if (!conv || !conv.messageMap) return null;
      var at = Date.now();
      var startedAt = _vc.startedAt || at;
      var turns = (_vc.metrics && _vc.metrics.turns) || 0;
      var mk = null;
      try {
        var PD = root.VoiceDirector;
        if (PD && typeof PD.buildCallMarker === 'function') {
          mk = PD.buildCallMarker({ kind: kind, at: at, startedAt: startedAt, turns: turns });
        }
      } catch (e) { mk = null; }
      if (!mk || !mk.content) {
        // 通话层还没提供 buildCallMarker 时的最小兜底，保证时间线不断
        mk = {
          role: 'system',
          content: (kind === 'start') ? '〔通话开始〕' : ('〔通话结束〕共 ' + turns + ' 轮'),
          marker: 'call'
        };
      }
      var parent = lastActiveMsg(conv);
      var content = strOf(mk.content);
      var msg = {
        id: newMsgId(),
        role: strOf(mk.role) || 'system',
        content: content,
        parentId: parent ? parent.id : conv.rootId,
        children: [],
        title: (kind === 'start') ? '通话开始' : '通话结束',
        wordCount: wordCount(content),
        versions: [{ content: content, timestamp: at, reason: 'voice' }],
        activeVersion: 0,
        files: [],
        createdAt: at,
        source: 'voice',
        marker: strOf(mk.marker) || 'call'
      };
      appendMessage(conv, msg);
      saveConvSafe();
      renderSafe();
      return msg;
    } catch (e) {
      warn('call marker failed', e);
      return null;
    }
  }

  // =====================================================================================
  // 18. 大脑请求：流式 JSON 增量解析 → 句子立刻进 TTS 流水线
  // =====================================================================================

  var JSON_DIRECTIVE = [
    '',
    '【输出格式（强制）】你正在打电话，回复会被直接念出来。只输出一个 JSON 对象，不要任何解释、不要代码块。',
    '字段顺序必须是这样，第一个字段永远是 speech：',
    '{"speech":"你要说出口的原话","emotion":"情绪","tone":"语气","pace":1.0,"volume":"中","nonverbals":["笑"]}',
    'speech 里只用口语短句，句末用中文标点；不要 Markdown、不要列表、不要括号里的动作描写。'
  ].join('\n');

  function plainMsgContent(m) {
    var c = strOf(m && m.content);
    return c.replace(/<status>[\s\S]*?<\/status>/g, '').trim();
  }

  function historyMessages(conv, limit) {
    var out = [];
    try {
      if (!conv) return out;
      var chain;
      if (typeof getActiveChain === 'function') chain = getActiveChain(conv);
      else chain = (conv.activePath || []).map(function (id) { return conv.messageMap[id]; });
      chain = (chain || []).filter(function (m) {
        // 通话标注（marker==='call'）不进普通历史：一轮一条，几通电话就能把上下文占满
        if (!m || m.marker === 'call' || m.role === 'system') return false;
        return (m.role === 'user' || m.role === 'assistant') && plainMsgContent(m);
      });
      var slice = chain.slice(-(limit || 16));
      for (var i = 0; i < slice.length; i++) {
        out.push({ role: slice[i].role, content: plainMsgContent(slice[i]) });
      }
    } catch (e) { warn('history', e); }
    return out;
  }

  // 会话人设：和 chat.js 的 buildContext() 用同一套 system 组装顺序，
  //   但**不注入状态栏** —— 通话是念出来的，模型收到 <status> 指令会把标签当台词念。
  //   全程 try/catch：取不到就跳过这一段，绝不能因为读人设把通话搞挂。
  var MODEL_PROMPT_SEP = '===强调===';

  function buildSessionSystemParts(conv) {
    var parts = [];
    try {
      if (!conv) return parts;
      var sys = strOf(conv.systemPrompt).trim();
      if (sys) parts.push(sys);
      var emp = strOf(conv.emphasis).trim();
      if (emp) parts.push('【重要强调】' + emp);
      // 模型修饰：优先用 chat.js 的 effectiveModelPrompt（它处理了会话级禁用/覆盖），
      //   拿不到（加载顺序/老版本）就按同样的规则自己取一次，保证两边看到同一份修饰
      var mp = null;
      try {
        if (typeof effectiveModelPrompt === 'function') mp = effectiveModelPrompt(conv) || null;
      } catch (e) { mp = null; }
      if (!mp) {
        try {
          if (!conv.modelPromptDisabled) {
            if (conv.modelPromptOverride) mp = { text: conv.modelPromptOverride };
            else {
              var st = S();
              var list = st && st.modelPrompts;
              if (list) mp = list[(conv.providerId || '') + ':' + (conv.model || '')] || null;
            }
          }
        } catch (e2) { mp = null; }
      }
      if (mp && mp.text) {
        var text = strOf(mp.text);
        var ix = text.indexOf(MODEL_PROMPT_SEP);
        if (ix >= 0) {
          // 用分隔符实际长度切分（不写死数字，避免吃掉强调的首字）
          var head = text.substring(0, ix).trim();
          var tail = text.substring(ix + MODEL_PROMPT_SEP.length).trim();
          if (head) parts.push(head);
          if (tail) parts.push('【重要强调】' + tail);
        } else if (text.trim()) {
          parts.push(text.trim());
        }
      }
      var uid = strOf(conv.userIdentity).trim();
      if (uid) parts.push('用户身份：' + uid);
    } catch (e) { warn('session system parts', e); }
    return parts;
  }

  // settings.voice 里的布尔可能被存成 true/1/'true'，都算开（字段缺失算关）
  function cfgOn(v) {
    if (v === true || v === 1) return true;
    return strOf(v).toLowerCase() === 'true';
  }

  // 时间感知载荷：timestamps 关掉时只发 {enabled:false}，让通话层知道"别看表"
  function buildClock() {
    var cfg = voiceCfg();
    if (!cfgOn(cfg.timestamps)) return { enabled: false };
    return {
      enabled: true,
      now: Date.now(),
      callStartedAt: _vc.startedAt || Date.now(),
      lastTurnAt: _vc.lastTurnAt || 0,
      turnIndex: (_vc.metrics && _vc.metrics.turns) || 0
    };
  }

  function buildBrainMessages(conv, userText, signals) {
    var cfg = voiceCfg();
    var signalsText = '';
    try {
      var PD0 = root.VoiceDirector;
      if (PD0 && typeof PD0.describeSignals === 'function') {
        signalsText = strOf(PD0.describeSignals(signals, { customPersona: cfg.customPersona }));
      }
    } catch (e) { signalsText = ''; }

    var clock = buildClock();
    var parts = buildSessionSystemParts(conv);
    var layer = '';
    try {
      var PD1 = root.VoiceDirector;
      if (PD1 && typeof PD1.buildCallLayer === 'function') {
        var raw = PD1.buildCallLayer({
          sessionSystem: parts.join('\n\n'),
          sessionParts: parts.slice(),
          personaId: cfg.personaId,
          customPersona: cfg.customPersona,
          signals: signals,
          signalsText: signalsText,
          voiceLabel: strOf(cfg.voiceId),
          channel: 'voice',
          clock: clock,
          rate: clampRate(cfg.rate),
          rateMode: (strOf(cfg.rateMode) === 'pitch') ? 'pitch' : 'natural'
        });
        layer = (typeof raw === 'string') ? strOf(raw)
          : strOf(raw && (raw.systemPrompt || raw.text || raw.content));
        layer = layer.trim();
      }
    } catch (e) { layer = ''; }

    if (!layer) {
      // voice-director 还是旧版（没有 buildCallLayer）：沿用原来的整体提示词，绝不让通话没提示词
      var sysOld = '';
      try {
        var PD2 = root.VoiceDirector;
        if (PD2 && typeof PD2.buildSystemPrompt === 'function') {
          sysOld = strOf(PD2.buildSystemPrompt({
            personaId: cfg.personaId,
            customPersona: cfg.customPersona,
            signals: signals,
            signalsText: signalsText,
            voiceLabel: strOf(cfg.voiceId),
            channel: 'voice'
          }));
        }
      } catch (e) { sysOld = ''; }
      if (!sysOld) {
        sysOld = '你正在和用户通电话。说话短、口语、自然，一次只说一两句，不要列条目，不要念标点。' +
          (cfg.customPersona ? '补充：' + cfg.customPersona : '');
      }
      layer = sysOld;
    }

    var sysParts = parts.slice();
    if (layer) sysParts.push(layer);
    // 通话层若没把副语言信号/时间写进提示词，这里补上（已包含就不重复）
    var joined = sysParts.join('\n\n');
    if (signalsText && joined.indexOf(signalsText) < 0) sysParts.push(signalsText);
    if (clock.enabled) {
      var clockText = '';
      try {
        var PD3 = root.VoiceDirector;
        if (PD3 && typeof PD3.describeClock === 'function') clockText = strOf(PD3.describeClock(clock));
      } catch (e) { clockText = ''; }
      joined = sysParts.join('\n\n');
      if (clockText && joined.indexOf(clockText) < 0) sysParts.push(clockText);
    }
    var sys = sysParts.join('\n\n') + '\n' + JSON_DIRECTIVE;

    var msgs = [{ role: 'system', content: sys }];
    var hist = historyMessages(conv, 14);
    for (var i = 0; i < hist.length; i++) msgs.push(hist[i]);

    // v126 修（v125 遗留）：这里原来还调了一次 VoiceDirector.buildTurnMessages。
    //   那个函数**自己会再拼一遍 system**（不传 system 时它内部调 buildSystemPrompt），
    //   而 system 与 history 上面已经加过了 —— 结果是发给模型的 messages 变成
    //   [system(新), user, system(旧), user, user]：两套互相冲突的提示词，外加重复的历史。
    //   实测抓到过：新通话层 + 旧 buildSystemPrompt 同时出现，JSON 格式说明也写了两份，
    //   模型可能按旧的那份输出（字段名对不上就解析失败），而表面上一切正常。
    //   现在只补本轮用户话，system / history 各只出现一次。
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }

  // 语音大脑：流式；失败自动回退非流式
  // onSentence(text)   —— 已成型的一句，立刻送 TTS
  // 返回 {speech, plan, firstTokenMs, json}
  function callBrain(conv, userText, signals, gate, onSentence) {
    var t0 = nowMs();
    var firstTurn = (_vc.metrics.turns === 0);
    var messages = buildBrainMessages(conv, userText, signals);
    // 首轮抢时间：上下文最短（本来也就一两句），把 max_tokens 压下来以缩短首 token。
    //   实测首 token 对 prompt 长度很敏感（732ms ↔ 1033ms）。
    var maxTokens = firstTurn ? 160 : 400;
    var firstTokenMs = 0;
    var extractor = createSpeechExtractor();
    var fullSpeechSeen = '';
    var aborted = false;

    function pushSentence(s) {
      if (!s) return;
      var clean = s;
      try {
        var PD = root.VoiceDirector;
        if (PD && typeof PD.sanitizeForTTS === 'function') clean = strOf(PD.sanitizeForTTS(s)) || s;
      } catch (e) {}
      clean = clean.trim();
      if (!clean) return;
      fullSpeechSeen += clean;
      try { onSentence(clean); } catch (e) { warn('onSentence', e); }
    }

    function streamAttempt() {
      var built = buildReq('brain', {
        messages: messages,
        temperature: 0.85,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      });
      return ssePost(built.req, {
        gate: gate,
        idleMs: T_BRAIN_IDLE,
        onJson: function (choice, delta) {
          var c = delta && delta.content;
          if (typeof c !== 'string' || !c) return;
          if (!firstTokenMs) firstTokenMs = Math.round(nowMs() - t0);
          var sents = extractor.push(c);
          for (var i = 0; i < sents.length; i++) pushSentence(sents[i]);
        }
      }).then(function () {
        var rest = extractor.flush();
        for (var i = 0; i < rest.length; i++) pushSentence(rest[i]);
        return { json: extractor.raw(), firstTokenMs: firstTokenMs };
      });
    }

    function nonStreamAttempt() {
      var built = buildReq('brain', {
        messages: messages,
        temperature: 0.85,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      });
      var p = httpPost(built.req, T_BRAIN_FIRST);
      var raced = gate ? gate.race(p, T_BRAIN_FIRST, '大脑') : withTimeout(p, T_BRAIN_FIRST, '大脑');
      return raced.then(function (resp) {
        if (resp.status >= 400) throw makeErr('大脑请求失败 HTTP ' + resp.status + '：' + errTextFrom(resp.data), 'voice_brain');
        var data = resp.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
        var ch = data && data.choices && data.choices[0];
        var msg = ch && (ch.message || ch.delta);
        var raw = msg ? strOf(msg.content) : '';
        if (!firstTokenMs) firstTokenMs = Math.round(nowMs() - t0);
        return { json: raw, firstTokenMs: firstTokenMs };
      });
    }

    return streamAttempt().catch(function (e) {
      if (isAbort(e)) throw e;
      warn('大脑流式失败，回退非流式：', e && e.message);
      return nonStreamAttempt();
    }).then(function (r) {
      var speech = extractor.speech();
      var plan = null;
      try {
        var PD = root.VoiceDirector;
        if (PD && typeof PD.parseDirective === 'function') plan = PD.parseDirective(r.json || ('{"speech":' + JSON.stringify(speech) + '}'));
      } catch (e) { plan = null; }
      // 完整 JSON 到齐后校正：流式增量可能少吐或多吐了句子
      var finalSpeech = plan && plan.speech ? strOf(plan.speech) : speech;
      var emitted = fullSpeechSeen.replace(/\s+/g, '');
      var finalNorm = finalSpeech.replace(/\s+/g, '');
      if (finalNorm && emitted.indexOf(finalNorm) < 0 && emitted.replace(/[。！？…，、；：,.!?;:]/g, '').indexOf(finalNorm.replace(/[。！？…，、；：,.!?;:]/g, '')) < 0) {
        pushSentence(firstSentence(finalSpeech));
      }
      return { speech: finalSpeech, plan: plan, firstTokenMs: r.firstTokenMs || firstTokenMs, json: r.json };
    });
  }

  // =====================================================================================
  // 19. TTS 流水线（边合成边播；句子级并发，前一句在播时后一句已经发出去了）
  // =====================================================================================

  function createPipeline(gate) {
    var q = {
      queue: [],          // 待合成的句子
      active: 0,          // 正在合成的个数
      maxActive: 2,       // 允许"下一句预合成"
      done: false,
      closed: false,
      onIdle: null,
      firstChunkMs: 0
    };

    // 排空判定。注意：这是被"两件不同的事"触发的 ——
    //   ① TTS 请求结束（pump 时调用）  ② 播放队列真的播完了（player.onDrained 回调）
    //   只挂 ① 会漏掉"请求都回来了、音频还在播"的时序，一整轮就永远卡在 speaking。
    function maybeIdle() {
      if (q.closed) return;
      if (q.active > 0) return;
      if (q.queue.length) return;
      if (!q.done) return;
      // 播放器还没建好时不要卡死在这里：没有任何音频排期，等同于"已排空"
      var p = _vc.player;
      if (p) {
        if (!p.isIdle()) {
          // 还没播完 —— 挂上排空回调，等它播完再来问一次（回调自带重入保护）
          p.onDrained = maybeIdle;
          return;
        }
        p.onDrained = null;
      }
      q.closed = true;
      if (q.onIdle) {
        var cb = q.onIdle;
        q.onIdle = null;
        try { cb(); } catch (e) { warn('pipeline idle', e); }
      }
    }

    function startOne(text) {
      q.active++;
      var p = ttsStream(text, {
        gate: gate,
        onPcm: function (bytes) {
          if (!_vc.player) { try { ensurePlayer(); } catch (e) { return; } }
          _vc.player.appendPcm24(bytes);
          if (_vc.state !== 'speaking') enterSpeaking();
        }
      }).then(function (r) {
        // 这一句的 PCM 已经全部到齐：吐出伸缩器里的尾巴，保持句尾完整
        try { if (_vc.player) _vc.player.flushStretch(); } catch (e) {}
        if (r && r.firstChunkMs && (!q.firstChunkMs || r.firstChunkMs < q.firstChunkMs)) q.firstChunkMs = r.firstChunkMs;
      }).catch(function (e) {
        if (isAbort(e)) return;
        // 静音降级：这一句坏了就跳过，绝不打断整通电话
        warn('TTS 失败（静音降级）:', e && e.message);
        if (!q.warned) { q.warned = true; toast('语音合成失败，已切到纯文字模式', 'warn'); }
      }).then(function () {
        q.active--;
        pump();
      });
      return p;
    }

    function pump() {
      if (q.closed) return;
      while (q.queue.length && q.active < q.maxActive) {
        startOne(q.queue.shift());
      }
      maybeIdle();
    }

    return {
      push: function (text) {
        if (q.closed) return;
        var t = strOf(text).trim();
        if (!t) return;
        // 太长的句子拆开，缩短首包时间
        if (t.length > SOFT_MAX) {
          var parts = splitSentences(t, { minLen: 1 });
          if (parts.length > 1) {
            for (var i = 0; i < parts.length; i++) q.queue.push(parts[i]);
            pump();
            return;
          }
          q.queue.push(t.slice(0, SOFT_MAX));
          q.queue.push(t.slice(SOFT_MAX));
        } else {
          q.queue.push(t);
        }
        pump();
      },
      finish: function () {
        q.done = true;
        pump();
        maybeIdle();
      },
      whenIdle: function (cb) {
        // 已经排空过（典型时序：finish() 里先判空了、这里才注册）→ 立即回调，不能漏。
        //   这正是曾经卡死在 speaking 的原因：单次触发的事件被注册在触发之后。
        if (q.closed || (q.done && !q.queue.length && q.active === 0 && (!_vc.player || _vc.player.isIdle()))) {
          q.closed = true;
          try { cb(); } catch (e) { warn('whenIdle', e); }
          return;
        }
        q.onIdle = cb;
        maybeIdle();
      },
      firstChunkMs: function () { return q.firstChunkMs; },
      size: function () { return q.queue.length + q.active; },
      stop: function () {
        q.closed = true;
        q.queue.length = 0;
        q.onIdle = null;
        if (_vc.player && _vc.player.onDrained === maybeIdle) _vc.player.onDrained = null;
      }
    };
  }

  function enterSpeaking() {
    if (_vc.state === 'speaking') { armSpeakWatchdog(); return; }
    setState('speaking');
    _vc.speaking = true;
    _vc.speakStartAt = nowMs();
    _vc.leakRms = 0.006;
    _vc.interrupted = false;
    clearFillerTimer();
    armSpeakWatchdog();
  }

  // speaking 状态必须有"最长停留时间"兜底：TTS 半路失败、采样率异常、排期算错……
  //   任何一种都可能让播放队列永远排不空。宁可提前回到 listening（用户能再说话），
  //   也不要让整通电话卡在一个转圈的状态里。
  function armSpeakWatchdog() {
    if (_vc.speakWatchdog) clearTimeout(_vc.speakWatchdog);
    _vc.speakWatchdog = setTimeout(function () {
      if (!_vc.running || _vc.state !== 'speaking') return;
      warn('speaking 超时兜底：强制回到 listening');
      try { if (_vc.player) _vc.player.hardStop(); } catch (e) {}
      abortCurrentTurn('watchdog');
      setState('listening');
      startAutoHangTimer();
    }, 45000);
  }

  function clearSpeakWatchdog() {
    if (_vc.speakWatchdog) { clearTimeout(_vc.speakWatchdog); _vc.speakWatchdog = null; }
  }

  // =====================================================================================
  // 20. 语气词预热（通话开始就并行合成，需要补白时零延迟播放）
  // =====================================================================================

  function clearFillerTimer() {
    if (_vc.fillerTimer) { clearTimeout(_vc.fillerTimer); _vc.fillerTimer = null; }
  }

  function prewarmFillers() {
    var token = ++_vc.fillerWarmToken;
    _vc.fillerBuffers = [];
    var texts = ['嗯……', '让我想想', '啊，这个'];
    try {
      var PD = root.VoiceDirector;
      if (PD && typeof PD.buildFillerPlan === 'function') {
        var plan = PD.buildFillerPlan({ count: 3, voiceLabel: voiceCfg().voiceId });
        if (Array.isArray(plan) && plan.length) {
          texts = plan.map(function (x) { return typeof x === 'string' ? x : strOf(x && (x.text || x.speech)); }).filter(Boolean);
          if (!texts.length) texts = ['嗯……', '让我想想', '啊，这个'];
        }
      }
    } catch (e) {}
    var ctx = _vc.audioCtx;
    if (!ctx) return;

    texts.slice(0, 3).forEach(function (t, idx) {
      // 后台发，失败静默忽略
      ttsStream(t, { gate: null, onPcm: function (bytes) {
        if (token !== _vc.fillerWarmToken) return;    // 音色已换，丢弃
        var i16 = bytesToInt16(bytes);
        if (!i16.length) return;
        var rs = new Resampler(TTS_RATE, ctx.sampleRate);
        var f32 = rs.process(int16ToFloat32(i16));
        if (!f32.length) return;
        try {
          var buf = ctx.createBuffer(1, f32.length, ctx.sampleRate);
          buf.getChannelData(0).set(f32);
          _vc.fillerBuffers[idx] = buf;
        } catch (e) {}
      } }).catch(function () { /* 静默 */ });
    });
  }

  function playFiller() {
    var p = _vc.player;
    if (!p || !_vc.audioCtx) { try { p = ensurePlayer(); } catch (e) { return false; } }
    var list = _vc.fillerBuffers.filter(Boolean);
    if (!list.length) return false;
    var buf = list[Math.floor(Math.random() * list.length)];
    try {
      enterSpeaking();
      p.appendBuffer(buf);
      return true;
    } catch (e) { return false; }
  }

  // =====================================================================================
  // 21. 一轮完整的通话（ASR → 大脑 → TTS 流水线 → 回到 listening）
  // =====================================================================================

  function startFillerTimer(token) {
    clearFillerTimer();
    _vc.fillerTimer = setTimeout(function () {
      if (token !== _vc.turnId) return;
      if (_vc.state !== 'thinking') return;
      if (playFiller()) log('补白：播放预合成语气词');
    }, FILLER_DELAY_MS);
  }

  // 自动挂断：v127 起**默认关闭**。
  //   为什么改：挂机聊天本来就是要一直挂着，45 秒的默认值直接把"长期聊"这件事毁掉 ——
  //   用户实测反馈「那还怎么长期挂机聊」。现在只有用户自己打开才计时，默认 1 小时。
  function startAutoHangTimer() {
    clearTimeout(_vc.autoHangTimer);
    _vc.autoHangTimer = null;
    if (!voiceCfg().autoHangup) return;            // 关着就完全不排定时器
    var limit = cfgNum('autoHangupSilenceMs', 3600000, 5000, 7200000);
    _vc.autoHangTimer = setTimeout(function () {
      if (!_vc.running) return;
      if (!voiceCfg().autoHangup) return;          // 中途被关掉
      if (_vc.state !== 'listening') { startAutoHangTimer(); return; }
      toast('太久没说话，已自动挂断（可在设置里关掉）', 'info');
      hangup();
    }, limit);
  }

  function abortCurrentTurn(reason) {
    _vc.turnId++;
    try { if (_vc.gate) _vc.gate.abort(abortErr()); } catch (e) {}
    _vc.gate = null;
    if (_vc.pipeline) { try { _vc.pipeline.stop(); } catch (e) {} _vc.pipeline = null; }
    clearFillerTimer();
  }

  function runTurn(pcm, durMs, why) {
    if (!_vc.running) return;
    var token = ++_vc.turnId;
    var turnStart = nowMs();
    _vc.lastTurnAt = Date.now();   // 时间感知：这一轮是什么时候说的
    var gate = createGate();
    _vc.gate = gate;
    _vc.interrupted = false;
    _vc.saidText = '';
    setState('thinking');
    clearTimeout(_vc.autoHangTimer);
    startFillerTimer(token);

    var conv = getConvById(_session.convId) || currentConvSafe();
    if (conv) _session.convId = conv.id;

    var vadInfo = null;
    try {
      if (_vc.vad) vadInfo = { noiseFloor: _vc.vad.noiseFloor(), thr: _vc.vad.threshold() };
    } catch (e) { vadInfo = null; }

    var signals = computeSignals(pcm, {
      sampleRate: CAPTURE_RATE,
      noiseFloor: vadInfo ? vadInfo.noiseFloor : undefined,
      thr: vadInfo ? vadInfo.thr : undefined,
      onsetMs: _vc.segOnsetMs
    });

    log('一轮开始', durMs + 'ms', why || '', 'rms=' + (Math.round(signals.rmsMean * 1000) / 1000));

    var pipeline = null;
    var assistantMsg = null;

    function fail(e) {
      if (token !== _vc.turnId) return;
      if (isAbort(e)) { log('本轮被放弃/打断'); return; }
      warn('本轮失败:', e && e.message);
      _vc.turnId++;   // 让后续回调全部失效
      try { if (_vc.player) _vc.player.hardStop(); } catch (x) {}
      if (_vc.pipeline) { try { _vc.pipeline.stop(); } catch (x) {} _vc.pipeline = null; }
      clearFillerTimer();
      var msg = (e && e.message) ? e.message : '出了点问题';
      if (e && e.code === 'voice_noasr') {
        setState('listening', '没听清，再说一次？');
        setTimeout(function () { if (_vc.running && _vc.state === 'listening') setStateText('请说话'); }, 1500);
        startAutoHangTimer();
        return;
      }
      setState('error', msg);
      toast(msg, 'warn');
      if (conv && assistantMsg && !assistantMsg.content) {
        // 别在会话里留一条空回复
        try {
          delete conv.messageMap[assistantMsg.id];
          var parent = getMsgSafe(conv, assistantMsg.parentId);
          if (parent && parent.children) {
            parent.children = parent.children.filter(function (x) { return x !== assistantMsg.id; });
          }
          conv.activePath = (conv.activePath || []).filter(function (x) { return x !== assistantMsg.id; });
          saveConvSafe();
        } catch (x) {}
      }
      setTimeout(function () {
        if (_vc.running && _vc.state === 'error') setState('listening');
      }, 2500);
      startAutoHangTimer();
    }

    var chain;
    try {
      chain = transcribe(pcm, gate);
    } catch (e) {
      chain = Promise.reject(e);
    }
    chain.then(function (asr) {
      if (token !== _vc.turnId) throw abortErr();
      _vc.metrics.asrMs = asr.ms;
      var text = strOf(asr.text).trim();
      // ASR 对静音/噪声会幻觉出「嗯。」这类词，太短就当没听清
      if (!text || text.replace(/[\s。，,.!！?？…、]/g, '').length < 1) {
        throw makeErr('没听清', 'voice_noasr');
      }
      attachTranscriptToSignals(signals, text);
      setUserLine(text);
      renderSignals(signals);
      _vc.signalHistory.push(signals);
      if (_vc.signalHistory.length > 20) _vc.signalHistory.shift();
      if (conv) {
        addUserMsg(conv, text, signals);
        assistantMsg = addAssistantPlaceholder(conv);
        saveConvSafe();
      }
      return callBrain(conv, text, signals, gate, function (sentence) {
        if (token !== _vc.turnId) return;
        if (!pipeline) pipeline = startPipeline(token, gate, conv, assistantMsg);
        pipeline.push(sentence);
      }).then(function (res) {
        if (token !== _vc.turnId) throw abortErr();
        _vc.metrics.brainFirstTokenMs = res.firstTokenMs || 0;
        if (!pipeline) {
          // 完全没有句子（模型返回空）→ 兜底说一句
          var fallback = res.speech || '嗯，我在。';
          pipeline = startPipeline(token, gate, conv, assistantMsg);
          pipeline.push(firstSentence(fallback));
        }
        if (conv && assistantMsg && res.speech) {
          var full = res.speech;
          if (res.plan && res.plan.emotion) assistantMsg.voicePlan = res.plan;
          updateAssistantMsg(conv, assistantMsg, full === _vc.saidText ? full : (_vc.saidText || full));
        }
        return res;
      });
    }).then(function () {
      if (token !== _vc.turnId) return;
      if (pipeline) {
        // 先注册排空回调，再 finish —— 顺序反了就会漏掉"已经播完"这个单次事件
        pipeline.whenIdle(function () {
          if (token !== _vc.turnId) return;
          endTurn(token, turnStart, conv, assistantMsg);
        });
        pipeline.finish();
      } else {
        endTurn(token, turnStart, conv, assistantMsg);
      }
    }).catch(fail);
  }

  function startPipeline(token, gate, conv, assistantMsg) {
    var pl = createPipeline(gate);
    _vc.pipeline = pl;
    pl._said = '';
    var origPush = pl.push;
    pl.push = function (text) {
      if (token !== _vc.turnId) return;
      var t = strOf(text).trim();
      if (!t) return;
      pl._said += t;
      _vc.saidText = pl._said;
      var shown = pl._said.length > 160 ? '…' + pl._said.slice(-160) : pl._said;
      setAssistantLine(shown, true);
      if (conv && assistantMsg) updateAssistantMsg(conv, assistantMsg, pl._said);
      origPush.call(pl, t);
    };
    return pl;
  }

  function endTurn(token, turnStart, conv, assistantMsg) {
    if (token !== _vc.turnId) return;
    var total = Math.round(nowMs() - turnStart);
    _vc.metrics.turnTotalMs = total;
    _vc.metrics.turns = (_vc.metrics.turns || 0) + 1;
    _vc.metrics.ttsFirstChunkMs = (_vc.pipeline && _vc.pipeline.firstChunkMs) ? _vc.pipeline.firstChunkMs() : _vc.metrics.ttsFirstChunkMs;
    _vc.metrics.lastTurn = {
      at: Date.now(),
      totalMs: total,
      asrMs: _vc.metrics.asrMs,
      brainFirstTokenMs: _vc.metrics.brainFirstTokenMs,
      ttsFirstChunkMs: _vc.metrics.ttsFirstChunkMs
    };
    _vc.pipeline = null;
    _vc.gate = null;
    clearSpeakWatchdog();
    try { if (_vc.player) _vc.player.resetStream(); } catch (e) {}
    setAssistantLine(_vc.saidText || '', false);
    if (conv && assistantMsg) {
      updateAssistantMsg(conv, assistantMsg, _vc.saidText || assistantMsg.content || '');
      saveConvSafe();
      try { if (typeof renderMessages === 'function') renderMessages(); } catch (e) {}
    }
    log('一轮结束', total + 'ms', 'asr=' + _vc.metrics.asrMs, 'brain=' + _vc.metrics.brainFirstTokenMs, 'tts=' + _vc.metrics.ttsFirstChunkMs);
    if (token !== _vc.turnId) return;
    if (_vc.running) {
      setState('listening');
      startAutoHangTimer();
      // 下一轮重新标定底噪（环境可能变了），并丢掉上一轮残留的采集缓冲
      if (_vc.vad) { try { _vc.vad.reset(); } catch (e) {} }
      _vc.segChunks = [];
      _vc.segSamples = 0;
      _vc.preroll = [];
      _vc.prerollSamples = 0;
      _vc.bargeAboveMs = 0;
      _vc.lastFrameAt = 0;
      try { if (_vc.resampler) _vc.resampler = new Resampler(_vc.audioCtx.sampleRate, CAPTURE_RATE); } catch (e) {}
    }
  }

  // =====================================================================================
  // 22. 打断（barge-in）
  // =====================================================================================

  function doBargeIn() {
    if (!_vc.running) return;
    if (voiceCfg().bargeIn === false) return;
    log('用户打断');
    _vc.interrupted = true;
    // ① 停掉所有正在播的 source ② 清空队列 ③ 中止后续 TTS ④ 状态转 listening ⑤ 反馈
    try { if (_vc.player) _vc.player.hardStop(); } catch (e) {}
    abortCurrentTurn('barge-in');
    setAssistantLine(_vc.saidText || '', false);
    if (_vc.state !== 'listening') setState('listening');
    flashEffect('is-interrupted', 'is-bargein', 400);
    haptic('bargein');
    try { _vc.vad && _vc.vad.reset(); } catch (e) {}
    _vc.preroll = [];
    _vc.prerollSamples = 0;
    _vc.segChunks = [];
  }

  // =====================================================================================
  // 23. 生命周期：open / close / start / hangup / interrupt / mute
  // =====================================================================================

  function applyOpenUI(open) {
    if (!UI.view) return;
    UI.view.style.display = open ? 'flex' : 'none';
    try {
      if (root.document && root.document.body) root.document.body.classList.toggle('voice-view-open', !!open);
    } catch (e) {}
  }

  function open() {
    uiCache();
    var cfg = voiceCfg();
    if (cfg && cfg.enabled === false) {
      toast('语音通话已在设置里关闭', 'warn');
      return false;
    }
    // 与生图互斥
    try {
      var st = ST();
      if (st && st.imageViewOpen && typeof toggleImageView === 'function') toggleImageView(false);
    } catch (e) {}
    _vc.open = true;
    try { var st2 = ST(); if (st2) st2.voiceOpen = true; } catch (e) {}
    applyOpenUI(true);
    refreshVoiceName();
    setState(_vc.state === 'idle' ? 'idle' : _vc.state);
    setUserLine('', false);
    setAssistantLine('', false);
    if (UI.signals) UI.signals.innerHTML = '';
    tickTimer();
    if (_vc.timerId) clearInterval(_vc.timerId);
    _vc.timerId = setInterval(tickTimer, 500);
    // 进入即尝试预热语气词（无麦克风也能先备好，省 0.55s）
    if (!_vc.fillerBuffers.length) {
      setTimeout(function () {
        try { ensureAudioCtx(); prewarmFillers(); } catch (e) {}
      }, 300);
    }
    return true;
  }

  function close() {
    hangup(true);
    _vc.open = false;
    try { var st = ST(); if (st) st.voiceOpen = false; } catch (e) {}
    applyOpenUI(false);
    if (_vc.timerId) { clearInterval(_vc.timerId); _vc.timerId = null; }
    setState('idle');
  }

  // 注意：start() 必须在用户手势的调用链里同步跑到 getUserMedia（不能先 await）
  // v125 修（QA 发现）：此前 start() 不做任何渠道预检，直接进 listening、状态写「请说话」，
  //   用户以为已经能用了，说第一句才暴露「缺少 API 密钥」—— 失败来得太晚。
  //   这里在**申请麦克风之前**先静态检查一次（只看配置，不发请求、不耗额度），
  //   把失败前移到用户点击后立刻可见的位置。返回 null 表示通过，否则返回可读错误文案。
  function preflightConfig() {
    try {
      resolveVoiceProvider('asr');
      resolveVoiceProvider('tts');
      resolveVoiceProvider('brain');
      return null;
    } catch (e) {
      var msg = (e && e.message) ? e.message : '语音配置不完整';
      // 去掉内部错误前缀，只留人能读的那半句
      msg = msg.replace(/^\[?voice_[a-z]+\]?\s*[:：]?\s*/i, '');
      return msg;
    }
  }

  // 本地静态检查：语音接口填全了没、模型名是不是明显填错了（不联网、不耗额度）
  function quickVoiceSanity() {
    var vp = pickVoiceProvider();
    if (!vp) return '还没有配置语音接口：请在「设置 → 语音通话 → 语音接口」里添加（填地址和密钥）';
    if (!vp.baseUrl) return '语音接口「' + (vp.name || vp.id) + '」缺接口地址';
    if (!vp.apiKey) return '语音接口「' + (vp.name || vp.id) + '」缺 API 密钥';
    var cfg = voiceCfg();
    var asr = strOf(cfg.asrModel).trim() || strOf(vp.asrModel).trim();
    var tts = strOf(cfg.ttsModel).trim() || strOf(vp.ttsModel).trim();
    // 明显填反的情况：识别模型里写着 tts / 合成模型里写着 asr
    if (asr && /tts|voicedesign|voiceclone/i.test(asr)) return '识别模型填成了合成模型（' + asr + '），请在设置里改回 asr 模型';
    if (tts && /(^|[-_])asr([-_]|$)/i.test(tts)) return '合成模型填成了识别模型（' + tts + '），请在设置里改回 tts 模型';
    return null;
  }

  function start() {
    if (_vc.running) return Promise.resolve(true);
    if (!_vc.open) {
      // 允许直接从代码调用：自动打开视图
      var opened = open();
      if (opened === false) return Promise.resolve(false);
    }
    uiCache();
    // 先做配置预检：没配好就别去申请麦克风（省一次系统弹窗，也让失败立刻可见）
    var pfErr = preflightConfig();
    if (pfErr) {
      setState('error', pfErr);
      toast(pfErr + '（去「设置 → 语音通话」配置）', 'warn');
      return Promise.resolve(false);
    }
    setState('connecting', '正在请求麦克风权限…');
    _vc.running = true;
    _vc.startedAt = Date.now();
    _vc.lastTurnAt = 0;
    _vc.callMarked = false;
    // 轮次按"这一通电话"算：不清零的话第二通电话的轮次会接着上一通数，
    //   时间感知和结束标注都会说出错误的"第几轮 / 共几轮"
    _vc.metrics.turns = 0;
    try { hookRouteChange(); } catch (e) {}
    refreshVoiceName();
    tickTimer();
    var conv = currentConvSafe();
    _session.convId = conv ? conv.id : null;

    // v127：语音接口是独立配置，接通前顺手把「模型名对不对」也确认一遍。
    //   以前靠"第一次说话才报 401"，用户会以为是自己麦克风坏了。
    //   这里只做本地检查（不发请求），失败就立刻说清楚是哪个接口、缺什么。
    var quickErr = quickVoiceSanity();
    if (quickErr) {
      _vc.running = false;
      setState('error', quickErr);
      toast(quickErr, 'warn');
      return Promise.resolve(false);
    }

    // 关键：先同步拿到 getUserMedia 的 promise（Android 15 要求手势内触发）
    var capturePromise = null;
    try { capturePromise = beginCapture(); } catch (e) { capturePromise = Promise.reject(e); }
    setState('connecting', '等待你在系统弹窗里点「允许」…');

    // 首次授权在真机上会挂 2~4 秒，给 60 秒宽限；超时才报错
    return withTimeout(capturePromise, 60000, '麦克风授权').then(function (info) {
      if (!_vc.running) return false;
      log('采集就绪', info && info.sampleRate);
      // 播放器必须在这里挂上：否则 TTS 的 PCM 无处可去，
      //   pipeline 的"排空"判定永远等不到，一轮就会卡死在 thinking。
      ensurePlayer();
      // 麦克风真的拿到了才算接通：在这条时间线上留一条标注
      _vc.callMarked = !!appendCallMarker('start');
      setState('listening');
      haptic('connect');          // 接通：轻振一下，告诉用户"能说了"
      startAutoHangTimer();
      // 后台预热语气词（零延迟补白）
      setTimeout(function () { prewarmFillers(); }, 50);
      return true;
    }).catch(function (e) {
      _vc.running = false;
      var msg = (e && e.message) ? e.message : '麦克风启动失败';
      setState('error', msg);
      toast(msg, 'warn');
      return false;
    });
  }

  function hangup(silent) {
    var wasRunning = _vc.running;
    _vc.running = false;
    _vc.turnId++;
    abortCurrentTurn('hangup');
    try { if (_vc.player) _vc.player.hardStop(); } catch (e) {}
    stopCapture();
    clearFillerTimer();
    clearSpeakWatchdog();
    clearTimeout(_vc.autoHangTimer);
    _vc.autoHangTimer = null;
    _vc.segChunks = [];
    _vc.saidText = '';
    if (!silent && _vc.callMarked) {
      // 先写标注再清状态：标注要用到 startedAt / turns
      appendCallMarker('end');
    }
    _vc.callMarked = false;
    if (!silent && wasRunning) {
      flashEffect('is-hangup', null, 600);
      haptic('hangup');
      log('挂断');
    }
    if (!silent) {
      setState('idle');
      setUserLine('', false);
      setAssistantLine('', false);
      if (UI.signals) UI.signals.innerHTML = '';
      _vc.startedAt = 0;
      tickTimer();
    }
    return true;
  }

  function interrupt() {
    if (_vc.state === 'speaking' || _vc.state === 'thinking') {
      doBargeIn();
      return true;
    }
    return false;
  }

  function toggleMute() {
    _vc.muted = !_vc.muted;
    try { if (UI.btnMute) UI.btnMute.classList.toggle('is-on', _vc.muted); } catch (e) {}
    toast(_vc.muted ? '已静音（AI 听不到你）' : '已取消静音', 'info');
    if (_vc.muted) {
      _vc.segChunks = [];
      _vc.preroll = [];
      _vc.prerollSamples = 0;
      try { if (_vc.vad) _vc.vad.reset(); } catch (e) {}
      updateOrbLevel(0);
    }
    return _vc.muted;
  }

  // =====================================================================================
  // 24. 测试语音链路（voice-settings.js 的「测试语音链路」按钮调用）
  // =====================================================================================

  function testChain(onProgress) {
    var push = (typeof onProgress === 'function') ? onProgress : function () {};
    var asrOk = false, ttsOk = false, roundTripOk = null;
    var asrLabel = '', ttsLabel = '';
    var roundTripReason = '';

    // 第一级：连通性探测。
    //   为什么用 0.35s 静音 wav：ASR 只接受 wav/mp3，没有 TTS 就先造不出真实语音。
    //   为什么判据是 HTTP 2xx 而不是"必须转出文本"：静音被幻觉成文字是上游已知行为
    //   （契约 §1.1 实测），拿一个已知不可靠的观测量去测另一个东西，只会自欺（看板 §4.12）。
    //   真实通话路径绝不会把静音送进 ASR —— VAD 门限在客户端就拦掉了（见 handleCaptureBlock）。
    function probeAsr() {
      push('识别服务：检测中…');
      var n = Math.round(CAPTURE_RATE * 0.35);
      var wav = encodeWav(int16ToBytes(new Int16Array(n)), CAPTURE_RATE);
      var built = buildReq('asr', {
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: bytesToBase64(wav), format: 'wav' } }] }]
      });
      asrLabel = built.model;
      return httpPost(built.req, 15000).then(function (resp) {
        if (resp.status >= 400) throw makeErr('HTTP ' + resp.status + '：' + errTextFrom(resp.data), 'voice_asr');
        asrOk = true;
        push('识别服务：可达（' + built.model + '）');
      }).catch(function (e) {
        push('识别服务：不可达（' + built.model + '）—— ' + (e && e.message || e));
      });
    }

    function probeTts() {
      push('合成服务：检测中…');
      var built = buildReq('tts', buildTtsBody('测试'));
      if (built.req.payload && built.req.payload.audio && built.req.payload.audio.voice === '__CLONE_REF__') {
        built.req.payload.audio.voice = strOf(voiceCfg().voiceId) || 'Mia';
      }
      ttsLabel = built.model + ' / ' + voiceLabelSafe();
      return httpPost(built.req, 25000).then(function (resp) {
        if (resp.status >= 400) throw makeErr('HTTP ' + resp.status + '：' + errTextFrom(resp.data), 'voice_tts');
        var data = resp.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
        var ch = data && data.choices && data.choices[0];
        var audio = ch && ch.message && ch.message.audio;
        if (!audio || !audio.data) throw makeErr('响应里没有音频数据', 'voice_tts');
        var bytes = base64ToBytes(audio.data);
        if (!bytes.length) throw makeErr('音频数据为空', 'voice_tts');
        ttsOk = true;
        push('合成服务：可达（' + ttsLabel + '）');
        return bytes;
      }).catch(function (e) {
        push('合成服务：不可达（' + ttsLabel + '）—— ' + (e && e.message || e));
        return null;
      });
    }

    // 第二级：往返验证。TTS 合成 → 喂回 ASR → 看转写是否非空。
    //   一级探测发现不了"模型名指错 / 密钥串了 / 格式不兼容"，往返能。
    //   失败不报"链路不通"，只报"往返未通过"，措辞要准。
    function probeRoundTrip(ttsBytes) {
      if (!asrOk || !ttsOk) { push('往返验证：跳过（前两级未全通）'); return Promise.resolve(null); }
      if (!ttsBytes || !ttsBytes.length) { push('往返验证：跳过（没有可用于回灌的音频）'); return Promise.resolve(null); }
      push('往返验证：进行中…');
      // 关键：请求体固定写 format:'wav'，所以发给 ASR 的**必须是真的 WAV**（带 RIFF 头）。
      //   绝不能"没有头就原样透传" —— 那正是「声明了一种格式却没保证内容真的是它」的 bug 形状
      //   （看板 §4.14：回退路径最容易长 bug，主路径对、回退路径类型不同、下游不知道）。
      //   TTS 侧固定 audio.format='pcm'（流式播放要裸 PCM），所以无头分支一定也是裸 PCM@24k。
      var wav;
      try {
        wav = pcmBytesToWav16k(ttsBytes);
      } catch (e) {
        push('往返验证：未通过（音频回灌处理失败：' + (e && e.message || e) + '）');
        return Promise.resolve(false);
      }
      if (!wav || wav.length <= 44) {
        push('往返验证：未通过（合成音频为空，无法回灌）');
        return Promise.resolve(false);
      }
      var built = buildReq('asr', {
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: bytesToBase64(wav), format: 'wav' } }] }]
      });
      return httpPost(built.req, 20000).then(function (resp) {
        // 与一级探测保持一致：把上游的 error.message / error.param 一起带出来，
        // 光看 "HTTP 400" 是查不出原因的（这次格式 bug 就是这么被藏住的）。
        if (resp.status >= 400) throw makeErr('HTTP ' + resp.status + '：' + errTextFrom(resp.data), 'voice_asr');
        var data = resp.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
        var ch = data && data.choices && data.choices[0];
        var text = ch && ch.message ? strOf(ch.message.content).trim() : '';
        // 只要求"转出非空文本"；不比对内容是否逐字一致（TTS 非确定性，契约 §1.1 明说不要做逐字对齐假设）
        if (text) {
          roundTripOk = true;
          push('往返验证：通过，识别回「' + text + '」');
        } else {
          roundTripOk = false;
          roundTripReason = '识别结果为空';
          push('往返验证：未通过（识别结果为空，可能模型或格式不匹配）');
        }
        return roundTripOk;
      }).catch(function (e) {
        roundTripOk = false;
        roundTripReason = (e && e.message) || '请求失败';
        push('往返验证：未通过（' + roundTripReason + '，可能模型或格式不匹配）');
        return false;
      });
    }

    var brainNote = '';
    try {
      var b = resolveVoiceProvider('brain');
      brainNote = '通话大脑：' + b.model + ' @ ' + b.label;
    } catch (e) {
      brainNote = '通话大脑：不可用 —— ' + (e && e.message || e);
    }

    return Promise.resolve()
      .then(probeAsr)
      .then(probeTts)
      .then(function (ttsBytes) { return probeRoundTrip(ttsBytes); })
      .then(function () {
        push(brainNote);
        // 结论：两级探测是硬判据；往返只是加分项，不通过也不算"链路不可用"
        var usable = asrOk && ttsOk;
        if (usable && roundTripOk === true) push('结论：链路可用（含往返验证）');
        else if (usable && roundTripOk === false) push('结论：链路可用；识别服务可达，但往返验证未通过（可能模型/格式不匹配）');
        else if (usable) push('结论：链路可用');
        else push('结论：链路不可用，请按上面提示检查渠道与密钥');
        return usable;
      })
      .catch(function (e) {
        push('结论：链路不可用 —— ' + (e && e.message || e));
        return false;
      });
  }

  // 把"可能是 wav、也可能是裸 PCM"的字节，统一转成合法的 16k/mono/16bit WAV。
  //   · 有 RIFF 头 → 按头里的采样率/位深处理（剥头，只取 data 段）
  //   · 没有头     → 按 TTS_RATE(24000) 裸 PCM 处理（TTS 侧固定 audio.format='pcm'）
  // 两条分支的产出都是**带 RIFF 头的真 WAV**，调用方可以无条件声明 format:'wav'。
  function pcmBytesToWav16k(bytes, fallbackRate) {
    if (!bytes || !bytes.length) return null;
    var hdr = parseWavHeader(bytes);
    var sampleRate, pcmBytes, bits;
    if (hdr) {
      sampleRate = hdr.sampleRate || TTS_RATE;
      bits = hdr.bits || 16;
      pcmBytes = bytes.subarray(hdr.pcmOffset, hdr.pcmOffset + hdr.dataBytes);
    } else {
      sampleRate = num(fallbackRate, TTS_RATE);
      bits = 16;
      pcmBytes = bytes;
    }
    if (!pcmBytes || !pcmBytes.length) return null;
    var i16 = bytesToInt16(pcmBytes);   // 上游都是 16bit 小端，位深不同也先按 16bit 解（可听，不崩）
    var rs = new Resampler(sampleRate, CAPTURE_RATE);
    var out = rs.process(int16ToFloat32(i16));
    var outBytes = int16ToBytes(floatToInt16(out));
    return encodeWav(outBytes, CAPTURE_RATE);
  }

  function voiceLabelSafe() {
    try {
      var VS = root.VoiceSettings;
      if (VS && typeof VS.currentVoiceLabel === 'function') return strOf(VS.currentVoiceLabel());
    } catch (e) {}
    return strOf(voiceCfg().voiceId) || 'Mia';
  }

  // =====================================================================================
  // 24b. 设置面板「高级」区（真机可调参数）
  // =====================================================================================
  // 为什么由 voice.js 自己注入 DOM，而不是写进 index.html：
  //   ① 这些参数是"只有真机才调得准"的量，和本文件里的默认值是一份真相，放一起才不会漂
  //   ② index.html / voice-settings.js 归别人所有，我改不了也不该改
  //   ③ 用户看不到的旋钮等于没有 —— 出问题只能改代码重新发版
  // 注入策略：挂到 [data-group-key="voice"] 的 .setting-group-body 末尾，用现有的
  //   setting-row / setting-select 等类名，样式自动跟随（ui-polish 不用为它写新样式）。

  // v127：微调面板重做。
  //   旧版是 5 个裸数字输入框，还分成「全局」和「外放/耳机」两套互相干扰。
  //   用户原话：「这么多设置你让人怎么调？凭感觉一个一个试吗？而且还是手填数值？」
  //   新的做法：
  //     · 常用项做成档位滑杆，用户选「感觉」而不是记数字；
  //     · 其余收进 <details>，默认折叠，想折腾的再展开。
  var TUNING_FIELDS = [
    {
      key: 'echoGuardMs', label: '防自激窗口', min: 0, max: 1200, step: 50, dflt: 250, unit: '毫秒',
      hint: 'AI 刚开口这段时间内不判断打断。外放回声大导致 AI 自己打断自己时调大。'
    },
    {
      key: 'bargeInHoldMs', label: '打断确认时长', min: 80, max: 800, step: 20, dflt: 180, unit: '毫秒',
      hint: '要连续说这么久才算打断。动不动就被打断时调大；觉得抢话不够快时调小。'
    },
    {
      key: 'bargeInLeakFactor', label: '回漏抑制系数', min: 1.5, max: 10, step: 0.1, dflt: 3.2, unit: '',
      hint: '打断阈值 = 自播放回漏能量 × 这个系数。外放时 AI 被自己的声音触发，就把这个数调高。'
    },
    {
      key: 'endpointSilenceMs', label: '说完判定静音', min: 200, max: 3000, step: 50, dflt: 700, unit: '毫秒',
      hint: '你停下这么久 AI 就认为你说完了。觉得接话太慢调小；总被打断话头就调大。'
    },
    {
      key: 'minUtteranceMs', label: '最短话语', min: 100, max: 2000, step: 50, dflt: 400, unit: '毫秒',
      hint: '短于这个时长的片段直接丢弃，不送识别（防止把咳嗽、关门声送去识别成文字）。'
    }
  ];

  // 档位滑杆：把「说不清的数字」翻译成「听得懂的描述」。
  //   每一档带一组具体数值，用户只需选感受，不用记 700 还是 875。
  var TUNING_DIALS = [
    {
      key: 'endpointSilenceMs', label: '接话快慢', lowLabel: '不抢话', highLabel: '秒接',
      hint: '你停顿多久，它才认为你说完了。往右拨 = 接话更快，但更容易打断你思考。',
      steps: [
        { v: 1100, name: '很稳' },
        { v: 875, name: '偏稳' },
        { v: 700, name: '均衡' },
        { v: 550, name: '偏快' },
        { v: 420, name: '很快' }
      ]
    },
    {
      key: 'echoGuardMs', label: '抗回声强度', lowLabel: '灵敏', highLabel: '抗回声',
      hint: '外放时 AI 容易被自己的声音打断。往右拨 = 更不容易自激，但打断也会稍微迟钝。',
      steps: [
        { v: 0, name: '关' },
        { v: 150, name: '弱' },
        { v: 250, name: '标准' },
        { v: 400, name: '强' },
        { v: 600, name: '很强' }
      ]
    },
    {
      key: 'minUtteranceMs', label: '防误触', lowLabel: '敏感', highLabel: '严格',
      hint: '多短的声音算「不是说话」。往右拨 = 咳嗽、关门声更不会被当成一句话。',
      steps: [
        { v: 200, name: '敏感' },
        { v: 300, name: '偏敏感' },
        { v: 400, name: '标准' },
        { v: 600, name: '偏严格' },
        { v: 900, name: '严格' }
      ]
    }
  ];

  function ensureAdvancedUI() {
    if (el('voice-dials')) return true;                  // 幂等
    var group = null;
    try { group = document.querySelector('[data-group-key="voice"]'); } catch (e) { group = null; }
    if (!group) return false;
    var body = group.querySelector('.setting-group-body') || group;

    // ---- 第一层：三档滑杆（常用项，永远可见）----
    var dials = document.createElement('div');
    dials.id = 'voice-dials';
    var h = '';
    h += '<div class="setting-divider"></div>';
    h += '<span class="setting-section-title">通话手感</span>';
    h += '<span class="setting-hint">直接选感受就行，不用记数字。改完下一轮通话立即生效。</span>';
    for (var i = 0; i < TUNING_DIALS.length; i++) {
      var d = TUNING_DIALS[i];
      h += '<div class="voice-dial" data-key="' + d.key + '">';
      h += '<div class="voice-dial-head"><span class="voice-dial-label">' + escapeText(d.label) + '</span>';
      h += '<span class="voice-dial-value" id="voice-dial-val-' + d.key + '"></span></div>';
      h += '<input type="range" class="voice-dial-range" id="voice-dial-' + d.key + '" ';
      h += 'min="0" max="' + (d.steps.length - 1) + '" step="1" value="2">';
      h += '<div class="voice-dial-scale"><span>' + escapeText(d.lowLabel) + '</span>';
      h += '<span>' + escapeText(d.highLabel) + '</span></div>';
      h += '<span class="setting-hint">' + escapeText(d.hint) + '</span>';
      h += '</div>';
    }
    dials.innerHTML = h;
    body.appendChild(dials);

    // ---- 第二层：高级项，默认折叠 ----
    var adv = document.createElement('details');
    adv.id = 'voice-advanced-details';
    adv.className = 'voice-adv';
    var ah = '';
    ah += '<summary class="voice-adv-summary">高级参数（一般不用动）</summary>';
    ah += '<div class="voice-adv-body">';
    ah += '<span class="setting-hint">这些是滑杆背后的具体数值。想精确控制时再展开，平时留空即可。</span>';
    for (var j = 0; j < TUNING_FIELDS.length; j++) {
      var f = TUNING_FIELDS[j];
      ah += '<label class="setting-row setting-row-col">';
      ah += '<span>' + escapeText(f.label) + (f.unit ? '（' + escapeText(f.unit) + '）' : '') + '</span>';
      ah += '<input type="number" id="voice-tune-' + f.key + '" class="setting-select setting-num" ';
      ah += 'min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" placeholder="默认 ' + f.dflt + '">';
      ah += '<span class="setting-hint">' + escapeText(f.hint) + '</span>';
      ah += '</label>';
    }
    ah += '<button id="btn-voice-tune-reset" class="btn btn-small" style="background:var(--bg3);color:var(--text)">恢复默认</button>';
    ah += '</div>';
    adv.innerHTML = ah;
    body.appendChild(adv);

    // 滑杆绑定：位置 → 档位值 → settings
    for (var k = 0; k < TUNING_DIALS.length; k++) {
      (function (dial) {
        var range = el('voice-dial-' + dial.key);
        if (!range) return;
        var apply = function (commit) {
          var idx = Math.max(0, Math.min(dial.steps.length - 1, parseInt(range.value, 10) || 0));
          var step = dial.steps[idx];
          voiceCfg()[dial.key] = step.v;
          var valEl = el('voice-dial-val-' + dial.key);
          if (valEl) valEl.textContent = step.name;
          if (commit) saveSettingsSafe();
        };
        range.addEventListener('input', function () { apply(false); });
        range.addEventListener('change', function () { apply(true); });
      })(TUNING_DIALS[k]);
    }

    // 高级输入框绑定（与滑杆双向一致：手填了就以手填为准）
    for (var m = 0; m < TUNING_FIELDS.length; m++) {
      (function (field) {
        var input = el('voice-tune-' + field.key);
        if (!input) return;
        var commit = function () {
          var raw = input.value.trim();
          if (raw === '') {
            delete voiceCfg()[field.key];
            saveSettingsSafe();
            syncDials();
            return;
          }
          var n = num(raw, field.dflt);
          n = Math.max(field.min, Math.min(field.max, n));
          voiceCfg()[field.key] = n;
          input.value = String(n);
          saveSettingsSafe();
          syncDials();
        };
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
      })(TUNING_FIELDS[m]);
    }

    var resetBtn = el('btn-voice-tune-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        var cfg = voiceCfg();
        for (var q = 0; q < TUNING_FIELDS.length; q++) {
          delete cfg[TUNING_FIELDS[q].key];
          var inp = el('voice-tune-' + TUNING_FIELDS[q].key);
          if (inp) inp.value = '';
        }
        saveSettingsSafe();
        syncDials();
        toast('已恢复默认', 'info');
      });
    }
    syncDials();
    log('通话手感面板已注入');
    return true;
  }

  // 把当前设置值反映到滑杆位置（最接近的那一档）
  function syncDials() {
    for (var i = 0; i < TUNING_DIALS.length; i++) {
      var d = TUNING_DIALS[i];
      var range = el('voice-dial-' + d.key);
      if (!range) continue;
      var cur = voiceCfg()[d.key];
      var curNum = num(cur, NaN);
      var best = 2;
      if (isFinite(curNum)) {
        var bestDiff = Infinity;
        for (var j = 0; j < d.steps.length; j++) {
          var diff = Math.abs(d.steps[j].v - curNum);
          if (diff < bestDiff) { bestDiff = diff; best = j; }
        }
      }
      range.value = String(best);
      var valEl = el('voice-dial-val-' + d.key);
      if (valEl) valEl.textContent = d.steps[best].name;
    }
  }

  function saveSettingsSafe() {
    try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) { warn('saveSettings', e); }
  }

  // 设置面板每次打开都试一次（骨架可能是后到的）
  var _advBoundOpen = false;
  function hookAdvancedUI() {
    if (_advBoundOpen) return;
    var btn = el('btn-settings');
    if (!btn) return;
    _advBoundOpen = true;
    btn.addEventListener('click', function () {
      setTimeout(function () { try { ensureAdvancedUI(); fillAdvancedUI(); } catch (e) { warn('advanced ui', e); } }, 0);
    });
  }

  function fillAdvancedUI() {
    // 每次打开设置都重新回填：用户可能刚改过、也可能点了「恢复默认」
    for (var i = 0; i < TUNING_FIELDS.length; i++) {
      var f = TUNING_FIELDS[i];
      var input = el('voice-tune-' + f.key);
      if (!input) continue;
      var cur = voiceCfg()[f.key];
      input.value = (cur === undefined || cur === null || cur === '') ? '' : String(cur);
    }
    syncDials();
  }

  // =====================================================================================
  // 25. 事件绑定与初始化
  // =====================================================================================

  function bindOnce(id, handler) {
    var node = el(id);
    if (!node) return null;
    node.addEventListener('click', handler);
    return node;
  }

  var _bound = false;

  function init() {
    if (_bound) return;
    _bound = true;
    uiCache();
    bindOnce('btn-open-voice-view', function () { open(); });
    bindOnce('btn-voice-back', function () { if (_vc.running) hangup(); close(); });
    bindOnce('btn-voice-hangup', function () { hangup(); setTimeout(function () { close(); }, 220); });
    bindOnce('btn-voice-call', function () {
      // 必须在 click 里同步调用 start（Android 15 要求手势内触发 getUserMedia）
      start();
    });
    bindOnce('btn-voice-mute', function () { toggleMute(); });
    bindOnce('btn-voice-interrupt', function () { interrupt(); });
    bindOnce('btn-voice-settings', function () {
      try {
        if (typeof toggleSettings === 'function') toggleSettings(true);
      } catch (e) { toast('无法打开设置', 'warn'); }
      try {
        var VS = root.VoiceSettings;
        if (VS && typeof VS.sync === 'function') setTimeout(function () { VS.sync(); }, 0);
      } catch (e) {}
    });

    // Android 物理返回键（image-gen.js 的主链已经处理 state.voiceOpen，这里是二次兜底）
    try {
      if (typeof isCapacitor === 'function' && isCapacitor() && root.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App) {
        Capacitor.Plugins.App.addListener('backButton', function () {
          var st = ST();
          if (st && st.voiceOpen) {
            if (_vc.running) hangup();
            close();
          }
        });
      }
    } catch (e) {}

    // 真机微调面板：注入到设置面板的「语音通话」分组里（幂等；骨架没到就等下次打开设置）
    try { hookAdvancedUI(); ensureAdvancedUI(); } catch (e) { warn('advanced init', e); }

    // 外放/耳机切换：只更新路由缓存，不打断正在进行的通话（参数都是下一次读取时生效）
    try { hookRouteChange(); } catch (e) {}

    // 换音色/人设后语气词要重做一批
    try {
      if (root.document && root.document.addEventListener) {
        root.document.addEventListener('chatlite:voice-voice-changed', function () {
          _vc.fillerBuffers = [];
          if (_vc.open) prewarmFillers();
          refreshVoiceName();
        });
      }
    } catch (e) {}

    // 页面卸载时释放麦克风（否则系统会一直显示录音中）
    try {
      if (root.addEventListener) {
        root.addEventListener('pagehide', function () { stopCapture(); });
        root.addEventListener('beforeunload', function () { stopCapture(); });
      }
    } catch (e) {}

    log('已初始化', VERSION);
  }

  // =====================================================================================
  // 26. 对外 API
  // =====================================================================================

  var API = {
    version: VERSION,
    open: open,
    close: close,
    isOpen: function () { return !!_vc.open; },
    start: start,
    hangup: hangup,
    interrupt: interrupt,
    toggleMute: toggleMute,
    isMuted: function () { return !!_vc.muted; },
    isRunning: function () { return !!_vc.running; },
    getState: function () { return _vc.state; },
    getMetrics: function () {
      return {
        asrMs: _vc.metrics.asrMs,
        brainMs: _vc.metrics.brainFirstTokenMs,
        brainFirstTokenMs: _vc.metrics.brainFirstTokenMs,
        ttsFirstChunkMs: _vc.metrics.ttsFirstChunkMs,
        turnTotalMs: _vc.metrics.turnTotalMs,
        turns: _vc.metrics.turns,
        lastTurn: _vc.metrics.lastTurn
      };
    },
    __testChain: testChain,
    __selfTest: function () { return runSelfTest(); },
    // 调试钩子：把一段 PCM 直接当作"用户说完了一句话"喂进整条链路。
    //   用途：无麦克风的自动化测试（CDP 里没法真说话），走的是与真实完全相同的
    //   runTurn → ASR → 大脑 → TTS → 播放 → 写回会话 路径，只是跳过了 VAD 判定。
    //   生产代码不会调用它。
    __injectUtterance: function (pcmInt16) {
      if (!_vc.running) return 'not-running';
      var pcm = pcmInt16;
      if (!pcm || !pcm.length) return 'empty';
      _vc.segChunks = [pcm];
      _vc.segSamples = pcm.length;
      _vc.segOnsetMs = 0;
      finishUtterance('inject');
      return 'ok';
    },
    __debug: function () {
      return {
        state: _vc.state, running: _vc.running, open: _vc.open, muted: _vc.muted,
        captureRate: _vc.audioCtx ? _vc.audioCtx.sampleRate : 0,
        vad: _vc.vad ? { phase: _vc.vad.phase(), thr: _vc.vad.threshold(), noise: _vc.vad.noiseFloor() } : null,
        route: currentRoute(),
        tuning: {
          echoGuardMs: effectiveTuning('echoGuardMs', ECHO_GUARD_MS),
          bargeInHoldMs: effectiveTuning('bargeInHoldMs', BARGE_HOLD_MS),
          bargeInLeakFactor: effectiveTuning('bargeInLeakFactor', BARGE_LEAK_FACTOR),
          leakFloor: effectiveTuning('leakFloor', BARGE_LEAK_FLOOR),
          endpointSilenceMs: effectiveTuning('endpointSilenceMs', VAD_DEFAULTS.endpointSilenceMs),
          minUtteranceMs: effectiveTuning('minUtteranceMs', VAD_DEFAULTS.minUtteranceMs),
          sensitivity: effectiveTuning('sensitivity', 0.5)
        },
        rate: { value: _vc.player ? _vc.player.rate : clampRate(voiceCfg().rate), mode: _vc.player ? _vc.player.rateMode : (strOf(voiceCfg().rateMode) === 'pitch' ? 'pitch' : 'natural') },
        leakRms: Math.round((_vc.leakRms || 0) * 10000) / 10000,
        fillers: _vc.fillerBuffers.filter(Boolean).length,
        metrics: API.getMetrics()
      };
    },
    __test: {}
  };

  // =====================================================================================
  // 27. 纯逻辑导出（供 tests/voice-runtime.test.js 在 node 里直接跑）
  // =====================================================================================

  API.__test = {
    // 编码
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    int16ToBytes: int16ToBytes,
    bytesToInt16: bytesToInt16,
    floatToInt16: floatToInt16,
    int16ToFloat32: int16ToFloat32,
    concatInt16: concatInt16,
    // 重采样
    Resampler: Resampler,
    resample: function (input, inRate, outRate) {
      var rs = new Resampler(inRate, outRate);
      return rs.process(input);
    },
    // 能量
    frameRms: frameRms,
    toDb: toDb,
    // WAV
    encodeWav: encodeWav,
    parseWavHeader: parseWavHeader,
    splitPcmTail: splitPcmTail,
    // 回归测试用：任意 PCM 字节 → 合法 16k WAV（两条分支都必须产出带 RIFF 头的真 WAV）
    pcmBytesToWav16k: pcmBytesToWav16k,
    // VAD
    createVad: createVad,
    VAD_DEFAULTS: VAD_DEFAULTS,
    // 信号
    computeSignals: computeSignals,
    attachTranscriptToSignals: attachTranscriptToSignals,
    pitchAutocorr: pitchAutocorr,
    // 文本
    splitSentences: splitSentences,
    firstSentence: firstSentence,
    jsonUnescape: jsonUnescape,
    extractJsonString: extractJsonString,
    createSpeechExtractor: createSpeechExtractor,
    // 语速 & 路由
    makeTimeStretcher: makeTimeStretcher,
    clampRate: clampRate,
    RATE_MIN: RATE_MIN,
    RATE_MAX: RATE_MAX,
    effectiveTuning: effectiveTuning,
    currentRoute: currentRoute,
    normalizeRoute: normalizeRoute,
    routeValueOf: routeValueOf,
    // 大脑渠道 / 提示词组装
    resolveVoiceProvider: resolveVoiceProvider,
    buildSessionSystemParts: buildSessionSystemParts,
    buildClock: buildClock,
    buildBrainMessages: buildBrainMessages,
    historyMessages: historyMessages,
    appendCallMarker: appendCallMarker,
    // 其它
    clamp: clamp,
    num: num,
    hapticEnabled: hapticEnabled,
    tuning: tuning,
    TUNING_RANGES: TUNING_RANGES,
    HAPTIC_PATTERNS: HAPTIC_PATTERNS,
    isAudioModel: isAudioModel,
    pickChatModel: pickChatModel,
    canBeBrain: canBeBrain,
    CAPTURE_RATE: CAPTURE_RATE,
    TTS_RATE: TTS_RATE
  };

  // 供脚本化自检（__selfTest），不依赖 DOM
  function runSelfTest() {
    var T = API.__test;
    var out = { ok: true, cases: [] };
    function check(name, fn) {
      try {
        var r = fn();
        out.cases.push({ name: name, ok: r === true, detail: r === true ? '' : String(r) });
        if (r !== true) out.ok = false;
      } catch (e) {
        out.cases.push({ name: name, ok: false, detail: (e && e.message) || String(e) });
        out.ok = false;
      }
    }
    check('base64 往返', function () {
      var b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
      var back = T.base64ToBytes(T.bytesToBase64(b));
      if (back.length !== b.length) return 'length ' + back.length;
      for (var i = 0; i < b.length; i++) if (back[i] !== b[i]) return 'byte ' + i;
      return true;
    });
    check('WAV 头 44 字节', function () {
      var wav = T.encodeWav(new Uint8Array([1, 2, 3, 4]), 16000);
      if (wav.length !== 48) return 'len ' + wav.length;
      var h = T.parseWavHeader(wav);
      if (!h || h.sampleRate !== 16000 || h.channels !== 1) return 'header';
      return true;
    });
    check('重采样 48k→16k 长度', function () {
      var input = new Float32Array(4800);
      var out = T.resample(input, 48000, 16000);
      return out.length >= 1590 && out.length <= 1610 ? true : 'got ' + out.length;
    });
    check('VAD 静音不触发', function () {
      var v = T.createVad({ sensitivity: 0.5 });
      var saw = false;
      for (var i = 0; i < 100; i++) { var e = v.feed(0.001, 20); if (e === 'speech-start') saw = true; }
      return saw ? '误触发' : true;
    });
    check('VAD 长语音触发 speech-start', function () {
      var v = T.createVad({ sensitivity: 0.5 });
      for (var i = 0; i < 20; i++) v.feed(0.001, 20);      // 标定
      var got = false;
      for (var j = 0; j < 30; j++) { if (v.feed(0.3, 20) === 'speech-start') { got = true; break; } }
      return got ? true : '未触发';
    });
    check('句子切分', function () {
      var s = T.splitSentences('你好呀。今天天气不错！我们出去走走吧？', { minLen: 1 });
      return s.length === 3 ? true : JSON.stringify(s);
    });
    check('流式 JSON 提取首句', function () {
      var ex = T.createSpeechExtractor();
      var got = [];
      got = got.concat(ex.push('{"speech":"你别急，我这边正在收尾'));
      got = got.concat(ex.push('了，大概下午就能发你。","emotion":"安抚"}'));
      return got.length >= 1 && /收尾/.test(got[0]) ? true : JSON.stringify(got);
    });
    return out;
  }

  // =====================================================================================
  // 28. 挂载
  // =====================================================================================

  root.VoiceCall = API;

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () { try { init(); } catch (e) { warn('init failed', e); } });
    } else {
      // DOM 已经就绪（voice.js 是最后一个 script）：延后一拍，等 app.js 的 init 先跑
      setTimeout(function () { try { init(); } catch (e) { warn('init failed', e); } }, 0);
    }
  }

})(typeof window !== 'undefined' ? window : globalThis);
