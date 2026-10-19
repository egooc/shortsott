# -*- coding: utf-8 -*-
"""원고 ↔ 레퍼런스 전사 문장 단위 일치 검사 — 공용(10-20, 연금JA ja-nenkin/render/ref_overlap.py 에서 옮김).
롱폼 원고 관문(렌더 전 필수): 연금 ja · 기업 ko · 정치 ko · 정치 JA.

    python scripts/ref_overlap.py <원고> [--lane nenkin_ja|corp_ko|politics_ko|politics_ja] [--refs DIR ...] [--th 0.7] [--json out]

원고 형식(확장자로 고름):
    .txt  — 한 줄 = 한 문장 묶음, '#'·'@' 로 시작하는 줄은 건너뜀(연금·기업)
    .py   — 정치 ko script_N.py: {'type': 'nar', 'text': ...} 의 text 만(인용 q(...)는 원래 남의 말이라 뺀다)
    .json — 문자열 배열 또는 [{text: ...}] (cues.json 등)
    폴더  — 그 안의 script.txt → script_*.py → seg/*/cues.json 순으로

레퍼런스 전사 폴더 규약(연금JA 그대로): DIR/*.md(·*.txt), 줄 앞 '[mm:ss]'·'[h:mm:ss]' 는 지우고, '#'·'- ' 머리줄은 건너뜀.
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
_SPLIT = re.compile(r'(?<=[。？！?!.])\s*|(?<=다\.)|(?<=요\.)')
_STAMP = re.compile(r'^\[\d+:\d+(?::\d+)?\]\s*')


def norm(s):
    return _PUNCT.sub('', s)


def split_sentences(text):
    return [s.strip() for s in _SPLIT.split(text) if s and s.strip()]


def ref_sentences(dirs):
    """[(파일 stem, 정규화 문장, 원문)]"""
    out = []
    for d in dirs:
        for f in sorted(list(Path(d).glob('*.md')) + list(Path(d).glob('*.txt'))):
            for line in f.read_text(encoding='utf-8').splitlines():
                line = _STAMP.sub('', line).strip()
                if not line or line.startswith(('#', '- ')):
                    continue
                out += [(f.stem, norm(s), s) for s in split_sentences(line) if len(norm(s)) >= MIN_LEN]
    return out


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


def lane_refs(lane):
    cfg = json.loads(CONFIG.read_text(encoding='utf-8'))
    return [ROOT / d for d in cfg['lanes'][lane]['refs']]


def check(script, refs_dirs, th=0.7):
    """→ {'hits': [{ratio, mine, ref_file, ref}], 'mine': n, 'refs': n, 'error': str|None}"""
    missing = [str(d) for d in refs_dirs if not Path(d).is_dir()]
    refs = ref_sentences([d for d in refs_dirs if Path(d).is_dir()])
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
    if not refs:
        if not lane:
            lane = 'nenkin_ja'   # 옛 연금JA 호출(인자 없이)과 같은 기본값
        refs = lane_refs(lane)
    res = check(argv[0], refs, th)
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
