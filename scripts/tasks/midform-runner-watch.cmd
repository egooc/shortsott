@echo off
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOGDIR%\midform-runner-watch.log"
python "%ROOT%\scripts\volcano_runner_watch.py" >> "%LOGDIR%\midform-runner-watch.log" 2>&1
