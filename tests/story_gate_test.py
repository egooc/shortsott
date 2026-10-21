# -*- coding: utf-8 -*-
"""scripts/story_gate.py 자기 테스트 — API 0, 임시 폴더만.
통과 예시 = 소유주 «롱투숏 정석» 레퍼런스(youtube.com/shorts/4B21vk16yeo, 문어 편)의 컷당 자막 1문장 13컷 구조
(상황→위기→시도 실패→개입→전환→결말+감정 꼬리, 동물 시점 생각 풍선)를 본뜬 문장. FAIL 예시 = 어랍숏 화면 해설 3문장."""
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import story_gate as sg  # noqa: E402

OCTO = [
    '그물에 걸린 문어가 갑판 위로 끌려 올라왔다',
    '바다로 돌아가고 싶었지만 다리가 그물코에 감겼다',
    '«여기서 말라 죽을 순 없어»',
    '문어는 먹물을 뿜고 미끄러져 보려 했다',
    '그런데 그물은 더 단단히 조여 왔다',
    '힘이 빠지자 다리 하나가 축 늘어졌다',
    '그때 갑판 끝에서 어린 선원이 다가왔다',
    '선원은 칼 대신 맨손으로 그물코를 하나씩 풀었다',
    '문어는 처음으로 도망치지 않고 그 손을 감았다',
    '마지막 매듭이 풀리는 순간 문어는 바다로 미끄러져 들어갔다',
    '선원은 빈손을 한참 내려다봤다',
    '다음 날 같은 자리에 조개 하나가 놓여 있었다',
    '«고마웠어, 작은 손»',
]
OCTO_STORY = {
    'structure_id': '구출-보은',
    'beats': {'situation': OCTO[0], 'stake': OCTO[1], 'attempt': OCTO[3], 'turn': OCTO[8], 'ending': OCTO[9], 'emotion_tail': OCTO[12]},
    'map': ['situation', 'stake', 'stake', 'attempt', 'attempt', 'attempt', 'turn', 'turn', 'turn', 'ending', 'ending', 'emotion_tail', 'emotion_tail'],
    'fiction': {'allowed': True, 'devices': ['생각 풍선', '의인화']},
}
RUST = ['녹 범벅 프레임인데 빛만 쏘자 사라졌다', '레이저가 표면을 지나가고 있습니다', '금속 표면이 은색입니다']
RUST_DESC = ['녹이 잔뜩 낀 자전거 프레임입니다', '레이저가 표면을 지나가고 있습니다', '금속 표면이 은색입니다']

# 판정 단위
r = sg.judge({'story': OCTO_STORY}, OCTO)
assert r['verdict'] == 'PASS', r
assert r['stats']['descriptive'] == 0 and r['stats']['turn_change']
assert sg.judge({}, RUST)['verdict'] == 'FAIL'                       # ① story 없음
r = sg.judge({'story': dict(OCTO_STORY, map=['situation', 'turn', 'ending'])}, RUST_DESC)
assert any(f.startswith('③') for f in r['fails']), r                 # ③ 화면 묘사형 100%
assert sg.descriptive('강아지가 기다리고 있습니다') and not sg.descriptive('8시간째 같은 자리')
assert not sg.descriptive('그래서 강아지는 문 앞에 있습니다') and not sg.descriptive('주인이 오자 강아지가 일어났다')
# ① 빈 beat
r = sg.judge({'story': dict(OCTO_STORY, beats=dict(OCTO_STORY['beats'], attempt=''))}, OCTO)
assert any('빈 beat attempt' in f for f in r['fails']), r
# ② 매핑 — 1개 빠지면 WARN, 30%↑ FAIL
r = sg.judge({'story': dict(OCTO_STORY, map=OCTO_STORY['map'][:12])}, OCTO)
assert r['verdict'] == 'WARN' and r['warns'][0].startswith('②'), r
r = sg.judge({'story': dict(OCTO_STORY, map=OCTO_STORY['map'][:8])}, OCTO)
assert any(f.startswith('②') for f in r['fails']), r
# ④ turn 이 앞과 같은 상태만 말함
r = sg.judge({'story': dict(OCTO_STORY, beats=dict(OCTO_STORY['beats'], turn='선원이 서 있다'), map=[b if b != 'turn' else 'attempt' for b in OCTO_STORY['map']])}, OCTO)
assert any(f.startswith('④') for f in r['fails']), r
# ⑤ 정치 레인 허구 금지 · 다른 레인 숫자 문장 출처
r = sg.judge({'story': OCTO_STORY}, OCTO, lane='politics_short')
assert any(f.startswith('⑤') for f in r['fails']), r
r = sg.judge({'story': dict(OCTO_STORY, fiction={'allowed': False, 'devices': []})}, OCTO, lane='politics_short')
assert r['verdict'] == 'PASS', r
r = sg.judge({'story': OCTO_STORY}, OCTO[:-1] + ['문어는 3년 뒤에도 그 배를 따라왔다'])
assert any(w.startswith('⑤') for w in r['warns']), r

