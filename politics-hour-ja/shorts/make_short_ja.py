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
    for b in sh['beats']:   # 주고받기 구조(소유주 10-20): role → 칸 종류. 반응 컷은 장내 소리 그대로, 그 위 해설은 line 한 줄 자막만
        if b.get('role') and not b.get('t'):
            b['t'] = {'attack': 'raw', 'reaction': 'raw', 'counter': 'raw', 'question': 'close', 'narration': 'nar'}[b['role']]
        if b.get('role') == 'reaction':
            b['text'] = b.get('line', '')
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
            chunks = R.ja_chunks(b['text'], 12) if b.get('text') else []   # 해설 없는 반응 컷은 자막 없음
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
    if (sh.get('layout') or plan.get('layout')) == 'close':   # 2편부터(소유주 10-20 «인물만 확대·대비, 뉴스 잘라 온 지저분한 틀 금지»)
        return render_close(sh, parts, caps, total, work, out)
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


# 3단 클로즈업(발굴 카드 docs/category-cards/2026-10-20-politics-shorts-style-baroboja.md): 위 27% 두 줄 화면 제목 · 가운데 45% 얼굴 확대 · 아래 28% 비움
BAND_Y, BAND_H = 518, 864            # 1920 의 27%~72%
T_LINES = (300, 440)                 # 화면 제목 두 줄(높이 12~26%, 글자 높이 ≈ 6%)
SUB_Y = 1250                         # 말 자막 한 줄(높이 약 65%, 영상 띠 아래쪽)
TAG_SEC = 3.0                        # 첫 3초 이름 꼬리표


def close_crop(src, a, dur, cut=.17, ow=W, oh=BAND_H, face=.28):
    """인물 상자(ko person_side) → crop 식. 얼굴 폭 = 출력 폭의 face 비율(단독 .28·분할 반쪽은 .40 ≈ 화면 폭 20%),
    눈높이 = 띠 위 1/5, 방송 자막 띠(아래 cut 비율)는 안 들어오게."""
    x0, y0, x1, y1 = R.person_side(ROOT / src, a, a + dur)['person']
    fw = (x1 - x0) * .38                                # 원본 폭 비율의 얼굴 폭(어깨 위 상자 기준 근사)
    cw = min(.9, max(.12, fw / (face * W / ow)))       # 출력에서 얼굴이 face 비율이 되도록
    ch = cw * (16 / 9) * (oh / ow)
    if ch > 1 - cut:
        ch = 1 - cut; cw = ch / ((16 / 9) * (oh / ow))
    eye = y0 + fw * (16 / 9) * .6
    top = min(max(0.0, eye - ch * .22), max(0.0, 1 - cut - ch))
    left = min(max(0.0, (x0 + x1) / 2 - cw / 2), 1 - cw)
    return f'crop=iw*{cw:.4f}:ih*{ch:.4f}:iw*{left:.4f}:ih*{top:.4f}'


