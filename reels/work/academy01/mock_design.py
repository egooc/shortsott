# 락키스북쉘프 설명회 영상 — 가로·세로 디자인 시안(정지 화면). 학원 정보 글 없이 로고·분위기만(소유주 10-19).
#   python mock_design.py   → mock_vertical.png · mock_horizontal_A.png · mock_horizontal_B.png
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = 'D:/midform/reels'
F_HEAD = f'{ROOT}/assets/fonts/Jua-Regular.ttf'
F_SUB = f'{ROOT}/assets/fonts/GmarketSansMedium.otf'
F_BOLD = f'{ROOT}/assets/fonts/GmarketSansBold.otf'
YEL, INK, CREAM, WHITE = (255, 210, 63), (30, 28, 26), (255, 248, 231), (255, 255, 255)

frame = Image.open(f'{ROOT}/work/academy01/frame_010.png').convert('RGB')   # 좌우 반전 바로잡은 프레임


def logo(h):
    im = Image.open(f'{ROOT}/ref/rockys/p01.jpg').convert('RGB')
    a = np.asarray(im).astype(int)
    alpha = np.clip((765 - a.sum(2)) * 3, 0, 255).astype(np.uint8)   # 흰 바탕 → 투명
    im = im.convert('RGBA'); im.putalpha(Image.fromarray(alpha))
    im = im.crop(im.getbbox())
    return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)


def rr(d, box, r, fill, outline=None, w=0):
    d.rounded_rectangle(box, r, fill=fill, outline=outline, width=w)


def font(p, s):
    return ImageFont.truetype(p, s)


def text_c(d, cx, y, s, f, fill):
    w = d.textlength(s, font=f)
    d.text((cx - w / 2, y), s, font=f, fill=fill)


def subtitle(d, cx, y, s, f, hl=None):
    """흰 둥근 상자 + 검정 글씨, 핵심 낱말은 노란 밑줄 형광."""
    w = d.textlength(s, font=f); h = f.size
    rr(d, (cx - w / 2 - 34, y - 22, cx + w / 2 + 34, y + h + 26), 22, WHITE + (240,))
    if hl:
        x0 = cx - w / 2 + d.textlength(s[:s.index(hl)], font=f)
        d.rectangle((x0 - 4, y + h * 0.55, x0 + d.textlength(hl, font=f) + 4, y + h + 6), fill=YEL)
    d.text((cx - w / 2, y), s, font=f, fill=INK)


