# -*- coding: utf-8 -*-
"""수창 ko 편 사슬 — 락·메모리 확인 → RENDERING.lock(수창) → TTS → 역전사 대조(ko-corp/render/audit.py) → (통과면) 전체 렌더 → 락 해제.
night_chain_ja01.py 의 ko 판(편 폴더 인자). 실행은 schtasks 한 번 실행 작업(chain_ko.cmd, ASCII) — Claude 셸 백그라운드는 메모리 정리 때 꺼진다.
소유주 확정(10-21 23:3x): 01:00~18:00 렌더 자리는 수창 — 락 안에 «monetize <편> 시작시각 (PID)», 끝나면 지운다. 18:30~00:30 정치 창은 피한다. ★10-22 관리자: 정치 창 안이어도 그날 밤 정치 편 렌더가 끝났으면(politics_done_tonight) 시작 가능.

    python -X utf8 monetize-longform/tools/chain_ko.py monetize-longform/ep_ko01 [--skip-audit] [--render-only]

역전사 종료 4(실제 불일치)면 렌더를 멈추고 사람이 audit/report_*.md 를 본다 → 수정 뒤 --render-only 로 렌더만.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seg_prune  # noqa: E402  D: 관문·seg 자동 정리(10-23)

ROOT = Path('D:/midform')
PY = [sys.executable, '-X', 'utf8']
LOCKS = [ROOT / 'politics-hour' / 'RENDERING.lock', ROOT / 'politics-hour' / 'RENDERING-ja.lock']
EP = ROOT / sys.argv[1]
LOG = EP / 'chain.log'
RUNNING = EP / 'chain.running'


def log(msg):
    line = f'{dt.datetime.now():%m-%d %H:%M:%S} {msg}'
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line + '\n')


def pid_alive(pid):
    r = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH'], capture_output=True, text=True)
    return str(pid) in (r.stdout or '')


def disk_c_gb():
    import shutil
    return shutil.disk_usage('C:/').free / 1e9


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


def in_politics_window():
    t = dt.datetime.now().time()
    return t >= dt.time(18, 30) or t < dt.time(0, 30)


def politics_done_tonight():
    """관리자 10-22 21:1x: 정치 창(18:30~01:00) 안이어도 그날 밤 정치 편(다음 날 07:00 공개분) 렌더가 끝났으면 수창 사슬 허용.
    표식 = politics-hour/episodes/<다음 날>/upload_log.jsonl 또는 §10 «정치 ko(…)» 줄에 다음 날 날짜 + 렌더 끝/완료·업로드."""
    now = dt.datetime.now()
    day = now + dt.timedelta(days=1) if now.hour >= 12 else now
    if (ROOT / 'politics-hour' / 'episodes' / f'{day:%Y%m%d}' / 'upload_log.jsonl').exists():
        return '다음 날 편 upload_log'
    skip = ROOT / 'monetize-longform' / f'politics_skip_{day:%Y%m%d}.txt'   # 관리자 «오늘 밤 정치 렌더 없음» 지시 — 내용 = 지시 출처
    if skip.exists():
        return '정치 렌더 없음(' + skip.read_text(encoding='utf-8').strip()[:40] + ')'
    hand = ROOT / 'docs' / 'handoff-manager-20261014.md'
    if hand.exists():
        # 관리자 10-22 21:4x 형식: «- 정치 ko(HH:MM): 10/23 렌더 끝 — 성공, 락 해제 (N분)» / 실패는 «— 실패 rc=N»(«렌더 끝»이 있어도 통과 금지)
        tag = f'{day.month}/{day.day}'
        for line in hand.read_text(encoding='utf-8').splitlines()[-400:]:
            if line.startswith(('- 정치 ko(', '- 관리자(')) and tag in line and '렌더 끝' in line and '성공' in line and '실패' not in line:
                return '§10 줄: ' + line[:60]
    return ''


def run(name, cmd):
    log(f'[{name}] 시작: {" ".join(cmd[3:])}')
    with LOG.open('a', encoding='utf-8') as f:
        r = subprocess.run(cmd, cwd=str(ROOT), stdout=f, stderr=subprocess.STDOUT)
    log(f'[{name}] 종료 {r.returncode}')
    return r.returncode


def chain():
    rel = str(EP.relative_to(ROOT)).replace('\\', '/')
    log(f'시작(PID {os.getpid()}) {rel} {sys.argv[2:]}')
    while True:
        locks = [x.name for x in LOCKS if x.exists()]
        gb = free_gb()
        pol = in_politics_window()
        cgb = disk_c_gb()
        done = politics_done_tonight() if pol else ''
        dgb = seg_prune.disk_d_gb()
        log(f'관문 확인: 락 {", ".join(locks) or "없음"} · 빈 메모리 {gb:.1f}GB · C: {cgb:.1f}GB · D: {dgb:.1f}GB · 정치 창 {"안" if pol else "밖"}{(" · 정치 렌더 끝(" + done + ")") if done else ""}')
        if not locks and gb >= 8 and cgb >= 1.5 and (not pol or done):
            if not seg_prune.disk_gate(EP.name, log):   # 관리자 10-23: D: ≥15GB, 모자라면 업로드 끝난 편 seg/ 자동 정리 → 그래도 모자라면 종료 4·§10
                return 4
            break
        time.sleep(10 * 60)
    lock = LOCKS[0]
    lock.write_text(f'monetize {EP.name} {dt.datetime.now():%Y-%m-%d %H:%M:%S} 시작 (PID {os.getpid()})\n', encoding='utf-8')
    log(f'락 잡음 {lock}')
    os.environ['MONETIZE_LOCK_HELD'] = '1'   # 자식 render.py 가 렌더러 자체 락을 건너뛰게(10-23 01:14 ja03 TTS 실패 원인)
    try:
        if '--render-only' not in sys.argv:
            rc = run('comment_hook', comment_hook_cmd(rel))   # 관리자 10-24: 댓글 장치 관문은 TTS 전(표 있는 채널은 --channel)
            if rc:
                log(f'댓글 장치 관문 {rc} — TTS 보류(comment_spec.json·원고 반응 줄 확인)')
                return rc
            rc = run('tts', PY + ['monetize-longform/render.py', rel, '--tts-only', '--no-gate'])
            if rc:
                log('TTS 실패 — 중단')
                return 1
            if '--skip-audit' in sys.argv:
                log('역전사 건너뜀(--skip-audit)')
            else:
                rc = run('audit', PY + ['ko-corp/render/audit.py', rel])
                if rc == 4:
                    log('역전사 불일치 있음 — 렌더 보류(사람 확인: audit/report_*.md)')
                    return 4
                if rc:
                    log(f'역전사 도구 오류 {rc} — 렌더 보류')
                    return rc
        rc = run('clip_check', PY + ['monetize-longform/tools/clip_check.py', rel])   # 관리자 10-24: 실영상 컷 관문(등록·움직임·오인 표), 컷 없으면 PASS
        if rc:
            log(f'실영상 컷 검사 {rc} — 렌더 보류(3 오인 표 미확인 → clip_misread_ack.txt · 4 FAIL)')
            return rc
        rc = run('render', PY + ['monetize-longform/render.py', rel, '--no-gate'])
        log('사슬 끝' if rc == 0 else f'렌더 실패 {rc}')
        if rc == 0:
            seg_prune.finish_prune(EP, log)   # 관리자 10-23: 최종 mp4+motion_gate(내장) 통과 → seg/ 즉시 정리
        return rc
    finally:
        if lock.exists() and lock.read_text(encoding='utf-8').startswith(f'monetize {EP.name}'):
            lock.unlink()
            log('락 지움')



COMMENT_KEY_ALIAS = {'shopping_old_ssulmo': 'ko_mon2_old'}   # 업로드 프로필 이름과 반응 표 이름이 다른 채널


def comment_hook_cmd(rel):
    """관리자 10-24: 댓글 장치 관문(TTS 전). server/data 또는 docs 의 comment_types/<key>.json 이 있는 채널만 --channel, 없으면 generic."""
    lane = json.loads((EP / 'lane.json').read_text(encoding='utf-8')) if (EP / 'lane.json').exists() else {}
    purpose = lane.get('comment_channel') or lane.get('upload_purpose') or ''
    key = COMMENT_KEY_ALIAS.get(purpose, purpose)
    cmd = PY + ['scripts/comment_hook.py', rel, '--lane', 'generic', '--spec', rel + '/comment_spec.json']
    if key and any((ROOT / d / 'comment_types' / f'{key}.json').exists() for d in ('server/data', 'docs')):
        cmd += ['--channel', key]
    return cmd

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
