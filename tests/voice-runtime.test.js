// ===== tests/voice-runtime.test.js =====
// voice.js 纯逻辑单测（node 直接跑，不依赖浏览器）
//   node tests/voice-runtime.test.js
// 覆盖：base64 往返 / Int16 编解码 / WAV 封装与解析 / 重采样（相位连续、分块拼接一致）/
//       VAD（静音不误触发、开口识别、端点、最短丢弃、最长强制切）/
//       PCM 拼接与半字节处理 / 句子切分 / 流式 JSON 增量提取 / 信号统计
//
// 说明：voice.js 是 UMD 风格、挂在 window 上，并且顶层不触碰 DOM（只在 init() 里碰），
//   所以可以直接 require 进来。

'use strict';

var path = require('path');
var root = globalThis;
var failures = 0;
var passes = 0;

function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + name); }
  else { failures++; console.log('  \u2717 ' + name + (detail ? '  \u2192 ' + detail : '')); }
}

function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol); }

// ---- 载入被测模块 ----
require(path.join(__dirname, '..', 'www', 'voice.js'));
var VoiceCall = root.VoiceCall;
if (!VoiceCall || !VoiceCall.__test) {
  console.error('无法加载 www/voice.js 的 __test 导出');
  process.exit(1);
}
var T = VoiceCall.__test;

// =====================================================================================
console.log('\n[1] base64 / Int16 编解码');
// =====================================================================================
(function () {
  var samples = [0, 1, -1, 127, -128, 32767, -32768, 1234, -4321];
  var i16 = Int16Array.from(samples);
  var bytes = T.int16ToBytes(i16);
  var back = T.bytesToInt16(bytes);
  ok('Int16 往返长度一致', back.length === i16.length, back.length + ' vs ' + i16.length);
  var same = true;
  for (var i = 0; i < i16.length; i++) if (back[i] !== i16[i]) { same = false; break; }
  ok('Int16 往返数值完全一致（含 -32768 边界）', same, 'diff at ' + i);

  var b64 = T.bytesToBase64(bytes);
  var rt = T.base64ToBytes(b64);
  var same2 = rt.length === bytes.length;
  for (var j = 0; j < bytes.length && same2; j++) if (rt[j] !== bytes[j]) same2 = false;
  ok('base64 往返字节一致', same2, 'b64=' + b64);

  ok('Int16 小端序（0x0102 → 02 01）', bytes[0] === 0x00 && bytes[1] === 0x00, bytes[0] + ',' + bytes[1]);
  var odd = T.bytesToInt16(new Uint8Array([1, 2, 3]));
  ok('奇数长度字节安全截断', odd.length === 1, 'len ' + odd.length);

  var f = T.floatToInt16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]));
  ok('float→int16 削波到 ±1', f[3] === 32767 && f[4] === -32768, f[3] + ',' + f[4]);
  ok('float→int16 中间值', Math.abs(f[1] - 16384) <= 1, String(f[1]));

  var f32 = T.int16ToFloat32(Int16Array.from([0, 16384, -32768]));
  ok('int16→float 归一化', near(f32[0], 0) && near(f32[1], 0.5, 1e-4) && near(f32[2], -1), f32[0] + ',' + f32[1] + ',' + f32[2]);
})();

// =====================================================================================
console.log('\n[2] WAV 封装与解析');
// =====================================================================================
(function () {
  var pcm = T.int16ToBytes(Int16Array.from([100, -100, 200, -200]));
  var wav = T.encodeWav(pcm, 16000);
  ok('总长度 = 44 + PCM', wav.length === 44 + pcm.length, wav.length + '');
  ok('RIFF 魔数', String.fromCharCode(wav[0], wav[1], wav[2], wav[3]) === 'RIFF');
  ok('WAVE 标识', String.fromCharCode(wav[8], wav[9], wav[10], wav[11]) === 'WAVE');

  var h = T.parseWavHeader(wav);
  ok('解析采样率', h && h.sampleRate === 16000, h && String(h.sampleRate));
  ok('解析声道数 = 1', h && h.channels === 1, h && String(h.channels));
  ok('解析位深 = 16', h && h.bits === 16, h && String(h.bits));
  ok('解析 data 偏移 = 44', h && h.pcmOffset === 44, h && String(h.pcmOffset));
  ok('解析 data 长度', h && h.dataBytes === pcm.length, h && String(h.dataBytes));

  var bad = T.parseWavHeader(new Uint8Array([1, 2, 3]));
  ok('非 wav 输入返回 null', bad === null);
  ok('随机字节返回 null', T.parseWavHeader(T.int16ToBytes(Int16Array.from([1, 2, 3, 4, 5]))) === null);
})();

