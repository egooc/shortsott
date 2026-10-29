@echo off
rem AI office collector: push this PC's read-only snapshot to office.grow-up.kr every 5 minutes.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage. Korean notes live in office\collector.js header.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-office-collect.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\office\collector.js" --push >> "%LOG%" 2>&1
