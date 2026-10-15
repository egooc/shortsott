"""채널 프로필(800x800)·배너(2560x1440, 안전 영역 1546x423) 그림. python brand.py <출력 폴더>"""
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
BG, PINK, LIGHT, YELLOW = (11, 10, 16), (255, 90, 168), (255, 209, 232), (255, 225, 77)


def star(d, cx, cy, r, fill):
    """네 꼭지 반짝이(✦)."""
    pts = []
    for i in range(8):
        a = math.pi / 4 * i - math.pi / 2
        rr = r if i % 2 == 0 else r * 0.28
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=fill)


def heart(d, cx, cy, s, fill):
    d.ellipse([cx - s, cy - s * 0.75, cx, cy + s * 0.25], fill=fill)
    d.ellipse([cx, cy - s * 0.75, cx + s, cy + s * 0.25], fill=fill)
    d.polygon([(cx - s * 0.97, cy - 0.1 * s), (cx + s * 0.97, cy - 0.1 * s), (cx, cy + s * 1.05)], fill=fill)


def glow(size, center, radius, color, alpha):
    g = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
                              fill=color + (alpha,))
    return g.filter(ImageFilter.GaussianBlur(radius * 0.45))


def text_c(d, xy, s, size, fill):
    f = ImageFont.truetype(FONT, size)
    d.text(xy, s, font=f, fill=fill, anchor='mm')


def profile(out):
    W = 800
    im = Image.new('RGBA', (W, W), BG + (255,))
    im.alpha_composite(glow((W, W), (400, 400), 300, PINK, 120))
    d = ImageDraw.Draw(im)
    heart(d, 400, 330, 120, PINK)
    text_c(d, (400, 330), '최애', 112, (255, 255, 255))
    text_c(d, (400, 560), '모먼트', 96, LIGHT)
    star(d, 610, 190, 46, YELLOW)
    star(d, 190, 230, 28, LIGHT)
    star(d, 640, 600, 22, LIGHT)
    im.convert('RGB').save(out / 'profile_800.png')


def banner(out):
    W, H = 2560, 1440
    im = Image.new('RGBA', (W, H), BG + (255,))
    im.alpha_composite(glow((W, H), (1280, 720), 560, PINK, 90))
    d = ImageDraw.Draw(im)
    rnd = random.Random(7)
    for _ in range(70):     # 안전 영역 밖 장식(데스크톱·TV 에서만 보임)
        x, y = rnd.randint(0, W), rnd.randint(0, H)
        if 470 < x < 2090 and 470 < y < 970:
            continue
        (star if rnd.random() < 0.6 else heart)(d, x, y, rnd.randint(10, 34), rnd.choice([PINK, LIGHT, YELLOW]))
    heart(d, 820, 700, 70, PINK)
    text_c(d, (1330, 680), '최애모먼트', 150, (255, 255, 255))
    text_c(d, (1280, 830), '최애의 귀여운 한 장면  ·  매일 쇼츠', 56, LIGHT)
    star(d, 1820, 600, 40, YELLOW)
    star(d, 1880, 680, 20, LIGHT)
    im.convert('RGB').save(out / 'banner_2560x1440.png')
    prev = im.convert('RGB').copy()     # 안전 영역 확인용
    ImageDraw.Draw(prev).rectangle([507, 508, 2053, 931], outline=(0, 255, 0), width=4)
    prev.resize((1280, 720)).save(out / 'banner_safe_preview.jpg')


if __name__ == '__main__':
    o = Path(sys.argv[1])
    o.mkdir(parents=True, exist_ok=True)
    profile(o)
    banner(o)
    print(o)
