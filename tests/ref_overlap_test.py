# -*- coding: utf-8 -*-
"""scripts/ref_overlap.py 자기 테스트 — API 0, 임시 폴더만."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ref_overlap as ro  # noqa: E402

with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    refs = t / 'refs'
    refs.mkdir()
    (refs / 'abc.md').write_text('# 제목\n\n- 채널 · 날짜\n[0:12] 동양그룹은 하루아침에 무너진 것이 아닙니다. 그 전에 신호가 있었습니다.\n'
                                 '[1:02:03] 年金の振込額が十月から変わる人がいます。\n', encoding='utf-8')
    # txt: 한 문장 복제(조사만 다름) + 새 문장
    s = t / 'script.txt'
    s.write_text('# 메모\n동양그룹은 하루아침에 무너진 게 아닙니다.\n해태는 과자 회사에서 출발해 건설과 전자로 몸집을 키웠습니다.\n', encoding='utf-8')
    r = ro.check(s, [refs])
    assert r['error'] is None and r['refs'] == 3, r
    assert len(r['hits']) == 1 and r['hits'][0]['ref_file'] == 'abc', r
    assert ro.main([str(s), '--refs', str(refs)]) == 4
    # ja 문장도 잡힌다
    j = t / 'ja.txt'
    j.write_text('年金の振込額が十月から変わる人がいます。\n', encoding='utf-8')
    assert ro.main([str(j), '--refs', str(refs)]) == 4
    # 정치 ko .py: nar text 만 읽고 인용 q() 는 무시
    p = t / 'script_1.py'
    p.write_text("def segments(quotes):\n    return [\n        {'type': 'nar', 'text': '새로운 해설 문장입니다. 동양그룹은 하루아침에 무너진 것이 아닙니다.'},\n"
                 "        {'type': 'quote', 'text': '그 전에 신호가 있었습니다.'},\n    ]\n", encoding='utf-8')
    assert ro.script_sentences(p) == ['새로운 해설 문장입니다.', '동양그룹은 하루아침에 무너진 것이 아닙니다.'], ro.script_sentences(p)
    assert len(ro.check(p, [refs])['hits']) == 1
    # 깨끗한 원고 = 0
    c = t / 'clean.txt'
    c.write_text('전혀 다른 이야기로 시작하는 문장입니다.\n', encoding='utf-8')
    assert ro.main([str(c), '--refs', str(refs)]) == 0
    # 검사 불가는 소리 낸다: 빈 폴더·없는 폴더 → 5 + 장부
    ro.LEDGER = t / 'gate_errors.jsonl'
    empty = t / 'empty'
    empty.mkdir()
    assert ro.main([str(c), '--refs', str(empty)]) == 5
    assert ro.main([str(c), '--refs', str(t / 'nope')]) == 5
    assert len(ro.LEDGER.read_text(encoding='utf-8').splitlines()) == 2
    # 레인 설정 읽기
    assert ro.lane_refs('nenkin_ja')[0].name == 'transcripts'
print('OK')
