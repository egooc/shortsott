# -*- coding: utf-8 -*-
"""원고 ↔ 레퍼런스 전사 문장 단위 일치 검사 — 공용(10-20, 연금JA ja-nenkin/render/ref_overlap.py 에서 옮김).
롱폼 원고 관문(렌더 전 필수): 연금 ja · 기업 ko · 정치 ko · 정치 JA.

    python scripts/ref_overlap.py <원고> [--lane nenkin_ja|corp_ko|politics_ko|politics_ja] [--refs DIR ...] [--lang ko|ja] [--th 0.7] [--json out]

원고 형식(확장자로 고름):
    .txt  — 한 줄 = 한 문장 묶음, '#'·'@' 로 시작하는 줄은 건너뜀(연금·기업)
    .py   — 정치 ko script_N.py: {'type': 'nar', 'text': ...} 의 text 만(인용 q(...)는 원래 남의 말이라 뺀다)
    .json — 문자열 배열 또는 [{text: ...}] (cues.json 등)
    폴더  — 그 안의 script.txt → script_*.py → seg/*/cues.json 순으로

레퍼런스 전사 폴더 규약(연금JA 그대로): DIR/*.md(·*.txt), 줄 앞 '[mm:ss]'·'[h:mm:ss]' 는 지우고, '#'·'- ' 머리줄은 건너뜀.
언어(--lang, 기본은 레인 설정): ja = 줄마다 나눔, ko = 타임코드 줄을 이어 붙여 다시 나눔(문장부호 없는 긴 덩어리는 40·80자 창).
--refs 를 안 주면 config/ref_overlap.json 의 레인 기본 폴더.

문장부호·공백을 지운 뒤 difflib 비율 ≥ th 인 쌍을 보여 준다.
종료 코드: 0 통과 · 4 걸림 · 5 검사 불가(레퍼런스 0문장·원고 0문장·폴더 없음 — 조용히 통과시키지 않는다, server/data/gate_errors.jsonl 에 남김).
"""
import ast
import datetime as _dt
import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config' / 'ref_overlap.json'
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
MIN_LEN = 8
_PUNCT = re.compile(r'[、。，,.「」『』“”‘’"\'？?！!・…~\-–—()（）\[\]<>《》«»:：;；\s]')
_SPLIT = re.compile(r'(?<=[。？！?!.])\s*')
WINS, LONG = ((40, 10), (80, 20)), 100   # ko 자동 자막은 문장부호가 거의 없다 → 긴 덩어리는 40자·80자 창으로 잘라 맞댄다(짧은 원고 문장·긴 문장 둘 다 0.7 이상 나오게)
_STAMP = re.compile(r'^\[\d+:\d+(?::\d+)?\]\s*')


def norm(s):
    return _PUNCT.sub('', s)


def split_sentences(text):
    return [s.strip() for s in _SPLIT.split(text) if s and s.strip()]


def _windows(n):
    """정규화 길이 n 이 LONG 을 넘으면 [(시작, 끝)] 창들, 아니면 None."""
    if n <= LONG:
        return None
    return [(i, min(i + w, n)) for w, step in WINS for i in range(0, max(n - w, 0) + step, step)]


def ref_sentences(dirs, lang='ja'):
    """[(파일 stem, 정규화 문장, 원문)]
    ja: 타임코드 줄마다 «。？！» 로 나눈다(연금JA 원판 그대로).
    ko: 한국어 전사는 타임코드 한 줄이 문장 조각이라 파일 하나의 줄을 이어 붙인 뒤 «. ? !» 로 다시 나눈다
        (기업 흥망 ko-corp/render/ref_overlap_ko.py 9f731f7 의 방식). 문장부호 없는 긴 덩어리는 40·80자 창으로."""
    out = []
    for d in dirs:
        for f in sorted(list(Path(d).glob('*.md')) + list(Path(d).glob('*.txt'))):
            lines = []
            for line in f.read_text(encoding='utf-8').splitlines():
                stamped = bool(_STAMP.match(line))
                line = _STAMP.sub('', line).strip()
                if not line or line.startswith(('#', '- ')) or (lang == 'ko' and not stamped and f.suffix == '.md' and _has_stamps(f)):
                    continue
                lines.append(line)
            chunks = split_sentences(' '.join(lines)) if lang == 'ko' else [s for l in lines for s in split_sentences(l)]
            for s in chunks:
                ns = norm(s)
                if len(ns) < MIN_LEN:
                    continue
                win = _windows(len(ns)) if lang == 'ko' else None
                if win:
                    out += [(f.stem, ns[a:b], ns[a:b]) for a, b in win]
                else:
                    out.append((f.stem, ns, s))
    return out


_STAMP_CACHE = {}


def _has_stamps(f):
    if f not in _STAMP_CACHE:
        _STAMP_CACHE[f] = any(_STAMP.match(l) for l in f.read_text(encoding='utf-8').splitlines())
    return _STAMP_CACHE[f]


