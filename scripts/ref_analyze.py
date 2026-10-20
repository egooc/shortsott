# -*- coding: utf-8 -*-
"""ref-analyze 1단계 — 레퍼런스 채널의 채널·업로드·원고 표 + 분류(class.md). 설계: docs/plans/ref-analyze-design-20261016.md

    python scripts/ref_analyze.py @traveler_ttt --lane ko_longshort [--n 20] [--shorts] [--lang ko] [--no-stt] [--max-stt 20 --max-stt-min 180]
    python scripts/ref_analyze.py UC69z_1ZtKQjG5fa-_sKBBfg --lane ko_longshort --shorts
    python scripts/ref_analyze.py @brave_chat --lane ko_case --long --min-sec 1200   # 롱폼만(쇼츠 섞인 채널)
    python scripts/ref_analyze.py nenkin_refs --lane ja_nenkin --lang ja --ids HSI_wfjHGko,DKPRM30rVmA   # 영상 단위

- 메타: 발굴용 Data API 키(YOUTUBE_API_KEY_SEARCH, 공개 통계만). --shorts 면 UUSH 재생목록(쇼츠 탭)만 본다.
- 표본: 공개 72시간+ · 최근 90일(모자라면 최근 200편까지 넓힘) → 조회 상위 n/2 · 하위 n/2.
  롱폼(중앙 길이 > 180초)이면 분당 조회(조회 ÷ 분)로도 다시 줄 세워 channel.json 에 함께 적는다(관리자 10-16).
- 자막은 상·하위를 번갈아 받는다. 받은 자막·전사는 캐시라 다시 돌리면 이어서 받는다.
- 원고: yt-dlp 자동 자막(json3) 먼저. 없으면 Speechmatics(rinbox_transcribe 의 submit/wait 를 import) —
  채널당 --max-stt 편 또는 합계 --max-stt-min 분 중 먼저 닿는 쪽까지, 넘으면 «전사 생략 N편». --no-stt 면 아예 안 쓴다.
- 429 가 나오면 그 자리에서 자막 받기를 멈춘다(재시도·우회 없음). 받은 편만으로 표를 쓰고 «429 중단»을 적는다.
  관리자 10-16: 요청 사이 3~5초 무작위 · 한 번에 새로 받는 자막 20편 · 429 나면 그 채널은 그날 접음(종료 코드 3 → 다음 채널) ·
  하루 실행 3회(첫 실행 + 재시도 2회). 기록은 캐시의 fetch_log.json.
- 캐시 server/data/ref_analyze/<채널>/(gitignore), 산출 reference/<lane>/<채널>/{channel,upload,script}.json + class.md.
문장 분할은 근사다: 자막 구두점(。.?!) 또는 0.7초+ 쉼에서 끊는다. 숫자는 «사람이 눈으로 확인할 근거»와 같이 본다.
"""
import argparse
import datetime as dt
import json
import math
import random
import re
import statistics as st
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import api_quota  # 발굴 키 쿼터 장부(10-20)
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KST = dt.timezone(dt.timedelta(hours=9))
CTA = {'ko': ('구독', '좋아요', '알림', '풀영상', '본편', '전체 영상', '링크'),
       'ja': ('チャンネル登録', '高評価', '本編', 'フル'), 'en': ('subscribe', 'full video', 'link', 'like')}
QWORD = {'ko': r'(까|나요|가요|죠|니|냐|래)\s*[?？]?$', 'ja': r'(か|の|かな)\s*[?？]?$', 'en': r'\?$'}


def api_key():
    for ln in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
        if ln.startswith('YOUTUBE_API_KEY_SEARCH='):
            return ln.split('=', 1)[1].strip().strip('\'"')
    sys.exit('YOUTUBE_API_KEY_SEARCH 가 .env 에 없다')


