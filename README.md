# chat-lite-android

chat-lite 的 Android APK 版本，使用 [Capacitor](https://capacitorjs.com/) 打包。

> 主仓库：https://github.com/Avelec0946/chat-lite
> 基于上游 commit：见 `www/UPSTREAM_COMMIT.txt`

## 与主仓库的关系

- **平行仓库**：本仓库独立于主仓库，主仓库保持纯净（不含 Capacitor 代码）
- **前端代码同步**：通过 `sync-from-upstream.ps1` 从主仓库拷贝，手动 merge APK 特有改动
- **运行时分支**：APK 特有逻辑全部用 `isCapacitor()` 检测隔离，主仓库同步时一眼能识别

## 项目结构

```
chat-lite-android/
├── www/                        # 前端文件（主仓库拷贝 + APK 改动）
│   ├── app.js                  # 修改版（isCapacitor 分支、原生 HTTP、全量导出/导入）
│   ├── index.html              # 修改版（导出/导入按钮、相对路径、web-only class）
│   ├── style.css               # 修改版（移动端触摸区域、capacitor-mode 隐藏）
│   ├── favicon.png             # 原样
│   ├── icon-192.png            # 原样
│   ├── icon-512.png            # 原样
│   ├── manifest.json           # 原样（APK 不需要，但保留无害）
│   └── UPSTREAM_COMMIT.txt     # 基于主仓库哪个 commit
├── capacitor.config.json       # Capacitor 配置（webDir: www, CapacitorHttp 启用）
├── package.json                # npm 依赖
├── sync-from-upstream.ps1      # 上游同步脚本
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

## 从主仓库同步更新

当主仓库 `chat-lite` 有新提交时：

```powershell
# 1. 先把主仓库更新到最新
cd C:\Users\86176\chat-lite
git pull

# 2. 回到 APK 仓库，执行同步脚本
cd C:\Users\86176\chat-lite-android
.\sync-from-upstream.ps1

# 3. 脚本会拷贝前端文件到 www/，并打印需要手动 merge 的 APK 特有改动清单
#    按清单逐项重新应用修改

# 4. 测试
npx cap sync android
cd android
.\gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

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
