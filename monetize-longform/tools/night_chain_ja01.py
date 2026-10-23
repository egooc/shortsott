# -*- coding: utf-8 -*-
"""ep_ja01 새벽 사슬 — 01:00 뒤(정치 락 00:30 해제·쇼핑 00:30 GPU 뒤) TTS → 역전사 대조 → (통과면) 전체 렌더.
관리자 10-21 23:00 지시(소유주 «수창 최우선»). 소유주 확정(23:3x): 01:00~18:00 렌더 자리는 수창이 먼저 — 기존 락을 우리가 잡고(안에 누가·언제), 끝나면 지운다.
실행은 schtasks 한 번 실행 작업(night_chain_ja01.cmd, ASCII) — Claude 셸 백그라운드는 메모리 정리 때 셸째 꺼진다(18:42 정치 렌더 사고).
중복 실행 방지: ep_ja01/night_chain.running 에 PID — 그 PID 가 살아 있으면 두 번째 실행은 바로 끝난다.

    python -X utf8 monetize-longform/tools/night_chain_ja01.py
"""
import datetime as dt
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('D:/midform')
EP = ROOT / 'monetize-longform' / 'ep_ja01'
LOG = EP / 'night_chain.log'
RUNNING = EP / 'night_chain.running'
PY = [sys.executable, '-X', 'utf8']
START = dt.datetime(2026, 10, 22, 1, 0)
LOCKS = [ROOT / 'politics-hour' / 'RENDERING.lock', ROOT / 'politics-hour' / 'RENDERING-ja.lock']


def log(msg):
    line = f'{dt.datetime.now():%m-%d %H:%M:%S} {msg}'
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line + '\n')


def pid_alive(pid):
    r = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH'], capture_output=True, text=True)
    return str(pid) in (r.stdout or '')


def free_gb():
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong), ('ullTotalPhys', ctypes.c_ulonglong),
                    ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong), ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullAvailPhys / 2**30


def run(name, cmd):
    log(f'[{name}] 시작: {" ".join(cmd[3:])}')
    with LOG.open('a', encoding='utf-8') as f:
        r = subprocess.run(cmd, cwd=str(ROOT), stdout=f, stderr=subprocess.STDOUT)
    log(f'[{name}] 종료 {r.returncode}')
    return r.returncode


def chain():
    log(f'대기 시작(PID {os.getpid()}) — {START:%H:%M} 까지')
    while dt.datetime.now() < START:
        time.sleep(60)
    while True:
        locks = [x.name for x in LOCKS if x.exists()]
        gb = free_gb()
        log(f'관문 확인: 락 {", ".join(locks) or "없음"} · 빈 메모리 {gb:.1f}GB')
        if not locks and gb >= 8:
            break
        time.sleep(10 * 60)
    # 렌더러 wait_gate 는 이 락을 보고 멈추므로 --no-gate(락·메모리 확인은 위에서 이미 했다).
    lock = LOCKS[0]
    lock.write_text(f'monetize ep_ja01 {dt.datetime.now():%Y-%m-%d %H:%M:%S} 시작 (PID {os.getpid()})\n', encoding='utf-8')
    log(f'락 잡음 {lock}')
    try:
        rc = run('tts', PY + ['monetize-longform/render.py', 'monetize-longform/ep_ja01', '--tts-only', '--no-gate'])
        if rc:
            log('TTS 실패 — 중단')
            return 1
        if '--skip-audit' in sys.argv:   # 역전사를 사람이 이미 판독한 뒤(남은 불일치가 STT 분절뿐일 때) 렌더만
            log('역전사 건너뜀(--skip-audit, 사람 판독 끝)')
            rc = 0
        else:
            rc = run('audit', PY + ['ja-nenkin/render/num_audit.py', 'monetize-longform/ep_ja01'])
        if rc == 4:
            log('역전사 실제 오독 있음 — 렌더 보류(사람 확인 필요)')
            return 4
        if rc == 3:
            log('역전사 형식 불일치만(점 빠짐) — 렌더는 진행, 청취 확인 남김')
        elif rc:
            log(f'역전사 도구 오류 {rc} — 렌더 보류')
            return rc
        rc = run('render', PY + ['monetize-longform/render.py', 'monetize-longform/ep_ja01', '--no-gate'])
        log('사슬 끝' if rc == 0 else f'렌더 실패 {rc}')
        return rc
    finally:
        if lock.exists() and lock.read_text(encoding='utf-8').startswith('monetize ep_ja01'):
            lock.unlink()
            log('락 지움')


def main():
    if RUNNING.exists():
        old = RUNNING.read_text(encoding='utf-8').strip()
        if old.isdigit() and pid_alive(int(old)) and int(old) != os.getpid():
            log(f'이미 실행 중(PID {old}) — 이 실행은 끝냄')
            return 0
    RUNNING.write_text(str(os.getpid()), encoding='utf-8')
    try:
        return chain()
    finally:
        RUNNING.unlink(missing_ok=True)


if __name__ == '__main__':
    sys.exit(main())
