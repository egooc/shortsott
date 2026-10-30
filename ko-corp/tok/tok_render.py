# -*- coding: utf-8 -*-
"""틱톡 ④·⑤ 세로판(1080×1920, 60~90초) — 장면 그림·도해 + Supertonic ko 해설 + 덩어리 자막 + BGM → −14 LUFS.

    python -X utf8 ko-corp/tok/tok_render.py ko-corp/tok/tok4a voice     목소리만(가벼움) → voice/voice.wav·cues.json
    python -X utf8 ko-corp/tok/tok_render.py ko-corp/tok/tok4a audit     역전사로 숫자 대조(불일치면 종료 4)
    python -X utf8 ko-corp/tok/tok_render.py ko-corp/tok/tok4a render    화면 렌더(RENDERING.lock 잡음)

왜(10-30 HEAD 배정 · 오피스 #58): 틱톡 수익 계정 ④ 작동 원리 · ⑤ 소름 진실을 기업흥망 세션의 도해·생성 그림·TTS 로 시험 2편씩.
TTS 는 무료 엔진(Supertonic) — Typecast 는 cat01 한정 승인(#29)이라 쓰지 않는다.
화면: 0~2초 센 그림 + 첫 장면 제목, 위 왼쪽 출처 표시(재구성 그림·도해·원본 그림), 단계 꼬리표, 자막은 화면 65% 높이(틱톡 아래 UI 피함).
"""
import atexit
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'ko-corp' / 'render'))
from ko_say import say  # noqa: E402

LOCK = ROOT / 'politics-hour' / 'RENDERING.lock'
FONT = str(ROOT / 'assets' / 'fonts' / 'rinbox' / 'GmarketSansBold.otf')
W, H, FPS = 1080, 1920, 30
TTS = {'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic',
       'speed': 1.12, 'steps': 8, 'gap': 0.35, 'lang': 'ko', 'num_reading': False}
WORKER = ROOT / 'ja-nenkin' / 'render' / 'supertonic_worker.py'
LANE = {'mech': {'voice': 'F2', 'bgm': ROOT / 'assets' / 'bgm' / 'shopping' / 'Komiku_-_12_-_Bicycle.ogg', 'bgm_vol': 0.10},   # CC0
        'mystery': {'voice': 'M1', 'bgm': HERE / 'bgm_drone.wav', 'bgm_vol': 0.35}}   # 자체 합성(저작권 0)
TAIL = 1.2
CAP_MAX = 15


def ff(*a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *map(str, a)], check=True)


def chunks(text):
    """자막 덩어리: 문장부호에서 먼저 끊고, 15자 넘으면 띄어쓰기에서 나눈다."""
    out = []
    for part in re.split(r'(?<=[.?!,])\s+', text.strip()):
        cur = ''
        for w in part.split():
            if cur and len(cur) + 1 + len(w) > CAP_MAX:
                out.append(cur)
                cur = w
            else:
                cur = f'{cur} {w}'.strip()
        if cur:
            out.append(cur)
    return out


def shown(c):
    return re.sub(r'[.,]+$', '', c)


def read(scene):
    """읽기 고침 — 장면의 read {원문: 읽을 말}(역전사로 오독 확인된 곳만, 예: 1854년→«1894»로 들림 10-30)."""
    text = scene['say']
    for k, v in scene.get('read', {}).items():
        text = text.replace(k, v)
    return text


