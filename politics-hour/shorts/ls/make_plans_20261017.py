"""훅(10-17 소유주 «제목 들어간 장면을 훅으로 넣고 → 한 줄 나레이션 → 전체»): hook=(원본초 시작, 끝[, cx]) 를 해설 앞에 둔다.
10-17 쇼츠(관리자 10-17: 18:00·21:00, 롱폼 토크쇼 발췌 일부만, 제목·태그는 keywords.json 낱말). 원본 10-15 틀 복사 —
10-15 쇼츠 — 롱투숏 방식 plan 만들기(소유주 10-15). 렌더: python ../briefing_render.py <폴더>/plan.json
s5 는 JTV 좌우 분할 화면 — 렌더러가 JTV 로고를 창 밖에 두려고 cx 를 0.45 아래로 묶어 말하는 김용민(오른쪽)을 못 잡는다. 그래서 오른쪽 칸만 잘라 낸 파생 소스(CQEEYoLOb9o_right.mp4, crop=640:700:980:140, 시각 그대로)를 쓴다. s3 은 KBS 이름 띠(원본 84~100%)가 자막과 겹쳐 zoom 으로 창 밖에 뺐다. s4(옥중 20억)는 원본이 76초짜리 G1 클립이라 40초 관문을 못 채워 뺐다."""
import json, sys
from pathlib import Path
sys.path.insert(0, 'D:/volcano-runs/ls_tools')
from autocap import toks, MAX

EP = Path('D:/midform/politics-hour/episodes/20261017')
HERE = Path(__file__).resolve().parent


CAP = 14            # 한 칸 최대(쇼츠는 한눈에 읽혀야 한다 — 10-15 소유주 «어느 정도 분절시켜야»)
SOFT = 8            # 이만큼 찼으면 어절 경계(조사·연결어미 뒤)에서 끊는다
STRONG = ('다', '요', '까', '죠', '니다', '세요', '시오', '야', '네')            # 문장 끝 — 4자 넘으면 바로 끊는다
JOINT = ('은', '는', '이', '가', '을', '를', '에', '서', '로', '고', '면', '데', '며', '도', '의', '지만', '니까', '게', '한테', '에게', '께', '부터', '까지', '처럼', '보다', '와', '과', '만', '랑')   # 어절 경계
INTERJ = {'예', '네', '자', '아니', '아', '어', '그래요', '좋아요'}
NOBREAK = ('마', '않', '못', '말', '아니', '수', '없', '있')   # «하지 마»·«할 수 없» 처럼 붙어야 뜻이 되는 말 앞에서는 안 끊는다


def cut(T, a, b, fix=None, gap=.45, brk=()):
    """자막 칸 나누기 — 8~14자 칸으로 짧게, 문장 끝은 바로·8자 넘으면 어절 경계에서 끊는다(10-15 소유주 «자막 분절이 왜 저렇게 돼?»
    «어미로만 끊으면 안 되고 어느 정도 분절»). 0.45초 쉼·화자 바뀜에서도 끊는다.
    린박스 손 분절 관행(10-15 C 린박스 답)과 같다: 문장 끝 즉시 · 의미 덩어리 · 조사·연결어미 뒤 · 부정/보조 서술 안 뗌 · 감탄사는 한 칸.
    미드폼 해설용 자동 분절은 server/utils/captionUnits.js(34/38자) — 쇼츠엔 길이가 안 맞아 옮겨 오지 않았다.
    오타 고침은 낱말 단위(fix={'토큰': '보일 낱말'}, '' 은 지움)."""
    fix = fix or {}
    vis = lambda c: ' '.join(fix.get(t, t) for t in c if fix.get(t, t))
    out, cur, last, prev = [], [], None, None
    for s, e, x in toks(T, a, b):
        turn = any(prev is not None and prev < k <= s for k in brk)    # 말하는 사람이 바뀌는 곳에서는 칸을 끊는다
        pause = last is not None and s - last > gap and (len(vis(cur)) > 2 or s - last > 1.0)   # 한두 글자 칸은 짧은 쉼에 안 떼어 낸다
        n, tail, nxt = len(vis(cur)), vis(cur[-1:]), vis([x])
        ok = not nxt.startswith(NOBREAK)
        exclaim = cur and all(vis([c]) in INTERJ for c in cur) and nxt not in INTERJ    # 감탄사·호응(예·자·아니)은 짧아도 한 칸
        ended = cur and ok and (exclaim or (n >= 4 and tail.endswith(STRONG)) or (n >= SOFT and len(tail) >= 2 and tail.endswith(JOINT)))
        if cur and len(vis(cur + [x])) > CAP and not (pause or turn or ended):
            # 넘칠 때는 마지막으로 끊어도 되는 어절 경계까지 되돌아가 끊는다(«하지 / 마십시오» 방지)
            j = next((j for j in range(len(cur) - 1, 0, -1) if len(vis(cur[j - 1:j])) >= 2 and vis(cur[j - 1:j]).endswith(STRONG + JOINT)
                      and not vis(cur[j:j + 1]).startswith(NOBREAK) and len(vis(cur[:j])) >= 4), None)
            if j:
                out.append(cur[:j]); cur = cur[j:]
            else:
                out.append(cur); cur = []
        elif cur and (pause or turn or ended):
            out.append(cur); cur = []
        cur.append(x); last, prev = e, s
    if cur:
        out.append(cur)
    caps = []
    for c in out:
        raw, shown = ' '.join(c), vis(c)
        if not shown:
            continue
        assert len(shown) <= CAP, shown
        caps.append(raw if raw == shown else '%s|%s' % (raw, shown))
    return {'source_in': a, 'source_out': b, 'captions': caps}


