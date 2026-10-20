# -*- coding: utf-8 -*-
"""scripts/script_audit.py 자기 테스트 — API 0, 임시 폴더만."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import script_audit as sa  # noqa: E402

codes = lambda r: [w['code'] for w in r['warnings']]
allc = lambda r: codes(r) + [w['code'] for w in r.get('notices', [])]   # enforce_from 전엔 V12·V14 가 notices

with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    sa.LEDGER = t / 'err.jsonl'
    # 롱폼 txt: 인사로 시작·고른 길이·질문 늦음·전환 없음 → K3·리듬·질문·전환
    lines = ['안녕하세요 오늘은 해태 이야기에 대해 알아보겠습니다.'] + ['이 문장은 거의 같은 길이로 계속 이어집니다.'] * 60
    f = t / 'script.txt'
    f.write_text('# 주석\n## 0\n@hook\n' + '\n'.join(lines) + '\n', encoding='utf-8')
    r = sa.audit(f, 'corp_ko')
    assert {'K3 첫 문장', '질문', '전환'} <= set(codes(r)) and 'G11 리듬' in allc(r), r   # 롱폼 리듬은 G11 창 기준(10-21)
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
    # devo 칼럼(10-20) 쇼츠 모드: V1 설명형 첫 문장 FAIL, V2 감정 평가, V3 엔딩 평가, V4 긴 문장
    f.write_text('오늘은 크랜베리 밭을 물에 잠그는 이유에 대해 알아보겠습니다.\n'
                 '농부가 밭에 물을 가득 채우는 장면은 정말 너무나도 감동적이었습니다 모두가 놀라웠습니다.\n'
                 '바퀴가 덩굴을 휘저으면 수천 개의 빨간 열매가 한꺼번에 수면 위로 떠오르게 됩니다.\n'
                 '그런데 그 열매 속에는 아주 작은 공기 방이 네 개나 숨어 있었다는 사실이 밝혀졌습니다.\n'
                 '이처럼 크랜베리 수확은 물과 공기를 이용한 정말 대단한 방법입니다.\n', encoding='utf-8')
    r = sa.audit(f, 'longshort')
    assert [x['code'] for x in r['fails']] == ['V1 첫 문장'], r['fails']
    assert {'V2 감정 평가', 'V3 엔딩 평가', 'V4 문장 길이'} <= set(codes(r)), codes(r)
    assert sa.main([str(f), '--lane', 'longshort']) == 4
    f.write_text('농부가 밭에 물을 붓는다.\n빨간 열매가 떠오른다.\n그런데 하나도 가라앉지 않는다.\n속을 잘라 보니 공기 방이 있다.\n하지만 농부는 웃지 않았다.\n', encoding='utf-8')
    r = sa.audit(f, 'longshort')
    assert r['fails'] == [] and sa.main([str(f), '--shorts']) == 0
    # V14 끝 어미 단조(모두 ~습니다) — 롱폼에도
    f.write_text('\n'.join(f'{i}번째 사실을 알려 드립니다.' if i % 2 else f'그 회사는 {i}년에 무너졌습니다.' for i in range(1, 12)) + '\n', encoding='utf-8')
    r = sa.audit(f, 'corp_ko')
    assert 'V14 끝 어미' in allc(r) and r['ending_top']['ending'] == '니다', r.get('ending_top')
    r2 = sa.audit(f, 'corp_ko', ignore=['V14'])
    assert 'V14 끝 어미' not in codes(r2) and 'V14 끝 어미' in allc(r2)   # --ignore 는 막지 않고 알림만   # ~습니다·~립니다 한 계열
    # V12 롱폼 질문 간격 120초 초과
    f.write_text('과자는 팔렸는데 회사는 왜 무너졌을까요?\n' + '\n'.join(['그 뒤로 긴 설명이 이어지고 숫자와 연도가 계속 나옵니다.'] * 40) + '\n', encoding='utf-8')
    r = sa.audit(f, 'corp_ko')
    assert 'V12 질문 간격' in allc(r), allc(r)
    # 10-21 자료 점검 G1·G3·G5(기획 json 쇼츠) — 날짜 유예를 지난 설정으로 돌린다
    cfg = json.loads(sa.CONFIG.read_text(encoding='utf-8'))
    for k in ('G1', 'G3', 'G5', 'G11'):
        cfg['enforce_from'][k] = '2026-01-01T00:00:00+09:00'
    (t / 'cfg.json').write_text(json.dumps(cfg, ensure_ascii=False), encoding='utf-8')
    real_cfg, sa.CONFIG = sa.CONFIG, t / 'cfg.json'
    pl = t / 'g1' / 'plan.json'
    pl.parent.mkdir()
    seg = ['농부가 밭에 물을 붓는다.', '빨간 열매가 떠오른다.', '열매는 계속 늘어난다.', '그런데 하나도 가라앉지 않는다.', '여러분이라면 먹어 볼까요?']
    pl.write_text(json.dumps({'segments': [{'text': x} for x in seg]}, ensure_ascii=False), encoding='utf-8')
    assert [x['code'] for x in sa.audit(pl, 'longshort', 'shorts')['fails']] == ['G1 목표 감정']
    pl.write_text(json.dumps({'segments': [{'text': x} for x in seg], 'target_emotion': '궁금', 'turn_line': '그런데 하나도 가라앉지 않는다'}, ensure_ascii=False), encoding='utf-8')
    r = sa.audit(pl, 'longshort', 'shorts')
    assert r['fails'] == [] and not [c for c in codes(r) if c.startswith('G')], r
    assert sa.tone_miss('감동', '정말 최고였어요!') and sa.tone_miss('유쾌', '그렇게 끝났습니다.') and not sa.tone_miss('궁금', '왜일까요?')
    seg[3] = '그런데 펜타닐이 나온다.'
    pl.write_text(json.dumps({'segments': [{'text': x} for x in seg], 'target_emotion': '궁금', 'turn_line': '그런데 펜타닐이 나온다'}, ensure_ascii=False), encoding='utf-8')
    assert 'G5 차단 낱말' in [x['code'] for x in sa.audit(pl, 'longshort', 'shorts')['fails']]
    sa.CONFIG = real_cfg
    # 검사 불가 → 5 + 장부
    assert sa.main([str(t / 'nope.txt')]) == 5 and sa.LEDGER.exists()
print('OK')
