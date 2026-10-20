# -*- coding: utf-8 -*-
"""쇼츠 클로즈업 창 — 컷마다 발언자 얼굴을 찾아 cx·zoom 을 plan 에 박는다(10-20 소유주 «인물만 확대·대비»).

    D:/midform/.venv-vision/Scripts/python.exe politics-hour/shorts/close_zoom.py <plan.json> [--band 0.79] [--dry]

규칙(관리자 10-20 14:30 전달):
  ① 얼굴 폭 ≈ 화면 폭 28%(띠를 피하느라 더 커질 수 있다) ② 눈높이 = 얼굴 띠 위 1/5(화면 37%) ③ 방송사 하단 자막 띠는 창 밖 — 못 빼면 그 컷은 안 쓴다(종료 3).
  ★처음 «얼굴 60%» 안(관리자 14:30)은 발굴 카드 수치(같은 날 저녁)로 바뀌었다.
plan 키:
  "band_y": 0.79      원본 높이 대비 하단 자막 띠 윗변(눈으로 재서 적는다, 없으면 --band, 기본 0.78)
                      소스 옆 <stem>.marks.json(린박스 소스 화면검사)의 박힌 자막 윗변 −0.01 이 더 높으면 그걸 쓴다
  컷 칸 "close": {"face": [x, y, w, h]}   얼굴 손 지정(원본 화소) — 기계가 다른 사람을 잡을 때만
결과: 칸마다 "cx", "zoom": [z, cy], "close_log": {...} — briefing_render.py 의 "layout": "close" 가 이 창으로 굽는다.
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'D:/midform/scripts')
from rinbox_faces import MODEL, read_range, W as RW   # noqa: E402

OUT_W, OUT_H = 1080, 864     # 얼굴 띠(briefing_render CLOSE_Y0~Y1)
FACE_FRAC = 0.28          # 목표 얼굴 폭 / 화면 폭(바로보자 상위 12편 단독 샷 실측)
EYE = 0.21                # 눈높이(띠 위에서) — 화면 높이 ≈ 37%
EYE_MAX = 0.30            # 띠를 피하려 창을 올리면 눈이 내려온다 — 이보다 아래면 창을 줄인다(얼굴이 커진다)
Z_MIN = 0.33              # 원본 높이의 1/3 미만 창은 너무 늘어나 뭉갠다 — 그런 컷은 안 쓴다
SAMPLE = 2.5              # 판독 초(컷 앞쪽)


def probe(src):
    o = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                        '-of', 'csv=p=0', str(src)], capture_output=True, text=True, check=True).stdout.strip().split(',')
    return int(o[0]), int(o[1])


def face_of(src, t0, t1, iw):
    """컷 앞쪽에서 가장 크고 오래 보이는 얼굴의 중앙값 (x, y, w, h, 눈 y) — 원본 화소."""
    frames = read_range(src, t0, min(t1, t0 + SAMPLE))
    h, w = frames.shape[1:3]
    det = cv2.FaceDetectorYN.create(str(MODEL), '', (w, h), 0.7)
    boxes = []
    for fr in frames[::2]:
        _, fs = det.detect(fr)
        if fs is None or not len(fs):
            continue
        f = max(fs, key=lambda r: r[2] * r[3])
        if f[2] / w < 0.04:
            continue
        boxes.append([f[0], f[1], f[2], f[3], (f[5] + f[7]) / 2])
    if len(boxes) < max(2, len(frames[::2]) // 3):
        return None
    s = iw / RW
    return [float(v) * s for v in np.median(np.array(boxes), axis=0)]


def window_for(face, iw, ih, band):
    x, y, fw, fh, ey = face
    cw = fw / FACE_FRAC
    ch = cw * OUT_H / OUT_W
    z = ch / ih
    why = ''
    if z > 1:
        z, ch = 1.0, ih
        cw = ch * OUT_W / OUT_H
    if z < Z_MIN:
        return None, '얼굴이 작다(창 %.2f < %.2f — %.1f배 늘어남)' % (z, Z_MIN, OUT_H / ch)
    top = ey - ch * EYE
    if top + ch > band:                       # 띠가 들어온다 → 창을 올린다
        top = band - ch
        if (ey - top) / ch > EYE_MAX:         # 눈이 위 1/3 에서 너무 내려옴 → 창을 줄인다(얼굴이 더 커진다)
            ch = max((band - ey) / (1 - EYE), band - (y - 0.12 * fh))   # 정수리까지는 창 안에(10-20 시험: 이마가 잘렸다)
            cw = ch * OUT_W / OUT_H
            top = band - ch
            z = ch / ih
            why = '띠 피하려 창 축소'
            if fw / cw > 0.6 or z < Z_MIN:
                return None, '하단 자막 띠를 못 뺀다(얼굴이 띠에 붙어 있다)'
        else:
            why = '띠 피하려 창 올림'
    top = max(0.0, top)
    cy = (top + ch / 2) / ih
    log = {'face_frac': round(fw / cw, 3), 'eye': round((ey - top) / ch, 3), 'upscale': round(OUT_H / ch, 2),
           'bottom_y': round((top + ch) / ih, 3), 'band_y': round(band / ih, 3), 'note': why}
    return (round((x + fw / 2) / iw, 4), [round(z, 4), round(cy, 4)]), log


def main():
    args = sys.argv[1:]
    pf = Path(args[0])
    plan = json.loads(pf.read_text(encoding='utf-8'))
    band_y = float(args[args.index('--band') + 1]) if '--band' in args else plan.get('band_y', 0.78)
    src = plan['source']
    mk = Path(src).with_name(Path(src).stem + '.marks.json')    # 린박스 소스 화면검사 캐시 — 박힌 자막 윗변이 더 높으면 그걸 쓴다
    if mk.exists():
        bs = json.loads(mk.read_text(encoding='utf-8')).get('burned_subs') or {}
        if bs.get('found'):
            band_y = min(band_y, round(bs['y_frac'][0] - 0.01, 3))
    iw, ih = probe(src)
    bad = 0
    for i, s in enumerate(plan['sequence']):
        if 'source_in' in s:
            t0, t1, kind = s['source_in'], s['source_out'], '컷'
        else:
            t0, t1, kind = s['pic_in'], s['pic_in'] + SAMPLE, '해설'
        face = (s.get('close') or {}).get('face')
        if face:
            face = list(map(float, face)) + [float(face[1]) + float(face[3]) * 0.42]
        else:
            face = face_of(src, t0, t1, iw)
        if not face:
            print('✗ %d %s %.2f  얼굴 없음 — 이 컷은 클로즈업 못 한다' % (i, kind, t0)); bad += 1
            continue
        res, log = window_for(face, iw, ih, band_y * ih)
        if not res:
            print('✗ %d %s %.2f  %s' % (i, kind, t0, log)); bad += 1
            continue
        s['cx'], s['zoom'], s['close_log'] = res[0], res[1], log
        print('✓ %d %s %.2f  cx %.3f z %.3f cy %.3f · 얼굴 %d%% · 눈 %.2f · %.1f배 · 창 아래 %.3f < 띠 %.3f %s'
              % (i, kind, t0, res[0], res[1][0], res[1][1], log['face_frac'] * 100, log['eye'], log['upscale'],
                 log['bottom_y'], log['band_y'], log['note']))
    plan['layout'] = 'close'
    plan['band_y'] = band_y
    plan.pop('camera', None)                   # 얼굴 추적 카메라 대신 컷마다 고정 창
    if '--dry' not in args:
        pf.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if bad:
        print('FAIL %d칸 — 그 컷을 빼거나 "close": {"face": [...]} 로 다시' % bad)
        sys.exit(3)
    print('OK %d칸' % len(plan['sequence']))


if __name__ == '__main__':
    main()
