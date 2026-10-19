# -*- coding: utf-8 -*-
"""원고 ↔ 레퍼런스 전사 문장 단위 일치 검사(관리자 10-20 «레퍼런스 문장 복제 0», 1편 13행 사고 재발 방지).

    python ja-nenkin/render/ref_overlap.py ja-nenkin/ep02/script.txt [--th 0.7] [--refs reference/ja_nenkin/nenkin_refs/transcripts]

문장부호·공백을 지운 뒤 difflib 비율 ≥ th 인 쌍을 보여 준다. 종료 코드 4 = 걸림.
"""
import difflib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
norm = lambda s: re.sub(r'[、。「」『』？！・\s]', '', s)


def ref_sentences(dirs):
    out = []
    for d in dirs:
        for f in Path(d).glob('*.md'):
            for line in f.read_text(encoding='utf-8').splitlines():
                line = re.sub(r'^\[\d+:\d+(?::\d+)?\]\s*', '', line).strip()
                out += [(f.stem, s) for s in re.split(r'(?<=[。？！])', line) if len(norm(s)) >= 8]
    return [(k, norm(s), s) for k, s in out]


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    th = float(argv[argv.index('--th') + 1]) if '--th' in argv else 0.7
    dirs = [argv[argv.index('--refs') + 1]] if '--refs' in argv else [ROOT / 'reference' / 'ja_nenkin' / 'nenkin_refs' / 'transcripts']
    refs = ref_sentences(dirs)
    mine = [l.strip() for l in Path(argv[0]).read_text(encoding='utf-8').splitlines() if l.strip() and not l.startswith(('#', '@'))]
    hits = 0
    for m in mine:
        nm = norm(m)
        if len(nm) < 8:
            continue
        cands = [r for r in refs if difflib.SequenceMatcher(None, nm, r[1]).quick_ratio() >= th]
        if not cands:
            continue
        r, best = max((difflib.SequenceMatcher(None, nm, c[1]).ratio(), c) for c in cands)
        if r >= th:
            hits += 1
            print(f'{r:.2f} | {m} || {best[0]}: {best[2]}')
    print(f'레퍼런스 문장 일치 검사: 원고 {len(mine)}문장 · 레퍼런스 {len(refs)}문장 · ≥{th} {hits}건')
    return 4 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
