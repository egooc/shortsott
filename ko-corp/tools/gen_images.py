# -*- coding: utf-8 -*-
"""장면 그림 일괄 생성 — img_prompts.json 의 각 키 → img/<키>.png (이미 있으면 건너뜀). GPT 창구 gpt-ask.js, 동시 3건.

    python ko-corp/tools/gen_images.py ko-corp/ep01 [키 ...]
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ep = Path(sys.argv[1]).resolve()
P = json.loads((ep / 'img_prompts.json').read_text(encoding='utf-8'))
style = P.pop('_style')
keys = sys.argv[2:] or list(P)


def one(k):
    out = ep / 'img' / f'{k}.png'
    if out.exists():
        return k, 'skip'
    r = subprocess.run(['node', 'D:/midform/scripts/gpt-ask.js', '--session', '기업 흥망', '--no-search', '--image', str(out),
                        f'{style}\n\n장면: {P[k]}'], capture_output=True, text=True, encoding='utf-8')
    return k, ('ok' if out.exists() else 'FAIL ' + (r.stderr or r.stdout)[-300:])


with ThreadPoolExecutor(3) as ex:
    for k, s in ex.map(one, keys):
        print(k, s, flush=True)
