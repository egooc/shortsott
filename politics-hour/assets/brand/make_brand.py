"""채널 로고(800x800, 원형으로 잘림)와 배너(2560x1440, 안전 영역 1546x423)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

H = Path(__file__).resolve().parent
FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
BODY = 'D:/midform/politics-hour/assets/fonts/ROKAFSansMedium.ttf'
BG, YEL, BLUE, RED, WHITE = (12, 16, 28), (245, 197, 24), (30, 91, 216), (230, 30, 43), (255, 255, 255)
f = lambda n, p=FONT: ImageFont.truetype(p, n)

# 로고: 파랑·빨강 반원 위에 "쟁점" — 양쪽을 같은 크기로
L = 800
lg = Image.new('RGB', (L, L), BG)
d = ImageDraw.Draw(lg)
d.pieslice([40, 40, L - 40, L - 40], 90, 270, fill=BLUE)
d.pieslice([40, 40, L - 40, L - 40], 270, 90, fill=RED)
d.ellipse([130, 130, L - 130, L - 130], fill=BG)
d.text((L / 2, L / 2 - 18), '쟁점', font=f(230), fill=YEL, anchor='mm')
d.text((L / 2, L / 2 + 140), 'BRIEFING', font=f(62), fill=WHITE, anchor='mm')
lg.save(H / 'logo.png')

# 배너
W, HT = 2560, 1440
bn = Image.new('RGB', (W, HT), BG)
d = ImageDraw.Draw(bn)
for x in range(W):          # 왼쪽 파랑 → 가운데 어둠 → 오른쪽 빨강
    t = x / (W - 1)
    a = max(0, 1 - t * 2.2) if t < .5 else max(0, (t - 1) * 2.2 + 1)
    c = BLUE if t < .5 else RED
    d.line([(x, 0), (x, HT)], fill=tuple(int(BG[i] + (c[i] - BG[i]) * a * .85) for i in range(3)))
cx, cy = W // 2, HT // 2
d.text((cx, cy - 55), '쟁점 브리핑', font=f(170), fill=WHITE, anchor='mm')
d.rectangle([cx - 330, cy + 50, cx + 330, cy + 58], fill=YEL)
d.text((cx, cy + 120), '실제 발언 그대로  ·  판단은 시청자 몫', font=f(52, BODY), fill=(225, 228, 236), anchor='mm')
d.text((cx - 640, cy - 55), '“', font=f(260), fill=BLUE, anchor='mm')
d.text((cx + 640, cy - 55), '”', font=f(260), fill=RED, anchor='mm')
bn.save(H / 'banner.png')
# 안전 영역 미리보기(모바일에서 보이는 부분)
bn.crop((cx - 773, cy - 211, cx + 773, cy + 211)).save(H / 'banner_safe_preview.png')
print('ok')
