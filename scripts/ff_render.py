# 쇼핑쇼츠 자체 렌더러 v0 — 화면 전체(1080x1920) · 단어 시각 자막 · 핵심어 강조 · 증거 이미지 · 화살표 · BGM.
#
#   python scripts/ff_render.py <plan.json> [--out out.mp4] [--no-bgm]
#
# 왜 직접 만드나: 어랍숏 엔진은 상단 제목 바 + 가운데 창(1080x1168)이 고정이고 자막 모양을 못 바꾼다.
# 「일본 돈까스 양배추의 비밀」(1,258만회) 같은 포맷 — 화면 가득한 시연·증거 캡처, 노랑 핵심어 자막,
# 빨간 화살표 — 은 그 틀로 70% 밖에 안 나온다(소유주 결정 2026-10-01: 자체 렌더러로).
#
# plan.json
# {
#   "voice": {"voice_id": "tc_...", "tempo": 1.1},                    생략하면 기본 목소리
#   "segments": [
#     {"text": "일본 돈까스 양배추 왜 이렇게 부드럽나 했더니",          한 문장 = 한 음성 = 한 구간
#      "emph": ["돈까스", "부드럽나"],                                  노랑 강조할 낱말(부분 일치)
#      "media": [ {"video": "a.mp4", "t0": 1.0, "t1": 3.2},            구간 길이를 media 수로 나눠 채운다
#                 {"image": "proof.png"} ],                            이미지는 흐린 배경 위 가운데
#      "arrow": true},                                                 빨간 아래 화살표(CTA 용)
#     ...
#   ],
#   "bgm": "D:/midform/assets/bgm/shopping/Komiku_-_12_-_Bicycle.ogg"
# }
# 음성은 Typecast with-timestamps(볼케이노와 같은 API·키). 같은 문장은 tts/ 캐시를 재사용한다.
import argparse, base64, hashlib, json, os, subprocess, sys, urllib.request
from pathlib import Path

MIDFORM = Path(__file__).resolve().parents[1]
FONTDIR = MIDFORM / 'assets' / 'fonts' / 'shopping'
FONT = 'BM DoHyeon'
W, H, FPS = 1080, 1920, 30
VOICE = {'voice_id': 'tc_68257f68bc6e3c161ab5078d', 'model': 'ssfm-v30', 'language': 'kor',
         'emotion': 'normal', 'tempo': 1.1, 'seed': 42}
CARD_MAX = 11            # 자막 한 장 글자 수(공백 제외)
CAP_Y = 1330             # 자막 세로 위치(화면 아래 1/3 — 레퍼런스 실측)
TAIL = 0.10              # 마지막 낱말 뒤 여유(초) — 구간 사이 무음을 없앤다
HEAD = 0.04              # 첫 낱말 앞 여유
# 표기 방식 스위치(2026-10-06 소유주: 파트너스 승인 뒤 제목 표기를 빼고 첫 3초 또렷하게) — yt-upload.js 도 같은 파일을 본다
try:
    DISC_CFG = json.loads(Path('D:/volcano-runs/_upload/disclosure.json').read_text(encoding='utf-8'))
except Exception:
    DISC_CFG = {}
DISCLOSURE = '이 영상은 쿠팡 파트너스 활동으로 수수료를 제공받습니다'   # 글씨만 반투명으로(소유주: 검은 배경 강조 불필요, 2026-10-02) · plan 'disclosure': '' 로 끈다


def run(cmd, **kw):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding='utf-8', errors='replace', **kw)
    if r.returncode:
        sys.exit(f'명령 실패: {" ".join(str(c) for c in cmd)[:300]}\n{r.stderr[-1500:]}')
    return r


# ---------------------------------------------------------------- 음성
def tts(text, voice, cache):
    body = {'text': text, 'voice_id': voice['voice_id'], 'model': voice['model'], 'language': voice['language'],
            'seed': voice.get('seed', 42),
            'prompt': {'emotion_type': 'preset', 'emotion_preset': voice['emotion'], 'emotion_intensity': 1},
            'output': {'volume': 100, 'audio_pitch': 0, 'audio_tempo': voice['tempo'], 'audio_format': 'wav'}}
    h = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
    wav, meta = cache / f'{h}.wav', cache / f'{h}.json'
    if not (wav.exists() and meta.exists()):
        key = (Path.home() / '.volcano' / 'keys' / 'typecast').read_bytes().decode('utf-8-sig').strip()
        req = urllib.request.Request('https://api.typecast.ai/v1/text-to-speech/with-timestamps',
                                     data=json.dumps(body).encode(), headers={'X-API-KEY': key, 'Content-Type': 'application/json'})
        r = json.loads(urllib.request.urlopen(req, timeout=120).read())
        wav.write_bytes(base64.b64decode(r['audio']))
        meta.write_text(json.dumps({'text': text, 'words': r['words'], 'duration': r.get('audio_duration')}, ensure_ascii=False), encoding='utf-8')
        print(f'  음성 구매 {len(text)}자: {text[:30]}')
    return wav, json.loads(meta.read_text(encoding='utf-8'))


MAX_GAP = 0.14   # 문장 안 낱말 사이 무음 상한(초) — Typecast 는 쉼표·연결어미마다 0.3~0.6초 쉬어 루즈하다(ffshop02 소유주 지적)


