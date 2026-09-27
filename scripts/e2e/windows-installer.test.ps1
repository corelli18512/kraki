# Run with Windows PowerShell 5.1 or PowerShell 7. No Pester/network required.
param([string]$Installer = (Join-Path $PSScriptRoot '../../install.ps1'))
$ErrorActionPreference = 'Stop'
if (-not $PSBoundParameters.ContainsKey('Installer')) {
    $published = Join-Path $PSScriptRoot '../../packages/arm/web/public/install.ps1'
    if ((Get-FileHash $Installer).Hash -ne (Get-FileHash $published).Hash) {
        throw 'Root and published Windows installers must be identical'
    }
    Write-Output 'PASS: root and published installers are identical'
}
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Installer), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-KrakiWindowsRelease' }, $true)
if (-not $function) { throw 'Missing release selector' }
Invoke-Expression $function.Extent.Text

function New-Release($tag, $asset, $prerelease = $false) {
    return [pscustomobject]@{ tag_name = $tag; draft = $false; prerelease = $prerelease; assets = @([pscustomobject]@{ name = $asset; browser_download_url = "https://example.invalid/$tag/$asset" }) }
}
function Invoke-RestMethod([string]$Uri) {
    $script:calls++
    if ($Uri -notmatch "per_page=100&page=$($script:calls)$") { throw "Unexpected URI: $Uri" }
    # Invoke-RestMethod returns a JSON array as one pipeline value on PS 5.1.
    return ,$script:pages[$script:calls]
}
$asset = 'kraki-cli-windows-x64.exe'
$script:calls = 0
$script:pages = @{ 1 = @((New-Release 'mac-v99' 'Kraki.app.zip'), (New-Release 'v99-beta' $asset $true), (New-Release 'v0.33.1' $asset)) }
$r = Get-KrakiWindowsRelease 'test/repo' $asset
if ($r.tag_name -ne 'v0.33.1' -or $script:calls -ne 1) { throw 'Did not skip Mac/prerelease assets' }
Write-Output 'PASS: Mac-only and prerelease entries skipped'

$script:calls = 0
$script:pages = @{ 1 = @(1..100 | ForEach-Object { New-Release "mac-v$_" 'Kraki.app.zip' }); 2 = @((New-Release 'v0.33.0' $asset)) }
$r = Get-KrakiWindowsRelease 'test/repo' $asset
if ($r.tag_name -ne 'v0.33.0' -or $script:calls -ne 2) { throw 'Pagination failed' }
Write-Output 'PASS: paginates without relying on /latest'

$script:calls = 0
$script:pages = @{ 1 = @((New-Release 'mac-only' 'Kraki.app.zip')) }
$failed = $false
try { Get-KrakiWindowsRelease 'test/repo' $asset | Out-Null } catch { $failed = $_.Exception.Message -like 'No stable release contains*' }
if (-not $failed) { throw 'Missing assets must fail clearly' }
Write-Output 'PASS: missing asset fails clearly'
