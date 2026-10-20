# v125 语音通话模块 —— 验证记录

> 记录人：Lead。所有数字均为**实测**，未测项如实标注。
> 验证层次按项目惯例递进：`node --check` → 单测 → 无头浏览器 CDP → 真机。
> 见看板 §4.19：**每一层只能证到那一层为止**。

---

## 1. 语法与单测

| 项 | 结果 |
|---|---|
| `node --check` 全部 11 个 www JS | **全过** |
| `tests/voice-director.test.js` | **340 / 340 通过**，退出码 0 |
| `tests/voice-runtime.test.js` | **155 / 155 通过**，退出码 0 |

覆盖范围：JSON 三态解析、解析失败回退、信号描述空/极值、表演提示各组合、sanitize 的 emoji/markdown/URL、
turnPolicy 边界（含端点自适应三档）、重采样、WAV 封装、PCM 拼接、VAD 判定、增量 JSON 抠 speech、范围夹紧。

---

## 2. 无头浏览器 CDP（真 API key）

### 2.1 语音链路自检 `VoiceCall.__testChain()`
```
识别服务：可达（mimo-v2.5-asr）
合成服务：可达（mimo-v2.5-tts / Mia）
往返验证：通过，识别回「Okay.」
通话大脑：deepseek-chat @ DeepSeek
结论：链路可用（含往返验证）
```
> 往返验证（TTS 合成 → 回灌 ASR → 转写非空）是 Lead 追加的第二级探测。
> 第一版有 bug（裸 PCM 被当 WAV 发，上游 400），已修并加 9 条回归断言。

### 2.2 完整一轮通话
```
start() -> listening
inject -> ok
状态轨迹: listening → thinking → speaking → listening
metrics: asrMs=773  brainFirstTokenMs=1033  ttsFirstChunkMs=619  turnTotalMs=10728
userLine: 你今天几点睡？
asstLine: 嗯？还没定呢，怎么了，你是睡不着吗？
signals : 语速偏快 · 音量偏低
会话写回: [{user, src:voice}, {assistant, src:voice}]
```

---

## 3. 真机（小米 22081212C / Android 15 / CDP 直连 WebView）

安装包：`com.avelec.chatlite.voice_call`（v125）

### 3.1 平台前提
| 项 | 实测 |
|---|---|
| `isSecureContext` | **true**（origin `https://localhost`） |
| `getUserMedia` | **成功**，track state=`live` |
| 音频参数 | sampleRate **48000**、channelCount 1、echoCancellation/noiseSuppression/autoGainControl **全 true** |
| `track.label` | **空字符串**（WebView 不暴露设备名，已在代码里规避） |
| 权限 | 首次弹系统框，授权后正常；拒绝时抛 `NotAllowedError` 且**不挂起** |

### 3.2 完整一轮通话
```
start() -> listening    captureRate=48000   vad.thr=0.0084
状态轨迹: thinking → speaking → listening
metrics: asrMs=888  brainFirstTokenMs=1100  ttsFirstChunkMs=870  turnTotalMs=11732
userLine: 你即将进入神秘的水中。
asstLine: 嗯？神秘的水中，这什么意思啊，你慢点说。
signals : 语速偏快 · 音量偏低
```
> 真机比无头浏览器慢约 100~200ms，属 WebView + 真机网络正常差异。

### 3.3 未配置渠道时的错误路径
进入 `error` 态并给出可读提示，**不卡死**：
> 「语音服务缺少 API 密钥：请先添加 MiMo 渠道，或在设置里选择语音渠道」

---

## 4. 界面与观感

### 4.1 ★ 测量方法修正（重要）
**Windows 上 `chrome --headless --window-size=390,844` 实际得到 487×688**（受系统最小窗口限制，`screen` 甚至是 200×150）。
必须用 `Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:2,mobile:true})`，且**要在页面加载完成后设置**（导航会重置 override）。

> 由 ui-polish 发现，Lead 复验确认并修进 `tools/cdp.js`。
> **在此之前的"窄屏"截图全部是在 487×688 下拍的** —— 与看板 §4.12「尺子在说谎」同源。

### 4.2 真 390×844 布局（修好尺子后重测）
```
voice-orb        top=85   bottom=265
voice-state-text top=275  bottom=295
voice-subtitle   top=303  bottom=395
voice-signals    top=405  bottom=436
voice-timer      top=639  bottom=659
btn-voice-hangup bottom=828   (视口 844，完整可见)
重叠检测 bad=[]
```

### 4.3 六种状态色互不相同（PASS）
```
idle 150,158,176 | connecting 72,96,190 | listening 52,199,168
thinking 230,168,58 | speaking 150,96,232 | error 178,58,66
```

### 4.4 发现的 UI 缺陷及修复
| 缺陷 | 根因 | 处置 |
|---|---|---|
| 副语言胶囊压穿计时器（「1:2」） | `.voice-subtitle` 写成 `flex:1;min-height:0`，在纵向 flex 中被 orb 挤到近零，内容溢出压到下方 | 改 `flex:0 1 auto; min-height:118px; overflow-y:auto` |
| orb 放大后顶出上边界 7px | `transform:scale` 不参与布局 | 按放大比例预留 padding |
| 球体后硬边矩形 | `box-shadow` 外发光被合成层矩形裁断 | 改 inset 阴影 + 独立 `::after` 径向渐变层 |
| 背景光晕切成矩形 | `radial-gradient` 默认按 `farthest-corner` 算半径 | 加 `closest-side` |

---