def squeeze_gaps(wav, words, cache, max_gap):
    """낱말 사이 긴 무음을 max_gap 으로 줄인 음성과 옮긴 낱말 시각을 돌려준다(캐시)."""
    cuts = []                                   # 잘라 낼 원본 구간(시작, 끝)
    for a, b in zip(words, words[1:]):
        gap = b['start'] - a['end']
        if gap > max_gap:
            cuts.append((a['end'] + max_gap / 2, b['start'] - max_gap / 2))
    if not cuts:
        return wav, words
    out = cache / f'{Path(wav).stem}_g{int(max_gap * 1000)}.wav'
    keep, t = [], 0.0
    for c0, c1 in cuts:
        keep.append((t, c0))
        t = c1
    if not out.exists():
        fc = ''.join(f'[0:a]atrim=start={a:.4f}' + (f':end={b:.4f}' if b else '') + f',asetpts=PTS-STARTPTS[k{i}];'
                     for i, (a, b) in enumerate(keep + [(t, None)]))
        fc += ''.join(f'[k{i}]' for i in range(len(keep) + 1)) + f'concat=n={len(keep) + 1}:v=0:a=1[a]'
        run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-filter_complex', fc, '-map', '[a]', out])

    def shift(x):
        return x - sum(c1 - c0 for c0, c1 in cuts if c1 <= x + 1e-6)
    return out, [dict(w, start=shift(w['start']), end=shift(w['end'])) for w in words]


# ---------------------------------------------------------------- 자막
COLORS = {'y': '&H00E5FF&', 'r': '&H3C5AFF&', 'c': '&HFFD84F&'}   # 노랑 핵심어 · 주황빨강 숫자/가격 · 하늘 상품명


def split_marks(text):
    """원고의 '/' 를 자막 카드 끊는 자리로 읽는다. '{보이는 글|읽는 글}' 은 TTS 엔 뒤쪽을 읽히고 자막엔 앞쪽을 보인다
    (예: '{13,430원|만 삼천사백삼십 원}' — 가격·숫자는 자막에 숫자로, 2026-10-03 소유주).
    → (읽을 낱말들, 끊는 낱말 위치 집합, {낱말 위치: 보일 글('' 이면 숨김)})"""
    import re
    tokens, breaks, disp = [], set(), {}
    for piece in text.split('/'):
        start = len(tokens)
        for m in re.finditer(r'\{([^|{}]*)\|([^{}]*)\}|(\S+)', piece):
            if m.group(3):
                tokens.append(m.group(3))
                continue
            ws = m.group(2).split()
            for j, w in enumerate(ws):
                disp[len(tokens)] = m.group(1) if j == 0 else ''
                tokens.append(w)
        if start and len(tokens) > start:
            breaks.add(start)
    return tokens, breaks, disp


def emph_color(word, emph):
    """emph 항목: '낱말'(노랑) 또는 '낱말|r'(숫자·가격) / '낱말|c'(상품명)."""
    for e in emph:
        t, _, c = e.partition('|')
        if t and (t in word or word.rstrip(',.!?') in t.split()):
            return COLORS.get(c or 'y')
    return None


def cards_for(words, emph, breaks=()):
    if breaks:
        cuts = [0] + sorted(breaks) + [len(words)]
        out = []
        for a, b in zip(cuts, cuts[1:]):
            c = words[a:b]
            if c:
                toks = [(w.get('disp', w['text'].strip().rstrip(',.!?')), emph_color(w.get('disp') or w['text'], emph)) for w in c]
                out.append((c[0]['start'], c[-1]['end'], [t for t in toks if t[0]]))
        return out
    return _auto_cards(words, emph)


def _auto_cards(words, emph):
    """낱말들을 CARD_MAX 이하 카드로 묶는다. 각 카드 = (시작, 끝, [(낱말, 강조?)])."""
    ws = [w for w in words if w['text'].strip()]
    ln = [len(w['text'].strip()) for w in ws]
    n = len(ws)
    # 모든 끊는 자리를 따져 본다: 카드당 CARD_MAX 이하, 장 수 최소, 그다음 길이 고르게,
    # 한 글자 낱말("한", "몇", "이")은 뒤 낱말과 떼지 않는다("한 / 번에도" — ffshop02)
    from functools import lru_cache

    @lru_cache(None)
    def best(i):
        if i == n:
            return (0, 0, 0), ()
        res = None
        for j in range(i + 1, n + 1):
            size = sum(ln[i:j])
            if size > CARD_MAX and j > i + 1:
                break
            orphan = 1 if j < n and ln[j - 1] == 1 else 0
            (orph, cnt, sq), rest = best(j)
            cand = ((orph + orphan, cnt + 1, sq + size * size), ((i, j),) + rest)
            if res is None or cand[0] < res[0]:
                res = cand
        return res
    cards = [ws[a:b] for a, b in best(0)[1]] if n else []
    out = []
    for c in cards:
        toks = [(w['text'].strip().rstrip(',.!?'), emph_color(w['text'], emph)) for w in c]   # 자막엔 문장부호를 안 쓴다
        out.append((c[0]['start'], c[-1]['end'], toks))
    return out


