# -*- coding: utf-8 -*-
"""유튜브 쇼츠 안전 영역 검사 — 글자가 쇼츠 UI 밑에 깔리면 실패.

    python scripts/shorts_safe.py <자막.ass> [--video 결과.mp4] [--at 초] [--out qc/shorts_safe.jpg] [--json]
    python scripts/shorts_safe.py --tpl 템플릿.json [--json]
    python scripts/shorts_safe.py <자막.ass> --tpl 틀글자.json      # ASS 밖에서 그린 글자(하이퍼프레임·HTML)도 같이

왜 (2026-10-16, 소유주 지적): N100 엔진룸 'made' 내레이션 자막이 y=1745(1920 기준)라
  «유튜브 템플릿에 완전 가려져 안 보인다». 로보토리 'home' 1790, JP 'zou' 1600도 같았다.
  렌더 뒤 눈으로 보기 전에 ASS 글자 상자로 기계가 잡는다.

규격(캔버스 1080x1920, px) — N100 전달:
  1. 아래 UI y>1450: 글자 중심 y<=1450, 글자 상자 아래 끝<=1500.
  2. 오른쪽 버튼 열 x>=950, y 900~1700: 글자 금지. 가운데 정렬은 줄 폭<=860(x 110~970).
  3. 위 UI y<130: 글자 상자 위 끝>=130.
  4. 좌우: 글자는 x 60~1020 안.
  5. 효과 문구·딴지도 같은 선. 영상 상자(핵심 피사체)는 아래 끝>1450이면 경고만.

글자 폭: 스타일의 Fontname 으로 글꼴 파일을 찾아(--fonts-dir, ASS 옆 fonts/, midform assets/fonts, 시스템 글꼴) 실측한다.
  libass 는 글꼴 크기를 «줄 높이»(OS/2 usWinAscent+usWinDescent)로 쓴다 — em = 크기 ÷ (줄 높이/unitsPerEm).
  Noto Sans JP 는 1.448 이라 1em 으로 셈하면 폭이 1.45배 부푼다(10-16 C 실측: 122ja 제목 계산 1022 vs 실제 약 700).
  글꼴을 못 찾으면 어림한다(한글·한자·가나 = 크기 1배, 그 밖 0.6배, 공백 0.3배 — 넓게 잡는 쪽). 그 줄엔 «폭 어림» 표시.

등급: 장식 띠(티커·로고·슬로건·태그바·버그)는 가려져도 내용 손실이 없다 → 템플릿 요소 "grade":"decor",
  ASS 는 --decor-style 이름 으로 주면 FAIL 이 WARN 으로 내려간다. 출처 표기는 content(기본)다.

종료 코드: 0 통과, 4 실패(금지 구역), 2 인자 오류, 1 기타.
"""
import argparse
import glob
import io
import json
import math
import os
import re
import struct
import subprocess
import sys

W, H = 1080, 1920
SAFE_CENTER_Y = 1450
SAFE_BOTTOM_Y = 1500
TOP_Y = 130
SIDE_L, SIDE_R = 60, 1020
RIGHT_COL = (950, 900, W, 1700)  # x0, y0, x1, y1
CENTER_MAX_W = 860
LINE_H_EST = 1.2  # 글꼴을 못 찾았을 때 줄 높이 = 크기 x 1.2 (넓게). 찾으면 libass 대로 크기 x 1.0
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIRS = [os.path.join(HERE, '..', 'assets', 'fonts'),
             os.path.join(os.environ.get('MIDFORM', 'D:/midform'), 'assets', 'fonts'),  # 파일을 옮겨 돌려도 찾게
             os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts'),
             '/usr/share/fonts', '/usr/local/share/fonts', os.path.expanduser('~/.fonts'),
             os.path.expanduser('~/.local/share/fonts')]

