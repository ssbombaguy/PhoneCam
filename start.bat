@echo off
rem PhoneCam server.
rem   start.bat               start (or, if already running, just open the page)
rem   start.bat --background  start without opening the browser (used at Windows login)
title PhoneCam
cd /d "%~dp0server"

rem Already running? Then just show the page.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8080/status | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  if /i not "%~1"=="--background" start "" http://localhost:8080/
  exit /b 0
)

if not exist node_modules (
  echo Installing server dependencies...
  call npm install --omit=dev || goto :error
)
if /i not "%~1"=="--background" start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8080/"
node server.js
goto :eof

:error
echo.
echo Could not install dependencies. Is Node.js installed? https://nodejs.org
pause
