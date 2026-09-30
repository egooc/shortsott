# -*- coding: utf-8 -*-
"""화이트리스트를 **중복도 순**으로 세운다.

    python scripts/whitelist_confidence.py            순위를 보여준다
    python scripts/whitelist_confidence.py --apply    카탈로그에 confidence 를 적는다

왜 (2026-09-28 소유주: "화이트리스트 안에서 중복도 높을수록 안전한 거 아닌가?")
  맞다. 그리고 지금까지 그걸 «기록만» 하고 순위에 안 썼다.

  한 채널에서 한 편 살아 있는 것과, **서로 다른 채널 다섯 곳이 각각 올려 놓고 다섯 곳 다
  안 막힌 것**은 증거의 무게가 다르다. 뒤쪽은 그 권리자가 이 포맷을 «폭넓게» 관용한다는 뜻이다.
  앞쪽은 그 채널이 운이 좋았거나 아직 안 걸렸을 수도 있다.

무엇을 세나 — 두 축이다. **채널 수가 편 수보다 무겁다.**
  channels  서로 다른 채널 몇 곳이 이 작품을 살려 두고 있나   ← 독립 표본의 수
  clips     그 채널들이 올린 편이 모두 몇 편인가              ← 같은 채널에서 여러 편은 덜 독립적이다
  oldest    가장 오래된 편이 언제 올라갔나                     ← 오래 버틸수록 세다

  confidence = 채널 수 × 2 + 편 수 + (90일 넘게 버틴 편이 있으면 +2)

★이것도 «보증»이 아니다. 우리 실적으로 화이트리스트 작품 5편 중 2편이 막혔다(사례 148).
  고르는 «순서»를 정하는 값이지, 안전 도장이 아니다. 실제로 발행해 보고 다시 센다.
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHITELIST = os.path.join(ROOT, 'server', 'data', 'whitelist_works.json')
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')


def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def score(w):
    chans = len(w.get('chs') or [])
    clips = int(w.get('n') or 0)
    old = 0
    try:
        days = (dt.date.today() - dt.date.fromisoformat(str(w.get('oldest'))[:10])).days
        old = 2 if days >= 90 else 0
    except Exception:
        pass
    return chans * 2 + clips + old, chans, clips, old


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    wl = json.load(io.open(WHITELIST, encoding='utf-8'))
    rows = []
    for w in wl:
        s, chans, clips, old = score(w)
        rows.append((s, chans, clips, old, w))
    rows.sort(key=lambda r: (-r[0], -r[2]))

    print(f"{'작품':40} {'점수':>4} {'채널':>4} {'편':>3} {'오래':>4}  채널 목록")
    for s, chans, clips, old, w in rows[:40]:
        print(f"  {w['en'][:38]:40} {s:4} {chans:4} {clips:3} {'+2' if old else '  ':>4}  "
              f"{'/'.join(w.get('chs') or [])[:34]}")

    multi = [r for r in rows if r[1] >= 2]
    print(f"\n작품 {len(rows)}건 · **두 채널 이상에서 살아 있는 것 {len(multi)}건**")
    if not multi:
        print('★아직 한 채널짜리뿐이다. 채널을 더 훑어야 중복도가 신호가 된다.')

    if not args.apply:
        print('\n계산만 · 카탈로그에 적으려면 --apply')
        return 0

    cat = json.load(io.open(CATALOG, encoding='utf-8'))
    movies = cat['movies']
    index = {}
    for k, v in movies.items():
        for n in (v.get('title_en'), v.get('title_ko'), k):
            if n:
                index[norm(n)] = k
    hit = 0
    for s, chans, clips, old, w in rows:
        k = index.get(norm(w['en']))
        if not k:
            continue
        movies[k]['whitelist_confidence'] = {
            'score': s, 'channels': chans, 'clips': clips,
            'chs': w.get('chs') or [], 'oldest': w.get('oldest'),
            'measured_at': dt.date.today().isoformat(),
        }
        hit += 1
    with io.open(CATALOG, 'w', encoding='utf-8') as fh:
        json.dump(cat, fh, ensure_ascii=False, indent=2)
    print(f'\n카탈로그 {hit}건에 whitelist_confidence 기록')
    return 0


if __name__ == '__main__':
    sys.exit(main())
