# -*- coding: utf-8 -*-
"""태그 관문 공통 낱말 검사 — 공용(10-20 관리자 큐, 카이안 K6 «태그는 내용 일치만·제목·설명·태그 공통 낱말»).
레인 yt_tags.js(업로드 뒤 태그 넣기·확인)는 각 레인 것이라 그대로 두고, 업로드 전에 메타만 본다.

    python scripts/tag_gate.py <upload.json | meta.json | spec.json | packages.json> [--script 원고] [--min 2] [--ratio 0.5] [--fail-on-warn] [--json out]

검사:
  공통   제목·설명 첫 두 줄·태그(+해시태그) 셋 모두에 있는 낱말 수 ≥ --min(기본 2)
  내용   태그 중 원고(--script, 없으면 같은 폴더 script.txt·자막·plan — comment_hook 어댑터)에 나오는 비율 ≥ --ratio(기본 0.5).
         여러 낱말 태그는 낱말마다 본다(packages_gate 와 같은 규칙). 원고를 못 찾으면 이 칸만 «못 잼».
  packages.json 이면 packages_gate.warnings() 를 그대로 부른다(묶음마다).
종료 코드: 0(경고형) · 4 = --fail-on-warn 이고 경고 있음 · 5 = 검사 불가(파일·제목·태그 없음, gate_errors.jsonl).
import: from tag_gate import common_words, tag_content  → common_words(title, desc, tags) · tag_content(tags, body) → (비율, 없는 태그)
"""
import datetime as _dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import comment_hook  # noqa: E402
import packages_gate  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
norm = packages_gate.norm


def desc_head(desc, n=2):
    lines = [l.strip() for l in str(desc or '').splitlines() if l.strip()]
    return ' '.join(lines[:n])


def common_words(title, desc, tags):
    head = norm(desc_head(desc) if '\n' in str(desc) or len(str(desc)) > 0 else '')
    words = list(dict.fromkeys(t.lstrip('#') for t in tags if t))
    return [w for w in words if norm(w) and norm(w) in norm(title) and norm(w) in head]


def tag_content(tags, body):
    b = norm(body)
    if not b:
        return None, []
    tags = [t for t in tags if t]
    miss = [t for t in tags if not all(norm(x) in b for x in t.split())]
    return (1 - len(miss) / len(tags)) if tags else None, miss


def _body(path, scripts):
    try:
        if scripts:
            return '\n'.join(l for s in scripts for l in comment_hook.body_from(s))
        _, _, body, _, _ = comment_hook.load(path)
        return '\n'.join(body)
    except (OSError, ValueError, KeyError):
        return ''


def check(path, scripts=None, min_common=2, min_ratio=0.5):
    p = Path(path)
    d = json.loads(p.read_text(encoding='utf-8'))
    if 'packages' in d:
        _, lines = packages_gate.warnings(p.parent)
        return {'path': str(p), 'kind': 'packages', 'warnings': lines}
    title = d.get('title') or ''
    if isinstance(title, list):
        title = ' '.join(map(str, title))
    desc = d.get('description') or '\n'.join(map(str, d.get('desc_head') or []))
    tags = list(d.get('tags') or []) + [h for h in (d.get('hashtags') or [])] + re.findall(r'#(\S+)', str(desc))
    if not title or not tags:
        raise ValueError('제목 또는 태그 없음')
    com = common_words(title, desc, tags)
    ratio, miss = tag_content(d.get('tags') or [], _body(p, scripts))
    W = []
    if len(com) < min_common:
        W.append(f'제목·설명 두 줄·태그 공통 낱말 {len(com)}개 {com} (≥{min_common})')
    if ratio is None:
        W.append('원고를 못 찾음 — 태그-내용 일치 못 잼(--script 로 지정)')
    elif ratio < min_ratio:
        W.append(f'원고에 나오는 태그 {ratio:.0%} (≥{min_ratio:.0%}) · 없는 태그 {miss[:8]}')
    return {'path': str(p), 'kind': 'upload', 'common': com, 'ratio': ratio, 'missing': miss, 'warnings': W}


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k, dflt=None: argv[argv.index(k) + 1] if k in argv else dflt
    scripts = [argv[i + 1] for i, a in enumerate(argv) if a == '--script'] or None
    try:
        res = check(argv[0], scripts, int(opt('--min', 2)), float(opt('--ratio', 0.5)))
    except (OSError, ValueError, KeyError, IndexError) as e:
        print(f'⚠ 태그 관문 검사 불가: {e} — 통과로 치지 않음(종료 5)')
        try:
            LEDGER.parent.mkdir(parents=True, exist_ok=True)
            with LEDGER.open('a', encoding='utf-8') as fh:
                fh.write(json.dumps({'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'tag_gate',
                                     'script': argv[0] if argv else '', 'error': str(e)}, ensure_ascii=False) + '\n')
        except OSError as e2:
            print(f'⚠ 장부 기록 실패: {e2}')
        return 5
    if opt('--json'):
        Path(opt('--json')).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for w in res['warnings']:
        print(f'  △ {w}')
    ratio = res.get('ratio')
    extra = '' if res['kind'] == 'packages' else f' · 공통 {res["common"]} · 원고 일치 {"-" if ratio is None else format(ratio, ".0%")}'
    print(f'{"△" if res["warnings"] else "✓"} 태그 관문 {Path(argv[0]).name}{extra} · 경고 {len(res["warnings"])}건')
    return 4 if (res['warnings'] and '--fail-on-warn' in argv) else 0


if __name__ == '__main__':
    sys.exit(main())
