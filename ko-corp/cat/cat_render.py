# -*- coding: utf-8 -*-
"""고양이 밈 기업 흥망(헤이루만 한국판 시범) 렌더 — 내레이션 0, 화면 대사 + 효과음 + BGM.

    python -X utf8 ko-corp/cat/cat_render.py ko-corp/cat01            beats.json → out/episode.mp4
    python -X utf8 ko-corp/cat/cat_render.py ko-corp/cat01 --only 0-5   앞 몇 화면만(시험, 락은 똑같이 잡는다)

beats.json:
  {"bgm": "assets/bgm/shopping/Komiku_-_12_-_Bicycle.ogg",
   "beats": [{"bg": "kitchen", "year": "1999년", "gray": false, "dur": 6.0, "sfx": "pop", "line": "이게 다 팔렸다고?!", "color": "red",
              "sub": "보조 자막(출처 기준 등)", "real": false, "cats": [{"pose": "boss_shock", "x": 0.22, "tag": "가게 사장(재연)", "flip": false}]}]}
  bg = img/<bg>.png(16:9 장면 그림), pose = cast/<pose>.png(초록 배경 고양이 → 자동 키잉). line 의 줄바꿈은 «\n», 색은 yellow|red|white.
  dur 이 없으면 대사 글자 수로 정한다(9자/줄·약 6초/화면 레퍼런스 실측). real=true(실존 인물 대사)인 화면의 이름표엔 «재연» 이 있어야 한다 — 없으면 종료 4.
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
SFX = {k: Path(__file__).resolve().parent / 'sfx' / f'{k}.wav' for k in ('pop', 'boing', 'tada', 'womp')}   # make_sfx.py 로 합성
W, H, FPS = 1920, 1080, 30
COLORS = {'yellow': (255, 232, 0), 'red': (235, 20, 20), 'white': (255, 255, 255)}
CODE = '2026-10-27a'


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


def wrap(line, n=11):
    """22자 대사 → 가운데에 가까운 띄어쓰기에서 두 줄(레퍼런스 한 줄 약 9~11자)."""
    if '\n' in line or len(line) <= n + 1:
        return line
    cuts = [i for i, ch in enumerate(line) if ch == ' ']
    if not cuts:
        return line
    i = min(cuts, key=lambda c: abs(c - len(line) / 2))
    return line[:i] + '\n' + line[i + 1:]


CAST = {'black.explain': 'black_explain', 'black.serious': 'black_serious', 'black.laugh': 'black_explain', 'black.suspicious': 'black_serious',
        'calico.photo': 'calico_photo', 'calico.shock': 'calico_shock', 'calico.laugh': 'calico_photo', 'couple.shy': 'couple_shy', 'couple.happy': 'couple_happy'}


def pose_src(ep, name):
    """«boss.angry» → pose/boss_angry.png(표정 낱장, 소유주 10-26) · 없으면 cast/ 시트 조각."""
    f = ep / 'pose' / (name.replace('.', '_') + '.png')
    return f if f.exists() else ep / 'cast' / (CAST.get(name, name.replace('.', '_')) + '.png')


def layout(ep, beat):
    """v2 화면(speaker·line·react·cutin) → 고양이 배치 + 글자 목록. v1(cats·line)은 그대로 둔다."""
    if 'speaker' not in beat:
        return beat
    b = dict(beat)
    if beat.get('cutin'):   # 표정 컷인: 고양이 하나를 크게, 글자 없음
        b['cats'] = [{'src': pose_src(ep, beat['speaker']), 'x': 0.5, 'h': 1.15, 'bottom': H + 260, 'bob': 6}]
        b['texts'], b['year'] = [], ''
        return b
    b['cats'] = [{'src': pose_src(ep, beat['speaker']), 'x': 0.2, 'h': 0.8, 'tag': beat.get('tag', ''), 'enter': bool(beat.get('enter'))}]
    lines = [x.strip() for x in beat.get('line', '').split('/') if x.strip()]
    size = 96 if len(lines) <= 3 and max(map(len, lines or [''])) <= 11 else 84
    b['texts'] = [{'text': '\n'.join(lines), 'x': 0.6, 'y': 0.33 if beat.get('react') else 0.4, 'size': size, 'color': beat.get('color', 'yellow')}]
    if beat.get('react'):
        b['cats'].append({'src': pose_src(ep, beat['react']), 'x': 0.86, 'h': 0.42, 'bob': 14})
        if beat.get('react_line'):
            b['texts'].append({'text': beat['react_line'], 'x': 0.8, 'y': 0.63, 'size': 62, 'color': 'white'})
    if beat.get('sub'):
        b['texts'].append({'text': beat['sub'], 'x': 0.6, 'y': 0.12, 'size': 34, 'color': 'white'})
    return b


def text_layer(beat, path):
    """연도·장소(왼쪽 위) · 대사(굵은 테두리 글씨, 노랑/빨강) · 보조 자막 · 이름표(흰 상자) 한 장."""
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if beat.get('year'):
        outlined(d, (36, 30), beat['year'], ImageFont.truetype(FONT, 72), (255, 255, 255), 12, 'la')
    cats = beat.get('cats', [])
    for t in beat.get('texts', []):
        outlined(d, (int(t['x'] * W), int(t['y'] * H)), t['text'], ImageFont.truetype(FONT, t['size']), COLORS[t['color']], max(6, t['size'] // 7))
    if beat.get('line') and 'texts' not in beat:
        xs = [c.get('x', 0.25) for c in cats]
        tx = beat.get('tx', 0.5 if len(cats) > 1 else (0.64 if (xs or [0.25])[0] < 0.5 else 0.36))
        text = wrap(beat['line'])
        size = 100 if max(len(s) for s in text.split('\n')) <= 11 else 86
        outlined(d, (int(tx * W), int(beat.get('ty', 0.34) * H)), text, ImageFont.truetype(FONT, size), COLORS[beat.get('color', 'yellow')], 14)
        if beat.get('sub'):
            outlined(d, (int(tx * W), int(beat.get('ty', 0.34) * H) + 170), beat['sub'], ImageFont.truetype(FONT, 34), (255, 255, 255), 6)
    for c in cats:
        if c.get('tag'):
            f = ImageFont.truetype(FONT, 54)
            l, t, r, b = d.multiline_textbbox((0, 0), c['tag'], font=f, align='center', spacing=4)
            bw, bh = r - l + 36, b - t + 22
            x = int(c.get('x', 0.25) * W)
            bx, by = max(12, min(W - bw - 12, x - bw // 2)), H - bh - 36
            d.rectangle((bx, by, bx + bw, by + bh), fill=(255, 255, 255), outline=(0, 0, 0), width=3)
            d.multiline_text((bx + bw / 2, by + bh / 2), c['tag'], font=f, fill=(0, 0, 0), anchor='mm', align='center', spacing=4)
    im.save(path)


def beat_dur(beat):
    if beat.get('dur'):
        return float(beat['dur'])
    n = len(beat.get('line', '').replace('\n', ''))
    return round(min(8.0, max(3.5, 2.0 + n * 0.11)), 1)


def shot_key(b):
    """구도 = 배경·흑백·컷인 여부·말하는/반응 고양이(표정 빼고). 표정만 바뀐 같은 구도는 같은 컷으로 센다."""
    who = lambda p: (p or '').split('.')[0].split('_')[0]
    return (b['bg'], bool(b.get('gray')), bool(b.get('cutin')), who(b.get('speaker')), who(b.get('react')))


def stats(beats):
    run, prev, longest, rep, rmax, pk = 0.0, None, 0.0, 0, 0, None
    for b in beats:
        run = run + beat_dur(b) if (b['bg'], bool(b.get('gray'))) == prev else beat_dur(b)
        prev = (b['bg'], bool(b.get('gray')))
        longest = max(longest, run)
        rep = rep + 1 if shot_key(b) == pk else 1
        pk = shot_key(b)
        rmax = max(rmax, rep)
    poses = {p for b in beats for p in (b.get('speaker'), b.get('react')) if p}
    return {'배경': len({b['bg'] for b in beats}), '포즈': len(poses), '인물': len({p.split('.')[0].split('_')[0] for p in poses}),
            '구도 반복 최대': rmax, '같은 배경 최장(초)': round(longest, 1), '화면': len(beats), '길이(초)': round(sum(map(beat_dur, beats)), 1)}


def check(beats, ep, max_run=15.0, max_rep=2):
    run, prev, rep, pk = 0.0, None, 0, None
    for i, b in enumerate(beats):
        run = run + beat_dur(b) if (b['bg'], bool(b.get('gray'))) == prev else beat_dur(b)
        prev = (b['bg'], bool(b.get('gray')))
        if 'speaker' in b and run > max_run:
            print(f'배경 반복 관문: 화면 {i} 까지 «{b["bg"]}» 연속 {run:.0f}초 > {max_run:.0f}초(소유주 10-26 C) — 종료 4')
            raise SystemExit(4)
        rep = rep + 1 if shot_key(b) == pk else 1
        pk = shot_key(b)
        if 'speaker' in b and rep > max_rep:
            print(f'구도 반복 관문: 화면 {i} 까지 같은 구도 {rep}컷 연속 > {max_rep}(관리자 10-27, 동네 업종 3판 지적) — 종료 4')
            raise SystemExit(4)
    miss = sorted({p for b in beats for p in (b.get('speaker'), b.get('react')) if p and not pose_src(ep, p).exists()})
    if miss:
        print(f'표정 그림 없음: {miss} — 종료 4')
        raise SystemExit(4)
    bad = [i for i, b in enumerate(beats) if b.get('real') and '재연' not in ''.join(c.get('tag', '') for c in b.get('cats', []))]
    if bad:
        print(f'재연 표시 관문: 실존 인물 대사에 «재연» 없는 화면 {bad} — 종료 4')
        raise SystemExit(4)


def render_beat(ep, i, beat, d, work):
    seg = work / f'b{i:03d}.mp4'
    key = json.dumps([beat, d, CODE, str(sorted(p.stat().st_mtime for p in (ep / 'pose').glob('*.png')) if (ep / 'pose').exists() else '')], ensure_ascii=False, sort_keys=True)
    if seg.exists() and (work / f'b{i:03d}.key').exists() and (work / f'b{i:03d}.key').read_text(encoding='utf-8') == key:
        return seg
    txt = work / f'b{i:03d}_text.png'
    beat = layout(ep, beat)
    text_layer(beat, txt)
    n = int(d * FPS)
    z0, z1 = (1.0, 1.06) if i % 2 == 0 else (1.06, 1.0)
    gray = ',hue=s=0' if beat.get('gray') else ''
    inputs = ['-loop', '1', '-i', ep / 'img' / f'{beat["bg"]}.png']
    flt = [f'[0]scale=3840:-2,zoompan=z=\'{z0}+({z1}-{z0})*on/{n}\':x=\'(iw-iw/zoom)/2\':y=\'(ih-ih/zoom)/2\':d={n}:s={W}x{H}:fps={FPS}{gray},format=rgba[v0]']
    last = 'v0'
    for j, c in enumerate(beat.get('cats', [])):
        src = Path(c['src']) if c.get('src') else ep / 'cast' / f'{c["pose"]}.png'
        cat = keyed(src, work / f'cat_{src.parent.name}_{src.stem}.png')
        h = int(c.get('h', 0.74) * H)
        inputs += ['-loop', '1', '-i', cat]
        k = j + 1
        flip = ',hflip' if c.get('flip') else ''
        x = int(c.get('x', 0.25) * W)
        bob = c.get('bob', 10)
        flt.append(f'[{k}]scale=-1:{h}{flip}[c{j}]')
        rise = '+if(lt(t,0.25),(1-t/0.25)*h,0)' if c.get('enter') else ''   # 등장: 아래에서 튀어나옴(결 분석서 §1-2)
        flt.append(f'[{last}][c{j}]overlay=x=\'{x}-w/2\':y=\'{c.get('bottom', H - 40)}-h+{bob}*sin(2*PI*t*1.6+{j}){rise}\':shortest=1[v{j + 1}]')
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
    if subprocess.run([sys.executable, '-X', 'utf8', 'D:/midform/scripts/gyeol_gate.py', str(ep)]).returncode:   # 공용 결 표 관문
        sys.exit(4)
    spec = json.loads((ep / 'beats.json').read_text(encoding='utf-8'))
    beats = spec['beats']
    check(beats, ep)
    (ep / 'out').mkdir(exist_ok=True)
    (ep / 'out' / 'stats.json').write_text(json.dumps(stats(beats), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if '--check' in sys.argv:
        print(json.dumps(stats(beats), ensure_ascii=False))
        return
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
    ins, mix, t = ['-stream_loop', '-1', '-i', ROOT / spec['bgm']], ['[0]volume=0.4,atrim=0:%.2f[bg]' % total], 0.0
    labels = ['[bg]']
    for i, (b, d) in enumerate(zip(beats, durs)):
        s = b.get('sfx', 'pop')
        if s and s in SFX:
            ins += ['-i', SFX[s]]
            k = len(labels)
            mix.append(f'[{k}]adelay={int(t * 1000)}|{int(t * 1000)},volume=0.45[s{k}]')
            labels.append(f'[s{k}]')
        t += d
    mix.append(''.join(labels) + f'amix=inputs={len(labels)}:normalize=0:duration=first[a]')
    audio = work / 'audio.wav'
    ff(*ins, '-filter_complex', ';'.join(mix), '-map', '[a]', '-t', f'{total:.2f}', '-ar', 48000, audio)
    final = out / ('test.mp4' if '--only' in sys.argv else 'episode.mp4')
    ff('-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', final)
    sys.path.insert(0, str(ROOT / 'scripts'))
    import loudnorm_final
    print('음량', loudnorm_final.normalize(final))
    (out / 'timing.json').write_text(json.dumps([{'i': i, 'start': round(sum(durs[:i]), 2), 'dur': d} for i, d in enumerate(durs)], indent=2) + '\n', encoding='utf-8')
    print(f'{final} · 화면 {len(beats)}개 · {total:.1f}초 · 평균 {total / len(beats):.1f}초/화면')


if __name__ == '__main__':
    main()
