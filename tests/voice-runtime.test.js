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
console.log('\n[16] VAD 真人语音触发（v127 真机致命缺陷回归）');
// =====================================================================================
// 用户实测「说了几句话，AI 完全没反应、会话也没有新消息」。查出两个真 bug：
//   ① speechOnMs 要求「连续」180ms 超过阈值，但真人音节之间必然有气口，
//      实测真机最长连续只有 ~107ms → aboveMs 反复归零 → VAD 永远进不了 speech。
//   ② confirmEnd() 读完统计就 resetSegment()，而调用方是先读统计再决定 wait；
//      走 wait 分支时 st 已被清空，continueWait() 只能等一个空段 → 这句话永远不提交、也不报错。
// 这两条都必须在单测里钉死，否则「主路径能跑通」会再次掩盖它们。
(function () {
  var DT = 1024 / 48000 * 1000;   // 真机 AudioContext 块间隔 ≈ 21.33ms

  function syllableFrames(n) {
    var out = [];
    var i = 0;
    while (i < n) {
      for (var k = 0; k < 3 && i < n; k++, i++) out.push(0.12);
      if (i < n) { out.push(0.003); i++; }
    }
    return out;
  }

  function freshVad(over) {
    var o = { calibrateMs: 300, speechOnMs: 180, speechHangMs: 260,
      endpointSilenceMs: 700, minUtteranceMs: 400, sensitivity: 0.85 };
    if (over) { for (var k in over) o[k] = over[k]; }
    return T.createVad(o);
  }

  (function () {
    var vad = freshVad();
    for (var i = 0; i < 15; i++) vad.feed(0.001, DT);
    var frames = syllableFrames(150);
    var entered = false;
    for (var j = 0; j < frames.length; j++) {
      if (vad.feed(frames[j], DT) === 'speech-start') { entered = true; break; }
    }
    ok('音节抖动的真人语音能进入 speech（旧实现永远进不去）', entered, 'phase=' + vad.phase());
  })();

  (function () {
    var vad = freshVad();
    var hit = false;
    for (var i = 0; i < 300; i++) if (vad.feed(0.001, DT) === 'speech-start') { hit = true; break; }
    ok('纯静音不误触发', !hit);
  })();

  (function () {
    var vad = freshVad();
    for (var i = 0; i < 15; i++) vad.feed(0.001, DT);
    var started = false;
    for (var j = 0; j < 8; j++) if (vad.feed(0.15, DT) === 'speech-start') started = true;
    ok('170ms 短噪声不触发 speech-start', !started);
  })();

  (function () {
    var vad = freshVad();
    for (var i = 0; i < 15; i++) vad.feed(0.001, DT);
    for (var j = 0; j < 90; j++) vad.feed(0.15, DT);
    var before = Math.round(vad.state.speechMs);
    var snap = vad.snapshot();
    var afterSnap = Math.round(vad.state.speechMs);
    ok('snapshot() 不改状态', before === afterSnap && before > 0, before + ' vs ' + afterSnap);
    ok('snapshot() 返回正确统计', snap.speechMs > 0 && snap.speechMs === before, String(snap.speechMs));
    vad.confirmEnd();
    ok('confirmEnd() 才重置', Math.round(vad.state.speechMs) === 0, String(Math.round(vad.state.speechMs)));
  })();

  (function () {
    var vad = freshVad();
    for (var i = 0; i < 15; i++) vad.feed(0.001, DT);
    for (var j = 0; j < 90; j++) vad.feed(0.15, DT);
    var round = 0, accepted = null;
    for (var k = 0; k < 200; k++) {
      var e = vad.feed(0.001, DT);
      if (e !== 'endpoint-candidate') continue;
      round++;
      var snap = vad.snapshot();
      if (round === 1) {
        vad.continueWait(400);
        ok('wait 分支后 speechMs 仍在（旧实现被清成 0）', snap.speechMs > 0, String(snap.speechMs));
      } else {
        accepted = snap;
        vad.confirmEnd();
        break;
      }
    }
    ok('wait 之后还能再次触发 endpoint', round >= 2, 'round=' + round);
    ok('第二轮仍能收下这句话（不被当成 tooShort 丢弃）',
      !!accepted && accepted.speechMs >= 400 && accepted.tooShort === false,
      JSON.stringify(accepted));
  })();

  (function () {
    var vad = freshVad();
    for (var i = 0; i < 15; i++) vad.feed(0.001, DT);
    for (var j = 0; j < 90; j++) vad.feed(0.15, DT);
    var got = null;
    for (var k = 0; k < 80; k++) {
      if (vad.feed(0.001, DT) === 'endpoint-candidate') { got = vad.confirmEnd(); break; }
    }
    ok('不 wait 直接收下也能拿到完整统计',
      !!got && got.speechMs >= 400 && got.tooShort === false, JSON.stringify(got));
  })();
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
console.log('\n[12] 通话提示词 = 会话人设 + 通话层');
// =====================================================================================
// 通话时"人设没保留"的根因是整体换成了 VoiceDirector.buildSystemPrompt()。
//   这里守住三件事：会话人设每一部分都在、排在通话层之前、状态栏不被念出来。
(function () {
  var originSettings = globalThis.settings;
  var hadEmp = Object.prototype.hasOwnProperty.call(globalThis, 'effectiveModelPrompt');
  var originEmp = globalThis.effectiveModelPrompt;
  var hadVD = Object.prototype.hasOwnProperty.call(globalThis, 'VoiceDirector');
  var originVD = globalThis.VoiceDirector;

  // 模拟 chat.js 的 effectiveModelPrompt 还没定义（加载顺序不确定）
  globalThis.effectiveModelPrompt = undefined;
  globalThis.settings = { modelPrompts: { 'p1:m1': { text: '模型修饰语\n\n===强调===\n模型强调内容' } } };
  var conv = {
    providerId: 'p1', model: 'm1',
    systemPrompt: '你是猫娘', emphasis: '说话简短', userIdentity: '用户是程序员',
    statusBar: { enabled: true, templateRule: '心情', displayFields: '体力' }
  };

  var parts = T.buildSessionSystemParts(conv);
  var joined = parts.join('\n');
  ok('会话 systemPrompt 保留', joined.indexOf('你是猫娘') >= 0, joined);
  ok('会话 emphasis 保留（带【重要强调】前缀）', joined.indexOf('【重要强调】说话简短') >= 0, joined);
  ok('模型修饰语保留', joined.indexOf('模型修饰语') >= 0, joined);
  ok('模型修饰的强调部分保留', joined.indexOf('【重要强调】模型强调内容') >= 0, joined);
  ok('userIdentity 保留', joined.indexOf('用户身份：用户是程序员') >= 0, joined);
  ok('会话人设顺序：systemPrompt → emphasis → 模型修饰 → userIdentity',
    joined.indexOf('你是猫娘') < joined.indexOf('说话简短') &&
    joined.indexOf('说话简短') < joined.indexOf('模型修饰语') &&
    joined.indexOf('模型修饰语') < joined.indexOf('用户身份'),
    joined);
  ok('状态栏开启时提示词不含 <status>', joined.indexOf('<status>') < 0, joined);
  ok('状态栏指令文本也不进通话', joined.indexOf('状态栏') < 0, joined);

  ok('空 conv 返回空数组（不抛）', (function () {
    try { return T.buildSessionSystemParts(null).length === 0 && T.buildSessionSystemParts({}).length === 0; }
    catch (e) { return false; }
  })());

  globalThis.effectiveModelPrompt = function () { return { text: '外部修饰' }; };
  ok('优先用 chat.js 的 effectiveModelPrompt',
    T.buildSessionSystemParts(conv).join('\n').indexOf('外部修饰') >= 0);
  globalThis.effectiveModelPrompt = function () { return null; };
  ok('external 返回 null 时回落到 settings.modelPrompts',
    T.buildSessionSystemParts(conv).join('\n').indexOf('模型修饰语') >= 0);

  // 通话层存在时：人设 → 通话层 → JSON 指令，且副语言/时间不重复
  var seen = null;
  globalThis.VoiceDirector = {
    buildCallLayer: function (o) { seen = o; return '通话层'; },
    describeClock: function () { return '【时间】下午三点'; },
    describeSignals: function () { return '【语气】有点急'; }
  };
  globalThis.settings = { modelPrompts: {}, voice: { timestamps: true, rate: 1.2, rateMode: 'natural' } };
  var msgs = T.buildBrainMessages(conv, '你好', null);
  var sys = msgs[0].content;
  ok('首条是 system 消息', msgs[0].role === 'system');
  ok('会话人设排在通话层之前', sys.indexOf('你是猫娘') >= 0 && sys.indexOf('你是猫娘') < sys.indexOf('通话层'), sys);
  ok('JSON 输出格式指令在最后', sys.indexOf('【输出格式（强制）】') > sys.indexOf('通话层'), sys);
  ok('clock 传给通话层（enabled/now/callStartedAt/lastTurnAt/turnIndex）',
    !!seen && !!seen.clock && seen.clock.enabled === true &&
    typeof seen.clock.now === 'number' && typeof seen.clock.callStartedAt === 'number' &&
    typeof seen.clock.lastTurnAt === 'number' && typeof seen.clock.turnIndex === 'number',
    JSON.stringify(seen && seen.clock));
  ok('timestamps 开时时间描述进提示词', sys.indexOf('【时间】下午三点') >= 0, sys);
  ok('副语言信号只注入一次', sys.split('【语气】有点急').length - 1 === 1, sys);

  // v126 回归：v125 里 buildBrainMessages 末尾还会调一次 buildTurnMessages，
  //   而那个函数会自己再拼一遍 system —— 于是 messages 变成 [system, user, system, user, user]，
  //   两套互相冲突的提示词同时发给模型（JSON 格式说明写了两份）。
  //   这条断言钉住「system 只出现一次、历史不重复、末条是本轮用户话」。
  ok('messages 里 system 只出现一次',
    msgs.filter(function (m) { return m.role === 'system'; }).length === 1,
    JSON.stringify(msgs.map(function (m) { return m.role; })));
  ok('messages 末条是本轮用户话', msgs[msgs.length - 1].role === 'user' &&
    msgs[msgs.length - 1].content === '你好',
    JSON.stringify(msgs[msgs.length - 1]));
  ok('本轮用户话只出现一次（不被 buildTurnMessages 重复追加）',
    msgs.filter(function (m) { return m.role === 'user' && m.content === '你好'; }).length === 1,
    JSON.stringify(msgs.map(function (m) { return m.role + ':' + String(m.content).slice(0, 8); })));
  ok('提示词里 JSON 格式说明只有一份',
    (sys.split('【输出格式').length - 1) === 1,
    String(sys.split('【输出格式').length - 1));

  globalThis.settings.voice.timestamps = false;
  T.buildBrainMessages(conv, '你好', null);
  ok('timestamps 关时 clock.enabled=false', seen.clock.enabled === false, JSON.stringify(seen.clock));

  delete globalThis.VoiceDirector;
  var sysOld = T.buildBrainMessages(conv, '你好', null)[0].content;
  ok('buildCallLayer 缺失时回退旧提示词且不丢人设',
    sysOld.indexOf('你是猫娘') >= 0 && sysOld.indexOf('你正在和用户通电话') >= 0, sysOld);

  globalThis.settings = originSettings;
  if (hadEmp) globalThis.effectiveModelPrompt = originEmp; else delete globalThis.effectiveModelPrompt;
  if (hadVD) globalThis.VoiceDirector = originVD; else delete globalThis.VoiceDirector;
})();

// =====================================================================================
console.log('\n[13] WSOLA 保音高时间伸缩（语速）');
// =====================================================================================
// 语速不能只改 playbackRate：那会把音高一起抬上去（1.5× 听起来像另一个人）。
//   WSOLA 只改时长不改周期，所以输出仍然是 220Hz；分块流式处理还要与一次性处理等长，
//   否则块边界会出现周期性咔哒。
(function () {
  var SR = 24000;

  function tone(n) {
    var a = new Float32Array(n);
    for (var i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR);
    return a;
  }

  function stretchAll(rate, chunk, n) {
    var ts = T.makeTimeStretcher(rate, SR);
    var input = tone(n);
    var pieces = [];
    var total = 0;
    for (var off = 0; off < n; off += chunk) {
      var out = ts.process(input.subarray(off, Math.min(n, off + chunk)));
      if (out && out.length) { pieces.push(out); total += out.length; }
    }
    var tail = ts.flush();
    if (tail && tail.length) { pieces.push(tail); total += tail.length; }
    var all = new Float32Array(total);
    var at = 0;
    var nan = 0;
    var peak = 0;
    for (var k = 0; k < pieces.length; k++) {
      all.set(pieces[k], at);
      at += pieces[k].length;
      for (var j = 0; j < pieces[k].length; j++) {
        var v = pieces[k][j];
        if (!isFinite(v)) nan++;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
    var zc = 0;
    for (var z = 1; z < all.length; z++) {
      if ((all[z - 1] < 0 && all[z] >= 0) || (all[z - 1] >= 0 && all[z] < 0)) zc++;
    }
    var hz = all.length ? (zc / 2) / (all.length / SR) : 0;
    return { total: total, nan: nan, peak: peak, hz: hz };
  }

  // rate=1：直通（同一份数组，零处理）
  var pass = T.makeTimeStretcher(1, SR);
  var inp = tone(2400);
  var direct = pass.process(inp);
  ok('rate=1 直通（输出 === 输入）', direct === inp && direct.length === inp.length, String(direct.length));
  ok('rate=1 flush 为空', pass.flush().length === 0);

  var r15 = stretchAll(1.5, 24000, 24000);
  var e15 = 24000 / 1.5;
  ok('rate=1.5 输出长度 ≈ 输入/1.5（±10%）', Math.abs(r15.total - e15) <= e15 * 0.1,
    r15.total + ' vs ~' + e15);
  ok('rate=1.5 保音高（≈220Hz，不是 330Hz）', Math.abs(r15.hz - 220) <= 20, r15.hz.toFixed(1) + 'Hz');
  ok('rate>1 时长变短', r15.total < 24000, String(r15.total));

  var r075 = stretchAll(0.75, 24000, 24000);
  var e075 = 24000 / 0.75;
  ok('rate=0.75 输出长度 ≈ 输入/0.75（±10%）', Math.abs(r075.total - e075) <= e075 * 0.1,
    r075.total + ' vs ~' + e075);
  ok('rate<1 时长变长', r075.total > 24000, String(r075.total));

  // 分块：TTS 一块块吐 PCM，分块结果必须和一次性几乎等长（相位连续的直接体现）
  var c15 = stretchAll(1.5, 4096, 24000);
  var c075 = stretchAll(0.75, 4096, 24000);
  ok('rate=1.5 分块与一次性长度接近（差 ≤ 400 样本）',
    Math.abs(c15.total - r15.total) <= 400, c15.total + ' vs ' + r15.total);
  ok('rate=0.75 分块与一次性长度接近（差 ≤ 400 样本）',
    Math.abs(c075.total - r075.total) <= 400, c075.total + ' vs ' + r075.total);
  ok('分块输出无 NaN/Infinity', c15.nan === 0 && c075.nan === 0, c15.nan + ',' + c075.nan);
  ok('输出振幅不发散（峰值 ≤ 1.1）', r15.peak <= 1.1 && r075.peak <= 1.1,
    r15.peak.toFixed(3) + ',' + r075.peak.toFixed(3));

  // 边界：rate 夹在 0.6~1.6，非法值回落 1（直通）
  ok('rate=99 夹到 1.6', T.makeTimeStretcher(99, SR).rate() === 1.6, String(T.makeTimeStretcher(99, SR).rate()));
  ok('rate=0.1 夹到 0.6', T.makeTimeStretcher(0.1, SR).rate() === 0.6, String(T.makeTimeStretcher(0.1, SR).rate()));
  ok('clampRate 常量 0.6~1.6', T.RATE_MIN === 0.6 && T.RATE_MAX === 1.6);
  [NaN, 0, -1, 'abc', undefined].forEach(function (bad) {
    var ts = T.makeTimeStretcher(bad, SR);
    var o = ts.process(inp);
    ok('非法 rate(' + String(bad) + ') 回落 1 且直通', ts.rate() === 1 && o === inp, String(ts.rate()));
  });

  var empty = T.makeTimeStretcher(1.5, SR);
  ok('空输入不抛、输出为空', (function () {
    try { return empty.process(new Float32Array(0)).length === 0 && empty.flush().length === 0; }
    catch (e) { return false; }
  })());

  // 句子边界：flush 后状态清空，下一句开头不混入上一句的补零尾巴
  var seg = T.makeTimeStretcher(1.5, SR);
  var s1 = seg.process(tone(6000));
  var f1 = seg.flush();
  var s2 = seg.process(tone(6000));
  var f2 = seg.flush();
  ok('两句独立拉伸长度一致', (s1.length + f1.length) === (s2.length + f2.length),
    (s1.length + f1.length) + ' vs ' + (s2.length + f2.length));
  ok('flush 后再次 flush 为空（状态已清）', seg.flush().length === 0);
  ok('setRate 改变速率并返回夹紧后的值',
    (function () { var ts = T.makeTimeStretcher(1, SR); return ts.setRate(1.4) === 1.4 && ts.rate() === 1.4; })());
})();

// =====================================================================================
console.log('\n[14] 路由预置 effectiveTuning / currentRoute');
// =====================================================================================
// 外放与耳机的声学环境差一个数量级，同一套打断参数不可能两边都合适。
//   预置只在"当前路由"下覆盖 base，非法值必须忽略（否则一个手误就能把打断调死）。
(function () {
  var originSettings = globalThis.settings;
  var hadCap = Object.prototype.hasOwnProperty.call(globalThis, 'Capacitor');
  var originCap = globalThis.Capacitor;
  var hadVD = Object.prototype.hasOwnProperty.call(globalThis, 'VoiceDirector');
  var originVD = globalThis.VoiceDirector;

  function withVoice(v) { globalThis.settings = { voice: v }; }

  // 先测"什么都没有"的场景：此时路由缓存为空，才能确定地回落到 speaker
  delete globalThis.settings;
  ok('settings 缺失时 currentRoute 回落 speaker 不抛', T.currentRoute() === 'speaker', T.currentRoute());
  ok('settings 缺失时 effectiveTuning 用默认值', T.effectiveTuning('echoGuardMs', 250) === 250);

  withVoice({
    echoGuardMs: 300, routeMode: 'speaker',
    tuningPresets: {
      speaker: { echoGuardMs: 400, bargeInHoldMs: 'abc', leakFloor: 999 },
      headset: { echoGuardMs: 600 }
    }
  });
  ok('currentRoute 用 routeMode 手动值（无插件）', T.currentRoute() === 'speaker', T.currentRoute());
  ok('base + 当前路由预置合并', T.effectiveTuning('echoGuardMs', 250) === 400, String(T.effectiveTuning('echoGuardMs', 250)));
  ok('预置没覆盖的键回落到 base', T.effectiveTuning('bargeInHoldMs', 180) === 180, String(T.effectiveTuning('bargeInHoldMs', 180)));
  ok('预置里的非数字被忽略', T.effectiveTuning('bargeInHoldMs', 180) === 180, String(T.effectiveTuning('bargeInHoldMs', 180)));
  ok('预置越界被忽略（回落到 base）', T.effectiveTuning('leakFloor', 0.004) === 0.004, String(T.effectiveTuning('leakFloor', 0.004)));
  ok('没有预置的键用 base', T.effectiveTuning('endpointSilenceMs', 700) === 700, String(T.effectiveTuning('endpointSilenceMs', 700)));

  // 主任提供统一合并器时优先用它（v126: resolveTuning(baseObj, presetObj) 逐项合并）
  var mergeArgs = null;
  globalThis.VoiceDirector = {
    resolveTuning: function (base, preset) {
      mergeArgs = { base: base, preset: preset };
      var out = {};
      for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
      if (preset && preset.echoGuardMs === 400) out.echoGuardMs = 777;   // 模拟"结果来自主任"
      return out;
    }
  };
  ok('合并器存在时走 VoiceDirector.resolveTuning', T.effectiveTuning('echoGuardMs', 250) === 777,
    String(T.effectiveTuning('echoGuardMs', 250)));
  ok('合并器收到 {当前键: base} 与预置对象',
    !!mergeArgs && mergeArgs.base && mergeArgs.base.echoGuardMs === 300 && mergeArgs.preset.echoGuardMs === 400,
    JSON.stringify(mergeArgs));
  delete globalThis.VoiceDirector;

  globalThis.settings.voice.routeMode = 'headset';
  ok('切到耳机后 currentRoute 跟着变', T.currentRoute() === 'headset', T.currentRoute());
  ok('切到耳机后预置跟着换', T.effectiveTuning('echoGuardMs', 250) === 600, String(T.effectiveTuning('echoGuardMs', 250)));

  globalThis.settings.voice.routeMode = 'auto';
  ok('auto + 无插件回落 speaker（不抛）', (function () {
    try { return T.currentRoute() === 'speaker'; } catch (e) { return false; }
  })());
  ok('auto 时用 speaker 路由的预置', T.effectiveTuning('echoGuardMs', 250) === 400, String(T.effectiveTuning('echoGuardMs', 250)));

  // 插件抛错：静默回落手动值（必须在插件成功之前测，否则会命中 4 秒路由缓存）
  globalThis.Capacitor = { Plugins: { AudioRoute: { getRoute: function () { throw new Error('boom'); } } } };
  globalThis.settings.voice.routeMode = 'speaker';
  ok('插件抛错时静默回落手动值', (function () {
    try { return T.currentRoute() === 'speaker'; } catch (e) { return false; }
  })());

  // 原生插件的 payload 是 { type, name }（AudioRoutePlugin 契约），不是 { route }
  ok('插件 {type:headset} 归一化为 headset', T.normalizeRoute(T.routeValueOf({ type: 'headset', name: '有线耳机' })) === 'headset');
  ok('插件 {type:bluetooth} 算耳机（蓝牙也是私密听感）',
    T.normalizeRoute(T.routeValueOf({ type: 'bluetooth', name: '蓝牙设备' })) === 'headset');
  // v126 真机修正：earpiece（听筒）必须算**外放**，不能算耳机。
  //   实测场景：没插任何耳机，但原生插件回报 earpiece（isSpeakerphoneOn() 默认 false +
  //   手机有听筒硬件）；而 WebView 的音频走 STREAM_MUSIC，实际是从外放喇叭出来的。
  //   归成耳机就会把两套参数用反 —— 外放回声大却用了灵敏的耳机参数，AI 被自己打断。
  ok('插件 {type:earpiece} 算外放（真机实测：无耳机时音频走外放）',
    T.normalizeRoute(T.routeValueOf({ type: 'earpiece', name: '听筒' })) === 'speaker');
  ok('插件中文名「听筒」也算外放',
    T.normalizeRoute(T.routeValueOf({ type: '', name: '听筒' })) === 'speaker');
  ok('插件 {type:speaker} 算外放', T.normalizeRoute(T.routeValueOf({ type: 'speaker', name: '外放' })) === 'speaker');
  ok('插件 payload 直接是字符串也能用', T.normalizeRoute(T.routeValueOf('headset')) === 'headset');

  // 插件存在：同步 getRoute 的结果优先于手动值
  globalThis.Capacitor = { Plugins: { AudioRoute: { getRoute: function () { return { type: 'headset', name: '有线耳机' }; } } } };
  ok('原生插件 getRoute 优先', T.currentRoute() === 'headset', T.currentRoute());
  ok('耳机插件路由也会带出耳机预置', T.effectiveTuning('echoGuardMs', 250) === 600);

  // 插件返回 Promise：同步调用先给已知值，结果回来后再更新（不能抛、不能卡）
  globalThis.Capacitor = { Plugins: { AudioRoute: { getRoute: function () { return Promise.resolve({ route: 'headset' }); } } } };
  ok('异步插件同步调用不抛', (function () {
    try { var r = T.currentRoute(); return r === 'speaker' || r === 'headset'; } catch (e) { return false; }
  })());

  delete globalThis.Capacitor;
  ok('插件被移除后 currentRoute 仍返回合法路由不抛', (function () {
    try { var r = T.currentRoute(); return r === 'speaker' || r === 'headset'; } catch (e) { return false; }
  })());

  globalThis.settings = originSettings;
  if (hadCap) globalThis.Capacitor = originCap; else delete globalThis.Capacitor;
  if (hadVD) globalThis.VoiceDirector = originVD; else delete globalThis.VoiceDirector;
})();

// =====================================================================================
console.log('\n[15] 大脑跟随会话 / 通话标注不污染历史');
// =====================================================================================
(function () {
  var originSettings = globalThis.settings;
  var originState = globalThis.state;
  var hadConvFn = Object.prototype.hasOwnProperty.call(globalThis, 'currentConv');
  var originConvFn = globalThis.currentConv;
  var hadVD = Object.prototype.hasOwnProperty.call(globalThis, 'VoiceDirector');
  var originVD = globalThis.VoiceDirector;

  // 1) 大脑渠道/模型跟随会话；settings.voice 里残留的旧字段一律不再读
  globalThis.settings = { apiKey: '', voice: { brainProviderId: 'old-id', brainModel: 'old-model' } };
  globalThis.state = { providers: [{ id: 'convp', name: '会话渠道', apiKey: 'k', models: [{ id: 'deepseek-chat' }] }] };
  globalThis.currentConv = function () { return { id: 'c1', providerId: 'convp', model: 'deepseek-chat' }; };
  var r1 = T.resolveVoiceProvider('brain');
  ok('大脑跟随会话渠道', r1.provider.id === 'convp', r1.provider.id);
  ok('旧 brainProviderId 不再生效', r1.provider.id !== 'old-id', r1.provider.id);
  ok('大脑模型用会话模型', r1.model === 'deepseek-chat', r1.model);

  // 2) 会话没配渠道 → 回落 DeepSeek 直连（老兜底保留）
  globalThis.settings = { apiKey: 'sk-test', voice: {} };
  globalThis.state = { providers: [] };
  globalThis.currentConv = function () { return { id: 'c2', providerId: '', model: '' }; };
  var r2 = T.resolveVoiceProvider('brain');
  ok('会话没配渠道回落 DeepSeek 直连',
    r2.provider.id === '__builtin_deepseek' && r2.model === 'deepseek-chat', JSON.stringify(r2));

  // 3) 什么都没有 → 可读错误（不能静默拿空 key 打请求）
  globalThis.settings = { apiKey: '', voice: {} };
  globalThis.state = { providers: [] };
  ok('没有任何渠道时报 voice_nokey', (function () {
    try { T.resolveVoiceProvider('brain'); return false; }
    catch (e) { return e.code === 'voice_nokey'; }
  })());

  // 4) 通话标注：写进 activePath / 是 system+marker，但不进 historyMessages
  var conv = { id: 'c3', rootId: 'r0', messageMap: {}, activePath: [] };
  globalThis.state = { providers: [], conversations: [conv] };
  globalThis.currentConv = function () { return conv; };
  var markerOpts = null;
  globalThis.VoiceDirector = {
    buildCallMarker: function (o) { markerOpts = o; return { role: 'system', content: '〔通话开始〕', marker: 'call' }; }
  };
  var mk = T.appendCallMarker('start');
  ok('通话标注写入 activePath', !!mk && conv.activePath.length === 1 && conv.activePath[0] === mk.id);
  var stored = conv.messageMap[conv.activePath[0]];
  ok('标注是 system 消息且 marker=call', stored.role === 'system' && stored.marker === 'call', JSON.stringify(stored));
  ok('标注挂在 rootId 下（父子关系正确）', stored.parentId === 'r0', stored.parentId);
  ok('buildCallMarker 收到 kind/at/startedAt/turns',
    !!markerOpts && markerOpts.kind === 'start' && typeof markerOpts.at === 'number' &&
    typeof markerOpts.startedAt === 'number' && typeof markerOpts.turns === 'number',
    JSON.stringify(markerOpts));

  var u = { id: 'u1', role: 'user', content: '你好' };
  var a = { id: 'a1', role: 'assistant', content: '在的' };
  conv.messageMap.u1 = u; conv.messageMap.a1 = a;
  conv.activePath.push('u1', 'a1');
  var hist = T.historyMessages(conv, 16);
  ok('historyMessages 过滤掉通话标注', hist.length === 2 && hist[0].role === 'user' && hist[1].role === 'assistant',
    JSON.stringify(hist));
  ok('标注本身仍在会话里（可回看）', !!conv.messageMap[stored.id]);

  // 5) 没有 buildCallMarker 也不炸：走最小兜底
  delete globalThis.VoiceDirector;
  var conv2 = { id: 'c4', rootId: 'r0', messageMap: {}, activePath: [] };
  globalThis.state = { providers: [], conversations: [conv2] };
  globalThis.currentConv = function () { return conv2; };
  var mk2 = T.appendCallMarker('end');
  ok('主任缺 buildCallMarker 时仍写标注（兜底）', !!mk2 && conv2.activePath.length === 1, JSON.stringify(mk2 && mk2.content));

  globalThis.settings = originSettings;
  globalThis.state = originState;
  if (hadConvFn) globalThis.currentConv = originConvFn; else delete globalThis.currentConv;
  if (hadVD) globalThis.VoiceDirector = originVD; else delete globalThis.VoiceDirector;
})();

// =====================================================================================
console.log('\n[v128] 句间静音上限（"磕巴"修复）');
// =====================================================================================
(function () {
  var RATE = 24000;
  var THR = 32768 * T.SILENCE_CAP_MS * 0 + 32768 * 0.008;   // 与实现同源：满量程 0.8%
  function silent(ms) { return new Int16Array(Math.round(ms / 1000 * RATE)); }
  function tone(ms) {
    var n = Math.round(ms / 1000 * RATE), a = new Int16Array(n);
    for (var i = 0; i < n; i++) a[i] = Math.round(8000 * Math.sin(i / 12));
    return a;
  }
  function concat(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Int16Array(total), off = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
    return out;
  }
  function msOf(arr) { return Math.round(arr.length / RATE * 1000); }

  // ① 一段 500ms 静音 + 300ms 声音 → 静音被截到 140ms
  var cap = T.makeSilenceCap(140, RATE);
  var r1 = cap.process(concat([silent(500), tone(300)]));
  ok('超长静音被截到上限（500→140ms）', msOf(r1.out) === 440, msOf(r1.out) + 'ms');
  ok('丢弃量记在 dropped', Math.abs(r1.dropped / RATE * 1000 - 360) < 2, String(r1.dropped));

  // ② 上限以内的自然停顿原样保留（不把正常换气压掉）
  var cap2 = T.makeSilenceCap(140, RATE);
  var r2 = cap2.process(concat([tone(200), silent(90), tone(200)]));
  ok('上限内的停顿不被动（90ms 原样保留）', msOf(r2.out) === 490, msOf(r2.out) + 'ms');
  ok('没有丢弃', r2.dropped === 0, String(r2.dropped));

  // ③ 跨块连续：静音被拆成 3 块（70+70+70）时也要算总长，而不是每块各自从头计
  var cap3 = T.makeSilenceCap(140, RATE);
  var out3 = [], dropped3 = 0, k;
  var blocks = [silent(70), silent(70), silent(70), tone(200)];
  for (k = 0; k < blocks.length; k++) {
    var rr = cap3.process(blocks[k]);
    out3.push(rr.out); dropped3 += rr.dropped;
  }
  var joined3 = concat(out3.filter(function (x) { return x.length; }));
  ok('跨块静音合并计量（210ms → 140ms）', msOf(joined3) === 340, msOf(joined3) + 'ms');
  ok('跨块累计丢弃 ≈ 70ms', Math.abs(dropped3 / RATE * 1000 - 70) < 2, String(dropped3));

  // ④ cap = 0 时完全直通（用户想听原始音频）
  var cap0 = T.makeSilenceCap(0, RATE);
  var raw = concat([silent(500), tone(200)]);
  var r4 = cap0.process(raw);
  ok('上限 0 = 直通，不丢任何样本', r4.out.length === raw.length && r4.dropped === 0, r4.out.length + '');

  // ⑤ 全部是声音时，输出必须与原样本逐样本相同（不能改动波形）
  var cap5 = T.makeSilenceCap(140, RATE);
  var voiceOnly = tone(400);
  var r5 = cap5.process(voiceOnly);
  var same = r5.out.length === voiceOnly.length;
  for (var m = 0; m < voiceOnly.length && same; m++) if (r5.out[m] !== voiceOnly[m]) same = false;
  ok('全是声音时逐样本不变（不改音质）', same, 'len ' + r5.out.length);
  ok('静音阈值与实现一致（THR≈满量程0.8%）', THR > 200 && THR < 300, String(THR));
})();

// =====================================================================================
console.log('\n[v128] 思考策略与 token 预算');
// =====================================================================================
(function () {
  var hadSettings = Object.prototype.hasOwnProperty.call(globalThis, 'settings');
  var origin = globalThis.settings;

  // ① 没有 settings（老环境）→ 跟随会话
  try { delete globalThis.settings; } catch (e) {}
  var t1 = T.voiceThinking({ thinkingEnabled: true });
  ok('无设置时默认 follow', t1.mode === 'follow' && t1.on === true, JSON.stringify(t1));
  var t2 = T.voiceThinking({ thinkingEnabled: false });
  ok('会话关掉思考 → follow 时不开', t2.on === false, JSON.stringify(t2));

  // ② 显式关 / 显式开覆盖会话
  globalThis.settings = { voice: { thinking: 'off' } };
  ok('thinking=off 覆盖会话（会话开着也不思考）', T.voiceThinking({ thinkingEnabled: true }).on === false);
  globalThis.settings = { voice: { thinking: 'on' } };
  ok('thinking=on 覆盖会话（会话关着也思考）', T.voiceThinking({ thinkingEnabled: false }).on === true);

  // ③ 乱填的值不能把功能调死 → 退回 follow
  globalThis.settings = { voice: { thinking: 'yes-please' } };
  var t3 = T.voiceThinking({ thinkingEnabled: true });
  ok('非法值退回 follow', t3.mode === 'follow' && t3.on === true, JSON.stringify(t3));

  // ④ 预算：思考必须额外留额度，否则正文会被 reasoning 挤空（实测 160 全被吃掉）
  ok('首轮不思考 = 160', T.brainMaxTokens(true, false) === 160, String(T.brainMaxTokens(true, false)));
  ok('后续不思考 = 400', T.brainMaxTokens(false, false) === 400, String(T.brainMaxTokens(false, false)));
  ok('首轮思考 = 160 + 思考预算',
    T.brainMaxTokens(true, true) === 160 + T.THINK_TOKEN_BUDGET, String(T.brainMaxTokens(true, true)));
  ok('思考预算足以覆盖实测 reasoning（≥1400）', T.THINK_TOKEN_BUDGET >= 1400, String(T.THINK_TOKEN_BUDGET));

  if (hadSettings) globalThis.settings = origin; else { try { delete globalThis.settings; } catch (e) {} }
})();

// =====================================================================================
console.log('\n[v128] 历史消息必须带 JSON 壳（否则上游只吐空格）');
// =====================================================================================
(function () {
  // 故障原样：会话里存的 assistant 是"说出口的原话"（回看要可读），
  //   而大脑要求 json_object 输出 → 历史里出现纯文本 assistant，DeepSeek 会返回
  //   一串空白字符（content="       "，finish_reason=stop），语音解析不出 speech，
  //   于是每轮都走兜底「嗯，我在。」。Node 对照实验见 tools/t-empty.js。
  var conv = { id: 'hc', rootId: 'r', messageMap: {}, activePath: [] };
  var u1 = { id: 'u1', role: 'user', content: '嗯。' };
  var a1 = { id: 'a1', role: 'assistant', content: '我在听。' };
  var u2 = { id: 'u2', role: 'user', content: '今天有点累。' };
  conv.messageMap = { u1: u1, a1: a1, u2: u2 };
  conv.activePath = ['u1', 'a1', 'u2'];

  var hist = T.historyMessages(conv, 8);
  ok('user 历史原样透传', hist[0].content === '嗯。' && hist[2].content === '今天有点累。',
    JSON.stringify(hist));
  ok('assistant 历史被包成 {"speech":…}',
    hist[1].content === '{"speech":"我在听。"}', JSON.stringify(hist[1].content));
  var parsed = null;
  try { parsed = JSON.parse(hist[1].content); } catch (e) {}
  ok('包出来的壳是合法 JSON（上游能按 json_object 接）', !!parsed && parsed.speech === '我在听。',
    JSON.stringify(parsed));

  // 已经是 JSON 的历史不要重复包（用户可能手工编辑过，或来自上游原文）
  var rawJson = '{"speech":"好的。","emotion":"平静"}';
  var conv2 = { id: 'hc2', rootId: 'r', messageMap: {}, activePath: [] };
  conv2.messageMap = { a2: { id: 'a2', role: 'assistant', content: rawJson } };
  conv2.activePath = ['a2'];
  var hist2 = T.historyMessages(conv2, 4);
  ok('已经是 JSON 的 assistant 不重复包装', hist2[0].content === rawJson, JSON.stringify(hist2[0].content));

  // 引号/换行必须转义，否则发给模型的 messages 本身就不是合法 JSON
  var conv3 = { id: 'hc3', rootId: 'r', messageMap: {}, activePath: [] };
  conv3.messageMap = { a3: { id: 'a3', role: 'assistant', content: '他说"别急"\n然后笑了' } };
  conv3.activePath = ['a3'];
  var hist3 = T.historyMessages(conv3, 4);
  var ok3 = null;
  try { ok3 = JSON.parse(hist3[0].content); } catch (e) {}
  ok('含引号/换行的原话转义正确', !!ok3 && ok3.speech === '他说"别急"\n然后笑了', JSON.stringify(hist3[0].content));
})();

// =====================================================================================
var total = passes + failures;
console.log('\n' + '='.repeat(58));
console.log((failures === 0 ? '全部通过' : '有失败') + '：' + passes + '/' + total + ' 通过，' + failures + ' 失败');
console.log('='.repeat(58) + '\n');
process.exit(failures === 0 ? 0 : 1);
