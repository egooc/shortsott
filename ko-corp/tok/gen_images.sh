#!/usr/bin/env bash
# 생성 그림 큐 — episode.json 의 prompt 마다 gpt-ask --image, 이미 있으면 건너뜀. 동시 3건.
cd "$(dirname "$0")"
python -X utf8 img_jobs.py > img_jobs.tsv
while IFS=$'\t' read -r ep name prompt; do
  out="$PWD/$ep/img/$name.png"; [ -f "$out" ] && continue
  while [ "$(jobs -rp | wc -l)" -ge 3 ]; do wait -n; done
  node ../../scripts/gpt-ask.js --session "기업흥망 틱톡" --no-search --image "$out" "Vertical 9:16 portrait image (1024x1536). $prompt. Leave the top 15% and bottom 30% visually simple (subtitles go there). Absolutely no letters, words, logos or watermarks." > "$ep/img/$name.log" 2>&1 &
done < img_jobs.tsv
wait
ls tok*/img/*.png | wc -l
