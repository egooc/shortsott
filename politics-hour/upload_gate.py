"""업로드 전 키워드 관문 — keywords.json 없이는 업로드 단계로 못 넘어간다(관리자 10-17, 소유주 «롱폼은 키워드랑 태그야»).

    python politics-hour/upload_gate.py <에피소드 폴더> [upload.json ...]

검사: <에피소드>/keywords.json 이 있고 keywords 가 3~5개. upload.json 을 주면 키워드마다 제목·설명 첫 두 줄·태그 중
한 곳 이상에 들어 있어야 하고, 태그는 15~25개.
쇼츠 upload.json(경로에 '/shorts/')은 한 쟁점만 다루므로 키워드 2개 이상만 보고 태그 개수는 안 본다.
썸네일 큰 낱말(thumb/thumb_k*.json 의 big → keywords.json thumb → keywords 1~2위)은 롱폼 첫 30초(콜드오픈+첫 해설)·쇼츠 첫 5초에 다 나와야 한다(10-17).
episode.json 에 "tts_say": true 인 편(10/20~)은 overlay/tts_audit.py 역전사 대조 결과(audit/result.json)가 ok 여야 한다.
하나라도 어긋나면 exit 3 — 업로드하지 말고 관리자에게 보고."""
import json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts')); import guide_words   # 가이드 낱말 공용 판정(소유주 10-18 «조회 0 = 가이드 위반»)

ep = Path(sys.argv[1])
bad = []
kp = ep / 'keywords.json'
if not kp.exists():
    bad.append(f'keywords.json 없음: {kp}')
    kws = []
else:
    kws = json.loads(kp.read_text(encoding='utf-8')).get('keywords', [])
    if not 3 <= len(kws) <= 5:
        bad.append(f'keywords {len(kws)}개 (3~5개여야 함)')
for up in sys.argv[2:]:
    u = json.loads(Path(up).read_text(encoding='utf-8'))
    tags = u.get('tags') or []
    hay = ' '.join([u.get('title', ''), *u.get('description', '').split('\n')[:2], *tags])
    short = 'shorts' in Path(up).resolve().parts
    miss = [k for k in kws if k.split('(')[0].strip() not in hay]
    if short and len(kws) - len(miss) < 2:
        bad.append(f'{Path(up).name}: 쇼츠 키워드 {len(kws) - len(miss)}개 (2개 이상이어야 함)')
    for k in ([] if short else miss):
        bad.append(f'{Path(up).name}: 키워드 «{k}» 가 제목·설명 첫 두 줄·태그에 없음')
    if not short and not 15 <= len(tags) <= 25:
        bad.append(f'{Path(up).name}: 태그 {len(tags)}개 (15~25개여야 함)')
# 썸네일 큰 낱말 → 첫 장면(관리자·소유주 10-17 «썸네일에 나오는 내용이 훅으로 처음에 들어가야»):
# 롱폼은 콜드오픈 words + 첫 해설(text·화면 카드), 쇼츠는 plan 의 제목·해설 카드·첫 자막(첫 5초)에 큰 낱말의 낱말마다 다 들어 있어야 한다.
def big_words(cfg_path):
    cfg = json.loads(cfg_path.read_text(encoding='utf-8')) if cfg_path.exists() else {}
    kwj = json.loads(kp.read_text(encoding='utf-8')) if kp.exists() else {}
    return cfg.get('big') or kwj.get('thumb') or kws[:2]


def need(words, hay, where):
    for w in words:
        lost = [t for t in w.split() if t not in hay]
        if lost:
            bad.append(f'{where}: 썸네일 큰 낱말 «{w}» 의 {lost} 가 첫 장면에 안 나옴')


epj = ep / 'episode.json'
if epj.exists():
    segs = json.loads(epj.read_text(encoding='utf-8'))['segments']
    cold = next((s for s in segs if s['type'] == 'cold'), {})
    nar = next((s for s in segs if s['type'] == 'nar'), {})
    hay = ' '.join([' '.join(w[1] for w in cold.get('words', [])), nar.get('text', ''), json.dumps(nar.get('visual', {}), ensure_ascii=False)])
    need(big_words(ep / 'thumb' / 'thumb_k.json'), hay, '롱폼 첫 30초(콜드오픈+도입)')
