# -*- coding: utf-8 -*-
"""소스 후보가 **정말 그 작품인지** 제목으로 감사한다.

    python scripts/audit_clip_titles.py [--grade AB] [--apply]

왜 (2026-09-30 실측, 사례 158)
  소스 검색은 제목 낱말로 맞추니 **다른 작품이 섞인다.**
  ```
  room-2015       → "The Room - Oh Hi Mark"            토미 와이소 영화
  animal-control  → "ANIMAL Movie Scene: Ranbir Takes" 인도 영화 Animal(2023)
  animal-control  → "literally just every animal control scene | Parks and Rec"
  ```
  그대로 만들면 **크레딧에 남의 영화 제목을 박은 영상**이 나간다.

어떻게 보나 — 후보 제목에 작품명이 «이어진 한 덩이»로 들어 있는지 본다.
  · 낱말이 흩어져 있으면(예: "animal" 과 "control" 이 멀리 떨어져) 의심한다.
  · 작품명 바로 앞에 관사·다른 낱말이 붙어 뜻이 달라지는 것도 의심한다("The Room" vs "Room").
★기계는 **의심만** 한다. `--apply` 없이 먼저 눈으로 보고, 확실한 것만 떨어뜨린다 —
  «모른다»를 «다른 작품»으로 바꿔 적으면 쓸 수 있는 소스를 버린다.
"""
import argparse
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CC = os.path.join(ROOT, 'server', 'data', 'clip_candidates.json')
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def norm(s):
    # ★아포스트로피는 **지운다**(공백으로 바꾸지 않는다). 공백으로 바꾸면
    #   "Grey's Anatomy" 가 "grey s anatomy" 가 되어 제목이 안 맞는 것처럼 보인다 —
    #   2026-09-30 첫 판에서 멀쩡한 소스 5건을 «다른 작품 의심»으로 올렸다.
    s = re.sub(r"['’‘`]", '', str(s or '').lower())
    return re.sub(r'[^a-z0-9 ]', ' ', s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grade', default='AB')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    cc = read_json(CC, {})
    cat = read_json(CATALOG, {}).get('movies', {})
    want = set(args.grade.upper())

    pairs = []
    for k, m in cat.items():
        if ((m.get('alive_clips') or {}).get('grade')) not in want:
            continue
        for n in (m.get('title_en'), k, m.get('title_ko')):
            if n and n in cc:
                pairs.append((k, m, n)); break

    flagged = 0
    for key, m, cname in pairs:
        e = cc[cname]
        want_t = norm(m.get('title_en') or key.replace('-', ' '))
        want_t = re.sub(r'\s+', ' ', want_t).strip()
        sus = []
        for c in e.get('top') or []:
            if c.get('dead'):
                continue
            t = re.sub(r'\s+', ' ', norm(c.get('title')))
            if want_t and want_t in t:
                continue                      # 제목이 한 덩이로 들어 있다 — 통과
            sus.append(c)
        if not sus:
            continue
        print(f"\n[{(m.get('alive_clips') or {}).get('grade')}] {key}  (작품명: \"{want_t}\")")
        for c in sus:
            print(f"   ? {c['id']} — {(c.get('title') or '')[:70]}")
            flagged += 1
            if args.apply:
                c['dead'] = '제목에 작품명이 없다 — 다른 작품 의심'
                c.pop('verified', None)
        if args.apply:
            ok = [c for c in e['top'] if c.get('verified')]
            e['usable'] = len(ok)
            e['best'] = ok[0] if ok else None
    if args.apply:
        with io.open(CC, 'w', encoding='utf-8') as fh:
            json.dump(cc, fh, ensure_ascii=False, indent=2)
        print(f'\n의심 {flagged}건을 떨어뜨렸다')
    else:
        print(f'\n의심 {flagged}건 — 눈으로 보고 확실한 것만 --apply')
    return 0


if __name__ == '__main__':
    sys.exit(main())
