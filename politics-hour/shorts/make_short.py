"""롱폼 인용 구간 → 세로 쇼츠(1080x1920). 위 = 후킹 두 줄, 가운데 = 원본 16:9, 아래 = 받아쓰기 자막, 출처는 항상 표기.
    python make_short.py <에피소드 폴더> <shorts.json>   (shorts.json = [{name, src, in, out, hook1, hook2, speaker, role, color, source, end?}])
자막은 Speechmatics 낱말 시각(transcripts/<id>.json)을 쓰고, 글자는 인용 원문(issues 의 text, 오인식 고친 것)과 개수가 맞으면 그걸로 바꾼다."""
import json, re, shutil, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT = 'D:/midform/politics-hour/assets/fonts/Paperlogy-8ExtraBold.ttf'
W, H, VY, VH = 1080, 1920, 600, 608           # 영상 자리
f = lambda n: ImageFont.truetype(FONT, n)


def wrap(d, text, font, maxw):
    lines, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=font) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur); cur = w
    return lines + [cur] if cur else lines


def card(sp, out):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    y = 150
    for i, (txt, col, size) in enumerate(((sp['hook1'], (255, 255, 255), 78), (sp['hook2'], (255, 214, 0), 92))):
        for ln in wrap(d, txt, f(size), W - 100):
            d.text((W / 2, y), ln, font=f(size), fill=col, anchor='mt', stroke_width=3, stroke_fill=(0, 0, 0)); y += size + 22
        y += 10
    c = tuple(int(sp['color'].lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
    name = f"{sp['speaker']} · {sp['role']}"
    tw = d.textlength(name, font=f(40))
    d.rectangle([40, VY + VH + 20, 40 + tw + 36, VY + VH + 84], fill=c)
    d.text((58, VY + VH + 52), name, font=f(40), fill=(255, 255, 255), anchor='lm')
    d.text((W - 30, VY - 24), sp['source'], font=f(28), fill=(220, 220, 220), anchor='rm')
    d.text((W / 2, H - 120), '쟁점 브리핑', font=f(44), fill=(255, 214, 0), anchor='mm')
    im.save(out)


def end_card(text, out):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    lines = [ln for part in text.split(chr(10)) for ln in wrap(d, part, f(60), W - 140)]; y0 = VY + VH // 2 - len(lines) * 40
    d.rectangle([40, y0 - 30, W - 40, y0 + len(lines) * 80 + 10], fill=(8, 12, 24, 230))
    for i, ln in enumerate(lines):
        d.text((W / 2, y0 + i * 80), ln, font=f(60), fill=(255, 214, 0) if i == 0 else (255, 255, 255), anchor='mt')
    im.save(out)


def chunks(ep, sp):
    vid = Path(sp['src']).stem
    words = [list(w) for w in json.loads((ep / 'transcripts' / f'{vid}.json').read_text(encoding='utf-8')) if w[0] >= sp['in'] - .05 and w[1] <= sp['out'] + .05]
    words = [w for w in words if not any(a <= w[0] < b for a, b in sp.get('mute', []))]   # 말이 뒤엉킨 구간은 자막을 비운다
    good = re.sub(r'\([^)]*\)', ' ', sp.get('text', '')).split()
    if len(good) == len(words):
        words = [[a, b, g] for (a, b, _), g in zip(words, good)]
    out, cur = [], []
    for w in words:
        if cur and (len(''.join(x[2] for x in cur + [w])) > 13 or w[0] - cur[-1][1] > .6):
            out.append(cur); cur = []
        cur.append(w)
    if cur: out.append(cur)
    for c in out:   # 오인식 고치기(spec 의 fix: {틀린: 맞는})
        for w in c:
            w[2] = sp.get('fix', {}).get(w[2], w[2])
    return [(c[0][0] - sp['in'], (c[-1][1] if i == len(out) - 1 else out[i + 1][0][0]) - sp['in'], ' '.join(x[2] for x in c)) for i, c in enumerate(out)]


def ass(chs, out):
    t = lambda s: f'{int(s // 3600)}:{int(s // 60 % 60):02d}:{s % 60:05.2f}'
    head = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n'
            'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n'
            'Style: C,Paperlogy 8 ExtraBold,84,&H00FFFFFF,&H00000000,&H80000000,0,1,6,0,8,40,40,1340\n\n[Events]\n'
            'Format: Layer, Start, End, Style, Text\n')
    Path(out).write_text(head + ''.join(f'Dialogue: 0,{t(max(0, a))},{t(b)},C,{x}\n' for a, b, x in chs), encoding='utf-8')


def main():
    ep = Path(sys.argv[1]).resolve(); specs = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    od = HERE / ep.name; od.mkdir(exist_ok=True)
    shutil.copy(FONT, od / Path(FONT).name)   # libass 가 글꼴을 찾도록(드라이브 경로 콜론 이스케이프를 피한다)
    for sp in specs:
        n = sp['name']; d = sp['out'] - sp['in']
        card(sp, od / f'{n}_card.png'); ass(chunks(ep, sp), od / f'{n}.ass')
        inputs = ['-ss', str(sp['in']), '-t', f'{d:.2f}', '-i', str(ep / sp['src']), '-i', str(od / f'{n}_card.png')]
        fc = (f'color=c=black:s={W}x{H}:d={d:.2f}[bg];[0:v]scale={W}:{VH},setsar=1[v];[bg][v]overlay=0:{VY}[a];[a][1:v]overlay=0:0[b];'
              f"[b]subtitles={n}.ass:fontsdir=.[c]")
        last = 'c'
        if sp.get('end'):
            end_card(sp['end'], od / f'{n}_end.png'); inputs += ['-i', str(od / f'{n}_end.png')]
            fc += f";[c][2:v]overlay=0:0:enable='gte(t,{d - 4:.2f})'[e]"; last = 'e'
        cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', fc, '-map', f'[{last}]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'medium',
               '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-af', 'loudnorm=I=-14:TP=-1.5', '-movflags', '+faststart', f'{n}.mp4']
        subprocess.run(cmd, cwd=od, check=True)
        print(od / f'{n}.mp4', f'{d:.1f}s')


main()
