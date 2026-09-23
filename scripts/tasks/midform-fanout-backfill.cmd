@echo off
rem Fan-out backfill. Fills posts that never reached Naver/Facebook/TikTok/Instagram/Threads.
rem Runs OUTSIDE the YouTube slots (08/12/18 KST) so the two never collide.
rem A few per run on purpose: firing 85 posts at once looks like spam to the platforms.
rem Exits quietly once there is nothing left to fill.
rem ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage and mangles UTF-8 Korean.
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-fanout-backfill.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts\fanout-backfill.js" --limit 4 >> "D:\midform\server\output\task-logs\midform-fanout-backfill.log" 2>&1
