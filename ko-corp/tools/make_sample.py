# -*- coding: utf-8 -*-
"""소유주 확인용 4분 샘플 — 콜드오픈 1분 + 도식 판 1분 + 그림 장면 1분 + 끝맺음 1분을 잘라 붙인다(관리자 10-19), 30MB 이하.

    python -X utf8 ko-corp/tools/make_sample.py ko-corp/ep01 [--board 23-26] [--pic 40-42]

episode.mp4 와 concat.txt(장면 조각 순서)로 장면 경계를 알아낸다. --board·--pic 은 장면 번호 범위(없으면 자동:
가장 긴 연속 녹판 구간·그림 구간 중 영상 가운데쯤). 각 구간은 장면 경계에서 시작해 60초에서 0.4초 페이드로 끊는다.
"""
import json
import subprocess
import sys
from pathlib import Path

ep = Path(sys.argv[1]).resolve()
args = sys.argv[2:]
src = ep / 'episode.mp4'
parts = [ln.split("'")[1] for ln in (ep / 'concat.txt').read_text(encoding='utf-8').splitlines() if ln.startswith('file')]


def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout)


starts, t = [], 0.0
for p in parts:
    starts.append(t); t += dur(p)
total = t
vis = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
kind = []
for p in parts:
    vid = Path(p).parent.name.split('-', 1)[1].rsplit('-', 1)[0]
    kind.append('pic' if vis[vid]['type'] in ('pic', 'chapter') else 'board')


def pick(want, given):
    if given:
        return int(given.split('-')[0])
    mid = len(parts) // 2
    for d in range(len(parts)):
        for i in (mid + d, mid - d):
            if 0 <= i < len(parts) and kind[i] == want and (i == 0 or kind[i - 1] != want):
                return i
    return mid


opt = lambda k: args[args.index(k) + 1] if k in args else None
cuts = [(0.0, 60.0), (starts[pick('board', opt('--board'))], 60.0), (starts[pick('pic', opt('--pic'))], 60.0), (max(0, total - 60.0), 60.0)]
out = ep / 'sample_4min.mp4'
fc, n = '', len(cuts)
for k, (a, d) in enumerate(cuts):
    fc += (f'[0:v]trim={a:.3f}:{a + d:.3f},setpts=PTS-STARTPTS,fade=t=in:d=0.4,fade=t=out:st={d - .4:.2f}:d=0.4[v{k}];'
           f'[0:a]atrim={a:.3f}:{a + d:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st={d - .4:.2f}:d=0.4[a{k}];')
fc += ''.join(f'[v{k}][a{k}]' for k in range(n)) + f'concat=n={n}:v=1:a=1[vc][a];[vc]scale=1280:-2[v]'
# 30MB 이하: 240초 × (850k 영상 + 128k 음성) ≈ 29MB
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(src), '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
                '-c:v', 'libx264', '-b:v', '850k', '-maxrate', '1000k', '-bufsize', '2000k', '-preset', 'slow',
                '-c:a', 'aac', '-b:a', '128k', str(out)], check=True)
print(out, f'{out.stat().st_size / 2 ** 20:.1f}MB', [f'{a / 60:.1f}분' for a, _ in cuts])
