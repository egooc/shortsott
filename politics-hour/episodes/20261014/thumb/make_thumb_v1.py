"""썸네일: 양쪽의 센 발언을 하나씩, 같은 크기로 맞세운다(원문 그대로·따옴표·발언자 이름). 우리 문구는 아래 한 줄만."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

H = Path(__file__).resolve().parent
FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
BODY = 'D:/midform/politics-hour/assets/fonts/ROKAFSansMedium.ttf'
W, HT = 1280, 720
LEFT = dict(img='ljh_60.png', box=(650, 20, 1450, 920), name='이정헌 (더불어민주당)', quote=['“정치의 탈을 쓴', '패륜입니다”'], color=(30, 91, 216))
RIGHT = dict(img='ljs_95.png', box=(570, 100, 1370, 1000), name='이진숙 (국민의힘)', quote=['“대통령이', '왕입니까”'], color=(230, 30, 43))

c = Image.new('RGB', (W, HT), (8, 10, 18))
d = ImageDraw.Draw(c)
for i, s in enumerate((LEFT, RIGHT)):
    im = Image.open(H / s['img']).convert('RGB').crop(s['box']).resize((640, 720))
    im = ImageEnhance.Brightness(im).enhance(.78)
    c.paste(im, (i * 640, 0))
# 아래쪽 어둡게(글자 자리)
shade = Image.new('L', (W, HT), 0)
sd = ImageDraw.Draw(shade)
for y in range(300, HT):
    sd.line([(0, y), (W, y)], fill=int(235 * (y - 300) / (HT - 300)))
c.paste(Image.new('RGB', (W, HT), (8, 10, 18)), (0, 0), shade)
d = ImageDraw.Draw(c)
fq, fn, fb, fs = ImageFont.truetype(FONT, 66), ImageFont.truetype(FONT, 30), ImageFont.truetype(FONT, 44), ImageFont.truetype(BODY, 20)
for i, s in enumerate((LEFT, RIGHT)):
    x0 = i * 640 + 36
    d.rectangle([i * 640, 0, i * 640 + 640, 12], fill=s['color'])
    y = 330
    for line in s['quote']:
        d.text((x0 + 3, y + 4), line, font=fq, fill=(0, 0, 0))
        d.text((x0, y), line, font=fq, fill=(255, 255, 255) if line != s['quote'][-1] else (255, 214, 64))
        y += 80
    d.rectangle([x0, y + 8, x0 + d.textlength(s['name'], font=fn) + 24, y + 54], fill=s['color'])
    d.text((x0 + 12, y + 12), s['name'], font=fn, fill=(255, 255, 255))
# 가운데 VS
d.ellipse([590, 250, 690, 350], fill=(245, 197, 24))
d.text((640, 300), 'VS', font=ImageFont.truetype(FONT, 46), fill=(10, 10, 10), anchor='mm')
# 우리 문구: 중립 한 줄
band = '대통령 부모 묘소 논란 · 양쪽 주장 정리'
d.rectangle([0, 630, W, 720], fill=(245, 197, 24))
d.text((36, 675), band, font=fb, fill=(10, 10, 10), anchor='lm')
d.text((W - 36, 660), '쟁점 브리핑 10.14', font=ImageFont.truetype(FONT, 28), fill=(10, 10, 10), anchor='rm')
d.text((W - 36, 695), '영상: 안동MBC·춘천MBC 2026.10.12', font=fs, fill=(40, 40, 40), anchor='rm')
c.save(H / 'thumbnail.png')
print(H / 'thumbnail.png')
