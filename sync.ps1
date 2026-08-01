# sync.ps1
# On-demand bidirectional sync: chat-lite (main repo) <-> chat-lite-android (APK repo)
#
# The two repos are INDEPENDENT. This script is an OPTIONAL on-demand tool, not a
# forced mechanism. Changes in one repo are NOT auto-followed by the other.
# Run it manually only when you actually want to sync.
#
# Usage (run from chat-lite-android repo root):
#   .\sync.ps1                        # default: main repo -> APK
#   .\sync.ps1 -Direction apk-to-main # APK -> main repo
#   .\sync.ps1 -Preview               # preview diffs only, no copying
#   .\sync.ps1 -Direction apk-to-main -Preview
#
# Params:
#   -Direction  sync direction: main-to-apk (default) or apk-to-main
#   -Preview    only show diff summary, do not copy files
#   -MainRepo   path to main repo (default: ../chat-lite)

param(
    [ValidateSet("main-to-apk", "apk-to-main")]
    [string]$Direction = "main-to-apk",
    [switch]$Preview,
    [string]$MainRepo = "../chat-lite"
)

$ErrorActionPreference = "Stop"

# ---------- Config ----------
# Shared frontend files (maintained in both repos, eligible for sync)
$sharedFiles = @(
    "app.js", "db.js", "haptics.js", "providers.js",
    "image-gen.js", "conversation.js", "chat.js", "io.js",
    "gesture-helpers.js", "index.html", "style.css",
    "favicon.png", "icon-192.png", "icon-512.png", "manifest.json"
)

# Repo-specific files (never synced, never overwritten by either direction)
$apkOnlyFiles = @(
    "APK_ONLY_PATCHES.md", "SYNC-MANIFEST.md",
    "UPSTREAM_COMMIT.txt", "capacitor.config.json"
)
$mainOnlyFiles = @(
    "server.js", "sw.js", "config.json", ".env.example"
)

$apkWebDir = Join-Path (Get-Location) "www"

# ---------- Helpers ----------
function Get-Sha1([string]$path) {
    if (-not (Test-Path $path)) { return "" }
    $hash = Get-FileHash -Path $path -Algorithm SHA1
    return $hash.Hash
}

# ---------- Main ----------
if (-not (Test-Path $MainRepo)) {
    Write-Host "ERROR: main repo path not found: $MainRepo" -ForegroundColor Red
    Write-Host "Usage: .\sync.ps1 -MainRepo 'C:\path\to\chat-lite'"
    exit 1
}

$srcDir  = if ($Direction -eq "main-to-apk") { $MainRepo } else { $apkWebDir }
$dstDir  = if ($Direction -eq "main-to-apk") { $apkWebDir } else { $MainRepo }
$dirName = if ($Direction -eq "main-to-apk") { "main -> APK" } else { "APK -> main" }

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " On-demand sync ($dirName)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
if ($Preview) {
    Write-Host " [PREVIEW] showing diffs only, no files copied`n" -ForegroundColor Yellow
}

$changed = @()
$skipped = @()

foreach ($f in $sharedFiles) {
    $src = Join-Path $srcDir $f
    $dst = Join-Path $dstDir $f

    $srcExists = Test-Path $src
    $dstExists = Test-Path $dst

    if (-not $srcExists) {
        # Source lacks this file (e.g. main repo has no module yet) - skip
        $skipped += $f
        continue
    }
    if (-not $dstExists) {
        # Target lacks this file - it is a NEW file
        Write-Host "  [NEW] $f (not present in target repo)" -ForegroundColor Green
        $changed += $f
        if (-not $Preview) { Copy-Item $src $dst -Force }
        continue
    }

    $h1 = Get-Sha1 $src
    $h2 = Get-Sha1 $dst
    if ($h1 -ne $h2) {
        Write-Host "  [DIFF] $f" -ForegroundColor Yellow
        $changed += $f
        if (-not $Preview) { Copy-Item $src $dst -Force }
    }
}

Write-Host ""
if ($changed.Count -eq 0) {
    Write-Host "OK: no diffs, repos already in sync ($($sharedFiles.Count) shared files)" -ForegroundColor Green
} elseif ($Preview) {
    Write-Host "WARN: $($changed.Count) file(s) differ: $($changed -join ', ')" -ForegroundColor Yellow
    Write-Host "   (preview mode, nothing copied. Run without -Preview to sync)"
} else {
    Write-Host "OK: synced $($changed.Count) file(s): $($changed -join ', ')" -ForegroundColor Green
}

if ($skipped.Count -gt 0) {
    Write-Host "  (skipped $($skipped.Count): not present in source)" -ForegroundColor DarkGray
}

# ---------- Post-sync reminders ----------
if (-not $Preview -and $changed.Count -gt 0) {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "After sync, please note:" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  1. Repo-specific files were NOT touched:" -ForegroundColor DarkGray
    Write-Host "     APK-only: $($apkOnlyFiles -join ', ')" -ForegroundColor DarkGray
    Write-Host "     APK-only: android/ capacitor.config.json" -ForegroundColor DarkGray
    Write-Host "     main-only: $($mainOnlyFiles -join ', ')" -ForegroundColor DarkGray
    Write-Host "     main-only: certs/ data/ .github/" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  2. If isCapacitor-branched JS was synced, verify APK-only logic:" -ForegroundColor Yellow
    if (Test-Path (Join-Path $apkWebDir "SYNC-MANIFEST.md")) {
        Write-Host "     see www/SYNC-MANIFEST.md (bidirectional diff manifest)" -ForegroundColor Yellow
    } elseif (Test-Path (Join-Path $apkWebDir "APK_ONLY_PATCHES.md")) {
        Write-Host "     see www/APK_ONLY_PATCHES.md (APK-only changes list)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  3. Recommended: node --check all JS + local smoke test" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  4. Each repo commits its own changes (this script does NOT commit)" -ForegroundColor Cyan
}
