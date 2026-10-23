@echo off
rem monetize ja chain - schtasks one-shot (ASCII only). usage: chain_ja.cmd ep_ja02 [--skip-audit] [--render-only]
cd /d D:\midform
"C:\Users\urban\AppData\Local\Programs\Python\Python312\python.exe" -X utf8 D:\midform\monetize-longform\tools\chain_ja.py monetize-longform\%1 %2 %3 >> D:\midform\monetize-longform\%1\chain_task.log 2>&1