def yt(path, **q):
    q['key'] = api_key()
    api_quota.spend('discovery_search', path)
    try:
        with urllib.request.urlopen('https://www.googleapis.com/youtube/v3/%s?%s' % (path, urllib.parse.urlencode(q)), timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            api_quota.mark_blocked('ref_analyze', f'{path} {exc.code}')
        raise


def iso_sec(d):
    m = re.match(r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', d or '')
    return sum(int(x or 0) * k for x, k in zip(m.groups(), (86400, 3600, 60, 1))) if m else 0


def playlist_id(c, shorts=False, long=False):
    if shorts:
        return 'UUSH' + c['id'][2:]   # 쇼츠 탭
    if long:
        return 'UULF' + c['id'][2:]   # 동영상 탭(쇼츠·라이브 제외)
    return c['contentDetails']['relatedPlaylists']['uploads']


def fetch_channel(ref, shorts, cap=200, long=False):
    q = {'part': 'snippet,statistics,contentDetails'}
    q.update({'id': ref} if ref.startswith('UC') else {'forHandle': ref})
    c = yt('channels', **q)['items'][0]
    pl = playlist_id(c, shorts, long)
    ids, page = [], None
    while len(ids) < cap:
        q = {'part': 'contentDetails', 'maxResults': 50, 'playlistId': pl}
        if page:
            q['pageToken'] = page
        r = yt('playlistItems', **q)
        ids += [i['contentDetails']['videoId'] for i in r.get('items', [])]
        page = r.get('nextPageToken')
        if not page:
            break
    vids = []
    for i in range(0, len(ids), 50):
        vids += yt('videos', part='snippet,statistics,contentDetails,status', id=','.join(ids[i:i + 50])).get('items', [])
    rows = []
    for v in vids:
        s = v['statistics']
        rows.append({'id': v['id'], 'title': v['snippet']['title'], 'pub': v['snippet']['publishedAt'],
                     'sec': iso_sec(v['contentDetails']['duration']), 'views': int(s.get('viewCount', 0)),
                     'likes': int(s.get('likeCount', 0)), 'comments': int(s.get('commentCount', 0)),
                     'privacy': v.get('status', {}).get('privacyStatus', 'public')})
    meta = {'id': c['id'], 'title': c['snippet']['title'], 'handle': c['snippet'].get('customUrl', ''),
            'subs': int(c['statistics'].get('subscriberCount', 0)), 'videos_total': int(c['statistics'].get('videoCount', 0)),
            'created': c['snippet']['publishedAt'][:10], 'playlist': pl}
    return meta, rows


def age_h(r, now):
    return (now - dt.datetime.fromisoformat(r['pub'].replace('Z', '+00:00'))).total_seconds() / 3600


def pick(rows, n, now):
    ok = [r for r in rows if r['privacy'] == 'public' and age_h(r, now) >= 72]
    recent = [r for r in ok if age_h(r, now) <= 90 * 24]
    pool = recent if len(recent) >= n * 2 else ok
    by = sorted(pool, key=lambda r: -r['views'])
    k = min(n // 2, len(by) // 2)
    return pool, by[:k], by[-k:] if k else []


def q(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * p))] if s else 0


def channel_table(meta, rows, pool, top, bot, now):
    v = [r['views'] for r in pool]
    med = q(v, 0.5)
    out = dict(meta)
    out.update({'n_fetched': len(rows), 'n_pool': len(pool), 'pool_rule': '공개 72h+ · 90일(모자라면 전체)',
                'views_median': med, 'p25': q(v, 0.25), 'p75': q(v, 0.75), 'p90': q(v, 0.9),
                'spread_p75_over_median': round(q(v, 0.75) / med, 2) if med else None,
                'share_over_3x': round(sum(x >= 3 * med for x in v) / len(v), 3) if v else 0,
                'uploads_30d': sum(age_h(r, now) <= 720 for r in rows),
                'uploads_90d': sum(age_h(r, now) <= 2160 for r in rows),
                'duration_median_sec': q([r['sec'] for r in pool], 0.5),
                'top_ids': [r['id'] for r in top], 'bottom_ids': [r['id'] for r in bot]})
    if out['duration_median_sec'] > 180:
        per = sorted(pool, key=lambda r: -(r['views'] / max(r['sec'] / 60, 0.1)))
        k = len(top)
        out['per_min_top_ids'] = [r['id'] for r in per[:k]]
        out['per_min_bottom_ids'] = [r['id'] for r in per[-k:]] if k else []
        out['per_min_overlap_top'] = len(set(out['per_min_top_ids']) & set(out['top_ids']))
    return out


def upload_table(rows, now):
    loc = [dt.datetime.fromisoformat(r['pub'].replace('Z', '+00:00')).astimezone(KST) for r in rows]
    loc.sort()
    gaps = [(b - a).total_seconds() / 3600 for a, b in zip(loc, loc[1:])]
    days = Counter(x.date() for x in loc)
    wd = Counter('월화수목금토일'[x.weekday()] for x in loc)
    hr = Counter(x.hour for x in loc)
    return {'tz': 'KST(=JST)', 'n': len(loc), 'first': str(loc[0].date()) if loc else None, 'last': str(loc[-1].date()) if loc else None,
            'weekday': dict(wd), 'hour': {str(h): hr[h] for h in sorted(hr)},
            'per_active_day_median': q(list(days.values()), 0.5), 'gap_hours_median': round(q(gaps, 0.5), 1) if gaps else None,
            'gap_hours_p90': round(q(gaps, 0.9), 1) if gaps else None,
            'days_with_upload_last30': sum(1 for d in days if (now.astimezone(KST).date() - d).days <= 30)}


# ---------- 자막·전사 ----------

class Stop(Exception):
    pass


def gate(log, today, max_429=1, max_runs=3):
    """오늘 이 채널 자막을 더 받아도 되나 — (ok, 이유). log = {날짜: {'runs': n, '429': n}}.
    관리자 10-16: 429 가 나면 그 채널은 그날 접는다 · 하루 재시도 2회(= 실행 3회)까지."""
    d = log.get(today, {})
    if d.get('429', 0) >= max_429:
        return False, '오늘 429 %d회 — 이 채널은 내일 다시' % d['429']
    if d.get('runs', 0) >= max_runs:
        return False, '오늘 자막 받기 %d회 — 하루 상한' % d['runs']
    return True, ''


def auto_subs(vid, lang, cache):
    f = cache / ('%s.%s.json3' % (vid, lang))
    if f.exists():
        return f
    p = subprocess.run(['yt-dlp', '--js-runtimes', 'node', '-q', '--skip-download', '--write-auto-subs', '--write-subs',
                        '--sub-langs', '%s,%s-orig' % (lang, lang), '--sub-format', 'json3', '-o', str(cache / '%(id)s'),
                        'https://www.youtube.com/watch?v=' + vid], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if '429' in p.stderr:
        raise Stop('429')
    auto_subs.fetched += 1
    for cand in (f, cache / ('%s.%s-orig.json3' % (vid, lang))):
        if cand.exists():
            if cand != f:
                cand.replace(f)
            return f
    return None


auto_subs.fetched = 0


def words_from_json3(f):
    d = json.loads(f.read_text(encoding='utf-8'))
    out = []
    for e in d.get('events', []):
        t0 = e.get('tStartMs', 0)
        segs = e.get('segs') or []
        for i, s in enumerate(segs):
            w = (s.get('utf8') or '').replace('\n', ' ').strip()
            if not w:
                continue
            start = (t0 + s.get('tOffsetMs', 0)) / 1000
            nxt = segs[i + 1].get('tOffsetMs') if i + 1 < len(segs) else None
            end = (t0 + nxt) / 1000 if nxt is not None else (t0 + e.get('dDurationMs', 1000)) / 1000
            out.append([round(start, 2), round(max(end, start + 0.05), 2), re.sub(r'^>>\s*', '', w)])
    return [w for w in out if w[2]]


def stt(vid, lang, cache):
    """Speechmatics — rinbox_transcribe 의 submit/wait 재사용. 구두점도 받아 문장 분할에 쓴다."""
    f = cache / ('%s.stt.json' % vid)
    if f.exists():
        return json.loads(f.read_text(encoding='utf-8'))
    sys.path.insert(0, str(ROOT / 'scripts'))
    import rinbox_transcribe as RT  # noqa: E402
    audio = cache / ('%s.m4a' % vid)
    p = subprocess.run(['yt-dlp', '--js-runtimes', 'node', '-q', '-f', 'bestaudio[ext=m4a]/bestaudio', '-o', str(audio),
                        'https://www.youtube.com/watch?v=' + vid], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if '429' in p.stderr:
        raise Stop('429')
    if not audio.exists():
        return None
    job = RT.submit(str(audio), lang)
    RT.wait(job)
    tr = json.loads(RT.req('%s/%s/transcript?format=json-v2' % (RT.API, job)))
    out = []
    for x in tr.get('results') or []:
        c = ((x.get('alternatives') or [{}])[0].get('content') or '').strip()
        if not c:
            continue
        if x.get('type') == 'punctuation' and out:
            out[-1][2] += c
        elif x.get('type') == 'word':
            out.append([round(float(x['start_time']), 2), round(float(x['end_time']), 2), c])
    audio.unlink(missing_ok=True)
    f.write_text(json.dumps(out, ensure_ascii=False) + '\n', encoding='utf-8')
    return out


def sentences(words, lang, pause=0.7):
    out, cur = [], []
    sep = '' if lang == 'ja' else ' '
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if re.search(r'[.?!。？！]$', w[2]) or nxt is None or nxt[0] - w[1] >= pause:
            out.append({'start': cur[0][0], 'end': cur[-1][1], 'text': sep.join(x[2] for x in cur).strip()})
            cur = []
    return out


def ending(text, lang):
    t = re.sub(r'[.?!。？！\s]+$', '', text)
    if lang == 'ko':
        return t[-2:] if len(t) >= 2 else t
    if lang == 'ja':
        m = re.search(r'(です|ます|でした|ました|だ|た|ね|よ|か|の|な)$', t)
        return m.group(1) if m else t[-1:]
    return 'q' if text.strip().endswith('?') else 'stmt'


def first_type(text, lang):
    if re.search(r'[?？]', text) or re.search(QWORD[lang], text):
        return 'question'
    if re.search(r'\d|[일이삼사오육칠팔구십백천만]+\s*(원|명|개|일|시간|km|키로)', text):
        return 'number'
    if re.search(r'[!！]', text):
        return 'exclaim'
    return 'statement'


def script_row(r, words, lang, source):
    sents = sentences(words, lang) if words else []
    dur = max(r['sec'], 1)
    speech, edge = 0.0, 0.0  # 낱말 구간의 합집합(자막 이벤트가 겹쳐서 단순 합은 1.0 을 넘는다)
    for s0, e0, _ in sorted(words or []):
        s0 = max(s0, edge)
        if e0 > s0:
            speech += e0 - s0
            edge = e0
    chars = sum(len(re.sub(r'\s', '', s['text'])) for s in sents)
    last = sents[-1]['text'] if sents else ''
    return {'id': r['id'], 'views': r['views'], 'sec': r['sec'], 'source': source,
            'speech_share': round(min(speech / dur, 1), 3), 'chars_per_min': round(chars / (dur / 60), 1),
            'first_speech_sec': words[0][0] if words else None, 'n_sentences': len(sents),
            'avg_sentence_chars': round(chars / len(sents), 1) if sents else None,
            'first_sentence': sents[0]['text'] if sents else '', 'first_type': first_type(sents[0]['text'], lang) if sents else None,
            'last_sentence': last, 'ending_cta': any(w.lower() in last.lower() for w in CTA[lang]),
            'ending_question': bool(re.search(r'[?？]$', last)),
            'endings': Counter(ending(s['text'], lang) for s in sents).most_common(5),
            'transcript_ok': transcript_ok(' '.join(s['text'] for s in sents), lang) if sents else None}


def transcript_ok(text, lang):
    """자막이 말을 받아 적었나 — ko 인데 한자·가나가 20%+ 면 노래 가사·외국어 오인식으로 본다.
    손 표시(flags.json bad_transcript)가 이걸 덮어쓴다. 소리 나는 대로 적은 한국어는 기계로 못 잡는다(A 눈 표시 필요)."""
    body = re.sub(r'[\s\W\d_]', '', text)
    if not body or lang != 'ko':
        return True
    foreign = len(re.findall(r'[぀-ヿ一-鿿]', body))
    return foreign / len(body) < 0.2


def title_row(r):
    t = r['title']
    return {'title_chars': len(t), 'title_digit': bool(re.search(r'\d', t)), 'title_q': '?' in t or '？' in t,
            'title_excl': '!' in t or '！' in t, 'title_hashtags': len(re.findall(r'#\S+', t)),
            'title_bracket': bool(re.search(r'[\[\(【「『]', t)),
            'title_emoji': bool(re.search('[\U0001F300-\U0001FAFF☀-➿]', t)),
            'like_rate': round(r['likes'] / r['views'], 4) if r['views'] else 0,
            'comment_rate': round(r['comments'] / r['views'], 5) if r['views'] else 0}


# ---------- 비교·분류 ----------

NUM = ['sec', 'speech_share', 'chars_per_min', 'first_speech_sec', 'n_sentences', 'avg_sentence_chars', 'title_chars',
       'title_hashtags', 'like_rate', 'comment_rate']
BOOL = ['ending_cta', 'ending_question', 'title_digit', 'title_q', 'title_excl', 'title_bracket', 'title_emoji']
CAT = ['first_type']
TEXT = {'n_sentences', 'avg_sentence_chars', 'ending_cta', 'ending_question', 'first_type'}  # 받아 적은 글자 자체를 보는 칸
SPEECH = {'speech_share', 'chars_per_min', 'first_speech_sec', 'n_sentences', 'avg_sentence_chars', 'ending_cta',
          'ending_question', 'first_type'}


def compare(top, bot):
    """원고 칸은 전사가 있는 편끼리만(전사 없음 ≠ 말 없음), 제목·반응 칸은 전부."""
    out = []
    def has(xs, k):
        k = k.split('=')[0]
        return [x for x in xs if (k not in SPEECH or x.get('source', 'auto') != 'none')
                and (k not in TEXT or x.get('transcript_ok') is not False)]
    for k in NUM:
        a = [x[k] for x in has(top, k) if x.get(k) is not None]
        b = [x[k] for x in has(bot, k) if x.get(k) is not None]
        if len(a) < 3 or len(b) < 3:
            continue
        sd = math.sqrt(((st.pstdev(a) ** 2) + (st.pstdev(b) ** 2)) / 2) or 1e-9
        out.append({'key': k, 'top': round(st.median(a), 3), 'bottom': round(st.median(b), 3),
                    'effect': round((st.mean(a) - st.mean(b)) / sd, 2)})
    for k in BOOL:
        a = [bool(x.get(k)) for x in has(top, k)]
        b = [bool(x.get(k)) for x in has(bot, k)]
        if len(a) >= 3 and len(b) >= 3:
            pa, pb = sum(a) / len(a), sum(b) / len(b)
            out.append({'key': k, 'top': round(pa, 2), 'bottom': round(pb, 2), 'effect': round((pa - pb) * 2, 2)})
    for k in CAT:
        tt, bb = has(top, k), has(bot, k)
        if len(tt) < 3 or len(bb) < 3:
            continue
        for val in sorted({x.get(k) for x in tt + bb if x.get(k)}):
            pa = sum(x.get(k) == val for x in tt) / len(tt)
            pb = sum(x.get(k) == val for x in bb) / len(bb)
            out.append({'key': '%s=%s' % (k, val), 'top': round(pa, 2), 'bottom': round(pb, 2), 'effect': round((pa - pb) * 2, 2)})
    return sorted(out, key=lambda x: -abs(x['effect']))


LABEL = {'sec': '길이(초)', 'speech_share': '말 비중', 'chars_per_min': '분당 글자', 'first_speech_sec': '첫 말 시각(초)',
         'n_sentences': '문장 수', 'avg_sentence_chars': '문장 평균 글자', 'title_chars': '제목 글자', 'title_hashtags': '제목 해시태그 수',
         'like_rate': '좋아요/조회', 'comment_rate': '댓글/조회', 'ending_cta': '끝 문장 CTA', 'ending_question': '끝 문장 질문',
         'title_digit': '제목 숫자', 'title_q': '제목 물음표', 'title_excl': '제목 느낌표', 'title_bracket': '제목 괄호', 'title_emoji': '제목 이모지'}


def class_md(ch, up, sc, diffs, lane, notes):
    L = ['# %s — 분류 (ref-analyze 1단계, %s)' % (ch['title'], dt.date.today()), '',
         '- 채널: %s `%s` · 구독 %s · 레인 `%s` · 재생목록 %s' % (ch.get('handle') or '', ch['id'], f"{ch['subs']:,}", lane, ch['playlist']),
         '- 표본: %s편 중 %s(%s) → 상위 %d · 하위 %d' % (ch['n_fetched'], ch['n_pool'], ch['pool_rule'], len(ch['top_ids']), len(ch['bottom_ids']))
         + (' · %d초 미만 제외(받은 %d편 기준, 업로드 표도 이 길이만)' % (ch['min_sec'], ch['n_before_min_sec']) if ch.get('min_sec') else ''),
         '- 조회 중앙 %s · 하위25 %s · 상위25 %s · 퍼짐 %s배 · 3배+ 편 %.0f%% · 중앙 길이 %s초'
         % (f"{ch['views_median']:,}", f"{ch['p25']:,}", f"{ch['p75']:,}", ch['spread_p75_over_median'], ch['share_over_3x'] * 100, ch['duration_median_sec']),
         '- 업로드: 30일 %s편 · 활동일 중앙 %s편/일 · 간격 중앙 %sh · 주로 %s시(KST)'
         % (ch['uploads_30d'], up['per_active_day_median'], up['gap_hours_median'],
            ', '.join(h for h, _ in sorted(up['hour'].items(), key=lambda x: -x[1])[:3])), '']
    if notes:
        L += ['> ' + n for n in notes] + ['']
    L += ['## 상위군이 하위군과 다른 점 Top 5', '', '| 속성 | 상위 | 하위 | 효과 |', '|---|---|---|---|']
    for d in diffs[:5]:
        k = d['key']
        L.append('| %s | %s | %s | %+.2f |' % (LABEL.get(k, k), d['top'], d['bottom'], d['effect']))
    tn = sum(x['source'] != 'none' for x in sc['rows'] if x['group'] == 'top')
    bn = sum(x['source'] != 'none' for x in sc['rows'] if x['group'] == 'bottom')
    L += ['', '효과 = (상위 평균 − 하위 평균) ÷ 표준편차(비율 칸은 차이×2). |효과| ≥ 0.8 이 큰 차이. 표본이 작아 방향만 본다.',
          '⚠전사 오류 편(외국어·가사 오인식 자동 판정 + flags.json 손 표시)은 문장 칸(문장 수·평균 글자·첫 문장 유형·끝 문장)에서 빼고, 첫 말 시각·말 비중엔 남긴다.',
          '원고 칸(말 비중·문장·첫 문장 유형 등)은 전사가 있는 편끼리만 비교 — 지금 상위 %d · 하위 %d편%s.'
          % (tn, bn, ' (3편 미만인 군이 있어 원고 칸은 비교 보류)' if min(tn, bn) < 3 else ''), '',
          '## 원고 근거 — 상위군 첫 문장', '']
    tops = {x['id']: x for x in sc['rows']}
    for vid in ch['top_ids']:
        x = tops.get(vid)
        if x and x['first_sentence']:
            L.append('- [%s회 · %s초] %s%s  `https://youtube.com/shorts/%s` (첫 말 %s초)'
                     % (f"{x['views']:,}", x['sec'], '' if x.get('transcript_ok') is not False else '⚠전사 오류(문장 칸 제외) ',
                        x['first_sentence'][:60], vid, x['first_speech_sec']))
    L += ['', '## 분류', '', '- 포맷 코드: (사람 지정 — 발굴 포맷 카탈로그 이름)', '- 결 태그: (사람 지정 — 위 Top 5·첫 문장을 보고 3~5개)',
          '- 우리 레인 대비: 지구관측소 롱투숏 편이 30편 쌓이면 같은 표로 나란히 잰다(A 요청).', '']
    return '\n'.join(L)


def fetch_videos(ids):
    rows = []
    for i in range(0, len(ids), 50):
        for v in yt('videos', part='snippet,statistics,contentDetails,status', id=','.join(ids[i:i + 50])).get('items', []):
            s = v['statistics']
            rows.append({'id': v['id'], 'title': v['snippet']['title'], 'pub': v['snippet']['publishedAt'],
                         'channel': v['snippet']['channelTitle'], 'channel_id': v['snippet']['channelId'],
                         'sec': iso_sec(v['contentDetails']['duration']), 'views': int(s.get('viewCount', 0)),
                         'likes': int(s.get('likeCount', 0)), 'comments': int(s.get('commentCount', 0)),
                         'privacy': v.get('status', {}).get('privacyStatus', 'public')})
    order = {x: k for k, x in enumerate(ids)}
    return sorted(rows, key=lambda r: order.get(r['id'], 99))


def transcript_md(r, words, lang):
    """시각 박은 문장 전사 — 따라 만들 원고 구조를 사람이 읽는 용도."""
    L = ['# %s' % r['title'], '', '- %s · %s · %s회 · %d분 %02d초 · https://youtu.be/%s'
         % (r.get('channel', ''), r['pub'][:10], f"{r['views']:,}", r['sec'] // 60, r['sec'] % 60, r['id']), '']
    for s in sentences(words, lang):
        L.append('[%02d:%02d] %s' % (int(s['start']) // 60, int(s['start']) % 60, s['text']))
    return '\n'.join(L) + '\n'


def run_ids(a, now):
    """영상 단위(--ids) — 상·하위 비교 없이 지정한 영상들의 원고 표 + 시각 박은 전사. 다른 채널끼리 섞어도 된다."""
    ids = [x.strip() for x in a.ids.split(',') if x.strip()]
    rows = fetch_videos(ids)
    label = re.sub(r'[^\w.-]', '_', a.channel)
    cache = ROOT / 'server' / 'data' / 'ref_analyze' / '_videos'
    out = ROOT / 'reference' / a.lane / label
    (out / 'transcripts').mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    logf = cache / 'fetch_log.json'
    log = json.loads(logf.read_text(encoding='utf-8')) if logf.exists() else {}
    today = now.astimezone(KST).date().isoformat()
    ok, why = gate(log, today, a.max_429, a.max_runs)
    stopped, notes, srows, stt_n, stt_min = (not ok), ([] if ok else ['자막 받기 건너뜀 — ' + why]), [], 0, 0.0
    if ok:
        log.setdefault(today, {'runs': 0, '429': 0})['runs'] += 1
    for r in rows:
        words, source = None, 'none'
        sttf = cache / ('%s.stt.json' % r['id'])
        cached = sttf.exists() or (cache / ('%s.%s.json3' % (r['id'], a.lang))).exists()
        if cached or not stopped:
            before = auto_subs.fetched + stt_n
            try:
                f = None if (sttf.exists() or a.stt_only) else auto_subs(r['id'], a.lang, cache)
                if sttf.exists():
                    words, source = json.loads(sttf.read_text(encoding='utf-8')), 'speechmatics'
                elif f:
                    words, source = words_from_json3(f), 'auto'
                elif not a.no_stt and stt_min + r['sec'] / 60 <= a.max_stt_min:
                    words = stt(r['id'], a.lang, cache)
                    source = 'speechmatics' if words else 'none'
                    stt_n += 1
                    stt_min += r['sec'] / 60
                else:
                    notes.append('%s 전사 생략(자동 자막 없음 · STT 상한 또는 --no-stt)' % r['id'])
            except Stop:
                stopped = True
                day = log.setdefault(today, {'runs': 0, '429': 0})
                day['429'] += 1
                day.setdefault('429_at', []).append(dt.datetime.now(KST).strftime('%H:%M:%S'))
                notes.append('429 중단 — %s 부터 받지 않았다(재시도·우회 없음)' % r['id'])
            if auto_subs.fetched + stt_n > before:
                time.sleep(random.uniform(a.sleep_min, a.sleep_max))
        row = script_row(r, words or [], a.lang, source)
        row.update(title_row(r))
        row.update({'title': r['title'], 'channel': r['channel'], 'pub': r['pub'][:10]})
        if words:
            row['sentences_per_min'] = round(row['n_sentences'] / max(r['sec'] / 60, 0.1), 1)
            (out / 'transcripts' / ('%s.md' % r['id'])).write_text(transcript_md(r, words, a.lang), encoding='utf-8')
        srows.append(row)
    logf.write_text(json.dumps(log, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if stt_n:
        notes.append('Speechmatics %d편 · %.1f분 사용' % (stt_n, stt_min))
    (out / 'script.json').write_text(json.dumps({'lang': a.lang, 'ids': ids, 'rows': srows, 'notes': notes},
                                                ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    L = ['# %s — 영상 단위 원고 표 (ref-analyze, %s)' % (a.channel, dt.date.today()), '',
         '| 영상 | 채널 | 조회 | 길이 | 전사 | 말 비중 | 분당 문장 | 문장 평균 글자 | 첫 말(초) |', '|---|---|---|---|---|---|---|---|---|']
    for x in srows:
        L.append('| [%s](https://youtu.be/%s) | %s | %s | %d:%02d | %s | %s | %s | %s | %s |'
                 % (x['title'][:30], x['id'], x['channel'], f"{x['views']:,}", x['sec'] // 60, x['sec'] % 60, x['source'],
                    x['speech_share'], x.get('sentences_per_min', '-'), x['avg_sentence_chars'] or '-', x['first_speech_sec']))
    L += ['', '전사 전문(시각 박은 문장)은 transcripts/<id>.md.'] + ['- ' + n for n in notes]
    (out / 'ref.md').write_text('\n'.join(L) + '\n', encoding='utf-8')
    print('%s → %s (%d편, 전사 %d, STT %d%s)' % (a.channel, out.relative_to(ROOT), len(srows),
          sum(x['source'] != 'none' for x in srows), stt_n, ', 중단' if stopped else ''))
    return 3 if stopped else 0


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(description='ref-analyze 1단계')
    ap.add_argument('channel', help='@핸들 또는 UC… 채널 ID (--ids 면 산출 폴더 이름)')
    ap.add_argument('--ids', help='영상 단위: 영상 ID 쉼표 목록(상·하위 비교 없이 원고 표 + 시각 박은 전사)')
    ap.add_argument('--lane', required=True)
    ap.add_argument('--n', type=int, default=20, help='원고 표본 수(상위 n/2 + 하위 n/2)')
    ap.add_argument('--shorts', action='store_true', help='쇼츠 탭(UUSH)만')
    ap.add_argument('--long', action='store_true', help='동영상 탭(UULF — 쇼츠·라이브 제외)만')
    ap.add_argument('--min-sec', type=int, default=0, help='이 길이(초) 미만은 표본에서 뺀다(예: 롱폼만 1200)')
    ap.add_argument('--lang', default='ko', choices=['ko', 'ja', 'en'])
    ap.add_argument('--no-stt', action='store_true', help='Speechmatics 안 씀(자동 자막만)')
    ap.add_argument('--stt-only', action='store_true', help='--ids 에서 자막 요청 없이 Speechmatics 만(자막 창 밖 — 관리자 10-16 «메타·Speechmatics만»)')
    ap.add_argument('--max-stt', type=int, default=20)
    ap.add_argument('--max-stt-min', type=float, default=180)
    ap.add_argument('--sleep-min', type=float, default=3.0, help='자막 요청 사이 쉼 하한(초, 무작위)')
    ap.add_argument('--sleep-max', type=float, default=5.0)
    ap.add_argument('--max-fetch', type=int, default=20, help='한 번 실행에 새로 받는 자막 상한(캐시는 안 셈)')
    ap.add_argument('--max-429', type=int, default=1, help='하루 429 이만큼이면 이 채널은 그날 접음')
    ap.add_argument('--max-runs', type=int, default=3, help='하루 자막 받기 실행 상한(첫 실행 + 재시도 2회)')
    a = ap.parse_args(argv)
    if a.shorts and a.long:
        ap.error('--shorts 와 --long 은 같이 못 쓴다')

    now = dt.datetime.now(dt.timezone.utc)
    if a.ids:
        return run_ids(a, now)
    meta, rows = fetch_channel(a.channel, a.shorts, long=a.long)
    if a.min_sec:
        meta['min_sec'], meta['n_before_min_sec'] = a.min_sec, len(rows)
        rows = [r for r in rows if r['sec'] >= a.min_sec]
    slug = re.sub(r'[^\w.-]', '_', (meta['handle'] or meta['id']).lstrip('@'))
    cache = ROOT / 'server' / 'data' / 'ref_analyze' / slug
    out = ROOT / 'reference' / a.lane / slug
    cache.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    pool, top, bot = pick(rows, a.n, now)
    flagf = out / 'flags.json'  # 사람이 표시한 전사 오류 — {"bad_transcript": [{"id":…, "why":…, "by":…}]}
    bad = {x['id'] for x in (json.loads(flagf.read_text(encoding='utf-8')).get('bad_transcript', []) if flagf.exists() else [])}
    ch = channel_table(meta, rows, pool, top, bot, now)
    up = upload_table(rows, now)

    notes, srows, stt_n, stt_min, skipped, stopped = [], [], 0, 0.0, 0, False
    logf = cache / 'fetch_log.json'
    log = json.loads(logf.read_text(encoding='utf-8')) if logf.exists() else {}
    today = now.astimezone(KST).date().isoformat()
    ok, why = gate(log, today, a.max_429, a.max_runs)
    if not ok:
        stopped = True
        notes.append('자막 받기 건너뜀 — %s(캐시만으로 표를 쓴다)' % why)
    else:
        log.setdefault(today, {'runs': 0, '429': 0})['runs'] += 1
    order = [r for pair in zip(top, bot) for r in pair]  # 상·하위 번갈아 — 중간에 멈춰도 두 군이 같이 남는다
    for r in order:
        words, source = None, 'none'
        cached = (cache / ('%s.%s.json3' % (r['id'], a.lang))).exists() or (cache / ('%s.stt.json' % r['id'])).exists()
        if not cached and auto_subs.fetched + stt_n >= a.max_fetch:
            stopped = stopped or 'cap'
        if not stopped or cached:
            before = auto_subs.fetched + stt_n
            try:
                sttf = cache / ('%s.stt.json' % r['id'])
                f = None if sttf.exists() else auto_subs(r['id'], a.lang, cache)
                if sttf.exists():  # 이미 전사한 편 — 자막 요청 없이 캐시
                    words, source = json.loads(sttf.read_text(encoding='utf-8')), 'speechmatics'
                elif f:
                    words, source = words_from_json3(f), 'auto'
                elif a.no_stt:
                    skipped += 1
                elif stt_n < a.max_stt and stt_min + r['sec'] / 60 <= a.max_stt_min:
                    words = stt(r['id'], a.lang, cache)
                    source = 'speechmatics' if words else 'none'
                    stt_n += 1
                    stt_min += r['sec'] / 60
                else:
                    skipped += 1
            except Stop:
                stopped = True
                day = log.setdefault(today, {'runs': 0, '429': 0})
                day['429'] += 1
                day.setdefault('429_at', []).append(dt.datetime.now(KST).strftime('%H:%M:%S'))  # 제한 폭 가늠용(관리자 10-16)
                notes.append('429 중단 — %s 이후 자막을 받지 않았다(재시도·우회 없음, 이 채널은 오늘 접음)' % r['id'])
            if auto_subs.fetched + stt_n > before:
                time.sleep(random.uniform(a.sleep_min, a.sleep_max))
        row = script_row(r, words or [], a.lang, source)
        if r['id'] in bad:
            row['transcript_ok'] = False
        row.update(title_row(r))
        row['group'] = 'top' if r in top else 'bottom'
        srows.append(row)
    if stopped == 'cap':
        notes.append('이번 실행 상한 %d편까지 받았다 — 나머지는 다음 시간대에 같은 명령으로(캐시 이어 받기)' % a.max_fetch)
    logf.write_text(json.dumps(log, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if skipped:
        notes.append('전사 생략 %d편(자동 자막 없음 · STT 상한 또는 --no-stt)' % skipped)
    if stt_n:
        notes.append('Speechmatics %d편 · %.1f분 사용' % (stt_n, stt_min))
    sc = {'lang': a.lang, 'n': len(srows), 'stt_used': stt_n, 'stt_minutes': round(stt_min, 1), 'skipped': skipped,
          'stopped': stopped, 'rows': srows}
    diffs = compare([x for x in srows if x['group'] == 'top'], [x for x in srows if x['group'] == 'bottom'])
    sc['diffs'] = diffs
    for name, obj in (('channel.json', ch), ('upload.json', up), ('script.json', sc)):
        (out / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (out / 'class.md').write_text(class_md(ch, up, sc, diffs, a.lane, notes) + '\n', encoding='utf-8')
    print('%s → %s (표본 %d, 자동 자막 %d, STT %d, 생략 %d%s)' % (meta['title'], out.relative_to(ROOT), len(srows),
          sum(x['source'] == 'auto' for x in srows), stt_n, skipped, ', 중단: %s' % stopped if stopped else ''))
    return 3 if stopped is True else 0  # 3 = 429·하루 상한으로 접음 → 다음 채널로


if __name__ == '__main__':
    sys.exit(main())
