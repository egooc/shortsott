# -*- coding: utf-8 -*-
"""댓글 장치 관문 — 공용(10-20 소유주 질책 «댓글 반응을 노리는 원고를 쓰기로 했는데 반영이 안 됐다», 관리자 명세).

    python scripts/comment_hook.py <원고 또는 폴더> [--lane shopping|rinbox|politics_shorts|longshort|fantube|n100|generic]
                                    [--spec 메타.json] [--script 본문 파일 ...] [--channel ko_event] [--json out]

검사(전부 통과해야 0):
  ① expected_comment = {type, line, at_sec} 객체 필수. type ∈ 정정·경험담·훈수·공감·논쟁·위험성 경고(전 레인 통일, 10-20 · 위험성 경고 10-21 G19). 선택 필드 form ∈ 질문·단정·훈수 유도·경험담 요청.
     린박스 옛 type «질문·단정» 은 10-21 00:00 KST 까지 경고(△)로만 받고 그 뒤 FAIL.
     «논쟁/훈수» 처럼 둘을 적으면 앞의 것으로 보되 둘 다 목록 안이어야 한다. 문자열 메모만 있으면 FAIL.
  ② line 이 원고 본문(해설·자막) 또는 고정 댓글 문구(pinned_comment·comment_question)에 실제로 있어야 한다(공백·부호 무시).
  ③ 끝 3문장에 아래 중 하나: 질문(?·까·죠·나요…) · 반박 가능한 단정(무조건·절대·정답·최고… 또는 line 이 끝 3문장 안 + type 정정/논쟁)
     · 경험담 요청(«이런 적»·«해 보신 분»·«댓글로»…). 본문이 없는 레인(정치 쇼츠 = 발췌 원음)은 고정 댓글 끝 3문장으로 본다.
  ④ 채널 반응 유형(10-23 소유주·관리자): --channel <key>(또는 spec 의 channel_types) 가 있으면 server/data/comment_types/<key>.json
     (comment_mine --channel-types)을 읽어 expected_comment.type 에 그 채널 유형 이름도 받는다. 원고에 채널 상위 3유형 중 2개 이상을
     부르는 줄이 있어야 한다 — spec 의 comment_calls: [{type, line}] (expected_comment 자신도 한 줄로 셈), line 은 본문·고정 댓글에 실제로.
     표가 server/data 에 없으면 docs/comment_types/<key>.json(저장소 추적 사본)을 읽고, 둘 다 없으면 검사 불가(5). ENFORCE_TYPES_FROM(10-24 00:00 KST) 전에는 ④ 실패가 경고(△)만.
종료 코드: 0 통과 · 4 FAIL · 5 검사 불가(입력을 못 읽음·본문과 고정 댓글이 둘 다 없음) — 통과 아님, server/data/gate_errors.jsonl 에 남김.

레인 어댑터(--lane 생략 시 파일 이름으로 짐작):
  shopping        메타 json(expected_comment·comment_question·file) + file 옆 plan.json segments[].text
  rinbox          plan_local.json(expected_comment) — narration[].cards + sequence[].captions(«a|b» 면 뒤쪽)
  politics_shorts *.upload.json(expected_comment·pinned_comment) — 본문 없음
  fantube         volcano-runs/fantube/<ep>/spec.json — voice[].text(본문 순서) + caps[].text, 위 제목 top.l1·l2 는 ② 위치로만
  longshort·n100·generic
                  spec(json, expected_comment 가 든 파일) + 본문(--script 또는 같은 폴더 script.txt·*.srt·cap.ass·plan*.json 의 text·cards·captions)
import: from comment_hook import check  →  check(path, lane=None, spec=None, scripts=None) → dict(ok, code, errors, ...)
"""
import datetime as _dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
TYPES = ['정정', '경험담', '훈수', '공감', '논쟁', '위험성 경고']   # 위험성 경고 = «이거 하면 큰일 나요» 류 댓글 유도(10-21 자료 점검 G19)
FORMS = ['질문', '단정', '훈수 유도', '경험담 요청']   # 선택 필드 expected_comment.form — 장치 문장의 모양(관리자 10-20 결정)
LEGACY_FORM_TYPES = {'질문': '질문', '단정': '단정'}      # 린박스 옛 type → form. 10-21 00:00 KST 까지만 경고로 받는다
LEGACY_UNTIL = _dt.datetime(2026, 10, 21, 0, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))
TEXT_KEYS = {'text', 'cards', 'captions', 'narration', 'segments', 'sequence', 'lines', 'cues', 'script'}
PINNED_KEYS = ('pinned_comment', 'comment_question')
CHANNEL_TYPES_DIR = ROOT / 'server' / 'data' / 'comment_types'
CHANNEL_TYPES_DOCS = ROOT / 'docs' / 'comment_types'   # server/data 는 gitignore — 다른 PC 는 저장소의 docs 쪽을 읽는다(10-23)
ENFORCE_TYPES_FROM = _dt.datetime(2026, 10, 24, 0, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))


