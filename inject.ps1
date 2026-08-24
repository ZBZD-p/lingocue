# Adds (or removes) the loader that pulls the tutor panel into Jellyfin's
# own web UI.
#
# Jellyfin ships jellyfin-web as prebuilt static files under Program Files, so
# this is a small edit to a shipped file -- no forking, no build toolchain.
# Writing there needs elevation, which is the only reason this is a separate
# script instead of something the tutor backend does itself.
#
# What gets injected is a tiny bootstrap rather than a plain <script src>:
# the panel lives on port 8420 while Jellyfin serves 8096, so the URL can't
# be page-relative, and hardcoding 127.0.0.1 would break every device except
# this one (on a phone, 127.0.0.1 is the phone). Building the URL from
# location.hostname at runtime makes the same injected line work from the
# desktop browser and from anything else on the network.
#
# Re-run this after a Jellyfin update: an update replaces index.html and
# drops the injection with it. Re-running is safe -- any previous injection
# is stripped first.
#
# Usage (elevated PowerShell, from the project directory):
#     powershell -ExecutionPolicy Bypass -File .\inject.ps1
#     powershell -ExecutionPolicy Bypass -File .\inject.ps1 -Remove
#
# Deliberately avoids backtick line-continuations and backtick-escaped
# quotes: both parse inconsistently in Windows PowerShell 5.1. This file must
# stay saved as UTF-8 *with BOM* or 5.1 mis-decodes the Chinese below and
# fails with a misleading parse error.

param(
    [switch]$Remove,
    [string]$IndexPath = 'C:\Program Files\Jellyfin\Server\jellyfin-web\index.html',
    [int]$Port = 8420
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '需要管理员权限：请用「以管理员身份运行」的 PowerShell 再跑一次。' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $IndexPath)) {
    Write-Host ('找不到 Jellyfin 的 index.html: ' + $IndexPath) -ForegroundColor Red
    exit 1
}

$startMark = '<!--english-tutor-->'
$endMark = '<!--/english-tutor-->'

$loader = "var s=document.createElement('script');" +
          "s.src=location.protocol+'//'+location.hostname+':' + $Port + '/static/tutor-panel.js';" +
          "s.defer=true;document.head.appendChild(s);"
$block = $startMark + '<script>' + $loader + '</script>' + $endMark

$backup = $IndexPath + '.tutor-backup'
$html = Get-Content $IndexPath -Raw

# Strip any previous injection, including the older plain <script src>
# form, so re-running upgrades in place instead of stacking copies.
$pattern = [regex]::Escape($startMark) + '.*?' + [regex]::Escape($endMark)
$html = [regex]::Replace($html, $pattern, '', 'Singleline')
$html = [regex]::Replace($html, '<script[^>]*tutor-panel\.js[^>]*></script>', '')

if ($Remove) {
    Set-Content -Path $IndexPath -Value $html -NoNewline -Encoding UTF8
    Write-Host '已移除注入。' -ForegroundColor Green
    exit 0
}

if (-not (Test-Path $backup)) {
    Copy-Item $IndexPath $backup
    Write-Host ('已备份原文件 -> ' + $backup)
}

# Last thing before </body>, so Jellyfin's own bundles are already in flight.
$html = $html.Replace('</body>', $block + '</body>')
Set-Content -Path $IndexPath -Value $html -NoNewline -Encoding UTF8

Write-Host '注入成功（这次用的是按访问地址自动推导的加载器，手机也能用）。' -ForegroundColor Green

# Without this the panel loads fine on this machine and silently fails from
# every other device: Windows blocks inbound 8420 by default, so the phone's
# request for tutor-panel.js just times out. Scoped to private networks so
# the backend is not offered up on public Wi-Fi.
$ruleName = 'English Tutor backend (8420)'
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    $ruleArgs = @{
        DisplayName = $ruleName
        Direction   = 'Inbound'
        Action      = 'Allow'
        Protocol    = 'TCP'
        LocalPort   = $Port
        Profile     = 'Private'
    }
    New-NetFirewallRule @ruleArgs | Out-Null
    Write-Host ('已添加防火墙入站规则：TCP ' + $Port + '（仅专用网络）') -ForegroundColor Green
} else {
    Write-Host '防火墙规则已存在，跳过。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '接下来：' -ForegroundColor Cyan
Write-Host '  1. 确保 app.py 在跑（要重启，监听地址改了）' -ForegroundColor Cyan
Write-Host '  2. 电脑上按 Ctrl+Shift+R 强制刷新 Jellyfin 页面' -ForegroundColor Cyan
Write-Host '  3. 手机连同一个 Wi-Fi，浏览器打开 http://<这台电脑的局域网IP>:8096' -ForegroundColor Cyan
Write-Host '     （局域网 IP 可以用 ipconfig 查，找 IPv4 地址）' -ForegroundColor Cyan
