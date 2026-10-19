# -*- coding: utf-8 -*-
"""② ko 실화 사건 롱폼 렌더러 — «사건 기록» 화면(어두운 평면·왼쪽 진술 레일·테두리 안 바디캠·아래 자막 판).

    python -X utf8 ko-truecrime/render/case_render.py ko-truecrime/ep01 [--only 0-5] [--tts-only] [--no-gate]

ep/script.txt 블록:
  @nar <화면id>                     해설 문장(한 줄 한 문장) — Supertonic ko(정치 롱폼 tts.py 를 import, 고치지 않음)
  @cam <클립> <in> <out> <화면id>   바디캠 원음 구간 — 다음 줄들은 «시작|끝|화자|자막»(원본 클립의 시각 초, 화자 비우면 꼬리표 없음)
ep/visuals.json: 화면id → {type: still|title|quote|facts, stage: 0~4, claim, date, clip, t, ...}
ep/blur.json: 클립 → [[t0, t1, x, y, w, h], ...](원본 기준 0~1) — 제3자 얼굴 흐림(경찰관·피고인은 그대로, 관리자 10-18)
원본 장비 표시(Axon 시각 등)는 지우지 않는다. 피해자 사진은 쓰지 않는다.
"""
import ctypes
import hashlib
import html
import json
import os
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, 'D:/midform/politics-hour/overlay')
import tts  # noqa: E402  정치 롱폼 음성(Supertonic F2) — import 만

HYPERFRAMES = '0.8.140'
FPS = 30
CODE = '2026-10-18b'   # J컷·프리즈(카메라 문법 10-18)
J = 0.4                 # J컷: 다음 바디캠 소리를 해설 끝 0.4초에 먼저 깐다(docs/camera-grammar-found-footage.md)
GSAP = Path('D:/midform/politics-hour/assets/gsap.min.js')
LOCKS = [Path('D:/midform/politics-hour/RENDERING.lock'), Path('D:/midform/politics-hour/RENDERING-ja.lock')]
FREE_GB = 8
VID = (400, 132, 1472, 828)          # 바디캠 판 x, y, w, h
STAGES = [('① 안부 확인', '8월 13일 오후'), ('② 이웃 집 CCTV', '8월 13일 오후'), ('③ 거짓말 탐지', '8월 15일'), ('④ 자백', '8월 15일')]
TITLE = ('CASE 01', '남편의 말은 네 번 바뀌었다')
PLACE = '2018.08.13 · 미국 콜로라도주 프레데릭'
SRC_TAG = ('실제 경찰 바디캠', 'Weld County 지방검찰청 공개')
esc = html.escape

