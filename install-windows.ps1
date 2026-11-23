# Chrono desktop installer for Windows (per user, no administrator rights).
#
#   install-windows.bat                      build this checkout and install it
#   install-windows.bat --release [vX.Y.Z]   download a GitHub release (latest if no tag)
#   install-windows.bat --file <setup.exe>   install a Chrono-Setup-*.exe you already have
#   install-windows.bat --uninstall          remove Chrono (settings are kept)
#   install-windows.bat --dir D:\Apps\Chrono  install somewhere else (e.g. when C: is full)
#
# Installs to %LOCALAPPDATA%\Programs\Chrono with Start menu and desktop
# shortcuts, the chrono:// link handler and the Explorer "Chrono" right-click
# menu, exactly like running the setup by hand. Chrono must be closed first.
#
# Works with Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$Repo = 'xsession/chrono'
$source = 'build'   # build | release | file
$tag = ''
$file = ''
$uninstall = $false
$installDir = ''
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '--release' {
      $source = 'release'
      if ($i + 1 -lt $args.Count -and -not "$($args[$i + 1])".StartsWith('-')) { $i++; $tag = "$($args[$i])" }
    }
    '--file' {
      if ($i + 1 -ge $args.Count) { throw '--file needs a path to Chrono-Setup-*.exe' }
      $source = 'file'; $i++; $file = "$($args[$i])"
    }
    '--uninstall' { $uninstall = $true }
    '--dir' {
      if ($i + 1 -ge $args.Count) { throw '--dir needs a folder, e.g. --dir D:\Apps\Chrono' }
      $i++; $installDir = [IO.Path]::GetFullPath("$($args[$i])")
    }
    { $_ -in '-h', '--help' } {
      Get-Content -LiteralPath $PSCommandPath -TotalCount 13 | ForEach-Object { $_ -replace '^# ?', '' }
      exit 0
    }
    default { throw "unknown option: $($args[$i]) (see --help)" }
  }
}

function Step([string]$m) { Write-Host ''; Write-Host ("== " + $m + " ==") }
# PowerShell does not stop on a failing native command, so check every one.
function Invoke-Checked([string]$what, [scriptblock]$run) {
  & $run
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

# Installed copies of Chrono, from the per-user and per-machine uninstall lists.
function Get-ChronoInstalls {
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
      Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match '^Chrono( |$)' -and $_.PSObject.Properties['UninstallString'] }
  }
}

# Chrono, or anything started from an installed copy's folder (its server and
# terminals), keeps files open and makes the setup fail.
function Assert-NotRunning {
  $dirs = @(Get-ChronoInstalls | Where-Object { $_.PSObject.Properties['InstallLocation'] -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation.TrimEnd('\') + '\' })
  $running = @(foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
    $exePath = $null
    try { $exePath = $proc.Path } catch { }
    $fromInstall = $false
    if ($exePath) { foreach ($dir in $dirs) { if ($exePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) { $fromInstall = $true } } }
    if ($proc.ProcessName -eq 'Chrono' -or $fromInstall) { $proc }
  })
  if ($running.Count) {
    $list = ($running | ForEach-Object { "$($_.ProcessName) ($($_.Id))" } | Select-Object -Unique) -join ', '
    throw "Chrono is running: $list. Close it (also in the tray) and run the installer again."
  }
}

# Split an uninstall command line into the program and its arguments.
function Split-Command([string]$line) {
  if ($line -match '^\s*"([^"]+)"\s*(.*)$') { return @($Matches[1], $Matches[2]) }
  if ($line -match '^\s*(\S+)\s*(.*)$') { return @($Matches[1], $Matches[2]) }
  return @($line, '')
}

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }

if ($uninstall) {
  Step 'Removing Chrono'
  Assert-NotRunning
  $found = @(Get-ChronoInstalls)
  if ($found.Count -eq 0) { Write-Host 'Chrono is not installed.'; exit 0 }
  foreach ($entry in $found) {
    $line = $entry.UninstallString
    if ($entry.PSObject.Properties['QuietUninstallString'] -and $entry.QuietUninstallString) { $line = $entry.QuietUninstallString }
    $parts = Split-Command $line
    $argsLine = $parts[1]
    if ($argsLine -notmatch '(^|\s)/S(\s|$)') { $argsLine = ($argsLine + ' /S').Trim() }
    Write-Host "removing $($entry.DisplayName)"
    $proc = Start-Process -FilePath $parts[0] -ArgumentList $argsLine -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "uninstall of $($entry.DisplayName) failed (exit code $($proc.ExitCode))" }
  }
  Write-Host "Settings are kept in $env:APPDATA\Chrono."
  exit 0
}

# The setup needs about 350 MB in the target folder and fails with exit code
# 2 (no message when silent) if the drive is too full, so check up front.
$target = $installDir
if (-not $target) { $target = Join-Path $env:LOCALAPPDATA 'Programs\Chrono' }
$needMB = 400
$drive = [IO.Path]::GetPathRoot($target)
$freeMB = [math]::Floor((New-Object IO.DriveInfo $drive).AvailableFreeSpace / 1MB)
if ($freeMB -lt $needMB) {
  throw "not enough space on $drive for $target ($freeMB MB free, about $needMB MB needed). Free some space, or install elsewhere: install-windows.bat --dir D:\Apps\Chrono"
}

