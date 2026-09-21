@echo off
rem One arabshot production round. Runs a Claude session only when the guard allows it.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
rem Korean recipe lives in scripts\produce-arabshot-prompt.md
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-arabshot-hourly.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"

node "%ROOT%\scripts\arabshot-guard.js" --target 14 --daily-cap 6 --claim >> "%LOG%" 2>&1
if errorlevel 10 (
  echo guard: skip this hour >> "%LOG%"
  exit /b 0
)

type "%ROOT%\scripts\produce-arabshot-prompt.md" | "C:\Users\urban\.local\bin\claude.exe" -p --permission-mode bypassPermissions >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

rem Always release the lock. Otherwise every later hour is skipped forever.
node "%ROOT%\scripts\arabshot-guard.js" --release >> "%LOG%" 2>&1
echo arabshot exit %RC% >> "%LOG%"
exit /b %RC%
