"""욕설·비속어 관문(소유주 10-27 결정, 관리자 경유) — 목록은 profanity.json(정규식).

    python profanity.py <ep폴더> [upload.json ...]     하나라도 걸리면 종료 4

검사 대상(모든 편, 날짜 유예 없음 — 옛 편은 package_gate→views_check headOk 포장 교체 단계에서만 실제로 걸린다):
- 원고: script_*.py 의 문자열(해설 문장·화면 카드). 원음 인용 자막(phrases·words 값)과 docstring 은 뺀다.
- 자막: episode.json 해설(text·visual 글자). 원음 인용(quote phrases·cold words)은 렌더 때 «xx» 로 가려지므로
  가린 뒤 남는 게 없는지만 보고, 가릴 낱말은 참고로 적는다(음성은 overlay/beep.py 가 1kHz 삐).
- 포장: upload.json title·description·tags·pinned_comment, packages.json packages·loop 의 title·hashtags·big·desc_head·tags
  + 썸네일 설정(thumbnail_X.png → 같은 폴더 X.json 의 quote·issue·chip·sides[].name·big).
«욕설»·«막말»·«폭언» 같은 묘사 낱말은 금지가 아니다. scope «text»(쌍욕)는 원고·해설·포장에만, 원음 인용에는 안 건다.
"""
import ast
import json
import re
import sys
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent           # D:/midform — packages.json thumbnail 경로의 기준
LIST = HERE / 'profanity.json'
SKIP_KEYS = {'phrases', 'words'}   # 원음 인용 자막 — 렌더 때 가려진다


@lru_cache(maxsize=1)
def _rules():
    d = json.loads(LIST.read_text(encoding='utf-8'))
    return d.get('mask', 'xx'), [(re.compile(w['re']), w.get('scope', 'all')) for w in d['words']]


def hits(text, scopes=('all', 'text')):
    """text 안 금지 낱말(매치 문자열) 목록."""
    out = []
    for rx, sc in _rules()[1]:
        if sc in scopes:
            out += [m.group(0) for m in rx.finditer(text or '')]
    return out


def mask(text):
    """원음 인용 자막용 — scope all 낱말을 «xx» 로(예: 씨발→xx)."""
    m, rules = _rules()
    for rx, sc in rules:
        if sc == 'all':
            text = rx.sub(m, text)
    return text


def is_bad_token(word):
    """전사 토큰 하나가 삐 대상인가(scope all)."""
    return bool(hits(word, ('all',)))


def token_hits(tokens, t0, t1):
    """Speechmatics 전사 [[start, end, word], ...] 에서 [t0, t1] 과 겹치는 욕설 토큰. 앞뒤 토큰을 붙인 낱말(«개» «새끼»)도 본다."""
    out = []
    toks = [w for w in tokens if isinstance(w, (list, tuple)) and len(w) >= 3]
    for i, (a, b, w) in enumerate(toks):
        if b <= t0 or a >= t1:
            continue
        if is_bad_token(str(w)):
            out.append((float(a), float(b), str(w)))
        elif i + 1 < len(toks) and is_bad_token(str(w) + str(toks[i + 1][2])) and not is_bad_token(str(toks[i + 1][2])):
            out.append((float(a), float(toks[i + 1][1]), f'{w} {toks[i + 1][2]}'))
    return out


def load_transcript(ep, src):
    """발췌 src(«src/<id>_<초>.mp4»)의 전사 = 편 폴더 transcripts/<같은 이름>.json. 없으면 None."""
    p = Path(ep) / 'transcripts' / (Path(src).stem + '.json')
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding='utf-8'))
    if isinstance(d, dict):
        d = d.get('words') or d.get('tokens') or []
    return d


def _py_strings(path):
    tree = ast.parse(Path(path).read_text(encoding='utf-8'))
    skip = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                skip.add(id(first.value))
        sub = []
        if isinstance(node, ast.keyword) and node.arg in SKIP_KEYS:
            sub = [node.value]
        elif isinstance(node, ast.Dict):
            sub = [v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant) and k.value in SKIP_KEYS]
        for s in sub:
            skip.update(id(n) for n in ast.walk(s))
    return [(n.lineno, n.value) for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in skip]


def _strings(obj):
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in _strings(v)]
    if isinstance(obj, (list, tuple)):
        return [s for v in obj for s in _strings(v)]
    return []


def _fmt(where, h, text):
    text = text.strip()
    k = max(0, text.find(h[0]) - 25)
    return f'{where}: 욕설·비속어 {sorted(set(h))} — «{"…" if k else ""}{text[k:k + 60]}»'


def script_lines(ep):
    bad = []
    for f in sorted(Path(ep).glob('script_*.py')):
        for ln, s in _py_strings(f):
            h = hits(s)
            if h:
                bad.append(_fmt(f'원고 {f.name}:{ln}', h, s))
    return bad


