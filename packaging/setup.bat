@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 20+ first: https://nodejs.org/
  pause
  exit /b 1
)
node install.mjs --mode onebot
pause
