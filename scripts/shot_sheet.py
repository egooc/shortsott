# 쓸 수 있는 샷을 출력 창(1080x1168) 모양 그대로 한 장에 모으고, 얼굴이 보이는 샷을 표시한다.
# 1인칭 원고(손만 나오는 화면)를 쓸 때 얼굴 샷을 빼기 위한 시트.
#
#   <venv python> scripts/shot_sheet.py --wd arabshop05 [--exclude xhs_89a0,ks_5220:87-98] [--only-faceless]
# 결과: <wd>/_shots/sheet_pov.jpg + <wd>/_shots/faces.json   (volcano venv 의 OpenCV 에 얼굴 검출기가 있다)
import argparse, json, os
import cv2
import numpy as np

W, H, BAND_Y, BAND_H = 1080, 1920, 376, 1168


def frame(cap, t):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, f = cap.read()
    if not ok:
        return None
    h, w = f.shape[:2]
    k = min(W / w, H / h)
    g = cv2.resize(f, (int(w * k), int(h * k)))
    out = np.zeros((H, W, 3), np.uint8)
    y, x = (H - g.shape[0]) // 2, (W - g.shape[1]) // 2
    out[y:y + g.shape[0], x:x + g.shape[1]] = g
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wd', required=True)
    ap.add_argument('--exclude', default='', help='영상 접두 또는 접두:시작-끝(샷 번호) 을 쉼표로')
    ap.add_argument('--only-faceless', action='store_true')
    a = ap.parse_args()
    wd = os.path.join('D:/volcano-runs', a.wd)
    d = json.load(open(os.path.join(wd, '_shots', 'shots.json'), encoding='utf-8'))
    shifts = d.get('shift_up_px', {})
    rules = [r for r in a.exclude.split(',') if r]

    def excluded(s):
        for r in rules:
            if ':' in r:
                pre, rng = r.split(':')
                lo, hi = map(int, rng.split('-'))
                if s['video'].startswith(pre) and lo <= s['id'] <= hi:
                    return True
            elif s['video'].startswith(r):
                return True
        return False

    face = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))
    vids = {os.path.basename(v): v for v in d['videos']}
    caps, out, faces = {}, [], {}
    for s in d['shots']:
        if not s.get('usable') or excluded(s):
            continue
        cap = caps.setdefault(s['video'], cv2.VideoCapture(vids[s['video']]))
        n = 0
        mid = None
        for q in (0.25, 0.5, 0.75):
            f = frame(cap, s['t0'] + s['dur'] * q)
            if f is None:
                continue
            up = int(shifts.get(s['video'], 0))
            band = np.roll(f, -up, axis=0)[BAND_Y:BAND_Y + BAND_H] if up else f[BAND_Y:BAND_Y + BAND_H]
            if q == 0.5:
                mid = band
            g = cv2.cvtColor(cv2.resize(band, (540, 584)), cv2.COLOR_BGR2GRAY)
            n = max(n, len(face.detectMultiScale(g, 1.1, 6, minSize=(40, 40))))
        faces[s['id']] = n
        if a.only_faceless and n:
            continue
        if mid is not None:
            out.append((s, n, cv2.resize(mid, (148, 160))))
    cols = 12
    rows = max(1, (len(out) + cols - 1) // cols)
    sheet = np.zeros((rows * 192, cols * 148, 3), np.uint8)
    for k, (s, n, th) in enumerate(out):
        x, y = (k % cols) * 148, (k // cols) * 192
        sheet[y + 32:y + 192, x:x + 148] = th
        col = (0, 0, 255) if n else (0, 255, 255)
        cv2.putText(sheet, f"#{s['id']} {s['video'][:6]}", (x + 2, y + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.4, col, 1)
        cv2.putText(sheet, f"{s['dur']:.1f}s" + (' FACE' if n else ''), (x + 2, y + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.4, col, 1)
    cv2.imwrite(os.path.join(wd, '_shots', 'sheet_pov.jpg'), sheet)
    json.dump(faces, open(os.path.join(wd, '_shots', 'faces.json'), 'w'), indent=1)
    print(f'샷 {len(out)}개 · 얼굴 {sum(1 for v in faces.values() if v)}개 → {wd}/_shots/sheet_pov.jpg')


if __name__ == '__main__':
    main()
