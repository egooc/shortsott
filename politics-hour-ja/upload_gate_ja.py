"""ja 정치 업로드 관문 — 원본 politics-hour/upload_gate.py 를 그대로 부르고, ja 제목 길이(16~30자)만 여기서 더 본다.

    python politics-hour-ja/upload_gate_ja.py <편 폴더> <upload.json ...>

원본 판정은 일본어에도 그대로 맞는다(키워드 부분 문자열 대조·태그 개수). 어긋나면 exit 3 — 업로드하지 말고 관리자에게 보고."""
import json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts')); import guide_words
from pathlib import Path

GATE = Path(__file__).resolve().parents[1] / 'politics-hour' / 'upload_gate.py'
# 원본의 첫 30초 검사는 ko episode.json(segments·words) 구조를 읽는다 → keywords.json 만 든 임시 폴더로 부르고,
# ja 첫 30초 검사는 아래에서 ja 구조로 따로 한다.
import shutil, tempfile
# 쇼츠 upload.json 은 넘기지 않는다(ko 쇼츠 검사는 ko ls/ 구조 plan.json·thumb_k 를 읽는다 — ja 쇼츠는 아래 comment_hook·풀이 검사가 본다).
# 편 날짜·전각 «？»는 ko 관문이 직접 읽는다(21e9750).
with tempfile.TemporaryDirectory() as tmp:
    shutil.copy2(Path(sys.argv[1]) / 'keywords.json', Path(tmp) / 'keywords.json')
    longs = [u for u in sys.argv[2:] if '/shorts/' not in u.replace(chr(92), '/')]
    rc = subprocess.run([sys.executable, str(GATE), tmp, *longs]).returncode if longs else 0
bad = []
for up in sys.argv[2:]:
    t = json.loads(Path(up).read_text(encoding='utf-8')).get('title', '')
    if '/shorts/' not in up.replace(chr(92), '/') and not 16 <= len(t) <= 30:
        bad.append(f'{Path(up).name}: 제목 {len(t)}자 (16~30자여야 함)')
# 썸네일 낱말은 첫 30초(콜드오픈·도입) 안에 자막·해설·화면 글자로 모두 나와야 한다(관리자·소유주 10-17)
ep = Path(sys.argv[1])
kw = json.loads((ep / 'keywords.json').read_text(encoding='utf-8')) if (ep / 'keywords.json').exists() else {}
pkp = ep / 'packages.json'
pkgs = json.loads(pkp.read_text(encoding='utf-8'))['packages'][1:] if pkp.exists() else []
if kw.get('thumb_words') or pkgs:
    import re
    sys.path.insert(0, str(Path(__file__).parent / 'render'))
    import ja_render
    epj = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    lst = Path(epj['workdir']) / 'concat.txt'
    durs = [ja_render.probe_seconds(ln.split("'")[1]) for ln in lst.read_text(encoding='utf-8').splitlines()
            if ln.startswith('file')] if lst.exists() else []
    norm = lambda s: re.sub(r'<[^>]+>|[\s“”"「」『』？?！!、。・]', '', s)
    t, hay = 0.0, ''
    segs = ja_render.segments(epj)
    if len(durs) != len(segs):                   # --only 시험 렌더가 concat.txt 를 덮었으면 추정치로
        durs = []
    for i, s in enumerate(segs):
        if t >= 30:
            break
        v = s.get('visual') or {}
        hay += ' '.join([s.get('text', ''), s.get('title', ''), (s.get('q') or {}).get('text', ''),
                         (v.get('hook') or {}).get('q_html', ''), ' '.join(v.get('items', []))])
        t += durs[i] if i < len(durs) else 8
if kw.get('thumb_words'):
    for w in kw['thumb_words']:
        if norm(w) not in norm(hay):
            bad.append(f'썸네일 낱말 «{w}» 이 첫 30초에 없음')
    if not bad:
        print('[gate-ja] PASS 썸네일 낱말 첫 30초:', ' · '.join(kw['thumb_words']))
    # 롱폼 제목은 썸네일의 가장 큰 낱말(thumb_big, 없으면 thumb_words 첫째)로 시작해야 한다(관리자 10-17, ko 51cbd4b 와 같은 규칙)
    big = kw.get('thumb_big') or kw['thumb_words'][0]
    for up in sys.argv[2:]:
        if '/shorts/' in up.replace(chr(92), '/'):
            continue
        t = json.loads(Path(up).read_text(encoding='utf-8')).get('title', '')
        if norm(t).startswith(norm(big)):
            print(f'[gate-ja] PASS 제목이 썸네일 큰 낱말 «{big}» 로 시작')
        else:
            bad.append(f'{Path(up).name}: 제목이 썸네일 큰 낱말 «{big}» 로 시작하지 않음 — «{t}»')
