// v125 e2e：在页面里配置 MiMo / DeepSeek 渠道 + 语音设置
// 由 tests/voice-e2e-page.js 通过 ctx.ev() 执行；key 来自 window.__e2eKeys（node 侧注入，不落盘）
(function () {
  var K = window.__e2eKeys || {};
  var mk = function (id, name, tpl, base, key, models) {
    return { id: id, name: name, template: tpl, baseUrl: base, endpointPath: '/v1/chat/completions',
      apiKey: key, authType: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ',
      extraHeaders: {}, extraQuery: {}, models: models || [], features: { supportsStreaming: true } };
  };
  state.providers = (state.providers || []).filter(function (x) { return x.id !== 'e2e-mimo' && x.id !== 'e2e-ds'; });
  state.providers.push(mk('e2e-mimo', 'E2E MiMo', 'openai', 'https://api.xiaomimimo.com', K.mimo,
    [{ id: 'mimo-v2.5-tts' }, { id: 'mimo-v2.5-asr' }]));
  state.providers.push(mk('e2e-ds', 'E2E DeepSeek', 'deepseek', 'https://api.deepseek.com', K.ds,
    [{ id: 'deepseek-chat' }]));
  var v = settings.voice = settings.voice || {};
  v.asrProviderId = 'e2e-mimo';
  v.ttsProviderId = 'e2e-mimo';
  v.asrModel = 'mimo-v2.5-asr';
  v.ttsModel = 'mimo-v2.5-tts';
  v.brainProviderId = 'e2e-ds';
  v.brainModel = 'deepseek-chat';
  v.voiceId = 'Mia';
  v.minUtteranceMs = 400;
  v.endpointSilenceMs = 700;
  return JSON.stringify({ providers: (state.providers || []).map(function (p) { return p.id; }) });
})()