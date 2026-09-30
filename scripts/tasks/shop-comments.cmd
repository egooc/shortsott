@echo off
rem Post the affiliate-link comment right after a scheduled shopping short goes public (shop_schedule.js comments)
cd /d D:\midform
"C:\Program Files\nodejs\node.exe" scripts\shop_schedule.js comments >> D:\volcano-runs\_upload\comments.log 2>&1
