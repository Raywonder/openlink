param(
    [string]$OutputDir = "$env:USERPROFILE\\Downloads"
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronDir = Split-Path -Parent $scriptDir
$repoRoot = Split-Path -Parent $electronDir
$packageJsonPath = Join-Path $electronDir 'package.json'
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$version = $packageJson.version
$distDir = Join-Path $repoRoot 'dist\\openlink'
$sourceDir = Join-Path $distDir 'win-unpacked'
$innoScript = Join-Path $electronDir 'installer\\OpenLink.iss'
$iscc = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe'

if (-not (Test-Path $iscc)) {
    throw "Inno Setup compiler not found at $iscc"
}

Push-Location $electronDir
try {
    npm run build:win:dir

    if (-not (Test-Path $sourceDir)) {
        throw "Expected Windows unpacked build at $sourceDir"
    }

    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

    & $iscc "/DMyAppVersion=$version" "/DSourceDir=$sourceDir" "/DOutputDir=$OutputDir" $innoScript
    if ($LASTEXITCODE -ne 0) {
        throw "ISCC.exe exited with code $LASTEXITCODE"
    }

    Write-Host "OpenLink Inno Setup build complete."
    Write-Host "Installer output: $OutputDir\\OpenLink Setup $version.exe"
} finally {
    Pop-Location
}
