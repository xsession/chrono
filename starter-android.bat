@echo off
setlocal EnableExtensions
rem Chrono Android companion starter (Windows). Thin wrapper around starter-android.ps1.
rem   starter-android.bat               install + build + APK
rem   starter-android.bat --check       install + build only
rem   starter-android.bat --open        open the project in Android Studio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0starter-android.ps1" %*
exit /b %ERRORLEVEL%
