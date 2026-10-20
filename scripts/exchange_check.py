# -*- coding: utf-8 -*-
"""쇼츠 주고받기 검사(10-20 소유주 «쇼츠는 주고받는 멘트·반응·대응, 주장 나열 금지») — API 0.

    python scripts/exchange_check.py <plan.json|폴더> [--lane politics_shorts|fantube|longshort] [--enforce-now] [--json]

입력: plan.json 의 beats — [{role, speaker, in, out}], role ∈ attack·reaction·counter·narration·question.
      beats 가 없으면 sequence(정치 쇼츠·린박스 꼴)를 읽는다: 항목의 role, who(없으면 앞 항목 화자를 잇는다),
      source_in/out(=in/out). narration 항목의 길이는 _render/n_<id>.wav → dur → 카드 글자 수/7 순.
검사:
  ① attack ≥1 · reaction ≥1 · counter ≥1                          FAIL
  ② attack 과 counter 의 speaker 가 다른 쌍이 하나는 있어야          FAIL
  ③ 같은 speaker 연속 발언(narration 은 화자 «narration») 합 > 12초  FAIL
  ④ narration 합 > 전체 30%                                          WARN
  ⑤ role 필드가 없는 beat 가 있으면 검사 불가(종료 5, 통과 아님)
레인: politics_shorts(기본) 는 필수, fantube·longshort 는 role 이 하나도 없으면 «검사 생략» 종료 0.
종료 코드: 0 통과 · 4 FAIL · 5 검사 불가 — server/data/gate_errors.jsonl 에 남김.
유예: ENFORCE_FROM(2026-10-22 00:00 KST) 전에는 FAIL·검사 불가를 «유예» 줄로만 찍고 0 (--enforce-now 로 바로 적용).
"""
import datetime as _dt
import json
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
ROLES = ('attack', 'reaction', 'counter', 'narration', 'question')
OPTIONAL_LANES = ('fantube', 'longshort')
RUN_MAX = 12.0
NARR_MAX = 0.30
ENFORCE_FROM = _dt.datetime(2026, 10, 22, 0, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))


class Unreadable(Exception):
    pass


def _wav_sec(p):
    try:
        with wave.open(str(p)) as w:
            return w.getnframes() / float(w.getframerate())
    except (OSError, wave.Error, EOFError):
        return None


def beats_of(plan, base=None):
    """plan → [{role, speaker, in, out, sec}]. role 없는 항목은 role=None 으로 남긴다."""
    if isinstance(plan.get('beats'), list):
        out = []
        for b in plan['beats']:
            a, z = float(b.get('in', 0) or 0), float(b.get('out', 0) or 0)
            out.append({'role': b.get('role'), 'speaker': b.get('speaker') or ('narration' if b.get('role') == 'narration' else None),
                        'in': a, 'out': z, 'sec': max(0.0, z - a)})
        return out
    seq = plan.get('sequence')
    if not isinstance(seq, list):
        raise Unreadable('beats·sequence 가 둘 다 없음')
    cards = {n.get('id'): n for n in plan.get('narration', []) if isinstance(n, dict)}
    out, who, t = [], None, 0.0
    for s in seq:
        if s.get('narration') is not None:
            nid = s['narration']
            sec = _wav_sec(base / '_render' / f'n_{nid}.wav') if base else None
            if sec is None:
                sec = s.get('dur') or len(''.join(cards.get(nid, {}).get('cards', []))) / 7.0
            out.append({'role': s.get('role') or 'narration',   # 해설 카드 항목은 꼴 자체가 narration
                        'speaker': 'narration', 'in': t, 'out': t + sec, 'sec': sec})
        else:
            who = s.get('who') or who
            sec = max(0.0, float(s.get('source_out', 0)) - float(s.get('source_in', 0)))
            out.append({'role': s.get('role'), 'speaker': s.get('speaker') or who, 'in': t, 'out': t + sec, 'sec': sec})
        t += sec
    return out


def runs(beats):
    """같은 화자 연속 구간 → [(speaker, 합 초, 첫 index, 끝 index)]."""
    out = []
    for i, b in enumerate(beats):
        if out and out[-1][0] == b['speaker']:
            sp, sec, a, _ = out[-1]
            out[-1] = (sp, sec + b['sec'], a, i)
        else:
            out.append((b['speaker'], b['sec'], i, i))
    return out


