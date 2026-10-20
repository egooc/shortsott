# -*- coding: utf-8 -*-
"""원고 검수표 — 공용, 경고형(10-20 관리자: 소유주 «대본 피드백이 들어갔나» 보강, 카이안 K3·K7 + 하늘구름땅바람 문장 리듬·열린 결말).

    python scripts/script_audit.py <원고 | 편 폴더> [--lane corp_ko|nenkin_ja|politics_ko|politics_ja|rinbox|longshort|fantube|shopping|n100]
                                   [--kind long|shorts] [--lang ko|ja] [--jargon 사전.json] [--names 고유명사.json] [--json out]

재는 것(한 표):
  분량      해설 문장 수·추정 길이(ko 7자/초·ja 7.5자/초, 원음 구간은 실제 길이)
  K7 밀도   분당 전문용어(사전 낱말) · 분당 고유명사(사전 + «~씨·대표·의원·회장…» 앞 낱말·영문/숫자 낱말·ja 가타카나 4자+)
  K3 첫 문장 인사·채널명·«오늘은 ~에 대해» 로 시작하면 △
  리듬      문장 길이(공백 뺀 글자) 평균·표준편차·변동계수(CV) — CV < 0.30 이면 △(고른 길이 = 기계 티)
  질문      첫 질문 문장 시각 — 롱폼 15초·쇼츠 3초 넘으면 △
  원음      첫 원음(인용·클립·대사) 시각 — 정치 롱폼 40초 넘으면 △(정치 첫 70초 규칙), 원음 없는 레인은 «-»
  전환      전환 문구(그런데·문제는·하지만·그래서·그 결과…) 위치·최대 간격 — 롱폼 120초 넘게 비면 △
  끝맺음    마지막 3문장 유형(질문·열린 결말 «~일 듯·~됐다고·~아님?»·단정·안내) — 쇼츠는 열린 결말/질문 없으면 △
종료 코드: 0(경고만) · 4 = FAIL(쇼츠 모드 V1 첫 문장 설명형) · 5 = 검사 불가(원고를 못 읽음, server/data/gate_errors.jsonl).
쇼츠 모드(--shorts 또는 쇼츠 레인 자동, devo 칼럼 10-20): V1 첫 문장 설명형 FAIL · V2 긴장 단계 감정 평가 어휘 · V3 엔딩 평가·요약 · V4 문장 평균 25자 초과(WARN).
공통: V14 끝 어미 상위 1종 > 60% · 롱폼 V12 질문 간격 > 120초(WARN). 낱말표·임계는 config/script_audit.json.
enforce_from(V12·V14 = 2026-10-21 00:00 KST) 전이거나 --ignore V12,V14 면 그 항목은 notices(ℹ, 막지 않음)로만 — warnings 에 안 들어간다.
어댑터: txt(«## 장»·«@화면»·«#» 주석 건너뜀 — 기업·연금) · 정치 ko episode.json(nar text + quote/cold in~out) 또는 script_N.py ·
        린박스 plan_local.json(sequence 순서, 클립 = 원음) · 그 밖의 쇼츠는 comment_hook 어댑터(spec·plan·자막).
import: from script_audit import audit  →  audit(path, lane=None, ...) → dict
"""
import datetime as _dt
import json
import re
import statistics as st
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import comment_hook  # noqa: E402
import ref_overlap  # noqa: E402

LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
CONFIG = ROOT / 'config' / 'script_audit.json'   # devo 칼럼 V1~V4·V12·V14 낱말표·임계
LONG_LANES = {'corp_ko', 'nenkin_ja', 'politics_ko', 'politics_ja'}
JA_LANES = {'nenkin_ja', 'politics_ja', 'rinbox'}
CPS = {'ko': 7.0, 'ja': 7.5}
JARGON = {'politics_ko': ROOT / 'politics-hour' / 'jargon.json', 'corp_ko': ROOT / 'ko-corp' / 'jargon.json'}
NAMES = {'politics_ko': ROOT / 'politics-hour' / 'names_ko.json'}
GREETING = {'ko': r'^(안녕하세요|여러분 안녕|반갑습니다|오늘은 .{0,20}(에 대해|알아보|이야기)|이번 영상|구독)',
            'ja': r'^(こんにちは|皆さんこんにちは|こんばんは|今日は.{0,20}(について|紹介)|今回の動画|チャンネル登録)'}
