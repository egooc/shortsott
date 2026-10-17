"""방송 자막 띠만 지우기 — scripts/ocr_lama_erase.py 의 LaMa 메움을 그대로 쓰고, 감지만 «아래 띠» 안으로 묶는다.
    D:/tools/vsr/.venv/Scripts/python.exe fantube/band_erase.py <in.mp4> <out.mp4> [--band 0.6] [--fps 6] [--grow 24] [--span 8] [--logo x0,y0,x1,y1] [--engine propainter|lama]   (cwd D:/tools/vsr)

왜(10/17 할명수 ep15): 원래 도구는 화면 전체에서 글자 줄을 찾다가 웃는 입(치아)을 글자로 보고 얼굴을 지웠다.
예능 자막·이름표는 아래 띠(높이 60% 아래)에만 있다 — 띠 밖 감지는 버리고, 띠 안은 같은 줄 글자들을 한 상자로
묶어(「(배이 🐴 → 지우 🐘)」 사이 화살표·이모지까지) 통째로 메운다.
"""
import argparse, sys
import numpy as np
import cv2
from paddleocr import TextDetection

sys.path.insert(0, 'D:/midform/scripts')
sys.path.insert(0, 'D:/tools/vsr')
import ocr_lama_erase as E  # noqa: E402


def detect_band(src, fps_det, grow, band, span=8, logo=None):
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    det = TextDetection(model_name='PP-OCRv5_mobile_det')
    step = max(1, round(fps / fps_det))
    y_band = int(H * band)
    masks, i = {}, -1
    while True:
        ok, f = cap.read()
        if not ok:
            break
        i += 1
        if i % step:
            continue
        boxes = []
        for r in det.predict(f):
            for poly, sc in zip(r['dt_polys'], r['dt_scores']):
                x0, y0 = np.min(poly, 0); x1, y1 = np.max(poly, 0)
                if sc >= 0.5 and y0 >= y_band:
                    boxes.append([int(x0), int(y0), int(x1), int(y1)])
        rows = []                                   # 세로로 겹치는 상자끼리 한 줄
        for b in sorted(boxes, key=lambda b: b[1]):
            for rw in rows:
                if min(rw[3], b[3]) - max(rw[1], b[1]) > 0.3 * (b[3] - b[1]):
                    rw[:] = [min(rw[0], b[0]), min(rw[1], b[1]), max(rw[2], b[2]), max(rw[3], b[3])]
                    break
            else:
                rows.append(b[:])
        m = np.zeros((H, W), np.uint8)
        for x0, y0, x1, y1 in rows:
            cv2.rectangle(m, (max(0, x0 - 3 * grow), max(y_band, y0 - grow)), (min(W - 1, x1 + 3 * grow), min(H - 1, y1 + grow)), 255, -1)
        masks[i] = m
    keys = sorted(masks)

    logo_m = np.zeros((H, W), np.uint8)
    if logo:
        cv2.rectangle(logo_m, logo[:2], logo[2:], 255, -1)
    # 이름표는 한 조각씩 나타난다(「(배이 🐴 →」 다음 「지우 🐘)」) — 앞뒤 span 개 감지를 합쳐 줄 전체를 덮는다
    union = {k: np.bitwise_or.reduce([masks[q] for q in keys if abs(q - k) <= span * step]) for k in keys}

    def at(j):
        lo = min((j // step) * step, keys[-1])
        hi = min(lo + step, keys[-1])
        return union[lo] | union[hi] | logo_m
    return fps, W, H, i + 1, at


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--band', type=float, default=0.6)
    ap.add_argument('--fps', type=float, default=6)
    ap.add_argument('--grow', type=int, default=24)
    ap.add_argument('--span', type=int, default=8)       # 앞뒤 합칠 감지 수(6fps 에서 ±1.3초)
    ap.add_argument('--engine', choices=['lama', 'propainter'], default='propainter')   # lama 는 바닥·무릎에 뿌연 얼룩(10/17)
    ap.add_argument('--logo', default='')                # 늘 메울 로고 상자 x0,y0,x1,y1 (할명수 70,60,320,150)
    a = ap.parse_args()
    fps, W, H, N, at = detect_band(a.src, a.fps, a.grow, a.band, a.span,
                                    tuple(int(v) for v in a.logo.split(',')) if a.logo else None)
    n = E.run_lama(a.src, a.out, fps, W, H, at) if a.engine == 'lama' else E.run_propainter(a.src, a.out, fps, W, H, N, at, 120)
    print(f'{N} 프레임 중 {n} 프레임 메움(띠 {a.band:.2f} 아래) → {a.out}')
