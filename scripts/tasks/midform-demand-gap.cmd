@echo off
rem Demand-gap snapshot. Runs after scout (01:30) and survivor-signal (02:10).
rem Needs two snapshots a day apart before it can report velocity, so it runs daily.
rem ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage and mangles UTF-8 Korean.
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-demand-gap.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts\demand-gap.js" >> "D:\midform\server\output\task-logs\midform-demand-gap.log" 2>&1