def channel_types(key):
    """comment_mine --channel-types 표 → dict(types, top3) 또는 None."""
    f = next((d / f'{key}.json' for d in (CHANNEL_TYPES_DIR, CHANNEL_TYPES_DOCS) if (d / f'{key}.json').exists()), None)
    if f is None:
        return None
    d = json.loads(f.read_text(encoding='utf-8'))
    return d if d.get('types') else None

_SQ = re.compile(r'[\s、。，,.「」『』“”‘’"\'？?！!・…~\-–—()（）\[\]<>《》«»:：;；/]')
_SPLIT = re.compile(r'(?<=[。？！?!.])\s*|\n+')
# 질문 판정(10-20 쇼핑 실측 «거품이 나요» 오판 수정): 물음표면 질문. ko 는 «습니까·까요·ㄹ까» 처럼 그 자체가 묻는 어미면 질문,
# «나요·죠·가요·래요·는데요» 처럼 평서로도 쓰이는 어미는 의문사(왜·뭐·어떻게·언제·누가…)가 같이 있을 때만, 마침표로 끝나면 평서로 본다.
_Q_MARK = re.compile(r'[?？]\s*[」』"”)]*\s*$')
_KO_ASK = re.compile(r'(습니까|ㅂ니까|을까요?|ㄹ까요?|일까요?|까요|겠어요|어때요|건가요)\s*[…]*$')
_KO_SOFT = re.compile(r'(나요|죠|가요|래요|는데요|니까)\s*[…]*$')
_KO_WH = re.compile(r'(왜|뭐|무엇|무슨|어떻게|언제|누가|누구|어디)')   # «몇 장·얼마나·어떤» 은 평서에 흔해 뺀다(«몇 장 뽑던 손이 … 끝나요» 오판)
_JA_ASK = re.compile(r'(か|かな|でしょうか|ませんか|ですか)\s*[。.…]*\s*[」』]*\s*$')


def is_question(s, lang=None):
    s = str(s or '').strip()
    if _Q_MARK.search(s):
        return True
    if lang != 'ko' and _JA_ASK.search(s):
        return True
    if lang == 'ja':
        return False
    s2 = re.sub(r'[.。]\s*$', '', s)
    if _KO_ASK.search(s2):                   # «…있을까요.» 처럼 마침표를 찍어도 묻는 어미면 질문(정치 첫 문장)
        return True
    if s2 != s:                              # «거품이 나요.» — 평서로도 쓰이는 어미 + 마침표 = 평서
        return False
    return bool(_KO_SOFT.search(s) and _KO_WH.search(s))


# 자문자답(10-20 관리자 결정): 질문 바로 다음 문장이 그 답이면 댓글 장치가 아니다 — 끝맺음(③)에서 뺀다.
# 질문이 «~냐고요? ~는요? ~라고요?» 같은 되묻기 꼴이거나, 다음 문장이 «네·아니요·바로·답은·비밀은…» 같은 답 표지로 시작하면 자문자답.
# 끝 3문장 중 맨 마지막 질문은 뒤 문장이 없으니 그대로 질문.
_SELF_ECHO = re.compile(r'(냐고요|냐구요|는요|라고요|냐면요|이냐고|ですって|かというと|かって)\s*[?？]')
_ANSWER = re.compile(r'^\s*(네|예|아니요|아뇨|아니에요|맞아요|바로|정답은|답은|이유는|비밀은|사실은|결론은|그건|그 답은|はい|いいえ|実は|答えは|理由は|正解は)')


def self_answered(sents, i):
    if i + 1 >= len(sents) or not is_question(sents[i]):
        return False
    return bool(_SELF_ECHO.search(sents[i]) or _ANSWER.search(sents[i + 1]))


