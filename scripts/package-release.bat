@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-release.ps1"
if errorlevel 1 (
  echo.
  echo Packaging failed.
  pause
  exit /b %errorlevel%
)

echo.
echo Packaging completed.
pause
