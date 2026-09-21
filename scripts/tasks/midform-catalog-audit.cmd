@echo off
rem Idle-hour verification sweep. Runs when production and publishing are quiet.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
rem What it checks lives in scripts\catalog-audit.js (year clash, double match, loose pattern).
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-catalog-audit.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"

node "%ROOT%\scripts\catalog-audit.js" >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo FOUND mismatches - see scout-reports\*-audit.md >> "%LOG%"
echo catalog-audit exit %RC% >> "%LOG%"
exit /b 0
