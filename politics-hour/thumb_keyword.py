"""키워드 썸네일(관리자·소유주 10-17 14:00 확정 규칙): keywords.json 1~2위 낱말이 화면에서 가장 큰 글자, 제목 맨 앞 낱말과 같게.
얼굴은 1순위 키워드 인물 하나를 크게(주인공) + 보조 얼굴, 문장은 작은 보조 줄 하나로만. 글자 적게: 큰 낱말 1~2개 + 보조 한 줄.
소유주 원문: «키워드 따라서 썸네일도 가야 될 거 아니야. 그게 이슈면 그걸 세워야지 앞에 눈에 띄게.»

    python politics-hour/thumb_keyword.py <에피소드 폴더> <설정.json> [out.png]

설정.json: {"main": {"img": "thumb/ljs_72.png", "box": [x0, y0, x1], "name": "이진숙 · 국민의힘", "color": "#E61E2B"},
            "side": [{"img": ..., "box": [...], "name": ..., "color": ...}],      # 0~2개, 오른쪽에 세로로 나눠 붙는다
            "sub": "KBS 국감 또 멈췄다", "source": "영상: KBS News 2026.10.16",
            "big": ["이진숙 제척", "조희대 탄핵"]}                                  # 없으면 keywords.json 의 "thumb" → "keywords"[:2]
얼굴은 영상 캡처만(생성 금지). box 의 세로는 칸 비율로 자동."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
W, HT, MAINW = 1280, 720, 780
f = lambda n: ImageFont.truetype(FONT, n)
rgb = lambda h: tuple(int(h.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))

ep = Path(sys.argv[1])
cfg = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
kw = json.loads((ep / 'keywords.json').read_text(encoding='utf-8'))
big = cfg.get('big') or kw.get('thumb') or kw['keywords'][:2]
out = Path(sys.argv[3]) if len(sys.argv) > 3 else ep / 'thumb' / 'thumbnail_K.png'


def panel(face, w, h):
    im = Image.open(ep / face['img']).convert('RGB')
    x0, y0, x1 = face['box']
    y1 = y0 + int((x1 - x0) * h / w)
    if y1 > im.height:
        y0, y1 = max(0, im.height - (y1 - y0)), im.height
    return ImageEnhance.Contrast(im.crop((x0, y0, x1, y1)).resize((w, h))).enhance(1.12)


c = Image.new('RGB', (W, HT), (0, 0, 0))
side = cfg.get('side', [])
mw = MAINW if side else W
c.paste(panel(cfg['main'], mw, HT), (0, 0))
for i, s in enumerate(side):
    sh = HT // len(side)
    c.paste(panel(s, W - mw, sh), (mw, i * sh))
shade = Image.new('L', (W, HT), 0)
sd = ImageDraw.Draw(shade)
for y in range(330, HT):
    sd.line([(0, y), (W, y)], fill=min(235, int(235 * (y - 330) / 170)))
c.paste((8, 10, 24), (0, 0, W, HT), shade)
d = ImageDraw.Draw(c)
if side:
    d.line([(mw, 0), (mw, HT)], fill=(0, 0, 0), width=6)
    for i in range(1, len(side)):
        d.line([(mw, i * HT // len(side)), (W, i * HT // len(side))], fill=(0, 0, 0), width=6)


def fit(text, size, maxw):
    while d.textlength(text, font=f(size)) > maxw:
        size -= 2
    return size


def tag(x, y, face, size=26):
    nw = d.textlength(face['name'], font=f(size))
    d.rectangle([x, y, x + nw + 22, y + size + 16], fill=rgb(face['color']))
    d.text((x + 11, y + size + 8), face['name'], font=f(size), fill=(255, 255, 255), anchor='ls')


tag(18, 18, cfg['main'], 30)
for i, s in enumerate(side):
    tag(mw + 12, i * HT // len(side) + 14, s, 22)
# 보조 줄(작게, 빨간 칩) → 1순위 낱말(가장 크게, 노랑) → 2순위 낱말(두 번째, 흰)
if cfg.get('sub'):
    ss = fit(cfg['sub'], 44, W - 120)
    tw = d.textlength(cfg['sub'], font=f(ss))
    d.rounded_rectangle([40, 392 - ss, 40 + tw + 32, 392 + 14], 10, fill=(214, 24, 36))
    d.text((56, 392), cfg['sub'], font=f(ss), fill=(255, 255, 255), anchor='ls')
s1 = fit(big[0], 190, W - 60)
d.text((34, 572), big[0], font=f(s1), fill=(255, 222, 0), anchor='ls', stroke_width=9, stroke_fill=(0, 0, 0))
if len(big) > 1:
    s2 = fit(big[1], 118, W - 60)
    d.text((38, 700), big[1], font=f(s2), fill=(255, 255, 255), anchor='ls', stroke_width=7, stroke_fill=(0, 0, 0))
if cfg.get('source'):
    d.text((W - 12, HT - 10), cfg['source'], font=f(15), fill=(220, 220, 220), anchor='rs', stroke_width=2, stroke_fill=(0, 0, 0))
c.save(out)
print(out, big)
