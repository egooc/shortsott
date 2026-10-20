# -*- coding: utf-8 -*-
"""댓글 장치 관문 — 공용(10-20 소유주 질책 «댓글 반응을 노리는 원고를 쓰기로 했는데 반영이 안 됐다», 관리자 명세).

    python scripts/comment_hook.py <원고 또는 폴더> [--lane shopping|rinbox|politics_shorts|longshort|fantube|n100|generic]
                                    [--spec 메타.json] [--script 본문 파일 ...] [--json out]

검사(전부 통과해야 0):
  ① expected_comment = {type, line, at_sec} 객체 필수. type ∈ 정정·경험담·훈수·공감·논쟁(린박스는 질문·단정도 받음 — 기존 관문 호환).
     «논쟁/훈수» 처럼 둘을 적으면 앞의 것으로 보되 둘 다 목록 안이어야 한다. 문자열 메모만 있으면 FAIL.
  ② line 이 원고 본문(해설·자막) 또는 고정 댓글 문구(pinned_comment·comment_question)에 실제로 있어야 한다(공백·부호 무시).
  ③ 끝 3문장에 아래 중 하나: 질문(?·까·죠·나요…) · 반박 가능한 단정(무조건·절대·정답·최고… 또는 line 이 끝 3문장 안 + type 정정/논쟁)
     · 경험담 요청(«이런 적»·«해 보신 분»·«댓글로»…). 본문이 없는 레인(정치 쇼츠 = 발췌 원음)은 고정 댓글 끝 3문장으로 본다.
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
TYPES = ['정정', '경험담', '훈수', '공감', '논쟁']
LANE_TYPES = {'rinbox': TYPES + ['질문', '단정']}
TEXT_KEYS = {'text', 'cards', 'captions', 'narration', 'segments', 'sequence', 'lines', 'cues', 'script'}
PINNED_KEYS = ('pinned_comment', 'comment_question')

_SQ = re.compile(r'[\s、。，,.「」『』“”‘’"\'？?！!・…~\-–—()（）\[\]<>《》«»:：;；/]')
_SPLIT = re.compile(r'(?<=[。？！?!.])\s*|\n+')
QUESTION = re.compile(r'([?？]|(까|죠|나요|가요|ㄹ까|을까|일까|습니까|ㅂ니까|니까|래요|겠어요|어때요|건가요|는데요)\s*[.。…]*$|'
                      r'(か|かな|でしょう|ませんか|ですか)\s*[。.…]*$)')
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


def _strings(node, key=None, skip=('expected_comment', 'comment_device', *PINNED_KEYS)):
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
        body = [c for n in d.get('narration', []) for c in n.get('cards', [])] + \
               [str(c).split('|')[-1] for s in d.get('sequence', []) for c in s.get('captions', [])]
        return lane, d, body, [], str(plan)
    spec_p = Path(spec) if spec else (p if p.suffix == '.json' else next(
        (c for n in ('spec.json', 'meta.json', 'plan.json', 'upload.json') for c in [p / n] if c.exists()), None))
    if spec_p is None:
        raise FileNotFoundError(f'expected_comment 가 든 spec json 을 못 찾음: {p}')
    d = _read_json(spec_p)
    pinned = [s for k in PINNED_KEYS for s in sentences(d.get(k) or '', drop_links=True)]
    if lane == 'politics_shorts':
        return lane, d, [], pinned, str(spec_p)
    if lane == 'fantube' and not scripts:   # volcano-runs/fantube/<ep>/spec.json — TTS voice[] 순서가 본문, caps[] 는 화면 자막
        body = [v.get('text', '') for v in d.get('voice', [])] + [c.get('text', '') for c in d.get('caps', [])]
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
        for c in [base / 'script.txt', base / 'cap.ass', *sorted(base.glob('*.srt')), *sorted(base.glob('plan*.json'))]:
            if c.exists() and c != spec_p:
                body = body_from(c)
                if body:
                    break
        if not body and spec_p.suffix == '.json':
            body = _strings(d)
    return lane, d, body, pinned, str(spec_p)


def check(path, lane=None, spec=None, scripts=None):
    res = {'path': str(path), 'lane': lane, 'ok': False, 'code': 5, 'errors': [], 'ending': None, 'error': None}
    try:
        lane, d, body, pinned, src = load(path, lane, spec, scripts)
    except (OSError, ValueError, KeyError) as e:
        res['error'] = f'입력을 못 읽음: {e}'
        return res
    res.update(lane=lane, source=src)
    body_s = [s for b in body for s in sentences(b)]
    if not body_s and not pinned:
        res['error'] = '본문·고정 댓글이 둘 다 비었음(형식을 못 읽음)'
        return res
    errs = []
    ec = d.get('expected_comment')
    types = LANE_TYPES.get(lane, TYPES)
    if not isinstance(ec, dict):
        errs.append('① expected_comment 가 {type, line, at_sec} 객체가 아님' + (f'(메모 문자열 «{ec}»)' if isinstance(ec, str) else '(없음)'))
        ec = {}
    else:
        parts = [t.strip() for t in re.split(r'[/·,]', str(ec.get('type', ''))) if t.strip()]
        if not parts or any(t not in types for t in parts):
            errs.append(f'① expected_comment.type «{ec.get("type")}» — {"·".join(types)} 중 하나')
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
    tail = tail_src[-3:]
    kinds = []
    for s in tail:
        if QUESTION.search(s.rstrip()):
            kinds.append('질문')
        if EXPERIENCE.search(s):
            kinds.append('경험담 요청')
        if ASSERT.search(s) or (line and line in squash(s) and str(ec.get('type', '')).split('/')[0] in ('정정', '논쟁', '단정')):
            kinds.append('반박 가능한 단정')
    res['ending'] = {'from': 'body' if body_s else 'pinned', 'tail': tail, 'kinds': sorted(set(kinds))}
    if not kinds:
        errs.append('③ 끝 3문장에 질문·반박 가능한 단정·경험담 요청이 없음: ' + ' / '.join(tail))
    res['errors'] = errs
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
    res = check(argv[0], opt('--lane'), opt('--spec'), scripts)
    if opt('--json'):
        Path(opt('--json')).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    name = Path(argv[0]).name
    if res['code'] == 5:
        print(f'⚠ 댓글 장치 검사 불가: {res["error"]} — 통과로 치지 않음(종료 5) · {name}')
        ledger('comment_hook', res['lane'], argv[0], res['error'])
        return 5
    if res['errors']:
        print(f'✗ 댓글 장치 FAIL — {name} ({res["lane"]})')
        for e in res['errors']:
            print(f'  - {e}')
        return 4
    print(f'✓ 댓글 장치 통과 — {name} ({res["lane"]}) · 장치 문장 위치 {res.get("line_in")} · 끝맺음 {"·".join(res["ending"]["kinds"])}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
