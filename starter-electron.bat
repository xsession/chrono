@echo off
setlocal EnableExtensions
rem Chrono Electron desktop starter (Windows). Thin wrapper around starter-electron.ps1.
rem   starter-electron.bat              build + launch
rem   starter-electron.bat --check      install + build only
rem   starter-electron.bat --packager   build + create installers (release\)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0starter-electron.ps1" %*
exit /b %ERRORLEVEL%
