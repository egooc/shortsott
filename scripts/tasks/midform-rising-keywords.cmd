@echo off
rem Rising search keywords snapshot for all longform lanes (owner rule 2026-10-19: topics come from rising keywords, not news).
rem Runs node scripts\rising_keywords.js --all. Scheduled daily 08:00 and 14:00 KST (task midform-rising-keywords).
rem ASCII only: cmd.exe reads .cmd in the OEM codepage.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-rising-keywords.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
"C:\Program Files\nodejs\node.exe" "%ROOT%\scripts\rising_keywords.js" --all >> "%LOG%" 2>&1
echo rc=%ERRORLEVEL% >> "%LOG%"
endlocal
exit /b 0
