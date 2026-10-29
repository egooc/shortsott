"""정치JA 원고 관문 — 원고 착수 전·TTS 전에 돈다(관리자 10-20 docs/materials-audit-20261020.md 4·6번, ref_overlap).

    python politics-hour-ja/script_gate.py <편 폴더> [--before-script]

① 후보표 = ko politics-hour/candidate_gate.py 를 import(사본 금지): keywords.json "candidates" 행마다
   keyword·rising_score·excerpt(官邸·国会 영상 출처·ID)·emotion_now(Z7 인물의 지금 대리만족 한 문장)·comment_count(Z12 댓글 수, JA 는 Yahoo!ニュース
   기사 댓글 수)·reason. 10/21편(폴더 이름 20261021)부터. 없으면 원고 착수 금지.
② (--before-script 가 아니면) 첫 말 인사 금지: 첫 해설·콜드오픈 문장이 인사·채널명·날짜 낭독이면 FAIL(관리자 §7 70초 규칙).
   + 쟁점 번호 호명(一つ目·論点①·今日の論点は三つ…)·목차·챕터 카드 FAIL(소유주 10-20, 10/21편부터).
③ (--before-script 가 아니면) scripts/ref_overlap.py --lane politics_ja — 해설만(인용 quote·공문 원문 card 제외).
⑤ (--before-script 가 아니면, 10/21편부터) 쇼츠 주고받기 구조 — shorts_struct_errors(소유주 10-20).
④ (--before-script 가 아니면, 10/21편부터) 공용 scripts/script_audit.py(devo V1·V3·V12·V14 등, 관리자 10-20) — JA episode.json·shorts/plan.json 은
   롱폼 audit(<편>) · 쇼츠 audit(<편>/shorts/plan.json:<id>) (도구개발 2a4b577 어댑터). △ 하나라도 FAIL(ko 관문과 같은 기준).
   쇼츠 고정 댓글이 설명형(「今日は·理由は…」)으로 시작해도 FAIL.
종료: 0 통과 · 3 FAIL · ref_overlap 이 4·5 면 그 코드."""
import json, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GREETING = re.compile(r'^(こんにちは|今週の国会、|今日は|本日の|今週は[^。]*お伝え|こんばんは|おはよう|皆さん|みなさん|どうも|ようこそ|今週も|本日も|本日は|今日も|今週の国会[、。です]|国会ノート[、。です]'
                      r'|\d+月\d+日|令和\d+年\d+月)')
FROM = '20261021'
# 쟁점 번호 호명·목차 금지(관리자 전달 소유주 10-20 «채널명 인사하고 쟁점 하나 둘 셋 나열하는 순간 루즈해진다. 첫 쟁점부터 바로»):
# TTS·자막·카드·고정 댓글·설명 첫 두 줄 어디에도 — 쟁점 사이는 내용 전환 문구만. 챕터는 설명란 타임스탬프에만(화면 목차·챕터 카드 금지).
NUMBERING = re.compile(r'(一|二|三|四|五|ひと|ふた|みっ|よっ|[1-5１-５])つ目|論点\s*[①-⑤1-5１-５一二三四五]|[①②③④⑤]|'
                       r'(今日|今週|本日|今回)の(論点|テーマ|ポイント|話題)は|(論点|ポイント|テーマ|話題)は\s*[一二三四五1-5１-５]つ|[一二三四五1-5１-５]つの(論点|テーマ|ポイント|話題)|目次|'
                       r'まずは?一つ|最後に?[、]?[三四五3-5]つ目|第[一二三四五1-5]の(論点|テーマ)')