def render_close(sh, parts, caps, total, work, out):
    """요소 3 + 끝 마크(관리자 10-20 소유주 «채널색 안 묻혀도 돼? 모션 너무 걷어낸 것 아니야?»):
    화면 제목 두 줄(윗줄 남색 상자·흰 글씨, 아랫줄 금색 · 0.3초 떠오름) · 말 자막 한 줄(팝) · 첫 3초 이름 꼬리표(남색·금 띠),
    끝 질문 옆 작은 채널 마크 0.8초(sh 의 mark 경로, null 이면 생략 — 새 채널에도 쓰도록). 띠·배너·출처 줄 없음.
    칸에 split {left:{src,start}, right:{src,start}} 가 있으면 좌우 분할(질문 왼쪽·답변 오른쪽). 5초 넘는 단독 칸은 가운데서 한 번 당겨 잡는다(컷 줌)."""
    hook = next((p for p in parts if p['t'] == 'hook'), None)
    lines = (sh.get('screen_lines') or (hook or {}).get('screen', sh['title']).split('\n'))[:2]

    def title_draw(d):
        f = font('NotoSansJP.ttf', 116)
        for k, (y, ln) in enumerate(zip(T_LINES, lines)):
            tw = d.textlength(ln, font=f)
            ff_ = f if tw <= W - 120 else font('NotoSansJP.ttf', int(116 * (W - 120) / tw))
            tw = d.textlength(ln, font=ff_)
            if k == 0:   # 윗줄 = 채널색 상자(1편 남색·금 테)
                d.rounded_rectangle([W / 2 - tw / 2 - 36, y - 78, W / 2 + tw / 2 + 36, y + 78], 16, fill=(*NAVY, 235), outline=GOLD, width=4)
                d.text((W / 2, y), ln, font=ff_, fill=PAPER, anchor='mm')
            else:
                d.text((W / 2, y), ln, font=ff_, fill=GOLD, anchor='mm', stroke_width=8, stroke_fill=NAVY)
    title_png = png(work / 'title.png', title_draw)
    sp = sh['speaker']   # 첫 3초 꼬리표 = 첫 발언자 {name, role}

    def tag_draw(d):
        fn, fr = font('NotoSansJP.ttf', 44, 900), font('NotoSansJP.ttf', 34, 700)
        wn, wr = d.textlength(sp['name'], font=fn), d.textlength(sp['role'], font=fr)
        d.rectangle([40, BAND_Y + 30, 40 + 14 + 24 + wn + 22 + wr + 28, BAND_Y + 104], fill=(*NAVY, 240))
        d.rectangle([40, BAND_Y + 30, 54, BAND_Y + 104], fill=GOLD)
        d.text((78, BAND_Y + 67), sp['name'], font=fn, fill=PAPER, anchor='lm')
        d.text((78 + wn + 22, BAND_Y + 69), sp['role'], font=fr, fill=GOLD, anchor='lm')
    tag_png = png(work / 'tag.png', tag_draw)

    def sub_png(k, s, kind):   # 자막은 상자 크기 그림 — 팝(0.86→1, 0.12초)
        f = font('NotoSansJP.ttf', 56, 800)
        tw = int(ImageDraw.Draw(Image.new('RGBA', (1, 1))).textlength(s, font=f))
        im = Image.new('RGBA', (tw + 48, 92), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, tw + 47, 91], 12, fill=(0, 0, 0, 170))
        d.text(((tw + 48) / 2, 46), s, font=f, fill=GOLD if kind == 'raw' else (255, 255, 255), anchor='mm')
        p_ = work / f'cap_{k:03d}.png'; im.save(p_); return p_
    caps = caps[:-1] + [(caps[-1][0], total, *caps[-1][2:])] if caps else caps   # 끝 질문 자막은 마지막 프레임까지(그 옆에 마크)
    subs = [(a, e, sub_png(k, s, kind)) for k, (a, e, s, kind) in enumerate(caps)]
    mark = sh.get('mark', 'politics-hour-ja/assets/channel/logo.png')
    MARK_SEC, MS = .8, 120
    if mark:   # 둥근 채널 마크(금 테)
        lg = Image.open(ROOT / mark).convert('RGBA').resize((MS, MS), Image.LANCZOS)
        m = Image.new('L', (MS, MS), 0); ImageDraw.Draw(m).ellipse([0, 0, MS - 1, MS - 1], fill=255); lg.putalpha(m)
        ImageDraw.Draw(lg).ellipse([1, 1, MS - 2, MS - 2], outline=GOLD, width=5)
        mark_png = work / 'mark.png'; lg.save(mark_png)
    vids, vf, n, jumps = [], [], 0, 0
    br = sh['broll']; bt = br['start']
    for i, p in enumerate(parts):
        if p['t'] == 'raw':
            src, a, cut = p['src'], p['in'], p.get('crop_bottom', .17)
        else:
            if p.get('broll'):
                br, bt = p['broll'], p['broll']['start']
            src, a, cut = br['src'], bt, br.get('crop_bottom', .17); bt += p['dur']
        if p.get('split'):
            halves = []
            for side in ('left', 'right'):
                s_ = p['split'][side]
                vids += ['-ss', f"{s_['start']:.3f}", '-t', f"{p['dur']:.3f}", '-i', str(ROOT / s_['src'])]
                vf.append(f'[{n}:v]fps=30,{close_crop(s_["src"], s_["start"], p["dur"], s_.get("crop_bottom", .17), W // 2, BAND_H, .40)},'
                          f'scale={W // 2}:{BAND_H}:flags=lanczos,setsar=1,trim=duration={p["dur"]:.3f},setpts=PTS-STARTPTS[h{n}]')
                halves.append(f'[h{n}]'); n += 1
            vf.append(''.join(halves) + f'hstack=inputs=2,eq=contrast=1.05,setsar=1[c{i}]')
        else:
            jump = p['dur'] >= 5.0   # 긴 칸은 가운데서 1.12배로 당겨 잡아 컷 하나를 더 만든다
            jumps += jump
            z = f"(1+0.03*t/{p['dur']:.3f})" + (f"*if(gte(t,{p['dur'] / 2:.3f}),1.12,1)" if jump else '')
            vids += ['-ss', f'{a:.3f}', '-t', f"{p['dur']:.3f}", '-i', str(ROOT / src)]
            vf.append(f'[{n}:v]fps=30,{close_crop(src, a, p["dur"], cut)},scale={W}:{BAND_H}:flags=lanczos,'
                      f"scale=w='trunc({W}*{z}/2)*2':h='trunc({BAND_H}*{z}/2)*2':eval=frame,crop={W}:{BAND_H}:(iw-{W})/2:(ih-{BAND_H})*0.3,"
                      f'eq=contrast=1.05,setsar=1,trim=duration={p["dur"]:.3f},setpts=PTS-STARTPTS[c{i}]')
            n += 1
    vf.append(''.join(f'[c{i}]' for i in range(len(parts))) + f'concat=n={len(parts)}:v=1:a=0[mid]')
    vids += ['-f', 'lavfi', '-t', f'{total:.3f}', '-i', f'color=c=black:s={W}x{H}:r=30']
    base = n
    chain = [f'[{base}:v][mid]overlay=0:{BAND_Y}[v0]']
    k_in = base + 1
    # 제목: 0.3초 동안 40px 아래에서 떠오름
    vids += ['-loop', '1', '-t', f'{total:.3f}', '-i', str(title_png)]   # 첫 프레임부터 다 보인다(피드 첫 화면) — 움직임은 떠오름만
    chain += [f'[{k_in}:v]format=rgba[ti]', "[v0][ti]overlay=0:'40*max(0,1-t/0.3)'[v1]"]; k_in += 1
    # 이름 꼬리표: 첫 프레임부터, 0.3초 나감
    tag_end = min(TAG_SEC, total)
    vids += ['-loop', '1', '-t', f'{tag_end:.3f}', '-i', str(tag_png)]
    chain += [f'[{k_in}:v]format=rgba,fade=t=out:st={tag_end - .3:.3f}:d=0.3:alpha=1[tg]',
              '[v1][tg]overlay=0:0:eof_action=pass[v2]']; k_in += 1
    last = 'v2'
    for k, (a, e, img) in enumerate(subs):
        vids += ['-loop', '1', '-t', f'{e - a:.3f}', '-i', str(img)]
        chain += [f"[{k_in}:v]format=rgba,scale=w='trunc(iw*(0.86+0.14*min(1,t/0.12))/2)*2':h=-2:eval=frame,setpts=PTS+{a:.3f}/TB[s{k}]",
                  f"[{last}][s{k}]overlay=x='(W-w)/2':y='{SUB_Y}-h/2':eof_action=pass[k{k}]"]; last = f'k{k}'; k_in += 1
    if mark:   # 끝 질문 옆(아래 오른쪽) 마크, 마지막 0.8초 팝
        m0 = max(0.0, total - MARK_SEC)
        cw_ = Image.open(subs[-1][2]).width if subs else 0
        mx, my = W / 2 + cw_ / 2 + 24 + MS / 2, SUB_Y            # 끝 자막 상자 바로 오른쪽
        if mx + MS / 2 > W - 16:
            mx, my = W / 2 + cw_ / 2 - MS / 2, SUB_Y + 46 + 16 + MS / 2   # 자리가 없으면 상자 오른쪽 아래
        vids += ['-loop', '1', '-t', f'{MARK_SEC + .5:.3f}', '-i', str(mark_png)]   # 끝 프레임까지 남게 넉넉히(-t total 이 자른다)
        chain += [f"[{k_in}:v]format=rgba,scale=w='trunc(iw*(0.7+0.3*min(1,t/0.15))/2)*2':h=-2:eval=frame,setpts=PTS+{m0:.3f}/TB[mk]",
                  f"[{last}][mk]overlay=x='{mx:.0f}-w/2':y='{my:.0f}-h/2':eof_action=pass[km]"]; last = 'km'; k_in += 1
    chain.append(f'[{last}]format=yuv420p[v]')
    alist = work / 'audio.txt'
    alist.write_text(''.join(f"file '{p['wav'].as_posix()}'\n" for p in parts), encoding='utf-8')
    aud = work / 'audio.wav'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(alist), '-ar', '48000', '-ac', '2', str(aud)], check=True)
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as fc:
        fc.write(';\n'.join(vf + chain))
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *vids, '-i', str(aud), '-/filter_complex', fc.name,
                    '-map', '[v]', '-map', f'{k_in}:a', '-t', f'{total:.3f}', '-r', '30',
                    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', str(out)], check=True)
    Path(fc.name).unlink(missing_ok=True)   # C: Temp 에 필터 파일을 남기지 않는다
    loud = loudnorm_final.normalize(str(out))
    raw_s = sum(p['dur'] for p in parts if p['t'] == 'raw')
    cuts = sum(2 if p.get('split') else 1 for p in parts) - 1 + jumps
    print(json.dumps({'out': str(out), 'layout': 'close', 'seconds': total, 'raw_seconds': round(raw_s, 2), 'narration_share': round(1 - raw_s / total, 3),
                      'overlays': ['화면 제목(0.3초 떠오름)', '말 자막(팝)', f'이름 꼬리표(0~{TAG_SEC:.0f}초)'] + ([f'끝 채널 마크({MARK_SEC}초)'] if mark else []),
                      'cuts': cuts, 'cuts_per_56s': round(cuts * 56 / total, 1), 'loudnorm': loud}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None)
