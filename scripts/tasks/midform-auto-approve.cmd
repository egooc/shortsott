@echo off
rem Approve finished drafts on machine checks so the schedule keeps moving.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
rem Korean rationale lives in scripts\auto-approve.js header.
rem
rem Owner directive 2026-09-20: stop requiring a human approval for every video.
rem The machine checks distributor tier, Content ID probe verdict, and mp4 duration.
rem It cannot see picture or caption errors - check-claims.js is the net after upload.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-auto-approve.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\scripts\auto-approve.js" --approve --max 6 >> "%LOG%" 2>&1