def part_tag(d, x, y, s, f):
    w = d.textlength(s, font=f)
    rr(d, (x, y, x + w + 48, y + f.size + 30), (f.size + 30) // 2, YEL, INK, 4)
    d.text((x + 24, y + 13), s, font=f, fill=INK)


# ── 세로 1080x1920 ────────────────────────────────────────────
def vertical():
    im = frame.copy().convert('RGBA')
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    # 위쪽 로고 카드
    lg = logo(150)
    rr(d, (40, 48, 40 + lg.width + 44, 48 + 150 + 36), 28, WHITE + (235,), INK, 4)
    ov.alpha_composite(lg, (62, 66))
    part_tag(d, 40 + lg.width + 70, 96, '학부모 설명회 | 보강', font(F_HEAD, 46))
    # 핵심 한 줄 — 머리 위 빈 곳(얼굴·입을 가리지 않게)
    f_key = font(F_HEAD, 74)
    s = '보강, 제한 두지 않아요'
    w = d.textlength(s, font=f_key)
    rr(d, (540 - w / 2 - 40, 500, 540 + w / 2 + 40, 500 + 74 + 46), 30, YEL, INK, 5)
    text_c(d, 540, 518, s, f_key, INK)
    # 자막
    subtitle(d, 540, 1560, '못 배운 부분은 아이가 먼저 물어봐요', font(F_SUB, 50), hl='먼저 물어봐요')
    # 아래 문구
    text_c(d, 540, 1830, 'Read for Fun · Read to Think · Read to Learn', font(F_BOLD, 28), WHITE)
    im.alpha_composite(ov)
    im.convert('RGB').save(f'{ROOT}/work/academy01/mock_vertical.png')


# ── 가로 A: 왼쪽 글 판 + 오른쪽 세로 영상 ──────────────────────
def horizontal_a():
    im = Image.new('RGBA', (1920, 1080), CREAM + (255,)); d = ImageDraw.Draw(im)
    # 바닥 노란 띠(학원 계단·의자 노랑)
    d.rectangle((0, 1000, 1920, 1080), fill=YEL)
    vid = frame.resize((540, 960), Image.LANCZOS)
    vx, vy = 1920 - 540 - 120, 40
    rr(d, (vx - 10, vy - 10, vx + 550, vy + 970), 34, INK)
    mask = Image.new('L', vid.size, 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, 540, 960), 26, fill=255)
    im.paste(vid, (vx, vy), mask)
    lg = logo(170)
    im.alpha_composite(lg, (120, 70))
    part_tag(d, 120 + lg.width + 40, 120, '학부모 설명회 | 보강', font(F_HEAD, 44))
    d.text((120, 300), '보강에 제한을', font=font(F_HEAD, 104), fill=INK)
    d.text((120, 420), '두지 않는 이유', font=font(F_HEAD, 104), fill=INK)
    d.rectangle((120, 520, 120 + 560, 540), fill=YEL)
    pts = ['휴강하면 당연히 보강', '기한·사유 따지지 않아요', '놓친 진도는 아이가 먼저 물어요']
    f_pt = font(F_BOLD, 40)
    for i, p in enumerate(pts):
        y = 600 + i * 92
        on = i == 2
        rr(d, (120, y, 960, y + 72), 36, YEL if on else WHITE, INK, 3)
        d.ellipse((136, y + 12, 184, y + 60), fill=INK)
        text_c(d, 160, y + 18, str(i + 1), font(F_BOLD, 32), YEL if on else WHITE)
        d.text((206, y + 18), p, font=f_pt, fill=INK)
    subtitle(d, 600, 912, '못 배운 부분은 아이가 먼저 물어봐요', font(F_SUB, 46), hl='먼저 물어봐요')
    im.convert('RGB').save(f'{ROOT}/work/academy01/mock_horizontal_A.png')


# ── 가로 B: 가운데 영상 + 양옆 흐린 학원 화면 ───────────────────
def horizontal_b():
    bg = frame.resize((1920, round(1920 * 1920 / 1080)), Image.LANCZOS).crop((0, 300, 1920, 1380))
    bg = bg.filter(ImageFilter.GaussianBlur(40)).convert('RGBA')
    bg.alpha_composite(Image.new('RGBA', bg.size, CREAM + (150,)))
    d = ImageDraw.Draw(bg)
    vid = frame.resize((608, 1080), Image.LANCZOS)
    bg.paste(vid, (656, 0))
    d.rectangle((650, 0, 656, 1080), fill=YEL); d.rectangle((1264, 0, 1270, 1080), fill=YEL)
    lg = logo(150)
    rr(d, (60, 50, 60 + lg.width + 40, 50 + 150 + 36), 28, WHITE, INK, 4)
    bg.alpha_composite(lg, (80, 68))
    part_tag(d, 60, 270, '학부모 설명회 | 보강', font(F_HEAD, 42))
    d.text((60, 360), '보강,', font=font(F_HEAD, 84), fill=INK)
    d.text((60, 456), '제한 두지', font=font(F_HEAD, 84), fill=INK)
    d.text((60, 552), '않아요', font=font(F_HEAD, 84), fill=INK)
    d.rectangle((60, 650, 400, 664), fill=YEL)
    subtitle(d, 960, 930, '못 배운 부분은 아이가 먼저 물어봐요', font(F_SUB, 48), hl='먼저 물어봐요')
    bg.convert('RGB').save(f'{ROOT}/work/academy01/mock_horizontal_B.png')


vertical(); horizontal_a(); horizontal_b()
print('ok')
