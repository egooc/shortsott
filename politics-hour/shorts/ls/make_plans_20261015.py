"""10-15 쇼츠 — 롱투숏 방식 plan 만들기(소유주 10-15). 렌더: python ../briefing_render.py <폴더>/plan.json
s5 는 JTV 좌우 분할 화면 — 렌더러가 JTV 로고를 창 밖에 두려고 cx 를 0.45 아래로 묶어 말하는 김용민(오른쪽)을 못 잡는다. 그래서 오른쪽 칸만 잘라 낸 파생 소스(CQEEYoLOb9o_right.mp4, crop=640:700:980:140, 시각 그대로)를 쓴다. s3 은 KBS 이름 띠(원본 84~100%)가 자막과 겹쳐 zoom 으로 창 밖에 뺐다. s4(옥중 20억)는 원본이 76초짜리 G1 클립이라 40초 관문을 못 채워 뺐다."""
import json, sys
from pathlib import Path
sys.path.insert(0, 'D:/volcano-runs/ls_tools')
from autocap import toks, MAX

EP = Path('D:/midform/politics-hour/episodes/20261015')
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


SHORTS = {
    's1_kkori': dict(vid='eHf71pXdShI', credit='영상: 울산MBC뉴스 2026.10.13',
                     title=['주진우에 터진 일갈', '꼬리를 딱 내려야지'], keys=['꼬리를'],
                     nar=['주진우 의원 향해', '위원장이 터졌다'], pic_in=508.3,
                     fix={'박형수연도': '박형수 의원도', '곽혜택': '곽규택', '내릴줄': '내릴 줄'},
                     cuts=[(489.6, 506.98), (510.15, 519.4), (523.45, 536.65)],
                     spk={'a': ('서영교', '더불어민주당 의원 · 법사위원장', '#1E5BD8')}, who=['a', 'a', 'a', 'a'],
                     hot=['꼬리를', '조용히', '내려야지', '틀렸으면']),
    's2_kkoim': dict(vid='7DGEJZb3iJE', credit='영상: 울산MBC뉴스 2026.10.06',
                     title=['선서 거부하다', '말이 꼬였다'], keys=['꼬였다'],
                     nar=['증언 거부 이유 읽던', '대법원장, 말이 꼬였다'], pic_in=659.5,
                     cuts=[(643.3, 658.35), (659.5, 672.0), (672.85, 685.98)],
                     spk={'a': ('조희대', '대법원장', '#4A4F5C'), 'x': (None, '', '#E8590C', '현장음')}, who=['a', 'a', 'a', 'a'],
                     fix={'나': '', '선서': '선서나'}, voices={2: [[668.2, 'x', 'r']], 3: [[679.9, 'x', 'r']]}, hot=['거부할', '거부', '꼬이셨어요', '밝힙니다']),
    's3_kimyj': dict(vid='zWJHYHNPAmQ', credit='영상: KBS News 2026.10.14',
                     title=['북한 규탄 결의안에', '김여정이 뭐라겠나'], keys=['김여정이'],
                     nar=['북한 규탄 결의안에', '우리 군 책임도 넣자?'], pic_in=937.45, zoom=[0.75, 0.38],
                     fix={'반기': '방기'},
                     cuts=[(909.65, 920.9), (931.5, 947.7), (948.15, 958.85), (958.95, 966.6)],
                     spk={'a': ('박선원', '더불어민주당 의원 · 국방위', '#1E5BD8'), 'b': ('성일종', '국민의힘 의원', '#C9151E')},
                     who=['a', 'b', 'a', 'a', 'a'], voices={2: [[931.5, 'b'], [935.3, 'a']]},
                     hot=['김여정', '조롱할', '형용모순이죠', '들러리', '방기']),
    's5_heonbeop': dict(vid='CQEEYoLOb9o', credit='영상: JTV뉴스 2026.10.06',
                        title=['헌법 똑바로', '읽고 나오시라'], keys=['헌법'],
                        nar=['사법부 독립이냐', '법관의 독립이냐'], pic_in=344.2, cx=.5, src='CQEEYoLOb9o_right',
                        fix={'백': '104조에서', '사조에서': '', '재청': '제청', '중': '조항', '보십시요': '보십시오'},
                        cuts=[(344.2, 359.98, .5), (359.98, 371.4, .5), (375.0, 388.4, .5)],
                        spk={'a': ('김용민', '더불어민주당 의원 · 법사위', '#1E5BD8'), 'y': (None, '', '#E8590C', '답변')}, who=['a', 'a', 'a', 'a'],
                        voices={3: [[378.6, 'y', 'l'], [380.6, 'a']]}, hot=['헌법', '사법부', '법관의', '똑바로', '자의적으로']),
}

for name, s in SHORTS.items():
    T = str(EP / 'transcripts' / f"{s['vid']}.json")
    plan = {'source': str(EP / 'src' / f"{s.get('src', s['vid'])}.mp4"), 'transcript': T, 'lang': 'ko', 'mirror': False,
            'camera': 'auto', 'episode': '015', 'date': '10.15 (목)', 'title': s['title'], 'title_keys': s['keys'],
            'credit': s['credit'], 'source_id': s['vid'], 'brand': {'name': '쟁점 브리핑'},
            'narration': [{'id': 'n0', 'cards': s['nar']}],
            **({'zoom': s['zoom']} if 'zoom' in s else {}),
            'sequence': [{'narration': 'n0', 'pic_in': s['pic_in'], **({'cx': s['cx']} if 'cx' in s else {})}]
                        + [{**cut(T, c[0], c[1], s.get('fix'), brk=[v[0] for vs in s.get('voices', {}).values() for v in vs]),
                            **({'cx': c[2]} if len(c) > 2 else {})} for c in s['cuts']],
            'speakers': {k: {'name': v[0], 'role': v[1], 'color': v[2], **({'label': v[3]} if len(v) > 3 else {})}
                         for k, v in s['spk'].items()},   # 이름 없는 키 = 화면 밖 목소리(이름표 없이 말풍선 라벨만)
            'hot': s.get('hot', [])}
    for i, vs in s.get('voices', {}).items():     # 칸 안에서 말하는 사람이 바뀌는 시각(원본초) — 자막 색을 가른다
        plan['sequence'][i]['voices'] = vs
    for seg, w in zip(plan['sequence'], s['who']):   # 이름표 — 화면·목소리로 확인한 사람만
        if w:
            seg['who'] = w
    d = HERE / '20261015' / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(name, sum(c[1] - c[0] for c in s['cuts']), [c['captions'] for c in plan['sequence'][1:]])
