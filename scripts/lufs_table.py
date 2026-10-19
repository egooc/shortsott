# -*- coding: utf-8 -*-
"""출력 음량 측정표(카이안 K12, 10-19) — ffmpeg ebur128 로 통합 음량(I)·트루 피크(TP)·LRA 를 재고 -14±1 LUFS 판정.

    python scripts/lufs_table.py <레인=파일.mp4> ...            # 표를 찍는다
    python scripts/lufs_table.py --json out.json <레인=파일> ...

API 0원 · 읽기만 한다. 레인 렌더러 마지막 단계 정규화는 scripts/loudnorm_final.py 를 import.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

TARGET, TOL = -14.0, 1.0


def measure(path):
    """{'I', 'TP', 'LRA'} — ebur128 마지막 요약 블록."""
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-vn', '-af', 'ebur128=peak=true',
                        '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    tail = r.stderr[r.stderr.rfind('Summary:'):]
    num = lambda k: float(re.search(k + r':\s+(-?[\d.]+|-inf)', tail).group(1).replace('-inf', '-99'))
    return {'I': num(r'I'), 'TP': num(r'Peak'), 'LRA': num(r'LRA')}


def verdict(m):
    return 'OK' if abs(m['I'] - TARGET) <= TOL and m['TP'] <= -1.0 else ('작음' if m['I'] < TARGET - TOL else ('큼' if m['I'] > TARGET + TOL else '피크'))


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    out = None
    if '--json' in argv:
        i = argv.index('--json'); out = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    rows = []
    for a in argv:
        lane, _, f = a.partition('=')
        m = measure(f)
        rows.append({'lane': lane, 'file': f, **m, 'verdict': verdict(m)})
        print(f'{lane}\t{m["I"]:.1f} LUFS\tTP {m["TP"]:.1f}\tLRA {m["LRA"]:.1f}\t{rows[-1]["verdict"]}\t{Path(f).name}', flush=True)
    if out:
        Path(out).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
