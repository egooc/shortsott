# -*- coding: utf-8 -*-
"""새 레퍼런스 채널을 발굴한다 — 이미 아는 채널의 «작품»을 씨앗으로.

    python scripts/discover_channels.py [--limit 12] [--report]

왜 (2026-09-30 소유주: "일단 래퍼런스 채널들 더 확장해서 찾아서 화이트리스트 보자고.
    고작 15편으로 뭘 봐.")
  소유주가 준 목록(채널 299개)은 다 훑었다. 화이트리스트 표본이 아직 작아서
  «화이트리스트가 효과 있나»를 판정할 수 없다 — 15편으로는 아무것도 못 본다.
  표본을 키우려면 채널을 더 찾아야 한다.

어떻게 찾나 — **이미 아는 작품으로 검색해 같은 포맷 채널을 줍는다.**
  화이트리스트 작품 제목으로 검색하면 그 작품을 리캡한 채널들이 나온다.
  우리 길이대(61~200초)에 있고 차단이 없는 영상을 올린 채널이면 후보다.
  `rival-scout.js` 가 같은 발상이었지만 **우리가 만든 영화**로만 검색했다.
  지금은 화이트리스트가 136건이라 씨앗이 훨씬 넓다.

★이미 본 채널은 건너뛴다(`reference_channels.json`). 새것만 쌓는다.
★할당량: search 100 유닛 × 작품당 1회. 하루 90작품이 한계다. 429 면 즉시 멈춘다.
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
KNOWN = os.path.join(ROOT, 'server', 'data', 'reference_channels.json')
SEEN = os.path.join(ROOT, 'server', 'data', 'pdf_channels.json')
OUT = os.path.join(ROOT, 'server', 'data', 'discovered_channels.json')
STATE = os.path.join(ROOT, 'server', 'data', 'discover_state.json')


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


def write_json(p, d):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, indent=2)


def api(endpoint, **params):
    params['key'] = (os.environ.get('YOUTUBE_API_KEY_SEARCH') or os.environ['YOUTUBE_API_KEY'])
    url = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?' + urllib.parse.urlencode(params)
    api_quota.spend('discovery_search', endpoint)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            api_quota.mark_blocked('discover_channels', f'{endpoint} {exc.code}')
            raise SystemExit(f'★할당량 소진(HTTP {exc.code}). 멈춘다 — 이어 돌리면 빈 결과가 «없음»으로 남는다.')
        raise


def iso_seconds(t):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', t or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=12)
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()
    load_env()

    found = read_json(OUT, {})
    if args.report:
        rows = sorted(found.items(), key=lambda kv: -kv[1]['hits'])
        print(f'발굴한 새 채널 {len(rows)}곳')
        for cid, v in rows[:40]:
            print(f"   {v['title'][:30]:32} 씨앗 {v['hits']:2}건 · {cid}")
        return 0

    known = set(read_json(KNOWN, {})) | set(read_json(SEEN, {})) | set(found)
    state = read_json(STATE, {'done': []})
    done = set(state['done'])
    wl = read_json(WHITELIST, [])
    seeds = [w for w in wl if w['en'] not in done]
    seeds.sort(key=lambda w: -w['views'])
    seeds = seeds[:args.limit]
    print(f'씨앗 작품 {len(seeds)}건 · 이미 아는 채널 {len(known)}곳')

    for w in seeds:
        q = f"{w['en']} {w.get('year') or ''} recap".strip()
        res = api('search', part='snippet', q=q, type='video', maxResults=50, order='relevance')
        ids = [x['id']['videoId'] for x in res.get('items', []) if x['id'].get('videoId')]
        new_here = {}
        for i in range(0, len(ids), 50):
            det = api('videos', part='snippet,contentDetails', id=','.join(ids[i:i + 50]))
            for it in det.get('items', []):
                sec = iso_seconds(it['contentDetails'].get('duration'))
                rr = it['contentDetails'].get('regionRestriction') or {}
                # 실격은 지역 차단뿐이다. ★소유권 매칭(licensedContent)으로 건너뛰지 않는다
                #   — 2026-09-30 철회. 공식 권리자 채널은 항상 매칭이라, 건너뛰면 발굴에서
                #   공식 무료 채널이 통째로 빠진다(이 스크립트가 찾아야 할 바로 그것들이다).
                if not (61 <= sec <= 200) or rr.get('blocked'):
                    continue
                cid = it['snippet'].get('channelId')
                if not cid or cid in known:
                    continue
                new_here.setdefault(cid, it['snippet'].get('channelTitle') or '')
        for cid, title in new_here.items():
            rec = found.setdefault(cid, {'title': title, 'hits': 0, 'seeds': []})
            rec['hits'] += 1
            rec['seeds'].append(w['en'])
        done.add(w['en'])
        state['done'] = sorted(done)
        write_json(OUT, found)
        write_json(STATE, state)
        print(f"  {w['en'][:32]:34} 새 채널 {len(new_here):2}곳")

    print(f'\n발굴 누적 {len(found)}곳 · 씨앗 소진 {len(done)}/{len(wl)}')
    print('다음: python scripts/scan_pdf_channels.py 와 같은 방식으로 규모를 재라')
    return 0


if __name__ == '__main__':
    sys.exit(main())
