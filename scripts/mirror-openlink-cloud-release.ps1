param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$CloudReleaseRoot = "$env:USERPROFILE\OpenCloud\O8Link OpenLink\releases\openlink-releases",
    [string]$Version,
    [string]$WindowsInstaller,
    [string]$WindowsPortable,
    [string]$MacOSZip,
    [string]$ShareRoot = 'https://cloud.raywonderis.me/s/openlink-releases',
    [string]$ReleaseNotes = "OpenLink update published through the OpenCloud release mirror.",
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-OptionalPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        $expanded = Join-Path $RepoRoot $expanded
    }

    if (Test-Path -LiteralPath $expanded -PathType Leaf) {
        return (Resolve-Path -LiteralPath $expanded).Path
    }

    return $null
}

function Get-FileSha256 {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-ReleaseFile {
    param(
        [string]$Source,
        [string]$DestinationDirectory,
        [string]$DestinationName
    )

    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    $destination = Join-Path $DestinationDirectory $DestinationName
    Copy-Item -LiteralPath $Source -Destination $destination -Force
    $sha = Get-FileSha256 $destination
    Set-Content -LiteralPath "$destination.sha256" -Value "$sha  $DestinationName" -Encoding ascii

    [pscustomobject]@{
        Path = $destination
        UrlPath = ($DestinationDirectory.Substring($CloudReleaseRoot.Length).TrimStart('\') -replace '\\','/')
        FileName = $DestinationName
        Sha256 = $sha
        Length = (Get-Item -LiteralPath $destination).Length
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $csproj = Join-Path $RepoRoot 'apps\windows\OpenLink.Windows\OpenLink.Windows.csproj'
    if (Test-Path -LiteralPath $csproj) {
        $projectXml = [xml](Get-Content -LiteralPath $csproj -Raw)
        $Version = [string]$projectXml.Project.PropertyGroup.Version
    }
}
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version was not provided and could not be read from the Windows project.'
}

$defaultWindowsInstaller = Join-Path $RepoRoot 'dist\openlink\OpenLink-Inno-Setup.exe'
$defaultWindowsPortable = Join-Path $RepoRoot 'dist\openlink\OpenLink-Windows-x64.zip'
$defaultMacOSZip = Join-Path $RepoRoot 'dist\openlink\OpenLink-macOS.zip'

$windowsInstallerPath = Resolve-OptionalPath ($(if ($WindowsInstaller) { $WindowsInstaller } else { $defaultWindowsInstaller }))
$windowsPortablePath = Resolve-OptionalPath ($(if ($WindowsPortable) { $WindowsPortable } else { $defaultWindowsPortable }))
$macOSZipPath = Resolve-OptionalPath ($(if ($MacOSZip) { $MacOSZip } else { $defaultMacOSZip }))

if (-not $windowsInstallerPath -and -not $windowsPortablePath -and -not $macOSZipPath) {
    throw "No release artifacts were found. Checked defaults under $RepoRoot\dist\openlink."
}

if ($Clean -and (Test-Path -LiteralPath $CloudReleaseRoot)) {
    $resolvedCloudRoot = (Resolve-Path -LiteralPath $CloudReleaseRoot).Path
    if (-not $resolvedCloudRoot.StartsWith((Join-Path $env:USERPROFILE 'OpenCloud'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a non-OpenCloud path: $resolvedCloudRoot"
    }
    Remove-Item -LiteralPath $resolvedCloudRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $CloudReleaseRoot | Out-Null
$windowsDir = Join-Path $CloudReleaseRoot 'windows'
$macOSDir = Join-Path $CloudReleaseRoot 'macos'
$mirrored = @()

if ($windowsInstallerPath) {
    $mirrored += Copy-ReleaseFile -Source $windowsInstallerPath -DestinationDirectory $windowsDir -DestinationName 'OpenLink-Inno-Setup.exe'
}
if ($windowsPortablePath) {
    $mirrored += Copy-ReleaseFile -Source $windowsPortablePath -DestinationDirectory $windowsDir -DestinationName 'OpenLink-Windows-x64.zip'
}
if ($macOSZipPath) {
    $mirrored += Copy-ReleaseFile -Source $macOSZipPath -DestinationDirectory $macOSDir -DestinationName 'OpenLink-macOS.zip'
}

$shareRoot = $ShareRoot.TrimEnd('/')
$platforms = [ordered]@{}
$windowsInstallerMirror = $mirrored | Where-Object { $_.FileName -eq 'OpenLink-Inno-Setup.exe' } | Select-Object -First 1
$windowsPortableMirror = $mirrored | Where-Object { $_.FileName -eq 'OpenLink-Windows-x64.zip' } | Select-Object -First 1
$macOSMirror = $mirrored | Where-Object { $_.FileName -eq 'OpenLink-macOS.zip' } | Select-Object -First 1

if ($windowsInstallerMirror) {
    $platforms['windows-x64'] = [ordered]@{
        installer_url = "$shareRoot/download?path=%2Fwindows&files=OpenLink-Inno-Setup.exe"
        url = $(if ($windowsPortableMirror) { "$shareRoot/download?path=%2Fwindows&files=OpenLink-Windows-x64.zip" } else { "$shareRoot/download?path=%2Fwindows&files=OpenLink-Inno-Setup.exe" })
        sha256 = $windowsInstallerMirror.Sha256
    }
}
elseif ($windowsPortableMirror) {
    $platforms['windows-x64'] = [ordered]@{
        url = "$shareRoot/download?path=%2Fwindows&files=OpenLink-Windows-x64.zip"
        sha256 = $windowsPortableMirror.Sha256
    }
}

if ($macOSMirror) {
    $platforms['macos-x64'] = [ordered]@{
        installer_url = "$shareRoot/download?path=%2Fmacos&files=OpenLink-macOS.zip"
        url = "$shareRoot/download?path=%2Fmacos&files=OpenLink-macOS.zip"
        sha256 = $macOSMirror.Sha256
    }
}
else {
    Write-Warning "No macOS artifact was mirrored. The manifest will not advertise a macOS update until OpenLink-macOS.zip is supplied."
}

$manifest = [ordered]@{
    version = $Version
    notes = $ReleaseNotes
    release_notes = $ReleaseNotes
    published_at = (Get-Date).ToUniversalTime().ToString('o')
    platforms = $platforms
}

$manifestPath = Join-Path $CloudReleaseRoot 'update.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Set-Content -LiteralPath "$manifestPath.sha256" -Value "$(Get-FileSha256 $manifestPath)  update.json" -Encoding ascii

$index = @(
    'OpenLink cloud release mirror',
    "Version: $Version",
    "Updated: $((Get-Date).ToUniversalTime().ToString('u'))",
    '',
    'Public share URL:',
    $shareRoot,
    '',
    'Updater manifest:',
    "$shareRoot/download?path=%2F&files=update.json",
    '',
    'Mirrored files:'
)
foreach ($file in $mirrored) {
    $relativePath = if ($file.UrlPath) { "$($file.UrlPath)/$($file.FileName)" } else { $file.FileName }
    $index += "- $relativePath ($($file.Length) bytes, sha256 $($file.Sha256))"
}
Set-Content -LiteralPath (Join-Path $CloudReleaseRoot 'README.txt') -Value $index -Encoding utf8

$mirrored | Format-Table FileName, Length, Sha256, Path -AutoSize
Write-Host "Manifest: $manifestPath"