CSS = '''@font-face{font-family:K;src:url(assets/NotoSansKR-VF.ttf);font-weight:100 900}
:root{--bg:#14171c;--panel:#1d222a;--line:#2e3540;--amber:#f2b33d;--txt:#e9edf2;--dim:#7d8794;--red:#e0483e}
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:K;color:var(--txt)}
#top{position:absolute;left:0;right:0;top:0;height:92px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 48px;gap:28px;background:var(--bg)}
#top .no{font-weight:800;font-size:26px;letter-spacing:4px;color:var(--amber)}
#top .t{font-weight:800;font-size:34px}
#top .st{margin-left:auto;font-size:26px;color:var(--dim);font-weight:600;letter-spacing:1px}
#left{position:absolute;left:0;top:93px;width:400px;bottom:0;background:var(--bg)}
#right{position:absolute;right:0;top:93px;width:48px;bottom:0;background:var(--bg)}
#gap{position:absolute;left:400px;right:48px;top:93px;height:39px;background:var(--bg)}
#bottom{position:absolute;left:400px;right:48px;top:960px;bottom:0;background:var(--bg)}
#rail{position:absolute;left:48px;top:140px;width:320px}
#rail .h{font-size:22px;letter-spacing:4px;color:var(--dim);font-weight:700;margin-bottom:22px}
.step{position:relative;padding:0 0 46px 44px;font-size:30px;font-weight:700;color:var(--dim)}
.step::before{content:"";position:absolute;left:8px;top:12px;width:16px;height:16px;border-radius:50%;border:3px solid var(--dim);background:var(--bg)}
.step::after{content:"";position:absolute;left:17px;top:34px;bottom:0;width:2px;background:var(--line)}
.step:last-child::after{display:none}
.step small{display:block;font-size:25px;font-weight:600;margin-top:4px}
.step.done{color:#aab3bf}.step.done::before{background:#aab3bf;border-color:#aab3bf}
.step.on{color:var(--txt)}.step.on::before{background:var(--amber);border-color:var(--amber);box-shadow:0 0 0 8px rgba(242,179,61,.18)}
.step.on small{color:var(--amber)}
#claim{position:absolute;left:48px;bottom:150px;width:320px;font-size:26px;line-height:1.5;color:var(--dim);font-weight:600}
#claim b{color:var(--txt);display:block;font-size:30px;margin-top:6px;word-break:keep-all}
#frame{position:absolute;left:400px;top:132px;width:1472px;height:828px;box-sizing:border-box;border:1px solid var(--line)}
#tag{position:absolute;left:420px;top:152px;background:rgba(20,23,28,.86);border-left:6px solid var(--red);padding:8px 18px;font-size:26px;font-weight:800}
#tag i{font-style:normal;color:var(--dim);font-weight:600;margin-left:14px;font-size:22px}
#sub{position:absolute;left:400px;width:1472px;top:960px;height:96px;background:var(--panel);border-top:3px solid var(--amber);box-sizing:border-box}
.ln{position:absolute;inset:0;display:flex;align-items:center;gap:22px;padding:0 30px;opacity:0}
.ln b{flex:none;font-size:26px;font-weight:800;color:var(--bg);background:var(--amber);padding:4px 16px;border-radius:4px}
.ln span{font-size:42px;font-weight:800;word-break:keep-all}
.ln.nar{justify-content:center}.ln.nar span{font-weight:700}
#panel{position:absolute;left:400px;top:132px;width:1472px;height:828px;background:#0d0f12;overflow:hidden}
#panel img{width:100%;height:100%;object-fit:cover;filter:brightness(.55) saturate(.8)}
.pc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 90px}
.pc .big{font-size:84px;font-weight:900;line-height:1.3;word-break:keep-all}
.pc .big em{font-style:normal;color:var(--amber)}
.pc .sm{font-size:38px;color:#c3cad3;font-weight:600;margin-top:22px;word-break:keep-all}
.qt{position:absolute;left:90px;right:90px;top:50%;transform:translateY(-50%);border-left:10px solid var(--amber);padding:20px 40px;background:rgba(20,23,28,.82)}
.qt small{display:block;font-size:30px;color:var(--amber);font-weight:800;margin-bottom:12px}
.qt div{font-size:62px;font-weight:900;line-height:1.35;word-break:keep-all}
.fx{position:absolute;left:90px;right:90px;top:50%;transform:translateY(-50%)}
.fx .r{display:flex;gap:34px;align-items:baseline;padding:18px 0;border-bottom:1px solid var(--line)}
.fx .r b{flex:none;width:300px;font-size:36px;color:var(--amber);font-weight:800}
.fx .r span{font-size:44px;font-weight:800;word-break:keep-all}
'''


def free_gb():
    class M(ctypes.Structure):
        _fields_ = [('l', ctypes.c_ulong), ('m', ctypes.c_ulong), ('t', ctypes.c_ulonglong), ('a', ctypes.c_ulonglong),
                    ('tp', ctypes.c_ulonglong), ('ap', ctypes.c_ulonglong), ('tv', ctypes.c_ulonglong), ('av', ctypes.c_ulonglong),
                    ('ae', ctypes.c_ulonglong)]
    m = M()
    m.l = ctypes.sizeof(M)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.a / 2 ** 30


def wait_gate():
    """관리자 10-18: 다른 레인 lock 없음 + 빈 메모리 8GB 이상일 때만 무거운 작업. 아니면 15분마다 다시 본다."""
    while True:
        locks = [p.name for p in LOCKS if p.exists()]
        gb = free_gb()
        print(f'[관문] 다른 레인 lock {", ".join(locks) or "없음"} · 빈 메모리 {gb:.1f}GB', flush=True)
        if not locks and gb >= FREE_GB:
            return
        time.sleep(900)


def key(obj):
    return hashlib.sha1(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:10]


def parse_script(path):
    blocks, cur = [], None
    for raw in path.read_text(encoding='utf-8').splitlines():
        ln = raw.strip()
        if not ln or ln.startswith('#'):
            continue
        if ln.startswith('@nar '):
            cur = {'kind': 'nar', 'vid': ln.split()[1], 'sentences': []}
            blocks.append(cur)
        elif ln.startswith('@cam '):
            _, clip, a, b, vid = ln.split()[:5]
            cur = {'kind': 'cam', 'clip': clip, 'in': float(a), 'out': float(b), 'vid': vid, 'subs': []}
            blocks.append(cur)
        elif cur and cur['kind'] == 'nar':
            cur['sentences'].append(ln)
        elif cur:
            a, b, who, text = ln.split('|', 3)
            cur['subs'].append([float(a), float(b), who.strip(), text.strip()])
    return blocks


