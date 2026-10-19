# -*- coding: utf-8 -*-
"""경쟁 채널 업로드 시각 분포(카이안 K16, 10-19) — 채널 최근 N편의 공개 시각을 KST 시각대로 센다(API 0원).
레인마다 레퍼런스 2곳 × 15편 = 30편. «우리 예약 슬롯을 경쟁보다 1~2시간 앞에» 재배치안의 근거.

    python scripts/publish_hours.py <레인>[:shorts]=<UC…|@핸들>[,<UC…|@핸들>] ... [--n 15] [--json out.json]

RSS(feeds/videos.xml)는 10-19 현재 404 라, 채널 /videos(또는 /shorts) 페이지에서 영상 id 를 읽고
영상 페이지의 publishDate(초·시간대 포함)를 읽는다. 요청 사이 4초, 403·429 가 나면 그 자리에서 전부 멈춘다(우회 금지).
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


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    out, n = None, 15
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
                name, vids = feed(c.strip(), kind == 'shorts', n)
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
        res[lane] = {'channels': names, 'n': len(rows), 'hours': dict(sorted(h.items())), 'top': top, 'videos': rows}
        print(f'{lane} · {" + ".join(names)} · {len(rows)}편 · 최빈 시각 ' + ', '.join(f'{k:02d}시 {n}편' for k, n in top))
        print('   ' + ' '.join(f'{k:02d}:{h[k]}' for k in range(24) if h[k]))
    if out:
        Path(out).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
