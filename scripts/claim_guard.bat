@echo off
rem Content ID T-minus guard (P0-5, 2026-09-08): publishAt 직전에 클레임/차단을 재확인하고
rem 차단이면 예약을 뽑는다. 07:40/17:40 daily (슬롯 08:00/18:00 의 T-20m).
rem 분리 실행은 PATH 를 상속받지 못한다 - 절대경로 고정 (memory: windows-tool-paths).
cd /d D:\midform
"C:\Program Files\nodejs\node.exe" scripts\check-claims.js --unschedule >> server\output\claim-reports\guard.log 2>&1
