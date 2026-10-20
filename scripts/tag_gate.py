# -*- coding: utf-8 -*-
"""태그 관문 공통 낱말 검사 — 공용(10-20 관리자 큐, 카이안 K6 «태그는 내용 일치만·제목·설명·태그 공통 낱말»).
레인 yt_tags.js(업로드 뒤 태그 넣기·확인)는 각 레인 것이라 그대로 두고, 업로드 전에 메타만 본다.

    python scripts/tag_gate.py <upload.json | meta.json | spec.json | packages.json | *.rinbox.json> [--lane rinbox] [--script 원고] [--min 2] [--ratio 0.5] [--fail-on-warn] [--json out]

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
# 레인 규칙(10-20 관리자 명세, 린박스 134ja 실측): 린박스 설명은 머리 두 줄이 고정 문구(원작 유도·時代劇 안내)라 건너뛰고 «그다음 첫 문단»을
# 설명 머리로 본다. 원고 일치 분모에서 장르·shorts·채널명 태그를 빼고, 작품명·배우명 태그는 work/cast 필드나 설명란 출연·제작 줄에 있으면 일치.
# 공통 낱말(제목·설명 머리·태그 셋 다) ≥2 는 그대로.
LANES = {
    'rinbox': {'fixed': [r'フルバージョン', r'時代劇作品の場面と歴史背景', r'풀버전', r'사극 작품의 장면'], 'head_lines': 1,
               'generic': ['shorts', 'short', 'Shorts', '時代劇', 'ドラマ', '名場面', '捕物帳', '쇼츠', '드라마', '명장면', '사극',
                           '沼落ちシネマ', '냐옹시네마', '지구관측소'],
               'credit': r'(出演|制作|출연|제작)'},
}


def lane_of(path, lane=None):
    return lane or ('rinbox' if str(path).endswith('.rinbox.json') else None)


def desc_head(desc, n=2, skip=()):
    lines = [l.strip() for l in str(desc or '').splitlines() if l.strip()]
    if skip:   # 고정 문구 줄은 앞에서부터 건너뛴다
        while lines and any(re.search(s, lines[0]) for s in skip):
            lines.pop(0)
    return ' '.join(lines[:n])


def common_words(title, desc, tags, skip=(), n=2):
    head = norm(desc_head(desc, n, skip))
    words = list(dict.fromkeys(t.lstrip('#') for t in tags if t))
    return [w for w in words if norm(w) and norm(w) in norm(title) and norm(w) in head]


def tag_content(tags, body, generic=()):
    b = norm(body)
    if not b:
        return None, []
    tags = [t for t in tags if t and t.lstrip('#') not in generic]
    miss = [t for t in tags if not all(norm(x) in b for x in t.split())]
    return (1 - len(miss) / len(tags)) if tags else None, miss


def _body(path, scripts, lane=None):
    try:
        if scripts:
            return '\n'.join(l for s in scripts for l in comment_hook.body_from(s))
        if lane == 'rinbox':   # 사이드카 옆(또는 위) plan_local.json — 해설 카드 + 대사 자막, work·cast 필드
            p = Path(path)
            plan = next((c for c in (p.parent / 'plan_local.json', p.parent.parent / 'plan_local.json') if c.exists()), None)
            if not plan:
                return ''
            _, d, body, _, _ = comment_hook.load(plan, 'rinbox')
            extra = [str(d.get('work') or ''), ' '.join(map(str, d.get('cast') or []))] if isinstance(d, dict) else []
            return '\n'.join(body + extra)
        _, _, body, _, _ = comment_hook.load(path)
        return '\n'.join(body)
    except (OSError, ValueError, KeyError):
        return ''


def check(path, scripts=None, min_common=2, min_ratio=0.5, lane=None):
    p = Path(path)
    lane = lane_of(p, lane)
    L = LANES.get(lane, {})
    d = json.loads(p.read_text(encoding='utf-8'))
    if 'packages' in d:
        _, lines = packages_gate.warnings(p.parent)
        return {'path': str(p), 'kind': 'packages', 'warnings': lines}
    title = d.get('title') or ''
    if isinstance(title, list):
        title = ' '.join(map(str, title))
    desc = d.get('description') or '\n'.join(map(str, d.get('desc_head') or []))
    kw = [k if isinstance(k, str) else str(k.get('kw') or k.get('keyword') or '') for k in (d.get('keywords') or [])] if isinstance(d.get('keywords'), list) else []
    base_tags = list(d.get('tags') or []) or kw   # 쇼핑 메타는 tags 대신 keywords(유튜브 태그로 쓰임)
    tags = base_tags + [h for h in (d.get('hashtags') or [])] + re.findall(r'#(\S+)', str(desc))
    if not title or not tags:
        raise ValueError('제목 또는 태그 없음')
    com = common_words(title, desc, tags, L.get('fixed', ()), L.get('head_lines', 2))
    body = _body(p, scripts, lane)
    if L.get('credit'):   # 작품명·배우명: 사이드카 work/cast + 설명란 출연·제작 줄
        body += '\n' + ' '.join(str(d.get(k) or '') for k in ('work', 'cast')) + '\n' + \
            '\n'.join(l for l in str(desc).splitlines() if re.search(L['credit'], l))
    ratio, miss = tag_content(base_tags, body, L.get('generic', ()))
    W = []
    if len(com) < min_common:
        W.append(f'제목·설명 두 줄·태그 공통 낱말 {len(com)}개 {com} (≥{min_common})')
    if ratio is None:
        W.append('원고를 못 찾음 — 태그-내용 일치 못 잼(--script 로 지정)')
    elif ratio < min_ratio:
        W.append(f'원고에 나오는 태그 {ratio:.0%} (≥{min_ratio:.0%}) · 없는 태그 {miss[:8]}')
    return {'path': str(p), 'kind': 'upload', 'lane': lane, 'common': com, 'ratio': ratio, 'missing': miss, 'warnings': W}


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k, dflt=None: argv[argv.index(k) + 1] if k in argv else dflt
    scripts = [argv[i + 1] for i, a in enumerate(argv) if a == '--script'] or None
    try:
        res = check(argv[0], scripts, int(opt('--min', 2)), float(opt('--ratio', 0.5)), opt('--lane'))
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