def ass_time(t):
    t = max(0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


def write_ass(path, events, total=0.0, disclosure='', tags=()):
    head = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n'
            '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, '
            'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            f'Style: Cap,{FONT},96,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,2,5,40,40,0,1\n'
            f'Style: Disc,{FONT},34,&H70FFFFFF,&H000000FF,&HA0000000,&HFF000000,0,0,0,0,100,100,0,0,1,1.2,0,8,40,40,60,1\n'
            # 우상단 «광고»(disclosure.json corner) — 흰 글씨·얇은 반투명 상자
            f'Style: DiscC,{FONT},40,&H10FFFFFF,&H000000FF,&H60000000,&H60000000,0,0,0,0,100,100,0,0,3,6,0,9,40,44,60,1\n'
            # 표기 축소(disclosure.json minimal) — 상자 없는 작은 흰 글씨, 처음·끝에만
            f'Style: DiscM,{FONT},38,&H20FFFFFF,&H000000FF,&H80000000,&HFF000000,0,0,0,0,100,100,0,0,1,2,0,8,40,40,60,1\n'
            # 제목 표기를 뺀 뒤 첫 몇 초용 — 또렷한 흰 글씨 + 반투명 검은 상자
            f'Style: DiscS,{FONT},46,&H00FFFFFF,&H000000FF,&H50000000,&H50000000,0,0,0,0,100,100,0,0,3,8,0,8,40,40,60,1\n'
            # 말 안 하는 화면 글씨(어랍숏식): 괄호 효과어 '(몽글몽글)' 는 작은 보라, 장면 한마디 '이게 다 거품' 은 초록
            f'Style: Sfx,{FONT},74,&H00E0389A,&H000000FF,&H00FFFFFF,&H64000000,0,0,0,0,100,100,0,0,1,6,0,5,40,40,0,1\n'
            f'Style: Note,{FONT},84,&H0060F070,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,2,5,40,40,0,1\n'
            # 시리즈 배지(첫 화면 '일본 1위' 등): 노랑 상자에 검은 글씨 — 섬네일 첫 프레임이 된다
            f'Style: Badge,{FONT},92,&H00111111,&H000000FF,&H0000E5FF,&H0000E5FF,0,0,0,0,100,100,0,0,3,18,0,8,40,40,170,1\n\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    lines = []
    if disclosure:   # 쿠팡파트너스: 설명·댓글만으론 반려 — 제목 또는 영상 안에 대가성 문구 필수(2026-10-02 반려)
        # 제목 표기를 뺀 뒤(_upload/disclosure.json strong_sec>0)엔 첫 몇 초를 또렷한 상자로 — 이후는 반투명 그대로
        strong = float(DISC_CFG.get('strong_sec', 0) or 0)
        if DISC_CFG.get('corner'):   # 2026-10-12 소유주: 우상단 «광고» 표시만, 영상 내내
            lines.append(f'Dialogue: 2,{ass_time(0)},{ass_time(total)},DiscC,,0,0,0,,{DISC_CFG.get("corner_text") or "광고"}')
        elif DISC_CFG.get('minimal'):   # 2026-10-12 소유주 "표기 축소": 상자 없이 작은 글씨로 처음·끝에만(공정위 지침의 시작·끝 표시)
            end = float(DISC_CFG.get('end_sec', 2) or 0)
            short = DISC_CFG.get('short_text') or '광고 · 쿠팡 파트너스 수수료를 받습니다'
            lines.append(f'Dialogue: 2,{ass_time(0)},{ass_time(min(strong or 3, total))},DiscM,,0,0,0,,{short}')
            if end > 0 and total > (strong or 3) + end:
                lines.append(f'Dialogue: 2,{ass_time(total - end)},{ass_time(total)},DiscM,,0,0,0,,{short}')
        else:
            if strong > 0:
                lines.append(f'Dialogue: 2,{ass_time(0)},{ass_time(min(strong, total))},DiscS,,0,0,0,,쿠팡 파트너스 광고 · 수수료를 제공받습니다')
            lines.append(f'Dialogue: 1,{ass_time(strong if strong > 0 else 0)},{ass_time(total)},Disc,,0,0,0,,{disclosure}')
    for a, b, text, style, y in tags:   # 툭 튀어나오는 팝
        if style == 'Badge':
            bsx = min(100, int(940 * 100 / max(1, sum(30 if ch == ' ' else 90 for ch in text))))   # 길면 가로로 줄인다(ffstory02 넘침)
            lines.append(f'Dialogue: 3,{ass_time(a)},{ass_time(b)},Badge,,0,0,0,,{{\\fscx{bsx}}}{text}')
            continue
        lines.append(f'Dialogue: 2,{ass_time(a)},{ass_time(b)},{style},,0,0,0,,'
                     f'{{\\pos(540,{y})\\fscx60\\fscy60\\t(0,120,\\fscx110\\fscy110)\\t(120,200,\\fscx100\\fscy100)}}{text}')
    for a, b, toks in events:
        txt = ' '.join(('{\\c' + e + '}' + t + '{\\c&HFFFFFF&}') if e else t for t, e in toks)
        # 등장 순간 살짝 커졌다 줄어드는 팝(레퍼런스의 자막 리듬)
        # 화면 폭(여백 빼고 1000px)을 넘으면 가로로 줄인다 — 글자 92px·띄어쓰기 32px 어림(ffshop04 넘침)
        est = sum(32 if ch == ' ' else 92 for ch in ' '.join(t for t, _ in toks))
        sx = min(100, int(1000 * 100 / max(est, 1)))
        lines.append(f'Dialogue: 0,{ass_time(a)},{ass_time(b)},Cap,,0,0,0,,{{\\pos(540,{CAP_Y})\\fscx{int(sx * 1.12)}\\fscy112\\t(0,90,\\fscx{sx}\\fscy100)}}{txt}')
    path.write_text(head + '\n'.join(lines) + '\n', encoding='utf-8')


# ---------------------------------------------------------------- 화면
# 화질: 중간 단계는 무손실, 최종 한 번만 압축(2026-10-03 소유주 '전반적으로 화질 아쉽다' — 3번 재압축이 원인 중 하나)
LOSSLESS = ['-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
FINAL = ['-c:v', 'libx264', '-crf', '15', '-preset', 'slow', '-tune', 'film', '-pix_fmt', 'yuv420p', '-maxrate', '24M', '-bufsize', '48M']
MIN_BAND = 1040          # 글자를 피해 남길 띠의 최소 높이(px) — 1.78배 확대까지. 일본 틱톡은 가운데 자막이 많아 1.6~1.75배가 흔하다(ffshop02)
BOX_MARGIN = 28


def clean_band(boxes):
    """글자 상자(y0,y1)들을 피한 가장 큰 세로 띠. 없으면 화면 전체."""
    cuts = sorted([max(0, a - BOX_MARGIN), min(H, b + BOX_MARGIN)] for a, b in boxes)
    free, y = [], 0
    for a, b in cuts:
        if a > y:
            free.append((y, a))
        y = max(y, b)
    if y < H:
        free.append((y, H))
    return max(free, key=lambda r: r[1] - r[0]) if free else (0, 0)


VSR = Path('D:/tools/vsr')   # video-subtitle-remover(Apache-2.0) — LaMa 로 박힌 글자를 주변 화면으로 채운다
ERASED = Path('D:/volcano-runs/_erased')   # 지운 클립 공용 저장소 — 원본·구간이 같으면 어느 편에서든 재사용(묶음편)


def erase_text(src, t0, t1, cache, area=None, fit=False, fx=0.5):
    """샷 구간만 떼어 박힌 글자를 지운 클립을 돌려준다(캐시). 자르기·흐림 대신 원본 구도를 그대로 쓰려고(ffshop02:
    잘라 키우면 화면이 위로 쏠리고 화질이 무른다 — 소유주 지적).
    area='auto': 글자 인식(ocr_area.py)으로 글자 자리만 찾아 그 칸만 지운다 — 화면 전체를 맡기면 브러시 결까지 뭉갠다(ffshop07).
    fit='square'(또는 True): 가로 영상을 원본 높이 정사각형으로 잘라(축소 없이) 지운다. fit='wide': 폭 1080 으로 줄여 지운다."""
    key = hashlib.sha256(f'{Path(src).resolve()}|{t0:.3f}|{t1:.3f}|lama-v7|{fit}|{fx}|{area}'.encode()).hexdigest()[:16]
    out = cache / f'{key}.mp4'
    if out.exists():
        return out
    raw = cache / f'{key}_raw.mp4'
    wh = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]).stdout.strip().split(',')
    landscape = int(wh[0]) * 16 > int(wh[1]) * 9 + 16
    if fit == 'wide':
        vf = ['-vf', f'scale={W}:-2']
    elif fit:
        vf = ['-vf', f"crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))*{fx}':0"]
    elif landscape:                       # 가로 영상은 어차피 가운데 9:16 만 쓴다(1080p 가로 전체는 GPU 6GB 초과 — ffshop03)
        vf = ['-vf', 'crop=trunc(ih*9/16/2)*2:ih']
    else:
        vf = []
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{t0:.3f}', '-i', src, '-t', f'{t1 - t0:.3f}', '-an', *vf,
         '-c:v', 'libx264', '-crf', 8, '-preset', 'fast', '-pix_fmt', 'yuv420p', raw])
    if area == 'auto':
        # 라벨·자막 상자가 언제·어디 나오는지 직접 잡아(PP-OCRv5 감지) 그 상자를 주변 화면으로 메운다(delogo).
        # 지우기 도구(LaMa)는 쓰지 않는다 — 브러시 결을 뭉개고, 영역을 줘도 라벨을 놓쳤다(ffshop07)
        r = subprocess.run([str(VSR / '.venv' / 'Scripts' / 'python.exe'), str(Path(__file__).with_name('ocr_area.py')), str(raw)],
                           capture_output=True, text=True, encoding='utf-8', errors='replace',
                           env=dict(os.environ, PYTHONIOENCODING='utf-8', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK='True'))
        try:
            spans = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:
            sys.exit(f'글자 자리 찾기 실패: {src}\n{r.stderr[-600:]}')
        if not spans:
            os.replace(raw, out)
            print(f'  글자 없음 {Path(src).name} {t0:.2f}-{t1:.2f}')
            return out
        vf = ','.join(f"delogo=x={x}:y={y}:w={w}:h={h}:enable='between(t,{s0},{s1})'" for s0, s1, (x, y, w, h)
                      in ((sp['t0'], sp['t1'], sp['box']) for sp in spans))
        run(['ffmpeg', '-loglevel', 'error', '-y', '-i', raw, '-vf', vf, '-c:v', 'libx264', '-crf', 8, '-preset', 'fast', '-pix_fmt', 'yuv420p', out])
        print(f'  라벨 메움 {Path(src).name} {t0:.2f}-{t1:.2f} ({len(spans)}곳)')
        return out
    if (landscape and not fit) or fit == 'wide':
        area = None
    r = subprocess.run([str(VSR / '.venv' / 'Scripts' / 'python.exe'), 'backend/main.py', '-i', str(raw), '-o', str(out),
                        '--inpaint-mode', 'lama'] + (['-c', *map(str, area)] if area else []),   # area: [ymin, ymax, xmin, xmax] (잘라 낸 클립 좌표)
                       cwd=VSR, capture_output=True, text=True, encoding='utf-8', errors='replace',
                       env=dict(os.environ, PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK='True'))
    if not out.exists():
        sys.exit(f'글자 지우기 실패: {src} {t0}-{t1}\n{r.stderr[-800:]}')
    print(f'  글자 지움 {Path(src).name} {t0:.2f}-{t1:.2f}' + (f' 영역 {area}' if area else ''))
    return out


