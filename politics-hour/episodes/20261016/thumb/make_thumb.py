"""썸네일: 얼굴 두 개를 위에 크게, 글자는 아래 두 줄만(레퍼런스 실측: 조회수 높은 정치 썸네일 공통).
1줄 = 사진 속 인물이 실제로 한 센 발언(원문 그대로, 말한 사람 얼굴과 짝), 2줄 = 센 낱말 + 궁금증(쟁점 이름 금지). 이름표·출처는 작게.
10/15부터 진영 편(정부·여당 쪽): 양쪽 같은 크기 규칙 없음."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

H = Path(__file__).resolve().parent
FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
W, HT, TOP = 1280, 720, 480
SIDES = [dict(img='pjm_4335.png', box=(570, 120, 1350, 0), name='박주민 · 더불어민주당', color=(30, 91, 216)),
         dict(img='osh_4503.png', box=(590, 150, 1370, 0), name='오세훈 · 서울시장', color=(230, 30, 43))]
QUOTE = '“솔직히 기억은 나지 않습니다”'   # 오세훈, 행안위 서울시 국감 10.15 (KBS 4504초)
ISSUE = '15억 수사의뢰서, 어디로 갔나?'
SOURCE = '영상: KBS News 2026.10.15'

c = Image.new('RGB', (W, HT), (0, 0, 0))
for i, s in enumerate(SIDES):
    x0, y0, x1, y1 = s['box']                                  # 사진을 화면 끝(720)까지 — 아래 검은 띠 없음(10-15 소유주)
    y1 = y0 + int((x1 - x0) * HT / 640)
    im = Image.open(H / s['img']).convert('RGB').crop((x0, y0, x1, y1)).resize((640, HT))
    c.paste(ImageEnhance.Contrast(im).enhance(1.1), (i * 640, 0))
shade = Image.new('L', (W, HT), 0)                           # 글자 뒤만 반투명하게 어둡게(채널A식), 사진은 비친다
sd = ImageDraw.Draw(shade)
for y in range(TOP - 90, HT):
    sd.line([(0, y), (W, y)], fill=min(215, int(215 * (y - TOP + 90) / 170)))
c.paste((8, 14, 40), (0, 0, W, HT), shade)
d = ImageDraw.Draw(c)
d.line([(640, 0), (640, TOP - 40)], fill=(0, 0, 0), width=6)
f = lambda n: ImageFont.truetype(FONT, n)
for i, s in enumerate(SIDES):
    x = i * 640 + (24 if i == 0 else 640 - 24)
    anchor = 'ls' if i == 0 else 'rs'
    tw = d.textlength(s['name'], font=f(28))
    bx = x if i == 0 else x - tw - 24
    d.rectangle([bx, TOP - 136, bx + tw + 24, TOP - 92], fill=s['color'])
    d.text((bx + 12, TOP - 102), s['name'], font=f(28), fill=(255, 255, 255), anchor='ls')
# 10-15 소유주(채널A·JTBC·KNN 레퍼런스): 윗줄 = 색 있는 큰 글씨(발언), 아랫줄 = 그라데이션 위 흰 글씨(궁금증)
import sys
TOPCOL = {'yellow': (255, 214, 0), 'cyan': (62, 230, 255)}[sys.argv[1] if len(sys.argv) > 1 else 'yellow']
def fit(text, size, maxw):
    while d.textlength(text, font=f(size)) > maxw:
        size -= 2
    return size
s1 = fit(QUOTE, 100, W - 70)
d.text((W / 2, 598), QUOTE, font=f(s1), fill=TOPCOL, anchor='ms', stroke_width=6, stroke_fill=(0, 0, 0))
s2 = fit(ISSUE, 84, W - 160)
d.text((W / 2, 698), ISSUE, font=f(s2), fill=(255, 255, 255), anchor='ms', stroke_width=5, stroke_fill=(0, 0, 0))
# 레퍼런스(10-15 vidIQ 국감 상위 썸네일 실측): 얼굴 옆 반응 글자(손글씨풍 노랑, 사실 주장 아닌 감탄·부호만)와 빨간 칩
REACT = [((1150, 70), '(???)')]               # 오세훈 쪽 반응 — 말이 아니라 부호만
CHIP = '국감 현장'
if len(sys.argv) > 2 and sys.argv[2] == 'react':
    for (x, y), txt in REACT:
        d.text((x, y), txt, font=f(64), fill=(255, 230, 0), anchor='mm', stroke_width=6, stroke_fill=(0, 0, 0))
    tw = d.textlength(CHIP, font=f(34))
    d.rectangle([20, 18, 20 + tw + 30, 70], fill=(212, 32, 44))
    d.text((35, 56), CHIP, font=f(34), fill=(255, 255, 255), anchor='ls')
d.text((W - 14, 22), SOURCE, font=f(16), fill=(230, 230, 230), anchor='rm', stroke_width=2, stroke_fill=(0, 0, 0))
OUT = H / ('thumbnail_v3_' + '_'.join(sys.argv[1:] or ['yellow']) + '.png')   # 공개본 thumbnail.png 은 남겨 둔다
c.save(OUT)
print(OUT)
