"""정치JA 레퍼런스 전사 채우기(10-20 관리자: ref_overlap 관문) — reference/ja/politics-{long,small,explainer-shorts} 의
Speechmatics 단어 전사(diar_*.json, 이미 받아 둔 것 · 유튜브 자막 요청 없음)를 ref_overlap 규약 md 로 바꾼다.

    python politics-hour-ja/ref_fill.py   → reference/ja_politics/politics_refs/transcripts/<폴더>__<id>.md

전사에 문장부호가 없어 0.25초 쉼·화자 바뀜·30자에서 끊고 「。」를 붙인다(원고 한 문장과 길이가 비슷해야 difflib 비율이 맞는다).
전사 md 는 남의 원고라 커밋하지 않는다."""
import json, sys
from pathlib import Path
ROOT = Path('D:/midform'); OUT = ROOT / 'reference/ja_politics/politics_refs/transcripts'
OUT.mkdir(parents=True, exist_ok=True)
n = 0; sents = 0
for sub in ['politics-long', 'politics-small', 'politics-explainer-shorts']:
    d = ROOT / 'reference/ja' / sub
    for f in sorted(d.glob('diar_*.json')):
        j = json.loads(f.read_text(encoding='utf-8')); w = j['words']
        w = [(x['s'], x['e'], x['w'], x.get('spk')) if isinstance(x, dict) else tuple(x[:4]) for x in w]
        vids = len(j.get('marks') or []) or 1; n += vids - 1
        lines, cur, st, prev_end, spk = [], '', None, None, None
        for a, b, t, s in w:
            if cur and (a - prev_end >= 0.25 or s != spk or len(cur) >= 30):
                lines.append((st, cur)); cur = ''
            if not cur: st = a
            cur += t; prev_end = b; spk = s
        if cur: lines.append((st, cur))
        stamp = lambda x: f'[{int(x//60):02d}:{int(x%60):02d}]' if x < 3600 else f'[{int(x//3600)}:{int(x%3600//60):02d}:{int(x%60):02d}]'
        body = [f'# {sub} · {f.stem[5:]}', '', f'- Speechmatics 음성 전사(단어) · 원본 {f.relative_to(ROOT).as_posix()}', '']
        body += [f'{stamp(a)} {t}。' for a, t in lines]
        (OUT / f'{sub}__{f.stem[5:]}.md').write_text('\n'.join(body) + '\n', encoding='utf-8')
        n += 1; sents += len(lines)
print(len(list(OUT.glob('*.md'))), '파일 ·', n, '편 ·', sents, '줄')
