# chat-lite-android

chat-lite 的 Android APK 版本，使用 [Capacitor](https://capacitorjs.com/) 打包。

> 主仓库（网页版）：https://github.com/Avelec0946/chat-lite

## 与主仓库的关系

**本仓库与主仓库是独立的两个仓库。** 双方各自演进，**不默认同步、不自动跟进**对方改动。

- 需要互通时，手动运行 `sync.ps1`（可选双向、可预览差异）——按需同步，不是强制机制
- APK 特有逻辑用 `isCapacitor()` 运行时隔离，web 下自动降级
- 双向差异声明见 `www/SYNC-MANIFEST.md`

## 项目结构

```
chat-lite-android/
├── www/                        # 前端文件（模块化结构，v2.0 拆分）
│   ├── app.js                  # 入口（state/init/事件绑定/通用工具）
│   ├── db.js                   # 存储层（IndexedDB/Filesystem）
│   ├── haptics.js              # 振感反馈
│   ├── providers.js            # 聊天 Provider 系统
│   ├── image-gen.js            # 生图子系统
│   ├── conversation.js         # 会话管理（渲染/分支树/长按菜单）
│   ├── chat.js                 # 聊天核心（消息发送/流式请求）
│   ├── io.js                   # 导入导出 + 角色卡 + 格式转换
│   ├── gesture-helpers.js      # 手势辅助
│   ├── index.html              # 页面结构（9 模块加载）
│   ├── style.css               # 样式
│   ├── APK_ONLY_PATCHES.md     # APK 特有改动历史（v49-v85 全记录）
│   └── SYNC-MANIFEST.md        # 双向同步差异声明
├── capacitor.config.json       # Capacitor 配置（webDir: www, CapacitorHttp 启用）
├── package.json                # npm 依赖
├── sync.ps1                    # 按需双向同步脚本（可 Preview）
├── android/                    # Android 工程（cap add 生成）
└── README.md                   # 本文件
```

## 环境要求

| 软件 | 版本 | 用途 |
|------|------|------|
| Node.js | 18+ | 运行 Capacitor CLI |
| Java JDK | 17 | Android 构建 |
| Android Studio | 最新 | Android SDK、APK 打包 |
| Android SDK | API 34+ | 构建工具 |

环境准备详见主仓库的 `chat-lite-apk-env-guide.md`。

## 构建步骤

### 1. 安装依赖

```powershell
cd C:\Users\86176\chat-lite-android
npm install
```

### 2. 添加 Android 平台（首次）

```powershell
npx cap add android
```

这会生成 `android/` 目录。

### 3. 配置 Android 工程

编辑 `android/app/build.gradle`，确认：

```gradle
android {
    namespace "com.avelec.chatlite"
    compileSdk 34

    defaultConfig {
        applicationId "com.avelec.chatlite"
        minSdkVersion 24        // Android 7.0+
        targetSdkVersion 34
        versionCode 1
        versionName "1.0.0"
    }
}
```

验证 `android/app/src/main/AndroidManifest.xml` 包含：

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

（`cap add android` 默认会加，但要确认。）

### 4. 同步 web 资源

```powershell
npx cap sync android
```

### 5. 构建 debug APK

```powershell
# 方式一：Android Studio
npx cap open android
# 然后 Build → Build Bundle(s) / APK(s) → Build APK(s)

# 方式二：命令行
cd android
.\gradlew assembleDebug
```

生成的 APK 在：
```
android/app/build/outputs/apk/debug/app-debug.apk
```

### 6. 安装到设备

```powershell
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## 快捷命令

```powershell
# 同步 web 资源 + 构建 debug APK
npm run build:debug

# 同步 web 资源 + 构建 release APK
npm run build:release

# 在 Android Studio 中打开
npm run open:android

# 仅同步 web 资源
npm run sync:web
```

## 按需双向同步（与主仓库互通）

两个仓库独立演进。需要互通时，在 APK 仓库根目录运行：

```powershell
# 预览差异（推荐先看再动）
.\sync.ps1 -Preview
.\sync.ps1 -Direction apk-to-main -Preview

# 实际同步
.\sync.ps1                    # 主仓库 → APK
.\sync.ps1 -Direction apk-to-main   # APK → 主仓库
```

同步前先读 `www/SYNC-MANIFEST.md`——它声明了哪些文件共享、哪些各自特有，同步时特有部分不会被覆盖。

同步后：
```powershell
npx cap sync android
cd android
.\gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> 注意：本仓库的改动**不会**自动推到主仓库；主仓库的改动**不会**自动拉进来。需要时手动同步。

## 架构说明

### 流式输出策略

APK 模式下采用**非流式 + 打字动画**方案：

1. `CapacitorHttp` 发起原生 HTTP 请求（绕过 CORS），一次性拿完整响应
2. 前端用 `typewriterEffect()` 逐字显示内容，模拟流式效果
3. 思考链（`reasoning_content`）一次性显示完整内容
4. 停止生成：标记 `_nativeAborted`，响应到达后丢弃（原生请求无法真正中断）
5. 超时：默认 120 秒，前端 `setTimeout` 兜底

未来可升级到方案 B（WebView fetch 真流式），见 `chat-lite-apk-migration-plan-v3.md`。

### 数据导出/导入

- **导出全部**：APK 模式用 `@capacitor/filesystem` 写入 + `@capacitor/share` 分享；Web 模式用 `<a download>`
- **导入全部**：支持「覆盖」和「合并」两种模式
  - 覆盖：直接替换当前所有数据
  - 合并：按 ID 去重，冲突时导入数据优先
- 导入前在 APK 模式下自动备份当前数据到 Cache 目录

### 与网页版的差异

| 功能 | 网页版 | APK |
|------|-------|-----|
| 后端代理 | server.js | 无（CapacitorHttp 绕过 CORS） |
| 流式输出 | 真流式（fetch + reader） | 非流式 + 打字动画 |
| 数据存储 | IndexedDB + 服务端同步 | 仅 IndexedDB（无服务端） |
| 直连模式开关 | 显示 | 隐藏（APK 强制直连） |
| 导出文件 | `<a download>` | Filesystem + Share |
| PWA manifest | 启用 | 保留无害 |

## 已知限制

1. **API Key 存在 WebView 本地存储**：不要把 debug APK 分发给他人
2. **停止生成不能真正中断请求**：原生 HTTP 一旦发出只能等返回，前端只能丢弃响应
3. **流式输出是假动画**：响应完整返回后才逐字显示，长回答会有等待
4. **CDN 依赖**：highlight.js / marked.min.js 从 CDN 加载，离线时语法高亮和 Markdown 渲染会失败（但不影响核心功能）
5. **数据不跨设备同步**：网页版和 APK 数据独立，需手动导出/导入

## 回滚方案

如果 Capacitor 方案走不通，回退到 Render 部署主仓库（详见主仓库的 `chat-lite-apk-transition-plan.md` 和 `chat-lite-dilemma-summary.md`）。

## 参考

- Capacitor 文档：https://capacitorjs.com/docs
- CapacitorHttp：https://capacitorjs.com/docs/apis/http
- Filesystem：https://capacitorjs.com/docs/apis/filesystem
- Share：https://capacitorjs.com/docs/apis/share
- v3 迁移计划：`chat-lite-apk-migration-plan-v3.md`