# 미리보기에 칠할 금지 구역
ZONES = [
    ('bottom_ui', (0, SAFE_CENTER_Y, W, H)),
    ('right_buttons', RIGHT_COL),
    ('top_ui', (0, 0, W, TOP_Y)),
    ('side_left', (0, 0, SIDE_L, H)),
    ('side_right', (SIDE_R, 0, W, H)),
]


# ---------- 글꼴 ----------

def _read(path):
    with open(path, 'rb') as f:
        return f.read()


def _tables(data):
    base = struct.unpack('>I', data[12:16])[0] if data[:4] == b'ttcf' else 0
    n = struct.unpack('>H', data[base + 4:base + 6])[0]
    out = {}
    for i in range(n):
        tag, _, off, ln = struct.unpack('>4sIII', data[base + 12 + 16 * i:base + 28 + 16 * i])
        out[tag.decode('latin-1')] = (off, ln)
    return out


def font_metrics(path):
    """(unitsPerEm, usWinAscent + usWinDescent) — libass 가 글꼴 크기에 맞추는 줄 높이."""
    data = _read(path)
    t = _tables(data)
    upem = struct.unpack('>H', data[t['head'][0] + 18:t['head'][0] + 20])[0]
    if 'OS/2' in t:
        o = t['OS/2'][0]
        wa, wd = struct.unpack('>HH', data[o + 74:o + 78])
        if wa + wd:
            return upem, wa + wd
    o = t['hhea'][0]
    asc, desc = struct.unpack('>hh', data[o + 4:o + 8])
    return upem, asc - desc


def font_names(path):
    """[(family, subfamily)] — name 표 1/2 와 16/17."""
    data = _read(path)
    t = _tables(data)
    if 'name' not in t:
        return []
    o = t['name'][0]
    _, count, soff = struct.unpack('>HHH', data[o:o + 6])
    got = {}
    for i in range(count):
        pid, _, _, nid, ln, off = struct.unpack('>6H', data[o + 6 + 12 * i:o + 18 + 12 * i])
        if nid not in (1, 2, 16, 17):
            continue
        raw = data[o + soff + off:o + soff + off + ln]
        try:
            v = raw.decode('utf-16-be') if pid in (0, 3) else raw.decode('latin-1')
        except UnicodeDecodeError:
            continue
        got.setdefault(nid, []).append(v)
    out = []
    for fam_id, sub_id in ((1, 2), (16, 17)):
        sub = (got.get(sub_id) or got.get(2) or ['Regular'])[0]
        for fam in set(got.get(fam_id, ())):
            out.append((fam, sub))
    return out


_FONT_INDEX = {}
_METRICS = {}


def find_font(family, bold=False, dirs=()):
    """Fontname 으로 글꼴 파일. 굵기는 Bold 플래그로 고른다. 없으면 None."""
    key = tuple(dirs)
    if key not in _FONT_INDEX:
        idx = {}
        for d in list(dirs) + FONT_DIRS:
            if not d or not os.path.isdir(d):
                continue
            for p in glob.glob(os.path.join(d, '**', '*.*'), recursive=True):
                if not p.lower().endswith(('.ttf', '.otf', '.ttc')):
                    continue
                try:
                    for fam, sub in font_names(p):
                        idx.setdefault(fam.lower(), []).append((sub, p))
                except Exception:  # noqa — 깨진 글꼴은 건너뛴다
                    continue
        _FONT_INDEX[key] = idx
    cands = _FONT_INDEX[key].get((family or '').strip().lower(), [])
    if not cands:
        return None
    want = 'bold' if bold else 'regular'
    for sub, p in cands:
        if sub.lower() == want:
            return p
    for sub, p in cands:
        if (want == 'bold') == ('bold' in sub.lower()):
            return p
    return cands[0][1]


def em_size(fs, font):
    """libass 글꼴 크기 → 실제 em 픽셀."""
    if font not in _METRICS:
        _METRICS[font] = font_metrics(font)
    upem, lh = _METRICS[font]
    return fs * upem / float(lh)


