@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] 没找到 Node.js。
  echo        请先安装 Node 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo 使用 Node %NODEVER%

if not exist config.json (
  if exist config.example.json (
    copy config.example.json config.json >nul
    echo [提示] 已根据 config.example.json 生成 config.json
    echo        如果你的 Harness 不在默认路径，请先改里面的 profileDir / pluginDir
    echo.
  )
)

echo 正在启动配置台，浏览器会自动打开（关掉这个窗口即停止服务）...
echo.
node src/server.mjs --open

echo.
echo 服务已退出。
pause
