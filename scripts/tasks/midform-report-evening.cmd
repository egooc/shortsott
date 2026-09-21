@echo off
rem Evening wrap-up at 22:00 KST. ASCII only: cmd.exe reads .cmd in the OEM codepage and
rem UTF-8 Korean comments break parsing (measured 2026-09-18).
rem
rem Two modes on purpose, because the slots are different ages at 22:00:
rem   health : today's 08/12/18 posts - did distribution start at all (18:00 is only T+4h)
rem   daily  : yesterday's slot - the first numbers that actually mean something (T+24h)
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-report-evening.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
"C:\Program Files\nodejs\node.exe" "%ROOT%\scripts\publish-report.js" --mode health >> "%LOG%" 2>&1
"C:\Program Files\nodejs\node.exe" "%ROOT%\scripts\publish-report.js" --mode daily >> "%LOG%" 2>&1
echo report-evening done >> "%LOG%"
