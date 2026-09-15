# Chrono Android companion starter (Windows).
#
# Checks/installs prerequisites (Node 22+, JDK 17+, Android SDK) and builds
# the debug APK with ./gradlew assembleDebug.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File starter-android.ps1            # build + APK
#   powershell -NoProfile -ExecutionPolicy Bypass -File starter-android.ps1 --check    # install + build only
#   powershell -NoProfile -ExecutionPolicy Bypass -File starter-android.ps1 --open     # open in Android Studio
#
# The Android app is a companion client: after installing the APK, enter the
# HTTPS address of your Chrono server (Backend button in the app).
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$mode = 'apk'
foreach ($arg in $args) {
  if ($arg -eq '--check') { $mode = 'check' }
  if ($arg -eq '--open') { $mode = 'open' }
}

function Step([string]$m) { Write-Host ''; Write-Host ("== " + $m + " ==") }

$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

function Test-NodeOk {
  try {
    $v = & node -p 'process.versions.node' 2>$null
    if ($v -and [int]($v.Split('.')[0]) -ge 22) { return $v }
  } catch { }
  return $null
}

# --- Node.js 22+ ---
Step 'Checking Node.js'
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
    if (-not $nodeVer) { throw 'Node.js was installed but is not on PATH yet. Reopen the terminal and run starter-android.ps1 again.' }
    Write-Host ('Installed Node.js ' + $nodeVer)
  } else {
    throw 'Could not install Node.js automatically (no winget/choco/scoop found). Install Node.js 22+ from https://nodejs.org and run starter-android.ps1 again.'
  }
} else {
  Write-Host ('Node.js ' + $nodeVer)
}

# --- JDK 17+ (Capacitor 7 / Gradle need a modern JDK; the build will not work on JDK 8) ---
Step 'Checking Java (JDK 17+)'
function Test-JavaOk {
  try {
    $out = & java -version 2>&1 | Select-Object -First 1
    if ($out -match '"(\d+)[^"]*"' -and [int]$Matches[1] -ge 17) { return ($Matches[0] + ' ' + $Matches[1]) }
    if ($out -match 'version "(\d+|17|21)' -and [int]$Matches[1] -ge 17) { return $Matches[0] }
  } catch { }
  return $null
}
if (-not (Test-JavaOk)) {
  Write-Host 'JDK 17+ not found - installing Temurin 17 (winget)...'
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { winget install -e --id EclipseAdoptium.Temurin.17.JDK --silent --accept-source-agreements --accept-package-agreements 2>$null; $installed = $true } catch { }
  }
  if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) { choco install temurin17jdk -y; $installed = $true }
  if ($installed) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $j = Test-JavaOk
    if (-not $j) { throw 'JDK was installed but java is not on PATH yet. Reopen the terminal and run starter-android.ps1 again.' }
    Write-Host ('Installed JDK ' + $j)
  } else {
    throw 'Could not install a JDK automatically. Install JDK 17+ (https://adoptium.net) and run starter-android.ps1 again.'
  }
} else {
  Write-Host ('Java ' + (Test-JavaOk))
}

# --- Android SDK ---
Step 'Checking Android SDK'
$sdk = $null
if ($env:ANDROID_HOME) { $sdk = $env:ANDROID_HOME }
elseif ($env:ANDROID_SDK_ROOT) { $sdk = $env:ANDROID_SDK_ROOT }
elseif (Test-Path "$env:LOCALAPPDATA\Android\Sdk") { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }

function Test-SdkOk([string]$dir) {
  if ($dir -and (Test-Path (Join-Path $dir 'platform-tools\adb.exe'))) { return $true }
  return $false
}

if (-not (Test-SdkOk $sdk)) {
  Write-Host 'Android SDK not found - installing cmdline-tools via winget (commandlinetools) or sdkmanager bootstrap...'
  $defaultDir = "$env:LOCALAPPDATA\Android\Sdk"
  $toolsDir = Join-Path $defaultDir 'cmdline-tools'
  $zip = "$env:TEMP\android-cmdline-tools.zip"
  $base = 'https://dl.google.com/android/repository/commandlinetools-windows-11076708_latest.zip'
  try {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      # winget has no official Android SDK package; fall back to the zip bootstrap.
      $null = $true
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Downloading $base"
    Invoke-WebRequest -Uri $base -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath (Join-Path $defaultDir 'cmdline-tools-extract') -Force
    $extracted = Get-ChildItem (Join-Path $defaultDir 'cmdline-tools-extract') -Directory | Select-Object -First 1
    if (Test-Path (Join-Path $toolsDir 'latest')) { Remove-Item -Recurse -Force (Join-Path $toolsDir 'latest') }
    Move-Item -Path $extracted.FullName -Destination (Join-Path $toolsDir 'latest')
    Remove-Item -Recurse -Force (Join-Path $defaultDir 'cmdline-tools-extract'), $zip
    $sdkmanager = Join-Path $toolsDir 'latest\bin\sdkmanager.bat'
    $env:ANDROID_HOME = $defaultDir
    [Environment]::SetEnvironmentVariable('ANDROID_HOME', $defaultDir, 'User')
    Write-Host 'Accepting SDK licenses and installing platform + build-tools (this can take a while)...'
    & $sdkmanager --sdk_root=$defaultDir --install "platform-tools" "platforms;android-34" "build-tools;34.0.0" | Out-Null
  } catch {
    throw ("Could not bootstrap the Android SDK automatically (" + $_.Exception.Message + "). " + "Install Android Studio (https://developer.android.com/studio) or the SDK command-line tools, set ANDROID_HOME, and run starter-android.ps1 again.")
  }
} else {
  Write-Host ('Android SDK: ' + $sdk)
}
$env:ANDROID_HOME = $sdk

# --- npm + build ---
Step 'Installing npm dependencies'
npm install

Step 'Building frontend + syncing Capacitor'
npm run android:sync

if ($mode -eq 'check') {
  Write-Host ''
  Write-Host 'Check complete - run starter-android.ps1 (without --check) to build the APK.'
  exit 0
}

if ($mode -eq 'open') {
  if (Get-Command 'android-studio' -ErrorAction SilentlyContinue) { android-studio . }
  else { & (Join-Path $PSScriptRoot 'android\gradlew.bat') --stop; npx cap open android }
  exit $LASTEXITCODE
}

Step 'Building debug APK'
Push-Location (Join-Path $PSScriptRoot 'android')
try {
  & .\gradlew.bat assembleDebug --console=plain
  if ($LASTEXITCODE -ne 0) { throw 'gradlew assembleDebug failed' }
} finally {
  Pop-Location
}
$apk = Join-Path $PSScriptRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  Write-Host ''
  Write-Host ('APK ready: ' + $apk)
  Write-Host 'Install it with: adb install ' + $apk
} else {
  Write-Host 'Build finished but app-debug.apk was not found - check gradle output above.'
}
exit $LASTEXITCODE
