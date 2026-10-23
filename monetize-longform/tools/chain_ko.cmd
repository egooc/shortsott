@echo off
rem monetize ko chain - schtasks one-shot (ASCII only). usage: chain_ko.cmd ep_ko01 [--skip-audit] [--render-only]
cd /d D:\midform
"C:\Users\urban\AppData\Local\Programs\Python\Python312\python.exe" -X utf8 D:\midform\monetize-longform\tools\chain_ko.py monetize-longform\%1 %2 %3 >> D:\midform\monetize-longform\%1\chain_task.log 2>&1
