# -*- coding: utf-8 -*-
"""scripts/comment_hook.py 자기 테스트 — API 0, 임시 폴더만."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import comment_hook as ch  # noqa: E402


def w(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n' if not isinstance(data, str) else data, encoding='utf-8')
    return p


with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    ch.LEDGER = t / 'gate_errors.jsonl'
    EC = {'type': '경험담', 'line': '여러분도 이런 적 있으신가요?', 'at_sec': 41.5}
    # generic: spec + script.txt, 끝에 장치 문장(질문)
    g = t / 'g'
    w(g / 'script.txt', '첫 문장입니다.\n중간 설명입니다.\n여러분도 이런 적 있으신가요?\n')
    w(g / 'spec.json', {'expected_comment': EC})
    r = ch.check(g)
    assert r['ok'] and r['line_in'] == 'body' and '질문' in r['ending']['kinds'], r
    assert ch.main([str(g)]) == 0
    # 메모 문자열·장치 문장 없음·끝맺음 없음 → 4
    w(g / 'spec.json', {'expected_comment': '경험담 — 이런 적'})
    w(g / 'script.txt', '첫 문장입니다.\n중간 설명입니다.\n그렇게 끝났습니다.\n')
    r = ch.check(g)
    assert r['code'] == 4 and any(e.startswith('①') for e in r['errors']) and any(e.startswith('③') for e in r['errors']), r
    w(g / 'spec.json', {'expected_comment': {**EC, 'type': '감탄'}})
    r = ch.check(g)
    assert any('type' in e for e in r['errors']) and any(e.startswith('②') for e in r['errors']), r
    # 반박 가능한 단정으로 끝나도 통과(질문 없이)
    w(g / 'script.txt', '첫 문장입니다.\n이건 무조건 첫 번째 방법이 정답입니다.\n')
    w(g / 'spec.json', {'expected_comment': {'type': '논쟁', 'line': '이건 무조건 첫 번째 방법이 정답입니다', 'at_sec': 30}})
    assert ch.check(g)['ok']
    # 쇼핑: 메타 file 옆 plan.json segments
    s = t / 'shop'
    w(s / 'run' / 'plan.json', {'segments': [{'text': '이 제품 아세요?'}, {'text': '원리는 간단합니다.'}, {'text': '써 보신 분 댓글로 알려 주세요.'}]})
    w(s / 'meta.json', {'file': str(s / 'run' / 'final.mp4'), 'comment_question': '여러분은 어떻게 하세요?',
                        'expected_comment': {'type': '경험담', 'line': '써 보신 분 댓글로 알려 주세요', 'at_sec': 50}})
    r = ch.check(s / 'meta.json', lane='shopping')
    assert r['ok'] and '경험담 요청' in r['ending']['kinds'], r
    # 린박스 plan_local: 해설 카드 + «a|b» 대사 자막
    rb = t / 'rb'
    w(rb / 'plan_local.json', {'expected_comment': {'type': '공감', 'form': '질문', 'line': '당신이라면 참았을까', 'at_sec': 44},
                               'narration': [{'cards': ['그는 결국 문을 열었다.']}],
                               'sequence': [{'captions': ['원문|그만해', '원문|당신이라면 참았을까?']}]})
    r = ch.check(rb)
    assert r['lane'] == 'rinbox' and r['ok'], r
    # 옛 type «질문» — 전환 기한 전엔 경고만, 기한 뒤엔 FAIL. 잘못된 form 은 FAIL
    import datetime as dt
    plan = json.loads((rb / 'plan_local.json').read_text(encoding='utf-8'))
    plan['expected_comment'] = {**plan['expected_comment'], 'type': '질문'}
    plan['expected_comment'].pop('form')
    w(rb / 'plan_local.json', plan)
    ch.LEGACY_UNTIL = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)
    r = ch.check(rb)
    assert r['ok'] and r['warnings'], r
    ch.LEGACY_UNTIL = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)
    r = ch.check(rb)
    assert not r['ok'] and 'form 필드로' in r['errors'][0], r
    plan['expected_comment'] = {**plan['expected_comment'], 'type': '공감', 'form': '감탄'}
    w(rb / 'plan_local.json', plan)
    assert any('form' in e for e in ch.check(rb)['errors'])
    # 린박스: 원음 대사로 끝나도 ③ 은 마지막 해설 블록 카드로 본다(sequence 순서, 카드 두 줄은 이어서)
    w(rb / 'plan_local.json', {'expected_comment': {'type': '공감', 'line': '皆さんはどう思いますか', 'at_sec': 40},
                               'narration': [{'id': 'n0', 'cards': ['最初の説明です。']}, {'id': 'n1', 'cards': ['この同心のやり方', '皆さんはどう思いますか？']}],
                               'sequence': [{'narration': 'n0'}, {'captions': ['よし']}, {'narration': 'n1'},
                                            {'captions': ['無謀な振る舞いは', '慎むんだ', 'いいな']}]})
    r = ch.check(rb)
    assert r['ok'] and r['ending']['from'] == 'last_narration', r
    # 정치 쇼츠: 본문 없음 → 고정 댓글에서 ②·③, 안내 줄·URL 은 끝 3문장에서 뺀다
    up = w(t / 'p' / 's2_x.upload.json', {'pinned_comment': '지금 함께 나서야 할까요, 국감 뒤가 맞을까요? 댓글로 의견 남겨 주세요.\n전체 맥락은 롱폼 → https://youtu.be/abc',
                                          'expected_comment': {'type': '논쟁/훈수', 'line': '지금 함께 나서야 할까요', 'at_sec': 0}})
    r = ch.check(up)
    assert r['lane'] == 'politics_shorts' and r['ok'] and r['line_in'] == 'pinned' and r['ending']['from'] == 'pinned', r
    w(up, {'pinned_comment': '전체 맥락은 롱폼 → https://youtu.be/abc', 'expected_comment': {'type': '논쟁', 'line': '왜', 'at_sec': 0}})
    assert ch.main([str(up)]) == 5   # 안내 줄뿐이면 검사할 문장이 없다 → 불가
    assert ch.check(up)['errors'][0].startswith('검사 불가:')   # errors 에도 이유
    # 팬튜브 spec: voice·caps
    fs_ = w(t / 'f' / 'spec.json', {'voice': [{'text': '해원이 바로 대답합니다.', 't0': 3}], 'caps': [{'text': '여러분은 바로 대답함?', 't0': 20, 't1': 23}],
                                     'top': {'l1': '사장님 한마디에', 'l2': '바로 시정'},
                                     'expected_comment': {'type': '공감', 'line': '여러분은 바로 대답함', 'at_sec': 21}})
    assert ch.check(fs_, lane='fantube')['ok']
    # 팬튜브: 마지막 TTS(t0 26)가 질문이면 caps 가 앞에 있어도 통과 — 시간순
    w(fs_, {'voice': [{'text': '시작합니다.', 't0': 1}, {'text': '여러분이라면 바로 대답할까요?', 't0': 26}],
            'caps': [{'text': f'자막 {i}입니다', 't0': 5 + i, 't1': 6 + i} for i in range(5)],
            'expected_comment': {'type': '공감', 'line': '여러분이라면 바로 대답할까요', 'at_sec': 26}})
    r = ch.check(fs_, lane='fantube')
    assert r['ok'] and r['ending']['tail'][-1].startswith('여러분이라면'), r
    # 롱투숏: plan.json 이 spec 이면 옛 판 plan_v1.json 보다 먼저 읽는다, ' / ' 카드 구분자는 무시
    lx = t / 'lx'
    w(lx / 'plan_v1.json', {'segments': [{'text': '옛 판 문장입니다.'}]})
    w(lx / 'plan.json', {'segments': [{'text': '주스로 마시던 그 크랜베리가 / 수면을 가득 덮습니다.'}, {'text': '드셔 보셨나요?'}],
                         'expected_comment': {'type': '경험담', 'line': '주스로 마시던 그 크랜베리가 수면을', 'at_sec': 6.5, 'pinned': '즐겨 드시나요?'}})
    r = ch.check(lx, lane='longshort')
    assert r['ok'] and r['line_in'] == 'body', r
    # hook.text 만 질문인 plan — 화면 문구는 본문이 아니다(lx02 v4 거짓 통과, 10-20), 렌더 자막(cap.ass)이 있어도 넘긴 spec 의 segments 가 본문
    hk = t / 'hk'
    hk.mkdir()
    (hk / '_ff').mkdir()
    (hk / '_ff' / 'cap.ass').write_text('Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,다른 판 끝 질문 있나요?\n', encoding='utf-8')
    w(hk / 'plan_v4.json', {'segments': [{'text': '밭에 물을 붓습니다.'}, {'text': '열매가 떠오릅니다.'}, {'text': '빨간 카펫 같아요.'}],
                            'hook': {'visual': '…', 'audio': '…', 'text': '이 빨간 밭은 왜 물에 잠글까요?'},
                            'expected_comment': {'type': '경험담', 'line': '열매가 떠오릅니다', 'at_sec': 3}})
    r = ch.check(hk / 'plan_v4.json', lane='longshort')
    assert not r['ok'] and any(e.startswith('③') for e in r['errors']), r
    # 검사 불가: 없는 경로 → 5 + 장부
    assert ch.main([str(t / 'nope')]) == 5
    assert len(ch.LEDGER.read_text(encoding='utf-8').splitlines()) == 2
# 질문 판정(10-20): «거품이 나요» 평서는 질문 아님, 묻는 어미는 마침표여도 질문, 평서로도 쓰는 어미는 의문사 있을 때만
for s, want in [('거품이 나요.', False), ('거품이 나요', False), ('왜 거품이 나나요', True), ('써 보신 분 있나요?', True),
                ('재판할 수 있을까요.', True), ('그렇죠.', False), ('이게 맞습니까', True),
                ('키친타올 몇 장 뽑던 손이 이제 행주 한 장으로 끝나요', False)]:
    assert ch.is_question(s, 'ko') == want, s
assert ch.is_question('年金を受け取っていませんか。', 'ja') and not ch.is_question('受け取れます。', 'ja')
# 자문자답은 끝맺음 질문이 아니다(10-20 관리자), 맨 마지막 질문은 그대로
S = ['진짜 닦였냐고요?', '행주에 기름이 옮겨 왔어요.', '여러분 집은 어떤가요?']
assert ch.self_answered(S, 0) and not ch.self_answered(S, 2)
# 열린 결말은 동의·반박을 청하는 꼴만(10-20 관리자)
for s, want in [('화장실이 한결 넓어 보일지도 몰라요', False), ('이거 완전 사기템 아님?', True), ('이게 맞죠?', True),
                ('다음엔 품절일 듯', True), ('이런 거 써 보셨을 듯?', True), ('넓어 보일 듯해요.', False), ('그럴 수도 있어요', False)]:
    assert ch.open_ask(s) == want, s
print('OK')
