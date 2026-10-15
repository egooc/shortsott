@echo off
rem Every 5 minutes: append one JSON line of CPU/RAM/GPU/disk load and top processes.
rem Feeds the manager's daily performance report (bottleneck and busy-hour analysis).
rem Owner 2026-10-15: needed to decide hardware upgrades and de-conflict schedules.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%ROOT%\scripts\resource-sample.ps1" >> "%LOGDIR%\midform-resource-sample.log" 2>&1
exit /b %ERRORLEVEL%
