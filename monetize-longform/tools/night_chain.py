# -*- coding: utf-8 -*-
"""수창 밤 사슬 — 편을 차례로 돌리되, 편 하나가 끝날 때마다 쇼핑에 한 회차를 양보한다(관리자 10-22 21:5x).

    python -X utf8 monetize-longform/tools/night_chain.py ep_ko04:ko:--render-only ep_ja03:ja ep_ko06:ko ...

편 사이 양보 규칙(오늘 아침 규칙과 같음):
  ① 편이 끝나 락이 풀린 뒤 10분 동안 쇼핑이 자리를 잡는지 본다(§10 «- 쇼핑(…): 쇼핑 시작» 줄 또는 RENDERING.lock 의 쇼핑 라벨).
  ② 잡았으면 «쇼핑 끝» 줄 또는 락 해제까지(상한 90분) 기다린다. 10분 안에 안 잡으면 쇼핑 회차가 없는 것으로 보고 바로 다음 편.
  ③ 관리자 10-22 23:4x: 07:00 이후 처음 락이 비는 틈은 정치(10/23편, 70~80분)에 — 양보 대기 중 정치가 락(JSON, "episode")을 잡으면
     §10 «- 정치 ko(…): M/D 렌더 끝 — 성공» 줄까지 기다린 뒤(상한 150분) 다시 쇼핑 양보부터. 순서 = 정치 → 쇼핑(대기 중이면) → 수창.
각 편 사슬(chain_ko/chain_ja)은 락·메모리·C:·정치 창(정치 렌더 끝 표식) 관문을 스스로 확인한다.
로그: monetize-longform/night_chain.log.
"""
import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seg_prune  # noqa: E402

ROOT = Path('D:/midform')
PY = [sys.executable, '-X', 'utf8']
HAND = ROOT / 'docs' / 'handoff-manager-20261014.md'
LOCK = ROOT / 'politics-hour' / 'RENDERING.lock'
LOG = ROOT / 'monetize-longform' / 'night_chain.log'
GRACE_MIN = 10
SHOP_MAX_MIN = 90


def log(m):
    s = f'{dt.datetime.now():%m-%d %H:%M:%S} {m}'
    print(s, flush=True)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(s + '\n')


def hand_lines():
    try:
        return HAND.read_text(encoding='utf-8').splitlines()
    except Exception:
        return []


def lock_kind():
    """'' / 'monetize' / 'politics'(render_episode.py 의 JSON 락: {"pid","episode",...}) / 'shop'(그 밖의 라벨)."""
    try:
        if not LOCK.exists():
            return ''
        t = LOCK.read_text(encoding='utf-8').strip()
    except Exception:
        return ''
    if t.startswith('monetize'):
        return 'monetize'
    if t.startswith('{') and '"episode"' in t:
        try:
            epn = str(json.loads(t).get('episode', ''))
        except ValueError:
            epn = ''
        return 'monetize' if epn.startswith(('corp ', 'monetize')) else 'politics'   # corp_render 자체 락(10-22n)도 JSON — 정치로 오인 금지
    return 'shop'


def shop_lock():
    return lock_kind() == 'shop'


def politics_done_line(n0):
    now = dt.datetime.now()
    tag = f'{now.month}/{now.day}'
    return any(l.startswith(('- 정치 ko(', '- 관리자(')) and tag in l and '렌더 끝' in l and '성공' in l and '실패' not in l for l in hand_lines()[n0:])


def wait_politics(n0):
    """정치가 락을 잡았다 — «렌더 끝 — 성공» 줄(§10, 오늘 날짜)이 오고 락이 없을 때까지(상한 150분)."""
    log('정치가 자리를 잡음 — §10 «M/D 렌더 끝 — 성공» 줄과 락 해제까지 대기(상한 150분)')
    t0 = dt.datetime.now()
    while dt.datetime.now() < t0 + dt.timedelta(minutes=150):
        if politics_done_line(n0) and lock_kind() != 'politics':
            log('정치 렌더 끝 — 성공 줄 확인 · 락 없음')
            return
        if lock_kind() != 'politics':
            time.sleep(120)
            if lock_kind() != 'politics' and politics_done_line(n0):
                log('정치 렌더 끝 — 성공 줄 확인')
                return
        time.sleep(60)
    log('정치 대기 상한 150분 경과 — 넘어감')


def shop_lines(n0, word):
    return any(l.lstrip().startswith('- 쇼핑') and word in l for l in hand_lines()[n0:])


def pending(wait_word, done_word):
    """§10 에 «<wait_word>» 줄이 있고 그 뒤에 «<done_word>» 줄이 없으면 그 레인이 먼저다(관리자 10-23 11:5x 정치 쇼츠, 13:0x 연금 움직임)."""
    lines = [l for l in hand_lines()[-400:] if not l.startswith('- 수창(')]   # 수창 자신의 보고 줄(낱말 설명)은 신호로 안 본다
    last_wait = max((i for i, l in enumerate(lines) if wait_word in l), default=-1)
    if last_wait < 0:
        return False
    return not any(done_word in l for l in lines[last_wait + 1:])


def politics_shorts_pending():
    return pending('정치 쇼츠 대기', '정치 쇼츠 끝')


