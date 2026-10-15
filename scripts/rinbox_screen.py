# -*- coding: utf-8 -*-
"""린박스 화면 검사 — 시청자가 실제로 보는 그림 창(자막을 얹기 전 pic.mp4)을 조각마다 본다.

    D:/midform/.venv-vision/Scripts/python.exe scripts/rinbox_screen.py <런>/_render     문제가 있으면 종료코드 1

왜 (2026-10-09): 자체 렌더러의 화면 검사가 «내 눈» 하나였다. 볼케이노는 샘플 프레임마다 글자 상자를 재고
크롭 창이 글자와 겹치면 그 컷을 반려했고(text_overlap), 샷 경계에 다른 샷이 15프레임 이하로 끼면 반려했다
(boundary_audit). 그 두 가지를 우리 창에 맞춰 옮긴다. AGY(누가 화자인가)는 옮기지 않는다.

  ① 글자 — RapidOCR 의 «검출»만 쓴다(읽지 않는다 → 한·일 다 된다).
     ✗ 한 조각 샘플의 절반 넘게 같은 자리에 글자 = 로고·박힌 자막·방송 표식
     △ 잠깐 비치는 글자 = 간판·소품일 수 있다 → 표시해 둔 시트를 눈으로 본다
  ② 경계 — 조각 앞·끝에 MIN_FRAG 프레임 이하의 다른 샷이 끼면 ✗ (깜빡이는 조각)
     + 보조 축(2026-10-15): 원본 덩어리 앞·끝을 ffmpeg scene>0.12 로 다시 잰다. 0.3초 넘게 이어지면 움직임 △
     어두운 장면도 잡게 밝기 차가 아니라 «정규화한 색 분포» 차로 샷 경계를 찾는다.

★그래도 마지막 판정은 눈이다 — 걸린 프레임은 상자를 그려 <_render>/screen_flags.png 로 남긴다.
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')
MIN_FRAG = 15          # 볼케이노 boundary_audit 의 minimum_partial_shot_frames
SAMPLE_EVERY = 10      # 글자 검출은 10프레임(1/3초)마다
STICKY = 0.5           # 이 비율 넘게 같은 자리에 있으면 «붙박이 글자»
SMALL_W = 160
W_OUT, H_OUT = 1080, 1020   # 렌더러의 그림 창


def read_small(pic):
    """샷 경계용 — 작게 줄인 전 프레임."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(pic), '-vf', 'scale=%d:-2' % SMALL_W,
                        '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True, check=True)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                            '-of', 'csv=p=0', str(pic)], capture_output=True, text=True, check=True).stdout.strip().split(',')
    w0, h0 = int(probe[0]), int(probe[1])
    h = int(round(h0 * SMALL_W / w0 / 2)) * 2
    return np.frombuffer(p.stdout, np.uint8).reshape(-1, h, SMALL_W, 3)


def shot_cuts(frames):
    """프레임 i 가 새 샷의 첫 장이면 i 를 돌려준다. 색 분포(HSV 히스토그램, 정규화) 거리 + 주변 대비."""
    hs = []
    for f in frames:
        hsv = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)
        hst = cv2.calcHist([hsv], [0, 1, 2], None, [12, 6, 6], [0, 180, 0, 256, 0, 256])
        hs.append(cv2.normalize(hst, None).flatten())
    d = np.array([0.0] + [cv2.compareHist(hs[i - 1], hs[i], cv2.HISTCMP_BHATTACHARYYA) for i in range(1, len(hs))])
    cuts = []
    for i in range(1, len(d)):
        local = np.median(d[max(1, i - 8):i + 9])
        if d[i] > 0.35 and d[i] > 3 * max(local, 0.03):
            cuts.append(i)
    # 보조 축 — 회색 평균 절대차(자리를 보는 측정). 흑백 필름은 샷이 바뀌어도 밝기 분포가 그대로라
    #   히스토그램이 못 본다(月影兵庫 84ja: 히스토그램 2곳, 실제 8곳 — ffmpeg scene>0.35 와 같은 8곳,
    #   명화관 실측 2026-10-09). 컬러 소재에선 이 문턱을 넘는 자리를 이미 위가 잡아 결과가 안 바뀐다.
    gs = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (160, 120)).astype(np.float32) for f in frames]
    for i in range(1, len(gs)):
        if float(np.abs(gs[i] - gs[i - 1]).mean()) > 40:
            cuts.append(i)
    # ★2프레임 안의 검출은 하나로 — 컷 하나를 두 번 세면 없는 1프레임 조각이 생겨 멀쩡한 렌더가 반려된다
    merged = []
    for i in sorted(set(cuts)):
        if merged and i - merged[-1] <= 2:
            continue
        merged.append(i)
    return merged, d