def clip_video(src, t0, t1, frames, out, band=(0, H), blur=()):
    have = max(0.05, t1 - t0)
    need = frames / FPS
    y0, y1 = band[:2]
    xo = band[2] if len(band) > 2 else None   # 세 번째 값: 가로 시작점(구석 글자를 화면 밖으로 밀어낼 때)
    bh = y1 - y0
    bw = int(round(bh * W / H / 2)) * 2
    # 먼저 1080x1920 캔버스로 맞춘 뒤(선별기와 같은 좌표계) 글자 없는 띠만 잘라 9:16 으로 다시 키운다
    vf = (f'scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H},'
          + (f'crop={bw}:{bh}:{(W - bw) // 2 if xo is None else xo}:{y0},scale={W}:{H}:flags=lanczos,unsharp=5:5:0.6:3:3:0,' if bh < H else '')   # 확대한 장면만 약하게 선명화
          + f'fps={FPS},setsar=1')
    if have < need - 1e-3:               # 소스가 짧으면 마지막 프레임을 늘리지 않고 살짝 느리게 튼다
        vf = f'setpts={need / have:.4f}*PTS,' + vf
    for k, (x0, y0, x1, y1) in enumerate(blur):   # 박힌 글자를 흐리게(자르기 대신 — 불편 장면처럼 화면 전체가 필요할 때). 좌표는 1080x1920 출력 기준
        vf += (f'[b{k}];[b{k}]split[m{k}][c{k}];[c{k}]crop={x1 - x0}:{y1 - y0}:{x0}:{y0},boxblur=28:4[z{k}];'
               f'[m{k}][z{k}]overlay={x0}:{y0}')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{t0:.3f}', '-i', src, '-t', f'{max(have, need) + 0.5:.3f}',
         '-vf', vf, '-frames:v', frames, '-an', *LOSSLESS, out])


