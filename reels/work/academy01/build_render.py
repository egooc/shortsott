# academy01 렌더 — ① 글자 지운 원본 + 컷 + 좌우 반전 + 음량 → edited.mp4 ② 가로(A안)·세로 그래픽 합성
#   python build_render.py edit        → edited.mp4
#   python build_render.py frames      → ov_h/ ov_v/ (상태별 PNG + concat 목록)
#   python build_render.py h|v [--to S] → out_h.mp4 / out_v.mp4 (--to 면 앞 S초만 시험)
import json, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).parent
ROOT = Path('D:/midform/reels')
SRC = ROOT / 'inbox/src_20261019_1446.mp4'
HEAD = HERE / 'head185_clean.mp4'      # 0~185초, 박힌 글자 지운 판
plan = json.loads((HERE / 'edit_plan.json').read_text(encoding='utf-8'))
F_HEAD = str(ROOT / 'assets/fonts/Jua-Regular.ttf')
F_SUB = str(ROOT / 'assets/fonts/GmarketSansMedium.otf')
F_BOLD = str(ROOT / 'assets/fonts/GmarketSansBold.otf')
YEL, INK, CREAM, WHITE = (255, 210, 63), (30, 28, 26), (255, 248, 231), (255, 255, 255)
VX, VY, VW, VH = 1920 - 540 - 120, 40, 540, 960     # 가로 A안 영상 자리


def run(cmd):
    print(' '.join(map(str, cmd))[:300], flush=True)
    subprocess.run(list(map(str, cmd)), check=True)


# ── ① 편집본 ────────────────────────────────────────────────
# 원본 시각별 출처: 0=글자 지운 앞 3분 · 1=원본. punch=얼굴 쪽 1.4배 당겨 잡기(아래 박힌 그래픽을 화면 밖으로).
# 0~4초 «보강» 불꽃·2:47~3:00(2:48부터 1차 지우기가 맨투맨까지 먹음) «토요일 수업» 상자는 지우면 맨투맨 글자까지 번져서(academy01 2차 실측) 당겨 잡기로 뺀다.
# 둘 다 파트 시작점이라 센 효과를 써도 되는 자리다(camera-grammar: 전환점에만).
ROUTE = [(0.0, 4.0, 1, True), (4.0, 167.2, 0, False), (167.2, 180.0, 1, True), (180.0, 1e9, 1, False)]
PUNCH = 'crop=764:1358:158:0,scale=1080:1920:flags=lanczos'


def edit(to=None):
    parts, fc = [], []
    for k0, k1 in plan['keep']:
        for r0, r1, src, punch in ROUTE:
            a, b = max(k0, r0), min(k1, r1)
            if b - a > 0.02:
                parts.append((src, a, b, punch))
    if to:   # 시험본: 편집 시각 to 초까지만
        acc, cut = 0.0, []
        for p_ in parts:
            if acc >= to + 1:
                break
            cut.append(p_); acc += p_[2] - p_[1]
        parts = cut
    # 구간마다 입력을 따로 연다(-ss 앞 탐색). 한 입력을 여러 trim 이 나눠 쓰면 ffmpeg 가 거부하거나 프레임을 통째로 쌓는다.
    ins = []
    for i, (src, a, b, punch) in enumerate(parts):
        d = b - a
        ins += ['-ss', f'{a:.3f}', '-t', f'{d:.3f}', '-i', HEAD if src == 0 else SRC]
        fc.append(f'[{i}:v]setpts=PTS-STARTPTS,hflip' + (',' + PUNCH if punch else '') + f',setsar=1,format=yuv420p,fps=30[v{i}]')
        fc.append(f'[{i}:a]asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.012,afade=t=out:st={max(0, d - 0.012):.3f}:d=0.012[a{i}]')
    fc.append(''.join(f'[v{i}][a{i}]' for i in range(len(parts))) + f'concat=n={len(parts)}:v=1:a=1[v][a0]')
    fc.append('[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]')
    run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', ';'.join(fc),
         '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '14', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k', HERE / 'edited.mp4'])


