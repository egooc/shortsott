# -*- coding: utf-8 -*-
"""고양이 밈 기업 흥망(헤이루만 한국판 시범) 렌더 — 내레이션 0, 화면 대사 + 효과음 + BGM.

    python -X utf8 ko-corp/cat/cat_render.py ko-corp/cat01            beats.json → out/episode.mp4
    python -X utf8 ko-corp/cat/cat_render.py ko-corp/cat01 --only 0-5   앞 몇 화면만(시험, 락은 똑같이 잡는다)

beats.json:
  {"bgm": "assets/bgm/shopping/Komiku_-_12_-_Bicycle.ogg",
   "beats": [{"bg": "kitchen", "year": "1999년", "gray": false, "dur": 6.0, "sfx": "pop",
              "cats": [{"pose": "shock", "x": 0.22, "tag": "가게 사장(재연)", "line": "이게 다 팔렸다고?!", "color": "red", "flip": false}]}]}
  bg = img/<bg>.png(16:9 장면 그림), pose = cast/<pose>.png(초록 배경 고양이 → 자동 키잉). line 의 줄바꿈은 «\n», 색은 yellow|red|white.
  dur 이 없으면 대사 글자 수로 정한다(9자/줄·약 6초/화면 레퍼런스 실측). 실존 인물 대사의 tag 엔 «(재연)» 이 있어야 한다 — 없으면 종료 4.
렌더 동안 politics-hour/RENDERING.lock 을 잡는다(락 있으면 시작 안 함). 원본 고양이 밈 영상 프레임은 쓰지 않는다 — 고양이는 전부 cast/ 의 우리 그림.
"""
import atexit
import datetime
import json
import math
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / 'politics-hour' / 'RENDERING.lock'
FONT = str(ROOT / 'assets' / 'fonts' / 'rinbox' / 'GmarketSansBold.otf')
SFX = {'pop': ROOT / 'fantube' / 'sfx' / 'pop.wav', 'sparkle': ROOT / 'fantube' / 'sfx' / 'sparkle.wav',
       'hit': ROOT / 'politics-hour' / 'assets' / 'sfx' / 'transition_hit.wav'}
W, H, FPS = 1920, 1080, 30
COLORS = {'yellow': (255, 232, 0), 'red': (235, 20, 20), 'white': (255, 255, 255)}
CODE = '2026-10-26a'


def take_lock(ep):
    if LOCK.exists():
        raise SystemExit(f'RENDERING.lock 있음 — 시작 안 함: {LOCK.read_text(encoding="utf-8")[:200]}')
    LOCK.write_text(json.dumps({'pid': os.getpid(), 'episode': f'cat {ep.name}', 'started': datetime.datetime.now().isoformat(timespec='seconds'),
                                'expect_hours': 0.5}, ensure_ascii=False), encoding='utf-8')

    def release():
        try:
            if json.loads(LOCK.read_text(encoding='utf-8')).get('pid') == os.getpid():
                LOCK.unlink()
        except (OSError, ValueError):
            pass
    atexit.register(release)


def free_gb():
    out = subprocess.run(['powershell', '-c', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], capture_output=True, text=True).stdout
    return int(out.strip() or 0) / 1024 / 1024


def ff(*a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *map(str, a)], check=True)


def keyed(src, dst):
    """초록 배경 고양이 → 투명 PNG(가장자리 초록 번짐 제거). 이미 만든 건 그대로."""
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return dst
    im = Image.open(src).convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if g > 120 and g > r * 1.35 and g > b * 1.35:
                px[x, y] = (0, 0, 0, 0)
            elif g > max(r, b):
                px[x, y] = (r, max(r, b), b, a)
    a = im.split()[3].filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1))
    im.putalpha(a)
    im.crop(im.getbbox()).save(dst)
    return dst


def outlined(draw, xy, text, font, fill, stroke=12, anchor='mm'):
    draw.multiline_text(xy, text, font=font, fill=fill, anchor=anchor, align='center', spacing=10,
                        stroke_width=stroke, stroke_fill=(0, 0, 0))


