# -*- coding: utf-8 -*-
"""캐릭터 프레임 애니메이션 — 기존 캐릭터 그림 한 장으로 6칸 시트를 받아, 정렬·투명 배경 프레임과 타이밍표대로 움직이는 투명 mov 를 만든다.
발굴 세션 시제품(10-18, 소유주 «좋은데?» 승인)을 공용 도구로 옮김.

    # 1) 시트 받기(gpt-ask 이미지 생성 1건). kind: action=동작 6장 · face=몸 고정에 눈·입 6종
    python scripts/char_anim.py sheet <캐릭터.png> <out_dir> --kind action [--poses poses.txt] [--desc "elderly man, beige cardigan…"]
    python scripts/char_anim.py sheet <캐릭터.png> <out_dir> --kind face
    # 2) 시트 → 정렬된 투명 프레임 out_dir/frames/0~5.png + 눈 확인용 check.png(체커 배경)
    python scripts/char_anim.py frames <out_dir>/sheet.png <out_dir> --kind action|face [--grid 3x2] [--face x0,y0,x1,y1]
    # 3) 타이밍표대로 투명 영상(prores 4444 mov) 또는 PNG 시퀀스
    python scripts/char_anim.py anim <out_dir> timing.txt [--height 900] [--fps 30] [--out a.mov | --png-seq dir] [--preview p.mp4]

타이밍표(한 줄 = 한 그림): `<프레임 번호> <초> [효과]` — 효과는 shake:<px> · tremble:<px> · jump:<px> · none. `#` 뒤는 주석.
    0 0.8
    2 0.1 shake:14
    5 2.2 tremble:1.5

정렬
- action: 칸마다 머리(맨 위 18% 줄들 중 가장 넓은 폭)를 재서 0번 칸 머리 폭으로 크기를 맞추고(0.8~1.25 로 제한), 머리 맨 위·가운데를 0번에 맞춘다.
- face: 칸 전체를 0번에 ECC(회전+이동)로 맞춘 뒤 얼굴 타원 안만 0번 위에 합성한다. 타원은 0번 머리 기준 자동(--face 로 칸 비율 직접 지정 가능).
투명 배경: 칸 테두리에서 이어진 흰 영역만 배경으로 지운다(봉투·셔츠 같은 안쪽 흰색은 남는다). 경계는 흰색 정도로 부드럽게 알파를 주고 흰 번짐을 뺀다.
작은 조각(땀방울·놀람 표시 같은 효과선은 남기고 칸 경계에서 넘어온 옆 칸 조각만)은 테두리에 붙은 작은 덩어리로 보고 지운다.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
WHITE = 235          # 이보다 밝으면(세 채널 최소값) 흰 배경 후보
EDGE_LO = 170        # 경계 알파: 이 밝기 이하는 불투명

ACTION_POSES = {
    'surprise': [
        'calm neutral face, holding the object at chest, looking at it',
        'slight anticipation: shoulders drop slightly, eyes narrow to read',
        'startle: body jerks up a little, eyebrows shoot up, eyes wide',
        'peak shock: mouth wide open, eyes huge, sweat drop, object raised slightly',
        'overshoot settle: body slightly lower, mouth still open',
        'frozen shock: same as the reference image pose',
    ],
}
FACE_POSES = [
    'eyes open normal, mouth closed',
    'eyes closed (blink), mouth closed',
    'eyes wide, mouth small "o"',
    'eyes wide, mouth wide open',
    'eyes wide, mouth half open',
    'eyes squeezed shut, mouth open wide (gasp)',
]
# 고칠 점 1(10-18 발굴): 칸 여백이 좁아 어깨가 일자로 잘렸다 → 차지 비율·여백을 못 박는다
MARGIN = ('Each character occupies at most 70% of its panel width and height, centered, with a WIDE pure-white margin on all four sides; '
          'shoulders, arms and hair must be fully visible and must never touch or cross the panel edge.')


def sheet_prompt(kind, poses, desc, cols, rows):
    who = f'same character ({desc})' if desc else 'same character, same face, same hair, same clothes, same props'
    head = (f'Use the attached image as the exact character reference: {who}. Same illustration style, same line weight and colors.\n\n'
            f'Draw a {cols} columns x {rows} rows sheet ({cols * rows} equal panels, pure white background, NO borders, NO numbers, NO text), '
            'read left-to-right, top-to-bottom:\n')
    body = '\n'.join(f'{i + 1}. {p}' for i, p in enumerate(poses))
    if kind == 'face':
        tail = ('\n\nIn ALL panels the body, hands, props, head, hair and glasses are IDENTICAL and in the IDENTICAL position — copy the reference exactly. '
                'ONLY the eyes and mouth change.')
    else:
        tail = ('\n\nCRITICAL for animation: every panel has the character at the SAME size, SAME position and SAME framing '
                '(upper body, head top at the same height, same head width), identical line weight and colors. Only pose/expression changes.')
    return head + body + tail + '\n' + MARGIN + '\n'


def cmd_sheet(a):
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cols, rows = map(int, a.grid.split('x'))
    if a.poses:
        poses = [l.strip() for l in Path(a.poses).read_text(encoding='utf-8').splitlines() if l.strip() and not l.startswith('#')]
    else:
        poses = FACE_POSES if a.kind == 'face' else ACTION_POSES[a.preset]
    if len(poses) != cols * rows:
        raise SystemExit(f'포즈 {len(poses)}개 ≠ 칸 {cols * rows}개')
    pf = out / f'prompt_{a.kind}.md'
    pf.write_text(sheet_prompt(a.kind, poses, a.desc, cols, rows), encoding='utf-8')
    (out / 'meta.json').write_text(json.dumps({'kind': a.kind, 'grid': a.grid, 'poses': poses, 'ref': str(Path(a.char).resolve())},
                                              ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if a.dry_run:
        print(pf)
        return 0
    sheet = out / 'sheet.png'
    r = subprocess.run(['node', str(ROOT / 'scripts' / 'gpt-ask.js'), '--session', a.session, '--no-search', '--effort', 'medium',
                        '--attach', str(Path(a.char).resolve()), '--image', str(sheet.resolve()), '--file', str(pf.resolve())])
    if r.returncode or not sheet.exists():
        raise SystemExit(f'시트 생성 실패(gpt-ask 종료 {r.returncode}) — 한도·인증 오류면 멈춘다')
    print(sheet)
    return 0


# ---------- 칸 자르기·배경 ----------

def panels(path, cols, rows):
    im = np.array(Image.open(path).convert('RGB'))
    H, W = im.shape[:2]
    return [im[r * H // rows:(r + 1) * H // rows, c * W // cols:(c + 1) * W // cols].copy() for r in range(rows) for c in range(cols)]


def bg_mask(p):
    """칸 테두리에서 이어진 밝은 영역 = 배경(True)."""
    light = (p.min(axis=2) >= WHITE).astype(np.uint8)
    h, w = light.shape
    n, lab = cv2.connectedComponents(light, connectivity=4)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    return np.isin(lab, list(border)) & (light > 0)


def to_rgba(p):
    """흰 배경 → 알파. 배경과 닿은 경계 띠만 밝기로 부드럽게, 흰 번짐은 빼서 색을 되살린다."""
    bg = bg_mask(p)
    fg = ~bg
    # 옆 칸에서 넘어온 조각: 테두리에 붙은 작은 덩어리(가장 큰 덩어리의 2% 미만)는 지운다
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), connectivity=8)
    if n > 1:
        big = st[1:, cv2.CC_STAT_AREA].max()
        h, w = fg.shape
        for i in range(1, n):
            x, y, bw, bh, area = st[i]
            touches = x == 0 or y == 0 or x + bw >= w or y + bh >= h
            if touches and area < big * .02:
                fg[lab == i] = False
    alpha = fg.astype(np.float32)
    band = cv2.dilate(bg.astype(np.uint8), np.ones((5, 5), np.uint8)) & fg
    m = p.min(axis=2).astype(np.float32)
    soft = np.clip((255 - m) / (255 - EDGE_LO), 0, 1)
    alpha = np.where(band > 0, soft, alpha)
    a = alpha[..., None]
    rgb = p.astype(np.float32)
    rgb = np.where(a > .01, (rgb - (1 - a) * 255) / np.maximum(a, .01), 0)
    return np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)


def head(alpha):
    """(맨 위 y, 머리 가운데 x, 머리 폭) — 캐릭터 높이 맨 위 18% 줄에서 가장 넓은 폭."""
    m = (alpha > 128).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n > 1:   # 떨어진 효과선(놀람 표시·땀방울)이 머리 폭을 부풀리지 않게 가장 큰 덩어리만
        m = lab == 1 + int(st[1:, cv2.CC_STAT_AREA].argmax())
    ys = np.where(m.any(axis=1))[0]
    top, bot = ys[0], ys[-1]
    best, cx = 0, m.shape[1] / 2
    for y in range(top, top + max(4, int((bot - top) * .18))):
        xs = np.where(m[y])[0]
        if len(xs) and xs[-1] - xs[0] > best:
            best, cx = xs[-1] - xs[0], (xs[0] + xs[-1]) / 2
    return float(top), float(cx), float(best)


def warp(img, M, size, fill):
    return cv2.warpAffine(img, M, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=fill)


def align_action(P):
    """고칠 점 2: 머리 폭으로 크기까지 맞춘다."""
    R = [to_rgba(p) for p in P]
    t0, c0, w0 = head(R[0][..., 3])
    out, info = [R[0]], [{'scale': 1.0, 'dx': 0, 'dy': 0}]
    h, w = R[0].shape[:2]
    for r in R[1:]:
        t, c, hw = head(r[..., 3])
        s = min(1.25, max(.8, w0 / hw if hw else 1))
        M = np.float32([[s, 0, c0 - s * c], [0, s, t0 - s * t]])
        out.append(warp(r, M, (w, h), (0, 0, 0, 0)))
        info.append({'scale': round(s, 3), 'dx': round(float(M[0, 2]), 1), 'dy': round(float(M[1, 2]), 1)})
    return out, info


def align_face(P, face=None):
    g0 = cv2.cvtColor(P[0], cv2.COLOR_RGB2GRAY).astype(np.float32)
    h, w = P[0].shape[:2]
    al, info = [P[0]], [{'ecc': 'ref'}]
    for p in P[1:]:
        g = cv2.cvtColor(p, cv2.COLOR_RGB2GRAY).astype(np.float32)
        M = np.eye(2, 3, dtype=np.float32)
        try:
            cc, M = cv2.findTransformECC(g0, g, M, cv2.MOTION_EUCLIDEAN,
                                         (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-5), None, 5)
            info.append({'ecc': round(float(cc), 3)})
        except cv2.error:
            info.append({'ecc': 'fail'})
        al.append(cv2.warpAffine(p, M, (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderValue=(255, 255, 255)))
    if face:
        x0, y0, x1, y1 = face
        box = [w * x0, h * y0, w * x1, h * y1]
    else:
        t, c, hw = head(to_rgba(P[0])[..., 3])
        box = [c - hw * .42, t + hw * .32, c + hw * .42, t + hw * 1.08]
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    mk = np.array(mask.filter(ImageFilter.GaussianBlur(max(4, (box[2] - box[0]) / 30)))).astype(np.float32)[..., None] / 255
    comp = [(P[0] * (1 - mk) + p * mk).astype(np.uint8) for p in al]
    return [to_rgba(c) for c in comp], info, [round(v, 1) for v in box]


def checker(h, w, k=24):
    yy, xx = np.mgrid[0:h, 0:w]
    v = np.where(((yy // k) + (xx // k)) % 2 == 0, 205, 245).astype(np.uint8)
    return np.dstack([v, v, v])


def over(rgba, bgimg):
    a = rgba[..., 3:4].astype(np.float32) / 255
    return (rgba[..., :3] * a + bgimg * (1 - a)).astype(np.uint8)


def cmd_frames(a):
    out = Path(a.out_dir)
    fd = out / 'frames'
    fd.mkdir(parents=True, exist_ok=True)
    cols, rows = map(int, a.grid.split('x'))
    P = panels(a.sheet, cols, rows)
    meta = {'kind': a.kind, 'grid': a.grid, 'sheet': str(Path(a.sheet).resolve())}
    if a.kind == 'face':
        F, info, box = align_face(P, [float(v) for v in a.face.split(',')] if a.face else None)
        meta['face_box'] = box
    else:
        F, info = align_action(P)
    meta['align'] = info
    # 여백을 넓게 받았으니(≤70%) 모든 프레임을 같은 상자(합집합 + 4%)로 잘라 --height 가 캐릭터 높이가 되게 한다 — 같은 상자라 정렬은 유지
    al = np.max([f[..., 3] for f in F], axis=0) > 8
    ys, xs = np.where(al)
    h0, w0 = al.shape
    m = int(max(h0, w0) * .04)
    y0, y1, x0, x1 = max(0, ys.min() - m), min(h0, ys.max() + m + 1), max(0, xs.min() - m), min(w0, xs.max() + m + 1)
    F = [f[y0:y1, x0:x1] for f in F]
    meta['crop'] = [int(x0), int(y0), int(x1), int(y1)]
    if 'face_box' in meta:
        meta['face_box'] = [meta['face_box'][0] - x0, meta['face_box'][1] - y0, meta['face_box'][2] - x0, meta['face_box'][3] - y0]
    for i, f in enumerate(F):
        Image.fromarray(f, 'RGBA').save(fd / f'{i}.png')
    h, w = F[0].shape[:2]
    tiles = []
    for i, f in enumerate(F):
        t = over(f, checker(h, w))
        t0, c0, _ = head(F[0][..., 3])
        cv2.line(t, (0, int(t0)), (w, int(t0)), (220, 60, 60), 1)      # 0번 머리 맨 위 — 튀는지 눈으로
        cv2.line(t, (int(c0), 0), (int(c0), h), (60, 60, 220), 1)
        if a.kind == 'face' and i == 0:
            x0, y0, x1, y1 = (int(v) for v in meta['face_box'])
            cv2.ellipse(t, ((x0 + x1) // 2, (y0 + y1) // 2), ((x1 - x0) // 2, (y1 - y0) // 2), 0, 0, 360, (40, 170, 40), 2)
        cv2.putText(t, str(i), (10, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 2)
        tiles.append(t)
    Image.fromarray(np.hstack(tiles)).save(out / 'check.png')
    meta_path = out / 'frames.json'
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'frames': str(fd), 'check': str(out / 'check.png'), 'align': info}, ensure_ascii=False))
    return 0


# ---------- 타이밍 → 영상 ----------

def parse_timing(text):
    rows = []
    for ln in text.splitlines():
        ln = ln.split('#')[0].strip()
        if not ln:
            continue
        parts = ln.split()
        fx, amp = 'none', 0.0
        if len(parts) > 2 and parts[2] != 'none':
            fx, _, v = parts[2].partition(':')
            amp = float(v) if v else {'shake': 10, 'tremble': 1.5, 'jump': 20}.get(fx, 0)
            if fx not in ('shake', 'tremble', 'jump'):
                raise ValueError(f'모르는 효과: {parts[2]}')
        rows.append((int(parts[0]), float(parts[1]), fx, amp))
    return rows


def offset(fx, amp, i, n):
    if fx == 'shake':
        k = 1 - i / n
        return amp * math.sin(i * 2.3) * k, amp * .6 * math.cos(i * 3.1) * k
    if fx == 'tremble':
        return amp * math.sin(i * 1.7), 0.0
    if fx == 'jump':
        return 0.0, -amp * math.sin(math.pi * i / n)
    return 0.0, 0.0


def sequence(frames, timing, fps, height, pad):
    """(RGBA 프레임 목록) — 캐릭터 높이를 height 로, 효과로 흔들려도 안 잘리게 사방 pad 여백."""
    s = height / frames[0].shape[0]
    sized = [cv2.resize(f, (round(f.shape[1] * s), height), interpolation=cv2.INTER_AREA) for f in frames]
    h, w = height + 2 * pad, sized[0].shape[1] + 2 * pad
    w += w % 2
    h += h % 2
    seq = []
    for idx, sec, fx, amp in timing:
        n = max(1, round(sec * fps))
        for i in range(n):
            dx, dy = offset(fx, amp * height / 980, i, n)   # 효과 px 은 시제품(캐릭터 높이 980) 기준
            M = np.float32([[1, 0, pad + dx], [0, 1, pad + dy]])
            seq.append(warp(sized[idx], M, (w, h), (0, 0, 0, 0)))
    return seq


def cmd_anim(a):
    out = Path(a.out_dir)
    frames = [np.array(Image.open(p).convert('RGBA')) for p in sorted((out / 'frames').glob('*.png'), key=lambda p: int(p.stem))]
    timing = parse_timing(Path(a.timing).read_text(encoding='utf-8'))
    bad = [t[0] for t in timing if t[0] >= len(frames)]
    if bad:
        raise SystemExit(f'없는 프레임 번호: {bad}')
    seq = sequence(frames, timing, a.fps, a.height, a.pad)
    h, w = seq[0].shape[:2]
    if a.png_seq:
        d = Path(a.png_seq)
        d.mkdir(parents=True, exist_ok=True)
        for i, f in enumerate(seq):
            Image.fromarray(f, 'RGBA').save(d / f'{i:05d}.png')
    mov = Path(a.out) if a.out else out / 'anim.mov'
    pr = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{w}x{h}', '-r', str(a.fps), '-i', '-',
                           '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', str(mov)], stdin=subprocess.PIPE)
    for f in seq:
        pr.stdin.write(f.tobytes())
    pr.stdin.close()
    if pr.wait():
        raise SystemExit('ffmpeg 실패')
    if a.preview:   # 눈 확인용: 연한 배경 위에 얹은 mp4
        bgc = np.full((h, w, 3), (238, 243, 246)[::-1], np.uint8)
        pv = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(a.fps), '-i', '-',
                               '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', a.preview], stdin=subprocess.PIPE)
        for f in seq:
            pv.stdin.write(over(f, bgc).tobytes())
        pv.stdin.close()
        pv.wait()
    print(json.dumps({'mov': str(mov), 'sec': round(len(seq) / a.fps, 2), 'size': [w, h], 'frames': len(seq)}, ensure_ascii=False))
    return 0


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='캐릭터 프레임 애니메이션(시트 → 투명 프레임 → 투명 mov)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sheet')
    s.add_argument('char'); s.add_argument('out_dir')
    s.add_argument('--kind', choices=['action', 'face'], required=True)
    s.add_argument('--preset', default='surprise', choices=sorted(ACTION_POSES))
    s.add_argument('--poses', help='한 줄에 한 칸 설명(영어 권장)')
    s.add_argument('--desc', default='', help='캐릭터 묘사 한 줄(영어) — 비우면 «같은 캐릭터»로만 지시')
    s.add_argument('--grid', default='3x2', help='열x행')
    s.add_argument('--session', default='char_anim')
    s.add_argument('--dry-run', action='store_true', help='프롬프트 파일만 쓰고 생성은 안 함')
    f = sub.add_parser('frames')
    f.add_argument('sheet'); f.add_argument('out_dir')
    f.add_argument('--kind', choices=['action', 'face'], required=True)
    f.add_argument('--grid', default='3x2')
    f.add_argument('--face', help='face 합성 타원 x0,y0,x1,y1(칸 비율 0~1) — 비우면 머리 기준 자동')
    n = sub.add_parser('anim')
    n.add_argument('out_dir'); n.add_argument('timing')
    n.add_argument('--fps', type=int, default=30)
    n.add_argument('--height', type=int, default=900, help='칸(캐릭터 프레임) 높이 px')
    n.add_argument('--pad', type=int, default=40)
    n.add_argument('--out', help='투명 mov 경로(기본 out_dir/anim.mov)')
    n.add_argument('--png-seq', help='PNG 시퀀스도 이 폴더에')
    n.add_argument('--preview', help='배경 얹은 확인용 mp4')
    a = ap.parse_args(argv)
    return {'sheet': cmd_sheet, 'frames': cmd_frames, 'anim': cmd_anim}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