LONG = '전체 맥락은 롱폼에서\n«이재명 재판 중지·조희대 탄핵»'
SHORTS = {
    # 18:00 발췌형 — 롱폼 ISSUE 03 이광철(매불쇼 10.16) 32.2~72.9 중 일부
    's1_chago': dict(vid='MZBJG-V1g7A_7120', credit='영상: [팟빵] 최욱의 매불쇼 2026.10.16',
                     title=['조희대 탄핵', '«차고 넘친다»'], keys=['차고'],
                     hook=(39.05, 43.0), hook_who='a',
                     nar=['조희대 탄핵 논의', '법률가 출신 출연자의 판단'], pic_in=39.2,
                     cuts=[(32.0, 45.5), (45.6, 61.1), (61.2, 72.65)],
                     spk={'a': ('이광철', '변호사 · 전 청와대 민정비서관', '#12A88A')}, who=['a', 'a', 'a', 'a'],
                     hot=['조희대', '위배했다고', '차고', '넘친다', '압도적인', '여론이'], end=LONG),
    # 21:00 질문형 — 롱폼 ISSUE 03 주진우 기자(매불쇼 10.16) 103.0~139.0 중 일부
    's2_why': dict(vid='MZBJG-V1g7A_7120', credit='영상: [팟빵] 최욱의 매불쇼 2026.10.16',
                   title=['왜 지금', '조희대 탄핵인가'], keys=['조희대'],
                   hook=(103.9, 110.35), hook_who='a',
                   nar=['탄핵 때마다 주저했던 민주당', '왜 지금 조희대 탄핵 얘기가 나왔나'], pic_in=113.4,
                   cuts=[(103.0, 110.2), (110.4, 126.9), (127.1, 138.65)],
                   spk={'a': ('주진우', '기자 · 매불쇼 출연', '#12A88A')}, who=['a', 'a', 'a', 'a'],
                   fix={'있느냐': '', '끌어': '', '네': ''}, hot=['조희대', '정치적', '정치의', '판단을'], end=LONG),
}

for name, s in SHORTS.items():
    T = str(EP / 'transcripts' / f"{s['vid']}.json")
    plan = {'source': str(EP / 'src' / f"{s.get('src', s['vid'])}.mp4"), 'transcript': T, 'lang': 'ko', 'mirror': False,
            'camera': 'auto', 'episode': '017', 'date': '10.17 (토)', 'title': s['title'], 'title_keys': s['keys'],
            'credit': s['credit'], 'source_id': s['vid'], 'brand': {'name': '쟁점 브리핑'},
            'narration': [{'id': 'n0', 'cards': s['nar']}],
            **({'zoom': s['zoom']} if 'zoom' in s else {}),
            'sequence': ([{**cut(T, s['hook'][0], s['hook'][1], s.get('fix')), **({'cx': s['hook'][2]} if len(s['hook']) > 2 else {})}]
                         if 'hook' in s else [])
                        + [{'narration': 'n0', 'pic_in': s['pic_in'], **({'cx': s['cx']} if 'cx' in s else {})}]
                        + [{**cut(T, c[0], c[1], s.get('fix'), brk=[v[0] for vs in s.get('voices', {}).values() for v in vs]),
                            **({'cx': c[2]} if len(c) > 2 else {})} for c in s['cuts']],
            'speakers': {k: {'name': v[0], 'role': v[1], 'color': v[2], **({'label': v[3]} if len(v) > 3 else {})}
                         for k, v in s['spk'].items()},   # 이름 없는 키 = 화면 밖 목소리(이름표 없이 말풍선 라벨만)
            'hot': s.get('hot', []), **({'end': s['end']} if 'end' in s else {})}
    for i, vs in s.get('voices', {}).items():     # 칸 안에서 말하는 사람이 바뀌는 시각(원본초) — 자막 색을 가른다
        plan['sequence'][i + ('hook' in s)]['voices'] = vs
    for seg, w in zip(plan['sequence'], ([s['hook_who']] if 'hook' in s else []) + s['who']):   # 이름표 — 화면·목소리로 확인한 사람만
        if w:
            seg['who'] = w
    d = HERE / '20261017' / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(name, sum(c[1] - c[0] for c in s['cuts']), [c.get('captions', 'NAR') for c in plan['sequence']])
