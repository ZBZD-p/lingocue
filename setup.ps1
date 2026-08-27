# One-shot dependency installer for LingoCue.
#
# Installs everything that has a legitimate "just install it, no interaction
# needed" story: the Python packages, ffmpeg (downloaded straight into the
# project -- no separate installer, no PATH edit required), and the local
# dictionary database. Two things genuinely can't be scripted and are
# printed as next steps instead: loading the Chrome extension (Chrome
# deliberately refuses to let anything but a person click through that,
# same reason it won't let a script install a signed extension either) and
# logging into the Claude Code CLI (interactive OAuth).
#
# -WithPunctuation additionally installs funasr + torch/torchaudio, for the
# optional feature that restores punctuation on YouTube auto-captions that
# have none. Opt-in because that one feature alone is about 5.7GB once the
# model downloads -- see the size breakdown this script's README section
# links back to.
#
# Usage (from the project directory):
#     powershell -ExecutionPolicy Bypass -File .\setup.ps1
#     powershell -ExecutionPolicy Bypass -File .\setup.ps1 -WithPunctuation
#
# Safe to re-run any time: every step checks whether its target already
# exists before doing anything, so re-running after a partial/failed run
# just picks up wherever it left off.
#
# Same constraints as inject.ps1: no backtick line-continuations or
# backtick-escaped quotes (both parse inconsistently in Windows PowerShell
# 5.1), and this file must stay saved as UTF-8 *with BOM* or 5.1 mis-decodes
# the Chinese text below and fails with a misleading parse error.

param(
    [switch]$WithPunctuation
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot

function Write-Step($text) { Write-Host ("`n==> " + $text) -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host ('    ' + $text) -ForegroundColor Green }
function Write-Skip($text) { Write-Host ('    ' + $text) -ForegroundColor Yellow }

# ---- Python version ---------------------------------------------------
Write-Step '检查 Python 版本'
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd) {
    Write-Host '找不到 python，先去 https://www.python.org/downloads/ 装 3.10 及以上版本，安装时记得勾选 "Add python.exe to PATH"，装完重开一个终端再跑这个脚本。' -ForegroundColor Red
    exit 1
}
Write-Ok (python --version)

# ---- Python packages ---------------------------------------------------
Write-Step '安装 Python 依赖 (fastapi / uvicorn / pydantic / mcp)'
python -m pip install -r (Join-Path $ProjectRoot 'requirements.txt') --quiet
Write-Ok '完成'

if ($WithPunctuation) {
    Write-Step '安装标点优化功能 (torch + torchaudio + funasr，体积较大，耐心等一下)'
    python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu --quiet
    python -m pip install funasr --quiet
    Write-Ok '完成（ct-punc 模型约 1.2GB，第一次真正遇到没标点的自动字幕时才会自动下载）'
} else {
    Write-Skip '跳过标点优化功能（默认不装，完整装上大约再加 5.7GB）。想要的话加 -WithPunctuation 参数重跑这个脚本。'
}

# ---- ffmpeg ---------------------------------------------------------------
Write-Step '检查 ffmpeg / ffprobe'
$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
$localFfmpegDir = Join-Path $ProjectRoot 'ffmpeg\bin'
$ffmpegReady = $false
if ($ffmpegCmd) {
    Write-Skip ('已在 PATH 里找到：' + $ffmpegCmd.Source)
    $ffmpegReady = $true
} elseif (Test-Path (Join-Path $localFfmpegDir 'ffmpeg.exe')) {
    Write-Skip ('之前已经下载到项目里了：' + $localFfmpegDir)
} else {
    Write-Host '    正在下载 ffmpeg（约 100MB，官方社区构建，来自 BtbN/FFmpeg-Builds）...'
    $zipPath = Join-Path $env:TEMP 'ffmpeg-lingocue.zip'
    $extractDir = Join-Path $env:TEMP 'ffmpeg-lingocue-extract'
    Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip' -OutFile $zipPath
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir
    $binSrc = Get-ChildItem -Path $extractDir -Recurse -Directory -Filter 'bin' | Select-Object -First 1
    New-Item -ItemType Directory -Path (Join-Path $ProjectRoot 'ffmpeg') -Force | Out-Null
    Copy-Item -Path $binSrc.FullName -Destination (Join-Path $ProjectRoot 'ffmpeg') -Recurse -Force
    Remove-Item -Path $zipPath, $extractDir -Recurse -Force
    Write-Ok ('下载完成，解压到了：' + $localFfmpegDir)
}

# ---- 本地词典 ---------------------------------------------------------------
Write-Step '生成本地词典 (悬停查词用)'
$dictPath = Join-Path $ProjectRoot 'dictionary.db'
if (Test-Path $dictPath) {
    Write-Skip '已存在，跳过'
} else {
    python (Join-Path $ProjectRoot 'build_dict.py')
    Write-Ok '完成'
}

# ---- config.json ---------------------------------------------------------------
Write-Step '准备 config.json'
$configPath = Join-Path $ProjectRoot 'config.json'
$examplePath = Join-Path $ProjectRoot 'config.example.json'
if (-not (Test-Path $configPath)) {
    Copy-Item $examplePath $configPath
    Write-Ok '已从 config.example.json 创建'
} else {
    Write-Skip '已存在，不覆盖你已有的配置'
}
if (-not $ffmpegReady) {
    # Only auto-fill when this script is also the one that just fetched
    # ffmpeg -- if ffmpeg is already on PATH, config.json doesn't need to
    # know where it is at all, and this shouldn't overwrite a path someone
    # deliberately set to something else.
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $config.ffmpeg_dir) {
        $config.ffmpeg_dir = $localFfmpegDir -replace '\\', '/'
        ($config | ConvertTo-Json) | Set-Content $configPath -Encoding UTF8
        Write-Ok ('已把 ffmpeg_dir 指向 ' + $localFfmpegDir)
    }
}

Write-Host ''
Write-Host '能自动装的都装完了。还剩两步，脚本没法替你做：' -ForegroundColor Cyan
Write-Host '  1. YouTube 扩展：chrome://extensions 开开发者模式 -> 加载已解压的扩展程序 -> 选 extension 文件夹' -ForegroundColor Cyan
Write-Host '  2. 对话引擎二选一：装 Claude Code CLI 并登录 (claude.com/claude-code)，或者启动后在设置页填 DeepSeek API key' -ForegroundColor Cyan
Write-Host ''
Write-Host '都弄好之后：python app.py，然后打开 http://127.0.0.1:8420' -ForegroundColor Green
