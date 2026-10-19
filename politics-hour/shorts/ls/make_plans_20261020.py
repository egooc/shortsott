"""10-20 쇼츠 — 10-19 틀 그대로(make_plans_20261019.py 복사). 롱폼 10/20편 인용 구간의 일부만.
s1: 김종배(MBC 라디오 시선집중 7/23) 91.6~116.6 — «감나라 대추나라 흙이…» 받아쓰기 불명 구간 앞에서 끊음. 7월 기소 직후 방송임을 카드에 밝힌다.
s2: 정춘생(매불쇼 10/19) 28.7~51.9 — «외통 하다 보니까…» 받아쓰기 불명 구간 앞에서 끊음."""
import json, sys
from pathlib import Path
sys.path.insert(0, 'D:/volcano-runs/ls_tools')
from autocap import toks, MAX

EP = Path('D:/midform/politics-hour/episodes/20261020')
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


LONG = '전체 맥락은 롱폼에서\n«모스 탄 재판·조희대 탄핵·청해부대»'
SHORTS = {
    # 롱폼 ISSUE 01 시선집중 김종배 91.4~122.15 중 일부. 7월 기소 직후 방송(«기소 당시»)
    's1_sabeop': dict(vid='t02Cu_0Je_w_600', credit='영상: MBC 라디오 〈김종배의 시선집중〉 260723(목) 방송',
                      title=['모스 탄', '사법주권 문제입니다'], keys=['모스 탄'],
                      hook=(108.8, 110.57), hook_who='a',
                      nar=['모스 탄 이재명 대통령 명예훼손 재판 · 10.16 첫 공판', '김종배 · 7월 기소 직후 방송'], pic_in=140.0,
                      cuts=[(91.61, 103.58), (103.91, 116.6)],
                      spk={'a': ('김종배', '시사평론가 · 시선집중 진행', '#12A88A')}, who=['a', 'a'],
                      fix={'사람가지고': '사람 가지고'},
                      hot=['사법주권', '미국', '대응은', '명예를'], end=LONG),
    # 롱폼 ISSUE 02 매불쇼 정춘생 28.62~69.69 중 일부. 소추안은 «공개»만(발의 아님)
    # 10-20 05:5x: 31초라 40초 관문 미달 → 앞 17.3~28.4(법카·격려금)·뒤 ~54.9(내일 당대표 기자회견)로 늘림, 해설 그림은 정춘생 화면(62초, 100초는 남성 출연자라 이름 카드와 어긋남),
    # 좌상단 매불쇼 출연자 띠(원본 x~700·y~194)가 창에 걸려 crop=1220:980:700:100 파생 소스(_jcs, 시각 그대로)
    's2_hamkke': dict(vid='sRegjA570As_4230_jcs', credit='영상: [팟빵] 최욱의 매불쇼 2026.10.19',
                      title=['조희대 탄핵', '민주당과 함께 합시다'], keys=['조희대 탄핵'],
                      hook=(35.78, 38.15), hook_who='a',
                      nar=['조국혁신당 조희대 탄핵소추안 공개 · 발의는 아직', '정춘생 «민주당과 함께 합시다»'], pic_in=62.0,
                      cuts=[(17.3, 28.4), (28.67, 38.2), (38.15, 55.3)],
                      spk={'a': ('정춘생', '조국혁신당 국회의원', '#1E5BD8')}, who=['a', 'a', 'a'],
                      fix={'버카': '법카'},
                      hot=['조희대', '탄핵안을', '민주당과', '함께'], end=LONG),
}

for name, s in SHORTS.items():
    T = str(EP / 'transcripts' / f"{s['vid']}.json")
    plan = {'source': str(EP / 'src' / f"{s.get('src', s['vid'])}.mp4"), 'transcript': T, 'lang': 'ko', 'mirror': False,
            'camera': 'auto', 'episode': '020', 'date': '10.20 (화)', 'title': s['title'], 'title_keys': s['keys'],
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
    d = HERE / '20261020' / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(name, sum(c[1] - c[0] for c in s['cuts']), [c.get('captions', 'NAR') for c in plan['sequence']])
