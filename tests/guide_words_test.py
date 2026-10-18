# -*- coding: utf-8 -*-
"""guide_words.py 자기 테스트 — 정본 json 구조·판정(위험 행위는 대상+행위·제외 낱말·ja)·파일 필드.
    python tests/guide_words_test.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import guide_words as G  # noqa: E402

W = G.load()
assert set(W) >= {'ko', 'ja', 'exclude'} and 'common' in W['exclude']
assert W.get("_version"), "정본 _version 없음 — 바꿀 때마다 날짜.번호 올리고 변경 보고에 한 줄"
assert len(W['ko']['categories']) == 8 and len(W['ja']['categories']) == 8   # 7범주 + 욕설(.3)
cats = lambda t, lang='ko', lane=None: [c for c, _ in G.hits(t, lang, lane, W)]
assert cats('펄펄 끓는 물에 손 넣었더니') == ['위험 행위']
assert cats('끓는 물의 정체') == []                       # 대상만 있으면 안 걸림
assert cats('칼국수 맛집') == [] and cats('피자 한 판') == []
assert '살인·죽음' in cats('남편은 아내를 살해했다')
assert '어린아이 대상' in cats('두 아이를 데리고', ) or cats('아이들과') == ['어린아이 대상']
assert cats('아이돌 무대') == []
assert '살인·죽음' in cats('殺人事件の真相', 'ja') and '어린아이 대상' in cats('子どもが', 'ja')
assert cats('扶養親族等申告書の書き方', 'ja') == []
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / 'packages.json'
    p.write_text(json.dumps({'packages': [{'title': '초코파이는 남았다', 'big': ['초코파이']},
                                          {'title': '그 회사 사장은 살해됐다', 'big': ['사장']}]}, ensure_ascii=False), encoding='utf-8')
    bad = G.gate_lines([str(p)], 'ko')
    assert len(bad) == 1 and '1번 제목' in bad[0], bad
    assert G.main(['--lang', 'ko', str(p)]) == 4
assert cats('아기 고양이 구조') == [] and cats('커터칼로 보온재를') == [] and cats('총알처럼 빠른') == []   # N100 오탐(.3)
assert cats('사업의 시발점') == [] and cats('존나 웃김') == ['욕설'] and cats('WHAT THE FUCK') == ['욕설']
assert cats('三匹が斬る！の殺陣', 'ja', 'jp_highlight') == [] and '칼·흉기' in cats('辻斬りが出る', 'ja', 'jp_highlight')
assert '총기' in cats('鉄砲を構え', 'ja') and cats('銃後の守り', 'ja') == []
assert cats('子どもの頃から助け合って', 'ja') == [] and '어린아이 대상' in cats('子どもたちが', 'ja')   # 어린 시절 회상은 아동 대상 아님(.4)
print('OK')
