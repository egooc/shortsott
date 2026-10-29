# -*- coding: utf-8 -*-
"""릴레이 쇼츠 렌더 — 같은 날 여러 토크쇼·라디오에서 같은 주제를 말한 3~5명을 문장 단위로 잘라 한 사람 말처럼 잇는다.
(소유주 10-28 «토크쇼에서 같은 주제로 말한 거, 같은 날 여기저기 나온 것들 다 잘라서 똑같은 얘기를 하고 있잖아»,
 레퍼런스 refs/supercut — 민주로와 m5F3Dk_fgu8 45초 14.2만 회)

    D:/midform/.venv-vision/Scripts/python.exe politics-hour/shorts/relay_render.py <relay.json> [--sheet-only]

해설 음성 0 · 원음 100%. 화면(1080x1920) = 쟁점 브리핑 쇼츠 틀 그대로(briefing_render.py frame_html_close, 10/23 s1_ppaldae 실측):
  ★10-28 소유주 «왜 탬플릿이 또 바꼈어?» — 남색 바탕·연두 제목·2줄 자막·출처 줄을 걷고 기존 틀로 되돌렸다. 수치는 briefing_render 에서 import.
  검정 바탕 · 위 제목 2줄(윗줄 노랑 #F5C518·아랫줄 흰, 페이퍼로지 112px 이하, 0.3초 등장)
  가운데 얼굴 띠 1080x864(y 528~1392) — 컷마다 발언자 얼굴 클로즈업(short_prep.py 의 얼굴 창 계산을 그대로 import)
  말 자막 한 줄(가운데 y 1240, 58→44px, 화자마다 CAP_STYLES 색, 0.15초 팝) — Speechmatics 낱말 그대로(전사 부분 문자열), 욕설은 xx + 삐
  경력 꼬리표: 그 사람이 처음 나온 뒤 3초만(왼쪽 위) · 끝 1초 채널 마크. 출처는 설명란.
  사실 카드: 숫자·결정이 나오는 컷에서 3~4초 얼굴 띠를 덮는다(남색·노랑, 원 출처 기사로 확인한 문장만)
  ★10-29 소유주 «숏폼에도 예능편집넣고 · 훅 넣고» — 롱폼 몽타주 훅(overlay/hook_overlay.py, 시사썰전식)을 세로로:
  첫 3~4초 «몽타주 훅» = 본편 컷에서 가장 센 원음 한마디 3~4개(약 1초, 구마다 다른 얼굴, 당겨 잡기 1.34→1.22 + 천천히 밀기)
  + 팝업 스티커(?!·!!)·손글씨 속마음·1~2어절 강조 자막(*노랑*/#빨강#)·팝 효과음. 훅의 말은 본편에 그대로 다시 나온다(약속).
  본편 예능 편집 = fx 가 있는 컷(감정 한마디·전환·끝 한 방)에서 그 낱말에 펀치인 1.0→1.15(0.2초) + 스티커 또는 속마음 1개(1.6초) + 팝.
  장식 그림·효과음은 hook_overlay 의 세로용 함수(pil_sticker·pil_note·pil_caps·pop_sfx)를 그대로 쓴다(두 벌 두지 않는다).

relay.json = {
  "name": "kgh", "title": ["첫 줄(노랑)", "둘째 줄(흰)"], "hot": ["낱말"](선택 — 자막에서 튀게),
  "speakers": {"키": {"name": "장성철", "role": "YTN 라디오 진행자"}},
  "cuts": [{"src": "...mp4", "transcript": "...json", "in": 135.9, "out": 140.0, "who": "키",
            "show": "YTN 라디오 «장성철의 뉴스명당»", "date": "10.28", "x": [0, 0.5], "band_y": 0.72, "top_y": 0,
            "role": "hook|fact|turn|punch|body", "face": [x,y,w,h](손 지정, 선택),
            "fx": {"at": "낱말", "sticker": {"text": "!!", "x": 760, "y": 560, "rot": 8} | "note": {"text": "헉..", "x": 70, "y": 1060, "rot": -6}}(선택)}],
  "hook": [{"cut": 0, "say": "억울하다 억울해요"(그 컷 전사의 이어진 낱말 그대로), "caps": "*억울하다*"(say 의 부분 — *노랑* #빨강#),
            "sticker": {...}(선택), "note": {...}(선택)}](선택 — 첫 3~4초 몽타주 훅),
  "cards": [{"cut": 6, "offset": 0.0, "dur": 3.6, "head": "...", "lines": ["...", "..."], "src": "뉴시스 10.27"}],
}
★10-29 b_roll(소유주 «억울하다는 김건희가 한 말이잖아 … 목소리는 기자 목소리 그대로»): 훅 조각 "b_roll": {...}, 컷 "b_roll": [{"from","to",...}] —
  화면만 주제 인물 장면으로 덮고 소리는 원래 화자 원음. {"src","t","person","tag"(speakers 키, 전언이면 role 에 «전언»),"crop"|"x","face_x"}.
  전언 컷은 "quoted_person". relay.json "subject" = 주제 인물(relay_gate 가 훅·전언·본편 2회를 본다).
결과: <relay.json 폴더>/<name>.mp4 · <name>_sheet.jpg(1초 간격 프레임 시트) · <name>.render.json(컷·자막 지도, 관문이 읽는다).
렌더 락: politics-hour/RENDERING.lock 이 있으면 종료 4(롱폼 렌더 중). 없으면 잡고 끝나면 내 PID 것만 지운다.
"""
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, 'D:/midform/scripts')
import short_prep as SP            # noqa: E402  얼굴 찾기·창 계산(같은 수식을 두 벌 두지 않는다)
import profanity as PF             # noqa: E402
import briefing_render as BR       # noqa: E402  쇼츠 틀 수치(제목·자막 색·자막 위치·꼬리표)는 한 벌만
sys.path.insert(0, str(HERE.parent / 'overlay'))
import hook_overlay as HK          # noqa: E402  예능 장식(스티커·속마음·강조 자막·팝 소리)은 롱폼 훅 것 그대로

