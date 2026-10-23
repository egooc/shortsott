@echo off
rem monetize night chain - schtasks one-shot (ASCII only). episodes run in order; between episodes yield one shopping round (night_chain.py).
cd /d D:\midform
"C:\Users\urban\AppData\Local\Programs\Python\Python312\python.exe" -X utf8 D:\midform\monetize-longform\tools\night_chain.py ep_ko08:ko:--render-only ep_ja04:ja:--render-only >> D:\midform\monetize-longform\night_chain_task.log 2>&1
