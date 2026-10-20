"""팬튜브 B 틀 — 커뮤니티 글 + 베스트 댓글 (10/19 소유주 «추천대로»).
    python fantube/tpl_b.py <spec.json>            → spec 의 out (기본 <spec 폴더>/out.mp4)

화면(1080x1920): 위 흰 판(작은 «HOT · 그룹» + 굵은 제목 두 줄 + 출처 한 줄) · 가운데 영상(1080x1150) ·
영상 아래쪽 우리 자막 · 맨 아래 베스트 댓글 카드(원본에 실제로 달린 댓글만, 좋아요 수 그대로, 아이디 없음).
spec:
  sources: {"A": {"path": ".../h8_2930.mp4", "base": 1770}}   base = 그 파일 0초의 원본 시각
  segs:    [{"src": "A", "a": 1807.7, "b": 1810.1, "cw": 860, "x": 520, "y": 20}]  a·b 원본 시각, 창 cw x (cw/0.939) — 방송 자막·로고 밖으로
  top:     {"tag": "HOT · 엔믹스", "l1": "...", "l2": "...", "credit": "영상: ..."}
  caps:    [{"t0": 0, "t1": 2.4, "text": "...", "style": "say|pop|en"}]    출력 시각 (en = 영어 한 줄, 한국어 자막 아래)
  comments:[{"t0": 0, "t1": 7.4, "likes": 870, "text": "..."}]          출력 시각, 줄바꿈은 \\n
"""
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
VY, VH = 320, 1150                       # 영상 칸
FONT = 'D:/midform/politics-hour/assets/fonts/'
BOLD, BODY = FONT + 'Paperlogy-8ExtraBold.ttf', FONT + 'ROKAFSansMedium.ttf'
FULL = 'C:/Windows/Fonts/malgunbd.ttf'   # 완성형 11,172자 전부 — 남의 댓글(«왤케»·«이넼» 등 Paperlogy·어그로체에 없는 글자)은 이걸로
BG, PINK = (245, 246, 248), (255, 90, 120)
FPS = 30


def f(p, s):
    return ImageFont.truetype(p, s)


def check(text, path):
    """글꼴에 없는 글자가 빈칸으로 찍히는 걸 막는다(ep17 «왤» 사고)."""
    ft = f(path, 40)
    miss = sorted({c for c in text if not c.isspace() and ft.getmask(c).getbbox() is None})
    if miss:
        raise SystemExit(f'글꼴 {Path(path).name} 에 없는 글자 {miss}: «{text}»')


def base_png(top, out):
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, VY - 20), fill='white')
    d.text((60, 52), top['tag'], font=f(BODY, 32), fill=PINK)
    if top.get('credit'):
        d.text((W - 60, 56), top['credit'], font=f(BODY, 26), fill=(150, 150, 150), anchor='ra')
    check(top['l1'] + top['l2'], BOLD)
    d.text((60, 112), top['l1'], font=f(BOLD, 60), fill='black')
    d.text((60, 196), top['l2'], font=f(BOLD, 60), fill='black')
    im.save(out)


def comment_png(c, out):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lines = c['text'].split('\n')
    y0 = VY + VH + 30
    h = 100 + 58 * len(lines)
    d.rounded_rectangle((40, y0, W - 40, y0 + h), 26, fill='white')
    d.text((80, y0 + 28), f"BEST  ♥ {c['likes']:,}", font=f(BODY, 30), fill=PINK)
    for i, ln in enumerate(lines):
        check(ln, FULL)
        if d.textlength(ln, font=f(FULL, 40)) > W - 160:          # 카드 밖으로 넘치면 멈춘다(ep19 «ㅋㅋㅋ» 넘침)
            raise SystemExit(f'댓글 줄이 카드보다 길다 — \n 으로 나눠라: «{ln}»')
        d.text((80, y0 + 82 + 58 * i), ln, font=f(FULL, 40), fill='black')
    im.save(out)


