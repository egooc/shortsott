@echo off
cd /d D:\midform
if not exist server\output\feed-watch mkdir server\output\feed-watch
node scripts\rinbox-feed-watch.js > server\output\feed-watch\latest.txt 2>&1
type server\output\feed-watch\latest.txt >> server\output\feed-watch\history.log