# 자동 교체 대체 포장(packages.json 1번~, 관리자 10-18 · ko upload_gate 와 같은 형식): 포장마다 big 이 있어야 하고,
# 제목은 big[0] 으로 시작, big 낱말은 첫 30초에 나와야 한다 — 교체 순간엔 사람이 못 보니 업로드 전에 미리 통과시킨다.
for i, pkg in enumerate(pkgs, 1):
    if not pkg.get('big'):
        bad.append(f'packages.json {i}번: big(핵심 낱말) 없음')
        continue
    if not 16 <= len(pkg['title']) <= 30:
        bad.append(f'packages.json {i}번: 제목 {len(pkg["title"])}자 (16~30자여야 함)')
    if not norm(pkg['title']).startswith(norm(pkg['big'][0])):
        bad.append(f'packages.json {i}번: 제목 «{pkg["title"]}» 이 «{pkg["big"][0]}» 으로 시작하지 않음')
    if not (Path(__file__).resolve().parents[1] / pkg['thumbnail']).exists():
        bad.append(f'packages.json {i}번: 썸네일 없음 {pkg["thumbnail"]}')
    miss = [w for w in pkg['big'] if norm(w) not in norm(hay)]
    bad += [f'packages.json {i}번: «{w}» 이 첫 30초에 없음' for w in miss]
    if not miss:
        print(f'[gate-ja] PASS 대체 포장 {i}번 «{pkg["title"]}»')
# 묶음마다 제목·썸네일·키워드·태그·해시태그·설명 첫 두 줄이 다 있어야 한다(10-18 소유주 «성과에 따라 계속 수정할 준비») — 교체 때 통째로 바뀐다
if pkp.exists():
    for i, pkg in enumerate(json.loads(pkp.read_text(encoding='utf-8'))['packages']):
        miss = [k for k in ('title', 'thumbnail', 'keywords', 'tags', 'hashtags', 'desc_head') if not pkg.get(k)]
        tag_len = sum(len(t) + (2 if ' ' in t else 0) for t in pkg.get('tags', [])) + max(len(pkg.get('tags', [])) - 1, 0)
        if miss:
            bad.append(f'packages.json {i}번 묶음: {"·".join(miss)} 없음')
        elif len(pkg['desc_head']) != 2 or tag_len > 500 or not all(h.startswith('#') for h in pkg['hashtags']):
            bad.append(f'packages.json {i}번 묶음: 설명 첫 줄 {len(pkg["desc_head"])}줄(2여야) · 태그 {tag_len}자(500 이하) · 해시태그 # 확인')
        else:
            print(f'[gate-ja] PASS {i}번 묶음 6칸(태그 {len(pkg["tags"])}개 {tag_len}자)')
norm = lambda s: re.sub(r'<[^>]+>|[\s“”"「」『』？?！!、。・]', '', s)
# 제목 전문용어엔 쉬운 풀이(관리자 10-20 S5, materials-audit 6번): 제목에 jargon.json 낱말이 있으면 제목 또는 설명 첫 줄(포장은 desc_head[0])에 plain 하나
jargon = json.loads((Path(__file__).parent / 'jargon.json').read_text(encoding='utf-8'))['words']
def _explained(where, title, first):
    for w, j in jargon.items():
        if w in title:
            hit = [p for p in j['plain'] if norm(p) in norm(title + first)]
            if hit:
                print(f'[gate-ja] PASS 풀이 {where}: «{w}»({j["ko"]}) ← «{hit[0]}»')
            else:
                bad.append(f'{where}: 제목 낱말 «{w}»({j["ko"]}) 풀이 없음 — 제목·설명 첫 줄에 {" / ".join(j["plain"])} 중 하나')
for up in sys.argv[2:]:
    u = json.loads(Path(up).read_text(encoding='utf-8'))
    _explained(Path(up).parent.name + '/' + Path(up).name, u.get('title', ''), (u.get('description') or '').split('\n')[0])
for i, pkg in enumerate(json.loads(pkp.read_text(encoding='utf-8'))['packages'] if pkp.exists() else []):
    _explained(f'packages.json {i}번', pkg.get('title', ''), (pkg.get('desc_head') or [''])[0])
