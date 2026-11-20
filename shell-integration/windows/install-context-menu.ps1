<#
.SYNOPSIS
  Adds a TortoiseGit-style "Chrono" submenu to the Windows Explorer right-click
  menu (files, folders and folder background) for the current user.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-context-menu.ps1
  powershell -ExecutionPolicy Bypass -File install-context-menu.ps1 -ExePath "D:\Apps\Chrono\Chrono.exe"
  powershell -ExecutionPolicy Bypass -File install-context-menu.ps1 -Uninstall

.NOTES
  Writes only under HKCU\Software\Classes — no administrator rights needed.
  On Windows 11 the entries appear under "Show more options" (Shift+F10),
  like other classic shell extensions.
#>
param(
  [string]$ExePath = (Join-Path $env:LOCALAPPDATA "Programs\Chrono\Chrono.exe"),
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$roots = @(
  @{ Key = "HKCU:\Software\Classes\*\shell\Chrono"; Arg = "%1" },
  @{ Key = "HKCU:\Software\Classes\Directory\shell\Chrono"; Arg = "%1" },
  @{ Key = "HKCU:\Software\Classes\Directory\Background\shell\Chrono"; Arg = "%V" }
)

if ($Uninstall) {
  foreach ($root in $roots) { if (Test-Path -LiteralPath $root.Key) { Remove-Item -LiteralPath $root.Key -Recurse -Force } }
  Write-Host "Chrono Explorer menu removed."
  exit 0
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Warning "Chrono.exe was not found at $ExePath. Pass -ExePath with the installed location."
  exit 1
}

$actions = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\actions.tsv") -Encoding UTF8 |
  Where-Object { $_.Trim() } |
  ForEach-Object { $parts = $_ -split "`t"; [pscustomobject]@{ Action = $parts[0]; Label = $parts[1] } }

foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root.Key) { Remove-Item -LiteralPath $root.Key -Recurse -Force }
  New-Item -Path $root.Key -Force | Out-Null
  Set-ItemProperty -LiteralPath $root.Key -Name "MUIVerb" -Value "Chrono"
  Set-ItemProperty -LiteralPath $root.Key -Name "SubCommands" -Value ""
  Set-ItemProperty -LiteralPath $root.Key -Name "Icon" -Value "`"$ExePath`",0"
  $index = 0
  foreach ($item in $actions) {
    $index++
    $sub = Join-Path $root.Key ("shell\{0:D2}{1}" -f $index, $item.Action)
    New-Item -Path $sub -Force | Out-Null
    Set-ItemProperty -LiteralPath $sub -Name "MUIVerb" -Value $item.Label
    if ($item.Action -in @("commit", "explore", "sync")) { Set-ItemProperty -LiteralPath $sub -Name "CommandFlags" -Value 0x40 -Type DWord }  # separator after
    New-Item -Path (Join-Path $sub "command") -Force | Out-Null
    # One argv element per path; Chrono turns it into chrono://tgit?action=...
    Set-ItemProperty -LiteralPath (Join-Path $sub "command") -Name "(default)" -Value ("`"{0}`" --tgit={1} `"{2}`"" -f $ExePath, $item.Action, $root.Arg)
  }
}
Write-Host "Chrono menu installed for files, folders and folder backgrounds."
Write-Host "Windows 11: right-click → Show more options → Chrono."
