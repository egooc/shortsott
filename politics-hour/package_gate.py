"""포장 묶음 제목 머리 관문(관리자 10-24, 소유주 10-23편 질책 «장동혁 욕설… 왜 그 자극적인 소재 냅두고 제목을 저 따위로»).
① 제목 머리 15자 안에 첫 쟁점 인물 이름과 그 쟁점 낱말이 있어야 한다(둘째 쟁점이 머리인 묶음 금지).
② 후보표에서 그 인물 줄의 news_outlier.title_words·quotes 낱말 중 인물 이름 말고 2개 이상이 제목에 그대로 있어야 한다.
인물 = keywords.json villain.name (없으면 keywords[0]), 쟁점 낱말 = villain.issue (없으면 threads.json 그 인물의 issue)를 띄어쓰기로 나눈 2자 이상 낱말.
사용: python package_gate.py <ep폴더> [--title "제목"]   — 제목을 주면 그 하나, 없으면 packages.json 의 packages·loop 전부. 하나라도 걸리면 종료 4.
EP 날짜가 ENFORCE_FROM 이전이면 경고만(옛 편 루프를 막지 않는다)."""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENFORCE_FROM = '00000000'   # 소유주 10-24 «제목을 바꾸는데 왜 타겟을 바꿔?» — 옛 편 루프도 타겟 바뀌는 묶음은 안 건다
HEAD = 15


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


def check(ep, title):
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
    items = [('title', sys.argv[sys.argv.index('--title') + 1])] if '--title' in sys.argv else titles(ep)
    enforce = ep.name[:8] >= ENFORCE_FROM
    fail = False
    for tag, t in items:
        b = check(ep, t)
        print(f'[pkg] {"FAIL" if b else "PASS"} {tag} «{t}»' + ''.join(f'\n      - {x}' for x in b))
        fail |= bool(b)
    if fail and enforce:
        sys.exit(4)
    if fail:
        print(f'[pkg] 경고만 — {ep.name} < {ENFORCE_FROM}')
