// v125 e2e：用真 TTS 生成一段中文语音，重采样成 16k Int16Array 存到 window.__e2ePcm
// 为什么不用正弦波：ASR 对纯音会幻觉（契约 §1.1 实测「300ms 正弦音 -> Yeah.」），
// 真语音才能真正验证「注入 → ASR → 大脑 → TTS」这条链。
(async function () {
  var K = window.__e2eKeys || {};
  var T = window.VoiceCall.__test;
  var r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + K.mimo },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: '（轻声，慢一点）你今天晚上打算几点睡？' }],
      audio: { voice: 'Mia', format: 'pcm' }
    })
  });
  if (!r.ok) {
    var t = await r.text();
    return JSON.stringify({ error: 'tts http ' + r.status, body: String(t).slice(0, 300) });
  }
  var j = await r.json();
  var ch = j && j.choices && j.choices[0];
  var b64 = ch && ch.message && ch.message.audio && ch.message.audio.data;
  if (!b64) return JSON.stringify({ error: 'no audio in response', body: JSON.stringify(j).slice(0, 300) });
  var bytes = T.base64ToBytes(b64);
  var i16 = T.bytesToInt16(bytes);
  // Resampler 吃 Float32 吐 Float32；TTS 固定 24k，采集固定 16k
  var rs = new T.Resampler(24000, 16000);
  var out = rs.process(T.int16ToFloat32(i16));
  var out16 = T.floatToInt16(out);
  window.__e2ePcm = out16;
  return JSON.stringify({
    srcBytes: bytes.length, srcSamples: i16.length,
    outSamples: out16.length, outMs: Math.round(out16.length / 16000 * 1000)
  });
})()