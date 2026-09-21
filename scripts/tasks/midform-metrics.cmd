@echo off
rem Daily performance pull. Reads what actually happened to the published videos.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-metrics.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\scripts\collect-metrics.js" >> "%LOG%" 2>&1
echo metrics exit %ERRORLEVEL% >> "%LOG%"
exit /b 0
