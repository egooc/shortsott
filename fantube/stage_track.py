"""무대(원거리 단체 영상)에서 한 멤버를 따라가는 카메라 점 — 얼굴 유사도 + 상의(색·가로 줄무늬 결) + 위치 연속성.

    python stage_track.py <영상> <시작> <끝> <refs.npy> <상의 기준 시각들 "64:x,89:x,..."> <out.json> [--step 0.25]

얼굴만으로는 안 된다(2026-10-13 Heavy Serenade 연습실: 얼굴 25~45px, 1·2등 유사도 차가 0.01~0.1).
그래서 사람이 확인한 «그 멤버가 맞는 순간들»의 상의를 기준으로 삼아 함께 본다:
  기준 시각 t:x → 그 시각 x 근처 얼굴의 상의 조각(얼굴 아래 1.2~4배 높이, 2.4배 폭)에서 HSV 색 분포 + 가로 줄 세기.
점수 = 0.35·얼굴 + 0.45·상의 + 0.20·연속성(앞 시각 위치와 가까울수록). 시각마다 최고점 얼굴을 고르고,
점수가 낮은 시각(가려짐·대형 교차)은 앞뒤로 메운다.
→ {"marks": [[t, cx(0~1), cy(0~1), face_h(px)], ...]}   cx·cy 는 원본 가로·세로 비율(얼굴 가운데).
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import member_id as mid  # noqa: E402


def torso(img, f):
    x, y, w, h = (int(v) for v in f[:4])
    H, W = img.shape[:2]
    x0, x1 = max(0, int(x + w / 2 - 1.2 * w)), min(W, int(x + w / 2 + 1.2 * w))
    y0, y1 = min(H - 1, int(y + 1.2 * h)), min(H, int(y + 4 * h))
    return img[y0:y1, x0:x1] if y1 - y0 > 8 and x1 - x0 > 8 else None


def cloth_desc(patch):
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256]).flatten()
    hist /= hist.sum() + 1e-9
    g = cv2.cvtColor(cv2.resize(patch, (48, 64)), cv2.COLOR_BGR2GRAY).astype(np.float32)
    sy = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1)).mean()      # 가로 줄무늬 → 세로 미분이 크다
    sx = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0)).mean()
    return hist, sy / (sx + 1e-6)


def cloth_sim(a, b):
    (ha, ra), (hb, rb) = a, b
    hs = float(np.minimum(ha, hb).sum())                       # 히스토그램 교집합 0~1
    rs = float(np.exp(-abs(np.log((ra + 1e-6) / (rb + 1e-6)))))  # 줄 결 비율이 같을수록 1
    return 0.6 * hs + 0.4 * rs


def main(src, t0, t1, refs_path, cloth_times, out, step=0.25):
    R, fc = np.load(refs_path), mid.Faces()
    refs_c = []
    for item in cloth_times.split(','):
        t, x = (float(v) for v in item.split(':'))
        img = mid.frame(src, t)
        fs = fc.find(img, 0.5)
        f = min(fs, key=lambda f: abs(f[0] + f[2] / 2 - x))
        refs_c.append(cloth_desc(torso(img, f)))
    marks, prev, t = [], None, t0
    while t <= t1 + 1e-6:
        img = mid.frame(src, t)
        H, W = img.shape[:2]
        best = None
        for f in fc.find(img, 0.5):
            p = torso(img, f)
            if p is None:
                continue
            fs_ = max(mid.cos(fc.embed(img, f), r) for r in R)
            cs = max(cloth_sim(cloth_desc(p), rc) for rc in refs_c)
            cx, cy = (f[0] + f[2] / 2) / W, (f[1] + f[3] / 2) / H
            cont = 1.0 if prev is None else float(np.exp(-abs(cx - prev[0]) / 0.06))
            s = 0.35 * fs_ + 0.45 * cs + 0.20 * cont
            if best is None or s > best[0]:
                best = (s, cx, cy, float(f[3]), fs_, cs)
        if best and best[0] >= 0.45:
            prev = best[1:3]
            marks.append([round(t, 2), round(float(best[1]), 4), round(float(best[2]), 4), round(float(best[3]), 1)])
            print(f'{t:6.2f} cx {best[1]:.3f} 점수 {best[0]:.2f} (얼굴 {best[4]:.2f} 상의 {best[5]:.2f})')
        else:
            print(f'{t:6.2f} 못 찾음')
        t += step
    Path(out).write_text(json.dumps({'marks': marks}) + '\n', encoding='utf-8')


if __name__ == '__main__':
    a = sys.argv
    main(a[1], float(a[2]), float(a[3]), a[4], a[5], a[6], float(a[a.index('--step') + 1]) if '--step' in a else 0.25)
