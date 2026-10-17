"""B채널 팬튜브 쇼츠 조립기 — 레퍼런스(엔믹스 팬튜브 상위 채널)형: 단색 머리띠 + 가로 꽉 찬 영상 + 영상 아래 자막 띠.

    python fantube.py <spec.json>            → spec 폴더에 out.mp4

화면 구성(1080x1920, 2026-10-13 소유주 승인 시험편 4):
  머리띠   0~400     멤버 칩·꼬리표 + 2줄 후킹 제목(핵심어 색), 아래 끝 멤버 색 줄
  영상     400~1480  원본 위쪽 880x880 을 1080x1080 으로(원본 아래쪽 박힌 자막 띠는 아예 떠 오지 않는다)
                     카메라는 린박스 얼굴 추적(말하는 얼굴·샷 경계 즉시·샷 안 미끄러짐), 로고는 logo_box 로 피한다
                     이벤트 그래픽(사물함·스탬프·포토카드·스티커·다음 편)은 영상 아래쪽에 겹친다
  자막 띠  1480~1660 우리 자막(단어별 등장·화자 칩·노랑 강조) — 문안은 원본 자막, 시각은 받아쓰기
  아래     1660~     쇼츠 UI 자리(비워 둔다)
  줌 펀치  events 의 punch 시각에 영상이 0.25초 튀었다 돌아온다(ffmpeg)

출처: 영상 왼쪽 위 «영상: …» 표기는 항상 남긴다(저작권법 제104조의3).
렌더·글꼴은 politics-hour, 카메라는 린박스 것을 import 한다(복사하지 않는다).
이전 배치(흐린 배경+둥근 패널+띠)는 fantube_v3_panel.py.bak.
"""
import html
import re
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from pathlib import Path

os.environ.setdefault('OPENCV_LOG_LEVEL', 'ERROR')
sys.path.insert(0, 'D:/midform/politics-hour/overlay')
from config import ASSETS  # noqa: E402
from quote_overlay import render  # noqa: E402
sys.path.insert(0, RINBOX := 'D:/midform/scripts')
from rinbox_render import cam_expr, snap_to_shot  # noqa: E402

W, H, FPS = 1080, 1920, 30
HEAD = 400                                    # 머리띠 높이
VX, VY, VW, VH = 0, HEAD, 1080, 1080          # 영상 자리(가로 꽉 참)
CAP_Y = VY + VH + 20                          # 자막 띠 글자 위 끝
BG = '#0b0a10'
SRC_W = 1920
CROP_W, CROP_H = 850, 850                     # 원본 위쪽 정사각 — 아래 230px(박힌 자막·장식 글자 자리)은 버린다
VISION_PY = 'D:/midform/.venv-vision/Scripts/python.exe'
FONTS = ['Paperlogy-8ExtraBold.ttf', 'ROKAFSansMedium.ttf', 'BMYEONSUNG.ttf']
esc = lambda s: html.escape(str(s), quote=True)  # noqa: E731


# ───────────────────────── 카메라(린박스 얼굴 추적) ─────────────────────────
def segments(spec):
    """편을 이루는 구간들. spec.segments 가 없으면 src/start/end 한 구간(예전 spec).
    구간: {"src","start","end", "camera": "talk"|"track"|"wide"(16:9 통째), "transcript"(talk), "track"(track: stage_track.py 결과),
           "crop": 정사각 창 크기(기본 CROP_W), "crop_y"(talk), "logo_box", "gain": 소리 배율}"""
    if spec.get('segments'):
        return spec['segments']
    return [{k: spec[k] for k in ('src', 'start', 'end', 'transcript', 'logo_box', 'crop_y') if k in spec}]


def seg_len(s):
    return float(s['fill']) if s.get('fill') else s['end'] - s['start']


def total(spec):
    return sum(seg_len(s) for s in segments(spec)) + float(spec.get('hold', 0))


