# Kraki installer for Windows PowerShell
# Usage: irm https://app.kraki.chat/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "corelli18512/kraki"
$asset = "kraki-cli-windows-x64.exe"
$binaryName = "kraki.exe"

Write-Host ""
Write-Host "  Kraki Installer" -ForegroundColor Cyan
Write-Host ""

# Windows PowerShell's web cmdlets ignore HTTPS_PROXY; pass it explicitly so
# networks that reach GitHub only through a proxy can install too.
$web = @{ UseBasicParsing = $true }
$proxy = @($env:HTTPS_PROXY, $env:https_proxy, $env:HTTP_PROXY, $env:http_proxy) | Where-Object { $_ } | Select-Object -First 1
if ($proxy) { $web.Proxy = $proxy }

# This repository also publishes Mac-only releases. GitHub's /latest may
# point at one of those, so select a stable release that actually has our asset.
function Get-KrakiWindowsRelease {
    param([string]$Repository, [string]$AssetName)
    for ($page = 1; $page -le 5; $page++) {
        $releases = Invoke-RestMethod "https://api.github.com/repos/$Repository/releases?per_page=100&page=$page" @web
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

# Download next to the target first: a running kraki.exe cannot be
# overwritten, and replacing it under a running daemon kept the old version
# running. Stop the daemon only once the new binary is here; the setup run
# below starts it again.
$download = "$target.download"
try {
    Invoke-WebRequest -Uri $url -OutFile $download @web
} catch {
    Write-Host "  Could not download $url" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)"
    if (-not $proxy) {
        Write-Host "  If this network reaches GitHub only through a proxy, set HTTPS_PROXY and run the installer again."
    }
    Remove-Item -Force -ErrorAction SilentlyContinue $download
    throw
}

# Verify against the release's SHA256SUMS.txt; refuse a mismatch or a
# release without checksums.
$sumsUrl = ($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1).browser_download_url
$expected = $null
if ($sumsUrl) {
    try {
        $sums = (Invoke-WebRequest -Uri $sumsUrl @web).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        foreach ($line in ($sums -split "`n")) {
            $parts = $line.Trim() -split '\s+', 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0].ToLower(); break }
        }
    } catch {}
}
$actual = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) {
    Remove-Item -Force -ErrorAction SilentlyContinue $download
    throw "Checksum verification failed for $asset - refusing to install."
}

if (Test-Path $target) {
    $wasRunning = $false
    try { $wasRunning = ((& $target status --json 2>$null | Out-String) -match '"running":\s*true') } catch {}
    if ($wasRunning) {
        Write-Host "  Stopping the running Kraki daemon for the upgrade..."
        try { & $target stop *> $null } catch {}
        # Give the process a moment to release the executable.
        for ($i = 0; $i -lt 20; $i++) {
            try { [IO.File]::Open($target, 'Open', 'ReadWrite', 'None').Close(); break } catch { Start-Sleep -Milliseconds 250 }
        }
    }
}
Move-Item -Force $download $target
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
