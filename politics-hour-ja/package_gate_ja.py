# -*- coding: utf-8 -*-
"""정치JA 포장 제목 머리 관문 — ko politics-hour/views_check.js 의 포장 교체가 부르는 package_gate.py 자리(packages.json "head_gate").
ko package_gate 는 한국어 따옴표(“)·ko 뉴스 낱말을 봐서 일본어 제목은 전부 FAIL 이었다(10-30 1KpARgeCS-g +4h 교체 0).
규칙은 upload_gate_ja.py 포장 머리 관문과 같다: ① 첫 쟁점 낱말이 앞 12자 안 ② 그 쟁점 news_outlier title_words·quotes 2개 이상.

    python -X utf8 politics-hour-ja/package_gate_ja.py <편 폴더> --title <제목>      종료 0 통과 · 4 FAIL
"""
import json
import re
import sys
from pathlib import Path


def check(ep, title):
    kw = json.loads((Path(ep) / 'keywords.json').read_text(encoding='utf-8'))
    cands = [c for c in kw.get('candidates', []) if isinstance(c, dict)]
    first = kw.get('first_issue') or (cands[0].get('keyword') if cands else '')
    no = (cands[0].get('news_outlier') if cands else None) or []
    no = [no] if isinstance(no, dict) else no
    strong = list(dict.fromkeys(w for o in no for w in [*o.get('title_words', []), *o.get('quotes', [])] if w))
    n = re.sub(r'<[^>]+>|[\s“”"「」『』？?！!、。・]', '', title)
    bad = []
    if not first or re.sub(r'[\s・]', '', first) not in n[:12]:
        bad.append(f'제목 머리(앞 12자)에 첫 쟁점 «{first}» 없음')
    hit = [x for x in strong if re.sub(r'[\s「」・]', '', x) in n]
    if len(hit) < 2:
        bad.append(f'뉴스 헤드라인 낱말 {len(hit)}개(2개 이상) — 후보 {" · ".join(strong[:6])}')
    return bad


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    a = sys.argv[1:]
    title = a[a.index('--title') + 1] if '--title' in a else ''
    bad = check(a[0], title)
    for b in bad:
        print(f'[pkg-ja] FAIL «{title}» — {b}')
    if not bad:
        print(f'[pkg-ja] PASS «{title}»')
    sys.exit(4 if bad else 0)
