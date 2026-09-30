@echo off
rem Fan out published rinbox episodes to the non-YouTube platforms via Blotato.
rem Idempotent: rinbox_social_state.json remembers what already shipped, so a
rem re-run costs nothing. Posting spends no Blotato credits.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-rinbox-social.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\scripts\rinbox-social.js" >> "%LOG%" 2>&1
echo rinbox-social exit %ERRORLEVEL% >> "%LOG%"
exit /b 0
