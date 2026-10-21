# -*- coding: utf-8 -*-
"""정치JA 불확실 팩트 관문(G4, 관리자 10-21) — ko politics-hour/uncertain_facts.py 를 그대로 import(사본 금지), 해설 읽는 곳만 JA 꼴로.

    python politics-hour-ja/uncertain_facts_ja.py <편 폴더> --ask   해설·콜드오픈을 gpt-ask 로 교차 확인 1회 → <편>/uncertain_facts.json
    python politics-hour-ja/uncertain_facts_ja.py <편 폴더>         검사만(exit 3 = 열린 항목·파일 없음·원고가 바뀜)

JA episode.json 에는 segments 가 없고 ja_render.segments() 가 만든다 → nar_texts 를 그 결과(cold·nar)로 바꿔 끼운다.
판정·파일 형식·10/23편부터·sha(확인 뒤 원고가 바뀌면 FAIL)는 ko 와 같다. 원고 관문·업로드 관문이 gate_lines 를 부른다."""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
_spec = importlib.util.spec_from_file_location('uncertain_facts_ko', ROOT / 'politics-hour' / 'uncertain_facts.py')
uf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(uf)


def nar_texts(ep):
    sys.path.insert(0, str(HERE / 'render'))
    import ja_render
    segs = ja_render.segments(json.loads((Path(ep) / 'episode.json').read_text(encoding='utf-8')))
    return [(i, s['text']) for i, s in enumerate(segs) if s.get('type') in ('cold', 'nar') and s.get('text')]


uf.nar_texts = nar_texts   # ask()·sha() 가 모듈 전역 nar_texts 를 부른다
gate_lines = uf.gate_lines

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1]).resolve()
    if '--ask' in sys.argv:
        d = uf.ask(ep)
        print(f'[fact-ja] {len(d["facts"])}건 → {ep / "uncertain_facts.json"}')
    if '--from-answer' in sys.argv:
        d = uf.from_answer(ep)
        print(f'[fact-ja] {len(d["facts"])}건(저장된 답에서) → {ep / "uncertain_facts.json"}')
    bad = gate_lines(ep)
    for b in bad:
        print('[fact-ja] FAIL', b)
    if bad:
        sys.exit(3)
    print('[fact-ja] PASS', ep.name)
