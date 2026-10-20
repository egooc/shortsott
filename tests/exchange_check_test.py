# -*- coding: utf-8 -*-
"""scripts/exchange_check.py 자기 테스트 — API 0, 임시 폴더만."""
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import exchange_check as ex  # noqa: E402


def w(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return p


def b(role, sp, a, z):
    return {'role': role, 'speaker': sp, 'in': a, 'out': z}


with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    ex.LEDGER = t / 'gate_errors.jsonl'
    good = w(t / 'g' / 'plan.json', {'beats': [b('question', 'narration', 0, 2), b('attack', '갑', 2, 8), b('reaction', '을', 8, 10),
                                               b('counter', '을', 10, 18), b('attack', '갑', 18, 22)]})
    r = ex.check(good, enforce=True)
    assert r['code'] == 0 and r['longest_run'] == {'speaker': '을', 'sec': 10.0}, r
    assert ex.main([str(good), '--enforce-now']) == 0
    # ① 반응·대응 없음 + ③ 한 사람 15초 → 4
    one = w(t / 'o' / 'plan.json', {'beats': [b('attack', '갑', 0, 15), b('narration', None, 15, 17)]})
    r = ex.check(one, enforce=True)
    assert r['code'] == 4 and any(e.startswith('①') for e in r['errors']) and any(e.startswith('③') for e in r['errors']), r
    # ② attack·counter 같은 화자
    w(one, {'beats': [b('attack', '갑', 0, 3), b('reaction', '을', 3, 5), b('counter', '갑', 5, 8)]})
    assert any(e.startswith('②') for e in ex.check(one, enforce=True)['errors'])
    # ④ 해설 30% 넘으면 경고만
    w(one, {'beats': [b('narration', None, 0, 6), b('attack', '갑', 6, 9), b('reaction', '을', 9, 11), b('counter', '을', 11, 14)]})
    r = ex.check(one, enforce=True)
    assert r['code'] == 0 and r['warnings'][0].startswith('④'), r
    # ⑤ role 없음 → 5(정치 필수), 선택 레인은 생략 0
    nr = w(t / 'n' / 'plan.json', {'beats': [{'speaker': '갑', 'in': 0, 'out': 5}]})
    assert ex.check(nr, enforce=True)['code'] == 5
    assert ex.main([str(nr), '--enforce-now']) == 5 and ex.LEDGER.exists()
    r = ex.check(nr, lane='fantube', enforce=True)
    assert r['code'] == 0 and r['skipped'], r
    # 유예 기간엔 판정은 남기되 종료 0
    r = ex.check(nr, now=ex.ENFORCE_FROM - dt.timedelta(hours=1))
    assert r['code'] == 5 and r['exit'] == 0 and not r['enforced'], r
    assert ex.check(nr, now=ex.ENFORCE_FROM + dt.timedelta(hours=1))['exit'] == 5
    # 정치 쇼츠 sequence 꼴: who 상속, 해설 카드는 narration(길이=글자/7), 화자 연속 합
    sq = w(t / 's' / 'plan.json', {'narration': [{'id': 'n0', 'cards': ['가' * 14]}],
                                   'sequence': [{'source_in': 0, 'source_out': 3, 'who': 'a', 'role': 'attack'},
                                                {'narration': 'n0'},
                                                {'source_in': 10, 'source_out': 20, 'who': 'a', 'role': 'attack'},
                                                {'source_in': 20, 'source_out': 25, 'role': 'attack'},
                                                {'source_in': 30, 'source_out': 33, 'who': 'b', 'role': 'counter'}]})
    bs = ex.beats_of(json.loads(sq.read_text(encoding='utf-8')))
    assert bs[1]['speaker'] == 'narration' and bs[1]['sec'] == 2.0 and bs[3]['speaker'] == 'a', bs
    r = ex.check(sq, enforce=True)
    assert any('a 혼자 15.0초' in e for e in r['errors']) and any('reaction' in e for e in r['errors']), r
    # 없는 경로 → 5
    assert ex.check(t / 'nope', enforce=True)['code'] == 5
print('OK')
