@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"

set "SERVER_PORT=3016"
set "UI_PORT=5177"
set "SERVER_URL=http://localhost:%SERVER_PORT%"
set "UI_URL=http://localhost:%UI_PORT%"

call :loadEnv
set "SERVER_URL=http://localhost:%SERVER_PORT%"
set "UI_URL=http://localhost:%UI_PORT%"

echo =====================================
echo Midform One-Click Start
echo Project: %cd%
echo Server:  %SERVER_URL%
echo UI:      %UI_URL%
echo =====================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node.js LTS, open a new terminal, then try again.
  goto :failPause
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH. Install Node.js LTS, open a new terminal, then try again.
  goto :failPause
)

call node -v
call npm -v
echo.

call :isListening %SERVER_PORT%
set "SERVER_ALREADY=%ERRORLEVEL%"
call :isListening %UI_PORT%
set "UI_ALREADY=%ERRORLEVEL%"

if "%SERVER_ALREADY%"=="0" if "%UI_ALREADY%"=="0" (
  echo [INFO] Already running. Opening browser only; no duplicate processes will be started.
  start "" "%UI_URL%"
  goto :done
)

if "%SERVER_ALREADY%"=="0" (
  echo [ERROR] Server port %SERVER_PORT% is already in use, but UI port %UI_PORT% is not responding.
  echo [ERROR] Run stop_midform.bat, then try again.
  goto :failPause
)

if "%UI_ALREADY%"=="0" (
  echo [ERROR] UI port %UI_PORT% is already in use, but server port %SERVER_PORT% is not responding.
  echo [ERROR] Run stop_midform.bat, then try again.
  goto :failPause
)

if not exist "%cd%\client_midform\node_modules" (
  echo [INFO] client_midform\node_modules is missing. Running npm install first.
  call npm --prefix "%cd%\client_midform" install
  if errorlevel 1 (
    echo [ERROR] client_midform npm install failed.
    goto :failPause
  )
  echo.
)

echo [INFO] Starting server in a new minimized window: %SERVER_URL%
start "midform-server" /D "%cd%" /min cmd /d /c "set PORT=%SERVER_PORT%&& node server/index.js"

call :waitHttp "%SERVER_URL%/api/health" 30
if errorlevel 1 (
  echo [ERROR] Server did not return HTTP 200 from /api/health within 30 seconds.
  echo [ERROR] Check the midform-server window. Trying to bring it to the foreground.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('midform-server') | Out-Null" >nul 2>nul
  goto :failPause
)

echo [INFO] Starting UI in a new minimized window: %UI_URL%
start "midform-ui" /D "%cd%" /min cmd /d /c "npm run dev:ui"

call :waitPort %UI_PORT% 30
if errorlevel 1 (
  echo [ERROR] UI port %UI_PORT% did not start listening within 30 seconds.
  echo [ERROR] Check the midform-ui window.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('midform-ui') | Out-Null" >nul 2>nul
  goto :failPause
)

echo [INFO] Opening browser: %UI_URL%
start "" "%UI_URL%"

:done
echo.
echo [OK] Midform is ready. This launcher window will close.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2" >nul 2>nul
exit /b 0

:failPause
echo.
echo [FAILED] Fix the issue above, then run this script again.
pause
exit /b 1

:loadEnv
if exist "%cd%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%cd%\.env") do (
    if /i "%%A"=="PORT" set "SERVER_PORT=%%B"
    if /i "%%A"=="MIDFORM_UI_PORT" set "UI_PORT=%%B"
  )
)
exit /b 0

:isListening
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c = Get-NetTCPConnection -LocalPort %~1 -State Listen -ErrorAction Stop; if ($c) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
exit /b %ERRORLEVEL%

:waitHttp
set "WAIT_URL=%~1"
set "WAIT_SECONDS=%~2"
for /l %%I in (1,1,%WAIT_SECONDS%) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%WAIT_URL%' -TimeoutSec 2; if ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 400) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 exit /b 0
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1" >nul 2>nul
)
exit /b 1

:waitPort
set "WAIT_PORT=%~1"
set "WAIT_SECONDS=%~2"
for /l %%I in (1,1,%WAIT_SECONDS%) do (
  call :isListening %WAIT_PORT%
  if not errorlevel 1 exit /b 0
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1" >nul 2>nul
)
exit /b 1