## 5. 回归检查（不破坏既有功能）
| 项 | 结果 |
|---|---|
| 侧栏生图入口仍在 | ✅ |
| 顶栏旧生图入口已移除 | ✅ |
| 生图视图仍可打开 | ✅ |
| 打开通话时生图自动关闭（互斥） | ✅ |
| 关闭通话后 `body`/`state.voiceOpen`/`display` 全部还原 | ✅ |
| 会话列表 / 输入区 / 设置面板（7 个分组） | ✅ |

---

## 6. 未验证 / 已知限制（如实登记）

| 项 | 状态 |
|---|---|
| **barge-in 真机手感** | ⚠️ **未验**。无头 Chrome 与 CDP 都造不出「AI 说话时用户开口」的时序。代码路径与阈值逻辑已单测覆盖，但真实打断手感**必须由用户真机确认** |
| **回声/外放自激** | ⚠️ **未验**。设备静置于桌面，未做外放说话测试。已暴露 `echoGuardMs / bargeInLeakFactor` 供现场调，`__debug().tuning.leakRms` 是调参依据 |
| **蓝牙耳机** | ⚠️ **未验**。采样率会变（8000/16000/44100），代码走通用重采样不写死 48k，但未实测 |
| **宽屏 1280×844** | 待 ui-polish 补截图（orb 尺寸 / 字幕行宽 / 控制区居中） |
| **息屏 / 切后台通话** | ⚠️ **未验** |
| 声音克隆 / 声音设计 | 代码已接（走 `mimo-v2.5-tts-voiceclone` / `voicedesign`），**API 层已验证可用**，UI 上传流程未做端到端实测 |
| ScriptProcessorNode | 已废弃 API，会产生 console 警告；按兼容性优先保留，v126 可换 AudioWorklet |

---

## 7. 结论

**核心链路（听 → 想 → 说 → 写回会话）在真机完整跑通**，延迟在可接受范围，界面在真尺寸下无重叠、六态可分。
**交互手感（打断 / 回声 / 蓝牙）属于必须真机确认的部分，尚未验证** —— 按项目惯例，**自验通过 ≠ 可以上 main**（看板 §3.4）。

## 8. QA 独立验证发现的问题（已修）

> QA 用独立脚本重新验证，**50 PASS / 3 FAIL**。3 个 FAIL 中 2 个是真 bug。以下全部已修并复验。

| # | 缺陷 | 根因 | 修法 | 复验 |
|---|---|---|---|---|
| 1 | **4 个副语言标签被塞进 1 个胶囊** | `voice.js` 的 `renderSignals` 按 `、,，/` 拆，而 `voice-director` 用 `' · '` 作分隔符 —— **两侧各自都对，只是约定不一致** | `voice-director` 导出 `SIGNAL_SEP` 常量，两侧共用同一真相 | 拆分结果 **4**，渲染 4 个胶囊，与计时器无重叠 |
| 2 | **通话与生图只有单向互斥** | `voice.js` 的 `open()` 会关生图，但 `toggleImageView(true)` **不会反向关通话** → 两个全屏视图叠在一起 | `image-gen.js` 的 `toggleImageView` 加反向关闭 | 双向均验证：afterImage_voice=false、reverse_imageDisplay=none |
| 3 | **settings.voice 缺 rate / haptics 字段** | 契约写了但默认值没写；而 `migrateVoiceSettings` 只保留默认值里有的键 → 用户手写也会被**静默丢掉** | 补 `rate:1.0`、`haptics:true`（保留 `haptic` 作实际字段，兼容两写法） | 字段数 **24**，手写 rate:1.5 能保住 |

### 另修一条体验问题（QA 指出）
**`start()` 不做渠道预检**：原来点「开始通话」直接进 listening 并显示「请说话」，用户以为能用了，**说第一句才暴露「缺少 API 密钥」**。

修法：`start()` 在**申请麦克风之前**先做一次静态配置检查（只看配置、不发请求、不耗额度），失败立即进 error 态并提示。
复验：未配置时 `start()` 返回 **false**，状态 **error**，文案「语音服务缺少 API 密钥：请先添加 MiMo 渠道，或在设置里选择语音渠道」。

---

## 9. 证据强度说明（QA 提出的质疑，接受）

QA 指出我原报告里两处**证据链偏弱**，我接受并更正：

1. **§2.1 往返验证「识别回 Okay.」** —— 这是一次性输出（TTS 非确定性，同一句话每次合成不同，ASR 转写也可能不同）。**判据本来就是「非空」而不是「等于某个值」**，原写法容易让人误以为可复现。已改为只陈述判据。
2. **§2.2 的 turnTotalMs=10728 与 userLine 无截图留存** —— 同类量级可复现（QA 复跑 10091ms），但**原始截图已随临时文件清理**。此后所有关键结论都要求附截图。

> 这两条本身不改变结论，但**证据的呈现方式必须诚实** —— 一次性输出写成「实测值」、无留档写成「已验证」，都会在后续复盘中误导人。

---

## 10. 最终交付物

| 项 | 值 |
|---|---|
| APK | `chat-lite-2.1-v125-voice-call-debug.apk`（**4,650,948 字节 / 4.43 MB**） |
| appId | `com.avelec.chatlite.voice_call`（与主包共存，不覆盖） |
| 装机 | 已覆盖安装并启动（pid 存活，无崩溃） |
| 包内容核验 | **8 个关键文件 SHA256 与工作区逐一比对，全部一致** |
| 权限 | `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` 均在 |
| 测试残留 | 全包搜索 perm-test 等关键词：无 |
