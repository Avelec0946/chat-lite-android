# sync.ps1
# 按需双向同步：chat-lite 主仓库 <-> chat-lite-android APK 仓库
#
# 两个仓库是独立的。本脚本是"按需可选"的同步工具，不是强制机制。
# 任何一方的改进，另一方不默认跟进。需要同步时手动运行本脚本。
#
# 用法（在 chat-lite-android 仓库根目录执行）：
#   .\sync.ps1                        # 默认：主仓库 -> APK（同步主仓库改动到 APK）
#   .\sync.ps1 -Direction apk-to-main # APK -> 主仓库（同步 APK 改动到主仓库）
#   .\sync.ps1 -Preview               # 只预览差异，不实际拷贝
#   .\sync.ps1 -Direction apk-to-main -Preview
#
# 参数：
#   -Direction  同步方向：main-to-apk（默认）或 apk-to-main
#   -Preview    只显示两端差异摘要，不拷贝文件
#   -MainRepo   主仓库路径（默认 ../chat-lite）

param(
    [ValidateSet("main-to-apk", "apk-to-main")]
    [string]$Direction = "main-to-apk",
    [switch]$Preview,
    [string]$MainRepo = "../chat-lite"
)

$ErrorActionPreference = "Stop"

# ---------- 配置 ----------
# 共享前端文件（两个仓库都维护、可互相同步的部分）
$sharedFiles = @(
    "app.js", "db.js", "haptics.js", "providers.js",
    "image-gen.js", "conversation.js", "chat.js", "io.js",
    "gesture-helpers.js", "index.html", "style.css",
    "favicon.png", "icon-192.png", "icon-512.png", "manifest.json"
)

# 单方特有文件（不参与同步，任何方向都不覆盖）
$apkOnlyFiles = @(
    "APK_ONLY_PATCHES.md", "SYNC-MANIFEST.md",
    "UPSTREAM_COMMIT.txt", "capacitor.config.json"
)
$mainOnlyFiles = @(
    "server.js", "sw.js", "config.json", ".env.example"
)

$apkWebDir = Join-Path (Get-Location) "www"

# ---------- 工具函数 ----------
function Get-Sha1([string]$path) {
    if (-not (Test-Path $path)) { return "" }
    $hash = Get-FileHash -Path $path -Algorithm SHA1
    return $hash.Hash
}

# ---------- 主逻辑 ----------
if (-not (Test-Path $MainRepo)) {
    Write-Host "错误：主仓库路径不存在：$MainRepo" -ForegroundColor Red
    Write-Host "用法：.\sync.ps1 -MainRepo 'C:\path\to\chat-lite'"
    exit 1
}

$srcDir  = if ($Direction -eq "main-to-apk") { $MainRepo } else { $apkWebDir }
$dstDir  = if ($Direction -eq "main-to-apk") { $apkWebDir } else { $MainRepo }
$dirName = if ($Direction -eq "main-to-apk") { "主仓库 -> APK" } else { "APK -> 主仓库" }

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 按需同步（$dirName）" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
if ($Preview) {
    Write-Host " [预览模式] 只显示差异，不拷贝文件`n" -ForegroundColor Yellow
}

$changed = @()
$skipped = @()

foreach ($f in $sharedFiles) {
    $src = Join-Path $srcDir $f
    $dst = Join-Path $dstDir $f

    $srcExists = Test-Path $src
    $dstExists = Test-Path $dst

    if (-not $srcExists) {
        # 源没有该文件（主仓库可能还没建模块），跳过
        $skipped += $f
        continue
    }
    if (-not $dstExists) {
        # 目标还没有该文件（例如主仓库还没有 db.js）——新增
        Write-Host "  [新增] $f（目标仓库还没有此文件）" -ForegroundColor Green
        $changed += $f
        if (-not $Preview) { Copy-Item $src $dst -Force }
        continue
    }

    $h1 = Get-Sha1 $src
    $h2 = Get-Sha1 $dst
    if ($h1 -ne $h2) {
        Write-Host "  [差异] $f" -ForegroundColor Yellow
        $changed += $f
        if (-not $Preview) { Copy-Item $src $dst -Force }
    }
}

Write-Host ""
if ($changed.Count -eq 0) {
    Write-Host "✅ 无差异，两端已一致（$($sharedFiles.Count) 个共享文件）" -ForegroundColor Green
} elseif ($Preview) {
    Write-Host "⚠️ 发现 $($changed.Count) 个文件有差异：$($changed -join ', ')" -ForegroundColor Yellow
    Write-Host "   （预览模式，未拷贝。去掉 -Preview 执行实际同步）"
} else {
    Write-Host "✅ 已同步 $($changed.Count) 个文件：$($changed -join ', ')" -ForegroundColor Green
}

if ($skipped.Count -gt 0) {
    Write-Host "  （跳过 $($skipped.Count) 个：源不存在）" -ForegroundColor DarkGray
}

# ---------- 同步后提醒 ----------
if (-not $Preview -and $changed.Count -gt 0) {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "同步后注意事项" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  1. 单方特有文件未被覆盖（本脚本不碰它们）：" -ForegroundColor DarkGray
    Write-Host "     APK 特有：$($apkOnlyFiles -join ', ')" -ForegroundColor DarkGray
    Write-Host "     APK 特有：android/ capacitor.config.json" -ForegroundColor DarkGray
    Write-Host "     主仓库特有：$($mainOnlyFiles -join ', ')" -ForegroundColor DarkGray
    Write-Host "     主仓库特有：certs/ data/ .github/" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  2. 若同步了含 isCapacitor 分支的 JS，检查 APK 特有逻辑是否完整：" -ForegroundColor Yellow
    if (Test-Path (Join-Path $apkWebDir "SYNC-MANIFEST.md")) {
        Write-Host "     见 www/SYNC-MANIFEST.md（双向差异声明）" -ForegroundColor Yellow
    } elseif (Test-Path (Join-Path $apkWebDir "APK_ONLY_PATCHES.md")) {
        Write-Host "     见 www/APK_ONLY_PATCHES.md（APK 特有改动清单）" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  3. 同步后建议：node --check 所有 JS + 启动本地验证" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  4. 同步后各仓库自行 commit（本脚本不自动提交）" -ForegroundColor Cyan
}
