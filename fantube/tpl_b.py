"""팬튜브 B 틀 — 커뮤니티 글 + 베스트 댓글 (10/19 소유주 «추천대로»).
    python fantube/tpl_b.py <spec.json>            → spec 의 out (기본 <spec 폴더>/out.mp4)

화면(1080x1920): 위 흰 판(작은 «HOT · 그룹» + 굵은 제목 두 줄 + 출처 한 줄) · 가운데 영상(1080x1150) ·
영상 아래쪽 우리 자막 · 맨 아래 베스트 댓글 카드(원본에 실제로 달린 댓글만, 좋아요 수 그대로, 아이디 없음).
spec:
  sources: {"A": {"path": ".../h8_2930.mp4", "base": 1770}}   base = 그 파일 0초의 원본 시각
  segs:    [{"src": "A", "a": 1807.7, "b": 1810.1, "cw": 860, "x": 520, "y": 20}]  a·b 원본 시각, 창 cw x (cw/0.939) — 방송 자막·로고 밖으로
  top:     {"tag": "HOT · 엔믹스", "l1": "...", "l2": "...", "credit": "영상: ..."}
  caps:    [{"t0": 0, "t1": 2.4, "text": "...", "style": "say|pop|en"}]    출력 시각 (en = 영어 한 줄, 한국어 자막 아래)
  comments:[{"t0": 0, "t1": 7.4, "likes": 870, "text": "..."}]          출력 시각, 줄바꿈은 \\n
"""
import json
import re
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
VY, VH = 320, 1150                       # 영상 칸
FONT = 'D:/midform/politics-hour/assets/fonts/'
BOLD, BODY = FONT + 'Paperlogy-8ExtraBold.ttf', FONT + 'ROKAFSansMedium.ttf'
FULL = 'C:/Windows/Fonts/malgunbd.ttf'   # 완성형 11,172자 전부 — 남의 댓글(«왤케»·«이넼» 등 Paperlogy·어그로체에 없는 글자)은 이걸로
BG, PINK = (245, 246, 248), (255, 90, 120)
FPS = 30
# 레인별 스킨(10/27 소유주 «다른 사람인 척» — 같은 틀에 색만 바꾸면 «페어»): 글꼴·배치·카드 모양이 다르다. spec.skin 으로 고른다.
REELS = 'D:/midform/reels/assets/fonts/'
SKINS = {
    'b': dict(bold=BOLD, body=BODY, label=BODY, bg=BG, accent=PINK, panel='white', rule=None, title_fill='black', title_size=60, align='left',
              card_fill='white', card_outline=None, card_radius=26, card_label='BEST  ♥ {likes:,}'),
    'gwamol': dict(bold=REELS + 'Jua-Regular.ttf', body=REELS + 'GmarketSansMedium.otf', label=REELS + 'GmarketSansBold.otf',
                   bg=(255, 246, 229), accent=(232, 118, 42), panel=(255, 246, 229), rule=(45, 32, 22), title_fill=(45, 32, 22), title_size=66, align='center',
                   card_fill=(255, 252, 246), card_outline=(45, 32, 22), card_radius=14, card_label='댓글 ♥ {likes:,}'),
}
SK = SKINS['b']
# 결 틀(10/28 소유주 «틀 바꿔», GUIDE_KYUL_JJYUK §8): spec.style == 'claim'. 제목은 전제(작게)/펀치(크게) 2줄, 자막 화자는 팬(quote·paren·note·end·label), 9~15초.
# 레인마다 틀의 종류가 다르다 — yoon: 띠 없이 영상 전체 + 상단 어두운 그라데이션 위 고딕 / james: 크림 띠 + 둥근 글꼴. 색만 다른 게 아니라 구조가 다르다.
CLAIM = {
    'yoon': dict(mode='overlay', band=0, l1_font=REELS + 'GmarketSansMedium.otf', l1_size=50, l1_fill=(235, 240, 250), l1_y=118,
                 l2_font=REELS + 'GmarketSansBold.otf', l2_size=82, l2_fill=(160, 210, 255), l2_y=186,
                 cap_font=REELS + 'GmarketSansBold.otf', cap_fill='white', cap_stroke=(10, 18, 36), hl=(160, 210, 255), end_fill=(160, 210, 255),
                 note_fill=(225, 232, 245), label_bg=(10, 26, 51), label_fg='white', flash=(200, 30, 40)),
    'james': dict(mode='band', band=400, band_fill=(255, 246, 229), l1_font=REELS + 'GmarketSansMedium.otf', l1_size=44, l1_fill=(120, 95, 70), l1_y=118,
                  l2_font=REELS + 'Jua-Regular.ttf', l2_size=88, l2_fill=(232, 118, 42), l2_y=190,
                  cap_font=REELS + 'Jua-Regular.ttf', cap_fill='white', cap_stroke=(45, 32, 22), hl=(255, 190, 70), end_fill=(255, 214, 120),
                  note_fill=(255, 240, 200), label_bg=(45, 32, 22), label_fg=(255, 246, 229), flash=(232, 118, 42)),
}
CK = None


