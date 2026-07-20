@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"

set "SERVER_PORT=3016"
set "UI_PORT=5177"

call :loadEnv

echo =====================================
echo Midform Stop
echo Server port: %SERVER_PORT%
echo UI port:     %UI_PORT%
echo =====================================
echo.

echo [INFO] Trying to stop processes by window title.
taskkill /FI "WINDOWTITLE eq midform-server*" /T /F >nul 2>nul
if errorlevel 1 (echo [INFO] midform-server window was not found.) else (echo [OK] midform-server window stopped.)

taskkill /FI "WINDOWTITLE eq midform-ui*" /T /F >nul 2>nul
if errorlevel 1 (echo [INFO] midform-ui window was not found.) else (echo [OK] midform-ui window stopped.)

echo.
echo [INFO] Checking port-owning PIDs.
call :killPort %SERVER_PORT%
call :killPort %UI_PORT%

echo.
echo [OK] Midform server/UI stop check complete.
pause
exit /b 0

:loadEnv
if exist "%cd%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%cd%\.env") do (
    if /i "%%A"=="PORT" set "SERVER_PORT=%%B"
    if /i "%%A"=="MIDFORM_UI_PORT" set "UI_PORT=%%B"
  )
)
exit /b 0

:killPort
set "TARGET_PORT=%~1"
set "FOUND_PID="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%TARGET_PORT% .*LISTENING"') do (
  set "FOUND_PID=1"
  echo [INFO] Stopping port %TARGET_PORT% PID %%P...
  taskkill /PID %%P /T /F >nul 2>nul
  if errorlevel 1 (echo [WARN] PID %%P stop failed or was already stopped.) else (echo [OK] PID %%P stopped.)
)
if not defined FOUND_PID echo [OK] Port %TARGET_PORT% is not in use.
exit /b 0
