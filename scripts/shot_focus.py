# -*- coding: utf-8 -*-
"""원본 장면마다 **확대 창**을 정한다 — AGY 피사체 영수증 자리를 **내가 프레임을 보고** 채운다.

    1) python scripts/shot_focus.py sheets D:/volcano-runs/lsr01
         → 장면을 끊고 프레임판(_focus/sheet-NN.png)과 빈 적을거리(focus-boxes.json)를 만든다
    2) 클로드가 프레임판을 보고 focus-boxes.json 의 네모를 채운다 (한 칸 안 **백분율** 0~100)
    3) python scripts/shot_focus.py solve D:/volcano-runs/lsr01
         → 기하를 풀어 focus.json (장면별 창 크기 crop + 가로·세로 가운데 points)
    4) python scripts/myeonghwagwan_render.py plan_self.json --focus D:/volcano-runs/lsr01/focus.json

왜 (2026-10-09 소유주: "이제 agy 영수값 대신해서 저걸 만들어야지 — view_width·crop 샷별
    확대 창, flash_aliases. 이걸 클로드가 잡아줘야지 프레임전사보면서")

  엔진에는 장면마다 창을 따로 주는 길이 **두 개** 있다.
    crop        [가로비, 세로비]   장면마다 창 크기 + 가로·세로 가운데 (film_editor.py 1454~1477)
                  AGY 피사체 영수증에서만 나왔다 — 135~190% 확대 · 피사체를 창 정중앙에.
    view_width  가로비 하나         장면마다 가로만. 세로는 알맹이 전체, 남는 데는 검은 띠.
                  (film_editor.py 1478~1494) 사람이 손으로 화각을 정하는 길.
  우리는 AGY 영수증을 만들 수 없다(서버가 파일 해시로 검사한다 — shorts_framing.resolve 73줄).
  그래서 **판독만 갈아 끼운다** — AGY 가 프레임마다 피사체 네모를 주던 자리에, 내가 프레임판을
  보고 네모를 적는다. 기하(배율·창 위치·보간)는 엔진 규칙을 **읽고 다시 구현했다.**
  엔진 코드는 가져오지 않는다(소유주 지시: 형식과 결과만 맞춘다).

  ★AGY 와 다른 점은 하나다: AGY 는 **프레임마다** 보고 나는 **1.2초마다** 본다.
    그 사이는 렌더 식이 선형으로 잇는다(엔진도 같은 식으로 잇는다). 빠르게 움직이는 피사체는
    그 사이 창을 살짝 벗어날 수 있다 — 그래서 표본마다 둘레 여유(2.5%)를 두고, 짧은 장면은
    표본 하나로 창을 고정한다. 이 차이는 docs/myeonghwagwan-render-spec.md 에 적어 둔다.

  ★flash_aliases (shorts_framing.py 88~100): 한두 프레임짜리 장면은 **판독하지 않는다.**
    이웃 장면의 창을 그 장면 시각에 그대로 둔다(창 크기도 같다 — 렌더에서 창이 튀지 않는다).
    엔진은 서버가 side(next|prev)를 정해 주는데, 우리는 **긴 이웃**을 따른다.
"""
import argparse
import datetime as dt
import glob
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import sys
# ★콘솔 기본값(cp949)은 ✗ ⚠ 같은 기호를 못 쓴다 — 그러다 렌더 끝맣문에서
#   UnicodeEncodeError 로 전체가 죽었다(2026-10-09 실제). 출력만 고친다.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

MIDFORM = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIDFORM / 'scripts'))

# ── 엔진과 같은 규칙 ──────────────────────────────────────────────────────────
MIN_ZOOM, MAX_ZOOM = 1.35, 1.90   # 사장님 결정 2026-10-07 «135~190% 로 확대한다»
MARGIN = 0.025                    # 지킬 영역 둘레 여유 = ROI 크기의 2.5% (longform_reframe.solve)
FRACTION_EPS = 1e-9               # 988.0000000000002/988 같은 계산 오차만 1 로 본다
MEDIAN_WIN = 0.5                  # 가운데를 ±0.5초 중앙값으로 고른다

# ── 우리 쪽 선택 ──────────────────────────────────────────────────────────────
FLASH_FRAMES = 3                  # 이보다 짧은 장면은 판독하지 않고 이웃 창을 쓴다
SAMPLE_SEC = 1.2                  # 긴 장면은 이 간격으로 표본을 뽑는다
MAX_SAMPLES = 4                   # 한 장면 최대 표본 수
CELL_W, COLS, ROWS = 640, 3, 4    # 프레임판 한 칸 가로 · 칸 배치
NARR_RATE = 9.66                  # 명화관 TTS 속도(자/초) — paid 음성이 없을 때 길이 어림


def run(cmd, **kw):
    kw.setdefault('capture_output', True)
    kw.setdefault('text', True)
    kw.setdefault('encoding', 'utf-8')
    kw.setdefault('errors', 'replace')
    return subprocess.run([str(c) for c in cmd], **kw)


def probe(src):
    r = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
             'stream=width,height,r_frame_rate', '-show_entries', 'format=duration',
             '-of', 'json', src])
    j = json.loads(r.stdout)
    s = j['streams'][0]
    num, den = (s['r_frame_rate'].split('/') + ['1'])[:2]
    return int(s['width']), int(s['height']), float(num) / float(den), float(j['format']['duration'])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 20), b''):
            h.update(blk)
    return h.hexdigest()


def newest(pattern):
    hits = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    return hits[0] if hits else None


