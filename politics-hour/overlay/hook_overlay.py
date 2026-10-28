"""롱폼 첫 15~20초 «몽타주 훅»(type 'hook') — 해설 TTS 반어·대구 2~4구 + 약 1초 1컷 얼굴·자료 장면 + 손그림 효과.

10-28 소유주: «시사썰전(@sisassuljun) 편집 스타일을 롱폼 초반 훅으로». 그 채널의 첫 9초 결(구마다 다른 얼굴 컷·«?!» 스티커·
손글씨 속마음·물음표 실루엣·빨간 화살표·작은 빨강/검정 이름표·맥락 꼬리표·1~2어절 자막)을 16:9 로 옮겼다.
그래픽은 전부 여기서 그린다(남의 에셋 복사 없음). «쉽고 유쾌한» 아래 띠는 쓰지 않는다. 질감 없음(소유주 «세련·평면»).

seg(episode.json):
{"type": "hook",
 "text": "아파서 나가고 싶다는데. 구속은 두 달 더. ...",      # 관문용(욕설·팩트·시작 관문 길이 추정) — lines 의 say 를 이은 것
 "title": ["김건희 추가 구속", "“영부인이었을 때 좀 잘 좀 하지”"],   # 위 고정 제목 바(흰 줄 + 노랑 줄)
 "gap": 0.35, "speed": 0.9,                                # 구 사이 숨(초)·말 빠르기(해설 1.05보다 느리게 — 1.05 는 4구가 5.2초라 컷이 0.3초로 쪼개졌다)
 "lines": [{"say": "아파서 나가고 싶다는데", "caps": ["*아파서*", "나가고 싶다는데..?"]}, ...],
          # caps = 1~2어절 자막 덩어리, *낱말* 노랑·#낱말# 빨강. 소리 시각은 구마다 합성 길이를 글자 수 비율로 나눈다.
 "cuts": [{"at": 0, "src": "src/ME3KPjbEsLE_0.mp4", "t": 84.3, "crop": [x, y, w, h],   # 원본 1920x1080 기준 창(16:9)
           "source": "영상: JTBC 뉴스 2026.10.27",            # 컷마다 왼쪽 아래 출처(지우지 않는다)
           "sticker": {"text": "?!", "x": 1400, "y": 260, "rot": 8},
           "note": {"text": "억울하다..", "x": 1300, "y": 520},          # 손글씨 속마음(작게)
           "name": {"lines": ["김건희", "10.27 대법원 영장 심사"], "x": 120, "y": 640},   # 빨강·검정 상자
           "tag": {"lines": ["구속만료", "D-4"], "x": 300, "y": 300},      # 맥락 꼬리표
           "arrow": {"from": [x, y], "to": [x, y]},                        # 빨간 화살표
           "silhouette": {"x": 960, "y": 560}, "dim": true}, ...]}       # 물음표 실루엣(정체 숨김)·배경 흐림
 cut["at"] = 이 컷이 시작하는 자막 덩어리 번호(전체 caps 순서). 첫 컷은 0.
"""
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import chrome
from config import ASSETS, SUPERTONIC

FPS = 30
TAIL = .25                       # 마지막 구 뒤 숨(다음 원음으로 바로)
YEL, RED, INK, NAVY = '#F5C518', '#E61E2B', '#0b0f1c', '#10131c'
POP = ASSETS / 'sfx' / 'pop.wav'  # 직접 합성(사인 하강음) — 스티커가 튈 때
esc = lambda s: html.escape(str(s), quote=True)


def _plain(c):
    return re.sub(r'[*#]', '', c)


def pop_sfx():
    if not POP.exists():
        POP.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        "aevalsrc='0.6*sin(2*PI*(250*t+650*0.03*(1-exp(-t/0.03))))*exp(-t/0.05)':s=48000:d=0.18",
                        '-ac', '2', str(POP)], check=True)
    return POP


