# -*- coding: utf-8 -*-
"""유튜브 쇼츠 안전 영역 검사 — 글자가 쇼츠 UI 밑에 깔리면 실패.

    python scripts/shorts_safe.py <자막.ass> [--video 결과.mp4] [--at 초] [--out qc/shorts_safe.jpg] [--json]
    python scripts/shorts_safe.py --tpl 템플릿.json [--json]

왜 (2026-10-16, 소유주 지적): N100 엔진룸 'made' 내레이션 자막이 y=1745(1920 기준)라
  «유튜브 템플릿에 완전 가려져 안 보인다». 로보토리 'home' 1790, JP 'zou' 1600도 같았다.
  렌더 뒤 눈으로 보기 전에 ASS 글자 상자로 기계가 잡는다.

규격(캔버스 1080x1920, px) — N100 전달:
  1. 아래 UI y>1450: 글자 중심 y<=1450, 글자 상자 아래 끝<=1500.
  2. 오른쪽 버튼 열 x>=950, y 900~1700: 글자 금지. 가운데 정렬은 줄 폭<=860(x 110~970).
  3. 위 UI y<130: 글자 상자 위 끝>=130.
  4. 좌우: 글자는 x 60~1020 안.
  5. 효과 문구·딴지도 같은 선. 영상 상자(핵심 피사체)는 아래 끝>1450이면 경고만.

글자 폭은 글꼴을 열지 않고 어림한다: 한글·한자·가나 = 글꼴 크기 1배, 그 밖 0.6배, 공백 0.3배.
  실제보다 조금 넓게 잡는 쪽이다(놓치는 것보다 낫다). --font 를 주면 Pillow 로 실측한다.

종료 코드: 0 통과, 4 실패(금지 구역), 2 인자 오류, 1 기타.
"""
import argparse
import io
import json
import math
import os
import re
import subprocess
import sys

W, H = 1080, 1920
SAFE_CENTER_Y = 1450
SAFE_BOTTOM_Y = 1500
TOP_Y = 130
SIDE_L, SIDE_R = 60, 1020
RIGHT_COL = (950, 900, W, 1700)  # x0, y0, x1, y1
CENTER_MAX_W = 860
LINE_H = 1.2  # 줄 높이 = 글꼴 크기 x 1.2

# 미리보기에 칠할 금지 구역
ZONES = [
    ('bottom_ui', (0, SAFE_CENTER_Y, W, H)),
    ('right_buttons', RIGHT_COL),
    ('top_ui', (0, 0, W, TOP_Y)),
    ('side_left', (0, 0, SIDE_L, H)),
    ('side_right', (SIDE_R, 0, W, H)),
]


def _wide(ch):
    o = ord(ch)
    return (0x1100 <= o <= 0x11FF or 0x2E80 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF
            or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFF60 or 0x3000 <= o <= 0x303F)


def text_width(line, fs, font=None):
    if font:
        from PIL import ImageFont
        f = ImageFont.truetype(font, max(1, int(round(fs))))
        return f.getlength(line)
    w = 0.0
    for ch in line:
        w += fs * (1.0 if _wide(ch) else 0.3 if ch == ' ' else 0.6)
    return w


def text_box(x, y, an, fs, text, scale_x=100.0, scale_y=100.0, outline=0.0, font=None,
             wrap_w=None):
    """앵커(x, y)·정렬 an(1~9)·글꼴 크기로 글자 상자 (x0, y0, x1, y1)."""
    lines = [ln for ln in re.split(r'\\N|\n', text)] or ['']
    fsx, fsy = fs * scale_x / 100.0, fs * scale_y / 100.0
    widths = [text_width(ln, fsx, font) for ln in lines]
    n = len(lines)
    if wrap_w:  # libass 자동 줄바꿈 어림
        n = sum(max(1, math.ceil(w / wrap_w)) for w in widths)
        widths = [min(w, wrap_w) for w in widths]
    bw = max(widths) + 2 * outline
    bh = n * fsy * LINE_H + 2 * outline
    col = (an - 1) % 3  # 0 왼 1 가운데 2 오른
    row = (an - 1) // 3  # 0 아래 1 가운데 2 위
    x0 = x - (0, bw / 2, bw)[col]
    y0 = y - (bh, bh / 2, 0)[row]
    return (x0, y0, x0 + bw, y0 + bh)


