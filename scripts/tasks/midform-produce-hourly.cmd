@echo off
rem One hourly production round. Runs a Claude session only when the guard allows it.
rem ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage, so UTF-8 Korean comments
rem get mangled into broken commands (measured 2026-09-18: the whole file failed to parse).
rem Korean explanation lives in scripts\produce-hourly-prompt.md and install-schedule.ps1.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-produce-hourly.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"

rem Guard: stock target, daily cap, and no overlapping run. Exit 10 means skip this hour.
node "%ROOT%\scripts\produce-guard.js" --claim >> "%LOG%" 2>&1
if errorlevel 10 (
  echo guard: skip this hour >> "%LOG%"
  exit /b 0
)

rem Feed the prompt over stdin: the only path where quotes and newlines survive intact.
type "%ROOT%\scripts\produce-hourly-prompt.md" | "C:\Users\urban\.local\bin\claude.exe" -p --permission-mode bypassPermissions >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

rem Always release the lock, success or not. Otherwise every later hour is skipped forever.
rem A failed session made nothing, so give its slot back: otherwise a day of failures (usage
rem limit, crash) fills the daily cap and skips every remaining hour. Measured 2026-09-21.
set REFUND=
if not "%RC%"=="0" set REFUND=--refund
node "%ROOT%\scripts\produce-guard.js" --release %REFUND% >> "%LOG%" 2>&1
echo produce exit %RC% >> "%LOG%"
exit /b %RC%
