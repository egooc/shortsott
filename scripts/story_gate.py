# -*- coding: utf-8 -*-
"""이야기 구조 관문(10-21 소유주 질책 «화면 해설 말고 허구라도 스토리를 입혀라») — devo V1·V5, 전자책 W10·W12.
형식(30자·주어 호명·댓글 장치)만 보던 관문에 «이야기 구조»를 더한다. 쇼츠 레인 공용.

    python scripts/story_gate.py <plan.json|spec.json|폴더>[:<쇼츠 id>] [--field narration] [--lane politics_short] [--lang ko|ja] [--enforce-now] [--json]

입력: 레인 plan/spec json. 원고 문장 = --field 로 지정한 필드(기본 narration → captions → lines 순으로 찾음).
  문장 배열은 문자열 또는 {text|caption|line|t} 객체. 문자열 하나면 문장 끝(.?!。)으로 나눈다.
  story 객체(plan.story, 없으면 쇼츠 항목.story):
    {"structure_id": "구조 ID(W12 10유형 또는 자체 무기 이름)",
     "beats": {"situation": "...", "stake": "...", "attempt": "...", "turn": "...", "ending": "...", "emotion_tail": "..."},
     "map": ["situation", "stake", ...]   # 문장 i → beat (리스트 또는 {"0": "situation"})
     "fiction": {"allowed": true, "devices": ["생각 풍선", "의인화"]}}   # plan.fiction 도 읽는다
검사:
  ① story 필수 · structure_id(또는 plan.pattern) · beats 6개 각 1문장 이상 — 없거나 빈 beat FAIL
  ② 문장→beat 매핑 — 매핑 없는 문장 1개↑ WARN · 30%↑ FAIL (beat 이름이 아닌 값도 «없음»)
  ③ 화면 묘사형 — 인과·시간 연결어도, 의도·감정 낱말도 없이 현재 상태 어미(«~하고 있습니다» «~입니다» «~이다»)로 끝나는 문장 30%↑ WARN · 50%↑ FAIL
  ④ turn — turn 문장(beats.turn + map 이 turn 인 문장)이 앞 beat(상황·위기·시도)와 낱말 1개↑ 겹치고,
     변화 표지(낱말 «갑자기·바뀌…» 또는 어미 «~더니·~는데..·~해버림·바로») 또는 앞에 없던 새 동사(«떠올림·씌워»)가 있어야 함, 없으면 FAIL
  ⑤ fiction — 정치 레인(--lane politics* 또는 경로에 politics)은 allowed=false 고정, allowed=true·devices 있음 FAIL.
     다른 레인은 허구 허용, 다만 숫자 문장이 있는데 facts/sources 필드가 없으면 WARN(P8 — 수치·사실 주장은 출처 그대로). fiction 필드 없음 WARN.
  ⑥ 장치 — story.devices {문장 번호: 장치 이름 | [장치, …]} 에서 12종(docs/longshort-reset-20261019.md §9)만 센다. 서로 다른 장치 5개 미만 WARN(10-23부터 FAIL).
     같은 장치 반복은 1로 센다. 목록 밖 이름·없는 문장 번호는 WARN. 정치 레인·fiction.allowed=false 는 허구형(캐릭터 설정·빌런·생각 풍선) FAIL.
     «구조는 뼈대, 장치가 재미»(10-21 소유주). 이름 뒤 괄호 설명(«반전+비장의 무기(W3④)»)은 그대로 둬도 된다.
출력: «[관문] story: PASS/WARN/FAIL · 사유» 한 줄(--json 은 JSON 한 줄).
종료 코드: 0 PASS·WARN · 4 FAIL · 5 검사 불가(파일·문장 없음 — server/data/gate_errors.jsonl).
유예: ENFORCE_FROM(2026-10-23 00:00 KST) 전에는 FAIL 도 «[유예 ~10-23]» 을 붙여 찍고 0.

import:
    sys.path.insert(0, 'D:/midform/scripts'); from story_gate import judge
    judge(plan_dict, sentences, lane='', lang='ko') → {'verdict': 'PASS|WARN|FAIL', 'fails': [...], 'warns': [...], 'stats': {...}}
    node 쪽은 CLI 종료 코드를 쓴다.
"""
import datetime as _dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hook_link import nouns  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
ENFORCE_FROM = _dt.datetime(2026, 10, 23, 0, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))
BEATS = ('situation', 'stake', 'attempt', 'turn', 'ending', 'emotion_tail')
FIELDS = ('narration', 'captions', 'lines', 'segments')   # segments = 롱투숏 plan(text 의 « / » 는 줄바꿈)
# 한국어 beat 이름·목록 꼴(«상황: …») 도 받는다 — 롱투숏 lx03 꼴(10-21). hook(훅) 은 매핑으로 인정하되 필수 beat 은 아님
ALIAS = {'상황': 'situation', '위기': 'stake', '욕구': 'stake', '위기·욕구': 'stake', '시도': 'attempt', '실패': 'attempt', '시도·실패': 'attempt',
         '개입': 'turn', '전환': 'turn', '결말': 'ending', '감정 꼬리': 'emotion_tail', '감정꼬리': 'emotion_tail', '꼬리': 'emotion_tail', '훅': 'hook', '후킹': 'hook'}
