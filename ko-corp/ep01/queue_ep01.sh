#!/bin/bash
# ep01 재렌더(10-31 사실 고침 9곳·채널명) — 기업흥망 렌더 창 13:00~17:00, 락 없을 때 시작
cd D:/midform
while :; do
  h=$(date +%H%M)
  if [ "$h" -ge 1300 ] && [ "$h" -lt 1700 ] && ! ls politics-hour/RENDERING*.lock >/dev/null 2>&1; then break; fi
  sleep 120
done
date; python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01; echo "exit=$?"; date
