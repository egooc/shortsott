@echo off
setlocal

cd /d "%~dp0"

echo =====================================
echo Content Pipeline Start
echo Project: %cd%
echo =====================================
echo.

echo Node version:
node -v
if errorlevel 1 (
  echo [ERROR] Node.js is not available in PATH.
  goto :end
)

echo NPM version:
call npm -v
if errorlevel 1 (
  echo [ERROR] npm is not available in PATH.
  goto :end
)

echo.
echo Cleaning ports via npm script...
call npm run clean:ports
if errorlevel 1 (
  echo [WARN] clean:ports failed. Continuing anyway...
)

echo.
echo Opening browser: http://localhost:5173
start "" "http://localhost:5173"

echo.
echo Starting backend + frontend...
call npm run dev

echo.
:end
echo Process exited.
pause
endlocal

