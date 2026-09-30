# -*- coding: utf-8 -*-
"""레퍼런스 채널의 «원고»를 들어서 작품을 알아낸다 — 화이트리스트를 짓는 세 번째 방법.

    python scripts/whitelist_from_narration.py <채널ID|영상ID> [--pages 6] [--max 40]
                                               [--min-views 300000] [--report] [--commit <표.tsv>]

왜 (2026-09-26 소유주: "최대한 레퍼런스 채널에서 화이트 리스트를 뽑아서 사용하자.
    영상 스크립트 분석해서 내용을 통해 영화 제목 유추하도록 하면 되")

  화이트리스트를 뽑는 길을 둘 만들어 뒀고 둘 다 한계가 있다.
    ① `rival-films.js` — **설명문 첫 줄**에서 제목을 뽑는다. 채널이 적어 줄 때만 된다.
       눈물한가득은 설명도 태그도 **비어 있다**(2026-09-26 실측). 이 길이 막힌다.
       `whitelist_works.json` 에 "humor #family #sitcom #shorts" 가 작품명으로 들어가 있는 것이
       그 증거다 — 해시태그를 제목으로 읽었다.
    ② `survivor-signal.js` — 우리 길이대 생존 클립 수를 센다. 우리가 **이미 고른** 영화만 채점한다.

  남은 길이 이것이다. **해설을 들으면 무슨 영화인지 나온다.** 리캡 채널의 원고는 줄거리 요약이라
  등장인물·설정·결말이 다 들어 있다. 설명문이 비어 있어도 소리는 못 숨긴다.

무엇을 거르나 — 「견딘 증거」가 되는 것만 남긴다
  · 차단 0 (regionRestriction.blocked 가 비어 있음). 막힌 것은 증거가 아니다.
  · 소유권 매칭(licensedContent)은 **거르지 않는다**. 세어서 보여 주기만 한다.
    2026-09-29 에는 이것도 실격으로 뒀다가 2026-09-30 철회했다 — 근거였던 「ja 4회」는
    매칭 때문이 아니라 내가 그 편을 비공개로 돌려서 나온 숫자였다. 게다가 공식 권리자
    채널은 자기 소유물을 올리니 **항상** 매칭이다. 실격으로 두면 공식 채널이 배제된다.
  · 61~200초. 우리 길이대다. 길이가 다르면 정책도 다를 수 있다.
  · 조회 하한. 묻힌 영상은 «권리자가 아직 안 본 것»일 수 있어 증거가 약하다.

돈: yt-dlp 로 **소리만** 받는다(3분이면 1~2MB). STT 는 Groq(메모리 use-groq-asr-not-local).
    한 번 들은 영상은 저장소에 남아 다시 안 듣는다.

제목은 이 스크립트가 «유추하지 않는다». 원고를 표로 뱉고, 읽는 쪽(사람이든 AI든)이 채워
--commit 으로 되돌린다. 기계가 제목을 지어내면 화이트리스트가 오염된다 —
whitelist_works.json 이 이미 그렇게 망가졌다.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'midform', 'scripts'))
STORE = os.path.join(ROOT, 'server', 'data', 'narration_probe.json')
WHITELIST = os.path.join(ROOT, 'server', 'data', 'whitelist_works.json')
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')

MIN_SEC, MAX_SEC = 61, 200


def load_env():
    try:
        for line in open(os.path.join(ROOT, '.env'), encoding='utf-8', errors='replace'):
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())
    except OSError:
        pass


def read_json(path, fallback):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fallback


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def api(endpoint, **params):
    params['key'] = os.environ['YOUTUBE_API_KEY']
    url = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def iso_seconds(text):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', text or '')
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def channel_videos(seed, pages):
    """씨앗이 영상이면 그 채널을 먼저 찾고, 업로드 재생목록을 훑는다."""
    channel_id = seed
    if not seed.startswith('UC'):
        items = api('videos', part='snippet', id=seed).get('items', [])
        if not items:
            raise SystemExit('영상을 못 찾았다: ' + seed)
        channel_id = items[0]['snippet']['channelId']
    info = api('channels', part='contentDetails,snippet,statistics', id=channel_id)['items'][0]
    uploads = info['contentDetails']['relatedPlaylists']['uploads']
    ids, token = [], ''
    for _ in range(pages):
        extra = {'pageToken': token} if token else {}
        page = api('playlistItems', part='contentDetails', maxResults=50, playlistId=uploads, **extra)
        ids += [x['contentDetails']['videoId'] for x in page.get('items', [])]
        token = page.get('nextPageToken', '')
        if not token:
            break
    rows = []
    for i in range(0, len(ids), 50):
        chunk = api('videos', part='snippet,contentDetails,statistics', id=','.join(ids[i:i + 50]))
        for it in chunk.get('items', []):
            restriction = it['contentDetails'].get('regionRestriction') or {}
            rows.append({
                'id': it['id'],
                'title': it['snippet'].get('title', ''),
                'desc': (it['snippet'].get('description') or '')[:200],
                'sec': iso_seconds(it['contentDetails'].get('duration')),
                'blocked': len(restriction.get('blocked') or []),
                'licensed': it['contentDetails'].get('licensedContent') is True,
                'views': int(it.get('statistics', {}).get('viewCount') or 0),
                'at': str(it['snippet'].get('publishedAt'))[:10],
            })
    return info['snippet']['title'], channel_id, rows


def fetch_audio(video_id, out_dir):
    """소리만 받는다. 화면은 필요 없다 — 원고만 들으면 된다."""
    out = os.path.join(out_dir, video_id + '.m4a')
    if os.path.exists(out) and os.path.getsize(out) > 10000:
        return out
    proc = subprocess.run(
        ['yt-dlp', '-q', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio',
         '-o', out, 'https://www.youtube.com/watch?v=' + video_id],
        capture_output=True, text=True, encoding='utf-8', errors='replace')
    if not os.path.exists(out):
        raise RuntimeError((proc.stderr or proc.stdout or 'yt-dlp 실패')[-300:])
    return out


def listen(audio_path):
    # ★언어를 고정하지 마라. 2026-09-28 에 'ko' 로 박아 두는 바람에 영어권 채널 104편이
    #   전부 한국어 헛소리로 전사됐다(Groq 는 강제된 언어로 «그럴듯하게» 지어낸다).
    #   자동 판정에 맡기면 한국어 채널도 영어 채널도 제 언어로 나온다.
    import asr_backend
    last = None
    for attempt in range(5):
        try:
            result = asr_backend.transcribe_groq(audio_path, language=None)
            return ' '.join(s.get('text', '').strip() for s in result.get('segments', [])).strip()
        except Exception as exc:                      # 429 가 흔하다 — 물러섰다 다시 온다
            last = exc
            time.sleep(3 * (attempt + 1))
    raise last


def made_and_banned():
    catalog = read_json(CATALOG, {})
    movies = catalog.get('movies') if isinstance(catalog, dict) else catalog
    # 카탈로그의 movies 는 «키 -> 영화» 사전이다. 값만 본다.
    entries = list(movies.values()) if isinstance(movies, dict) else list(movies or [])
    made, banned = set(), set()
    for m in entries:
        if not isinstance(m, dict):
            continue
        for name in (m.get('title_en'), m.get('title'), m.get('title_ko'), m.get('key')):
            if name:
                made.add(str(name).lower())
        if m.get('distributor_tier') == 'banned':
            banned.add(str(m.get('title_en') or m.get('key') or '').lower())
    return made, banned


def cmd_harvest(args):
    load_env()
    store = read_json(STORE, {})
    name, channel_id, rows = channel_videos(args.seed, args.pages)
    # ★소유권 매칭(licensed)으로 걸러내지 않는다 — 2026-09-30 철회.
    #   공식 권리자 채널(SBS Catch·テレ東公式 등)은 자기 소유물을 올리므로 **항상** 매칭이다.
    #   매칭을 실격으로 두면 우리가 써야 할 공식 무료 채널이 정확히 배제된다.
    alive = [r for r in rows
             if not r['blocked']
             and MIN_SEC <= r['sec'] <= MAX_SEC and r['views'] >= args.min_views]
    alive.sort(key=lambda r: -r['views'])
    blocked_n = sum(1 for r in rows if r['blocked'])
    licensed_n = sum(1 for r in rows if r.get('licensed'))
    print('=== {} ({}) ==='.format(name, channel_id))
    print('훑은 영상 {}편 · 차단 {}편 · 소유권매칭 {}편 · 조건 통과 {}편 '
          '(차단0 · 소유권매칭0 · {}~{}초 · 조회 {:,}+)'.format(
              len(rows), blocked_n, licensed_n, len(alive), MIN_SEC, MAX_SEC, args.min_views))
    fresh = [r for r in alive if r['id'] not in store]
    todo = fresh[:args.max]
    print('새로 들을 것 {}편 (이미 들은 것 {}편)\n'.format(len(todo), len(alive) - len(fresh)))
    tmp = os.path.join(ROOT, 'server', 'output', 'narration-audio')
    os.makedirs(tmp, exist_ok=True)
    for i, r in enumerate(todo, 1):
        try:
            text = listen(fetch_audio(r['id'], tmp))
        except Exception as exc:
            print('  [{}/{}] {} 실패: {}'.format(i, len(todo), r['id'], str(exc)[:120]))
            continue
        # ★한 편마다 «다시 읽고» 적는다. 수확 둘이 동시에 돌거나 그 사이에 --commit 이 끼면,
        #   시작할 때 읽어 둔 store 를 통째로 쓰는 순간 남이 적은 제목이 지워진다.
        #   (2026-09-26 실측: 그렇게 제목 10편이 날아갔다.)
        store = read_json(STORE, {})
        store[r['id']] = dict(r, channel=name, channel_id=channel_id,
                              text=text, film_en='', film_ko='', year='')
        write_json(STORE, store)                      # 끊겨도 들은 건 남는다
        print('  [{}/{}] {} {}초 {:,}회  {}'.format(i, len(todo), r['id'], r['sec'], r['views'], text[:70]))
    cmd_report(args)


def cmd_report(args):
    store = read_json(STORE, {})
    rows = list(store.values())
    if args.seed:
        picked = [v for v in rows if args.seed in (v.get('channel_id'), v.get('id'), v.get('channel'))]
        rows = picked or rows
    todo = [r for r in rows if not r.get('film_en')]
    done = [r for r in rows if r.get('film_en')]
    print('\n들은 것 {}편 · 제목 채운 것 {}편 · 아직 {}편'.format(len(rows), len(done), len(todo)))
    if todo:
        print('\n--- 제목을 채울 것 (읽고 `--commit 표.tsv` 로 되돌린다) ---')
        print('# videoId<TAB>영문제목<TAB>한국어제목<TAB>연도')
        for r in todo:
            print('\n[{}] {}초 · {:,}회 · {} · {}'.format(r['id'], r['sec'], r['views'], r['at'], r['channel']))
            print('  제목: ' + r['title'])
            print('  원고: ' + r['text'][:520])
    if done:
        print('\n--- 살아 있는 것으로 확인된 작품 ---')
        agg = {}
        for r in done:
            a = agg.setdefault(r['film_en'].lower(),
                               {'en': r['film_en'], 'ko': r['film_ko'], 'year': r['year'],
                                'n': 0, 'views': 0, 'chs': set(), 'oldest': '9999'})
            a['n'] += 1
            a['views'] += r['views']
            a['chs'].add(r['channel'])
            a['oldest'] = min(a['oldest'], r['at'])
        made, banned = made_and_banned()
        for a in sorted(agg.values(), key=lambda x: -x['views']):
            key = a['en'].lower()
            flag = ' ★이미 만듦' if key in made else (' ☠금지' if key in banned else '')
            print('  {} ({} {}) · {}편 · {:,}회 · {} · 최초 {}{}'.format(
                a['en'], a['ko'], a['year'], a['n'], a['views'], '/'.join(sorted(a['chs'])), a['oldest'], flag))


def cmd_commit(args):
    store = read_json(STORE, {})
    n = 0
    for line in open(args.commit, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        parts = (line.split('\t') + ['', '', ''])[:4]
        vid, en, ko, year = [p.strip() for p in parts]
        if vid not in store:
            print('  모르는 영상: ' + vid)
            continue
        if not en:                                    # 빈 제목은 «못 알아냈다»는 뜻이다. 지어내지 않는다.
            continue
        store[vid].update({'film_en': en, 'film_ko': ko, 'year': year})
        n += 1
    write_json(STORE, store)
    print('제목 {}편 기록'.format(n))
    # 화이트리스트를 새로 짓는다. 설명문 찌꺼기가 아니라 «들어서 확인한 것»만 들어간다.
    agg = {}
    for r in store.values():
        if not r.get('film_en'):
            continue
        a = agg.setdefault(r['film_en'].lower(),
                           {'en': r['film_en'], 'ko': r.get('film_ko', ''), 'year': r.get('year', ''),
                            'tv': False, 'n': 0, 'views': 0, 'chs': set(), 'oldest': '9999'})
        a['n'] += 1
        a['views'] += r['views']
        a['chs'].add(r['channel'])
        a['oldest'] = min(a['oldest'], r['at'])
    out = [dict(a, chs=sorted(a['chs'])) for a in sorted(agg.values(), key=lambda x: -x['views'])]
    write_json(WHITELIST, out)
    print('{} 에 작품 {}건'.format(WHITELIST, len(out)))


def cmd_relisten(args):
    """이미 받아 둔 오디오로 원고만 다시 뽑는다. 제목이 붙은 것은 건드리지 않는다."""
    load_env()
    store = read_json(STORE, {})
    tmp = os.path.join(ROOT, 'server', 'output', 'narration-audio')
    want = args.relisten
    todo = [k for k, v in store.items()
            if not v.get('film_en') and (want == 'all' or want in (v.get('channel'), v.get('channel_id')))]
    print('다시 들을 것 {}편'.format(len(todo)))
    for i, vid in enumerate(todo, 1):
        audio = os.path.join(tmp, vid + '.m4a')
        try:
            if not os.path.exists(audio):
                audio = fetch_audio(vid, tmp)
            text = listen(audio)
        except Exception as exc:
            print('  [{}/{}] {} 실패: {}'.format(i, len(todo), vid, str(exc)[:110]))
            continue
        store = read_json(STORE, {})
        store[vid]['text'] = text
        write_json(STORE, store)
        print('  [{}/{}] {} {}'.format(i, len(todo), vid, text[:80]))
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument('seed', nargs='?', default='')
    p.add_argument('--pages', type=int, default=6)
    p.add_argument('--max', type=int, default=40)
    p.add_argument('--min-views', type=int, default=300000, dest='min_views')
    p.add_argument('--report', action='store_true')
    p.add_argument('--commit')
    p.add_argument('--relisten', help='이 채널의 원고를 다시 듣는다(언어 고정 버그 복구용)')
    args = p.parse_args()
    if args.relisten:
        return cmd_relisten(args)
    if args.commit:
        return cmd_commit(args)
    if args.report or not args.seed:
        return cmd_report(args)
    return cmd_harvest(args)


if __name__ == '__main__':
    sys.exit(main() or 0)