def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    i = (x1 - x0) * (y1 - y0)
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)


def grab(pic, idx):
    cap = cv2.VideoCapture(str(pic))
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ok, f = cap.read()
    cap.release()
    return f if ok else None


def cam_x(p, rel):
    """조각 p 의 rel 번째 프레임에서 창 왼쪽 x(원본 화소). 렌더러 cam_expr 와 같은 식."""
    pts = p['cam']
    for (fa, xa, _), (fb, xb, jump) in zip(pts, pts[1:]):
        if rel < fb:
            if jump or fb <= fa:
                return xa
            return xa + (xb - xa) * min(1.0, max(0.0, (rel - fa) / (fb - fa)))
    return pts[-1][1]


def src_box(box, p, iw, ih, mirror, rel=0):
    """그림 창(1080x1020) 상자 → 원본 좌표. 렌더러의 crop 을 거꾸로 푼다."""
    if 'cam' in p:
        cw, ch, x0, y0 = p['cw'], p['ch'], cam_x(p, rel), p['y']
    else:                                   # 옛 지도(2026-10-09 오전 이전 렌더)
        z, cy = p['zoom']
        ch = ih * z
        cw = min(iw, ih * z * W_OUT / H_OUT)
        x0 = min(max(iw * float(p['cx']) - cw / 2, 0), iw - cw)
        y0 = min(max(ih * cy - ch / 2, 0), ih - ch)
    bx0, by0, bx1, by1 = box
    if mirror:
        bx0, bx1 = W_OUT - bx1, W_OUT - bx0
    sx, sy = cw / W_OUT, ch / H_OUT
    return (x0 + bx0 * sx, y0 + by0 * sy, x0 + bx1 * sx, y0 + by1 * sy)


def same_spot(a, b, iw):
    """같은 자리인가 — 세로로 반 넘게 겹치고 가로 중심이 화면 폭 8% 안. 자막은 글이 바뀌어 폭이 달라도 잡힌다."""
    oy = min(a[3], b[3]) - max(a[1], b[1])
    uy = max(a[3], b[3]) - min(a[1], b[1])
    return uy > 0 and oy / uy > 0.5 and abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) < 0.08 * iw



EDGE_SCENE = 0.12      # 보조 경계 검사 문턱(ffmpeg scene) — 저대비 흑백 컷이 0.22~0.33 으로 나온다
EDGE_MOTION = 0.3      # 문턱 넘는 프레임이 이보다 길게 이어지면 컷이 아니라 카메라 움직임(△ 로 낮춘다)
EDGE_WIN = 0.6         # 덩어리 앞·끝에서 볼 원본 초