# 제목 맨 앞 낱말 = 썸네일 1순위 큰 낱말(관리자 10-17): 롱폼 upload.json 제목이 big[0] 으로 시작해야 한다.
top = (big_words(ep / 'thumb' / 'thumb_k.json') or [''])[0]
for up in sys.argv[2:]:
    if 'shorts' in Path(up).resolve().parts:
        continue
    t = json.loads(Path(up).read_text(encoding='utf-8')).get('title', '')
    if top and not t.startswith(top):
        bad.append(f'{Path(up).name}: 제목 «{t}» 이 썸네일 1순위 낱말 «{top}» 으로 시작하지 않음')
# 자동 교체 대체 포장(packages.json 1번~, 관리자 10-18): 포장마다 big(인용 썸네일의 핵심 낱말)이 있어야 하고,
# 제목은 big[0] 으로 시작, big 낱말은 롱폼 첫 30초에 나와야 한다 — 교체 순간엔 사람이 못 보니 업로드 전에 미리 통과시킨다.
pkp = ep / 'packages.json'
if pkp.exists() and epj.exists():
    for i, pkg in enumerate(json.loads(pkp.read_text(encoding='utf-8'))['packages'][1:], 1):
        if not pkg.get('big'):
            bad.append(f'packages.json {i}번: big(핵심 낱말) 없음')
            continue
        if not pkg['title'].startswith(pkg['big'][0]):
            bad.append(f'packages.json {i}번: 제목 «{pkg["title"]}» 이 «{pkg["big"][0]}» 으로 시작하지 않음')
        if not (Path(__file__).resolve().parent.parent / pkg['thumbnail']).exists():
            bad.append(f'packages.json {i}번: 썸네일 없음 {pkg["thumbnail"]}')
        need(pkg['big'], hay, f'packages.json {i}번 첫 30초')
        if 'tags' in pkg and not 15 <= len(pkg['tags']) <= 25:   # 교체 때 태그도 통째로 바뀐다(관리자 10-18)
            bad.append(f'packages.json {i}번: 태그 {len(pkg["tags"])}개 (15~25개여야 함)')
        if 'tags' in pkg or 'desc_head' in pkg:
            phay = ' '.join([pkg['title'], *pkg.get('desc_head', []), *pkg.get('tags', [])])
            for k in kws:
                if k.split('(')[0].strip() not in phay:
                    bad.append(f'packages.json {i}번: 키워드 «{k}» 가 제목·desc_head·tags 에 없음')
for up in sys.argv[2:]:
    if 'shorts' not in Path(up).resolve().parts:
        continue
    name = Path(up).name.split('.')[0]
    plan = Path(up).parent.parent / 'ls' / Path(up).parent.name / name / 'plan.json'
    if not plan.exists():
        bad.append(f'{name}: plan.json 없음 {plan}')
        continue
    pj = json.loads(plan.read_text(encoding='utf-8'))
    seq = [s for s in pj['sequence'] if 'captions' in s]
    first = [c.split('|')[-1] for c in (seq[0]['captions'][:3] if seq else [])]
    hay = ' '.join([*pj.get('title', []), *[c for n in pj.get('narration', []) for c in n.get('cards', [])], *first])
    need(big_words(ep / 'thumb' / f'thumb_k_{name}.json'), hay, f'{name} 첫 5초(제목·해설 카드·첫 자막)')