def cap_png(c, out):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    check(c['text'], BOLD)
    if c.get('style') == 'tts':                      # 해설 한 줄 — 영상 위쪽 검은 말풍선
        ft = f(BOLD, 52)
        lines = c['text'].split('\n')
        tw = max(d.textlength(ln, font=ft) for ln in lines)
        d.rounded_rectangle((W / 2 - tw / 2 - 34, VY + 50, W / 2 + tw / 2 + 34, VY + 50 + 40 + 66 * len(lines)), 24, fill=(20, 20, 20, 235))
        for i, ln in enumerate(lines):
            d.text((W // 2, VY + 50 + 20 + 33 + 66 * i), ln, font=ft, fill=(255, 225, 60), anchor='mm')
        im.save(out)
        return
    if c.get('style') == 'en':                       # 영어 자막 한 줄(G22 ⑥ 교육적 가치) — 한국어 자막 아래 작게
        d.text((W // 2, VY + VH - 34), c['text'], font=f(BOLD, 44), fill=(210, 230, 255), stroke_width=6, stroke_fill='black', anchor='mm')
        im.save(out)
        return
    size, col = (74, (255, 225, 60)) if c.get('style') == 'pop' else (62, 'white')
    y = VY + VH - 110
    for i, ln in enumerate(c['text'].split('\n')[::-1]):
        d.text((W // 2, y - i * (size + 14)), ln, font=f(BOLD, size), fill=col, stroke_width=8, stroke_fill='black', anchor='mm')
    im.save(out)


def main(spec_path):
    sp = Path(spec_path)
    s = json.loads(sp.read_text(encoding='utf-8'))
    work = sp.parent / '_tplb'
    work.mkdir(exist_ok=True)
    out = Path(s.get('out') or sp.parent / 'out.mp4')
    base_png(s['top'], work / 'base.png')
    srcs = list(s['sources'])
    args = ['ffmpeg', '-v', 'error', '-y']
    for k in srcs:
        args += ['-i', s['sources'][k]['path']]
    args += ['-loop', '1', '-framerate', str(FPS), '-i', str(work / 'base.png')]
    over = []
    for i, c in enumerate(s['comments']):
        comment_png(c, work / f'c{i}.png')
        over.append((work / f'c{i}.png', c['t0'], c['t1']))
    for i, c in enumerate(s['caps']):
        cap_png(c, work / f'k{i}.png')
        over.append((work / f'k{i}.png', c['t0'], c['t1']))
    voices = []                                      # 중간 TTS 한 줄(PDF 규칙 7) — 정치 롱폼 Supertonic F2 를 그대로 import
    if s.get('voice'):
        sys.path.insert(0, 'D:/midform/politics-hour/overlay')
        import tts
        for i, v in enumerate(s['voice']):
            wav = work / f'tts{i}.wav'
            tts.supertonic(v['text'], wav)
            dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(wav)],
                                       capture_output=True, text=True).stdout)
            voices.append((wav, v['t0'], v['t0'] + dur))
            c = {'text': v.get('show', v['text']), 'style': 'tts'}
            cap_png(c, work / f'kt{i}.png')
            over.append((work / f'kt{i}.png', v['t0'], v['t0'] + dur))
    for p, _, _ in over:
        args += ['-loop', '1', '-framerate', str(FPS), '-i', str(p)]
    for wav, _, _ in voices:
        args += ['-i', str(wav)]

    fc, vs, as_ = [], [], []
    for i, g in enumerate(s['segs']):
        src = s['sources'][g['src']]
        ii = srcs.index(g['src'])
        a, b = g['a'] - src['base'], g['b'] - src['base']
        cw = g['cw'] // 2 * 2
        ch = round(cw * VH / W) // 2 * 2
        fc.append(f"[{ii}:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS,fps={FPS},crop={cw}:{ch}:{g['x']}:{g['y']},scale={W}:{VH},setsar=1[v{i}]")
        d = b - a
        fc.append(f"[{ii}:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.03,afade=t=out:st={d - 0.04:.3f}:d=0.04[a{i}]")
        vs.append(f'[v{i}]')
        as_.append(f'[a{i}]')
    n = len(s['segs'])
    total = sum(g['b'] - g['a'] for g in s['segs'])
    fc.append(''.join(v + a for v, a in zip(vs, as_)) + f'concat=n={n}:v=1:a=1[vc][ac0]')
    bi = len(srcs)
    if voices:                                       # 해설 동안 원음 25%로 낮추고 섞는다
        duck = '+'.join(f'between(t,{a:.2f},{b:.2f})' for _, a, b in voices)
        fc.append(f"[ac0]volume='if({duck},0.25,1)':eval=frame[ad]")
        vi = bi + 1 + len(over)
        for k, (_, a, _) in enumerate(voices):
            fc.append(f"[{vi + k}:a]aresample=48000,volume=1.6,adelay={int(a * 1000)}:all=1[vv{k}]")
        fc.append('[ad]' + ''.join(f'[vv{k}]' for k in range(len(voices))) + f'amix=inputs={1 + len(voices)}:normalize=0:duration=first[am]')
        fc.append(f"[am]afade=t=out:st={total - 0.4:.3f}:d=0.4[ac]")
    else:
        fc.append(f"[ac0]afade=t=out:st={total - 0.4:.3f}:d=0.4[ac]")
    fc.append(f'[{bi}:v][vc]overlay=0:{VY}:shortest=1[o0]')
    for j, (_, t0, t1) in enumerate(over):
        fc.append(f"[o{j}][{bi + 1 + j}:v]overlay=0:0:enable='between(t,{t0},{t1})':shortest=1[o{j + 1}]")
    args += ['-filter_complex', ';'.join(fc), '-map', f'[o{len(over)}]', '-map', '[ac]', '-t', f'{total:.3f}',
             '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
             '-movflags', '+faststart', str(out)]
    subprocess.run(args, check=True)
    sys.path.insert(0, 'D:/midform/scripts')       # -14 LUFS 2패스(도구개발 공용, 10/19) — 영상은 복사, 이미 맞으면 그대로
    import loudnorm_final
    loudnorm_final.normalize(str(out))
    print(f'{out} · {total:.1f}초 · 컷 {n}개')


if __name__ == '__main__':
    main(sys.argv[1])