def source_edges(src, a, b):
    """원본 a~b 초에서 장면 변화 무리를 돌려준다 [(첫 프레임 시각, 최고 점수, 길이초)].
    ★왜(2026-10-15): shot_cuts 가 素浪人花山大吉 의 컷을 0~1곳만 봤다(회색 평균차 문턱 40 > 실제 컷).
      109ja 끝 4프레임·롱투숏 ls18·ls23 시작 1~3프레임이 «통과»로 나왔다. 원본에서 다시 재는 보조 축이다.
      shot_cuts 는 shot_focus·rinbox_faces 가 import 하므로 건드리지 않는다."""
    import re
    a = max(0.0, a)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-ss', '%.3f' % a, '-t', '%.3f' % (b - a), '-i', str(src), '-vf',
                        "scale=160:120,select='gte(scene,0)',metadata=print", '-an', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    frames, pts = [], None
    for line in r.stderr.splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            pts = float(m.group(1))
        m = re.search(r'scene_score=([\d.]+)', line)
        if m and pts is not None:
            frames.append((a + pts, float(m.group(1))))
    groups, cur = [], []
    for k, (t, sc) in enumerate(frames):
        if sc > EDGE_SCENE:
            cur.append((t, sc))
        elif cur:
            groups.append(cur); cur = []
    if cur:
        groups.append(cur)
    # 0.2초 안에 붙은 무리는 하나로 — 팬·흔들림은 문턱 위아래를 오가며 끊겨 찍힌다(롱투숏 ls16 3485.72~3485.92,
    #   0.12~0.13 이 0.1초 간격으로 세 번). 합친 무리가 EDGE_MOTION 보다 길면 움직임이다.
    merged = []
    for g in groups:
        if merged and g[0][0] - merged[-1][-1][0] <= 0.2:
            merged[-1] = merged[-1] + g
        else:
            merged.append(g)
    groups = merged
    out = []
    for g in groups:
        best = max(g, key=lambda x: x[1])
        out.append((best[0], best[1], g[-1][0] - g[0][0]))
    return out


