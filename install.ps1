# Kraki installer for Windows PowerShell
# Usage: irm https://kraki.corelli.cloud/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "corelli18512/kraki"
$asset = "kraki-cli-windows-x64.exe"
$binaryName = "kraki.exe"

Write-Host ""
Write-Host "  🦑 Kraki Installer" -ForegroundColor Cyan
Write-Host ""

# Fetch latest version
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$version = $release.tag_name
Write-Host "  Installing Kraki $version..."

# Download
$url = "https://github.com/$repo/releases/download/$version/$asset"
$installDir = Join-Path $env:LOCALAPPDATA "Kraki"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$target = Join-Path $installDir $binaryName

Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
Write-Host "  Downloaded to $target"

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
    $env:Path = "$env:Path;$installDir"
    Write-Host "  Added $installDir to PATH"
}

Write-Host ""
Write-Host "  ✓ Kraki $version installed" -ForegroundColor Green
Write-Host ""

# Auto-run
& $target
