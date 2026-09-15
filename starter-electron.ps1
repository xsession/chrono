# Chrono Electron desktop starter (Windows).
#
# Checks/installs prerequisites, then builds and launches the Electron
# desktop app. The Electron main process spawns the Chrono backend itself
# (random port in 14210-14310), so nothing else needs to be running.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File starter-electron.ps1            # build + launch
#   powershell -NoProfile -ExecutionPolicy Bypass -File starter-electron.ps1 --check    # build only, do not launch
#   powershell -NoProfile -ExecutionPolicy Bypass -File starter-electron.ps1 --packager # build + create installers (release\)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$mode = 'run'
foreach ($arg in $args) {
  if ($arg -eq '--check') { $mode = 'check' }
  if ($arg -eq '--packager') { $mode = 'packager' }
}

function Step([string]$m) { Write-Host ''; Write-Host ("== " + $m + " ==") }

# Refresh PATH so freshly installed toolchains are visible without reopening the shell.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

function Test-NodeOk {
  try {
    $v = & node -p 'process.versions.node' 2>$null
    if ($v -and [int]($v.Split('.')[0]) -ge 22) { return $v }
  } catch { }
  return $null
}

Step 'Checking prerequisites'
$nodeVer = Test-NodeOk
if (-not $nodeVer) {
  Write-Host 'Node.js 22+ not found - installing...'
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { winget install -e --id OpenJS.NodeJS.22 --silent --accept-source-agreements --accept-package-agreements 2>$null; $installed = $true } catch { }
    if (-not $installed) { try { winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null; $installed = $true } catch { } }
  }
  if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) { choco install nodejs -y; $installed = $true }
  if (-not $installed -and (Get-Command scoop -ErrorAction SilentlyContinue)) { scoop install nodejs; $installed = $true }
  if ($installed) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $nodeVer = Test-NodeOk
    if (-not $nodeVer) { throw 'Node.js was installed but is not on PATH yet. Reopen the terminal and run starter-electron.ps1 again.' }
    Write-Host ('Installed Node.js ' + $nodeVer)
  } else {
    throw 'Could not install Node.js automatically (no winget/choco/scoop found). Install Node.js 22+ from https://nodejs.org and run starter-electron.ps1 again.'
  }
} else {
  Write-Host ('Node.js ' + $nodeVer)
}

try { $gitVer = & git --version 2>$null } catch { $gitVer = $null }
if (-not $gitVer) { throw 'git was not found on PATH. Install Git for Windows (https://git-scm.com) and run starter-electron.ps1 again.' }
Write-Host $gitVer

Step 'Installing npm dependencies (includes Electron)'
npm install

Step 'Building frontend'
npm run build

if ($mode -eq 'check') {
  Write-Host ''
  Write-Host 'Check complete - run starter-electron.ps1 (without --check) to launch the desktop app.'
  exit 0
}

if ($mode -eq 'packager') {
  Step 'Creating installers'
  Write-Host 'Installers are written to release\ after the build.'
  npm run desktop:build
  exit $LASTEXITCODE
}

Step 'Launching Chrono desktop (Electron)'
Write-Host ''
Write-Host 'The backend starts inside the app on a port in 14210-14310.'
npm run desktop:dev
exit $LASTEXITCODE
