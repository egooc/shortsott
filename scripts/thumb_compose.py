# -*- coding: utf-8 -*-
"""롱폼 썸네일 합성(레인 공통) — 누구나 아는 제품·사물(주인공) + 상징 1개 배경 + 두 줄 큰 글씨, 포장 0·1·2 썸네일 3장과 미리보기 시트.
관리자 10-18 소유주 지시 «초코파이 같은 거랑 상징적 이미지 합쳐서 썸네일».

    python scripts/thumb_compose.py <편 폴더> [--config compose.json] [--only 0,2] [--regen] [--write-packages] [--no-gpt]

<편 폴더>/packages.json: {"packages": [{"title": "…", "big": ["초코파이", …]}, …]}   ← 제목·큰 낱말(업로드 관문과 같은 형식)
<편 폴더>/compose.json:
    {"product": {"name": "초코파이", "desc": "round chocolate-coated snack cake with marshmallow filling, one cake shown half unwrapped"},
     "style_ref": "ref/style.png",          # 선택 — 없으면 처음 만든 제품 그림을 기준 그림으로 붙인다
     "chip": "기업 흥망",                    # 선택 — 왼쪽 위 작은 띠
     "variants": [{"symbol": "fork", "top": "초코파이는 남았다", "bottom": "그룹은 왜 무너졌나"},
                  {"symbol": "crack", "top": "…", "bottom": "…"},
                  {"symbol": "scale", "top": "…", "bottom": "같은 뿌리, 다른 운명", "quote": true}]}   # quote=아랫줄을 “따옴표 한마디”로

방식
- 그림은 gpt-ask 이미지 생성(제품 1장 + 상징 배경 1장씩). 매번 기준 그림을 --attach 해서 화풍을 맞춘다. 만든 그림은 thumb/compose/ 에 남아
  문구만 바꿀 때는 재생성 없이 다시 합성한다(--regen 이면 다시 그림).
- 제품은 흰 배경으로 받아 char_anim.to_rgba 로 투명하게 오려 오른쪽에 얹는다. 3안은 제품이 같고 상징·문구만 다르다.
- 글씨는 PIL(페이퍼로지 ExtraBold): 윗줄 = 사실(큰 낱말로 시작, 가장 큰 글씨), 아랫줄 = 색 강조 역설 또는 “한마디”.
관문(하나라도 걸리면 종료 코드 4): 제목이 big[0] 으로 시작 · 윗줄이 big[0] 으로 시작하고 아랫줄보다 큰 글씨 · 윗줄 ≤ 10자·아랫줄 ≤ 12자(공백 제외) ·
얼굴 검출 0(YuNet) · 그림에 실존 인물 얼굴·로고·실제 포장 문구를 그리지 말라는 지시를 프롬프트에 고정.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import char_anim  # noqa: E402

FONT = str(ROOT / 'politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf')
YUNET = str(ROOT / 'politics-hour/models/face_detection_yunet_2023mar.onnx')
SYMBOLS = ROOT / 'scripts' / 'thumb_symbols.json'
W, H = 1280, 720
MAX_TOP, MAX_BOTTOM = 10, 12
INK = (14, 24, 48)                  # 남색 바탕(그라데이션 끝)
YELLOW, CORAL = (255, 212, 0), (255, 112, 84)

NO = 'No text, no letters, no numbers, no logos, no brand names, no real product packaging copy, no people, no faces.'
STYLE = 'Sleek modern flat illustration with long smooth gradients and soft rim light; no texture, no grain, no paper effect.'


def f(n):
    return ImageFont.truetype(FONT, n)


def load(path, mode='RGB'):
    """파일 핸들을 바로 닫는다(윈도에서 열린 채 남으면 지우기·덮어쓰기가 막힌다)."""
    with Image.open(path) as im:
        return im.convert(mode)


def gpt_image(prompt, out, attach, session):
    args = ['node', str(ROOT / 'scripts' / 'gpt-ask.js'), '--session', session, '--no-search', '--effort', 'medium', '--image', str(out)]
    for a in attach:
        args += ['--attach', str(a)]
    return subprocess.Popen(args + [prompt], stdout=subprocess.DEVNULL)


def product_prompt(p):
    return (f'Draw one generic {p["name"]} object: {p["desc"]}. Single object, three-quarter view, centered, occupying at most 70% of the frame, '
            f'pure white background with wide margins, nothing touching the edges, no cast shadow, no plate, no reflection. {STYLE} {NO}'
            + (' Match the rendering style of the attached reference image.' if p.get('_ref') else ''))


def bg_prompt(sym):
    return (f'Wide 16:9 background scene: {sym["prompt"]}. Put the main symbol on the right 60% of the frame; keep the left 40% a calm, '
            f'nearly empty dark navy gradient (space for a headline). {STYLE} Cinematic but clean. {NO} '
            'Match the color palette and rendering style of the attached reference image.')


def cover(im, w, h):
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def cutout(path):
    rgba = char_anim.to_rgba(np.array(load(path)), white=185, chroma=24)   # 제품 밑 회색 그림자까지 배경으로(10-18 시험: 흰 덩어리로 남았다)
    ys, xs = np.where(rgba[..., 3] > 8)
    return Image.fromarray(rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1], 'RGBA')


def fit(d, text, size, maxw):
    while size > 30 and d.textlength(text, font=f(size)) > maxw:
        size -= 2
    return size


def compose(bg_path, prod, v, chip):
    """(1280x720 RGB, 큰 글씨 크기 {top, bottom})"""
    c = cover(load(bg_path), W, H)
    # 왼쪽 긴 그라데이션(글씨 자리) — 소유주 취향: 세련·무질감·그라데이션 길게
    g = np.clip(1 - np.linspace(0, 1, W) / .72, 0, 1) ** 1.6 * 235
    shade = Image.fromarray(np.tile(g.astype(np.uint8), (H, 1)), 'L')
    c.paste(INK, (0, 0, W, H), shade)
    # 제품: 오른쪽, 높이 58%, 바닥 그림자
    ph = int(H * .58)
    pr = prod.resize((round(prod.width * ph / prod.height), ph), Image.LANCZOS)
    if pr.width > W * .46:
        pr = pr.resize((int(W * .46), round(pr.height * W * .46 / pr.width)), Image.LANCZOS)
    px, py = W - pr.width - 30, H - pr.height - 60
    sh = Image.new('L', (W, H), 0)
    ImageDraw.Draw(sh).ellipse([px + pr.width * .08, py + pr.height - 26, px + pr.width * .92, py + pr.height + 34], fill=150)
    c.paste((0, 0, 0), (0, 0, W, H), sh.filter(ImageFilter.GaussianBlur(22)))
    c.paste(pr, (px, py), pr)
    d = ImageDraw.Draw(c)
    maxw = max(px - 30, int(W * .5))
    bottom = f'“{v["bottom"]}”' if v.get('quote') else v['bottom']
    big = v.get('_big', '')
    # 윗줄이 길어 112px 밑으로 줄면 큰 낱말만 한 줄로 크게, 나머지는 둘째 줄 흰 글씨(큰 낱말이 언제나 가장 큰 글씨)
    lines = [(v['top'], fit(d, v['top'], 150, maxw), (255, 255, 255))]
    head, _, rest = v['top'].partition(' ')       # 첫 띄어쓰기에서 끊는다 — 조사(«는»)가 혼자 다음 줄로 떨어지지 않게
    if lines[0][1] < 112 and big and head.startswith(big) and rest.strip():
        sbig = fit(d, head, 170, maxw)
        lines = [(head, sbig, (255, 255, 255)), (rest.strip(), min(fit(d, rest.strip(), 92, maxw), sbig - 30), (255, 255, 255))]
    st = lines[0][1]
    sb = min(fit(d, bottom, 104, maxw), st - 14)
    lines.append((bottom, sb, YELLOW if v.get('quote') or v.get('color') != 'coral' else CORAL))
    gap = 26
    total = sum(s for _, s, _ in lines) + gap * (len(lines) - 1)
    y = max(150 if chip else 60, (H - total) // 2 + 20)
    for text, size, col in lines:
        y += size
        d.text((54, y), text, font=f(size), fill=col, anchor='ls', stroke_width=max(5, size // 18), stroke_fill=INK)
        y += gap
    if chip:
        tw = d.textlength(chip, font=f(36))
        d.rounded_rectangle([50, 46, 50 + tw + 36, 102], radius=10, fill=(212, 32, 44))
        d.text((68, 88), chip, font=f(36), fill=(255, 255, 255), anchor='ls')
    return c, {'top': st, 'bottom': sb}


def faces(img):
    a = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    det = cv2.FaceDetectorYN.create(YUNET, '', (a.shape[1], a.shape[0]), score_threshold=.6)
    _, found = det.detect(a)
    return 0 if found is None else len(found)


def gate(i, pkg, v, size, nface):
    bad = []
    big = (pkg.get('big') or [''])[0]
    if not big:
        bad.append(f'{i}번: packages.json big 없음')
    elif not pkg['title'].lstrip('【[').startswith(big):
        bad.append(f'{i}번: 제목 «{pkg["title"]}» 이 큰 낱말 «{big}» 로 시작하지 않음')
    if big and not v['top'].startswith(big):
        bad.append(f'{i}번: 윗줄 «{v["top"]}» 이 큰 낱말 «{big}» 로 시작하지 않음')
    if size['top'] <= size['bottom']:
        bad.append(f'{i}번: 윗줄 글씨({size["top"]})가 아랫줄({size["bottom"]})보다 크지 않음')
    for k, mx in (('top', MAX_TOP), ('bottom', MAX_BOTTOM)):
        n = len(v[k].replace(' ', ''))
        if n > mx:
            bad.append(f'{i}번: {k} {n}자 > {mx}자')
    if nface:
        bad.append(f'{i}번: 얼굴 {nface}개 검출')
    return bad


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='롱폼 썸네일 합성(제품+상징+두 줄)')
    ap.add_argument('ep')
    ap.add_argument('--config', default='compose.json')
    ap.add_argument('--only', help='포장 번호 쉼표')
    ap.add_argument('--regen', action='store_true', help='그림을 다시 받는다')
    ap.add_argument('--no-gpt', action='store_true', help='그림이 없으면 멈춘다(문구만 다시 합성)')
    ap.add_argument('--write-packages', action='store_true', help='packages.json 의 thumbnail 칸을 새 파일로')
    ap.add_argument('--session', default='thumb_compose')
    a = ap.parse_args(argv)
    ep = Path(a.ep).resolve()
    cfg = json.loads((ep / a.config).read_text(encoding='utf-8'))
    pk_path = ep / 'packages.json'
    pk = json.loads(pk_path.read_text(encoding='utf-8'))
    syms = json.loads(SYMBOLS.read_text(encoding='utf-8'))
    out = ep / 'thumb' / 'compose'
    out.mkdir(parents=True, exist_ok=True)
    idx = [int(x) for x in a.only.split(',')] if a.only else list(range(len(cfg['variants'])))
    for i in idx:
        if cfg['variants'][i]['symbol'] not in syms:
            raise SystemExit(f'모르는 상징: {cfg["variants"][i]["symbol"]} (scripts/thumb_symbols.json 에 추가)')
    ref = (ep / cfg['style_ref']) if cfg.get('style_ref') else None
    prod_png = out / 'product.png'
    calls = 0
    if a.regen or not prod_png.exists():
        if a.no_gpt:
            raise SystemExit('product.png 없음(--no-gpt)')
        p = dict(cfg['product'], _ref=bool(ref))
        rc = gpt_image(product_prompt(p), prod_png, [ref] if ref else [], a.session).wait()
        calls += 1
        if rc or not prod_png.exists():
            raise SystemExit(f'제품 그림 실패(gpt-ask {rc}) — 한도·인증 오류면 멈춘다')
    ref = ref or prod_png
    jobs = []
    for i in idx:
        sym = cfg['variants'][i]['symbol']
        bp = out / f'bg_{sym}.png'
        if (a.regen or not bp.exists()) and not any(j[1] == bp for j in jobs):
            if a.no_gpt:
                raise SystemExit(f'{bp.name} 없음(--no-gpt)')
            jobs.append((gpt_image(bg_prompt(syms[sym]), bp, [ref], a.session), bp))   # 동시 실행(gpt-ask 가 4건으로 묶는다)
    for pr, bp in jobs:
        calls += 1
        if pr.wait() or not bp.exists():
            raise SystemExit(f'배경 그림 실패: {bp.name}')
    prod = cutout(prod_png)
    bad, made = [], []
    for i in idx:
        v = cfg['variants'][i]
        v = dict(v, _big=(pk['packages'][i].get('big') or [''])[0])
        img, size = compose(out / f'bg_{v["symbol"]}.png', prod, v, cfg.get('chip'))
        dst = out / f'thumb_{i}.png'
        img.save(dst)
        nf = faces(img)
        bad += gate(i, pk['packages'][i], v, size, nf)
        made.append((i, dst, size, nf))
        if a.write_packages:
            pk['packages'][i]['thumbnail'] = str(dst.relative_to(ROOT)).replace('\\', '/') if ROOT in dst.parents else str(dst)
            pk['packages'][i]['style'] = f'compose {v["symbol"]}' + (' quote' if v.get('quote') else '')
    # 미리보기 시트: 실제 크기 1장 + 유튜브 목록 크기(320x180) 줄
    tiles = [load(out / f'thumb_{i}.png') for i in range(len(cfg['variants'])) if (out / f'thumb_{i}.png').exists()]
    sheet = Image.new('RGB', (max(W, 8 + 424 * len(tiles)), 580), (245, 245, 245))
    sd = ImageDraw.Draw(sheet)
    for k, t in enumerate(tiles):
        sheet.paste(t.resize((416, 234), Image.LANCZOS), (8 + k * 424, 8))
        sheet.paste(t.resize((320, 180), Image.LANCZOS), (8 + k * 424, 260))
        title = pk['packages'][k]['title'] if k < len(pk['packages']) else ''
        sd.text((8 + k * 424, 452), f'{k}번 · {cfg["variants"][k]["symbol"]}', font=f(22), fill=(40, 40, 40))
        sd.multiline_text((8 + k * 424, 482), '\n'.join(title[j:j + 18] for j in range(0, len(title), 18)), font=f(20), fill=(70, 70, 70))
    sheet.save(out / 'sheet.png')
    if a.write_packages:
        pk_path.write_text(json.dumps(pk, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for i, dst, size, nf in made:
        print(f'{i}번 {dst.name} 글씨 {size["top"]}/{size["bottom"]}px 얼굴 {nf}')
    print(f'시트 {out / "sheet.png"} · GPT {calls}건')
    if bad:
        print('관문 걸림:\n- ' + '\n- '.join(bad))
        return 4
    print('관문 통과')
    return 0


if __name__ == '__main__':
    sys.exit(main())
