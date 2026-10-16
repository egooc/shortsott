"""렌더 전에 원고를 검사한다: 쟁점마다 양쪽 인용 시간이 맞는지, 해설에 평가어가 섞였는지, 출처 표기가 빠졌는지.

    python episode_check.py <episode.json>

쟁점 브리핑의 원칙(2026-10-13 소유주): 양쪽 입장과 발언을 정리하고 판단은 시청자에게 맡긴다.
- 인용 조각은 "side": "A"|"B" 를 단다. 같은 issue_tag 안에서 A·B 인용 합계 시간 차이가 큰 쪽의 20%를 넘으면 실패.
- 해설(text·화면 제목)에 평가어가 따옴표 밖에 있으면 실패. 어느 쪽 말인지 밝혀 옮길 때는 ‘’ 나 "" 로 감싼다.
- 인용 조각마다 "영상: 채널 날짜" 출처가 있어야 한다(권리관리정보, 지우지 않는다).
- 마지막 해설은 "판단은 시청자 여러분께" 로 맺는다.
진영 편(chrome.stance == "partisan", 2026-10-14 소유주 결정)은 균형·평가어·맺음말 검사를 하지 않고,
욕설·비하어만 막는다(광고 제한·신고). 시사 스피커 인용은 side "P". 출처·발언자 검사는 그대로.
실패가 하나라도 있으면 종료 코드 1.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

CHARS_PER_SEC = 5.2      # Supertonic F2 · 1.05배 실측(쉼 포함, 공백 뺀 글자)
BALANCE = .20
QUOTE_SEC = (8, 60)
JUDGE = ['궤변', '망언', '망발', '막말', '패륜', '정당한', '부당한', '무리한', '억지', '꼼수', '폭거', '내로남불', '적반하장',
         '황당', '어처구니', '한심', '졸속', '독재', '선동', '거짓말', '날조', '치졸', '몰염치', '정치 보복', '물타기', '발목잡기',
         '참사', '광기', '횡포', '오만', '뻔뻔']
QUOTED = re.compile(r"[‘'\"“][^‘’'\"“”]*[’'\"”]")
CLOSING = '판단은 시청자 여러분께'
SWEAR = ['씨발', '시발', '좆', '병신', '개새', '미친놈', '빨갱이', '틀딱', '수꼴', '좌좀', '토착왜구', '홍어']


def unquoted(text):
    return QUOTED.sub(' ', text)


def visual_texts(v):
    # 양쪽 입장을 나란히 적는 versus 는 누구 말인지 밝힌 것이라 검사하지 않는다
    if not v or v.get('type') == 'versus':
        return []
    out = [v.get('title', ''), v.get('sub', ''), v.get('caption', '')]
    for x in v.get('items', []) + v.get('steps', []):
        out += x if isinstance(x, list) else [x]
    return [t for t in out if t]


def check(ep):
    fails, notes = [], []
    partisan = ep.get('chrome', {}).get('stance') == 'partisan'
    seconds = defaultdict(lambda: {'A': 0.0, 'B': 0.0, 'nA': 0, 'nB': 0})
    nar_chars = quote_sec = 0
    segs = ep['segments']
    for i, s in enumerate(segs):
        where = f'#{i} {s["type"]} {s.get("issue_tag", "")}'
        if s['type'] == 'quote':
            d = s['out'] - s['in']
            quote_sec += d
            if not str(s.get('source', '')).startswith('영상:'):
                fails.append(f'{where}: 출처 표기(영상: 채널 날짜) 없음')
            if s.get('side') == 'P' and partisan:
                pass
            elif s.get('side') not in ('A', 'B'):
                fails.append(f'{where}: side(A/B) 없음')
            else:
                b = seconds[s.get('issue_tag', '')]
                b[s['side']] += d; b['n' + s['side']] += 1
            if not (QUOTE_SEC[0] <= d <= QUOTE_SEC[1]):
                notes.append(f'{where}: 인용 길이 {d:.1f}초 ({QUOTE_SEC[0]}~{QUOTE_SEC[1]} 밖)')
            if not s.get('speaker'):
                fails.append(f'{where}: 발언자 이름 없음')
        else:
            text = s.get('text', '')
            nar_chars += len(re.sub(r'\s', '', text))
            for t in [text] + visual_texts(s.get('visual')):
                for w in (SWEAR if partisan else JUDGE):
                    if w in (t if partisan else unquoted(t)):
                        fails.append(f'{where}: 평가어 «{w}» 가 따옴표 밖에 있음 — {t[:60]}')
    for tag, b in seconds.items():
        hi, lo = max(b['A'], b['B']), min(b['A'], b['B'])
        line = f'{tag}: A {b["A"]:.0f}초/{b["nA"]}개 · B {b["B"]:.0f}초/{b["nB"]}개'
        if hi and (hi - lo) / hi > BALANCE and not partisan:
            fails.append(f'균형 실패 {line} (차이 {(hi - lo) / hi:.0%})')
        else:
            notes.append(f'균형 {line}')
    last = next((s for s in reversed(segs) if s['type'] == 'nar'), None)
    if not partisan and (not last or CLOSING not in last.get('text', '')):
        fails.append(f'마지막 해설이 «{CLOSING}…» 로 끝나지 않음')
    nar_sec = nar_chars / CHARS_PER_SEC
    total = nar_sec + quote_sec
    notes.append(f'예상 길이 {total / 60:.1f}분 = 해설 {nar_sec / 60:.1f}분({nar_chars}자) + 인용 {quote_sec / 60:.1f}분 '
                 f'(인용 비율 {quote_sec / max(1, total):.0%})')
    return fails, notes


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    fails, notes = check(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
    for n in notes:
        print('  ', n)
    for f in fails:
        print('FAIL', f)
    print('OK' if not fails else f'{len(fails)}건 실패')
    sys.exit(1 if fails else 0)