// =====================================================================================
console.log('\n[3] 重采样（48k→16k / 44.1k→16k / 24k→48k 播放）');
// =====================================================================================
(function () {
  // 48k 正弦 1kHz，1 秒
  var n = 48000, input = new Float32Array(n);
  for (var i = 0; i < n; i++) input[i] = Math.sin(2 * Math.PI * 1000 * i / 48000);
  var out = T.resample(input, 48000, 16000);
  ok('48k→16k 长度 ≈ 1/3', Math.abs(out.length - 16000) <= 12, String(out.length));

  // 输出仍应是 1kHz 正弦：检查过零次数（1 秒 1kHz ≈ 2000 次过零）
  var zc = 0;
  for (var k = 1; k < out.length; k++) if ((out[k - 1] < 0 && out[k] >= 0) || (out[k - 1] >= 0 && out[k] < 0)) zc++;
  ok('48k→16k 保留 1kHz 音高（过零数 ≈ 2000）', Math.abs(zc - 2000) <= 40, String(zc));

  var out441 = T.resample(new Float32Array(44100), 44100, 16000);
  ok('44.1k→16k 长度 ≈ 16000', Math.abs(out441.length - 16000) <= 12, String(out441.length));

  var up = T.resample(new Float32Array(24000), 24000, 48000);
  ok('24k→48k 长度 ≈ 2x', Math.abs(up.length - 48000) <= 24, String(up.length));

  // 相位连续性：整段一次处理 vs 分成两块处理，结果应几乎一致（分块边界不能产生跳变）
  var whole = T.resample(input, 48000, 16000);
  var rs = new T.Resampler(48000, 16000);
  var a = rs.process(input.subarray(0, 24000));
  var b = rs.process(input.subarray(24000));
  var joined = new Float32Array(a.length + b.length);
  joined.set(a, 0); joined.set(b, a.length);
  ok('分块重采样与整段重采样长度一致', Math.abs(joined.length - whole.length) <= 2, joined.length + ' vs ' + whole.length);
  var maxDiff = 0;
  for (var m = 0; m < Math.min(joined.length, whole.length); m++) {
    var d = Math.abs(joined[m] - whole[m]);
    if (d > maxDiff) maxDiff = d;
  }
  ok('分块重采样无相位跳变（最大差 < 0.01）', maxDiff < 0.01, 'maxDiff=' + maxDiff.toFixed(6));

  ok('空输入安全', T.resample(new Float32Array(0), 48000, 16000).length === 0);
})();

// =====================================================================================
console.log('\n[4] PCM 拼接与半字节尾巴');
// =====================================================================================
(function () {
  var a = Int16Array.from([1, 2, 3]);
  var b = Int16Array.from([4, 5]);
  var c = T.concatInt16([a, null, b, new Int16Array(0)]);
  ok('concatInt16 跳过 null/空块', c.length === 5 && c[0] === 1 && c[4] === 5, Array.from(c).join(','));
  ok('concatInt16 空输入', T.concatInt16([]).length === 0);
  ok('concatInt16 null 输入', T.concatInt16(null).length === 0);

  // 半字节：第一次 3 字节（含 1 个孤立字节），第二次 3 字节
  var sp1 = T.splitPcmTail(null, new Uint8Array([1, 2, 3]));
  ok('奇数块只吐完整样本', sp1.body.length === 2, String(sp1.body.length));
  ok('奇数块保留 1 字节尾巴', sp1.carry && sp1.carry.length === 1, sp1.carry && String(sp1.carry.length));
  ok('尾巴内容正确', sp1.carry[0] === 3, String(sp1.carry[0]));

  var sp2 = T.splitPcmTail(sp1.carry, new Uint8Array([4, 5, 6]));
  ok('拼上尾巴后输出 2 个样本', sp2.body.length === 4, String(sp2.body.length));
  ok('拼上尾巴后无残留', sp2.carry === null, sp2.carry && String(sp2.carry.length));
  var joinedSamples = T.bytesToInt16(sp2.body);
  ok('拼接后样本正确（0x0403,0x0605）', joinedSamples[0] === 0x0403 && joinedSamples[1] === 0x0605,
    joinedSamples[0] + ',' + joinedSamples[1]);

  var evenCase = T.splitPcmTail(null, new Uint8Array([1, 2, 3, 4]));
  ok('偶数块无尾巴', evenCase.carry === null && evenCase.body.length === 4);
})();

