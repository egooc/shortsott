@echo off
rem Tag gate watch: videos whose tags were written but read back as 0. Confirms them, or cancels the schedule 20 min before publish.
rem Runs node scripts\yt_tags_pending.js --tick every 10 minutes (task midform-yt-tags-watch). No API calls when the list is empty.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-yt-tags-watch.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
"C:\Program Files\nodejs\node.exe" "%ROOT%\scripts\yt_tags_pending.js" --tick >> "%LOG%" 2>&1
