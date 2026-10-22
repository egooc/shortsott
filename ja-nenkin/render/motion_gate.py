# -*- coding: utf-8 -*-
"""움직임 관문(관리자 10-22): 장면마다 첫·끝 프레임의 판 영역(STAGE_BOX) SSIM ≥ 0.95 면 FAIL — 하나라도 있으면 종료 4.

    python ja-nenkin/render/motion_gate.py <편 폴더> [--concat concat_v4.txt] [--keep N]

concat 목록(기본 concat.txt)의 segment.mp4 를 차례로 본다. 결과 <편>/audit/motion_gate.json,
처음 N개(기본 3) 장면의 첫·끝 정지 화면은 <편>/audit/motion/ 에 남긴다(증명용).
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from nenkin_render import LOCKS, STAGE_BOX  # noqa: E402

LIMIT = 0.95


def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout or 0)


def frame(p, t, out):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', str(p), '-frames:v', '1', str(out)], check=True)


def ssim(a, b):
    x, y, w, h = STAGE_BOX
    crop = f'crop={w}:{h}:{x}:{y}'
    r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(a), '-i', str(b), '-filter_complex',
                        f'[0:v]{crop}[a];[1:v]{crop}[b];[a][b]ssim', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'All:([0-9.]+)', r.stderr)
    return float(m.group(1)) if m else None


def main(argv):
    busy = [x for x in LOCKS if x.exists() and not x.read_text(encoding='utf-8').startswith('nenkin_ja')]
    if busy:   # 10-22 23:3x §7: 남의 락 위에선 프레임 뽑기·SSIM 도 시작하지 않는다
        print('[관문] motion: 다른 레인 RENDERING 락 있음 — 락 풀린 뒤 다시(종료 3)', ', '.join(x.name for x in busy))
        return 3
    ep = Path(argv[0]).resolve()
    lst = ep / (argv[argv.index('--concat') + 1] if '--concat' in argv else 'concat.txt')
    keep = int(argv[argv.index('--keep') + 1]) if '--keep' in argv else 3
    segs = [Path(m) for m in re.findall(r"file '([^']+)'", lst.read_text(encoding='utf-8'))]
    segs = [s if s.is_absolute() else (lst.parent / s) for s in segs]
    shots = ep / 'audit' / 'motion'
    shots.mkdir(parents=True, exist_ok=True)
    rows, fails = [], []
    with tempfile.TemporaryDirectory() as td:
        for i, s in enumerate(segs):
            d = dur(s)
            a, b = (Path(td) / 'a.png', Path(td) / 'b.png') if i >= keep else (shots / f'{s.parent.name}_first.png', shots / f'{s.parent.name}_last.png')
            frame(s, 0.05, a)
            frame(s, max(0.1, d - 0.1), b)
            v = ssim(a, b)
            rows.append({'seg': s.parent.name, 'dur': round(d, 2), 'ssim': v})
            if v is None or v >= LIMIT:
                fails.append(rows[-1])
    out = {'limit': LIMIT, 'n': len(rows), 'fail': len(fails), 'fails': fails, 'rows': rows}
    (ep / 'audit' / 'motion_gate.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    vals = [r['ssim'] for r in rows if r['ssim'] is not None]
    print(f'[관문] motion: 장면 {len(rows)} · FAIL {len(fails)} · SSIM 최대 {max(vals):.3f} 중앙 {sorted(vals)[len(vals) // 2]:.3f}' if vals else '[관문] motion: 값 없음')
    for f in fails[:10]:
        print('  FAIL', f['seg'], f['ssim'])
    return 4 if fails else 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main(sys.argv[1:]))
