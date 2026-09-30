# -*- coding: utf-8 -*-
"""채널이 «우리 포맷»인지 **소리로** 판정한다.

    python scripts/channel_is_recap.py <채널ID|영상ID> [...]
    python scripts/channel_is_recap.py --from-rivals    정찰 대장의 채널을 전부 훑는다

왜 (사례 139)
  기존 판정기(`rival-scout.js`)는 **길이와 설명문 비율**만 봤다. 그래서 자체 제작 콩트(하이픽션),
  연예 가십(치치패치), 감정쇼(숏해적)를 «우리 포맷»으로 분류해 놓았고, 그들의 «차단 0»을
  우리 비교군 통계에 섞었다. 전부 허수였다.

무엇이 다른가 — **외국 영화를 쓰는 채널은 «한국어가 아닌 말»이 소리에 남아 있다.**
  우리도, 대한숏도, 눈물한가득도 원본 발화를 살린다(사례 137: 저쪽 79% 구간에 원어가 있다).
  콩트·가십 채널은 전부 한국어 자체 녹음이라 외국어가 아예 없다.

★**«영어로 강제 전사»로 판정하면 안 된다 (2026-09-28 실패).**
  한국어 음성에 `language='en'` 을 걸면 그럴듯한 영어 헛문장이 나온다.
  그 방식으로 첫 판을 돌렸더니 하이픽션(콩트)·치치패치(가십)가 «원어 3/3» 으로 나왔다.
  → **언어를 자동 판정**시키고, 한국어가 아닌 언어로 잡히는 구간이 있는지 본다.

★한계: **한국 드라마 리캡 채널은 이 방식으로 못 가린다**(원어가 한국어라서).
  우리가 찾는 것은 외국 영화 소재라 지금은 이 편이 맞지만, 그 한계를 알고 써라.

판정
  recap   원어가 들리는 표본이 절반 이상        → 화이트리스트를 캘 수 있다
  korean  원어가 거의 없다(자체 제작·가십·음악)  → 비교군에서 뺀다
  thin    우리 길이대 영상이 너무 적다            → 볼 것이 없다
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
STORE = os.path.join(ROOT, 'server', 'data', 'channel_format.json')
RIVALS = os.path.join(ROOT, 'server', 'data', 'rival_channels.json')
TMP = os.path.join(ROOT, 'server', 'output', 'format-audio')

MIN_SEC, MAX_SEC = 61, 200
NOISE = {'um', 'uh', 'you', 'thank you', 'bye', 'thanks for watching', 'oh', 'mm', 'hmm', ''}


def load_env():
    try:
        for line in open(os.path.join(ROOT, '.env'), encoding='utf-8', errors='replace'):
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
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


def channel_rows(seed, pages=2):
    cid = seed
    if not seed.startswith('UC'):
        items = api('videos', part='snippet', id=seed).get('items', [])
        if not items:
            raise SystemExit('영상을 못 찾았다: ' + seed)
        cid = items[0]['snippet']['channelId']
    info = api('channels', part='contentDetails,snippet', id=cid)['items'][0]
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
            rr = it['contentDetails'].get('regionRestriction') or {}
            rows.append({'id': it['id'], 'sec': iso_seconds(it['contentDetails'].get('duration')),
                         'blocked': len(rr.get('blocked') or []),
                         'views': int(it.get('statistics', {}).get('viewCount') or 0)})
    return info['snippet']['title'], cid, rows


def is_foreign_language(lang):
    """자동 판정된 언어가 한국어가 아닌가. 빈 값·한국어면 아니다."""
    l = str(lang or '').strip().lower()
    return bool(l) and not l.startswith(('ko', 'korean'))


def has_original_audio(video_id):
    """원어 대사가 들리는가. 가운데 두 구간만 본다 — 앞은 보통 해설이다."""
    import asr_backend
    out = os.path.join(TMP, video_id + '.m4a')
    os.makedirs(TMP, exist_ok=True)
    if not (os.path.exists(out) and os.path.getsize(out) > 10000):
        subprocess.run(['yt-dlp', '-q', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio',
                        '-o', out, 'https://www.youtube.com/watch?v=' + video_id],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if not os.path.exists(out):
        return None
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                '-of', 'csv=p=0', out], capture_output=True, text=True).stdout.strip() or 0)
    # 가운데 세 구간을 «언어 자동 판정»으로 듣는다. 하나라도 한국어가 아니면 원어가 섞인 것이다.
    for a in (dur * 0.3, dur * 0.5, dur * 0.7):
        for attempt in range(4):
            try:
                r = asr_backend.transcribe_groq(out, language=None, start=a, end=min(a + 14, dur))
                if is_foreign_language(r.get('language')):
                    return True
                break
            except Exception:
                time.sleep(3 * (attempt + 1))
    return False


def judge(seed, sample=3):
    name, cid, rows = channel_rows(seed)
    band = [r for r in rows if not r['blocked'] and MIN_SEC <= r['sec'] <= MAX_SEC]
    band.sort(key=lambda r: -r['views'])
    blocked = sum(1 for r in rows if r['blocked'])
    if len(band) < 5:
        return {'channel': name, 'channel_id': cid, 'verdict': 'thin',
                'videos': len(rows), 'blocked': blocked, 'in_band': len(band), 'hits': 0, 'tried': 0}
    hits = tried = 0
    for r in band[:sample]:
        got = has_original_audio(r['id'])
        if got is None:
            continue
        tried += 1
        hits += 1 if got else 0
    verdict = 'recap' if tried and hits * 2 >= tried else 'korean'
    return {'channel': name, 'channel_id': cid, 'verdict': verdict, 'videos': len(rows),
            'blocked': blocked, 'in_band': len(band), 'hits': hits, 'tried': tried}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seeds', nargs='*')
    ap.add_argument('--from-rivals', action='store_true')
    ap.add_argument('--sample', type=int, default=3)
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    load_env()

    seeds = list(args.seeds)
    if args.from_rivals:
        chs = (read_json(RIVALS, {}) or {}).get('channels') or {}
        seeds += [k for k in chs if k.startswith('UC')]
    store = read_json(STORE, {})
    seeds = [s for s in seeds if s not in store]
    if args.limit:
        seeds = seeds[:args.limit]
    if not seeds:
        print('새로 볼 채널 없음 · 대장', len(store), '건')
    for s in seeds:
        try:
            v = judge(s, args.sample)
        except Exception as exc:
            print(f'  실패 {s}: {str(exc)[:110]}')
            continue
        store[v['channel_id']] = v
        write_json(STORE, store)
        mark = {'recap': '★영화리캡', 'korean': '자체제작/기타', 'thin': '표본부족'}[v['verdict']]
        print(f"  {mark:14} {v['channel'][:20]:22} 대역 {v['in_band']:3}편 · "
              f"차단 {v['blocked']:3} · 원어 {v['hits']}/{v['tried']}")

    recaps = [v for v in store.values() if v['verdict'] == 'recap']
    print(f"\n대장 {len(store)}채널 · ★영화리캡 {len(recaps)}곳")
    for v in sorted(recaps, key=lambda x: -x['in_band']):
        print(f"   {v['channel'][:22]:24} 대역 {v['in_band']:3}편 · 차단 {v['blocked']:3} · {v['channel_id']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