def numbering_errors(ep, uploads=()):
    """원고(해설·콜드오픈·카드)·고정 댓글·설명 첫 두 줄의 쟁점 번호 호명·목차 + 챕터 카드 → FAIL 문구 목록."""
    bad = []
    segs = spoken(ep)
    import ja_render   # spoken() 이 render 경로를 넣었다
    for s in ja_render.segments(json.loads((ep / 'episode.json').read_text(encoding='utf-8'))):
        if s.get('type') == 'chapter':
            bad.append(f'챕터 카드 «{(s.get("title") or s.get("text") or "")[:20]}» — 챕터는 설명란 타임스탬프에만')
    for s in segs:
        m = NUMBERING.search(s['text'])
        if m:
            bad.append(f'원고 {s.get("type")} 번호 호명·목차 «{m.group(0)}»: «{s["text"][:30]}»')
    for up in uploads:
        u = json.loads(Path(up).read_text(encoding='utf-8'))
        for where, txt in (('고정 댓글', u.get('pinned_comment') or ''), ('설명 첫 두 줄', '\n'.join((u.get('description') or '').split('\n')[:2]))):
            m = NUMBERING.search(txt)
            if m:
                bad.append(f'{Path(up).parent.name}/{Path(up).name} {where} 번호 호명·목차 «{m.group(0)}»')
    pk = ep / 'packages.json'
    for i, pkg in enumerate(json.loads(pk.read_text(encoding='utf-8'))['packages'] if pk.exists() else []):
        m = NUMBERING.search('\n'.join(pkg.get('desc_head') or []))
        if m:
            bad.append(f'packages.json {i}번 설명 첫 두 줄 번호 호명·목차 «{m.group(0)}»')
    return bad
def audit_lines(ep):
    """공용 원고 검수표(script_audit, 도구개발 2a4b577 정치JA 어댑터) — 롱폼 + shorts/plan.json 쇼츠마다. → (FAIL 목록, 출력 줄 목록)"""
    sys.path.insert(0, str(ROOT / 'scripts'))
    import script_audit
    bad, lines = [], []
    jobs = [('롱폼', str(ep), None)]
    plan = ep / 'shorts' / 'plan.json'
    for sh in (json.loads(plan.read_text(encoding='utf-8')).get('shorts', []) if plan.exists() else []):
        jobs.append((f'쇼츠 {sh["id"]}', f'{plan}:{sh["id"]}', 'shorts'))
    for name, path, kind in jobs:
        res = script_audit.audit(path, lane='politics_ja', kind=kind)
        if res.get('error'):
            bad.append(f'원고 검수표 {name} 검사 불가: {res["error"]}')
            continue
        probs = [(w['code'], w['msg']) for w in res.get('fails', []) + res.get('warnings', [])]
        if kind == 'shorts':   # 도구 수정 전 임시 면제(관리자 10-20): 주고받기 통과 + 0초 attack 이 의문문이면 «첫 질문» △ 1건 면제
            sh = next(s for s in json.loads(plan.read_text(encoding='utf-8'))['shorts'] if path.endswith(':' + s['id']))
            b0 = (sh.get('beats') or [{}])[0]
            if b0.get('role') == 'attack' and re.search(r'[?？]\s*$', b0.get('text') or '') and not shorts_struct_errors(ep, only=sh['id']):
                kept = [x for x in probs if x[0] != '질문']
                if len(kept) < len(probs):
                    lines.append(f'원고 검수표 {name} [질문] 면제 — 0초 공격 대사가 의문문 «{b0["text"][:20]}» (도구 수정 전 임시, 관리자 10-20)')
                probs = kept
        for code, msg in probs:
            bad.append(f'원고 검수표 {name} △ [{code}] {msg}')
        for w in res.get('notices', []):
            lines.append(f'원고 검수표 {name} 참고 [{w.get("code")}] {w.get("msg")}')
        if not probs:
            lines.append(f'원고 검수표 {name} △ 0')
    cfg = json.loads((ROOT / 'config' / 'script_audit.json').read_text(encoding='utf-8')).get('ja', {})
    for up in sorted((ep / 'shorts').glob('*/upload.json')):   # V1 — 쇼츠 고정 댓글도 설명형 시작 금지
        pc = (json.loads(up.read_text(encoding='utf-8')).get('pinned_comment') or '').strip()
        hit = [w for w in cfg.get('v1_starts', []) if pc.startswith(w)]
        if hit:
            bad.append(f'쇼츠 {up.parent.name} 고정 댓글 설명형 시작 «{pc[:20]}» (V1)')
    return bad, lines


ROLES = ('attack', 'reaction', 'counter', 'narration', 'question')
RAW_MAX = .80                         # 쇼츠 원음 ≤ 길이의 80%(관리자 10-20, 10-16 해설 85% 규칙 대체)
RANGE = {'attack': (3, 8), 'reaction': (1, 3), 'counter': (3, 10)}


