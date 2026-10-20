# -*- coding: utf-8 -*-
"""댓글에서 나온 제목 후보를 **실제 작품인지** 확인한다.

    python scripts/verify_title_hints.py [--limit 200]

왜 (2026-09-29)
  `title_from_comments.py` 가 385편에서 후보를 뽑았다. 그런데 댓글에는 대사 인용도 따옴표에
  들어 있어서 «I order you to stop dying» 같은 것이 제목처럼 잡힌다.
  그대로 올리면 예전에 해시태그가 작품명으로 들어갔던 사고가 되풀이된다.

어떻게 거르나 — **유튜브 검색으로 실재를 확인한다.**
  후보 이름으로 검색해서 그 이름이 «작품»으로 취급되는지 본다. 실재하는 영화·드라마면
  공식 예고편·클립 채널이 상위에 뜬다. 대사 조각이면 아무것도 안 걸리거나 엉뚱한 게 나온다.
  검색 결과 제목에 후보 이름이 **그대로** 들어 있는 건수를 센다.

★그래도 «확정»은 아니다. 여기서 살아남은 것만 사람이 보는 목록에 올린다.
  마지막 판단은 여전히 사람(또는 나)이 한다 — 기계가 제목을 지어내면 화이트리스트가 썩는다.
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
HINTS = os.path.join(ROOT, 'server', 'data', 'title_hints.json')
STORE = os.path.join(ROOT, 'server', 'data', 'narration_probe.json')
OUT = os.path.join(ROOT, 'server', 'data', 'title_verified.json')


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
        with open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()


def search_hits(name):
    """이 이름이 «작품»으로 통하는가. 검색 결과 제목에 그대로 들어 있는 건수."""
    q = urllib.parse.urlencode({'part': 'snippet', 'q': f'{name} movie trailer',
                                'type': 'video', 'maxResults': 8,
                                'key': (os.environ.get('YOUTUBE_API_KEY_SEARCH') or os.environ['YOUTUBE_API_KEY'])})
    api_quota.spend('discovery_search', 'search')
    try:
        with urllib.request.urlopen('https://www.googleapis.com/youtube/v3/search?' + q, timeout=45) as r:
            data = json.load(r)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            api_quota.mark_blocked('verify_title_hints', f'search {exc.code}')
            raise
        return -1
    except Exception:
        return -1
    n = norm(name)
    if len(n) < 3:
        return 0
    hits = 0
    for it in data.get('items', []):
        title = norm(it['snippet'].get('title'))
        if n in title:
            hits += 1
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=200)
    ap.add_argument('--min-weight', type=int, default=2, dest='min_weight')
    args = ap.parse_args()
    load_env()

    hints = read_json(HINTS, {})
    store = read_json(STORE, {})
    done = read_json(OUT, {})

    # 후보를 «이름» 단위로 모은다 — 같은 이름이 여러 영상에서 나오면 그게 곧 중복도다.
    by_name = {}
    for vid, cands in hints.items():
        if store.get(vid, {}).get('film_en'):
            continue
        for name, weight in cands:
            if weight < args.min_weight:
                continue
            by_name.setdefault(name, []).append((vid, weight))
    order = sorted(by_name.items(), key=lambda kv: -sum(w for _, w in kv[1]))
    todo = [(n, v) for n, v in order if n not in done][:args.limit]
    print(f'후보 이름 {len(by_name)}개 · 이번에 확인할 것 {len(todo)}개 (이미 본 것 {len(done)})')

    for name, vids in todo:
        h = search_hits(name)
        done[name] = {'hits': h, 'videos': [v for v, _ in vids],
                      'weight': sum(w for _, w in vids)}
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(done, fh, ensure_ascii=False, indent=2)
        mark = '★작품' if h >= 3 else ('애매' if h >= 1 else '대사조각')
        print(f'  {mark:6} {name[:44]:46} 검색적중 {h:2} · 영상 {len(vids)}편 · 가중 {done[name]["weight"]}')

    strong = {n: v for n, v in done.items() if v['hits'] >= 3}
    print(f'\n★작품으로 확인된 이름 {len(strong)}개')
    for n, v in sorted(strong.items(), key=lambda kv: -len(kv[1]['videos']))[:30]:
        print(f'   {n[:40]:42} 영상 {len(v["videos"]):2}편 · 적중 {v["hits"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
