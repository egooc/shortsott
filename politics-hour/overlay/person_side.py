"""인용 장면에서 인물이 있는 쪽을 찾아, 모션그래픽을 올릴 빈 쪽을 고른다.

    python person_side.py <영상> <시작초> <끝초>
    → {"side": "left"|"right", "person": [x0, y0, x1, y1](0~1), "faces": n}

구간에서 프레임 7장을 뽑아 정면 얼굴을 찾고, 가장 큰 얼굴들의 범위로 인물 영역을 잡는다.
몸은 얼굴 폭의 약 3배로 넓혀 본다. 얼굴을 못 찾으면 화면 중앙에 인물이 있다고 보고 오른쪽을 비운다.
"""
import json
import subprocess
import sys

from pathlib import Path

import cv2
import numpy as np

MODEL = str(Path(__file__).resolve().parents[1] / 'models' / 'face_detection_yunet_2023mar.onnx')  # OpenCV zoo YuNet


def frame_at(path, t, width=640):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', path, '-frames:v', '1',
                          '-vf', f'scale={width}:-2', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                         capture_output=True).stdout
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    w, h = (int(x) for x in probe.strip().split(',')[:2])
    height = round(h * width / w / 2) * 2
    if len(raw) != width * height * 3:
        return None
    return np.frombuffer(raw, np.uint8).reshape(height, width, 3)


def detect(path, start, end):
    boxes = []
    for k in range(7):
        img = frame_at(path, start + (end - start) * (k + .5) / 7)
        if img is None:
            continue
        h, w = img.shape[:2]
        det = cv2.FaceDetectorYN.create(MODEL, '', (w, h), 0.7)
        _, faces = det.detect(img)
        faces = [f for f in (faces if faces is not None else []) if f[2] >= w / 25]
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])[:4]
            boxes.append((x / w, y / h, (x + fw) / w, (y + fh) / h))
    if not boxes:
        return {'side': 'right', 'person': [.3, .1, .7, 1.0], 'faces': 0}
    x0 = float(np.median([b[0] for b in boxes])); x1 = float(np.median([b[2] for b in boxes]))
    y0 = float(np.median([b[1] for b in boxes]))
    fw = x1 - x0
    body = [max(0.0, x0 - fw), max(0.0, y0 - fw * .4), min(1.0, x1 + fw), 1.0]
    left_room, right_room = body[0], 1 - body[2]
    return {'side': 'left' if left_room > right_room else 'right', 'person': [round(v, 3) for v in body],
            'faces': len(boxes)}


if __name__ == '__main__':
    print(json.dumps(detect(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))))
