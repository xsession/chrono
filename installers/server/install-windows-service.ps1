<#
.SYNOPSIS
  Run the Chrono server at logon as a per-user Scheduled Task (no admin needed).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-windows-service.ps1
  powershell -ExecutionPolicy Bypass -File install-windows-service.ps1 -Port 1500
  powershell -ExecutionPolicy Bypass -File install-windows-service.ps1 -Uninstall
#>
param([int]$Port = 1421, [switch]$Uninstall)
$ErrorActionPreference = "Stop"
$taskName = "Chrono Server"
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Chrono server task removed."
  exit 0
}
$appDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$major = [int](& $node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { throw "Node.js 22+ is required" }
if (-not (Test-Path (Join-Path $appDir "dist\index.html"))) { throw "$appDir\dist is missing - run 'npm run build' first" }
# Install the runtime dependencies when any is missing (not just ws: an update
# can add one, e.g. the AI SDK, to a folder that already has node_modules).
$pkg = Get-Content -LiteralPath (Join-Path $appDir "package.json") -Raw | ConvertFrom-Json
$missing = @($pkg.dependencies.PSObject.Properties.Name | Where-Object { -not (Test-Path -LiteralPath (Join-Path $appDir "node_modules\$_\package.json")) })
if ($missing.Count) {
  Write-Host "Installing runtime dependencies ($($missing -join ', ') missing)..."
  Push-Location $appDir
  try { npm ci --omit=dev; if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)" } } finally { Pop-Location }
}
$action = New-ScheduledTaskAction -Execute $node -Argument "--experimental-strip-types `"$appDir\server\index.ts`"" -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
$env:CHRONO_PORT = "$Port"
[Environment]::SetEnvironmentVariable("CHRONO_PORT", "$Port", "User")
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Chrono Git client server" -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Chrono server started: http://127.0.0.1:$Port (runs at every logon)"
