"""비슷한 롱폼 채널의 터진 편 — 채널 롱폼 중앙값 ×3 이상(소유주 10-22 «주제는 터진 편 레퍼런스 확인 뒤, 그 열 없으면 탈락»).

  python -X utf8 ko-corp/tools/ref_outliers.py                 표·ko-corp/ref_outliers.json 갱신
  python -X utf8 ko-corp/tools/ref_outliers.py --grep 맥주 하이트   제목에 낱말이 든 편만(배수 무관) 함께 보기

채널 = 레퍼런스 카드(docs/category-cards/2026-10-18-ko-corp-reference.md) 표. 채널 ID 는 처음 한 번만 search.list(100단위)로 찾아 CHANNELS 캐시에 남긴다.
기준: 업로드 목록 최대 200편 중 8분 이상 롱폼, 공개 3일 지난 최근 30편의 조회 중앙값. 배수 ≥ 3 = 터진 편. 발굴용 키(.env YOUTUBE_API_KEY_SEARCH), 키 값은 출력하지 않는다.
"""
import datetime
import json
import re
import statistics
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'ko-corp' / 'ref_outliers.json'
CACHE = ROOT / 'ko-corp' / 'tools' / 'ref_channels.json'
NAMES = ['몰랐던 경제', '무궁화경제', '무릎탁경제학', '제국 그 후', '새싹경제학', '경제상담소', '소비더머니', '당신이 몰랐던 이야기', '더재벌TV']
units = 0


def key():
    for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
        if line.startswith('YOUTUBE_API_KEY_SEARCH='):
            return line.split('=', 1)[1].strip().strip('"')
    raise SystemExit('.env 에 YOUTUBE_API_KEY_SEARCH 없음')


def api(ep, cost=1, **q):
    global units
    units += cost
    q['key'] = KEY
    try:
        with urllib.request.urlopen(f'https://www.googleapis.com/youtube/v3/{ep}?' + urllib.parse.urlencode(q), timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{ep} HTTP {e.code} — 멈춤(다른 키로 넘어가지 않음)')


def secs(iso):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso or '')
    return sum(int(x or 0) * k for x, k in zip(m.groups(), (3600, 60, 1))) if m else 0


def channel_ids():
    ids = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else {}
    for n in NAMES:
        if n not in ids:
            items = api('search', 100, part='snippet', type='channel', q=n, maxResults=5, regionCode='KR').get('items', [])
            hit = next((i for i in items if i['snippet']['channelTitle'].replace(' ', '') == n.replace(' ', '')), None)
            ids[n] = hit['snippet']['channelId'] if hit else None
    CACHE.write_text(json.dumps(ids, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return ids


def long_videos(cid):
    up = 'UU' + cid[2:]
    vids, tok = [], None
    for _ in range(4):
        r = api('playlistItems', part='contentDetails', playlistId=up, maxResults=50, **({'pageToken': tok} if tok else {}))
        vids += [i['contentDetails']['videoId'] for i in r.get('items', [])]
        tok = r.get('nextPageToken')
        if not tok:
            break
    out = []
    for i in range(0, len(vids), 50):
        r = api('videos', part='snippet,contentDetails,statistics', id=','.join(vids[i:i + 50]))
        for v in r.get('items', []):
            if secs(v['contentDetails']['duration']) >= 480:
                out.append({'id': v['id'], 'title': v['snippet']['title'], 'at': v['snippet']['publishedAt'][:10],
                            'views': int(v['statistics'].get('viewCount', 0)), 'min': round(secs(v['contentDetails']['duration']) / 60)})
    return out


def search(q):
    """레퍼런스 9채널 밖까지: 검색 상위 롱폼마다 그 채널 중앙값을 재서 배수를 붙인다(search 100단위 + 채널당 몇 단위)."""
    cut = (datetime.date.today() - datetime.timedelta(days=3)).isoformat()
    items = api('search', 100, part='snippet', type='video', q=q, maxResults=25, regionCode='KR', relevanceLanguage='ko', videoDuration='long').get('items', [])
    items += api('search', 100, part='snippet', type='video', q=q, maxResults=25, regionCode='KR', relevanceLanguage='ko', videoDuration='medium').get('items', [])
    meds, rows = {}, []
    for it in items:
        cid = it['snippet']['channelId']
        if cid not in meds:
            vs = long_videos(cid)
            base = [v['views'] for v in vs if v['at'] <= cut][:30]
            meds[cid] = (statistics.median(base) if base else 0, {v['id']: v for v in vs})
        med, vs = meds[cid]
        v = vs.get(it['id']['videoId'])
        if v and med:
            rows.append(dict(v, channel=it['snippet']['channelTitle'], median=med, ratio=round(v['views'] / med, 1)))
    rows.sort(key=lambda v: -v['ratio'])
    print(f'검색 «{q}» 롱폼 {len(rows)}편 · API {units}단위')
    for v in rows:
        print(f'×{v["ratio"]:<5} {v["min"]:>3}분 {v["views"]:>9,} {v["channel"]} {v["at"]} {v["id"]} {v["title"]}')


def main():
    global KEY
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    KEY = key()
    if '--search' in sys.argv:   # python ko-corp/tools/ref_outliers.py --search "진로그룹"
        search(sys.argv[sys.argv.index('--search') + 1])
        return
    words = sys.argv[sys.argv.index('--grep') + 1:] if '--grep' in sys.argv else []
    cut = (datetime.date.today() - datetime.timedelta(days=3)).isoformat()
    res = {'at': datetime.datetime.now().isoformat(timespec='minutes'), 'channels': [], 'outliers': [], 'grep': []}
    for n, cid in channel_ids().items():
        if not cid:
            print(f'{n}: 채널 못 찾음')
            continue
        vs = long_videos(cid)
        base = [v['views'] for v in vs if v['at'] <= cut][:30]
        med = statistics.median(base) if base else 0
        res['channels'].append({'name': n, 'id': cid, 'long': len(vs), 'median': med})
        print(f'{n}: 롱폼 {len(vs)}편 · 중앙 {med:,.0f}')
        for v in vs:
            v.update(channel=n, ratio=round(v['views'] / med, 1) if med else None)
            if med and v['ratio'] >= 3:
                res['outliers'].append(v)
            if words and any(w.lower() in v['title'].lower() for w in words):
                res['grep'].append(v)
    res['outliers'].sort(key=lambda v: -v['ratio'])
    res['units'] = units
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'\n터진 편(×3 이상) {len(res["outliers"])}개 · API {units}단위')
    for v in res['outliers'][:40]:
        print(f'×{v["ratio"]:<5} {v["views"]:>9,} {v["channel"]} {v["at"]} {v["id"]} {v["title"]}')
    if words:
        print(f'\n제목에 {words}: {len(res["grep"])}편')
        for v in res['grep']:
            print(f'×{v["ratio"]} {v["views"]:,} {v["channel"]} {v["at"]} {v["id"]} {v["title"]}')


if __name__ == '__main__':
    main()