def _py_narration(path):
    texts = []
    for node in ast.walk(ast.parse(Path(path).read_text(encoding='utf-8'))):
        if not isinstance(node, ast.Dict):
            continue
        kv = {k.value: v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant) and isinstance(k.value, str)}
        t, ty = kv.get('text'), kv.get('type')
        if isinstance(ty, ast.Constant) and ty.value == 'nar' and isinstance(t, ast.Constant) and isinstance(t.value, str):
            texts.append(t.value)
    return texts


def _json_texts(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    if isinstance(data, dict):
        data = data.get('cues') or data.get('lines') or data.get('segments') or []
    return [x if isinstance(x, str) else str(x.get('text', '')) for x in data if isinstance(x, (str, dict))]


def script_sentences(path):
    """원고 → 문장 목록. 폴더면 형식 순서대로 찾는다."""
    p = Path(path)
    if p.is_dir():
        if (p / 'script.txt').exists():
            return script_sentences(p / 'script.txt')
        out = []
        for f in sorted(p.glob('script_*.py')) or sorted(p.glob('seg/*/cues.json')):
            out += script_sentences(f)
        return out
    if p.suffix == '.py':
        lines = _py_narration(p)
    elif p.suffix == '.json':
        lines = _json_texts(p)
    else:
        lines = [l.strip() for l in p.read_text(encoding='utf-8').splitlines() if l.strip() and not l.lstrip().startswith(('#', '@'))]
    return [s for l in lines for s in split_sentences(l)]


def lane_cfg(lane):
    return json.loads(CONFIG.read_text(encoding='utf-8'))['lanes'][lane]


def lane_refs(lane):
    return [ROOT / d for d in lane_cfg(lane)['refs']]


def check(script, refs_dirs, th=0.7, lang='ja'):
    """→ {'hits': [{ratio, mine, ref_file, ref}], 'mine': n, 'refs': n, 'error': str|None}"""
    missing = [str(d) for d in refs_dirs if not Path(d).is_dir()]
    refs = ref_sentences([d for d in refs_dirs if Path(d).is_dir()], lang)
    mine = [s for s in script_sentences(script) if len(norm(s)) >= MIN_LEN]
    res = {'script': str(script), 'th': th, 'mine': len(mine), 'refs': len(refs), 'hits': [], 'error': None}
    if missing:
        res['error'] = f'레퍼런스 폴더 없음: {", ".join(missing)}'
    elif not refs:
        res['error'] = '레퍼런스 0문장'
    elif not mine:
        res['error'] = '원고 0문장(형식을 못 읽음)'
    if res['error']:
        return res
    for m in mine:
        nm = norm(m)
        sm = difflib.SequenceMatcher(None, autojunk=False)
        sm.set_seq2(nm)   # seq2 쪽을 캐시하므로 원고 문장을 고정하고 레퍼런스를 바꿔 끼운다
        best = None
        for stem, nr, raw in refs:
            sm.set_seq1(nr)
            if sm.real_quick_ratio() < th or sm.quick_ratio() < th:
                continue
            r = sm.ratio()
            if r >= th and (best is None or r > best[0]):
                best = (r, stem, raw)
        if best:
            res['hits'].append({'ratio': round(best[0], 3), 'mine': m, 'ref_file': best[1], 'ref': best[2]})
    return res


def _ledger(res, lane):
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        rec = {'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'ref_overlap', 'lane': lane,
               'script': res['script'], 'error': res['error']}
        with LEDGER.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError as e:
        print(f'⚠ 장부 기록 실패: {e}')


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    th = float(argv[argv.index('--th') + 1]) if '--th' in argv else 0.7
    lane = argv[argv.index('--lane') + 1] if '--lane' in argv else None
    refs = [argv[i + 1] for i, a in enumerate(argv) if a == '--refs']
    if not refs and not lane:
        lane = 'nenkin_ja'   # 옛 연금JA 호출(인자 없이)과 같은 기본값
    if not refs:
        refs = lane_refs(lane)
    lang = argv[argv.index('--lang') + 1] if '--lang' in argv else (lane_cfg(lane).get('lang', 'ja') if lane else 'ja')
    res = check(argv[0], refs, th, lang)
    for h in res['hits']:
        print(f'{h["ratio"]:.2f} | {h["mine"]} || {h["ref_file"]}: {h["ref"]}')
    if '--json' in argv:
        Path(argv[argv.index('--json') + 1]).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if res['error']:
        print(f'⚠ 레퍼런스 문장 일치 검사 불가: {res["error"]} — 통과로 치지 않음(종료 5)')
        _ledger(res, lane)
        return 5
    print(f'레퍼런스 문장 일치 검사: 원고 {res["mine"]}문장 · 레퍼런스 {res["refs"]}문장 · ≥{th} {len(res["hits"])}건')
    return 4 if res['hits'] else 0


if __name__ == '__main__':
    sys.exit(main())
