@echo off
setlocal
cd /d "%~dp0"

set CF=tools\cloudflared.exe
set PORT=8787

if not exist "%CF%" (
  echo cloudflared not found, downloading ^(~55 MB^) ...
  if not exist tools mkdir tools
  curl -L --fail -o "%CF%" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  if errorlevel 1 (
    echo [x] Download failed. Get it manually from:
    echo     https://github.com/cloudflare/cloudflared/releases
    echo     and put it at %CF%
    pause
    exit /b 1
  )
)

echo.
echo Opening a public tunnel to http://localhost:%PORT%
echo The public https URL is printed below - copy it into the admin page settings
echo so the phone notification links point at the right place.
echo.

"%CF%" tunnel --url http://localhost:%PORT% --no-autoupdate
pause