def chrome(spec, panel_html=''):
    st = spec.get('stage', 0)
    steps = ''.join(f'<div class="step {"done" if i + 1 < st else ("on" if i + 1 == st else "")}"><span>{esc(a)}</span><small>{esc(b)}</small></div>'
                    for i, (a, b) in enumerate(STAGES))
    claim = f'<div id="claim">지금 그의 설명<b>«{esc(spec["claim"])}»</b></div>' if spec.get('claim') else ''
    return (f'{panel_html}<div id="top"><span class="no">{TITLE[0]}</span><span class="t">{esc(TITLE[1])}</span><span class="st">{esc(spec.get("date", PLACE))}</span></div>'
            f'<div id="left"></div><div id="right"></div><div id="gap"></div><div id="bottom"></div>'
            f'<div id="rail"><div class="h">진술 기록</div>{steps}</div>{claim}<div id="frame"></div>')


def lines_html(items, nar):
    """자막 판 — items: [[a, b, 화자, 글]]. 해설은 다음 줄이 나올 때까지 유지, 대사는 제 끝까지."""
    body, js = '<div id="sub">', []
    for i, (a, b, who, text) in enumerate(items):
        tag = f'<b>{esc(who)}</b>' if who else ''
        body += f'<div class="ln{" nar" if nar else ""}" id="l{i}">{tag}<span>{esc(text)}</span></div>'
        end = items[i + 1][0] if nar and i + 1 < len(items) else b
        js.append(f'tl.set("#l{i}",{{opacity:1}},{max(a, 0):.2f});tl.set("#l{i}",{{opacity:0}},{end:.2f});')
    return body + '</div>', js


def panel(spec, d):
    t = spec['type']
    img = '<img src="still.jpg">' if spec.get('clip') else ''
    if t == 'still':
        return f'<div id="panel">{img}</div><div id="tag">{SRC_TAG[0]}<i>{SRC_TAG[1]} · 정지 화면</i></div>', []
    if t == 'title':
        lines = ''.join(f'<div class="big" id="b{i}">{x}</div>' for i, x in enumerate(spec['lines']))
        sm = f'<div class="sm">{esc(spec["sub"])}</div>' if spec.get('sub') else ''
        js = [f'tl.from("#b{i}",{{opacity:0,y:30,duration:.5}},{.2 + i * .6:.2f});' for i in range(len(spec['lines']))]
        return f'<div id="panel">{img}<div class="pc">{lines}{sm}</div></div>', js
    if t == 'quote':
        return (f'<div id="panel">{img}<div class="qt" id="qt"><small>{esc(spec["who"])}</small><div>«{esc(spec["text"])}»</div></div></div>',
                ['tl.from("#qt",{opacity:0,x:-40,duration:.5},.3);'])
    if t == 'facts':
        rows = ''.join(f'<div class="r" id="r{i}"><b>{esc(a)}</b><span>{esc(b)}</span></div>' for i, (a, b) in enumerate(spec['rows']))
        step = max(.6, (d - 1.5) / max(1, len(spec['rows'])))
        js = [f'tl.from("#r{i}",{{opacity:0,x:-30,duration:.4}},{.3 + i * step:.2f});' for i in range(len(spec['rows']))]
        return f'<div id="panel"><div class="fx">{rows}</div></div>', js
    raise SystemExit(f'모르는 화면 종류: {t}')


def page(folder, cid, d, body, js, transparent=False):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    shutil.copy2(HERE / 'NotoSansKR-VF.ttf', folder / 'assets' / 'NotoSansKR-VF.ttf')
    shutil.copy2(GSAP, folder / 'assets' / 'gsap.min.js')
    bg = 'transparent' if transparent else '#14171c'
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{CSS}body{{background:{bg}}}</style></head><body>'
        f'<div id="root" data-composition-id="{cid}" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
        f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{body}</section></div>'
        f'<script src="assets/gsap.min.js"></script><script>const tl=gsap.timeline({{paused:true}});{"".join(js)}'
        f'window.__timelines=window.__timelines||{{}};window.__timelines["{cid}"]=tl;</script></body></html>', encoding='utf-8')


