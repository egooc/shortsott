# -*- coding: utf-8 -*-
"""정치JA 쇼츠 — 롱폼 1편에서 떼어 낸 세로 쇼츠(1080x1920). 해설 ≥85%·원음 ≤15초(소유주 10-16), 첫 3초 «なぜ»(10-19),
첫 프레임 = 질문 낱말 화면(썸네일), 끝 = 롱폼 안내(관리자 10-19).

    python politics-hour-ja/shorts/make_short_ja.py <plan.json> <쇼츠 id> [--out out.mp4]

plan.json: episodes/<날짜>/shorts/plan.json — beats[]: hook·nar·close(해설 TTS) / raw(원음 src·in·out·text·tag).
     쇼츠마다 broll: {src, start} — 해설 칸 뒤 화면(소리 끔), speaker: {name, role}.
TTS 는 ja_render.speak(Supertonic F2·숫자 히라가나·YOMI)를 그대로 쓴다. 끝에 scripts/loudnorm_final 로 -14 LUFS.
"""
import json, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE.parent / 'render')); import ja_render as R
sys.path.insert(0, str(ROOT / 'scripts')); import loudnorm_final
F = HERE.parent / 'assets' / 'fonts'
W, H = 1080, 1920
VY, VH = 640, 608                        # 16:9 영상 자리
NAVY, NAVY2, GOLD, ACC, PAPER = (14, 23, 38), (30, 48, 78), (255, 206, 60), (226, 83, 58), (244, 241, 234)
R.YOMI.update({'指す': 'さす', '常任理事国': 'じょうにんりじこく', '批准': 'ひじゅん',
               '国連憲章': 'こくれんけんしょう', '連合国': 'れんごうこく'})


def font(name, size, weight=900):
    f = ImageFont.truetype(str(F / name), size)
    f.set_variation_by_axes([weight])
    return f


def wrap(d, s, f, maxw):
    out, cur = [], ''
    for ch in s:
        if cur and d.textlength(cur + ch, font=f) > maxw and ch not in '、。？」”':
            out.append(cur); cur = ch
        else:
            cur += ch
    return out + ([cur] if cur else [])


def png(path, draw):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); draw(ImageDraw.Draw(im)); im.save(path); return path


def background(path):
    im = Image.new('RGB', (W, H)); d = ImageDraw.Draw(im)
    for y in range(H):
        k = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(NAVY[i] + (NAVY2[i] - NAVY[i]) * k) for i in range(3)))
    im.save(path); return path


