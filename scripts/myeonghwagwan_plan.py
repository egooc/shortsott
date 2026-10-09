# -*- coding: utf-8 -*-
"""볼케이노 회차 폴더에서 자체 렌더러용 plan.json 을 짓는다.
#
#   python scripts/myeonghwagwan_plan.py D:/volcano-runs/lsr01 [--cx 0.5] [--out plan.json]
#
# 왜 따로 두나 (2026-10-09): 손으로 plan 을 지으면 **어느 편집표를 쓸지** 매번 틀린다.
#   볼케이노는 `edit.json` 이 아니라 **`effective-edit.json`** 으로 굽는다.
#   둘은 컷 경계가 다르다 — lsr01 실측:
#       edit.json            77.400 ~ 88.100   = 321프레임
#       effective-edit.json  77.600 ~ 88.100   = 315프레임
#   왜 당겨졌나: `boundary-preflight-*.json` 의 audit 에 이유가 적혀 있다 —
#       reason: "word_safe_leading_source_boundary"
#   **컷 머리가 말 한가운데서 시작하지 않게** 앞을 당긴 것이다.
#   edit.json 으로 구우면 말이 잘린 채 시작하고 프레임도 9개 더 나온다(5155 vs 5146).
"""
import argparse
import glob
import io
import json
import os
import sys

import sys
# ★콘솔 기본값(cp949)은 ✗ ⚠ 같은 기호를 못 쓴다 — 그러다 렌더 끝맣문에서
#   UnicodeEncodeError 로 전체가 죽었다(2026-10-09 실제). 출력만 고친다.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def newest(pattern):
    hits = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    return hits[0] if hits else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('workdir', help='볼케이노 회차 폴더 (예: D:/volcano-runs/lsr01)')
    ap.add_argument('--cx', type=float, default=0.5, help='가로 어디를 가운데로 둘지(0~1)')
    ap.add_argument('--lang', default=None, help='안 주면 제목 글자로 알아본다')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    wd = a.workdir.rstrip(chr(47) + chr(92))

    # ★effective-edit.json 이 **먼저**다. 없을 때만 edit.json 으로 내려간다.
    ed = newest(wd + '/edits/*/effective-edit.json') or newest(wd + '/edits/*/edit.json')
    if not ed:
        sys.exit('편집표를 못 찾았다: ' + wd + '/edits/*/')
    if ed.endswith('edit.json') and 'effective' not in ed:
        print('⚠ effective-edit.json 이 없어 edit.json 을 쓴다 — 컷 머리가 말을 자를 수 있다')
    e = json.load(io.open(ed, encoding='utf-8'))

    src = newest(wd + '/volcano_src.*') or newest(wd + '/*.mp4')
    tr = wd + '/transcript.json'
    if not src:
        sys.exit('원본 영상을 못 찾았다')
    if not os.path.exists(tr):
        sys.exit('전사가 없다 — 먼저 뜨라:\n'
                 '  python scripts/rinbox_transcribe.py %s %s --lang en' % (src, tr))

    lang = a.lang
    if not lang:
        t = ''.join(e['title'])
        lang = 'ja' if any('\u3040' <= c <= '\u30ff' for c in t) else 'ko'

    plan = {
        'source': os.path.abspath(src).replace(chr(92), chr(47)),
        'transcript': os.path.abspath(tr).replace(chr(92), chr(47)),
        'lang': lang,
        'mirror': False,
        'title': e['title'],
        'credit': e.get('credit', ''),
        'narration': e['narration'],
        'sequence': [dict(s, cx=a.cx) for s in e['sequence']],
    }
    out = a.out or (wd + '/plan_self.json')
    io.open(out, 'w', encoding='utf-8').write(json.dumps(plan, ensure_ascii=False, indent=1))
    cuts = [s for s in plan['sequence'] if 'source_in' in s]
    print('%s · %s · 해설 %d · 컷 %d · 편집표 %s'
          % (out, lang, len(plan['narration']), len(cuts), os.path.basename(ed)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
