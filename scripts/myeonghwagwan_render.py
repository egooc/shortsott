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
import math
from pathlib import Path

MIDFORM = Path(__file__).resolve().parents[1]
W, H, FPS = 1080, 1920, 30
PIC_Y0, PIC_Y1 = 420, 1500                       # 그림 창 — chrome.png 투명 영역 실측
PIC_W = PIC_H = PIC_Y1 - PIC_Y0                  # 1080 정사각형
# 소리 목표 — 볼케이노 완성본 실측(lsr01 -13.6/LRA4.8 · lsr02-ja -13.5/LRA5.6)
LUFS, TRUE_PEAK, LRA = '-13.5', '-1.3', '5'
# 해설 앞뒤 여유 — 볼케이노 film_editor.py 717~718 과 같은 값
NAR_HEAD, NAR_TAIL = 0.065, 0.09
CHROME = MIDFORM / 'assets' / 'myeonghwagwan_chrome.png'
FONTS = MIDFORM / 'assets' / 'fonts'
# 명화관 목소리 — **추측이 아니라 영수증 해시로 확인한 값이다**(2026-10-09).
# 어떻게 알아냈나: 볼케이노는 TTS 요청 본문의 sha256 을 영수증에 남긴다
# (film_editor.py 30~32 digest · 491~495 typecast_body). 본문 모양이 다 드러나 있으므로
# Typecast 목소리 목록 1143개 × 감정 × 속도를 돌려 **해시가 맞는 조합**을 찾았다.
# TTS 를 한 번도 사지 않고 알아냈다. 명화관 회차 9편(lsr01·lsr02-ja·dh01·cg01-ja·cg02·
# wf01·wf01-ja·acct·acct-ja) 전부 같은 값이었다.
#   ★린박스 기본값(tc_68257f68…, normal, 1.05)을 쓰면 6.89자/초로 **느리다.**
#     명화관은 tempo 1.2 · tonedown 이고 9.66자/초다.
VOICE = {'voice_id': 'tc_611c3f692fac944dff493a04',   # SeHee
         'model': 'ssfm-v30', 'emotion': 'tonedown', 'tempo': 1.2, 'seed': 42}
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
def paid_narration(plan, narr):
    """볼케이노가 이미 산 해설 음성이 있으면 **그걸 쓴다.** 돈도 아끼고 소리도 같아진다.

    볼케이노는 해설 전체를 **한 번에** 산다(lsr01: 3개 77자 = 1건 8.375초).
    그 결과가 회차 폴더에 그대로 남는다:
      <wd>/paid/<요청해시>/narration.wav      소리
      <wd>/paid/<요청해시>/response.json      낱말 시각(words)
    소유주 상시 지시: «유료 열쇠는 새로 발급하지 말 것(TTS 재사용이 깨진다)·paid/ 삭제 금지».
    그 폴더가 있는 이유가 바로 이것이다.

    글이 편집표와 **글자 하나까지 같을 때만** 쓴다. 다르면 조용히 엉뚱한 소리가 붙는다.
    돌려주는 것: {해설id: (wav경로, 시작초, 끝초)} — 없으면 빈 사전.
    """
    import glob
    root = Path(plan['transcript']).resolve().parent
    hits = sorted(glob.glob(str(root / 'paid' / '*' / 'response.json')))
    want = [' '.join(n['cards']) for n in narr]
    for rj in hits:
        wav = Path(rj).parent / 'narration.wav'
        if not wav.exists():
            continue
        try:
            doc = json.loads(Path(rj).read_text(encoding='utf-8'))
            words = doc.get('words') or []
            dur_all = float(doc.get('audio_duration') or 0) or None
        except (ValueError, OSError, TypeError):
            continue
        said = ''.join(str(w.get('text', '')) for w in words).replace(' ', '')
        if said != ''.join(want).replace(' ', ''):
            continue
        out, i = {}, 0
        for n, text in zip(narr, want):
            need = text.replace(' ', '')
            got, a, b = '', None, None
            while i < len(words) and len(got) < len(need):
                w = words[i]
                if a is None:
                    a = float(w['start'])
                got += str(w.get('text', '')).replace(' ', '')
                b = float(w['end'])
                i += 1
            if got != need:
                return {}
            out[n['id']] = (wav, a, b, dur_all)
        print('  볼케이노가 산 해설 음성을 그대로 쓴다: %s' % wav.parent.name[:12])
        return out
    return {}


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
def check_transcript(words):
    """전사가 **낱말 단위**인지 본다. 아니면 분명히 실패시킨다.

    ★전사 형식이 두 가지다(2026-10-09 실측).
      낱말 단위   [[0.24, 0.72, "Pizza"], ...]                      ← 우리가 쓸 수 있다
      겹침 토막   [[12.72, 15.51, "That's enough. He's in the ..."],
                  [15.51, 15.52, "house. Get out there and end this. Give"], ...]
                  스트리밍 부분결과라 앞 것이 뒤에 통째로 또 나온다. 시각을 못 잰다.
      겹침 토막을 그냥 받으면 자막이 엉뚱한 데 붙는다. **조용히 틀리느니 서는 게 낫다.**
    """
    if not words:
        sys.exit('전사가 비어 있다')
    long = sum(1 for w in words[:60] if len(str(w[2]).split()) > 3)
    if long > len(words[:60]) * 0.4:
        first = str(words[1][2] if len(words) > 1 else words[0][2])[:90]
        sys.exit('전사가 낱말 단위가 아니다(겹침 토막으로 보인다) — 낱말 단위 전사를 써라. 첫 토막: %r' % first)


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
# ★제목 색은 **볼케이노 완성본**(edits/*/final-*.mp4)에서 쟀다. 제목1 흰색 · 제목2 노랑.
#   2026-10-09 실측: lsr01·lsr02-ja·cg01-ja·cg02·wf01·wf01-ja 전부 (240,240,240)/(240,224,0).
#   ★한때 주황빨강(240,64,32)으로 적었는데 **틀렸다.** 그건 캡컷 출력 폴더의 발행본을 잰 값이고,
#     발행본은 우리 캡컷 파이프라인 산물이지 볼케이노 명화관 완성본이 아니다(같은 편 dh01:
#     볼케이노 159.1초 노랑 vs 발행본 163.4초 주황빨강 — 아예 다른 편집본이다).
#     주황빨강/노랑 조합은 **린박스** 스타일이다(rinbox67~71 실측).
# 명화관 모양 — **볼케이노 완성본과 그 captions.ass 에서 그대로 가져왔다.**
# (글꼴, 크기, 색 &HAABBGGRR, 외곽선, 정렬, y)
# ★정렬이 스타일마다 다르다 — Head·Credit 은 8(위 기준), 나머지는 5(가운데 기준).
#   이걸 5 로 통일하면 **제목이 반 줄만큼 아래로 내려간다**(2026-10-09 실측으로 확인).
# ★제목 색은 제목1 흰색 · 제목2 노랑이다. 주황빨강은 린박스 스타일이지 명화관이 아니다.
# ★여백은 다섯 스타일 모두 L20 R20 V0.
LOOK = {
    'ko': {'T1':  ('카페24 아네모네', 99, '&H00FCFBFC', 4,   8, 211),
           # ★T2 **스타일 색은 T1 과 같다**(볼케이노도 두 줄 다 Head 스타일을 쓴다).
           #   노랑은 인라인 \c 로 준다 — 엔진과 같은 방식이다.
           'T2':  ('카페24 아네모네', 99, '&H00FCFBFC', 4,   8, 298),
           'NAR': ('카페24 아네모네', 82, '&H00FCFCFC', 5.5, 5, 1305),
           'CAP': ('서울한강체 M',    82, '&H0019FFF7', 5.5, 5, 1305),
           'EFF': ('카페24 아네모네', 70, '&H0002FEF6', 4,   5, 1305),
           'CR':  ('카페24 아네모네', 64, '&H00999999', 0,   8, 1600)},
    'ja': {'T1':  ('Noto Sans JP Bold',   99, '&H00FCFBFC', 4,   8, 211),
           'T2':  ('Noto Sans JP Bold',   99, '&H00FCFBFC', 4,   8, 298),
           'NAR': ('Noto Sans JP Medium', 82, '&H00FCFCFC', 5.5, 5, 1305),
           'CAP': ('Noto Sans JP Medium', 82, '&H0019FFF7', 5.5, 5, 1305),
           'EFF': ('Noto Sans JP Medium', 70, '&H0002FEF6', 4,   5, 1305),
           'CR':  ('Noto Sans JP Bold',   64, '&H00999999', 0,   8, 1600)},
}
ACCENT = '&H001BFFF6'   # 제목 둘째 줄 강조색(노랑) — 인라인으로 준다
POS_Y = 5     # LOOK 항목에서 y 가 몇 번째인가
POS_AL = 4    # 정렬


