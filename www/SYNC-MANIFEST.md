# SYNC-MANIFEST — 双向同步声明

**最后更新**：2026-10-28（v3.0.7：新增共享模块 `auto-title.js`（会话标题自动命名），当前只在 APK 仓库；v3.0.5：新增共享模块 `web-search.js`（联网搜索），当前只在 APK 仓库）
**用途**：chat-lite（主仓库）与 chat-lite-android（APK 仓库）按需互相同步时的差异声明

> 两个仓库是**独立的**。任何一方的改进，另一方**不默认跟进**。
> 需要同步时，手动运行 `sync.ps1`（可选双向 + Preview 预览）。
> 本清单说明哪些部分共享、哪些部分各自特有，同步时不会覆盖特有部分。

---

## 一、共享文件（sync.ps1 会同步的部分）

> ⚠ **v3.0.1（2026-10-27）起：语音通话是 APK 专有功能，主仓库不包含、也不同步。**
> 但下面这些「共享文件」**已经含语音相关代码**（v125 起），整体同步会把语音代码带到 Web 版，
> 而 Web 版没有 `voice*.js` → 顶栏出现点不开的话筒、控制台报错。
> **同步这些文件时必须按 §二.1 的清单人工剔除语音段落**，不能无脑覆盖。
> 语音相关行数（实测）：`index.html` 84 / `style.css` 277 / `db.js` 20 / `image-gen.js` 7 / `app.js` 2 / `io.js` 1。
> `chat.js` 是唯一"干净"的（`buildContext(conv, opts)` 的 `statusBar` 选项是通用改进，可整体同步）。

| 文件 | 说明 |
|---|---|
| `app.js` | 入口（state/init/事件绑定/通用工具） |
| `db.js` | 存储层（IndexedDB/Filesystem） |
| `haptics.js` | 振感反馈（web 端降级为无） |
| `providers.js` | 聊天 Provider 系统 |
| `image-gen.js` | 生图（接口/图库/预览/存储） |
| `conversation.js` | 会话管理（渲染/分支树/长按菜单） |
| `chat.js` | 聊天核心（消息发送/流式请求） |
| `io.js` | 导入导出 + 角色卡 + 格式转换 |
| `gesture-helpers.js` | 手势辅助 |
| `latex.js` | LaTeX 渲染层（定界符提取 → 占位符穿越 marked → KaTeX 回填）**v116 新增** |
| `web-search.js` | 联网搜索（DeepSeek Search / Fetch 客户端 + 会话级开关 + 上下文注入 + 来源卡片）**v3.0.5 新增**。本身就是 web 可用的（`wsPostJson` 有 web `fetch` 分支），**不是 APK 专有**；同步时还要一起带：`index.html` 的 `<script src="web-search.js">`、输入区地球按钮、设置面板「联网搜索」分组与「本次对话 → 联网搜索」开关、`style.css` 的 `.ws-*` / `.web-sources*` 规则、`db.js` 的 `defaultWebSearchSettings` / `migrateWebSearchSettings`、`chat.js` 的注入点、`conversation.js` 的来源渲染 |
| `auto-title.js` | 会话标题自动命名（首条消息 → 截断式占位 → 模型短标题覆盖）**v3.0.7 新增**。纯前端、web 可用；但**web 版走本机中转时不发模型请求**（只保留截断式），判定在 `atAskModel` 里。同步时还要一起带：`index.html` 的 `<script src="auto-title.js">` + 设置面板「常用偏好 → 自动命名会话」开关、`db.js` 的 `defaultAutoTitleSettings` / `migrateAutoTitleSettings`、`chat.js sendFromMessage` 开头的调用、`conversation.js` 手动改名处置 `titleSetByUser`、`app.js` 的开关绑定与 `fillSettingsForm` 回填 |
| `vendor/` | **目录（递归同步）**：本地化第三方库——`katex/`（0.16.47，含 20 个 woff2 字体）、`marked/`（12.0.1）、`highlight/`（11.9.0）。**v116 新增**，替代原 cdnjs 引用 |
| `index.html` | 页面结构 |
| `style.css` | 样式 |
| `favicon.png` / `icon-192.png` / `icon-512.png` | 图标 |
| `manifest.json` | PWA 清单（注意：主仓库为 `/chat-lite/` 前缀路径，APK 为相对路径，同步后需各自检查） |

## 二、APK 仓库特有（sync 不覆盖，需手工维护）