def beat_sec(b):
    return float(b['out']) - float(b['in']) if b.get('out') is not None else len(re.sub(r'\s', '', b.get('nar') or '')) / 7.5


def shorts_struct_errors(ep, only=None, quiet=False):
    """쇼츠 = 주고받기 1~2개(소유주 10-20 «토론·국감장에서 주고받는 멘트와 반응·대응을»): plan.json beats 의 role·speaker 로
    attack≥1·reaction≥1·counter≥1, 발언자 2명 이상·공격자≠대응자, 한 사람 연속 12초 이하, 칸 길이(공격 3~8·반응 1~3·대응 3~10초), 해설은 한 줄(30자) 이하."""
    plan = ep / 'shorts' / 'plan.json'
    bad = []
    for sh in (json.loads(plan.read_text(encoding='utf-8')).get('shorts', []) if plan.exists() else []):
        sid, beats = sh['id'], sh.get('beats', [])
        if only and sid != only:
            continue
        sys.path.insert(0, str(ROOT / 'scripts'))
        import exchange_check   # 도구개발 fba0506 — 쇼츠마다 판정(①②③ FAIL·④ 해설 30% WARN), 유예 없음(--enforce-now 와 같음)
        try:
            r = exchange_check.judge(exchange_check.beats_of({'beats': beats}, plan.parent))
        except exchange_check.Unreadable as e:
            bad.append(f'쇼츠 {sid}: 주고받기 검사 불가 — {e}')
            continue
        bad += [f'쇼츠 {sid}: {e}' for e in r['errors'] + r['warnings']]
        quiet or only or print(f'[exchange] 쇼츠 {sid} 종료 {r["code"]} · 화자 {r.get("speakers")} · 최장 연속 {r.get("longest_run")} · 길이 {r.get("total_sec")}초')
        raw_s = sum(beat_sec(b) for b in beats if b.get('role') in ('attack', 'reaction', 'counter'))
        all_s = sum(beat_sec(b) for b in beats) or 1
        if raw_s / all_s > RAW_MAX:   # 10-16 «해설 ≥85%»를 대체(관리자 10-20)
            bad.append(f'쇼츠 {sid}: 원음 {raw_s:.1f}초 = {raw_s / all_s:.0%} > {RAW_MAX:.0%}')
        for b in beats:   # 정치JA 추가 기준(관리자 10-20): 칸 길이·해설 한 줄
            lo_hi = RANGE.get(b.get('role'))
            if lo_hi and not lo_hi[0] - .05 <= beat_sec(b) <= lo_hi[1] + .05:
                bad.append(f'쇼츠 {sid}: {b["role"]} {b.get("speaker")} {beat_sec(b):.1f}초 — {lo_hi[0]}~{lo_hi[1]}초')
            if b.get('role') in ('narration', 'question') and len(b.get('nar') or '') > 30:
                bad.append(f'쇼츠 {sid}: 해설 한 줄(30자) 초과 «{b["nar"][:20]}…»')
            if b.get('role') == 'reaction' and len(b.get('line') or '') > 30:
                bad.append(f'쇼츠 {sid}: 반응 컷 위 해설 한 줄(30자) 초과')
    return bad


FACT_DEVICES = ('훅 질문', '시도·실패', '반전·비장의 무기', '금지된 지식', '의성어·현장감', '궁금증 연쇄', '클라이맥스 예고', '감정 꼬리', '열린 결말 질문')
FICTION_DEVICES = ('캐릭터 설정', '빌런(반대자)', '빌런', '생각 풍선')


def story_sentences(sh):
    """쇼츠 beats → (문장, beat 매핑) — 해설 nar·원음 text·반응 컷 위 line 순서대로. 매핑은 칸의 sb(이야기 beat 이름)."""
    sents, mp = [], []
    for b in sh.get('beats', []):
        t = (b.get('nar') or b.get('text') or b.get('line') or '').replace('\n', ' ').strip()
        if t:
            sents.append(t)
            mp.append(b.get('sb') or '')
    return sents, mp


