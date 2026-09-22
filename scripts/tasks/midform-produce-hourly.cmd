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
rem The release step decides by itself whether to refund the daily slot: it compares the
rem draft count now against the count at claim time. Exit code is NOT the test - a session
rem that correctly gives up (no TTS credit, no usable source) exits 0 and still made nothing.
rem Measured 2026-09-22: five clean 0-output rounds filled the 6/day cap by 17:45.
node "%ROOT%\scripts\produce-guard.js" --release >> "%LOG%" 2>&1
echo produce exit %RC% >> "%LOG%"
exit /b %RC%
