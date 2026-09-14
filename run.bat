@echo off
setlocal EnableExtensions
rem Chrono Next launcher (Windows). Thin wrapper around run.ps1.
rem   run.bat            build + start, open http://localhost:1421
rem   run.bat --check    install + build only, do not start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
exit /b %ERRORLEVEL%
