@echo off
rem Rival channel tracking. ASCII only: cmd.exe reads .cmd in the OEM codepage.
rem Korean notes live in scripts$n.js
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-rival-backlog.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts$n.js" >> "D:\midform\server\output\task-logs\midform-rival-backlog.log" 2>&1
