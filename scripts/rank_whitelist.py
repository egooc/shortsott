# -*- coding: utf-8 -*-
"""살아 있는 클립 수·차단률로 화이트리스트 등급을 매기고 카탈로그에 적는다.

    python scripts/rank_whitelist.py            등급을 보여준다
    python scripts/rank_whitelist.py --apply    카탈로그에 적는다

왜 (2026-09-29 소유주: "특정 채널에 1개 살아있다고 안전한 건 아니라는 거지")
  내 화이트리스트 136건 중 118건이 «한 채널 한 편»이었다. 전부 똑같아 보였다.
  유튜브 전체로 세 보니 갈렸다(`count_alive_clips.py`):
  ```
  Paddington 2      39편 살아있음 · 차단 0%     ← 권리자가 폭넓게 관용
  The Intouchables  14편 살아있음 · 차단 60%    ← 21편이 막혀 있다. 위험하다
  ```
  **언터처블은 내 화이트리스트에 있었다.** 한 채널에 한 편 살아 있는 것을 보고 «안전»으로
  분류했고, 그대로 만들었으면 막혔을 것이다.

등급
  A  살아있음 20편+ · 차단률 5% 이하   → 1순위. 권리자가 폭넓게 관용한다
  B  살아있음 10편+ · 차단률 15% 이하  → 2순위
  C  그 밖                             → 쓰지 마라. 특히 차단률 20%+ 는 위험 신호다

★이것도 보증이 아니다. «남이 안 막혔다»와 «우리가 안 막힌다»는 다르다(사례 148·150).
  고르는 순서를 정할 뿐이고, 진짜 방어는 여전히 3층(check-claims)이다.
"""
import argparse
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COUNTS = os.path.join(ROOT, 'server', 'data', 'alive_clip_counts.json')
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def grade(v):
    # ★죽은 것은 **지역 차단뿐이다**(2026-09-30 철회).
    #   2026-09-29 에는 소유권 매칭(licensedContent)도 죽은 것으로 셌다. 근거였던 「ja 4회」는
    #   매칭이 아니라 내가 그 편을 비공개로 돌려서 나온 숫자였다 — 순환 논증이었다.
    #   게다가 공식 권리자 채널은 자기 소유물을 올리니 항상 매칭이다. 매칭을 죽음으로 세면
    #   **가장 안전한 소스가 가장 낮은 등급**을 받는다. 정확히 거꾸로다.
    alive = v['alive_in_band']
    dead = v['blocked_in_band']
    tot = alive + dead
    rate = (dead / tot) if tot else 1.0
    if alive >= 20 and rate <= 0.05:
        return 'A', rate
    if alive >= 10 and rate <= 0.15:
        return 'B', rate
    return 'C', rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    counts = read_json(COUNTS, {})
    cat = read_json(CATALOG, {})
    movies = cat.get('movies', {})
    index = {}
    for k, v in movies.items():
        for n in (v.get('title_en'), v.get('title_ko'), k):
            if n:
                index[norm(n)] = k

    rows = []
    for title, v in counts.items():
        g, rate = grade(v)
        rows.append((g, -v['alive_in_band'], title, v, rate))
    rows.sort()

    print(f"{'등급':4} {'작품':38} {'살아있음':>7} {'막힘':>5} {'차단률':>7}  카탈로그")
    hit = 0
    for g, _, title, v, rate in rows:
        key = index.get(norm(title))
        mark = key or '(없음)'
        if key and args.apply:
            movies[key]['alive_clips'] = {
                'grade': g, 'alive_in_band': v['alive_in_band'],
                'blocked_in_band': v['blocked_in_band'],
                'licensed_in_band': v.get('licensed_in_band'),
                'signal': v.get('signal') or 'region_and_licensed',
                'block_rate': round(rate, 3), 'channels': v['channels'],
                'measured_at': '2026-09-29',
            }
            if g == 'C':
                movies[key]['note'] = (movies[key].get('note') or '') + (
                    f" ★2026-09-29 등급 C — 유튜브에 살아 있는 클립 {v['alive_in_band']}편, "
                    f"차단 {v['blocked_in_band']}편(차단률 {100 * rate:.0f}%). 고르지 마라.")
            hit += 1
        one = '  ★신호1개' if v.get('signal') == 'region_only' else ''
        print(f"  {g:4} {title[:36]:38} {v['alive_in_band']:7} {v['blocked_in_band']:5} "
              f"{100 * rate:6.0f}%  {mark}{one}")

    from collections import Counter
    print('\n등급 분포:', dict(Counter(r[0] for r in rows)))
    if args.apply:
        with io.open(CATALOG, 'w', encoding='utf-8') as fh:
            json.dump(cat, fh, ensure_ascii=False, indent=2)
        print(f'카탈로그 {hit}건에 alive_clips 기록')
    else:
        print('계산만 · 적으려면 --apply')
    return 0


if __name__ == '__main__':
    sys.exit(main())
