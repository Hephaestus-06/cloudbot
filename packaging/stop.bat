@echo off
setlocal
chcp 65001 >nul
echo Stopping bot processes (DSH + protocol client)...
taskkill /f /im node.exe >nul 2>&1
echo Done. QQ client itself is left running.
pause
