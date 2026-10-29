"""포장 묶음 제목 머리 관문(관리자 10-24, 소유주 10-23편 질책 «장동혁 욕설… 왜 그 자극적인 소재 냅두고 제목을 저 따위로»).
① 제목 머리 15자 안에 첫 쟁점 인물 이름과 그 쟁점 낱말이 있어야 한다(둘째 쟁점이 머리인 묶음 금지).
② 후보표에서 그 인물 줄의 news_outlier.title_words·quotes 낱말 중 인물 이름 말고 2개 이상이 제목에 그대로 있어야 한다.
인물 = keywords.json villain.name (없으면 keywords[0]), 쟁점 낱말 = villain.issue (없으면 threads.json 그 인물의 issue)를 띄어쓰기로 나눈 2자 이상 낱말.
사용: python package_gate.py <ep폴더> [--title "제목"]   — 제목을 주면 그 하나, 없으면 packages.json 의 packages·loop 전부. 하나라도 걸리면 종료 4.
EP 날짜가 ENFORCE_FROM 이전이면 경고만(옛 편 루프를 막지 않는다).
★소유주 10-27 결정(관리자 경유, 레퍼런스 기준선 10-26 제안 ①③) — NEW_FROM(20261028) 이후 편에만:
③ 45자 이내(공백 포함 len). ④ 인용 먼저: 여는 따옴표(" “ « ' ‘)가 제목 앞 20자 안에서 시작.
⑤ 이야기 하나: keywords.json candidates 의 인물 키워드 중 빌런 말고 다른 인물 이름은 제목에 최대 1명(찌르는 말의 화자), 따옴표 인용 구간은 최대 2개.
★욕설·비속어(profanity.json) — 모든 편(날짜 유예 없음): 제목, 그리고 묶음(--title 이면 packages.json 에서 같은 제목 묶음을 찾아)의
해시태그·big·desc_head·tags·썸네일 문구. views_check.js headOk 가 이 종료 4 로 포장 교체 후보에서 뺀다."""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENFORCE_FROM = '00000000'   # 소유주 10-24 «제목을 바꾸는데 왜 타겟을 바꿔?» — 옛 편 루프도 타겟 바뀌는 묶음은 안 건다
HEAD = 15
THUMB_FROM = '20261030'   # 소유주 10-29 «썸네일 3개가 여직껏 제목만 바뀌는 거였어?» — 묶음마다 사진이 달라야(그 전 편은 경고만)
NEW_FROM = '20261028'   # 소유주 10-27: ③④⑤ 는 10/28편부터(그 전 편 교체 묶음은 지금처럼 ①② 만)
MAX_LEN, QUOTE_HEAD, MAX_QUOTES, MAX_OTHERS = 45, 20, 2, 1
OPENERS = '"“«\'‘'
QUOTE_SPAN = re.compile(r'"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’|' + r"'[^']*'")
NOT_PERSON = {'지지율', '특검', '탄핵', '국감', '국회', '여당', '야당', '정부', '대통령', '총선', '지방선거'}
SURNAMES = set('김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진나엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경사부')
sys.path.insert(0, str(HERE)); import profanity   # noqa: E402


def lead_and_issue(ep):
    k = json.loads((ep / 'keywords.json').read_text(encoding='utf-8'))
    v = k.get('villain') or {}
    name = v.get('name') or (k.get('keywords') or [''])[0]
    issue = v.get('issue', '')
    if not issue:
        tp = HERE / 'threads.json'
        if tp.exists():
            t = json.loads(tp.read_text(encoding='utf-8'))
            for th in t.get('active', []):
                if th.get('name') == name:
                    issue = th.get('issue', '')
    words = [w for w in re.split(r'[\s«»"\'·,]+', issue) if len(w) >= 2]
    outl = []
    for c in k.get('candidates', []):
        if name and (name in c.get('keyword', '') or c.get('keyword', '') in name):
            o = c.get('news_outlier')
            for x in (o if isinstance(o, list) else []):
                outl += [w for w in x.get('title_words', []) if w != name and len(w) >= 2]
                for q in x.get('quotes', []):   # 뉴스가 쓴 따옴표 낱말(«술자리 쌍욕 육성 녹음»)도 쟁점 낱말·센 낱말로 인정
                    qw = [w for w in re.split(r"[\s«»\"'·,.!?…]+", q) if len(w) >= 2 and w != name]
                    outl += qw
                    words += qw
    return name, sorted(set(words), key=words.index), sorted(set(outl), key=outl.index)


def check(ep, title, pkg=None):
    name, words, outl = lead_and_issue(ep)
    bad, head = [], title[:HEAD]
    if not name or name not in head:
        bad.append(f'머리 {HEAD}자 «{head}»에 첫 쟁점 인물 «{name}» 없음')
    if not words:
        bad.append('쟁점 낱말 미정(keywords.json villain.issue·threads.json)')
    elif not any(w in head for w in words):
        bad.append(f'머리 {HEAD}자 «{head}»에 쟁점 낱말 {words} 없음')
    hit = [w for w in outl if w in title]
    if len(hit) < 2:
        bad.append(f'뉴스 아웃라이어 제목 낱말 {len(hit)}개({hit}) — 2개 이상 필요, 후보 {outl[:10]}')
    if ep.name[:8] >= NEW_FROM:
        bad += story_rules(ep, title, name)
    bad += profanity_rules(title, pkg)
    return bad