def story_lines(ep, only=None, enforce=None):
    """공용 scripts/story_gate.judge 를 import(관리자 10-21 §7 규칙 5 «숏폼 원고 = 창작 글쓰기, 화면 해설 금지»): 쇼츠 항목마다
    story{structure_id, beats{situation·stake·attempt·turn·ending·emotion_tail}, fiction{allowed:false}} + 칸마다 sb(문장→beat).
    정치라 허구 장치 FAIL(실명 인물은 확인된 사건·발언만). 10-23 00:00 KST 전에는 FAIL 도 유예. → (FAIL 목록, 출력 줄 목록)"""
    sys.path.insert(0, str(ROOT / 'scripts'))
    import datetime as dt
    import story_gate
    enforce = dt.datetime.now(dt.timezone.utc) >= story_gate.ENFORCE_FROM if enforce is None else enforce
    plan = ep / 'shorts' / 'plan.json'
    bad, out = [], []
    for sh in (json.loads(plan.read_text(encoding='utf-8')).get('shorts', []) if plan.exists() else []):
        if only and sh['id'] != only:
            continue
        sents, mp = story_sentences(sh)
        story = dict(sh.get('story') or {})
        if story and not story.get('map'):
            story['map'] = mp
        r = story_gate.judge({**sh, 'story': story} if story else sh, sents, lane='politics_short', lang='ja')
        dv = story.get('devices') or {}   # 장치 {문장 번호: 장치}(longshort-reset §9, 관리자 10-21) — 정치는 사실형만
        dv = dv if isinstance(dv, dict) else dict(enumerate(dv))
        fic = [d for d in dv.values() if d in FICTION_DEVICES]
        if fic:
            r['fails'].append(f'허구형 장치 {"·".join(fic)} — 정치는 사실형({"·".join(FACT_DEVICES)})만'); r['verdict'] = 'FAIL'
        if len(set(dv.values()) - set(FICTION_DEVICES)) < 5:
            r['warns'].append(f'장치 {len(set(dv.values()) - set(FICTION_DEVICES))}종 < 5 (story.devices)')
            r['verdict'] = 'WARN' if r['verdict'] == 'PASS' else r['verdict']
        why = ' / '.join(r['fails'] + r['warns']) or f'구조·매핑·전환 통과({r["stats"]["n"]}문장, 묘사형 {r["stats"]["descriptive"]})'
        pre = '' if enforce or r['verdict'] != 'FAIL' else '[유예 ~10-23] '
        out.append(f'[관문] {pre}story: {r["verdict"]} · {why} · 쇼츠 {sh["id"]}')
        if r['verdict'] == 'FAIL' and enforce:
            bad.append(f'쇼츠 {sh["id"]}: story FAIL — {" / ".join(r["fails"])}')
    return bad, out


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'politics-hour'))
import candidate_gate   # noqa: E402  ko 후보표 관문(28ca994) 그대로


# ko 빌런 검사 중 ko 자료를 읽는 두 줄(상승 검색어 politics_ko 상위 5 · politics-hour/threads.json 줄기)은 일본 자료로 바꿔 본다(10-29).
#  일본: 빌런은 villain_watch 최신 보고서 상위 3 또는 상승 검색어 politics_ja 상위 5 안 · 줄기는 politics-hour-ja/threads.json
KO_ONLY = ('상승 검색어 상위 5위', '지금 줄기', '상승 검색어 표 없음', '줄기 이슈')


