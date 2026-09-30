# 쇼핑 소스에서 "출력에 써도 되는 샷"을 자동으로 골라 대장과 시트를 만든다.
#
#   python scripts/shot_picker.py --out <dir> <video> [<video> ...] [--band-y 420 --band-h 1080]
#
# 왜: 더우인 상품 영상은 여러 촬영분을 짜깁기하고 글자 띠·스티커·자막을 박는다. 어랍숏은 세로 원본의
#     가운데 정사각형만 쓰므로 위쪽 띠는 저절로 잘리지만, 가운데에 걸린 자막·팻말은 남는다.
#     그 판정과 샷 경계 찾기를 사람이 시트를 보며 하던 것을 기계로 옮긴다.
#
# 하는 일
#   1) PySceneDetect(ContentDetector)로 샷 경계
#   2) 샷마다 25/50/75% 지점 프레임의 가운데 정사각형에서 RapidOCR 로 글자 상자 검출
#   3) 64비트 dHash 로 짜깁기 영상 사이의 같은 장면을 한 번만 남김
#   4) <out>/shots.json + <out>/shots_clean.jpg(깨끗한 샷, 번호·원본·시각 표시)
#
# 글자 판정: 중국어·일본어·한국어 3자 이상 = 박힌 자막(overlay) → 뺀다 / 짧은 로고 = scene_text 경고(시트에 주황 'logo')
#            / 숫자만·같은 글자 반복 = 철망 무늬 오독(noise) → 무시. 0.6초 미만 샷은 짧아서 뺀다.
# 최종 판정은 여전히 눈이다(burned-subtitle-screening 메모리) — 시트를 반드시 열어 보라.
import argparse, json, os, sys
import cv2
import numpy as np
from scenedetect import detect, ContentDetector
from rapidocr_onnxruntime import RapidOCR

W, H = 1080, 1920


def frame_at(cap, t):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
    ok, f = cap.read()
    if not ok:
        return None
    return cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA)


def dhash(img):
    g = cv2.cvtColor(cv2.resize(img, (9, 8), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    bits = (g[:, 1:] > g[:, :-1]).flatten()
    return int(''.join('1' if b else '0' for b in bits), 2)


CJK = lambda t: sum(1 for c in t if '一' <= c <= '鿿' or '぀' <= c <= 'ヿ' or '가' <= c <= '힣')


def classify(txt):
    """overlay: 박힌 자막·문구(중국어 3자 이상) / scene: 제품 로고 같은 화면 속 글자 / noise: 철망 무늬 오독"""
    t = ''.join(txt.split())
    if CJK(t) >= 3:
        return 'overlay'
    core = [c for c in t if c.isalnum()]
    if len(core) < 2 or all(c.isdigit() for c in core) or len(set(core)) <= 1:
        return 'noise'
    return 'scene'


def hamming(a, b):
    return bin(a ^ b).count('1')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--band-y', type=int, default=420)
    ap.add_argument('--band-h', type=int, default=1080)
    ap.add_argument('--min-shot', type=float, default=0.6)
    ap.add_argument('--threshold', type=float, default=27.0)
    ap.add_argument('--min-text-score', type=float, default=0.5)
    ap.add_argument('videos', nargs='+')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    ocr = RapidOCR()
    shots, hashes = [], []
    for vi, path in enumerate(a.videos):
        scenes = detect(path, ContentDetector(threshold=a.threshold))
        cap = cv2.VideoCapture(path)
        if not scenes:
            dur = cap.get(cv2.CAP_PROP_FRAME_COUNT) / (cap.get(cv2.CAP_PROP_FPS) or 30)
            scenes = [(None, None)]
            spans = [(0.0, dur)]
        else:
            spans = [(s.get_seconds(), e.get_seconds()) for s, e in scenes]
        for t0, t1 in spans:
            d = t1 - t0
            rec = {'id': None, 'video': os.path.basename(path), 'video_index': vi, 't0': round(t0, 3),
                   't1': round(t1, 3), 'dur': round(d, 3), 'text': False, 'text_samples': [], 'scene_text': [], 'dup_of': None}
            if d < a.min_shot:
                rec['skip'] = 'short'
                shots.append(rec)
                continue
            mid = None
            for q in (0.25, 0.5, 0.75):
                f = frame_at(cap, t0 + d * q)
                if f is None:
                    continue
                band = f[a.band_y:a.band_y + a.band_h]
                if q == 0.5:
                    mid = band
                res, _ = ocr(band)
                for box, txt, score in (res or []):
                    if float(score) < a.min_text_score:
                        continue
                    kind = classify(txt)
                    if kind == 'overlay':
                        rec['text'] = True
                        rec['text_samples'].append(txt.strip()[:20])
                    elif kind == 'scene':
                        rec['scene_text'].append(txt.strip()[:20])
            if mid is not None:
                h = dhash(mid)
                for j, hh in hashes:
                    if hamming(h, hh) <= 6:
                        rec['dup_of'] = j
                        break
                hashes.append((len(shots), h))
                rec['_thumb'] = cv2.resize(mid, (160, 160))
            shots.append(rec)
        cap.release()

    clean = []
    for i, s in enumerate(shots):
        s['id'] = i
        s['usable'] = not s.get('skip') and not s['text'] and s['dup_of'] is None
        if s['usable']:
            clean.append(s)

    # 시트: 깨끗한 샷만, 번호·원본 번호·시각
    cols = 10
    rows = max(1, (len(clean) + cols - 1) // cols)
    sheet = np.zeros((rows * 190, cols * 160, 3), np.uint8)
    for k, s in enumerate(clean):
        x, y = (k % cols) * 160, (k // cols) * 190
        sheet[y + 30:y + 190, x:x + 160] = s['_thumb']
        cv2.putText(sheet, f"#{s['id']} v{s['video_index']}", (x + 3, y + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
        cv2.putText(sheet, f"{s['t0']:.1f}-{s['t1']:.1f}" + (' logo' if s['scene_text'] else ''), (x + 3, y + 27), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 165, 255) if s['scene_text'] else (255, 255, 255), 1)
    cv2.imwrite(os.path.join(a.out, 'shots_clean.jpg'), sheet)
    for s in shots:
        s.pop('_thumb', None)
    out = {'videos': a.videos, 'band': [a.band_y, a.band_h], 'shots': shots,
           'summary': {'total': len(shots), 'usable': len(clean),
                       'text': sum(1 for s in shots if s['text']),
                       'scene_text_warn': sum(1 for s in shots if s['usable'] and s['scene_text']),
                       'dup': sum(1 for s in shots if s['dup_of'] is not None),
                       'short': sum(1 for s in shots if s.get('skip') == 'short')}}
    with open(os.path.join(a.out, 'shots.json'), 'w', encoding='utf-8') as fp:
        fp.write(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(out['summary'], ensure_ascii=False))
    for s in shots:
        if s['text']:
            print(f"  text  #{s['id']} v{s['video_index']} {s['t0']:.1f}-{s['t1']:.1f} {s['text_samples'][:3]}")


if __name__ == '__main__':
    sys.exit(main())
