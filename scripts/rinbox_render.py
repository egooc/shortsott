# 린박스 자체 렌더러 v0 — 볼케이노 없이 편집표 하나로 완성본을 만든다.
#
#   python scripts/rinbox_render.py <plan.json> [--out out.mp4] [--no-tts]
#
# 왜 직접 만드나: 2026-10-08 볼케이노가 린박스 피사체 판독을 AGY(Antigravity Gemini) 필수로 바꿨고,
# 주간 Gemini 한도가 2편에 소진된다. 하루 6편 목표와 구조적으로 안 맞는다(소유주 결정: 자립).
# 화면 치수·색은 이미 발행된 우리 영상(rinbox69ja final)에서 재어 그대로 맞췄다 — 채널 모양이 바뀌면 안 된다.
#
# 화면 (1080x1920)
#   y   0~ 218  검정
#   y 218~ 311  제목 1줄  노랑 #F0D800
#   y 350~ 440  제목 2줄  빨강 #F00000
#   y 450~1470  그림 1080x1020 (원본에서 cx 로 가로를 골라 잘라 넣는다)
#   y 1518~1561 크레딧     회색 #909090
#   자막은 그림 안쪽 아래(기준 영상 실측 y 1250~1398)
#
# plan.json  — 지금까지 쓰던 _edit.json 에 source/transcript/camera 만 더한 모양이다
# {
#   "source": "D:/volcano-runs/rinbox13ja/volcano_src.mp4",
#   "transcript": "D:/volcano-runs/rinbox73ja/transcript.json",
#   "lang": "ja",                      ko 면 자막을 공백으로 잇고, ja 면 붙여 쓴다
#   "mirror": true,                    좌우 뒤집기(기존 편과 같게)
#   "title": ["아래 줄", "윗 줄"], "credit": "작품명",
#   "narration": [{"id": "n0", "cards": ["...", "..."]}, ...],
#   "sequence": [
#     {"narration": "n0", "cx": 0.5},                                   그림은 다음 컷 앞에서 거꾸로 잡는다
#     {"source_in": 807.7667, "source_out": 829.1667,
#      "captions": ["...", "..."], "cx": 0.5},                           원음 + 자막
#     ...
#   ]
# }
# 음성은 Typecast with-timestamps — 볼케이노와 같은 목소리·키다. 같은 글은 tts/ 캐시를 재사용한다.
import argparse, base64, hashlib, json, math, os, re, subprocess, sys, urllib.request
from pathlib import Path

MIDFORM = Path(__file__).resolve().parents[1]
W, H, FPS = 1080, 1920, 30
# ★longshort_render.py(A 롱투숏·명화관)가 import 해 PIC_Y0/PIC_Y1/PIC_H·TITLE_MAX·write_ass(시그니처)·아래 합성식을 갈아 끼운다 — 바꾸기 전에 명화관 세션에 한 줄 알릴 것
PIC_Y0, PIC_Y1 = 450, 1470                       # 그림 창
PIC_H = PIC_Y1 - PIC_Y0                          # 1020
VOICE = {'voice_id': 'tc_68257f68bc6e3c161ab5078d', 'model': 'ssfm-v30',
         'emotion': 'normal', 'tempo': 1.05, 'seed': 42}
LANG = {'ko': 'kor', 'ja': 'jpn', 'en': 'eng'}
JOIN = {'ko': ' ', 'ja': '', 'en': ' '}          # 자막 칸을 이어 붙일 때
CAP_MAX = {'ko': 12, 'ja': 11, 'en': 24}
TITLE_MAX = {'ko': 9, 'ja': 8, 'en': 20}
LOSSLESS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p']
FINAL = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p']


def run(cmd, **kw):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', **kw)
    if r.returncode:
        sys.exit('명령 실패: %s\n%s' % (' '.join(str(c) for c in cmd)[:300], r.stderr[-1500:]))
    return r


def frames(sec):
    return int(round(sec * FPS))


# ---------------------------------------------------------------- 음성
def tts(text, lang, cache):
    body = {'text': text, 'voice_id': VOICE['voice_id'], 'model': VOICE['model'],
            'language': LANG[lang], 'seed': VOICE['seed'],
            'prompt': {'emotion_type': 'preset', 'emotion_preset': VOICE['emotion'], 'emotion_intensity': 1},
            'output': {'volume': 100, 'audio_pitch': 0, 'audio_tempo': VOICE['tempo'], 'audio_format': 'wav'}}
    h = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
    wav, meta = cache / ('%s.wav' % h), cache / ('%s.json' % h)
    if not (wav.exists() and meta.exists()):
        key = (Path.home() / '.volcano' / 'keys' / 'typecast').read_bytes().decode('utf-8-sig').strip()
        req = urllib.request.Request(
            'https://api.typecast.ai/v1/text-to-speech/with-timestamps',
            data=json.dumps(body).encode(),
            headers={'X-API-KEY': key, 'Content-Type': 'application/json'})
        r = json.loads(urllib.request.urlopen(req, timeout=120).read())
        wav.write_bytes(base64.b64decode(r['audio']))
        meta.write_text(json.dumps({'text': text, 'words': r['words'],
                                    'duration': r.get('audio_duration')}, ensure_ascii=False), encoding='utf-8')
        print('  음성 구매 %d자: %s' % (len(text), text[:34]))
    return wav, json.loads(meta.read_text(encoding='utf-8'))