# 댓글 장치(관리자 10-20 소유주 질책 «댓글 반응을 노리는 원고 반영이 안 됐다»): 쇼츠는 expected_comment 가 있어야 하고,
# 롱폼·쇼츠 모두 고정 댓글에 질문 한 줄(«?»·전각 «？»)이 있어야 한다 — 발췌 원음이라 본문에 못 넣으면 고정 댓글 질문이 그 장치다.
# 쇼츠 expected_comment({type, line, at_sec})·장치 문장·끝 3문장은 공용 scripts/comment_hook.py(도구개발) 로 본다 — 종료 4·5 둘 다 FAIL.
import comment_hook   # noqa: E402  scripts/ 는 위에서 sys.path 에 넣었다
for up in sys.argv[2:]:
    u = json.loads(Path(up).read_text(encoding='utf-8'))
    if 'shorts' in Path(up).resolve().parts:
        r = comment_hook.check(up, lane='politics_shorts')
        if not r['ok']:
            bad.append(f'{Path(up).name}: 댓글 장치 관문(comment_hook) 종료 {r["code"]} — {"; ".join(map(str, r.get("errors", [])))}')
    if not any(q in (u.get('pinned_comment') or '') for q in '?？'):   # 전각 «？»(정치JA)도 질문
        bad.append(f'{Path(up).name}: 고정 댓글에 질문 한 줄(«?») 없음 — 논쟁·훈수를 부르는 질문으로')
# 제목 점검은 공용 scripts/title_check.py(관리자 10-20, 055f18a)로 통일 — 쇼츠 10패턴·15자·앞 10자·title_pattern 필드·위험 조합,
# 롱폼 전문용어 풀이(politics_ko 는 politics-hour/jargon.json, S5). --fail-on-warn 이라 경고(4)·검사 불가(5) 모두 업로드 금지. 10/21편부터.
import subprocess   # noqa: E402
import candidate_gate   # noqa: E402  편 날짜(ep_date)·후보표(상승 점수·발췌·지금의 감정·댓글 수) — 10/21편부터
EP_DATE = candidate_gate.ep_date(ep, sys.argv[2:])
# 쇼츠 주고받기(10-20 15:00 소유주 «주고받는 중요 멘트랑 반응이나 대응») + 3단 얼굴 띠 틀 — 10/21편부터. shorts/exchange_gate.py
import subprocess   # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent / 'shorts')); import exchange_gate   # noqa: E402
for up in sys.argv[2:]:
    if 'shorts' not in Path(up).resolve().parts or EP_DATE < '20261021':
        continue
    name = Path(up).name.split('.')[0]
    plan = Path(up).parent.parent / 'ls' / Path(up).parent.name / name / 'plan.json'
    if not plan.exists():
        continue
    bad += exchange_gate.check(json.loads(plan.read_text(encoding='utf-8')), name)[0]
    r = subprocess.run([sys.executable, '-X', 'utf8', str(Path(__file__).resolve().parents[1] / 'scripts' / 'exchange_check.py'), str(plan),
                        '--lane', 'politics_shorts', '--enforce-now'], capture_output=True, text=True, encoding='utf-8')
    if r.returncode:
        bad.append(f'{name} exchange_check 종료 {r.returncode}: ' + ' / '.join(x for x in r.stdout.splitlines() if 'FAIL' in x or '불가' in x)[:400])
    # 이야기 구조(공용 story_gate 2e986a7, 소유주 10-21 «화면 해설 말고 스토리») — 정치는 허구 금지 고정. 원고 순서 문장 = upload.json story_lines. 10-23 전 FAIL 은 유예(0)
    r = subprocess.run([sys.executable, '-X', 'utf8', str(Path(__file__).resolve().parents[1] / 'scripts' / 'story_gate.py'), str(up),
                        '--lane', 'politics_short', '--field', 'story_lines'], capture_output=True, text=True, encoding='utf-8')
    print(r.stdout.strip())
    if r.returncode:
        bad.append(f'{name} story_gate 종료 {r.returncode}: {r.stdout.strip()[:300]}')
TITLE_CHECK = Path(__file__).resolve().parents[1] / 'scripts' / 'title_check.py'
for up in (sys.argv[2:] if EP_DATE >= '20261021' else []):
    u = json.loads(Path(up).read_text(encoding='utf-8'))
    ja = str(u.get('defaultLanguage', '')).startswith('ja')
    opt = (['--lane', 'politics_shorts', '--kind', 'shorts', '--lang', 'ja' if ja else 'ko'] if 'shorts' in Path(up).resolve().parts
           else ['--lane', 'politics_ja' if ja else 'politics_ko'])
    r = subprocess.run([sys.executable, '-X', 'utf8', str(TITLE_CHECK), up, *opt, '--fail-on-warn'], capture_output=True, text=True, encoding='utf-8')
    if r.returncode:
        why = ' / '.join(l.strip() for l in r.stdout.splitlines() if l.strip().startswith('△ [') or '불가' in l)
        bad.append(f'{Path(up).name}: 제목 점검(title_check) 종료 {r.returncode} — {why or r.stderr.strip()[-200:]}')
