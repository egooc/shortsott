# -*- coding: utf-8 -*-
"""戦国なぜ 쇼츠 로컬 조립 — 그림 슬롯 + Supertonic 음성 + 자막 → 1080x1920 mp4.

    python scripts/naze_render.py <원고.json> <작업 폴더> [--images <그림 폴더>] [--out final.mp4]

작업 폴더에는 naze_voice.py 가 만든 voice.wav·timing.json 이 있어야 한다.
그림은 <그림 폴더>/<슬롯번호>.(png|jpg|jpeg|webp) — 슬롯은 문장 두 개에 하나(문장 i → i//2+1, 볼케이노 뇌전구 groups 와 같은 번호).
그림이 없는 슬롯은 회색 자리표시로 그린다(그림 오기 전 미리보기용).

화면(10-16 쇼츠 안전 영역 규격 안): 위 제목 h1(흰)·h2(노랑) y 200~330 · AI 이미지 고지 · 그림 1080x1000(y 400~1400, 천천히 확대)
· 자막 한 덩어리(13자 이하) 중심 y 1330. 렌더 뒤 shorts_safe.py 로 자막 위치를 검사한다.
왜: 볼케이노 voice 단계는 Typecast(유료)가 필요하다 — 소유주 비용 결정 전이라 그림만 받고 조립은 로컬(관리자 10-16).
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent / 'assets' / 'fonts' / 'rinbox'
W, H, FPS = 1080, 1920, 30
PIC_Y, PIC_H = 400, 1000
CAP_Y, CAP_MAX = 1330, 13


def chunks(text, mx=CAP_MAX):
    t = text.replace('。', '')
    if len(t) <= mx:
        return [t.rstrip('、')]
    cuts = [i for i, c in enumerate(t) if c in '、']
    if cuts:
        k = min(cuts, key=lambda i: abs(i - len(t) / 2))
        return chunks(t[:k], mx) + chunks(t[k + 1:], mx)
    k = len(t) // 2
    for d in range(k):
        for c in (k + d, k - d):
            if 2 < c < len(t) - 2 and t[c - 1] in 'はがをにでともへのて':
                return chunks(t[:c], mx) + chunks(t[c:], mx)
    return chunks(t[:k], mx) + chunks(t[k:], mx)


def ass_time(t):
    t = max(0.0, t)
    return '%d:%02d:%05.2f' % (int(t // 3600), int(t % 3600 // 60), t % 60)


def build_ass(s, timing, total):
    head = ('[Script Info]\nScriptType: v4.00+\nWrapStyle: 2\nScaledBorderAndShadow: yes\nPlayResX: %d\nPlayResY: %d\n\n'
            '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, '
            'Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, '
            'MarginL, MarginR, MarginV, Encoding\n'
            'Style: H1,Noto Sans JP,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,0,5,0,0,0,1\n'
            'Style: H2,Noto Sans JP,88,&H0000D8F0,&H0000D8F0,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,0,5,0,0,0,1\n'
            'Style: NOTE,Noto Sans JP,30,&H00A0A0A0,&H00A0A0A0,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n'
            'Style: CAP,Noto Sans JP,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,7,0,5,0,0,0,1\n\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n') % (W, H)
    ev = []
    end = ass_time(total)
    ev.append('Dialogue: 0,0:00:00.00,%s,H1,,0,0,0,,{\\pos(540,215)}%s' % (end, s.get('h1', '')))
    ev.append('Dialogue: 0,0:00:00.00,%s,H2,,0,0,0,,{\\pos(540,322)}%s' % (end, s.get('h2', '')))
    ev.append('Dialogue: 0,0:00:00.00,%s,NOTE,,0,0,0,,{\\pos(540,1430)}※画像はAIで生成したイメージです' % end)
    for ln in timing['lines']:
        parts = chunks(ln['text'])
        dur = ln['end'] - ln['start']
        w = [max(1, len(p)) for p in parts]
        acc = 0
        for p, k in zip(parts, w):
            a = ln['start'] + dur * acc / sum(w)
            acc += k
            b = ln['start'] + dur * acc / sum(w)
            ev.append('Dialogue: 1,%s,%s,CAP,,0,0,0,,{\\pos(540,%d)}%s' % (ass_time(a), ass_time(b), CAP_Y, p))
    return head + '\n'.join(ev) + '\n'


def slot_image(images, n):
    if images:
        for ext in ('png', 'jpg', 'jpeg', 'webp'):
            p = Path(images) / ('%d.%s' % (n, ext))
            if p.exists():
                return p
    return None


def run(cmd):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode:
        sys.exit('ffmpeg 실패:\n' + r.stderr[-1500:])


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('script')
    ap.add_argument('workdir')
    ap.add_argument('--images')
    ap.add_argument('--out')
    a = ap.parse_args()
    s = json.loads(Path(a.script).read_text(encoding='utf-8'))
    wd = Path(a.workdir)
    timing = json.loads((wd / 'timing.json').read_text(encoding='utf-8'))
    total = timing['total'] + 0.6
    lines = timing['lines']
    nslot = max(1, (len(lines) - 1 + 1) // 2)
    # 슬롯 구간: 그 슬롯의 첫 문장 시작 ~ 다음 슬롯 첫 문장 시작
    starts = {}
    for ln in lines:
        k = min(ln['i'] // 2 + 1, nslot)
        starts.setdefault(k, ln['start'])
    seg_dir = wd / '_seg'
    seg_dir.mkdir(exist_ok=True)
    keys = sorted(starts)
    segs, missing = [], []
    for j, k in enumerate(keys):
        t0 = 0.0 if j == 0 else starts[k]
        t1 = starts[keys[j + 1]] if j + 1 < len(keys) else total
        dur = max(0.5, t1 - t0)
        frames = int(round(dur * FPS))
        img = slot_image(a.images, k)
        out = seg_dir / ('%02d.mp4' % k)
        if img:
            src = ['-loop', '1', '-i', img]
            vf = ('scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,'
                  "zoompan=z='min(1+0.0008*on,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=%d:s=%dx%d:fps=%d"
                  % (W * 2, PIC_H * 2, W * 2, PIC_H * 2, frames, W, PIC_H, FPS))
        else:
            missing.append(k)
            src = ['-f', 'lavfi', '-i', 'color=c=0x3a3a3a:s=%dx%d:r=%d' % (W, PIC_H, FPS)]
            ff = (FONTS / 'NotoSansJP-Bold.otf').as_posix().replace(':', '\\:')
            vf = "drawtext=fontfile='%s':text='slot %d':fontcolor=white:fontsize=80:x=(w-tw)/2:y=(h-th)/2" % (ff, k)
        run(['ffmpeg', '-loglevel', 'error', '-y', *src, '-t', '%.3f' % dur, '-vf', vf, '-frames:v', frames,
             '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out])
        segs.append(out)
    lst = seg_dir / 'list.txt'
    lst.write_text(''.join("file '%s'\n" % p.as_posix() for p in segs), encoding='utf-8')
    ass = wd / 'cap.ass'
    ass.write_text(build_ass(s, timing, total), encoding='utf-8')
    out = Path(a.out) if a.out else wd / 'final.mp4'
    fdir = FONTS.as_posix().replace(':', '\\:')
    assp = ass.as_posix().replace(':', '\\:')
    vf = ("[0:v]pad=%d:%d:0:%d:color=0x101010,ass='%s':fontsdir='%s'[v]" % (W, H, PIC_Y, assp, fdir))
    run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-i', wd / 'voice.wav',
         '-filter_complex', vf, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-t', '%.3f' % total, out])
    r = subprocess.run([sys.executable, HERE / 'shorts_safe.py', ass, '--video', out, '--json'], capture_output=True,
                       text=True, encoding='utf-8', errors='replace', env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    safe = json.loads(r.stdout) if r.stdout.strip().startswith('{') else {'ok': None}
    print('완성 %s · %.1f초 · 슬롯 %d개(그림 없음 %s) · 안전 영역 %s'
          % (out, total, len(keys), missing or '없음', 'PASS' if safe.get('ok') else 'FAIL — qc/shorts_safe.jpg'))


if __name__ == '__main__':
    main()