def _wide(ch):
    o = ord(ch)
    return (0x1100 <= o <= 0x11FF or 0x2E80 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF
            or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFF60 or 0x3000 <= o <= 0x303F)


def text_width(line, em, font=None):
    """em 픽셀 기준 한 줄 폭. 글꼴이 있으면 Pillow 로 advance 를 잰다."""
    if font:
        from PIL import ImageFont
        return ImageFont.truetype(font, 1000).getlength(line) * em / 1000.0
    w = 0.0
    for ch in line:
        w += em * (1.0 if _wide(ch) else 0.3 if ch == ' ' else 0.6)
    return w


def text_box(x, y, an, fs, text, scale_x=100.0, scale_y=100.0, outline=0.0, font=None,
             wrap_w=None):
    """앵커(x, y)·정렬 an(1~9)·글꼴 크기(libass 단위)로 글자 상자 (x0, y0, x1, y1)."""
    lines = [ln for ln in re.split(r'\\N|\n', text)] or ['']
    em = em_size(fs, font) if font else fs
    emx, fsy = em * scale_x / 100.0, fs * scale_y / 100.0
    widths = [text_width(ln, emx, font) for ln in lines]
    n = len(lines)
    if wrap_w:  # libass 자동 줄바꿈 어림
        n = sum(max(1, math.ceil(w / wrap_w)) for w in widths)
        widths = [min(w, wrap_w) for w in widths]
    bw = max(widths) + 2 * outline
    bh = n * fsy * (1.0 if font else LINE_H_EST) + 2 * outline
    col = (an - 1) % 3  # 0 왼 1 가운데 2 오른
    row = (an - 1) // 3  # 0 아래 1 가운데 2 위
    x0 = x - (0, bw / 2, bw)[col]
    y0 = y - (bh, bh / 2, 0)[row]
    return (x0, y0, x0 + bw, y0 + bh)


