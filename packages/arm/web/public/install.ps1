# Kraki installer for Windows PowerShell
# Usage: irm https://app.kraki.chat/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "corelli18512/kraki"
$asset = "kraki-cli-windows-x64.exe"
$binaryName = "kraki.exe"

Write-Host ""
Write-Host "  Kraki Installer" -ForegroundColor Cyan
Write-Host ""

# This repository also publishes Mac-only releases. GitHub's /latest may
# point at one of those, so select a stable release that actually has our asset.
function Get-KrakiWindowsRelease {
    param([string]$Repository, [string]$AssetName)
    for ($page = 1; $page -le 5; $page++) {
        $releases = Invoke-RestMethod "https://api.github.com/repos/$Repository/releases?per_page=100&page=$page"
        foreach ($candidate in $releases) {
            if ($candidate.draft -or $candidate.prerelease) { continue }
            if (@($candidate.assets | Where-Object { $_.name -eq $AssetName }).Count -gt 0) {
                return $candidate
            }
        }
        if ($releases.Count -lt 100) { break }
    }
    throw "No stable release contains $AssetName. See https://github.com/$Repository/releases"
}

$release = Get-KrakiWindowsRelease -Repository $repo -AssetName $asset
$version = $release.tag_name
Write-Host "  Installing Kraki $version..."

# Download
$url = ($release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1).browser_download_url
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
Write-Host "  [OK] Kraki $version installed" -ForegroundColor Green
Write-Host ""

# Auto-run
& $target
