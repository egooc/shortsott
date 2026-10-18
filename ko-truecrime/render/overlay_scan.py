# -*- coding: utf-8 -*-
"""방송사가 얹은 설명 글자(검은 상자 위 흰 글씨) 구간 찾기 — 1초 간격, 화면 왼쪽 위 45%×40% 영역.

    .venv-vision python overlay_scan.py <영상> → 표준출력 JSON [[시작초, 끝초], ...]
판정: 영역 안에 «거의 검정(<20)» 덩어리가 2% 이상이고 그 안에 «거의 흰색(>225)» 이 0.4% 이상인 프레임. 앞뒤 3초는 호출 쪽에서 띄운다.
"""
import json
import subprocess
import sys

import numpy as np

path = sys.argv[1]
w, h = 320, 180
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'fps=1,scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                     capture_output=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w)
hits = []
for i, f in enumerate(frames):
    r = f[:int(h * .4), :int(w * .45)].astype(int)
    dark = (r < 20).mean()
    white = ((r > 225) & (np.roll(r, 2, axis=1) < 40)).mean()   # 흰 글씨 바로 옆이 검정(상자 위 글자)
    if dark > .02 and white > .004:
        hits.append(i)
spans = []
for t in hits:
    if spans and t - spans[-1][1] <= 2:
        spans[-1][1] = t
    else:
        spans.append([t, t])
print(json.dumps(spans))