def f(p, s):
    return ImageFont.truetype(p, s)


def _glyph(ft, c):
    im = Image.new('L', (80, 80), 0)
    ImageDraw.Draw(im).text((10, 10), c, font=ft, fill=255)
    return im.tobytes()


def pick(text, preferred):
    """글꼴에 없는 글자가 있으면 그 줄만 malgunbd 로. 빈 칸으로 찍히는 글자(«왤»)와 □(notdef, Jua 의 «…»)를 둘 다 잡는다 — 10/28 시험편 «…»→□ 사고."""
    ft = f(preferred, 40)
    notdef = _glyph(ft, '')
    for c in text:
        if c.isspace():
            continue
        g = _glyph(ft, c)
        if ft.getmask(c).getbbox() is None or g == notdef:
            return FULL
    return preferred


def draw_hl(d, cx, y, text, font_path, size, fill, hl, hl_fill, stroke, sw):
    """한 줄을 가운데 맞춰 그리되 hl 낱말만 다른 색(쮸뀨미 «강!»·«39°C» 식 강조)."""
    ft = f(pick(text, font_path), size)
    parts = [text] if not hl or hl not in text else [text[:text.index(hl)], hl, text[text.index(hl) + len(hl):]]
    widths = [d.textlength(p, font=ft) for p in parts]
    x = cx - sum(widths) / 2
    for p, w in zip(parts, widths):
        d.text((x, y), p, font=ft, fill=hl_fill if (hl and p == hl) else fill, stroke_width=sw, stroke_fill=stroke, anchor='lm')
        x += w