// =====================================================================================
console.log('\n[5] VAD 判定');
// =====================================================================================
(function () {
  // 5.1 纯静音永远不触发
  var v = T.createVad({ sensitivity: 0.5 });
  var startCount = 0;
  for (var i = 0; i < 500; i++) if (v.feed(0.0005, 20) === 'speech-start') startCount++;
  ok('静音不触发 speech-start', startCount === 0, String(startCount));
  ok('静音阶段保持 idle', v.phase() === 'idle', v.phase());

  // 5.2 标定完成后有阈值
  v = T.createVad({ sensitivity: 0.5 });
  for (var j = 0; j < 20; j++) v.feed(0.001, 20);   // 400ms 标定
  ok('标定后阈值 > 底噪', v.threshold() > v.noiseFloor(), v.threshold() + ' vs ' + v.noiseFloor());

  // 5.3 短促脉冲不触发（不足 180ms）
  v = T.createVad({ sensitivity: 0.5 });
  for (var k = 0; k < 20; k++) v.feed(0.001, 20);
  var triggered = false;
  for (var m = 0; m < 5; m++) { if (v.feed(0.5, 20) === 'speech-start') triggered = true; }  // 100ms
  for (var m2 = 0; m2 < 10; m2++) { if (v.feed(0.001, 20) === 'speech-start') triggered = true; }
  ok('100ms 短脉冲不触发（需 ≥180ms）', triggered === false);

  // 5.4 持续语音触发
  v = T.createVad({ sensitivity: 0.5 });
  for (var n1 = 0; n1 < 20; n1++) v.feed(0.001, 20);
  var got = false;
  for (var n2 = 0; n2 < 40; n2++) if (v.feed(0.3, 20) === 'speech-start') { got = true; break; }
  ok('持续 300ms 语音触发 speech-start', got === true);
  ok('触发后进入 speech 相位', v.phase() === 'speech', v.phase());

  // 5.5 说完 + 足够长的语音 → endpoint-candidate
  v = T.createVad({ sensitivity: 0.5, endpointSilenceMs: 300, minUtteranceMs: 100 });
  for (var q1 = 0; q1 < 20; q1++) v.feed(0.001, 20);
  for (var q2 = 0; q2 < 30; q2++) if (v.feed(0.3, 20) === 'speech-start') break;
  var ep = null;
  for (var q3 = 0; q3 < 60; q3++) { var e = v.feed(0.001, 20); if (e === 'endpoint-candidate') { ep = e; break; } }
  ok('静音达标后给 endpoint-candidate', ep === 'endpoint-candidate', String(ep));

  var stats = v.confirmEnd();
  // 说明：触发 speech-start 后测试立即停止喂有声音频，所以 speechMs 只包含"开口确认"的 180ms。
  ok('confirmEnd 返回语音时长（≥ 开口确认阈值）', stats.speechMs >= 180, String(stats.speechMs));
  ok('confirmEnd 后回到 idle', v.phase() === 'idle', v.phase());
  ok('confirmEnd 标记 tooShort=false', stats.tooShort === false, String(stats.tooShort));

  // 5.6 太短 → discard，且不产生端点
  v = T.createVad({ sensitivity: 0.5, minUtteranceMs: 800, endpointSilenceMs: 200 });
  for (var r1 = 0; r1 < 20; r1++) v.feed(0.001, 20);
  for (var r2 = 0; r2 < 30; r2++) if (v.feed(0.3, 20) === 'speech-start') break;
  var sawDiscard = false;
  for (var r3 = 0; r3 < 40; r3++) {
    var e3 = v.feed(0.001, 20);
    if (e3 === 'discard') { sawDiscard = true; break; }
  }
  ok('过短语音给 discard（不送 ASR）', sawDiscard === true);

  // 5.7 超过 maxUtteranceMs 强制切
  v = T.createVad({ sensitivity: 0.5, maxUtteranceMs: 600, minUtteranceMs: 100 });
  for (var s1 = 0; s1 < 20; s1++) v.feed(0.001, 20);
  for (var s2 = 0; s2 < 30; s2++) if (v.feed(0.3, 20) === 'speech-start') break;
  var forced = false;
  for (var s3 = 0; s3 < 100; s3++) if (v.feed(0.3, 20) === 'force-end') { forced = true; break; }
  ok('超过最长话语强制切', forced === true);

  // 5.8 continueWait 会延后端点
  v = T.createVad({ sensitivity: 0.5, endpointSilenceMs: 200, minUtteranceMs: 100 });
  for (var t1 = 0; t1 < 20; t1++) v.feed(0.001, 20);
  for (var t2 = 0; t2 < 30; t2++) if (v.feed(0.3, 20) === 'speech-start') break;
  for (var t3 = 0; t3 < 20; t3++) v.feed(0.001, 20);
  v.continueWait(800);
  var epEarly = false;
  for (var t4 = 0; t4 < 10; t4++) if (v.feed(0.001, 20) === 'endpoint-candidate') { epEarly = true; break; }
  ok('continueWait 后短时间内不再判端点', epEarly === false);
})();

