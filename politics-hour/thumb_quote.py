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


ep = Path(sys.argv[1])
cfg = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
VENV_VISION = Path('D:/midform/.venv-vision/Scripts/python.exe')
if cfg.get('mode') == 'cutout' and Path(sys.executable).resolve() != VENV_VISION.resolve():
    import importlib.util, subprocess   # 누끼(rembg)는 .venv-vision 에만 — 다른 파이썬으로 불리면 거기서 다시 돈다(after_render 그대로 둬도 됨)
    if importlib.util.find_spec('rembg') is None:
        sys.exit(subprocess.run([str(VENV_VISION), '-X', 'utf8', __file__, *sys.argv[1:]]).returncode)
out = Path(sys.argv[3])
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