QUESTION = {  # 참고용(판정은 comment_hook.is_question — 10-20 «거품이 나요» 오판 수정)
    'ko': r'[?？]\s*$|(까요?|나요|가요|습니까|죠)\s*[.。]?\s*$', 'ja': r'[?？]\s*$|(か|でしょうか|ますか)\s*[。.]?\s*$'}
TRANSITION = {'ko': r'^(그런데|근데|문제는|하지만|그러나|그래서|그 결과|결국|반전은|여기서|그러자|그런데도|그렇다면|이때)',
              'ja': r'^(ところが|しかし|でも|問題は|そこで|その結果|結局|実は|では|すると)'}
OPEN_END = {  # 참고용 — 쇼츠 끝맺음 판정은 comment_hook.open_ask(동의·반박 청하는 꼴만, 10-20)
    'ko': r'(일 듯|일지도|됐다고|했다고|아님\?|라던데|모를 일|두고 볼)', 'ja': r'(かも|らしい|だとか|どうなる)'}
GUIDE_END = {'ko': r'(구독|좋아요|댓글|알림|다음 영상|링크)', 'ja': r'(チャンネル登録|高評価|コメント|次の動画)'}
TITLE_SUFFIX = r'(씨|대표|의원|장관|총리|대통령|회장|사장|위원장|교수|기자|변호사|검사|판사|후보)'