def clip_fit(src, t0, t1, frames, out, mode=True, fx=0.5, fz=1.0, fy=0.0):
    """가로 영상 배치. mode='wide': 화면 폭에 맞춘 얇은 띠(1080x608). 기본(True/'square'): 원본 높이만큼 정사각형으로
    잘라(1920x1080 → 1080x1080, 확대 없음) 가운데 크게 둔다 — 띠는 작고 답답했다(2026-10-03 소유주 화질 지적).
    fx: 정사각형을 자를 가로 위치(0=왼쪽 끝, 0.5=가운데, 1=오른쪽 끝). 위아래 빈 곳은 같은 영상을 흐리게 깐다."""
    have = max(0.05, t1 - t0)
    need = frames / FPS
    pre = f'setpts={need / have:.4f}*PTS,' if have < need - 1e-3 else ''
    if mode == 'wide':
        fg = f'[b]scale={W}:-2:flags=lanczos[fg]'
    else:
        # fz<1: 정사각형 한 변을 줄여(=확대) 위·아래 문구를 화면 밖으로 — fy=1 이면 아래쪽(ffshop05 산코 위쪽 큰 문구)
        fg = (f"[b]crop='min(iw,ih)*{fz}':'min(iw,ih)*{fz}':'(iw-min(iw,ih)*{fz})*{fx}':'(ih-min(iw,ih)*{fz})*{fy}',"
              f"scale={W}:{W}:flags=lanczos[fg]")
    fc = (f'[0:v]{pre}fps={FPS},split[a][b];'
          f'[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:3,eq=brightness=-0.22[bg];'
          f'{fg};[bg][fg]overlay=0:(H-h)/2-120,setsar=1')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{t0:.3f}', '-i', src, '-t', f'{max(have, need) + 0.5:.3f}',
         '-filter_complex', fc, '-frames:v', frames, '-an', *LOSSLESS, out])


