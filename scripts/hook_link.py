# -*- coding: utf-8 -*-
"""후킹 ↔ 기획 한 문장 연결 검사(10-21 자료 점검 G2) — plan.hook 과 spec.vicarious 에 공통 명사가 하나는 있어야 한다.
«후킹 = 기획 한 문장»: 0~2초 후킹이 기획에서 정한 대리만족과 다른 걸 말하면 끌어 놓고 딴 얘기다.

    python scripts/hook_link.py <plan.json|spec.json|폴더> [--spec spec.json] [--lang ko|ja] [--enforce-now]

hook: str 또는 {visual, audio, text} 를 합친 글. vicarious: 문자열(«(근거: …)» 괄호는 뺀다).
한 파일에 둘 다 있으면 그 파일만(팬튜브 spec·롱투숏 plan). 따로면 --spec.
종료 코드: 0 연결됨 · 4 공통 명사 0 · 5 검사 불가(hook 또는 vicarious 없음) — server/data/gate_errors.jsonl.
유예: ENFORCE_FROM(2026-10-23 00:00 KST) 전에는 4·5 를 «유예» 줄로만 찍고 0.

import(plan_gate·publish.js·own_check):
    sys.path.insert(0, 'D:/midform/scripts'); from hook_link import link
    link(hook, vicarious, lang='ko') → {'ok': bool, 'common': [...], 'hook_nouns': [...], 'vic_nouns': [...]}
    node 쪽은 CLI 종료 코드를 쓴다(--json 은 한 줄 JSON).
"""
import datetime as _dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
ENFORCE_FROM = _dt.datetime(2026, 10, 23, 0, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))
JOSA = ('에게서', '한테서', '에서는', '으로는', '이라도', '까지는', '부터는', '에게', '한테', '에서', '으로', '까지', '부터', '처럼', '보다',
        '이랑', '하고', '은', '는', '이', '가', '을', '를', '에', '의', '도', '로', '와', '과', '만', '랑')
STOP = {'여러분', '오늘', '정말', '진짜', '지금', '그냥', '이것', '그것', '저것', '이거', '그거', '우리', '사람', '때문', '하나', '이번', '처음',
        '다음', '모두', '전부', '부분', '정도', '근거', '대신', '느끼는', '감정', '상단', '하단', '자막', '화면', '첫', '0초', 'TTS', 'BGM'}


def _text(x):
    if isinstance(x, dict):
        return ' '.join(_text(v) for k, v in x.items() if not str(k).startswith('_'))
    if isinstance(x, list):
        return ' '.join(_text(v) for v in x)
    return str(x or '')


def nouns(text, lang='ko'):
    """명사 어림 — ko: 한글 2자+ 낱말에서 조사를 떼고 앞 2자 이상, ja: 한자·가타카나 2자+ 덩어리."""
    text = re.sub(r'\((근거|출처)[^)]*\)', ' ', text or '')
    if lang == 'ja':
        return list(dict.fromkeys(w for w in re.findall(r'[一-龥々]{2,}|[ァ-ヶー]{2,}', text) if w not in STOP))
    out = []
    for w in re.findall(r'[가-힣A-Za-z]{2,}', text):
        for j in JOSA:
            # 한 글자 명사는 조사가 붙은 꼴(«밭은»·«물에»)일 때만 뗀다 — 조사 낱말은 한 글자짜리를 빼면 남는 게 명사다
            if w.endswith(j) and len(w) - len(j) >= (1 if len(j) == 1 or j in ('에서', '으로', '까지', '부터') else 2):
                w = w[:-len(j)]
                break
        if w not in STOP:
            out.append(w)
    return list(dict.fromkeys(out))


def link(hook, vicarious, lang='ko'):
    hn, vn = nouns(_text(hook), lang), nouns(_text(vicarious), lang)
    vt = re.sub(r'\s', '', _text(vicarious))
    # 같은 낱말이거나, 한쪽 낱말(2자+)이 다른 쪽 글에 그대로 들어 있으면 공통(«해원이»↔«해원에게서»)
    common = [w for w in hn if w in vn or (len(w) >= 2 and w in vt)]   # 한 글자는 양쪽 다 «명사+조사» 꼴에서 나온 것만
    return {'ok': bool(common), 'common': common, 'hook_nouns': hn[:12], 'vic_nouns': vn[:12]}


def _load(p):
    p = Path(p)
    if p.is_dir():
        p = next((p / n for n in ('plan.json', 'spec.json', 'plan_local.json') if (p / n).exists()), p / 'plan.json')
    return json.loads(p.read_text(encoding='utf-8'))


def check(path, spec=None, lang='ko', now=None, enforce=None):
    now = now or _dt.datetime.now(_dt.timezone.utc)
    enforce = (now >= ENFORCE_FROM) if enforce is None else enforce
    try:
        plan = _load(path)
        sp = _load(spec) if spec else plan
        hook, vic = plan.get('hook'), sp.get('vicarious') or plan.get('vicarious')
        if not _text(hook).strip() or not _text(vic).strip():
            raise ValueError(f'{"hook" if not _text(hook).strip() else "vicarious"} 없음')
        r = link(hook, vic, lang)
        r['code'] = 0 if r['ok'] else 4
    except (OSError, ValueError, AttributeError, json.JSONDecodeError) as e:
        r = {'ok': False, 'code': 5, 'error': f'검사 불가: {e}', 'common': []}
    r.update(path=str(path), enforced=enforce, exit=r['code'] if enforce else 0)
    return r


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = list(sys.argv[1:] if argv is None else argv)
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    spec, lang = opt('--spec'), opt('--lang') or 'ko'
    args = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] not in ('--spec', '--lang'))]
    if not args:
        print(__doc__)
        return 5
    r = check(args[0], spec, lang, enforce=True if '--enforce-now' in argv else None)
    if r['code'] == 5:
        try:
            LEDGER.parent.mkdir(parents=True, exist_ok=True)
            with LEDGER.open('a', encoding='utf-8') as fh:
                fh.write(json.dumps({'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'hook_link', 'script': args[0], 'error': r['error']}, ensure_ascii=False) + '\n')
        except OSError as e:
            print(f'⚠ 장부 기록 실패: {e}')
    if '--json' in argv:
        print(json.dumps(r, ensure_ascii=False))
    else:
        pre = '' if r['enforced'] else '[유예 ~10-23] '
        if r['code'] == 0:
            print(f'✓ 후킹↔기획 공통 명사 {"·".join(r["common"][:5])} · {args[0]}')
        elif r['code'] == 4:
            print(f'✗ {pre}후킹↔기획 공통 명사 0 — 후킹 {"·".join(r["hook_nouns"][:6])} / 기획 {"·".join(r["vic_nouns"][:6])} · {args[0]}')
        else:
            print(f'✗ {pre}{r["error"]} · {args[0]}')
    return r['exit']


if __name__ == '__main__':
    sys.exit(main())
