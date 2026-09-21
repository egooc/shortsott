@echo off
rem Upload and schedule approved drafts. Runs right after auto-approve.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage and UTF-8 Korean comments break parsing.
rem
rem Owner directive 2026-09-20: publish on schedule without a human step.
rem --skip-export because the volcano pipeline already wrote the mp4 (no CapCut screen work).
rem auto-publish still runs its own sync audit and holds a draft whose captions have no speech
rem under them - that gate stays, it caught terminal_goat-ja on the first automated run.
setlocal
set ROOT=D:\midform
set LOGDIR=%ROOT%\server\output\task-logs
set LOG=%LOGDIR%\midform-auto-publish.log
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"
node "%ROOT%\scripts\auto-publish.js" --skip-export --limit 6 >> "%LOG%" 2>&1
echo ---- blotato fan-out >> "%LOG%"
node "%ROOT%\scripts\blotato-publish.js" >> "%LOG%" 2>&1
