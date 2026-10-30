#!/usr/bin/env bash
# 틱톡 ④·⑤ 렌더 큐 — 정치 렌더 시간(18:30~00:30)·RENDERING.lock 피해서 네 편 차례로.
cd /d/midform
ok() { local hm=$(date +%H%M); [ ! -f politics-hour/RENDERING.lock ] && [ ! -f politics-hour/RENDERING-ja.lock ] && [ "$hm" -ge 0031 ] && [ "$hm" -lt 1830 ]; }
for e in tok4a tok4b tok5a tok5b; do
  [ -f ko-corp/tok/$e/out/$e.mp4 ] && continue
  until ok; do sleep 120; done
  date; python -X utf8 ko-corp/tok/tok_render.py ko-corp/tok/$e render 2>&1 | tail -3
done
date; echo done
