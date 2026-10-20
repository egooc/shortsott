# -*- coding: utf-8 -*-
"""10/20 새 포장 2개(관리자 «인물 이름 + 본인 한마디 — 상대 인물», ko 비교표 규칙) — 인물 얼굴 둘 + 실제 발언 인용(원문 그대로, 줄임은 …).
왼쪽 = 고이치 총리(官邸 회견 iiY537K7WPQ 520초, PDL1.0), 오른쪽 = 岡本三成 의원(衆議院本会議 10/7 1602.5초, 인용 — 640x360 이라 작게).
python make_thumb_vs.py c|g"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter

HERE = Path(__file__).parent
F = Path('D:/midform/politics-hour-ja/assets/fonts')
W, H = 1280, 720
NAVY, ACC, GOLD, PAPER = (14, 23, 38), (226, 83, 58), (255, 206, 60), (244, 241, 234)
SPEC = {
    'c': dict(tag='消費税1% · 国会と会見の答弁', mine=['「1%であれば…', '　令和9年4月から', '　実施可能」'], theirs=['「苦しいのは', '　いまです」']),
    'g': dict(tag='ガソリン補助 · 衆議院本会議 10/7', mine=['「あくまでも', '　激変緩和措置」'], theirs=['「1リットル51円と', '　過去最高額」']),
}


def font(name, size, weight):
    f = ImageFont.truetype(str(F / name), size)
    f.set_variation_by_axes([weight])
    return f


def fade_h(img, x0, x1, left_solid):   # 가로 그라데이션으로 남색에 녹인다
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    for x in range(W):
        k = 0 if x < x0 else 1 if x > x1 else (x - x0) / (x1 - x0)
        d.line([(x, 0), (x, H)], fill=int(255 * ((1 - k) if left_solid else k)))
    return Image.composite(Image.new('RGB', (W, H), NAVY), img, m)


key = sys.argv[1]
s = SPEC[key]
img = Image.new('RGB', (W, H), NAVY)
tk = ImageEnhance.Contrast(Image.open(HERE / 'kk_520.png').convert('RGB').crop((220, 70, 760, 610)).resize((620, 620), Image.LANCZOS)).enhance(1.08)
img.paste(tk, (-10, 20))
img = fade_h(img, 560, 640, False)   # 고이치 얼굴 오른쪽 끝을 녹인다
ok = Image.open(HERE / 'ok_1602.5.png').convert('RGB').crop((250, 22, 410, 182)).resize((420, 420), Image.LANCZOS)
ok = ImageEnhance.Sharpness(ok.filter(ImageFilter.GaussianBlur(.6))).enhance(1.6)
om = Image.new('L', ok.size, 0); od = ImageDraw.Draw(om)
for x in range(ok.width):   # 岡本 얼굴 왼쪽 가장자리도 녹인다
    od.line([(x, 0), (x, ok.height)], fill=min(255, int(255 * x / 90)))
img.paste(ok, (W - 440, 30), om)
m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
for y in range(H):
    d.line([(0, y), (W, y)], fill=min(235, max(0, int(235 * (y - 400) / 160))))
img = Image.composite(Image.new('RGB', (W, H), NAVY), img, m)
dr = ImageDraw.Draw(img)


def txt(xy, t, f, fill, stroke=6):
    dr.text(xy, t, font=f, fill=fill, stroke_width=stroke, stroke_fill=NAVY)


dr.rectangle([0, 0, W, 8], fill=GOLD)
tf = font('NotoSansJP.ttf', 26, 900)
dr.rectangle([30, 28, 30 + dr.textlength(s['tag'], font=tf) + 28, 72], fill=PAPER)
dr.text((44, 30), s['tag'], font=tf, fill=NAVY)
q = font('NotoSerifJP.ttf', 92 if len(s['mine']) == 3 else 104, 900)
y = 380 if len(s['mine']) == 3 else 440
for ln in s['mine']:
    txt((30, y), ln, q, GOLD, 7); y += q.size + 8
q2 = font('NotoSerifJP.ttf', 62, 900)
y = 480
for ln in s['theirs']:
    txt((W - 30 - max(dr.textlength(x, font=q2) for x in s['theirs']), y), ln, q2, PAPER, 5); y += 76
nm = font('NotoSansJP.ttf', 28, 800)
for label, x, right, fill in (('高市早苗 内閣総理大臣', 30, False, ACC), ('岡本三成 衆議院議員', W - 30, True, (60, 76, 104))):
    tw = dr.textlength(label, font=nm)
    x0 = x - tw - 32 if right else x
    yy = 86 if not right else 418
    dr.rectangle([x0, yy, x0 + tw + 32, yy + 44], fill=fill)
    dr.text((x0 + 16, yy + 4), label, font=nm, fill=(255, 255, 255))
dr.text((W - 14, H - 12), '映像：首相官邸ホームページ／衆議院インターネット審議中継', font=font('NotoSansJP.ttf', 16, 600), fill=(220, 220, 220), anchor='rs')
out = HERE / f'thumb_vs_{key}.jpg'
img.save(out, quality=92)
print(out)