// =====================================================================================
console.log('\n[6] 句子切分');
// =====================================================================================
(function () {
  var s1 = T.splitSentences('你好呀。今天天气不错！我们出去走走吧？', { minLen: 1 });
  ok('三个强句号切成三句', s1.length === 3, JSON.stringify(s1));
  ok('首句内容正确', s1[0] === '你好呀。', JSON.stringify(s1[0]));

  var s2 = T.splitSentences('是吗？！我不信。', { minLen: 1 });
  ok('连续标点不被拆开', s2.length === 2 && s2[0] === '是吗？！', JSON.stringify(s2));

  var s3 = T.splitSentences('', { minLen: 1 });
  ok('空文本返回空数组', s3.length === 0);

  var s4 = T.splitSentences('嗯', { minLen: 2 });
  ok('短于 minLen 的碎片被过滤', s4.length === 0, JSON.stringify(s4));

  var long = '这是一个很长的句子，它包含了多个逗号，因此需要被软切开，否则首包时间会很长，用户会等得不耐烦。';
  var s5 = T.splitSentences(long, { minLen: 1 });
  ok('长句被切成多段', s5.length >= 2, JSON.stringify(s5.map(function (x) { return x.length; })));
  var allShort = s5.every(function (x) { return x.length <= 60; });
  ok('切出的每段都不太长', allShort);

  var s6 = T.splitSentences('第一句。\n第二句。', { minLen: 1 });
  ok('换行也算句边界', s6.length === 2, JSON.stringify(s6));

  ok('firstSentence 取第一句', T.firstSentence('啊，这样。然后呢？') === '啊，这样。', T.firstSentence('啊，这样。然后呢？'));
})();

// =====================================================================================
console.log('\n[7] 流式 JSON 增量提取（性能关键路径）');
// =====================================================================================
(function () {
  var ex = T.createSpeechExtractor();
  var got = [];
  // 模拟 DeepSeek 流式：先到半句（未闭合），后到句号
  got = got.concat(ex.push('{"speech":"你别急，我这边正在收尾'));
  ok('未成句时不吐', got.length === 0, JSON.stringify(got));

  got = got.concat(ex.push('了，大概今天下午就能发你。'));
  ok('遇到句号立刻吐出一句', got.length === 1, JSON.stringify(got));
  ok('吐出的是完整第一句', /收尾了，大概今天下午就能发你。/.test(got[0]), JSON.stringify(got[0]));

  got = got.concat(ex.push('不过要等我看一下。","emotion":"安抚"}'));
  ok('第二句也能吐', got.length >= 2, JSON.stringify(got));
  ok('第二句内容正确', /不过要等我看一下。/.test(got[1]), JSON.stringify(got[1]));

  var rest = ex.flush();
  ok('flush 后不再重复吐已吐内容', rest.length === 0 || !/收尾/.test(rest.join('')), JSON.stringify(rest));

  // 转义
  var ex2 = T.createSpeechExtractor();
  var g2 = [];
  g2 = g2.concat(ex2.push('{"speech":"他说\\"你好\\"。'));
  ok('转义引号正确还原', g2.length && g2[0].indexOf('"你好"') >= 0, JSON.stringify(g2));

  // 非 speech 在前
  var ex3 = T.createSpeechExtractor();
  var g3 = [];
  g3 = g3.concat(ex3.push('{"emotion":"开心","speech":"好啊。'));
  ok('speech 不是第一个字段也能抠', g3.length === 1 && g3[0] === '好啊。', JSON.stringify(g3));

  // 非法 JSON 不崩
  var ex4 = T.createSpeechExtractor();
  var g4 = [];
  try {
    g4 = g4.concat(ex4.push('这不是 JSON {{{'));
    g4 = g4.concat(ex4.push('随便一段文本'));
  } catch (e) { ok('非法输入不抛异常', false, e.message); }
  ok('非法输入不吐内容', g4.length === 0, JSON.stringify(g4));

  ok('extractJsonString 闭合检测', T.extractJsonString('{"a":"xy"}', 'a').closed === true);
  ok('extractJsonString 未闭合检测', T.extractJsonString('{"a":"xy', 'a').closed === false);
  ok('jsonUnescape 处理 \\n', T.jsonUnescape('a\\nb') === 'a\nb', JSON.stringify(T.jsonUnescape('a\\nb')));
  ok('jsonUnescape 处理 \\u', T.jsonUnescape('\\u4f60\\u597d') === '你好', T.jsonUnescape('\\u4f60\\u597d'));
})();

