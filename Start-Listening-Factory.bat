@echo off
setlocal
cd /d "%~dp0"
title MT EPS Listening Factory Launcher

echo [CHECK] Node.js 20.19 or newer...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install the current Node.js LTS release and run this file again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo [ERROR] This app needs Node.js 20.19 or newer. Update Node.js LTS and retry.
  pause
  exit /b 1
)

echo [CHECK] Looking for an already-running Listening Factory...
powershell -NoProfile -Command "try{$r=Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:8790/api/health;if($r.app -eq 'MT EPS TOPIK Listening Factory'){exit 0}}catch{};exit 1"
if not errorlevel 1 (
  echo [OPEN] Listening Factory is already running.
  start "" "http://127.0.0.1:8790/?v=1.2.0"
  exit /b 0
)

echo [DEPENDENCIES] Checking npm dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

echo [TOOLS] Checking/installing local media tools...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Setup-Tools.ps1"
if errorlevel 1 goto :fail

echo [BUILD] Building Listening Factory v1.2.0...
call npm run build
if errorlevel 1 goto :fail

echo [START] Starting local server...
start "MT EPS Listening Factory Server" cmd /k "cd /d ""%~dp0"" && npm start"

echo [WAIT] Waiting for http://127.0.0.1:8790/api/health ...
powershell -NoProfile -Command "$ok=$false;for($i=0;$i -lt 90;$i++){try{$r=Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:8790/api/health;if($r.ok -and $r.app -eq 'MT EPS TOPIK Listening Factory'){$ok=$true;break}}catch{};Start-Sleep -Seconds 1};if(-not $ok){exit 1}"
if errorlevel 1 (
  echo [ERROR] Server did not become ready. Check the MT EPS Listening Factory Server window for the exact error.
  pause
  exit /b 1
)

echo [OPEN] Listening Factory ready.
start "" "http://127.0.0.1:8790/?v=1.2.0"
exit /b 0

:fail
echo [ERROR] Setup or build failed. The exact failure is shown above.
pause
exit /b 1
