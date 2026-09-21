@echo off
rem Nightly source-pool depth check. Warns before the movie pool runs dry.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
rem Rules live in scripts\catalog-pool.js and docs\source-casebook.md case 74.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-catalog-pool.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"

node "%ROOT%\scripts\catalog-pool.js" --warn-days 10 >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

rem exit 1 = pool is thin or a rule was violated. Refill the catalog by scouting.
if not "%RC%"=="0" (
  echo pool thin or rule violated - scouting to refill >> "%LOG%"
  node "%ROOT%\scripts\scout-sources.js" --recon >> "%LOG%" 2>&1
)
echo catalog-pool exit %RC% >> "%LOG%"
exit /b 0
