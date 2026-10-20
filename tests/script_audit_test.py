# -*- coding: utf-8 -*-
"""scripts/script_audit.py 자기 테스트 — API 0, 임시 폴더만."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import script_audit as sa  # noqa: E402

codes = lambda r: [w['code'] for w in r['warnings']]

with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    sa.LEDGER = t / 'err.jsonl'
    # 롱폼 txt: 인사로 시작·고른 길이·질문 늦음·전환 없음 → K3·리듬·질문·전환
    lines = ['안녕하세요 오늘은 해태 이야기에 대해 알아보겠습니다.'] + ['이 문장은 거의 같은 길이로 계속 이어집니다.'] * 60
    f = t / 'script.txt'
    f.write_text('# 주석\n## 0\n@hook\n' + '\n'.join(lines) + '\n', encoding='utf-8')
    r = sa.audit(f, 'corp_ko')
    assert {'K3 첫 문장', '리듬', '질문', '전환'} <= set(codes(r)), r
    assert r['first_question_sec'] is None and r['rhythm']['cv'] < 0.3
    # 좋은 원고: 첫 문장이 질문, 길이 섞임, 전환 자주
    good = ['과자는 팔렸는데 회사는 왜 무너졌을까요?', '196억 원.', '그런데 이 돈은 그룹 빚에 비하면 아주 작은 돈이었고, 그래서 더 이상했습니다.',
            '짧게.', '문제는 그다음 날이었습니다.', '은행 창구 앞에는 아침부터 줄이 길게 늘어섰고 직원들은 아무 말도 하지 못했습니다.'] * 6
    f.write_text('\n'.join(good) + '\n', encoding='utf-8')
    r = sa.audit(f, 'corp_ko')
    assert codes(r) == [], r
    assert r['first_question_sec'] == 0 and r['transitions']['count'] >= 12
    # 카드 줄(롱투숏)은 문장 끝까지 이어 붙인다 — «잠글까요» 가 0초 질문
    f.write_text('이 빨간 밭은\n왜 일부러 물에 잠글까요\n바퀴로 덩굴을 휘저으면\n열매가 떠오릅니다.\n떠오른 열매는 어디로 갈까 아님?\n', encoding='utf-8')
    r = sa.audit(f, 'longshort')
    assert r['first_sentence'] == '이 빨간 밭은 왜 일부러 물에 잠글까요' and r['first_question_sec'] == 0, r
    # 정치 episode.json: 원음 시각·40초 규칙
    ep = t / 'ep'
    ep.mkdir()
    (ep / 'episode.json').write_text(json.dumps({'segments': [
        {'type': 'nar', 'text': '미국에서 한 말을 한국 법원이 재판할 수 있을까요. ' + '긴 설명 문장이 계속 이어집니다. ' * 20},
        {'type': 'quote', 'in': 10.0, 'out': 25.0}, {'type': 'nar', 'text': '그런데 재판은 계속됩니다.'}]}, ensure_ascii=False), encoding='utf-8')
    r = sa.audit(ep, 'politics_ko')
    assert r['first_audio_sec'] > 40 and '원음' in codes(r), r
    # 린박스 plan_local: 클립 = 원음, 해설 카드
    rb = t / 'rb'
    rb.mkdir()
    (rb / 'plan_local.json').write_text(json.dumps({'narration': [{'id': 'n1', 'cards': ['この同心のやり方', '皆さんはどう思いますか？']}],
                                                   'sequence': [{'source_in': 0, 'source_out': 4.0, 'captions': ['よし']}, {'narration': 'n1'}]},
                                                  ensure_ascii=False), encoding='utf-8')
    r = sa.audit(rb, 'rinbox')
    assert r['first_audio_sec'] == 0 and r['ending']['kinds'] == ['질문'] and '끝맺음' not in codes(r), r
    # 검사 불가 → 5 + 장부
    assert sa.main([str(t / 'nope.txt')]) == 5 and sa.LEDGER.exists()
print('OK')
