@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Optional: --no-open   start without opening the browser
set "OPENFLAG=--open"
if /i "%~1"=="--no-open" set "OPENFLAG="

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Install Node 20+ first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo Using Node %NODEVER%

if not exist config.json (
  if exist config.example.json (
    copy config.example.json config.json >nul
    echo [INFO] Created config.json from config.example.json
    echo        Edit profileDir / pluginDir inside it if Harness lives elsewhere.
    echo.
  )
)

echo Starting bot-console... close this window to stop the service.
echo.
node src/server.mjs %OPENFLAG%

echo.
echo Service stopped.
pause