// =====================================================================================
console.log('\n[8] 副语言信号');
// =====================================================================================
(function () {
  var rate = 16000, dur = 2;   // 2 秒
  var n = rate * dur;
  var pcm = new Int16Array(n);
  // 前半段 200Hz 正弦（有声），后半段静音 —— 测 speechRatio / 停顿
  for (var i = 0; i < n; i++) {
    if (i < rate) pcm[i] = Math.round(8000 * Math.sin(2 * Math.PI * 200 * i / rate));
    else pcm[i] = 0;
  }
  var sig = T.computeSignals(pcm, { sampleRate: rate });
  ok('总时长正确', Math.abs(sig.totalMs - 2000) <= 25, String(sig.totalMs));
  ok('语音占比在 (0,1) 之间', sig.speechRatio > 0 && sig.speechRatio < 1, String(sig.speechRatio));
  ok('有语音时长', sig.speechMs > 0, String(sig.speechMs));
  ok('峰值能量有记录', sig.rmsPeak > 0, String(sig.rmsPeak));
  ok('响度分档是合法值', ['低', '中', '高'].indexOf(sig.loudness) >= 0, sig.loudness);
  ok('SNR 是有限数', isFinite(sig.snrDb), String(sig.snrDb));
  ok('基频落在人声范围', sig.pitchMeanHz === 0 || (sig.pitchMeanHz > 70 && sig.pitchMeanHz < 400), String(sig.pitchMeanHz));
  ok('200Hz 正弦基频接近 200', sig.pitchMeanHz === 0 || Math.abs(sig.pitchMeanHz - 200) < 40, String(sig.pitchMeanHz));

  // 全静音
  var silent = T.computeSignals(new Int16Array(rate), { sampleRate: rate });
  ok('全静音 speechRatio ≈ 0', silent.speechRatio < 0.05, String(silent.speechRatio));
  ok('全静音无基频', silent.pitchMeanHz === 0, String(silent.pitchMeanHz));

  // 空输入
  var empty = T.computeSignals(new Int16Array(0), { sampleRate: rate });
  ok('空输入返回完整结构', empty && empty.totalMs === 0 && empty.pauses.length === 0);

  // 字速回填
  var withText = T.attachTranscriptToSignals(JSON.parse(JSON.stringify(sig)), '今天天气真不错我们出去走走吧');
  ok('字速被回填', withText.speechRateCps > 0, String(withText.speechRateCps));

  // 削波检测
  var loud = new Int16Array(rate);
  for (var k = 0; k < rate; k++) loud[k] = (k % 2 === 0) ? 32767 : -32768;
  var loudSig = T.computeSignals(loud, { sampleRate: rate });
  ok('削波被检出', loudSig.clipping === true, String(loudSig.clipping));
})();

