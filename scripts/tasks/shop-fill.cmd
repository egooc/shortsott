@echo off
rem Keep the new shopping channel stocked: upload the next stock items (max 2/day: 08:00 and 18:00 only; owner 2026-10-15 dropped the 12:00 slot) and fan out to Blotato + Naver Clip
cd /d D:\midform
"C:\Program Files\nodejs\node.exe" scripts\shop_schedule.js fill 2 --purpose shopping >> D:\volcano-runs\_upload\fill.log 2>&1