def mark_image(src, marks, out):
    """증거 캡처에 빨간 동그라미(marks: 원본 픽셀 [x0,y0,x1,y1] 목록). 보이는 숫자만 짚는다."""
    from PIL import Image, ImageDraw
    im = Image.open(src).convert('RGB')
    d = ImageDraw.Draw(im)
    w = max(6, im.width // 120)
    for x0, y0, x1, y1 in marks:
        px, py = (x1 - x0) * 0.08 + 8, (y1 - y0) * 0.25 + 8
        d.ellipse([x0 - px, y0 - py, x1 + px, y1 + py], outline=(235, 28, 36), width=w)
    im.save(out)
    return out


def clip_image(src, frames, out, full=False):
    """full: 1080x1920 글자 카드 — 흐린 배경 없이 화면 전체(스토리형 연도·숫자 카드)."""
    d = frames / FPS
    if full:
        fc = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
              f"zoompan=z='1+0.03*on/{max(frames, 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS},setsar=1")
        run(['ffmpeg', '-loglevel', 'error', '-y', '-loop', 1, '-t', f'{d + 0.2:.3f}', '-i', src, '-filter_complex', fc,
             '-frames:v', frames, *LOSSLESS, out])
        return
    fc = (f'[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:3,eq=brightness=-0.18[bg];'
          f'[0:v]scale=w=1000:h=1150:force_original_aspect_ratio=decrease:flags=lanczos[fg];'   # 자막(1330) 위에서 끝나게
          f'[bg][fg]overlay=(W-w)/2:150+(1150-h)/2,'
          f'zoompan=z=\'1+0.04*on/{max(frames, 1)}\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d={frames}:s={W}x{H}:fps={FPS},setsar=1')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-loop', 1, '-t', f'{d + 0.2:.3f}', '-i', src, '-filter_complex', fc,
         '-frames:v', frames, *LOSSLESS, out])


