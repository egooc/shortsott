# -*- coding: utf-8 -*-
"""scripts/story_gate.py 자기 테스트 — API 0, 임시 폴더만.
통과 예시 = 소유주 «롱투숏 정석» 레퍼런스(youtube.com/shorts/4B21vk16yeo, 문어 편)의 실제 컷당 자막 13문장
(관리자가 컨택트 시트에서 읽음, 10-21) — 상황→위기→시도 실패→개입·전환→결말+감정 꼬리, 생각 풍선. FAIL 예시 = 어랍숏 화면 해설 3문장."""
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import story_gate as sg  # noqa: E402

OCTO = [
    '문어 로봇으로 탐사 중이었는데',
    '진짜 문어 한 마리가 상어에게 쫓기고 있었음',
    '주변에 숨을 만한 장소가 마땅치 않았고',
    '상어는 문어를 잡기 위해 샅샅이 수색 중이었음',
    '이때 근처에 보이는 파이프..!',
    '살기 위해 전속력으로 달리는 문어',
    '들어오는 건 성공했는데..',
    '안이 막혀 있어서 깊게 들어갈 수 없었음',
    '이 상황을 보던 문어 로봇이 좋은 생각 하나 떠올림',
    '의도를 알아듣나 싶어서 코코넛 껍질을 씌워 보내봤는데..',
    '진짜 바로 의도 파악해버림 ㄷㄷ',
    '바로 뚜껑으로 사용해서 그대로 은신해버리는 문어',
    '나와서 고맙다고 로봇 안아줌 ㅠㅠ',
]
OCTO_STORY = {
    'structure_id': '구출-보은(개입자 시점)',
    'beats': {'situation': OCTO[0], 'stake': OCTO[1], 'attempt': OCTO[4], 'turn': OCTO[8], 'ending': OCTO[11], 'emotion_tail': OCTO[12]},
    'map': ['situation', 'stake', 'stake', 'stake', 'attempt', 'attempt', 'attempt', 'attempt', 'turn', 'turn', 'turn', 'ending', 'emotion_tail'],
    'devices': {'1': '빌런(상어)', '3': '생각 풍선((큰일났다...))', '7': '시도·실패(파이프 막힘)', '9': '반전+비장의 무기(코코넛 껍질)', '12': '감정 꼬리(안아줌)'},
    'fiction': {'allowed': True, 'devices': ['생각 풍선 «(로봇임)»·«(어디갔어..)»·«(큰일났다...)»·«(ㅠㅠㅠㅠ)»·«뚱땅뚱땅»·«난 아무 말 안했다.. 개입한거 아니다..»', '의인화']},
}
RUST = ['녹 범벅 프레임인데 빛만 쏘자 사라졌다', '레이저가 표면을 지나가고 있습니다', '금속 표면이 은색입니다']
RUST_DESC = ['녹이 잔뜩 낀 자전거 프레임입니다', '레이저가 표면을 지나가고 있습니다', '금속 표면이 은색입니다']

# 판정 단위
r = sg.judge({'story': OCTO_STORY}, OCTO)
assert r['verdict'] == 'PASS', r
assert r['stats']['descriptive'] == 0 and (r['stats']['turn_change'] or r['stats']['turn_new_verbs'])
assert sg.new_verbs('좋은 생각 하나 떠올림', '상어에게 쫓기고 있었음')    # (a) 새 동사만으로도 전환
assert not sg.new_verbs('파이프 안에 있다', '파이프로 달리는 문어')
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
r = sg.judge({'story': dict(OCTO_STORY, beats=dict(OCTO_STORY['beats'], turn='문어가 파이프 안에 있다'), map=[b if b != 'turn' else 'attempt' for b in OCTO_STORY['map']])}, OCTO)
assert any(f.startswith('④') for f in r['fails']), r
# ⑤ 정치 레인 허구 금지 · 다른 레인 숫자 문장 출처
r = sg.judge({'story': OCTO_STORY}, OCTO, lane='politics_short')
assert any(f.startswith('⑤') for f in r['fails']), r
FACT_DEV = {'0': '훅 질문', '4': '궁금증 연쇄', '7': '시도·실패', '9': '반전', '12': '감정 꼬리'}
r = sg.judge({'story': dict(OCTO_STORY, fiction={'allowed': False, 'devices': []}, devices=FACT_DEV)}, OCTO, lane='politics_short')
assert r['verdict'] == 'PASS', r
# ⑥ 장치 — 정치 허구형 FAIL · 5개 미만 유예 전 WARN / 뒤 FAIL · 목록 밖 이름 WARN
r = sg.judge({'story': dict(OCTO_STORY, fiction={'allowed': False, 'devices': []})}, OCTO, lane='politics_short')
assert any(f.startswith('⑥ 정치') for f in r['fails']), r
few = dict(OCTO_STORY, devices={'0': '훅 질문', '12': '감정 꼬리', '5': '짤 삽입'})
r = sg.judge({'story': few}, OCTO, enforce=False)
assert r['verdict'] == 'WARN' and any(w.startswith('⑥ 장치 2개') for w in r['warns']) and any('목록 밖' in w for w in r['warns']), r
assert any(f.startswith('⑥ 장치 2개') for f in sg.judge({'story': few}, OCTO, enforce=True)['fails'])
assert sg.device_names('반전+비장의 무기(일반 방법 vs 다른 방법, W3④)') == ['반전·비장의 무기']
r = sg.judge({'story': OCTO_STORY}, OCTO[:-1] + ['문어는 3일 뒤에도 그 로봇을 찾아왔음'])
assert any(w.startswith('⑤') for w in r['warns']), r

# 롱투숏 lx03 꼴 — 한국어 beat 목록 «상황: …» · map 한국어 이름 · 훅
KO = {'structure_id': 'S6-rescue', 'beats': ['상황: ' + OCTO[0], '위기·욕구: ' + OCTO[1], '시도·실패: ' + OCTO[3], '전환: ' + OCTO[8], '결말: ' + OCTO[11], '감정 꼬리: ' + OCTO[12]],
      'map': {str(i): {'situation': '상황', 'stake': '위기·욕구', 'attempt': '시도·실패', 'turn': '전환', 'ending': '결말', 'emotion_tail': '감정 꼬리'}[b] for i, b in enumerate(OCTO_STORY['map'])},
      'fiction': {'allowed': True, 'devices': ['의인화']}, 'devices': OCTO_STORY['devices']}
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
