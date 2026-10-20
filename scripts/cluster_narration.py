# -*- coding: utf-8 -*-
"""**제목을 몰라도** 중복도를 센다 — 원고가 겹치면 같은 장면이다.

    python scripts/cluster_narration.py [--min-ch 2] [--resolve 8]

왜 (2026-09-29 소유주: "특정 채널에 1개 살아있다고 안전한건 아니라는거지" /
    2026-09-30 "고작 15편으로 뭘 봐")
  화이트리스트를 키우려고 제목을 알아내는 데 매달려 왔다. 그런데 제목은 **수단**이고
  소유주가 원한 것은 **중복도**다. 그리고 중복도는 제목 없이도 셀 수 있다.

  판독 중에 실제로 본 것:
  ```
  -t1rq4Kw5qc EdiraX   / AGBf_RzSS5E 눈물한가득   "allow kids in here to take a picture on a truck"
  OGX4_cUsAf8 ShockJnk / MeTHtojeXkw 눈물한가득   "My name is Javier Martinez... come see you for work"
  ByFpyMLd_ww CineApex / Mc7ikKemcKo CineApex    "that picture you just took, it was kind of a private moment"
  ```
  **세 쌍 다 서로 다른 채널에서 같은 장면을 올렸고 셋 다 차단 0이다.** 그게 안전 신호다.
  제목은 그 뒤에 붙이면 된다 — 오히려 대사를 그대로 검색하면 제목이 나온다(--resolve).

어떻게 묶나 — 원고에서 **영어 대사 5낱말 뭉치(shingle)** 를 뽑아 맞춰 본다.
  내레이션(한국어/해설)은 채널마다 다르지만 **원본 대사는 같다.** 그래서 대사만 쓴다.
  흔한 말("I don't know", "Are you okay")이 우연히 겹치는 것을 막으려고
  전체에서 3회 이상 나오는 뭉치는 버리고, 남은 뭉치가 3개 이상 겹칠 때만 같은 장면으로 본다.

★**무리로 잇지 마라(2026-09-30 실측).** 처음엔 합집합 찾기로 이어 붙였는데,
  이 채널들은 **한 편에 여러 장면을 엮은 모음**을 올린다. 모음 한 편이 두 장면을 다 담으면
  서로 다른 영화가 한 무리로 연결된다. 실제로 «Gifted Hands 교실» 과 «교도소 장면» 과
  «진통 9분 간격» 이 한 무리로 묶였고, 거기에 제목을 붙였으면 셋 다 오염됐다.
  → 그래서 **쌍(pair)만** 본다. 영상 하나가 «다른 채널 몇 곳과 장면을 나눠 갖나»를 센다.

★대사를 유튜브 API 로 검색하지 마라(2026-09-30 실측, 900유닛 헛씀).
  YouTube search 는 구문 일치를 하지 않는다 — 큰따옴표를 씌워도 무시하고,
  9건 전부 «It's Just A Prank» 같은 무관한 쇼츠만 돌려줬다. 제목은 **웹 검색**으로 찾아라.
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
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'server', 'data', 'narration_probe.json')
OUT = os.path.join(ROOT, 'server', 'data', 'scene_clusters.json')

K = 5              # 낱말 뭉치 길이
MAX_DF = 3         # 전체에서 이보다 많이 나오는 뭉치는 흔한 말이라 버린다
MIN_SHARED = 3     # 뭉치 3개 이상 겹쳐야 같은 장면(모음 영상의 우연한 겹침을 막는다)


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def write_json(p, d):
    with io.open(p, 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)


def load_env():
    try:
        for line in open(os.path.join(ROOT, '.env'), encoding='utf-8', errors='replace'):
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
    except OSError:
        pass


def api(endpoint, **params):
    params['key'] = (os.environ.get('YOUTUBE_API_KEY_SEARCH') or os.environ['YOUTUBE_API_KEY'])
    url = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?' + urllib.parse.urlencode(params)
    api_quota.spend('discovery_search', endpoint)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            api_quota.mark_blocked('cluster_narration', f'{endpoint} {exc.code}')
            raise SystemExit('★유튜브 API 할당량 소진(HTTP {}). 멈춘다.'.format(exc.code))
        raise


def shingles(text):
    """영어 대사에서만 뭉치를 뽑는다. 한글 해설은 채널마다 달라서 쓸모가 없다."""
    words = re.findall(r"[a-z']+", (text or '').lower())
    return {' '.join(words[i:i + K]) for i in range(max(0, len(words) - K + 1))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-ch', type=int, default=2, dest='min_ch')
    ap.add_argument('--resolve', type=int, default=0,
                    help='상위 N개 무리의 대사를 검색해 제목 후보를 찾는다')
    ap.add_argument('--show', type=int, default=25)
    args = ap.parse_args()

    store = read_json(STORE, {})
    sh = {vid: shingles(r.get('text')) for vid, r in store.items()}
    df = Counter()
    for s in sh.values():
        df.update(s)
    # 흔한 말을 버린다
    sh = {vid: {g for g in s if df[g] <= MAX_DF} for vid, s in sh.items()}

    # 뭉치 -> 영상 목록으로 뒤집고, 공유 수를 세서 이어 붙인다(합집합 찾기)
    inv = defaultdict(list)
    for vid, s in sh.items():
        for g in s:
            inv[g].append(vid)
    pair = Counter()
    for g, vids in inv.items():
        if len(vids) < 2:
            continue
        for i in range(len(vids)):
            for j in range(i + 1, len(vids)):
                pair[tuple(sorted((vids[i], vids[j])))] += 1

    # ★전이로 잇지 않는다. 영상별로 «장면을 나눠 갖는 다른 채널» 을 센다.
    share = defaultdict(set)
    for (a, b), n in pair.items():
        if n < MIN_SHARED:
            continue
        ca, cb = store[a]['channel'], store[b]['channel']
        if ca == cb:                    # 같은 채널의 재업은 중복도가 아니다
            continue
        share[a].add(b)
        share[b].add(a)

    rows = []
    for vid, mates in share.items():
        r = store[vid]
        chs = sorted({store[m]['channel'] for m in mates} | {r['channel']})
        if len(chs) < args.min_ch:
            continue
        quote = ' '.join(re.findall(r"[A-Za-z',.?! ]+", r.get('text') or '')[:1]).strip()[:120]
        rows.append({
            'video': vid, 'mates': sorted(mates), 'channels': chs, 'n_ch': len(chs), 'n_vid': len(mates) + 1,
            'views': r['views'] + sum(store[m]['views'] for m in mates),
            'film_en': r.get('film_en') or next(
                (store[m]['film_en'] for m in mates if store[m].get('film_en')), ''),
            'quote': quote,
        })
    rows.sort(key=lambda r: (-r['n_ch'], -r['views']))
    write_json(OUT, rows)

    print('원고 {}편 · 다른 채널과 장면이 겹치는 영상 {}편'.format(len(store), len(rows)))
    print('{:>3} {:>3} {:>12} {:24} {}'.format('채널', '편', '조회합', '제목', '대사'))
    for r in rows[:args.show]:
        print('{:>4} {:>4} {:>12,} {:24} {}'.format(
            r['n_ch'], r['n_vid'], r['views'], (r['film_en'] or '—')[:22], r['quote'][:64]))
    unknown = [r for r in rows if not r['film_en']]
    print('\n그중 제목 미확정 {}개 — 대사를 그대로 검색하면 제목이 나온다(--resolve N)'.format(len(unknown)))

    if args.resolve:
        load_env()
        print('\n--- 대사 검색으로 제목 찾기 ---')
        for r in unknown[:args.resolve]:
            q = '"{}"'.format(r['quote'][:70])
            res = api('search', part='snippet', q=q, type='video', maxResults=6, order='relevance')
            print('\n채널 {}곳 · {}'.format(r['n_ch'], r['quote'][:70]))
            print('   영상: ' + ' '.join([r['video']] + r['mates'][:3]))
            for it in res.get('items', []):
                print('   > {} — {}'.format(
                    it['snippet']['title'][:80], it['snippet']['channelTitle'][:24]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