| 文件/部分 | 说明 |
|---|---|
| `capacitor.config.json` | Capacitor 配置 |
| `android/` | Android 原生工程（MainActivity 的 WakeLock 等） |
| `package.json` | APK 依赖（@capacitor/* 插件） |
| `www/APK_ONLY_PATCHES.md` | APK 特有改动详细历史（v49-v85 全记录） |
| JS 中的 `isCapacitor()` 分支 | Capacitor 运行时隔离逻辑 |
| `CapFilesystem` / `CapShare` / `CapStreamHttp` / `CapHaptics` / `CapRichHaptics` | Capacitor 原生插件调用 |
| 生图的 Filesystem 图片存储 | `writeImageFile` / `readImageFile` 等 |
| 导入导出 OOM 修复（`encoding:'utf8'`） | Filesystem 原生写文本 |
| 后台任务通知 / WakeLock 逻辑 | Capacitor App 生命周期 |

### 二.1 语音通话模块（整体 APK 专有，**不推主仓库**）

| 项 | 说明 |
|---|---|
| `voice.js` / `voice-director.js` / `voice-provider.js` / `voice-settings.js` | 四个文件都**不进主仓库**（主仓库现在没有，保持没有） |
| 原生 `CallKeepService` / `CallKeepAlivePlugin` / `AudioRoutePlugin` | 前台服务 + 唤醒锁 + Wi-Fi 锁 + 音频路由，Web 版没有对应物 |
| `index.html` 里的 `#voice-view` 整块 DOM / 顶栏话筒按钮 / 4 个 `<script>` 引用 | 同步时要整块剔除 |
| `index.html` 设置面板的「语音通话」分组（含 Beta 徽标 / 总开关 / 微调面板） | 同上 |
| `style.css` 的 `.voice-*` 规则（约 277 行） | 剔除后其余样式可同步 |
| `db.js` 的 `defaultVoiceSettings` / `migrateVoiceSettings` / 语音字段收敛（约 20 行） | 剔除；其余存储逻辑可同步 |
| `image-gen.js` 的 `state.voiceOpen` 互斥判断（约 7 行） | 剔除 |
| `app.js` 的语音入口绑定（2 行）/ `io.js` 的 voice 字段处理（1 行） | 剔除 |
| `www/APK_ONLY_PATCHES.md` §32~§36 | 语音模块的完整改动史（APK 专有，主仓库不需要） |

> 判据：主仓库没有 `voice.js` 时，`window.VoiceCall` 为 undefined。
> 上面所有剔除点都必须能在「VoiceCall 不存在」时安全降级 —— 代码里已按这个原则写（`typeof` 判断 + try/catch），
> 但**同步后仍需实际打开一次页面确认无报错**。

## 三、主仓库特有（sync 不覆盖，需手工维护）

| 文件/部分 | 说明 |
|---|---|
| `server.js` | 后端代理（本地模式 CORS 中转） |
| `sw.js` | Service Worker（PWA 离线） |
| `config.json` / `.env.example` | 服务器配置 |
| `certs/` / `data/` / `.github/` / `tmp/` | 服务器相关目录 |
| `index.html` 的 manifest 路径 | `/chat-lite/manifest.json` 前缀 |

## 四、同步注意事项

1. **方向**：`.\sync.ps1 -Direction main-to-apk`（主→APK，默认）或 `apk-to-main`（APK→主）
2. **预览**：先 `-Preview` 看差异，确认后再实际同步
3. **web 降级**：APK 特有代码用 `isCapacitor()` 隔离，web 下返回 false 自动走 web 分支，无需剥离
4. **b61c923 修复**（models URL 从聊天端点派生）：主仓库已有，APK 若缺失需手工补
5. **同步后**：`node --check` 全部 JS + 各仓库自行 commit（sync.ps1 不自动提交）
6. **cache-bust**：同步后按各仓库自身版本续编，不强行统一。**且只有内容真的变了的模块才升号**——"顺手统一升全部模块"会强制用户端重下未变文件，并把被缓存掩盖的问题一起翻出来（2026-09-19 v113 实证，详见看板 §4.7）
7. **OOM 修复**：APK 用 `encoding:'utf8'`（Filesystem API）；web 分支保留 `<a download>` + 紧凑 JSON 优化
8. **`vendor/` 按目录同步**（v116 起）：`sync.ps1` 递归比对 `vendor/`，逐文件 SHA1，只复制有差异的；无需在脚本里逐个登记 26 个字体/库文件

## 五、快速决策表

| 场景 | 操作 |
|---|---|
| 主仓库有 bug 修复 | `.\sync.ps1 -Direction main-to-apk -Preview` → 确认 → 同步 |
| APK 有通用功能更新 | `.\sync.ps1 -Direction apk-to-main -Preview` → 确认 → 同步 |
| APK 特有功能（振感/生图存储/后台） | **不同步**，留在 APK 仓库 |
| 主仓库特有（server.js/代理逻辑） | **不同步**，留在主仓库 |
| 不确定 | 先 `-Preview`，diff 后判断 |

---

*两仓库独立演进，需要时互通有无。*
