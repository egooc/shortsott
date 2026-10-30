# -*- coding: utf-8 -*-
"""틱톡 ④·⑤ 자체 도해(1080×1920 PNG) — 생성 그림이 아니라 직접 그린 설명 그림.

    python -X utf8 ko-corp/tok/diagrams.py            네 편 전부 → <편>/img/d*.png

tok4a d1~d4  엘리베이터 승강로: 칸·레일·과속 조절기·조속기 줄·쐐기, 단계마다 해당 부품만 주황
tok4b d1~d4  모래→칩 4단계 사다리(전기로·정제·잉곳 끌어올리기·웨이퍼), 현재 단계만 크게
tok5a d_gaze 위에서 본 그림·관람객·시선(정면 vs 오른쪽 15도)
tok5b d_rip·d_escape  위에서 본 해변·이안류 물길·탈출 방향
글자는 도해 안 이름표만(자막·단계 꼬리표는 렌더러가 얹는다). 아래 30%는 자막 자리라 비워 둔다.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FONT = str(ROOT / 'assets' / 'fonts' / 'rinbox' / 'GmarketSansBold.otf')
W, H = 1080, 1920
BG, INK, DIM, HOT, BLUE = (18, 24, 38), (235, 240, 250), (90, 104, 130), (255, 140, 30), (70, 160, 255)


def canvas():
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    for y in range(0, H, 60):   # 옅은 모눈
        d.line([(0, y), (W, y)], fill=(26, 34, 52))
    for x in range(0, W, 60):
        d.line([(x, 0), (x, H)], fill=(26, 34, 52))
    return im, d


def f(n):
    return ImageFont.truetype(FONT, n)


def label(d, xy, text, color=INK, size=40, anchor='mm'):
    d.text(xy, text, font=f(size), fill=color, anchor=anchor, stroke_width=4, stroke_fill=BG)


def arrow(d, a, b, color, w=10, head=34):
    d.line([a, b], fill=color, width=w)
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    p = [b, (b[0] - head * math.cos(ang - .45), b[1] - head * math.sin(ang - .45)),
         (b[0] - head * math.cos(ang + .45), b[1] - head * math.sin(ang + .45))]
    d.polygon(p, fill=color)


def elevator(step):
    im, d = canvas()
    c = lambda k: HOT if k == step else DIM   # noqa: E731
    # 레일 두 줄
    for x in (300, 780):
        d.rectangle([x - 10, 330, x + 10, 1330], fill=c(4) if step == 4 else (120, 130, 150))
    # 기계실 과속 조절기(위) · 아래 도르래
    gx, gy = 880, 260
    d.ellipse([gx - 80, gy - 80, gx + 80, gy + 80], outline=c(2) if step != 3 else HOT, width=12)
    if step >= 3:   # 원심력 추 벌어짐
        for a in (0, math.pi):
            ox, oy = gx + 55 * math.cos(a), gy + 55 * math.sin(a)
            d.ellipse([ox - 18, oy - 18, ox + 18, oy + 18], fill=HOT)
    else:
        for a in (0, math.pi):
            ox, oy = gx + 25 * math.cos(a), gy + 25 * math.sin(a)
            d.ellipse([ox - 16, oy - 16, ox + 16, oy + 16], fill=c(2))
    d.ellipse([gx - 50, 1300, gx + 50, 1400], outline=(120, 130, 150), width=8)
    rope = HOT if step in (2, 3) else (150, 160, 180)
    d.line([(gx + 80, gy), (gx + 50, 1350)], fill=rope, width=6)
    d.line([(gx - 80, gy), (gx - 80, 760)], fill=rope, width=6)
    d.line([(gx - 80, 820), (gx - 50, 1350)], fill=rope, width=6)
    # 칸
    top = 640 if step == 1 else 700
    d.rounded_rectangle([330, top, 750, top + 360], 16, fill=(40, 52, 78), outline=INK, width=6)
    d.line([(gx - 80, top + 150), (750, top + 150)], fill=c(4), width=8)   # 레버 연결
    # 끊어진 로프
    for x in (470, 540, 610):
        d.line([(x, 330), (x + 10, 470)], fill=(150, 160, 180), width=6)
        d.line([(x + 6, 560), (x, top)], fill=(150, 160, 180), width=6)
    # 쐐기
    for x, sgn in ((310, 1), (770, -1)):
        y = top + 330
        d.polygon([(x + sgn * 20, y), (x + sgn * 60, y - 50), (x + sgn * 60, y + 30)], fill=c(4))
    label(d, (540, 380), '끊어진 로프', (180, 190, 210), 36)
    label(d, (gx - 10, 130), '과속 조절기', HOT if step in (2, 3) else INK, 40)
    label(d, (540, top + 180), '칸', INK, 60)
    if step == 1:
        arrow(d, (540, top + 420), (540, top + 600), HOT, 14, 44)
        label(d, (540, top + 650), '떨어지며 빨라짐', HOT, 44)
    if step == 3:
        label(d, (540, 1140), '추가 벌어져 줄을 잡음', HOT, 44)
    if step == 4:
        label(d, (540, top + 430), '쐐기가 레일을 꽉 문다', HOT, 44)
        arrow(d, (gx - 80, top + 150), (760, top + 150), HOT, 8, 30)
    return im


def ladder(step):
    im, d = canvas()
    items = [('전기로', '규석+탄소 · 2천 도'), ('정제', '기체 화합물로 → 걸러 냄'), ('잉곳', '씨앗 결정 끌어올리기'), ('웨이퍼', '얇게 썰고 갈기')]
    y0 = 240
    for i, (name, sub) in enumerate(items, 1):
        on = i == step
        y = y0 + (i - 1) * 300
        box = [120, y, 960, y + 240]
        d.rounded_rectangle(box, 30, fill=(60, 40, 20) if on else (30, 38, 58), outline=HOT if on else DIM, width=8 if on else 4)
        d.ellipse([150, y + 50, 290, y + 190], fill=HOT if on else DIM)
        label(d, (220, y + 122), str(i), BG, 80)
        label(d, (330, y + 85), name, HOT if on else INK, 64 if on else 52, 'lm')
        label(d, (330, y + 170), sub, INK if on else DIM, 38, 'lm')
        if i < 4:
            arrow(d, (540, y + 245), (540, y + 295), DIM, 8, 24)
        if i < step:   # 지난 단계 체크(글꼴에 ✓ 없음 → 선으로)
            d.line([(870, y + 120), (895, y + 150), (945, y + 90)], fill=BLUE, width=12)
    return im


def gaze():
    im, d = canvas()
    px, py = 540, 330
    d.rectangle([px - 170, py - 40, px + 170, py + 40], fill=(120, 100, 70), outline=INK, width=4)
    label(d, (px, py - 100), '그림', INK, 48)
    vy = 1180
    d.ellipse([px - 60, vy - 60, px + 60, vy + 60], fill=BLUE)
    label(d, (px, vy + 110), '보는 사람', INK, 44)
    for dx in (-26, 26):   # 눈 방향 표시
        d.ellipse([px + dx - 10, vy - 80, px + dx + 10, vy - 60], fill=INK)
    d.line([(px, py + 40), (px, vy - 70)], fill=DIM, width=6)
    label(d, (px - 30, 700), '정면\n(소문)', DIM, 40, 'rm')
    ang = math.radians(15)
    ex, ey = px + (vy - py) * math.tan(ang), vy - 70
    arrow(d, (px, py + 40), (ex, ey), HOT, 12, 40)
    label(d, (ex + 10, ey + 80), '실제 시선\n오른쪽 15.4도', HOT, 46)
    d.arc([px - 220, py - 180, px + 220, py + 260], 90 - 15, 90, fill=HOT, width=6)
    return im


def beach(escape):
    im, d = canvas()
    d.rectangle([0, 0, W, 760], fill=(20, 70, 120))          # 바다
    d.rectangle([0, 760, W, 1080], fill=(30, 110, 160))      # 얕은 물
    d.rectangle([0, 1080, W, 1320], fill=(214, 190, 140))    # 모래
    for x0, x1 in ((40, 420), (660, 1040)):                 # 부서지는 파도
        for k in range(3):
            y = 820 + k * 70
            d.arc([x0, y, x1, y + 80], 200, 340, fill=(240, 245, 255), width=10)
    d.polygon([(450, 1080), (630, 1080), (600, 200), (480, 200)], fill=(14, 50, 90))   # 물길(짙음)
    for y in range(1020, 260, -170):
        arrow(d, (540, y), (540, y - 120), HOT, 12, 36)
    label(d, (540, 140), '이안류 물길 → 먼바다', HOT, 46)
    d.text((230, 1200), '모래사장', font=f(44), fill=(70, 50, 25), anchor='mm')
    if escape:
        sx, sy = 540, 560
        d.ellipse([sx - 30, sy - 30, sx + 30, sy + 30], fill=(255, 220, 120))
        d.line([(sx, sy + 40), (sx, 900)], fill=(255, 70, 70), width=10)
        d.line([(sx - 22, 930), (sx + 22, 974)], fill=(255, 90, 90), width=10)
        d.line([(sx + 22, 930), (sx - 22, 974)], fill=(255, 90, 90), width=10)
        label(d, (sx + 40, 952), '정면', (255, 90, 90), 44, 'lm')
        arrow(d, (sx + 40, sy), (900, sy), (90, 230, 120), 14, 44)
        arrow(d, (900, sy), (900, 1000), (90, 230, 120), 14, 44)
        label(d, (860, sy - 70), '옆으로', (90, 230, 120), 50)
    return im


def main():
    for i in range(1, 5):
        elevator(i).save(HERE / 'tok4a' / 'img' / f'd{i}.png')
        ladder(i).save(HERE / 'tok4b' / 'img' / f'd{i}.png')
    gaze().save(HERE / 'tok5a' / 'img' / 'd_gaze.png')
    beach(False).save(HERE / 'tok5b' / 'img' / 'd_rip.png')
    beach(True).save(HERE / 'tok5b' / 'img' / 'd_escape.png')
    print('도해 11장')


if __name__ == '__main__':
    main()
