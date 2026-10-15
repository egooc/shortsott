"""멤버 얼굴 찾기 — 기준 얼굴(이름표로 확인한 장면)과 닮은 얼굴을 다른 영상에서 시각별로 찾는다.

    python member_id.py refs  <out_refs.npy> <영상:초,초,...> [<영상:초,...> ...]
    python member_id.py scan  <refs.npy> <영상> <시작> <끝> [--step 0.5] [--out scan.json]

refs: 지정한 시각마다 가장 큰 얼굴 하나를 기준으로 쓴다(그 장면에 그 멤버만 크게 잡혀 있어야 한다 —
      이름표·화자로 사람이 먼저 확인한 시각만 넣을 것).
scan: 시각마다 얼굴을 모두 찾아 기준과의 최고 코사인 유사도를 적는다. SFace 권장 문턱은 0.363.
      → [{"t", "faces": [{"box": [x,y,w,h](원본 화소), "sim"}]}]  — 판정(누가 멤버인가)은 쓰는 쪽이 한다.
모델: YuNet(얼굴 찾기, politics-hour/models) + SFace(얼굴 비교, fantube/models, opencv_zoo Apache-2.0).
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

YUNET = 'D:/midform/politics-hour/models/face_detection_yunet_2023mar.onnx'
SFACE = str(Path(__file__).resolve().parent / 'models' / 'face_recognition_sface_2021dec.onnx')


def frame(src, t):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', str(src), '-frames:v', '1',
                          '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    w, h = (int(v) for v in subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                            'stream=width,height', '-of', 'csv=p=0', str(src)],
                                           capture_output=True, text=True).stdout.strip().split(',')[:2])
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3) if len(raw) == w * h * 3 else None


class Faces:
    def __init__(self):
        self.det = None
        self.rec = cv2.FaceRecognizerSF.create(SFACE, '')

    def find(self, img, score=0.6):
        h, w = img.shape[:2]
        if self.det is None or self.det.getInputSize() != (w, h):
            self.det = cv2.FaceDetectorYN.create(YUNET, '', (w, h), score)
        _, f = self.det.detect(img)
        return [] if f is None else list(f)

    def embed(self, img, f):
        return self.rec.feature(self.rec.alignCrop(img, f)).flatten()


def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def refs(out, specs):
    fc, vecs = Faces(), []
    for spec in specs:
        src, times = spec.rsplit(':', 1)
        for t in times.split(','):
            img = frame(src, float(t))
            fs = fc.find(img) if img is not None else []
            if not fs:
                print('얼굴 없음', src, t)
                continue
            f = max(fs, key=lambda f: f[2] * f[3])
            vecs.append(fc.embed(img, f))
            print(f'기준 {Path(src).name} {t}s 얼굴 {int(f[2])}px')
    np.save(out, np.array(vecs))
    sims = [cos(a, b) for i, a in enumerate(vecs) for b in vecs[i + 1:]]
    print(f'기준 {len(vecs)}개 · 서로 유사도 중앙값 {np.median(sims):.3f} (낮으면 다른 사람이 섞였다)')


def scan(ref_path, src, t0, t1, step=0.5, out=None):
    R, fc, rows = np.load(ref_path), Faces(), []
    t = t0
    while t < t1:
        img = frame(src, t)
        faces = []
        for f in (fc.find(img, 0.5) if img is not None else []):
            v = fc.embed(img, f)
            faces.append({'box': [int(x) for x in f[:4]], 'sim': round(max(cos(v, r) for r in R), 3)})
        rows.append({'t': round(t, 2), 'faces': sorted(faces, key=lambda x: -x['sim'])})
        t += step
    if out:
        Path(out).write_text(json.dumps(rows) + '\n', encoding='utf-8')
    return rows


if __name__ == '__main__':
    if sys.argv[1] == 'refs':
        refs(sys.argv[2], sys.argv[3:])
    else:
        a = sys.argv
        step = float(a[a.index('--step') + 1]) if '--step' in a else 0.5
        out = a[a.index('--out') + 1] if '--out' in a else None
        for r in scan(a[2], a[3], float(a[4]), float(a[5]), step, out):
            top = r['faces'][0] if r['faces'] else None
            print(r['t'], len(r['faces']), top)