# ---------------------------------------------------------------- 자막 시각
def card_times(words, t0, t1, cards, join):
    """자막 칸을 전사 토큰에 되짚어 각 칸의 (시작, 끝)을 돌려준다.

    snap_captions.snap 이 만든 칸을 그대로 받는다 — 칸 경계는 이미 토큰 경계다.
    """
    # ★말꼬리가 컷 끝을 0.3초 안으로 넘는 토큰은 받아 끝을 컷 끝에 맞춘다 — 샷 경계에서 자르면 전사 끝 시각이
    #   실제 소리보다 늦게 잡힌 토큰이 걸린다(2026-10-09 82ko 「아니냐」 544.03, 543.96 뒤는 -44dB 무음).
    toks = [(s, min(e, t1), x) for s, e, x in words if s >= t0 - 1e-3 and e <= t1 + 0.3]
    out, i = [], 0
    for c in cards:
        # 「토큰글|보일글」 — 시각은 전사 토큰에서 재고, 화면엔 전사 오타를 고친 글을 띄운다(반딩→반띵)
        c, show = (c.split('|', 1) + [None])[:2] if '|' in c else (c, None)
        want = c.replace(' ', '')
        got, a, b = '', None, None
        while i < len(toks) and len(got) < len(want):
            s, e, x = toks[i]
            if a is None:
                a = s
            got += x
            b = e
            i += 1
        if got != want:
            raise SystemExit('자막이 전사 토큰과 안 맞는다: %r ≠ %r' % (c, got))
        out.append((a, b, show or c))
    return out


