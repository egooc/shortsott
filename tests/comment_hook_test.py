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
    w(rb / 'plan_local.json', {'expected_comment': {'type': '질문', 'line': '당신이라면 참았을까', 'at_sec': 44},
                               'narration': [{'cards': ['그는 결국 문을 열었다.']}],
                               'sequence': [{'captions': ['원문|그만해', '원문|당신이라면 참았을까?']}]})
    r = ch.check(rb)
    assert r['lane'] == 'rinbox' and r['ok'], r
    # 정치 쇼츠: 본문 없음 → 고정 댓글에서 ②·③, 안내 줄·URL 은 끝 3문장에서 뺀다
    up = w(t / 'p' / 's2_x.upload.json', {'pinned_comment': '지금 함께 나서야 할까요, 국감 뒤가 맞을까요? 댓글로 의견 남겨 주세요.\n전체 맥락은 롱폼 → https://youtu.be/abc',
                                          'expected_comment': {'type': '논쟁/훈수', 'line': '지금 함께 나서야 할까요', 'at_sec': 0}})
    r = ch.check(up)
    assert r['lane'] == 'politics_shorts' and r['ok'] and r['line_in'] == 'pinned' and r['ending']['from'] == 'pinned', r
    w(up, {'pinned_comment': '전체 맥락은 롱폼 → https://youtu.be/abc', 'expected_comment': {'type': '논쟁', 'line': '왜', 'at_sec': 0}})
    assert ch.main([str(up)]) == 5   # 안내 줄뿐이면 검사할 문장이 없다 → 불가
    # 팬튜브 spec: voice·caps
    fs_ = w(t / 'f' / 'spec.json', {'voice': [{'text': '해원이 바로 대답합니다.', 't0': 3}], 'caps': [{'text': '여러분은 바로 대답함?', 't0': 20, 't1': 23}],
                                     'top': {'l1': '사장님 한마디에', 'l2': '바로 시정'},
                                     'expected_comment': {'type': '공감', 'line': '여러분은 바로 대답함', 'at_sec': 21}})
    assert ch.check(fs_, lane='fantube')['ok']
    # 검사 불가: 없는 경로 → 5 + 장부
    assert ch.main([str(t / 'nope')]) == 5
    assert len(ch.LEDGER.read_text(encoding='utf-8').splitlines()) == 2
print('OK')