def arrow_png(path):
    from PIL import Image, ImageDraw
    im = Image.new('RGBA', (220, 260), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    red, edge = (235, 28, 36, 255), (255, 255, 255, 255)
    shaft = [(80, 10), (140, 10), (140, 140), (200, 140), (110, 250), (20, 140), (80, 140)]
    d.polygon(shaft, fill=edge)
    inner = [(90, 20), (130, 20), (130, 150), (178, 150), (110, 234), (42, 150), (90, 150)]
    d.polygon(inner, fill=red)
    im.save(path)


# ---------------------------------------------------------------- 조립
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--out', default=None)
    ap.add_argument('--no-bgm', action='store_true')
    a = ap.parse_args()
    plan_path = Path(a.plan).resolve()
    wd = plan_path.parent
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    voice = dict(VOICE, **plan.get('voice', {}))
    work = wd / '_ff'
    (work / 'tts').mkdir(parents=True, exist_ok=True)
    (work / 'clips').mkdir(parents=True, exist_ok=True)
    (ERASED).mkdir(parents=True, exist_ok=True)
    out = Path(a.out) if a.out else wd / f'{wd.name}_ff.mp4'

    # 1) 음성과 구간 길이(프레임 단위로 맞춘다)
    # 'cont': true 인 구간은 앞 구간과 한 문장 — 음성을 한 번에 만들어 억양이 끊기지 않게 하고(ffshop02 소유주 지적),
    # 낱말 시각으로 구간을 나눈다. 원고의 '/' 는 자막 카드 끊는 자리(음성엔 안 들어간다).
    groups = []
    for i, s_ in enumerate(plan['segments']):
        if s_.get('cont') and groups:
            groups[-1].append(i)
        else:
            groups.append([i])
    segs, t = [], 0.0
    for grp in groups:
        toks = [split_marks(plan['segments'][i]['text']) for i in grp]
        text = ' '.join(' '.join(tk) for tk, *_ in toks)
        wav, meta = tts(text, voice, work / 'tts')
        words = [w for w in meta['words'] if w['text'].strip()]
        counts = [len(tk) for tk, *_ in toks]
        if sum(counts) != len(words):
            sys.exit(f'낱말 수 불일치({sum(counts)} vs {len(words)}): {text}')
        wav, words = squeeze_gaps(wav, words, work / 'tts', plan.get('max_gap', MAX_GAP))
        g0 = max(0.0, words[0]['start'] - HEAD)
        bounds, idx = [g0], 0
        for n in counts[:-1]:
            idx += n
            bounds.append((words[idx - 1]['end'] + words[idx]['start']) / 2)
        bounds.append(words[-1]['end'] + TAIL)
        fb = [int(round((x - g0) * FPS)) for x in bounds]          # 프레임 경계(누적 반올림 — 음성이 끊김 없이 이어진다)
        idx = 0
        for k, i in enumerate(grp):
            frames = fb[k + 1] - fb[k]
            a0 = g0 + fb[k] / FPS
            dur = frames / FPS
            ws = words[idx: idx + counts[k]]
            idx += counts[k]
            segs.append({'i': i, 's': plan['segments'][i], 'wav': wav, 'a0': a0, 'dur': dur, 'frames': frames, 'start': t,
                         'breaks': toks[k][1], 'disp': toks[k][2],
                         'words': [dict(w, start=w['start'] - a0 + t, end=w['end'] - a0 + t) for w in ws]})
            t += dur
    total = t
    print(f'구간 {len(segs)}개 · 총 {total:.2f}초')

    # 2) 화면 조각
    shots, shot_videos = {}, {}
    if plan.get('shots_json'):
        sj = json.loads((wd / plan['shots_json']).read_text(encoding='utf-8'))
        shots = {x['id']: x for x in sj['shots']}
        shot_videos = {Path(v).name: v for v in sj['videos']}
    parts = []
    for g in segs:
        media = g['s']['media']
        weights = [m.get('w', 1.0) for m in media]
        alloc, left = [], g['frames']
        for k, wgt in enumerate(weights):
            f = left if k == len(weights) - 1 else int(round(g['frames'] * wgt / sum(weights)))
            alloc.append(f)
            left -= f
        for k, (m, f) in enumerate(zip(media, alloc)):
            if f <= 0:
                continue
            p = work / 'clips' / f'{g["i"]:02d}_{k}.mp4'
            src = lambda x: str((wd / x).resolve()) if not Path(x).is_absolute() else x   # plan 폴더 기준 상대 경로
            if 'shot' in m:                            # 선별기(--full) 샷 번호 → 영상·시각·글자 자리
                sh = shots[m['shot']]
                band = tuple(m['band']) if m.get('band') else clean_band(sh.get('boxes', []))   # 'band' 로 직접 지정 가능
                if plan.get('erase_text') and m.get('erase', True) and not m.get('band'):
                    # 선별기 OCR 은 샷 가운데 몇 장만 봐서 자막을 놓친다(#197·#225) — 지우기 모드면 샷마다 전부 지운다
                    clean = erase_text(shot_videos[sh['video']], sh['t0'], sh['t1'], ERASED)
                    clip_video(str(clean), 1 / FPS, sh['t1'] - sh['t0'] - 1 / FPS, f, p, (0, H))
                    parts.append(p)
                    continue
                if band[1] - band[0] < MIN_BAND:
                    sys.exit(f'샷 #{m["shot"]} 은 글자를 피하면 {band[1] - band[0]}px 만 남는다(최소 {MIN_BAND}) — 다른 샷을 골라라')
                clip_video(shot_videos[sh['video']], sh['t0'] + 1 / FPS, sh['t1'] - 1 / FPS, f, p, band, blur=m.get('blur', ()))
                if band != (0, H):
                    print(f'  샷 #{m["shot"]} 글자 피해 {band[0]}~{band[1]}px 만 사용(확대 {H / (band[1] - band[0]):.2f}배)')
            elif 'video' in m and plan.get('erase_text') and m.get('erase', True) and not m.get('band'):
                t0 = m.get('t0', 0.0)
                t1 = m.get('t1', t0 + f / FPS)
                clean = erase_text(src(m['video']), t0, t1, ERASED, m.get('erase_area', 'auto' if m.get('fit') and m.get('fit') != 'wide' else None),
                                   fit=m.get('fit', False), fx=m.get('fx', 0.5))
                if m.get('fit'):
                    # 지운 클립은 이미 잘려 있다: wide = 폭 1080 띠, square = 정사각형(가운데 그대로)
                    clip_fit(str(clean), 0.0, t1 - t0, f, p, 'wide' if m.get('fit') == 'wide' else 'square', 0.5)
                else:
                    clip_video(str(clean), 0.0, t1 - t0, f, p)
            elif 'video' in m and m.get('fit'):
                clip_fit(src(m['video']), m.get('t0', 0.0), m.get('t1', m.get('t0', 0.0) + f / FPS), f, p, m['fit'], m.get('fx', 0.5), m.get('fz', 1.0), m.get('fy', 0.0))
            elif 'video' in m:
                clip_video(src(m['video']), m.get('t0', 0.0), m.get('t1', m.get('t0', 0.0) + f / FPS), f, p, tuple(m.get('band', (0, H))), blur=m.get('blur', ()))   # 'band': 지우기 대신 글자 없는 띠만 잘라 쓴다
            else:
                img = src(m['image'])
                if m.get('marks'):
                    img = str(mark_image(img, m['marks'], work / 'clips' / f'{g["i"]:02d}_{k}_marked.png'))
                clip_image(img, f, p, full=m.get('full', False))
            parts.append(p)
    ins, fc = [], ''
    for k, p in enumerate(parts):
        ins += ['-i', p]
        fc += f'[{k}:v:0]'
    fc += f'concat=n={len(parts)}:v=1:a=0[v]'
    video = work / 'video.mp4'
    run(['ffmpeg', '-loglevel', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[v]', '-r', FPS,
         *LOSSLESS, video])

    # 3) 음성 이어 붙이기(구간마다 앞 무음을 잘라 빈틈 없이)
    ins, fc = [], ''
    for k, g in enumerate(segs):
        ins += ['-i', g['wav']]
        fc += f'[{k}:a]atrim=start={g["a0"]:.4f}:duration={g["dur"]:.4f},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=end={g["dur"]:.4f}[a{k}];'
    fc += ''.join(f'[a{k}]' for k in range(len(segs))) + f'concat=n={len(segs)}:v=0:a=1[a]'
    voice_wav = work / 'voice.wav'
    raw = work / 'voice_raw.wav'
    run(['ffmpeg', '-loglevel', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[a]', '-ac', 2, raw])
    # 음성 크기를 맞춘다(Typecast 원음은 -26 LUFS 안팎이라 그대로면 작다 — ffshop01 실측)
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-15:LRA=11:TP=-2,aresample=48000', '-ac', 2, voice_wav])

    # 4) 자막 + 화살표
    events = []
    for g in segs:
        for c in cards_for([dict(w, disp=g['disp'][j]) if j in g['disp'] else w for j, w in enumerate(g['words'])], g['s'].get('emph', []), g['breaks']):
            events.append(c)
    for k in range(len(events) - 1):                 # 카드는 다음 카드 직전까지 유지(깜빡임 없음)
        a0, _, toks = events[k]
        events[k] = (a0, events[k + 1][0], toks)
    if events:
        events[-1] = (events[-1][0], total, events[-1][2])
    ass = work / 'cap.ass'
    tags = []
    for g in segs:   # 구간 시작에서 'at' 초 뒤에 띄워 'dur' 초(기본 1.6초, 구간 끝까지) 유지
        for tg in g['s'].get('tags', []):
            a0 = g['start'] + tg.get('at', 0.15)
            b0 = a0 + tg['dur'] if tg.get('dur') else min(g['start'] + g['dur'], a0 + 1.6)
            style = 'Note' if tg.get('kind') == 'note' else 'Sfx'
            tags.append((a0, b0, tg['text'], style, tg.get('y', 1090 if style == 'Note' else 1220)))
    if plan.get('badge'):   # 시리즈 배지 — 첫 2.6초 화면 위쪽(섬네일·첫 프레임)
        tags.insert(0, (0.0, min(total, plan.get('badge_dur', 2.6)), plan['badge'], 'Badge', None))
    write_ass(ass, events, total, plan.get('disclosure', DISCLOSURE), tags)
    arrow = work / 'arrow.png'
    arrow_png(arrow)
    win = [(g['start'], g['start'] + g['dur']) for g in segs if g['s'].get('arrow')]
    enable = '+'.join(f'between(t,{x:.3f},{y:.3f})' for x, y in win) or '0'
    ass_arg = str(ass).replace('\\', '/').replace(':', '\\:')
    font_arg = str(FONTDIR).replace('\\', '/').replace(':', '\\:')
    vf = (f"[0:v]ass='{ass_arg}':fontsdir='{font_arg}'[c];"
          f"[c][2:v]overlay=x=(W-w)/2:y=1500+18*sin(t*9):enable='{enable}'[v]")
    mixed = out.with_name(out.stem + '_nobgm.mp4')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', video, '-i', voice_wav, '-loop', 1, '-i', arrow,
         '-filter_complex', vf, '-map', '[v]', '-map', '1:a', '-t', f'{total:.3f}', '-r', FPS,
         *FINAL, '-c:a', 'aac', '-b:a', '192k',
         '-movflags', '+faststart', mixed])

    # 5) BGM(어랍숏 쇼핑과 같은 사이드체인 더킹)
    bgm = plan.get('bgm') or str(MIDFORM / 'assets' / 'bgm' / 'shopping' / 'Komiku_-_12_-_Bicycle.ogg')
    if a.no_bgm:
        os.replace(mixed, out)
    else:
        loop = ['-stream_loop', '-1']
        fc = (f'[1:a]aresample=48000,volume=-8dB,afade=t=in:d=0.3,afade=t=out:st={max(0, total - 1.0):.2f}:d=1.0[bgm];'
              '[0:a]asplit=2[v][sc];[bgm][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[duck];'
              '[v][duck]amix=inputs=2:duration=first:normalize=0,volume=-2.5dB,aresample=192000,'
              'alimiter=limit=0.75:level=false,aresample=48000[a]')
        run(['ffmpeg', '-loglevel', 'error', '-y', '-i', mixed, *loop, '-i', bgm, '-filter_complex', fc,
             '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out])
        # 최종 크기 맞춤 — 이미지 구간이 많으면 -20 LUFS 까지 처진다(ffshop03). 편마다 -14 LUFS 로 고정(10/19 전 레인 -14 기준, 도구 측정 ffref15 -16.7·ffref16 -16.3)
        tmp = out.with_name(out.stem + '_ln.mp4')
        run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out, '-af', 'loudnorm=I=-14:LRA=11:TP=-1.5,aresample=48000',
             '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp])
        os.replace(tmp, out)

    # 6) 기계 검사(게이트 v0)
    gate(out, total)


def gate(out, total):
    r = run(['ffprobe', '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames,avg_frame_rate',
             '-show_entries', 'format=duration', '-of', 'json', out])
    j = json.loads(r.stdout)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    want = int(round(total * FPS))
    problems = []
    if (v['width'], v['height']) != (W, H):
        problems.append(f'해상도 {v["width"]}x{v["height"]}')
    if abs(int(v['nb_read_frames']) - want) > 2:
        problems.append(f'프레임 {v["nb_read_frames"]} ≠ {want}')
    sd = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(out), '-af', 'silencedetect=n=-45dB:d=0.4', '-f', 'null', '-'],
                        capture_output=True, text=True, encoding='utf-8', errors='replace').stderr
    sil = sd.count('silence_start')
    if sil:
        problems.append(f'무음 구간 {sil}곳')
    lu = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(out), '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                        capture_output=True, text=True, encoding='utf-8', errors='replace').stderr
    I = [l for l in lu.splitlines() if l.strip().startswith('I:')][-1:]
    P = [l for l in lu.splitlines() if l.strip().startswith('Peak:')][-1:]
    print(f'완성 {out} · {total:.2f}초 · {v["nb_read_frames"]}프레임 · {" ".join(x.strip() for x in I + P)}')
    print('게이트: ' + ('통과' if not problems else '✗ ' + ' / '.join(problems)))


if __name__ == '__main__':
    main()