# 열린 결말(10-20 관리자 결정): 시청자에게 동의·반박을 청하는 어미만 장치로 인정(칼럼 S3 «~일 듯·~아님?» 꼴).
# «~일지도 몰라요·~수도 있어요·~듯해요.» 같은 단순 추측(마침표)은 인정하지 않는다. script_audit 쇼츠 끝맺음도 이 판정을 쓴다.
OPEN_ASK = re.compile(r'(아님\s*[?？]?|아닌가요|아닐까요|맞죠\s*[?？]?|맞지\s*[?？]?|[일을할될]\s?듯\s*[?？]?|인\s?듯\s*[?？]|같은데\s*어떠세요|어떠세요|않나요|'
                      r'じゃない\s*[？?]|ですよね\s*[？?]?|でしょ\s*[？?]|よね\s*[？?])\s*[」』"”)]*\s*$')


def open_ask(s):
    s = str(s or '').strip()
    return bool(OPEN_ASK.search(s)) and not re.search(r'(일지도|수도\s?있|듯해요|듯합니다)\s*[.。]?\s*$', s)


class _Q:   # 옛 QUESTION.search(s) 호출 호환
    @staticmethod
    def search(s):
        return is_question(s)


QUESTION = _Q()
ASSERT = re.compile(r'(무조건|절대|100\s*%|백 퍼센트|정답|최고|최악|유일|단언|확실히|틀림없|뿐입니다|밖에 없|이게 맞|이 맞습니다|'
                    r'라고 봅니다|입니다\s*끝|絶対|間違いな|一番|だけです|しかない)')
EXPERIENCE = re.compile(r'(이런 적|그런 적|겪어 보신|겪어보신|해 보신|해보신|경험 있|경험해 보|여러분은|여러분이라면|댓글로|댓글에|알려 주세요|알려주세요|'
                        r'남겨 주세요|남겨주세요|ありませんか|経験|コメント|教えて)')


def squash(s):
    return _SQ.sub('', str(s or ''))


_URL = re.compile(r'https?://\S+')
_LINK_LINE = re.compile(r'(전체 맥락은|동영상 탭|롱폼에서 보세요|프로필 링크|구독|→\s*$)')


def sentences(text, drop_links=False):
    """문장 나누기. drop_links=True(고정 댓글)면 URL 을 지우고 «전체 맥락은 롱폼…» 같은 안내 줄은 뺀다(끝 3문장을 안내 문구가 차지하지 않게)."""
    text = str(text or '')
    if drop_links:
        text = '\n'.join(l for l in text.splitlines() if not _LINK_LINE.search(l))
        text = _URL.sub('', text)
    return [s.strip() for s in _SPLIT.split(text) if s and squash(s)]


def _read_json(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))


# 본문이 아닌 화면 문구 키 — 그 아래 text 는 본문(끝 3문장)에 넣지 않는다(10-20 롱투숏 lx02 v4: hook.text 가 끝 줄로 읽혀 ③ 거짓 통과).
# 팬튜브 spec.top 은 원래 «② 위치로만». 고정 댓글은 ② 위치 판정에만 쓴다.
NON_BODY_KEYS = ('hook', 'title', 'top', 'meta', 'title_spec', 'thumbnail', 'thumb', 'thumb_words', 'packages', 'desc_head', 'description', 'tags')


def _strings(node, key=None, skip=('expected_comment', 'comment_device', *PINNED_KEYS, *NON_BODY_KEYS)):
    """json 안 TEXT_KEYS 아래 문자열을 순서대로(«a|b» 자막은 뒤쪽)."""
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k in skip:
                continue
            out += _strings(v, k, skip)
    elif isinstance(node, list):
        for v in node:
            out += _strings(v, key, skip)
    elif isinstance(node, str) and key in TEXT_KEYS:
        out.append(node.split('|')[-1] if '|' in node else node)
    return out


def _srt_ass_text(p):
    lines = []
    for ln in Path(p).read_text(encoding='utf-8', errors='replace').splitlines():
        if p.suffix == '.ass':
            if ln.startswith('Dialogue:'):
                lines.append(re.sub(r'\{[^}]*\}', '', ln.split(',', 9)[-1]).replace('\\N', ' '))
        elif ln.strip() and not ln.strip().isdigit() and '-->' not in ln:
            lines.append(ln.strip())
    return lines


def body_from(p):
    p = Path(p)
    if p.suffix == '.json':
        return _strings(_read_json(p))
    if p.suffix in ('.srt', '.ass', '.vtt'):
        return _srt_ass_text(p)
    return [l.strip() for l in p.read_text(encoding='utf-8').splitlines() if l.strip() and not l.lstrip().startswith(('#', '@'))]


