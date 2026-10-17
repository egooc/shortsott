# -*- coding: utf-8 -*-
"""ja 연금 해설 롱폼 조립기 — 원고(script.txt) + 장면표(visuals.json) → 장면별 하이퍼프레임 화면 + Supertonic 해설 → episode.mp4

    python ja-nenkin/render/nenkin_render.py ja-nenkin/ep01 [--only 0-5] [--tts-only]

- 뼈대(하이퍼프레임 page·hf_render·ffmpeg 합성)는 politics-hour-ja/render/ja_render.py 의 함수를 복사해 왔다(관리자 10-17: 복사해 자기 모듈로,
  화면 템플릿은 가져오지 말 것). 화면은 레퍼런스(@年金給付金手続きノート) 문법 — 장 이름표·가운데 판 하나·아래 2줄 자막·출처 작은 글씨 —
  을 따르되 색·그림은 새로, 글씨는 레퍼런스보다 크게(소유주 10-17 «노인 시청자»): 자막 92px·판 글자 56px 이상.
- 숫자: 자막은 아라비아 숫자, TTS 입력은 scripts/ja_numread.to_say(금액·비율 히라가나). 렌더 전 --check 로 값 검산.
- 렌더는 낮에만(ko 18:30~00:30·ja 03~06·쇼핑 00:30/03:30 피함).
"""
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import ja_numread as N  # noqa: E402

HERE = Path(__file__).resolve().parent
FONTS = ROOT / 'politics-hour-ja' / 'assets' / 'fonts'
GSAP = ROOT / 'politics-hour-ja' / 'assets' / 'gsap.min.js'
HYPERFRAMES = '0.8.140'
FPS = 30
CODE = '2026-10-17a'
SUPERTONIC = {'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic',
              'voice': 'F2', 'speed': 1.05, 'steps': 8, 'gap': 0.45, 'lang': 'ja', 'num_reading': False}
BLUE, BLUE_D, CREAM, BAND, RED, INK, GREEN = '#1E5AA8', '#143F7A', '#FFFCF4', '#FFF1B8', '#D62A1E', '#1B1B1B', '#2E8B57'
esc = lambda s: html.escape(str(s), quote=True)

# ---------- 원고 ----------


def parse_script(path):
    """[{chap, vid, sentences[]}] — '## 장' · '@화면' · 문장."""
    blocks, chap = [], ''
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('# '):
            continue
        if line.startswith('## '):
            chap = line[3:].strip()
        elif line.startswith('@'):
            blocks.append({'chap': chap, 'vid': line[1:].strip(), 'sentences': []})
        else:
            blocks[-1]['sentences'].append(line)
    return blocks


def chunks(sentence, limit=26):
    """자막 덩어리: 、 에서 끊고 limit 자를 넘으면 더 나눈다(2줄 = 약 18자 × 2)."""
    out, cur = [], ''
    for piece in re.split(r'(?<=、)', sentence):
        if cur and len(cur) + len(piece) > limit:
            out.append(cur); cur = piece
        else:
            cur += piece
    if cur:
        out.append(cur)
    res = []
    for c in out:
        while len(c) > limit + 4:
            res.append(c[:limit]); c = c[limit:]
        res.append(c)
    return [c.rstrip('。、') for c in res]


