# Build a clean Chrome Web Store .zip from the runtime files only.
# Usage:  powershell -ExecutionPolicy Bypass -File package.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "coupon-hunter-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

$runtime = @(
  "manifest.json", "background.js", "sources.js", "core.js", "content.js",
  "content.css", "popup.html", "popup.css", "popup.js", "welcome.html",
  "welcome.js"
) | ForEach-Object { Join-Path $root $_ }

$missing = $runtime | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "Missing files: $($missing -join ', ')" }

$paths = $runtime + (Join-Path $root "icons")
Compress-Archive -Path $paths -DestinationPath $zip -Force
Write-Host "Built $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB)"
