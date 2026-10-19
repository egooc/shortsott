# -*- coding: utf-8 -*-
"""TTS 문장 사이 무음 상한 검사(카이안 K13, 10-19) — 연금·기업 흥망·정치 쇼츠 공용.
«쇼츠 1초 정적 = 방송 사고». 상한 제안: 쇼츠 0.4초 · 롱폼 0.8초(측정 뒤 조정).

    python scripts/gap_check.py <voice.wav|episode.mp4> [--kind shorts|long] [--cap 0.8] [--noise -40]

관문에서:
    sys.path.insert(0, 'D:/midform/scripts'); import gap_check
    bad += gap_check.gate_lines(path, kind='long')      # ['무음 1.32초 @ 412.5s (상한 0.8)', ...]

무음 = ffmpeg silencedetect(noise dB 아래가 이어진 구간). 맨 앞·맨 끝 무음은 뺀다(페이드·끝 여운).
종료 코드 0 = 통과 · 4 = 상한 넘는 무음 있음. 읽기만 한다.
"""
import re
import subprocess
import sys

CAPS = {'shorts': 0.4, 'long': 0.8}


def silences(path, noise=-40, min_len=0.2):
    """[(시작, 끝, 길이)] 과 전체 길이."""
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-vn', '-af',
                        f'silencedetect=noise={noise}dB:d={min_len}', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    err = r.stderr
    dur = re.search(r'Duration: (\d+):(\d+):([\d.]+)', err)
    total = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0.0
    starts = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', err)]
    ends = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', err)]
    out = [(s, e, e - s) for s, e in zip(starts, ends)]
    if len(starts) > len(ends):                          # 끝까지 무음
        out.append((starts[-1], total, total - starts[-1]))
    return out, total


def gaps(path, kind='long', cap=None, noise=-40):
    """상한을 넘는 중간 무음 [(시작, 길이)]."""
    cap = CAPS[kind] if cap is None else cap
    sil, total = silences(path, noise)
    mid = [(s, n) for s, e, n in sil if s > 0.05 and e < total - 0.05]
    return [(s, n) for s, n in mid if n > cap], cap, mid


def gate_lines(path, kind='long', cap=None, noise=-40):
    over, cap, _ = gaps(path, kind, cap, noise)
    return [f'무음 {n:.2f}초 @ {s:.1f}s (상한 {cap})' for s, n in over]


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k, d: type(d)(argv[argv.index(k) + 1]) if k in argv else d
    kind = opt('--kind', 'long')
    cap = float(argv[argv.index('--cap') + 1]) if '--cap' in argv else None
    over, cap, mid = gaps(argv[0], kind, cap, opt('--noise', -40))
    ns = sorted(n for _, n in mid)
    if ns:
        print(f'중간 무음 {len(ns)}곳 · 중앙 {ns[len(ns) // 2]:.2f}초 · 최대 {ns[-1]:.2f}초 · 상한 {cap}초 초과 {len(over)}곳')
    for s, n in over[:30]:
        print(f'✗ 무음 {n:.2f}초 @ {s:.1f}s')
    if not over:
        print(f'✓ 무음 상한 통과 ({argv[0]})')
    return 4 if over else 0


if __name__ == '__main__':
    sys.exit(main())