def voice(ep, spec):
    vdir = ep / 'voice'
    vdir.mkdir(exist_ok=True)
    job = dict(TTS, voice=LANE[spec['lane']]['voice'], out=str(vdir / 'voice.wav'),
               sentences=[[say(read(s)), chunks(s['say'])] for s in spec['scenes']])
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(job, f, ensure_ascii=False)
    r = subprocess.run([TTS['python'], str(WORKER), f.name], capture_output=True, text=True, encoding='utf-8',
                       env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    os.unlink(f.name)
    if r.returncode:
        raise SystemExit(r.stderr[-2000:])
    cues = json.loads(r.stdout.strip().splitlines()[-1])
    k, scenes = 0, []
    for s in spec['scenes']:
        n = len(chunks(s['say']))
        scenes.append(cues[k:k + n])
        k += n
    (vdir / 'cues.json').write_text(json.dumps(scenes, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'목소리 {LANE[spec["lane"]]["voice"]} · {cues[-1][1]:.1f}초 · 자막 {len(cues)}덩어리')


def audit(ep, spec):
    """voice.wav 를 Speechmatics ko 로 받아쓰고 원고 숫자가 다 들렸는지 센다(ko TTS 오독 10-19)."""
    import audit as A
    au = ep / 'audit'
    au.mkdir(exist_ok=True)
    tr = au / 'voice.json'
    subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'rinbox_transcribe.py'), str(ep / 'voice' / 'voice.wav'), str(tr), '--lang', 'ko'], check=True)
    words = json.loads(tr.read_text(encoding='utf-8'))
    heard = ' '.join(w for _, _, w in words)
    want = Counter(v for s in spec['scenes'] for v in A.script_values(s['say']) if v is not None)
    miss = want - Counter(A.values(heard))
    head = f'역전사 대조: 숫자 {sum(want.values()) - sum(miss.values())}/{sum(want.values())}' + (f' · 빠짐 {dict(miss)}' if miss else '')
    (au / 'report.md').write_text(head + '\n\n들림: ' + heard + '\n', encoding='utf-8')
    print(head)
    return 4 if miss else 0


def cover(src, dst):
    im = Image.open(src).convert('RGB')
    s = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - W) // 2, (im.height - H) // 2
    im.crop((x, y, x + W, y + H)).save(dst)


def pill(d, xy, text, size, fg, bg, anchor='la'):
    f = ImageFont.truetype(FONT, size)
    x0, y0, x1, y1 = d.textbbox(xy, text, font=f, anchor=anchor)
    d.rounded_rectangle([x0 - 22, y0 - 14, x1 + 22, y1 + 14], 18, fill=bg)
    d.text(xy, text, font=f, fill=fg, anchor=anchor)