def hf_render(folder, out, fmt):
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    tmp = Path(folder) / 'tmp'
    tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMP=str(tmp), TEMP=str(tmp))
    name = f'screen.{fmt}'
    cmd = [npx, '--yes', f'hyperframes@{HYPERFRAMES}', 'render', '.', '--format', fmt, '--fps', str(FPS),
           '--workers', '4', '--output', name, '--quiet', '--frames-cache-dir', 'off']
    if subprocess.run(cmd, cwd=folder, env=env).returncode:
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(exist_ok=True)
        cmd[cmd.index('--workers') + 1] = '1'
        subprocess.run(cmd, cwd=folder, check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.move(str(Path(folder) / name), out)


def blur_chain(boxes, w, h, src='0:v', t0=0.0):
    """원본 위 흐림 상자 — 구간 밖에서는 꺼진다. t0 는 잘라 낸 구간의 시작(필터 시각은 0부터)."""
    if not boxes:
        return f'[{src}]null[bl]'
    parts = [f'[{src}]split={len(boxes) + 1}[b0]' + ''.join(f'[c{k}]' for k in range(len(boxes)))]
    last = 'b0'
    for k, (a, b, x, y, bw, bh) in enumerate(boxes):
        X, Y, W, H = (int(round(v)) // 2 * 2 for v in (x * w, y * h, bw * w, bh * h))
        parts.append(f'[c{k}]crop={W}:{H}:{X}:{Y},boxblur=24:4[k{k}]')
        parts.append(f"[{last}][k{k}]overlay={X}:{Y}:enable='between(t,{a - t0:.2f},{b - t0:.2f})'[o{k}]")
        last = f'o{k}'
    return ';'.join(parts) + f';[{last}]null[bl]'


def probe_wh(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True).stdout.strip().split(',')
    return int(out[0]), int(out[1])


def still(ep, spec, blur, out):
    src = ep / 'raw' / f'{spec["clip"]}.mp4'
    w, h = probe_wh(src)
    t = float(spec['t'])
    boxes = [[0, 1e9] + bx[2:] for bx in blur.get(spec['clip'], []) if bx[0] <= t <= bx[1]]
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', str(src),
                    '-filter_complex', blur_chain(boxes, w, h) + ';[bl]scale=1472:828[s]',
                    '-map', '[s]', '-frames:v', '1', '-q:v', '3', str(out)], check=True)