MAPPABLE = BEATS + ('hook',)
# ③ 인과·시간 연결 — 낱말 경계로 보는 것과 어미(낱말 끝)로 보는 것
LINK_WORDS = {
    'ko': ('그래서', '그런데', '하지만', '그러나', '결국', '그러자', '그러다', '그때', '마침내', '드디어', '끝내', '순간', '때문', '덕분', '뒤', '후', '만에', '동안', '내내', '다시', '이미', '아직', '벌써', '처음', '이제', '갑자기', '오히려', '반대로', '대신'),
    'ja': ('だから', 'でも', 'しかし', '結局', 'すると', 'ところが', 'その時', 'ついに', 'やっと', '突然', 'なのに', 'ので', 'から', 'のに', 'あと', '後', 'まだ', 'もう', '初めて', '逆に'),
}
LINK_ENDS = {
    'ko': ('더니', '자마자', '는데', '은데', '인데', '니까', '으니', '려고', '면서', '지만', '도록', '다가', '어서', '아서', '해서', '고서', '째', '면'),
    'ja': ('たら', 'ても', 'でも', 'けど', 'ながら', 'ために'),
}
NOT_JA_ENDING_NOUNS = {'남자', '여자', '의자', '상자', '과자', '사자', '모자', '감자', '숫자', '혼자', '기자', '부자', '환자', '왕자', '액자', '글자', '피자', '천자', '독자', '자자'}
INTENT = {
    'ko': ('싶', '려고', '겠', '무서', '두려', '기뻐', '기쁘', '화가', '화나', '놀라', '놀란', '걱정', '포기', '결심', '생각', '몰래', '애타', '간절', '마음', '눈물', '설마', '제발', '하필', '외롭', '슬프', '슬퍼', '억울', '안도', '울컥', '참았', '버텼', '믿', '바라', '원했', '노리', '속으로', '?', '!'),
    'ja': ('たい', 'つもり', '思っ', '怖', '嬉し', '心配', '決め', '諦め', '願', '涙', 'まさか', 'どうか', '寂し', '悲し', '悔し', 'ほっと', '信じ', '?', '？', '!', '！'),
}
STATE_END = {
    'ko': re.compile(r'(고\s*있(습니다|어요|다|네요)|있습니다|있어요|있다|입니다|이다|이에요|예요|합니다|됩니다|보입니다|이죠)[.。…]?$'),
    'ja': re.compile(r'(ている|ています|てる|です|だ|である|ます)[。.…]?$'),
}
# ④ 변화 낱말 — turn 은 앞과 다른 상태를 말해야 한다
CHANGE = {
    'ko': ('갑자기', '그런데', '하지만', '그러자', '순간', '드디어', '마침내', '결국', '처음으로', '오히려', '반대로', '이제', '더 이상', '더는', '바뀌', '바꿨', '달라', '변했', '사라', '멈췄', '멈추', '풀렸', '열렸', '깨달', '알아챘', '돌아', '시작', '없었', '않았', '못했', '대신', '그제야', '비로소', '뒤집'),
    'ja': ('突然', 'でも', 'しかし', 'すると', 'ついに', 'やっと', '結局', '初めて', '逆に', 'もう', '変わ', '消え', '止ま', '気づ', '始ま', 'なかった'),
}
# 10-21 레퍼런스 실제 자막(문어 편)이 낱말 목록으로는 못 넘었다 → 어미 표지(b)와 «새 동사»(a)도 변화로 인정
CHANGE_ENDS = {'ko': ('더니', '는데..', '는데…', '버림', '버렸', '버리', '바로'), 'ja': ('たら', 'ところ', 'しまっ', 'すぐ')}
PRED_END = re.compile(r'(버림|버렸다|버려|더니|봤는데|았는데|었는데|했는데|는데|다|요|음|림|줌|함|짐|김|봄|움|워|줘|고|서)$')
AUX = {'있', '없', '이', '하', '되', '않', '같', '보', '싶', '중', '했', '였', '있었', '없었'}