def persons(ep, villain):
    """후보표 인물 키워드(빌런 제외). 인물 = 후보 «person»: true, names_ko.json _roles, 원고 인용 화자, 또는 성씨로 시작하는 한글 3자(NOT_PERSON 제외)."""
    k = json.loads((ep / 'keywords.json').read_text(encoding='utf-8'))
    roles = {}
    if (HERE / 'names_ko.json').exists():
        roles = json.loads((HERE / 'names_ko.json').read_text(encoding='utf-8')).get('_roles', {})
    speakers = set()
    for f in list((ep / 'issues').glob('*.json')) if (ep / 'issues').exists() else []:
        try:
            speakers |= {q.get('speaker', '') for q in json.loads(f.read_text(encoding='utf-8')).get('quotes', [])}
        except (ValueError, AttributeError):
            pass
    out = []
    for c in k.get('candidates', []):
        kw = c.get('keyword', '').strip()
        if not kw or kw == villain or (villain and (villain in kw or kw in villain)):
            continue
        if c.get('person') is False or kw in NOT_PERSON:
            continue
        if c.get('person') or kw in roles or kw in speakers or (re.fullmatch(r'[가-힣]{3}', kw) and kw[0] in SURNAMES):
            out.append(kw)
    return out


def story_rules(ep, title, villain):
    bad = []
    if len(title) > MAX_LEN:
        bad.append(f'제목 {len(title)}자 — {MAX_LEN}자 이내(공백 포함)로')
    pos = [title.find(c) for c in OPENERS if c in title]
    first = min(pos) if pos else -1
    if first < 0 or first >= QUOTE_HEAD:
        bad.append(f'인용 먼저: 여는 따옴표가 앞 {QUOTE_HEAD}자 «{title[:QUOTE_HEAD]}» 안에 없음' + (f'({first + 1}번째 글자에서 시작)' if first >= 0 else '(따옴표 없음)'))
    spans = QUOTE_SPAN.findall(title)
    if len(spans) > MAX_QUOTES:
        bad.append(f'이야기 하나: 따옴표 인용 {len(spans)}개 {spans} — {MAX_QUOTES}개 이하로')
    others = [p for p in persons(ep, villain) if p in title]
    if len(others) > MAX_OTHERS:
        bad.append(f'이야기 하나: 빌런 «{villain}» 말고 인물 {others} {len(others)}명 — 찌르는 말의 화자 {MAX_OTHERS}명까지')
    return bad


def profanity_rules(title, pkg=None):
    if pkg is not None:
        return profanity.package_lines(pkg)
    h = profanity.hits(title)
    return [f'욕설·비속어 {sorted(set(h))} — 제목에서 빼라(원문 인용이 꼭 필요하면 «욕설»·«막말»로 바꿔 적는다)'] if h else []


def thumb_rules(ep, villain):
    """thumb/pkg*.json 끼리: sides img 집합이 같으면 FAIL, 빌런 칸 img 가 같아도 FAIL."""
    cf = sorted((ep / 'thumb').glob('pkg*.json')) if (ep / 'thumb').exists() else []
    seen_set, seen_v, bad = {}, {}, []
    for f in cf:
        try:
            sides = json.loads(f.read_text(encoding='utf-8')).get('sides', [])
        except ValueError:
            continue
        imgs = frozenset(s.get('img', '') for s in sides)
        vimg = next((s.get('img', '') for s in sides if villain and villain in s.get('name', '')), sides[0].get('img', '') if sides else '')
        if imgs in seen_set:
            bad.append(f'썸네일 {f.stem} 사진 구성이 {seen_set[imgs]} 와 같음 — 글자만 바뀐 묶음, 빌런 장면·상대 인물을 바꿔라')
        elif vimg and vimg in seen_v:
            bad.append(f'썸네일 {f.stem} 빌런 사진 {Path(vimg).name} 이 {seen_v[vimg]} 와 같음 — 묶음마다 다른 장면·표정')
        seen_set.setdefault(imgs, f.stem); seen_v.setdefault(vimg, f.stem)
    return bad


def titles(ep):
    p = json.loads((ep / 'packages.json').read_text(encoding='utf-8'))
    out = [(f'packages[{i}]', x.get('title', '')) for i, x in enumerate(p.get('packages', []))]
    out += [(f'loop[{i}]', x.get('title', '')) for i, x in enumerate((p.get('loop') or {}).get('packages', []))]
    return out


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1])
    if not ep.is_absolute() and not ep.exists():
        ep = HERE / 'episodes' / sys.argv[1]
    pk = profanity.packages(ep)
    if '--title' in sys.argv:   # views_check headOk — 같은 제목 묶음이 있으면 그 묶음의 해시태그·썸네일 문구까지 욕설 검사
        t0 = sys.argv[sys.argv.index('--title') + 1]
        items = [('title', t0, next((x for _, x in pk if x.get('title') == t0), None))]
    else:
        items = [(tag, x.get('title', ''), x) for tag, x in pk]
    enforce = ep.name[:8] >= ENFORCE_FROM
    fail = False
    tb = thumb_rules(ep, lead_and_issue(ep)[0]) if (ep / 'keywords.json').exists() else []
    if tb:
        print('[pkg] ' + ('FAIL' if ep.name[:8] >= THUMB_FROM else '경고') + ' 썸네일 다양성' + ''.join('\n      - ' + x for x in tb))
        fail |= ep.name[:8] >= THUMB_FROM
    else:
        print('[pkg] PASS 썸네일 다양성')
    for tag, t, pkg in items:
        b = check(ep, t, pkg)
        print(f'[pkg] {"FAIL" if b else "PASS"} {tag} «{t}»' + ''.join(f'\n      - {x}' for x in b))
        fail |= bool(b)
    if fail and enforce:
        sys.exit(4)
    if fail:
        print(f'[pkg] 경고만 — {ep.name} < {ENFORCE_FROM}')
