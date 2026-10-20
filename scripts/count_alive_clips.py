# -*- coding: utf-8 -*-
"""그 영화 클립이 **유튜브에 몇 편이나 살아 있나**를 센다 — 화이트리스트의 진짜 순위.

    python scripts/count_alive_clips.py [--limit 25] [--report]

왜 (2026-09-29 소유주: "지금 채널에 가장 많이 올라와 있는 영화가 화이트리스트 1순위 풀인 거야.
    특정 채널에 1개 살아있다고 안전한 건 아니라는 거지")

  맞다. 내가 지은 화이트리스트 136건 중 **118건이 «한 채널에 한 편»** 이었다.
  그건 그 채널이 운이 좋았거나 아직 안 걸린 것일 수도 있다. 증거가 아니다.
  게다가 내 표본은 채널당 6편씩만 얕게 캔 것이라, 편 수가 적은 것이
  «드물어서»인지 «내가 덜 캐서»인지 구분되지 않는다.

  → 그래서 **채널 표본이 아니라 유튜브 전체**에서 센다.
    우리 길이대(61~200초) 클립이 몇 편 살아 있고 몇 편이 막혀 있나.
    막힌 영상은 내려가거나 차단 표시가 붙으므로, **살아 있는 수가 곧 그 권리자의 관용도**다.

  기존 `survivor-signal.js` 가 같은 생각으로 `live_in_our_band` 를 셌다(사례 91).
  이건 그것을 화이트리스트 작품에 대해 다시 세는 것이고, **차단된 수도 함께** 센다 —
  살아 있는 수만 보면 «많이 올라와서 많이 살아 있는» 것과 구별이 안 된다.

★★차단 신호는 **둘**이다(2026-09-29 실측, 메모리 licensed-content-is-the-second-block-signal).
  `contentDetails.regionRestriction.blocked` 하나만 보면 놓친다.
  같은 소스로 같은 시각에 올린 ko/ja 한 쌍에서:
  ```
              regionRestriction   licensedContent   조회수
  ko          없음                false             2,847
  ja          없음                **true**          **4**
  ```
  소유권이 매칭되면 **차단 국가 목록 없이도 도달이 죽는다.** `check-claims.js` 는
  2026-09-29 에 고쳤는데 이 파이썬 쪽은 2026-09-30 까지 신호 하나만 보고 있었다 —
  «안전을 재려고 만든 도구»가 불충분한 신호로 재고 있었다.

★할당량: search 는 호출당 100 유닛. 작품당 2회 = 200 유닛. 하루 50작품이 한계다.
  429 가 뜨면 **즉시 멈춘다** — 조용히 «0편»으로 기록하면 «없다»로 잘못 읽힌다(사례 151).
"""
import argparse
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

import api_quota  # 발굴 키 쿼터 장부(10-20)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHITELIST = os.path.join(ROOT, 'server', 'data', 'whitelist_works.json')
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')
OUT = os.path.join(ROOT, 'server', 'data', 'alive_clip_counts.json')

LO, HI = 61, 200


def load_env():
    try:
        for line in open(os.path.join(ROOT, '.env'), encoding='utf-8', errors='replace'):
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
    except OSError:
        pass


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def api(endpoint, **params):
    params['key'] = (os.environ.get('YOUTUBE_API_KEY_SEARCH') or os.environ['YOUTUBE_API_KEY'])
    url = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?' + urllib.parse.urlencode(params)
    api_quota.spend('discovery_search', endpoint)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            api_quota.mark_blocked('count_alive_clips', f'{endpoint} {exc.code}')
            raise SystemExit(f'★유튜브 API 할당량 소진(HTTP {exc.code}). 여기서 멈춘다 — '
                             '이어 돌리면 «0편»으로 잘못 기록된다.')
        raise


def iso_seconds(t):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', t or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def count(title, year):
    """우리 길이대에 살아 있는 클립 수와 막힌 수. 검색 두 번으로 넓게 훑는다."""
    ids, seen = [], set()
    for q in (f'{title} {year} clip'.strip(), f'{title} scene'):
        res = api('search', part='snippet', q=q, type='video', maxResults=50, order='relevance')
        for x in res.get('items', []):
            vid = x['id'].get('videoId')
            if vid and vid not in seen:
                seen.add(vid)
                ids.append(vid)
    alive = blocked = licensed = 0
    channels = set()
    for i in range(0, len(ids), 50):
        det = api('videos', part='snippet,contentDetails', id=','.join(ids[i:i + 50]))
        for it in det.get('items', []):
            sec = iso_seconds(it['contentDetails'].get('duration'))
            if not (LO <= sec <= HI):
                continue
            rr = it['contentDetails'].get('regionRestriction') or {}
            if rr.get('blocked'):
                blocked += 1
            else:
                # ★소유권 매칭(licensedContent)은 «살아 있음»으로 센다 — 2026-09-30 철회.
                #   매칭은 도달을 죽이지 않는다(2026-06 ja: 44/46 매칭에 편당 8,288회).
                #   공식 권리자 채널은 항상 매칭이므로 죽은 것으로 세면 등급이 거꾸로 나온다.
                #   따로 세어서 보여는 준다 — 소재의 권리 상태 정보로는 여전히 쓸모가 있다.
                if it['contentDetails'].get('licensedContent') is True:
                    licensed += 1
                alive += 1
                channels.add(it['snippet'].get('channelId'))
    return {'searched': len(ids), 'alive_in_band': alive, 'blocked_in_band': blocked,
            'licensed_in_band': licensed, 'channels': len(channels)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=25)
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()
    load_env()

    store = read_json(OUT, {})
    if args.report:
        rows = sorted(store.items(), key=lambda kv: -kv[1]['alive_in_band'])
        print(f"조사 {len(rows)}건 — 살아 있는 클립 수 순")
        print(f"{'작품':40} {'살아있음':>7} {'막힘':>5} {'채널':>5}")
        for k, v in rows[:40]:
            dead = v['blocked_in_band'] + v.get('licensed_in_band', 0)
            tot = v['alive_in_band'] + dead
            rate = f"{100 * dead / tot:.0f}%" if tot else '-'
            mark = '' if 'licensed_in_band' in v else '  ★신호 하나로만 잰 것 — 다시 재라'
            print(f"  {k[:38]:40} {v['alive_in_band']:7} {v['blocked_in_band']:5} "
                  f"{v['channels']:5}  차단률 {rate}{mark}")
        return 0

    cat = read_json(CATALOG, {}).get('movies', {})
    wl = read_json(WHITELIST, [])
    banned = {(v.get('title_en') or '').lower() for v in cat.values()
              if v.get('distributor_tier') == 'banned'}
    todo = [w for w in wl if w['en'] not in store and w['en'].lower() not in banned]
    todo.sort(key=lambda w: -w['views'])
    todo = todo[:args.limit]
    print(f'화이트리스트 {len(wl)}건 · 이번에 셀 것 {len(todo)}건 (이미 센 것 {len(store)})')
    for w in todo:
        r = count(w['en'], w.get('year') or '')
        store[w['en']] = r
        with io.open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(store, fh, ensure_ascii=False, indent=2)
        dead = r['blocked_in_band'] + r['licensed_in_band']
        tot = r['alive_in_band'] + dead
        rate = f"{100 * dead / tot:.0f}%" if tot else '-'
        print(f"  {w['en'][:34]:36} 살아있음 {r['alive_in_band']:3} · 막힘 {r['blocked_in_band']:3} "
              f"· 소유권 {r['licensed_in_band']:3} · 채널 {r['channels']:3} · 차단률 {rate}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
