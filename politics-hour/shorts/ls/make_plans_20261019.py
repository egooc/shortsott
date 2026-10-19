"""10-19 쇼츠 — 10-18 틀 그대로(make_plans_20261018.py 복사). 롱폼 10/19편 인용 구간의 일부만.
s1: 여선웅(끝장뉴스) 41.09~80.04 중 — 44.4~46.9 «엠엘1 지레»(받아쓰기 불명)·64.5~66.0 «그러니까요»(화자 불확실) 뺌.
s2: 박용진(KBC 뉴스메이커) 253.0~293.2. «역린» 받아쓰기 고침. 김병주(오마이TV)는 소유주 판단 대기라 안 씀."""
import json, sys
from pathlib import Path
sys.path.insert(0, 'D:/volcano-runs/ls_tools')
from autocap import toks, MAX

EP = Path('D:/midform/politics-hour/episodes/20261019')
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


LONG = '전체 맥락은 롱폼에서\n«브런슨 철책선·조희대 탄핵·한동훈»'
SHORTS = {
    # 롱폼 ISSUE 01 끝장뉴스 여선웅 41.09~80.04 중 일부. 브런슨 발언은 한국 언론 번역 보도
    's1_urittang': dict(vid='4BXBQs62Rwo', credit='영상: 뉴스토마토 «끝장뉴스» 2026.10.18',
                        title=['브런슨', '우리 땅이 아닙니까'], keys=['브런슨'],
                        hook=(57.89, 64.46), hook_who='a',
                        nar=['브런슨 사령관 «남쪽 철책선에서 대한민국 시작»', '여선웅 «국민의힘은 왜 말이 없나»'], pic_in=48.0,
                        cuts=[(41.0, 44.56, 0.73), (49.35, 57.88), (57.89, 64.46), (66.14, 79.96)],
                        spk={'a': ('여선웅', '뉴스토마토 «끝장뉴스» 패널', '#1E5BD8')}, who=['a', 'a', 'a', 'a'],
                        fix={'브람스는': '브런슨', '브랜슨': '브런슨', '국민의': '국민의힘도', '힘도': ''},
                        hot=['브런슨', '국민의힘은', '우리', '땅이', '사과를'], end=LONG),
    # 롱폼 ISSUE 03 KBC 뉴스메이커 박용진 253.0~293.2 중 일부. 딸 의혹은 «의혹», 수사 진행 중
    's2_bigyo': dict(vid='poXMTZvM_oE_2140', credit='영상: KBC 뉴스 «KBC 뉴스메이커» 2026.10.18',
                     title=['한동훈 딸', '왜 조국 딸하고 비교해요'], keys=['한동훈'],
                     hook=(284.38, 287.8), hook_who='a',
                     nar=['한동훈 딸 의혹 재고발 · 중수청 배당', '박용진 «국민 눈높이에서 생각해야»'], pic_in=275.0,
                     cuts=[(253.1, 259.3), (259.8, 266.98), (267.05, 278.97), (279.2, 292.95)],
                     spk={'a': ('박용진', '전 더불어민주당 의원', '#1E5BD8')}, who=['a', 'a', 'a', 'a'],
                     fix={'영린이에요': '역린이에요', '영린입니다': '역린입니다', '화나흥분데요': '화나고 흥분해요', '세상이': '세상에', '때라고': '딸하고'},
                     hot=['한동훈', '역린', '조국', '비교해요', '눈높이'], end=LONG),
}

for name, s in SHORTS.items():
    T = str(EP / 'transcripts' / f"{s['vid']}.json")
    plan = {'source': str(EP / 'src' / f"{s.get('src', s['vid'])}.mp4"), 'transcript': T, 'lang': 'ko', 'mirror': False,
            'camera': 'auto', 'episode': '019', 'date': '10.19 (월)', 'title': s['title'], 'title_keys': s['keys'],
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
    d = HERE / '20261019' / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(name, sum(c[1] - c[0] for c in s['cuts']), [c.get('captions', 'NAR') for c in plan['sequence']])
