# -*- coding: utf-8 -*-
"""scripts/api_quota.py 자기 테스트 — 임시 장부·설정으로 상한·중지·요약 확인(API 0)."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import api_quota as q  # noqa: E402

with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    q.LOG, q.CFG, q.LEDGER = t / 'q.jsonl', t / 'c.json', t / 'e.jsonl'
    q.CFG.write_text(json.dumps({'day_total': 150, 'tools': {'a': 3, 'other': 500}, 'units': {'search': 100, 'default': 1}}), encoding='utf-8')
    for _ in range(3):
        q.spend('a', 'videos')
    try:
        q.spend('a', 'videos')
        raise AssertionError('도구 상한을 넘겼는데 통과')
    except q.QuotaStop:
        pass
    q.spend('b', 'search')                      # 100단위
    try:
        q.spend('b', 'search')                  # 계 203 > 150
        raise AssertionError('전체 상한을 넘겼는데 통과')
    except q.QuotaStop:
        pass
    assert q.used()[0] == 103 and '계 103/150' in q.summary()
    q.mark_blocked('b', 'videos 429')
    try:
        q.spend('other_tool', 'videos')
        raise AssertionError('중지 뒤 통과')
    except q.QuotaStop as e:
        assert '중지' in str(e)
    assert '★중지' in q.summary() and q.LEDGER.exists()
print('OK')
