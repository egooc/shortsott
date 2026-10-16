# -*- coding: utf-8 -*-
"""정치 롱폼 무음 갭 검사 — scripts/silence_gap.py 를 편 구조에 맞춰 부른다(10/17부터, 관리자 결정 b+c).

    python politics-hour/gap_check.py <episode 폴더>          (work/concat.txt·work/episode.mp4 를 읽는다)

- 해설 문장 사이는 0.4~0.6초로 맞췄다(supertonic_worker.trim + gap 0.4) → 0.65초 넘는 해설 무음만 FAIL.
- 인용·첫머리 조각 안의 쉼은 원래 말투라 뺀다(--allow). 조각 경계 ±0.3초(전환)도 뺀다.
"""
import subprocess
import sys
from pathlib import Path

GAP = Path(__file__).resolve().parents[1] / 'scripts' / 'silence_gap.py'


def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p],
                                capture_output=True, text=True).stdout)


def main(ep):
    work = Path(ep) / 'work'
    segs = [ln.split("'")[1] for ln in (work / 'concat.txt').read_text(encoding='utf-8').splitlines() if ln.startswith('file')]
    allow, t = [], 0.0
    for p in segs:
        d, kind = dur(p), Path(p).parent.name.split('-')[1]
        if kind != 'nar':
            allow.append((t, t + d))
        allow.append((max(0, t - .3), t + .3))
        t += d
    cmd = [sys.executable, str(GAP), str(work / 'episode.mp4'), '--min', '0.65']
    for a, b in allow:
        cmd += ['--allow', f'{a:.2f}-{b:.2f}']
    sys.exit(subprocess.run(cmd).returncode)


if __name__ == '__main__':
    main(sys.argv[1])
