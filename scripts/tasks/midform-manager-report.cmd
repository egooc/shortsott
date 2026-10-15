@echo off
rem Daily 07:35: build yesterday's manager performance report (docs\reports\YYYY-MM-DD-perf.md).
rem The manager Claude session reads it at 07:40 and posts the summary to the owner.
rem Owner 2026-10-15: performance report (views, tokens, GPT, per-video time, bottlenecks), not progress.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-manager-report.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
set PYTHONIOENCODING=utf-8
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\scripts\manager-report.js" >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
echo manager-report exit %RC% >> "%LOG%"
exit /b %RC%
