# -*- coding: utf-8 -*-
"""episode.json 의 prompt 가 있는 장면 → 탭 구분 작업 목록(편, 그림 이름, 프롬프트)."""
import json
import sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
for f in sorted(Path(__file__).resolve().parent.glob('tok*/episode.json')):
    for s in json.loads(f.read_text(encoding='utf-8'))['scenes']:
        if s.get('prompt'):
            print(f'{f.parent.name}\t{s["img"]}\t{s["prompt"]}')