def speak(seg, out, say=None):
    """구마다 Supertonic(기존 해설과 같은 목소리·속도)으로 합성 → (길이, 자막 큐 [(시작, 끝, 표시 문구)])."""
    parts = [[_plain(c) for c in ln['caps']] for ln in seg['lines']]
    job = dict(SUPERTONIC, out=str(Path(out).resolve()), gap=float(seg.get('gap', .35)), speed=float(seg.get('speed', .9)),
               sentences=[[say(ln['say']) if say else ln['say'], p] for ln, p in zip(seg['lines'], parts)])
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(job, f, ensure_ascii=False)
    try:
        res = subprocess.run([SUPERTONIC['python'], str(Path(__file__).with_name('supertonic_worker.py')), f.name],
                             capture_output=True, text=True, encoding='utf-8', check=True,
                             env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    finally:
        Path(f.name).unlink(missing_ok=True)
    raw = json.loads(res.stdout.strip().splitlines()[-1])
    shown = [c for ln in seg['lines'] for c in ln['caps']]
    return [(a, b, s) for (a, b, _), s in zip(raw, shown)]


def cut_times(seg, cues, d):
    """컷 창 [(시작, 끝)]. 하이퍼프레임 렌더가 GSAP 시각보다 한 프레임 늦게 잡혀(10/29 시안 실측 97번 프레임) 숨김은 1.5프레임 앞당긴다."""
    starts = [0.0 if c['at'] == 0 else round(cues[c['at']][0] * FPS) / FPS for c in seg['cuts']]   # 프레임 격자에 맞춘다(컷과 그래픽이 한 프레임 어긋나지 않게)
    return [(a, (starts[i + 1] if i + 1 < len(starts) else d)) for i, a in enumerate(starts)]


def _cap_html(c):
    c = esc(c)
    c = re.sub(r'\*([^*]+)\*', r'<b class="y">\1</b>', c)
    return re.sub(r'#([^#]+)#', r'<b class="r">\1</b>', c)


SIL = ('<svg viewBox="0 0 400 460" width="400" height="460"><path d="M200 40c62 0 104 46 104 112s-42 122-104 122S96 218 96 152 138 40 200 40z" '
       f'fill="{NAVY}" stroke="#fff" stroke-width="8"/><path d="M20 460c8-110 84-170 180-170s172 60 180 170z" fill="{NAVY}" stroke="#fff" '
       'stroke-width="8"/><text x="200" y="215" text-anchor="middle" font-family="Aggro" font-size="170" fill="#fff">?</text></svg>')


def build(spec, folder):
    """spec = seg + duration·cues·windows·brand·date. 투명 오버레이 index.html(하이퍼프레임)."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    shutil.copy2(ASSETS / 'gsap.min.js', folder / 'assets' / 'gsap.min.js')
    for f in ('Paperlogy-8ExtraBold.ttf', 'ROKAFSansMedium.ttf', 'SBAggroB.ttf', 'BMYEONSUNG.ttf'):
        shutil.copy2(ASSETS / 'fonts' / f, folder / 'assets' / f)
    d = float(spec['duration'])
    css = f'''
@font-face{{font-family:Paper;src:url(assets/Paperlogy-8ExtraBold.ttf)}}
@font-face{{font-family:Body;src:url(assets/ROKAFSansMedium.ttf)}}
@font-face{{font-family:Aggro;src:url(assets/SBAggroB.ttf)}}
@font-face{{font-family:Hand;src:url(assets/BMYEONSUNG.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:1920px;height:1080px;overflow:hidden;word-break:keep-all}}
#shade{{position:absolute;left:0;right:0;bottom:0;height:380px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.62))}}
#title{{position:absolute;left:40px;top:28px;padding:12px 24px 14px;background:rgba(11,15,28,.9);border-left:8px solid {YEL};border-radius:4px;
  font-family:Paper;line-height:1.12;z-index:6}}
#title .a{{font-size:40px;color:#fff}} #title .b{{font-size:46px;color:{YEL}}}
.cap{{position:absolute;left:0;right:0;bottom:130px;text-align:center;font-family:Aggro;font-size:118px;line-height:1.05;letter-spacing:-3px;color:#fff;
  -webkit-text-stroke:16px #000;paint-order:stroke fill;opacity:0;z-index:7}}
.cap .y{{color:{YEL};font-weight:inherit}} .cap .r{{color:{RED};font-weight:inherit}}
.src{{position:absolute;left:40px;bottom:30px;font-family:Body;font-size:22px;color:rgba(255,255,255,.9);background:rgba(0,0,0,.5);
  padding:4px 12px;border-radius:4px;opacity:0;z-index:8}}
.stk{{position:absolute;font-family:Aggro;font-size:230px;line-height:1;color:#fff;-webkit-text-stroke:16px #000;paint-order:stroke fill;
  opacity:0;z-index:5;letter-spacing:-18px}}
.note{{position:absolute;font-family:Hand;font-size:80px;color:#fff;-webkit-text-stroke:10px #000;paint-order:stroke fill;opacity:0;z-index:5}}
.nm{{position:absolute;opacity:0;z-index:5;font-family:Paper}}
.nm div{{display:table;padding:6px 16px 8px;color:#fff;line-height:1.1}}
.nm .l0{{background:{RED};font-size:46px}} .nm .l1{{background:{INK};font-size:34px}}
.tg{{position:absolute;opacity:0;z-index:5;font-family:Paper;transform:rotate(-4deg)}}
.tg div{{display:table;padding:6px 18px 8px;color:#fff;line-height:1.05}}
.tg .l0{{background:{INK};font-size:44px}} .tg .l1{{background:{RED};font-size:64px}}
.arr{{position:absolute;left:0;top:0;z-index:5;opacity:0}}
.sil{{position:absolute;opacity:0;z-index:4}}
'''
    css += chrome.CSS
    body, js = [], ['const tl=gsap.timeline({paused:true});']
    title = spec.get('title') or []
    if title:
        body.append(f'<div id="title"><div class="a">{esc(title[0])}</div>' + (f'<div class="b">{esc(title[1])}</div>' if len(title) > 1 else '') + '</div>')
        js.append('tl.from("#title",{x:-40,opacity:0,duration:.3,ease:"power3.out"},.05);')
    cbody, cjs = chrome.parts(dict(spec, issue_tag='', stinger=False), d)
    body.append(cbody); js += cjs
    body.insert(0, '<div id="shade"></div>')
    pops = []
    for k, ((a, b), c) in enumerate(zip(spec['windows'], spec['cuts'])):
        end = b if k + 1 < len(spec['cuts']) else d + 1
        body.append(f'<div class="src" id="s{k}">{esc(c.get("source", ""))}</div>')
        js.append(f'tl.set("#s{k}",{{opacity:1}},{max(0, a - 1.5 / FPS):.3f});tl.set("#s{k}",{{opacity:0}},{end - 1.5 / FPS:.3f});')
        el = []
        if c.get('silhouette'):
            s = c['silhouette']
            body.append(f'<div class="sil" id="si{k}" style="left:{s["x"] - 200}px;top:{s["y"] - 230}px">{SIL}</div>')
            js.append(f'tl.fromTo("#si{k}",{{opacity:0,y:40}},{{opacity:1,y:0,duration:.22,ease:"power3.out"}},{a:.3f});'
                      f'tl.fromTo("#si{k} text",{{scale:.4,transformOrigin:"50% 70%"}},{{scale:1,duration:.3,ease:"back.out(3)"}},{a + .12:.3f});')
            el.append(f'#si{k}')
        if c.get('name'):
            n = c['name']
            body.append(f'<div class="nm" id="nm{k}" style="left:{n["x"]}px;top:{n["y"]}px">'
                        + ''.join(f'<div class="l{i}">{esc(t)}</div>' for i, t in enumerate(n['lines'][:2])) + '</div>')
            js.append(f'tl.fromTo("#nm{k}",{{opacity:0,x:-30}},{{opacity:1,x:0,duration:.18,ease:"power3.out"}},{a + .08:.3f});')
            el.append(f'#nm{k}')
        if c.get('tag'):
            t = c['tag']
            body.append(f'<div class="tg" id="tg{k}" style="left:{t["x"]}px;top:{t["y"]}px">'
                        + ''.join(f'<div class="l{i}">{esc(x)}</div>' for i, x in enumerate(t['lines'][:2])) + '</div>')
            js.append(f'tl.fromTo("#tg{k}",{{opacity:0,scale:1.6}},{{opacity:1,scale:1,duration:.2,ease:"back.out(2.5)"}},{a + .05:.3f});')
            el.append(f'#tg{k}'); pops.append(a + .05)
        if c.get('arrow'):
            (x1, y1), (x2, y2) = c['arrow']['from'], c['arrow']['to']
            import math
            ang = math.atan2(y2 - y1, x2 - x1)
            hx = [x2 - 46 * math.cos(ang - .5), x2 - 46 * math.cos(ang + .5)]
            hy = [y2 - 46 * math.sin(ang - .5), y2 - 46 * math.sin(ang + .5)]
            path = f'M{x1} {y1} Q{(x1 + x2) / 2 + (y2 - y1) * .18:.0f} {(y1 + y2) / 2 - (x2 - x1) * .18:.0f} {x2} {y2}'
            head = f'M{hx[0]:.0f} {hy[0]:.0f} L{x2} {y2} L{hx[1]:.0f} {hy[1]:.0f}'
            body.append(f'<svg class="arr" id="ar{k}" width="1920" height="1080" viewBox="0 0 1920 1080">'
                        f'<path d="{path}" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" pathLength="1" stroke-dasharray="1" class="p"/>'
                        f'<path d="{path}" fill="none" stroke="{RED}" stroke-width="14" stroke-linecap="round" pathLength="1" stroke-dasharray="1" class="p"/>'
                        f'<path d="{head}" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" class="h"/>'
                        f'<path d="{head}" fill="none" stroke="{RED}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" class="h"/></svg>')
            js.append(f'tl.set("#ar{k}",{{opacity:1}},{a + .15:.3f});'
                      f'tl.fromTo("#ar{k} .p",{{strokeDashoffset:1}},{{strokeDashoffset:0,duration:.25,ease:"power2.out"}},{a + .15:.3f});'
                      f'tl.fromTo("#ar{k} .h",{{opacity:0}},{{opacity:1,duration:.05}},{a + .38:.3f});')
            el.append(f'#ar{k}')
        if c.get('sticker'):
            s = c['sticker']
            body.append(f'<div class="stk" id="st{k}" style="left:{s["x"]}px;top:{s["y"]}px">{esc(s["text"])}</div>')
            r = s.get('rot', 8)
            t0 = a + s.get('delay', .1)
            js.append(f'tl.fromTo("#st{k}",{{opacity:0,scale:.2,rotation:{-r}}},{{opacity:1,scale:1,rotation:{r},duration:.22,ease:"back.out(3.2)"}},{t0:.3f});'
                      f'tl.to("#st{k}",{{rotation:{-r / 2},duration:.12,yoyo:true,repeat:1,ease:"sine.inOut"}},{t0 + .3:.3f});')
            el.append(f'#st{k}'); pops.append(t0)
        if c.get('note'):
            n = c['note']
            body.append(f'<div class="note" id="nt{k}" style="left:{n["x"]}px;top:{n["y"]}px;transform:rotate({n.get("rot", -6)}deg)">{esc(n["text"])}</div>')
            js.append(f'tl.fromTo("#nt{k}",{{opacity:0,y:14}},{{opacity:1,y:0,duration:.18,ease:"power2.out"}},{a + .25:.3f});')
            el.append(f'#nt{k}')
        if el and k + 1 < len(spec['cuts']):
            js.append(f'tl.set("{",".join(el)}",{{opacity:0}},{b - 1.5 / FPS:.3f});')
    for i, (a, b, c) in enumerate(spec['cues']):
        body.append(f'<div class="cap" id="c{i}">{_cap_html(c)}</div>')
        nxt = spec['cues'][i + 1][0] if i + 1 < len(spec['cues']) else d + 1   # 켜고 끄기는 tl.set, 컷과 같은 프레임 격자 1프레임 앞(시안 실측 — .5 앞은 한 프레임 늦고 1.5 앞은 한 프레임 이르다, 하이퍼프레임 정지 프레임 재사용 탓으로 보임)
        on, off = max(0, round(a * FPS) / FPS - 1 / FPS), round(nxt * FPS) / FPS - 1 / FPS
        js.append(f'tl.set("#c{i}",{{opacity:1}},{on:.3f});tl.fromTo("#c{i}",{{scale:1.25}},{{scale:1,duration:.1,ease:"back.out(2)",immediateRender:false}},{on:.3f});'
                  f'tl.set("#c{i}",{{opacity:0}},{off:.3f});')   
    js.append('window.__timelines=window.__timelines||{};window.__timelines["hook"]=tl;')
    html_body = (f'<div id="root" data-composition-id="hook" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
                 f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{"".join(body)}</section></div>')
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head><body>{html_body}'
        f'<script src="assets/gsap.min.js"></script><script>{"".join(js)}</script></body></html>', encoding='utf-8')
    return pops


def compose(spec, overlay, voice, out, pops=()):
    """컷마다 원본 창을 잘라 1920x1080 로 당겨 잡고(첫 4프레임 살짝 튀어 들어온 뒤 천천히 밀기) 이어 붙인 뒤 오버레이·음성·튀는 소리를 얹는다."""
    d = float(spec['duration'])
    args, chains = [], []
    for k, ((a, b), c) in enumerate(zip(spec['windows'], spec['cuts'])):
        dur = (b if k + 1 < len(spec['cuts']) else d) - a
        args += ['-ss', f'{c["t"]:.3f}', '-t', f'{dur + .2:.3f}', '-i', str(c['src'])]
        x, y, w, h = c['crop']
        n = max(1, round((a + dur) * FPS) - round(a * FPS))   # 컷 길이를 프레임 정수로(trim=duration 은 컷마다 ±1프레임 흔들렸다)
        z = f"if(lt(on,4),1.12-0.03*on,1+0.06*(on-4)/{n})"
        extra = ',boxblur=22:2,eq=brightness=-0.28:saturation=0.6' if c.get('dim') else ''
        chains.append(f'[{k}:v]fps={FPS},crop={w}:{h}:{x}:{y},scale=1920:1080,setsar=1,'
                      f"zoompan=z='{z}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x1080:fps={FPS},"
                      f'trim=end_frame={n},setpts=PTS-STARTPTS{extra}[v{k}]')
    m = len(spec['cuts'])
    args += ['-i', str(overlay), '-i', str(voice)]
    f = ';'.join(chains) + ';' + ''.join(f'[v{k}]' for k in range(m)) + f'concat=n={m}:v=1:a=0[bg];[bg][{m}:v]overlay=format=auto,setsar=1[v]'
    f += f';[{m + 1}:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur={d:.3f}[vo]'
    mix = '[vo]'
    if pops:
        args += ['-i', str(pop_sfx())]
        f += f';[{m + 2}:a]aresample=48000,aformat=channel_layouts=stereo,asplit={len(pops)}' + ''.join(f'[p{i}]' for i in range(len(pops)))
        for i, t in enumerate(pops):
            f += f';[p{i}]adelay={int(t * 1000)}|{int(t * 1000)},volume=0.5[q{i}]'
            mix += f'[q{i}]'
        f += f';{mix}amix=inputs={len(pops) + 1}:duration=first:normalize=0[a]'
    else:
        f += ';[vo]anull[a]'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *args, '-filter_complex', f, '-map', '[v]', '-map', '[a]', '-t', f'{d:.3f}',
                    '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', str(out)],
                   check=True)