def member_cam(spec, seg, folder, idx, out0):
    """member 구간: 채널 멤버(spec.member_refs 얼굴 기준)를 기본으로 잡고, 자막 화자가 다른 멤버일 때만 그 사람 쪽으로.
    린박스 화자 추적은 입 움직임으로 고르는데 셀카 투샷에선 옆 사람을 고르기 쉽다(2026-10-13 진규 편: 배이만 잡힘).
    0.5초마다 얼굴을 찾고 기준과 닮은 정도로 «멤버 / 다른 사람»을 가른다. 결과는 mcam{idx}.json."""
    cache = folder / f"mcam{idx}_{seg['start']:.2f}_{seg['end']:.2f}.json"   # 경계가 바뀌면 새로 잰다
    if cache.exists():
        return [tuple(p) for p in json.loads(cache.read_text(encoding='utf-8'))]
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import numpy as np
    import member_id as mid
    R = np.load(spec['member_refs'])
    fc = mid.Faces()
    cw = seg.get('crop', CROP_W)
    me = spec.get('member_name', '규진')
    caps = spec.get('captions', [])
    seg_len_ = seg['end'] - seg['start']

    def speaker_at(lt):
        ot = out0 + lt
        for c in caps:
            if c.get('speaker') and c['t'] <= ot < c['end']:
                return c['speaker']
        return None

    samples, t = [], 0.0                          # (구간 초, 창 x 또는 None)
    while t < seg_len_:
        img = mid.frame(seg['src'], seg['start'] + t)
        faces = fc.find(img, 0.6) if img is not None else []
        x = None
        if faces:
            scored = [(max(mid.cos(fc.embed(img, f), r) for r in R), f) for f in faces]
            mine = max(scored, key=lambda s: s[0])
            sp = speaker_at(t)
            target = mine[1]
            if sp and sp != me and len(scored) > 1:
                others = [f for s, f in scored if f is not mine[1]]
                target = max(others, key=lambda f: f[2] * f[3])
            x = int(min(max(float(target[0] + target[2] / 2) - cw / 2, 0), SRC_W - cw)) // 2 * 2
        samples.append((t, x))
        t += 0.25
    # 얼굴을 못 찾은 시각(초근접·전환)은 앞 값을 끌지 않고 «다음에 찾은 값»으로 미리 맞춘다 — 컷이 바뀐 순간부터 새 자리
    nxt = None
    for k in range(len(samples) - 1, -1, -1):
        if samples[k][1] is None:
            samples[k] = (samples[k][0], nxt)
        else:
            nxt = samples[k][1]
    points = []
    for tt, x in samples:
        if x is None:
            continue
        f = round(tt * FPS)
        if not points:
            points.append((0, x, True))
        elif abs(x - points[-1][1]) > 60 and f > points[-1][0]:
            points.append((f, x, True))
    points = points or [(0, (SRC_W - cw) // 2, True)]
    cache.write_text(json.dumps(points) + '\n', encoding='utf-8')
    return points


def camera(seg, folder, idx=0):
    """talk 구간: 린박스 rinbox_faces.py 로 «말하는 얼굴»을 따라가는 카메라 점 → cam_expr 용 (구간 프레임, x, 즉시?).
    샷 경계 점은 즉시 전환(snap_to_shot), 샷 안 "pan" 점은 미끄러진다 — 린박스와 같은 규칙. camera{idx}.json 에 둔다."""
    cache = folder / f"camera{idx}_{seg['start']:.2f}_{seg['end']:.2f}.json"   # 경계가 바뀌면 새로 잰다
    if cache.exists():
        return [tuple(p) for p in json.loads(cache.read_text(encoding='utf-8'))]
    src, start, end = seg['src'], seg['start'], seg['end']
    cw = seg.get('crop', CROP_W)
    fin, fout = folder / f'faces_in{idx}.json', folder / f'faces{idx}.json'
    fin.write_text(json.dumps({'source': src, 'transcript': seg['transcript'], 'iw': SRC_W, 'cw': cw,
                               'ranges': [[start, end]]}, ensure_ascii=False) + '\n', encoding='utf-8')
    r = subprocess.run([VISION_PY, RINBOX + '/rinbox_faces.py', str(fin), str(fout)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode:
        sys.exit('얼굴 추적 실패:\n' + r.stderr[-1500:])
    (folder / f'faces{idx}.txt').write_text(r.stdout, encoding='utf-8')
    marks = json.loads(fout.read_text(encoding='utf-8'))['marks'][0]
    x_of = lambda cx: int(round(min(max(cx * SRC_W - cw / 2, 0), SRC_W - cw) / 2)) * 2  # noqa: E731
    nf = round((end - start) * FPS)
    points = [(0, x_of(marks[0][1]), True)]
    for m in marks[1:]:
        pan = len(m) > 2 and m[2] == 'pan'
        tt = m[0] if pan else snap_to_shot(src, m[0])
        f = min(nf - 1, max(1, round((tt - start) * FPS)))
        if f > points[-1][0]:
            points.append((f, x_of(m[1]), not pan))
    cache.write_text(json.dumps(points) + '\n', encoding='utf-8')
    return points


def track_points(seg):
    """track 구간: stage_track.py 의 [t, cx, cy, 얼굴높이] 를 따라 미끄러지는 (프레임, x) · (프레임, y) 점.
    창은 정사각 seg.crop, 얼굴이 창 위쪽 1/4 에 오게 둔다."""
    cw = seg.get('crop', 540)
    marks = json.loads(Path(seg['track']).read_text(encoding='utf-8'))['marks']
    marks = [m for m in marks if seg['start'] - .01 <= m[0] <= seg['end'] + .01]
    xs, ys = [], []
    for t, cx, cy, _ in marks:
        f = max(0, round((t - seg['start']) * FPS))
        x = int(min(max(cx * SRC_W - cw / 2, 0), SRC_W - cw)) // 2 * 2
        y = int(min(max(cy * 1080 - cw * .25, 0), 1080 - cw)) // 2 * 2
        if not xs or f > xs[-1][0]:
            xs.append((f, x, not xs)); ys.append((f, y, not ys))
    return xs, ys


# ───────────────────────── 컷 경계 다듬기 ─────────────────────────
# 규칙 출처(새로 만들지 않는다):
#   · 명화관 확정 규칙 1 (C:/Users/urban/volcano-runs/tools/명화관_원고규칙_서버지시.md 마지막 절) — 컷 끝 = 마지막 단어 끝
#     +0.3~0.5s, 침묵(-30dB) 안이면 침묵 시작 +0.15s 이상. 규칙 5 — 문장 중간에서 끊지 않는다(spec 작성 때 지킨다).
#   · 린박스 깜빡임 도우미 rinbox_flashfix.py — 끝은 «샷 경계 − 1프레임»(snap_to_shot 이 그 값을 준다), 소리 크기는 level().
#   · 린박스 화면 검사 rinbox_screen.py — 렌더 뒤 관문. 조각 앞·끝 15프레임 이하 다른 샷 = 깜빡임.
import rinbox_flashfix as FF  # noqa: E402
import rinbox_screen as SC  # noqa: E402  — 관문과 같은 샷 경계 검출(shot_cuts)을 다듬기에도 쓴다


def _cuts_in(src, a, dur):
    """원본 a~a+dur 를 30fps 작은 그림으로 읽어 린박스 화면 검사와 같은 shot_cuts 로 새 샷 첫 장 시각들을 돌려준다."""
    w, h = 192, 108
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{a:.3f}', '-t', f'{dur:.3f}', '-i', str(src), '-vf',
                          f'fps={FPS}:round=up,scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    frames = [np.frombuffer(raw[i * w * h * 3:(i + 1) * w * h * 3], np.uint8).reshape(h, w, 3) for i in range(n)]
    if len(frames) < 3:
        return []
    cuts, _ = SC.shot_cuts(frames)
    return [a + c / FPS for c in cuts]
ASR_TOL = 0.1   # 낱말 시각 오차 허용 — 린박스 렌더러는 컷 끝을 0.3초 안으로 넘는 토큰을 받아 준다(rinbox_render 91행), 우리는 더 엄격히
LEAD, TAIL, TAIL_SILENT = 0.2, 0.4, 0.15     # 첫 단어 앞 여유 · 말 뒤 여유(소리 있음) · 침묵일 때 최소


def _words(seg, spec):
    """구간 소스의 받아쓰기 낱말 [(s, e, w)] — 원본 시각. 지운 클립(src 시작 0)은 tr_offset 으로 원본 시각을 옮겨 맞춘다."""
    tr = seg.get('transcript') or (spec.get('transcripts') or {}).get(seg.get('tr_src', seg['src']))
    if not tr:
        return None
    off = float(seg.get('tr_offset', 0))
    return [(s - off, e - off, w) for s, e, w in json.loads(Path(tr).read_text(encoding='utf-8'))]


_DUR = {}


def src_dur(src):
    """소스 영상 길이(초) — 경계를 늘릴 때 영상 밖으로 나가지 않게(지운 짧은 클립은 0초부터 시작한다)."""
    if src not in _DUR:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(src)],
                           capture_output=True, text=True)
        _DUR[src] = float(r.stdout.strip() or 0)
    return _DUR[src]


def tidy_bounds(seg, words):
    """(새 시작, 새 끝, 사유). 경계는 «늘리기만» 한다 — 줄이는 건 다음/앞 말을 침범할 때뿐(그림이 펀치인 컷이 있다).
    끝: 마지막 단어 끝 +0.3~0.5s, 침묵이면 +0.15s 이상(명화관 규칙 1), 0.3초 안 샷 경계면 «경계 − 1프레임»(snap_to_shot).
    시작: 앞 말꼬리 뒤 · 첫 단어 −0.2s. 시작 뒤 15프레임 안에 샷 경계가 있으면(린박스 화면 검사의 깜빡임 기준)
          그 전에 말이 없을 때 «경계 프레임»에서 시작하고, 말이 걸치면 앞 샷이 15프레임 넘게 보이도록 당긴다(rinbox_flashfix)."""
    a, b = seg['start'], seg['end']
    inside = [w for w in words if a - 0.05 <= w[0] < b - 0.05]          # 구간 안에서 «시작하는» 낱말 — 끝을 넘겨도 그 말까지(명화관 규칙 5)
    cap0 = seg.get('_speech_from')                                          # 원본 자막 기준 말 시작 — ASR 이 놓친 첫마디(«제일…») 보호
    if cap0 is not None:
        inside = [(cap0, cap0 + 0.01, '(자막)')] + [w for w in inside if w[0] > cap0] if (not inside or cap0 < inside[0][0]) else inside
    if not inside:
        return a, b, '낱말 없음'
    first, last = inside[0], inside[-1]
    before = [w for w in words if w[1] <= first[0] - 1e-3]
    after = [w for w in words if w[0] >= last[1] - 1e-3 and w is not last]
    floor_a = max(0.0, (before[-1][1] + 0.05) if before else 0.0)
    ceil_b = min(src_dur(seg['src']) - 0.05, (after[0][0] - 0.05) if after else b + 5)
    # 끝
    lv = FF.level(seg['src'], last[1], 0.35)          # 말 뒤가 침묵인가(-30dB) — 명화관 규칙 1
    want_b = last[1] + (0.25 if lv is not None and lv < -30 else TAIL)
    nb = min(max(b, want_b), ceil_b)
    found = []
    sb = snap_to_shot(seg['src'], nb, 0.3, found)
    if found and found[-1] and last[1] + 0.12 <= sb <= ceil_b:
        nb = sb
    tail = [c for c in _cuts_in(seg['src'], nb - 0.6, 0.6) if c < nb - 0.5 / FPS]  # 끝 직전 경계(관문 기준)
    if tail and tail[-1] >= last[1] + 0.12 and nb - tail[-1] <= 0.5:
        nb = tail[-1] - 1 / FPS                                  # 경계 − 1프레임에서 끝(rinbox_flashfix)
    elif tail and nb - tail[-1] <= 0.5:
        nb = min(ceil_b, tail[-1] + 0.55)                        # 말이 경계 뒤까지 → 새 샷을 15프레임 넘게
    # 시작
    na = max(min(a, first[0] - LEAD), floor_a)
    head = [c for c in _cuts_in(seg['src'], na, 0.6) if c > na + 0.5 / FPS]   # 관문(shot_cuts)과 같은 기준
    if head:
        cut_f = head[0]                                          # 새 샷 첫 프레임
        if cut_f <= first[0] + 1e-3:
            na = cut_f                                           # 말 전에 바뀐다 → 새 샷부터
        elif cut_f - na <= 0.5:
            na = max(floor_a, cut_f - 0.55)                      # 말이 걸친다 → 앞 샷을 15프레임 넘게
    na, nb = max(0.0, na), min(src_dur(seg['src']) - 0.05, nb)
    return round(na, 3), round(nb, 3), f'첫 «{first[2]}» {first[0]:.2f} · 끝 «{last[2]}» {last[1]:.2f}'


# 자막은 두 줄로 넘기지 않는다 — 린박스·롱투숏 규칙(rinbox_render CAP_MAX, ls_tools/autocap.cards): 한 칸 = 한 줄,
# 넘치면 줄을 바꾸지 않고 어절 경계에서 칸을 쪼갠다. 상한은 글자 수 대신 우리 자막 띠 폭(1020px)에 실제 글꼴로 잰다.
# 칸 시각은 전사 토큰에서 잰다(card_times 와 같은 생각) — 문구는 원본 자막 그대로라 토큰글과 1:1 로 안 맞아 글자 비율로 토큰을 찾는다.
LINE_FONT = {'say': ('Paperlogy-8ExtraBold.ttf', 56, 0), 'pop': ('Paperlogy-8ExtraBold.ttf', 72, 0),
             'note': ('BMYEONSUNG.ttf', 50, 52), 'thought': ('Paperlogy-8ExtraBold.ttf', 50, 0),
             'tag': ('Paperlogy-8ExtraBold.ttf', 50, 0), 'closer': ('Paperlogy-8ExtraBold.ttf', 52, 60)}
LINE_W = W - 60 - 30                                  # .cap 좌우 30px + 여유


def _line_px(text, style):
    from PIL import ImageFont
    f, size, pad = LINE_FONT.get(style, LINE_FONT['say'])
    return ImageFont.truetype(str(ASSETS / 'fonts' / f), size).getlength(text.replace('*', '')) + pad


CAP_CHARS = 16          # 칸당 글자(공백·* 제외 아님 — autocap 처럼 공백 포함). 린박스 ko 12 는 더 큰 글꼴 기준


def _too_long(text, style):
    return len(text.replace('*', '')) > CAP_CHARS or _line_px(text, style) > LINE_W


def _chunks(text, style):
    """어절 경계에서만 쪼갠다. 칸 수는 탐욕 묶음으로 정하고, 그 칸 수 안에서 가장 긴 칸이 가장 짧아지게 나눈다
    (자투리 한 어절이 혼자 남지 않게). *강조* 가 칸을 넘으면 닫고 다음 칸에서 다시 연다."""
    ws = text.split(' ')
    k, cur = 1, []
    for w in ws:
        if cur and _too_long(' '.join(cur + [w]), style):
            k += 1; cur = []
        cur.append(w)
    L = lambda i, j: len(' '.join(ws[i:j]).replace('*', ''))
    inside = lambda j: ' '.join(ws[:j]).count('*') % 2 == 1          # *강조 덩어리* 한가운데서 끊기 → 벌점(의미 덩어리)
    from functools import lru_cache

    @lru_cache(None)
    def best(i, k):                                   # ws[i:] 를 k 칸으로 → (가장 긴 칸 + 벌점, 나눔)
        if k == 1:
            return (L(i, len(ws)), (len(ws),))
        opts = [(max(L(i, j), best(j, k - 1)[0]) + (8 if inside(j) else 0), (j,) + best(j, k - 1)[1])
                for j in range(i + 1, len(ws) - k + 2)
                if _line_px(' '.join(ws[i:j]), style) <= LINE_W]
        return min(opts) if opts else (99, tuple(range(i + 1, i + k)) + (len(ws),))
    cuts = (0,) + best(0, min(k, len(ws)))[1]
    out = [' '.join(ws[a:b]) for a, b in zip(cuts, cuts[1:])]
    fixed, open_ = [], False
    for c in out:
        c = ('*' if open_ else '') + c
        open_ = c.count('*') % 2 == 1
        fixed.append(c + ('*' if open_ else ''))
    return [c.replace('**', '') for c in fixed]


def one_line(spec):
    caps, out = spec.get('captions', []), []
    bounds, acc = [], 0.0
    for s in spec.get('segments', []):
        bounds.append((acc, acc + seg_len(s), s)); acc += seg_len(s)
    for c in caps:
        st = c.get('style', 'say')
        parts = _chunks(c['text'], st) if st in ('say', 'pop', 'note', 'thought') and _too_long(c['text'], st) else [c['text']]
        if len(parts) == 1:
            out.append(c); continue
        n = [len(p.replace('*', '').replace(' ', '')) for p in parts]
        fr = [sum(n[:i]) / sum(n) for i in range(1, len(parts))]          # 칸 경계의 글자 비율
        cuts = [c['t'] + f * (c['end'] - c['t']) for f in fr]               # 기본: 글자 비율대로
        seg = next((b for b in bounds if b[0] - 1e-6 <= c['t'] < b[1]), None)
        ws = _words(seg[2], spec) if seg else None
        if ws:
            a = seg[2]['start'] + (c['t'] - seg[0]); b = seg[2]['start'] + (c['end'] - seg[0])
            tk = [w for w in ws if w[0] >= a - 0.05 and w[0] < b]
            if len(tk) >= len(parts):
                cum, tot = [], sum(len(w[2]) for w in tk)
                for w in tk:
                    cum.append((sum(len(x[2]) for x in tk[:tk.index(w)]) / tot, w[0]))
                cuts = [seg[0] + (next(t for f0, t in cum if f0 >= f - 1e-6) if any(f0 >= f - 1e-6 for f0, _ in cum)
                                  else cum[-1][1]) - seg[2]['start'] for f in fr]
        ts = [c['t']] + [max(c['t'], min(x, c['end'])) for x in cuts] + [c['end']]
        if any(b - a < 0.6 for a, b in zip(ts, ts[1:])):           # 토큰 짝이 어긋나면 글자 비율로
            ts = [c['t']] + [c['t'] + f * (c['end'] - c['t']) for f in fr] + [c['end']]
        for i, p in enumerate(parts):
            out.append(dict(c, t=round(ts[i], 3), end=round(ts[i + 1], 3), text=p))
    return dict(spec, captions=out)


def tidy(spec, folder):
    """talk·member 구간의 시작·끝을 다듬고, 그만큼 자막·이벤트·효과음 시각을 민다. spec.tidy=false 면 건너뛴다."""
    if spec.get('tidy') is False or not spec.get('segments'):
        return spec
    segs, log = spec['segments'], []
    old_off, new_off, acc_o, acc_n = [], [], 0.0, 0.0
    new_segs = []
    for s in segs:
        ns = dict(s)
        if s.get('camera', 'talk') in ('talk', 'member') and not s.get('fill'):
            o0 = acc_o
            sp = [c['t'] for c in spec.get('captions', []) if c.get('style', 'say') in ('say', 'pop')
                  and o0 - 1e-6 <= c['t'] < o0 + seg_len(s)]
            if sp:
                ns['_speech_from'] = s['start'] + (min(sp) - o0)
            ws = _words(s, spec)
            if ws:
                na, nb, why = tidy_bounds(ns, ws)
                log.append(f"{s['start']:.2f}~{s['end']:.2f} → {na:.2f}~{nb:.2f} ({why})")
                ns['start'], ns['end'] = na, nb
        old_off.append((acc_o, acc_o + seg_len(s), s['start'])); new_off.append((acc_n, ns['start']))
        acc_o += seg_len(s); acc_n += seg_len(ns)
        new_segs.append(ns)

    # 사전 검사: 그림 창만 빠르게 합성해 린박스 관문을 돌리고, ✗ 깜빡임이면 그 끝을 «경계에서» 자른다(rinbox_flashfix 처방).
    #   창을 통째로 밀면 양쪽에 경계가 붙은 구간에서 핑퐁한다(사물함 편 실측) — 자르기만 한다.
    probe = dict(spec, segments=new_segs)
    for _ in range(3):
        txt = compose(probe, folder, None, pic_only=True)
        fixes = re.findall(r'✗ 구간\(원본 ([\d.]+)~([\d.]+)s\): (앞|끝) (\d+)프레임이 다른 샷', txt)
        if not fixes:
            break
        changed = False
        for a_, b_, side, n in fixes:
            for ns in new_segs:
                if (abs(ns['start'] - float(a_)) >= 0.02 or abs(ns['end'] - float(b_)) >= 0.05   # 시작·끝 둘 다 — 지운 클립들은 모두 1.0초에서 시작한다
                        or ns.get('_flash_ok_' + side)):
                    continue
                key = '_flash_n_' + side                                   # 같은 끝을 두 번 고쳐도 또 걸리면 = 원본의 빠른 컷 리듬
                ns[key] = ns.get(key, 0) + 1
                if ns[key] > 2:
                    ns['_flash_ok_' + side] = True
                    log.append(f'깜빡임 허용(원본 빠른 컷): 원본 {a_}s {side} {n}프레임')
                    continue
                ws = _words(ns, spec) or []
                inside = [w for w in ws if ns['start'] - 0.05 <= w[0] < ns['end'] - 0.05]
                if ns.get('_speech_from') is not None and (not inside or ns['_speech_from'] < inside[0][0]):
                    inside = [(ns['_speech_from'], ns['_speech_from'] + 0.01, '(자막)')] + inside
                if side == '앞':
                    cut = ns['start'] + int(n) / FPS                      # 새 샷 첫 장
                    floor_a = max([0.0] + [w[1] + 0.05 for w in ws if w[1] <= (inside[0][0] if inside else cut)])
                    if not inside or cut <= inside[0][0] + ASR_TOL:            # ASR 시각 오차 안이면 «말 전»
                        ns['start'] = round(cut, 3)                       # 말 전에 바뀐다 → 경계부터
                    elif cut - 18 / FPS >= floor_a:
                        ns['start'] = round(cut - 18 / FPS, 3)            # 말이 걸친다 → 앞 샷을 15프레임 넘게
                    else:
                        ns['_flash_ok_앞'] = True                         # 앞 말 때문에 못 당긴다 = 원본 편집 리듬
                else:
                    cut = ns['end'] - int(n) / FPS                        # 새 샷 첫 장
                    nxt = [w[0] - 0.05 for w in ws if w[0] >= (inside[-1][1] if inside else cut)]
                    ceil_b = min(min(nxt) if nxt else ns['end'] + 2, src_dur(ns['src']) - 0.05)
                    if not inside or cut - 1 / FPS >= inside[-1][1] - ASR_TOL:
                        ns['end'] = round(cut - 1 / FPS, 3)               # 말이 끝난 뒤 바뀐다 → 경계 − 1프레임
                    elif cut + 18 / FPS <= ceil_b:
                        ns['end'] = round(cut + 18 / FPS, 3)              # 말이 걸친다 → 새 샷을 15프레임 넘게
                    else:
                        ns['_flash_ok_끝'] = True
                changed = True
                log.append(f"깜빡임 {'허용(원본 리듬)' if ns.get('_flash_ok_' + side) else '고침'}: 원본 {a_}s {side} {n}프레임 → {ns['start']:.2f}~{ns['end']:.2f}")
        if not changed:
            break
        acc_n = 0.0
        new_off = []
        for ns in new_segs:
            new_off.append((acc_n, ns['start']))
            acc_n += seg_len(ns)

    def move(x):
        for (o0, o1, src0), (n0, nsrc0) in zip(old_off, new_off):
            if o0 - 1e-6 <= x < o1 + 1e-6:
                return round(n0 + (x - o0) + (src0 - nsrc0), 3)
        return round(x + (acc_n - acc_o), 3)
    out = dict(spec)
    out['segments'] = new_segs
    out['captions'] = [dict(c, t=move(c['t']), end=move(c['end'])) for c in spec.get('captions', [])]
    out['events'] = [dict(e, **({'t': move(e['t'])} if 't' in e else {}), **({'until': move(e['until'])} if 'until' in e else {}),
                          **({'items': [dict(i, t=move(i['t'])) for i in e['items']]} if 'items' in e else {}))
                     for e in spec.get('events', [])]
    out['sfx'] = [dict(x, t=move(x['t'])) for x in spec.get('sfx', [])]
    out['music'] = [dict(x, t=move(x['t'])) for x in spec.get('music', [])]
    # 구간 끝이 늘어난 만큼, 구간 마지막에 걸려 끝나던 자막은 새 끝까지 늘인다
    for c_old, c_new in zip(spec.get('captions', []), out['captions']):
        for (o0, o1, _), (n0, _), ns in zip(old_off, new_off, new_segs):
            if abs(c_old['end'] - o1) < 0.25 and o0 <= c_old['t'] < o1:
                c_new['end'] = round(n0 + seg_len(ns), 3)
    (folder / 'tidy.txt').write_text('\n'.join(log) + '\n', encoding='utf-8')
    return out


# ───────────────────────── 오버레이(하이퍼프레임) ─────────────────────────
def css(c):
    return f'''
@font-face{{font-family:Paper;src:url(assets/Paperlogy-8ExtraBold.ttf)}}
@font-face{{font-family:Body;src:url(assets/ROKAFSansMedium.ttf)}}
@font-face{{font-family:Hand;src:url(assets/BMYEONSUNG.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:{W}px;height:{H}px;overflow:hidden;word-break:keep-all}}
#head{{position:absolute;left:0;top:0;width:{W}px;height:{HEAD}px;background:{BG}}}
#rule{{position:absolute;left:0;top:{HEAD - 6}px;width:{W}px;height:6px;background:{c};box-shadow:0 0 24px {c}}}
#chip{{position:absolute;left:56px;top:110px;display:flex;align-items:center;gap:10px;font-family:Paper;font-size:32px}}
#chip .g{{background:#fff;color:#111;padding:6px 16px;border-radius:40px}}
#chip .m{{background:{c};color:#fff;padding:6px 16px;border-radius:40px;box-shadow:0 0 20px {c}88}}
#chip .tag{{font-family:Body;font-size:26px;color:#9a97a8;margin-left:6px}}
#title{{position:absolute;left:56px;right:40px;top:176px;font-family:Paper;font-size:80px;line-height:1.16;color:#fff}}
#title .ln{{display:block;white-space:nowrap}}
#title .w{{display:inline-block;opacity:0;transform:translateY(40px) scale(.9)}}
#title .k{{color:{c}}}
#credit{{position:absolute;left:{VX + 18}px;top:{VY + 16}px;font-family:Body;font-size:22px;color:#fff;
  background:rgba(0,0,0,.45);padding:4px 12px;border-radius:14px}}
#series{{position:absolute;right:18px;top:{VY + 14}px;font-family:Paper;font-size:26px;color:#fff;
  background:rgba(0,0,0,.5);padding:4px 14px;border-radius:20px;border:2px solid {c}}}
#capzone{{position:absolute;left:0;top:{VY + VH}px;width:{W}px;height:{H - VY - VH}px;background:{BG}}}
.info{{position:absolute;left:50px;top:{VY + VH - 130}px;font-family:Paper;font-size:44px;color:#111;background:#FFE14D;
  padding:14px 26px;border-radius:16px;box-shadow:0 8px 0 rgba(0,0,0,.25)}}
.lockers{{position:absolute;left:40px;right:40px;top:{VY + VH - 236}px;display:flex;gap:14px}}
.lk{{flex:1;height:200px;border-radius:12px;background:linear-gradient(#cfd5dd,#9aa3ae);position:relative;
  box-shadow:0 10px 0 rgba(0,0,0,.25),inset 0 0 0 4px #e8ecf1}}
.lk:before,.lk:after{{content:"";position:absolute;left:24px;right:24px;height:6px;background:#7d8692;border-radius:3px}}
.lk:before{{top:30px}} .lk:after{{top:48px}}
.lk .pl{{position:absolute;left:10px;right:10px;top:74px;background:#fff;border-radius:8px;text-align:center;
  font-family:Paper;font-size:30px;color:#333;padding:10px 0;white-space:nowrap}}
.lk .kn{{position:absolute;right:26px;top:140px;width:14px;height:36px;background:#6b737e;border-radius:8px}}
.lk.me{{background:linear-gradient({c},#c2447f);box-shadow:0 0 40px {c},0 10px 0 rgba(0,0,0,.25),inset 0 0 0 4px #ffd1e6}}
.lk.me .pl{{color:{c}}}
.stamp{{position:absolute;left:0;right:0;margin:0 auto;width:max-content;top:{VY + VH - 170}px;font-family:Paper;font-size:72px;color:{c};border:8px solid {c};
  padding:10px 34px;border-radius:18px;background:rgba(255,255,255,.92);white-space:nowrap;transform:rotate(-6deg)}}
.pc{{position:absolute;left:690px;top:{VY + VH - 410}px;width:320px;padding:16px 16px 66px;background:#fff;border-radius:10px;
  box-shadow:0 18px 40px rgba(0,0,0,.45);transform:rotate(5deg)}}
.pc img{{display:block;width:100%;height:290px;object-fit:cover;border-radius:4px}}
.pc .cap{{position:absolute;left:0;right:0;bottom:14px;text-align:center;font-family:Hand;font-size:40px;color:#333}}
.pc .tape{{position:absolute;left:50%;top:-20px;width:150px;height:44px;margin-left:-75px;background:{c}99;transform:rotate(-4deg)}}
.st{{position:absolute;font-family:Hand;font-size:52px;color:#fff;background:{c};padding:10px 24px;border-radius:40px;
  box-shadow:0 6px 0 rgba(0,0,0,.25)}}
.cap{{position:absolute;left:30px;right:30px;top:{CAP_Y}px;text-align:center;opacity:0}}
.cap .sp{{display:inline-block;font-family:Paper;font-size:34px;color:#fff;padding:4px 18px;border-radius:24px;margin-bottom:6px}}
.cap .tx{{font-family:Paper;font-size:56px;line-height:1.18;color:#fff}}
.cap .w{{display:inline-block}}
.cap .k{{color:#FFE14D;font-weight:inherit}}
.cap.pop .tx{{font-size:72px}}
.cap.pop .k{{color:{c}}}
.cap.note .tx{{display:inline-block;font-family:Hand;font-size:50px;color:#fff;padding:6px 26px;border-radius:34px;
  background:linear-gradient(90deg,{c},#9b7bff)}}
.cap.note .k{{color:#FFF27A}}
.cap.tag,.cap.thought{{top:{VY + VH - 120}px}}
.cap.closer .tx{{display:inline-block;font-family:Paper;font-size:52px;color:#fff;padding:12px 30px;border-radius:40px;
  background:linear-gradient(90deg,{c},#ff86c3);box-shadow:0 0 30px {c}aa;transform:rotate(-2deg)}}
.cap.closer .k{{color:#FFF27A}}
.cap.tag .tx{{font-size:50px;color:#FFE14D;text-shadow:0 0 6px #000,3px 3px 0 #111,-3px 3px 0 #111,3px -3px 0 #111,-3px -3px 0 #111}}
.cap.thought .tx{{font-size:50px;color:#fff;text-shadow:0 0 6px #000,3px 3px 0 #111,-3px 3px 0 #111,3px -3px 0 #111,-3px -3px 0 #111}}
.vig{{position:absolute;left:0;top:{VY}px;width:{W}px;height:{VH}px;opacity:0;
  background:radial-gradient(ellipse at center,rgba(255,140,200,0) 68%,rgba(255,140,200,.22) 100%)}}
.pt{{position:absolute;opacity:0;text-shadow:0 0 18px #ff8cc8,0 0 6px #fff;font-family:Paper}}
.cta{{position:absolute;left:60px;right:60px;top:{VY + VH - 140}px;text-align:center;font-family:Paper;font-size:56px;color:#fff;
  background:#111;border:5px solid {c};border-radius:60px;padding:20px 0;box-shadow:0 0 40px {c}88}}
'''


def title_html(lines, keys):
    out = ''
    for i, ln in enumerate(lines):
        ws = ''
        for w in ln.split():
            k = any(key in w for key in keys) if keys else i >= 1
            ws += f'<span class="w{" k" if k else ""}">{esc(w)}</span> '
        size = min(80, int(968 / (max(1, len(ln)) * .93)))     # 긴 줄은 줄여서 한 줄에 맞춘다
        out += f'<span class="ln" style="font-size:{size}px">{ws}</span>'
    return out


def events_html_js(events, d):
    body, js = '', []
    for i, e in enumerate(events):
        t, eid = float(e.get('t', 0)), f'e{i}'
        end = float(e.get('until', t + e.get('dur', 3)))
        out_at = min(end, d - .05)
        typ = e['type']
        if typ == 'info':
            body += f'<div class="info" id="{eid}">{esc(e["text"])}</div>'
            js += [f'tl.from("#{eid}",{{x:-80,opacity:0,duration:.4,ease:"back.out(1.7)"}},{t:.3f});',
                   f'tl.to("#{eid}",{{opacity:0,x:-40,duration:.3}},{out_at - .3:.3f});']
        elif typ == 'lockers':
            cells = ''.join(f'<div class="lk{" me" if it.get("me") else ""}" id="{eid}_{j}"><div class="pl">{esc(it["label"])}</div>'
                            f'<div class="kn"></div></div>' for j, it in enumerate(e['items']))
            body += f'<div class="lockers" id="{eid}">{cells}</div>'
            for j, it in enumerate(e['items']):
                tt = float(it['t'])
                if it.get('me'):
                    js += [f'tl.from("#{eid}_{j}",{{y:220,opacity:0,scale:.6,duration:.45,ease:"back.out(2.2)"}},{tt:.3f});',
                           f'tl.to("#{eid}_{j}",{{scale:1.12,duration:.15,yoyo:true,repeat:1}},{tt + .5:.3f});']
                else:
                    js.append(f'tl.from("#{eid}_{j}",{{y:220,opacity:0,duration:.4,ease:"power3.out"}},{tt:.3f});')
            js.append(f'tl.to("#{eid}",{{y:60,opacity:0,duration:.35,ease:"power2.in"}},{out_at - .35:.3f});')
        elif typ == 'stamp':
            body += f'<div class="stamp" id="{eid}">{esc(e["text"])}</div>'
            js += [f'tl.from("#{eid}",{{scale:2.6,opacity:0,duration:.3,ease:"power4.in"}},{t:.3f});',
                   f'tl.to("#{eid}",{{opacity:0,duration:.3}},{out_at - .3:.3f});']
        elif typ == 'photocard':
            body += (f'<div class="pc" id="{eid}"><div class="tape"></div><img src="assets/{esc(Path(e["image"]).name)}">'
                     f'<div class="cap">{esc(e.get("label", ""))}</div></div>')
            js += [f'tl.from("#{eid}",{{y:500,rotation:-20,opacity:0,duration:.6,ease:"back.out(1.4)"}},{t:.3f});',
                   f'tl.to("#{eid}",{{y:400,opacity:0,duration:.4,ease:"power2.in"}},{out_at - .4:.3f});']
            for j, s in enumerate(e.get('stickers', [])):
                sid = f'{eid}_s{j}'
                top, rot = VY + VH - 250 + j * 112, (-6 if j % 2 == 0 else 5)
                body += f'<div class="st" id="{sid}" style="left:70px;top:{top}px;transform:rotate({rot}deg)">{esc(s["text"])}</div>'
                js += [f'tl.from("#{sid}",{{scale:0,opacity:0,duration:.35,ease:"back.out(2.5)"}},{float(s["t"]):.3f});',
                       f'tl.to("#{sid}",{{opacity:0,duration:.3}},{out_at - .3:.3f});']
        elif typ == 'sparkle':
            # 움짤 위: 분홍 비네트 + 떠오르는 반짝이·하트(위치·지연은 고정 난수 — 다시 렌더해도 같다)
            import random
            rnd = random.Random(7)
            n_p = int(e.get('count', 16))
            dur = out_at - t
            body += f'<div class="vig" id="{eid}v"></div>'
            js += [f'tl.fromTo("#{eid}v",{{opacity:0}},{{opacity:1,duration:.3}},{t:.3f});',
                   f'tl.set("#{eid}v",{{opacity:0}},{out_at:.3f});']
            for j in range(n_p):
                ch = '♥' if j % 3 == 0 else '✦'
                x, y = rnd.randint(40, W - 80), rnd.randint(VY + 120, VY + VH - 60)
                size, delay = rnd.randint(34, 70), rnd.uniform(0, max(.1, dur - .9))
                col = '#ffffff' if j % 2 else '#ffd1e8'
                body += (f'<div class="pt" id="{eid}p{j}" style="left:{x}px;top:{y}px;font-size:{size}px;color:{col}">{ch}</div>')
                js += [f'tl.fromTo("#{eid}p{j}",{{y:40,opacity:0,scale:.4}},{{y:-130,opacity:1,scale:1,duration:.5,ease:"power2.out"}},{t + delay:.3f});',
                       f'tl.to("#{eid}p{j}",{{y:-220,opacity:0,duration:.45,ease:"power1.in"}},{t + delay + .5:.3f});']
        elif typ == 'cta':
            body += f'<div class="cta" id="{eid}">{esc(e["text"])}</div>'
            js.append(f'tl.from("#{eid}",{{y:120,opacity:0,duration:.4,ease:"back.out(1.8)"}},{t:.3f});')
    return body, js


def marked_words(text):
    """'그 옆에 *내 사물함*이 딱!!' → 단어별 html. *강조* 는 띄어쓰기를 넘어가도 되고 단어 중간에서 끝나도 된다."""
    words, cur, key = [], [], False          # cur = [(문자열, 강조?)] 한 단어 분량
    def flush():
        if cur:
            words.append(''.join(f'<b class="k">{esc(s)}</b>' if k else esc(s) for s, k in cur))
            cur.clear()
    for seg in re.split(r'(\*)', text):
        if seg == '*':
            key = not key
            continue
        parts = seg.split(' ')
        for j, part in enumerate(parts):
            if j:
                flush()
            if part:
                cur.append((part, key))
    flush()
    return words


def captions_html_js(caps, speakers, d):
    """우리 자막 — 원본 박힌 자막을 지운 자리(패널 아래쪽)에 단어별로 튀어나온다.
    caps: [{"t","end","text","speaker"?, "style": "say"|"pop"|"note"}], *낱말* 은 노란 강조.
    나타남·사라짐은 길이 0 인 tl.set 이라 사이 프레임은 정지 재사용된다."""
    body, js = '', []
    for i, c in enumerate(caps):
        cid, t0, t1 = f'c{i}', float(c['t']), min(float(c['end']), d - .02)
        words = ''.join(f'<span class="w">{w}</span> ' for w in marked_words(c['text']))
        sp = c.get('speaker')
        chip = (f'<div class="sp" style="background:{speakers.get(sp, "#555")}">{esc(sp)}</div>' if sp else '')
        body += f'<div class="cap {c.get("style", "say")}" id="{cid}">{chip}<div class="tx">{words}</div></div>'
        n = max(1, len(c['text'].split()))
        stag = min(.07, max(.02, (t1 - t0) * .35 / n))
        js += [f'tl.set("#{cid}",{{opacity:1}},{t0:.3f});',
               f'tl.from("#{cid} .w",{{y:26,opacity:0,scale:.75,duration:.16,stagger:{stag:.3f},ease:"back.out(2.4)"}},{t0:.3f});',
               f'tl.set("#{cid}",{{opacity:0}},{t1:.3f});']
        if c.get('style') == 'closer':      # 편집자 한마디 — 끝 정지 화면 위에 통째로 튀어나온다
            js.append(f'tl.from("#{cid} .tx",{{scale:.4,opacity:0,duration:.35,ease:"back.out(2.2)"}},{t0:.3f});')
            js.append(f'tl.to("#{cid} .tx",{{keyframes:[{{rotation:7,x:10}},{{rotation:-7,x:-10}},{{rotation:5,x:7}},{{rotation:-4,x:-5}},{{rotation:2,x:2}},{{rotation:-2,x:0}}],duration:.6,ease:"none"}},{t0 + .35:.3f});')
        if c.get('style') == 'pop':
            js.append(f'tl.from("#{cid} .tx",{{scale:1.5,duration:.22,ease:"back.out(2)"}},{t0:.3f});')
    return body, js


def build_overlay(spec, folder):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    shutil.copy2(ASSETS / 'gsap.min.js', folder / 'assets' / 'gsap.min.js')
    for f in FONTS:
        shutil.copy2(ASSETS / 'fonts' / f, folder / 'assets' / f)
    for e in spec['events']:
        if e.get('image'):
            shutil.copy2(e['image'], folder / 'assets' / Path(e['image']).name)
    d = total(spec)
    c = spec.get('color', '#FF5FA2')
    keys = spec.get('title_keys', [])
    ev_body, ev_js = events_html_js(spec['events'], d)
    cap_body, cap_js = captions_html_js(spec.get('captions', []), spec.get('speakers', {}), d)
    ev_body, ev_js = ev_body + cap_body, ev_js + cap_js
    tag = f'<span class="tag">{esc(spec["tag"])}</span>' if spec.get('tag') else ''
    body = (f'<div id="root" data-composition-id="fantube" data-width="{W}" data-height="{H}" data-duration="{d:.3f}">'
            f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">'
            f'<div id="head"></div><div id="capzone"></div><div id="rule"></div>'
            f'<div id="chip"><span class="g">{esc(spec["group"])}</span><span class="m">{esc(spec["member"])}</span>{tag}</div>'
            f'<div id="title">{title_html(spec["title"], keys)}</div>'
            f'<div id="credit">{esc(spec["credit"])}</div><div id="series">{esc(spec.get("series", ""))}</div>'
            f'{ev_body}</section></div>')
    js = ['const tl=gsap.timeline({paused:true});',
          'tl.from("#rule",{scaleX:0,transformOrigin:"left center",duration:.45,ease:"power3.out"},0);',
          'tl.from("#chip>*",{y:-30,opacity:0,duration:.35,stagger:.08,ease:"power3.out"},.05);',
          'tl.to("#title .w",{opacity:1,y:0,scale:1,duration:.32,stagger:.07,ease:"back.out(2)"},.15);',
          'tl.from("#credit,#series",{opacity:0,duration:.4},.6);',
          *ev_js,
          'window.__timelines=window.__timelines||{};window.__timelines["fantube"]=tl;']
    page = (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css(c)}</style></head><body>{body}'
            f'<script src="assets/gsap.min.js"></script><script>{"".join(js)}</script></body></html>')
    (folder / 'index.html').write_text(page, encoding='utf-8')


# ───────────────────────── 합성(ffmpeg) ─────────────────────────
def punch_expr(times, amp=0.07, dur=0.25):
    """펀치 시각마다 1→1+amp→1 (반 사인)."""
    terms = [f"between(t,{t:.3f},{t + dur:.3f})*sin(PI*(t-{t:.3f})/{dur})" for t in times]
    return f"1+{amp}*({'+'.join(terms) or '0'})"


def shot_points(seg):
    """shots 구간: seg.shots = [[원본 시각, 창 크기, x, y], ...](샷 시작마다 한 줄) → [(구간 프레임, 창, x, y)], 첫 점은 0."""
    out = []
    for t, cw, x, y in sorted(seg['shots']):
        f = max(0, round((t - seg['start']) * FPS))
        if out and f <= out[-1][0]:
            out[-1] = (out[-1][0], int(cw), int(x) // 2 * 2, int(y) // 2 * 2)
        else:
            out.append((f, int(cw), int(x) // 2 * 2, int(y) // 2 * 2))
    out[0] = (0,) + out[0][1:]
    return out


def keep_off_logo(points, box):
    """원본 고정 로고(logo_box = [x0, y0, x1, y1], 원본 화소)가 창에 들어오지 않게 카메라 x 를 묶는다.
    로고가 왼쪽 절반이면 창 왼쪽 끝을 로고 오른쪽 너머로, 오른쪽이면 창 오른쪽 끝을 로고 왼쪽 앞으로."""
    if not box:
        return points
    x0, _, x1, _ = box
    lo, hi = (x1 + 10, SRC_W - CROP_W) if x1 < SRC_W / 2 else (0, x0 - 10 - CROP_W)
    return [(f, int(min(max(x, lo), hi)) // 2 * 2, j) for f, x, j in points]


def screen(spec, folder, segs, cams):
    """린박스 화면 검사 관문 — 조각 목록을 그쪽 형식(pieces.json)으로 남기고 rinbox_screen.py 를 그대로 돌린다. 결과 문자열."""
    rd = folder / '_render'
    pieces, f0 = [], 0
    for s, cam in zip(segs, cams):
        n_fr = int(round(float(s['fill']) * FPS)) if s.get('fill') else round((s['end'] - s['start']) * FPS)
        if s.get('camera') == 'shots':                  # 샷마다 창이 다르다 — 관문에는 샷 하나를 조각 하나로
            pts = shot_points(s) + [(n_fr, 0, 0, 0)]
            for (fa, c, x, y), (fb, *_) in zip(pts, pts[1:]):
                pieces.append({'seg': len(pieces), 'out_f0': f0 + fa, 'frames': fb - fa, 'src_t0': round(s['start'] + fa / FPS, 3),
                               'cam': [[0, x, True]], 'cw': c, 'ch': c, 'y': y})
            f0 += n_fr
            continue
        cw = s.get('crop', 540 if s.get('camera') == 'track' else CROP_W)
        ch = cw
        if s.get('camera') == 'wide':
            cw, ch = SRC_W, 1080
        pieces.append({'seg': len(pieces), 'out_f0': f0, 'frames': n_fr, 'src_t0': round(s['start'], 3),
                       'cam': [list(c) for c in cam], 'cw': cw, 'ch': ch, 'y': int(s.get('crop_y', 0))})
        f0 += n_fr
    (rd / 'pieces.json').write_text(json.dumps({'source': str(segs[0]['src']), 'mirror': False, 'fps': FPS,
                                                'pieces': pieces}, ensure_ascii=False) + '\n', encoding='utf-8')
    r = subprocess.run([VISION_PY, RINBOX + '/rinbox_screen.py', str(rd)], capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    (rd / 'screen.txt').write_text(r.stdout + r.stderr[-2000:], encoding='utf-8')
    return r.stdout


def compose(spec, folder, overlay, pic_only=False):
    """구간마다 자르기(talk = 화자 추적 x, track = 멤버 추적 x·y) → 1080x1080 → 이어 붙이기 → 줌 펀치 → 그래픽."""
    segs, d = segments(spec), total(spec)
    z = punch_expr([float(e['t']) for e in spec['events'] if e['type'] == 'punch'])
    ins, fc = [], f"color=c={BG}:s={W}x{H}:r={FPS}:d={d:.3f}[bg];"
    cams = []
    for i, s in enumerate(segs):
        ins += ['-ss', f"{s['start']:.3f}", '-t', f"{s['end'] - s['start']:.3f}", '-i', str(s['src'])]
        if s.get('camera') == 'wide':                 # 예능 등 16:9 통째(10/17 소유주: 얼굴·방송 자막 잘림 금지) — 뒤는 같은 화면 흐림
            crop = (f"split[wa{i}][wb{i}];[wa{i}]scale=-2:{VH},crop={VW}:{VH},gblur=sigma=28,eq=brightness=-0.10[wg{i}];"
                    f"[wb{i}]scale={VW}:-2[wf{i}];[wg{i}][wf{i}]overlay=0:(H-h)/2")
            cams.append([(0, 0, True)])
        elif s.get('camera') == 'shots':                # 샷마다 창 크기·위치 — 방송 자막 띠가 있는 샷은 당겨서(창 아래끝 < 자막 위끝) 피하고
            pts = shot_points(s)                        # 없는 샷은 풀어서 넓게(10/18 소유주: 지우기·블러 대신 확대했다 풀었다)
            def step(vals):                              # 입력 프레임(in) 기준 계단(it 는 0.3초 늦었다) — scale(eval=frame)+crop 은 크기가 바뀔 때 crop 이 다시 설정돼
                e = str(vals[-1][1])                     # 창이 첫 샷 자리로 돌아갔다(10/18 실측). zoompan 은 출력 크기가 고정이라 안전하다
                for (f, v), (g, _) in reversed(list(zip(vals, vals[1:]))):
                    e = f"if(lt(in,{g}),{v},{e})"
                return e
            cz, ex, ey = (step([(f, c) for f, c, _, _ in pts]), step([(f, x) for f, _, x, _ in pts]),
                          step([(f, y) for f, _, _, y in pts]))
            crop = (f"pad={SRC_W}:{SRC_W}:0:0,"           # 정사각 입력이어야 zoompan 의 보이는 창이 정사각(cw x cw)
                    f"zoompan=z='{SRC_W}/({cz})':x='{ex}':y='{ey}':d=1:s={VW}x{VH}:fps={FPS}")
            cams.append([(f, x, True) for f, _, x, _ in pts])
        elif s.get('camera') == 'fixed':                # 움짤 등: 창을 x 에 고정
            cw = s.get('crop', CROP_W)
            crop = f"crop={cw}:{cw}:{int(s['x'])}:{int(s.get('crop_y', 0))}"
            cams.append([(0, int(s['x']), True)])
        elif s.get('camera', 'talk') == 'track':
            xs, ys = track_points(s)
            cw = s.get('crop', 540)
            crop = f"crop={cw}:{cw}:'{cam_expr(xs)}':'{cam_expr(ys)}'"
            cams.append(xs)
        elif s.get('camera') == 'member':
            cw = s.get('crop', CROP_W)
            out0 = sum(seg_len(x) for x in segs[:i])
            pts = keep_off_logo(member_cam(spec, s, folder, i, out0), s.get('logo_box'))
            crop = f"crop={cw}:{cw}:'{cam_expr(pts)}':{int(s.get('crop_y', 0))}"
            cams.append(pts)
        else:
            cw = s.get('crop', CROP_W)
            pts = keep_off_logo(camera(s, folder, i), s.get('logo_box'))
            crop = f"crop={cw}:{cw}:'{cam_expr(pts)}':{int(s.get('crop_y', 0))}"
            cams.append(pts)
        n_src = round((s['end'] - s['start']) * FPS)            # 구간 프레임 수를 정확히 — pieces.json 과 실제 영상이 어긋나면
        base = (f"[{i}:v]fps={FPS}:round=up,trim=end_frame={n_src},setpts=PTS-STARTPTS,"   # 관문이 이음매를 깜빡임으로 오인한다
                f"{crop},scale={VW}:{VH}:flags=lanczos,setsar=1,format=yuv420p")
        dreamy = ''
        if s.get('dreamy'):
            f = seg_len(s)
            dreamy = (f",format=gbrp,split[dq{i}][dg{i}];[dg{i}]gblur=sigma=22,eq=brightness=0.02:saturation=1.05[dgb{i}];"
                      f"[dq{i}][dgb{i}]blend=all_mode=screen:all_opacity=0.26,colorbalance=rs=0.02:gs=0:bs=0.015,format=yuv420p,"
                      f"scale=w='trunc({VW}*(1+0.06*t/{f:.3f})/2)*2':h='trunc({VH}*(1+0.06*t/{f:.3f})/2)*2':eval=frame,"
                      f"crop={VW}:{VH},setsar=1")
        if s.get('fill'):
            # 움짤: 짧은 장면을 앞으로·뒤로 왕복(부메랑)해 fill 초를 채운다. 원음은 끈다(효과음·노래가 대신한다).
            n_f = round((s['end'] - s['start']) * FPS)
            fc += (f"{base}[b{i}];[b{i}]split[bf{i}][br{i}];[br{i}]reverse[brr{i}];[bf{i}][brr{i}]concat=n=2:v=1:a=0,"
                   f"loop=loop=-1:size={2 * n_f},trim=duration={s['fill']:.3f},setpts=N/FRAME_RATE/TB{dreamy}[v{i}];"
                   f"aevalsrc=0:s=48000:d={s['fill']:.3f},aformat=channel_layouts=stereo[a{i}];")
        else:
            fc += (f"{base}{dreamy}[v{i}];"
                   f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration={n_src / FPS:.4f},apad=whole_dur={n_src / FPS:.4f},"
                   f"volume={0 if s.get('mute') else s.get('gain', 1.0)},"
                   f"afade=t=in:d=0.03,afade=t=out:st={max(0.0, seg_len(s) - 0.04):.3f}:d=0.04[a{i}];")   # 이음매 «틱» 방지
    n = len(segs)
    fc += ''.join(f'[v{i}][a{i}]' for i in range(n)) + f"concat=n={n}:v=1:a=1[cv][ca];"
    hold = float(spec.get('hold', 0))
    if hold:
        fc += f"[cv]tpad=stop_mode=clone:stop_duration={hold:.3f}[cvh];[ca]apad=pad_dur={hold:.3f}[cah];"
    cv, ca = ('cvh', 'cah') if hold else ('cv', 'ca')
    ov = n
    if pic_only:
        fc += f"[{cv}]null[pic];[{ca}]anullsink;[bg]nullsink"
        rd = folder / '_render'
        rd.mkdir(exist_ok=True)
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[pic]', '-an',
                        '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast', str(rd / 'pic.mp4')], check=True)
        return screen(spec, folder, segs, cams)
    fc += f"[{cv}]split[{cv}m][{cv}p];"
    cv_pic = f'{cv}p'
    fc += (f"[{cv}m]scale=w='trunc({VW}*({z})/2)*2':h='trunc({VH}*({z})/2)*2':eval=frame,crop={VW}:{VH}[pv];"
           f"[bg][pv]overlay={VX}:{VY}[base];"
           f"[base][{ov}:v]overlay=format=auto,format=yuv420p[v];"
           f"[{ca}]loudnorm=I=-14:TP=-1.5:LRA=11[an];")
    sfx = spec.get('sfx', [])                      # [{"file","t","gain"}] — 편집자 한마디 «반짝» 등
    music = spec.get('music', [])
    for m in music:                                # 노래 하이라이트 — 효과음과 같은 길로 섞는다(파일 조각으로)
        clip = folder / f"music_{len(sfx)}.wav"
        fi, fo, du = m.get('fade_in', .15), m.get('fade_out', .6), m['dur']
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f"{m['from']:.3f}", '-t', f'{du:.3f}', '-i', m['file'],
                        '-vn', '-af', f'afade=t=in:d={fi},afade=t=out:st={du - fo:.3f}:d={fo}', '-ar', '48000', '-ac', '2', str(clip)],
                       check=True)
        sfx = sfx + [{'file': str(clip), 't': m['t'], 'gain': m.get('gain', 0.55)}]
    for k, s in enumerate(sfx):
        ms = int(float(s['t']) * 1000)
        fc += f"[{n + 1 + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms},volume={s.get('gain', 0.8)}[s{k}];"
    fc += (''.join(f'[s{k}]' for k in range(len(sfx))) and
           '[an]' + ''.join(f'[s{k}]' for k in range(len(sfx))) + f"amix=inputs={1 + len(sfx)}:normalize=0:duration=first[a]") or '[an]anull[a]'
    sfx_in = [a for s in sfx for a in ('-i', s['file'])]
    out = folder / 'out.mp4'
    rd = folder / '_render'
    rd.mkdir(exist_ok=True)
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *ins, '-i', str(overlay), *sfx_in, '-filter_complex', fc,
                    '-map', '[v]', '-map', '[a]', '-t', f'{d:.3f}', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium',
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', str(out),
                    '-map', f'[{cv_pic}]', '-an', '-t', f'{d:.3f}', '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
                    str(rd / 'pic.mp4')], check=True)
    screen(spec, folder, segs, cams)
    return out


def main(spec_path):
    spec_path = Path(spec_path).resolve()
    folder = spec_path.parent
    spec = tidy(one_line(json.loads(spec_path.read_text(encoding='utf-8'))), folder)
    hf = folder / 'overlay.hf'
    build_overlay(spec, hf)
    ov = folder / 'overlay.mov'
    if '--no-render' not in sys.argv:
        render(hf, ov)
    out = compose(spec, folder, ov)
    print('화면 검사(린박스):', ((folder / '_render' / 'screen.txt').read_text(encoding='utf-8').strip().splitlines() or ['?'])[0:3])
    if '--keep-overlay' not in sys.argv:
        ov.unlink(missing_ok=True)          # 투명 MOV 는 편당 1GB 넘는다
    print(out)


if __name__ == '__main__':
    main(sys.argv[1])
