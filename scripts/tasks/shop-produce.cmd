@echo off
rem Nightly shopping-shorts production (owner 2026-10-13). Guard decides whether to run.
rem ASCII only: cmd.exe reads .cmd in the OEM codepage. Korean details live in scripts\shop-produce-prompt.md.
setlocal
set ROOT=D:\midform
set LOG=D:\volcano-runs\_upload\produce.log
cd /d "%ROOT%"
echo ---- %DATE% %TIME% >> "%LOG%"

node "%ROOT%\scripts\shop-produce-guard.js" --claim >> "%LOG%" 2>&1
if errorlevel 10 (
  echo guard: skip >> "%LOG%"
  exit /b 0
)

rem Prompt over stdin so quotes and newlines survive.
rem 2026-10-28: Coupang via Partners API rank only (web pages denied), so no --chrome.
type "%ROOT%\scripts\shop-produce-prompt.md" | "C:\Users\urban\.local\bin\claude.exe" -p --permission-mode bypassPermissions >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

rem Always release the lock; the release counts what was actually added to stock.
node "%ROOT%\scripts\shop-produce-guard.js" --release >> "%LOG%" 2>&1
echo produce exit %RC% >> "%LOG%"
exit /b %RC%
