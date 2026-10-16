"""썸네일: 얼굴 두 개를 위에 크게, 글자는 아래 두 줄만(레퍼런스 실측: 조회수 높은 정치 썸네일 공통).
1줄 = 양쪽 센 발언 “A” vs “B”(원문 그대로), 2줄 = 쟁점 이름. 이름표·출처는 작게."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

H = Path(__file__).resolve().parent
FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
W, HT, TOP = 1280, 720, 480
SIDES = [dict(img='ljh_90.png', box=(660, 0, 1400, 545), name='이정헌 · 민주당', quote='“정치의 탈을 쓴 패륜”', color=(30, 91, 216)),
         dict(img='ljs_105.png', box=(560, 120, 1300, 665), name='이진숙 · 국민의힘', quote='“대통령이 왕입니까”', color=(230, 30, 43))]
ISSUE = '12대 0, 국회에서 무슨 일이?'   # 주제는 숨기고 궁금증만(소유주 10/14)
SOURCE = '영상: 안동MBC·춘천MBC 2026.10.12'

c = Image.new('RGB', (W, HT), (0, 0, 0))
for i, s in enumerate(SIDES):
    im = Image.open(H / s['img']).convert('RGB').crop(s['box']).resize((640, TOP + 70))
    c.paste(ImageEnhance.Contrast(im).enhance(1.1), (i * 640, 0))
shade = Image.new('L', (W, HT), 0)
sd = ImageDraw.Draw(shade)
for y in range(TOP - 80, HT):
    sd.line([(0, y), (W, y)], fill=min(255, int(255 * (y - TOP + 80) / 80)))
c.paste((0, 0, 0), (0, 0, W, HT), shade)
d = ImageDraw.Draw(c)
d.line([(640, 0), (640, TOP - 40)], fill=(0, 0, 0), width=6)
f = lambda n: ImageFont.truetype(FONT, n)
for i, s in enumerate(SIDES):
    x = i * 640 + (24 if i == 0 else 640 - 24)
    anchor = 'ls' if i == 0 else 'rs'
    tw = d.textlength(s['name'], font=f(28))
    bx = x if i == 0 else x - tw - 24
    d.rectangle([bx, TOP - 96, bx + tw + 24, TOP - 52], fill=s['color'])
    d.text((bx + 12, TOP - 62), s['name'], font=f(28), fill=(255, 255, 255), anchor='ls')
# 1줄: 양쪽 발언
q1, q2, vs = SIDES[0]['quote'], SIDES[1]['quote'], '  vs  '
fq = f(56)
total = d.textlength(q1 + vs + q2, font=fq)
x = (W - total) / 2
for part, col in ((q1, (255, 255, 255)), (vs, (245, 197, 24)), (q2, (255, 255, 255))):
    d.text((x, 572), part, font=fq, fill=col, anchor='ls')
    x += d.textlength(part, font=fq)
# 2줄: 쟁점
d.text((W / 2, 690), ISSUE, font=f(84), fill=(255, 214, 0), anchor='ms', stroke_width=2, stroke_fill=(0, 0, 0))
d.text((W - 14, 22), SOURCE, font=f(16), fill=(230, 230, 230), anchor='rm', stroke_width=2, stroke_fill=(0, 0, 0))
c.save(H / 'thumbnail.png')
print(H / 'thumbnail.png')