# 첫 문장 «안녕하세요·오늘은» 금지(10-20 콜드오픈 규칙): 콜드오픈 첫 낱말과 첫 해설 첫 문장
if epj.exists() and EP_DATE >= '20261021':
    first = [' '.join(w[1] for w in cold.get('words', [])[:3]), (nar.get('text') or '').strip()[:12]]
    for f in first:
        if f.lstrip().startswith(('안녕하세요', '오늘은')):
            bad.append(f'첫 문장이 «{f[:12]}…» — 인사·«오늘은» 시작 금지, 질문이나 원음으로 연다')
bad += candidate_gate.gate_lines(ep, sys.argv[2:])
# 레퍼런스 겹침·태그 관문(관리자 10-20 adoption_check: 손 실행만이던 것을 관문으로) — 10/21편부터.
# ① scripts/ref_overlap.py: 원고 문장이 레퍼런스 채널 전사와 ≥0.7 겹치면 4, 검사 불가 5 — 둘 다 FAIL.
# ② scripts/tag_gate.py --fail-on-warn: 제목·설명 첫 두 줄·태그 공통 낱말. 롱폼은 원고(해설+인용 원음) 일치 비율도, 쇼츠는 원음이라 비율 제외(--ratio 0).
if EP_DATE >= '20261021':
    LANG_JA = any(str(json.loads(Path(u).read_text(encoding='utf-8')).get('defaultLanguage', '')).startswith('ja') for u in sys.argv[2:])
    SCRIPTS_DIR = Path(__file__).resolve().parents[1] / 'scripts'
    if epj.exists():
        r = subprocess.run([sys.executable, '-X', 'utf8', str(SCRIPTS_DIR / 'ref_overlap.py'), str(ep), '--lane', 'politics_ja' if LANG_JA else 'politics_ko'],
                           capture_output=True, text=True, encoding='utf-8')
        if r.returncode:
            bad.append(f'레퍼런스 겹침(ref_overlap) 종료 {r.returncode} — {(r.stdout.strip().splitlines() or [r.stderr.strip()[-200:]])[-1]}')
    (ep / 'audit').mkdir(exist_ok=True)
    for up in sys.argv[2:]:
        if 'shorts' in Path(up).resolve().parts:
            plan = Path(up).parent.parent / 'ls' / Path(up).parent.name / Path(up).name.split('.')[0] / 'plan.json'
            body = '\n'.join(c.split('|')[-1] for s in (json.loads(plan.read_text(encoding='utf-8'))['sequence'] if plan.exists() else []) for c in s.get('captions', []))
            extra = ['--ratio', '0']
        else:
            segs = json.loads(epj.read_text(encoding='utf-8'))['segments'] if epj.exists() else []
            body = '\n'.join(s.get('text') or ' '.join(w[1] for w in s.get('words', [])) for s in segs)
            extra = []
        sf = ep / 'audit' / f'tag_body_{Path(up).name.split(".")[0]}.txt'
        sf.write_text(body + '\n', encoding='utf-8')
        r = subprocess.run([sys.executable, '-X', 'utf8', str(SCRIPTS_DIR / 'tag_gate.py'), up, '--script', str(sf), *extra, '--fail-on-warn'],
                           capture_output=True, text=True, encoding='utf-8')
        if r.returncode:
            why = ' / '.join(l.strip() for l in r.stdout.splitlines() if l.strip().startswith('△') and '경고' not in l[:12])
            bad.append(f'{Path(up).name}: 태그 관문(tag_gate) 종료 {r.returncode} — {why or r.stdout.strip()[-200:]}')
