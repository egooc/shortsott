@echo off
rem ?�동 ?�성: scripts\install-schedule.ps1 ??직접 고치지 말고 �??�크립트�?고칠 �?cd /d "D:\midform"
if not exist "D:\midform\server\output\task-logs" mkdir "D:\midform\server\output\task-logs"
echo ---- %DATE% %TIME% >> "D:\midform\server\output\task-logs\midform-claim-guard-0740.log"
"C:\Program Files\nodejs\node.exe" "D:\midform\scripts\check-claims.js" --all --unschedule >> "D:\midform\server\output\task-logs\midform-claim-guard-0740.log" 2>&1
