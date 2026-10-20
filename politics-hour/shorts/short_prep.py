# -*- coding: utf-8 -*-
"""쇼츠 얼굴 띠 소스 만들기 — 주고받기 장면을 1080x864(가운데 45% 얼굴 띠)로 미리 짜 맞춘다(10-20 소유주 «바로보자처럼»).

    D:/midform/.venv-vision/Scripts/python.exe politics-hour/shorts/short_prep.py <prep.json>

prep.json = {"src": "...mp4", "transcript": "...json", "out": "...mp4", "band_y": 0.82, "top_y": 0.13,   top_y = 위 고정 표식 아랫변
             "parts": [{"in": 249.2, "out": 254.59, "mode": "fit"},
                       {"in": 254.59, "out": 261.1, "mode": "split"},      질문자 왼쪽 · 답변자 오른쪽(원본 좌우 분할 화면에서 얼굴 둘)
                       {"in": 503.0, "out": 512.3, "mode": "single", "x": [0.35, 0.7]}]}   얼굴 하나 클로즈업(x = 찾을 가로 범위)
  fit    : 원본 전체를 폭 1080 에 맞추고 위아래 검정(도표·자료 화면)
  split  : 원본 왼쪽 반·오른쪽 반에서 가장 큰 얼굴을 하나씩 찾아 각 540x864 판으로 잘라 붙인다(얼굴 폭 ≈ 화면 20%, 바로보자 실측)
  single : 가장 큰 얼굴 하나(얼굴 폭 ≈ 화면 28%)
  둘 다 눈높이 = 판 위 1/4, 창 아래가 band_y(원본 높이 비율, 박힌 이름표·자막 윗변) 위 — 못 맞추면 종료 3.
결과: out(1080x864, 30fps) + out 옆 <stem>.json(받아쓰기, 시각을 새 파일 기준으로 옮김) + <stem>.prep.json(조각 지도: 새 시각 ↔ 원본 시각).
plan.json 에서는 이 파일을 source 로, "zoom": [1.0, 0.5], "cx": 0.5 로 쓴다(창 = 화면 전체).
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

BW, BH, FPS = 1080, 864, 30
FRAC = {'split': 0.40, 'single': 0.28}    # 얼굴 폭 / 판 폭(split 판 540 → 화면 20%), single 은 화면 28%
EYE = 0.25


def probe(src):
    o = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                        '-of', 'csv=p=0', str(src)], capture_output=True, text=True, check=True).stdout.strip().split(',')
    return int(o[0]), int(o[1])


def faces(src, t0, t1, iw):
    """구간 가운데 1.5초의 얼굴들 [(x, y, w, h, 눈y)] — 원본 화소, 프레임마다 가장 큰 순."""
    mid = (t0 + t1) / 2
    fr = read_range(src, max(t0, mid - .75), min(t1, mid + .75))
    h, w = fr.shape[1:3]
    det = cv2.FaceDetectorYN.create(str(MODEL), '', (w, h), 0.7)
    s = iw / RW
    out = []
    for f in fr[::3]:
        _, fs = det.detect(f)
        if fs is not None:
            out.append([[v * s for v in (r[0], r[1], r[2], r[3], (r[5] + r[7]) / 2)] for r in fs if r[2] / w >= 0.03])
    return out


def pick(frames, x_lo, x_hi):
    """x 범위 안의 가장 큰 얼굴 — 프레임들의 중앙값."""
    got = []
    for fs in frames:
        c = [f for f in fs if x_lo <= f[0] + f[2] / 2 < x_hi]
        if c:
            got.append(max(c, key=lambda f: f[2] * f[3]))
    if len(got) < max(1, len(frames) // 3):
        return None
    return list(np.median(np.array(got), axis=0))


def crop_for(face, pw, ph, frac, x_lo, x_hi, ih, band, top_min=0.0):
    """판(pw x ph)에 넣을 원본 창 (x, y, w, h). top_min = 창 윗변 하한(원본 위쪽 고정 표식·위원회 표시 아래)."""
    x, y, fw, fh, ey = face
    cw = fw / frac
    ch = cw * ph / pw
    if ch > band - top_min:                     # 표식과 띠 사이에 다 안 들어간다 → 그 사이 높이로 줄인다
        ch = band - top_min
        cw = ch * pw / ph
    top = max(ey - ch * EYE, top_min)
    if top + ch > band:
        top = band - ch
        if (ey - top) / ch > 0.4:              # 눈이 너무 내려온다 → 창을 줄인다(얼굴이 커진다, close_zoom 과 같은 수)
            ch = max((band - ey) / (1 - EYE), band - (y - 0.12 * fh))
            cw = ch * pw / ph
            top = band - ch
            if fw / cw > 0.8:
                return None, '이름표·자막 띠를 못 뺀다(얼굴이 띠에 붙어 있다)'
    top = max(top_min, top)
    if top + ch > band + 1:
        return None, '위 표식과 아래 띠 사이에 창이 안 들어간다'
    left = min(max(x + fw / 2 - cw / 2, x_lo), x_hi - cw)
    if left < x_lo - 1 or cw > x_hi - x_lo:
        return None, '창이 반쪽 화면보다 넓다(얼굴이 작다)'
    return [int(left) // 2 * 2, int(top) // 2 * 2, int(cw) // 2 * 2, int(ch) // 2 * 2], 'ok'


def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    src, out = spec['src'], Path(spec['out'])
    iw, ih = probe(src)
    band = spec.get('band_y', 0.82) * ih
    words = json.loads(Path(spec['transcript']).read_text(encoding='utf-8'))
    parts, new_words, mp, t = [], [], [], 0.0
    work = out.with_suffix('')
    work.mkdir(parents=True, exist_ok=True)
    for k, p in enumerate(spec['parts']):
        a, b, mode = p['in'], p['out'], p['mode']
        d = b - a
        if mode == 'fit':
            vf = f'scale={BW}:-2,pad={BW}:{BH}:0:(oh-ih)/2:black'
            log = 'fit'
        else:
            fr = faces(src, a, b, iw)
            if mode == 'split':
                L = pick(fr, 0, iw / 2)
                R = pick(fr, iw / 2, iw)
                tm = spec.get('top_y', 0) * ih
                if not (L and R):
                    sys.exit(f'✗ 조각 {k} split: 얼굴 둘을 못 찾음(왼 {bool(L)} 오른 {bool(R)})')
                cl, wl = crop_for(L, BW // 2, BH, FRAC['split'], 0, iw / 2, ih, band, tm)
                cr, wr = crop_for(R, BW // 2, BH, FRAC['split'], iw / 2, iw, ih, band, tm)
                if not (cl and cr):
                    sys.exit(f'✗ 조각 {k} split: {wl} / {wr}')
                vf = (f'split[l][r];[l]crop={cl[2]}:{cl[3]}:{cl[0]}:{cl[1]},scale={BW // 2}:{BH}[L];'
                      f'[r]crop={cr[2]}:{cr[3]}:{cr[0]}:{cr[1]},scale={BW // 2}:{BH}[R];[L][R]hstack')
                log = f'split 왼 {cl} 오른 {cr} · 얼굴 왼 {L[2] / cl[2] * 50:.0f}% 오른 {R[2] / cr[2] * 50:.0f}%(화면 폭 대비)'
            else:
                xr = p.get('x', [0, 1])                 # 얼굴 찾을 가로 범위(원본 폭 비율) — 큰 얼굴이 딴 사람일 때
                F = pick(fr, xr[0] * iw, xr[1] * iw)
                if not F:
                    sys.exit(f'✗ 조각 {k} single: 얼굴 없음')
                c, why = crop_for(F, BW, BH, FRAC['single'], 0, iw, ih, band, spec.get('top_y', 0) * ih)
                if not c:
                    sys.exit(f'✗ 조각 {k} single: {why}')
                vf = f'crop={c[2]}:{c[3]}:{c[0]}:{c[1]},scale={BW}:{BH}'
                log = f'single {c} · 얼굴 {F[2] / c[2] * 100:.0f}%(화면 폭 대비)'
        pv = work / f'p{k:02d}.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{a:.3f}', '-i', src, '-t', f'{d:.3f}',
                        '-filter_complex', f'[0:v]fps={FPS},{vf},setsar=1[v]', '-map', '[v]', '-map', '0:a',
                        '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                        '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', str(pv)], check=True)
        parts.append(pv)
        for w in words:
            if a <= w[0] < b:                       # 시작이 조각 안이면 넣고, 끝은 조각 끝에서 자른다(경계에 걸친 낱말이 빠졌다 — 10-20 «어떻게»)
                new_words.append([round(w[0] - a + t, 3), round(min(w[1], b) - a + t, 3), *w[2:]])
        mp.append({'part': k, 'mode': mode, 'new': [round(t, 3), round(t + d, 3)], 'src': [a, b], 'log': log})
        print(f'✓ 조각 {k} {mode} 원본 {a:.2f}~{b:.2f} → 새 {t:.2f}~{t + d:.2f} · {log}')
        t += d
    lst = work / 'list.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst),
                    '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', str(FPS),
                    '-c:a', 'aac', '-b:a', '192k', str(out)], check=True)     # concat 은 다시 굽는다(0번 프레임 함정)
    out.with_suffix('.json').write_text(json.dumps(new_words, ensure_ascii=False) + '\n', encoding='utf-8')
    out.with_name(out.stem + '.prep.json').write_text(json.dumps({'src': src, 'parts': mp}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'완성 {out} · {t:.2f}초 · 낱말 {len(new_words)}')


if __name__ == '__main__':
    main()