def new_verbs(turn_t, prev_t):
    """(a) turn 의 서술어 어간 중 앞(상황·위기·시도)에 없는 것 — «떠올림·씌워·파악해버림». 있다·하다 같은 보조어는 뺀다."""
    prev = {w[:2] for w in re.findall(r'[가-힣]{2,}', prev_t)}
    out = []
    for tok in re.findall(r'[가-힣]{2,}', turn_t):
        mm = PRED_END.search(tok)
        if not mm:
            continue
        stem = tok[:mm.start()] or tok
        if len(stem) < 2 or stem in AUX or stem[:2] in prev or stem[:1] in AUX and len(stem) < 3:
            continue
        out.append(tok)
    return list(dict.fromkeys(out))


NUM_RX = re.compile(r'\d|[일이삼사오육칠팔구십백천만억]+\s*(퍼센트|%|원|명|배|년|억|만)')
FICTION_MARK = re.compile(r'생각\s*풍선|속마음|\(생각\)|【心の声】|心の声')


def _text(x):
    if isinstance(x, dict):
        for k in ('text', 'caption', 'line', 't', 'narration'):
            if isinstance(x.get(k), str) and (k != 't' or len(x.get(k)) > 3):
                return x[k].replace(' / ', ' ')
        return ''
    return str(x or '')


def split_sentences(v):
    if isinstance(v, str):
        return [s.strip() for s in re.split(r'(?<=[.?!。？！])\s*|\n+', v) if s.strip()]
    if isinstance(v, list):
        return [s for s in (_text(x).replace(' / ', ' ').strip() for x in v) if s]
    return []


def sentences_of(plan, field=None):
    for f in ([field] if field else FIELDS):
        if f and f in plan and split_sentences(plan[f]):
            return f, split_sentences(plan[f])
    return field, []


def _words(t, lang):
    """겹침 비교용 낱말 어간 — ko 는 명사 어림 + 앞 2자, ja 는 한자·가타카나 덩어리."""
    ws = nouns(t, lang)
    return {w[:2] if lang != 'ja' else w for w in ws if len(w) >= 2}


def descriptive(s, lang='ko'):
    """화면 묘사형: 연결어·의도 낱말 없이 현재 상태 어미로 끝남."""
    t = s.strip()
    if any(w in t for w in INTENT.get(lang, ())):
        return False
    if any(re.search(rf'(^|\s){re.escape(w)}', t) for w in LINK_WORDS.get(lang, ())):
        return False
    toks = re.findall(r'[가-힣]+', t) if lang != 'ja' else []
    if any(tok.endswith(e) for tok in toks[:-1] for e in LINK_ENDS['ko']) or \
            any(tok.endswith('자') and tok not in NOT_JA_ENDING_NOUNS and len(tok) >= 2 for tok in toks[:-1]):
        return False
    if lang == 'ja' and any(e in t for e in LINK_ENDS['ja']):
        return False
    return bool(STATE_END.get(lang, STATE_END['ko']).search(t))


def _canon(k):
    k = str(k or '').strip()
    return k if k in MAPPABLE else ALIAS.get(k, ALIAS.get(k.replace(' ', ''), k))