W, H, FPS = 1080, 1920, 30
Y0, Y1 = BR.CLOSE_Y0, BR.CLOSE_Y1   # 얼굴 띠 528~1392
BW, BH = 1080, 864
FONT = str(HERE.parent / 'assets' / 'fonts' / 'Paperlogy-8ExtraBold.ttf')
BODY = str(HERE.parent / 'assets' / 'fonts' / 'ROKAFSansMedium.ttf')


def rgb(c):
    if c.startswith('rgba'):
        r, g, b, a = [float(x) for x in c[5:-1].split(',')]
        return (int(r), int(g), int(b), int(round(a * 255)))
    c = c.lstrip('#')
    c = ''.join(ch * 2 for ch in c) if len(c) == 3 else c
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


YEL, RED, NAVY = rgb(BR.YEL), rgb(BR.RED), (26, 32, 54, 255)
FACE = 0.30                         # 얼굴 폭 / 화면 폭(레퍼런스는 30~40%)
CAP_UNITS = 19.5                    # 자막 한 줄 상한(한글 1·띄어쓰기 .3 — fit_size 44px 에서 860px)
CAP_MAX = 15                        # 자막 한 칸 목표 글자(띄어쓰기 뺀)
PAD_A = 0.012                       # 컷 경계 소리 페이드(딸깍 방지)
POP, TITLE_IN = 0.15, 0.3           # 자막 팝(1.14→1)·제목 등장(아래 24px·1.06배 → 제자리)
STK_IN, NOTE_IN, FX_HOLD = 0.22, 0.18, 1.6   # 스티커 튀어나옴(.2→1배, back.out)·속마음 떠오름·본편 장식 머무는 시간
HOOK_CAP_Y = BR.CLOSE_CAP_Y           # 훅 강조 자막 가운데 y(본편 자막 자리 그대로)


def font(p, n):
    return ImageFont.truetype(p, n)


def fit(d, text, path, big, small, maxw):
    for n in range(big, small - 1, -2):
        if d.textlength(text, font=font(path, n)) <= maxw:
            return n
    return small


# ---------- 컷 → 얼굴 띠 ----------
def band_clip(c, k, work, span=None, zoom=None, tag='c'):
    """span=(in, out) 을 주면 그 구간만(훅), zoom = zoompan z 식(on = 컷 안 프레임 번호) — 당겨 잡기·펀치인."""
    src = c['src']
    iw, ih = SP.probe(src)
    band = c.get('band_y', 0.82) * ih
    top = c.get('top_y', 0) * ih
    a, b = span or (c['in'], c['out'])
    if c.get('mode') == 'fit':
        vf = f'scale={BW}:-2,crop={BW}:{BH}'
        log = {'mode': 'fit'}
    else:
        if c.get('face'):
            x, y, w, h = map(float, c['face'])
            F = [x, y, w, h, y + h * 0.42]
        else:
            xr = c.get('x', [0, 1])
            F = SP.pick(SP.faces(src, a, b, iw), xr[0] * iw, xr[1] * iw)
            if not F:
                sys.exit(f'✗ 컷 {k}: 얼굴 없음 ({Path(src).name} {a}~{b})')
        xr = c.get('x', [0, 1])
        cr, why = SP.crop_for(F, BW, BH, FACE, xr[0] * iw, xr[1] * iw, ih, band, top)
        if not cr:
            cr, why = SP.crop_for(F, BW, BH, FACE, 0, iw, ih, band, top)
        if not cr:
            sys.exit(f'✗ 컷 {k}: {why}')
        vf = f'crop={cr[2]}:{cr[3]}:{cr[0]}:{cr[1]},scale={BW}:{BH}'
        if zoom:
            vf += f",zoompan=z='{zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={BW}x{BH}:fps={FPS}"
        log = {'mode': 'single', 'crop': [int(v) for v in cr], 'face_frac': round(float(F[2]) / cr[2], 3), 'upscale': round(BH / cr[3], 2),
               'face_cx': int((float(F[0]) + float(F[2]) / 2 - cr[0]) * BW / cr[2])}   # 띠 안 얼굴 가운데 x — 장식은 반대쪽에
    d = b - a
    out = work / f'{tag}{k:02d}.mp4'
    af = f'afade=t=in:d={PAD_A},afade=t=out:st={d - PAD_A:.3f}:d={PAD_A}'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{a:.3f}', '-i', src, '-t', f'{d:.3f}',
                    '-filter_complex', f'[0:v]fps={FPS},{vf},setsar=1[v];[0:a]aresample=48000,{af}[a]', '-map', '[v]', '-map', '[a]',
                    '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', str(out)], check=True)
    return out, log


