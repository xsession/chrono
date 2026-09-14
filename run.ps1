# Chrono Next launcher (Windows).
# Installs Node.js 22+ if missing, then npm dependencies, builds and starts the app.
# Invoked by run.bat; can also be run directly:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 --check
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$check = ($args -contains '--check')

function Step([string]$m) { Write-Host ''; Write-Host ("== " + $m + " ==") }

# Refresh PATH so a freshly-installed Node.js is visible without reopening the shell.
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
    if (-not $nodeVer) { throw 'Node.js was installed but is not on PATH yet. Reopen the terminal and run run.bat again.' }
    Write-Host ('Installed Node.js ' + $nodeVer)
  } else {
    throw 'Could not install Node.js automatically (no winget/choco/scoop found). Install Node.js 22+ from https://nodejs.org and run run.bat again.'
  }
} else {
  Write-Host ('Node.js ' + $nodeVer)
}

try { $gitVer = & git --version 2>$null } catch { $gitVer = $null }
if (-not $gitVer) { throw 'git was not found on PATH. Install Git for Windows (https://git-scm.com) and run run.bat again.' }
Write-Host $gitVer

Step 'Installing npm dependencies'
npm install

Step 'Building frontend'
npm run build

if ($check) {
  Write-Host ''
  Write-Host 'Check complete - run run.bat (without --check) to start the app.'
  exit 0
}

$port = if ($env:CHRONO_PORT) { $env:CHRONO_PORT } else { '1421' }
Step 'Starting Chrono Next'
Write-Host ''
Write-Host ('Open http://localhost:' + $port)
npm start
exit $LASTEXITCODE