def norm_beats(b):
    """{situation: ...} · {상황: ...} · ['상황: ...', ...] → {situation: text}"""
    out = {}
    items = b.items() if isinstance(b, dict) else [(x.split(':', 1) if ':' in str(x) else (None, x)) for x in (b or [])] if isinstance(b, list) else []
    for k, v in items:
        c = _canon(k)
        if c in BEATS:
            out[c] = (out.get(c, '') + ' ' + _beat_text(v)).strip()
    return out


def _beat_text(b):
    return ' '.join(b) if isinstance(b, list) else str(b or '')


# ⑥ 장치 12종 — 이름: 알아보는 낱말(앞에서부터 찾는다)
DEVICES = {
    '훅 질문': ('훅 질문', '훅질문', '후킹 질문'), '캐릭터 설정': ('캐릭터',), '빌런': ('빌런', '반대자'),
    '시도·실패': ('시도·실패', '시도 실패', '시도-실패', '시도실패'), '반전·비장의 무기': ('반전', '비장의 무기'),
    '금지된 지식': ('금지된 지식',), '의성어·현장감': ('의성어', '현장감'), '궁금증 연쇄': ('궁금증 연쇄', '궁금증연쇄'),
    '생각 풍선': ('생각 풍선', '생각풍선', '속말'), '클라이맥스 예고': ('클라이맥스 예고', '클라이맥스'), '감정 꼬리': ('감정 꼬리', '감정꼬리'),
    '열린 결말 질문': ('열린 결말', '열린결말'),
}
FICTION_DEVICES = {'캐릭터 설정', '빌런', '생각 풍선'}   # 정치 레인 금지(실명 인물은 확인된 사건·발언만)
MIN_DEVICES = 5


def device_names(v):
    """«반전+비장의 무기(W3④)» → ['반전·비장의 무기'] — 한 칸에 여러 장치를 + 로 적어도 센다."""
    t = re.sub(r'\([^)]*\)', ' ', str(v or ''))
    return list(dict.fromkeys(name for name, keys in DEVICES.items() if any(k in t for k in keys)))