def yield_to(label, wait_word, done_word, grace_min=15, max_min=90):
    """양보 한 단계: 락이 빈 뒤 grace_min 안에 그 레인이 락을 잡으면 락 해제 또는 «done_word» 줄까지(상한 max_min) 기다린다."""
    log(f'{wait_word} 줄 있음 — {grace_min}분 안에 {label}이(가) 자리를 잡는지 본다')
    t0 = dt.datetime.now()
    while dt.datetime.now() < t0 + dt.timedelta(minutes=grace_min):
        if LOCK.exists() and lock_kind() != 'monetize':
            log(f'{label}이(가) 자리를 잡음(락 {lock_kind()}) — 락 해제 또는 «{done_word}» 줄까지 대기(상한 {max_min}분)')
            t1 = dt.datetime.now()
            while dt.datetime.now() < t1 + dt.timedelta(minutes=max_min):
                if not pending(wait_word, done_word) and not LOCK.exists():
                    log(f'«{done_word}» 줄 확인 · 락 없음')
                    return
                if not LOCK.exists():
                    time.sleep(90)
                    if not LOCK.exists():
                        log(f'{label} 락 해제 확인')
                        return
                time.sleep(60)
            log(f'{label} 대기 상한 {max_min}분 경과 — 넘어감')
            return
        if not pending(wait_word, done_word):
            log(f'«{done_word}» 줄 확인 — 다음 양보로')
            return
        time.sleep(30)
    log(f'{label}이(가) {grace_min}분 안에 자리를 안 잡음 — 다음 양보로')


YIELD_ORDER = [('정치 쇼츠', '정치 쇼츠 대기', '정치 쇼츠 끝'), ('연금 움직임', '연금 움직임 대기', '연금 움직임 끝')]   # 관리자 10-23: 정치 쇼츠 → 연금 움직임 → 쇼핑 → 수창


def yield_to_shop():
    for label, w, d in YIELD_ORDER:
        if pending(w, d):
            yield_to(label, w, d)
    n0 = len(hand_lines())
    t0 = dt.datetime.now()
    log(f'양보 대기: {GRACE_MIN}분 안에 쇼핑이 자리를 잡는지 본다(§10 기준 줄 {n0})')
    taken = False
    while dt.datetime.now() < t0 + dt.timedelta(minutes=GRACE_MIN):
        if lock_kind() == 'politics':          # 정치 → 쇼핑 → 수창
            wait_politics(n0)
            return yield_to_shop()
        if shop_lock() or shop_lines(n0, '쇼핑 시작'):
            taken = True
            break
        time.sleep(30)
    if not taken:
        log('쇼핑 회차 없음 — 바로 다음 편')
        return
    log('쇼핑이 자리를 잡음 — «쇼핑 끝» 또는 락 해제까지 대기(상한 90분)')
    t1 = dt.datetime.now()
    while dt.datetime.now() < t1 + dt.timedelta(minutes=SHOP_MAX_MIN):
        if shop_lines(n0, '쇼핑 끝') and '쇼핑 시작' not in ''.join(l for l in hand_lines()[n0:] if '쇼핑 끝' in l):
            log('«쇼핑 끝» 확인')
            return
        if not LOCK.exists():
            time.sleep(60)
            if not LOCK.exists() and not shop_lock():
                log('쇼핑 락 해제 확인')
                return
        time.sleep(60)
    log('쇼핑 상한 90분 경과 — 넘어감')


def main(items):
    log(f'night_chain 시작: {" ".join(items)}')
    for i, it in enumerate(items):
        parts = it.split(':')
        if parts[0] == 'wait':            # wait:<ep> — 다른 실행이 돌리는 편 사슬(<ep>/chain.running)이 끝날 때까지 기다린 뒤 양보
            running = ROOT / 'monetize-longform' / parts[1] / 'chain.running'
            log(f'[{i + 1}/{len(items)}] {parts[1]} 사슬(다른 실행) 끝 대기')
            while running.exists():
                time.sleep(60)
            log(f'[{i + 1}/{len(items)}] {parts[1]} 사슬 끝 확인')
            if i + 1 < len(items):
                yield_to_shop()
            continue
        ep, lang, extra = parts[0], parts[1], parts[2:]
        freed, names = seg_prune.prune(log)   # 업로드 끝난 편(video_id)의 seg/ 자동 정리 — 관리자 10-23 D: 3.4GB 사고
        log(f'seg 자동 정리: {freed}MB {names} · D: {seg_prune.disk_d_gb():.1f}GB')
        tool = 'chain_ko.py' if lang == 'ko' else 'chain_ja.py'
        cmd = PY + [f'monetize-longform/tools/{tool}', f'monetize-longform/{ep}'] + extra
        log(f'[{i + 1}/{len(items)}] {ep} 시작: {" ".join(cmd[3:])}')
        with LOG.open('a', encoding='utf-8') as f:
            r = subprocess.run(cmd, cwd=str(ROOT), stdout=f, stderr=subprocess.STDOUT)
        log(f'[{i + 1}/{len(items)}] {ep} 종료 {r.returncode}')
        if i + 1 < len(items):
            yield_to_shop()
    log('night_chain 끝')


if __name__ == '__main__':
    main(sys.argv[1:])