def speak(sentences, out):
    job = dict(SUPERTONIC, out=str(Path(out).resolve()), sentences=[[N.to_say(s), chunks(s)] for s in sentences])
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(job, f, ensure_ascii=False)
    r = subprocess.run([SUPERTONIC['python'], str(HERE / 'supertonic_worker.py'), f.name],
                       capture_output=True, text=True, encoding='utf-8', env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    os.unlink(f.name)
    if r.returncode:
        raise SystemExit(r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def wav_seconds(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


# ---------- 화면 ----------
CSS = f'''
@font-face{{font-family:Sans;src:url(assets/NotoSansJP.ttf)}}
html,body{{margin:0;background:{CREAM}}}
#root{{position:relative;width:1920px;height:1080px;overflow:hidden;font-family:Sans;color:{INK};font-feature-settings:"palt";
  background:linear-gradient(180deg,#FFFFFF 0%,{CREAM} 70%)}}
#frame{{position:absolute;inset:0;border:14px solid {BLUE};box-sizing:border-box;pointer-events:none}}
#chap{{position:absolute;left:14px;top:14px;background:{BLUE};color:#fff;font-weight:900;font-size:58px;padding:10px 44px 16px 36px;
  border-bottom-right-radius:22px;letter-spacing:.02em}}
#band{{position:absolute;left:14px;right:14px;bottom:14px;height:262px;background:{BAND};border-top:6px solid #F2C230}}
.cap{{position:absolute;left:60px;right:60px;bottom:14px;height:262px;display:flex;align-items:center;justify-content:center;text-align:center;opacity:0}}
.cap span{{font-weight:900;font-size:92px;line-height:1.18;letter-spacing:.03em;color:{INK};max-width:1720px}}
.cap em{{font-style:normal;color:{RED}}}
#src{{position:absolute;right:40px;bottom:290px;font-size:26px;font-weight:700;color:#4A4A4A;background:rgba(255,255,255,.85);padding:2px 12px}}
#fic{{position:absolute;right:40px;top:30px;font-size:30px;font-weight:900;color:#fff;background:#6B6B6B;padding:4px 18px 6px;border-radius:8px}}
#stage{{position:absolute;left:14px;right:14px;top:110px;bottom:290px}}
.card{{background:#fff;border:5px solid {BLUE};border-radius:24px;box-shadow:0 10px 0 rgba(30,90,168,.18)}}
.red{{color:{RED}}}
em{{font-style:normal;color:{RED}}}
img{{mix-blend-mode:multiply}}
'''


def chrome(blk, spec):
    body = '<div id="frame"></div><div id="band"></div>'
    if blk['chap'] and blk['chap'] not in ('0', 'まとめ'):
        body += f'<div id="chap">{esc(blk["chap"])}</div>'
    elif blk['chap'] == 'まとめ':
        body += '<div id="chap">まとめ・やること</div>'
    if spec.get('fiction'):
        body += '<div id="fic">架空の例</div>'
    if spec.get('source'):
        body += f'<div id="src">出典：{esc(spec["source"])}</div>'
    return body


def stage(spec, d, img_dir, doc_dir, cues):
    """가운데 판 — (css, body, js). 글자는 56px 이상."""
    t = spec['type']
    css, js = '', []
    at = lambda kw, default=.4: next((a for a, b, x in cues if kw and kw in x), default)
    if t == 'title':          # 큰 글자 판(훅·장 제목)
        lines = ''.join(f'<div class="l{i}">{ln}</div>' for i, ln in enumerate(spec['lines']))
        css = f'''#ti{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
#ti div{{font-weight:900;font-size:{spec.get("size", 120)}px;line-height:1.25}}
#ti .l0{{font-size:{spec.get("size0", spec.get("size", 120))}px}}
#ti em{{font-style:normal;color:{RED}}}
#ti .k{{display:inline-block;background:{BLUE};color:#fff;padding:6px 36px 12px;border-radius:16px;font-size:64px;margin-bottom:24px}}'''
        body = f'<div id="ti">{lines}</div>'
        js = ['tl.from("#ti div",{opacity:0,y:30,duration:.5,stagger:.25,ease:"power3.out"},.15);']
        if spec.get('img'):
            css += f'#ti{{right:620px}}#pic{{position:absolute;right:40px;bottom:0;height:640px}}'
            body += f'<img id="pic" src="img/{spec["img"]}">'
            js.append('tl.from("#pic",{opacity:0,x:40,duration:.6},.3);')
        return css, body, js
    if t == 'img':            # 삽화 + 오른쪽 카드(제목·큰 줄)
        side = spec.get('lines')
        css = f'''#pic{{position:absolute;left:{80 if side else 0}px;{"" if side else "right:0;margin:auto;"}top:0;bottom:0;margin-top:auto;margin-bottom:auto;height:{spec.get("h", 640)}px}}
#cd{{position:absolute;left:760px;right:50px;top:50%;transform:translateY(-50%);padding:34px 50px 40px}}
#cd .h{{display:inline-block;background:{GREEN};color:#fff;font-weight:900;font-size:56px;padding:4px 26px 8px;border-radius:12px;margin-bottom:14px}}
#cd .ln{{font-weight:900;font-size:{int(spec.get("size", 66) * 1.2)}px;line-height:1.34}}
#cd em{{font-style:normal;color:{RED}}}
#bb{{position:absolute;left:{spec.get("bx", 760)}px;top:{spec.get("by", 40)}px;background:#fff;border:5px solid {INK};border-radius:60px;padding:18px 48px 24px;
  font-weight:900;font-size:72px}}'''
        body = f'<img id="pic" src="img/{spec["img"]}">'
        js = ['tl.from("#pic",{opacity:0,scale:.94,duration:.5,ease:"power2.out"},.1);']
        if side:
            body += '<div id="cd" class="card">' + (f'<div class="h">{esc(spec["head"])}</div>' if spec.get('head') else '') + ''.join(
                f'<div class="ln" id="l{i}">{ln}</div>' for i, ln in enumerate(side)) + '</div>'
            js.append('tl.from("#cd",{opacity:0,x:40,duration:.5,ease:"power2.out"},.35);')
            for i, ln in enumerate(side):
                js.append(f'tl.from("#l{i}",{{opacity:0,y:14,duration:.35}},{at(spec.get("at", [None] * 9)[i] if spec.get("at") else None, .6 + i * .5):.2f});')
        if spec.get('bubble'):
            body += f'<div id="bb">{esc(spec["bubble"])}</div>'
            js.append('tl.from("#bb",{opacity:0,scale:.6,duration:.35,ease:"back.out(2)"},.5);')
        return css, body, js
    if t == 'doc':            # 공문서 견본 — 보는 창(crop) 안에서 빨간 테두리로 칸 짚기
        x0, y0, x1, y1 = spec.get('crop', [0, 0, 1, 1])
        pw, ph = spec.get('page', [1654, 2339])
        H = 680
        cw, ch = (x1 - x0) * pw, (y1 - y0) * ph
        sc = min(H / ch, 1500 / cw)
        W, Hh = cw * sc, ch * sc
        css = f'''#dv{{position:absolute;left:0;right:0;top:0;margin:auto;width:{W:.0f}px;height:{Hh:.0f}px;overflow:hidden;border:4px solid #999;background:#fff;
  box-shadow:0 12px 30px rgba(0,0,0,.18)}}
#dv img{{position:absolute;left:{-x0 * pw * sc:.0f}px;top:{-y0 * ph * sc:.0f}px;width:{pw * sc:.0f}px}}
.bx{{position:absolute;border:9px solid {RED};border-radius:10px;box-sizing:border-box}}
.nb{{position:absolute;width:84px;height:84px;border-radius:50%;background:{RED};color:#fff;font-weight:900;font-size:56px;line-height:80px;text-align:center}}'''
        body = f'<div id="dv"><img src="docs/{spec["src"]}">'
        for i, b in enumerate(spec.get('boxes', [])):
            bx0, by0, bx1, by1 = b['r']
            L, T = (bx0 - x0) * pw * sc, (by0 - y0) * ph * sc
            body += f'<div class="bx" id="b{i}" style="left:{L:.0f}px;top:{T:.0f}px;width:{(bx1 - bx0) * pw * sc:.0f}px;height:{(by1 - by0) * ph * sc:.0f}px"></div>'
            if b.get('n'):
                body += f'<div class="nb" id="n{i}" style="left:{max(0, L - 42):.0f}px;top:{max(0, T - 42):.0f}px">{esc(b["n"])}</div>'
            a = at(b.get('kw'), .8 + i * 1.2)
            js.append(f'tl.from("#b{i}",{{opacity:0,scale:1.15,duration:.35,ease:"power2.out"}},{a:.2f});')
            if b.get('n'):
                js.append(f'tl.from("#n{i}",{{opacity:0,scale:.4,duration:.3,ease:"back.out(2)"}},{a + .1:.2f});')
        body += '</div>'
        js.insert(0, 'tl.from("#dv",{opacity:0,y:20,duration:.5},.05);')
        return css, body, js
    if t == 'cards':          # 숫자 카드 식: [카드, 연산, 카드, …]
        css = f'''#cs{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:34px}}
#cs .c{{padding:24px 40px 30px;text-align:center;min-width:300px}}
#cs .c small{{display:block;font-weight:900;font-size:50px;color:#fff;background:{BLUE};margin:-24px -40px 18px;padding:8px 20px 12px;border-radius:18px 18px 0 0}}
#cs .c b{{font-weight:900;font-size:{spec.get("size", 96)}px}}
#cs .c.r{{border-color:{RED}}} #cs .c.r small{{background:{RED}}} #cs .c.r b{{color:{RED}}}
#cs .op{{font-weight:900;font-size:110px;color:{BLUE}}}
#nt{{position:absolute;left:0;right:0;bottom:10px;text-align:center;font-weight:700;font-size:44px;color:#333}}'''
        body, k = '<div id="cs">', 0
        for it in spec['items']:
            if isinstance(it, str):
                body += f'<div class="op" id="o{k}">{esc(it)}</div>'
            else:
                body += f'<div class="c card{" r" if it.get("red") else ""}" id="o{k}"><small>{esc(it["label"])}</small><b>{esc(it["value"])}</b></div>'
            js.append(f'tl.from("#o{k}",{{opacity:0,y:30,duration:.4,ease:"power2.out"}},{at(it.get("kw") if isinstance(it, dict) else None, .3 + k * .45):.2f});')
            k += 1
        body += '</div>' + (f'<div id="nt">{esc(spec["note"])}</div>' if spec.get('note') else '')
        return css, body, js
    if t == 'table':          # 큰 표(행 3~5개), hi 행은 빨간 테두리
        cols = len(spec['head'])
        css = f'''#tb{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:{spec.get("w", 1600)}px;height:max-content;border-collapse:collapse;background:#fff}}
#tb th{{background:{BLUE};color:#fff;font-weight:900;font-size:50px;padding:10px 18px;border:3px solid {BLUE_D}}}
#tb td{{font-weight:800;font-size:{spec.get("size", 56)}px;padding:10px 22px;border:3px solid #9DB3D6;text-align:center}}
#tb tr.hi td{{color:{RED};outline:8px solid {RED};outline-offset:-6px}}
#tt{{position:absolute;left:0;right:0;top:-6px;text-align:center;font-weight:900;font-size:54px}}'''
        rows = ''.join(f'<tr id="r{i}" class="{"hi" if i in spec.get("hi", []) else ""}">' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>'
                       for i, r in enumerate(spec['rows']))
        body = (f'<div id="tt">{esc(spec.get("title", ""))}</div>' if spec.get('title') else '') + \
            f'<table id="tb"><tr>{"".join(f"<th>{esc(h)}</th>" for h in spec["head"])}</tr>{rows}</table>'
        js = ['tl.from("#tb",{opacity:0,y:20,duration:.45},.1);']
        js += [f'tl.from("#r{i}",{{opacity:0,duration:.35}},{at((spec.get("at") or [None] * 9)[i] if spec.get("at") else None, .5 + i * .4):.2f});' for i in range(len(spec['rows']))]
        return css, body, js
    if t in ('toc', 'list'):  # 목차(지금 장 빨강) / 체크 목록
        on = spec.get('on', -1)
        css = f'''#ls{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:{spec.get("w", 1700)}px;height:max-content;padding:26px 56px 34px}}
#ls .h{{font-weight:900;font-size:64px;color:{BLUE};margin-bottom:10px}}
#ls .it{{font-weight:900;font-size:{int(spec.get("size", 62) * 1.2)}px;line-height:1.42;color:#333}}
#ls .it i{{font-style:normal;display:inline-block;width:88px;color:{BLUE}}}
#ls .it.on{{color:{RED}}} #ls .it.on i{{color:{RED}}}
#ls .it.dim{{color:#9A9A9A}}'''
        mark = spec.get('mark', '✓' if t == 'list' else None)
        body = '<div id="ls" class="card">' + (f'<div class="h">{esc(spec["head"])}</div>' if spec.get('head') else '')
        for i, x in enumerate(spec['items']):
            m = mark or f'{i + 1}.'
            cls = 'on' if i == on else ('dim' if on >= 0 and t == 'toc' else '')
            body += f'<div class="it {cls}" id="i{i}"><i>{m}</i>{x}</div>'
        body += '</div>'
        js = ['tl.from("#ls",{opacity:0,scale:.97,duration:.4},.05);']
        js += [f'tl.from("#i{i}",{{opacity:0,x:-24,duration:.35}},{at((spec.get("at") or [None] * 12)[i] if spec.get("at") else None, .4 + i * .35):.2f});'
               for i in range(len(spec['items']))]
        return css, body, js
    if t == 'flow':           # 판정 질문 — 지금 질문만 크게, 오른쪽에 はい/いいえ
        q = spec['q']
        css = f'''#fl{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:1600px;height:max-content;padding:30px 60px 40px}}
#fl .n{{display:inline-block;background:{BLUE};color:#fff;font-weight:900;font-size:52px;padding:4px 26px 8px;border-radius:12px}}
#fl .q{{font-weight:900;font-size:68px;line-height:1.35;margin-top:16px}}
#fl .a{{margin-top:24px;font-weight:900;font-size:60px;color:{GREEN}}}
#fl em{{font-style:normal;color:{RED}}}'''
        body = f'<div id="fl" class="card"><div class="n">{esc(spec["n"])}</div><div class="q">{q}</div>' + \
            (f'<div class="a" id="an">{spec["a"]}</div>' if spec.get('a') else '') + '</div>'
        js = ['tl.from("#fl",{opacity:0,y:24,duration:.45},.05);']
        if spec.get('a'):
            js.append(f'tl.from("#an",{{opacity:0,x:-20,duration:.4}},{at(spec.get("a_kw"), d * .55):.2f});')
        return css, body, js
    if t == 'months':         # 지급월 칩 + 값
        css = f'''#mo{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:22px}}
#mo .m{{width:230px;text-align:center}}
#mo .m b{{display:block;font-weight:900;font-size:58px;color:#fff;background:{BLUE};border-radius:14px;padding:6px 0 10px}}
#mo .m span{{display:block;margin-top:16px;font-weight:900;font-size:48px;line-height:1.3}}
#mo .m.on b{{background:{RED}}} #mo .m.on span{{color:{RED}}}
#nt{{position:absolute;left:0;right:0;bottom:20px;text-align:center;font-weight:800;font-size:48px}}'''
        body = '<div id="mo">' + ''.join(f'<div class="m{" on" if m.get("on") else ""}" id="m{i}"><b>{esc(m["m"])}</b><span>{m.get("v", "")}</span></div>'
                                         for i, m in enumerate(spec['items'])) + '</div>' + (f'<div id="nt">{spec["note"]}</div>' if spec.get('note') else '')
        js = [f'tl.from("#m{i}",{{opacity:0,y:20,duration:.35}},{.2 + i * .25:.2f});' for i in range(len(spec['items']))]
        if spec.get('note'):
            js.append(f'tl.from("#nt",{{opacity:0,duration:.4}},{at(spec.get("note_kw"), 1.8):.2f});')
        return css, body, js
    raise SystemExit('모르는 화면 종류: ' + t)


def captions(cues, d, emph=()):
    body, js = '', []
    for i, (a, b, text) in enumerate(cues):
        tx = esc(text)
        for w in sorted(emph, key=len, reverse=True):
            tx = tx.replace(esc(w), f'<em>{esc(w)}</em>')
        body += f'<div class="cap" id="c{i}"><span>{tx}</span></div>'
        js.append(f'tl.set("#c{i}",{{opacity:1}},{a:.3f});tl.set("#c{i}",{{opacity:0}},{min(b, d - .04):.3f});')
    return body, js


def page(folder, cid, d, css, body, js, ep):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    if not (folder / 'assets' / 'NotoSansJP.ttf').exists():
        shutil.copy2(FONTS / 'NotoSansJP.ttf', folder / 'assets' / 'NotoSansJP.ttf')
    shutil.copy2(GSAP, folder / 'assets' / 'gsap.min.js')
    for sub in ('img', 'docs'):
        link = folder / sub
        if not link.exists():
            shutil.copytree(ep / sub, link)
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>{CSS}{css}</style></head><body>'
        f'<div id="root" data-composition-id="{cid}" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
        f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{body}</section></div>'
        f'<script src="assets/gsap.min.js"></script><script>const tl=gsap.timeline({{paused:true}});{"".join(js)}'
        f'window.__timelines=window.__timelines||{{}};window.__timelines["{cid}"]=tl;</script></body></html>', encoding='utf-8')


def hf_render(folder, out):
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    tmp = Path(folder) / 'tmp'
    tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMP=str(tmp), TEMP=str(tmp))
    cmd = [npx, '--yes', f'hyperframes@{HYPERFRAMES}', 'render', '.', '--format', 'mp4', '--fps', str(FPS),
           '--workers', '4', '--output', 'screen.mp4', '--quiet', '--frames-cache-dir', 'off']
    if subprocess.run(cmd, cwd=folder, env=env).returncode:
        shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir(exist_ok=True)
        cmd[cmd.index('--workers') + 1] = '1'
        subprocess.run(cmd, cwd=folder, check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.move(str(Path(folder) / 'screen.mp4'), out)


def mux(video, wav, out, d):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(video), '-i', str(wav),
                    '-filter_complex', f'[1:a]apad=whole_dur={d:.3f},aresample=48000[a]', '-map', '0:v', '-map', '[a]',
                    '-t', f'{d:.3f}', '-r', str(FPS), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', str(out)], check=True)


def key(obj):
    return hashlib.sha1(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:10]


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    only = argv[argv.index('--only') + 1] if '--only' in argv else None
    blocks = parse_script(ep / 'script.txt')
    vis = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
    emph = vis.pop('_emph', [])
    miss = [b['vid'] for b in blocks if b['vid'] not in vis]
    if miss:
        raise SystemExit('visuals.json 에 없는 화면: ' + ', '.join(miss))
    rng = range(len(blocks)) if not only else range(int(only.split('-')[0]), min(len(blocks), int(only.split('-')[1]) + 1))
    if '--preview' in argv:            # TTS·렌더 없이 정지 화면만(정치 렌더 시간대에도 가볍게 돌릴 수 있다)
        out = ep / 'preview'
        out.mkdir(exist_ok=True)
        npx = shutil.which('npx.cmd') or shutil.which('npx')
        for i in rng:
            blk, spec = blocks[i], vis[blocks[i]['vid']]
            cues, t = [], 0.0
            for s in blk['sentences']:
                cs = chunks(s)
                for c in cs:
                    d0 = max(1.2, len(c) / 5.6)
                    cues.append([round(t, 2), round(t + d0, 2), c]); t += d0
                t += .45
            d = round(t + .45, 3)
            sc, sb, sj = stage(spec, d, ep / 'img', ep / 'docs', cues)
            cb, cj = captions(cues, d, emph)
            f = out / f'{i:03d}'
            page(f, f's{i}', d, sc, chrome(blk, spec) + f'<div id="stage">{sb}</div>' + cb, sj + cj, ep)
            last = max((a for a, b, x in cues if b - a > 1.5), default=d * .8)
            subprocess.run([npx, '--yes', f'hyperframes@{HYPERFRAMES}', 'snapshot', '.', '--at', f'{min(d - .1, last + .8):.2f}', '--no-end',
                            '--describe', 'false', '-o', str(f / 'snap')], cwd=f, capture_output=True)
            (out / 'png').mkdir(exist_ok=True)
            for p in sorted((f / 'snap').glob('*.png'))[:1]:
                shutil.copy2(p, out / 'png' / f'v{i:03d}_{blk["vid"]}.png')
            print(i, blk['vid'], flush=True)
        return 0
    work = ep / 'seg'
    work.mkdir(exist_ok=True)
    parts, total = [], 0.0
    for i in rng:
        blk, spec = blocks[i], vis[blocks[i]['vid']]
        folder = work / f'{i:03d}-{blk["vid"]}-{key([blk, spec, CODE])}'
        final = folder / 'segment.mp4'
        if not final.exists():
            folder.mkdir(parents=True, exist_ok=True)
            wav = folder / 'voice.wav'
            cues = speak(blk['sentences'], wav)
            (folder / 'cues.json').write_text(json.dumps(cues, ensure_ascii=False) + '\n', encoding='utf-8')
            if '--tts-only' in argv:
                print(f'[{i}] tts {wav_seconds(wav):.1f}s', flush=True)
                continue
            d = round(wav_seconds(wav) + .45, 3)
            sc, sb, sj = stage(spec, d, ep / 'img', ep / 'docs', cues)
            cb, cj = captions(cues, d, emph)
            page(folder / 'hf', f's{i}', d, '#stage{}' + sc, chrome(blk, spec) + f'<div id="stage">{sb}</div>' + cb, sj + cj, ep)
            hf_render(folder / 'hf', folder / 'screen.mp4')
            mux(folder / 'screen.mp4', wav, final, d)
            (folder / 'screen.mp4').unlink(missing_ok=True)
            shutil.rmtree(folder / 'hf' / 'img', ignore_errors=True)
            shutil.rmtree(folder / 'hf' / 'docs', ignore_errors=True)
        if final.exists():
            parts.append(final)
            total += float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(final)],
                                          capture_output=True, text=True).stdout or 0)
        print(f'[{i + 1}/{len(blocks)}] {blk["vid"]} {total / 60:.1f}분', flush=True)
    if '--tts-only' in argv or not parts:
        return 0
    lst = ep / 'concat.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    out = ep / (f'episode_{only}.mp4' if only else 'episode.mp4')
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst),
                    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', str(out)], check=True)
    print(out, f'{total / 60:.1f}분')
    return 0


if __name__ == '__main__':
    sys.exit(main())
