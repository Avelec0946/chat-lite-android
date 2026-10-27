// v127 e2e：配置「语音接口」（独立于聊天渠道）+ 会话大脑
// 由 tests/voice-e2e-page.js 通过 ctx.ev() 执行；key 来自 window.__e2eKeys（node 侧注入，不落盘）
//
// v127 变更：语音不再复用「接口管理」里的聊天渠道，改为独立的 settings.voice.voiceProviders。
//   e2e 也必须按新结构配，否则 start() 会在预检阶段就失败（这正是用户遇到的 401 的同类问题）。
(function () {
  var K = window.__e2eKeys || {};
  var mk = function (id, name, tpl, base, key, models) {
    return { id: id, name: name, template: tpl, baseUrl: base, endpointPath: '/v1/chat/completions',
      apiKey: key, authType: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ',
      extraHeaders: {}, extraQuery: {}, models: models || [], features: { supportsStreaming: true } };
  };

  // 聊天渠道（只用于"大脑"，跟随会话）
  state.providers = (state.providers || []).filter(function (x) { return x.id !== 'e2e-ds'; });
  state.providers.push(mk('e2e-ds', 'E2E DeepSeek', 'deepseek', 'https://api.deepseek.com', K.ds,
    [{ id: 'deepseek-chat' }]));

  // 语音接口（独立配置：地址 + 密钥 + 模型）
  var v = settings.voice = settings.voice || {};
  v.voiceProviders = [{
    id: 'e2e-voice',
    name: 'E2E MiMo 官方',
    baseUrl: 'https://api.xiaomimimo.com',
    endpointPath: '/v1/chat/completions',
    apiKey: K.mimo,
    authType: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ',
    extraHeaders: {}, extraQuery: {},
    models: [{ id: 'mimo-v2.5-asr' }, { id: 'mimo-v2.5-tts' }],
    asrModel: 'mimo-v2.5-asr',
    ttsModel: 'mimo-v2.5-tts'
  }];
  v.voiceProviderId = 'e2e-voice';
  v.asrModel = 'mimo-v2.5-asr';
  v.ttsModel = 'mimo-v2.5-tts';
  v.voiceId = 'Mia';
  v.minUtteranceMs = 400;
  v.endpointSilenceMs = 700;
  v.autoHangup = false;          // 挂机测试不能被自动挂断打断
  // v3.0：语音通话改默认关（Beta，需手动打开）。老 fixture 没设这两个键，
  //   open() 会直接以「已在设置里关闭」拦住 —— 于是 edge/e2e 里所有场景（start/打断/
  //   互斥/注入）全都变成"没接通"，看起来像 18 条功能回归，其实只是前提没对齐。
  //   这两套件测的是**通话行为**，前提是"用户已经在设置里打开过"，所以显式打开。
  //   enabledSetByUser=true 是必须的：迁移里「没表过态就强制关」，缺了它下次启动又会被关掉。
  v.enabled = true;
  v.enabledSetByUser = true;
  return JSON.stringify({ providers: (state.providers || []).map(function (p) { return p.id; }),
    voiceProviders: v.voiceProviders.length });
})()