def text_layer(beat, path):
    """연도(왼쪽 위) · 대사(굵은 테두리 글씨) · 이름표(흰 상자) 한 장."""
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if beat.get('year'):
        outlined(d, (36, 30), beat['year'], ImageFont.truetype(FONT, 64), (255, 255, 255), 10, 'la')
    cats = beat.get('cats', [])
    for c in cats:
        x = int(c.get('x', 0.25) * W)
        if c.get('line'):
            lines = c['line'].split('\n')
            size = 76 if max(len(s) for s in lines) <= 11 else 64
            tx = int(c.get('tx', 0.68 if c.get('x', 0.25) < 0.5 else 0.32) * W) if len(cats) == 1 else x
            ty = int(c.get('ty', 0.36 if len(cats) == 1 else 0.2) * H)
            outlined(d, (tx, ty), c['line'], ImageFont.truetype(FONT, size), COLORS[c.get('color', 'yellow')])
        if c.get('tag'):
            f = ImageFont.truetype(FONT, 40)
            l, t, r, b = d.multiline_textbbox((0, 0), c['tag'], font=f, align='center', spacing=4)
            bw, bh = r - l + 36, b - t + 22
            bx, by = max(12, min(W - bw - 12, x - bw // 2)), H - bh - 40
            d.rectangle((bx, by, bx + bw, by + bh), fill=(255, 255, 255), outline=(0, 0, 0), width=3)
            d.multiline_text((bx + bw / 2, by + bh / 2), c['tag'], font=f, fill=(0, 0, 0), anchor='mm', align='center', spacing=4)
    im.save(path)


def beat_dur(beat):
    if beat.get('dur'):
        return float(beat['dur'])
    n = sum(len(c.get('line', '').replace('\n', '')) for c in beat.get('cats', []))
    return round(min(8.0, max(3.5, 2.0 + n * 0.11)), 1)


def check(beats):
    bad = [i for i, b in enumerate(beats) for c in b.get('cats', []) if c.get('real') and '재연' not in c.get('tag', '')]
    if bad:
        print(f'재연 표시 관문: 실존 인물 대사에 «재연» 없는 화면 {bad} — 종료 4')
        raise SystemExit(4)


def render_beat(ep, i, beat, d, work):
    seg = work / f'b{i:03d}.mp4'
    key = json.dumps([beat, d, CODE], ensure_ascii=False, sort_keys=True)
    if seg.exists() and (work / f'b{i:03d}.key').exists() and (work / f'b{i:03d}.key').read_text(encoding='utf-8') == key:
        return seg
    txt = work / f'b{i:03d}_text.png'
    text_layer(beat, txt)
    n = int(d * FPS)
    z0, z1 = (1.0, 1.06) if i % 2 == 0 else (1.06, 1.0)
    gray = ',hue=s=0' if beat.get('gray') else ''
    inputs = ['-loop', '1', '-i', ep / 'img' / f'{beat["bg"]}.png']
    flt = [f'[0]scale=3840:-2,zoompan=z=\'{z0}+({z1}-{z0})*on/{n}\':x=\'(iw-iw/zoom)/2\':y=\'(ih-ih/zoom)/2\':d={n}:s={W}x{H}:fps={FPS}{gray},format=rgba[v0]']
    last = 'v0'
    for j, c in enumerate(beat.get('cats', [])):
        cat = keyed(ep / 'cast' / f'{c["pose"]}.png', work / f'cat_{c["pose"]}.png')
        h = int(c.get('h', 0.62) * H)
        inputs += ['-loop', '1', '-i', cat]
        k = j + 1
        flip = ',hflip' if c.get('flip') else ''
        x = int(c.get('x', 0.25) * W)
        bob = c.get('bob', 10)
        flt.append(f'[{k}]scale=-1:{h}{flip}[c{j}]')
        flt.append(f'[{last}][c{j}]overlay=x=\'{x}-w/2\':y=\'{H - 40}-h+{bob}*sin(2*PI*t*1.6+{j})\':shortest=1[v{j + 1}]')
        last = f'v{j + 1}'
    k = len(beat.get('cats', [])) + 1
    inputs += ['-loop', '1', '-i', txt]
    flt.append(f'[{k}]format=rgba,fade=in:st=0:d=0.12:alpha=1[t]')
    flt.append(f'[{last}][t]overlay=0:0:shortest=1,format=yuv420p[out]')
    ff(*inputs, '-filter_complex', ';'.join(flt), '-map', '[out]', '-t', f'{d:.2f}', '-r', FPS, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', 18, seg)
    (work / f'b{i:03d}.key').write_text(key, encoding='utf-8')
    return seg


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1]).resolve()
    spec = json.loads((ep / 'beats.json').read_text(encoding='utf-8'))
    beats = spec['beats']
    check(beats)
    if '--only' in sys.argv:
        a, b = map(int, sys.argv[sys.argv.index('--only') + 1].split('-'))
        beats = beats[a:b + 1]
    if free_gb() < 8:
        raise SystemExit(f'빈 메모리 {free_gb():.1f}GB < 8GB — 시작 안 함')
    take_lock(ep)
    work, out = ep / 'work', ep / 'out'
    work.mkdir(exist_ok=True)
    out.mkdir(exist_ok=True)
    durs = [beat_dur(b) for b in beats]
    segs = [render_beat(ep, i, b, d, work) for i, (b, d) in enumerate(zip(beats, durs))]
    (work / 'list.txt').write_text(''.join(f"file '{s.as_posix()}'\n" for s in segs), encoding='utf-8')
    video = work / 'video.mp4'
    ff('-f', 'concat', '-safe', 0, '-i', work / 'list.txt', '-c', 'copy', video)
    total = sum(durs)
    # 소리: BGM(-20dB 깔기) + 화면마다 효과음
    ins, mix, t = ['-stream_loop', '-1', '-i', ROOT / spec['bgm']], ['[0]volume=0.18,atrim=0:%.2f[bg]' % total], 0.0
    labels = ['[bg]']
    for i, (b, d) in enumerate(zip(beats, durs)):
        s = b.get('sfx', 'pop')
        if s and s in SFX:
            ins += ['-i', SFX[s]]
            k = len(labels)
            mix.append(f'[{k}]adelay={int(t * 1000)}|{int(t * 1000)},volume=0.7[s{k}]')
            labels.append(f'[s{k}]')
        t += d
    mix.append(''.join(labels) + f'amix=inputs={len(labels)}:normalize=0:duration=first[a]')
    audio = work / 'audio.wav'
    ff(*ins, '-filter_complex', ';'.join(mix), '-map', '[a]', '-t', f'{total:.2f}', '-ar', 48000, audio)
    final = out / ('test.mp4' if '--only' in sys.argv else 'episode.mp4')
    ff('-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
       '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-shortest', final)
    (out / 'timing.json').write_text(json.dumps([{'i': i, 'start': round(sum(durs[:i]), 2), 'dur': d} for i, d in enumerate(durs)], indent=2) + '\n', encoding='utf-8')
    print(f'{final} · 화면 {len(beats)}개 · {total:.1f}초 · 평균 {total / len(beats):.1f}초/화면')


if __name__ == '__main__':
    main()