def judge(plan, sentences, lane='', lang='ko', story=None, enforce=None):
    fails, warns, stats = [], [], {'n': len(sentences)}
    enforce = (_dt.datetime.now(_dt.timezone.utc) >= ENFORCE_FROM) if enforce is None else enforce
    story = story if story is not None else plan.get('story')
    politics = 'politic' in (lane or '')
    # ① story 객체 · 구조 ID · beats
    if not isinstance(story, dict):
        fails.append('① story 객체 없음 — structure_id·beats 6개·map 을 원고 전에 적어라(W12)')
        story = {}
    else:
        sid = story.get('structure_id') or plan.get('pattern')
        if not str(sid or '').strip():
            fails.append('① structure_id 없음(W12 구조 ID 또는 자체 무기 이름)')
        beats = norm_beats(story.get('beats'))
        empty = [b for b in BEATS if not _beat_text(beats.get(b)).strip()]
        if empty:
            fails.append(f'① 빈 beat {"·".join(empty)}')
    beats = norm_beats(story.get('beats'))
    # ② 매핑
    m = story.get('map')
    if isinstance(m, dict):
        m = [m.get(str(i), m.get(i)) for i in range(len(sentences))]
    m = [_canon(x) for x in (m or [])] + [None] * max(0, len(sentences) - len(m or []))
    unmapped = [i for i in range(len(sentences)) if m[i] not in MAPPABLE]
    stats['unmapped'] = len(unmapped)
    if story and sentences:
        ratio = len(unmapped) / len(sentences)
        if ratio >= 0.30:
            fails.append(f'② 매핑 없는 문장 {len(unmapped)}/{len(sentences)}({ratio:.0%}) — 문장마다 story.map 에 beat')
        elif unmapped:
            warns.append(f'② 매핑 없는 문장 {len(unmapped)}개(#{",".join(str(i + 1) for i in unmapped[:5])})')
    # ③ 화면 묘사형
    desc = [i for i, s in enumerate(sentences) if descriptive(s, lang)]
    dr = len(desc) / len(sentences) if sentences else 0
    stats['descriptive'] = len(desc)
    ex = f' 예 «{sentences[desc[0]][:24]}»' if desc else ''
    if dr > 0.50:
        fails.append(f'③ 화면 묘사형 {len(desc)}/{len(sentences)}({dr:.0%}) — 인과·시간·감정으로 다시 써라(V5 «기다리고 있습니다»→«8시간째 같은 자리»){ex}')
    elif dr > 0.30:
        warns.append(f'③ 화면 묘사형 {len(desc)}/{len(sentences)}({dr:.0%}){ex}')
    # ④ turn — 앞 beat 와 겹치는 낱말 + 변화 낱말
    if story:
        turn_t = ' '.join([_beat_text(beats.get('turn'))] + [sentences[i] for i in range(len(sentences)) if m[i] == 'turn'])
        prev_t = ' '.join([_beat_text(beats.get(b)) for b in ('situation', 'stake', 'attempt')] +
                          [sentences[i] for i in range(len(sentences)) if m[i] in ('situation', 'stake', 'attempt')])
        common = sorted(_words(turn_t, lang) & _words(prev_t, lang))
        change = [w for w in CHANGE.get(lang, ()) + CHANGE_ENDS.get(lang, ()) if w in turn_t]
        nv = new_verbs(turn_t, prev_t) if lang != 'ja' else []
        stats['turn_common'], stats['turn_change'], stats['turn_new_verbs'] = common[:5], change[:3], nv[:3]
        if turn_t.strip() and (not common or not (change or nv)):
            fails.append('④ turn 이 앞과 다른 상태를 말하지 않음 — ' + ('앞 beat 와 겹치는 낱말 0' if not common else '변화 표지(갑자기·바뀌·~더니·~해버림·바로) 0 · 앞에 없던 새 동사 0') +
                         ' — beats.turn 문장에 앞 beat 낱말(대상·문제)을 담고 무엇이 바뀌었는지 써라')
    # ⑤ fiction
    fic = story.get('fiction') if isinstance(story.get('fiction'), dict) else plan.get('fiction') if isinstance(plan.get('fiction'), dict) else None
    marks = [s for s in sentences if FICTION_MARK.search(s)]
    if politics:
        if (fic and (fic.get('allowed') or fic.get('devices'))) or marks:
            fails.append('⑤ 정치 레인은 허구 장치 금지(fiction.allowed=false 고정 — 실명 인물은 확인된 사건·발언만)')
    else:
        if fic is None:
            warns.append('⑤ fiction 필드 없음({allowed, devices})')
        elif fic.get('allowed'):
            nums = [s for s in sentences if NUM_RX.search(s)]
            if nums and not any(plan.get(k) or story.get(k) or fic.get(k) for k in ('facts', 'facts_from_source', 'sources', 'source_refs', '출처')):
                warns.append(f'⑤ 허구 허용 편에 숫자 문장 {len(nums)}개인데 facts/sources 없음(P8 — 수치·사실은 출처 그대로) 예 «{nums[0][:20]}»')
    # ⑥ 장치
    dv = story.get('devices') if isinstance(story.get('devices'), dict) else plan.get('devices') if isinstance(plan.get('devices'), dict) else {}
    used, unknown, badidx = [], [], []
    for k, v in dv.items():
        names = []
        for one in (v if isinstance(v, list) else [v]):   # {문장: 장치} · {문장: [장치, …]} 둘 다(10-21 관리자 결정, 린박스 nar2)
            got = device_names(one)
            if not got:
                unknown.append(str(one)[:12])
            names += got
        if not (str(k).isdigit() and int(k) < len(sentences)):
            badidx.append(str(k))
        used += names
    used = list(dict.fromkeys(used))
    stats['devices'] = used
    no_fiction = politics or (fic is not None and fic.get('allowed') is False)
    if no_fiction and set(used) & FICTION_DEVICES:
        fails.append(f'⑥ {"정치 레인" if politics else "fiction.allowed=false"} 허구형 장치 {"·".join(sorted(set(used) & FICTION_DEVICES))} — 사실형(훅 질문·궁금증 연쇄·감정 꼬리 등)만')
    if len(used) < MIN_DEVICES:
        msg = f'⑥ 장치 {len(used)}개(<{MIN_DEVICES}) — story.devices{{문장 번호: 장치}}에 12종 중 5개 이상(docs/longshort-reset-20261019.md §9)'
        (fails if enforce else warns).append(msg)
    if unknown:
        warns.append(f'⑥ 목록 밖 장치 이름 {"·".join(unknown[:3])}')
    if badidx:
        warns.append(f'⑥ 없는 문장 번호 {"·".join(badidx[:3])}')
    verdict = 'FAIL' if fails else 'WARN' if warns else 'PASS'
    return {'verdict': verdict, 'fails': fails, 'warns': warns, 'stats': stats}


