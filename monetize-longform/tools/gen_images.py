# -*- coding: utf-8 -*-
"""장면 그림 일괄 생성(수창 레인) — img_prompts.json 의 각 키 → img/<키>.png (이미 있으면 건너뜀). GPT 창구 gpt-ask.js.
ko-corp/tools/gen_images.py 와 같은 방식이지만 호출자 이름(--session)과 동시 수(--jobs)를 받는다(렌더 중엔 1~2).

    python -X utf8 monetize-longform/tools/gen_images.py <편 폴더> [--jobs 2] [--session "수창 롱폼"] [키 ...]
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

argv = sys.argv[1:]
ep = Path(argv[0]).resolve()
jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 2
session = argv[argv.index('--session') + 1] if '--session' in argv else '수창 롱폼'
refs = [argv[i + 1] for i, a in enumerate(argv) if a == '--style-ref']   # 10-24: 레인 레퍼런스 화면을 붙여 화풍을 맞춘다(여러 장 가능)
keys = [a for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] not in ('--jobs', '--session', '--style-ref')]
P = json.loads((ep / 'img_prompts.json').read_text(encoding='utf-8'))
style = P.pop('_style')
keys = keys or list(P)
(ep / 'img').mkdir(exist_ok=True)


def one(k):
    out = ep / 'img' / f'{k}.png'
    if out.exists():
        return k, 'skip'
    att = [x for r_ in refs for x in ('--attach', r_)]
    note = '\n\n붙인 그림은 화풍 기준이다 — 선·색·빛·질감·밝기를 그대로 따르고, 내용(인물·물체·구도·글자·로고)은 따라 하지 말 것.' if refs else ''
    r = subprocess.run(['node', 'D:/midform/scripts/gpt-ask.js', '--session', session, '--no-search', *att, '--image', str(out),
                        f'{style}{note}\n\n장면: {P[k]}'], capture_output=True, text=True, encoding='utf-8')
    return k, ('ok' if out.exists() else 'FAIL ' + (r.stderr or r.stdout)[-300:])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    with ThreadPoolExecutor(jobs) as ex:
        for k, s in ex.map(one, keys):
            print(k, s, flush=True)