def rinbox_blocks(d):
    """plan_local 을 sequence(화면) 순서로 펼친다 → [('nar'|'cap', 문장)]. {'narration': id} 칸은 그 해설 카드, 나머지는 대사 자막(«a|b» 면 뒤쪽)."""
    nar = {n.get('id'): n.get('cards', []) for n in d.get('narration', [])}
    out = []
    for s in d.get('sequence', []):
        if 'narration' in s:
            out += [('nar', c) for c in nar.get(s['narration'], [])]
        else:
            out += [('cap', str(c).split('|')[-1]) for c in s.get('captions', [])]
    return out


def rinbox_tail(d):
    """린박스 ③ 은 «마지막 해설 블록의 카드» — 해설이 장치를 맡고 대사는 원음(끝 반응 컷)이라 끝 3문장이 대사일 수 있다(린박스 10-20).
    카드는 한 문장이 두 줄로 나뉘어 있으므로 이어 붙여 본다."""
    last = None
    for s in d.get('sequence', []):
        if 'narration' in s:
            last = s['narration']
    if last is None:
        return None
    cards =next((n.get('cards', []) for n in d.get('narration', []) if n.get('id') == last), [])
    return sentences(' '.join(cards)) if cards else None


def guess_lane(p):
    n = Path(p).name
    if n.endswith('.upload.json'):
        return 'politics_shorts'
    if n == 'plan_local.json' or (Path(p).is_dir() and (Path(p) / 'plan_local.json').exists()):
        return 'rinbox'
    return 'generic'


def load(path, lane=None, spec=None, scripts=None):
    """→ (lane, spec dict, body 문장 목록, pinned 문장 목록, 출처 설명)"""
    p = Path(path)
    lane = lane or guess_lane(p)
    if lane == 'rinbox':
        plan = p / 'plan_local.json' if p.is_dir() else p
        if not plan.exists():
            plan = next((c for c in (p.parent / 'plan_local.json', p.parent.parent / 'plan_local.json') if c.exists()), plan)
        d = _read_json(plan)
        body = rinbox_blocks(d)
        body = [tx for _, tx in body] or [c for n in d.get('narration', []) for c in n.get('cards', [])]
        return lane, d, body, [], str(plan)
    spec_p = Path(spec) if spec else (p if p.suffix == '.json' else next(
        (c for n in ('spec.json', 'meta.json', 'plan.json', 'upload.json') for c in [p / n] if c.exists()), None))
    if spec_p is None:
        raise FileNotFoundError(f'expected_comment 가 든 spec json 을 못 찾음: {p}')
    d = _read_json(spec_p)
    pinned = [s for k in PINNED_KEYS for s in sentences(d.get(k) or '', drop_links=True)]
    ec = d.get('expected_comment')
    if isinstance(ec, dict) and isinstance(ec.get('pinned'), str):   # 롱투숏은 고정 질문을 expected_comment.pinned 에 둔다
        pinned += sentences(ec['pinned'], drop_links=True)
    if lane == 'politics_shorts':
        return lane, d, [], pinned, str(spec_p)
    if lane == 'fantube' and not scripts:   # volcano-runs/fantube/<ep>/spec.json — TTS voice[] 순서가 본문, caps[] 는 화면 자막
        # voice·caps 를 t0 시간순으로 합친다 — 끝 3문장이 «caps 끝 3개»가 되던 일(팬튜브 10-20 실측). 같은 t0 면 voice 먼저.
        timed = [(float(v.get('t0') or 0), 0, v.get('text', '')) for v in d.get('voice', [])] + \
                [(float(c.get('t0') or 0), 1, c.get('text', '')) for c in d.get('caps', [])]
        body = [tx for _, _, tx in sorted(timed, key=lambda x: (x[0], x[1]))]
        top = d.get('top') or {}
        return lane, d, body, pinned + [f"{top.get('l1', '')} {top.get('l2', '')}".strip()], str(spec_p)
    body = []
    if scripts:
        for s in scripts:
            body += body_from(s)
    elif lane == 'shopping' and d.get('file'):
        plan = Path(d['file']).parent / 'plan.json'
        if not plan.is_absolute():
            plan = ROOT / plan
        if plan.exists():
            body = [s.get('text', '') for s in _read_json(plan).get('segments', [])]
    if not body:
        base = p if p.is_dir() else p.parent
        # spec 자체(plan.json segments)가 옛 판 plan_v1.json 보다 먼저 — 10-20 롱투숏 lx02 가 옛 판을 읽어 못 찾던 일
        # 넘겨받은 spec 이 원고 칸(segments·voice·narration)을 가지고 있으면 그게 본문 — 다른 판의 렌더 자막(cap.ass)보다 먼저(lx02 v4 회귀, 10-20)
        own = isinstance(d, dict) and any(d.get(k) for k in ('segments', 'voice', 'narration', 'lines', 'cues'))
        order = [spec_p] if own else []
        for c in order + [base / 'script.txt', base / 'cap.ass', base / '_ff' / 'cap.ass', *sorted(base.glob('*.srt')), spec_p,
                          base / 'plan.json']:
            if c.exists():
                body = _strings(d) if c == spec_p else body_from(c)
                if body:
                    break
    return lane, d, body, pinned, str(spec_p)


