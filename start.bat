@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Optional: --no-open   start without opening the browser
set "OPENFLAG=--open"
if /i "%~1"=="--no-open" set "OPENFLAG="

where node >nul 2>&1
if errorlevel 1 goto :no_node

rem ----------------------------------------------------------------
rem If the service is already running, reuse it instead of crashing.
rem ----------------------------------------------------------------
curl.exe -s -m 2 http://127.0.0.1:8787/healthz >nul 2>&1
if errorlevel 1 goto :start

set "TOK="
if exist ".token" for /f "usebackq delims=" %%t in (".token") do set "TOK=%%t"
echo [INFO] bot-console is already running.
if defined TOK echo        URL: http://127.0.0.1:8787/?token=%TOK%
if defined OPENFLAG if defined TOK start "" "http://127.0.0.1:8787/?token=%TOK%"
echo        To stop it: use the button in the page, or run stop-gui.vbs
ping -n 4 127.0.0.1 >nul
exit /b 0

:start
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
exit /b 0

:no_node
echo.
echo [ERROR] Node.js not found. Install Node 20+ first: https://nodejs.org/
echo.
pause
exit /b 1
