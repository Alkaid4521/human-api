@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found. Install Node 20+ first: https://nodejs.org
  pause
  exit /b 1
)

echo Starting Human-as-API on http://127.0.0.1:8787 ...
echo Admin page: http://127.0.0.1:8787/admin
echo Press Ctrl+C to stop.
echo.

node server.mjs
pause
