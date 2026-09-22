@echo off
rem Rival channel discovery. Weekly - search costs 100 quota units per call.
rem ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage and mangles UTF-8 Korean.
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-rival-scout.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts\rival-scout.js" >> "D:\midform\server\output\task-logs\midform-rival-scout.log" 2>&1