def check(path, lane=None, spec=None, scripts=None, channel=None, enforce=None):
    res = {'path': str(path), 'lane': lane, 'ok': False, 'code': 5, 'errors': [], 'ending': None, 'error': None}
    try:
        lane, d, body, pinned, src = load(path, lane, spec, scripts)
    except (OSError, ValueError, KeyError) as e:
        res['error'] = f'입력을 못 읽음: {e}'
        res['errors'] = [f"검사 불가: {res['error']}"]   # 부르는 쪽 게이트 메시지에 이유가 나오게(정치 ko 10-20)
        return res
    res.update(lane=lane, source=src)
    body_s = [s for b in body for s in sentences(b)]
    if not body_s and not pinned:
        res['error'] = '본문·고정 댓글이 둘 다 비었음(형식을 못 읽음)'
        res['errors'] = [f"검사 불가: {res['error']}"]
        return res
    errs = []
    ec = d.get('expected_comment')
    warns = []
    channel = channel or d.get('channel_types') or (ec.get('channel') if isinstance(ec, dict) else None)
    ct = None
    if channel:
        ct = channel_types(channel)
        if ct is None:
            res['error'] = f'채널 반응 유형표 없음: server/data/comment_types/{channel}.json (comment_mine --channel-types {channel})'
            res['errors'] = [f"검사 불가: {res['error']}"]
            return res
        res['channel'] = channel
    allowed = TYPES + ([t['name'] for t in ct['types']] if ct else [])
    if not isinstance(ec, dict):
        errs.append('① expected_comment 가 {type, line, at_sec} 객체가 아님' + (f'(메모 문자열 «{ec}»)' if isinstance(ec, str) else '(없음)'))
        ec = {}
    else:
        parts = [t.strip() for t in re.split(r'[/·,]', str(ec.get('type', ''))) if t.strip()]
        if ct and str(ec.get('type', '')).strip() in allowed:   # 채널 유형 이름엔 «·»가 들어갈 수 있다
            parts = [str(ec.get('type')).strip()]
        legacy = [x for x in parts if x in LEGACY_FORM_TYPES]
        if legacy and _dt.datetime.now(LEGACY_UNTIL.tzinfo) < LEGACY_UNTIL:
            warns.append(f'type «{"·".join(legacy)}» 는 이제 form 값 — type 은 {"·".join(TYPES)} 중 하나로, «{legacy[0]}» 은 form 에(10-21 00:00 부터 FAIL)')
            parts = [x for x in parts if x not in LEGACY_FORM_TYPES] or ['공감']
        if not parts or any(x not in allowed for x in parts):
            errs.append(f'① expected_comment.type «{ec.get("type")}» — {"·".join(allowed)} 중 하나' +
                        (' (질문·단정은 form 필드로)' if legacy else ''))
        if ec.get('form') is not None and ec.get('form') not in FORMS:
            errs.append(f'① expected_comment.form «{ec.get("form")}» — {"·".join(FORMS)} 중 하나(선택 필드)')
        if not squash(ec.get('line')):
            errs.append('① expected_comment.line 비었음 — 원고에 넣은 장치 문장을 그대로')
        try:
            if float(ec.get('at_sec')) < 0:
                raise ValueError
        except (TypeError, ValueError):
            errs.append(f'① expected_comment.at_sec «{ec.get("at_sec")}» — 0 이상 숫자')
    line = squash(ec.get('line'))
    if line:
        where = 'body' if line in squash(''.join(body_s)) else 'pinned' if line in squash(''.join(pinned)) else None
        res['line_in'] = where
        if not where:
            errs.append(f'② 장치 문장 «{ec.get("line")}» 이 본문·자막·고정 댓글 어디에도 없음')
    tail_src = body_s if body_s else pinned
    tail_from = 'body' if body_s else 'pinned'
    if lane == 'rinbox' and rinbox_tail(d):
        tail_src, tail_from = rinbox_tail(d), 'last_narration'
    tail = tail_src[-3:]
    kinds, self_q = [], []
    for j, s in enumerate(tail):
        if is_question(s.rstrip()):
            if self_answered(tail_src, len(tail_src) - len(tail) + j):
                self_q.append(s)
            else:
                kinds.append('질문')
        if open_ask(s):
            kinds.append('열린 결말(동의·반박)')
        if EXPERIENCE.search(s):
            kinds.append('경험담 요청')
        if ASSERT.search(s) or (line and line in squash(s) and (str(ec.get('type', '')).split('/')[0] in ('정정', '논쟁', '단정') or ec.get('form') == '단정')):
            kinds.append('반박 가능한 단정')
    res['ending'] = {'from': tail_from, 'tail': tail, 'kinds': sorted(set(kinds)), 'self_answered': self_q}
    if not kinds:
        errs.append('③ 끝 3문장에 질문·동의/반박 청하는 열린 결말·반박 가능한 단정·경험담 요청이 없음: ' + ' / '.join(tail))
    if ct:
        top3 = ct.get('top3') or [t['name'] for t in ct['types'][:3]]
        calls = [c for c in (d.get('comment_calls') or []) if isinstance(c, dict)]
        if isinstance(ec, dict) and ec.get('type') and ec.get('line'):
            calls = [{'type': ec['type'], 'line': ec['line']}] + calls
        body_sq, pin_sq = squash(''.join(body_s)), squash(''.join(pinned))
        called, missing = [], []
        for c in calls:
            ln = squash(c.get('line'))
            if not ln or (ln not in body_sq and ln not in pin_sq):
                missing.append(f"{c.get('type')}: «{c.get('line')}»")
            elif str(c.get('type', '')).strip() in top3:
                called.append(str(c['type']).strip())
        called = sorted(set(called), key=top3.index)
        res['channel_calls'] = {'top3': top3, 'called': called, 'missing_lines': missing}
        e4 = []
        if missing:
            e4.append('④ comment_calls 줄이 본문·고정 댓글에 없음: ' + ' / '.join(missing))
        if len(called) < 2:
            e4.append(f'④ 채널 상위 3유형({"·".join(top3)}) 중 2개 이상을 부르는 줄이 없음(지금 {len(called)}개: {"·".join(called) or "-"}) '
                      '— spec 에 comment_calls: [{type, line}] 로 원고 문장을 지목')
        now = _dt.datetime.now(ENFORCE_TYPES_FROM.tzinfo)
        if e4 and (enforce is False or (enforce is None and now < ENFORCE_TYPES_FROM)):
            warns += [f'{m} [유예 ~10-24]' for m in e4]
        else:
            errs += e4
    res['errors'] = errs
    res['warnings'] = warns
    res['ok'] = not errs
    res['code'] = 0 if not errs else 4
    return res