# 롱투숏 lx03 꼴 — 한국어 beat 목록 «상황: …» · map 한국어 이름 · 훅
KO = {'structure_id': 'S6-rescue', 'beats': ['상황: ' + OCTO[0], '위기·욕구: ' + OCTO[1], '시도·실패: ' + OCTO[3], '전환: ' + OCTO[8], '결말: ' + OCTO[9], '감정 꼬리: ' + OCTO[12]],
      'map': {str(i): {'situation': '상황', 'stake': '위기·욕구', 'attempt': '시도·실패', 'turn': '전환', 'ending': '결말', 'emotion_tail': '감정 꼬리'}[b] for i, b in enumerate(OCTO_STORY['map'])},
      'fiction': {'allowed': True, 'devices': ['의인화']}}
KO['map']['0'] = '훅'
assert sg.judge({'story': KO}, OCTO)['verdict'] == 'PASS', sg.judge({'story': KO}, OCTO)
assert sg.split_sentences([{'text': '이 새 부리를 / 왜 사포로 갈아 줄까요'}]) == ['이 새 부리를 왜 사포로 갈아 줄까요']

with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    sg.LEDGER = t / 'err.jsonl'
    p = t / 'plan.json'
    p.write_text(json.dumps({'captions': [{'text': s} for s in OCTO], 'story': OCTO_STORY}, ensure_ascii=False), encoding='utf-8')
    assert sg.main([str(p), '--enforce-now']) == 0
    p.write_text(json.dumps({'narration': RUST}, ensure_ascii=False), encoding='utf-8')
    assert sg.main([str(p), '--enforce-now']) == 4
    assert sg.check(str(p), now=sg.ENFORCE_FROM - dt.timedelta(hours=1))['exit'] == 0
    assert '[유예 ~10-23]' in sg.line(sg.check(str(p), now=sg.ENFORCE_FROM - dt.timedelta(hours=1)))
    # --field 지정 · plan.json:<id> (JA 쇼츠 꼴)
    p.write_text(json.dumps({'script': OCTO, 'story': OCTO_STORY}, ensure_ascii=False), encoding='utf-8')
    assert sg.main([str(p), '--field', 'script', '--enforce-now']) == 0
    p.write_text(json.dumps({'shorts': [{'id': 's1', 'lines': OCTO, 'story': OCTO_STORY}]}, ensure_ascii=False), encoding='utf-8')
    assert sg.main([f'{p}:s1', '--enforce-now']) == 0
    # 문장 없음 → 5 + 장부
    p.write_text(json.dumps({'story': OCTO_STORY}, ensure_ascii=False), encoding='utf-8')
    assert sg.main([str(p), '--enforce-now']) == 5 and sg.LEDGER.exists()
print('OK')