def _hit(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def check_box(box, name='', kind='text', centered=False):
    """하나의 상자를 규격과 맞댄다. [(level, rule, msg)] — level FAIL/WARN."""
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


def ass_boxes(text, font=None):
    """ASS 대사마다 1080x1920 기준 글자 상자. [{start,end,style,text,box,centered}]"""
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
        b = text_box(x, y, an, fs, body, fscx, fscy, bord, font, wrap_w)
        box = (b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy)
        out.append({'start': t2s(ev.get('Start', '0:00:00.00')), 'end': t2s(ev.get('End', '0:00:00.00')),
                    'style': ev.get('Style', ''), 'text': body.replace('\\N', ' / '),
                    'box': [round(v, 1) for v in box], 'centered': an in (2, 5, 8)})
    return out


def check_ass(text, font=None, skip_styles=()):
    rows = []
    for b in ass_boxes(text, font):
        if b['style'] in skip_styles:
            continue
        name = '[%s %.2fs] %s' % (b['style'], b['start'], b['text'][:20])
        b['issues'] = check_box(b['box'], name, 'text', b['centered'])
        rows.append(b)
    return rows


# ---------- 템플릿 ----------

def check_template(tpl):
    """템플릿 정의를 규격과 맞댄다. tpl = {"elements": [...]} 또는 [...].
    요소: {"name", "kind": "text"|"video", "box": [x0,y0,x1,y1]}
       또는 글자 자리 {"name", "x", "y", "an"(기본 2), "fs", "text"(가장 긴 줄 예시) | "max_chars"(한글 기준), "lines"(기본 1)}
    좌표는 1080x1920 기준. [(level, rule, msg)]"""
    els = tpl.get('elements', []) if isinstance(tpl, dict) else tpl
    out = []
    for e in els:
        name = e.get('name', '?')
        kind = e.get('kind', 'text')
        if 'box' in e:
            box = tuple(float(v) for v in e['box'])
        else:
            sample = e.get('text') or ('가' * int(e.get('max_chars', 1)))
            sample = '\\N'.join([sample] * int(e.get('lines', 1)))
            box = text_box(float(e['x']), float(e['y']), int(e.get('an', 2)), float(e['fs']), sample,
                           float(e.get('scale_x', 100)), 100.0, float(e.get('outline', 0)))
        an = int(e.get('an', 2))
        out += check_box(box, name, kind, kind == 'text' and an in (2, 5, 8))
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
        live = at is None or r['start'] <= at < r['end']
        bad = any(i[0] == 'FAIL' for i in r.get('issues', []))
        if not live and not bad:
            continue
        col = (255, 40, 40, 255) if bad else (40, 255, 80, 255)
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
    ap.add_argument('--tpl', help='템플릿 정의 JSON')
    ap.add_argument('--video', help='렌더 결과 mp4 — 미리보기 바탕 프레임')
    ap.add_argument('--at', type=float, help='미리보기 시각(초). 없으면 첫 실패 대사, 없으면 첫 대사')
    ap.add_argument('--out', help='미리보기 jpg (기본 <ass 폴더>/qc/shorts_safe.jpg)')
    ap.add_argument('--no-preview', action='store_true')
    ap.add_argument('--font', help='글꼴 파일 — 주면 폭을 실측')
    ap.add_argument('--skip-style', action='append', default=[], help='검사에서 뺄 스타일 이름(반복 가능)')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    if a.tpl:
        with io.open(a.tpl, encoding='utf-8') as f:
            issues = check_template(json.load(f))
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
        rows = check_ass(f.read(), a.font, set(a.skip_style))
    fails = [r for r in rows if any(i[0] == 'FAIL' for i in r['issues'])]
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
        preview(rows, jpg, frame, at)
        if frame and os.path.exists(frame):
            os.remove(frame)
    if a.json:
        print(json.dumps({'ok': not fails, 'lines': len(rows), 'fail_lines': len(fails), 'preview': jpg,
                          'fails': [{'start': r['start'], 'style': r['style'], 'text': r['text'],
                                     'box': r['box'], 'issues': r['issues']} for r in fails]},
                         ensure_ascii=False, indent=2))
    else:
        for r in fails:
            for lv, _, msg in r['issues']:
                print('%s %s' % (lv, msg))
        print('%s — 대사 %d줄 중 금지 구역 %d줄%s' % ('PASS' if not fails else 'FAIL', len(rows), len(fails),
                                                (', 미리보기 ' + jpg) if jpg else ''))
    return 4 if fails else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa
        print('오류: %s' % e, file=sys.stderr)
        sys.exit(1)