def check_transcript(words):
    """전사가 **낱말 단위**인지 본다. 아니면 분명히 실패시킨다.

    ★전사 형식이 두 가지다(2026-10-09 실측).
      낱말 단위   [[0.24, 0.72, "Pizza"], ...]                      ← 우리가 쓸 수 있다
      겹침 토막   [[12.72, 15.51, "That's enough. He's in the ..."],
                  [15.51, 15.52, "house. Get out there and end this. Give"], ...]
                  스트리밍 부분결과라 앞 것이 뒤에 통째로 또 나온다. 시각을 못 잰다.
      겹침 토막을 그냥 받으면 자막이 엉뚱한 데 붙는다. **조용히 틀리느니 서는 게 낫다.**
    """
    if not words:
        sys.exit('전사가 비어 있다')
    long = sum(1 for w in words[:60] if len(str(w[2]).split()) > 3)
    if long > len(words[:60]) * 0.4:
        first = str(words[1][2] if len(words) > 1 else words[0][2])[:90]
        sys.exit('전사가 낱말 단위가 아니다(겹침 토막으로 보인다) — 낱말 단위 전사를 써라. 첫 토막: %r' % first)


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


def write_ass(path, title, credit, events, total, lang):
    look = LOOK.get(lang, LOOK['ja'])
    head = [
        '[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes',
        'PlayResX: %d' % W, 'PlayResY: %d' % H, '',
        '[V4+ Styles]',
        # ★볼케이노 captions.ass 와 **글자 하나까지 같은** Format 줄이어야 한다.
        #   린박스 뼈대의 Format 에는 SecondaryColour 가 빠져 있는데 Style 줄은 색을 넷 쓴다 —
        #   칸 수가 어긋나 libass 가 스타일을 통째로 버리고 **제목이 안 그려졌다**(2026-10-09).
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, '
        'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, '
        'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ]
    # ★볼케이노 captions.ass 와 같은 줄을 낸다 — 보조색 &H000000FF, 여백 L20 R20 V0,
    #   Bold/Italic 플래그는 0(글꼴 이름으로 굵기를 낸다).
    for name, (font, size, col, outline, align, _) in look.items():
        head.append('Style: %s,%s,%d,%s,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,%s,0,%d,20,20,0,1'
                    % (name, font, size, col, outline, align))
    head += ['', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    body = []
    full = '0:00:00.00,%s' % ass_time(total)
    # ★볼케이노는 제목에 인라인으로 크기·색을 다시 박는다(pos · fax0 · fs99 · c&H...&).
    #   둘째 줄 강조색(노랑)은 **스타일이 아니라 인라인**으로 준다 — 엔진과 같은 방식이다.
    t1 = look['T1']
    body.append(r'Dialogue: 1,%s,T1,,0,0,0,,{\pos(%d,%d)\fax0\fs%d\c%s&}%s'
                % (full, W // 2, t1[POS_Y], t1[1], t1[2], esc(title[0])))
    if len(title) > 1:
        t2 = look['T2']
        body.append(r'Dialogue: 1,%s,T2,,0,0,0,,{\pos(%d,%d)\fax0\fs%d\c%s&}%s'
                    % (full, W // 2, t2[POS_Y], t2[1], ACCENT, esc(title[1])))
    body.append('Dialogue: 0,%s,CR,,0,0,0,,{\\pos(%d,%d)}%s' % (full, W // 2, look['CR'][POS_Y], esc(credit)))
    # ★명화관은 **해설(NAR)과 원음 대사(CAP)를 다른 모양으로 쓴다** — ko 는 글꼴까지 다르다
    #   (해설 카페24 아네모네 흰색 · 원음 서울한강체 노랑). 통일하면 ko 스타일이 사라진다.
    for a, b, text, style in events:
        body.append('Dialogue: 1,%s,%s,%s,,0,0,0,,{\\pos(%d,%d)}%s'
                    % (ass_time(a), ass_time(b), style, W // 2, look[style][POS_Y], esc(text)))
    path.write_text('\n'.join(head + body) + '\n', encoding='utf-8')


# ---------------------------------------------------------------- 그림
def measure_content(src, segs):
    """원본의 **검은 띠를 걷어낸 알맹이 네모**를 잰다. (w, h, x, y)

    ★볼케이노 film_editor.py 786~804 를 그대로 옮겼다 — 컷 8개를 1초씩 cropdetect 하고
      **최빈값**을 쓴다. 원본 절반보다 작게 잡힌 표본은 버린다(어두운 장면에서 cropdetect 가
      화면 한복판만 집어내는 일이 있다). 안정된 값이 없으면 통짜 프레임을 쓴다.
    ★이걸 안 하면 레터박스가 있는 원본에서 **검은 띠째로 그림 창에 들어간다.**
    """
    import collections
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(src)],
                           capture_output=True, text=True)
    try:
        sw, sh = [int(x) for x in probe.stdout.strip().split(',')[:2]]
    except ValueError:
        return None
    samples = []
    for g in segs[:8]:
        r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-ss', '%.3f' % g['pic_in'],
                            '-i', str(src), '-map', '0:v:0', '-an', '-t', '%.3f' % min(1.0, g['dur']),
                            '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        samples += [tuple(int(v) for v in m)
                    for m in re.findall(r'crop=(\d+):(\d+):(\d+):(\d+)', r.stderr or '')]
    valid = [s for s in samples
             if s[0] >= sw * .5 and s[1] >= sh * .5 and s[2] + s[0] <= sw and s[3] + s[1] <= sh]
    if not valid:
        return (sw, sh, 0, 0)
    return collections.Counter(valid).most_common(1)[0][0]


def camera_expr(points, span, crop_w, c_off, c_span):
    """카메라 점들을 ffmpeg crop 오프셋 식으로 바꾼다. **점 사이는 부드럽게 이어진다.**

    ★볼케이노 film_editor.py 1407~1422 를 그대로 옮겼다.
      x(cx) = clamp(cx*span - crop_w/2, c_off, c_off + c_span - crop_w)
      점 사이: x(a) + (x(b)-x(a)) * clip((n-na)/(nb-na), 0, 1)   ← 프레임 n 에 따라 선형으로
    ★cx 는 **통짜 가로(span)** 기준이고, 창만 알맹이(c_off, c_span) 안으로 가둔다.
      예전엔 알맹이 안에서 cx 를 셌는데 레터박스가 있는 원본에서 자리가 어긋난다.
    ★예전엔 점마다 조각을 잘라 붙였다 — 그러면 화면이 **뚝 끊긴다.** 엔진은 한 번에 굽고
      식 안에서 움직인다. 그래야 같은 그림이 나온다(2026-10-09 엔진 코드로 확인).

    points: [(프레임번호, cx), ...] — 프레임번호는 이 조각 안에서 0부터
    """
    def x(cx):
        return int(round(max(c_off, min(c_off + c_span - crop_w, cx * span - crop_w / 2)) / 2) * 2)
    expr = str(x(points[-1][1]))
    for (na, ca), (nb, cb) in reversed(list(zip(points, points[1:]))):
        if nb <= na:
            continue
        expr = 'if(lt(n,%d),%d+(%d)*clip((n-%d)/%d,0,1),%s)' % (nb, x(ca), x(cb) - x(ca), na, nb - na, expr)
    return expr


def pic_clip(src, t0, n_frames, points, mirror, out, zoom=(1.0, 0.5), content=None):
    """원본 t0 부터 n_frames 만큼을 떼어 그림 창(1080x1080)으로 만든다.

    points: [(프레임번호, cx), ...] — 조각 안 0 부터. 한 점이면 고정, 여러 점이면 이어 움직인다.
    zoom=(z, cy): 알맹이 높이의 z 만큼만 쓰고 세로 가운데를 cy 에 둔다(1.0 이면 전체).
    content=(w, h, x, y): 검은 띠를 걷어낸 알맹이 네모. measure_content() 가 잰다.
    """
    z, cy = zoom
    if not content:
        sys.exit('알맹이 네모를 못 쟀다 — 원본을 확인하라')
    cwid, chei, cx0, cy0 = content
    crop_h = max(2, int(round(chei * z / 2) * 2))
    crop_w = max(2, int(round(crop_h * PIC_W / PIC_H / 2) * 2))
    sw = cx0 + cwid          # 통짜 가로를 모르면 알맹이 오른끝을 쓴다(아래에서 실제 폭으로 덮어쓴다)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width', '-of', 'csv=p=0', str(src)],
                           capture_output=True, text=True)
    try:
        sw = int(probe.stdout.strip().split(',')[0])
    except ValueError:
        pass
    crop_w = min(crop_w, cwid)
    x_expr = camera_expr(points, sw, crop_w, cx0, cwid)
    y = int(round(max(cy0, min(cy0 + chei - crop_h, cy0 + chei * cy - crop_h / 2)) / 2) * 2)
    vf = ("crop=%d:%d:'%s':%d,scale=%d:%d:flags=lanczos,setsar=1,fps=%d"
          % (crop_w, crop_h, x_expr, y, PIC_W, PIC_H, FPS))
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
    check_transcript(words)
    # ★작업 폴더는 **출력 이름별로** 따로 둔다. 같은 편집표를 두 번 동시에 돌리면
    #   조각 파일(v00_0.mp4 …)을 서로 덮어써서 프레임이 모자란 완성본이 나온다
    #   (2026-10-09 실측: 5242 프레임이어야 할 것이 3838 로 나왔다).
    out = Path(a.out) if a.out else Path(a.plan).resolve().parent / '_render' / 'final.mp4'
    work = Path(a.plan).resolve().parent / ('_render_' + out.stem)
    work.mkdir(parents=True, exist_ok=True)
    cache = MIDFORM / 'cache' / 'tts'
    cache.mkdir(parents=True, exist_ok=True)

    for i, line in enumerate(plan['title']):
        if len(line) > TITLE_MAX[lang]:
            sys.exit('제목 %d줄이 %d자를 넘는다: %r' % (i + 1, TITLE_MAX[lang], line))

    nar = {n['id']: n for n in plan['narration']}

    # 1) 음성을 먼저 사고 길이를 받는다 — 길이가 정해져야 그림을 몇 프레임 뽑을지 안다
    reuse = paid_narration(plan, plan['narration'])
    for n in plan['narration']:
        # ★칸은 «공백»으로 잇는다(언어 무관) — 볼케이노와 같은 글이어야 같은 끊어 읽기가 나온다.
        text = ' '.join(n['cards'])
        n['text'] = text
        if n['id'] in reuse:
            # 볼케이노가 산 통짜 음성에서 이 해설 몫만 떼어 쓴다
            src_wav, a0, b0, total_wav = reuse[n['id']]
            # ★앞뒤 여유는 볼케이노와 같은 값이다 — 앞 0.065초·뒤 0.09초, 그리고 **올림**
            #   (film_editor.py 717~719: a = start-.065 · b = end+.09 · frames = ceil((b-a)*fps)).
            #   어림잡아 0.12 를 쓰니 세 해설에서 6프레임이 더 나왔다(5152 vs 5146).
            a1 = max(0.0, a0 - NAR_HEAD)
            # ★뒤 여유는 **음성 전체 길이를 넘지 못한다**(film_editor.py 718: min(audio_duration, ...)).
            #   가두지 않으면 마지막 해설이 없는 소리를 달라 하고 프레임이 넘친다
            #   (2026-10-09 실측: 8.451 > 8.375 라 2프레임 더 나왔다).
            b1 = min(total_wav, b0 + NAR_TAIL) if total_wav else b0 + NAR_TAIL
            dur = math.ceil((b1 - a1) * FPS) / FPS
            cut = cache / ('paid_%s_%s.wav' % (Path(src_wav).parent.name[:12], n['id']))
            if not cut.exists():
                run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', '%.3f' % a1, '-i', str(src_wav),
                     '-t', '%.3f' % dur, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', cut])
            n['wav'] = cut
            n['meta'] = {'text': text, 'words': [], 'duration': dur}
        else:
            n['wav'], n['meta'] = tts(text, lang, cache)
        n['dur'] = n['meta']['duration']

    # 2) 구간을 펼친다
    # ★해설 그림은 **편집표의 narration[].source 시각에서 시작한다.**
    #   볼케이노 film_editor.py 662·728 줄이 그렇게 한다:
    #     a = narration[clip['narration']]['source'] if 'narration' in clip else clip['source_in']
    #     narration[n['id']] = {'kind': 'N', 'source_in': n['source'], ...}
    #   린박스는 «앞 컷 끝에서 이어서» 잡는데 **명화관은 다르다.** 뼈대를 옮길 때 이걸
    #   같이 가져와 해설 그림이 엉뚱한 데서 시작했다(2026-10-09 엔진 코드로 확인).
    seq = plan['sequence']
    segs = []
    for i, s in enumerate(seq):
        if 'narration' in s:
            n = nar[s['narration']]
            dur = n['dur']
            if 'pic_in' in s:
                pic_in = s['pic_in']          # 손으로 지정했으면 그것이 먼저다
            elif n.get('source') is not None:
                pic_in = n['source']          # ★기본 — 편집표가 정한 자리
            else:
                nxt = next((x for x in seq[i + 1:] if 'source_in' in x), None)
                if nxt is None:
                    sys.exit('해설에 source 가 없고 뒤에 컷도 없다')
                pic_in = max(0.0, nxt['source_in'] - dur)
            segs.append({'kind': 'nar', 'id': n['id'], 'pic_in': pic_in, 'dur': dur,
                         'cx': s.get('cx', 0.5), 'zoom': s.get('zoom', plan.get('zoom', [1.0, 0.5])), 'wav': n['wav']})
        else:
            dur = s['source_out'] - s['source_in']
            segs.append({'kind': 'cut', 'pic_in': s['source_in'], 'dur': dur,
                         'cx': s.get('cx', 0.5), 'zoom': s.get('zoom', plan.get('zoom', [1.0, 0.5])), 'captions': s.get('captions', []),
                         't0': s['source_in'], 't1': s['source_out']})

    # 검은 띠를 먼저 걷어낸다 — 그 안에서만 프레임을 잡는다(볼케이노와 같은 방식)
    content = measure_content(src, segs)
    if content:
        print('  알맹이 네모 %dx%d +%d+%d' % content)

    total = sum(g['dur'] for g in segs)
    if not 85 <= total <= 180:
        print('⚠ 길이 %.2f초 — 85~180초 밖이다(엔진 하한 85초·숏츠 상한 180초)' % total)

    # 3) 그림·소리 조각을 만든다
    parts_v, parts_a, events, t = [], [], [], 0.0
    for k, g in enumerate(segs):
        nf = frames(g['dur'])
        # cx 는 숫자 하나거나 [[원본시각, cx], ...] — 한 컷 안에서 화자가 바뀌면 여러 점을 준다.
        # ★조각으로 자르지 않고 **한 번에 굽는다.** 점 사이는 crop 식 안에서 이어 움직인다
        #   (볼케이노 camera_expression 과 같은 방식). 잘라 붙이면 화면이 뚝 끊긴다.
        marks = sorted(g['cx']) if isinstance(g['cx'], list) else [[g['pic_in'], g['cx']]]
        points = [(min(nf - 1, max(0, frames(tm - g['pic_in']))), float(c)) for tm, c in marks]
        seen, pts = set(), []
        for n0, c in points:               # 같은 프레임에 두 점이 오면 뒤엣것을 버린다
            if n0 not in seen:
                seen.add(n0); pts.append((n0, c))
        if pts[0][0] != 0:
            pts.insert(0, (0, pts[0][1]))  # 첫 점은 조각 머리에서 시작해야 한다
        v = work / ('v%02d.mp4' % k)
        pic_clip(src, g['pic_in'], nf, pts, plan.get('mirror', True), v, tuple(g['zoom']), content)
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

    # 5) 소리 크기를 편마다 같게 — **볼케이노와 같은 2패스 방식**
    # ★엔진은 먼저 재고(print_format=json) 그 실측값을 linear=true 로 되먹인다
    #   (film_editor.py 1815~1820). 1패스로 하면 구간마다 이득이 움직여 덜 정확하다 —
    #   실제로 1패스는 -13.8 이 나왔다(목표 -13.5).
    # ★무음이면 측정을 **지어내지 않는다.** 엔진 주석 그대로:
    #   "Digital silence has no finite loudness; do not invent a measurement."
    tmp = out.with_name(out.stem + '_ln.mp4')
    base = 'loudnorm=I=%s:TP=%s:LRA=%s' % (LUFS, TRUE_PEAK, LRA)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(out),
                        '-af', base + ':print_format=json', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    blocks = re.findall(r'\{[^{}]+\}', r.stderr or '')
    af = base
    if blocks:
        try:
            st = json.loads(blocks[-1])
            vals = [float(st[k]) for k in ('input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset')]
            if all(v == v and abs(v) != float('inf') for v in vals):
                af = base + ':linear=true:' + ':'.join(
                    '%s=%s' % (k, st[v]) for k, v in
                    [('measured_I', 'input_i'), ('measured_TP', 'input_tp'),
                     ('measured_LRA', 'input_lra'), ('measured_thresh', 'input_thresh'),
                     ('offset', 'target_offset')])
                print('  소리 실측 %s LUFS · LRA %s → %s 로 맞춘다' % (st['input_i'], st['input_lra'], LUFS))
        except (ValueError, KeyError):
            pass
    run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out, '-af', af + ',aresample=48000',
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
