# -*- coding: utf-8 -*-
"""볼케이노 실행기가 **언제 무엇을 바꿨는지** 센다. 자체 렌더러를 따라 붙이기 위한 눈.

    python scripts/volcano_runner_watch.py              바뀐 것을 보여주고 기준선을 갱신한다
    python scripts/volcano_runner_watch.py --check      보여주기만(기준선을 안 건드린다)
    python scripts/volcano_runner_watch.py --diff film_editor.py   그 파일의 옛→새 차이
    python scripts/volcano_runner_watch.py --log        지금까지 잡은 변화 이력

왜 (2026-10-08 소유주: "자체 렌더를 만들어서 볼케이노를 쓰면서도 언제든 독립할수 있는
    준비를 하고싶어. 자체적으로 만들어놓고 볼케이노의 업데이트 변화를 감지해서
    우리도 업데이트 할수 있도록 말이야")

  실행기는 **스스로 갱신된다.** 그리고 그 갱신이 우리를 깬 적이 있다 —
  2026-10-08 하루에 세 번 갱신됐고(01:35·01:54·03:46), 그중 하나가 렌더 지문 계산을
  바꿔 **AGY 카메라를 쓰는 모든 회차가 finish 에서 떨어지게** 만들었다(사례 165).
  우리는 그걸 회차가 죽고 나서야 알았다. 실비를 태운 뒤였다.

어디를 보나 — 갱신의 흔적이 디스크에 남는다
  `<워크디렉토리>/runner/*.py`                      지금 돌고 있는 판
  `<워크디렉토리>/.volcano-runner-update/replaced/<id>/`  갈아끼우기 **전** 파일(옛 판)
  실측 2026-10-08: `shorts_framing.py` 가 78 → 88 → 101 줄로 하루에 두 번 바뀌었다.

★워크디렉토리마다 실행기 판이 다르다. «가장 최근에 받은 것»을 현재 판으로 본다.
★이 도구는 **읽기만** 한다. 실행기를 고치지 않는다(«검증된 실행 코드» — 고치면 서버와 갈라진다).
"""
import argparse
import datetime as dt
import difflib
import hashlib
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = 'D:/volcano-runs'
STATE = os.path.join(ROOT, 'server', 'data', 'volcano_runner_watch.json')

# 렌더 결과를 직접 좌우하는 것들. 바뀌면 크게 알린다.
HOT = (
    'film_editor.py', 'film_continuity.py', 'film_caption.py', 'film_tracks.py',
    'film_word_audio.py', 'shorts_framing.py', 'subject_agy.py', 'subject_focus.py',
    'volcano_run.py', 'volcano_drive.py',
)


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        h.update(fh.read())
    return h.hexdigest()


def newest_runner():
    """워크디렉토리마다 판이 다르다 — 파일별로 **가장 최근에 받은 것**을 현재 판으로 본다."""
    best = {}
    if not os.path.isdir(RUNS):
        return best
    for wd in os.listdir(RUNS):
        d = os.path.join(RUNS, wd, 'runner')
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if not name.endswith('.py'):
                continue
            p = os.path.join(d, name)
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            if name not in best or m > best[name][1]:
                best[name] = (p, m)
    return best


def old_copies(name):
    """갈아끼우기 전 파일들 — 새것과 견줄 짝. (시각, 경로) 로 돌려준다."""
    out = []
    if not os.path.isdir(RUNS):
        return out
    for wd in os.listdir(RUNS):
        rep = os.path.join(RUNS, wd, '.volcano-runner-update', 'replaced')
        if not os.path.isdir(rep):
            continue
        for h in os.listdir(rep):
            p = os.path.join(rep, h, name)
            if os.path.isfile(p):
                out.append((os.path.getmtime(p), p, h))
    out.sort()
    return out


def lines(p):
    try:
        return io.open(p, encoding='utf-8', errors='replace').read().splitlines()
    except OSError:
        return []


