# -*- coding: utf-8 -*-
"""움직임 관문(관리자 10-22 §7 ⑤) — 장면 조각마다 첫·끝 프레임 SSIM 을 재서 0.95 이상(= 거의 정지)이면 FAIL, 종료 4.

    python -X utf8 monetize-longform/tools/motion_gate.py monetize-longform/ep_ko06 [--only 0-2] [--json]

출력: <ep>/motion_check/<idx>_first.png·_last.png(증명용 정지 화면), <ep>/motion_check/report.json.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path('D:/midform')
TH = 0.95


def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)], capture_output=True, text=True).stdout or 0)


def frame(src, t, dst):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', str(src), '-frames:v', '1', str(dst)], check=True)


def ssim(a, b):
    r = subprocess.run(['ffmpeg', '-nostdin', '-i', str(a), '-i', str(b), '-lavfi', 'ssim', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'All:([0-9.]+)', r.stderr or '')
    return float(m.group(1)) if m else None


def main(argv):
    ep = (ROOT / argv[0]).resolve() if not Path(argv[0]).is_absolute() else Path(argv[0])
    only = argv[argv.index('--only') + 1] if '--only' in argv else None
    lo, hi = (int(only.split('-')[0]), int(only.split('-')[-1])) if only else (0, 10 ** 6)
    out = ep / 'motion_check'
    out.mkdir(exist_ok=True)
    segs = sorted([d for d in (ep / 'seg').iterdir() if d.is_dir() and (d / 'segment.mp4').exists()], key=lambda d: int(d.name.split('-')[0]))
    rows, bad = [], []
    for d in segs:
        i = int(d.name.split('-')[0])
        if not lo <= i <= hi:
            continue
        v = d / 'segment.mp4'
        t = dur(v)
        a, b = out / f'{i:03d}_first.png', out / f'{i:03d}_last.png'
        frame(v, 0.05, a)
        frame(v, max(0.05, t - 0.1), b)
        s = ssim(a, b)
        rows.append({'i': i, 'vid': '-'.join(d.name.split('-')[1:-1]), 'sec': round(t, 2), 'ssim': s, 'first': str(a), 'last': str(b)})
        if s is None or s >= TH:
            bad.append(f'{i} {rows[-1]["vid"]} SSIM {s}')
    (out / 'report.json').write_text(json.dumps({'threshold': TH, 'rows': rows, 'fail': bad}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    if '--json' in argv:
        print(json.dumps(rows, ensure_ascii=False))
    vals = [r['ssim'] for r in rows if r['ssim'] is not None]
    summ = f'장면 {len(rows)} · SSIM 최소 {min(vals):.3f} · 중앙 {sorted(vals)[len(vals) // 2]:.3f} · 최대 {max(vals):.3f}' if vals else '장면 0'
    if bad:
        print(f'[관문] motion: FAIL · {summ} · 정지 장면 {len(bad)}: ' + ', '.join(bad[:8]) + ' (종료 4)')
        return 4
    print(f'[관문] motion: PASS · {summ} (종료 0)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
