@echo off
setlocal EnableExtensions
rem Chrono desktop installer (Windows). Thin wrapper around install-windows.ps1.
rem   install-windows.bat                      build this checkout and install it
rem   install-windows.bat --release [vX.Y.Z]   download a GitHub release instead
rem   install-windows.bat --file setup.exe       install a setup you already have
rem   install-windows.bat --uninstall          remove Chrono
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
exit /b %ERRORLEVEL%
