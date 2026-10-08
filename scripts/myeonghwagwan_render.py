# -*- coding: utf-8 -*-
# 명화관 자체 렌더러 v0 — 볼케이노 없이 편집표 하나로 완성본을 만든다.
#
#   python scripts/myeonghwagwan_render.py <plan.json> [--out out.mp4]
#
# 왜 (2026-10-08 소유주 결정): 볼케이노 env 관문이 AGY 필수로 바뀌었고 주간 한도가
# 10-15 까지 소진됐다. 그 사이 명화관 생산이 통째로 멈춘다. 린박스가 같은 날
# rinbox_render.py 로 자립했고, 이 파일은 그 뼈대를 명화관 치수로 갈아 끼운 것이다.
#
# 화면 치수는 **엔진 자산과 완성본에서 직접 쟀다**(docs/myeonghwagwan-render-spec.md).
#   그림 창   y 420~1499 · 1080x1080 정사각형  ← chrome.png 의 투명 영역이 정답이다
#   틀        assets/myeonghwagwan_chrome.png  (엔진 원본, ko·ja 동일)
#   글꼴      assets/fonts/  ko body.ttf(카페24 아네모네)·dialogue.ttf(서울한강체 M)
#                            ja body.otf·dialogue.otf(Noto Sans JP)
#   제목 99pt y211/y298 · 자막 82pt y1305 · 크레딧 64pt
#   ★제목 2줄 색만 ASS 와 다르다 — ASS 는 노랑인데 완성본 10편 전부 RGB(240,64,32) 주황빨강.
#
# plan.json — 볼케이노 edit.json 에 source/transcript/cx 만 더한 모양이다
# {
#   "source": "D:/volcano-runs/xx/volcano_src.mp4",
#   "transcript": "D:/volcano-runs/xx/transcript.json",
#   "lang": "ko",
#   "title": ["윗 줄", "아랫 줄"], "credit": "영화 '제목'(연도)",
#   "narration": [{"id": "n0", "text": "...", "cards": ["...", "..."], "source": 3.8}],
#   "sequence": [
#     {"narration": "n0", "cx": 0.5},
#     {"source_in": 5.63, "source_out": 11.39, "captions": ["...", "..."], "cx": 0.5}
#   ]
# }
# 음성은 Typecast with-timestamps — 볼케이노와 같은 목소리·키다.
import argparse, base64, hashlib, json, os, re, subprocess, sys, urllib.request
from pathlib import Path

MIDFORM = Path(__file__).resolve().parents[1]
W, H, FPS = 1080, 1920, 30
PIC_Y0, PIC_Y1 = 420, 1500                       # 그림 창 — chrome.png 투명 영역 실측
PIC_W = PIC_H = PIC_Y1 - PIC_Y0                  # 1080 정사각형
CHROME = MIDFORM / 'assets' / 'myeonghwagwan_chrome.png'
FONTS = MIDFORM / 'assets' / 'fonts'
VOICE = {'voice_id': 'tc_68257f68bc6e3c161ab5078d', 'model': 'ssfm-v30',
         'emotion': 'normal', 'tempo': 1.05, 'seed': 42}
LANG = {'ko': 'kor', 'ja': 'jpn', 'en': 'eng'}
JOIN = {'ko': ' ', 'ja': '', 'en': ' '}          # 자막 칸을 이어 붙일 때
CAP_MAX = {'ko': 16, 'ja': 14, 'en': 28}   # 명화관 완성본 실측 최장 15자(ko)·13자(ja)
TITLE_MAX = {'ko': 14, 'ja': 12, 'en': 26}  # 제목 99pt 로 x 132~950 안에 드는 길이
LOSSLESS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p']
FINAL = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p']