# --- 1. Get the setup program -----------------------------------------------
$setup = ''
$tempDir = $null
if ($source -eq 'file') {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "no such file: $file" }
  if ($file -notmatch '\.exe$') { throw 'expected a Chrono-Setup-*.exe file' }
  $setup = (Resolve-Path -LiteralPath $file).Path
}
elseif ($source -eq 'release') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $which = 'latest'; if ($tag) { $which = $tag }
  Step "Looking up the $which release of $Repo"
  if ($tag) { $api = "https://api.github.com/repos/$Repo/releases/tags/$tag" } else { $api = "https://api.github.com/repos/$Repo/releases/latest" }
  $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'chrono-installer'; 'Accept' = 'application/vnd.github+json' }
  $asset = $release.assets | Where-Object { $_.name -match "^Chrono-Setup-.+-$arch\.exe$" } | Select-Object -First 1
  if (-not $asset) { throw "no Windows $arch setup in the $which release (build from source instead: install-windows.bat)" }
  $tempDir = Join-Path ([IO.Path]::GetTempPath()) ("chrono-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  $setup = Join-Path $tempDir $asset.name
  Write-Host "downloading $($asset.name)"
  $oldProgress = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'  # the progress bar makes 5.1 very slow
  try { Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -UseBasicParsing } finally { $ProgressPreference = $oldProgress }
}
else {
  if (-not ((Test-Path 'package.json') -and (Test-Path 'electron'))) { throw 'run this from a Chrono checkout, or use --release / --file' }
  $nodeVersion = $null
  try { $nodeVersion = & node -p 'process.versions.node' 2>$null } catch { }
  if (-not $nodeVersion -or [int]($nodeVersion.Split('.')[0]) -lt 22) {
    throw 'Node.js 22+ is required to build (or use --release). starter-electron.bat can install it.'
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required (https://git-scm.com)' }
  $version = (& node -p 'require(''./package.json'').version').Trim()

  Step 'Installing npm dependencies'
  Invoke-Checked 'npm ci' { npm ci }
  Step "Building Chrono $version"
  Invoke-Checked 'npm run build' { npm run build }
  Step "Packaging (setup, $arch)"
  $setup = Join-Path $PSScriptRoot "release\Chrono-Setup-$version-$arch.exe"
  # Remove the previous setup of this version, so a failed packaging step
  # can never install a stale file.
  Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
  Invoke-Checked 'electron-builder' { npx electron-builder --win nsis "--$arch" --publish never }
  if (-not (Test-Path -LiteralPath $setup)) { throw "packaging finished but $setup is missing (see release\)" }
}

# --- 2. Install it ------------------------------------------------------------
try {
  Assert-NotRunning
  # The setup removes the installed version first. A per-machine copy (from
  # running a setup as administrator) cannot be removed by this per-user,
  # silent install, and the setup then gives up with exit code 2.
  $machine = @(Get-ChronoInstalls | Where-Object { $_.PSPath -like '*HKEY_LOCAL_MACHINE*' })
  if ($machine.Count) {
    $names = ($machine | ForEach-Object { "$($_.DisplayName) in $($_.InstallLocation)" }) -join '; '
    throw "Chrono is installed for all users ($names). Remove it first from Settings > Apps (needs administrator rights), then run this again."
  }
  Step "Installing $(Split-Path -Leaf $setup) to $target"
  # /S = silent, /currentuser = per-user install. /D= sets the folder; NSIS
  # wants it last and unquoted, even with spaces, so pass one argument string
  # (Start-Process would quote an array element that contains spaces).
  $setupArgs = '/S /currentuser'
  if ($installDir) { $setupArgs += " /D=$installDir" }
  $proc = Start-Process -FilePath $setup -ArgumentList $setupArgs -Wait -PassThru
  if ($proc.ExitCode -eq 2) {
    $found = (@(Get-ChronoInstalls) | ForEach-Object { "$($_.DisplayName) (uninstaller: $($_.UninstallString))" }) -join '; '
    if (-not $found) {
      throw "setup stopped (exit code 2) and, run silently, gives no reason. Run it normally to see the message: & '$setup' /currentuser"
    }
    throw "setup could not remove the installed Chrono (exit code 2). Installed: $found. Close every Chrono window (also in the tray) or uninstall it from Settings > Apps, then run this again."
  }
  if ($proc.ExitCode -ne 0) { throw "setup failed (exit code $($proc.ExitCode))" }
}
finally {
  if ($tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}

$installed = @(Get-ChronoInstalls) | Select-Object -First 1
$exe = Join-Path $target 'Chrono.exe'
if ($installed -and $installed.PSObject.Properties['InstallLocation'] -and $installed.InstallLocation) { $exe = Join-Path $installed.InstallLocation 'Chrono.exe' }
$shownVersion = '?'
if ($installed -and $installed.PSObject.Properties['DisplayVersion']) { $shownVersion = $installed.DisplayVersion }
Write-Host ''
Write-Host "Chrono $shownVersion installed: $exe"
Write-Host 'Start it from the Start menu or the desktop shortcut.'
