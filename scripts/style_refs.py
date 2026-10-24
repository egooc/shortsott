# -*- coding: utf-8 -*-
"""화풍 기준 그림 검사·첨부 — 공용(10-24 §7: 소유주 «화풍 존나 올드 AI 같애 · 레퍼런스 캡처해서 GPT한테 시키면 알아서 맞춰준다»).

그림을 GPT 로 만들 때는 레퍼런스 터진 편 화면 3~5장을 요청에 붙여 화풍을 맞춘다. 기준 = 수창 monetize-longform/tools/gen_images.py --style-ref.

    python scripts/style_refs.py <img_prompts.json|plan.json>        json 의 style_refs(또는 _style_refs) 목록 검사
    python scripts/style_refs.py --refs a.jpg b.jpg c.jpg             경로를 바로 검사
                                 [--enforce-now] [--json]
종료 코드: 0 통과 · 4 FAIL(style_refs 비었음·파일 없음·그림 아님) — ENFORCE_FROM(10-25 00:00 KST) 전에는 알림만 찍고 0.
3장 미만·5장 초과는 경고(△)만. json 안 상대 경로는 그 json 폴더 기준.

import:
    from style_refs import check, attach_args, STYLE_NOTE
    r = check(refs)                 # dict(ok, code, errors, warnings, refs=절대 경로 목록)
    cmd += attach_args(r['refs'])   # ['--attach', a, '--attach', b, ...] → gpt-ask.js
    prompt = style + STYLE_NOTE + 장면   # 붙인 그림은 화풍만, 내용은 따라 하지 말 것
"""
import datetime as _dt
import json
import sys
from pathlib import Path

KST = _dt.timezone(_dt.timedelta(hours=9))
ENFORCE_FROM = _dt.datetime(2026, 10, 25, 0, 0, tzinfo=KST)
IMG_EXT = {'.png', '.jpg', '.jpeg', '.webp'}
MIN_REFS, MAX_REFS = 3, 5
KEYS = ('style_refs', '_style_refs')
# gen_images.py 와 같은 문장 — 화풍만 가져오고 내용·글자·로고는 베끼지 않는다
STYLE_NOTE = '\n\n붙인 그림은 화풍 기준이다 — 선·색·빛·질감·밝기를 그대로 따르고, 내용(인물·물체·구도·글자·로고)은 따라 하지 말 것.'


def refs_from(path):
    """json 파일 → style_refs 목록(json 폴더 기준 절대 경로). 키가 없으면 []."""
    p = Path(path)
    d = json.loads(p.read_text(encoding='utf-8'))
    raw = next((d[k] for k in KEYS if isinstance(d, dict) and k in d), [])
    if isinstance(raw, str):
        raw = [raw]
    return [str((p.parent / r).resolve()) if not Path(r).is_absolute() else str(Path(r)) for r in raw or []]


def check(refs, enforce=None, now=None):
    refs = [str(r) for r in (refs or []) if str(r).strip()]
    errs, warns = [], []
    if not refs:
        errs.append('style_refs 비었음 — 레퍼런스 터진 편 화면 3~5장을 붙여야 한다(§7 10-24)')
    for r in refs:
        p = Path(r)
        if not p.exists():
            errs.append(f'style_refs 파일 없음: {r}')
        elif p.suffix.lower() not in IMG_EXT:
            errs.append(f'style_refs 그림 아님: {r}')
    if refs and len(refs) < MIN_REFS:
        warns.append(f'style_refs {len(refs)}장 — {MIN_REFS}~{MAX_REFS}장 권장')
    if len(refs) > MAX_REFS:
        warns.append(f'style_refs {len(refs)}장 — {MAX_REFS}장까지만 붙이는 게 낫다(앞 {MAX_REFS}장)')
    now = now or _dt.datetime.now(KST)
    grace = errs and (enforce is False or (enforce is None and now < ENFORCE_FROM))
    return {'ok': not errs, 'code': 0 if not errs or grace else 4, 'grace': bool(grace), 'errors': errs, 'warnings': warns,
            'refs': [str(Path(r).resolve()) for r in refs][:MAX_REFS]}


def attach_args(refs):
    return [x for r in refs for x in ('--attach', str(r))]


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    enforce = True if '--enforce-now' in argv else None
    if '--refs' in argv:
        refs = [a for a in argv[argv.index('--refs') + 1:] if not a.startswith('--')]
        src = '--refs'
    else:
        src = next((a for a in argv if not a.startswith('--')), None)
        if not src:
            print('usage: style_refs.py <prompts.json> | --refs a b c  [--enforce-now] [--json]')
            return 2
        try:
            refs = refs_from(src)
        except (OSError, ValueError) as e:
            print(f'✗ style_refs 검사 — 입력을 못 읽음: {e}')
            return 4
    r = check(refs, enforce)
    if '--json' in argv:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    for w in r['warnings']:
        print(f'△ {w}')
    if r['errors']:
        head = '[유예 ~10-25] ' if r['grace'] else ''
        print(f'{head}✗ style_refs FAIL — {Path(src).name}')
        for e in r['errors']:
            print(f'  - {e}')
        return r['code']
    print(f'✓ style_refs 통과 — {len(r["refs"])}장')
    return 0


if __name__ == '__main__':
    sys.exit(main())
