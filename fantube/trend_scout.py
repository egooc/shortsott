"""엔믹스 «오늘 터진» 쇼츠 찾기 — 같은 소스·같은 주제로 따라 만들 거리.

    python trend_scout.py [--period today|week] [--top 25] [--out <json>]

검색은 longform_competition.search(innertube Shorts 유형 + 기간, API 0원)를 그대로 쓴다.
상위 후보는 yt-dlp 로 올린 시각·채널을 받아 «시간당 조회수»로 줄 세운다(24시간 안 올라온 것만).
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, 'D:/midform/scripts')
import longform_competition as LC  # noqa: E402

LC.UPLOAD.setdefault('today', 2)
LC.UPLOAD.setdefault('hour', 1)
QUERIES = ['엔믹스', 'NMIXX', '엔믹스 규진', '규진', '엔믹스 해원', '엔믹스 설윤', '엔믹스 릴리', '엔믹스 배이', '엔믹스 지우',
           'NMIXX KYUJIN', '엔믹스 무대', '엔믹스 직캠', '엔믹스 예능']
OFFICIAL = {'NMIXX', 'JYP Entertainment', 'NMIXX Official'}


def meta(vid):
    r = subprocess.run(['yt-dlp', '-q', '--no-warnings', '--skip-download', '-j',
                        'https://www.youtube.com/shorts/' + vid], capture_output=True, text=True, encoding='utf-8')
    try:
        d = json.loads(r.stdout)
    except Exception:
        return None
    ts = d.get('timestamp') or (datetime.strptime(d['upload_date'], '%Y%m%d').replace(tzinfo=timezone.utc).timestamp()
                                if d.get('upload_date') else None)
    return {'timestamp': ts, 'views': d.get('view_count'), 'likes': d.get('like_count'), 'comments': d.get('comment_count'),
            'channel': d.get('channel'), 'handle': d.get('uploader_id'), 'subs': d.get('channel_follower_count'),
            'duration': d.get('duration'), 'title': d.get('title'), 'description': (d.get('description') or '')[:400]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--period', default='today', choices=['hour', 'today', 'week'])
    ap.add_argument('--top', type=int, default=25)
    ap.add_argument('--out', default='D:/volcano-runs/fantube/_trend/trend_%s.json' % time.strftime('%Y%m%d_%H%M'))
    a = ap.parse_args()
    seen = {}
    for q in QUERIES:
        for it in LC.search(q, a.period, pages=2):
            if any(k in (it.get('title') or '') + (it.get('channel') or '') for k in ('엔믹스', 'NMIXX', 'nmixx', '규진', '해원', '설윤', '릴리', '배이', '지우')):
                it.setdefault('queries', []).append(q)
                seen.setdefault(it['id'], it)
    cand = sorted(seen.values(), key=lambda x: -(x.get('view_count') or 0))[:a.top]
    now = time.time()
    rows = []
    for it in cand:
        m = meta(it['id']) or {}
        age_h = (now - m['timestamp']) / 3600 if m.get('timestamp') else None
        v = m.get('views') or it.get('view_count') or 0
        rows.append(dict(it, **m, age_h=round(age_h, 1) if age_h else None,
                         per_hour=int(v / max(age_h, 1)) if age_h else None,
                         official=(m.get('channel') or it.get('channel') or '') in OFFICIAL))
    rows.sort(key=lambda r: -(r.get('per_hour') or 0))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for r in rows:
        print(f"{r.get('per_hour') or 0:>7}/h {r.get('views') or 0:>9,} {str(r.get('age_h')):>5}h "
              f"{'[공식]' if r['official'] else ''}{(r.get('channel') or '')[:16]:16} | {(r.get('title') or '')[:60]}  {r['id']}")
    print(a.out)


if __name__ == '__main__':
    main()
