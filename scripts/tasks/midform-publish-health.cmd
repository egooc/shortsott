@echo off
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOGDIR%\midform-publish-health.log"
node "%ROOT%\scripts\publish-health.js" --days 3 >> "%LOGDIR%\midform-publish-health.log" 2>&1