def load(path, fb=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return fb


def dump(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding='utf-8')


# ───────────────────────────────────────────────── 쓰이는 구간 · 장면 경계
def used_windows(run_dir, plan):
    """편집표가 **실제로 쓰는** 원본 구간 [(t0, t1), ...]. 그 안의 장면만 판독한다.

    해설 그림 길이는 볼케이노가 산 음성 길이에서 그대로 잰다(돈을 안 쓴다).
    paid 음성이 없으면 글자수 ÷ 9.66자/초로 어림한다 — 조금 넉넉히 잡으면 장면 몇 개를
    더 읽을 뿐 해는 없다.
    """
    import myeonghwagwan_render as R
    nar = {n['id']: n for n in plan['narration']}
    try:
        reuse = R.paid_narration(plan, plan['narration'])
    except Exception:
        reuse = {}
    out = []
    for i, s in enumerate(plan['sequence']):
        if 'source_in' in s:
            out.append([float(s['source_in']), float(s['source_out'])])
            continue
        n = nar[s['narration']]
        if n['id'] in reuse:
            _, a0, b0, total = reuse[n['id']]
            a1 = max(0.0, a0 - R.NAR_HEAD)
            b1 = min(total, b0 + R.NAR_TAIL) if total else b0 + R.NAR_TAIL
            dur = math.ceil((b1 - a1) * R.FPS) / R.FPS
        else:
            dur = len(''.join(n.get('cards') or [n.get('text', '')])) / NARR_RATE + 0.5
        t0 = s.get('pic_in', n.get('source'))
        if t0 is None:
            nxt = next((x for x in plan['sequence'][i + 1:] if 'source_in' in x), None)
            t0 = max(0.0, float(nxt['source_in']) - dur) if nxt else 0.0
        out.append([float(t0), float(t0) + dur])
    return merged(out)


def merged(spans):
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [[round(a, 4), round(b, 4)] for a, b in out]


def read_cuts(run_dir, src, spans, fps):
    """장면 경계(절대 원본 초). 볼케이노가 이미 **잰 값이 있으면 그것이 정답이다.**

    볼케이노는 회차 폴더에 장면 경계를 남긴다(edits/*/source-shots.json · measurements.json
    의 source_shots). 같은 원본을 또 재면 값이 어긋날 수 있으니 있는 것을 쓴다.
    없으면(볼케이노가 안 본 원본) ffmpeg 장면 검출로 우리가 잰다.
    """
    for pat in ('/edits/*/source-shots.json', '/edits/*/measurements.json'):
        p = newest(str(run_dir) + pat)
        if not p:
            continue
        d = load(p) or {}
        d = d.get('source_shots', d)
        cuts = d.get('cuts')
        if cuts:
            return sorted(float(c) for c in cuts), os.path.basename(p)
    cuts = []
    for a, b in spans:
        r = run(['ffmpeg', '-hide_banner', '-nostats', '-ss', '%.3f' % a, '-i', src,
                 '-t', '%.3f' % (b - a), '-an', '-vf',
                 "select='gt(scene,0.35)',metadata=print:file=-", '-f', 'null', '-'])
        for m in re.finditer(r'pts_time:([\d.]+)', (r.stdout or '') + (r.stderr or '')):
            cuts.append(a + float(m.group(1)))
    return sorted(cuts), 'ffmpeg 장면검출'


def shot_list(spans, cuts, fps):
    """쓰이는 구간을 장면 경계로 끊는다. 장면 id 는 **엔진과 같은 '%.3f' % 시작초**다.

    ★왜 id 를 같게 쓰나: 엔진은 배율을 id 의 sha256 에서 뽑는다(longform_reframe.solve —
      기계·재실행에 흔들리지 않는 난수). cam_plain.json 을 보면 장면 키가 '103.900' 꼴이다.
      id 가 같으면 **같은 상한에서 같은 배율**이 나온다 — AGY 를 못 써도 가장 가까운 값이다.
    """
    out = []
    for a, b in spans:
        edges = [a] + [c for c in cuts if a + 1e-6 < c < b - 1e-6] + [b]
        for t0, t1 in zip(edges, edges[1:]):
            nf = int(round((t1 - t0) * fps))
            if nf < 1:
                continue
            out.append({'id': '%.3f' % t0, 'start': round(t0, 4), 'end': round(t1, 4),
                        'frames': nf, 'flash': nf < FLASH_FRAMES})
    return out


def sample_times(shot, fps):
    a, b = shot['start'], shot['end']
    span = b - a
    n = max(1, min(MAX_SAMPLES, int(span / SAMPLE_SEC) + 1))
    if n == 1:
        return [round(a + span / 2, 3)]
    # 머리·꼬리를 조금 안쪽으로 들인다(경계 프레임은 넘어가는 컷일 수 있다)
    pad = min(0.08, span / 8)
    return [round(a + pad + (span - 2 * pad) * i / (n - 1), 3) for i in range(n)]


# ───────────────────────────────────────────────── 프레임판
def grab(src, t, path):
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % t, '-i', src,
         '-frames:v', '1', '-q:v', '2', path])
    return os.path.exists(path)