def ja_villain_lines(ep):
    kd = json.loads((Path(ep) / 'keywords.json').read_text(encoding='utf-8'))
    v = kd.get('villain') or {}
    name = str(v.get('name', '')).strip()
    if not name:
        return []
    bad = []
    rep = sorted((HERE / '_scan' / 'villain_watch').glob('*.md'))
    watch = []
    if rep:
        for ln in rep[-1].read_text(encoding='utf-8').splitlines():
            m = re.match(r'\| ([^|★]+?)(?: ★새 신호)? \| \d+', ln)
            if m:
                watch.append(m.group(1).strip())
    rk = ROOT / 'server' / 'data' / 'rising_keywords' / 'politics_ja_latest.json'
    top = [r['keyword'] for r in sorted(json.loads(rk.read_text(encoding='utf-8')).get('rows') or [], key=lambda r: -(r.get('rising_score') or 0))][:5] if rk.exists() else []
    if name not in watch[:3] and name not in top:
        bad.append(f'빌런 «{name}» 이 villain_watch 상위 3({" · ".join(watch[:3])})·상승 검색어 politics_ja 상위 5({" · ".join(top)}) 밖')
    th = HERE / 'threads.json'
    act = json.loads(th.read_text(encoding='utf-8')).get('active', []) if th.exists() else []
    mine = next((t for t in act if t.get('villain') == name), None)
    if not str(v.get('switch', '')).strip():
        if not mine:
            bad.append(f'빌런 «{name}» 이 politics-hour-ja/threads.json 줄기에 없음 — 새 줄기면 "switch": 사유 + threads.json 에 추가')
        elif v.get('issue') and mine.get('issue') != v['issue']:
            bad.append(f'«{name}» 줄기 이슈 «{mine.get("issue")}» 와 다름 «{v["issue"]}»')
    return bad


def candidates_errors(ep):
    return [b for b in candidate_gate.gate_lines(ep) if not any(k in b for k in KO_ONLY)] + ja_villain_lines(ep)


def spoken(ep, all_types=False):
    sys.path.insert(0, str(Path(__file__).parent / 'render'))
    import ja_render
    epj = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    segs = ja_render.segments(epj)
    return segs if all_types else [s for s in segs if s.get('type') in ('cold', 'nar', 'card', 'chapter') and s.get('text')]


def main():
    ep = Path(sys.argv[1])
    bad = candidates_errors(ep)
    rc_ref = 0
    if '--before-script' not in sys.argv:
        segs = spoken(ep)
        first = next((s['text'] for s in segs if s.get('type') in ('cold', 'nar')), '')
        if candidate_gate.ep_date(ep) < FROM:
            pass
        elif GREETING.match(first.strip()):
            bad.append(f'첫 말이 인사·채널명·날짜: «{first[:30]}»')
        else:
            print(f'[script-ja] PASS 첫 말 인사 아님: «{first[:30]}»')
        if candidate_gate.ep_date(ep) >= FROM:
            nb = numbering_errors(ep)
            bad += nb
            if not nb:
                print('[script-ja] PASS 쟁점 번호 호명·목차·챕터 카드 없음')
        if candidate_gate.ep_date(ep) >= FROM:
            sb = shorts_struct_errors(ep)
            bad += sb
            if not sb and (ep / 'shorts' / 'plan.json').exists():
                print('[script-ja] PASS 쇼츠 주고받기 구조(공격·반응·대응, 연속 ≤12초)')
            stb, stl = story_lines(ep)   # 쇼츠 이야기 구조(§7 규칙 5, 10-23 전 유예)
            bad += stb
            for l in stl:
                print(l)
        import uncertain_facts_ja   # G4 불확실 팩트(ko uncertain_facts import, 10/23편부터) — TTS 전
        fb = uncertain_facts_ja.gate_lines(ep)
        bad += fb
        if not fb and candidate_gate.ep_date(ep) >= uncertain_facts_ja.uf.FROM:
            print('[script-ja] PASS 불확실 팩트 0건(gpt-ask 교차 확인·원고 해시 일치)')
        if candidate_gate.ep_date(ep) >= FROM or '--audit' in sys.argv:
            ab, al = audit_lines(ep)
            bad += ab
            for l in al:
                print('[script-ja] PASS', l)
        with tempfile.TemporaryDirectory() as tmp:
            nar = Path(tmp) / 'nar.json'
            nar.write_text(json.dumps([s['text'] for s in segs if s.get('type') != 'card'], ensure_ascii=False), encoding='utf-8')
            rc_ref = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'ref_overlap.py'), str(nar), '--lane', 'politics_ja']).returncode
    if not candidates_errors(ep):
        print('[script-ja] PASS 후보표(상승 점수·발췌·지금의 감정·댓글 수·사유)')
    for b in bad:
        print('[script-ja] FAIL', b)
    sys.exit(rc_ref or (3 if bad else 0))


if __name__ == '__main__':
    main()
