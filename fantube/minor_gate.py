"""미성년 멤버 보호 관문 — 10/27 관리자 요구(코르티스 레인: 마틴·주훈 2008, 성현·건호 2009 — 성인은 제임스뿐).
가이드 낱말 검사(publish.js MINOR)와 별개로, 화면에 나오는 글 전부(제목 띠·카드·설명·태그)에 대해
  ① 외모·몸 평가 문장 금지  ② 연애·커플로 엮는 문장 금지  ③ 썸네일(첫 컷) 미성년 단독 클로즈업 금지
를 막는다. 미성년 이름이 한 번도 안 나오는 편은 ①②를 전체 문장에 적용하지 않고 미성년이 들어간 문장만 본다
(성인 멤버 묘사까지 막지 않기 위해). 단, ③은 spec.thumb.members 선언으로 판정한다 — 선언이 없으면 검사 불가(exit 5).

  python fantube/minor_gate.py <ep> <upload.json>        # D:/volcano-runs/fantube/<ep>/spec.json 을 읽는다
종료: 0 통과 · 4 걸림(업로드 금지) · 5 검사 불가(thumb.members 없음 등)
spec.json 에 필요한 것: "minors": ["건호","성현"](없으면 레인 기본표 LANES 에서 purpose 로 고른다), "thumb": {"members": ["제임스","건호"], "close_up": true|false}
"""
import json, re, sys
from pathlib import Path

LANES = {
    # 10/27 정정: 성인은 제임스(2005)뿐. 마틴 2008-03-20 · 주훈 2008-01-03 · 성현 2009-01-13 · 건호 2009-02-14 (에스콰이어·YTN) → 만 19 전까지 전원 미성년 취급
    'cortis_fan_ko': {'minors': {
        '마틴': ['마틴', 'martin'], '주훈': ['주훈', '김주훈', 'juhoon', 'joohoon'],
        '성현': ['성현', '엄성현', 'seonghyeon', 'sunghyun', 'sunghyeon'], '건호': ['건호', '안건호', 'keonho', 'geonho'],
    }},
    'idol3sec_ko': {'minors': {}},
}
LOOKS = re.compile(r'(잘생|이쁘|예쁘|예삐|귀엽|귀얍|섹시|몸매|복근|어깨|허벅|허리|종아리|피부|비주얼|얼굴\s*천재|얼굴이|키가|키 크|키 작|살 빠|살쪘|근육|조각|미모|외모|존잘|존예|여리여리|날씬|통통|쌩얼|민낯|입술|쇄골|눈웃음|교복)')
ROMANCE = re.compile(r'(연애|커플|여친|남친|여자친구|남자친구|사귀|썸|데이트|키스|뽀뽀|고백|설레|심쿵|남편|와이프|신혼|부부|질투|사랑꾼|스킨십|안아|포옹|벽치기|애교)')
# 10/29 번역 카드(영어 원문)용 — 같은 기준을 영어에도 적용한다
LOOKS_EN = re.compile(r'\b(handsome|pretty|cute|cutie|sexy|hot|gorgeous|beautiful|abs|body|visual|skin|lips|shoulders?|thighs?|muscles?|tall|skinny|chubby|face card|jawline|boyfriend material)\b', re.I)
ROMANCE_EN = re.compile(r'\b(flirt\w*|boyfriend|girlfriend|dating|date|kiss\w*|couple|husband|wife|crush|soulmates?|cuddl\w*|hug\w*|love ?letter|marry|married)\b', re.I)


def main():
    ep, meta_path = sys.argv[1], sys.argv[2]
    spec_path = Path('D:/volcano-runs/fantube') / ep / 'spec.json'
    S = json.loads(spec_path.read_text(encoding='utf-8'))
    M = json.loads(Path(meta_path).read_text(encoding='utf-8'))
    purpose = M.get('purpose') or 'idol3sec_ko'
    lane = LANES.get(purpose, {'minors': {}})
    minors = lane['minors']
    if S.get('minors'):
        minors = {m: minors.get(m, [m]) for m in S['minors']}
    if not minors:
        print(f'[minor_gate] {ep}: 미성년 멤버 없는 레인({purpose}) — 통과')
        return 0

    top = S.get('top') or {}
    lines = [('제목', top.get('l1')), ('제목', top.get('l2')), ('태그줄', top.get('tag')), ('메타 제목', M.get('title'))]
    lines += [('카드', c.get('text')) for c in (S.get('comments') or [])]
    lines += [('카드 원문', c.get('orig')) for c in (S.get('comments') or [])]   # 10/29 번역 카드: 영어 원문도 똑같이 본다
    lines += [('자막', c.get('text')) for c in (S.get('caps') or [])]
    lines += [('해설', v.get('text')) for v in (S.get('voice') or [])]
    lines += [('설명', ln) for ln in (M.get('description') or '').split('\n')]
    lines += [('태그', ' '.join(M.get('tags') or []))]
    lines = [(k, v) for k, v in lines if v]

    def names_in(text):
        t = text.lower()
        return [m for m, al in minors.items() if any(a.lower() in t for a in al)]

    hits = []
    for kind, text in lines:
        who = names_in(text)
        if kind in ('카드', '제목', '메타 제목') and not who:
            # 카드·제목은 이름이 없어도 그 편의 주인공이 미성년이면 적용한다
            if set(S.get('focus') or []) & set(minors):
                who = list(set(S.get('focus') or []) & set(minors))
        if not who:
            continue
        if LOOKS.search(text):
            hits.append(f'① 외모·몸 평가({",".join(who)}) [{kind}] «{text[:40]}» ← {LOOKS.search(text).group(0)}')
        if ROMANCE.search(text):
            hits.append(f'② 연애 엮기({",".join(who)}) [{kind}] «{text[:40]}» ← {ROMANCE.search(text).group(0)}')
        if LOOKS_EN.search(text):
            hits.append(f'① 외모·몸 평가(영문, {",".join(who)}) [{kind}] «{text[:40]}» ← {LOOKS_EN.search(text).group(0)}')
        if ROMANCE_EN.search(text):
            hits.append(f'② 연애 엮기(영문, {",".join(who)}) [{kind}] «{text[:40]}» ← {ROMANCE_EN.search(text).group(0)}')

    th = S.get('thumb')
    if not th or not isinstance(th.get('members'), list):
        print(f'[minor_gate] {ep}: spec.thumb.members 선언 없음 — 썸네일(첫 컷) 판정 불가(종료 5)')
        return 5
    tm = [m for m in th['members']]
    if len(tm) == 1 and tm[0] in minors and th.get('close_up', True):
        hits.append(f'③ 썸네일 미성년 단독 클로즈업 «{tm[0]}» — 첫 컷을 둘 이상 나오는 컷이나 넓은 샷으로')

    if hits:
        print(f'[minor_gate] ★FAIL {ep} — {len(hits)}건')
        for h in hits:
            print('   ' + h)
        return 4
    print(f'[minor_gate] {ep}: 통과 — 미성년 {list(minors)} 문장 {len(lines)}줄·썸네일 {tm} 확인')
    return 0


if __name__ == '__main__':
    sys.exit(main())