def _hit(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def check_box(box, name='', kind='text', centered=False, grade='content'):
    """하나의 상자를 규격과 맞댄다. [(level, rule, msg)] — level FAIL/WARN. decor 는 FAIL 을 WARN 으로."""
    out = _check_box(box, name, kind, centered)
    if grade == 'decor':
        out = [('WARN' if lv == 'FAIL' else lv, rule, msg + ' [decor]') for lv, rule, msg in out]
    return out


def _check_box(box, name, kind, centered):
    x0, y0, x1, y1 = box
    out = []
    if kind == 'video':
        if y1 > SAFE_CENTER_Y:
            out.append(('WARN', 'subject_low', '%s 영상 상자 아래 끝 y=%.0f > %d — 핵심 피사체를 선 위에'
                        % (name, y1, SAFE_CENTER_Y)))
        return out
    cy = (y0 + y1) / 2
    if cy > SAFE_CENTER_Y:
        out.append(('FAIL', 'bottom_ui', '%s 중심 y=%.0f > %d (아래 UI)' % (name, cy, SAFE_CENTER_Y)))
    if y1 > SAFE_BOTTOM_Y:
        out.append(('FAIL', 'bottom_ui', '%s 아래 끝 y=%.0f > %d (아래 UI)' % (name, y1, SAFE_BOTTOM_Y)))
    if _hit(box, RIGHT_COL):
        out.append(('FAIL', 'right_buttons', '%s 상자 x %.0f~%.0f, y %.0f~%.0f 가 오른쪽 버튼 열에 걸림'
                    % (name, x0, x1, y0, y1)))
    if y0 < TOP_Y:
        out.append(('FAIL', 'top_ui', '%s 위 끝 y=%.0f < %d (위 UI)' % (name, y0, TOP_Y)))
    if x0 < SIDE_L or x1 > SIDE_R:
        out.append(('FAIL', 'side', '%s x %.0f~%.0f 가 좌우 여백(%d~%d) 밖' % (name, x0, x1, SIDE_L, SIDE_R)))
    if centered and x1 - x0 > CENTER_MAX_W:
        out.append(('FAIL', 'center_width', '%s 가운데 정렬 줄 폭 %.0f > %d' % (name, x1 - x0, CENTER_MAX_W)))
    return out


# ---------- ASS ----------

def t2s(t):
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_ass(text):
    info, styles, events = {}, {}, []
    sfmt, efmt, sec = None, None, ''
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith('['):
            sec = s.lower()
            continue
        if ':' not in s:
            continue
        k, _, v = s.partition(':')
        v = v.strip()
        if sec == '[script info]':
            info[k.strip()] = v
        elif k == 'Format' and 'styles' in sec:
            sfmt = [x.strip() for x in v.split(',')]
        elif k == 'Style' and sfmt:
            vals = [x.strip() for x in v.split(',', len(sfmt) - 1)]
            styles[vals[0]] = dict(zip(sfmt, vals))
        elif k == 'Format' and sec == '[events]':
            efmt = [x.strip() for x in v.split(',')]
        elif k == 'Dialogue' and efmt:
            vals = [x.strip() if i < len(efmt) - 1 else x for i, x in enumerate(v.split(',', len(efmt) - 1))]
            events.append(dict(zip(efmt, vals)))
    return info, styles, events


def _num(d, k, fb=0.0):
    try:
        return float(d.get(k, fb))
    except (TypeError, ValueError):
        return fb


def _tag(tags, name):
    m = None
    for m in re.finditer(r'\\' + name + r'(-?[\d.]+)', tags):
        pass
    return float(m.group(1)) if m else None


def ass_boxes(text, font=None, font_dirs=()):
    """ASS 대사마다 1080x1920 기준 글자 상자. [{start,end,style,text,box,centered,font,estimated}]
    font 를 주면 모든 줄에 그 글꼴, 아니면 스타일·\\fn 의 Fontname 으로 찾는다."""
    info, styles, events = parse_ass(text)
    px = _num(info, 'PlayResX', 0) or W
    py = _num(info, 'PlayResY', 0) or H
    sx, sy = W / px, H / py
    wrap_style = int(_num(info, 'WrapStyle', 0))
    out = []
    for ev in events:
        raw = ev.get('Text', '')
        tags = ''.join(re.findall(r'\{([^}]*)\}', raw))
        if re.search(r'\\p[1-9]', tags):  # 그림 모드는 글자가 아니다
            continue
        body = re.sub(r'\{[^}]*\}', '', raw).replace('\\h', ' ')
        if not body.replace('\\N', '').replace('\\n', '').strip():
            continue
        st = styles.get(ev.get('Style', ''), {})
        fs = _tag(tags, 'fs') or _num(st, 'Fontsize', 48)
        fscx = _tag(tags, 'fscx') or _num(st, 'ScaleX', 100)
        fscy = _tag(tags, 'fscy') or _num(st, 'ScaleY', 100)
        bord = _tag(tags, 'bord')
        bord = _num(st, 'Outline', 0) if bord is None else bord
        an = _tag(tags, 'an')
        if an is None:
            a = _tag(tags, 'a')  # 옛 정렬: 1~3 아래, 5~7 위, 9~11 가운데
            if a is not None:
                a = int(a)
                an = (a if a <= 3 else a + 2 if a <= 7 else a - 5)
        an = int(an or _num(st, 'Alignment', 2))
        fn = re.findall(r'\\fn([^\\}]+)', tags)
        fam = fn[-1].strip() if fn else st.get('Fontname', '')
        bold = _tag(tags, 'b')
        bold = (_num(st, 'Bold', 0) != 0) if bold is None else bold != 0
        ff = font or find_font(fam, bold, font_dirs)
        ml = _num(ev, 'MarginL') or _num(st, 'MarginL')
        mr = _num(ev, 'MarginR') or _num(st, 'MarginR')
        mv = _num(ev, 'MarginV') or _num(st, 'MarginV')
        m = re.search(r'\\(?:pos|move)\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)', tags)
        wrap_w = None
        if m:
            x, y = float(m.group(1)), float(m.group(2))
        else:
            col, row = (an - 1) % 3, (an - 1) // 3
            x = (ml, (ml + px - mr) / 2, px - mr)[col]
            y = (py - mv, py / 2, mv)[row]
            if wrap_style != 2:
                wrap_w = px - ml - mr
        if wrap_style == 2:
            body = body.replace('\\n', '\\N')
        else:
            body = body.replace('\\n', ' ')
        b = text_box(x, y, an, fs, body, fscx, fscy, bord, ff, wrap_w)
        box = (b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy)
        out.append({'start': t2s(ev.get('Start', '0:00:00.00')), 'end': t2s(ev.get('End', '0:00:00.00')),
                    'style': ev.get('Style', ''), 'text': body.replace('\\N', ' / '),
                    'box': [round(v, 1) for v in box], 'centered': an in (2, 5, 8),
                    'font': ff, 'estimated': not ff,
                    'anchor_x': x * sx if (an - 1) % 3 != 1 else (box[0] + box[2]) / 2})
    return out


EST_MIN = 1 / 1.5  # 어림 폭이 실제보다 넓을 수 있는 최대 비율(Noto Sans JP 1.448)


def _soften_estimated(b, name, grade):
    """폭을 어림한 줄: 가장 좁게 잡아도(폭 x EST_MIN) 걸리는 것만 FAIL, 폭 때문에만 걸린 것은 WARN.
    위아래 침범(bottom_ui·top_ui)은 폭과 무관하니 그대로 FAIL."""
    x0, y0, x1, y1 = b['box']
    ax = b['anchor_x']
    narrow = (ax + (x0 - ax) * EST_MIN, y0, ax + (x1 - ax) * EST_MIN, y1)
    still = {(rule) for lv, rule, _ in check_box(narrow, name, 'text', b['centered'], grade) if lv == 'FAIL'}
    out = []
    for lv, rule, msg in b['issues']:
        if lv == 'FAIL' and rule not in still:
            lv, msg = 'WARN', msg + ' [폭 어림 — 글꼴로 실측 필요]'
        out.append((lv, rule, msg))
    return out


def check_ass(text, font=None, skip_styles=(), decor_styles=(), font_dirs=()):
    rows = []
    for b in ass_boxes(text, font, font_dirs):
        if b['style'] in skip_styles:
            continue
        name = '[%s %.2fs] %s%s' % (b['style'], b['start'], b['text'][:20], ' (폭 어림)' if b['estimated'] else '')
        grade = 'decor' if b['style'] in decor_styles else 'content'
        b['issues'] = check_box(b['box'], name, 'text', b['centered'], grade)
        if b['estimated']:
            b['issues'] = _soften_estimated(b, name, grade)
        rows.append(b)
    return rows


# ---------- 템플릿 ----------

def template_boxes(tpl):
    """템플릿 정의 → [{name, kind, grade, box, centered}]. 좌표는 1080x1920 기준.
    tpl = {"elements": [...]} 또는 [...].
    요소: {"name", "kind": "text"|"video", "box": [x0,y0,x1,y1]}
       또는 글자 자리 {"name", "x", "y", "an"(기본 2), "fs"(libass 크기), "text"(가장 긴 줄 예시) | "max_chars"(한글 기준),
                      "lines"(기본 1), "outline", "font"(글꼴 파일) | "fontname"+"bold"(선택)}
       공통 선택: "grade": "content"(기본) | "decor" — decor 는 FAIL 을 WARN 으로.
       하이퍼프레임·HTML 틀에서 그린 글자는 "box" 로 넣는다(CSS 상자 그대로)."""
    els = tpl.get('elements', []) if isinstance(tpl, dict) else tpl
    out = []
    for e in els:
        kind = e.get('kind', 'text')
        an = int(e.get('an', 2))
        if 'box' in e:
            box = tuple(float(v) for v in e['box'])
            centered = False
        else:
            sample = e.get('text') or ('가' * int(e.get('max_chars', 1)))
            sample = '\\N'.join([sample] * int(e.get('lines', 1)))
            ff = e.get('font') or (find_font(e['fontname'], bool(e.get('bold'))) if e.get('fontname') else None)
            box = text_box(float(e['x']), float(e['y']), an, float(e['fs']), sample,
                           float(e.get('scale_x', 100)), 100.0, float(e.get('outline', 0)), ff)
            centered = kind == 'text' and an in (2, 5, 8)
        out.append({'name': e.get('name', '?'), 'kind': kind, 'grade': e.get('grade', 'content'),
                    'box': [round(v, 1) for v in box], 'centered': centered})
    return out


def check_template(tpl):
    """템플릿 정의를 규격과 맞댄다(요소 형식은 template_boxes). [(level, rule, msg)]"""
    out = []
    for b in template_boxes(tpl):
        out += check_box(b['box'], b['name'], b['kind'], b['centered'], b['grade'])
    return out


# ---------- 미리보기 ----------

def grab_frame(video, at, dst):
    subprocess.run([os.environ.get('FFMPEG', 'ffmpeg'), '-loglevel', 'error', '-y', '-ss', '%.3f' % at,
                    '-i', video, '-frames:v', '1', '-q:v', '3', dst], check=True)
    return dst


def preview(rows, out, frame=None, at=None):
    from PIL import Image, ImageDraw
    if frame and os.path.exists(frame):
        img = Image.open(frame).convert('RGB').resize((W, H))
    else:
        img = Image.new('RGB', (W, H), (40, 40, 40))
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for _, z in ZONES:
        d.rectangle(z, fill=(255, 0, 0, 70))
    d.line([(0, SAFE_CENTER_Y), (W, SAFE_CENTER_Y)], fill=(255, 255, 0, 220), width=3)
    d.line([(0, SAFE_BOTTOM_Y), (W, SAFE_BOTTOM_Y)], fill=(255, 160, 0, 220), width=2)
    for r in rows:
        live = at is None or 'start' not in r or r['start'] <= at < r['end']
        lv = [i[0] for i in r.get('issues', [])]
        if not live and 'FAIL' not in lv:
            continue
        col = ((255, 40, 40, 255) if 'FAIL' in lv else (255, 200, 0, 255) if 'WARN' in lv
               else (40, 255, 80, 255))
        d.rectangle(r['box'], outline=col, width=4 if live else 2)
    img = Image.alpha_composite(img.convert('RGBA'), lay).convert('RGB')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out, quality=88)
    return out


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='유튜브 쇼츠 안전 영역 검사')
    ap.add_argument('ass', nargs='?')
    ap.add_argument('--tpl', help='템플릿 정의 JSON (ASS 와 같이 주면 틀 글자도 판정에 넣는다)')
    ap.add_argument('--video', help='렌더 결과 mp4 — 미리보기 바탕 프레임')
    ap.add_argument('--at', type=float, help='미리보기 시각(초). 없으면 첫 실패 대사, 없으면 첫 대사')
    ap.add_argument('--out', help='미리보기 jpg (기본 <ass 폴더>/qc/shorts_safe.jpg)')
    ap.add_argument('--no-preview', action='store_true')
    ap.add_argument('--font', help='글꼴 파일 — 모든 줄에 이 글꼴(없으면 스타일 Fontname 으로 찾는다)')
    ap.add_argument('--fonts-dir', action='append', default=[], help='글꼴 찾을 폴더 추가(반복 가능)')
    ap.add_argument('--skip-style', action='append', default=[], help='검사에서 뺄 스타일 이름(반복 가능)')
    ap.add_argument('--decor-style', action='append', default=[], help='장식 띠 스타일 — FAIL 을 WARN 으로(반복 가능)')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    tpl_rows = []
    if a.tpl:
        with io.open(a.tpl, encoding='utf-8') as f:
            for b in template_boxes(json.load(f)):
                b['issues'] = check_box(b['box'], b['name'], b['kind'], b['centered'], b['grade'])
                tpl_rows.append(b)
    if a.tpl and not a.ass:
        issues = [i for r in tpl_rows for i in r['issues']]
        fails = [i for i in issues if i[0] == 'FAIL']
        if a.json:
            print(json.dumps({'ok': not fails, 'issues': issues}, ensure_ascii=False, indent=2))
        else:
            for lv, _, msg in issues:
                print('%s %s' % (lv, msg))
            print('PASS' if not fails else 'FAIL %d건' % len(fails))
        return 4 if fails else 0
    if not a.ass:
        ap.print_usage()
        return 2

    with io.open(a.ass, encoding='utf-8-sig') as f:
        # ASS 옆 fonts/ 는 늘 먼저 본다(N100 own_render 는 편 폴더에 fonts/ 를 복사해 둔다)
        dirs = tuple(a.fonts_dir) + (os.path.join(os.path.dirname(os.path.abspath(a.ass)), 'fonts'),)
        rows = check_ass(f.read(), a.font, set(a.skip_style), set(a.decor_style), dirs)
    fails = [r for r in rows if any(i[0] == 'FAIL' for i in r['issues'])]
    tpl_fails = [r for r in tpl_rows if any(i[0] == 'FAIL' for i in r['issues'])]
    warns = [i for r in rows + tpl_rows for i in r['issues'] if i[0] == 'WARN']
    est = sorted({r['style'] for r in rows if r['estimated']})
    jpg = None
    if not a.no_preview:
        at = a.at
        if at is None and rows:
            pick = fails[0] if fails else rows[0]
            at = (pick['start'] + pick['end']) / 2
        jpg = a.out or os.path.join(os.path.dirname(os.path.abspath(a.ass)), 'qc', 'shorts_safe.jpg')
        frame = None
        if a.video and at is not None:
            frame = grab_frame(a.video, at, jpg + '.frame.jpg')
        preview(rows + tpl_rows, jpg, frame, at)
        if frame and os.path.exists(frame):
            os.remove(frame)
    ok = not fails and not tpl_fails
    if a.json:
        print(json.dumps({'ok': ok, 'lines': len(rows), 'fail_lines': len(fails), 'preview': jpg,
                          'estimated_styles': est,
                          'fails': [{'start': r['start'], 'style': r['style'], 'text': r['text'],
                                     'box': r['box'], 'issues': r['issues']} for r in fails]
                          + [{'name': r['name'], 'box': r['box'], 'issues': r['issues']} for r in tpl_fails],
                          'warns': warns}, ensure_ascii=False, indent=2))
    else:
        for r in fails + tpl_fails:
            for lv, _, msg in r['issues']:
                print('%s %s' % (lv, msg))
        for _, _, msg in warns:
            print('WARN %s' % msg)
        if est:
            print('참고: 글꼴을 못 찾아 폭을 어림한 스타일 — %s (--fonts-dir 로 글꼴 폴더를 주면 실측)' % ', '.join(est))
        print('%s — 대사 %d줄 중 금지 구역 %d줄%s%s' % (
            'PASS' if ok else 'FAIL', len(rows), len(fails),
            (', 틀 글자 %d개 중 %d개' % (len(tpl_rows), len(tpl_fails))) if tpl_rows else '',
            (', 미리보기 ' + jpg) if jpg else ''))
    return 0 if ok else 4


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa
        print('오류: %s' % e, file=sys.stderr)
        sys.exit(1)
