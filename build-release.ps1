[CmdletBinding()]
param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot 'dist' }
$taskManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskVersion = $taskManifest.version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw 'manifest 版本无效。' }
$taskNames = @('manifest.json', 'shared.js', 'content.js', 'background.js', 'popup.html', 'options.html', 'ui.js', 'ui.css', 'icons', 'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'LICENSE')
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskZip = Join-Path $taskOutput "native-auto-space-v$taskVersion.zip"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$taskStream = [System.IO.File]::Open($taskZip, [System.IO.FileMode]::Create)
$taskArchive = $null
try {
    $taskArchive = New-Object System.IO.Compression.ZipArchive($taskStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($taskName in $taskNames) {
        $taskItem = Get-Item -LiteralPath (Join-Path $PSScriptRoot $taskName)
        $taskEntries = if ($taskItem.PSIsContainer) { @(Get-ChildItem -LiteralPath $taskItem.FullName -File -Recurse | Sort-Object FullName) } else { @($taskItem) }
        foreach ($taskEntry in $taskEntries) {
            $taskEntryName = $taskEntry.FullName.Substring($taskRoot.Length).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskEntry.FullName, $taskEntryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
} finally {
    if ($null -ne $taskArchive) { $taskArchive.Dispose() }
    $taskStream.Dispose()
}
$taskShell = New-Object -ComObject Shell.Application
$taskFolder = $taskShell.Namespace('shell:Downloads')
if ($null -eq $taskFolder) { throw '无法取得 Windows 下载目录。' }
$taskDownloads = [Environment]::ExpandEnvironmentVariables($taskFolder.Self.Path)
$taskDownloadZip = Join-Path $taskDownloads ([System.IO.Path]::GetFileName($taskZip))
Copy-Item -LiteralPath $taskZip -Destination $taskDownloadZip -Force
$taskHasher = [System.Security.Cryptography.SHA256]::Create()
try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash([System.IO.File]::ReadAllBytes($taskZip))).Replace('-', '').ToLowerInvariant() }
finally { $taskHasher.Dispose() }
[pscustomobject]@{ version=$taskVersion; zip=$taskZip; downloadZip=$taskDownloadZip; sha256=$taskHash } | ConvertTo-Json