# ── ② 그래픽 상태 ─────────────────────────────────────────────
def logo(h):
    import numpy as np
    im = Image.open(ROOT / 'ref/rockys/p01.jpg').convert('RGB')
    a = np.asarray(im).astype(int)
    alpha = np.clip((765 - a.sum(2)) * 3, 0, 255).astype(np.uint8)
    im = im.convert('RGBA'); im.putalpha(Image.fromarray(alpha))
    im = im.crop(im.getbbox())
    return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)


def font(p, s):
    return ImageFont.truetype(p, s)


def rr(d, box, r, fill, outline=None, w=0):
    d.rounded_rectangle(box, r, fill=fill, outline=outline, width=w)


def fit_font(d, s, path, size, maxw):
    f = font(path, size)
    while d.textlength(s, font=f) > maxw and size > 28:
        size -= 2; f = font(path, size)
    return f


def subtitle(d, cx, y, s, path, size, maxw):
    f = fit_font(d, s, path, size, maxw)
    w = d.textlength(s, font=f)
    rr(d, (cx - w / 2 - 32, y - 20, cx + w / 2 + 32, y + f.size + 24), 22, WHITE + (240,))
    d.text((cx - w / 2, y), s, font=f, fill=INK)


def part_tag(d, x, y, s, f):
    w = d.textlength(s, font=f)
    rr(d, (x, y, x + w + 48, y + f.size + 30), (f.size + 30) // 2, YEL, INK, 4)
    d.text((x + 24, y + 13), s, font=f, fill=INK)


def events():
    """상태가 바뀌는 시각 목록 → [(t0, t1, section, point_idx, sub_text|None)]"""
    T = plan['edit_dur']
    cuts = {0.0, T}
    for s in plan['sections']:
        cuts.add(s['t0']); cuts.update(p[0] for p in s['points'])
    for x in plan['subs']:
        cuts.add(x['t0']); cuts.add(x['t1'])
    cuts = sorted(c for c in cuts if 0 <= c <= T)
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 0.02:
            continue
        m = (a + b) / 2
        sec = next(i for i, s in enumerate(plan['sections']) if s['t0'] <= m < s['t1'] or i == len(plan['sections']) - 1)
        pts = plan['sections'][sec]['points']
        pi = max([i for i, p in enumerate(pts) if p[0] <= m], default=-1)
        sub = next((x['text'] for x in plan['subs'] if x['t0'] <= m < x['t1']), None)
        out.append((a, b, sec, pi, sub))
    return out


def draw_h(sec, pi, sub, lg):
    s = plan['sections'][sec]
    im = Image.new('RGBA', (1920, 1080), CREAM + (255,)); d = ImageDraw.Draw(im)
    d.rectangle((0, 1000, 1920, 1080), fill=YEL)
    rr(d, (VX - 10, VY - 10, VX + VW + 10, VY + VH + 10), 34, INK)
    im.alpha_composite(lg, (120, 70))
    part_tag(d, 120 + lg.width + 40, 120, s['tag'], font(F_HEAD, 44))
    fT = font(F_HEAD, 104)
    d.text((120, 300), s['title'][0], font=fT, fill=INK)
    d.text((120, 420), s['title'][1], font=fT, fill=INK)
    d.rectangle((120, 520, 120 + max(d.textlength(t, font=fT) for t in s['title']), 540), fill=YEL)
    f_pt = font(F_BOLD, 38)
    for i, (_, p) in enumerate(s['points']):
        y = 590 + i * 76
        on = i == pi
        rr(d, (120, y, 980, y + 62), 31, YEL if on else WHITE, INK, 3)
        d.ellipse((134, y + 9, 178, y + 53), fill=INK)
        w = d.textlength(str(i + 1), font=font(F_BOLD, 28))
        d.text((156 - w / 2, y + 17), str(i + 1), font=font(F_BOLD, 28), fill=YEL if on else WHITE)
        d.text((196, y + 14), p, font=f_pt, fill=INK if (on or i < pi) else (120, 116, 110))
    if sub:
        subtitle(d, 560, 918, sub, F_SUB, 44, 960)
    return im


def draw_v(sec, pi, sub, t_in_point, lg):
    s = plan['sections'][sec]
    im = Image.new('RGBA', (1080, 1920), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    rr(d, (40, 48, 40 + lg.width + 44, 48 + 150 + 36), 28, WHITE + (235,), INK, 4)
    im.alpha_composite(lg, (62, 66))
    part_tag(d, 40 + lg.width + 70, 96, s['tag'], font(F_HEAD, 46))
    # 핵심 카드: 소절이 바뀐 뒤 5초만(책장 가림 최소)
    if t_in_point is not None:
        key = s['points'][pi][1] if pi >= 0 else s['key']
        f_key = fit_font(d, key, F_HEAD, 70, 900)
        w = d.textlength(key, font=f_key)
        rr(d, (540 - w / 2 - 40, 500, 540 + w / 2 + 40, 500 + f_key.size + 46), 30, YEL, INK, 5)
        d.text((540 - w / 2, 518), key, font=f_key, fill=INK)
    if sub:
        subtitle(d, 540, 1560, sub, F_SUB, 50, 940)
    d.text((540 - d.textlength('Read for Fun · Read to Think · Read to Learn', font=font(F_BOLD, 28)) / 2, 1830),
           'Read for Fun · Read to Think · Read to Learn', font=font(F_BOLD, 28), fill=WHITE)
    return im


def frames():
    ev = events()
    lg_h, lg_v = logo(170), logo(150)
    for kind in ('h', 'v'):
        od = HERE / f'ov_{kind}'; od.mkdir(exist_ok=True)
        for f in od.glob('*.png'):
            f.unlink()
        lines, cache = [], {}
        # 세로는 핵심 카드 5초 창 때문에 사건을 더 쪼갠다
        evk = ev
        if kind == 'v':
            evk = []
            for a, b, sec, pi, sub in ev:
                pts = plan['sections'][sec]['points']
                starts = sorted({plan['sections'][sec]['t0']} | {p[0] for p in pts})
                st = max([x for x in starts if x <= a + 1e-6], default=0)
                end = st + 5.0
                if a < end < b:
                    evk += [(a, end, sec, pi, sub, True), (end, b, sec, pi, sub, False)]
                else:
                    evk.append((a, b, sec, pi, sub, a < end))
        for e in evk:
            a, b, sec, pi, sub = e[:5]
            key = (sec, pi, sub) + ((e[5],) if kind == 'v' else ())
            if key not in cache:
                name = f'{len(cache):04d}.png'
                im = draw_h(sec, pi, sub, lg_h) if kind == 'h' else draw_v(sec, pi, sub, 0 if e[5] else None, lg_v)
                im.save(od / name)
                cache[key] = name
            lines += [f"file '{cache[key]}'", f'duration {b - a:.3f}']
        lines.append(f"file '{lines[-2].split(chr(39))[1]}'")
        (od / 'list.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
        print(kind, len(cache), '장 ·', len(evk), '구간')
    m = Image.new('L', (VW, VH), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, VW, VH), 26, fill=255)
    m.save(HERE / 'mask_h.png')


def render(kind, to=None):
    lim = ['-t', str(to)] if to else []
    out = HERE / (f'out_{kind}' + ('_test' if to else '') + '.mp4')
    if kind == 'h':
        fc = (f'[1:v]scale={VW}:{VH}:flags=lanczos,format=rgba[vs];[2:v]format=gray[m];[vs][m]alphamerge[vr];'
              f'[0:v]format=rgba[bg];[bg][vr]overlay={VX}:{VY}:shortest=1,format=yuv420p[v]')
        ins = ['-f', 'concat', '-safe', '0', '-i', HERE / 'ov_h/list.txt', '-i', HERE / 'edited.mp4', '-loop', '1', '-i', HERE / 'mask_h.png']
        amap = '1:a'
    else:
        fc = '[1:v]format=rgba[ov];[0:v][ov]overlay=0:0:shortest=1,format=yuv420p[v]'
        ins = ['-i', HERE / 'edited.mp4', '-f', 'concat', '-safe', '0', '-i', HERE / 'ov_v/list.txt']
        amap = '0:a'
    run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[v]', '-map', amap, *lim,
         '-r', '30', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', out])


if __name__ == '__main__':
    cmd = sys.argv[1]
    to = float(sys.argv[sys.argv.index('--to') + 1]) if '--to' in sys.argv else None
    {'edit': lambda: edit(to), 'frames': frames}.get(cmd, lambda: render(cmd, to))()