def cmd_diff(name):
    cur = newest_runner().get(name)
    if not cur:
        print(f'{name} 를 실행기에서 못 찾았다'); return 1
    olds = old_copies(name)
    if not olds:
        print(f'{name} 의 옛 판이 없다 — 아직 갈아끼운 적이 없다는 뜻이다'); return 0
    _, oldp, h = olds[-1]
    a, b = lines(oldp), lines(cur[0])
    print(f'{name}: 옛 판 {len(a)}줄({h}) → 지금 {len(b)}줄')
    print(f'  옛: {oldp}')
    print(f'  새: {cur[0]}\n')
    n = 0
    for ln in difflib.unified_diff(a, b, lineterm='', n=2):
        if ln.startswith('---') or ln.startswith('+++'):
            continue
        print('  ' + ln[:150])
        n += 1
        if n > 160:
            print('  … (잘랐다. 전체는 위 두 경로를 직접 비교하라)')
            break
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='기준선을 갱신하지 않는다')
    ap.add_argument('--diff', help='이 파일의 옛→새 차이를 본다')
    ap.add_argument('--log', action='store_true')
    args = ap.parse_args()

    state = read_json(STATE, {'baseline': {}, 'events': []})
    if args.log:
        for e in state['events'][-25:]:
            print(f"{e['at'][:16]}  바뀜 {len(e['changed'])} · 새로 {len(e['added'])} · 사라짐 {len(e['removed'])}"
                  f"{'  ★' + ', '.join(e['hot']) if e.get('hot') else ''}")
            for c in e['changed'][:8]:
                print(f"    {c['name']:26} {c['was_lines']:>5} → {c['now_lines']:<5}줄")
        return 0
    if args.diff:
        return cmd_diff(args.diff)

    cur = newest_runner()
    if not cur:
        print(f'{RUNS} 에서 실행기를 못 찾았다'); return 1
    base = state.get('baseline') or {}
    now = {}
    for name, (p, m) in cur.items():
        now[name] = {'sha': sha(p), 'lines': len(lines(p)),
                     'at': dt.datetime.fromtimestamp(m).isoformat(timespec='seconds'), 'path': p}

    added = sorted(set(now) - set(base))
    removed = sorted(set(base) - set(now))
    changed = [{'name': n, 'was': base[n]['sha'][:8], 'now': now[n]['sha'][:8],
                'was_lines': base[n]['lines'], 'now_lines': now[n]['lines'], 'at': now[n]['at']}
               for n in sorted(now) if n in base and base[n]['sha'] != now[n]['sha']]
    hot = [c['name'] for c in changed if c['name'] in HOT] + [n for n in added if n in HOT]

    print(f'실행기 파일 {len(now)}개 (기준선 {len(base)}개)')
    if not base:
        print('  첫 실행 — 기준선을 세운다. 다음부터 바뀐 것만 보여준다.')
    if changed:
        print(f'\n바뀐 파일 {len(changed)}개')
        for c in changed:
            mark = ' ★렌더에 직접 영향' if c['name'] in HOT else ''
            print(f"  {c['name']:26} {c['was_lines']:>5} → {c['now_lines']:<5}줄  "
                  f"{c['was']}→{c['now']}  {c['at'][5:16]}{mark}")
    if added:
        print(f"\n새 파일 {len(added)}개: {', '.join(added)}")
    if removed:
        print(f"\n사라진 파일 {len(removed)}개: {', '.join(removed)}")
    if not (changed or added or removed) and base:
        print('  변화 없음')

    if hot:
        print(f"\n★★렌더 결과를 바꿀 수 있는 파일이 {len(hot)}개 바뀌었다: {', '.join(hot)}")
        print('   차이를 보라:  python scripts/volcano_runner_watch.py --diff <파일>')
        print('   우리 자체 렌더러가 같은 동작을 하는지 맞춰 보라.')

    if not args.check:
        if changed or added or removed:
            state['events'] = (state.get('events') or []) + [{
                'at': dt.datetime.now().isoformat(timespec='seconds'),
                'changed': changed, 'added': added, 'removed': removed, 'hot': hot}]
            state['events'] = state['events'][-200:]
        state['baseline'] = now
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with io.open(STATE, 'w', encoding='utf-8') as fh:
            json.dump(state, fh, ensure_ascii=False, indent=1)
        print(f'\n기준선 갱신 · {STATE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