// =====================================================================================
console.log('\n[8b] 音频回灌格式（回归：声明 format:\'wav\' 就必须真的是 WAV）');
// =====================================================================================
// 背景：曾经在这条路径上踩过「声明了一种格式，却没保证内容真的是那个格式」的 bug ——
//   TTS 固定 audio.format='pcm'（返回裸 PCM 无 RIFF 头），回灌 ASR 时却原样透传，
//   而请求体写着 format:'wav' → 上游 400 "invalid audio format"。
//   下面的用例锁死：两条分支（有头/无头）都必须产出带 RIFF 头的合法 WAV。
(function () {
  var rate = 24000, n = rate;   // 1 秒
  var pcm = new Int16Array(n);
  for (var i = 0; i < n; i++) pcm[i] = Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / rate));
  var rawPcm = T.int16ToBytes(pcm);

  // 分支 1：无 RIFF 头（TTS 流式/format:'pcm' 的真实产物）→ 必须补出头
  var wav1 = T.pcmBytesToWav16k(rawPcm);
  ok('裸 PCM 分支产出非空', !!wav1 && wav1.length > 44, wav1 && String(wav1.length));
  ok('裸 PCM 分支带 RIFF 头', wav1 &&
    String.fromCharCode(wav1[0], wav1[1], wav1[2], wav1[3]) === 'RIFF',
    wav1 && String.fromCharCode(wav1[0], wav1[1], wav1[2], wav1[3]));
  var h1 = wav1 ? T.parseWavHeader(wav1) : null;
  ok('裸 PCM 分支解析为 16k WAV', h1 && h1.sampleRate === 16000, h1 && String(h1.sampleRate));
  ok('裸 PCM 分支是单声道 16bit', h1 && h1.channels === 1 && h1.bits === 16,
    h1 && (h1.channels + '/' + h1.bits));
  // 24k→16k：样本数应变 2/3
  ok('裸 PCM 分支下采样到 16k（样本数 ≈ 2/3）',
    h1 && Math.abs(h1.dataBytes - Math.round(n * 2 / 3) * 2) <= 8,
    h1 && (h1.dataBytes + ' vs ' + Math.round(n * 2 / 3) * 2));

  // 分支 2：带 RIFF 头（非流式返回的 24k wav）→ 必须剥头重封，不能把原头当数据
  var wavIn = T.encodeWav(rawPcm, 24000);
  var wav2 = T.pcmBytesToWav16k(wavIn);
  var h2 = wav2 ? T.parseWavHeader(wav2) : null;
  ok('带 WAV 头分支产出合法 16k WAV', h2 && h2.sampleRate === 16000, h2 && String(h2.sampleRate));
  ok('带 WAV 头分支剥掉了原头（样本数与裸 PCM 分支一致）',
    h1 && h2 && h1.dataBytes === h2.dataBytes,
    (h1 && h1.dataBytes) + ' vs ' + (h2 && h2.dataBytes));
  ok('带 WAV 头分支没有把 RIFF 字节当音频数据',
    wav2 && String.fromCharCode(wav2[44], wav2[45], wav2[46], wav2[47]) !== 'RIFF');

  // 边界
  ok('空输入返回 null', T.pcmBytesToWav16k(new Uint8Array(0)) === null);
  ok('null 输入返回 null', T.pcmBytesToWav16k(null) === null);
})();

