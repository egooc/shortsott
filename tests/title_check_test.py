# -*- coding: utf-8 -*-
"""scripts/title_check.py 자기 테스트 — API 0."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import title_check as tc  # noqa: E402

codes = lambda *a, **k: [c for c, _ in tc.check_title(*a, **k)]

# ls11 실측 제목 — 위험 행위×신체 대상 + 결과 유도
w = tc.check_title('펄펄 끓는 물에 손 넣었더니')
assert any(c == '위험×신체' and '결과 유도' in m and '손' in m for c, m in w), w
assert '가이드' not in [c for c, _ in w]          # 같은 내용을 두 번 세지 않는다
assert tc.risky_combo('얼음물에 얼굴 담갔더니')[0].startswith('위험 행위×신체 대상(얼음물 × 얼굴)')
assert tc.risky_combo('손으로 만든 칼국수') is None   # 음식 낱말 속 «칼» 은 위험 낱말로 안 본다
assert tc.risky_combo('불고기 손질법') is None
assert tc.risky_combo('불에 손', 'ko') is not None
# 쇼츠 체크
assert codes('남자들만 모르는 지퍼 올리는 법') == []
for s in ('기름때 키친타올로 닦지 마세요', '변기솔 젖은 채 꽂아 두지 마세요', '논슬립 옷걸이 없이 얇은 옷 걸지 마세요'):
    assert '패턴' not in codes(s), s   # 쇼핑 «~지 마세요» = 금지·경고
assert {'결과노출', '설명형'} <= set(codes('결국 회사는 망했다: 해태의 몰락 · 원인 · 교훈'))
assert {'해시태그', '최상급', '앞10자'} <= set(codes('오늘은 역대급 소름 레전드 #쇼츠 #꿀팁'))
assert '길이' in codes('이 제목은 쇼츠에 쓰기에는 너무나도 길어서 한눈에 들어오지 않습니다 그렇죠')
assert '앞10자' in codes('평범한 하루였는데 크랜베리 밭이 잠겼다', keywords=['크랜베리'])
assert '앞10자' not in codes('크랜베리 밭을 일부러 물에 잠그는 이유', keywords=['크랜베리'])
# 롱폼 전문용어
J = {'탄핵소추안': ['국회가 먼저 묻는 절차'], '탄핵소추': ['국회가 먼저 묻는 절차'], '전작권': ['전시작전권']}
w = tc.check_title('조희대 탄핵소추안 발의', 'long', jargon=J)
assert [c for c, _ in w] == ['전문용어'], w
assert codes('전작권(전시작전권) 넘겨받으면 뭐가 달라지나', 'long', jargon=J) == ['가이드']   # 풀이는 됐고, 전작권은 10-20.1 정치·군사 범주
assert '전문용어' not in codes('전작권 넘겨받으면', 'long', jargon=J, desc='전시작전권을 돌려받는다는 뜻\n둘째 줄')
# CLI: json 입력·title_pattern 없음·검사 불가 5·--fail-on-warn 4
with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    tc.LOG, tc.LEDGER = t / 'log.jsonl', t / 'err.jsonl'
    s = t / 'spec.json'
    s.write_text(json.dumps({'title': '펄펄 끓는 물에 손 넣었더니'}, ensure_ascii=False), encoding='utf-8')
    assert tc.main([str(s), '--lane', 'longshort']) == 0
    assert tc.main([str(s), '--lane', 'longshort', '--fail-on-warn']) == 4
    rec = json.loads(tc.LOG.read_text(encoding='utf-8').splitlines()[0])
    assert 'title_pattern' in rec['codes'] and rec['combo'].startswith('위험 행위×신체 대상'), rec
    pk = t / 'packages.json'   # packages.json 은 desc_head(설명 첫 두 줄)로 풀이를 본다
    pk.write_text(json.dumps({'packages': [{'title': '탄핵소추안 발의되면 뭐가 달라지나', 'desc_head': ['국회가 먼저 묻는 절차를 시작했다는 뜻입니다.', '둘째 줄']}]},
                             ensure_ascii=False), encoding='utf-8')
    jf = t / 'j.json'
    jf.write_text(json.dumps(J, ensure_ascii=False), encoding='utf-8')
    assert tc.main([str(pk), '--kind', 'long', '--jargon', str(jf), '--fail-on-warn']) == 0
    assert tc.main([str(t / 'nope.json')]) == 5
    assert tc.LEDGER.exists()
# 제목 머리(10-20 관리자): 제도·절차 명사 머리 + 인물 없음 → △, 이름이 명사의 대상이면 인물로 안 친다
P = ['조희대', '신장식', '모스 탄']
assert tc.institution_head('조희대 탄핵소추안 — 국회가 묻는 절차', 'ko', P)
assert tc.institution_head('탄핵소추안 발의 절차 정리', 'ko', P)
assert not tc.institution_head('신장식 «탄핵소추안 끝내야»', 'ko', P)
assert not tc.institution_head('장동혁 의원 탄핵안 «의회 쿠데타»', 'ko', [])
assert not tc.institution_head('한동훈 "그 친구는 좀 깐족댑니다"', 'ko', P)
assert tc.person_words(['조희대', '조희대 탄핵', '조국혁신당', '이재명 국무회의', '모스 탄']) == ['조희대', '모스 탄']
assert '제목 머리' in codes('탄핵소추안 발의 절차 정리', 'long', persons=P) and '제목 머리' not in codes('탄핵소추안 발의 절차 정리', 'long')
assert tc.institution_head('補正予算 審議入り', 'ja', []) and not tc.institution_head('高市首相 補正予算「年内に」', 'ja', [])
# 군사 인물 머리(10-20 관리자): role military 또는 «○○ 사령관» 꼴
R = {'브런슨': 'military', '한동훈': 'politician'}
assert tc.military_head('브런슨 "그것도 다 우리 땅이 아닙니까"… 조희대 탄핵', 'ko', R) == '브런슨'
assert tc.military_head('제이비어 사령관 «철책선»', 'ko', {})
assert not tc.military_head('한동훈 "그 친구는 좀 깐족댑니다"', 'ko', R)
assert '군사 인물 머리' in codes('브런슨 "우리 땅"… 한동훈', 'long', persons=[], roles=R)
print('OK')
