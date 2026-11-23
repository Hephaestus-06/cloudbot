@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "SNOW=%~dp0protocol\snowluma\app"
if exist "%SNOW%\node.exe" (
  echo Starting protocol client (SnowLuma) in background...
  start "SnowLuma" /min "%SNOW%\node.exe" "%SNOW%\index.mjs"
  ping -n 8 127.0.0.1 >nul
) else (
  echo [WARN] No bundled protocol client. Make sure an OneBot 11 endpoint listens on 127.0.0.1:3001.
)
echo Starting the bot (DSH profile "cloudbot")...
dsh cloudbot
pause