def ensure_assets():
    """틀·글꼴이 없으면 볼케이노 편집 폴더에서 챙겨 온다.

    ★`assets/**` 는 저장소에서 빼는 것이 이 repo 규칙이다(로컬 미디어). 그래서 글꼴 17MB 를
      커밋하지 않는다. 대신 **없으면 스스로 가져온다** — 볼케이노가 회차마다 편집 폴더에
      chrome.png 와 fonts/ 를 같이 떨어뜨려 두기 때문이다(2026-10-09 실측).
      한 번 챙겨 두면 그 뒤로는 볼케이노 없이 돈다.
    """
    import glob, shutil
    need = [CHROME] + [FONTS / n for n in ('body.ttf', 'dialogue.ttf')]
    if all(p.exists() for p in need):
        return
    FONTS.mkdir(parents=True, exist_ok=True)
    pats = sorted(glob.glob('D:/volcano-runs/*/edits/*/chrome.png'), key=os.path.getmtime, reverse=True)
    if not pats:
        sys.exit('틀·글꼴이 없고 볼케이노 편집 폴더도 못 찾았다 — assets/ 를 손으로 채워라')
    for src_chrome in pats:
        d = Path(src_chrome).parent
        if not CHROME.exists():
            shutil.copy2(src_chrome, CHROME)
            print('틀을 챙겼다:', src_chrome)
        for f in (d / 'fonts').glob('*.tt[fc]'):
            if not (FONTS / f.name).exists():
                shutil.copy2(f, FONTS / f.name)
        for f in (d / 'fonts').glob('*.otf'):
            if not (FONTS / f.name).exists():
                shutil.copy2(f, FONTS / f.name)
        if all(p.exists() for p in need):
            break
    missing = [p.name for p in need if not p.exists()]
    if missing:
        sys.exit('아직 모자란다: %s' % ', '.join(missing))


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
    """자막 칸의 (시작, 끝, 보일글)을 돌려준다.

    ★명화관 자막은 **번역문**이다(영어 원음 → 한국어/일본어). 그래서 린박스처럼 글자를
      전사에 맞춰 볼 수 없다. 볼케이노 편집표가 칸마다 `word_ids` 를 달아 두는데,
      그 **개수**가 곧 «이 칸이 전사 낱말 몇 개를 먹는가»다(bind_ko.json 이 같은 것을
      [낱말수, 글] 짝으로 적어 둔다 — 2026-10-09 실측으로 확인).
      그러므로 개수만큼 낱말을 걸어 가며 시각을 잰다.

    칸 모양 둘 다 받는다
      {'word_ids': [...], 'text': '치즈 크러스트 아직 있죠?'}   명화관 편집표 그대로
      '보일 글'                                                 글자가 곧 전사인 경우(원음이 우리말)
    """
    toks = [(s0, e0, x) for s0, e0, x in words if s0 >= t0 - 1e-3 and e0 <= t1 + 1e-3]
    out, i = [], 0
    for c in cards:
        if isinstance(c, dict):
            n = max(1, len(c.get('word_ids') or []))
            show = c.get('text', '')
            if i >= len(toks):
                raise SystemExit('전사 낱말이 모자란다 — 컷 %.2f~%.2f, 칸 %r' % (t0, t1, show))
            a0 = toks[i][0]
            b0 = toks[min(i + n, len(toks)) - 1][1]
            i += n
            out.append((a0, b0, show))
            continue
        # 글자로 맞추는 길(원음이 우리말일 때)
        c, show = (c.split('|', 1) + [None])[:2] if '|' in c else (c, None)
        want = c.replace(' ', '')
        got, a0, b0 = '', None, None
        while i < len(toks) and len(got) < len(want):
            s0, e0, x = toks[i]
            if a0 is None:
                a0 = s0
            got += x
            b0 = e0
            i += 1
        if got != want:
            raise SystemExit('자막이 전사 토큰과 안 맞는다: %r ≠ %r' % (c, got))
        out.append((a0, b0, show or c))
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
# 명화관 모양 — **엔진 자산·완성본에서 직접 쟀다**(docs/myeonghwagwan-render-spec.md 8항).
# (글꼴, 크기, 색 &HAABBGGRR, 굵게, 기울임, 테두리, 세로 가운데)
# ★제목 2줄 색은 ASS(&H001BFFF6 노랑)가 아니라 **완성본 실측 RGB(240,64,32)** 을 쓴다.
#   ASS = &H00 BB GG RR → RGB(240,64,32) 는 &H002040F0.
LOOK = {
    'ko': {'T1': ('카페24 아네모네', 99, '&H00C0C0C0', 0, 0, 4, 211),
           'T2': ('카페24 아네모네', 99, '&H002040F0', 0, 0, 4, 298),
           'CR': ('카페24 아네모네', 64, '&H00999999', 0, 0, 0, 1600),
           'NAR': ('카페24 아네모네', 82, '&H00FCFCFC', 0, 0, 5.5, 1305),
           'CAP': ('서울한강체 M', 82, '&H0019FFF7', 0, 0, 5.5, 1305)},
    'ja': {'T1': ('Noto Sans JP', 99, '&H00C0C0C0', 1, 0, 4, 211),
           'T2': ('Noto Sans JP', 99, '&H002040F0', 1, 0, 4, 298),
           'CR': ('Noto Sans JP', 64, '&H00999999', 1, 0, 0, 1600),
           'NAR': ('Noto Sans JP', 82, '&H00FCFCFC', 0, 0, 5.5, 1305),
           'CAP': ('Noto Sans JP', 82, '&H0019FFF7', 0, 0, 5.5, 1305)},
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
    # ★명화관은 **해설(NAR)과 원음 대사(CAP)를 다른 모양으로 쓴다** — ko 는 글꼴까지 다르다
    #   (해설 카페24 아네모네 흰색 · 원음 서울한강체 노랑). 통일하면 ko 스타일이 사라진다.
    for a, b, text, style in events:
        body.append('Dialogue: 1,%s,%s,%s,,0,0,0,,{\\pos(%d,%d)}%s'
                    % (ass_time(a), ass_time(b), style, W // 2, look[style][6], esc(text)))
    path.write_text('\n'.join(head + body) + '\n', encoding='utf-8')


# ---------------------------------------------------------------- 그림
def pic_clip(src, t0, n_frames, cx, mirror, out, zoom=(1.0, 0.5)):
    """원본 t0 부터 n_frames 만큼을 떼어 1080x1020 그림 창으로 만든다.

    cx 는 «원본 가로»의 어디를 가운데로 둘지(0~1)다 — AGY 없이 내가 프레임을 보고 정한다.
    zoom=(z, cy): 원본 높이의 z 만큼만 창으로 쓰고 세로 가운데를 cy 에 둔다(1.0 이면 높이 전체).
      볼케이노 2026-10-08 판의 «샷별 확대 창»에서 옮겼다. 쓰임: 원본 위쪽에 박힌 방송사 로고 띠를
      잘라 내면서도 화자 쪽으로 cx 를 옮길 수 있게 한다(사마귀 SBS CATCH — 로고 y 0~7.5%).
    """
    z, cy = zoom
    ch = 'ih*%.6f' % z
    cw = 'ih*%.6f' % (z * PIC_W / PIC_H)        # 창 비율(1080:1080 정사각)만큼의 가로
    x = "clip(iw*%.6f-(%s)/2,0,iw-(%s))" % (cx, cw, cw)
    y = "clip(ih*%.6f-(%s)/2,0,ih-(%s))" % (cy, ch, ch)
    vf = ("crop='min(iw,%s)':'%s':'%s':'%s',scale=%d:%d:flags=lanczos,setsar=1,fps=%d"
          % (cw, ch, x, y, PIC_W, PIC_H, FPS))
    if mirror:
        vf += ',hflip'
    run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % t0, '-i', src,
         '-t', '%.3f' % (n_frames / FPS + 0.5), '-vf', vf, '-frames:v', n_frames,
         '-an', *LOSSLESS, out])


SEG_LUFS = -17.0      # 구간 음량 기준 — 최종 loudnorm(-16) 전에 구간끼리 높이를 맞춘다


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


# ---------------------------------------------------------------- 조립
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    ensure_assets()
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

    nar = {n['id']: n for n in plan['narration']}

    # 1) 음성을 먼저 사고 길이를 받는다 — 길이가 정해져야 그림을 몇 프레임 뽑을지 안다
    for n in plan['narration']:
        # ★칸은 «공백»으로 잇는다(언어 무관) — 볼케이노와 같은 글이어야 같은 끊어 읽기가 나온다.
        text = ' '.join(n['cards'])
        n['text'] = text
        n['wav'], n['meta'] = tts(text, lang, cache)
        n['dur'] = n['meta']['duration']

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
                         'cx': s.get('cx', 0.5), 'zoom': s.get('zoom', plan.get('zoom', [1.0, 0.5])), 'wav': n['wav']})
        else:
            dur = s['source_out'] - s['source_in']
            segs.append({'kind': 'cut', 'pic_in': s['source_in'], 'dur': dur,
                         'cx': s.get('cx', 0.5), 'zoom': s.get('zoom', plan.get('zoom', [1.0, 0.5])), 'captions': s.get('captions', []),
                         't0': s['source_in'], 't1': s['source_out']})
            prev_end = s['source_out']

    total = sum(g['dur'] for g in segs)
    if not 85 <= total <= 180:
        print('⚠ 길이 %.2f초 — 85~180초 밖이다(엔진 하한 85초·숏츠 상한 180초)' % total)

    # 3) 그림·소리 조각을 만든다
    parts_v, parts_a, events, t = [], [], [], 0.0
    for k, g in enumerate(segs):
        nf = frames(g['dur'])
        # cx 는 숫자 하나거나 [[원본시각, cx], ...] — 한 컷 안에서 샷이 바뀌어 화자가 달라지면 샷마다 준다
        marks = g['cx'] if isinstance(g['cx'], list) else [[g['pic_in'], g['cx']]]
        marks = sorted(marks)
        edges = [0] + [min(nf, max(0, frames(tm - g['pic_in']))) for tm, _ in marks[1:]] + [nf]
        # ★3프레임 미만 조각은 앞 조각에 붙인다 — 볼케이노 2026-10-08 수정(joined_pieces)에서 옮김:
        #   1프레임 조각은 concat 이 길이를 0 으로 쳐 다음 프레임과 겹치고 인코더가 한 장을 버린다.
        k2 = 1
        while k2 < len(edges) - 1:
            if edges[k2] - edges[k2 - 1] < 3 or edges[k2 + 1] - edges[k2] < 3:
                del edges[k2]; del marks[k2]
            else:
                k2 += 1
        for j, (_, c) in enumerate(marks):
            n = edges[j + 1] - edges[j]
            if n <= 0:
                continue
            v = work / ('v%02d_%d.mp4' % (k, j))
            pic_clip(src, g['pic_in'] + edges[j] / FPS, n, c, plan.get('mirror', True), v, tuple(g['zoom']))
            parts_v.append(v)
        if g['kind'] == 'nar':
            parts_a.append(Path(g['wav']))
            # ★해설에도 자막이 깔린다(NAR 모양). 볼케이노 완성본 실측: 해설 큐 10~14개.
            #   칸 시각은 Typecast 가 돌려준 낱말 시각에서 잰다 — 전사 토큰이 아니다(원음이 아니니까).
            n = nar[g['id']]
            ws = n['meta'].get('words') or []
            cards = n['cards']
            if ws and cards:
                want = [c.replace(' ', '') for c in cards]
                i2, got, acc = 0, '', []
                for w in ws:
                    s0, e0, x = (w['start'], w['end'], w['text']) if isinstance(w, dict) else w
                    if i2 >= len(want):
                        break
                    if not acc or acc[-1][2] != i2:
                        acc.append([s0, e0, i2])
                    acc[-1][1] = e0
                    got += str(x).replace(' ', '')
                    if len(got) >= len(want[i2]):
                        got = ''
                        i2 += 1
                for a0, b0, idx in acc:
                    if idx < len(cards):
                        events.append((t + a0, t + b0, cards[idx], 'NAR'))
            elif cards:
                # 낱말 시각이 없으면 칸 수로 고르게 나눈다 — 정확하진 않지만 비는 것보다 낫다
                step = g['dur'] / len(cards)
                for j2, c in enumerate(cards):
                    events.append((t + j2 * step, t + (j2 + 1) * step, c, 'NAR'))
        else:
            au = work / ('a%02d.wav' % k)
            clip_audio(src, g['t0'], g['dur'], au)
            parts_a.append(au)
            for ca, cb, text in card_times(words, g['t0'], g['t1'], g['captions'], JOIN[lang]):
                if len(str(text)) > CAP_MAX[lang]:
                    sys.exit('자막 칸이 %d자를 넘는다: %r' % (CAP_MAX[lang], text))
                events.append((t + ca - g['t0'], t + cb - g['t0'], text, 'CAP'))
        t += nf / FPS

    total = t
    # 4) 이어 붙이고 검정 캔버스에 얹는다
    lst = work / 'v.txt'
    lst.write_text(''.join("file '%s'\n" % p.as_posix() for p in parts_v), encoding='utf-8')
    pic = work / 'pic.mp4'
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
    fdir = str(FONTS).replace('\\', '/').replace(':', '\\:')
    # ★극장 틀을 그림 **위에** 얹는다 — 엔진이 쓰는 원본 그대로(ko·ja 동일).
    #   틀이 먼저고 자막이 그 위다: 자막은 그림 창 안쪽에 떠야 하고 틀에 가리면 안 된다.
    fc = ("color=c=black:s=%dx%d:r=%d[bg];[bg][0:v]overlay=0:%d:shortest=1[p];"
          "[p][2:v]overlay=0:0[c];[c]ass='%s':fontsdir='%s'[v]"
          % (W, H, FPS, PIC_Y0, ass_arg, fdir))
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', pic, '-i', voice, '-i', CHROME,
         '-filter_complex', fc, '-map', '[v]', '-map', '1:a', '-t', '%.3f' % total,
         '-r', FPS, *FINAL, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out])

    # 5) 소리 크기를 편마다 같게
    # ★명화관 목표는 **-13.5 LUFS · LRA 5**다(린박스는 -16/11 — 베껴 오면 2.4dB 작게 나온다).
    #   볼케이노 완성본 실측: lsr01 -13.6 LUFS/LRA 4.8 · lsr02-ja -13.5/5.6 (2026-10-09 재확인).
    tmp = out.with_name(out.stem + '_ln.mp4')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out,
         '-af', 'loudnorm=I=-13.5:LRA=5:TP=-1.3,aresample=48000',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp])
    os.replace(tmp, out)
    gate(out, total)
    # 눈검사용 시트 — 2초마다 한 장. 앞 샷이 오프닝(박힌 제목·좌우반전 글자)이거나 로고가 들어오는 걸
    # 기계가 못 잡으므로 발행 승인 전에 반드시 이걸 본다(2026-10-08 暴れん坊将軍 806초 오프닝 사고).
    sheet = out.with_name(out.stem + '_review.png')
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out, '-vf', 'fps=1/2,scale=270:-1,tile=9x3',
         '-frames:v', '1', sheet])
    print('눈검사 시트:', sheet)
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
    if not 85 <= total <= 180:
        bad.append('길이 %.2f초' % total)
    print('완성 %s · %.2f초 · %s프레임' % (out, total, v['nb_read_frames']))
    print('게이트: ' + ('통과' if not bad else '✗ ' + ' / '.join(bad)))


if __name__ == '__main__':
    main()
