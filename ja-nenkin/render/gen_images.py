# -*- coding: utf-8 -*-
"""연금JA 장면 그림 생성 — 관리자 §7 10-24: 레퍼런스 터진 편 화면 3~5장을 GPT 이미지 요청에 붙여 화풍을 맞춘다.
수창 monetize-longform/tools/gen_images.py --style-ref 와 같은 방식(그 파일은 모듈 수준에서 argv 를 읽어 import 불가).

    python -X utf8 ja-nenkin/render/gen_images.py <편 폴더> [--jobs 2] [키 ...]

<편>/img_prompts.json = {"_style": "화풍 글", "_style_refs": ["ja-nenkin/style_refs/....png", ...], "<키>": "장면 설명", ...}
- _style_refs 가 비었거나 파일이 없으면 종료 4(관문) — 글로만 화풍을 지시하지 않는다.
- 붙이는 화면은 화풍 참고용: 로고·글자·실존 인물 얼굴은 잘라 낸 것만(ja-nenkin/style_refs/), 구도·글자는 따라 하지 않는다.
- 결과 img/<키>.png(있으면 건너뜀), 요청마다 img/_gen_log.jsonl 에 {key, style_refs, prompt, ok} 한 줄.
"""
import datetime
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NOTE = ('\n\n붙인 그림은 화풍 기준이다 — 선·색·채색 방식·얼굴 그리는 법·밝기를 그대로 따르고, '
        '내용(인물·물체·구도·글자·로고)은 따라 하지 말 것. 그림 안에 글자를 넣지 말 것.')


def refs_of(P):
    refs = P.get('_style_refs') or []
    missing = [r for r in refs if not (ROOT / r).exists()]
    if len(refs) < 3 or missing:
        print(f'[관문] style_refs {len(refs)}장 · 없는 파일 {missing} — 레퍼런스 화면 3~5장 없이는 그림 요청 금지(종료 4)')
        sys.exit(4)
    return refs


def one(ep, style, refs, k, desc):
    out = ep / 'img' / f'{k}.png'
    if out.exists():
        return k, 'skip'
    att = [x for r in refs for x in ('--attach', str(ROOT / r))]
    prompt = f'{style}{NOTE}\n\n장면: {desc}'
    r = subprocess.run(['node', str(ROOT / 'scripts' / 'gpt-ask.js'), '--session', '연금JA', '--no-search', *att, '--image', str(out), prompt],
                       capture_output=True, text=True, encoding='utf-8')
    ok = out.exists()
    with open(ep / 'img' / '_gen_log.jsonl', 'a', encoding='utf-8') as f:
        f.write(json.dumps({'at': datetime.datetime.now().isoformat(timespec='seconds'), 'key': k, 'style_refs': refs,
                            'prompt': prompt, 'ok': ok}, ensure_ascii=False) + '\n')
    return k, ('ok' if ok else 'FAIL ' + (r.stderr or r.stdout)[-300:])


def main(argv):
    ep = Path(argv[0]).resolve()
    jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 2
    keys = [a for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] != '--jobs']
    P = json.loads((ep / 'img_prompts.json').read_text(encoding='utf-8'))
    refs = refs_of(P)
    style = P['_style']
    keys = keys or [k for k in P if not k.startswith('_')]
    (ep / 'img').mkdir(exist_ok=True)
    bad = 0
    with ThreadPoolExecutor(jobs) as ex:
        for k, s in ex.map(lambda k: one(ep, style, refs, k, P[k]), keys):
            print(k, s, flush=True)
            bad += s.startswith('FAIL')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main(sys.argv[1:]))
