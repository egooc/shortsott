# -*- coding: utf-8 -*-
"""화이트리스트 작품의 **소스 클립을 찾는다** — 방향이 반대인 정찰.

    python scripts/find_clips_for.py <카탈로그키|영화제목> [...]
    python scripts/find_clips_for.py --whitelist [--limit 20]   화이트리스트 작품을 위에서부터
    python scripts/find_clips_for.py --report                    쌓인 결과만 읽는다

왜 (2026-09-29 소유주: "반대로 이 화이트리스트에 해당되는 클립 찾는 것도 필요한데 가능해?")
  맞다. 화이트리스트는 «무슨 영화가 안 막히나»만 답한다. 그 영화의 **쓸 만한 소스**가 없으면
  한 편도 못 만든다. 기존 `scout-sources.js` 는 방향이 반대다 — 정해진 소스 채널을 훑어
  «거기 뭐가 있나»를 본다. 이건 작품을 먼저 정하고 클립을 찾는다.

무엇을 «쓸 만하다»고 보나 — 제작 파이프라인이 실제로 요구하는 것들이다
  · 길이 180초 이상   컷 5개를 뽑으려면 원본이 그만큼은 돼야 한다(우리 런은 보통 280초 안팎)
  · 차단 0            막힌 클립은 받아도 소용없다
  · 연령 제한 없음     소유주 상시 지시 — 쿠키 우회 금지
  · 자막 있으면 가산   `en-orig.vtt` 가 있으면 유료 ASR 을 통째로 건너뛴다(오늘 트랜스포머에서 확인)
  · 공식/대형 클립 채널 가산  Movieclips 류는 화질·오디오가 안정적이다

★**할당량을 조심해라.** `search` 는 호출당 100 유닛이고 작품마다 3번 부른다 = 300 유닛.
  기본 하루 10,000 유닛이면 **하루 33작품이 한계**다. 넘기면 429 가 뜨는데,
  이 스크립트는 그때 «검색 0건»으로 기록해 **소스가 없는 것처럼 보이게 만든다**
  (2026-09-29 실측: 17건이 그렇게 거짓 음성으로 남았다).
  → `found == 0` 인 기록은 «없음»이 아니라 «못 물어봤음»이다. 지우고 다시 돌려라.
  → 한 번에 `--limit 30` 을 넘기지 마라.

★여기서 나온 후보는 **아직 «후보»다.** 실제로 받아 보고 `source-fitness.js` 로 오디오·침묵을
  재야 한다. 이 스크립트는 «받아볼 값어치가 있는 것»까지만 좁힌다.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

import api_quota  # 발굴 키 쿼터 장부(10-20)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')
WHITELIST = os.path.join(ROOT, 'server', 'data', 'whitelist_works.json')
OUT = os.path.join(ROOT, 'server', 'data', 'clip_candidates.json')

MIN_SEC = 180
GOOD_CHANNELS = ('movieclips', 'binge society', 'bestclips', 'rotten tomatoes', 'screen bites',
                 'clipzone', 'flicks', 'movie coverage', 'fresh movie', 'scene city', 'tv series')


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
            api_quota.mark_blocked('find_clips_for', f'{endpoint} {exc.code}')
        raise


def iso_seconds(t):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', t or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def has_subs(video_id):
    """자막이 있으면 유료 ASR 을 건너뛴다. yt-dlp 에게 목록만 물어본다(다운로드 없음)."""
    try:
        r = subprocess.run(['yt-dlp', '--no-warnings', '--skip-download', '--list-subs',
                            'https://www.youtube.com/watch?v=' + video_id],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=60)
        out = (r.stdout or '')
        return bool(re.search(r'^\s*(en|en-orig|en-US)\b', out, re.M))
    except Exception:
        return False


def search(title, year, want=14):
    queries = [f'{title} {year} movie clip' if year else f'{title} movie clip',
               f'{title} scene', f'{title} full scene']
    seen, rows = set(), []
    for q in queries:
        try:
            res = api('search', part='snippet', q=q, type='video', maxResults=want,
                      videoEmbeddable='true', order='relevance')
        except urllib.error.HTTPError as exc:
            if exc.code == 429 or exc.code == 403:
                raise SystemExit('★유튜브 API 할당량 소진(HTTP %d). 여기서 멈춘다 — '
                                 '이어서 돌리면 «소스 없음»으로 잘못 기록된다.' % exc.code)
            continue
        except Exception:
            continue
        ids = [x['id']['videoId'] for x in res.get('items', []) if x['id'].get('videoId')]
        ids = [i for i in ids if i not in seen]
        seen.update(ids)
        for i in range(0, len(ids), 50):
            det = api('videos', part='snippet,contentDetails,statistics,status',
                      id=','.join(ids[i:i + 50]))
            for it in det.get('items', []):
                cd = it['contentDetails']
                rr = cd.get('regionRestriction') or {}
                rows.append({
                    'id': it['id'],
                    'title': it['snippet'].get('title', ''),
                    'channel': it['snippet'].get('channelTitle', ''),
                    'sec': iso_seconds(cd.get('duration')),
                    'blocked': len(rr.get('blocked') or []),
                    # ★소스에 소유권이 매칭돼 있으면(licensedContent) 그 업로드의 지문이
                    #   이미 등록돼 있다는 뜻이다. 우리가 그걸로 만들면 잡히기 쉽다.
                    #   막지는 않되 점수를 깎는다 — 고를 것이 없을 때는 써야 하니까.
                    'licensed': cd.get('licensedContent') is True,
                    'adult': (cd.get('contentRating') or {}).get('ytRating') == 'ytAgeRestricted',
                    'views': int(it.get('statistics', {}).get('viewCount') or 0),
                })
    return rows


def score(r, title):
    s = 0
    s -= 2 if r.get('licensed') else 0          # 소유권 매칭된 업로드는 뒤로 민다
    s += 3 if r['sec'] >= 240 else (2 if r['sec'] >= MIN_SEC else 0)
    s += 2 if any(g in r['channel'].lower() for g in GOOD_CHANNELS) else 0
    s += 1 if r['views'] >= 100000 else 0
    s += 1 if re.sub(r'[^a-z0-9]', '', title.lower())[:12] in re.sub(r'[^a-z0-9]', '', r['title'].lower()) else 0
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*')
    ap.add_argument('--whitelist', action='store_true')
    ap.add_argument('--limit', type=int, default=25)   # 할당량상 하루 33작품이 한계다
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--subs', action='store_true', help='자막 유무까지 확인한다(느리다)')
    args = ap.parse_args()
    load_env()

    store = read_json(OUT, {})
    if args.report:
        ok = {k: v for k, v in store.items() if v.get('best')}
        print(f'조사한 작품 {len(store)} · 쓸 만한 소스가 있는 것 {len(ok)}')
        for k, v in sorted(ok.items(), key=lambda kv: -kv[1]['best']['score'])[:40]:
            b = v['best']
            print(f"  {k[:30]:32} {b['sec']:4}초 · {b['channel'][:20]:22} · 점수 {b['score']} · {b['id']}")
        return 0

    cat = read_json(CATALOG, {}).get('movies', {})
    targets = []
    if args.whitelist:
        wl = read_json(WHITELIST, [])
        made = {k for k, v in cat.items() if v.get('distributor_tier') == 'banned'}
        for w in wl:
            key = None
            for k, v in cat.items():
                if (v.get('title_en') or '').lower() == w['en'].lower():
                    key = k
                    break
            if key and key in made:
                continue
            targets.append((key or w['en'], w['en'], w.get('year') or ''))
    for n in args.names:
        v = cat.get(n)
        targets.append((n, (v or {}).get('title_en') or n, (v or {}).get('year') or ''))

    targets = [t for t in targets if t[0] not in store][:args.limit]
    print(f'찾을 작품 {len(targets)}건 (이미 조사한 것 {len(store)})')
    for key, title, year in targets:
        rows = search(title, year)
        good = [r for r in rows if r['sec'] >= MIN_SEC and not r['blocked'] and not r['adult']]
        for r in good:
            r['score'] = score(r, title)
        good.sort(key=lambda r: -r['score'])
        if args.subs:
            for r in good[:3]:
                r['subs'] = has_subs(r['id'])
                if r['subs']:
                    r['score'] += 2
            good.sort(key=lambda r: -r['score'])
        store[key] = {'title': title, 'year': year, 'found': len(rows),
                      'usable': len(good), 'best': good[0] if good else None,
                      'top': good[:5]}
        with io.open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(store, fh, ensure_ascii=False, indent=2)
        if good:
            b = good[0]
            print(f"  ★{title[:26]:28} 후보 {len(good):2}개 · 최상 {b['sec']:4}초 "
                  f"{b['channel'][:18]:20} 점수 {b['score']} · {b['id']}")
        else:
            print(f"  ✗{title[:26]:28} 쓸 만한 소스 없음 (검색 {len(rows)}건)")

    ok = sum(1 for v in store.values() if v.get('best'))
    print(f'\n조사 {len(store)}건 · 소스 있음 {ok}건 ({100 * ok / max(len(store), 1):.0f}%)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
