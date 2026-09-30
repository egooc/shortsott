# -*- coding: utf-8 -*-
"""댓글·설명·고정댓글에서 작품명을 찾는다 — 원고를 듣기 «전에» 값싸게.

    python scripts/title_from_comments.py <videoId> [...]
    python scripts/title_from_comments.py --pending [--limit 40]

왜 (2026-09-29 소유주: "댓글이나 설명에 안 나와 있어?")
  안 봤다. 나는 원고를 STT 로 듣고 내가 읽어서 제목을 달고 있었는데,
  리캡 채널 댓글에는 «이거 무슨 영화예요?» → 누가 답해 주는 흐름이 흔하다.
  설명문·고정댓글에 대놓고 적어 두는 채널도 있다.
  → **댓글이 먼저다.** 여기서 잡히면 STT 도 사람 판독도 필요 없다.

무엇을 긁나
  · 영상 설명문
  · 상위 댓글과 그 답글 (좋아요 순)
  이 안에서 «영화 제목처럼 생긴 것»을 찾는다 — 따옴표·괄호로 묶였거나 연도가 붙은 덩어리,
  그리고 movie/film/영화 같은 말 뒤에 오는 덩어리.

★여기서 나온 이름도 **그대로 믿지 않는다.** 후보로만 모아서 사람(또는 나)이 확인한 뒤
  `whitelist_from_narration.py --commit` 으로 올린다. 댓글은 틀릴 수 있다.
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'server', 'data', 'narration_probe.json')
OUT = os.path.join(ROOT, 'server', 'data', 'title_hints.json')

ASK = re.compile(r'(what|which|name of the)\s+(movie|film|show|series)|무슨\s*(영화|드라마)|제목\s*[이가]?\s*(뭐|무엇)',
                 re.I)
# 「제목 (2016)」 · 「"제목"」 · 「movie: 제목」 꼴
PATTERNS = [
    re.compile(r'\b([A-Z][\w\'\-\.]*(?:\s+[A-Za-z0-9\'\-\.:&]+){0,6})\s*\((19|20)\d{2}\)'),
    re.compile(r'(?:movie|film|it\'?s|this is|from)\s*[:\-]?\s*["“]([^"”]{2,60})["”]', re.I),
    re.compile(r'(?:영화|드라마)\s*[:\-]?\s*[「"\'‘“]?([^\n"”\'’」]{2,40})'),
    re.compile(r'["“]([A-Z][^"”\n]{2,50})["”]'),
]
STOP = re.compile(r'^(the movie|this movie|a movie|movie|film|shorts?|subscribe|comment|part \d)$', re.I)


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


def texts_for(video_id):
    """설명문 + 댓글(답글 포함)을 한 덩어리 목록으로."""
    out = []
    try:
        items = api('videos', part='snippet', id=video_id).get('items') or []
        if items:
            out.append(('설명', items[0]['snippet'].get('description') or ''))
    except Exception:
        pass
    try:
        page = api('commentThreads', part='snippet,replies', videoId=video_id,
                   maxResults=60, order='relevance', textFormat='plainText')
        for th in page.get('items', []):
            top = th['snippet']['topLevelComment']['snippet']
            out.append(('댓글', top.get('textDisplay') or ''))
            for rep in (th.get('replies') or {}).get('comments', []):
                out.append(('답글', rep['snippet'].get('textDisplay') or ''))
    except Exception as exc:
        out.append(('오류', str(exc)[:80]))
    return out


def candidates(blocks):
    """제목처럼 생긴 덩어리를 모은다. 질문에 대한 «답글»은 가산점."""
    found = {}
    asked = any(ASK.search(t) for _, t in blocks)
    for kind, raw in blocks:
        text = html.unescape(raw or '')
        for pat in PATTERNS:
            for m in pat.finditer(text):
                name = (m.group(1) or '').strip(' :-—·.,"\'')
                if not name or len(name) < 2 or STOP.match(name):
                    continue
                w = 3 if kind == '답글' and asked else (2 if kind == '설명' else 1)
                found[name] = found.get(name, 0) + w
    return sorted(found.items(), key=lambda kv: -kv[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ids', nargs='*')
    ap.add_argument('--pending', action='store_true')
    ap.add_argument('--limit', type=int, default=40)
    args = ap.parse_args()
    load_env()

    ids = list(args.ids)
    if args.pending:
        store = read_json(STORE, {})
        rows = [v for v in store.values() if not v.get('film_en')]
        rows.sort(key=lambda v: -v.get('views', 0))
        ids += [v['id'] for v in rows[:args.limit]]

    hints = read_json(OUT, {})
    for vid in ids:
        if vid in hints:
            continue
        cands = candidates(texts_for(vid))
        hints[vid] = cands[:6]
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(hints, fh, ensure_ascii=False, indent=2)
        top = ' · '.join(f'{n}({w})' for n, w in cands[:4]) or '(없음)'
        print(f'  {vid}  {top}')

    got = sum(1 for v in hints.values() if v)
    print(f'\n영상 {len(hints)}건 · 후보가 나온 것 {got}건 ({100 * got / max(len(hints), 1):.0f}%)')
    print('★후보는 «확인 대상»이다. 그대로 올리지 마라 — 댓글은 틀릴 수 있다.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
