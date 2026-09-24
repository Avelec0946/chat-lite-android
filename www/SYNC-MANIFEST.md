# SYNC-MANIFEST — 双向同步声明

**最后更新**：2026-09-25（v116：LaTeX 适配 + 第三方库全本地化）
**用途**：chat-lite（主仓库）与 chat-lite-android（APK 仓库）按需互相同步时的差异声明

> 两个仓库是**独立的**。任何一方的改进，另一方**不默认跟进**。
> 需要同步时，手动运行 `sync.ps1`（可选双向 + Preview 预览）。
> 本清单说明哪些部分共享、哪些部分各自特有，同步时不会覆盖特有部分。

---

## 一、共享文件（sync.ps1 会同步的部分）

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