def episode_lines(ep):
    """(실패, 참고) — 해설 자막·화면 글자는 실패, 원음 인용 자막은 가림 참고."""
    bad, notes = [], []
    p = Path(ep) / 'episode.json'
    if not p.exists():
        return bad, notes
    for i, s in enumerate(json.loads(p.read_text(encoding='utf-8'))['segments']):
        if s['type'] in ('nar', 'hook'):   # 몽타주 훅(10-28)도 해설과 같은 우리 말 — 자막 덩어리·이름표·꼬리표·손글씨까지
            hook_txt = ([c for ln in s.get('lines', []) for c in ln.get('caps', [])] + list(s.get('title', []))
                        + [str(v) for c in s.get('cuts', []) for k in ('name', 'tag', 'note', 'sticker') if c.get(k)
                           for v in (c[k].get('lines') or [c[k].get('text', '')])]) if s['type'] == 'hook' else []
            for t in [s.get('text', '')] + _strings(s.get('visual', {})) + hook_txt:
                h = hits(t)
                if h:
                    bad.append(_fmt(f'해설 자막 [{i}]', h, t))
            continue
        texts = list(s.get('phrases', [])) if s['type'] == 'quote' else [w[1] for w in s.get('words', [])]
        for t in texts:
            h = hits(t, ('all',))
            if h:
                left = hits(mask(t), ('all',))
                (bad if left else notes).append(f'인용 자막 [{i}] {s["type"]} {sorted(set(h))} → «{mask(t)[:50]}»'
                                                 + (' — 가린 뒤에도 남음' if left else ' (렌더 때 xx·삐)'))
        for k in ('tag', 'speaker', 'role'):
            h = hits(s.get(k, ''))
            if h:
                bad.append(_fmt(f'인용 이름표 [{i}] {k}', h, s.get(k, '')))
    return bad, notes


def upload_lines(ups):
    bad = []
    for up in ups:
        u = json.loads(Path(up).read_text(encoding='utf-8'))
        for k in ('title', 'description', 'pinned_comment'):
            h = hits(u.get(k) or '')
            if h:
                bad.append(_fmt(f'{Path(up).name} {k}', h, u.get(k) or ''))
        for t in u.get('tags') or []:
            h = hits(t)
            if h:
                bad.append(_fmt(f'{Path(up).name} tags', h, t))
    return bad


def thumb_config(pkg):
    """packages.json 묶음의 썸네일 png → 썸네일 문구 설정 json(thumbnail_X.png → X.json)."""
    t = pkg.get('thumbnail')
    if not t:
        return None
    png = ROOT / t
    stem = png.stem[len('thumbnail_'):] if png.stem.startswith('thumbnail_') else png.stem
    cfg = png.parent / f'{stem}.json'
    return cfg if cfg.exists() else None


def package_lines(pkg, tag=''):
    """묶음 하나의 포장 글자(제목·해시태그·big·desc_head·tags·썸네일 문구)."""
    bad = []
    fields = [('title', pkg.get('title', ''))]
    fields += [(k, x) for k in ('hashtags', 'big', 'desc_head', 'tags') for x in (pkg.get(k) or [])]
    cfg = thumb_config(pkg)
    if cfg:
        c = json.loads(cfg.read_text(encoding='utf-8'))
        fields += [(f'썸네일 {cfg.name} {k}', c.get(k, '')) for k in ('quote', 'issue', 'chip') if c.get(k)]
        fields += [(f'썸네일 {cfg.name} big', x) for x in c.get('big', [])]
        fields += [(f'썸네일 {cfg.name} name', sd.get('name', '')) for sd in c.get('sides', [])]
    for k, t in fields:
        h = hits(str(t))
        if h:
            bad.append(_fmt(f'{tag} {k}'.strip(), h, str(t)))
    return bad


def packages(ep):
    p = Path(ep) / 'packages.json'
    if not p.exists():
        return []
    j = json.loads(p.read_text(encoding='utf-8'))
    out = [(f'packages[{i}]', x) for i, x in enumerate(j.get('packages', []))]
    out += [(f'loop[{i}]', x) for i, x in enumerate((j.get('loop') or {}).get('packages', []))]
    return out


def gate_lines(ep, ups=()):
    """upload_gate 용 — 원고·해설 자막·포장 전부. 원음 인용 자막 가림은 참고(출력만)."""
    ep = Path(ep)
    bad = script_lines(ep)
    b, notes = episode_lines(ep)
    bad += b
    bad += upload_lines(ups)
    for tag, pkg in packages(ep):
        bad += package_lines(pkg, f'packages.json {tag}')
    for n in notes:
        print('[욕설] 참고', n)
    return bad


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1])
    if not ep.exists():
        ep = HERE / 'episodes' / sys.argv[1]
    bad = gate_lines(ep, sys.argv[2:])
    for x in bad:
        print('[욕설] FAIL', x)
    print('[욕설]', 'PASS' if not bad else f'{len(bad)}건 실패', ep.name)
    sys.exit(4 if bad else 0)
