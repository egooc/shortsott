@echo off
rem Survivor signal refresh. Runs after the nightly scout (01:30) so it reads fresh recon.
rem ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage, so UTF-8 Korean comments
rem get mangled and can swallow the next command. Korean notes live in scripts\survivor-signal.js.
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-survivor-signal.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts\survivor-signal.js" >> "D:\midform\server\output\task-logs\midform-survivor-signal.log" 2>&1
