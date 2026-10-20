# -*- coding: utf-8 -*-
"""경쟁 채널 업로드 시각 분포(카이안 K16, 10-19) — 채널 최근 N편의 공개 시각을 KST 시각대로 센다(API 0원).
레인마다 레퍼런스 2곳 × 15편 = 30편. «우리 예약 슬롯을 경쟁보다 1~2시간 앞에» 재배치안의 근거.

    python scripts/publish_hours.py <레인>[:shorts]=<UC…|@핸들>[,<UC…|@핸들>] ... [--n 15] [--json out.json]

RSS(feeds/videos.xml)는 10-19 현재 404 라, 채널 /videos(또는 /shorts) 페이지에서 영상 id 를 읽고
영상 페이지의 publishDate(초·시간대 포함)를 읽는다. 요청 사이 4초, 403·429 가 나면 그 자리에서 전부 멈춘다(우회 금지).

--api (10-20): 발굴용 키(.env YOUTUBE_API_KEY_SEARCH)로 channels(forHandle)·playlistItems·videos.list — 채널당 2~3단위, 검색 0.
     정확한 공개 시각 + 조회수. 표에 «조회 가중» 칸과 «제안 슬롯»(조회 가중 최빈 시각 1~2시간 앞, K16)을 더한다.
     --slot 레인=HH[,HH] 로 지금 우리 슬롯을 주면 제안과 나란히 보인다. 기본 --n 30.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
UA = {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko'}


class Blocked(Exception):
    pass


def get(url):
    time.sleep(4)
    try:
        return _get(url)
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise Blocked(f'{e.code} {url}')
        raise


def _get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def feed(c, shorts=False, n=15):
    """채널 하나 → (이름, [{at, hour, wd, id}])."""
    base = f'https://www.youtube.com/channel/{c}' if c.startswith('UC') and len(c) == 24 else 'https://www.youtube.com/' + urllib.parse.quote(c)
    html = get(base + ('/shorts' if shorts else '/videos'))
    m = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    name = m.group(1) if m else c
    ids = list(dict.fromkeys(re.findall(r'"videoId":"([\w-]{11})"', html)))[:n]
    out = []
    for vid in ids:
        d = re.search(r'"publishDate":"([^"]+)"', get(f'https://www.youtube.com/watch?v={vid}'))
        if not d:
            continue
        at = datetime.fromisoformat(d.group(1)).astimezone(KST)
        out.append({'id': vid, 'at': at.isoformat(), 'hour': at.hour, 'wd': '월화수목금토일'[at.weekday()]})
    return name, out


def _env_key():
    for line in (Path(__file__).resolve().parents[1] / '.env').read_text(encoding='utf-8').splitlines():
        if line.startswith('YOUTUBE_API_KEY_SEARCH='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    return None


def api_feed(c, shorts=False, n=30, key=None, units=None):
    """→ (채널 이름, [{id, at, hour, wd, views, sec}]) — 쇼츠 레인은 60초 이하만, 아니면 61초 이상만."""
    def call(ep, **q):
        import api_quota   # 발굴 키 공용 쿼터 장부(10-20)
        try:
            api_quota.spend('publish_hours', ep)
        except api_quota.QuotaStop as e:
            raise Blocked(str(e))
        units[0] += 1
        url = f'https://www.googleapis.com/youtube/v3/{ep}?' + urllib.parse.urlencode({**q, 'key': key})
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                api_quota.mark_blocked('publish_hours', f'{ep} {e.code}')
                raise Blocked(f'{ep} {e.code}')
            raise
    if c.startswith('@'):
        it = (call('channels', part='snippet', forHandle=c[1:]).get('items') or [None])[0]
        if not it:
            raise ValueError(f'handle 못 풂 {c}')
        cid, name = it['id'], it['snippet']['title']
    else:
        cid, name = c, c
    ids, page = [], None
    for _ in range(4):
        j = call('playlistItems', part='contentDetails', playlistId='UU' + cid[2:], maxResults=50, **({'pageToken': page} if page else {}))
        ids += [x['contentDetails']['videoId'] for x in j.get('items', [])]
        page = j.get('nextPageToken')
        if len(ids) >= n * 3 or not page:
            break
    out = []
    for i in range(0, len(ids), 50):
        for v in call('videos', part='snippet,statistics,contentDetails', id=','.join(ids[i:i + 50])).get('items', []):
            name = v['snippet']['channelTitle']
            m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', v['contentDetails']['duration']) or None
            sec = sum(int(x or 0) * k for x, k in zip(m.groups(), (3600, 60, 1))) if m else 0
            if (sec <= 60) != shorts:
                continue
            at = datetime.fromisoformat(v['snippet']['publishedAt'].replace('Z', '+00:00')).astimezone(KST)
            out.append({'id': v['id'], 'at': at.isoformat(), 'hour': at.hour, 'wd': '월화수목금토일'[at.weekday()],
                        'views': int(v['statistics'].get('viewCount', 0)), 'sec': sec})
    out.sort(key=lambda r: r['at'], reverse=True)
    return name, out[:n]


def suggest(hw):
    """조회 가중 최빈 시각 h → «h-2~h-1시» 제안."""
    if not hw:
        return None
    h = max(hw, key=hw.get)
    return {'peak': h, 'slot': [(h - 2) % 24, (h - 1) % 24]}


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    out, n = None, 15
    use_api = '--api' in argv
    argv = [a for a in argv if a != '--api']
    slots = {}
    while '--slot' in argv:
        i = argv.index('--slot'); k, _, v = argv[i + 1].partition('='); slots[k.split(':')[0]] = v; argv = argv[:i] + argv[i + 2:]
    key, units = (_env_key() if use_api else None), [0]
    if use_api and not key:
        print('⚠ .env 에 YOUTUBE_API_KEY_SEARCH 없음 — --api 불가')
        return 5
    if use_api:
        n = 30
    if '--json' in argv:
        i = argv.index('--json'); out = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    if '--n' in argv:
        i = argv.index('--n'); n = int(argv[i + 1]); argv = argv[:i] + argv[i + 2:]
    res = {}
    for a in argv:
        lane, _, chans = a.partition('=')
        lane, _, kind = lane.partition(':')
        rows, names = [], []
        for c in chans.split(','):
            try:
                name, vids = api_feed(c.strip(), kind == 'shorts', n, key, units) if use_api else feed(c.strip(), kind == 'shorts', n)
            except Blocked as e:
                print(f'멈춤: {e} — 오늘은 더 요청하지 않는다')
                if out:
                    Path(out).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                return 3
            except Exception as e:
                print(f'{lane}: {c} 실패 {e}')
                continue
            names.append(f'{name}({len(vids)})')
            rows += [dict(v, channel=name) for v in vids]
        h = Counter(r['hour'] for r in rows)
        top = h.most_common(3)
        hw = Counter()
        for r in rows:
            hw[r['hour']] += r.get('views', 0)
        sg = suggest(hw) if use_api else None
        res[lane] = {'channels': names, 'n': len(rows), 'hours': dict(sorted(h.items())), 'top': top, 'videos': rows,
                     'views_by_hour': dict(sorted(hw.items())) if use_api else None, 'suggest': sg, 'ours': slots.get(lane)}
        print(f'{lane} · {" + ".join(names)} · {len(rows)}편 · 최빈 시각 ' + ', '.join(f'{k:02d}시 {n}편' for k, n in top))
        print('   편수   ' + ' '.join(f'{k:02d}:{h[k]}' for k in range(24) if h[k]))
        if use_api:
            tot = sum(hw.values()) or 1
            print('   조회%  ' + ' '.join(f'{k:02d}:{round(100 * hw[k] / tot)}' for k in range(24) if hw[k]))
            if sg:
                print(f'   제안   조회 가중 최빈 {sg["peak"]:02d}시 → {sg["slot"][0]:02d}~{sg["slot"][1]:02d}시 예약(K16 1~2시간 앞)' +
                      (f' · 지금 우리 {slots[lane]}시' if lane in slots else ''))
    if use_api:
        print(f'쿼터 {units[0]}단위(검색 0)')
    if out:
        Path(out).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