def _load(arg):
    sid = None
    p = arg
    m = re.match(r'^(.*\.json):([^\\/:]+)$', arg)
    if m:
        p, sid = m.group(1), m.group(2)
    p = Path(p)
    if p.is_dir():
        p = next((p / n for n in ('plan.json', 'spec.json', 'plan_local.json') if (p / n).exists()), p / 'plan.json')
    data = json.loads(p.read_text(encoding='utf-8'))
    if sid:
        items = data.get('shorts') or data.get('items') or []
        hit = next((x for x in items if str(x.get('id')) == sid), None)
        if hit is None:
            raise ValueError(f'id {sid} 없음')
        merged = {k: v for k, v in data.items() if k not in ('shorts', 'items')}
        merged.update(hit)
        if 'beats' in hit and not any(f in hit for f in FIELDS):
            merged['lines'] = [b for b in hit['beats'] if _text(b)]
        return merged, p
    return data, p


def check(arg, field=None, lane='', lang='ko', now=None, enforce=None):
    now = now or _dt.datetime.now(_dt.timezone.utc)
    enforce = (now >= ENFORCE_FROM) if enforce is None else enforce
    try:
        plan, p = _load(arg)
        lane = lane or plan.get('lane') or ('politics' if 'politics' in str(p).replace('\\', '/').lower() else '')
        f, sents = sentences_of(plan, field)
        if not sents:
            raise ValueError(f'원고 문장 없음(--field {field or "/".join(FIELDS)})')
        r = judge(plan, sents, lane=lane, lang=lang, enforce=enforce)
        r.update(field=f, lane=lane, code=4 if r['verdict'] == 'FAIL' else 0)
    except (OSError, ValueError, AttributeError, TypeError, json.JSONDecodeError) as e:
        r = {'verdict': 'ERROR', 'code': 5, 'error': f'검사 불가: {e}', 'fails': [], 'warns': []}
    r.update(path=str(arg), enforced=enforce, exit=r['code'] if enforce else 0)
    return r


def line(r):
    if r['code'] == 5:
        return f'[관문] story: 검사 불가 · {r["error"]} · {r["path"]}'
    pre = '' if r['enforced'] or r['verdict'] != 'FAIL' else '[유예 ~10-23] '
    why = ' / '.join(r['fails'] + r['warns']) or f'구조·매핑·전환 통과({r["stats"]["n"]}문장, 묘사형 {r["stats"]["descriptive"]})'
    return f'[관문] {pre}story: {r["verdict"]} · {why} · {r["path"]}'


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = list(sys.argv[1:] if argv is None else argv)
    vals = ('--field', '--lane', '--lang')
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    args = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] not in vals)]
    if not args:
        print(__doc__)
        return 5
    r = check(args[0], opt('--field'), opt('--lane') or '', opt('--lang') or 'ko', enforce=True if '--enforce-now' in argv else None)
    if r['code'] == 5:
        try:
            LEDGER.parent.mkdir(parents=True, exist_ok=True)
            with LEDGER.open('a', encoding='utf-8') as fh:
                fh.write(json.dumps({'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'story_gate', 'script': args[0], 'error': r['error']}, ensure_ascii=False) + '\n')
        except OSError as e:
            print(f'⚠ 장부 기록 실패: {e}')
    print(json.dumps(r, ensure_ascii=False) if '--json' in argv else line(r))
    return r['exit']


if __name__ == '__main__':
    sys.exit(main())