def main(plan_path, sid, out=None):
    plan = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    sh = next(s for s in plan['shorts'] if s['id'] == sid)
    work = Path(plan_path).resolve().parent / sid; work.mkdir(exist_ok=True)
    out = Path(out or work / f'{sid}.mp4')
    # 1) 칸마다 소리와 길이
    t, parts, caps = 0.0, [], []
    for i, b in enumerate(sh['beats']):
        if b['t'] == 'raw':
            d = round(b['out'] - b['in'], 3)
            wav = work / f'{i:02d}_raw.wav'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f"{b['in']:.3f}", '-t', f'{d:.3f}', '-i', str(ROOT / b['src']),
                            '-vn', '-ac', '2', '-ar', '48000', '-af', 'afade=t=in:d=0.06,afade=t=out:st=%.3f:d=0.2' % max(0, d - .2), str(wav)], check=True)
            chunks = R.ja_chunks(b['text'], 12)
            w = [len(c) for c in chunks]; acc = 0
            for c, n in zip(chunks, w):
                caps.append((t + d * acc / sum(w), t + d * (acc + n) / sum(w), c, 'raw')); acc += n
        else:
            tts = work / f'{i:02d}_tts.wav'
            cues = R.speak(b['nar'], tts)
            d = round(R.wav_seconds(tts) + .25, 3)
            wav = work / f'{i:02d}_nar.wav'   # 원음과 같은 48k 스테레오, 칸 길이(꼬리 0.25초 무음 포함)에 딱 맞춘다
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(tts), '-ar', '48000', '-ac', '2',
                            '-af', f'apad=whole_dur={d:.3f}', '-t', f'{d:.3f}', str(wav)], check=True)
            for a, e, c in cues:
                for k, sub in enumerate(R.ja_chunks(c, 14)):   # 세로 화면 한 줄 14자
                    n = len(R.ja_chunks(c, 14)); caps.append((t + a + (e - a) * k / n, t + a + (e - a) * (k + 1) / n, sub, b['t']))
        parts.append(dict(b, wav=wav, start=t, dur=d)); t += d
    total = round(t, 3)
    # 2) 그림 층
    bg = background(work / 'bg.png')
    hook = next(p for p in parts if p['t'] == 'hook')
    title_png = png(work / 'title.png', lambda d: [d.text((W / 2, y), ln, font=font('NotoSansJP.ttf', 84), fill=GOLD if k else PAPER,
                                                         anchor='mm', stroke_width=5, stroke_fill=NAVY)
                                                  for k, (y, ln) in enumerate(zip((300, 420), (sh.get('title_lines') or wrap(d, sh['title'], font('NotoSansJP.ttf', 84), W - 100))[:2]))]
                    + [d.text((W - 30, H - 30), sh.get('credit', ''), font=font('NotoSansJP.ttf', 22, 600), fill=(200, 200, 200), anchor='rs')])

    def hook_draw(d):   # 첫 프레임 = 질문 낱말(썸네일)
        d.rectangle([0, 0, W, H], fill=(10, 18, 32, 215))
        f = font('NotoSansJP.ttf', 140)
        lines = [ln for part in hook['screen'].split('\n') for ln in wrap(d, part, f, W - 80)]   # 줄바꿈 문자로 줄을 직접 끊는다
        y0 = H / 2 - (len(lines) - 1) * 95 - 120
        for k, ln in enumerate(lines):
            d.text((W / 2, y0 + k * 190), ln, font=f, fill=GOLD if '？' in ln or k == len(lines) - 1 else PAPER, anchor='mm', stroke_width=8, stroke_fill=NAVY)
        d.text((W / 2, y0 + len(lines) * 190 + 40), sh['title'], font=font('NotoSansJP.ttf', 60), fill=PAPER, anchor='mm', stroke_width=4, stroke_fill=NAVY)
    hook_png = png(work / 'hook.png', hook_draw)
    raw = next(p for p in parts if p['t'] == 'raw')

    def name_draw(d):
        f = font('NotoSansJP.ttf', 40, 800); s = f"{sh['speaker']['name']} {sh['speaker']['role']}"
        tw = d.textlength(s, font=f)
        d.rectangle([40, VY + VH - 70, 40 + tw + 40, VY + VH - 12], fill=ACC)
        d.text((60, VY + VH - 41), s, font=f, fill=(255, 255, 255), anchor='lm')
        d.text((W - 24, VY - 20), raw['tag'], font=font('NotoSansJP.ttf', 28, 800), fill=PAPER, anchor='rm')
    name_png = png(work / 'name.png', name_draw)

    def end_draw(d):
        d.rounded_rectangle([60, 1640, W - 60, 1780], 24, fill=GOLD)
        d.text((W / 2, 1710), '▶ 本編「今週の国会」は関連動画から', font=font('NotoSansJP.ttf', 46), fill=NAVY, anchor='mm')
    end_png = png(work / 'end.png', end_draw)
    cap_pngs = []
    for k, (a, e, s, kind) in enumerate(caps):
        def cd(d, s=s, kind=kind):
            f = font('NotoSansJP.ttf', 70)
            tw = d.textlength(s, font=f)
            d.rounded_rectangle([W / 2 - tw / 2 - 30, 1380, W / 2 + tw / 2 + 30, 1500], 18, fill=(8, 12, 22, 225))
            d.text((W / 2, 1440), s, font=f, fill=GOLD if kind == 'raw' else PAPER, anchor='mm')
        cap_pngs.append((a, e, png(work / f'cap_{k:03d}.png', cd)))
    # 3) 영상: 해설 칸은 broll(소리 끔), 원음 칸은 그 구간
    vids, vf, n = [], [], 0
    br = sh['broll']; bt = br['start']
    for p in parts:
        if p['t'] == 'raw':
            vids += ['-ss', f"{p['in']:.3f}", '-t', f"{p['dur']:.3f}", '-i', str(ROOT / p['src'])]
        else:
            if p.get('broll'):   # 칸마다 화면을 따로 고를 수 있다(관계없는 장면·다른 인물 피하기) — 그 뒤 칸은 거기서 이어진다
                br, bt = p['broll'], p['broll']['start']
            vids += ['-ss', f'{bt:.3f}', '-t', f"{p['dur']:.3f}", '-i', str(ROOT / br['src'])]; bt += p['dur']
        cut = (p.get('broll') or br).get('crop_bottom', 0) if p['t'] != 'raw' else 0   # 소재에 박힌 자막 띠 잘라 내기(비율)
        vf.append(f'[{n}:v]fps=30,' + (f'crop=iw:ih*{1 - cut:.3f}:0:0,' if cut else '') + f'scale={W}:{VH}:force_original_aspect_ratio=increase,crop={W}:{VH},setsar=1,trim=duration={p["dur"]:.3f},setpts=PTS-STARTPTS[c{n}]')
        n += 1
    vf.append(''.join(f'[c{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[mid]')
    imgs = [bg, title_png, name_png, end_png, hook_png] + [c[2] for c in cap_pngs]
    base = n
    for p_ in imgs:
        vids += ['-loop', '1', '-t', f'{total:.3f}', '-i', str(p_)]
    end_at = next(p for p in parts if p['t'] == 'close')['start']
    chain = [f'[{base}:v][mid]overlay=0:{VY}[v0]', f'[v0][{base + 1}:v]overlay=0:0:enable=\'gte(t,{hook["dur"]:.3f})\'[v1]',
             f"[v1][{base + 2}:v]overlay=0:0:enable='between(t,{raw['start']:.3f},{raw['start'] + raw['dur']:.3f})'[v2]",
             f"[v2][{base + 3}:v]overlay=0:0:enable='gte(t,{end_at:.3f})'[v3]"]
    chain.append(f"[v3][{base + 4}:v]overlay=0:0:enable='lt(t,{hook['dur']:.3f})'[v4]")
    last = 'v4'
    for k, (a, e, _) in enumerate(cap_pngs):
        chain.append(f"[{last}][{base + 5 + k}:v]overlay=0:0:enable='between(t,{a:.3f},{e:.3f})'[k{k}]"); last = f'k{k}'
    chain.append(f"[{last}]format=yuv420p[v]")
    alist = work / 'audio.txt'
    alist.write_text(''.join(f"file '{p['wav'].as_posix()}'\n" for p in parts), encoding='utf-8')
    aud = work / 'audio.wav'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(alist), '-ar', '48000', '-ac', '2', str(aud)], check=True)
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as fc:
        fc.write(';\n'.join(vf + chain))
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *vids, '-i', str(aud), '-/filter_complex', fc.name,
                    '-map', '[v]', '-map', f'{base + len(imgs)}:a', '-t', f'{total:.3f}', '-r', '30',
                    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', str(out)], check=True)
    loud = loudnorm_final.normalize(str(out))
    raw_s = sum(p['dur'] for p in parts if p['t'] == 'raw')
    print(json.dumps({'out': str(out), 'seconds': total, 'raw_seconds': round(raw_s, 2), 'narration_share': round(1 - raw_s / total, 3),
                      'hook_seconds': hook['dur'], 'loudnorm': loud}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None)
