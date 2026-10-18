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

ep = Path(sys.argv[1])
cfg = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
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