def _load_json(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8')) if p and Path(p).exists() else {}
    except (OSError, ValueError):
        return {}


def _est(text, lang):
    return len(re.sub(r'\s', '', text)) / CPS[lang]


def segments(path, lane=None):
    """→ [('nar'|'audio', 문장 또는 '', 초)] 화면 순서. 해설은 문장 단위로 쪼갠다."""
    p = Path(path)
    lang = 'ja' if lane in JA_LANES else 'ko'
    out = []

    def nar(text):
        text = re.sub(r'\s+/\s+', ' ', text)   # 자막 카드 구분자 « / »(롱투숏 plan.json)는 한 문장 안이다
        for s in ref_overlap.split_sentences(text):
            out.append(('nar', s, _est(s, lang)))

    ep = p / 'episode.json' if p.is_dir() else p
    if ep.name == 'episode.json' and ep.exists():                     # 정치 ko 빌드 결과
        for s in _load_json(ep).get('segments', []):
            if s.get('type') == 'nar' and s.get('text'):
                nar(s['text'])
            elif s.get('type') in ('quote', 'cold') and s.get('out') is not None:
                out.append(('audio', '', max(0.0, float(s['out']) - float(s['in']))))
        return out
    plan = p / 'plan_local.json' if p.is_dir() else p
    if plan.name == 'plan_local.json' and plan.exists():             # 린박스
        d = _load_json(plan)
        cards = {n.get('id'): n.get('cards', []) for n in d.get('narration', [])}
        for s in d.get('sequence', []):
            if 'narration' in s:
                nar(' '.join(cards.get(s['narration'], [])))
            elif s.get('source_out') is not None:
                out.append(('audio', '', float(s['source_out']) - float(s['source_in'])))
        return out
    seg_plan = (p if p.is_dir() else p.parent) / 'plan.json'
    if lane == 'shopping' and seg_plan.exists():   # 쇼핑 원고(script.txt)는 마침표가 없다 → plan.json segments 가 문장 경계(10-20 관리자)
        for seg in _load_json(seg_plan).get('segments', []):
            nar(str(seg.get('text', '')))
        return out
    if p.suffix == '.txt' or (p.is_dir() and (p / 'script.txt').exists()):   # 기업·연금
        f = p / 'script.txt' if p.is_dir() else p
        lines = [l.strip() for l in f.read_text(encoding='utf-8').splitlines()]
        block = []   # «## 장» 이름표는 장 경계 표시('chap')로 남긴다 — V12 장 끝 질문 검사용(기업 10-20)
        for l in lines:
            if l.startswith('## '):
                for s in join_cards(block):
                    nar(s)
                block = []
                out.append(('chap', l[3:].strip(), 0.0))
            elif l and not l.startswith(('#', '@')):
                block.append(l)
        for s in join_cards(block):
            nar(s)
        return out
    if p.suffix == '.py' or (p.is_dir() and list(p.glob('script_*.py'))):   # 정치 ko 원고(빌드 전) — 인용 길이는 모름
        for f in ([p] if p.suffix == '.py' else sorted(p.glob('script_*.py'))):
            for t in comment_hook._py_narration(f):
                nar(t)
        return out
    _, _, body, _, _ = comment_hook.load(p, lane)                     # 쇼츠 spec·plan·자막
    for s in join_cards(body):
        nar(s)
    return out


def join_cards(lines):
    """한 줄 = 자막 카드인 원고(롱투숏 cap.ass·script.txt)는 문장 끝(부호·«다/요/까/죠»)까지 이어 붙인다. 문장 단위 원고는 그대로."""
    out, buf = [], ''
    for line in lines:
        buf = f'{buf} {str(line).strip()}'.strip()
        if re.search(r'[.?!。？！…」』]$|[다요까죠]$', buf):
            out.append(buf)
            buf = ''
    return out + ([buf] if buf else [])


def _names(sent, names, lang):
    found = [n for n in names if n in sent]
    if lang == 'ko':
        found += re.findall(rf'([가-힣]{{2,4}})\s?{TITLE_SUFFIX}', sent)
        found += re.findall(r'\b[A-Z][A-Za-z]{1,}\b|\b[A-Z]{2,}\b', sent)
    else:
        found += re.findall(r'[ァ-ヶー]{4,}', sent)
    return list(dict.fromkeys(found))


def audit(path, lane=None, kind=None, lang=None, jargon=None, names=None, ignore=None):
    kind = kind or ('long' if lane in LONG_LANES else 'shorts')
    lang = lang or ('ja' if lane in JA_LANES else 'ko')
    res = {'path': str(path), 'lane': lane, 'kind': kind, 'lang': lang, 'warnings': [], 'error': None}
    try:
        segs = segments(path, lane)
    except (OSError, ValueError, KeyError, SyntaxError) as e:
        res['error'] = f'원고를 못 읽음: {e}'
        return res
    sents = [(i, s) for i, (k, s, _) in enumerate(segs) if k == 'nar']
    if not sents:
        res['error'] = '해설 문장 0(형식을 못 읽음)'
        return res
    jargon = jargon if jargon is not None else _load_json(JARGON.get(lane))
    jw = [w for w in jargon if not w.startswith('_')]
    nw = [w for w in (names if names is not None else _load_json(NAMES.get(lane))) if not w.startswith('_')]
    at, t = [], 0.0
    for k, s, d in segs:
        at.append(t)
        t += d
    total = t
    mins = max(total / 60, 1e-6)
    W = res['warnings']
    # K7 밀도
    jcount = sum(1 for _, s in sents for w in jw if w in s and not any(w != x and w in x and x in s for x in jw))
    ncount = sum(len(_names(s, nw, lang)) for _, s in sents)
    res['density'] = {'jargon_per_min': round(jcount / mins, 2), 'names_per_min': round(ncount / mins, 2), 'jargon': jcount, 'names': ncount}
    # K3 첫 문장
    first = sents[0][1]
    res['first_sentence'] = first
    if re.search(GREETING[lang], first):
        W.append(('K3 첫 문장', f'인사·채널명·주제 예고로 시작 «{first[:30]}» — 첫 문장은 사건·질문으로'))
    # 리듬
    lens = [len(re.sub(r'\s', '', s)) for _, s in sents]
    mean = st.mean(lens)
    sd = st.pstdev(lens) if len(lens) > 1 else 0.0
    cv = sd / mean if mean else 0.0
    res['rhythm'] = {'sentences': len(lens), 'mean': round(mean, 1), 'sd': round(sd, 1), 'cv': round(cv, 2)}
    if len(lens) >= 5 and cv < 0.30:
        W.append(('리듬', f'문장 길이 CV {cv:.2f} < 0.30 — 길이가 고르다(기계 티), 짧은 문장·긴 문장을 섞어라'))
    # 첫 질문
    q = next((at[i] for i, s in sents if comment_hook.is_question(s, lang)), None)
    res['first_question_sec'] = None if q is None else round(q, 1)
    lim_q = 15 if kind == 'long' else 3
    if q is None or q > lim_q:
        W.append(('질문', f'첫 질문 {"없음" if q is None else f"{q:.0f}초"} — {lim_q}초 안에'))
    # 첫 원음
    a = next((at[i] for i, (k, _, _) in enumerate(segs) if k == 'audio'), None)
    res['first_audio_sec'] = None if a is None else round(a, 1)
    if lane in ('politics_ko', 'politics_ja') and (a is None or a > 40):
        W.append(('원음', f'첫 원음 {"없음" if a is None else f"{a:.0f}초"} — 정치 롱폼은 40초 안에'))
    # 전환 간격
    tr = [at[i] for i, s in sents if re.search(TRANSITION[lang], s)]
    gaps = [b - a_ for a_, b in zip([0.0] + tr, tr + [total])]
    res['transitions'] = {'count': len(tr), 'max_gap_sec': round(max(gaps), 1) if gaps else None, 'per_min': round(len(tr) / mins, 2)}
    if kind == 'long' and gaps and max(gaps) > 120:
        W.append(('전환', f'전환 문구 없이 {max(gaps):.0f}초 — 120초 안에 «그런데·문제는» 류로 다시 붙잡아라'))
    # 끝맺음
    all_s = [s for _, s in sents]
    tail = all_s[-3:]
    kinds = []
    for j, s in enumerate(tail):
        k = len(all_s) - len(tail) + j
        kinds += (['질문'] if comment_hook.is_question(s, lang) and not comment_hook.self_answered(all_s, k) else []) + (['열린 결말'] if comment_hook.open_ask(s) else []) + \
                 (['안내'] if re.search(GUIDE_END[lang], s) else [])
    res['ending'] = {'tail': tail, 'kinds': sorted(set(kinds)) or ['단정']}
    if kind == 'shorts' and not {'질문', '열린 결말'} & set(kinds):
        W.append(('끝맺음', '쇼츠 끝 3문장에 질문·열린 결말(~일 듯·~됐다고·~아님?)이 없음'))
    # ── devo 칼럼(10-20) ──────────────────────────────────────────
    C = _load_json(CONFIG).get(lang, {})
    CF = _load_json(CONFIG)
    F = []   # FAIL(종료 4) — 쇼츠 첫 문장 설명형만
    if kind == 'shorts':
        # V1 첫 문장 설명형 금지
        hit = [w for w in C.get('v1_starts', []) if first.startswith(w) or (w.startswith('에 ') and w in first[:30])] + \
              [w for w in C.get('v1_ends', []) if re.search(re.escape(w) + r'\s*[.。!?？]?$', first)]
        if hit:
            F.append(('V1 첫 문장', f'설명형 «{first[:30]}» ({"·".join(hit)}) — 행동 묘사·의외성·궁금증 중 하나로'))
        # V2 긴장 단계(첫 문장·끝 2문장 뺀 가운데) 감정 평가 어휘
        mid = [s for _, s in sents[1:-2]] if len(sents) > 3 else []
        emo = sorted({w for s in mid for w in C.get('v2_emotion', []) if w in s})
        if emo:
            W.append(('V2 감정 평가', f'긴장 단계에 감정 평가 «{"·".join(emo)}» — 행동·사실로(«그 자리에서 움직이지 않았습니다»)'))
        # V3 엔딩 나레이터 평가·요약
        last = sents[-1][1]
        if any(re.search(rx, last) for rx in C.get('v3_evaluate', [])):
            W.append(('V3 엔딩 평가', f'끝 문장이 평가·요약 «{last[:30]}» — 감정 한 문장 또는 «하지만» 여운으로'))
        # V4 쇼츠 문장 평균 길이
        if mean > CF.get('shorts_mean_max', 25):
            W.append(('V4 문장 길이', f'쇼츠 문장 평균 {mean:.1f}자 > {CF.get("shorts_mean_max", 25)}자 — 한 문장 한 사건'))
    # V14 끝 어미 다양성(롱폼·쇼츠)
    ends = [_ending(s, lang) for _, s in sents]
    ends = [e for e in ends if e]
    if len(ends) >= 5:
        top, n = max(((e, ends.count(e)) for e in set(ends)), key=lambda x: x[1])
        res['ending_top'] = {'ending': top, 'share': round(n / len(ends), 2)}
        if n / len(ends) > CF.get('ending_top_max', 0.6):
            W.append(('V14 끝 어미', f'«~{top}» 이 {n / len(ends):.0%} — 어미를 섞어라(~요/~다/~죠/질문)'))
    # V12 롱폼 질문 간격
    if kind == 'long':
        qs = [at[i] for i, s in sents if comment_hook.is_question(s, lang)]
        qgaps = [b - a for a, b in zip([0.0] + qs, qs + [total])]
        res['question_gap_max_sec'] = round(max(qgaps), 1) if qgaps else None
        lim = CF.get('long_question_gap_max', 120)
        if qgaps and max(qgaps) > lim:
            W.append(('V12 질문 간격', f'질문 없이 {max(qgaps):.0f}초 — {lim}초 안에 다음 궁금증을(장마다 다음 질문)'))
        # 장(##)마다 끝 문장이 질문인지(마지막 장 제외) — 기업 10-20 요청
        chaps, cur, last_nar = [], None, None
        for k, s, _ in segs:
            if k == 'chap':
                if cur is not None:
                    chaps.append((cur, last_nar))
                cur, last_nar = s, None
            elif k == 'nar':
                last_nar = s
        if len(chaps) >= 1:
            noq = [c for c, ln in chaps if ln and not comment_hook.is_question(ln, lang)]
            res['chapter_end_questions'] = {'chapters': len(chaps) + 1, 'not_question': noq}
            if noq:
                W.append(('V12 장 끝 질문', f'장 끝 문장이 질문이 아닌 장 {len(noq)}/{len(chaps)}개({", ".join(noq[:6])}) — 장마다 다음 궁금증으로 끝내라'))
    res['duration_sec'] = round(total, 1)
    # enforce_from(날짜 전) · ignore(호출자 지정) 코드는 막는 경고가 아니라 알림(notices)으로
    now = _dt.datetime.now().astimezone()
    late = {k for k, v in CF.get('enforce_from', {}).items() if now < _dt.datetime.fromisoformat(v)}
    soft = late | set(ignore or ())
    res['notices'] = [{'code': c, 'msg': m + (' (적용 전 — 알림만)' if c.split()[0] in late else ' (무시 지정)')} for c, m in W if c.split()[0] in soft]
    W = [(c, m) for c, m in W if c.split()[0] not in soft]
    res['warnings'] = [{'code': c, 'msg': m} for c, m in W]
    res['fails'] = [{'code': c, 'msg': m} for c, m in F]
    return res


def _ending(s, lang):
    """문장 끝 어미 묶음 — ko: 습니다/어요·아요/죠/다/까 …, ja: です/ます/でした/た/ね …"""
    s = re.sub(r'[\s.。!！?？…"”」』)]+$', '', s)
    if not s:
        return None
    if lang == 'ja':
        for e in ('ました', 'でした', 'ません', 'です', 'ます', 'だった', 'ない', 'ね', 'よ', 'か', 'た', 'る'):
            if s.endswith(e):
                return e
        return s[-1]
    for e in ('습니까', '니까', '습니다', '니다', '세요', '까요', '죠', '거든요', '어요', '아요', '여요', '에요', '예요', '요', '다', '까', '네', '지'):
        if s.endswith(e):
            if e in ('습니다', '니다'):
                return '니다'          # ~습니다·~입니다·~ㅂ니다 는 한 계열(기업 실측 «~니다 계열 92%»)
            if e in ('습니까', '니까'):
                return '니까'
            return '요' if e in ('어요', '아요', '여요', '에요', '예요') else e
    return s[-1]


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    lane = opt('--lane')
    kind = 'shorts' if '--shorts' in argv else opt('--kind')
    ignore = [x.strip() for x in (opt('--ignore') or '').split(',') if x.strip()]
    res = audit(argv[0], lane, kind, opt('--lang'),
                _load_json(opt('--jargon')) if opt('--jargon') else None, _load_json(opt('--names')) if opt('--names') else None, ignore)
    if opt('--json'):
        Path(opt('--json')).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if res['error']:
        print(f'⚠ 원고 검수 불가: {res["error"]} — 통과로 치지 않음(종료 5) · {argv[0]}')
        try:
            LEDGER.parent.mkdir(parents=True, exist_ok=True)
            with LEDGER.open('a', encoding='utf-8') as fh:
                fh.write(json.dumps({'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'script_audit',
                                     'lane': lane, 'script': argv[0], 'error': res['error']}, ensure_ascii=False) + '\n')
        except OSError as e:
            print(f'⚠ 장부 기록 실패: {e}')
        return 5
    d, r, tr = res['density'], res['rhythm'], res['transitions']
    fa = '-' if res['first_audio_sec'] is None else f'{res["first_audio_sec"]:.0f}초'
    fq = '없음' if res['first_question_sec'] is None else f'{res["first_question_sec"]:.0f}초'
    print(f'원고 검수표 — {argv[0]} ({lane or "-"}/{res["kind"]}/{res["lang"]})')
    print(f'  분량      해설 {r["sentences"]}문장 · 추정 {res["duration_sec"] / 60:.1f}분')
    print(f'  K7 밀도   전문용어 {d["jargon_per_min"]}/분({d["jargon"]}) · 고유명사 {d["names_per_min"]}/분({d["names"]})')
    print(f'  K3 첫 문장 «{res["first_sentence"][:40]}»')
    print(f'  리듬      평균 {r["mean"]}자 · 표준편차 {r["sd"]} · CV {r["cv"]}')
    print(f'  질문/원음 첫 질문 {fq} · 첫 원음 {fa}')
    print(f'  전환      {tr["count"]}회({tr["per_min"]}/분) · 최대 간격 {tr["max_gap_sec"]}초')
    print(f'  끝맺음    {"·".join(res["ending"]["kinds"])} — {" / ".join(s[:24] for s in res["ending"]["tail"])}')
    if res.get('ending_top'):
        print(f'  끝 어미   최다 «~{res["ending_top"]["ending"]}» {res["ending_top"]["share"]:.0%}' +
              (f' · 질문 최대 간격 {res["question_gap_max_sec"]}초' if res.get('question_gap_max_sec') is not None else ''))
    for f in res.get('fails', []):
        print(f'  ✗ [{f["code"]}] {f["msg"]}')
    for w in res['warnings']:
        print(f'  △ [{w["code"]}] {w["msg"]}')
    for w in res.get('notices', []):
        print(f'  ℹ [{w["code"]}] {w["msg"]}')
    if res.get('fails'):
        print(f'FAIL {len(res["fails"])}건 · 경고 {len(res["warnings"])}건 — 종료 4')
        return 4
    print(f'경고 {len(res["warnings"])}건 — 경고형, 막지 않음' if res['warnings'] else '경고 0건')
    return 0


if __name__ == '__main__':
    sys.exit(main())
