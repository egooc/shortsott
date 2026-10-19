# -*- coding: utf-8 -*-
"""가이드라인 낱말 점검(정본 config/guide_words.json) — 업로드 관문들이 import 하는 판정 + 단독 실행.
10-18 소유주: «제재 없이도 피드 못 받는 거면 커뮤니티 가이드 위반 — 위험한 거·칼·마약·총기·살인·피·어린아이 대상».
판정 규칙은 롱투숏 guide_check.py 와 같다(위험 행위 = 대상+행위 둘 다, 나머지 범주 = 낱말 하나). 그쪽이 함수로 분리되면 이 모듈이 그걸 import 하도록 바꾼다.

    python scripts/guide_words.py --lang ko|ja [--lane nenkin] <upload.json | packages.json | compose.json | 문구> ...

종료 코드 0 = 깨끗 · 4 = 걸림(발행 중단, 우회는 소유주 말이 있을 때만 GUIDE_OK=1).

관문에서:
    sys.path.insert(0, 'D:/midform/scripts'); import guide_words
    bad += guide_words.gate_lines(paths, lang='ko', lane='politics')     # ['packages.json 0번 제목 · 살인·죽음: [...]', ...]
"""
import json
import os
import re
import sys
from pathlib import Path

WORDS = Path(__file__).resolve().parents[1] / 'config' / 'guide_words.json'


def load():
    return json.loads(WORDS.read_text(encoding='utf-8'))


def hits(text, lang='ko', lane=None, W=None):
    """[(범주, [낱말…])] — 걸린 것만."""
    W = W or load()
    L = W[lang]
    t = re.sub(r'https?://\S+|@\S+', ' ', text or '')   # 원작자 @핸들·URL 은 낱말 맞추기 전에 지운다(N100 «@shitonthebeach» 오탐, 10-18)
    t = re.sub(r'#', ' ', t)
    ex = W['exclude']
    for x in ex.get('common', []) + ex.get(f'{lang}_common', []) + (ex.get(lane, []) if lane else []):
        t = t.replace(x, ' ')
    out = []
    risky = L.get('risky')
    if risky:
        obj = list(dict.fromkeys(n for w, n in risky['objects'].items() if w in t))
        act = [w for w in risky['actions'] if w in t]
        if obj and act:
            out.append(('위험 행위', obj + act))
    animal = L.get('animal')
    if animal:   # 동물 학대 오해 — 동물+행위가 같은 문장에 있을 때만(10-19, N100 목록)
        found = []
        for s in re.split(r'[.!?。！？\n]+', t):
            obj = [w for w in animal['objects'] if w in s]
            act = [w for w in animal['actions'] if w in s]
            if obj and act:
                found += [w for w in obj + act if w not in found]
        if found:
            out.append(('동물 학대 오해', found))
    tl = t.lower()   # 영문 욕설(fuck·shit)은 대소문자 무시
    for cat, words in L['categories'].items():
        f = [w for w in words if w in t or (w.isascii() and w in tl)]
        if f:
            out.append((cat, f))
    return out


def fields(path):
    """파일 하나 → [(이름, 문구)] — upload.json(title·description·tags) · packages.json(포장마다 제목·큰 낱말) · compose.json(썸네일 두 줄)."""
    p = Path(path)
    if not (p.suffix == '.json' and p.exists()):
        return [('(문구)', str(path))]
    d = json.loads(p.read_text(encoding='utf-8'))
    out = []
    if 'packages' in d:
        for i, k in enumerate(d['packages']):
            out.append((f'{p.name} {i}번 제목', k.get('title', '')))
            out.append((f'{p.name} {i}번 썸네일 큰 낱말', ' '.join(k.get('big', []))))
            if k.get('description'):
                out.append((f'{p.name} {i}번 설명', k['description']))
    if 'variants' in d:
        for i, v in enumerate(d['variants']):
            out.append((f'{p.name} {i}번 썸네일 문구', f'{v.get("top", "")} {v.get("bottom", "")}'))
    if 'title' in d:
        out.append((f'{p.name} 제목', d.get('title', '')))
    if 'description' in d:
        out.append((f'{p.name} 설명', d.get('description', '')))
    if 'tags' in d:
        out.append((f'{p.name} 태그', ' '.join(d.get('tags', []))))
    for k in ('thumb', 'thumb_words', 'big'):
        if isinstance(d.get(k), list):
            out.append((f'{p.name} {k}', ' '.join(map(str, d[k]))))
    return out


def gate_lines(paths, lang='ko', lane=None):
    """관문용: 걸린 줄 목록(비면 통과). GUIDE_OK=1 이면 빈 목록(소유주 말이 있을 때만)."""
    if os.environ.get('GUIDE_OK') == '1':
        return []
    W = load()
    bad = []
    for path in paths:
        for name, text in fields(path):
            for cat, ws in hits(text, lang, lane, W):
                bad.append(f'{name} · 가이드 {cat}: {ws}')
    return bad


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    lang = argv[argv.index('--lang') + 1] if '--lang' in argv else 'ko'
    lane = argv[argv.index('--lane') + 1] if '--lane' in argv else None
    skip = {i for k in ('--lang', '--lane') if k in argv for i in (argv.index(k), argv.index(k) + 1)}
    paths = [a for i, a in enumerate(argv) if i not in skip]
    bad = gate_lines(paths, lang, lane)
    print('\n'.join(f'✗ {b}' for b in bad) if bad else f'✓ 가이드 낱말 걸림 없음 ({lang}{"/" + lane if lane else ""}, {len(paths)}개)')
    return 4 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
