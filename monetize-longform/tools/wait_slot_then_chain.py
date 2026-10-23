# -*- coding: utf-8 -*-
"""렌더 자리 양보 대기 → 사슬 시작 (수창, 관리자 10-22 08:0x 규칙).
쇼핑이 handoff-manager §10 에 «쇼핑 끝»을 적을 때까지(상한 분) 기다리고, 그다음 정치 재렌더 완료 줄(정치…재렌더…완료/끝)이 §10에 올라오고
RENDERING.lock·RENDERING-ja.lock 이 없을 때까지(절대 시각 상한) 기다린 뒤 지정한 사슬 .cmd 를 schtasks 로 건다.

    python -X utf8 monetize-longform/tools/wait_slot_then_chain.py <편(ep_ja02)> <chain cmd(chain_ja.cmd)> <since HH:MM> [--shop-max 90] [--pol-until 14:00] [--no-politics]
로그: <편>/wait.log. 줄 판정은 since 시각 이후에 추가된 §10 줄만 본다(파일 길이 기준 — 시작 시점의 줄 수 뒤).
"""
import datetime as dt
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('D:/midform')
HAND = ROOT / 'docs' / 'handoff-manager-20261014.md'
LOCKS = [ROOT / 'politics-hour' / 'RENDERING.lock', ROOT / 'politics-hour' / 'RENDERING-ja.lock']
ep = sys.argv[1]
cmd = sys.argv[2]
since = sys.argv[3]
argv = sys.argv[4:]
shop_max = int(argv[argv.index('--shop-max') + 1]) if '--shop-max' in argv else 90
pol_until = argv[argv.index('--pol-until') + 1] if '--pol-until' in argv else '14:00'
no_pol = '--no-politics' in argv
LOG = ROOT / 'monetize-longform' / ep / 'wait.log'


def log(m):
    s = f'{dt.datetime.now():%m-%d %H:%M:%S} {m}'
    print(s, flush=True)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(s + '\n')


def new_lines(n0):
    try:
        ls = HAND.read_text(encoding='utf-8').splitlines()
    except Exception:
        return []
    return ls[n0:]


def main():
    n0 = len(HAND.read_text(encoding='utf-8').splitlines())
    start = dt.datetime.now()
    shop_deadline = start + dt.timedelta(minutes=shop_max)
    h, mi = map(int, pol_until.split(':'))
    pol_deadline = start.replace(hour=h, minute=mi, second=0, microsecond=0)
    log(f'대기 시작 {ep} → {cmd} · §10 기준 줄 {n0} · 쇼핑 상한 {shop_deadline:%H:%M} · 정치 상한 {pol_deadline:%H:%M}')
    # 1) 쇼핑 끝
    while True:
        if any(l.lstrip().startswith('- 쇼핑') and '쇼핑 끝' in l and '쇼핑 시작' not in l for l in new_lines(n0)):
            log('«쇼핑 끝» 확인'); break
        if dt.datetime.now() >= shop_deadline:
            log('쇼핑 상한 경과 — 넘어감'); break
        time.sleep(60)
    # 2) 정치 재렌더 완료 + 락 없음
    if not no_pol:
        pat = re.compile(r'^\s*- 정치.*(재렌더|렌더).*(완료|끝|마침)')
        while True:
            done = any(pat.search(l) and '재렌더 시작' not in l for l in new_lines(n0))
            locks = [x.name for x in LOCKS if x.exists()]
            if done and not locks:
                log('정치 재렌더 완료 줄 확인 · 락 없음'); break
            if dt.datetime.now() >= pol_deadline and not locks:
                log('정치 상한 경과 · 락 없음 — 시작'); break
            time.sleep(60)
    else:
        while any(x.exists() for x in LOCKS):
            time.sleep(60)
    tn = f'monetize_{ep}_chain'
    st = (dt.datetime.now() + dt.timedelta(minutes=1)).strftime('%H:%M')
    r = subprocess.run(['schtasks', '/Create', '/F', '/SC', 'ONCE', '/ST', st, '/TN', tn, '/TR', f'D:\\midform\\monetize-longform\\tools\\{cmd} {ep}'], capture_output=True, text=True)
    r2 = subprocess.run(['schtasks', '/Run', '/TN', tn], capture_output=True, text=True)
    log(f'사슬 시작 {tn}: {r.returncode}/{r2.returncode}')


if __name__ == '__main__':
    main()
