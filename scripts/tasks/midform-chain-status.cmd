@echo off
rem Report whether production -> approval -> publish is still moving.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
rem
rem Why: when approval stopped on 09-18 the whole chain went quiet and nothing said so.
rem Stock sat at target so hourly production skipped every hour for two days.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-chain-status.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\scripts\chain-status.js" >> "%LOG%" 2>&1
