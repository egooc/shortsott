"""인용형 썸네일(10/15 2,663회 편 틀): 얼굴 둘 위에 크게, 윗줄 = 사진 속 인물이 실제로 한 말(원문 그대로), 아랫줄 = 궁금증 한 줄.
성과 없을 때 갈아 끼울 대체 포장(packages.json)용 — 10-18 소유주 «썸네일이랑 키워드를 성과에 따라 바꿔 줘야».

    python politics-hour/thumb_quote.py <에피소드 폴더> <설정.json> <out.png>

설정.json: {"sides": [{"img": "thumb/hjp_350.png", "box": [x0, y0, x1], "name": "홍준표 · 전 대구시장", "color": "#E61E2B"}, ...],   # 1~2개, 왼쪽부터
            "quote": "“…”", "issue": "…?", "chip": "KBC 대담", "source": "영상: …"}
얼굴은 영상 캡처만(생성 금지). box 의 세로는 칸 비율로 자동."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
W, HT, TOP = 1280, 720, 480
f = lambda n: ImageFont.truetype(FONT, n)
rgb = lambda h: tuple(int(h.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))

def cutout_faces(c, ep, cfg, pw):
    """mode=cutout: 지금 두 칸 배경(c) 위에 인물을 누끼(rembg)로 따서 얼굴을 크게 얹는다. .venv-vision 파이썬 필요(rembg·cv2).
    cfg: bg_dim(0~1, 배경 어둡게) · bg_blur(px) · outline({"color": "#FFFFFF", "px": 6}) ·
         sides[].cut_img(누끼 원본, 기본 img) · face([x,y,w,h] 손 지정, 기본 자동 가장 큰 얼굴) · face_h(얼굴 상자 높이/썸네일 높이, 기본 .6) ·
         face_x(칸 안 얼굴 가운데 0~1, 기본 왼칸 .58·오른칸 .42 = 안쪽으로 마주 보게) · face_top(얼굴 상자 윗변 y, 기본 110)."""
    import os
    import numpy as np
    from PIL import ImageFilter
    os.environ.setdefault('U2NET_HOME', 'D:/midform/models/u2net')
    import cv2
    from rembg import new_session, remove
    sys.path.insert(0, 'D:/midform/scripts')
    from rinbox_faces import MODEL
    if cfg.get('bg_blur'):
        c = c.filter(ImageFilter.GaussianBlur(cfg['bg_blur']))
    if cfg.get('bg_dim'):
        c = ImageEnhance.Brightness(c).enhance(1 - cfg['bg_dim'])
    sess = new_session(cfg.get('model', 'u2net_human_seg'))
    n = len(cfg['sides'])
    for i, s in enumerate(cfg['sides']):
        src = ep / s.get('cut_img', s['img'])
        im = Image.open(src).convert('RGB')
        fx = s.get('face')
        if not fx:
            bgr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
            det = cv2.FaceDetectorYN.create(str(MODEL), '', (im.width, im.height), 0.6)
            _, fs = det.detect(bgr)
            if fs is None:
                raise SystemExit(f'얼굴 못 찾음: {src} — sides[{i}].face 로 손 지정')
            x0b = s['box'][0] if 'cut_img' not in s else 0
            x1b = s['box'][2] if 'cut_img' not in s else im.width
            cand = [r for r in fs if x0b <= r[0] + r[2] / 2 < x1b] or list(fs)
            fx = [int(v) for v in max(cand, key=lambda r: r[2] * r[3])[:4]]
        x, y, w, h = fx
        cx0, cy0 = max(0, int(x - 1.9 * w)), max(0, int(y - 1.0 * h))   # 머리·어깨까지 넉넉히 잘라 누끼
        crop = im.crop((cx0, cy0, min(im.width, int(x + w + 1.9 * w)), im.height))
        cut = s.get('_cache') or remove(crop, session=sess, post_process_mask=True)
        k = s.get('face_h', cfg.get('face_h', .6)) * HT / h
        cut = cut.resize((int(cut.width * k), int(cut.height * k)), Image.LANCZOS)
        fxk = (x - cx0 + w / 2) * k
        fyk = (y - cy0) * k
        ax = s.get('face_x', .58 if (n > 1 and i == 0) else .42 if n > 1 else .5)
        px, py = int(i * pw + ax * pw - fxk), int(s.get('face_top', cfg.get('face_top', 110)) - fyk)
        layer = Image.new('RGBA', c.size, (0, 0, 0, 0))
        layer.paste(cut, (px, py), cut)
        if n > 1:   # 제 칸 밖으로 넘친 부분은 자른다(가운데 칸막이 유지)
            m = Image.new('L', c.size, 0)
            ImageDraw.Draw(m).rectangle([i * pw, 0, (i + 1) * pw - 1, HT], fill=255)
            layer.putalpha(Image.fromarray(np.minimum(np.array(layer.getchannel('A')), np.array(m))))
        ol = cfg.get('outline')
        if ol:
            a = layer.getchannel('A').filter(ImageFilter.MaxFilter(2 * ol.get('px', 6) + 1))
            c.paste(rgb(ol.get('color', '#FFFFFF')), (0, 0, *c.size), a)
        c.paste(layer, (0, 0), layer)
    return c


# ── 구도 프리셋 "layout"(소유주 10-29 «레퍼런스 잘 나온 롱폼 썸네일 구도 확인해서 디자인 시안 몇 개로») ──
# 근거: refs/thumb_layouts/NOTES.md(발췌 정치 채널 10곳 상위 90편 분류). 레퍼런스 그래픽·글꼴·로고는 안 쓰고 구도·비율만.
# 공통 키: font(글꼴 경로 — 정치JA 는 일본어 글꼴), chip(왼쪽 위 빨간 칩), source(오른쪽 위 작은 출처). 얼굴은 영상 캡처만.
#   vs          = 대립 2인(기존 sides·quote·issue + VS_DEFAULTS) — 소유주 10-29 «4번»
#   lineup      = 인물 줄 3~5명 위 60% + 아래 큰 글자 2줄: people[{img, face?, hint?: [x0, x1]}], line1(빨강·흰 테), line2(흰·검정 테)
#   solo        = 한 인물 왼쪽 크게(누끼) + 오른쪽 큰 글자 2~3줄: person{img, face?, hint?}, lines[](첫 줄 노랑·나머지 흰), mark?(마지막 줄 빨강)
#   center_word = 밝은 바탕 + 양옆 인물(누끼) + 가운데 세로 큰 글자 2~4줄: people[2], words[](빨강·남색 번갈아, 흰 테)
#   scene       = 사건 장면 한 장 전체(어둡게) + 빨간 원/화살표 + 아래 글자 2줄: scene{img, box?: [x0, y0, x1]},
#                 marks[{circle: [cx, cy, r]} | {arrow: [x0, y0, x1, y1]}](썸네일 1280x720 좌표), line1(노랑), line2(흰)
#   band        = 위 장면/인물 + 아래 단색 띠(band_y 부터, 기본 400 ≈ 아래 44%)에 큰 글자 2~3줄(정치JA 10-29 요청, JA 1위 18/63):
#                 scene{img, box?} 또는 people[1~2]{img, face?, hint?}(누끼), band_y, band_color(기본 남색), lines[], line_colors[](기본 노랑·흰·흰)
#   lineup 의 line2_color(기본 흰, 정치JA 는 노랑)
VS_DEFAULTS = {'mode': 'cutout', 'bg_dim': 0.4, 'bg_blur': 8, 'outline': {'color': '#FFFFFF', 'px': 4}, 'face_h': 0.8, 'face_top': 20}
YEL, RED, NAVY = (245, 197, 24), (230, 30, 43), (16, 19, 28)


def _cut(ep, p, sess):
    """사람 하나 누끼 → (RGBA 잘린 그림, 그 안 얼굴 [x, y, w, h]). p: {img, face?, hint?: [x0, x1](얼굴 가운데 x 범위)}."""
    import numpy as np
    import cv2
    from rembg import remove
    sys.path.insert(0, 'D:/midform/scripts')
    from rinbox_faces import MODEL
    im = Image.open(ep / p['img']).convert('RGB')
    fx = p.get('face')
    if not fx:
        det = cv2.FaceDetectorYN.create(str(MODEL), '', (im.width, im.height), 0.6)
        _, fs = det.detect(cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR))
        if fs is None:
            raise SystemExit(f'얼굴 못 찾음: {p["img"]} — face 로 손 지정')
        h0, h1 = p.get('hint', [0, im.width])
        cand = [r for r in fs if h0 <= r[0] + r[2] / 2 < h1] or list(fs)
        fx = [int(v) for v in max(cand, key=lambda r: r[2] * r[3])[:4]]
    x, y, w, h = fx
    cx0, cy0 = max(0, int(x - 1.6 * w)), max(0, int(y - 1.0 * h))
    crop = im.crop((cx0, cy0, min(im.width, int(x + w + 1.6 * w)), min(im.height, int(y + h * 4.5))))
    return remove(crop, session=sess, post_process_mask=True), [x - cx0, y - cy0, w, h]


def _place(c, cut, face, face_h, cx, top, outline=None, clip=None):
    """얼굴 높이 face_h(px)·얼굴 가운데 x=cx·얼굴 윗변 y=top 이 되게 키워 얹는다. outline=(색, px). clip=(x0, x1) 그 칸 밖은 자름."""
    import numpy as np
    from PIL import ImageFilter
    k = face_h / face[3]
    cut = cut.resize((max(1, int(cut.width * k)), max(1, int(cut.height * k))), Image.LANCZOS)
    layer = Image.new('RGBA', c.size, (0, 0, 0, 0))
    layer.paste(cut, (int(cx - (face[0] + face[2] / 2) * k), int(top - face[1] * k)), cut)
    if clip:
        m = Image.new('L', c.size, 0)
        ImageDraw.Draw(m).rectangle([clip[0], 0, clip[1] - 1, HT], fill=255)
        layer.putalpha(Image.fromarray(np.minimum(np.array(layer.getchannel('A')), np.array(m))))
    if outline:
        a = layer.getchannel('A').filter(ImageFilter.MaxFilter(2 * outline[1] + 1))
        c.paste(outline[0], (0, 0, *c.size), a)
    c.paste(layer, (0, 0), layer)
    return c


def _fit(d, text, size, maxw):
    while d.textlength(text, font=f(size)) > maxw and size > 20:
        size -= 2
    return size


def _bg(ep, img, dim=.45, blur=10, box=None):
    from PIL import ImageFilter
    im = Image.open(ep / img).convert('RGB')
    if box:
        x0, y0, x1 = box
        im = im.crop((x0, y0, x1, y0 + int((x1 - x0) * HT / W)))
    im = im.resize((W, HT))
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    return ImageEnhance.Brightness(im).enhance(1 - dim)


def _chrome(c, cfg):
    d = ImageDraw.Draw(c)
    if cfg.get('chip'):
        tw = d.textlength(cfg['chip'], font=f(34))
        d.rectangle([20, 18, 20 + tw + 30, 70], fill=RED)
        d.text((35, 56), cfg['chip'], font=f(34), fill=(255, 255, 255), anchor='ls')
    if cfg.get('source'):
        d.text((W - 14, 22), cfg['source'], font=f(16), fill=(230, 230, 230), anchor='rm', stroke_width=2, stroke_fill=(0, 0, 0))
    return c


def _sess(cfg):
    import os
    os.environ.setdefault('U2NET_HOME', 'D:/midform/models/u2net')
    from rembg import new_session
    return new_session(cfg.get('model', 'u2net_human_seg'))


def _shade(c, y0, alpha=225, col=(8, 14, 40)):
    sh = Image.new('L', (W, HT), 0)
    sd = ImageDraw.Draw(sh)
    for y in range(y0, HT):
        sd.line([(0, y), (W, y)], fill=min(alpha, int(alpha * (y - y0) / 120)))
    c.paste(col, (0, 0, W, HT), sh)
    return c


def lay_lineup(ep, cfg):
    sess, ppl = _sess(cfg), cfg['people']
    c = _bg(ep, ppl[0]['img'], dim=.55, blur=14)
    n = len(ppl)
    slot = W / n
    fh = cfg.get('face_h', .40) * HT
    for i, p in enumerate(ppl):
        cut, fc = _cut(ep, p, sess)
        _place(c, cut, fc, fh, slot * (i + .5), cfg.get('face_top', 40), outline=((255, 255, 255), 3), clip=(int(slot * i), int(slot * (i + 1))))
    c = _shade(c, 380, 235)
    d = ImageDraw.Draw(c)
    for i in range(1, n):
        d.line([(slot * i, 0), (slot * i, 400)], fill=(0, 0, 0), width=4)
    s1 = _fit(d, cfg['line1'], 116, W - 50)
    d.text((W / 2, 585), cfg['line1'], font=f(s1), fill=RED, anchor='ms', stroke_width=9, stroke_fill=(255, 255, 255))
    s2 = _fit(d, cfg['line2'], 92, W - 80)
    d.text((W / 2, 698), cfg['line2'], font=f(s2), fill=rgb(cfg['line2_color']) if cfg.get('line2_color') else (255, 255, 255), anchor='ms', stroke_width=6, stroke_fill=(0, 0, 0))
    return _chrome(c, cfg)


def lay_solo(ep, cfg):
    sess, p = _sess(cfg), cfg['person']
    c = _bg(ep, p['img'], dim=.6, blur=16)
    cut, fc = _cut(ep, p, sess)
    _place(c, cut, fc, cfg.get('face_h', .62) * HT, W * cfg.get('face_x', .27), cfg.get('face_top', 70), outline=((255, 255, 255), 4))
    d = ImageDraw.Draw(c)
    lines = cfg['lines']
    x0, maxw = int(W * .53), int(W * .45)
    sizes = [_fit(d, t, 104, maxw) for t in lines]
    y = (HT - sum(s + 22 for s in sizes)) / 2 + 30
    for i, (t, s) in enumerate(zip(lines, sizes)):
        col = YEL if i == 0 else RED if (cfg.get('mark') and i == len(lines) - 1) else (255, 255, 255)
        d.text((x0, y + s), t, font=f(s), fill=col, anchor='ls', stroke_width=7, stroke_fill=(0, 0, 0))
        y += s + 22
    return _chrome(c, cfg)


def lay_center_word(ep, cfg):
    sess, ppl = _sess(cfg), cfg['people'][:2]
    c = Image.new('RGB', (W, HT), rgb(cfg.get('bg', '#F3F3F1')))
    fh = cfg.get('face_h', .46) * HT
    for i, p in enumerate(ppl):
        cut, fc = _cut(ep, p, sess)
        _place(c, cut, fc, fh, W * (.17 if i == 0 else .83), cfg.get('face_top', 150), outline=((255, 255, 255), 5))
    d = ImageDraw.Draw(c)
    words = cfg['words']
    sz = min(_fit(d, w, 150, int(W * .40)) for w in words)
    sz = min(sz, int((HT - 60) / len(words)) - 14)
    y = (HT - len(words) * (sz + 14)) / 2
    for i, w in enumerate(words):
        d.text((W / 2, y + sz), w, font=f(sz), fill=RED if i % 2 == 0 else NAVY, anchor='ms', stroke_width=10, stroke_fill=(255, 255, 255))
        y += sz + 14
    return _chrome(c, cfg)


def lay_scene(ep, cfg):
    import math
    sc = cfg['scene']
    c = _bg(ep, sc['img'], dim=cfg.get('bg_dim', .25), blur=0, box=sc.get('box'))
    d = ImageDraw.Draw(c)
    for m in cfg.get('marks', []):
        if 'circle' in m:
            cx, cy, r = m['circle']
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RED, width=9)
        if 'arrow' in m:
            x0, y0, x1, y1 = m['arrow']
            d.line([(x0, y0), (x1, y1)], fill=RED, width=16)
            a = math.atan2(y1 - y0, x1 - x0)
            d.polygon([(x1, y1), (x1 - 46 * math.cos(a - .5), y1 - 46 * math.sin(a - .5)), (x1 - 46 * math.cos(a + .5), y1 - 46 * math.sin(a + .5))], fill=RED)
    c = _shade(c, 440, 215)
    d = ImageDraw.Draw(c)
    s1 = _fit(d, cfg['line1'], 96, W - 70)
    d.text((W / 2, 598), cfg['line1'], font=f(s1), fill=YEL, anchor='ms', stroke_width=6, stroke_fill=(0, 0, 0))
    s2 = _fit(d, cfg['line2'], 80, W - 120)
    d.text((W / 2, 696), cfg['line2'], font=f(s2), fill=(255, 255, 255), anchor='ms', stroke_width=5, stroke_fill=(0, 0, 0))
    return _chrome(c, cfg)


def lay_band(ep, cfg):
    by = int(cfg.get('band_y', 400))
    if cfg.get('scene'):
        sc = cfg['scene']
        im = Image.open(ep / sc['img']).convert('RGB')
        if sc.get('box'):   # 띠 위 칸(W x by) 비율로 자른다
            x0, y0, x1 = sc['box']
            im = im.crop((x0, y0, x1, y0 + int((x1 - x0) * by / W)))
        else:
            k = max(W / im.width, by / im.height)
            im = im.resize((int(im.width * k), int(im.height * k)))
            im = im.crop(((im.width - W) // 2, (im.height - by) // 2, (im.width - W) // 2 + W, (im.height - by) // 2 + by))
        c = Image.new('RGB', (W, HT), NAVY)
        c.paste(im.resize((W, by)), (0, 0))
    else:
        sess, ppl = _sess(cfg), cfg['people'][:2]
        c = _bg(ep, ppl[0]['img'], dim=.5, blur=12)
        n = len(ppl)
        for i, p in enumerate(ppl):
            cut, fc = _cut(ep, p, sess)
            cx = W * (.5 if n == 1 else (.27 if i == 0 else .73))
            _place(c, cut, fc, cfg.get('face_h', .42) * HT, cx, cfg.get('face_top', 40), outline=((255, 255, 255), 4),
                   clip=None if n == 1 else (0 if i == 0 else W // 2, W // 2 if i == 0 else W))
    d = ImageDraw.Draw(c)
    d.rectangle([0, by, W, HT], fill=rgb(cfg.get('band_color', '#10131C')))
    lines = cfg['lines'][:3]
    cols = cfg.get('line_colors') or ['#F5C518', '#FFFFFF', '#FFFFFF']
    room = HT - by - 30
    sizes = [_fit(d, t, min(120, int(room / len(lines)) - 12), W - 70) for t in lines]
    y = by + (HT - by - sum(s + 12 for s in sizes)) / 2 + 4
    for i, (t, s) in enumerate(zip(lines, sizes)):
        d.text((W / 2, y + s), t, font=f(s), fill=rgb(cols[min(i, len(cols) - 1)]), anchor='ms', stroke_width=5, stroke_fill=(0, 0, 0))
        y += s + 12
    return _chrome(c, cfg)


LAYOUTS = {'lineup': lay_lineup, 'solo': lay_solo, 'center_word': lay_center_word, 'scene': lay_scene, 'band': lay_band}


ep = Path(sys.argv[1])
cfg = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
VENV_VISION = Path('D:/midform/.venv-vision/Scripts/python.exe')
if cfg.get('font'):   # 정치JA 등 다른 언어 — 글꼴만 바꿔 같은 틀(10-29)
    FONT = cfg['font']
if cfg.get('layout') == 'vs':   # «대립» 프리셋 = 소유주 10-29 고른 4번(누끼·배경 어둡게·흐리게·흰 외곽선·얼굴 80%)
    for k, v in VS_DEFAULTS.items():
        cfg.setdefault(k, v)
if (cfg.get('mode') == 'cutout' or cfg.get('layout')) and Path(sys.executable).resolve() != VENV_VISION.resolve():
    import importlib.util, subprocess   # 누끼(rembg)는 .venv-vision 에만 — 다른 파이썬으로 불리면 거기서 다시 돈다(after_render 그대로 둬도 됨)
    if importlib.util.find_spec('rembg') is None:
        sys.exit(subprocess.run([str(VENV_VISION), '-X', 'utf8', __file__, *sys.argv[1:]]).returncode)
out = Path(sys.argv[3])
if cfg.get('layout') in LAYOUTS:   # lineup·solo·center_word·scene — refs/thumb_layouts/NOTES.md
    LAYOUTS[cfg['layout']](ep, cfg).convert('RGB').save(out)
    print(out)
    sys.exit(0)
sides = cfg['sides']
pw = W // len(sides)
c = Image.new('RGB', (W, HT), (0, 0, 0))
for i, s in enumerate(sides):
    im = Image.open(ep / s['img']).convert('RGB')
    x0, y0, x1 = s['box']
    y1 = y0 + int((x1 - x0) * HT / pw)
    if y1 > im.height:
        y0, y1 = max(0, im.height - (y1 - y0)), im.height
    c.paste(ImageEnhance.Contrast(im.crop((x0, y0, x1, y1)).resize((pw, HT))).enhance(1.1), (i * pw, 0))
if cfg.get('mode') == 'cutout':   # 소유주 10-29 «얼굴만 크게 누끼 따서 지금 배경 그대로에서 양쪽 대립»
    c = cutout_faces(c, ep, cfg, pw)
shade = Image.new('L', (W, HT), 0)
sd = ImageDraw.Draw(shade)
for y in range(TOP - 90, HT):
    sd.line([(0, y), (W, y)], fill=min(215, int(215 * (y - TOP + 90) / 170)))
c.paste((8, 14, 40), (0, 0, W, HT), shade)
d = ImageDraw.Draw(c)
if len(sides) > 1:
    d.line([(pw, 0), (pw, TOP - 40)], fill=(0, 0, 0), width=6)
for i, s in enumerate(sides):
    tw = d.textlength(s['name'], font=f(28))
    bx = 24 if i == 0 else W - 24 - tw - 24
    d.rectangle([bx, TOP - 136, bx + tw + 24, TOP - 92], fill=rgb(s['color']))
    d.text((bx + 12, TOP - 102), s['name'], font=f(28), fill=(255, 255, 255), anchor='ls')


def fit(text, size, maxw):
    while d.textlength(text, font=f(size)) > maxw:
        size -= 2
    return size


s1 = fit(cfg['quote'], 100, W - 70)
d.text((W / 2, 598), cfg['quote'], font=f(s1), fill=(255, 214, 0), anchor='ms', stroke_width=6, stroke_fill=(0, 0, 0))
s2 = fit(cfg['issue'], 84, W - 160)
d.text((W / 2, 698), cfg['issue'], font=f(s2), fill=(255, 255, 255), anchor='ms', stroke_width=5, stroke_fill=(0, 0, 0))
if cfg.get('chip'):
    tw = d.textlength(cfg['chip'], font=f(34))
    d.rectangle([20, 18, 20 + tw + 30, 70], fill=(212, 32, 44))
    d.text((35, 56), cfg['chip'], font=f(34), fill=(255, 255, 255), anchor='ls')
if cfg.get('source'):
    d.text((W - 14, 22), cfg['source'], font=f(16), fill=(230, 230, 230), anchor='rm', stroke_width=2, stroke_fill=(0, 0, 0))
c.save(out)
print(out)
