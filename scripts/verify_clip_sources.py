# -*- coding: utf-8 -*-
"""소스 후보가 **정말 내려받히는지** 확인한다. API 의 `blocked: 0` 을 믿지 마라.

    python scripts/verify_clip_sources.py [--grade AB] [--limit 40]

왜 (2026-09-30 실측)
  등급 A 1위 `paddington-2` 는 소스 후보 8건이 전부 `blocked: 0` 이었다. 그런데:
  ```
  yt-dlp --skip-download 7tKwtj8I93M
  → ERROR: [youtube] 7tKwtj8I93M: This video is not available
  ```
  **지역 제한으로 우리는 못 받는다.** YouTube Data API 의
  `contentDetails.regionRestriction.blocked` 는 «권리자가 명시적으로 지역을 막은 것»만
  알려 준다. 채널 단위 제한·유료 전환·비공개 전환·연령 제한은 거기 안 나온다.

  그 결과 «등급 A 인데 만들 수 있는 것 10건» 이라고 세 놓고, 실제로는 셋이 못 받는
  소스였다. 오늘 예약 생산 세 번이 전부 미측정 작품으로 간 이유가 이것이다 —
  생산 차례에 가서야 소스가 죽은 걸 알고 뒤로 물러났다.

→ 후보를 **미리** 두들겨 본다. 죽은 것은 `dead: <이유>` 로 적고 usable 에서 뺀다.
★쿠키로 우회하지 않는다(소유주 상시 지시). 못 받으면 못 받는 것으로 적는다.
★연령 제한(`age_limit > 0`)도 금지다 — 같이 떨어뜨린다.
"""
import argparse
import io
import json
import os
import subprocess
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


def probe(vid):
    """(살았나, 이유). yt-dlp 로 메타만 본다 — 내려받지 않는다."""
    try:
        r = subprocess.run(
            ['yt-dlp', '--no-warnings', '--skip-download', '--no-playlist',
             '--print', '%(duration)s|%(age_limit)s|%(availability)s',
             'https://www.youtube.com/watch?v=' + vid],
            capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return False, 'timeout'
    out = (r.stdout or '').strip().splitlines()
    line = next((x for x in out if '|' in x), '')
    if not line:
        err = (r.stderr or '').strip().splitlines()
        msg = next((x for x in err if 'ERROR' in x), (err[-1] if err else 'no output'))
        msg = msg.split(': ', 2)[-1][:70]
        return False, msg
    dur, age, avail = (line.split('|') + ['', '', ''])[:3]
    if age not in ('0', 'NA', '', 'None'):
        return False, f'연령제한 {age}'
    if avail not in ('public', 'unlisted', 'NA', '', 'None'):
        return False, f'공개상태 {avail}'
    return True, f'{dur}초'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grade', default='AB')
    ap.add_argument('--limit', type=int, default=40)
    args = ap.parse_args()

    cc = read_json(CC, {})
    cat = read_json(CATALOG, {}).get('movies', {})
    want = set(args.grade.upper())

    # 등급이 맞는 작품의 후보만 두들긴다
    keys = []
    for k, m in cat.items():
        g = (m.get('alive_clips') or {}).get('grade')
        if g not in want:
            continue
        for n in (m.get('title_en'), k, m.get('title_ko')):
            if n and n in cc:
                keys.append((g, k, n))
                break
    keys.sort()
    checked = 0
    for g, key, cname in keys:
        e = cc[cname]
        tops = e.get('top') or []
        print(f"\n[{g}] {key}  후보 {len(tops)}건")
        alive = []
        for c in tops:
            if checked >= args.limit:
                print('   (한도 도달 — 나머지는 다음 회차에)')
                break
            if c.get('verified') is True:
                alive.append(c); print(f"   ✓ {c['id']} (이미 확인)"); continue
            if c.get('dead'):
                print(f"   ✗ {c['id']} {c['dead']} (이미 확인)"); continue
            ok, why = probe(c['id'])
            checked += 1
            if ok:
                c['verified'] = True
                c.pop('dead', None)
                alive.append(c)
                print(f"   ✓ {c['id']} {why} — {(c.get('title') or '')[:48]}")
            else:
                c['dead'] = why
                c.pop('verified', None)
                print(f"   ✗ {c['id']} {why}")
        e['top'] = tops
        e['usable'] = len(alive)
        e['best'] = alive[0] if alive else None
        e['verified_at'] = '2026-09-30'
        with io.open(CC, 'w', encoding='utf-8') as fh:
            json.dump(cc, fh, ensure_ascii=False, indent=2)     # 끊겨도 남는다
        print(f"   → 살아 있는 소스 {len(alive)}건" + ('' if alive else '  ★소스 없음 — 이 작품은 만들 수 없다'))
        if checked >= args.limit:
            break
    print(f'\n두들긴 후보 {checked}건')
    return 0


if __name__ == '__main__':
    sys.exit(main())
