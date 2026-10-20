# -*- coding: utf-8 -*-
"""scripts/tag_gate.py 자기 테스트 — API 0, 임시 폴더만."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import tag_gate as tg  # noqa: E402

assert tg.common_words('조희대 탄핵, 민주당은 왜', '조희대 탄핵소추안을 두고 민주당이\n둘째 줄\n셋째 줄 국회', ['조희대', '민주당', '국회', '#조희대']) == ['조희대', '민주당']
assert tg.tag_content(['조희대 탄핵', '국회'], '조희대 대법원장 탄핵 이야기') == (0.5, ['국회'])
assert tg.tag_content(['a'], '') == (None, [])
with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    tg.LEDGER = t / 'err.jsonl'
    up = t / 'upload.json'
    up.write_text(json.dumps({'title': '크랜베리 밭을 물에 잠그는 이유', 'description': '크랜베리 수확은 밭을 물에 잠가서 한다\n둘째 줄',
                              'tags': ['크랜베리', '수확', '농장', '미국 농업']}, ensure_ascii=False), encoding='utf-8')
    (t / 'script.txt').write_text('크랜베리 밭을 물에 잠급니다. 수확할 때 열매가 뜹니다.\n', encoding='utf-8')
    r = tg.check(up)
    assert r['common'] == ['크랜베리'] and r['ratio'] == 0.5, r          # 공통 1개 → 경고
    assert any('공통 낱말 1개' in w for w in r['warnings'])
    assert tg.main([str(up)]) == 0 and tg.main([str(up), '--fail-on-warn']) == 4
    assert tg.main([str(up), '--min', '1', '--fail-on-warn']) == 0
    bad = t / 'bad.json'
    bad.write_text(json.dumps({'title': '제목만'}, ensure_ascii=False), encoding='utf-8')
    assert tg.main([str(bad)]) == 5 and tg.LEDGER.exists()
print('OK')