def judge(beats, lane='politics_shorts'):
    if not beats:
        raise Unreadable('beat 가 0개')
    no_role = [i for i, b in enumerate(beats) if not b['role']]
    if no_role and len(no_role) == len(beats) and lane in OPTIONAL_LANES:
        return {'code': 0, 'skipped': True, 'errors': [], 'warnings': [], 'runs': []}
    if no_role:
        raise Unreadable(f'role 없는 beat {len(no_role)}개(#{", #".join(map(str, no_role[:5]))})')
    bad = [b['role'] for b in beats if b['role'] not in ROLES]
    if bad:
        raise Unreadable(f'모르는 role {sorted(set(bad))} — {"·".join(ROLES)} 중 하나')
    errors, warnings = [], []
    have = {r: [b for b in beats if b['role'] == r] for r in ROLES}
    miss = [r for r in ('attack', 'reaction', 'counter') if not have[r]]
    if miss:
        errors.append(f'① {"·".join(miss)} 없음 — 주고받기(공격→반응→대응)가 아니라 한쪽 주장')
    atk, cnt = {b['speaker'] for b in have['attack']}, {b['speaker'] for b in have['counter']}
    if atk and cnt and not any(a != c for a in atk for c in cnt):
        errors.append(f'② attack·counter 화자가 같음({", ".join(sorted(map(str, atk)))}) — 대응은 다른 사람이어야')
    rs = runs(beats)
    for sp, sec, a, z in rs:
        if sp != 'narration' and sec > RUN_MAX:
            errors.append(f'③ {sp} 혼자 {sec:.1f}초 연속(#{a}~#{z}) > {RUN_MAX:.0f}초')
    total = sum(b['sec'] for b in beats) or 1.0
    narr = sum(b['sec'] for b in have['narration'])
    if narr / total > NARR_MAX:
        warnings.append(f'④ 해설 {narr:.1f}초 = {100 * narr / total:.0f}% > {100 * NARR_MAX:.0f}%')
    top = max((r for r in rs if r[0] != 'narration'), key=lambda r: r[1], default=None)
    return {'code': 4 if errors else 0, 'skipped': False, 'errors': errors, 'warnings': warnings, 'total_sec': round(total, 1),
            'speakers': sorted({str(b['speaker']) for b in beats if b['speaker'] != 'narration'}),
            'longest_run': {'speaker': top[0], 'sec': round(top[1], 1)} if top else None,
            'runs': [{'speaker': sp, 'sec': round(sec, 1)} for sp, sec, _, _ in rs]}


def _plan_path(p):
    p = Path(p)
    if p.is_dir():
        for n in ('plan.json', 'plan_local.json'):
            if (p / n).exists():
                return p / n
        raise Unreadable(f'{p} 에 plan.json 없음')
    if not p.exists():
        raise Unreadable(f'{p} 없음')
    return p


def _ledger(path, lane, error):
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        rec = {'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'exchange_check', 'lane': lane,
               'script': str(path), 'error': error}
        with LEDGER.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError as e:
        print(f'⚠ 장부 기록 실패: {e}')


def check(path, lane='politics_shorts', now=None, enforce=None):
    """→ {code, enforced, errors, warnings, ...}. code 는 유예 반영 전 판정, exit 는 반영 후."""
    now = now or _dt.datetime.now(_dt.timezone.utc)
    enforce = (now >= ENFORCE_FROM) if enforce is None else enforce
    try:
        pp = _plan_path(path)
        plan = json.loads(pp.read_text(encoding='utf-8'))
        r = judge(beats_of(plan, pp.parent), lane)
    except (Unreadable, json.JSONDecodeError, OSError, ValueError, TypeError) as e:
        r = {'code': 5, 'skipped': False, 'errors': [f'검사 불가: {e}'], 'warnings': [], 'runs': []}
    r.update(path=str(path), lane=lane, enforced=enforce, exit=r['code'] if enforce else 0)
    return r


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = list(sys.argv[1:] if argv is None else argv)
    lane, as_json, force = 'politics_shorts', '--json' in argv, '--enforce-now' in argv
    argv = [a for a in argv if a not in ('--json', '--enforce-now')]
    if '--lane' in argv:
        i = argv.index('--lane'); lane = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    if not argv:
        print(__doc__)
        return 5
    worst = 0
    for p in argv:
        r = check(p, lane, enforce=True if force else None)
        if r['code'] == 5:
            _ledger(p, lane, r['errors'][0])
        if as_json:
            print(json.dumps(r, ensure_ascii=False))
        else:
            head = '검사 생략(role 없음 · 선택 레인)' if r['skipped'] else ('통과' if r['code'] == 0 else 'FAIL' if r['code'] == 4 else '검사 불가')
            lr = r.get('longest_run')
            print(f'{p} ({lane}) · {head}' + (f' · 최장 연속 {lr["speaker"]} {lr["sec"]}초 / 전체 {r["total_sec"]}초' if lr else ''))
            pre = '' if r['enforced'] else '[유예 ~10-22] '
            for e in r['errors']:
                print(f'  ✗ {pre}{e}')
            for w in r['warnings']:
                print(f'  △ {w}')
        worst = max(worst, r['exit'])
    return worst


if __name__ == '__main__':
    sys.exit(main())