# ---------------------------------------------------------------- ASS
def ass_time(t):
    t = max(0.0, t)
    return '%d:%02d:%05.2f' % (int(t // 3600), int(t % 3600 // 60), t % 60)


def esc(s):
    return s.replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}')


# 언어별 모양 — 기준 영상에서 재어 맞췄다(ja: rinbox69ja final · ko: rinbox68ko final).
# 같은 글자를 시험 렌더해 폭·높이 오차 1~2% 안으로 역산했다(scratchpad calib_ko.py).
# 각 항목: (글꼴, 크기, 색 &HAABBGGRR, 굵게, 기울임, 테두리, 세로 가운데)
LOOK = {
    'ja': {'T1': ('Noto Sans JP', 146, '&H0000D8F0', 1, 0, 0, 264),
           'T2': ('Noto Sans JP', 146, '&H000000F0', 1, 0, 0, 395),
           'CR': ('Noto Sans JP', 65, '&H00909090', 0, 1, 0, 1539),
           'CAP': ('Noto Sans JP', 80, '&H00FFFFFF', 1, 0, 6, 1245)},
    # ko 제목·크레딧은 «Gmarket Sans Bold» 로 이름을 박아야 Bold 가 물린다(가족 이름만 주면 Medium) · 제목은 기울임
    'ko': {'T1': ('Gmarket Sans Bold', 142, '&H0000ECFC', 1, 1, 0, 260),
           'T2': ('Gmarket Sans Bold', 142, '&H000014FC', 1, 1, 0, 387),
           'CR': ('Gmarket Sans Bold', 64, '&H00989898', 1, 1, 0, 1537),
           'CAP': ('Gmarket Sans', 98, '&H00F8F8F8', 0, 0, 3, 1237)},
}


def write_ass(path, title, credit, events, total, lang):
    look = LOOK.get(lang, LOOK['ja'])
    head = [
        '[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes',
        'PlayResX: %d' % W, 'PlayResY: %d' % H, '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, '
        'Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, '
        'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ]
    for name, (font, size, col, bold, ital, outline, _) in look.items():
        head.append('Style: %s,%s,%d,%s,&H00000000,&H00000000,%d,%d,0,0,100,100,0,0,1,%d,0,5,0,0,0,1'
                    % (name, font, size, col, bold, ital, outline))
    head += ['', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    body = []
    full = '0:00:00.00,%s' % ass_time(total)
    body.append('Dialogue: 0,%s,T1,,0,0,0,,{\\pos(%d,%d)}%s' % (full, W // 2, look['T1'][6], esc(title[0])))
    if len(title) > 1:
        body.append('Dialogue: 0,%s,T2,,0,0,0,,{\\pos(%d,%d)}%s' % (full, W // 2, look['T2'][6], esc(title[1])))
    body.append('Dialogue: 0,%s,CR,,0,0,0,,{\\pos(%d,%d)}%s' % (full, W // 2, look['CR'][6], esc(credit)))
    for a, b, text in events:
        body.append('Dialogue: 1,%s,%s,CAP,,0,0,0,,{\\pos(%d,%d)}%s'
                    % (ass_time(a), ass_time(b), W // 2, look['CAP'][6], esc(text)))
    path.write_text('\n'.join(head + body) + '\n', encoding='utf-8')


# ---------------------------------------------------------------- 그림
def snap_to_shot(src, t, reach=0.3, found=None):
    """t 근처(±reach)에서 가장 가까운 샷 경계 시각. 없으면 t. 경계 = 장면 변화 점수가 가장 큰 프레임(0.25 넘을 때).
    found 에 리스트를 주면 경계를 찾았는지(True/False)를 덧붙인다 — 카메라가 «즉시 바뀜»인지 «미끄러짐»인지 가른다."""
    a = max(0.0, t - reach)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-ss', '%.3f' % a, '-t', '%.3f' % (2 * reach), '-i', str(src),
                        '-vf', "scale=320:-2,select='gte(scene,0)',metadata=print", '-an', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    best, pts = None, None
    for line in r.stderr.splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            pts = float(m.group(1))
        m = re.search(r'lavfi\.scene_score=([\d.]+)', line)
        if m and pts is not None:
            sc = float(m.group(1))
            if sc > 0.25 and (best is None or sc > best[0]):
                best = (sc, a + pts)
    if found is not None:
        found.append(best is not None)
    if best is None:
        return t
    # ★한 프레임 당긴다 — 23.976 원본을 30 으로 바꾸면 새 샷 첫 장이 경계 시각보다 한 칸 앞 출력 프레임에 온다
    #   (2026-10-09 화면 검사 실측: 78ja 일곱 곳 모두 +1프레임)
    return round((round(best[1] * FPS) - 1) / FPS, 4)


def probe_size(src):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                        '-of', 'csv=p=0', str(src)], capture_output=True, text=True, check=True)
    w, h = r.stdout.strip().split(',')[:2]
    return int(w), int(h)


def measure_content(src, times, iw, ih):
    """알맹이(레터·필러박스를 뺀 실제 그림)의 가로 범위 (x, w). 볼케이노 measure_content 와 같은 cropdetect=24:2:0,
    쓰는 구간 몇 곳에서 재어 가장 많이 나온 값을 쓴다. 로고가 검은 띠에 있으면 넓게 나오는데 — 그건 덜 가둘 뿐이라 무해하다."""
    seen = {}
    for t in times[:4]:
        r = subprocess.run(['ffmpeg', '-hide_banner', '-ss', '%.3f' % t, '-t', '2', '-i', str(src), '-vf', 'cropdetect=24:2:0',
                            '-an', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
        for m in re.finditer(r'crop=(\d+):(\d+):(\d+):(\d+)', r.stderr):
            k = (int(m.group(3)), int(m.group(1)))
            seen[k] = seen.get(k, 0) + 1
    if not seen:
        return 0, iw
    x, w = max(seen, key=seen.get)
    if w < iw * 0.5:          # 어두운 장면에 속은 값은 버린다
        return 0, iw
    return x, w


def cam_expr(points):
    """crop x 식 — points = [(출력프레임, x화소, 즉시?)...], 첫 점은 0. 볼케이노 camera_expression 과 같은 꼴:
    다음 점이 «즉시»(샷 경계)면 그 전까지 고정, 아니면(샷 안) 앞 점에서 다음 점까지 선형으로 미끄러진다."""
    expr = str(points[-1][1])
    for (fa, xa, _), (fb, xb, jump) in reversed(list(zip(points, points[1:]))):
        if jump or fb <= fa:
            expr = 'if(lt(n,%d),%d,%s)' % (fb, xa, expr)
        else:
            expr = 'if(lt(n,%d),%d+(%d)*clip((n-%d)/%d,0,1),%s)' % (fb, xa, xb - xa, fa, fb - fa, expr)
    return expr


def window(iw, ih, content, zoom):
    """창 크기와 cx→x 변환. cx 는 «원본 통짜 가로» 기준, 창만 알맹이 안으로 가둔다(볼케이노와 같다)."""
    z, cy = zoom
    ch = int(round(ih * z / 2)) * 2
    cw = int(round(min(content[1], ih * z * W / PIC_H) / 2)) * 2
    y = int(round(min(max(ih * cy - ch / 2, 0), ih - ch) / 2)) * 2
    def x_of(cx):
        return int(round(max(content[0], min(content[0] + content[1] - cw, cx * iw - cw / 2)) / 2)) * 2
    return cw, ch, y, x_of


def pic_cam(src, t0, n_frames, points, mirror, out, cw, ch, y):
    """원본 t0 부터 n_frames 를 한 번에 굽는다 — 카메라는 식 안에서 움직인다(조각을 잘라 붙이지 않는다).
    ★fps 를 crop 보다 먼저 둔다 → 식의 n 이 출력 프레임 번호다. round=up: 어떤 장도 제 시각보다 먼저 나오지 않게."""
    vf = ("fps=%d:round=up,crop=%d:%d:'%s':%d,scale=%d:%d:flags=lanczos,setsar=1"
          % (FPS, cw, ch, cam_expr(points), y, W, PIC_H))
    if mirror:
        vf += ',hflip'
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % t0, '-i', src,
         '-t', '%.3f' % (n_frames / FPS + 0.5), '-vf', vf, '-frames:v', n_frames,
         '-an', *LOSSLESS, out])


def pic_clip(src, t0, n_frames, cx, mirror, out, zoom=(1.0, 0.5)):
    """원본 t0 부터 n_frames 만큼을 떼어 1080x1020 그림 창으로 만든다.

    cx 는 «원본 가로»의 어디를 가운데로 둘지(0~1)다 — AGY 없이 내가 프레임을 보고 정한다.
    zoom=(z, cy): 원본 높이의 z 만큼만 창으로 쓰고 세로 가운데를 cy 에 둔다(1.0 이면 높이 전체).
      볼케이노 2026-10-08 판의 «샷별 확대 창»에서 옮겼다. 쓰임: 원본 위쪽에 박힌 방송사 로고 띠를
      잘라 내면서도 화자 쪽으로 cx 를 옮길 수 있게 한다(사마귀 SBS CATCH — 로고 y 0~7.5%).
    """
    z, cy = zoom
    ch = 'ih*%.6f' % z
    cw = 'ih*%.6f' % (z * W / PIC_H)            # 창 비율(1080:1020)만큼의 가로
    x = "clip(iw*%.6f-(%s)/2,0,iw-(%s))" % (cx, cw, cw)
    y = "clip(ih*%.6f-(%s)/2,0,ih-(%s))" % (cy, ch, ch)
    # ★fps=..:round=up — 23.976→30 변환에서 기본(near)은 새 샷 첫 장을 반 프레임 일찍 당겨 와 조각 끝에
    #   다음 샷이 1프레임 비쳤다(2026-10-09 화면 검사). 어떤 장도 제 시각보다 먼저 나오지 않게 한다.
    vf = ("crop='min(iw,%s)':'%s':'%s':'%s',scale=%d:%d:flags=lanczos,setsar=1,fps=%d:round=up"
          % (cw, ch, x, y, W, PIC_H, FPS))
    if mirror:
        vf += ',hflip'
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % t0, '-i', src,
         '-t', '%.3f' % (n_frames / FPS + 0.5), '-vf', vf, '-frames:v', n_frames,
         '-an', *LOSSLESS, out])


# 길이 창 — 위쪽 50→59 (2026-10-11 소유주: «59초 안에서 아크가 닫혀야»). 결말을 자르느니 길이를 쓴다.
LEN_MIN, LEN_MAX = 40, 59
SEG_LUFS = -17.0      # 구간 음량 기준 — 최종 loudnorm(-14) 전에 구간끼리 높이를 맞춘다


def level(wav, out, target=SEG_LUFS, cap=8.0):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(wav), '-af', 'ebur128', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    v = re.findall(r'I:\s+(-?[\d.]+) LUFS', r.stderr)
    if not v or float(v[-1]) < -60:          # 거의 무음이면 손대지 않는다
        return Path(wav)
    gain = max(-cap, min(cap, target - float(v[-1])))
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-af', 'volume=%.2fdB' % gain,
         '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out])
    return out


def clip_audio(src, t0, sec, out):
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % t0, '-i', src,
         '-t', '%.3f' % sec, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out])


def source_marks(src, work):
    """소스의 고정 표식(로고) 자리 — 볼케이노 _preset_trials/소스_화면검사.py 를 한 번 돌려 소스 옆에 남긴다."""
    cache = Path(src).with_name(Path(src).stem + '.marks.json')
    # 소스를 같은 이름으로 다시 받으면(88ko·89ko 교체) 옛 캐시가 남는다 — 소스가 더 새면 다시 잰다
    if not cache.exists() or cache.stat().st_mtime < Path(src).stat().st_mtime:
        chk = Path('D:/volcano-runs/_preset_trials/소스_화면검사.py')
        if not chk.exists():
            print('⚠ 소스 화면검사가 없다 — 로고 상한 없이 간다')
            return []
        r = subprocess.run([sys.executable, str(chk), str(src), '--json'], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        if r.returncode:
            sys.exit('소스 화면검사 실패:\n' + r.stderr[-800:])
        cache.write_text(r.stdout, encoding='utf-8')
    j = json.loads(cache.read_text(encoding='utf-8'))
    if j.get('blockers'):
        print('⚠ 소스 검사 ✗: ' + ' / '.join(j['blockers']))
    for m in j.get('static_marks', []):
        print('고정 표식 %s x %.3f~%.3f → 창 밖으로' % (m.get('corner'), m['x'][0], m['x'][1]))
    return j.get('static_marks', [])


# ---------------------------------------------------------------- 조립
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    plan = json.loads(Path(a.plan).read_text(encoding='utf-8'))
    lang = plan.get('lang', 'ja')
    src = plan['source']
    words = json.loads(Path(plan['transcript']).read_text(encoding='utf-8'))
    work = Path(a.plan).resolve().parent / '_render'
    work.mkdir(exist_ok=True)
    cache = MIDFORM / 'cache' / 'tts'
    cache.mkdir(parents=True, exist_ok=True)
    out = Path(a.out) if a.out else work / 'final.mp4'

    for i, line in enumerate(plan['title']):
        if len(line) > TITLE_MAX[lang]:
            sys.exit('제목 %d줄이 %d자를 넘는다: %r' % (i + 1, TITLE_MAX[lang], line))

    # 0) 이름 관문 — 음성을 사기 전에 배역표와 대조한다(rinbox_names.py, 2026-10-09)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import rinbox_names
    if not rinbox_names.check(a.plan):
        sys.exit('이름 관문에서 막혔다 — 배역표(rinbox_catalog.json cast)와 맞춰 고친 뒤 다시')
    # 재사용 관문(2026-10-09) — 이번 원음 대사가 이미 발행된 편에서 쓰였으면 막는다. 소스 영상 ID 가 옛 편엔 없어
    #   글자로 대조한다(rinbox_reuse.py). 일부러 다시 쓰는 편이면 plan 에 "allow_reuse": true.
    # 자막 칸 길이를 렌더 전에 한꺼번에 본다 — 조각을 굽다가 하나씩 걸리면 고칠 때마다 다시 돌아야 한다(89ko)
    longs = [c for s in plan['sequence'] for c in s.get('captions', [])
             if len(c.split('|', 1)[-1]) > CAP_MAX[plan.get('lang', 'ko')]]
    if longs:
        sys.exit('자막 칸이 %d자를 넘는다: %s' % (CAP_MAX[plan.get('lang', 'ko')], ' / '.join(longs)))
    import rinbox_reuse
    if not rinbox_reuse.check(a.plan) and not plan.get('allow_reuse'):
        sys.exit('재사용 관문에서 막혔다 — 이미 발행된 편과 같은 대사 구간이다')

    nar = {n['id']: n for n in plan['narration']}

    # 1) 음성을 먼저 사고 길이를 받는다 — 길이가 정해져야 그림을 몇 프레임 뽑을지 안다
    for n in plan['narration']:
        # ★칸은 «공백»으로 잇는다(언어 무관) — 볼케이노와 같은 글이어야 같은 끊어 읽기가 나온다.
        text = ' '.join(n['cards'])
        n['text'] = text
        wav, n['meta'] = tts(text, lang, cache)
        # ★앞뒤 여유는 엔진 공식 그대로 — 앞 0.065초 · 뒤 0.09초 · 프레임 올림(film_editor.py 717~719,
        #   명화관 명세 10장 9항). 타입캐스트 음성은 앞에 무음이 0.35초쯤 붙어 해설마다 8프레임 늘어졌다.
        #   min(audio_duration, …) 을 빼면 없는 소리를 달라 해 마지막 해설이 넘친다.
        d, w = n['meta']['duration'], n['meta']['words']
        a, b = (max(0, w[0]['start'] - .065), min(d, w[-1]['end'] + .09)) if w else (0, d)
        n['dur'] = math.ceil((b - a) * FPS) / FPS
        n['wav'] = work / ('n_%s.wav' % n['id'])
        run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % a, '-i', wav, '-af', 'apad',
             '-t', '%.4f' % n['dur'], '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', n['wav']])

    # 2) 구간을 펼친다 — 내레이션 그림은 «앞 컷 끝에서 이어서», 맨 앞은 «다음 컷 앞에서 거꾸로»
    seq = plan['sequence']
    segs, prev_end = [], None
    for i, s in enumerate(seq):
        if 'narration' in s:
            n = nar[s['narration']]
            dur = n['dur']
            if 'pic_in' in s:
                # ★직접 지정 — 앞뒤 샷에 오프닝·박힌 글자가 있으면 같은 장면의 다른 자리를 쓴다
                pic_in = s['pic_in']
            elif prev_end is not None:
                pic_in = prev_end
            else:
                nxt = next((x for x in seq[i + 1:] if 'source_in' in x), None)
                if nxt is None:
                    sys.exit('맨 앞 내레이션 뒤에 컷이 없다')
                pic_in = nxt['source_in'] - dur
            segs.append({'kind': 'nar', 'id': n['id'], 'pic_in': pic_in, 'dur': dur,
                         'cx': s.get('cx', 'auto' if plan.get('camera') == 'auto' else 0.5), 'zoom': s.get('zoom', plan.get('zoom', [1.0, 0.5])), 'wav': n['wav']})
        else:
            dur = s['source_out'] - s['source_in']
            segs.append({'kind': 'cut', 'pic_in': s['source_in'], 'dur': dur,
                         'cx': s.get('cx', 'auto' if plan.get('camera') == 'auto' else 0.5), 'zoom': s.get('zoom', plan.get('zoom', [1.0, 0.5])), 'captions': s.get('captions', []),
                         't0': s['source_in'], 't1': s['source_out']})
            prev_end = s['source_out']

    total = sum(g['dur'] for g in segs)
    if not LEN_MIN <= total <= LEN_MAX:
        print('⚠ 길이 %.2f초 — %d~%d초 밖이다' % (total, LEN_MIN, LEN_MAX))

    # 3) 그림·소리 조각을 만든다
    iw, ih = probe_size(src)
    content = tuple(plan['content']) if plan.get('content') else measure_content(src, [g['pic_in'] for g in segs], iw, ih)
    print('원본 %dx%d · 알맹이 x %d~%d' % (iw, ih, content[0], content[0] + content[1]))
    # 카메라 자동(rinbox_faces.py, 2026-10-09) — cx 가 "auto" 인 구간은 얼굴 추적이 샷마다 점을 찍는다.
    #   AGY 화자 판독 자리: 말하는 동안 입이 움직인 얼굴 · 흐린 앞사람·잘린 가장자리 얼굴은 뺀다.
    #   찍은 점과 이유는 _render/faces.json · faces.txt 에 남는다(눈검사 때 본다).
    auto = [g for g in segs if g['cx'] == 'auto']
    if auto:
        vpy = MIDFORM / '.venv-vision' / 'Scripts' / 'python.exe'
        cw0 = window(iw, ih, content, tuple(auto[0]['zoom']))[0]
        fin, fout = work / 'faces_in.json', work / 'faces.json'
        fin.write_text(json.dumps({'source': src, 'transcript': plan['transcript'], 'iw': iw, 'cw': cw0,
                                   'ranges': [[g['pic_in'], g['pic_in'] + g['dur']] for g in auto]},
                                  ensure_ascii=False) + '\n', encoding='utf-8')
        r = subprocess.run([str(vpy), str(Path(__file__).resolve().parent / 'rinbox_faces.py'), str(fin), str(fout)],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            sys.exit('얼굴 추적 실패:\n' + r.stderr[-1500:])
        (work / 'faces.txt').write_text(r.stdout, encoding='utf-8')
        for g, marks in zip(auto, json.loads(fout.read_text(encoding='utf-8'))['marks']):
            g['cx'] = marks
        print('카메라 자동 %d구간 · 점 %d개 (faces.txt)' % (len(auto), sum(len(g['cx']) for g in auto)))

    marks_fixed = source_marks(src, work)
    parts_v, parts_a, events, t = [], [], [], 0.0
    pieces, out_f = [], 0
    for k, g in enumerate(segs):
        nf = frames(g['dur'])
        # cx 는 숫자 하나거나 [[원본시각, cx], ...] / [[원본시각, cx, "pan"], ...].
        # 기본은 «즉시 전환»(샷 경계 ±0.3초면 경계에 붙인다). "pan" 을 붙인 점만 앞 점에서 그 점까지 미끄러진다 —
        # 볼케이노 camera_expression 의 식(2026-10-09, 명화관 발견). ★미끄러짐은 같은 샷 안에서만 쓴다:
        #   경계 찾기가 어두운 장면에서 실패하면 «샷 안»으로 오판돼 카메라가 컷을 가로질러 흘렀다(83ko 시험).
        marks = sorted(g['cx'] if isinstance(g['cx'], list) else [[g['pic_in'], g['cx']]], key=lambda m: m[0])
        cw, ch, y0, x_of = window(iw, ih, content, tuple(g['zoom']))
        # 고정 표식(방송사 로고)을 창 밖에 둔다 — 얼굴 추적이 가장자리 인물을 따라가도 로고가 들어오지 않게.
        #   표식 자리는 소스 검사에서, 상·하한은 «이 구간의 실제 창 폭»으로 계산한다(2026-10-09 87ko: 검사가 준
        #   cx 상한 0.603 은 좁은 창 기준이라 우리 창(원본 폭 60%)에선 「스브스」가 잘린 채 들어왔다).
        lo, hi = plan.get('cx_min', 0.0), plan.get('cx_max', 1.0)
        half = cw / iw / 2
        # 0.025 = «창 가장자리 ↔ 로고» 여유(원본 폭 비율). 명화관 MARGIN(피사체 네모 둘레 여유)과 숫자만 같고 뜻이
        #   다르다 — 한쪽을 조율해도 다른 쪽이 따라갈 이유가 없으니 상수로 합치지 말 것.
        for mk in marks_fixed:
            x0, x1 = mk['x']
            if x0 >= 0.5:
                hi = min(hi, x0 - half - 0.025)
            elif x1 <= 0.5:
                lo = max(lo, x1 + half + 0.025)
        marks = [[m[0], min(hi, max(lo, m[1]))] + list(m[2:]) for m in marks]
        points = [(0, x_of(marks[0][1]), True)]
        for m in marks[1:]:
            tm, c, pan = m[0], m[1], len(m) > 2 and m[2] == 'pan'
            tt = tm if pan else snap_to_shot(src, tm)
            f = min(nf - 1, max(1, frames(tt - g['pic_in'])))
            if f > points[-1][0]:
                points.append((f, x_of(c), not pan))
        v = work / ('v%02d.mp4' % k)
        pic_cam(src, g['pic_in'], nf, points, plan.get('mirror', True), v, cw, ch, y0)
        parts_v.append(v)
        # 조각 지도 — 화면 검사(rinbox_screen.py)가 «결과물 몇 프레임째 = 원본 몇 초, 창이 어디» 를 안다
        pieces.append({'seg': k, 'kind': g['kind'], 'out_f0': out_f, 'frames': nf, 'src_t0': round(g['pic_in'], 3),
                       'cam': [list(p) for p in points], 'cw': cw, 'ch': ch, 'y': y0})
        out_f += nf
        if g['kind'] == 'nar':
            parts_a.append(Path(g['wav']))
        else:
            au = work / ('a%02d.wav' % k)
            clip_audio(src, g['t0'], g['dur'], au)
            parts_a.append(au)
            for ca, cb, text in card_times(words, g['t0'], g['t1'], g['captions'], JOIN[lang]):
                if len(text) > CAP_MAX[lang]:
                    sys.exit('자막 칸이 %d자를 넘는다: %r' % (CAP_MAX[lang], text))
                events.append((t + ca - g['t0'], t + cb - g['t0'], text))
        t += nf / FPS

    total = t
    # 4) 이어 붙이고 검정 캔버스에 얹는다
    lst = work / 'v.txt'
    lst.write_text(''.join("file '%s'\n" % p.as_posix() for p in parts_v), encoding='utf-8')
    pic = work / 'pic.mp4'
    (work / 'pieces.json').write_text(json.dumps({'source': src, 'mirror': plan.get('mirror', True), 'fps': FPS,
        'pieces': pieces}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
         '-c', 'copy', pic])
    # ★구간마다 음량을 같은 기준으로 맞춘다(2026-10-08 실측: 내레이션이 원음 대사보다 0.5~3dB 커서
    #   내레이션으로 넘어갈 때 소리가 툭 커졌다). 정적 이득만 준다 — 짧은 조각에 loudnorm 을 걸면 숨 쉬듯 출렁인다.
    parts_a = [level(p, work / ('lv%02d.wav' % i)) for i, p in enumerate(parts_a)]
    lsta = work / 'a.txt'
    lsta.write_text(''.join("file '%s'\n" % p.as_posix() for p in parts_a), encoding='utf-8')
    voice = work / 'voice.wav'
    run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lsta,
         '-ac', '2', '-ar', '48000', voice])

    ass = work / 'cap.ass'
    write_ass(ass, plan['title'], plan['credit'], events, total, lang)
    ass_arg = str(ass).replace('\\', '/').replace(':', '\\:')
    fdir = str(MIDFORM / 'assets' / 'fonts' / 'rinbox').replace('\\', '/').replace(':', '\\:')
    # ★longshort_render.py 가 이 식('[bg][0:v]overlay=0:%d:shortest=1[p];')을 문자열로 찾는다 — 바꾸면 명화관에 알릴 것
    fc = ("color=c=black:s=%dx%d:r=%d[bg];[bg][0:v]overlay=0:%d:shortest=1[p];"
          "[p]ass='%s':fontsdir='%s'[v]" % (W, H, FPS, PIC_Y0, ass_arg, fdir))
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', pic, '-i', voice,
         '-filter_complex', fc, '-map', '[v]', '-map', '1:a', '-t', '%.3f' % total,
         '-r', FPS, *FINAL, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out])

    # 5) 소리 크기를 편마다 같게 — 2패스(film_editor.py 1815~1820, 명화관 명세 10장 2항).
    #   1패스는 목표에서 0.3 LU 비켜 났다. 재고 나서 linear=true 로 한 번에 맞춘다. 무음이면 측정을 지어내지 않는다.
    norm = 'loudnorm=I=-14:LRA=11:TP=-1.5'   # 카이안 K12 -14 LUFS (10-19)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(out), '-af', norm + ':print_format=json', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    m = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])
    if all(math.isfinite(float(m[k])) for k in ('input_i', 'input_tp', 'input_lra', 'input_thresh')):
        norm += (':linear=true:measured_I=%s:measured_TP=%s:measured_LRA=%s:measured_thresh=%s:offset=%s'
                 % (m['input_i'], m['input_tp'], m['input_lra'], m['input_thresh'], m['target_offset']))
    # 웃음·고함이 AAC 에서 0 dBFS 를 넘는다(90ko +0.6) — loudnorm linear 는 피크를 못 누른다. ff_render.py 와 같은 리미터.
    tmp = out.with_name(out.stem + '_ln.mp4')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out,
         '-af', norm + ',alimiter=limit=0.75:level=false,aresample=48000',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp])
    os.replace(tmp, out)
    gate(out, total)
    # 눈검사용 시트 — 2초마다 한 장. 앞 샷이 오프닝(박힌 제목·좌우반전 글자)이거나 로고가 들어오는 걸
    # 기계가 못 잡으므로 발행 승인 전에 반드시 이걸 본다(2026-10-08 暴れん坊将軍 806초 오프닝 사고).
    sheet = out.with_name(out.stem + '_review.png')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out, '-vf', 'fps=1/2,scale=270:-1,tile=9x3',
         '-frames:v', '1', sheet])
    print('눈검사 시트:', sheet)
    # 화면 검사(rinbox_screen.py, 2026-10-09) — 덧칠 글자(로고·박힌 자막)·깜빡이는 샷 조각을 기계가 먼저 본다.
    # 별도 venv(.venv-vision, RapidOCR)라 하위 프로세스로 부른다. 결과는 screen.txt 로 남기고 승인 단계가 읽는다.
    vpy = MIDFORM / '.venv-vision' / 'Scripts' / 'python.exe'
    if vpy.is_file():
        r = subprocess.run([str(vpy), str(Path(__file__).resolve().parent / 'rinbox_screen.py'), str(work)],
                           capture_output=True, text=True, encoding='utf-8', errors='replace',
                           env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        print(r.stdout.rstrip())
        (work / 'screen.txt').write_text(r.stdout + ('OK\n' if r.returncode == 0 else 'FAIL\n'), encoding='utf-8')
    else:
        print('⚠ 화면 검사 venv 없음 — D:/midform/.venv-vision 에 rapidocr-onnxruntime 설치')
    return out


def gate(out, total):
    r = run(['ffprobe', '-v', 'error', '-count_frames',
             '-show_entries', 'stream=codec_type,width,height,nb_read_frames',
             '-show_entries', 'format=duration', '-of', 'json', out])
    j = json.loads(r.stdout)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    want = frames(total)
    bad = []
    if (v['width'], v['height']) != (W, H):
        bad.append('해상도 %sx%s' % (v['width'], v['height']))
    if abs(int(v['nb_read_frames']) - want) > 2:
        bad.append('프레임 %s ≠ %d' % (v['nb_read_frames'], want))
    if not LEN_MIN <= total <= LEN_MAX:
        bad.append('길이 %.2f초' % total)
    # 소리 관문(2026-10-09) — 음량이 목표에서 벗어났나 · 피크가 깨지나 · 1.5초 넘게 말이 끊기나
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(out), '-af',
                        'ebur128=peak=true,silencedetect=n=-45dB:d=1.5', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    li = re.findall(r'I:\s+(-?[\d.]+) LUFS', r.stderr)
    tp = re.findall(r'Peak:\s+(-?[\d.]+) dBFS', r.stderr)
    gaps = re.findall(r'silence_duration: ([\d.]+)', r.stderr)
    if not li or abs(float(li[-1]) + 16) > 1.0:
        bad.append('음량 %s LUFS' % (li[-1] if li else '?'))
    if tp and float(tp[-1]) > -1.0:
        bad.append('피크 %s dBFS' % tp[-1])
    if gaps:
        bad.append('무음 %s초' % ' · '.join('%.1f' % float(x) for x in gaps))
    print('소리 %s LUFS · 피크 %s dBFS' % (li[-1] if li else '?', tp[-1] if tp else '?'))
    print('완성 %s · %.2f초 · %s프레임' % (out, total, v['nb_read_frames']))
    print('게이트: ' + ('통과' if not bad else '✗ ' + ' / '.join(bad)))


if __name__ == '__main__':
    main()