def broll_clip(br, dur, key, work, zoom=None):
    """b_roll = 화면만 다른 소스로 덮기(소리는 원래 화자 원음 그대로) — 10-29 소유주 «억울하다는 김건희가 한 말이잖아. 김건희 얼굴이 나와야지».
    br = {"src", "t"(소스 시작 초), "person"(화면 속 인물), "tag"(꼬리표 speakers 키), "crop": [x,y,w,h](선택, 없으면 얼굴 찾기),
          "x": [0,1], "band_y": .8, "top_y": .07}. 얼굴 창 계산은 컷과 같은 band_clip."""
    c = {'src': br['src'], 'x': br.get('x', [0, 1]), 'band_y': br.get('band_y', 0.8), 'top_y': br.get('top_y', 0.07)}
    if br.get('face'):
        c['face'] = br['face']
    if br.get('crop'):
        x, y, w, h = br['crop']
        vf = f'crop={w}:{h}:{x}:{y},scale={BW}:{BH}'
        if zoom:
            vf += f",zoompan=z='{zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={BW}x{BH}:fps={FPS}"
        out = work / f'b{key}.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{br["t"]:.3f}', '-i', br['src'], '-t', f'{dur:.3f}', '-an',
                        '-vf', f'fps={FPS},{vf},setsar=1', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                        str(out)], check=True)
        fx = br.get('face_x', x + w / 2)
        return out, {'mode': 'b_roll', 'crop': [int(v) for v in br['crop']], 'face_cx': int((fx - x) * BW / w)}
    out, log = band_clip(c, 0, work, span=(br['t'], br['t'] + dur), zoom=zoom, tag=f'b{key}_')
    return out, {**log, 'mode': 'b_roll'}


def apply_broll(base, items, work, name):
    """base 클립 위에 b_roll 영상들을 [from, to) 동안 덮는다. 소리는 base 그대로."""
    if not items:
        return base
    ins, fc, last = ['-i', str(base)], '', '[0:v]'
    for i, (clip, a, b) in enumerate(items):
        ins += ['-i', str(clip)]
        fc += f'[{i + 1}:v]setpts=PTS-STARTPTS+{a:.3f}/TB[o{i}];{last}[o{i}]overlay=0:0:enable=\'between(t,{a:.3f},{b - .001:.3f})\':eof_action=pass[v{i}];'
        last = f'[v{i}]'
    out = work / f'{name}_br.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fc.rstrip(';'), '-map', last, '-map', '0:a',
                    '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', str(FPS), '-c:a', 'copy', str(out)],
                   check=True)
    return out


# ---------- 자막 ----------
def words_of(c):
    ws = json.loads(Path(c['transcript']).read_text(encoding='utf-8'))
    ws = ws if isinstance(ws, list) else ws['words']
    return [w for w in ws if c['in'] - .05 <= w[0] < c['out'] - .05]