# 고정 댓글 = 양자택일 질문 한 줄(관리자 10-20 ③): 공용 comment_hook --lane politics_shorts(expected_comment 객체·pinned_comment «?»)
for up in sys.argv[2:]:
    r = subprocess.run([sys.executable, str(GATE.parents[1] / 'scripts' / 'comment_hook.py'), up, '--lane', 'politics_shorts'],
                       capture_output=True, text=True, encoding='utf-8')
    pin = json.loads(Path(up).read_text(encoding='utf-8')).get('pinned_comment', '')
    if r.returncode or not re.search(r'[?？]', pin):
        bad.append(f'{Path(up).parent.name}/{Path(up).name}: 고정 댓글 관문 종료 {r.returncode} «{pin}» — {(r.stdout + r.stderr).strip()[-200:]}')
    else:
        print(f'[gate-ja] PASS 고정 댓글 «{pin}»')
# 쇼츠 제목 점검(관리자 10-20 via 정치 ko 06906c4): 롱폼은 ko 관문이 title_check 를 부른다(defaultLanguage ja → politics_ja),
# ja 쇼츠는 ko 관문에 안 넘기므로 여기서 같은 옵션으로 — 10패턴·길이·앞 10자·title_pattern 필드, --fail-on-warn(4·5 업로드 금지)
for up in [u for u in sys.argv[2:] if '/shorts/' in u.replace(chr(92), '/')]:
    r = subprocess.run([sys.executable, '-X', 'utf8', str(GATE.parents[1] / 'scripts' / 'title_check.py'), up,
                        '--lane', 'politics_shorts', '--kind', 'shorts', '--lang', 'ja', '--fail-on-warn'],
                       capture_output=True, text=True, encoding='utf-8')
    if r.returncode:
        why = ' / '.join(l.strip() for l in r.stdout.splitlines() if l.strip().startswith('△ [') or '불가' in l)
        bad.append(f'{Path(up).parent.name}/{Path(up).name}: 제목 점검(title_check) 종료 {r.returncode} — {why or r.stderr.strip()[-200:]}')
    else:
        print(f'[gate-ja] PASS 쇼츠 제목 점검 {Path(up).parent.name}')
# 첫 말 인사 금지·후보표 대리만족 열(관리자 10-20 ②④) — 원고 관문과 같은 판정
import importlib.util
_sp = importlib.util.spec_from_file_location('script_gate', Path(__file__).parent / 'script_gate.py')
script_gate = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(script_gate)
if script_gate.candidate_gate.ep_date(ep, sys.argv[2:]) >= script_gate.FROM:   # 10/21편부터(후보표 열은 ko 관문이 이미 봤다)
    _first = next((s['text'] for s in script_gate.spoken(ep) if s.get('type') in ('cold', 'nar')), '')
    if script_gate.GREETING.match(_first.strip()):
        bad.append(f'첫 말이 인사·채널명·날짜: «{_first[:30]}»')
    else:
        print(f'[gate-ja] PASS 첫 말 인사 아님 «{_first[:30]}»')
    _nb = script_gate.numbering_errors(ep, sys.argv[2:])   # 쟁점 번호 호명·목차·챕터 카드(소유주 10-20)
    bad += _nb
    if not _nb:
        print('[gate-ja] PASS 쟁점 번호 호명·목차·챕터 카드 없음(원고·고정 댓글·설명 첫 두 줄)')
    _sb = script_gate.shorts_struct_errors(ep)   # 쇼츠 주고받기 구조(소유주 10-20)
    bad += _sb
    if not _sb:
        print('[gate-ja] PASS 쇼츠 주고받기 구조(공격·반응·대응, 연속 ≤12초)')
    for _u in [u for u in sys.argv[2:] if '/shorts/' in u.replace(chr(92), '/')]:   # 쇼츠 이야기 구조(공용 story_gate, §7 규칙 5 · 10-23 전 유예)
        _sid = Path(_u).parent.name   # shorts/<id>/upload.json
        _stb, _stl = script_gate.story_lines(ep, only=_sid)
        bad += _stb
        for _l in _stl:
            print('[gate-ja]', _l)
    _ab, _al = script_gate.audit_lines(ep)   # 공용 원고 검수표 devo V1·V3·V12·V14(관리자 10-20) — ko 관문 경로는 임시 폴더라 안 돈다
    bad += _ab
    for _l in _al:
        print('[gate-ja] PASS', _l)
# 커뮤니티 가이드 낱말(10-18 소유주 «제재 없이 조회 0 = 가이드 위반», 정본 config/guide_words.json · 도구개발 공용 판정) — 걸리면 종료 4
guide = guide_words.gate_lines([*sys.argv[2:], *[x for x in [ep / 'packages.json', ep / 'keywords.json'] if x.exists()]], lang='ja', lane='politics_ja')
bad += guide
if not guide:
    print('[gate-ja] PASS 가이드 낱말(제목·설명·태그·포장·썸네일 낱말)')
for b in bad:
    print('[gate-ja] FAIL', b)
sys.exit(4 if guide else 3 if rc or bad else 0)
