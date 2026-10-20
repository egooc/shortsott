# -*- coding: utf-8 -*-
"""10/20 루프 묶음 썸네일 — 정치 썸네일 규칙(소유주 10/14·15): 얼굴 둘이 위 60%를 크게 채움, 글자는 아래 두 줄만
(윗줄 = 사진 속 인물의 실제 발언 원문·금색 큰 글씨, 아랫줄 = 궁금증·흰 글씨), 글자 뒤만 그라데이션, 이름은 작은 칩, 출처 구석.
왼쪽 = 고이치 총리(官邸 회견 iiY537K7WPQ 520초, PDL1.0), 오른쪽 = 岡本三成 의원(衆議院本会議 10/7 1602.5초, 인용).
python make_thumb_vs.py c|g"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter

HERE = Path(__file__).parent
F = Path('D:/midform/politics-hour-ja/assets/fonts')
W, H = 1280, 720
NAVY, ACC, GOLD, PAPER = (14, 23, 38), (226, 83, 58), (255, 206, 60), (244, 241, 234)
SPEC = {
    'c': dict(top='「苦しいのはいまです」', bottom='消費税1%、総理の答えは？'),
    'g': dict(top='「あくまでも激変緩和措置」', bottom='ガソリン補助、いつまで？'),
}


def font(name, size, weight):
    f = ImageFont.truetype(str(F / name), size)
    f.set_variation_by_axes([weight])
    return f


s = SPEC[sys.argv[1]]
img = Image.new('RGB', (W, H), NAVY)
# 얼굴 둘을 화면 반씩, 눈높이 ≈ 위 25%
tk = Image.open(HERE / 'kk_520.png').convert('RGB').crop((360, 150, 640, 500))          # 280x350 → 640x800
tk = ImageEnhance.Contrast(tk.resize((640, 800), Image.LANCZOS)).enhance(1.08)
img.paste(tk, (0, -40))
ok = Image.open(HERE / 'ok_1602.5.png').convert('RGB').crop((258, 18, 402, 198))         # 144x180 → 640x800
ok = ImageEnhance.Sharpness(ok.resize((640, 800), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.2))).enhance(1.8)
img.paste(ok, (640, -40))
dr = ImageDraw.Draw(img)
dr.line([(640, 0), (640, H)], fill=NAVY, width=6)
# 글자 뒤만 그라데이션(아래 40%)
m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
for y in range(H):
    d.line([(0, y), (W, y)], fill=min(225, max(0, int(225 * (y - 400) / 140))))
img = Image.composite(Image.new('RGB', (W, H), (8, 12, 22)), img, m)
dr = ImageDraw.Draw(img)


def fit(t, name, size, weight, maxw):
    f = font(name, size, weight)
    while dr.textlength(t, font=f) > maxw:
        size -= 4; f = font(name, size, weight)
    return f


f1 = fit(s['top'], 'NotoSansJP.ttf', 112, 900, W - 60)
dr.text((W / 2, 520), s['top'], font=f1, fill=GOLD, anchor='mm', stroke_width=8, stroke_fill=NAVY)
f2 = fit(s['bottom'], 'NotoSansJP.ttf', 84, 900, W - 80)
dr.text((W / 2, 650), s['bottom'], font=f2, fill=PAPER, anchor='mm', stroke_width=6, stroke_fill=NAVY)
nm = font('NotoSansJP.ttf', 26, 800)
for label, x, fill in (('高市総理', 24, ACC), ('岡本三成 議員', 664, (60, 76, 104))):
    tw = dr.textlength(label, font=nm)
    dr.rectangle([x, 24, x + tw + 28, 64], fill=fill)
    dr.text((x + 14, 27), label, font=nm, fill=(255, 255, 255))
dr.text((W - 12, H - 8), '映像：首相官邸ホームページ／衆議院インターネット審議中継', font=font('NotoSansJP.ttf', 15, 600), fill=(200, 200, 200), anchor='rs')
out = HERE / f'thumb_vs_{sys.argv[1]}.jpg'
img.save(out, quality=92)
print(out)
