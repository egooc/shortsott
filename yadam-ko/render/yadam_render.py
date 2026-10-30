# -*- coding: utf-8 -*-
"""야담 ko 낭독 롱폼 렌더러 — 생성 그림 컷(5~8초) + 천천히 움직이기 + 아래 한 줄 자막 + Supertonic 낭독(무료).

    python -X utf8 yadam-ko/render/yadam_render.py yadam-ko/ep01 [--preview 90] [--tts-only] [--plan]

<편>/script.txt   @cut <키> [hold=초] 다음 줄들: 지문 = 이야기꾼 목소리, «>인물| 대사» = 인물 목소리
<편>/voices.json  {"_narr": {"voice": "F1", "speed": 0.95}, "<인물>": {"voice": ..., "speed": ...}}
<편>/img/<키>.png 또는 <키>a·<키>b·<키>c.png — 한 컷에 그림 여러 장이면 줄 경계에서 나눠 보여 준다(기획서: 한 컷 5~8초)
관문(순서): 렌더 창 13~17시 · 다른 레인 RENDERING 락 없음 · 빈 메모리 8GB+ → 원고 겹침(ref_overlap, 종료 4) → 결 표(gyeol_gate) → TTS → 렌더
결과: <편>/episode.mp4(-14 LUFS) · <편>/timeline.json(컷·줄 실측 초 — 결 표·댓글 초 갱신용) · <편>/subs.ass
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
FPS = 30
W, H = 1920, 1080
SUPERTONIC = {'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic', 'steps': 8}
LOCKS = [Path('D:/midform/politics-hour/RENDERING.lock'), Path('D:/midform/politics-hour/RENDERING-ja.lock')]
FREE_GB = 8
WINDOW = (13, 17)
GAP_SAME, GAP_SWAP, TAIL = 0.35, 0.55, 0.45
FONT_DIR = ROOT / 'assets' / 'fonts' / 'rinbox'
SUB_MAX = 22
MOTION_VER = 1
# 움직임 4가지를 돌린다: (시작 배율, 끝 배율, 시작 가로 기준점, 끝 가로 기준점)
MOVES = [(1.00, 1.08, .5, .5), (1.08, 1.00, .5, .5), (1.06, 1.06, .2, .8), (1.06, 1.06, .8, .2)]


def free_gb():
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in
                    ('total', 'avail', 'tpf', 'apf', 'tv', 'av', 'aev')]
    m = MS(); m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.avail / 2 ** 30


class render_lock:
    """RENDERING.lock = 무거운 작업 한 자리(관리자 10-22). 창·다른 락·메모리를 보고 잡고, 내가 만든 락만 지운다."""
    def __init__(self, label):
        self.label = label

    def __enter__(self):
        import atexit
        h = datetime.datetime.now().hour
        if not (WINDOW[0] <= h < WINDOW[1]):
            raise SystemExit(f'[관문] 렌더·TTS 는 {WINDOW[0]}~{WINDOW[1]}시 창에서만 — 지금 {h}시')
        locks = [x.name for x in LOCKS if x.exists()]
        gb = free_gb()
        print(f'[관문] 다른 레인 lock {", ".join(locks) or "없음"} · 빈 메모리 {gb:.1f}GB', flush=True)
        if locks or gb < FREE_GB:
            raise SystemExit('[관문] 락이 있거나 빈 메모리 8GB 미만 — 렌더 안 함')
        atexit.register(self.__exit__, None, None, None)
        self.text = f'yadam_ko {self.label} {datetime.datetime.now():%Y-%m-%d %H:%M:%S} 시작 (PID {os.getpid()})\n'
        LOCKS[0].write_text(self.text, encoding='utf-8')
        return self

    def __exit__(self, *exc):
        try:
            if LOCKS[0].read_text(encoding='utf-8') == self.text:
                LOCKS[0].unlink()
        except OSError:
            pass


def parse(ep):
    cuts = []
    for ln in (ep / 'script.txt').read_text(encoding='utf-8').splitlines():
        s = ln.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith('@cut'):
            parts = s.split()
            hold = next((float(p[5:]) for p in parts[2:] if p.startswith('hold=')), 0.0)
            cuts.append({'id': parts[1], 'hold': hold, 'lines': []})
            continue
        m = re.match(r'^>([^|]+)\|\s*(.+)$', s)
        cuts[-1]['lines'].append({'spk': m.group(1).strip(), 'text': m.group(2).strip()} if m else {'spk': '_narr', 'text': s})
    return cuts


def say(text):
    """소리로 낼 글: 말줄임표·따옴표는 쉼으로."""
    t = text.replace('…', ', ').replace('“', '').replace('”', '').replace('«', '').replace('»', '')
    t = re.sub(r',\s*,', ',', t).strip(' ,')
    return t if re.search(r'[.!?]$', t) else t + '.'


def tts(ep, cuts):
    V = json.loads((ep / 'voices.json').read_text(encoding='utf-8'))
    (ep / 'tts').mkdir(exist_ok=True)
    todo = []
    for c in cuts:
        for ln in c['lines']:
            v = V.get(ln['spk']) or V['_narr']
            spoken = say(ln['text'])
            h = hashlib.sha1(json.dumps([v['voice'], v.get('speed', 1.0), SUPERTONIC['steps'], spoken], ensure_ascii=False).encode()).hexdigest()[:12]
            ln['wav'] = str(ep / 'tts' / f'{h}.wav')
            ln['say'] = spoken
            if not Path(ln['wav']).exists():
                todo.append({'voice': v['voice'], 'speed': v.get('speed', 1.0), 'text': spoken, 'out': ln['wav']})
    if todo:
        job = ep / 'tts' / '_job.json'
        job.write_text(json.dumps({'dir': SUPERTONIC['dir'], 'steps': SUPERTONIC['steps'], 'items': todo}, ensure_ascii=False), encoding='utf-8')
        print(f'TTS {len(todo)}줄 합성', flush=True)
        subprocess.run([SUPERTONIC['python'], str(HERE / 'yd_tts_worker.py'), str(job)], check=True,
                       env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    for c in cuts:
        for ln in c['lines']:
            with wave.open(ln['wav']) as w:
                ln['dur'] = w.getnframes() / w.getframerate()


def timeline(cuts):
    t = 0.0
    prev = None
    for c in cuts:
        c['t0'] = t
        for ln in c['lines']:
            if prev is not None:
                t += GAP_SAME if prev == ln['spk'] else GAP_SWAP
            ln['t0'] = t
            t += ln['dur']
            ln['t1'] = t
            prev = ln['spk']
        t = max(t + TAIL, c['t0'] + c['hold'])
        c['t1'] = t
    return t


def images_of(ep, cid):
    one = ep / 'img' / f'{cid}.png'
    if one.exists():
        return [one]
    return [p for p in (ep / 'img' / f'{cid}{x}.png' for x in 'abcd') if p.exists()]


def shots(ep, cuts):
    """컷마다 그림 n장 — 컷 길이를 n 등분한 지점에서 가장 가까운 줄 경계로 나눈다."""
    out = []
    for c in cuts:
        imgs = images_of(ep, c['id'])
        if not imgs:
            raise SystemExit(f'그림 없음: {c["id"]}')
        n = len(imgs)
        bounds = [ln['t0'] for ln in c['lines'][1:]]
        cuts_at = []
        for k in range(1, n):
            target = c['t0'] + (c['t1'] - c['t0']) * k / n
            cand = [b for b in bounds if b not in cuts_at and (not cuts_at or b > cuts_at[-1])]
            b = min(cand, key=lambda b: abs(b - target)) if cand else target
            if abs(b - target) > (c['t1'] - c['t0']) / n * .45:     # 줄 경계가 너무 멀면 그냥 등분
                b = target
            cuts_at.append(b)
        edges = [c['t0'], *cuts_at, c['t1']]
        for i, img in enumerate(imgs):
            out.append({'cut': c['id'], 'img': img, 't0': edges[i], 't1': edges[i + 1]})
    return out


def clip(sh, k, out):
    d = sh['t1'] - sh['t0']
    z0, z1, x0, x1 = MOVES[k % len(MOVES)]
    n = max(1, round(d * FPS))
    p = f'(on/{max(1, n - 1)})'
    z = f'{z0}+({z1}-{z0})*{p}'
    x = f'(iw-iw/zoom)*({x0}+({x1}-{x0})*{p})'
    vf = (f'scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,crop={W * 2}:{H * 2},'
          f"zoompan=z='{z}':x='{x}':y='(ih-ih/zoom)/2':d=1:s={W}x{H}:fps={FPS},setsar=1,format=yuv420p")
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-loop', '1', '-framerate', str(FPS), '-i', str(sh['img']),
                    '-vf', vf, '-frames:v', str(n), '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', str(out)], check=True)
    return n / FPS


def chunks(text):
    """한 줄 자막 덩어리 — 문장을 SUB_MAX 안쪽 k 조각으로 고르게(꼬리 한 낱말만 남는 줄 없이), 쉼표 뒤를 먼저 끊는다."""
    words = text.split()
    k = -(-len(text) // SUB_MAX)
    if k <= 1:
        return [text]
    target = len(text) / k
    out, cur = [], ''
    for i, word in enumerate(words):
        nxt = f'{cur} {word}'.strip()
        left = len(' '.join(words[i:]))
        if cur and (len(nxt) > SUB_MAX or (len(cur) >= target * .8 and cur.endswith(',')) or len(nxt) > target * 1.15) \
                and left >= target * .5 and len(out) < k - 1:
            out.append(cur); cur = word
        else:
            cur = nxt
    out.append(cur)
    return out


def ass_time(t):
    cs = int(round(t * 100))
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


def subs(cuts, path):
    head = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\n'
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
            'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            'Style: N,Noto Sans KR,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,58,1\n'
            'Style: D,Noto Sans KR,68,&H00B4F5FF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,58,1\n\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    ev = []
    for c in cuts:
        for ln in c['lines']:
            parts = [p for s in re.split(r'(?<=[.!?])\s+', ln['text']) if s for p in chunks(s)]
            wts = [max(1, len(p.replace(' ', ''))) for p in parts]
            acc = 0
            for p, w in zip(parts, wts):
                a = ln['t0'] + ln['dur'] * acc / sum(wts); acc += w
                b = ln['t0'] + ln['dur'] * acc / sum(wts)
                st = 'N' if ln['spk'] == '_narr' else 'D'
                txt = p if st == 'N' else f'“{p}”'
                ev.append(f'Dialogue: 0,{ass_time(a)},{ass_time(b)},{st},,0,0,0,,{txt}')
    path.write_text(head + '\n'.join(ev) + '\n', encoding='utf-8')


def voice_track(cuts, total, out):
    with wave.open(cuts[0]['lines'][0]['wav']) as w0:
        sr, sw, ch = w0.getframerate(), w0.getsampwidth(), w0.getnchannels()
    buf = bytearray(int(total * sr) * sw * ch + sw * ch)
    for c in cuts:
        for ln in c['lines']:
            with wave.open(ln['wav']) as w:
                data = w.readframes(w.getnframes())
            i = int(ln['t0'] * sr) * sw * ch
            buf[i:i + len(data)] = data
    with wave.open(str(out), 'wb') as w:
        w.setnchannels(ch); w.setsampwidth(sw); w.setframerate(sr)
        w.writeframes(bytes(buf[:int(total * sr) * sw * ch]))


def main(argv):
    ep = Path(argv[0]).resolve()
    opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
    preview = float(opt('--preview', 0) or 0)
    cuts = parse(ep)
    if '--plan' in argv:   # 그림 개수·키 점검만(가벼움)
        miss = [c['id'] for c in cuts if not images_of(ep, c['id'])]
        print(f'컷 {len(cuts)} · 그림 없는 컷 {len(miss)} {miss[:20]}')
        return 4 if miss else 0
    r = subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'ref_overlap.py'), str(ep / 'script.txt'), '--lane', 'yadam_ko'])
    if r.returncode:
        print('[관문] 원고 겹침 — TTS 안 함'); return r.returncode
    r = subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'gyeol_gate.py'), str(ep)])
    if r.returncode:
        print('[관문] 결 표'); return r.returncode
    with render_lock('preview' if preview else ('tts' if '--tts-only' in argv else 'full')):
        tts(ep, cuts)
        total = timeline(cuts)
        tl = [{'id': c['id'], 't0': round(c['t0'], 2), 't1': round(c['t1'], 2),
               'lines': [{'spk': l['spk'], 'text': l['text'], 'say': l['say'], 't0': round(l['t0'], 2), 't1': round(l['t1'], 2)} for l in c['lines']]}
              for c in cuts]
        (ep / 'timeline.json').write_text(json.dumps({'total': round(total, 2), 'cuts': tl}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'총 {total:.1f}초 ({total / 60:.1f}분)', flush=True)
        if '--tts-only' in argv:
            return 0
        if preview:
            cuts = [c for c in cuts if c['t0'] < preview]
            total = cuts[-1]['t1']
        S = shots(ep, cuts)
        seg = ep / 'seg'; seg.mkdir(exist_ok=True)
        lst = []
        for k, sh in enumerate(S):
            h = hashlib.sha1(json.dumps([MOTION_VER, str(sh['img']), sh['img'].stat().st_mtime, round(sh['t1'] - sh['t0'], 3), k % len(MOVES)]).encode()).hexdigest()[:10]
            out = seg / f'{k:03d}_{sh["cut"]}_{h}.mp4'
            if not out.exists():
                clip(sh, k, out)
            lst.append(out)
            if k % 10 == 0:
                print(f'그림 {k + 1}/{len(S)}', flush=True)
        (ep / 'concat.txt').write_text(''.join(f"file '{p.as_posix()}'\n" for p in lst), encoding='utf-8')
        voice_track(cuts, total, ep / 'voice.wav')
        subs(cuts, ep / 'subs.ass')
        out = ep / ('preview.mp4' if preview else 'episode.mp4')
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(ep / 'concat.txt'), '-i', str(ep / 'voice.wav'),
                        '-vf', f"subtitles=subs.ass:fontsdir='{FONT_DIR.as_posix().replace(':', chr(92) + ':')}'",
                        '-map', '0:v', '-map', '1:a', '-t', f'{total:.3f}', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', str(out)], check=True, cwd=str(ep))
        import loudnorm_final
        print('음량', loudnorm_final.normalize(str(out)), flush=True)
        print('완료', out)
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main(sys.argv[1:]))
