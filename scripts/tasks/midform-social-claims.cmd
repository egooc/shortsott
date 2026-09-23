@echo off
rem Social-side claim check: posts that failed to publish on TikTok/Instagram/Threads/Facebook.
rem check-claims.js is the YouTube equivalent; this is the same layer for the other platforms.
rem --requeue clears the fan-out ledger for failed posts so the backfill runner retries them.
rem ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage and mangles UTF-8 Korean.
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-social-claims.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts\social-claims.js" --requeue >> "D:\midform\server\output\task-logs\midform-social-claims.log" 2>&1