def ledger(gate, lane, path, error):
    """공용 게이트 «실패하면 소리 낸다» 장부. 장부 쓰기도 실패하면 화면에 알린다."""
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        rec = {'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': gate, 'lane': lane,
               'script': str(path), 'error': error}
        with LEDGER.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError as e:
        print(f'⚠ 장부 기록 실패: {e}')


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    scripts = [argv[i + 1] for i, a in enumerate(argv) if a == '--script'] or None
    res = check(argv[0], opt('--lane'), opt('--spec'), scripts, channel=opt('--channel'), enforce=True if '--enforce-now' in argv else None)
    if opt('--json'):
        Path(opt('--json')).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    name = Path(argv[0]).name
    if res['code'] == 5:
        print(f'⚠ 댓글 장치 검사 불가: {res["error"]} — 통과로 치지 않음(종료 5) · {name}')
        ledger('comment_hook', res['lane'], argv[0], res['error'])
        return 5
    for wmsg in res.get('warnings') or []:
        print(f'△ {wmsg}')
    if res['errors']:
        print(f'✗ 댓글 장치 FAIL — {name} ({res["lane"]})')
        for e in res['errors']:
            print(f'  - {e}')
        return 4
    print(f'✓ 댓글 장치 통과 — {name} ({res["lane"]}) · 장치 문장 위치 {res.get("line_in")} · 끝맺음 {"·".join(res["ending"]["kinds"])}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
