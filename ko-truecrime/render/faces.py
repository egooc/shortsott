# -*- coding: utf-8 -*-
"""바디캠 구간의 얼굴을 찾아 흐림 상자(blur.json 형식)를 만든다 — 제3자만 흐리고 경찰관·피고인은 남긴다(관리자 10-18).

    D:/midform/.venv-vision/Scripts/python.exe faces.py <영상> <시작초> <끝초> [--step 0.5] [--keep x0-x1] [--sheet out.jpg]

- YuNet(politics-hour/models, OpenCV zoo)으로 step 초마다 얼굴을 찾는다.
- --keep x0-x1: 얼굴 가운데 x(0~1)가 이 범위면 남긴다(그 구간의 피고인 위치를 눈으로 확인한 뒤 준다). 여러 개는 쉼표.
- 출력(표준출력 JSON): {"boxes": [[t0, t1, x, y, w, h], ...], "faces": [[t, x, y, w, h, score, keep], ...]}
  상자는 얼굴보다 35% 넓게, 앞뒤 step 만큼 늘려 흔들림을 덮는다. --sheet 를 주면 표본 프레임에 상자를 그린 모음(눈 확인용).
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

MODEL = 'D:/midform/politics-hour/models/face_detection_yunet_2023mar.onnx'


def frame(path, t, w, h):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                         capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3) if len(raw) == w * h * 3 else None


def main(argv):
    path, a, b = argv[0], float(argv[1]), float(argv[2])
    step = float(argv[argv.index('--step') + 1]) if '--step' in argv else .5
    keep = [tuple(map(float, r.split('-'))) for r in argv[argv.index('--keep') + 1].split(',')] if '--keep' in argv else []
    w, h = (int(x) for x in subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                                             '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.strip().split(',')[:2])
    det = cv2.FaceDetectorYN.create(MODEL, '', (w, h), score_threshold=.6)
    faces, boxes, shots = [], [], []
    t = a
    while t <= b:
        img = frame(path, t, w, h)
        if img is not None:
            _, found = det.detect(img)
            for f in (found if found is not None else []):
                x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[-1])
                cx = (x + fw / 2) / w
                k = any(lo <= cx <= hi for lo, hi in keep)
                faces.append([round(t, 2), round(x / w, 4), round(y / h, 4), round(fw / w, 4), round(fh / h, 4), round(score, 3), k])
                if not k:
                    px, py = fw * .35, fh * .35
                    bx, by = max(0, x - px), max(0, y - py)
                    boxes.append([round(max(a, t - step), 2), round(min(b, t + step), 2), round(bx / w, 4), round(by / h, 4),
                                  round(min(w - bx, fw + 2 * px) / w, 4), round(min(h - by, fh + 2 * py) / h, 4)])
            if '--sheet' in argv and len(shots) < 12 and (not shots or t - shots[-1][0] >= (b - a) / 12):
                vis = img.copy()
                for ft in [x for x in faces if x[0] == round(t, 2)]:
                    c = (0, 200, 0) if ft[6] else (0, 0, 255)
                    cv2.rectangle(vis, (int(ft[1] * w), int(ft[2] * h)), (int((ft[1] + ft[3]) * w), int((ft[2] + ft[4]) * h)), c, 4)
                cv2.putText(vis, f'{t:.1f}', (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (255, 255, 255), 3)
                shots.append((t, cv2.resize(vis, (480, int(480 * h / w)))))
        t += step
    if '--sheet' in argv and shots:
        out = argv[argv.index('--sheet') + 1]
        tiles = [s for _, s in shots] + [np.zeros_like(shots[0][1])] * ((4 - len(shots) % 4) % 4)
        rows = [np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]
        cv2.imwrite(out, np.vstack(rows))
    print(json.dumps({'boxes': boxes, 'faces': faces}))


if __name__ == '__main__':
    main(sys.argv[1:])