# 목차·번호 호명 금지(소유주 10-20 «'쟁점 브리핑입니다' 하고 쟁점 하나 둘 셋 나열하는 순간 루즈해진다»): 10/21편부터
# 해설 TTS·화면 카드(nar 의 text·visual) + 고정 댓글 + 설명란 전체에서 FAIL. 인용 원음(quote·cold)은 실제 발언이라 안 본다.
# 챕터는 설명란에만, 번호(«01»)·«오늘의 쟁점»·«정리» 같은 제목 없이 내용 낱말로.
NO_TOC = re.compile(r'쟁점 ?브리핑입니다|쟁점 ?(하나|둘|셋|넷|[1-4])|(첫|두|세|네) ?번째 ?(쟁점|이슈)|두 번째로|세 번째로|오늘(의)? ?쟁점')
CAMP = re.compile(r'좌파|우파|극우|극좌|종북|빨갱이|수꼴|좌빨|토착왜구|대깨|개딸|태극기 ?부대')
CHAPTER = re.compile(r'^\s*\d{1,2}:\d{2}(:\d{2})?\s+(.*)$')
if EP_DATE >= '20261021':
    if epj.exists():
        for i, s in enumerate(json.loads(epj.read_text(encoding='utf-8'))['segments']):
            if s['type'] != 'nar':
                continue
            for m in NO_TOC.finditer(json.dumps({'text': s.get('text', ''), 'visual': s.get('visual', {})}, ensure_ascii=False)):
                bad.append(f'해설 [{i}] 목차·번호 호명 «{m.group(0)}» — 번호 없이 내용 전환 문구로(«그런데 같은 날 대법원에서는…»)')
            # 진영 딱지 낱말 금지(관리자 10-20 기획 가이드 24편) — 해설·화면 카드만, 인용 원음은 발언 그대로라 안 본다
            for m in CAMP.finditer(json.dumps({'text': s.get('text', ''), 'visual': s.get('visual', {})}, ensure_ascii=False)):
                bad.append(f'해설 [{i}] 진영 딱지 낱말 «{m.group(0)}» — 인물·기관 이름으로')
    for up in sys.argv[2:]:
        u = json.loads(Path(up).read_text(encoding='utf-8'))
        for where, txt in (('고정 댓글', u.get('pinned_comment', '')), ('설명란', u.get('description', ''))):
            for m in NO_TOC.finditer(txt or ''):
                bad.append(f'{Path(up).name}: {where} 목차·번호 호명 «{m.group(0)}»')
        for line in (u.get('description') or '').splitlines():
            c = CHAPTER.match(line)
            if c and re.match(r'(\d{1,2}\b|오늘|정리|마무리|목차)', c.group(2)):
                bad.append(f'{Path(up).name}: 챕터 «{line.strip()}» — 번호·제목 말고 내용 낱말로')
