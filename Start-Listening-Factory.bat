@echo off
setlocal
cd /d "%~dp0"
title MT EPS Listening Factory Launcher

echo [CHECK] Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js LTS and run this file again.
  pause
  exit /b 1
)

echo [CHECK] Closing an older Listening Factory process on port 8790 if present...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8790" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul

if not exist node_modules (
  echo [FIRST RUN] Installing app dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo [TOOLS] Checking local media tools...
where ffmpeg >nul 2>nul
if errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Setup-Tools.ps1"

echo [BUILD] Building Listening Factory v1.1.0...
call npm run build
if errorlevel 1 goto :fail

echo [START] Starting local server...
start "MT EPS Listening Factory Server" cmd /k "cd /d ""%~dp0"" && npm start"

echo [WAIT] Waiting for http://127.0.0.1:8790 ...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 90;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8790/api/health; if($r.StatusCode -eq 200){$ok=$true;break} } catch{}; Start-Sleep -Seconds 1 }; if(-not $ok){exit 1}"
if errorlevel 1 (
  echo [ERROR] Server did not become ready. Check the 'MT EPS Listening Factory Server' window for the exact error.
  pause
  exit /b 1
)

echo [OPEN] Listening Factory ready.
start "" "http://127.0.0.1:8790/?v=1.1.0"
exit /b 0

:fail
echo [ERROR] Setup/build failed. Keep this window open and send the visible error if you need help.
pause
exit /b 1