def main(render_dir):
    rd = Path(render_dir)
    pm = json.loads((rd / 'pieces.json').read_text(encoding='utf-8'))
    pic = rd / 'pic.mp4'
    pr = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                         '-of', 'csv=p=0', pm['source']], capture_output=True, text=True, check=True).stdout.strip().split(',')
    iw, ih = int(pr[0]), int(pr[1])
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()

    small = read_small(pic)
    cuts, _ = shot_cuts(small)
    errors, warns, flagged = [], [], []

    # 원본에서 이어지는 조각(cx 만 바꾼 자리)은 한 덩어리 — 깜빡임은 덩어리 앞·끝에서만 본다
    runs, cur = [], None
    for p in pm['pieces']:
        if cur and abs(cur['src_t1'] - p['src_t0']) < 0.5 / 30 + 1e-6:
            cur['b'] = p['out_f0'] + p['frames']; cur['src_t1'] = p['src_t0'] + p['frames'] / 30
            cur['starts'].append(p['out_f0'])
        else:
            cur = {'a': p['out_f0'], 'b': p['out_f0'] + p['frames'], 'src_t0': p['src_t0'],
                   'src_t1': p['src_t0'] + p['frames'] / 30, 'starts': [p['out_f0']], 'jumps': []}
            runs.append(cur)
        cur['jumps'] += [p['out_f0'] + f for f, _, jump in p.get('cam', [])[1:] if jump]
    edits = {r['a'] for r in runs}
    for r in runs:
        inner = [c for c in cuts if r['a'] < c < r['b']]
        tag = '구간(원본 %.2f~%.2fs)' % (r['src_t0'], r['src_t1'])
        if inner and inner[0] - r['a'] <= MIN_FRAG:
            errors.append('%s: 앞 %d프레임이 다른 샷 — 깜빡임' % (tag, inner[0] - r['a']))
            flagged.append((r['a'], None, 'head %df' % (inner[0] - r['a'])))
        if inner and r['b'] - inner[-1] <= MIN_FRAG:
            errors.append('%s: 끝 %d프레임이 다른 샷 — 깜빡임' % (tag, r['b'] - inner[-1]))
            flagged.append((r['b'] - 1, None, 'tail %df' % (r['b'] - inner[-1])))
        # 보조 경계 검사 — 원본에서 덩어리 앞·끝 EDGE_WIN 초를 ffmpeg scene 으로 다시 잰다(위가 놓친 저대비 컷)
        fps_out = pm.get('fps', 30)
        if not any(e.startswith(tag) for e in errors):
            for t, sc, span in source_edges(pm['source'], r['src_t0'] - 0.5, r['src_t0'] + EDGE_WIN):
                n = int(round((t - r['src_t0']) * fps_out))
                if 0 < n <= MIN_FRAG:
                    if span > EDGE_MOTION:
                        warns.append('%s: 앞 %d프레임 뒤 화면 변화(scene %.2f, %.1f초 이어짐) — 움직임인지 눈으로' % (tag, n, sc, span))
                    else:
                        errors.append('%s: 앞 %d프레임이 다른 샷 — 깜빡임(원본 경계 %.2fs, scene %.2f)' % (tag, n, t, sc))
                        flagged.append((r['a'], None, 'head %df' % n))
            for t, sc, span in source_edges(pm['source'], r['src_t1'] - EDGE_WIN, r['src_t1'] + 0.5):
                n = int(round((r['src_t1'] - t) * fps_out))
                if 0 < n <= MIN_FRAG:
                    if span > EDGE_MOTION:
                        warns.append('%s: 끝 %d프레임 앞 화면 변화(scene %.2f, %.1f초 이어짐) — 움직임인지 눈으로' % (tag, n, sc, span))
                    else:
                        errors.append('%s: 끝 %d프레임이 다른 샷 — 깜빡임(원본 경계 %.2fs, scene %.2f)' % (tag, n, t, sc))
                        flagged.append((r['b'] - 1, None, 'tail %df' % n))
        # 카메라 전환점(cx 를 바꾼 조각 경계)이 샷 경계와 어긋나면 새 샷 첫 장이 이전 카메라로 나온다
        for st in r['starts'][1:] + r.get('jumps', []):
            near = [c for c in cuts if abs(c - st) <= 6]
            if near and abs(near[0] - st) >= 2:      # ±1 은 샷 경계 검출 오차
                warns.append('%s: 카메라 전환이 샷 경계와 %+d프레임 어긋남(결과 f%d)' % (tag, st - near[0], st))

    # 글자 — 원본 좌표로 되돌려, «서로 다른 샷» 에서 같은 자리면 화면 위 덧칠(로고·박힌 자막)
    shot_of = lambda f: sum(1 for c in cuts if c <= f)
    hits = []          # (원본상자, 샷번호, 결과프레임, 창상자)
    sampled_shots = set()
    for p in pm['pieces']:
        a, b = p['out_f0'], p['out_f0'] + p['frames']
        for i in list(range(a + 2, b - 1, SAMPLE_EVERY)) or [a + p['frames'] // 2]:
            f = grab(pic, i)
            if f is None:
                continue
            sampled_shots.add(shot_of(i))
            res, _ = ocr(f, use_det=True, use_cls=False, use_rec=False)
            for q in res or []:
                q = np.array(q)
                box = (float(q[:, 0].min()), float(q[:, 1].min()), float(q[:, 0].max()), float(q[:, 1].max()))
                if (box[2] - box[0]) * (box[3] - box[1]) < 400:
                    continue
                x0, y0, x1, y1 = map(int, box)
                patch = cv2.resize(cv2.cvtColor(f[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY), (48, 24)).astype(np.float32)
                patch = (patch - patch.mean()) / (patch.std() + 1e-3)
                hits.append((src_box(box, p, iw, ih, pm.get('mirror', True), i - a), shot_of(i), i, box, patch))
    n_shots = len({h for h in sampled_shots}) or 1
    used = set()
    for k, h in enumerate(hits):
        if k in used:
            continue
        group = [j for j, o in enumerate(hits) if same_spot(h[0], o[0], iw)]
        shots = {hits[j][1] for j in group}
        # ★샷 «대부분» 에 있어야 덧칠이다(2026-10-09 실측: 검출기가 눈·입·줄무늬 소매를 글자로 잡는다 —
        #   그런 오탐은 샷 2~8개에 흩어지고, 진짜 로고는 샘플한 샷 24/24 에 있었다).
        # ★자리만으론 부족하다 — 맞보기 장면은 코·입이 늘 원본 가운데 같은 자리에 온다(82ko). 덧칠의 생김새를 하나 더 본다:
        #   로고 = 샷이 바뀌어도 그 자리 그림이 똑같다 / 박힌 자막 = 화면 위·아래 띠의 가로로 긴 상자
        firsts = {}
        for j in group:
            firsts.setdefault(hits[j][1], hits[j][4])
        pats = list(firsts.values())
        sims = [float((pats[u] * pats[v]).mean()) for u in range(len(pats)) for v in range(u + 1, len(pats))]
        same_look = bool(sims) and float(np.median(sims)) > 0.8
        ws = [(hits[j][0][2] - hits[j][0][0]) / max(1.0, hits[j][0][3] - hits[j][0][1]) for j in group]
        cyf = np.median([(hits[j][0][1] + hits[j][0][3]) / 2 / ih for j in group])
        sub_like = float(np.median(ws)) >= 2.5 and (cyf < 0.2 or cyf > 0.7)
        if len(shots) >= 3 and len(shots) >= 0.5 * n_shots and (same_look or sub_like):
            used.update(group)
            sb = h[0]
            errors.append('덧칠 글자(샷 %d개에서 같은 자리) 원본 x%d~%d y%d~%d (%.0f%%~%.0f%% 높이) — 로고·박힌 자막' % (
                len(shots), sb[0], sb[2], sb[1], sb[3], 100 * sb[1] / ih, 100 * sb[3] / ih))
            flagged.append((h[2], [h[3]], 'overlay'))
    rest = []      # ★장면 속 글자 경고는 끈다 — 검출기 오탐(눈·입)이 대부분이라 소음만 된다. 판정은 덧칠만.
    if rest:
        shots = sorted({h[1] for h in rest})
        warns.append('장면 속 글자 %d건(샷 %d개) — 간판·옷·소품인지 시트로 확인' % (len(rest), len(shots)))
        seen_shots = set()
        for h in rest:
            if h[1] not in seen_shots:
                seen_shots.add(h[1]); flagged.append((h[2], [h[3]], 'scene text'))

    if flagged:
        tiles = []
        for i, bx, label in flagged[:24]:
            f = grab(pic, i)
            if f is None:
                continue
            for box in bx or []:
                cv2.rectangle(f, (int(box[0]), int(box[1])), (int(box[2]), int(box[3])), (0, 0, 255), 6)
            f = cv2.resize(f, (360, 340))
            cv2.putText(f, 'f%d %s' % (i, label), (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
            tiles.append(f)
        while tiles and len(tiles) % 4:
            tiles.append(np.zeros_like(tiles[0]))
        if tiles:
            sheet = np.vstack([np.hstack(tiles[r:r + 4]) for r in range(0, len(tiles), 4)])
            cv2.imencode('.png', sheet)[1].tofile(str(rd / 'screen_flags.png'))

    print('화면 검사 · 조각 %d개 · 구간 %d개 · 샷 경계 %d곳 · 글자 검출 %d건' % (len(pm['pieces']), len(runs), len(cuts), len(hits)))
    for e in errors:
        print('  ✗', e)
    for w in warns:
        print('  △', w)
    if not errors and not warns:
        print('  통과')
    if flagged:
        print('  걸린 프레임 시트: %s' % (rd / 'screen_flags.png'))
    return not errors


if __name__ == '__main__':
    sys.exit(0 if main(sys.argv[1]) else 1)