def wav_seconds(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


def render_nar(ep, blk, spec, blur, folder, tts_only, lead=None):
    wav = folder / 'voice.wav'
    if not (wav.exists() and (folder / 'cues.json').exists()):
        _, cues = tts.speak('supertonic', ' '.join(blk['sentences']), str(wav))
        (folder / 'cues.json').write_text(json.dumps(cues, ensure_ascii=False) + '\n', encoding='utf-8')
    if tts_only:
        return None
    cues = json.loads((folder / 'cues.json').read_text(encoding='utf-8'))
    d = round(wav_seconds(wav) + .45, 3)
    hf = folder / 'hf'
    hf.mkdir(parents=True, exist_ok=True)
    if spec.get('clip'):
        still(ep, spec, blur, hf / 'still.jpg')
    pb, pj = panel(spec, d)
    sb, sj = lines_html([[a, b, '', x] for a, b, x in cues], True)
    page(hf, 'n', d, chrome(spec, pb) + sb, pj + sj)
    hf_render(hf, folder / 'screen.mp4', 'mp4')
    out = folder / 'segment.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(folder / 'screen.mp4'), '-i', str(wav),
                    *(['-ss', f'{lead[1]:.3f}', '-t', f'{J:.3f}', '-i', str(ep / 'raw' / f'{lead[0]}.mp4')] if lead else []),
                    '-filter_complex', f'[1:a]apad=whole_dur={d:.3f},aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[a0];' + (
                        f'[2:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.15,adelay={int((d - J) * 1000)}|{int((d - J) * 1000)}[jl];'
                        f'[a0][jl]amix=inputs=2:duration=first:normalize=0[a]' if lead else '[a0]anull[a]'), '-map', '0:v', '-map', '[a]',
                    '-t', f'{d:.3f}', '-r', str(FPS), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', str(out)], check=True)
    (folder / 'screen.mp4').unlink(missing_ok=True)
    return out


def render_cam(ep, blk, spec, blur, folder, jcut=False):
    src = ep / 'raw' / f'{blk["clip"]}.mp4'
    a, b = blk['in'] + (J if jcut else 0), blk['out']      # J컷이면 앞 0.4초 소리는 앞 해설 끝에 이미 깔렸다
    fz = float(spec.get('freeze', 0))                         # 프리즈: 자백 장면 한 번만 — 끝 프레임을 fz 초 멈춘다
    d = round(b - a + fz, 3)
    hf = folder / 'hf'
    tag = f'<div id="tag">{SRC_TAG[0]}<i>{SRC_TAG[1]}</i></div>'
    sb, sj = lines_html([[x - a, y - a, who, t] for x, y, who, t in blk['subs']], False)
    page(hf, 'c', d, chrome(spec) + tag + sb, sj, transparent=True)
    hf_render(hf, folder / 'overlay.mov', 'mov')
    w, h = probe_wh(src)
    x, y, vw, vh = VID
    boxes = [bx for bx in blur.get(blk['clip'], []) if bx[1] >= a and bx[0] <= b]
    fc = (blur_chain(boxes, w, h, '0:v', a) +
          (f';[bl]tpad=stop_mode=clone:stop_duration={fz:.2f}[bz]' if fz else ';[bl]null[bz]') +
          f';[bz]fps={FPS},scale={vw}:{vh}:force_original_aspect_ratio=decrease,pad={vw}:{vh}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0];'
          f'color=c=0x14171c:s=1920x1080:r={FPS}:d={d:.3f}[bg];[bg][v0]overlay={x}:{y}[b1];[b1][1:v]overlay=format=auto,setsar=1[v];'
          f'[0:a]apad=whole_dur={d:.3f},aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.15,afade=t=out:st={max(0, d - .3):.2f}:d=0.3[a]')
    out = folder / 'segment.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{a:.3f}', '-t', f'{d:.3f}', '-i', str(src), '-i', str(folder / 'overlay.mov'),
                    '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', f'{d:.3f}', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', str(out)], check=True)
    (folder / 'overlay.mov').unlink(missing_ok=True)
    return out


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    blocks = parse_script(ep / 'script.txt')
    vis = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
    blur = json.loads((ep / 'blur.json').read_text(encoding='utf-8')) if (ep / 'blur.json').exists() else {}
    miss = [b['vid'] for b in blocks if b['vid'] not in vis]
    if miss:
        raise SystemExit('visuals.json 에 없는 화면: ' + ', '.join(miss))
    only = argv[argv.index('--only') + 1] if '--only' in argv else None
    rng = range(len(blocks)) if not only else range(int(only.split('-')[0]), min(len(blocks), int(only.split('-')[1]) + 1))
    tts_only = '--tts-only' in argv
    if '--no-gate' not in argv:
        wait_gate()
    parts, cam_s, total = [], 0.0, 0.0
    for i in rng:
        blk, spec = blocks[i], vis[blocks[i]['vid']]
        clip = blk.get('clip') or spec.get('clip')
        nb = blocks[i + 1] if i + 1 < len(blocks) else None          # J컷은 이웃 블록에 달려 있다 — 이웃의 종류·시작점도 키에
        pb = blocks[i - 1] if i else None
        link = [nb and (nb['kind'], nb.get('clip'), nb.get('in')), pb and pb['kind']]
        folder = ep / 'seg' / f'{i:03d}-{blk["kind"]}-{key([blk, spec, blur.get(clip, []), CODE, link])}'
        folder.mkdir(parents=True, exist_ok=True)
        final = folder / 'segment.mp4'
        if not final.exists():
            nxt = blocks[i + 1] if i + 1 < len(blocks) else None
            prv = blocks[i - 1] if i else None
            if blk['kind'] == 'nar':
                render_nar(ep, blk, spec, blur, folder, tts_only, (nxt['clip'], nxt['in']) if nxt and nxt['kind'] == 'cam' else None)
            elif not tts_only:
                render_cam(ep, blk, spec, blur, folder, jcut=bool(prv and prv['kind'] == 'nar'))
        if final.exists():
            dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(final)],
                                       capture_output=True, text=True).stdout or 0)
            total += dur
            cam_s += dur if blk['kind'] == 'cam' else 0
            parts.append(final)
        print(f'[{i + 1}/{len(blocks)}] {blk["kind"]} {blk["vid"]} {total / 60:.1f}분', flush=True)
    if tts_only or not parts:
        return 0
    lst = ep / 'concat.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    out = ep / (f'episode_{only}.mp4' if only else 'episode.mp4')
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(out)], check=True)
    print(f'{out} {total / 60:.1f}분 · 원음 {cam_s / 60:.1f}분({cam_s / max(total, 1) * 100:.0f}%)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
