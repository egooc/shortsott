# -*- coding: utf-8 -*-
"""ko 기업 흥망 롱폼 조립기 — 원고(script.txt) + 장면표(visuals.json) + 장면 그림(img/) → episode.mp4

    python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01 [--only 0-5] [--tts-only] [--preview] [--no-gate]

화면 두 가지(기획 가이드 10-19 §2·§4 — 몰랐던 경제 문법, 복제 아님):
  pic      손그림 장면 그림 한 장을 천천히 밀거나 당긴다(ffmpeg, 장면 20~30초) + 투명 자막 판(하이퍼프레임)
  나머지   진녹색 도식 판 — 왼쪽 위 한 줄 제목 + 가운데 판. 판 종류는 연금 렌더러(ja-nenkin/render/nenkin_render.py)의
           stage() 를 import 해서 쓰고(title·cards·table·bars·list·flow), 기업 흥망 전용 판(year·split·org·calendar·chapter)만 여기 있다.
음성: Supertonic ko F2(무료 TTS 원칙). 숫자·연도·금액은 ko_say 가 한글 읽기로 바꿔 넣는다(자막은 아라비아 숫자).
출력: -14 LUFS(카이안 K12).
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'ja-nenkin' / 'render'))
sys.path.insert(0, str(HERE))
import nenkin_render as R  # noqa: E402  판·시계·하이퍼프레임 렌더 — import 만(고치지 않는다)
from ko_say import say  # noqa: E402

FPS = 30
CODE = '2026-10-22n'   # n: 레퍼런스 경제꽈배기 실측(줌 1.12·컷 9초·표 1.06) · m: 움직임 개편 · b: 판 글씨 키움(미리보기 1차)
SUPERTONIC = {'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic',
              'voice': 'F2', 'speed': 1.02, 'steps': 8, 'gap': 0.45, 'lang': 'ko', 'num_reading': False}
WORKER = ROOT / 'ja-nenkin' / 'render' / 'supertonic_worker.py'      # lang 키를 받는 판(정치 원본은 ko 고정) — import 경로만
FONT_K = ROOT / 'ko-truecrime' / 'render' / 'NotoSansKR-VF.ttf'
FONT_P = ROOT / 'politics-hour' / 'assets' / 'fonts' / 'Paperlogy-8ExtraBold.ttf'

# 진녹색 도식 판(가이드 §2: 도식 판은 진녹색 바탕 하나로 고정). 색은 우리 것.
GREEN, GREEN_D, LINE, CREAM, YELLOW, CORAL, MUTE = '#1F3D30', '#16302A', '#3E6B56', '#F4EEDC', '#F2C14E', '#E8735A', '#9FB8AA'
R.BLUE = R.AI = LINE
R.INK = R.SUMI = CREAM
R.RED = R.SHU = YELLOW
R.KIN = LINE
esc = lambda s: html.escape(str(s), quote=True)

CSS = f'''@font-face{{font-family:K;src:url(assets/K.ttf);font-weight:100 900}}
@font-face{{font-family:P;src:url(assets/P.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:1920px;height:1080px;overflow:hidden;font-family:K;color:{CREAM};word-break:keep-all}}
#root.board{{background:radial-gradient(ellipse at 50% 40%,{GREEN} 0%,{GREEN_D} 100%)}}
#root.board.clear{{background:transparent}}
#head{{position:absolute;left:84px;top:58px;font-family:P;font-size:46px;color:{YELLOW};letter-spacing:.01em;display:flex;align-items:center;gap:18px}}
#head::before{{content:"";width:10px;height:46px;background:{YELLOW};border-radius:3px}}
#src{{position:absolute;right:60px;top:66px;font-size:24px;font-weight:600;color:{MUTE}}}
#note{{position:absolute;right:60px;top:66px;font-size:24px;font-weight:600;color:#fff;background:rgba(0,0,0,.45);padding:4px 14px;border-radius:6px}}
#stage{{position:absolute;left:84px;right:84px;top:140px;bottom:200px}}
#scrim{{position:absolute;left:0;right:0;bottom:0;height:300px;background:linear-gradient(transparent,rgba(0,0,0,.62))}}
.cap{{position:absolute;left:80px;right:80px;bottom:58px;text-align:center;opacity:0}}
.cap span{{font-weight:800;font-size:60px;line-height:1.25;color:#fff;letter-spacing:-.01em;
  text-shadow:0 0 10px rgba(0,0,0,.85),0 3px 0 rgba(0,0,0,.9),2px 0 0 rgba(0,0,0,.6),-2px 0 0 rgba(0,0,0,.6)}}
.card{{background:rgba(255,255,255,.05);border:2px solid {LINE};border-radius:18px}}
em,.red{{font-style:normal;color:{YELLOW}}}
.k2{{color:{CORAL}}}
'''
# 연금 판(stage) 의 겉모습을 녹판에 맞춘다 — 판 css 뒤에 붙인다
THEME = f'''
#ti div{{font-family:P;color:{CREAM};letter-spacing:-.01em}}
#ti .k{{font-family:P;background:{YELLOW};color:{GREEN_D};border-radius:10px;font-size:56px;padding:4px 30px 8px}}
#cd .h,#ls .h{{display:block;color:{YELLOW};font-family:P;font-size:52px;padding:0 0 12px;margin-bottom:14px;border-bottom:2px solid {LINE}}}
#ls .it{{color:{CREAM}}} #ls .it i{{color:{YELLOW}}} #ls .it.dim{{color:{MUTE}}}
#cs .c{{background:rgba(255,255,255,.06);border:2px solid {LINE}}}
#cs .c small{{background:{LINE};color:{CREAM};font-family:K;font-weight:800}}
#cs .c b{{font-family:P;color:{CREAM};white-space:nowrap}}
#cs .c.r{{border-color:{YELLOW}}} #cs .c.r small{{background:{YELLOW};color:{GREEN_D}}} #cs .c.r b{{color:{YELLOW}}}
#cs .op{{color:{YELLOW};font-family:P}}
#nt{{color:{YELLOW}!important}}
#tb{{background:transparent!important}}
#tb th{{background:{LINE};color:{CREAM};font-family:K}}
#tb td{{color:{CREAM};border-bottom:2px solid {LINE}}}
#tb tr.hi td{{color:{YELLOW};background:rgba(242,193,78,.08)}}
#tt{{color:{YELLOW}!important;font-family:P}}
#bc .h{{color:{YELLOW}!important;font-family:P}} #bc .gl{{color:{CREAM}!important}} #bc .bn{{color:{MUTE}!important}}
#bc .bar{{background:{MUTE}}} #bc .bar.r{{background:{YELLOW}}} #bc .bv{{color:{CREAM}}} #bc .bv.r{{color:{YELLOW}}}
#fl .n{{background:{YELLOW};color:{GREEN_D};font-family:P;font-size:62px!important}} #fl .q{{color:{CREAM};font-size:86px!important}} #fl .a{{color:{YELLOW};font-size:70px!important}}
#fl{{width:1700px!important}}
#cd em,#ls em,#fl em{{background:linear-gradient(transparent 62%,rgba(242,193,78,.25) 62%) no-repeat;background-size:0% 100%}}
'''


# ---------- 원고·음성 ----------

def chunks(sentence, limit=24):
    """자막 덩어리(한 줄): 쉼표 구간마다, limit 자를 넘으면 같은 길이에 가깝게 공백에서 나눈다(«됐습니다» 홀로 남는 꼬리 방지)."""
    def balance(words):
        text = ' '.join(words)
        n = -(-len(text) // limit)
        if n <= 1:
            return [text]
        target, out, cur = len(text) / n, [], ''
        for w in words:
            if cur and len(cur) + 1 + len(w) / 2 > target and len(out) < n - 1:
                out.append(cur); cur = w
            else:
                cur = (cur + ' ' + w).strip()
        return out + [cur]
    pieces, cur = [], ''
    for piece in re.split(r'(?<=,)\s+', sentence.strip()):
        cur = (cur + ' ' + piece).strip()
        if len(cur) >= limit * .45:          # 짧은 쉼표 구간은 다음 구간과 붙인다
            pieces.append(cur); cur = ''
    if cur:
        if pieces and len(pieces[-1]) + len(cur) < limit:
            pieces[-1] += ' ' + cur
        else:
            pieces.append(cur)
    return [c.rstrip('.,') for p in pieces for c in balance(p.split(' '))]


def speak(sentences, out):
    job = dict(SUPERTONIC, out=str(Path(out).resolve()), sentences=[[say(s), chunks(s)] for s in sentences])
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(job, f, ensure_ascii=False)
    r = subprocess.run([SUPERTONIC['python'], str(WORKER), f.name], capture_output=True, text=True, encoding='utf-8',
                       env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    os.unlink(f.name)
    if r.returncode:
        raise SystemExit(r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def wav_seconds(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


def key(obj):
    return hashlib.sha1(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:10]


# ---------- 기업 흥망 전용 판 ----------

def stage(spec, d, cues):
    """(css, body, js). 연금 판에 없는 종류만 여기서, 나머지는 R.stage."""
    t = spec['type']
    ck = R.Clock(cues, d)
    js = []
    if t == 'chapter':         # 장 제목 — 그림 위 어두운 막 + 번호 + 제목
        css = f'''#chp{{position:absolute;inset:0;background:rgba(10,24,18,.62);display:flex;flex-direction:column;align-items:center;justify-content:center}}
#chp .n{{font-family:P;font-size:64px;color:{GREEN_D};background:{YELLOW};padding:2px 34px 8px;border-radius:12px}}
#chp .t{{font-family:P;font-size:128px;color:#fff;margin-top:26px;text-shadow:0 6px 24px rgba(0,0,0,.5)}}'''
        body = f'<div id="chp"><div class="n">{esc(spec["n"])}</div><div class="t">{esc(spec["title"])}</div></div>'
        js = ['tl.from("#chp",{opacity:0,duration:.5},0);', 'tl.from("#chp .n",{opacity:0,y:-20,duration:.45,ease:"power3.out"},.2);',
              'tl.from("#chp .t",{opacity:0,y:40,duration:.6,ease:"power3.out"},.35);',
              f'tl.to("#chp",{{opacity:0,duration:.5}},{max(1.6, d - .7):.2f});']
        return css, body, js
    if t == 'year':            # 연도 카드 — 큰 날짜 + 한 줄 사건(가이드 §2 «1972년 8월 3일 정부가 …»)
        lines = spec.get('lines', [])
        css = f'''#yr{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
#yr .d{{font-family:P;font-size:{spec.get("size", 150)}px;color:{YELLOW};letter-spacing:-.02em;line-height:1.05}}
#yr .l{{font-weight:800;font-size:66px;line-height:1.3;margin-top:30px;color:{CREAM};max-width:1560px}}
#yr .s{{font-weight:600;font-size:40px;color:{MUTE};margin-top:18px}}
#yr .bar{{width:220px;height:6px;background:{LINE};margin:34px auto 0}}'''
        body = f'<div id="yr"><div class="d">{spec["date"]}</div><div class="bar"></div>' + ''.join(
            f'<div class="l" id="y{i}">{ln}</div>' for i, ln in enumerate(lines)) + (f'<div class="s" id="ys">{esc(spec["sub"])}</div>' if spec.get('sub') else '') + '</div>'
        js = ['tl.from("#yr .d",{opacity:.4,scale:1.08,duration:.6,ease:"power3.out"},0);', 'tl.from("#yr .bar",{scaleX:0,duration:.5,ease:"power2.out"},.3);']
        prev = .6
        for i, ln in enumerate(lines):
            a = .7 if i == 0 else max(prev, ck.at((spec.get('at') or [None] * 9)[i] if spec.get('at') else None, ln, prev + .8))
            js.append(f'tl.from("#y{i}",{{opacity:0,y:24,duration:.45,ease:"power3.out"}},{a:.2f});')
            prev = a + .4
        if spec.get('sub'):
            js.append(f'tl.from("#ys",{{opacity:0,duration:.4}},{max(prev, ck.at(None, spec["sub"], prev + .6)):.2f});')
        return css, body, js
    if t == 'split':           # 두 갈래 비교판 — 뿌리 하나에서 두 줄기, 줄기마다 단계가 말 순서대로
        L, Rt = spec['left'], spec['right']
        css = f'''#sp{{position:absolute;inset:0}}
#sp .root{{position:absolute;left:0;right:0;top:60px;margin:auto;width:max-content;padding:14px 50px 20px;font-weight:900;font-size:66px;
  background:{LINE};border-radius:14px;color:{CREAM}}}
#sp svg{{position:absolute;left:0;top:176px;width:100%;height:114px}}
#sp .col{{position:absolute;top:270px;width:840px;box-sizing:border-box;padding:28px 44px 34px}}
#sp .col.l{{left:0}} #sp .col.r{{right:0}}
#sp .col h3{{margin:0 0 18px;font-family:P;font-weight:400;font-size:72px}}
#sp .col.l h3{{color:{YELLOW}}} #sp .col.r h3{{color:{CORAL}}}
#sp .col .it{{font-weight:800;font-size:{54 if max(len(L['items']), len(Rt['items'])) > 2 else 60}px;line-height:1.3;margin:10px 0;color:{CREAM}}}
#sp .col .it::before{{content:"↓ ";color:{MUTE}}}
#sp .col .it:first-of-type::before{{content:""}}
#sp .end{{font-weight:900}}'''
        def col(c, side):
            return (f'<div class="col card {side}" id="c{side}"><h3>{esc(c["title"])}</h3>' +
                    ''.join(f'<div class="it" id="{side}{i}">{x}</div>' for i, x in enumerate(c['items'])) + '</div>')
        body = (f'<div id="sp"><div class="root" id="rt">{esc(spec["root"])}</div>'
                f'<svg viewBox="0 0 1752 114" preserveAspectRatio="none"><path id="pl" d="M876 0 V30 H420 V114" fill="none" stroke="{YELLOW}" stroke-width="5"/>'
                f'<path id="pr" d="M876 0 V30 H1332 V114" fill="none" stroke="{CORAL}" stroke-width="5"/></svg>' + col(L, 'l') + col(Rt, 'r') + '</div>')
        js = ['tl.from("#rt",{opacity:.4,y:-16,duration:.45},0);',
              'tl.fromTo("#pl",{strokeDasharray:700,strokeDashoffset:700},{strokeDashoffset:0,duration:.6},.35);',
              'tl.fromTo("#pr",{strokeDasharray:700,strokeDashoffset:700},{strokeDashoffset:0,duration:.6},.35);',
              'tl.from("#cl",{opacity:0,y:20,duration:.4},.8);', 'tl.from("#cr",{opacity:0,y:20,duration:.4},.95);']
        prev = 1.0
        order = spec.get('order') or [('l', i) for i in range(len(L['items']))] + [('r', i) for i in range(len(Rt['items']))]
        for side, i in order:
            item = (L if side == 'l' else Rt)['items'][i]
            a = max(prev, ck.at(None, item, prev + .6)) if not spec.get('all_at_once') else 1.0
            js.append(f'tl.from("#{side}{i}",{{opacity:0,x:{-24 if side == "l" else 24},duration:.4,ease:"power2.out"}},{a:.2f});')
            prev = a + .3
        return css, body, js
    if t == 'org':             # 조직도 — 맨 위 회사 하나, 아래로 계열사가 말 순서대로 붙는다
        kids = spec['kids']
        css = f'''#og{{position:absolute;inset:0}}
#og .top{{position:absolute;left:0;right:0;top:20px;margin:auto;width:max-content;padding:16px 56px 20px;font-family:P;font-size:64px;
  background:{YELLOW};color:{GREEN_D};border-radius:14px}}
#og .ln{{position:absolute;left:120px;right:120px;top:200px;height:4px;background:{LINE};transform-origin:center}}
#og .row{{position:absolute;left:0;right:0;top:260px;display:flex;flex-wrap:wrap;justify-content:center;gap:30px 30px}}
#og .kid{{width:{spec.get("kw", 520)}px;padding:26px 10px 30px;text-align:center;font-weight:800;font-size:60px;color:{CREAM}}}
#og .kid small{{display:block;font-size:30px;color:{MUTE};font-weight:600;margin-top:6px}}
#og .kid.hi{{border-color:{CORAL};color:{CORAL}}}'''
        body = f'<div id="og"><div class="top" id="otop">{esc(spec["top"])}</div><div class="ln" id="oln"></div><div class="row">' + ''.join(
            f'<div class="kid card{" hi" if k.get("hi") else ""}" id="k{i}">{esc(k["name"])}' + (f'<small>{esc(k["sub"])}</small>' if k.get('sub') else '') + '</div>'
            for i, k in enumerate(kids)) + '</div></div>'
        js = ['tl.from("#otop",{opacity:.4,y:-20,duration:.5,ease:"power3.out"},0);', 'tl.from("#oln",{scaleX:0,duration:.5},.4);']
        prev = .6
        for i, k in enumerate(kids):
            a = max(prev, ck.at(k.get('kw'), k['name'], prev + .35))
            js.append(f'tl.from("#k{i}",{{opacity:0,y:20,duration:.35,ease:"power2.out"}},{a:.2f});')
            prev = a + .2
        return css, body, js
    if t == 'calendar':        # 만기 달력 — 달마다 갚을 날짜 점이 찍히고, 몰린 달은 산호색
        ms = spec['months']
        css = f'''#ca{{position:absolute;inset:0;display:grid;grid-template-columns:repeat(6,1fr);gap:22px;align-content:center}}
#ca .m{{padding:18px 22px 24px;min-height:330px}}
#ca .m b{{display:block;font-family:P;font-weight:400;font-size:64px;color:{CREAM};margin-bottom:12px}}
#ca .m.hi{{border-color:{CORAL}}} #ca .m.hi b{{color:{CORAL}}}
#ca .dot{{display:inline-block;width:42px;height:42px;border-radius:50%;background:{MUTE};margin:6px}}
#ca .m.hi .dot{{background:{CORAL}}}
#ca .tag{{display:block;font-weight:800;font-size:38px;color:{YELLOW};margin-top:8px}}'''
        body = '<div id="ca">' + ''.join(
            f'<div class="m card{" hi" if m.get("hi") else ""}" id="m{i}"><b>{esc(m["m"])}</b>' + ''.join(f'<i class="dot" id="m{i}d{k}"></i>' for k in range(m.get('dots', 0)))
            + (f'<span class="tag">{esc(m["tag"])}</span>' if m.get('tag') else '') + '</div>' for i, m in enumerate(ms)) + '</div>'
        js = [f'tl.from("#m{i}",{{opacity:.3,duration:.3}},{.05 + i * .06:.2f});' for i in range(len(ms))]
        t0 = 1.0
        span = max(2.0, d * .6)
        allk = [(i, k) for i, m in enumerate(ms) for k in range(m.get('dots', 0))]
        for n, (i, k) in enumerate(allk):
            js.append(f'tl.from("#m{i}d{k}",{{scale:0,duration:.25,ease:"back.out(3)"}},{t0 + span * n / max(1, len(allk)):.2f});')
        return css, body, js
    return R.stage(spec, d, None, None, cues)


def chrome(spec):
    body = ''
    if spec.get('label'):
        body += f'<div id="head">{esc(spec["label"])}</div>'
    if spec.get('source'):
        body += f'<div id="src">자료: {esc(spec["source"])}</div>'
    if spec.get('badge'):
        body += f'<div id="note">{esc(spec["badge"])}</div>'
    return body


def captions(cues, d, emph=()):
    body, js = '', []
    for i, (a, b, text) in enumerate(cues):
        tx = esc(text)
        for w in sorted(emph, key=len, reverse=True):
            tx = tx.replace(esc(w), f'<em>{esc(w)}</em>')
        body += f'<div class="cap" id="c{i}"><span>{tx}</span></div>'
        end = cues[i + 1][0] if i + 1 < len(cues) else d
        start = max(0.0, a - 2 / FPS) if i == 0 else a
        js.append(f'tl.set("#c{i}",{{opacity:1}},{start:.3f});' + (f'tl.set("#c{i}",{{opacity:0}},{end:.3f});' if i + 1 < len(cues) else ''))
    return body, js


def page(folder, cid, d, css, body, js, board):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    for src, name in ((FONT_K, 'K.ttf'), (FONT_P, 'P.ttf'), (R.GSAP, 'gsap.min.js')):
        if not (folder / 'assets' / name).exists():
            shutil.copy2(src, folder / 'assets' / name)
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{CSS}{css}{THEME}</style></head><body>'
        f'<div id="root" class="{"board clear" if board == "clear" else "board" if board else ""}" data-composition-id="{cid}" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
        f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{body}</section></div>'
        f'<script src="assets/gsap.min.js"></script><script>const tl=gsap.timeline({{paused:true}});{R.COUNT_JS}{"".join(js)}'
        f'window.__timelines=window.__timelines||{{}};window.__timelines["{cid}"]=tl;</script></body></html>', encoding='utf-8')


def hf_render(folder, out, fmt):
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    tmp = Path(folder) / 'tmp'
    tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMP=str(tmp), TEMP=str(tmp))
    name = f'screen.{fmt}'
    cmd = [npx, '--yes', f'hyperframes@{R.HYPERFRAMES}', 'render', '.', '--format', fmt, '--fps', str(FPS),
           '--workers', '4', '--output', name, '--quiet', '--frames-cache-dir', 'off']
    if subprocess.run(cmd, cwd=folder, env=env).returncode:
        shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir(exist_ok=True)
        cmd[cmd.index('--workers') + 1] = '1'
        subprocess.run(cmd, cwd=folder, check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.move(str(Path(folder) / name), out)


MOVES = ['in', 'right', 'out', 'left']
# 움직임(소유주 10-22 «영상이 움직이질 않아»·관리자 레퍼런스 경제꽈배기 실측): 그림 8~9초마다 바뀜 · 컷 안에서 1.00↔1.12 · 방향 교대
ZOOM, PAN_Z = (1.0, 1.12), 1.12            # 옆 이동은 1.12 로 키운 채 (iw-iw/1.12)=10.7% 를 가로지른다
SHOT_MAX, INTRO_SHOT, INTRO_SEC = 9.0, 5.0, 60.0    # 그림 한 컷 최대 9초 · 첫 60초는 5초 안팎
BOARD_ZOOM = (1.0, 1.06)                   # 숫자·도표 카드 배경 밀어 넣기
SSIM_STILL = 0.95                          # 장면 첫·끝 프레임 SSIM 이 이 이상이면 정지(종료 4)


def ken_burns(img, d, move, out, focus=0.5, zoom=ZOOM, n=None):
    """그림 한 장 → d 초 영상. 당기거나(in/out) 옆으로 민다(left/right). focus = 줌 중심 가로 위치(0~1)·옆 이동의 세로 위치.
    2배로 키운 뒤 잘라 움직임이 계단처럼 떨리지 않게 한다."""
    n = n or int(round(d * FPS))
    W, H = 3840, 2160
    a, b = zoom
    z0, z1 = {'in': (a, b), 'out': (b, a), 'left': (PAN_Z, PAN_Z), 'right': (PAN_Z, PAN_Z)}[move]
    zx = f'({z0}+({z1}-{z0})*on/{max(1, n - 1)})'
    if move in ('left', 'right'):
        p = f'(on/{max(1, n - 1)})' if move == 'right' else f'(1-on/{max(1, n - 1)})'
        x, y = f'(iw-iw/zoom)*{p}', f'(ih-ih/zoom)*{focus}'
    else:
        x, y = f'(iw-iw/zoom)*{focus}', 'ih/2-(ih/zoom/2)'
    vf = (f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},'
          f"zoompan=z='{zx}':x='{x}':y='{y}':d=1:s=1920x1080:fps={FPS},setsar=1")
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-loop', '1', '-framerate', str(FPS), '-t', f'{d:.3f}', '-i', str(img),
                    '-vf', vf, '-frames:v', str(n), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', str(out)], check=True)


def bg_shots(imgs, d, i, out, max_shot=SHOT_MAX, zoom=ZOOM, moves=MOVES):
    """장면 배경을 max_shot 초 이하 컷 여러 개로 — 그림이 여러 장이면 돌려 쓰고, 한 장이면 다른 부분(focus)을 잡는다. 컷마다 방향을 바꾼다."""
    n = int(round(d * FPS))
    k = max(1, -(-n // int(max_shot * FPS)))
    frames = [n // k + (1 if j < n % k else 0) for j in range(k)]
    parts = []
    for j, fn in enumerate(frames):
        p = Path(out).with_name(f'shot{j}.mp4')
        ken_burns(imgs[j % len(imgs)], fn / FPS, moves[(i + j) % len(moves)], p, focus=(0.5, 0.2, 0.8)[(i + j) % 3], zoom=zoom, n=fn)
        parts.append(p)
    if k == 1:
        shutil.move(str(parts[0]), out)
        return k
    lst = Path(out).with_name('shots.txt')
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(out)], check=True)
    for p in parts + [lst]:
        p.unlink(missing_ok=True)
    return k


def board_bg():
    """표·도표 배경 그림(한 번만) — 녹색 방사 그라데이션 + 큰 흐린 원 몇 개(평면·무질감, 움직임이 눈에 보이게)."""
    out = HERE / 'board_bg.png'
    if out.exists():
        return out
    from PIL import Image, ImageDraw, ImageFilter
    W, H = 3840, 2160
    hx = lambda c: tuple(int(c[k:k + 2], 16) for k in (1, 3, 5))
    g0, g1, ln = hx(GREEN), hx(GREEN_D), hx(LINE)
    im = Image.radial_gradient('L').resize((W, H))
    base = Image.composite(Image.new('RGB', (W, H), g1), Image.new('RGB', (W, H), g0), im)
    lay = Image.new('L', (W, H), 0)
    dr = ImageDraw.Draw(lay)
    for cx, cy, r in ((600, 500, 520), (3300, 700, 640), (2200, 1900, 560), (1200, 1750, 380), (2900, 1500, 300)):
        dr.ellipse((cx - r, cy - r, cx + r, cy + r), fill=70)
    lay = lay.filter(ImageFilter.GaussianBlur(14))
    base = Image.composite(Image.new('RGB', (W, H), ln), base, lay)
    base.save(out)
    return out


def motion_gate(seg, folder, shots=None):
    """장면 첫·끝 프레임 SSIM(아래 자막 300px 뺀 위쪽) — SSIM_STILL 이상이면 정지로 보고 종료 4. 정지 화면은 folder 에 남긴다(증명용)."""
    f0, f1 = folder / 'first.png', folder / 'last.png'
    crop = 'crop=1920:780:0:0'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(seg), '-vf', crop, '-frames:v', '1', str(f0)], check=True)
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-sseof', '-0.2', '-i', str(seg), '-vf', crop, '-update', '1', str(f1)], check=True)
    r = subprocess.run(['ffmpeg', '-nostdin', '-i', str(f0), '-i', str(f1), '-lavfi', 'ssim', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'All:([\d.]+)', r.stderr)
    s = float(m.group(1)) if m else 1.0
    (folder / 'motion.json').write_text(json.dumps({'ssim': s, 'shots': shots}) + '\n', encoding='utf-8')
    return s


def mux(video, wav, out, d, overlay=None):
    fc = f'[1:a]apad=whole_dur={d:.3f},aresample=48000[a]'
    inputs = ['-i', str(video), '-i', str(wav)]
    vmap = '0:v'
    if overlay:
        inputs += ['-i', str(overlay)]
        fc = f'[0:v][2:v]overlay=format=auto,setsar=1[v];' + fc
        vmap = '[v]'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *inputs, '-filter_complex', fc, '-map', vmap, '-map', '[a]',
                    '-t', f'{d:.3f}', '-r', str(FPS), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', str(out)], check=True)


def scene_html(spec, d, cues, emph):
    """(css, body, js, board) — pic·chapter 는 투명 판(그림 위), 나머지는 녹판."""
    cb, cj = captions(cues, d, emph)
    if spec['type'] == 'pic':
        return '', chrome(spec) + '<div id="scrim"></div>' + cb, cj, False
    sc, sb, sj = stage(spec, d, cues)
    if spec['type'] == 'chapter':
        return sc, sb + '<div id="scrim"></div>' + cb, sj + cj, False
    return sc, chrome(spec) + f'<div id="stage">{sb}</div>' + cb, R.transitions(d) + R.no_blank(sj) + cj, True


def seg_dir(ep, i, blk, spec):
    """장면 조각 폴더 — 원고·판·렌더 코드가 같으면 같은 폴더(다시 만들지 않는다)."""
    return Path(ep) / 'seg' / f'{i:03d}-{blk["vid"]}-{key([blk, spec, CODE, SUPERTONIC])}'


def voice_dir(ep, blk):
    """음성 폴더 — 문장·음성 설정·숫자 읽기만으로 정한다(판을 고쳐도 음성은 다시 만들지 않는다). audit.py 도 이것으로 찾는다."""
    return Path(ep) / 'voice' / f'{blk["vid"]}-{key([blk["sentences"], SUPERTONIC, [say(s) for s in blk["sentences"]]])}'


def script_gates(ep):
    """TTS 전 원고 관문(관리자 10-20 «게이트 없는 원칙은 미적용»): 레퍼런스 문장 일치 0건 · 원고 검수 △ 0 · 댓글 장치 통과. 하나라도 걸리면 중단."""
    py, sc = [sys.executable, '-X', 'utf8'], ROOT / 'scripts'
    script = ep / 'script.txt'
    r = subprocess.run(py + [str(sc / 'ref_overlap.py'), str(script), '--lane', 'corp_ko'], capture_output=True, text=True, encoding='utf-8')
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip(), flush=True)
    if r.returncode:
        raise SystemExit(f'ref_overlap 종료 {r.returncode} — TTS 중단\n{r.stdout}')
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / 'audit.json'
        r = subprocess.run(py + [str(sc / 'script_audit.py'), str(script), '--lane', 'corp_ko', '--jargon', str(ROOT / 'ko-corp' / 'jargon.json'),
                                 '--names', str(ep / 'names.json'), '--json', str(out)], capture_output=True, text=True, encoding='utf-8')
        warn = json.loads(out.read_text(encoding='utf-8')).get('warnings') if out.exists() else None
    wf = ep / 'gate_waive.json'  # 관리자가 그 편만 면제한 경고 코드(예: ep01 은 V12·V14 이전 원고 — 관리자 10-20 «ep01 은 13시 합성 그대로»)
    waive = json.loads(wf.read_text(encoding='utf-8')) if wf.exists() else {}
    if warn:
        skip = [w for w in warn if w.get('code') in waive.get('codes', [])]
        warn = [w for w in warn if w not in skip]
        for w in skip:
            print(f'script_audit 면제 [{w["code"]}] {w["msg"]} — {waive.get("why", "")}', flush=True)
    print(f'script_audit 경고 {len(warn) if warn is not None else "?"}건', flush=True)
    if r.returncode or warn is None or warn:
        raise SystemExit(f'script_audit 종료 {r.returncode}·경고 {warn} — TTS 중단\n{r.stdout}')
    r = subprocess.run(py + [str(sc / 'comment_hook.py'), str(ep), '--lane', 'generic', '--spec', str(ep / 'packages.json'), '--script', str(script)],
                       capture_output=True, text=True, encoding='utf-8')
    print(r.stdout.strip().splitlines()[0] if r.stdout.strip() else r.stderr.strip(), flush=True)
    if r.returncode:
        raise SystemExit(f'comment_hook 종료 {r.returncode} — TTS 중단\n{r.stdout}')
    from fact_gate import gate  # 불확실 팩트 0건(관리자 10-21 G4, 10-23 부터 막음)
    gate(ep)


LOCK = ROOT / 'politics-hour' / 'RENDERING.lock'   # 레인 공용 «무거운 작업 한 자리»(라벨 무관)


def take_lock(ep, only):
    """RENDERING.lock 을 이 렌더 이름으로 쓰고, 끝나거나 멈추면(종료 4 포함) 내 것일 때만 지운다."""
    import atexit
    import time
    if LOCK.exists():
        raise SystemExit(f'RENDERING.lock 있음 — 시작 안 함: {LOCK.read_text(encoding="utf-8").strip()}')
    LOCK.write_text(json.dumps({'pid': os.getpid(), 'episode': f'corp {Path(ep).name}' + (f' --only {only}' if only else ''),
                                'started': time.strftime('%Y-%m-%d %H:%M'), 'expect_hours': 2}, ensure_ascii=False) + '\n', encoding='utf-8')

    def release():
        try:
            if json.loads(LOCK.read_text(encoding='utf-8')).get('pid') == os.getpid():
                LOCK.unlink()
        except (OSError, ValueError):
            pass
    atexit.register(release)


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    only = argv[argv.index('--only') + 1] if '--only' in argv else None
    blocks = R.parse_script(ep / 'script.txt')
    vis = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
    emph = vis.pop('_emph', [])
    miss = [b['vid'] for b in blocks if b['vid'] not in vis]
    if miss:
        raise SystemExit('visuals.json 에 없는 화면: ' + ', '.join(miss))
    nopic = [v for v, s in vis.items() if s.get('img') and not (ep / 'img' / s['img']).exists()]
    rng = range(len(blocks)) if not only else range(int(only.split('-')[0]), min(len(blocks), int(only.split('-')[-1]) + 1))
    if '--preview' in argv:            # TTS 없이 정지 화면만 — 글자 수로 시각을 어림한다
        out = ep / 'preview'
        (out / 'png').mkdir(parents=True, exist_ok=True)
        npx = shutil.which('npx.cmd') or shutil.which('npx')
        for i in rng:
            blk, spec = blocks[i], vis[blocks[i]['vid']]
            cues, t = [], 0.0
            for s in blk['sentences']:
                for c in chunks(s):
                    d0 = max(1.2, len(c) / 6.5)
                    cues.append([round(t, 2), round(t + d0, 2), c]); t += d0
                t += .45
            d = round(t + .45, 3)
            css, body, js, board = scene_html(spec, d, cues, emph)
            f = out / f'{i:03d}'
            page(f, f's{i}', d, css, body, js, board)
            at = min(d - .1, max((a for a, b, x in cues), default=d * .8) + .5)
            subprocess.run([npx, '--yes', f'hyperframes@{R.HYPERFRAMES}', 'snapshot', '.', '--at', f'{at:.2f}', '--no-end',
                            '--describe', 'false', '-o', str(f / 'snap')], cwd=f, capture_output=True)
            snaps = sorted((f / 'snap').glob('*.png'))[:1]
            for p in snaps:
                dst = out / 'png' / f'v{i:03d}_{blk["vid"]}.png'
                if spec.get('img') and (ep / 'img' / spec['img']).exists():     # 그림 장면은 그림 위에 판을 얹어 본다
                    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(ep / 'img' / spec['img']), '-i', str(p), '-filter_complex',
                                    '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080[b];[b][1:v]overlay', '-frames:v', '1', str(dst)], check=True)
                else:
                    shutil.copy2(p, dst)
            print(i, blk['vid'], flush=True)
        return 0
    if nopic and '--tts-only' not in argv:
        raise SystemExit('그림 없음: ' + ', '.join(nopic))
    script_gates(ep)
    if '--no-gate' not in argv:
        R.wait_gate()
    take_lock(ep, only)   # 시험 렌더도 락을 잡는다(관리자 §7 10-22 23:3x), 끝나면 지운다
    work = ep / 'seg'
    work.mkdir(exist_ok=True)
    parts, total = [], 0.0
    start = sum(wav_seconds(voice_dir(ep, b) / 'voice.wav') + .45 for b in blocks[:rng.start] if (voice_dir(ep, b) / 'voice.wav').exists())
    for i in rng:
        blk, spec = blocks[i], vis[blocks[i]['vid']]
        folder = seg_dir(ep, i, blk, spec)
        final, shots = folder / 'segment.mp4', None
        if not final.exists():
            vd = voice_dir(ep, blk)
            vd.mkdir(parents=True, exist_ok=True)
            wav = vd / 'voice.wav'
            if wav.exists() and (vd / 'cues.json').exists():
                cues = json.loads((vd / 'cues.json').read_text(encoding='utf-8'))
            else:
                cues = speak(blk['sentences'], wav)
                (vd / 'cues.json').write_text(json.dumps(cues, ensure_ascii=False) + '\n', encoding='utf-8')
            if '--tts-only' in argv:
                print(f'[{i}] tts {wav_seconds(wav):.1f}s', flush=True)
                continue
            folder.mkdir(parents=True, exist_ok=True)
            d = round(wav_seconds(wav) + .45, 3)
            css, body, js, board = scene_html(spec, d, cues, emph)
            page(folder / 'hf', f's{i}', d, css, body, js, 'clear' if board else False)
            if board:   # 표·도표: 투명 판 + 천천히 밀어 넣는 녹색 배경(한 컷)
                shots = bg_shots([board_bg()], d, i, folder / 'bg.mp4', max_shot=d + 1, zoom=BOARD_ZOOM, moves=('in', 'out'))
            else:       # 그림: 컷 최대 10초(첫 60초는 5초), 컷마다 방향 교대 — imgs 가 있으면 돌려 쓴다
                imgs = [ep / 'img' / x for x in spec.get('imgs', [spec['img']])]
                shots = bg_shots(imgs, d, i, folder / 'bg.mp4', max_shot=INTRO_SHOT if start < INTRO_SEC else SHOT_MAX)
            hf_render(folder / 'hf', folder / 'overlay.mov', 'mov')
            mux(folder / 'bg.mp4', wav, final, d, folder / 'overlay.mov')
            for x in ('bg.mp4', 'overlay.mov'):
                (folder / x).unlink(missing_ok=True)
        mj = folder / 'motion.json'
        ssim = json.loads(mj.read_text(encoding='utf-8'))['ssim'] if mj.exists() else motion_gate(final, folder, shots) if final.exists() else None
        if ssim is not None and ssim >= SSIM_STILL and '--tts-only' not in argv:
            print(f'[{i}] {blk["vid"]} 첫·끝 프레임 SSIM {ssim:.3f} ≥ {SSIM_STILL} — 정지 화면(관리자 10-22), 종료 4 — {folder}', flush=True)
            raise SystemExit(4)
        start += wav_seconds(voice_dir(ep, blk) / 'voice.wav') + .45 if (voice_dir(ep, blk) / 'voice.wav').exists() else 0
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
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', str(out)], check=True)
    sys.path.insert(0, str(ROOT / 'scripts'))
    import loudnorm_final               # 공용 2패스 −14 LUFS(카이안 K12) — import 만
    print(out, f'{total / 60:.1f}분', loudnorm_final.normalize(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
