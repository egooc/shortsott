# -*- coding: utf-8 -*-
"""린박스 얼굴 추적 카메라 — 구간마다 «샷당 카메라 점»을 기계가 찍는다(2026-10-09).

    D:/midform/.venv-vision/Scripts/python.exe scripts/rinbox_faces.py <in.json> <out.json>
    D:/midform/.venv-vision/Scripts/python.exe scripts/rinbox_faces.py --compare <run>        손으로 찍은 점과 비교

in.json = {"source", "transcript", "iw", "cw", "ranges": [[t0, t1], ...]}
out.json = {"marks": [[[t, cx], [t, cx, "pan"], ...], ...]}   ranges 와 같은 순서, cx 는 원본 통짜 가로 0~1

왜: 볼케이노는 AGY 가 «누가 화자인가»를 판독하고 로컬 얼굴 추적이 그 사람을 따라갔다. 우리는 AGY 를 안 쓴다 —
화자 판정을 «말소리가 있는 동안 입이 움직이는 얼굴»로 대신한다(YuNet 의 입꼬리 두 점 사이를 프레임마다 비교).

한 샷 안에서:
  ① 얼굴들이 창(cw) 하나에 다 들어가면 → 그 묶음의 가운데
  ② 안 들어가면 → 말하는 동안 입이 가장 많이 움직인 얼굴, 확실치 않으면 가장 큰 얼굴
  ③ 얼굴이 없으면 → 앞 샷 자리 그대로(첫 샷이면 가운데)
  ④ 고른 얼굴이 샷 안에서 창 폭의 1/4 넘게 움직이면 → 끝 쪽에 "pan" 점을 하나 더 둔다
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rinbox_screen import shot_cuts   # noqa: E402

MODEL = Path(__file__).resolve().parents[1] / 'midform' / 'assets' / 'models' / 'face_detection_yunet_2023mar.onnx'
FPS = 10            # 판독 프레임 수(초당)
W = 640             # 판독 폭
MIN_PRESENT = 0.3   # 샷 프레임의 이 비율 넘게 보여야 «그 샷의 얼굴»
MIN_FACE = 0.04     # 판독 폭 대비 이보다 작은 얼굴은 배경 인물로 본다
SMALL_FACE = 0.06   # 가장 큰 얼굴이 판독 폭의 이보다 작으면 «넓은 샷»으로 본다
FOLLOW_TOL = 0.01   # 샷 안 궤적에서 직선을 벗어나는 허용치(창 폭 비율). 엔진은 정확히 일직선 위 점만 뺀다(_decimate) —
                    # 우리도 데드존 없이 흐르게 두고, 판독 잡음 수준(창 폭 1% ≈ 출력 11px)만 접는다.
FLASH = 2           # 이보다 적은 판독 프레임(0.2초 미만)의 샷은 읽지 않고 앞 창을 그대로 둔다 —
                    # 명화관 shot_focus 의 flash_aliases 와 같은 생각(엔진 shorts_framing.py 88~100)
# ★명화관 세션의 scripts/shot_focus.py detect 가 이 파일의 read_range · mouth_patch · MODEL · FPS · W ·
#   MIN_FACE · MIN_PRESENT 를 import 한다 — 이름·뜻을 바꾸면 그쪽이 깨진다(2026-10-09 두 세션 합의).


def read_range(src, t0, t1):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '%.3f' % t0, '-t', '%.3f' % (t1 - t0), '-i', str(src),
                        '-vf', 'fps=%d,scale=%d:-2' % (FPS, W), '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                       capture_output=True, check=True)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                            '-of', 'csv=p=0', str(src)], capture_output=True, text=True, check=True).stdout.strip().split(',')
    h = int(round(int(probe[1]) * W / int(probe[0]) / 2)) * 2
    return np.frombuffer(p.stdout, np.uint8).reshape(-1, h, W, 3)


def mouth_patch(gray, f):
    """입꼬리 두 점을 감싸는 작은 회색 조각, 32x16 으로 맞춘다.
    YuNet 한 줄 = x,y,w,h · 오른눈(4,5) · 왼눈(6,7) · 코(8,9) · 입 오른쪽(10,11) · 입 왼쪽(12,13) · 점수(14).
    ★2026-10-09 까지 9~12 를 읽었다(코 y 가 섞였다) — 입이 아닌 데를 비교해 화자 판정이 사실상 무작위였다."""
    mx0, my0, mx1, my1 = f[10], f[11], f[12], f[13]
    cx, cy = (mx0 + mx1) / 2, (my0 + my1) / 2
    half = max(abs(mx1 - mx0) * 0.9, f[2] * 0.18)
    x0, x1 = int(max(0, cx - half)), int(min(gray.shape[1], cx + half))
    y0, y1 = int(max(0, cy - half * 0.6)), int(min(gray.shape[0], cy + half * 0.6))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 16)).astype(np.float32)


def sharpness(gray, f):
    """얼굴 안쪽의 선명도. 어깨너머 앞사람은 초점이 나가 낮다.
    네모 가운데 60% 만 본다(머리카락·창문 경계가 섞이면 흐린 얼굴도 높게 나온다 — 83ko 117초 실측),
    밝기 대비로 나눠 어두운 얼굴이 손해 보지 않게 한다."""
    x0, y0 = int(max(0, f[0] + f[2] * 0.2)), int(max(0, f[1] + f[3] * 0.2))
    x1, y1 = int(min(gray.shape[1], f[0] + f[2] * 0.8)), int(min(gray.shape[0], f[1] + f[3] * 0.8))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return 0.0
    g = cv2.resize(gray[y0:y1, x0:x1], (48, 48)).astype(np.float32)
    return float(cv2.Laplacian(g, cv2.CV_32F).var() / (g.std() ** 2 + 25.0))


def tracks_in(dets, grays, speech):
    """한 샷의 프레임별 얼굴 → 같은 사람끼리 묶은 트랙. 가로 중심이 가까우면 같은 사람."""
    tracks = []
    for i, faces in enumerate(dets):
        for f in faces:
            c = f[0] + f[2] / 2
            best = min(tracks, key=lambda t: abs(t['c'][-1] - c), default=None)
            if best is not None and abs(best['c'][-1] - c) < max(0.08 * W, f[2] * 0.6) and best['i'][-1] != i:
                tr = best
            else:
                tr = {'i': [], 'c': [], 'w': [], 'box': [], 'patch': [], 'sharp': []}
                tracks.append(tr)
            tr['i'].append(i); tr['c'].append(c); tr['w'].append(f[2])
            tr['box'].append((f[0], f[0] + f[2]))
            tr['patch'].append(mouth_patch(grays[i], f))
            tr['sharp'].append(sharpness(grays[i], f))
    for tr in tracks:
        moves = []
        for k in range(1, len(tr['i'])):
            a, b = tr['patch'][k - 1], tr['patch'][k]
            if a is None or b is None or tr['i'][k] - tr['i'][k - 1] > 2 or not speech[tr['i'][k]]:
                continue
            moves.append(float(np.mean(np.abs(a - b))) / (np.std(a) + 8.0))
        tr['motion'] = float(np.mean(moves)) if len(moves) >= 2 else 0.0
        tr['size'] = float(np.median(tr['w']))
        tr['sharpness'] = float(np.median(tr['sharp']))
        # 화면 가장자리에 걸려 잘린 얼굴(앞에 걸친 뒤통수·흐린 어깨너머 인물) — 흐림 잡음이 «입 움직임»으로 잡힌다
        tr['edge'] = bool(np.median([x0 <= 0.01 * W or x1 >= 0.99 * W for x0, x1 in tr['box']]) >= 0.5)
    return tracks


def group_span(trs):
    """여럿을 한 창에 묶을 수 있는지 — **프레임마다** 잰 폭의 90 백분위. 가운데값만 보면 두 사람이
    벌어지는 순간 창을 넘는다(명화관 lsr01 139.367)."""
    by_frame = {}
    for t in trs:
        for i, (x0, x1) in zip(t['i'], t['box']):
            lo, hi = by_frame.get(i, (x0, x1))
            by_frame[i] = (min(lo, x0), max(hi, x1))
    lo = min(np.median([x0 for x0, _ in t['box']]) for t in trs)
    hi = max(np.median([x1 for _, x1 in t['box']]) for t in trs)
    spans = [h - l for l, h in by_frame.values()]
    return max(hi - lo, float(np.percentile(spans, 90)) if spans else 0.0)


def follow(track, n, win):
    """고른 얼굴의 샷 안 궤적 → 꺾이는 점만 남긴 [(프레임, x)]. ±0.5초 중앙값으로 떨림을 죽이고(엔진의 rolling
    median), 직선에서 창 폭 8% 넘게 벗어나는 데만 점을 둔다(엔진 _decimate 와 같은 생각). 움직임이 창 폭 15% 안이면 한 점.
    양 끝 두 점만 보면 갔다 돌아오는 움직임을 놓친다(명화관 186.633)."""
    xs = np.interp(np.arange(n), track['i'], track['c'])
    half = FPS // 2
    sm = np.array([np.median(xs[max(0, k - half):k + half + 1]) for k in range(n)])
    if sm.max() - sm.min() <= win * FOLLOW_TOL:
        return [(0, float(np.median(sm)))]
    keep = {0, n - 1}

    def split(i, j):
        if j - i < 2:
            return
        line = sm[i] + (sm[j] - sm[i]) * (np.arange(i, j + 1) - i) / (j - i)
        k = int(np.argmax(np.abs(sm[i:j + 1] - line))) + i
        if abs(sm[k] - line[k - i]) > win * FOLLOW_TOL:
            keep.add(k)
            split(i, k)
            split(k, j)
    split(0, n - 1)
    return [(k, float(sm[k])) for k in sorted(keep)]


def plan_range(src, words, t0, t1, iw, cw, prev):
    frames = read_range(src, t0, t1)
    n = len(frames)
    if n == 0:
        return [[t0, prev]], prev, []
    det = cv2.FaceDetectorYN.create(str(MODEL), '', (frames.shape[2], frames.shape[1]), 0.6, 0.3, 50)
    dets, grays = [], []
    for fr in frames:
        _, faces = det.detect(fr)
        faces = [] if faces is None else [f for f in faces if f[2] >= MIN_FACE * W]
        dets.append(faces)
        grays.append(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY))
    times = [t0 + i / FPS for i in range(n)]
    speech = [any(w[0] <= t < w[1] + 0.1 for w in words) for t in times]
    cuts, _ = shot_cuts(frames) if n > 2 else ([], None)
    bounds = [0] + cuts + [n]
    win = cw / iw * W                     # 창 폭(판독 화소)
    marks, log = [], []
    for a, b in zip(bounds, bounds[1:]):
        if b - a < FLASH:
            if marks:
                log.append('  %.2f 짧은 샷(%d장) → 앞 창 그대로' % (times[a], b - a))
                continue
            if b < n:                     # 맨 앞이 짧은 샷이면 다음 샷이 판정한다
                continue
        trs = [t for t in tracks_in(dets[a:b], grays[a:b], speech[a:b]) if len(t['i']) >= MIN_PRESENT * (b - a)]
        why = ''
        if not trs:
            # 얼굴이 없는 샷(문서·풍경 인서트)은 가운데 — 앞 자리를 끌고 오면 창이 가장자리에 남는다(83ko 112초)
            target, track, why = 0.5, None, '얼굴 없음 → 가운데'
        else:
            lo = min(np.median([x0 for x0, _ in t['box']]) for t in trs)
            hi = max(np.median([x1 for _, x1 in t['box']]) for t in trs)
            if max(t['size'] for t in trs) < SMALL_FACE * W:
                # 넓은 샷에 작은 얼굴뿐 — 누구를 비출 근거가 없다, 가운데(83ko 110초: 끝에 선 사람에게 갔다)
                target, track, why = 0.5, None, '작은 얼굴뿐 → 가운데'
            elif group_span(trs) <= win * 0.9:
                target, track, why = (lo + hi) / 2 / W, None, '%d명 다 들어감' % len(trs)
            else:
                # 잘린 가장자리 얼굴은 화자 후보에서 뺀다(78ja 397초 — 앞에 걸친 아이를 골랐다)
                cand = [t for t in trs if not t['edge']] or trs
                # 초점 밖 얼굴도 뺀다 — 가장 선명한 얼굴의 65% 미만. 흐린 앞사람의 입 언저리 흐림이 «입 움직임»으로
                #   잡혀 창이 그쪽으로 갔다(83ko 117~134초). 처음엔 «더 큰» 조건도 걸었는데, 명화관에서 흐린 **작은**
                #   방해물이 그 그물을 빠져나갔다(lsr01 11.900 외 3곳) — 크기 조건을 뺐다. 6편에선 78ja 478초만 바뀌었고 나아졌다.
                sharp = max(cand, key=lambda t: t['sharpness'])
                cand = [t for t in cand if t['sharpness'] >= 0.65 * sharp['sharpness']] or cand
                by_motion = sorted(cand, key=lambda t: -t['motion'])
                if by_motion[0]['motion'] > 0 and (len(by_motion) < 2 or by_motion[0]['motion'] > 1.3 * by_motion[1]['motion']):
                    track, why = by_motion[0], '입 움직임 %.2f' % by_motion[0]['motion']
                else:
                    by_size = sorted(cand, key=lambda t: -t['size'])
                    if len(by_size) >= 3 and by_size[0]['size'] < 1.5 * by_size[1]['size']:
                        # 넓은 샷에 고만고만한 얼굴 여럿 — 한 사람을 고를 근거가 없다, 크기 가중 가운데(83ko 110초)
                        track = None
                        tot = sum(t['size'] for t in by_size)
                        target = sum(float(np.median(t['c'])) * t['size'] for t in by_size) / tot / W
                        why = '얼굴 %d명 고만고만 → 가중 가운데' % len(by_size)
                    else:
                        track, why = by_size[0], '가장 큰 얼굴'
                if track is not None:
                    target = float(np.median(track['c'])) / W
        target = round(float(target), 3)
        marks.append([round(times[a], 3), target])
        log.append('  %.2f~%.2f 얼굴 %d · %s → cx %.3f' % (times[a], times[b - 1] + 1 / FPS, len(trs), why, target))
        if track is not None and len(track['c']) >= 8:
            path = follow(track, b - a, win)
            if len(path) > 1:
                marks[-1][1] = round(path[0][1] / W, 3)
                for k, x in path[1:]:
                    marks.append([round(times[a + k], 3), round(x / W, 3), 'pan'])
                log.append('    샷 안에서 따라감 ' + ' → '.join('%.3f' % (x / W) for _, x in path))
                target = round(path[-1][1] / W, 3)
        prev = target
    if not marks:
        marks = [[t0, prev]]
    marks[0][0] = round(t0, 3)
    return marks, prev, log


def run(spec):
    words = json.loads(Path(spec['transcript']).read_text(encoding='utf-8'))
    out, prev = [], 0.5
    for t0, t1 in spec['ranges']:
        marks, prev, log = plan_range(spec['source'], words, t0, t1, spec['iw'], spec['cw'], prev)
        print('구간 %.2f~%.2f' % (t0, t1))
        print('\n'.join(log))
        out.append(marks)
    return out


def cx_at(marks, t):
    cur = marks[0][1]
    for m in marks[1:]:
        if m[0] <= t:
            cur = m[1]
    return cur


def compare(run_dir):
    """마지막 렌더(pieces.json)의 손 카메라와 기계 카메라를 같은 시각에서 비교한다."""
    run_dir = Path(run_dir)
    pm = json.loads((run_dir / '_render' / 'pieces.json').read_text(encoding='utf-8'))
    plan = json.loads((run_dir / 'plan_local.json').read_text(encoding='utf-8'))
    src = pm['source']
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width',
                            '-of', 'csv=p=0', str(src)], capture_output=True, text=True, check=True).stdout.strip()
    iw = int(probe.split(',')[0])
    pieces = [p for p in pm['pieces'] if 'cam' in p]
    spec = {'source': src, 'transcript': plan['transcript'], 'iw': iw, 'cw': pieces[0]['cw'],
            'ranges': [[p['src_t0'], p['src_t0'] + p['frames'] / 30] for p in pieces]}
    auto = run(spec)
    far, total = 0, 0
    for p, marks in zip(pieces, auto):
        for f in range(0, p['frames'], 15):
            x = p['cam'][0][1]
            for fa, xa, _ in p['cam']:
                if fa <= f:
                    x = xa
            hand = (x + p['cw'] / 2) / iw
            mach = cx_at(marks, p['src_t0'] + f / 30)
            d = abs(hand - mach) * iw / p['cw']          # 창 폭 단위
            total += 1
            if d > 0.25:
                far += 1
                print('  ≠ 원본 %.2f초 손 %.3f 기계 %.3f (창 폭의 %.0f%%)' % (p['src_t0'] + f / 30, hand, mach, d * 100))
    print('%s: 0.5초 표본 %d곳 중 %d곳이 창 폭 1/4 넘게 다르다' % (run_dir.name, total, far))


if __name__ == '__main__':
    if sys.argv[1] == '--compare':
        for d in sys.argv[2:]:
            compare(d)
    else:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        Path(sys.argv[2]).write_text(json.dumps({'marks': run(spec)}, ensure_ascii=False) + '\n', encoding='utf-8')
