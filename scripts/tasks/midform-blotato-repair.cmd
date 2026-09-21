@echo off
rem Report Blotato fan-out posts that the platform later failed. ASCII only: cmd.exe reads .cmd
rem in the OEM codepage and UTF-8 Korean comments break parsing (measured 2026-09-18).
rem
rem Report only, never auto-repost. A failure can belong to a video we pulled for Content ID,
rem and reposting that without a human look is the wrong default. Retry with:
rem   node scripts\blotato-repair.js --retry
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-blotato-repair.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
"C:\Program Files\nodejs\node.exe" "%ROOT%\scripts\blotato-repair.js" >> "%LOG%" 2>&1