def chunk(ws):
    """숨(0.7초+)에서 먼저 끊고, 긴 덩어리는 글자 수가 고르게 k칸으로 나눈다(«낙동강 / 오리알» 같은 고아 낱말 방지)."""
    runs, cur = [], []
    for w in ws:
        if cur and w[0] - cur[-1][1] > .7:
            runs.append(cur)
            cur = []
        cur.append(w)
    if cur:
        runs.append(cur)
    out = []
    for r in runs:
        tot = sum(len(x[2]) for x in r)
        k = max(1, -(-tot // CAP_MAX))
        tgt = tot / k                                   # 누적 글자 수가 tgt·j 에 가장 가까운 낱말 경계에서 끊는다
        cum, c = [], 0
        for w in r:
            c += len(w[2])
            cum.append(c)
        cuts = []
        for j in range(1, k):
            cuts.append(min(range(len(r) - 1), key=lambda i: abs(cum[i] - tgt * j)) + 1)
        edges = [0] + sorted(set(cuts)) + [len(r)]
        out += [r[edges[i]:edges[i + 1]] for i in range(len(edges) - 1) if edges[i] < edges[i + 1]]
    n = lambda xs: sum(len(x[2]) for x in xs)
    i = 1
    while i < len(out):                                # 숨 뒤 한 낱말(«모르겠는데»)은 앞 칸에 붙인다(한 줄에 들어갈 때만)
        if n(out[i]) <= 6 and units(' '.join(x[2] for x in out[i - 1] + out[i])) <= CAP_UNITS:
            out[i - 1] = out[i - 1] + out.pop(i)
        else:
            i += 1
    return out


def comp(im, layer, x, y):
    """화면 밖으로 나간 부분은 잘라서 alpha_composite(음수 좌표 허용)."""
    x, y = int(x), int(y)
    l, t = max(0, -x), max(0, -y)
    r, b = min(layer.width, im.width - x), min(layer.height, im.height - y)
    if r > l and b > t:
        im.alpha_composite(layer.crop((l, t, r, b)), (x + l, y + t))


def units(text):
    return sum(.3 if ch == ' ' else 1.0 for ch in text)


# ---------- 화면 그리기(briefing_render frame_html_close 를 PIL 로 — CSS 수치 그대로) ----------
def spaced(d, xy, text, f, fill, ls=0, anchor='mm'):
    """letter-spacing(px) 을 준 한 줄. xy 는 가운데."""
    ws = [d.textlength(ch, font=f) for ch in text]
    tw = sum(ws) + ls * (len(text) - 1)
    x = xy[0] - tw / 2
    for ch, w in zip(text, ws):
        d.text((x, xy[1]), ch, font=f, fill=fill, anchor='lm')
        x += w + ls
    return tw


def draw_title(im, plan, t):
    """#title: left/right 60 · top 200 · 높이 CLOSE_Y0-220 · 세로 가운데 · line-height 1.08 · letter-spacing -2 · l0 노랑 l1 흰.
    등장: 0.3초 동안 아래 24px·1.06배에서 제자리(줄마다 .08초 늦게, power3.out)."""
    lines = plan['title'][:2]
    sizes = [BR.fit_size(ln, 960, 112, 76) for ln in lines]
    lhs = [n * 1.08 for n in sizes]
    top = 200 + ((Y0 - 220) - sum(lhs)) / 2
    for i, ln in enumerate(lines):
        p = min(1.0, max(0.0, (t - i * .08) / TITLE_IN))
        e = 1 - (1 - p) ** 3
        dy, sc = 24 * (1 - e), 1 + .06 * (1 - e)
        n = sizes[i]
        cy = top + sum(lhs[:i]) + lhs[i] / 2
        layer = Image.new('RGBA', (W, int(lhs[i] * 1.4)), (0, 0, 0, 0))
        spaced(ImageDraw.Draw(layer), (W / 2, layer.height / 2), ln, font(FONT, n), YEL if i == 0 else (255, 255, 255, 255), ls=-2)
        if sc != 1:
            layer = layer.resize((int(W * sc), int(layer.height * sc)), Image.LANCZOS)
        comp(im, layer, W / 2 - layer.width / 2, cy + dy - layer.height / 2)


def draw_caption(im, cap, plan, t):
    """.cap: left 60 · width 890 · 가운데 y CLOSE_CAP_Y · 한 줄 · fit_size(860, 58, 44) · padding 6 20 10 · radius 8 · 팝 1.14→1(.15초)."""
    order = {k: i for i, k in enumerate(plan['speakers'])}
    fg, bg = BR.CAP_STYLES[order.get(cap['who'], 0) % len(BR.CAP_STYLES)]
    fg, bg = rgb(fg), rgb(bg)
    hot_fg = (255, 255, 255, 255) if fg == YEL else (RED if bg[:3] == (255, 255, 255) else YEL)
    hot = plan.get('hot', [])
    text = cap['text']
    n = BR.fit_size(text, 860, 58, 44)
    f = font(FONT, n)
    lay = Image.new('RGBA', (W + 400, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    tw = d.textlength(text, font=f)
    bw, bh = tw + 40, n * 1.15 + 16
    cx, cy = lay.width / 2, lay.height / 2
    d.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], radius=8, fill=bg)
    x = cx - tw / 2
    ty = cy - bh / 2 + 6 + n * 1.15 / 2
    for i, w in enumerate(text.split(' ')):
        s = w + (' ' if i < len(text.split(' ')) - 1 else '')
        d.text((x, ty), s, font=f, fill=hot_fg if any(h in w for h in hot) else fg, anchor='lm')
        x += d.textlength(s, font=f)
    p = min(1.0, max(0.0, (t - cap['t0']) / POP))
    sc = 1.14 - .14 * (1 - (1 - p) ** 2)              # back.out 근사
    if sc != 1:
        lay = lay.resize((int(lay.width * sc), int(lay.height * sc)), Image.LANCZOS)
    comp(im, lay, 60 + 890 / 2 - lay.width / 2, BR.CLOSE_CAP_Y - lay.height / 2)


def draw_tag(im, who, spk):
    """.tag: left 40 · top CLOSE_Y0+24 · 본문 글꼴 32 · padding 8 14 · radius 6 · 바탕 = 화자 색 · 테두리 3 노랑."""
    s = spk.get(who, {})
    lab = ' · '.join(x for x in (s.get('name'), s.get('role')) if x)
    if not lab:
        return
    d = ImageDraw.Draw(im)
    f = font(BODY, 32)
    tw = d.textlength(lab, font=f)
    x0, y0 = 40, Y0 + 24
    d.rounded_rectangle([x0, y0, x0 + tw + 28 + 6, y0 + 32 + 16 + 6], radius=6, fill=rgb(s.get('color', '#1a2036')), outline=YEL, width=3)
    d.text((x0 + 17, y0 + 3 + 8 + 16), lab, font=f, fill=(255, 255, 255), anchor='lm')


def draw_card(im, card):
    """사실 카드 — 롱폼 계열 남색 바탕·노랑 테두리·노랑 머리글."""
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = 60, Y0 + 40, W - 60, Y1 - 210      # 아래 자막 자리는 비운다
    d.rounded_rectangle([x0, y0, x1, y1], radius=26, fill=(26, 32, 54, 246), outline=YEL, width=8)
    d.rectangle([x0 + 40, y0 + 52, x0 + 52, y0 + 128], fill=YEL)
    n = fit(d, card['head'], FONT, 66, 44, x1 - x0 - 140)
    d.text((x0 + 76, y0 + 90), card['head'], font=font(FONT, n), fill=YEL, anchor='lm')
    y = y0 + 200
    for ln in card['lines']:
        big = ln.startswith('!')
        ln = ln.lstrip('!')
        n = fit(d, ln, FONT, 74 if big else 52, 36, x1 - x0 - 100)
        d.text((x0 + 50, y), ln, font=font(FONT, n), fill=YEL if big else (255, 255, 255), anchor='lm')
        y += n + 46
    d.text((x1 - 36, y1 - 40), card.get('src', ''), font=font(BODY, 26), fill=(170, 178, 196), anchor='rm')


def draw_mark(d):
    f = font(FONT, 30)
    tw = d.textlength('쟁점 브리핑', font=f)
    x1 = W - 140
    d.rectangle([x1 - tw - 38, Y0 + 24, x1, Y0 + 76], fill=NAVY)
    d.rectangle([x1 - tw - 38, Y0 + 24, x1 - tw - 32, Y0 + 76], fill=YEL)
    d.text((x1 - 16, Y0 + 50), '쟁점 브리핑', font=f, fill=(255, 255, 255), anchor='rm')


def draw_deco(im, dc, t):
    """스티커: .22초 동안 .2→1배(back.out)·기울기 -r→r, 뒤 .3초에 반 흔들. 속마음: .18초 동안 아래 14px 에서 떠오름."""
    p = min(1.0, max(0.0, (t - dc['t0']) / (STK_IN if dc['kind'] == 'sticker' else NOTE_IN)))
    if dc['kind'] == 'sticker':
        c1, c3 = 3.2 + 1, 3.2 + 2
        e = 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2      # back.out(3.2)
        sc, r = .2 + .8 * e, -dc['rot'] + 2 * dc['rot'] * e
        if t - dc['t0'] > .3:
            r = dc['rot'] - 1.5 * dc['rot'] * min(1.0, (t - dc['t0'] - .3) / .12)
        lay = HK.pil_sticker(dc['text'], dc['size'], r)
        if abs(sc - 1) > .01:
            lay = lay.resize((max(1, int(lay.width * sc)), max(1, int(lay.height * sc))), Image.LANCZOS)
        cx, cy = dc['x'] + dc['w'] / 2, dc['y'] + dc['h'] / 2
        comp(im, lay, cx - lay.width / 2, cy - lay.height / 2)
    else:
        e = 1 - (1 - p) ** 2
        lay = HK.pil_note(dc['text'], dc['size'], dc['rot'])
        if e < 1:
            lay.putalpha(lay.getchannel('A').point(lambda v: int(v * e)))
        comp(im, lay, dc['x'], dc['y'] + 14 * (1 - e))


def draw_hook_cap(im, hc, t):
    """훅 강조 자막(1~2어절, 어그로·테두리·*노랑*/#빨강#) — 1.25→1배 .1초."""
    lay = HK.pil_caps(hc['caps'], 118, 1000)
    p = min(1.0, max(0.0, (t - hc['t0']) / .1))
    sc = 1.25 - .25 * (1 - (1 - p) ** 2)
    if sc != 1:
        lay = lay.resize((int(lay.width * sc), int(lay.height * sc)), Image.LANCZOS)
    comp(im, lay, W / 2 - lay.width / 2, HOOK_CAP_Y - lay.height / 2)


def state_png(plan, t, segs, caps, total, tags, decos=(), hcaps=()):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw_title(im, plan, t)
    card = None
    for s in segs:
        for k in s.get('cards', []):
            if k['t0'] <= t < k['t1']:
                card = k
    if card:
        draw_card(im, card)
    tag = next((w for w, a, b in tags if a <= t < b), None)
    if tag and not card:
        draw_tag(im, tag, plan['speakers'])
    if not card:
        for dc in decos:
            if dc['t0'] <= t < dc['t1']:
                draw_deco(im, dc, t)
    hc = next((x for x in hcaps if x['t0'] <= t < x['t1']), None)
    if hc:
        draw_hook_cap(im, hc, t)
    cap = next((x for x in caps if x['t0'] <= t < x['t1']), None)
    if cap and not hc:
        draw_caption(im, cap, plan, t)
    if t >= total - 1.0:
        draw_mark(ImageDraw.Draw(im))
    return im


def main():
    pf = Path(sys.argv[1]).resolve()
    plan = json.loads(pf.read_text(encoding='utf-8'))
    name = plan['name']
    out_dir = pf.parent
    work = out_dir / f'_{name}'
    work.mkdir(exist_ok=True)
    lock = HERE.parent / 'RENDERING.lock'
    if lock.exists():
        print(f'[lock] RENDERING.lock 있음 — 다른 렌더 중: {lock.read_text(encoding="utf-8", errors="replace")[:200]}')
        sys.exit(4)
    lock.write_text(json.dumps({'label': f'정치 릴레이 쇼츠 {name}', 'pid': os.getpid(), 'started': time.strftime('%Y-%m-%d %H:%M')},
                               ensure_ascii=False) + '\n', encoding='utf-8')
    try:
        render(plan, out_dir, work, name)
    finally:
        try:
            if json.loads(lock.read_text(encoding='utf-8')).get('pid') == os.getpid():
                lock.unlink()
        except (OSError, ValueError):
            pass


def find_say(c, say):
    """컷 전사에서 say 와 똑같이 이어지는 낱말들 → (in, out, 낱말들). 앞뒤 낱말 소리를 물지 않게 숨 쪽으로만 조금 넓힌다."""
    ws = words_of(c)
    toks = say.split()
    for i in range(len(ws) - len(toks) + 1):
        if [w[2] for w in ws[i:i + len(toks)]] == toks:
            a = ws[i][0] - .04
            if i > 0:
                a = max(a, ws[i - 1][1] + .005)
            j = i + len(toks) - 1
            b = ws[j][1] + .1
            if j + 1 < len(ws):
                b = min(b, ws[j + 1][0] - .005)
            return max(a, c['in']), min(b, c['out']), ws[i:j + 1]
    sys.exit(f'✗ 훅 «{say}»: 컷 전사에 그 낱말들이 이어서 없다')


def deco_of(spec, kind, t0, t1, face_cx=None):
    """x 를 안 주면 얼굴 반대쪽 가장자리(얼굴을 가리지 않게). 왼쪽 위는 경력 꼬리표 자리라 왼쪽 스티커는 한 칸 내린다."""
    size = spec.get('size', 200 if kind == 'sticker' else 96)
    rot = spec.get('rot', 8 if kind == 'sticker' else -6)
    lay = HK.pil_sticker(spec['text'], size, rot) if kind == 'sticker' else HK.pil_note(spec['text'], size, rot)
    x, y = spec.get('x'), spec.get('y')
    left = face_cx is not None and face_cx >= W / 2
    if x is None:
        x = 50 if left else W - 50 - lay.width
    if y is None:
        y = (Y0 + 110 if left else Y0 + 50) if kind == 'sticker' else Y0 + 230
    return {'kind': kind, 'text': spec['text'], 'x': x, 'y': y, 'rot': rot, 'size': size,
            'w': lay.width, 'h': lay.height, 't0': t0, 't1': t1}


def render(plan, out_dir, work, name):
    segs, caps, clips, t = [], [], [], 0.0
    beeps, decos, hcaps, hook, pops = [], [], [], [], []
    btags, face_from = [], {}                              # b_roll 꼬리표(우선) · 컷 화자 얼굴이 처음 보이는 시각
    for i, hk in enumerate(plan.get('hook', [])):          # 첫 3~4초 몽타주 훅 — 본편 컷의 원음 한마디
        c = plan['cuts'][hk['cut']]
        a, b, ws = find_say(c, hk['say'])
        n = max(1, round((b - a) * FPS))
        hz = f'if(lt(on,4),1.34-0.03*on,1.22+0.05*(on-4)/{n})'
        clip, log = band_clip(c, i, work, span=(a, b), zoom=hz, tag='h')
        d = n / FPS
        brs = []
        if hk.get('b_roll'):                               # 훅 조각 화면 = 주제 인물(소리는 원래 화자)
            br = hk['b_roll']
            bc, blog = broll_clip(br, d, f'h{i}', work, zoom=f'if(lt(on,4),1.12-0.02*on,1.04+0.04*(on-4)/{n})')   # 덮는 장면은 이미 가까워 당겨 잡기를 줄인다
            clip = apply_broll(clip, [(bc, 0.0, d)], work, f'h{i:02d}')
            log = {**log, 'face_cx': blog.get('face_cx', log.get('face_cx'))}
            brs.append({'from': 0.0, 'to': round(d, 3), 't0': round(t, 3), 't1': round(t + d, 3), 'person': br['person'], 'tag': br.get('tag'),
                        'src': br['src'], 't': br['t'], 'log': blog})
            if br.get('tag'):
                btags.append((br['tag'], t, t + d))
        hook.append({'i': i, 'cut': hk['cut'], 'who': c['who'], 'in': round(a, 3), 'out': round(b, 3), 't0': round(t, 3), 't1': round(t + d, 3),
                     'say': hk['say'], 'caps': hk['caps'], 'log': log, 'b_roll': brs})
        hcaps.append({'t0': t, 't1': t + d, 'caps': hk['caps']})
        for kind in ('sticker', 'note'):
            if hk.get(kind):
                dt = .08 if kind == 'sticker' else .2
                decos.append(deco_of(hk[kind], kind, t + dt, t + d, log.get('face_cx')))
                if kind == 'sticker':
                    pops.append(t + dt)
        clips.append(clip)
        print(f'✓ 훅 {i} {c["who"]} «{hk["say"]}» {a:.2f}~{b:.2f} ({d:.2f}초) → {t:.2f}~{t + d:.2f}')
        t += d
    hook_end = t
    for k, c in enumerate(plan['cuts']):
        fx = c.get('fx') or {}
        zoom, at = None, None
        if fx.get('at'):
            hit = [w for w in words_of(c) if w[2] == fx['at'] or fx['at'] in w[2]]
            if not hit:
                sys.exit(f'✗ 컷 {k} fx.at «{fx["at"]}» 이 그 컷 전사에 없다')
            at = hit[0][0] - c['in']
            f0 = max(0, round(at * FPS) - 2)
            zoom = f'if(lt(on,{f0}),1,min(1.15,1+0.15*(on-{f0})/6))'
        clip, log = band_clip(c, k, work, zoom=zoom)
        d = round((c['out'] - c['in']) * FPS) / FPS
        brs, items = [], []
        for j, br in enumerate(c.get('b_roll') or []):     # 컷 일부 화면만 주제 인물로(패널 얼굴은 컷 앞뒤에 남긴다)
            a = float(br.get('from', 0.0))
            b = min(d, float(br['to']) if br.get('to') is not None else d)
            n = max(1, round((b - a) * FPS))
            bc, blog = broll_clip(br, b - a, f'c{k}_{j}', work, zoom=f'min(1.10,1+0.10*on/{n})')
            items.append((bc, a, b))
            brs.append({'from': round(a, 3), 'to': round(b, 3), 't0': round(t + a, 3), 't1': round(t + b, 3), 'person': br['person'],
                        'tag': br.get('tag'), 'src': br['src'], 't': br['t'], 'log': blog})
            if br.get('tag'):
                btags.append((br['tag'], t + a, t + b))
        clip = apply_broll(clip, items, work, f'c{k:02d}')
        if brs and brs[0]['from'] <= 0.01:
            face_from[k] = t + brs[0]['to']
        if at is not None:
            fcx = next((x['log'].get('face_cx') for x in brs if x['from'] <= at < x['to']), log.get('face_cx'))
            for kind in ('sticker', 'note'):
                if fx.get(kind):
                    t0 = t + max(0.0, at - .05)
                    decos.append(deco_of(fx[kind], kind, t0, min(t + d, t0 + FX_HOLD), fcx))
                    if kind == 'sticker':
                        pops.append(t0)
        seg = {'k': k, 't0': t, 't1': t + d, 'cut': c, 'log': log, 'cards': [], 'b_roll': brs}
        for ch in chunk(words_of(c)):
            raw = ' '.join(w[2] for w in ch)
            shown = raw
            for j in c.get('joins', []):                  # 띄어쓰기만 붙인다(전사 오인식 «영부인이 었을») — 글자는 그대로
                shown = shown.replace(j, j.replace(' ', ''))
            for w in ch:                                  # 욕설 낱말은 삐(소리)와 xx(글자)
                if PF.is_bad_token(w[2]):
                    beeps.append((t + w[0] - c['in'], t + w[1] - c['in']))
            caps.append({'t0': max(t, t + ch[0][0] - c['in'] - .08), 't1': 0, 'text': PF.mask(shown), 'raw': raw, 'cut': k, 'who': c['who']})
        segs.append(seg)
        clips.append(clip)
        print(f'✓ 컷 {k} {c["who"]} {c["in"]:.2f}~{c["out"]:.2f} ({d:.2f}초) → {t:.2f}~{t + d:.2f} · {log}')
        t += d
    total = t
    for i, cp in enumerate(caps):                        # 다음 자막이 뜰 때까지 유지(빈 화면 없이), 컷 끝을 넘지 않게
        seg = segs[cp['cut']]
        nxt = caps[i + 1]['t0'] if i + 1 < len(caps) else total
        cp['t1'] = min(nxt, seg['t1']) if (i + 1 < len(caps) and caps[i + 1]['cut'] == cp['cut']) else seg['t1']
    for card in plan.get('cards', []):
        s = segs[card['cut']]
        t0 = s['t0'] + card.get('offset', 0)
        s['cards'].append({**card, 't0': t0, 't1': min(total, t0 + card.get('dur', 3.5))})
    # 그림: 컷 이어 붙이기(다시 굽는다 — 0번 프레임 함정)
    lst = work / 'list.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in clips), encoding='utf-8')
    band = work / 'band.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c:v', 'libx264', '-crf', '14',
                    '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', str(FPS), '-c:a', 'pcm_s16le', str(band)], check=True)
    # 틀: 상태가 바뀌는 시각마다 한 장 → png 이어 붙인 투명 영상
    tags, seen = [], set()                               # 경력 꼬리표: 그 사람이 처음 나온 컷 시작부터 TAG_S 초
    for s in segs:
        w = s['cut']['who']
        if w not in seen and s['t0'] >= hook_end:
            seen.add(w)
            a0 = face_from.get(s['k'], s['t0'])          # b_roll 이 컷 머리를 덮으면 화자 얼굴이 보일 때부터
            tags.append((w, a0, min(a0 + BR.TAG_S, total)))
    tags = btags + tags                                  # b_roll 꼬리표(«김건희 씨»·«기자 전언»)가 먼저
    anim = {i * .08 + TITLE_IN * j / 6 for i in range(2) for j in range(1, 7)}            # 제목 등장
    anim |= {c['t0'] + POP * j / 3 for c in caps for j in range(1, 4)}                    # 자막 팝
    anim |= {h['t0'] + .1 * j / 3 for h in hcaps for j in range(1, 4)}                     # 훅 자막 팝
    anim |= {dc['t0'] + (STK_IN * j / 7 if dc['kind'] == 'sticker' else NOTE_IN * j / 3)
             for dc in decos for j in range(1, 8 if dc['kind'] == 'sticker' else 4)}       # 스티커·속마음 등장
    anim |= {dc['t0'] + .3 + .04 * j for dc in decos if dc['kind'] == 'sticker' for j in range(0, 4)}   # 스티커 반 흔들
    marks = sorted({0.0, total, max(0.0, total - 1.0)} | {s['t0'] for s in segs} | {c['t0'] for c in caps} | {c['t1'] for c in caps}
                   | {k['t0'] for s in segs for k in s['cards']} | {k['t1'] for s in segs for k in s['cards']}
                   | {a for _, a, b in tags} | {b for _, a, b in tags} | anim
                   | {h['t0'] for h in hcaps} | {h['t1'] for h in hcaps} | {dc['t0'] for dc in decos} | {dc['t1'] for dc in decos})
    marks = sorted({round(m * FPS) / FPS for m in marks if 0 <= m <= total})   # 프레임 경계로 — 칸 길이 반올림이 쌓여 틀이 그림보다 앞서던 것(10-29 실측 0.1초)
    fr = work / 'frames'
    fr.mkdir(exist_ok=True)
    seq = []
    for i in range(len(marks) - 1):
        a, b = marks[i], marks[i + 1]
        if b - a < 1 / FPS / 2:
            continue
        p = fr / f's{i:03d}.png'
        state_png(plan, a + min(.5 / FPS, (b - a) / 2), segs, caps, total, tags, decos, hcaps).save(p)
        seq.append((p, b - a))
    cl = work / 'frames.txt'
    cl.write_text(''.join(f"file '{p.as_posix()}'\nduration {d:.4f}\n" for p, d in seq) + f"file '{seq[-1][0].as_posix()}'\n", encoding='utf-8')
    # 합성: 검정 바탕 + 얼굴 띠 + 틀, 소리 = 원음(삐 구간은 1kHz)
    af = '[0:a]anull'
    if beeps:
        mute = '+'.join(f'between(t,{a:.3f},{b:.3f})' for a, b in beeps)
        af = (f"[0:a]volume=enable='{mute}':volume=0[m];sine=f=1000:sample_rate=48000:d={total:.3f},volume=0.25,"
              f"volume=enable='not({mute})':volume=0[bp];[m][bp]amix=inputs=2:normalize=0")
    raw = work / 'raw.mp4'
    pin = []
    if pops:                                             # 팝 효과음(스티커가 튈 때) — 원음 위에 얹는다(해설 아님)
        pin = ['-i', str(HK.pop_sfx())]
        af += '[o0]'
        af += f';[2:a]aresample=48000,aformat=channel_layouts=stereo,asplit={len(pops)}' + ''.join(f'[p{i}]' for i in range(len(pops)))
        for i, tp in enumerate(pops):
            ms = int(tp * 1000)
            af += f';[p{i}]adelay={ms}|{ms},volume=0.45[q{i}]'
        af += ';[o0]' + ''.join(f'[q{i}]' for i in range(len(pops))) + f'amix=inputs={len(pops) + 1}:duration=first:normalize=0'
    fc = (f'color=c=black:s={W}x{H}:r={FPS}:d={total:.3f}[bg];[bg][0:v]overlay=0:{Y0}:shortest=1[p];'
          f'[1:v]format=rgba[f];[p][f]overlay=0:0:format=auto[v];{af}[a]')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(band), '-f', 'concat', '-safe', '0', '-i', str(cl), *pin,
                    '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', f'{total:.3f}', '-c:v', 'libx264', '-crf', '18',
                    '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', str(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
                    str(raw)], check=True)
    import loudnorm_final
    final = out_dir / f'{name}.mp4'
    r = loudnorm_final.normalize(str(raw), str(final))
    print('음량', r)
    sheet(final, out_dir / f'{name}_sheet.jpg', total)
    m = {'name': name, 'total': round(total, 3), 'loudness': r, 'beeps': beeps,
         'hook': {'t0': 0.0, 't1': round(hook_end, 3), 'clips': hook}, 'pops': [round(x, 3) for x in pops],
         'decos': [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in dc.items()} for dc in decos],
         'cuts': [{'k': s['k'], 't0': round(s['t0'], 3), 't1': round(s['t1'], 3), 'who': s['cut']['who'], 'show': s['cut']['show'],
                   'date': s['cut']['date'], 'src': s['cut']['src'], 'in': s['cut']['in'], 'out': s['cut']['out'],
                   'role': s['cut'].get('role'), 'log': s['log'], 'quoted_person': s['cut'].get('quoted_person'),
                   'b_roll': s['b_roll']} for s in segs],
         'subject': plan.get('subject'),
         'captions': [{'t0': round(c['t0'], 3), 't1': round(c['t1'], 3), 'text': c['text'], 'raw': c['raw'], 'cut': c['cut']} for c in caps],
         'cards': [{k: v for k, v in c.items()} for s in segs for c in s['cards']]}
    (out_dir / f'{name}.render.json').write_text(json.dumps(m, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'완성 {final} · {total:.2f}초')


def sheet(src, out, total, cols=8):
    ims = []
    t = 0.0
    while t < total:
        p = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(src), '-frames:v', '1', '-vf', 'scale=270:-2',
                            '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
        if p:
            im = Image.open(io.BytesIO(p)).convert('RGB')
            ImageDraw.Draw(im).text((6, 4), f'{t:.2f}', fill=(255, 255, 0), font=font(FONT, 24))
            ims.append(im)
        t += .25 if t < 5 - 1e-6 else 1.0             # 앞 5초(훅)는 0.25초 간격
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    sh = Image.new('RGB', (w * cols, h * rows))
    for i, im in enumerate(ims):
        sh.paste(im, (i % cols * w, i // cols * h))
    sh.save(out, quality=85)
    print('시트', out)


if __name__ == '__main__':
    main()