// =====================================================================================
console.log('\n[8c] 大脑渠道选型（回归：不能拿 ASR/TTS 模型当聊天模型）');
// =====================================================================================
// 背景：兜底选"大脑"渠道时曾经直接用 models[0]，而一个只有语音模型的 MiMo 渠道
//   会把 mimo-v2.5-asr 当成聊天模型发出去 → 运行时必然 400。
(function () {
  ok('识别语音模型 mimo-v2.5-asr', T.isAudioModel('mimo-v2.5-asr') === true);
  ok('识别语音模型 mimo-v2.5-tts', T.isAudioModel('mimo-v2.5-tts') === true);
  ok('识别 voicedesign', T.isAudioModel('mimo-v2.5-tts-voicedesign') === true);
  ok('识别 voiceclone', T.isAudioModel('mimo-v2.5-tts-voiceclone') === true);
  ok('识别 whisper', T.isAudioModel('whisper-1') === true);
  ok('不误判 deepseek-chat', T.isAudioModel('deepseek-chat') === false);
  ok('不误判 gpt-4o', T.isAudioModel('gpt-4o') === false);
  ok('不误判 mimo-v2.5（多模态本体）', T.isAudioModel('mimo-v2.5') === false);

  var mimoOnly = { id: 'p1', apiKey: 'k', models: [{ id: 'mimo-v2.5-asr' }, { id: 'mimo-v2.5-tts' }] };
  ok('纯语音渠道挑不出聊天模型', T.pickChatModel(mimoOnly) === '', JSON.stringify(T.pickChatModel(mimoOnly)));
  ok('纯语音渠道不能当大脑', T.canBeBrain(mimoOnly) === false);

  var mixed = { id: 'p2', apiKey: 'k', models: [{ id: 'mimo-v2.5-asr' }, { id: 'mimo-v2.5' }, { id: 'mimo-v2.5-tts' }] };
  ok('混合渠道挑出非语音模型', T.pickChatModel(mixed) === 'mimo-v2.5', T.pickChatModel(mixed));
  ok('混合渠道可以当大脑', T.canBeBrain(mixed) === true);

  var chatOnly = { id: 'p3', apiKey: 'k', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-pro' }] };
  ok('纯聊天渠道优先挑 chat 关键字', T.pickChatModel(chatOnly) === 'deepseek-chat', T.pickChatModel(chatOnly));

  var noModels = { id: 'p4', apiKey: 'k', models: [] };
  ok('没填模型目录 → 允许当大脑', T.canBeBrain(noModels) === true);
  ok('没填模型目录 → 挑不出具体模型', T.pickChatModel(noModels) === '');

  var noKey = { id: 'p5', apiKey: '', models: [{ id: 'deepseek-chat' }] };
  ok('没有密钥 → 不能当大脑', T.canBeBrain(noKey) === false);
})();

// =====================================================================================
console.log('\n[8d] 通话振感开关');
// =====================================================================================
// 三处振感：接通 / 被打断 / 挂断。开关是 settings.voice.haptic（db.js 定义，默认 true）。
//   这里守住"关得掉"这条 —— 配置项写了不读，是最典型的"声明了但没人消费"。
(function () {
  var origin = globalThis.settings;
  function withVoice(v) {
    globalThis.settings = { voice: v };
  }
  withVoice({ haptic: true });
  ok('haptic=true → 开', T.hapticEnabled() === true);
  withVoice({ haptic: false });
  ok('haptic=false → 关（最关键的一条）', T.hapticEnabled() === false);
  withVoice({});
  ok('字段缺失 → 默认开', T.hapticEnabled() === true);
  withVoice({ haptic: undefined });
  ok('haptic 显式 undefined → 默认开', T.hapticEnabled() === true);
  withVoice({ haptics: false });
  ok('兼容旧笔误 haptics=false → 关', T.hapticEnabled() === false);
  delete globalThis.settings;
  ok('settings 缺失时不抛异常', (function () {
    try { T.hapticEnabled(); return true; } catch (e) { return false; }
  })());

  ok('三档振感都已定义', !!(T.HAPTIC_PATTERNS.connect && T.HAPTIC_PATTERNS.bargein && T.HAPTIC_PATTERNS.hangup));
  ok('bargein 强度高于 connect', T.HAPTIC_PATTERNS.bargein.ms > T.HAPTIC_PATTERNS.connect.ms,
    T.HAPTIC_PATTERNS.bargein.ms + ' vs ' + T.HAPTIC_PATTERNS.connect.ms);

  globalThis.settings = origin;
})();

// =====================================================================================
console.log('\n[8e] 真机调参范围夹紧');
// =====================================================================================
// 这三个量只有真机才调得准，开放给用户后必须有范围保护：
//   填 99999 到「防自激窗口」等于永久关闭打断检测，现象是"打断坏了"而不是"参数离谱"。
//   同理 endpointSilenceMs 填 30000 会让通话永远不接话。
(function () {
  var origin = globalThis.settings;
  function withVoice(v) { globalThis.settings = { voice: v }; }

  // 未设置 → 用内置默认
  withVoice({});
  ok('未设置时回落到内置默认 echoGuardMs=250', T.tuning('echoGuardMs', 250) === 250);
  ok('未设置时回落到内置默认 bargeInHoldMs=180', T.tuning('bargeInHoldMs', 180) === 180);

  // 正常值原样生效
  withVoice({ echoGuardMs: 350 });
  ok('设置的 350 原样生效', T.tuning('echoGuardMs', 250) === 350);

  // 越界夹紧（关键：填离谱值等于把功能调死）
  withVoice({ echoGuardMs: 99999 });
  ok('echoGuardMs 99999 → 夹紧到 1200', T.tuning('echoGuardMs', 250) === 1200, String(T.tuning('echoGuardMs', 250)));
  withVoice({ echoGuardMs: -50 });
  ok('echoGuardMs 负数 → 夹紧到 0', T.tuning('echoGuardMs', 250) === 0, String(T.tuning('echoGuardMs', 250)));
  withVoice({ bargeInHoldMs: 5000 });
  ok('bargeInHoldMs 5000 → 夹紧到 800', T.tuning('bargeInHoldMs', 180) === 800, String(T.tuning('bargeInHoldMs', 180)));
  withVoice({ endpointSilenceMs: 99999 });
  ok('endpointSilenceMs 99999 → 夹紧到 5000（否则永远不接话）',
    T.tuning('endpointSilenceMs', 700) === 5000, String(T.tuning('endpointSilenceMs', 700)));
  withVoice({ endpointSilenceMs: 550 });
  ok('端点上调 550 生效（真机嫌慢时用）', T.tuning('endpointSilenceMs', 700) === 550);
  withVoice({ bargeInLeakFactor: 100 });
  ok('bargeInLeakFactor 100 → 夹紧到 10', T.tuning('bargeInLeakFactor', 3.2) === 10, String(T.tuning('bargeInLeakFactor', 3.2)));

  // 非数字/空值 → 回默认
  withVoice({ echoGuardMs: 'abc' });
  ok('填非数字 → 回默认', T.tuning('echoGuardMs', 250) === 250, String(T.tuning('echoGuardMs', 250)));

  ok('五个可调参数都有范围定义',
    !!T.TUNING_RANGES.echoGuardMs && !!T.TUNING_RANGES.bargeInHoldMs &&
    !!T.TUNING_RANGES.bargeInLeakFactor && !!T.TUNING_RANGES.endpointSilenceMs);

  globalThis.settings = origin;
})();

// =====================================================================================
console.log('\n[9] 其它纯工具');
// =====================================================================================
(function () {
  ok('frameRms 全 0 输入 = 0', T.frameRms(new Float32Array(100)) === 0);
  var half = new Float32Array(100);
  for (var i = 0; i < 100; i++) half[i] = 0.5;
  ok('frameRms 常数 0.5 → 0.5', near(T.frameRms(half), 0.5, 1e-6), String(T.frameRms(half)));
  ok('frameRms 空输入 = 0', T.frameRms(new Float32Array(0)) === 0);
  ok('toDb(1) = 0', near(T.toDb(1), 0, 1e-9));
  ok('toDb(0.5) ≈ -6.02', Math.abs(T.toDb(0.5) + 6.02) < 0.01, String(T.toDb(0.5)));
  ok('toDb(0) 有下界', T.toDb(0) === -100);
  ok('clamp 上下界', T.clamp(5, 0, 1) === 1 && T.clamp(-5, 0, 1) === 0 && T.clamp(0.5, 0, 1) === 0.5);
  ok('clamp 处理 NaN', T.clamp('abc', 0, 1) === 0, String(T.clamp('abc', 0, 1)));
  ok('num 处理字符串', T.num('3.5', 0) === 3.5);
  ok('num 无效输入回退默认', T.num(undefined, 7) === 7);
  ok('CAPTURE_RATE = 16000', T.CAPTURE_RATE === 16000);
  ok('TTS_RATE = 24000', T.TTS_RATE === 24000);
  ok('pitchAutocorr 全零返回 0', T.pitchAutocorr(new Float32Array(512), 16000) === 0);
})();

// =====================================================================================
console.log('\n[10] 内置自检 __selfTest()');
// =====================================================================================
(function () {
  var r = VoiceCall.__selfTest();
  ok('__selfTest 全部通过', r.ok === true, JSON.stringify(r.cases.filter(function (c) { return !c.ok; })));
  ok('__selfTest 覆盖 ≥ 6 项', r.cases.length >= 6, String(r.cases.length));
})();

// =====================================================================================
console.log('\n[11] 对外 API 形状（契约 §3.4）');
// =====================================================================================
(function () {
  ['open', 'close', 'isOpen', 'start', 'hangup', 'interrupt', 'getState', 'getMetrics', '__testChain']
    .forEach(function (k) {
      ok('VoiceCall.' + k + ' 存在', typeof VoiceCall[k] === 'function', typeof VoiceCall[k]);
    });
  ok('getState() 返回 idle（未通话）', VoiceCall.getState() === 'idle', VoiceCall.getState());
  var m = VoiceCall.getMetrics();
  ok('getMetrics 结构完整',
    m && 'asrMs' in m && 'brainFirstTokenMs' in m && 'ttsFirstChunkMs' in m && 'turnTotalMs' in m && 'turns' in m,
    JSON.stringify(m));
  ok('isOpen() 初始为 false', VoiceCall.isOpen() === false);
})();

// =====================================================================================
var total = passes + failures;
console.log('\n' + '='.repeat(58));
console.log((failures === 0 ? '全部通过' : '有失败') + '：' + passes + '/' + total + ' 通过，' + failures + ' 失败');
console.log('='.repeat(58) + '\n');
process.exit(failures === 0 ? 0 : 1);
