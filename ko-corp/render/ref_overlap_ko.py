# -*- coding: utf-8 -*-
"""원고 ↔ 레퍼런스 전사 문장 일치 검사 ko 판 — 연금 ja-nenkin/render/ref_overlap.py 를 import 하고 문장 나누기·정규화만 한국어로 바꾼다.
(관리자 10-20 전 롱폼 필수 관문 — 종료 코드 4면 TTS·렌더 금지. 도구개발 공용판이 나오면 그것으로 바꾼다.)

    python -X utf8 ko-corp/render/ref_overlap_ko.py ko-corp/ep01/script.txt [--th 0.7] [--refs reference/ko_corp/corp_refs/transcripts]

ja 판 그대로 부르면 «。？！» 로만 나눠 ko 전사가 문장으로 안 갈리고, 타임코드 한 줄(문장 조각)과 원고 한 문장을 맞대 비율이 낮게 나온다.
여기서는 파일 하나의 타임코드 줄을 이어 붙인 뒤 «. ? !» 로 다시 나눈다.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ja-nenkin' / 'render'))
import ref_overlap as R  # noqa: E402

R.norm = lambda s: re.sub(r'[\s.,?!·…"\'“”‘’«»()\[\]、。「」『』？！・~-]', '', s)


def ref_sentences(dirs):
    out = []
    for d in dirs:
        for f in Path(d).glob('*.md'):
            body = ' '.join(re.sub(r'^\[\d+:\d+(?::\d+)?\]\s*', '', ln).strip()
                            for ln in f.read_text(encoding='utf-8').splitlines() if ln.startswith('['))
            out += [(f.stem, s.strip()) for s in re.split(r'(?<=[.?!。？！])\s+', body) if len(R.norm(s)) >= 8]
    return [(k, R.norm(s), s) for k, s in out]


R.ref_sentences = ref_sentences

if __name__ == '__main__':
    argv = sys.argv[1:]
    if '--refs' not in argv:
        argv += ['--refs', str(ROOT / 'reference' / 'ko_corp' / 'corp_refs' / 'transcripts')]
    sys.exit(R.main(argv))