def build_sheets(cells, out_dir, size):
    """칸마다 10% 격자와 눈금 번호를 그린다 — 내가 **백분율로 읽을 수 있게.**"""
    from PIL import Image, ImageDraw, ImageFont
    sw, sh = size
    cw = CELL_W
    ch = int(round(CELL_W * sh / sw))
    bar = 26
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 15)
        tiny = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 12)
    except OSError:
        font = tiny = ImageFont.load_default()
    sheets = []
    per = COLS * ROWS
    for si in range(0, len(cells), per):
        chunk = cells[si:si + per]
        rows = int(math.ceil(len(chunk) / float(COLS)))
        width = COLS * (cw + 8) + 8
        height = rows * (ch + bar + 8) + 8
        sheet = Image.new('RGB', (width, height), (18, 18, 20))
        d = ImageDraw.Draw(sheet)
        for k, c in enumerate(chunk):
            col, row = k % COLS, k // COLS
            x0 = 8 + col * (cw + 8)
            y0 = 8 + row * (ch + bar + 8)
            try:
                im = Image.open(c['jpg']).convert('RGB').resize((cw, ch), Image.LANCZOS)
            except Exception:
                im = Image.new('RGB', (cw, ch), (60, 0, 0))
            sheet.paste(im, (x0, y0 + bar))
            d.text((x0 + 4, y0 + 5), '%s  t=%.2f  %s' % (c['key'], c['t'], c['note']),
                   fill=(255, 230, 120), font=font)
            for p in range(1, 10):
                gx = x0 + int(cw * p / 10.0)
                gy = y0 + bar + int(ch * p / 10.0)
                shade = (255, 255, 255) if p == 5 else (120, 200, 255)
                d.line([(gx, y0 + bar), (gx, y0 + bar + ch)], fill=shade, width=1)
                d.line([(x0, gy), (x0 + cw, gy)], fill=shade, width=1)
                d.text((gx + 2, y0 + bar + 2), str(p * 10), fill=(120, 230, 255), font=tiny)
                d.text((x0 + 3, gy + 1), str(p * 10), fill=(120, 230, 255), font=tiny)
            d.rectangle([x0, y0 + bar, x0 + cw - 1, y0 + bar + ch - 1], outline=(200, 200, 200))
        p = Path(out_dir) / ('sheet-%02d.png' % (si // per + 1))
        sheet.save(p)
        sheets.append({'file': p.name, 'cells': [c['key'] for c in chunk]})
    return sheets


def cmd_sheets(a):
    run_dir = Path(a.run_dir)
    plan_path = a.plan or newest(str(run_dir) + '/plan_self.json') or newest(str(run_dir) + '/plan*.json')
    if not plan_path:
        sys.exit('plan 을 못 찾았다 — 먼저 myeonghwagwan_plan.py 를 돌려라')
    plan = load(plan_path)
    src = plan['source']
    sw, sh, fps, dur = probe(src)
    spans = used_windows(run_dir, plan)
    cuts, how = read_cuts(run_dir, src, spans, fps)
    shots = shot_list(spans, cuts, fps)
    flash = [s for s in shots if s['flash']]
    read = [s for s in shots if not s['flash']]
    print('원본 %dx%d %.3ffps · 쓰이는 구간 %d개 %.1f초'
          % (sw, sh, fps, len(spans), sum(b - a for a, b in spans)))
    print('장면 경계 %d개 (%s) → 장면 %d개 · 판독 %d · 섬광(이웃 창) %d'
          % (len(cuts), how, len(shots), len(read), len(flash)))

    out_dir = run_dir / '_focus'
    out_dir.mkdir(exist_ok=True)
    cells = []
    for s in read:
        for i, t in enumerate(sample_times(s, fps)):
            jpg = out_dir / ('%s_%d.jpg' % (s['id'].replace('.', '_'), i))
            if not jpg.exists():
                grab(src, t, jpg)
            cells.append({'key': '%s#%d' % (s['id'], i), 'jpg': str(jpg), 't': t,
                          'note': '%.2fs' % (s['end'] - s['start'])})
    print('프레임 %d장 뽑았다 → 판 만든다' % len(cells))
    sheets = build_sheets(cells, out_dir, (sw, sh))

    dump(run_dir / 'focus-todo.json',
         {'plan': str(plan_path), 'source': src, 'source_sha256': sha256_file(src),
          'size': [sw, sh], 'fps': fps, 'spans': spans, 'cuts_from': how,
          'shots': shots, 'sheets': sheets,
          'samples': dict((c['key'], c['t']) for c in cells)})

    bp = run_dir / 'focus-boxes.json'
    old = (load(bp) or {}).get('boxes') or {}
    boxes = dict((c['key'], old.get(c['key'])) for c in cells)
    dump(bp, {
        '__': '칸 안 **백분율** [왼쪽, 위, 오른쪽, 아래] 0~100. 한 칸에 사람이 둘이면 [[..],[..]].',
        '__2': '해설이 가리키는 피사체·행동을 적는다. 얼굴만이 아니라 몸통까지 — 엔진도 그렇게 쓴다.',
        '__3': '빈 칸(null)이 하나라도 남으면 solve 가 선다.',
        'boxes': boxes})
    print('판 %d장: %s' % (len(sheets), out_dir))
    print('적을거리: %s  (빈 칸 %d개)' % (bp, sum(1 for v in boxes.values() if not v)))
    return 0


# ───────────────────────────────────────────────── 기하 풀기
def union(boxes, w, h):
    if not boxes:
        raise ValueError('피사체 네모가 없다 — 가운데를 짐작하지 않는다')
    for b in boxes:
        if len(b) != 4 or not (0 <= b[0] < b[2] <= w and 0 <= b[1] < b[3] <= h):
            raise ValueError('네모가 원본 안에 있어야 한다: %r' % (b,))
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def zoom_fraction(identity):
    """기계·재실행에 흔들리지 않는 난수 — 엔진과 **같은 식**이다."""
    return int(hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16], 16) / float(2 ** 64 - 1)


def median(vals):
    vals = sorted(vals)
    n = len(vals)
    return (vals[(n - 1) // 2] + vals[n // 2]) / 2.0


def solve_shot(width, height, samples, identity, aspect, min_zoom=MIN_ZOOM, max_zoom=MAX_ZOOM):
    """알맹이 네모 안(width·height)에서 배율과 창 위치를 푼다. 엔진 규칙을 다시 구현한 것.

    samples: [{'t': 초, 'boxes': [[왼,위,오른,아래], ...]}, ...]  (알맹이 기준 좌표)
    돌려주는 것: {'zoom', 'window': (cw, ch), 'rows': [{'t', 'x', 'y'}], 'fallback'}
    """
    ratio = aspect[0] / float(aspect[1])
    base_w = min(float(width), float(height) * ratio)
    base_h = base_w / ratio
    rows, upper, last = [], max_zoom, -1.0
    for s in samples:
        t = float(s['t'])
        if t <= last:
            raise ValueError('표본 시각이 커지지 않는다')
        last = t
        b = union(s['boxes'], width, height)
        px, py = (b[2] - b[0]) * MARGIN, (b[3] - b[1]) * MARGIN
        safe = [max(0, b[0] - px), max(0, b[1] - py), min(width, b[2] + px), min(height, b[3] + py)]
        upper = min(upper, base_w / (safe[2] - safe[0]), base_h / (safe[3] - safe[1]))
        rows.append({'t': t, 'safe': safe})
    if upper < 1 - 1e-9:
        raise ValueError('피사체가 창 하나에 안 들어간다 — 다른 장면을 쓰거나 네모를 줄여라')
    fallback = upper < min_zoom
    zoom = max(1.0, upper) if fallback else min_zoom + (upper - min_zoom) * zoom_fraction(identity)
    cw, ch = base_w / zoom, base_h / zoom
    for row in rows:
        near = [r for r in rows if abs(r['t'] - row['t']) <= MEDIAN_WIN + 1e-9]
        cx = median([(r['safe'][0] + r['safe'][2]) / 2 for r in near])
        cy = median([(r['safe'][1] + r['safe'][3]) / 2 for r in near])
        b = row['safe']
        lo_x, hi_x = max(0, b[2] - cw), min(width - cw, b[0])
        lo_y, hi_y = max(0, b[3] - ch), min(height - ch, b[1])
        if lo_x > hi_x + 1e-7 or lo_y > hi_y + 1e-7:
            raise ValueError('창을 둘 자리가 없다')
        row['x'] = max(lo_x, min(hi_x, cx - cw / 2))
        row['y'] = max(lo_y, min(hi_y, cy - ch / 2))
    return {'zoom': zoom, 'window': (cw, ch), 'rows': rows,
            'fallback': 'preserve_required_region_below_minimum' if fallback else None}


def fraction(v):
    return 1.0 if 1.0 < v <= 1.0 + FRACTION_EPS else v


def decimate(points):
    """같은 직선 위 가운데 점을 뺀다 — 렌더 식이 선형 보간이라 결과는 같다(엔진과 같은 정리)."""
    out = []
    for p in points:
        out.append(p)
        while len(out) >= 3:
            a, b, d = out[-3:]
            if d[0] == a[0]:
                break
            if any(abs(b[k] - (a[k] + (d[k] - a[k]) * (b[0] - a[0]) / (d[0] - a[0]))) > 1e-9
                   for k in (1, 2)):
                break
            out.pop(-2)
    return out


def cmd_solve(a):
    run_dir = Path(a.run_dir)
    todo = load(run_dir / 'focus-todo.json')
    if not todo:
        sys.exit('focus-todo.json 이 없다 — 먼저 sheets 를 돌려라')
    bx = (load(run_dir / 'focus-boxes.json') or {}).get('boxes') or {}
    # ★기계 판독(얼굴)이 있으면 **그것이 먼저**다 — 촘촘해서(0.3초) 빠른 움직임을 잡는다.
    #   얼굴이 없는 장면(화면·손·물건·뒤통수)만 내가 프레임판을 보고 적은 값을 쓴다.
    auto = {}
    if not a.hand_only:
        auto = dict(((load(run_dir / 'focus-auto.json') or {}).get('shots')) or {})
    # ★기계가 **엉뙡한 사람**을 고른 장면은 내가 집어 넣는다(review 참고).
    #   focus-boxes.json 의 "override": ["19.833", ...] — 그 장면만 손으로 적은 네모를 쓴다.
    ovr = (load(run_dir / 'focus-boxes.json') or {}).get('override') or []
    for sid in ovr:
        auto.pop(sid, None)
    if ovr:
        print('손으로 덮어쓴 장면 %d개: %s' % (len(ovr), ', '.join(ovr)))
    sw, sh = todo['size']
    need_hand = [s['id'] for s in todo['shots'] if not s['flash'] and s['id'] not in auto]
    missing = [k for k, v in bx.items() if not v and k.split('#')[0] in need_hand]
    if not bx and not auto:
        sys.exit('읽은 네모가 없다 — detect 를 돌리거나 프레임판을 보고 적어라')
    if missing:
        sys.exit('빈 칸 %d개가 남았다 — 프레임판을 보고 채워라: %s'
                 % (len(missing), ', '.join(missing[:6])))
    aspect = tuple(int(v) for v in a.aspect.split(':'))

    # 알맹이 네모 — 렌더러와 **같은 방법**으로 잰다(최빈값 cropdetect)
    import myeonghwagwan_render as R
    segs = [{'pic_in': t0, 'dur': t1 - t0} for t0, t1 in todo['spans']]
    content = R.measure_content(todo['source'], segs) or (sw, sh, 0, 0)
    cwid, chei, cx0, cy0 = content
    print('알맹이 네모 %dx%d +%d+%d · 창 비율 %d:%d' % (cwid, chei, cx0, cy0, aspect[0], aspect[1]))

    shots = dict((s['id'], dict(s)) for s in todo['shots'])
    order = [s['id'] for s in todo['shots']]
    samples = todo['samples']
    solved = {}
    for sid in order:
        s = shots[sid]
        if s['flash']:
            continue
        rows = []
        # ★표본 번호가 아니라 **시각 순**으로 줄 세운다. recheck 가 끼워 넣은 표본
        #   (#m0 …)은 번호가 뒤여도 시각은 가운데다 — 번호로 세우면 시각이 거꾸로 간다.
        keys = sorted((k for k in samples if k.split('#')[0] == sid),
                      key=lambda k: samples[k])
        src_rows = ([{'t': r['t'], 'raw': r['boxes']} for r in auto[sid]] if sid in auto
                    else [{'t': samples[k], 'raw': bx[k]} for k in keys])
        for r0 in src_rows:
            k = sid
            raw = r0['raw']
            boxes = raw if isinstance(raw[0], (list, tuple)) else [raw]
            local = []
            for b in boxes:
                # 백분율 → 원본 화소 → 알맹이 안으로 자른다(작성자가 뺀 데는 쓰지 않는다)
                px = [b[0] / 100.0 * sw, b[1] / 100.0 * sh, b[2] / 100.0 * sw, b[3] / 100.0 * sh]
                cl = [max(px[0], cx0), max(px[1], cy0),
                      min(px[2], cx0 + cwid), min(px[3], cy0 + chei)]
                if cl[0] >= cl[2] or cl[1] >= cl[3]:
                    sys.exit('%s: 네모가 알맹이 네모 밖이다 %r' % (k, b))
                local.append([cl[0] - cx0, cl[1] - cy0, cl[2] - cx0, cl[3] - cy0])
            rows.append({'t': r0['t'], 'boxes': local})
        try:
            plan = solve_shot(cwid, chei, rows, sid, aspect)
        except ValueError as e:
            sys.exit('%s: %s' % (sid, e))
        cw, ch = plan['window']
        pts = decimate([[round(r['t'], 4),
                         round((r['x'] + cx0 + cw / 2) / sw, 6),
                         round((r['y'] + cy0 + ch / 2) / sh, 6)] for r in plan['rows']])
        solved[sid] = {'id': sid, 'start': s['start'], 'end': s['end'],
                       'zoom': round(plan['zoom'], 5),
                       'crop': [fraction(cw / sw), fraction(ch / sh)],
                       'points': pts, 'fallback': plan['fallback'], 'same_as': None}

    # ── flash_aliases: 한두 프레임 장면은 **긴 이웃**의 창을 그 장면 시각에 둔다
    for i, sid in enumerate(order):
        s = shots[sid]
        if not s['flash']:
            continue
        prev = next((order[j] for j in range(i - 1, -1, -1) if order[j] in solved), None)
        nxt = next((order[j] for j in range(i + 1, len(order)) if order[j] in solved), None)
        if prev is None and nxt is None:
            sys.exit('%s: 섬광 장면인데 판독한 이웃이 없다' % sid)
        if prev is None:
            side = 'next'
        elif nxt is None:
            side = 'prev'
        else:
            side = 'prev' if shots[prev]['frames'] >= shots[nxt]['frames'] else 'next'
        owner = solved[prev if side == 'prev' else nxt]
        x, y = owner['points'][-1 if side == 'prev' else 0][1:]
        solved[sid] = {'id': sid, 'start': s['start'], 'end': s['end'],
                       'zoom': owner['zoom'], 'crop': list(owner['crop']),
                       'points': [[s['start'], x, y]], 'fallback': owner['fallback'],
                       'same_as': owner['id'], 'side': side}

    out = {'source': todo['source'], 'source_sha256': todo['source_sha256'],
           'size': [sw, sh], 'content': list(content), 'fps': todo['fps'],
           'aspect': list(aspect), 'zoom_range': [MIN_ZOOM, MAX_ZOOM], 'sample_sec': SAMPLE_SEC,
           'read_by': 'claude(frame sheets)',
           'read_at': dt.datetime.now().isoformat(timespec='seconds'),
           'shots': [solved[sid] for sid in order if sid in solved]}
    p = Path(a.out) if a.out else run_dir / 'focus.json'
    dump(p, out)
    zs = [s['zoom'] for s in out['shots'] if not s['same_as']]
    fb = [s['id'] for s in out['shots'] if s['fallback']]
    print('장면 %d개 · 배율 %.2f~%.2f (평균 %.2f) · 섬광 %d · 하한 미달 %d'
          % (len(out['shots']), min(zs), max(zs), sum(zs) / len(zs),
             sum(1 for s in out['shots'] if s['same_as']), len(fb)))
    if fb:
        print('  하한(135%) 미달 — 피사체가 커서 확대를 못 했다: ' + ', '.join(fb[:8]))
    print(p)
    return 0


# ───────────────────────────────────────────────── 기계 판독(얼굴) — 린박스 세션 것을 쓴다
# ★2026-10-09 소유주: "린박스 세션에서 먼저 정리한 값이 있는지 확인하고 개발하자."
#   있었다 — scripts/rinbox_faces.py 가 **초당 10프레임**으로 YuNet 얼굴을 잡고,
#   한 샷의 화자를 «말하는 동안 입이 움직인 얼굴»로 고른다(AGY 화자 판독의 자리).
#   거기서 가져다 쓰는 것: read_range(프레임 읽기) · mouth_patch(입 조각) · 고르는 규칙 · 상수.
#   여기서 더하는 것 하나: **세로**. 린박스 그림 창은 세로가 통짜라 cx 만 있으면 됐지만
#   명화관은 정사각형 창이라 위·아래도 정해야 한다(AGY crop 은 가로·세로 둘 다 준다).
FACE_PAD = (0.60, 0.45, 1.15)   # 얼굴 네모 → 머리+윗몸: 좌우 ×0.60 · 위 ×0.45 · 아래 ×1.15
# ★세로를 얼굴 높이의 3.5배로 주었더니 거의 모든 장면에서 네모가 창 높이에 꿉 차
#   확대가 1.0 으로 눈렸다(2026-10-09 실측: 75장면 중 58장면이 하한 미달, 평균 1.16).
#   머리+윗몸은 얼굴 높이의 대략 2.6배·폭의 2.2배다.


def _tracks_xy(dets, grays, speech, rf):
    """린박스 tracks_in 과 같은 묶음 규칙이되 **네모 전체(x·y)** 를 남긴다."""
    import numpy as np
    tracks = []
    for i, faces in enumerate(dets):
        for f in faces:
            c = f[0] + f[2] / 2
            best = min(tracks, key=lambda t: abs(t['c'][-1] - c), default=None)
            if best is not None and abs(best['c'][-1] - c) < max(0.08 * rf.W, f[2] * 0.6) and best['i'][-1] != i:
                tr = best
            else:
                tr = {'i': [], 'c': [], 'w': [], 'rect': [], 'patch': []}
                tracks.append(tr)
            tr['i'].append(i)
            tr['c'].append(c)
            tr['w'].append(f[2])
            tr['rect'].append((float(f[0]), float(f[1]), float(f[2]), float(f[3])))
            tr['patch'].append(rf.mouth_patch(grays[i], f))
            tr.setdefault('sharp', []).append(rf.sharpness(grays[i], f))
    for tr in tracks:
        moves = []
        for k in range(1, len(tr['i'])):
            a, b = tr['patch'][k - 1], tr['patch'][k]
            if a is None or b is None or tr['i'][k] - tr['i'][k - 1] > 2 or not speech[tr['i'][k]]:
                continue
            moves.append(float(np.mean(np.abs(a - b))) / (np.std(a) + 8.0))
        tr['motion'] = float(np.mean(moves)) if len(moves) >= 2 else 0.0
        tr['size'] = float(np.median(tr['w']))
        sharp = [s for s in tr.get('sharp') or [] if s is not None]
        tr['sharp'] = float(np.median(sharp)) if sharp else 0.0
    return tracks


def _subject_box(rect, rw, rh, base_w=None, base_h=None):
    """얼굴 네모 → 머리+윗몸 네모(판독 화소). 화면 밖으로는 안 나간다.

    ★여유는 **창 안에 들어갈 만큼만** 준다. 얼굴이 클수록(클로즈업) 여유를 줄인다 —
      얼굴 폭의 2.7배를 그대로 주면 큰 클로즈업에서 네모가 정사각형 창보다 넓어져
      «창 하나에 안 들어간다»로 멈춘다(2026-10-09 1.467 장면에서 실제로 멈췄다).
      네모가 뜻하는 것은 «반드시 보여야 할 것»이다. 클로즈업에서 반드시 보여야 할 것은
      얼굴이지 어깨가 아니다 — 어깨는 잘려도 된다.
    """
    x, y, w, h = rect
    sx, sy, sb = FACE_PAD
    px, py, pb = w * sx, h * sy, h * sb
    if base_w:
        room = max(0.0, base_w * 0.95 - w) / 2.0     # 좌우로 나눠 쓸 여유
        px = min(px, room)
    if base_h:
        room = max(0.0, base_h * 0.95 - h)
        if py + pb > room:                            # 위:아래 = 0.65:1.90 으로 나눈다
            k = room / (py + pb) if (py + pb) else 0.0
            py, pb = py * k, pb * k
    return [max(0.0, x - px), max(0.0, y - py),
            min(float(rw), x + w + px), min(float(rh), y + h + pb)]


def cmd_detect(a):
    """장면마다 얼굴을 **촘촘히** 읽어 네모를 적는다. 얼굴이 없는 장면은 손으로 읽게 남긴다.

    왜 촘촘히: 1.2초 표본만으로는 빠르게 오가는 얼굴을 놓친다 — 2026-10-09 실측에서
      186.633 장면의 얼굴이 두 표본 사이에서 왼쪽으로 갔다 돌아와, 가운데 시각의 창이
      엉뚱한 데 놓였다(볼케이노 완성본은 그 시각에 얼굴이 또렷했다).
    """
    import numpy as np
    import cv2
    run_dir = Path(a.run_dir)
    todo = load(run_dir / 'focus-todo.json')
    if not todo:
        sys.exit('focus-todo.json 이 없다 — 먼저 sheets 를 돌려라')
    import rinbox_faces as rf
    sw, sh = todo['size']
    aspect = tuple(int(v) for v in a.aspect.split(':'))
    import myeonghwagwan_render as R
    segs = [{'pic_in': t0, 'dur': t1 - t0} for t0, t1 in todo['spans']]
    content = R.measure_content(todo['source'], segs) or (sw, sh, 0, 0)
    cwid, chei, cx0, cy0 = content
    ratio = aspect[0] / float(aspect[1])
    base_w = min(float(cwid), float(chei) * ratio)
    base_h = base_w / ratio
    plan = json.loads(Path(todo['plan']).read_text(encoding='utf-8'))
    words = json.loads(Path(plan['transcript']).read_text(encoding='utf-8'))
    auto, hand, log = {}, [], []
    for s in todo['shots']:
        if s['flash']:
            continue
        t0, t1 = s['start'], s['end']
        try:
            frames = rf.read_range(todo['source'], t0, t1)
        except Exception as e:
            hand.append((s['id'], '프레임을 못 읽었다: %s' % e))
            continue
        n = len(frames)
        if n == 0:
            hand.append((s['id'], '프레임 0장'))
            continue
        rh_, rw_ = frames.shape[1], frames.shape[2]
        det = cv2.FaceDetectorYN.create(str(rf.MODEL), '', (rw_, rh_), 0.6, 0.3, 50)
        dets, grays = [], []
        for fr in frames:
            _, faces = det.detect(fr)
            faces = [] if faces is None else [f for f in faces if f[2] >= rf.MIN_FACE * rf.W]
            dets.append(faces)
            grays.append(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY))
        times = [t0 + i / rf.FPS for i in range(n)]
        speech = [any(w[0] <= t < w[1] + 0.1 for w in words) for t in times]
        trs = [t for t in _tracks_xy(dets, grays, speech, rf) if len(t['i']) >= rf.MIN_PRESENT * n]
        # ★화면 가장자리(1%·99%)에 걸친 **잘린 얼굴**은 후보에서 뺀다.
        #   앞에 걸친 흐린 뒤통수의 흐림 잡음이 «입 움직임»으로 잡혔다
        #   (린박스 세션 78ja 실측 · 2026-10-09 그쪽에서 알려왔다).
        import numpy as _np
        inner = [t for t in trs
                 if _np.median([r[0] for r in t['rect']]) > rw_ * 0.01
                 and _np.median([r[0] + r[2] for r in t['rect']]) < rw_ * 0.99]
        if inner:
            trs = inner
        # ★어깨너머 앞사람 빼기 — 린박스 세션이 6편을 눈으로 검증해 준 규칙(2026-10-09).
        #   가장 선명한 얼굴보다 65% 미만으로 흐리**면서** 크기는 1.3배 넘게 큰 얼굴만 뺀다.
        #   흐림만으로 빼면 먼 데 있는 작은 주인공까지 버린다 — «흐리고 크다»가 앞사람의 표식이다.
        if len(trs) > 1:
            top = max(t['sharp'] for t in trs)
            # ★크기 조건은 뺀다. 린박스는 «흐리고 큰» 것만 뺀다는데, 명화관 11.900 에서는
            #   흐린 방해물이 주인공보다 **작아서** 그 그물을 빠져나갔다(2026-10-09 실측).
            #   재는 법은 린박스 것(안쪽 60% · 대비로 나눔)이 더 낫다 — 그건 그대로 쓴다.
            keep = [t for t in trs if not (top > 0 and t['sharp'] < top * 0.65)]
            if keep:
                trs = keep
        if not trs:
            hand.append((s['id'], '얼굴 없음'))
            continue
        # 창(알맹이 기준)을 판독 화소로 환산 — 다 들어가는지 보려면 같은 자로 재야 한다
        scale = rw_ / float(sw)
        win_w, win_h = base_w * scale, base_h * scale
        boxes_by_frame = {}
        pick = None
        lo = min(np.median([r[0] for r in t['rect']]) for t in trs)
        hi = max(np.median([r[0] + r[2] for r in t['rect']]) for t in trs)
        top = min(np.median([r[1] for r in t['rect']]) for t in trs)
        bot = max(np.median([r[1] + r[3] for r in t['rect']]) for t in trs)
        group = (hi - lo) <= win_w * 0.9 and (bot - top) <= win_h * 0.55
        if group and len(trs) > 1:
            why = '%d명 다 들어감' % len(trs)
        else:
            by_motion = sorted(trs, key=lambda t: -t['motion'])
            if by_motion[0]['motion'] > 0 and (len(by_motion) < 2
                                               or by_motion[0]['motion'] > 1.3 * by_motion[1]['motion']):
                pick, why = by_motion[0], '입 움직임 %.2f' % by_motion[0]['motion']
            else:
                pick, why = max(trs, key=lambda t: t['size']), '가장 큰 얼굴'
            group = False
        def build(use):
            out = {}
            for tr in use:
                for k, i in enumerate(tr['i']):
                    out.setdefault(i, []).append(
                        _subject_box(tr['rect'][k], rw_, rh_, win_w, win_h))
            return out

        def fits(by_frame):
            # ★묶음은 **프레임마다** 창에 들어가야 한다. 가운데값만 보면
            #   두 사람이 벌어졌다 붙는 장면에서 어느 순간 창을 넘는다(139.367 실측).
            for bs in by_frame.values():
                if (max(b[2] for b in bs) - min(b[0] for b in bs) > win_w * 0.98
                        or max(b[3] for b in bs) - min(b[1] for b in bs) > win_h * 0.98):
                    return False
            return True

        boxes_by_frame = build(trs if group else [pick])
        if group and not fits(boxes_by_frame):
            by_motion = sorted(trs, key=lambda t: -t['motion'])
            pick = (by_motion[0] if by_motion[0]['motion'] > 0
                    and (len(by_motion) < 2 or by_motion[0]['motion'] > 1.3 * by_motion[1]['motion'])
                    else max(trs, key=lambda t: t['size']))
            why += ' → 창을 넘어 한 사람만'
            group = False
            boxes_by_frame = build([pick])
        have = sorted(boxes_by_frame)
        if not have:
            hand.append((s['id'], '고른 얼굴의 네모가 없다'))
            continue
        step = max(1, int(round(a.step * rf.FPS)))
        rows = []
        for i in range(have[0], have[-1] + 1, step):
            j = min(have, key=lambda q: abs(q - i))
            if abs(j - i) > rf.FPS * 0.6:
                continue
            bs = boxes_by_frame[j]
            rows.append({'t': round(times[i], 3),
                         'boxes': [[b[0] / rw_ * 100, b[1] / rh_ * 100,
                                    b[2] / rw_ * 100, b[3] / rh_ * 100] for b in bs]})
        if len(rows) >= 1 and rows[-1]['t'] < t1 - 1.0 / rf.FPS and have[-1] not in [0]:
            rows.append({'t': round(times[have[-1]], 3),
                         'boxes': [[b[0] / rw_ * 100, b[1] / rh_ * 100,
                                    b[2] / rw_ * 100, b[3] / rh_ * 100]
                                   for b in boxes_by_frame[have[-1]]]})
        seen, keep = set(), []
        for r in sorted(rows, key=lambda r: r['t']):
            if r['t'] in seen:
                continue
            seen.add(r['t'])
            keep.append(r)
        auto[s['id']] = keep
        log.append('  %-10s %4.2f초 · 얼굴 %d · %s · 표본 %d' % (s['id'], t1 - t0, len(trs), why, len(keep)))
    dump(run_dir / 'focus-auto.json',
         {'source': todo['source'], 'size': [sw, sh], 'content': list(content),
          'aspect': list(aspect), 'step': a.step, 'face_pad': list(FACE_PAD),
          'read_by': 'rinbox_faces(YuNet) + shot_focus',
          'read_at': dt.datetime.now().isoformat(timespec='seconds'),
          'shots': auto, 'needs_hand': [{'id': i, 'why': w} for i, w in hand]})
    print('\n'.join(log[:14]))
    if len(log) > 14:
        print('  … %d개 더' % (len(log) - 14))
    print('기계가 읽은 장면 %d · 손으로 읽어야 할 장면 %d' % (len(auto), len(hand)))
    for i, w in hand[:12]:
        print('   손: %-10s %s' % (i, w))
    print(run_dir / 'focus-auto.json')
    return 0


def cmd_review(a):
    """기계가 고른 피사체와 **실제로 쓰일 창**을 장면마다 그려 둔다 — 내가 틀린 것만 집어내게.

    왜 (2026-10-09 실측): 얼굴 판독은 대개 맞지만 가끔 **엉뚱한 사람**을 고른다.
      19.833 장면에서 배경의 남자를 골라 창이 주인공(오른쪽 교환원)을 비켜 갔다.
      기계는 촘촘히 보고, 틀린 자리는 내가 집는다 — 그게 AGY 자리에 들어가는 우리 방식이다.
    틀린 장면을 찾으면 focus-boxes.json 의 "override" 에 장면 id 를 적는다.
    그러면 solve 가 그 장면만 **손으로 적은 네모**를 쓴다.
    """
    run_dir = Path(a.run_dir)
    todo = load(run_dir / 'focus-todo.json')
    auto = (load(run_dir / 'focus-auto.json') or {}).get('shots') or {}
    focus = load(a.focus or (run_dir / 'focus.json'))
    if not (todo and focus):
        sys.exit('focus-todo.json · focus.json 이 있어야 한다 — detect · solve 를 먼저 돌려라')
    from PIL import Image, ImageDraw, ImageFont
    win = dict((s['id'], s) for s in focus['shots'])
    out_dir = run_dir / '_focus'
    font = None
    for cand in ('C:/Windows/Fonts/malgunbd.ttf', 'C:/Windows/Fonts/malgun.ttf',
                 'C:/Windows/Fonts/arialbd.ttf'):
        try:
            font = ImageFont.truetype(cand, 15)       # ★한글이 들어가는 글꿴을 먼저 찾는다
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    cells = []
    for s in todo['shots']:
        sid = s['id']
        if s['flash'] or sid not in win:
            continue
        rows = auto.get(sid)
        t = rows[len(rows) // 2]['t'] if rows else (s['start'] + s['end']) / 2
        boxes = rows[len(rows) // 2]['boxes'] if rows else []
        jpg = out_dir / ('rv_%s.jpg' % sid.replace('.', '_'))
        if not jpg.exists():
            grab(todo['source'], t, jpg)
        cells.append((sid, str(jpg), t, boxes, '기계' if rows else '손'))
    cw = CELL_W
    sw, sh = todo['size']
    ch = int(round(cw * sh / sw))
    bar, per = 24, COLS * ROWS
    n = 0
    for si in range(0, len(cells), per):
        chunk = cells[si:si + per]
        rows_n = int(math.ceil(len(chunk) / float(COLS)))
        im = Image.new('RGB', (COLS * (cw + 8) + 8, rows_n * (ch + bar + 8) + 8), (18, 18, 20))
        d = ImageDraw.Draw(im)
        for k, (sid, jpg, t, boxes, how) in enumerate(chunk):
            x0 = 8 + (k % COLS) * (cw + 8)
            y0 = 8 + (k // COLS) * (ch + bar + 8)
            try:
                im.paste(Image.open(jpg).convert('RGB').resize((cw, ch), Image.LANCZOS), (x0, y0 + bar))
            except Exception:
                pass
            w = win[sid]
            d.text((x0 + 3, y0 + 4), '%s  %s  배율 %.2f%s' % (sid, how, w['zoom'],
                   '  ★하한미달' if w['fallback'] else ''), fill=(255, 220, 120), font=font)
            for b in boxes:
                d.rectangle([x0 + b[0] / 100 * cw, y0 + bar + b[1] / 100 * ch,
                             x0 + b[2] / 100 * cw, y0 + bar + b[3] / 100 * ch],
                            outline=(0, 255, 80), width=2)
            p = min(w['points'], key=lambda q: abs(q[0] - t))
            ww, hh = w['crop'][0] * cw, w['crop'][1] * ch
            d.rectangle([x0 + p[1] * cw - ww / 2, y0 + bar + p[2] * ch - hh / 2,
                         x0 + p[1] * cw + ww / 2, y0 + bar + p[2] * ch + hh / 2],
                        outline=(255, 80, 80), width=2)
        n += 1
        im.save(out_dir / ('review-%02d.png' % n))
    print('검토판 %d장: %s  (초록=피사체 · 빨강=실제 창)' % (n, out_dir))
    print('틀린 장면은 focus-boxes.json 의 "override" 에 id 를 적고 solve 를 다시 돌려라')
    return 0


def cmd_recheck(a):
    """표본 사이에서 피사체가 **창 반쪽보다 많이 움직인** 장면을 찾아 가운데 프레임을 더 뽑는다.

    왜 (2026-10-09 실측): 186.633 장면에서 여자 얼굴이 1.65초 사이에 왼쪽으로 갔다가 오른쪽으로
      돌아왔다. 양 끝 표본만 보면 직선으로 오른쪽으로 간 것처럼 보여, 가운데 시각의 창이 **엉뚱한
      데**(흐릿한 앞사람)에 놓였다. 볼케이노 완성본은 그 시각에 얼굴이 또렷했다.
      AGY 는 프레임마다 보니 이런 일이 없다. 우리는 **움직임이 큰 데만 더 본다.**
    """
    run_dir = Path(a.run_dir)
    todo = load(run_dir / 'focus-todo.json')
    focus = load(a.focus or (run_dir / 'focus.json'))
    if not todo or not focus:
        sys.exit('focus-todo.json / focus.json 이 있어야 한다 — sheets · solve 를 먼저 돌려라')
    sw, sh = todo['size']
    samples = dict(todo['samples'])
    shots = dict((s['id'], s) for s in todo['shots'])
    add = []
    for s in focus['shots']:
        if s.get('same_as'):
            continue
        win_w, win_h = s['crop'][0] * sw, s['crop'][1] * sh
        for p, q in zip(s['points'], s['points'][1:]):
            dx, dy = abs(q[1] - p[1]) * sw, abs(q[2] - p[2]) * sh
            if dx <= win_w * a.move and dy <= win_h * a.move:
                continue
            mid = round((p[0] + q[0]) / 2, 3)
            if any(abs(mid - t) < 0.15 for k, t in samples.items() if k.startswith(s['id'] + '#')):
                continue
            add.append((s['id'], mid, max(dx / win_w, dy / win_h)))
    if not add:
        print('표본 사이 움직임이 창 %.0f%% 를 넘는 장면이 없다 — 더 볼 것이 없다' % (a.move * 100))
        return 0
    add.sort(key=lambda r: -r[2])
    print('움직임이 큰 자리 %d곳 — 가운데 프레임을 더 뽑는다 (큰 것부터)' % len(add))
    for sid, t, r in add[:8]:
        print('   %-10s t=%.2f  창의 %.1f배' % (sid, t, r))

    out_dir = run_dir / '_focus'
    cells, n = [], {}
    for sid, t, _ in sorted(add, key=lambda r: r[1]):
        i = n[sid] = n.get(sid, -1) + 1
        key = '%s#m%d' % (sid, i)
        jpg = out_dir / ('%s_m%d.jpg' % (sid.replace('.', '_'), i))
        if not jpg.exists():
            grab(todo['source'], t, jpg)
        samples[key] = t
        cells.append({'key': key, 'jpg': str(jpg), 't': t,
                      'note': '%.2fs 보충' % (shots[sid]['end'] - shots[sid]['start'])})
    sheets = build_sheets(cells, out_dir, (sw, sh))
    for i, sh_ in enumerate(sheets):     # 이름이 겹치지 않게 r 을 붙인다
        src = out_dir / sh_['file']
        dst = out_dir / ('sheet-r%02d.png' % (i + 1))
        os.replace(src, dst)
        sh_['file'] = dst.name
    todo['samples'] = samples
    todo['sheets'] = [s for s in todo['sheets'] if not s['file'].startswith('sheet-r')] + sheets
    dump(run_dir / 'focus-todo.json', todo)

    bp = run_dir / 'focus-boxes.json'
    d = load(bp) or {'boxes': {}}
    for c in cells:
        d['boxes'].setdefault(c['key'], None)
    dump(bp, d)
    print('보충 판 %d장: %s' % (len(sheets), out_dir))
    print('빈 칸 %d개 — 채우고 solve 를 다시 돌려라' % sum(1 for v in d['boxes'].values() if not v))
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    s1 = sub.add_parser('sheets', help='장면을 끊고 프레임판을 굽는다')
    s1.add_argument('run_dir')
    s1.add_argument('--plan', default=None)
    s2 = sub.add_parser('solve', help='적어 둔 네모로 기하를 푼다')
    s2.add_argument('run_dir')
    s2.add_argument('--aspect', default='1:1', help='그림 창 비율 (명화관 1:1)')
    s2.add_argument('--out', default=None)
    s2.add_argument('--hand-only', action='store_true',
                    help='기계 판독(focus-auto.json)을 무시하고 손으로 적은 것만 쓴다')
    s3 = sub.add_parser('detect', help='얼굴을 촘촘히 읽어 네모를 적는다(린박스 rinbox_faces 를 쓴다)')
    s3.add_argument('run_dir')
    s3.add_argument('--aspect', default='1:1')
    s3.add_argument('--step', type=float, default=0.3, help='표본 간격(초)')
    s5 = sub.add_parser('review', help='기계가 고른 피사체와 창을 그려 둔다')
    s5.add_argument('run_dir')
    s5.add_argument('--focus', default=None)
    s4 = sub.add_parser('recheck', help='표본 사이 움직임이 큰 자리에 프레임을 더 뽑는다')
    s4.add_argument('run_dir')
    s4.add_argument('--focus', default=None)
    s4.add_argument('--move', type=float, default=0.5, help='창 폭의 이 비율보다 많이 움직이면 더 본다')
    a = ap.parse_args()
    return {'sheets': cmd_sheets, 'solve': cmd_solve,
            'detect': cmd_detect, 'recheck': cmd_recheck,
            'review': cmd_review}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
