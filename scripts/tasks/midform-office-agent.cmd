@echo off
rem AI office device agent: keeps this PC connected to office.grow-up.kr (sessions, screen read, send, open, close).
rem ASCII only: cmd.exe reads .cmd in the OEM codepage. Korean notes live in office\agent.js header.
rem Long-running. The task re-fires every 5 minutes with IgnoreNew, so a dead agent comes back.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-office-agent.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% start >> "%LOG%"
node "%ROOT%\office\agent.js" >> "%LOG%" 2>&1