def claim_title_png(top, out):
    """결 틀 제목: 전제(작게) / 펀치(크게). yoon 은 영상 위에 얹는 투명 PNG(상단 어두운 그라데이션), james 는 띠."""
    C = CK
    if C['mode'] == 'band':
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, W, C['band']), fill=C['band_fill'] + (255,))
    else:
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for y in range(0, 460):                       # 위 0 → 460px 어두움 0.82 → 0
            a = int(210 * (1 - y / 460) ** 1.4)
            d.line((0, y, W, y), fill=(6, 10, 20, a))
    for key in ('l1', 'l2'):
        tx = top.get(key) or ''
        if not tx:
            continue
        fp, size = pick(tx, C[key + '_font']), C[key + '_size']
        while size > 40 and d.textlength(tx, font=f(fp, size)) > W - 70:   # 폭에 안 들어가면 줄인다(10/28 n10 펀치 줄 잘림)
            size -= 2
        d.text((W // 2, C[key + '_y']), tx, font=f(fp, size), fill=C[key + '_fill'], anchor='mm')
    im.save(out)


def claim_cap_png(c, out):
    """팬 화자 자막. style: quote(따옴표 대사) · paren(괄호 반응) · note(대괄호 상황) · end(끝 한마디) · label(이름 라벨 x,y) · list(번호 목록 한 줄).
    공통: 흰 글씨 + 어두운 외곽, 위치는 영상 세로 61~71%(바닥 아님). c.hl 낱말만 강조색. c.y 로 위치 덮어쓰기(0~1 비율)."""
    C = CK
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    st = c.get('style', 'quote')
    tx = c['text']
    if st == 'label':
        ft = f(pick(tx, C['cap_font']), 34)
        tw = d.textlength(tx, font=ft)
        x, y = int(c['x']), VY + int(c['y'])
        d.rounded_rectangle((x - tw / 2 - 14, y - 26, x + tw / 2 + 14, y + 26), 8, fill=C['label_bg'] + (230,))
        d.text((x, y), tx, font=ft, fill=C['label_fg'], anchor='mm')
        im.save(out)
        return
    if st == 'quote':
        if not tx.startswith(('"', '“')):
            tx = f'"{tx}"'
        size, fill, yr = 58, C['cap_fill'], 0.66
    elif st == 'paren':
        if not tx.startswith('('):
            tx = f'({tx})'
        size, fill, yr = 52, C['cap_fill'], 0.66
    elif st == 'note':
        if not tx.startswith('['):
            tx = f'[{tx}]'
        size, fill, yr = 42, C['note_fill'], 0.71
    elif st == 'end':
        size, fill, yr = 62, C['end_fill'], 0.63
    elif st == 'list':
        size, fill, yr = 40, C['note_fill'], 0.06
    else:
        raise SystemExit(f'결 틀 자막 style 모름: {st}')
    yr = c.get('y', yr)
    lines = tx.split('\n')
    for i, ln in enumerate(lines):
        y = VY + VH * yr + (i - (len(lines) - 1) / 2) * (size + 12)
        draw_hl(d, W // 2, y, ln, C['cap_font'], size, fill, c.get('hl'), C['hl'], C['cap_stroke'], 7 if st != 'note' else 5)
    im.save(out)


def trans_card_png(c, out):
    """번역 카드(10/29 소유주 결정, 코르티스 레인): 실제 영어 댓글 원문(작게, 회색) + 뜻만 옮긴 번역(크게) + 왼쪽 위 «댓글 ♥ n» + 오른쪽 위 «번역» 표시.
    위치는 영상 세로 c.y(기본 0.62) 가운데 — 같은 시각에 팬 자막을 겹치지 않게 둔다. 줄바꿈은 \\n 으로 직접."""
    C = CK
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 이모지(글꼴에 없어 □로 찍힘)는 카드에서만 뺀다 — spec.orig 는 원문 그대로 두어도 된다
    orig = [re.sub(r'[\U0001F000-\U0001FAFF☀-➿️‍]+', '', ln).rstrip() for ln in c['orig'].split('\n')]
    tr = c['text'].split('\n')
    ft_o = f(REELS + 'GmarketSansMedium.otf', 34)
    ft_t = f(pick(c['text'], C['cap_font']), 50)
    ft_l = f(REELS + 'GmarketSansBold.otf', 30)
    pad, x0, x1 = 34, 60, W - 60
    for ln in orig:
        if d.textlength(ln, font=ft_o) > x1 - x0 - 2 * pad:
            raise SystemExit(f'번역 카드 원문 줄이 카드보다 길다 — \\n 으로 나눠라: «{ln}»')
    for ln in tr:
        if d.textlength(ln, font=ft_t) > x1 - x0 - 2 * pad:
            raise SystemExit(f'번역 카드 번역 줄이 카드보다 길다 — \\n 으로 나눠라: «{ln}»')
    h = pad + 44 + 12 + 44 * len(orig) + 14 + 60 * len(tr) + pad
    yc = VY + VH * c.get('y', 0.62)
    y0 = int(yc - h / 2)
    d.rounded_rectangle((x0, y0, x1, y0 + h), 22, fill=(255, 252, 246, 242), outline=C['label_bg'], width=3)
    d.text((x0 + pad, y0 + pad + 22), f"댓글 ♥ {int(c.get('likes', 0)):,}", font=ft_l, fill=C['label_bg'], anchor='lm')
    bw = d.textlength('번역', font=ft_l) + 28
    d.rounded_rectangle((x1 - pad - bw, y0 + pad, x1 - pad, y0 + pad + 44), 10, fill=C['label_bg'])
    d.text((x1 - pad - bw / 2, y0 + pad + 22), '번역', font=ft_l, fill=C['label_fg'], anchor='mm')
    y = y0 + pad + 44 + 12
    for ln in orig:
        d.text((x0 + pad, y + 22), ln, font=ft_o, fill=(120, 110, 100), anchor='lm')
        y += 44
    y += 14
    for ln in tr:
        d.text((x0 + pad, y + 30), ln, font=ft_t, fill=C['label_bg'], anchor='lm')
        y += 60
    im.save(out)


def flash_png(out):
    C = CK
    Image.new('RGBA', (W, H), C['flash'] + (150,)).save(out)


def check(text, path):
    """글꼴에 없는 글자가 빈칸으로 찍히는 걸 막는다(ep17 «왤» 사고)."""
    ft = f(path, 40)
    miss = sorted({c for c in text if not c.isspace() and ft.getmask(c).getbbox() is None})
    if miss:
        raise SystemExit(f'글꼴 {Path(path).name} 에 없는 글자 {miss}: «{text}»')


def base_png(top, out):
    im = Image.new('RGB', (W, H), SK['bg'])
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, VY - 20), fill=SK['panel'])
    if SK['rule']:
        d.rectangle((0, VY - 24, W, VY - 20), fill=SK['rule'])
    check(top['l1'] + top['l2'], SK['bold'])
    ts = SK['title_size']
    if SK['align'] == 'center':
        d.text((W // 2, 50), top['tag'], font=f(SK['body'], 30), fill=SK['accent'], anchor='ma')
        d.text((W // 2, 104), top['l1'], font=f(SK['bold'], ts), fill=SK['title_fill'], anchor='ma')
        d.text((W // 2, 190), top['l2'], font=f(SK['bold'], ts), fill=SK['title_fill'], anchor='ma')
        if top.get('credit'):
            d.text((W // 2, VY - 58), top['credit'], font=f(SK['body'], 24), fill=(140, 130, 120), anchor='ma')
    else:
        d.text((60, 52), top['tag'], font=f(SK['body'], 32), fill=SK['accent'])
        if top.get('credit'):
            d.text((W - 60, 56), top['credit'], font=f(SK['body'], 26), fill=(150, 150, 150), anchor='ra')
        d.text((60, 112), top['l1'], font=f(SK['bold'], ts), fill=SK['title_fill'])
        d.text((60, 196), top['l2'], font=f(SK['bold'], ts), fill=SK['title_fill'])
    im.save(out)


def comment_png(c, out, off=30):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lines = c['text'].split('\n')
    y0 = VY + VH + off                               # spec.comment_y_offset — 'under' 자막과 겹치지 않게 내린다(v2 190)
    h = 100 + 58 * len(lines)
    d.rounded_rectangle((40, y0, W - 40, y0 + h), SK['card_radius'], fill=SK['card_fill'], outline=SK['card_outline'], width=3 if SK['card_outline'] else 0)
    d.text((80, y0 + 28), SK['card_label'].format(likes=c['likes']), font=f(SK['label'], 30), fill=SK['accent'])
    for i, ln in enumerate(lines):
        check(ln, FULL)
        if d.textlength(ln, font=f(FULL, 40)) > W - 160:          # 카드 밖으로 넘치면 멈춘다(ep19 «ㅋㅋㅋ» 넘침)
            raise SystemExit(f'댓글 줄이 카드보다 길다 — \n 으로 나눠라: «{ln}»')
        d.text((80, y0 + 82 + 58 * i), ln, font=f(FULL, 40), fill='black')
    im.save(out)


def cap_png(c, out):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    check(c['text'], BOLD)
    if c.get('style') == 'tts':                      # 해설 한 줄 — 영상 위쪽 검은 말풍선
        ft = f(BOLD, 52)
        lines = c['text'].split('\n')
        tw = max(d.textlength(ln, font=ft) for ln in lines)
        d.rounded_rectangle((W / 2 - tw / 2 - 34, VY + 50, W / 2 + tw / 2 + 34, VY + 50 + 40 + 66 * len(lines)), 24, fill=(20, 20, 20, 235))
        for i, ln in enumerate(lines):
            d.text((W // 2, VY + 50 + 20 + 33 + 66 * i), ln, font=ft, fill=(255, 225, 60), anchor='mm')
        im.save(out)
        return
    if c.get('style') == 'under':                    # v2(10/22 소유주 «재미없다»): 레퍼런스식 이야기 한 줄 — 영상 아래 여백에 검은 글씨, 작게
        for i, ln in enumerate(c['text'].split('\n')):
            d.text((W // 2, VY + VH + 72 + 60 * i), ln, font=f(SK['bold'], 46), fill=SK['title_fill'], anchor='mm')
        im.save(out)
        return
    if c.get('style') == 'aside':                    # v2: 작은 혼잣말 «(…)» — 영상 안 아래쪽, 흰 글씨 한 줄
        d.text((W // 2, VY + VH - 70), c['text'], font=f(BOLD, 42), fill='white', stroke_width=5, stroke_fill='black', anchor='mm')
        im.save(out)
        return
    if c.get('style') == 'en':                       # 영어 자막 한 줄(G22 ⑥ 교육적 가치) — 한국어 자막 아래 작게
        d.text((W // 2, VY + VH - 34), c['text'], font=f(BOLD, 44), fill=(210, 230, 255), stroke_width=6, stroke_fill='black', anchor='mm')
        im.save(out)
        return
    size, col = (74, (255, 225, 60)) if c.get('style') == 'pop' else (62, 'white')
    y = VY + VH - 110
    for i, ln in enumerate(c['text'].split('\n')[::-1]):
        d.text((W // 2, y - i * (size + 14)), ln, font=f(BOLD, size), fill=col, stroke_width=8, stroke_fill='black', anchor='mm')
    im.save(out)


def main(spec_path):
    sp = Path(spec_path)
    s = json.loads(sp.read_text(encoding='utf-8'))
    global SK, CK, VY, VH
    SK = SKINS.get(s.get('skin', 'b'), SKINS['b'])   # 결 틀 스킨(yoon·james)은 CLAIM 표에 있다
    claim = s.get('style') == 'claim'
    work = sp.parent / '_tplb'
    work.mkdir(exist_ok=True)
    out = Path(s.get('out') or sp.parent / 'out.mp4')
    late = []                                        # 영상 위에 늘 얹는 층(결 틀 제목)
    if claim:
        CK = CLAIM[s.get('skin', 'yoon')]
        VY, VH = CK['band'], H - CK['band']          # 띠 아래 전체가 영상(9:16 크롭) — 카드 칸 없음
        Image.new('RGB', (W, H), CK.get('band_fill', (0, 0, 0))).save(work / 'base.png')
        claim_title_png(s['top'], work / 'title.png')
        late.append(work / 'title.png')
    else:
        base_png(s['top'], work / 'base.png')
    srcs = list(s['sources'])
    args = ['ffmpeg', '-v', 'error', '-y']
    for k in srcs:
        args += ['-i', s['sources'][k]['path']]
    args += ['-loop', '1', '-framerate', str(FPS), '-i', str(work / 'base.png')]
    over = []
    total0 = sum(g['b'] - g['a'] for g in s['segs'])
    for p in late:
        over.append((p, 0, total0 + 1))
    for i, c in enumerate(s.get('comments') or []):
        if claim:
            # 10/29 소유주 «번역 카드(추천대로)»: 결 틀에서 카드는 실제 영어 댓글의 번역 카드 1장만(orig 영어 원문 + text 번역 + translated=true), 구석에 «번역» 표시.
            if not (c.get('translated') and c.get('orig')):
                raise SystemExit('결 틀(style=claim)은 댓글 카드 칸이 없다 — 번역 카드(orig 영어 원문·translated=true)만 1장, 나머지는 끝 한마디(caps style=end)로')
            if i >= 1:
                raise SystemExit('결 틀 번역 카드는 1장까지')
            trans_card_png(c, work / f'c{i}.png')
        else:
            comment_png(c, work / f'c{i}.png', s.get('comment_y_offset', 30))
        over.append((work / f'c{i}.png', c['t0'], c['t1']))
    if claim:                                        # 같은 시각의 따옴표 대사 + 괄호 반응은 한 줄에 겹치므로 괄호를 한 단 아래(0.73)로 — 10/28 n11
        for c in s['caps']:
            if c.get('style') == 'paren' and 'y' not in c and any(q.get('style') == 'quote' and abs(q['t0'] - c['t0']) < 0.05 for q in s['caps']):
                c['y'] = 0.73
    for i, c in enumerate(s['caps']):
        (claim_cap_png if claim else cap_png)(c, work / f'k{i}.png')
        over.append((work / f'k{i}.png', c['t0'], c['t1']))
    for i, t in enumerate(s.get('flash') or []):     # 전환 순간 플래시 1~2프레임(쮸뀨미 2,279만 편 «놀림→걱정» 지점)
        flash_png(work / f'fl{i}.png')
        over.append((work / f'fl{i}.png', t, t + 0.08))
    voices = []                                      # 중간 TTS 한 줄(PDF 규칙 7) — 정치 롱폼 Supertonic F2 를 그대로 import
    if s.get('voice'):
        sys.path.insert(0, 'D:/midform/politics-hour/overlay')
        import tts
        for i, v in enumerate(s['voice']):
            wav = work / f'tts{i}.wav'
            tts.supertonic(v['text'], wav)
            dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(wav)],
                                       capture_output=True, text=True).stdout)
            voices.append((wav, v['t0'], v['t0'] + dur))
            c = {'text': v.get('show', v['text']), 'style': 'tts'}
            cap_png(c, work / f'kt{i}.png')
            over.append((work / f'kt{i}.png', v['t0'], v['t0'] + dur))
    for p, _, _ in over:
        args += ['-loop', '1', '-framerate', str(FPS), '-i', str(p)]
    for wav, _, _ in voices:
        args += ['-i', str(wav)]

    fc, vs, as_ = [], [], []
    for i, g in enumerate(s['segs']):
        src = s['sources'][g['src']]
        ii = srcs.index(g['src'])
        a, b = g['a'] - src['base'], g['b'] - src['base']
        cw = g['cw'] // 2 * 2
        ch = round(cw * VH / W) // 2 * 2
        if g.get('fit') and s.get('style') == 'claim':
            raise SystemExit('결 틀(style=claim)은 가로 통짜(fit) 금지 — 레퍼런스 24편 전부 9:16 크롭, cw·x 를 얼굴 쪽으로 좁혀라')
        if g.get('fit'):                             # 10/27 원본 자막형: 자막이 창보다 넓은 컷은 가로 전체를 1080 폭에 맞추고 위아래는 같은 그림을 흐리게 깔아 채운다
            fc.append(f"[{ii}:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS,fps={FPS},split=2[f{i}a][f{i}b]")
            fc.append(f"[f{i}a]scale={W}:{VH}:force_original_aspect_ratio=increase,crop={W}:{VH},gblur=sigma=40,eq=brightness=-0.12:saturation=0.8[bg{i}]")
            fc.append(f"[f{i}b]scale={W}:-2[fg{i}]")
            fc.append(f"[bg{i}][fg{i}]overlay=0:(H-h)/2,setsar=1[v{i}]")
        else:
            fc.append(f"[{ii}:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS,fps={FPS},crop={cw}:{ch}:{g['x']}:{g['y']},scale={W}:{VH},setsar=1[v{i}]")
        d = b - a
        fc.append(f"[{ii}:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.03,afade=t=out:st={d - 0.04:.3f}:d=0.04[a{i}]")
        vs.append(f'[v{i}]')
        as_.append(f'[a{i}]')
    n = len(s['segs'])
    total = sum(g['b'] - g['a'] for g in s['segs'])
    fc.append(''.join(v + a for v, a in zip(vs, as_)) + f'concat=n={n}:v=1:a=1[vc][ac0]')
    bi = len(srcs)
    if voices:                                       # 해설 동안 원음 25%로 낮추고 섞는다
        duck = '+'.join(f'between(t,{a:.2f},{b:.2f})' for _, a, b in voices)
        fc.append(f"[ac0]volume='if({duck},0.25,1)':eval=frame[ad]")
        vi = bi + 1 + len(over)
        for k, (_, a, _) in enumerate(voices):
            fc.append(f"[{vi + k}:a]aresample=48000,volume=1.6,adelay={int(a * 1000)}:all=1[vv{k}]")
        fc.append('[ad]' + ''.join(f'[vv{k}]' for k in range(len(voices))) + f'amix=inputs={1 + len(voices)}:normalize=0:duration=first[am]')
        fc.append(f"[am]afade=t=out:st={total - 0.4:.3f}:d=0.4[ac]")
    else:
        fc.append(f"[ac0]afade=t=out:st={total - 0.4:.3f}:d=0.4[ac]")
    fc.append(f'[{bi}:v][vc]overlay=0:{VY}:shortest=1[o0]')
    for j, (_, t0, t1) in enumerate(over):
        fc.append(f"[o{j}][{bi + 1 + j}:v]overlay=0:0:enable='between(t,{t0},{t1})':shortest=1[o{j + 1}]")
    args += ['-filter_complex', ';'.join(fc), '-map', f'[o{len(over)}]', '-map', '[ac]', '-t', f'{total:.3f}',
             '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
             '-movflags', '+faststart', str(out)]
    subprocess.run(args, check=True)
    sys.path.insert(0, 'D:/midform/scripts')       # -14 LUFS 2패스(도구개발 공용, 10/19) — 영상은 복사, 이미 맞으면 그대로
    import loudnorm_final
    loudnorm_final.normalize(str(out))
    # 효과음 선택(도구개발 variety_fx cd40ad7, 10/29): spec.sfx = {"rel": -18, "turn": "whoosh.short", "end": "pop"} 일 때만.
    # 그래픽·줌 없이(--sfx-only, 영상 복사) 전환 플래시 지점 1곳 + 끝 한마디 0~1곳, 그 자리 원음 대비 rel dB, 끝나면 -14 LUFS 재정규화. 기본 끔.
    sfx = s.get('sfx')
    if sfx:
        import shutil
        plan = [{'t': t, 'kind': 'sfx', 'sfx': sfx.get('turn', 'whoosh.short')} for t in (s.get('flash') or [])[:1]]
        end = [c for c in s['caps'] if c.get('style') == 'end']
        if end and sfx.get('end', 'pop'):
            plan.append({'t': end[0]['t0'], 'kind': 'sfx', 'sfx': sfx.get('end', 'pop')})
        pj = work / 'sfx_plan.json'
        pj.write_text(json.dumps(plan, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        nosfx = out.with_name(out.stem + '_nosfx' + out.suffix)
        shutil.copyfile(out, nosfx)
        subprocess.run([sys.executable, '-X', 'utf8', 'D:/midform/scripts/variety_fx.py', str(nosfx), str(pj), '--plan', str(pj),
                        '--sfx-only', '--rel', str(sfx.get('rel', -18)), '--out', str(out)], check=True)
        loudnorm_final.normalize(str(out))
        print(f'효과음 {len(plan)}개(원음 대비 {sfx.get("rel", -18)} dB) · 효과음 없는 판 {nosfx.name}')
    print(f'{out} · {total:.1f}초 · 컷 {n}개')


if __name__ == '__main__':
    main(sys.argv[1])