# 원고 검수표(관리자 10-20, 공용 scripts/script_audit.py — 원고 확정 때 한 번 돌리고 결과 줄을 원고 보고에): 10/21편부터 롱폼은
# △ 0(전환 문구 120초 안·첫 질문 15초·첫 원음 40초…), 끝 3문장에 TTS 로 읽는 질문 한 줄이 있고 안내형(구독·좋아요) 없음,
# 그 질문이 롱폼 고정 댓글에도 같은 문장으로 들어 있어야 한다. 구독 안내는 설명란으로.
if epj.exists() and EP_DATE >= '20261021':
    import script_audit   # noqa: E402
    SA_JA = any(str(json.loads(Path(u).read_text(encoding='utf-8')).get('defaultLanguage', '')).startswith('ja') for u in sys.argv[2:])   # 정치JA 가 이 관문을 import 한다
    sa = script_audit.audit(str(ep), lane='politics_ja' if SA_JA else 'politics_ko')
    (ep / 'audit').mkdir(exist_ok=True)
    (ep / 'audit' / 'script_audit.json').write_text(json.dumps(sa, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if sa.get('error'):
        bad.append(f'원고 검수표(script_audit) 검사 불가: {sa["error"]}')
    for w in sa.get('warnings', []):
        bad.append(f'원고 검수표 △ [{w["code"]}] {w["msg"]}')
    end = sa.get('ending') or {}
    if '안내' in end.get('kinds', []):
        bad.append(f'끝 3문장이 안내형 {end.get("tail")} — 양자택일 질문 한 줄 + 짧은 닫음으로, 구독 안내는 설명란')
    asks = [s for s in end.get('tail', []) if s.rstrip().endswith(('?', '？', '까요.', '까요'))]
    if not asks:
        bad.append('끝 3문장에 질문 한 줄 없음(TTS 로 읽는 양자택일 질문)')
    sq = lambda x: comment_hook.squash(x)
    for up in sys.argv[2:]:
        if 'shorts' in Path(up).resolve().parts:
            continue
        pc = sq(json.loads(Path(up).read_text(encoding='utf-8')).get('pinned_comment', ''))
        if asks and not any(sq(a) in pc for a in asks):
            bad.append(f'{Path(up).name}: 고정 댓글에 원고 끝 질문 «{asks[0]}» 이 같은 문장으로 없음')
# 쇼츠 원고 검수표(도구개발 d77326a — plan.json 을 그냥 넘기면 롱폼 기준이라 kind='shorts' 로 부른다): 첫 질문 3초·끝 질문/열린 결말·
# V1~V4. «첫 원음 40초»는 롱폼 항목이라 뺀다. 10/21편부터 △ 0.
if EP_DATE >= '20261021':
    import script_audit   # noqa: E402,F811
    for up in sys.argv[2:]:
        if 'shorts' not in Path(up).resolve().parts:
            continue
        name = Path(up).name.split('.')[0]
        plan = Path(up).parent.parent / 'ls' / Path(up).parent.name / name / 'plan.json'
        if not plan.exists():
            continue
        sa = script_audit.audit(str(plan), lane='politics_ja' if 'ja' in str(json.loads(Path(up).read_text(encoding='utf-8')).get('defaultLanguage', '')) else 'politics_ko', kind='shorts')
        (ep / 'audit').mkdir(exist_ok=True)
        (ep / 'audit' / f'script_audit_{name}.json').write_text(json.dumps(sa, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if sa.get('error'):
            bad.append(f'{name} 쇼츠 검수표 검사 불가: {sa["error"]}')
        for w in sa.get('warnings', []):
            if w['code'] != '원음':
                bad.append(f'{name} 쇼츠 검수표 △ [{w["code"]}] {w["msg"]}')
for up in sys.argv[2:]:   # 쇼츠 설명·고정 댓글의 롱폼 주소 자리표({LONGFORM})는 롱폼 업로드 뒤 채운다 — 남아 있으면 FAIL
    _u = json.loads(Path(up).read_text(encoding='utf-8'))
    if re.search(r'\{[A-Z_]+\}', (_u.get('description') or '') + (_u.get('pinned_comment') or '')):
        bad.append(f'{Path(up).name}: 채우지 않은 자리표 {sorted(set(re.findall(r"[{][A-Z_]+[}]", (_u.get("description") or "") + (_u.get("pinned_comment") or ""))))}')
sys.path.insert(0, str(Path(__file__).resolve().parent / 'overlay')); import tts_audit   # 해설 TTS 역전사 숫자·고유명사 대조(10/20편부터, tts_say 편만 요구)
bad += tts_audit.gate_lines(ep)
import uncertain_facts   # noqa: E402  불확실 팩트 목록(uncertain_facts.json) 0건·원고 해시 일치(G4, 10/23편부터)
bad += uncertain_facts.gate_lines(ep, sys.argv[2:])
import jargon_gate   # noqa: E402  제목 전문 용어 풀이 두 출처 교차 확인 기록(G23, 10/23편부터)
bad += jargon_gate.gate_lines(ep, sys.argv[2:])
import package_gate   # noqa: E402  포장 묶음 제목 머리 관문(관리자 10-24) — 첫 쟁점 인물+쟁점 낱말 머리 15자·뉴스 제목 낱말 2개+, 업로드 관문은 10/25편부터(10/23편은 루프에서만)
if EP_DATE >= '20261025' and (ep / 'packages.json').exists():
    bad += [f'packages.json {tag}: {x}' for tag, t in package_gate.titles(ep) for x in package_gate.check(ep, t)]
bad += guide_words.gate_lines([*sys.argv[2:], *[p for p in [ep / 'packages.json'] if p.exists()]], lang='ko', lane='politics')   # 제목·설명·태그·썸네일 낱말, 우회 GUIDE_OK=1 은 소유주 말 있을 때만
if EP_DATE >= '20261023':   # 소유주 10-22 «억지로 늘리지 말고 여러 개» — 목표 약 10분, 8분 미만 FAIL, 12분 넘으면 쪼개기 권고(안 막음)
    _mp4 = ep / 'work' / 'episode.mp4'
    _r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(_mp4)], capture_output=True, text=True) if _mp4.exists() else None
    _sec = float(_r.stdout.strip() or 0) if _r and _r.returncode == 0 else 0
    _tgt, _ref = candidate_gate.target_sec(ep)   # 가장 짧은 레퍼런스가 20분 이상이면 그 길이(하한 0.8배), 아니면 10분(하한 8분)
    _min = 480 if _tgt == 600 else _tgt * 0.8
    print(f'[gate] 길이 {_sec / 60:.1f}분 · 레퍼런스 {(_ref or {}).get("sec", 0) / 60:.1f}분({(_ref or {}).get("video_id", "-")}) → 목표 {_tgt / 60:.0f}분')
    if _sec < _min:
        bad.append(f'길이 {_sec / 60:.1f}분 — {_min / 60:.0f}분 미만 금지(목표 {_tgt / 60:.0f}분), 쟁점을 더하거나 다음 편과 합쳐라' if _sec else f'길이 잴 수 없음: {_mp4}')
    elif _tgt == 600 and _sec > 720:
        print(f'[gate] 참고 길이 {_sec / 60:.1f}분 — 목표 약 10분, 늘리지 말고 두 편으로 쪼갤 수 있는지 본다')
# 소유주 10-23 «여당 유튜브인데 이재명을 이재명이라 그래? 대통령이라고 해야지» — 제목·설명·태그·해시태그·포장에서 이름만 쓴 «이재명» FAIL(«이재명 정부»는 허용)
_BARE = re.compile(r'이재명(?!\s*(대통령|정부))')
_hashtags = lambda d: [l for l in (d or '').split('\n') if re.fullmatch(r'(#\S+\s*)+', l.strip())]
for up in [*sys.argv[2:], *[p for p in [ep / 'packages.json'] if p.exists()]]:
    _j = json.loads(Path(up).read_text(encoding='utf-8'))
    _items = [_j] if 'packages' not in _j else [*_j['packages'], *(_j.get('loop') or [])]
    for i, _p in enumerate(_items):
        _txt = ' '.join([_p.get('title', ''), _p.get('description', ''), *_p.get('desc_head', []), *_p.get('tags', []), *_p.get('hashtags', []), *_p.get('big', [])])
        for m in _BARE.finditer(_txt):
            bad.append(f'{Path(up).name}{f" {i}번" if "packages" in _j else ""}: 이름만 쓴 «{_txt[max(0, m.start() - 12):m.end() + 8]}» — «이재명 대통령»으로')
    # 소유주 10-23 «이슈 키워드는 제목이랑 해시태그에 반영한 거야?» — 키워드마다 제목 또는 해시태그에, 1순위는 둘 다(10/23편부터)
    if EP_DATE >= '20261023' and 'packages' not in _j and 'shorts' not in Path(up).resolve().parts:
        _t, _h = _j.get('title', ''), ''.join(_hashtags(_j.get('description'))).replace(' ', '')
        for n, k in enumerate(kws):
            k0 = k.split('(')[0].strip()
            inT, inH = k0 in _t, '#' + k0.replace(' ', '') in _h
            if not (inT or inH) or (n == 0 and not (inT and inH)):
                bad.append(f'{Path(up).name}: 키워드 «{k0}» — 제목 {"O" if inT else "X"} · 해시태그 {"O" if inH else "X"} ({"1순위는 둘 다" if n == 0 else "둘 중 하나는"})')
for b in bad:
    print('[gate] FAIL', b)
if bad:
    sys.exit(3)
print('[gate] PASS', ep.name, ' · '.join(kws))