def overlay(scene, cap, title, path):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if scene.get('badge'):
        pill(d, (60, 200), scene['badge'], 34, (255, 255, 255), (0, 0, 0, 150))
    if scene.get('step'):
        pill(d, (W // 2, scene.get('step_y', 330)), scene['step'], 64, (20, 20, 20), (255, 170, 40, 235), 'mm')
    if title:
        f = ImageFont.truetype(FONT, 84)
        lines = wrap(title, 11)
        d.multiline_text((W // 2, 520), '\n'.join(lines), font=f, fill=(255, 230, 0), anchor='mm', align='center',
                         spacing=18, stroke_width=10, stroke_fill=(0, 0, 0))
    if cap:
        f = ImageFont.truetype(FONT, 76)
        d.multiline_text((W // 2, 1290), '\n'.join(wrap(cap, 11)), font=f, fill=(255, 255, 255), anchor='mm', align='center',
                         spacing=16, stroke_width=9, stroke_fill=(0, 0, 0))
    im.save(path)


def wrap(t, n):
    if len(t) <= n:
        return [t]
    sp = [i for i, ch in enumerate(t) if ch == ' ']
    if not sp:
        return [t[:n], t[n:]]
    i = min(sp, key=lambda i: abs(i - len(t) / 2))
    return [t[:i], t[i + 1:]]


def drone(dst):
    """자체 합성 저음 BGM(미스터리) — 55·82.5·110.4Hz 사인 + 느린 떨림 + 걸러 낸 분홍 소음, 90초."""
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.30*sin(2*PI*55*t)*(0.7+0.3*sin(2*PI*0.11*t))+0.18*sin(2*PI*82.5*t)*(0.6+0.4*sin(2*PI*0.07*t))'
       '+0.10*sin(2*PI*110.4*t):s=48000:d=95', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.05:d=95:r=48000',
       '-filter_complex', '[1]lowpass=f=400[n];[0][n]amix=inputs=2:normalize=0,afade=t=in:d=2,volume=0.8', '-ac', '2', dst)


def take_lock(ep):
    if LOCK.exists():
        raise SystemExit(f'RENDERING.lock 있음 — 시작 안 함: {LOCK.read_text(encoding="utf-8")[:200]}')
    LOCK.write_text(json.dumps({'pid': os.getpid(), 'episode': f'tok {ep.name}', 'started': datetime.datetime.now().isoformat(timespec='seconds'),
                                'expect_hours': 0.2}, ensure_ascii=False), encoding='utf-8')

    def release():
        try:
            if json.loads(LOCK.read_text(encoding='utf-8')).get('pid') == os.getpid():
                LOCK.unlink()
        except (OSError, ValueError):
            pass
    atexit.register(release)


def render(ep, spec):
    cues = json.loads((ep / 'voice' / 'cues.json').read_text(encoding='utf-8'))
    starts = [0.0] + [c[0][0] - 0.12 for c in cues[1:]]
    end = cues[-1][-1][1] + TAIL
    work = ep / 'work'
    work.mkdir(exist_ok=True)
    take_lock(ep)
    parts = []
    for i, (scene, cs) in enumerate(zip(spec['scenes'], cues)):
        t0, t1 = starts[i], starts[i + 1] if i + 1 < len(starts) else end
        dur = t1 - t0
        img = ep / 'img' / (scene['img'] + '.png')
        if scene['img'] == 'monalisa':
            img = ep / 'img' / 'monalisa_src.jpg'
        base = work / f'base_{i:02d}.png'
        cover(img, base)
        ins, fl, last = ['-loop', '1', '-t', f'{dur:.3f}', '-i', base], [], '[bg]'
        frames = max(1, round(dur * FPS))
        z = 0.0004 if scene['img'].startswith('d') else 0.0011   # 도해는 거의 정지, 그림은 천천히 당김
        fl.append(f'[0]scale={W * 2}:{H * 2},zoompan=z=\'1+{z}*on\':x=\'iw/2-iw/zoom/2\':y=\'ih/2-ih/zoom/2\':d={frames}:s={W}x{H}:fps={FPS}[bg]')
        for k, (a, b, text) in enumerate(cs):
            png = work / f'ov_{i:02d}_{k:02d}.png'
            overlay(scene, shown(text), spec['title'] if i == 0 else None, png)
            ins += ['-i', png]
            a0 = 0 if k == 0 else a - t0
            b0 = dur + 1 if k == len(cs) - 1 else cs[k + 1][0] - t0
            fl.append(f'{last}[{k + 1}]overlay=enable=\'between(t,{a0:.3f},{b0:.3f})\'[v{k}]')
            last = f'[v{k}]'
        seg = work / f'seg_{i:02d}.mp4'
        ff(*ins, '-filter_complex', ';'.join(fl), '-map', last, '-t', f'{dur:.3f}', '-r', FPS, '-c:v', 'libx264', '-preset', 'medium',
           '-crf', 19, '-pix_fmt', 'yuv420p', seg)
        parts.append(seg)
    lst = work / 'list.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    video = work / 'video.mp4'
    ff('-f', 'concat', '-safe', 0, '-i', lst, '-c', 'copy', video)
    lane = LANE[spec['lane']]
    if not lane['bgm'].exists():
        drone(lane['bgm'])
    audio = work / 'audio.wav'
    ff('-i', ep / 'voice' / 'voice.wav', '-stream_loop', '-1', '-i', lane['bgm'], '-filter_complex',
       f'[1]volume={lane["bgm_vol"]},atrim=0:{end:.2f},afade=t=out:st={end - 1.5:.2f}:d=1.5[bg];[0]apad[v];[v][bg]amix=inputs=2:normalize=0:duration=longest[a]',
       '-map', '[a]', '-t', f'{end:.2f}', '-ar', 48000, '-ac', 2, audio)
    out = ep / 'out'
    out.mkdir(exist_ok=True)
    final = out / f'{ep.name}.mp4'
    ff('-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', final)
    sys.path.insert(0, str(ROOT / 'scripts'))
    import loudnorm_final
    print('음량', loudnorm_final.normalize(final))
    print(f'{final} · 장면 {len(parts)} · {end:.1f}초')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1]).resolve()
    spec = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    step = sys.argv[2]
    if step == 'voice':
        voice(ep, spec)
    elif step == 'audit':
        sys.exit(audit(ep, spec))
    elif step == 'render':
        render(ep, spec)


if __name__ == '__main__':
    main()
