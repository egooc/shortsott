# -*- coding: utf-8 -*-
"""썸네일 — 지도/장면 그림 + 이름표 원(생성 얼굴 금지, 글자만) + 왼쪽 세로 연호 상자 + 아래 검은 띠 2줄(작은 맥락 / 큰 결론).
발굴 시트 JA §3·§4(絵で見る 11/11 꼴). 결론 줄은 [[글자, 색키], ...] 로 숫자·이름만 색.

    python -X utf8 monetize-longform/tools/thumb.py <편 폴더>/thumbs.json <편 폴더>
thumbs.json: {"<이름>": {"bg": "img/x.png", "era": ["天正十九年", "1591年"], "names": [["秀長", x, y, "red"]], "top": "작은 맥락",
              "big": [["글자", "white|red|yellow|green"], ...]}}
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SERIF = ROOT / 'ja-nenkin' / 'render' / 'fonts' / 'NotoSerifJP-VF.ttf'
SANS = ROOT / 'politics-hour-ja' / 'assets' / 'fonts' / 'NotoSansJP.ttf'
W, H = 1280, 720
COL = {'white': (255, 255, 255), 'red': (235, 64, 52), 'yellow': (255, 214, 64), 'green': (110, 210, 120), 'orange': (245, 150, 40)}


def font(p, size, wght=900):
    f = ImageFont.truetype(str(p), size)
    try:
        f.set_variation_by_axes([wght])
    except Exception:
        pass
    return f


def make(spec, ep, out):
    bg = Image.open(ep / spec['bg']).convert('RGB')
    s = max(W / bg.width, H / bg.height)
    bg = bg.resize((int(bg.width * s) + 1, int(bg.height * s) + 1))
    fx, fy = spec.get('focus', [.5, .4])
    x0 = int((bg.width - W) * fx)
    y0 = int((bg.height - H) * fy)
    im = ImageEnhance.Brightness(bg.crop((x0, y0, x0 + W, y0 + H))).enhance(.8)
    d = ImageDraw.Draw(im)
    for name, x, y, c in spec.get('names', []):      # 이름표 원(금테)
        r = 74
        d.ellipse([x - r - 6, y - r - 6, x + r + 6, y + r + 6], fill=(200, 160, 60))
        d.ellipse([x - r, y - r, x + r, y + r], fill=COL.get(c, (40, 50, 70)) if c != 'navy' else (32, 44, 74))
        f = font(SERIF, 62 if len(name) <= 2 else 46)
        d.text((x, y), name, font=f, fill=(255, 255, 255), anchor='mm', stroke_width=3, stroke_fill=(20, 20, 20))
    era = spec.get('era')
    if era:                                           # 왼쪽 세로 연호 상자
        d.rectangle([24, 24, 132, 450], fill=(250, 246, 236), outline=(40, 30, 20), width=5)
        f = font(SERIF, 52)
        y = 50
        for ch in era[0]:
            d.text((78, y), ch, font=f, fill=(30, 20, 10), anchor='mt'); y += 58
        f2 = font(SANS, 34)
        d.text((78, min(y + 6, 410)), era[1], font=f2, fill=(196, 52, 44), anchor='mt')
    d.rectangle([0, H - 230, W, H], fill=(10, 12, 18))
    d.text((40, H - 210), spec['top'], font=font(SANS, 46, 800), fill=(230, 230, 230))
    f = font(SANS, 92)
    x = 40
    total = sum(d.textlength(t, font=f) for t, _ in spec['big'])
    if total > W - 80:
        f = font(SANS, int(92 * (W - 80) / total))
    for t, c in spec['big']:
        d.text((x, H - 132), t, font=f, fill=COL[c])
        x += d.textlength(t, font=f)
    im.save(out, quality=92)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sp = Path(sys.argv[1])
    ep = Path(sys.argv[2])
    (ep / 'thumb').mkdir(exist_ok=True)
    for k, spec in json.loads(sp.read_text(encoding='utf-8')).items():
        make(spec, ep, ep / 'thumb' / f'{k}.jpg')
        print(k)


if __name__ == '__main__':
    main()
