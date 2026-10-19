# 정해진 시간·자리에 박힌 그래픽 글자만 지운다 — ocr_lama_erase.py 의 run_lama 를 import 하고 마스크만 바꾼다.
#   D:/tools/vsr/.venv/Scripts/python.exe <이 파일> <in.mp4> <out.mp4> <spec.json>   (cwd D:/tools/vsr)
# 왜: 통째 OCR 은 책장 책 제목·맨투맨 «moment» 글자까지 지운다(academy01 실측). 자리(rect)와 시간 창을 주고 그 안에서만 찾는다.
# spec.json: [{"t0":0,"t1":3.6,"rect":[x0,y0,x1,y1],"mode":"rect"|"ocr","grow":40,"keep_small":[260,105]}, ...]
#   rect: 상자 전체를 메움(불꽃 같은 글자 아닌 장식까지) · ocr: 상자 안 글자 줄만 키워서 메움
import json, sys
import numpy as np
import cv2

sys.path.insert(0, 'D:/midform/scripts')
sys.path.insert(0, 'D:/tools/vsr')
from ocr_lama_erase import run_lama  # noqa: E402

sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def build_at(src, spec, fps_det=6):
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    det = None
    step = max(1, round(fps / fps_det))
    masks, i = {}, -1
    while True:
        ok, f = cap.read()
        if not ok:
            break
        i += 1
        if i % step:
            continue
        t = i / fps
        m = np.zeros((H, W), np.uint8)
        for s in spec:
            if not (s['t0'] <= t < s['t1']):
                continue
            x0, y0, x1, y1 = s['rect']
            if s['mode'] == 'rect':
                m[y0:y1, x0:x1] = 255
                continue
            if det is None:
                from paddleocr import TextDetection
                det = TextDetection(model_name='PP-OCRv5_mobile_det')
            sub = np.zeros((H, W), np.uint8)
            for r in det.predict(f[y0:y1, x0:x1]):
                for poly, sc in zip(r['dt_polys'], r['dt_scores']):
                    bw, bh = np.max(poly, 0) - np.min(poly, 0)
                    ex = s.get('keep_small')   # 맨투맨 «moment» 같은 작은 글자 줄은 남긴다 [최대폭, 최대높이]
                    if ex and bw < ex[0] and bh < ex[1]:
                        continue
                    if sc >= 0.5:
                        cv2.fillPoly(sub, [np.asarray(poly, np.int32) + [x0, y0]], 255)
            g = s.get('grow', 40)
            sub = cv2.dilate(sub, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * g + 1, 2 * g + 1)))
            m |= sub
        masks[i] = m
    N = i + 1
    keys = sorted(masks)

    def at(j):
        lo = min((j // step) * step, keys[-1])
        hi = min(lo + step, keys[-1])
        return masks[lo] | masks[hi]
    return fps, W, H, N, at


def main():
    src, out, spec = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3], encoding='utf-8'))
    fps, W, H, N, at = build_at(src, spec)
    print('마스크 준비 끝', N, '프레임', flush=True)
    n = run_lama(src, out, fps, W, H, at)
    print(f'{N} 프레임 중 {n} 프레임 메움 → {out}')


if __name__ == '__main__':
    main()
