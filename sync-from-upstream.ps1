# sync-from-upstream.ps1
# 从主仓库 chat-lite 同步前端文件到本仓库的 www/
# 用法：在 chat-lite-android 仓库根目录执行 .\sync-from-upstream.ps1
# 可选参数：-upstream 主仓库路径（默认 ../chat-lite）

param(
    [string]$upstream = "../chat-lite"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $upstream)) {
    Write-Host "错误：主仓库路径不存在：$upstream" -ForegroundColor Red
    Write-Host "用法：.\sync-from-upstream.ps1 -upstream 'C:\path\to\chat-lite'"
    exit 1
}

# 需要同步的前端文件
$files = @("app.js", "index.html", "style.css", "favicon.png", "icon-192.png", "icon-512.png", "manifest.json")

Write-Host "从主仓库同步前端文件：$upstream" -ForegroundColor Cyan
Write-Host ""

$copied = 0
$skipped = 0
foreach ($f in $files) {
    $src = Join-Path $upstream $f
    $dst = Join-Path "www" $f
    if (Test-Path $src) {
        Copy-Item $src $dst -Force
        Write-Host "  [已拷贝] $f" -ForegroundColor Green
        $copied++
    } else {
        Write-Host "  [跳过]   $f （上游不存在）" -ForegroundColor Yellow
        $skipped++
    }
}

Write-Host ""
Write-Host "同步完成：$copied 个文件已拷贝，$skipped 个跳过" -ForegroundColor Cyan
Write-Host ""

# 记录上游 commit
Push-Location $upstream
$commit = git log --oneline -1
Pop-Location

$commit | Out-File -FilePath "www/UPSTREAM_COMMIT.txt" -Encoding utf8
Write-Host "上游 commit 已记录到 www/UPSTREAM_COMMIT.txt：" -ForegroundColor Cyan
Write-Host "  $commit"
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "下一步：手动 merge APK 特有改动" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  主仓库的 app.js / index.html / style.css 被覆盖了 APK 特有改动，"
Write-Host "  需要手动重新应用以下修改："
Write-Host ""
Write-Host "  app.js:"
Write-Host "    1. 顶部 isCapacitor() 检测函数"
Write-Host "    2. 顶部 CapFilesystem / CapShare / CapHttp 插件引用"
Write-Host "    3. state 对象新增 _nativeAborted / _dataLoaded 字段"
Write-Host "    4. save() 函数：用 if (!isCapacitor()) 包住 server sync 部分"
Write-Host "    5. init() 函数：用 if (!isCapacitor()) 包住 loadFromServer() 调用"
Write-Host "    6. init() 函数：在 applyBackgroundImage() 后加 body.capacitor-mode class"
Write-Host "    7. 两处 useDirect 改为 isCapacitor() || settings.directMode || !isLocal"
Write-Host "    8. sendFromMessage 前新增 executeNativeRequest() 和 typewriterEffect()"
Write-Host "    9. sendFromMessage 和 sendFromMessageContinue 的 fetch 前加 Capacitor 分支"
Write-Host "   10. 新增 ensureDataLoaded / exportAllData / importAllData / importAllDataFromFile"
Write-Host "   11. init 事件绑定里加 btn-export-all / btn-import-all 监听"
Write-Host ""
Write-Host "  index.html:"
Write-Host "    1. favicon 和 manifest 改为相对路径"
Write-Host "    2. 直连模式 label 和 hint 加 web-only class"
Write-Host "    3. 接口管理区块后加「数据管理」区块（导出/导入全部按钮 + 模式选择）"
Write-Host ""
Write-Host "  style.css:"
Write-Host "    1. 末尾加 Capacitor 模式隐藏规则 + 移动端触摸区域优化"
Write-Host ""
Write-Host "  建议：用 git diff www/app.js 对比修改前后的差异，逐项确认。"
Write-Host ""
