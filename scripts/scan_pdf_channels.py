# -*- coding: utf-8 -*-
"""소유주가 준 목록에서 나온 채널들을 «규모·길이·차단»으로 훑는다.

    python scripts/scan_pdf_channels.py [--min-videos 2] [--limit 60]

왜 (2026-09-28 소유주: "내가 보내준 파일 있잖아. 미드폼 리스트업 엑셀 그거 어디갔어
    거기에 채널 많이 있었는데")
  2026-09-25 에 받은 목록(영상 881건)에서 나는 «살아 있는 영화»만 뽑고 **채널은 버렸다.**
  정작 소재 고갈을 막는 데 필요한 것이 그 채널 목록이었다. 299개가 들어 있었다.

  같은 날 소유주가 짚은 또 하나: **한국 채널만 볼 이유가 없다.**
  영어권 레퍼런스 6곳을 재 보니 761편 차단 0이었다(우리는 66편 중 30편 차단).
  그래서 여기서는 언어를 가리지 않는다.

무엇으로 거르나 — 소리를 듣기 «전에» 값싸게 자를 수 있는 것만 본다
  · 우리 길이대(61~200초)에 몇 편이나 있나  — 광맥의 크기
  · 차단된 편이 몇이나 되나                  — 0 이어야 «견딘 증거»다
  · 중앙 길이                                 — 우리(90~100초)와 겹치는가
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'server', 'data', 'pdf_channels.json')
OUT = os.path.join(ROOT, 'server', 'data', 'reference_channels.json')


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


def api(endpoint, **params):
    params['key'] = os.environ['YOUTUBE_API_KEY']
    url = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def iso_seconds(t):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', t or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def scan(cid, pages=3):
    info = api('channels', part='contentDetails,snippet,statistics', id=cid).get('items') or []
    if not info:
        return None
    info = info[0]
    uploads = info['contentDetails']['relatedPlaylists']['uploads']
    ids, token = [], ''
    for _ in range(pages):
        extra = {'pageToken': token} if token else {}
        page = api('playlistItems', part='contentDetails', maxResults=50, playlistId=uploads, **extra)
        ids += [x['contentDetails']['videoId'] for x in page.get('items', [])]
        token = page.get('nextPageToken', '')
        if not token:
            break
    secs, blocked, band_views = [], 0, []
    for i in range(0, len(ids), 50):
        chunk = api('videos', part='contentDetails,statistics', id=','.join(ids[i:i + 50]))
        for it in chunk.get('items', []):
            s = iso_seconds(it['contentDetails'].get('duration'))
            rr = it['contentDetails'].get('regionRestriction') or {}
            b = len(rr.get('blocked') or [])
            secs.append(s)
            blocked += 1 if b else 0
            if not b and 61 <= s <= 200:
                band_views.append(int(it.get('statistics', {}).get('viewCount') or 0))
    if not secs:
        return None
    ordered = sorted(secs)
    return {
        'channel_id': cid,
        'title': info['snippet']['title'],
        'subs': int(info.get('statistics', {}).get('subscriberCount') or 0),
        'videos': len(secs),
        'blocked': blocked,
        'in_band': len(band_views),
        'median_sec': ordered[len(ordered) // 2],
        'band_avg_views': int(sum(band_views) / len(band_views)) if band_views else 0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-videos', type=int, default=2, dest='min_videos')
    ap.add_argument('--limit', type=int, default=60)
    ap.add_argument('--pages', type=int, default=3)
    args = ap.parse_args()
    load_env()

    src = read_json(SRC, {})
    store = read_json(OUT, {})
    seeds = [c for c, v in sorted(src.items(), key=lambda kv: -kv[1]['videos'])
             if v['videos'] >= args.min_videos and c not in store][:args.limit]
    print(f'목록 채널 {len(src)} · 이번에 훑을 것 {len(seeds)} · 이미 본 것 {len(store)}')
    for c in seeds:
        try:
            r = scan(c, args.pages)
        except Exception as exc:
            print(f'  실패 {c}: {str(exc)[:90]}')
            continue
        if not r:
            continue
        store[c] = r
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(store, fh, ensure_ascii=False, indent=2)
        print(f"  {r['title'][:28]:30} 구독 {r['subs']:>9,} · {r['videos']:3}편 · "
              f"차단 {r['blocked']:3} · 대역 {r['in_band']:3} · 중앙 {r['median_sec']:3}초 · "
              f"대역평균 {r['band_avg_views']:>10,}")

    good = [v for v in store.values() if v['blocked'] == 0 and v['in_band'] >= 15]
    good.sort(key=lambda v: -v['in_band'])
    print(f"\n★캘 만한 채널 (차단 0 · 우리 대역 15편+) {len(good)}곳")
    for v in good[:30]:
        print(f"   {v['title'][:26]:28} 대역 {v['in_band']:3}편 · 중앙 {v['median_sec']:3}초 · "
              f"평균 {v['band_avg_views']:>10,} · {v['channel_id']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
