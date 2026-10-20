# -*- coding: utf-8 -*-
"""scripts/hook_link.py 자기 테스트 — API 0, 임시 폴더만."""
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import hook_link as hl  # noqa: E402

assert hl.link({'text': '해원 부탁에 엄태구가 소리쳤다'}, '해원에게서 대신 느끼는 예능 여유')['common'] == ['해원']
assert not hl.link('빨간 밭은 왜 물에 잠글까', '손 하나 안 대고 해결되는 시원함')['ok']
assert hl.link('이 빨간 밭은 왜 일부러 물에 잠글까요', '물만 채웠을 뿐인데 밭 전체가 떠오르는 시원함 (근거: 빨간 영상)')['ok']
assert hl.nouns('年金の書類を読む', 'ja') == ['年金', '書類']
with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    hl.LEDGER = t / 'err.jsonl'
    p = t / 'plan.json'
    p.write_text(json.dumps({'hook': {'visual': '붉은 열매 밭', 'audio': '왜 물에 잠글까'}, 'vicarious': '열매가 한 번에 떠오르는 시원함'}, ensure_ascii=False), encoding='utf-8')
    assert hl.main([str(p), '--enforce-now']) == 0
    p.write_text(json.dumps({'hook': '고양이가 뛴다', 'vicarious': '밭이 빨갛게 떠오른다'}, ensure_ascii=False), encoding='utf-8')
    assert hl.check(p, enforce=True)['code'] == 4
    assert hl.check(p, now=hl.ENFORCE_FROM - dt.timedelta(hours=1))['exit'] == 0
    p.write_text(json.dumps({'hook': '고양이가 뛴다'}, ensure_ascii=False), encoding='utf-8')
    assert hl.main([str(p), '--enforce-now']) == 5 and hl.LEDGER.exists()
print('OK')
