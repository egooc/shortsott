@echo off
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOGDIR%\midform-fb-block.log"
node "%ROOT%\scripts\fb-block-check.js" --pages 110 >> "%LOGDIR%\midform-fb-block.log" 2>&1
