"""해설 구간용 모션그래픽(투명 배경). 인용 오버레이와 같은 색·글꼴 체계를 쓴다.

    python narration_overlay.py <spec.json> <출력.mov>

spec["type"]:
  issue    {"no": 1, "title": "...", "sub": "..."}                       이슈 시작 카드
  facts    {"title": "...", "items": ["...", "...", "..."]}              핵심 사실 3줄이 차례로
  timeline {"title": "...", "steps": [["9월 28일", "..."], ...]}         날짜 줄이 그어지며 단계 등장
  versus   {"title": "...", "left": ["민주당", "..."], "right": ["국민의힘", "..."],
            "lcolor": "#1E5BD8", "rcolor": "#E61E2B"}                     양쪽 주장 대결
  number   {"title": "...", "value": 25, "suffix": "%", "caption": "..."}  숫자 카운트업
공통: "duration", "source"(왼쪽 아래 출처, 선택)
"""
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quote_overlay import FPS, build as _unused, render  # noqa: E402,F401
import quote_overlay  # noqa: E402

esc = lambda s: html.escape(str(s), quote=True)
YELLOW = '#F5C518'

BASE_CSS = '''
@font-face{font-family:Paper;src:url(assets/Paperlogy-8ExtraBold.ttf)}
@font-face{font-family:Body;src:url(assets/ROKAFSansMedium.ttf)}
@font-face{font-family:Hand;src:url(assets/BMYEONSUNG.ttf)}
html,body{margin:0;background:transparent}
#root{position:relative;width:1920px;height:1080px;overflow:hidden;color:#fff;word-break:keep-all}
.t{position:absolute;left:140px;top:150px;font-family:Paper;font-size:70px;text-shadow:0 6px 24px rgba(0,0,0,.8)}
.u{position:absolute;left:140px;top:250px;height:10px;width:220px;background:#F5C518;transform-origin:left center}
#source{position:absolute;left:40px;bottom:60px;font-family:Body;font-size:22px;color:rgba(255,255,255,.88);
  background:rgba(0,0,0,.45);padding:4px 12px;border-radius:4px}
.box{background:rgba(10,14,28,.80);border-radius:10px}
.cap{position:absolute;left:50%;bottom:90px;transform:translateX(-50%);max-width:1700px;white-space:nowrap;
  font-family:Paper;font-size:52px;color:#fff;background:rgba(8,12,24,.82);padding:10px 30px;border-radius:8px;opacity:0}
'''


def scene(spec):
    t = spec['type']; d = float(spec['duration'])
    css, body, js = BASE_CSS, '', []
    if t == 'issue':
        css += f'''#no{{position:absolute;left:140px;top:300px;font-family:Paper;font-size:260px;color:{YELLOW};line-height:1}}
#lbl{{position:absolute;left:150px;top:250px;font-family:Body;font-size:40px;letter-spacing:12px;color:#cfd6e6}}
#title{{position:absolute;left:520px;top:340px;width:1260px;font-family:Paper;font-size:96px;line-height:1.15}}
#sub{{position:absolute;left:526px;top:600px;width:1200px;font-family:Body;font-size:40px;color:#e6e9f2}}
#rule{{position:absolute;left:520px;top:575px;width:1240px;height:6px;background:{YELLOW};transform-origin:left}}'''
        if spec.get('no') is None:   # 10/21편부터 번호 호명 금지(목차·«ISSUE 01» 낭독에서 이탈) — 번호 없이 제목 카드만, 왼쪽으로 당긴다
            css += '#title{left:140px;top:300px} #sub{left:146px} #rule{left:140px}'
            body = f'<div id="title">{esc(spec["title"])}</div><div id="rule"></div><div id="sub">{esc(spec.get("sub", ""))}</div>'
        else:
            body = (f'<div id="lbl">ISSUE</div><div id="no">{int(spec["no"]):02d}</div><div id="title">{esc(spec["title"])}</div>'
                    f'<div id="rule"></div><div id="sub">{esc(spec.get("sub", ""))}</div>')
        js = ['tl.from("#no",{x:-80,opacity:0,duration:.6,ease:"power3.out"},0);',
              'tl.from("#lbl",{opacity:0,duration:.4},.2);',
              'tl.from("#title",{y:40,opacity:0,duration:.6,ease:"power3.out"},.35);',
              'tl.from("#rule",{scaleX:0,duration:.6,ease:"power2.inOut"},.7);',
              'tl.from("#sub",{opacity:0,y:20,duration:.5},1.0);']
    elif t == 'facts':
        css += '''.f{position:absolute;left:140px;width:1100px;padding:26px 34px 26px 110px;font-family:Paper;font-size:48px;line-height:1.3}
.f b{position:absolute;left:30px;top:22px;font-size:56px;color:#F5C518}'''
        body = f'<div class="t">{esc(spec["title"])}</div><div class="u"></div>' + ''.join(
            f'<div class="f box" id="f{i}" style="top:{330 + i * 190}px"><b>{i + 1}</b>{esc(x)}</div>'
            for i, x in enumerate(spec['items'][:3]))
        step = max(.9, (d - 2) / 3)
        js = ['tl.from(".t",{x:-60,opacity:0,duration:.5},0);', 'tl.from(".u",{scaleX:0,duration:.5},.3);']
        js += [f'tl.from("#f{i}",{{x:-80,opacity:0,duration:.5,ease:"power3.out"}},{.8 + i * step:.2f});' for i in range(len(spec['items'][:3]))]
    elif t == 'timeline':
        steps = spec['steps'][:4]; n = len(steps); gap = 1640 / n
        css += f'''#line{{position:absolute;left:140px;top:560px;width:1640px;height:8px;background:{YELLOW};transform-origin:left}}
.s{{position:absolute;top:470px;width:{gap - 40:.0f}px}}
.s i{{display:block;width:34px;height:34px;border-radius:50%;background:{YELLOW};border:6px solid #111;margin:69px 0 0 -6px}}
.s .dt{{position:absolute;top:0;font-family:Paper;font-size:46px;color:{YELLOW}}}
.s .tx{{margin-top:26px;font-family:Body;font-size:36px;line-height:1.35;padding:18px 22px}}'''
        body = f'<div class="t">{esc(spec["title"])}</div><div class="u"></div><div id="line"></div>' + ''.join(
            f'<div class="s" id="s{i}" style="left:{140 + i * gap:.0f}px"><div class="dt">{esc(a)}</div><i></i>'
            f'<div class="tx box">{esc(b)}</div></div>' for i, (a, b) in enumerate(steps))
        step = max(.8, (d - 2.5) / n)
        js = ['tl.from(".t",{x:-60,opacity:0,duration:.5},0);', 'tl.from(".u",{scaleX:0,duration:.5},.3);',
              f'tl.from("#line",{{scaleX:0,duration:{min(2.5, d * .4):.2f},ease:"power1.inOut"}},.6);']
        js += [f'tl.from("#s{i}",{{y:40,opacity:0,duration:.5,ease:"back.out(1.4)"}},{.9 + i * step:.2f});' for i in range(n)]
    elif t == 'versus':
        lc, rc = spec.get('lcolor', '#1E5BD8'), spec.get('rcolor', '#E61E2B')
        css += f'''.side{{position:absolute;top:330px;box-sizing:border-box;width:780px;min-height:400px;padding:40px 46px}}
.side h2{{margin:0;font-family:Paper;font-size:60px}} .side p{{font-family:Body;font-size:42px;line-height:1.45;margin:26px 0 0}}
#L{{left:110px;border-top:14px solid {lc}}} #R{{left:1030px;border-top:14px solid {rc}}}
#vs{{position:absolute;left:890px;top:470px;width:140px;text-align:center;font-family:Paper;font-size:84px;color:{YELLOW}}}'''
        body = (f'<div class="t">{esc(spec["title"])}</div><div class="u"></div>'
                f'<div class="side box" id="L"><h2>{esc(spec["left"][0])}</h2><p>{esc(spec["left"][1])}</p></div>'
                f'<div id="vs">VS</div><div class="side box" id="R"><h2>{esc(spec["right"][0])}</h2><p>{esc(spec["right"][1])}</p></div>')
        js = ['tl.from(".t",{x:-60,opacity:0,duration:.5},0);', 'tl.from(".u",{scaleX:0,duration:.5},.3);',
              'tl.from("#L",{x:-200,opacity:0,duration:.6,ease:"power3.out"},.6);',
              f'tl.from("#R",{{x:200,opacity:0,duration:.6,ease:"power3.out"}},{max(1.2, d * .35):.2f});',
              f'tl.from("#vs",{{scale:3,opacity:0,duration:.5,ease:"back.out(2)"}},{max(1.6, d * .35 + .4):.2f});']
    elif t == 'number':
        val = spec['value']; suf = esc(spec.get('suffix', ''))
        css += f'''#num{{position:absolute;left:140px;top:330px;font-family:Paper;font-size:300px;color:{YELLOW};line-height:1}}
#cap{{position:absolute;left:150px;top:690px;width:1400px;font-family:Body;font-size:48px;line-height:1.4}}'''
        body = (f'<div class="t">{esc(spec["title"])}</div><div class="u"></div>'
                f'<div id="num"><span id="v">{val}</span>{suf}</div><div id="cap">{esc(spec.get("caption", ""))}</div>')
        js = ['tl.from(".t",{x:-60,opacity:0,duration:.5},0);', 'tl.from(".u",{scaleX:0,duration:.5},.3);',
              'tl.from("#num",{opacity:0,duration:.3},.6);',
              f'const o={{v:0}};tl.to(o,{{v:{val},duration:1.4,ease:"power2.out",onUpdate:()=>{{document.getElementById("v").textContent=Math.round(o.v).toLocaleString()}}}},.6);',
              'tl.from("#cap",{y:30,opacity:0,duration:.5},1.6);']
    elif t == 'followup':
        items = spec['items'][:3]
        css += f'''#fh{{position:absolute;left:140px;top:150px;font-family:Paper;font-size:44px;color:#111;background:{YELLOW};padding:8px 22px;border-radius:4px}}
#ft{{position:absolute;left:140px;top:240px;width:1500px;font-family:Paper;font-size:78px;line-height:1.15}}
.fi{{position:absolute;left:140px;width:1300px;padding:22px 30px 22px 96px;font-family:Body;font-size:42px}}
.fi b{{position:absolute;left:26px;top:16px;font-family:Paper;font-size:46px;color:{YELLOW}}}
.fi s{{position:absolute;right:26px;top:26px;font-family:Paper;font-size:28px;text-decoration:none;color:#ff6b6b}}
#fn{{position:absolute;left:140px;top:900px;font-family:Paper;font-size:40px;color:{YELLOW}}}'''
        body = (f'<div id="fh">후속 보도 예고</div><div id="ft">{esc(spec["title"])}</div>' + ''.join(
            f'<div class="fi box" id="fi{i}" style="top:{430 + i * 140}px"><b>▶</b>{esc(a)}<s>{esc(b)}</s></div>'
            for i, (a, b) in enumerate(items)) + f'<div id="fn">{esc(spec.get("note", "새 소식이 나오면 바로 이어서 전해드립니다"))}</div>')
        step = max(.7, (d - 3) / max(1, len(items)))
        js = ['tl.from("#fh",{x:-60,opacity:0,duration:.4},0);', 'tl.from("#ft",{y:30,opacity:0,duration:.5},.3);']
        js += [f'tl.from("#fi{i}",{{x:-80,opacity:0,duration:.45,ease:"power3.out"}},{.9 + i * step:.2f});' for i in range(len(items))]
        js.append(f'tl.from("#fn",{{opacity:0,duration:.5}},{max(1.5, d - 2.5):.2f});')
        js.append('tl.to("#fn",{opacity:.4,duration:.7,repeat:3,yoyo:true},%.2f);' % max(2, d - 2))
    elif t == 'bridge':
        # 인용과 인용 사이 짧은 해설: 다음에 말할 사람만 띄운다
        css += f'''#kick{{position:absolute;left:140px;top:150px;font-family:Paper;font-size:40px;color:#111;background:{YELLOW};padding:8px 22px;border-radius:4px}}
#kn{{position:absolute;left:140px;top:236px;width:1600px;font-family:Paper;font-size:72px;line-height:1.2;text-shadow:0 6px 24px rgba(0,0,0,.8)}}
#kr{{position:absolute;left:144px;top:332px;font-family:Body;font-size:38px;color:#e6e9f2;text-shadow:0 4px 16px rgba(0,0,0,.8)}}'''
        if spec.get('title'):
            body = (f'<div id="kick">이어서 들어 보겠습니다</div><div id="kn">{esc(spec["title"])}</div>'
                    f'<div id="kr">{esc(spec.get("sub", ""))}</div>')
            js = ['tl.from("#kick",{x:-60,opacity:0,duration:.4},0);', 'tl.from("#kn",{y:30,opacity:0,duration:.5},.3);',
                  'tl.from("#kr",{opacity:0,duration:.4},.6);']
        else:
            body, js = '<div></div>', []
    else:
        raise SystemExit('unknown type ' + t)
    js.append(f'tl.to("#root > section",{{opacity:0,duration:.45}},{max(.5, d - .5):.2f});')
    return css, body, js


def build(spec, folder):
    quote_overlay.build({'speaker': '', 'phrases': [''], 'side': 'left', 'duration': spec['duration']}, folder)  # 자산 복사
    css, body, js = scene(spec)
    import chrome
    cbody, cjs = chrome.parts(dict(spec, ambience=spec.get('ambience', True)), float(spec['duration']))
    css += chrome.CSS
    body = cbody.split('<div id="tagbar"')[0] + body + ('<div id="tagbar"' + cbody.split('<div id="tagbar"', 1)[1] if '<div id="tagbar"' in cbody else '')
    js = cjs + js
    d = float(spec['duration'])
    src = f'<div id="source">{esc(spec["source"])}</div>' if spec.get('source') else ''
    for i, (a, b, text) in enumerate(spec.get('captions', [])):
        src += f'<div class="cap" id="cap{i}">{esc(text)}</div>'
        js.append(f'tl.set("#cap{i}",{{opacity:1}},{a:.3f});tl.set("#cap{i}",{{opacity:0}},{min(b, d - .05):.3f});')
    page = (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head><body>'
            f'<div id="root" data-composition-id="nar" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
            f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{body}{src}</section></div>'
            f'<script src="assets/gsap.min.js"></script><script>const tl=gsap.timeline({{paused:true}});{"".join(js)}'
            f'window.__timelines=window.__timelines||{{}};window.__timelines["nar"]=tl;</script></body></html>')
    (folder / 'index.html').write_text(page, encoding='utf-8')


def compose(bg, start, duration, overlay, out, audio=None, spec=None):
    """배경 영상을 흐리고 어둡게 깔고 오버레이를 얹는다. audio 를 주면 그 음성(해설)을 쓴다.
    spec 을 주면 격자·빛줄기(오버레이 아래)와 티커(위)를 motion.py 로 함께 그린다."""
    import subprocess
    import motion
    spec = dict(spec or {}, ambience=(spec or {}).get('ambience', True)) if spec else {}
    folder = Path(out).parent
    extra, under = motion.pre(spec, duration, folder, 3 if audio else 2, 'bg', 'bga')
    vf = (f"[0:v]fps={FPS},scale=1920:1080,crop=1920:900:0:150,scale=1920:1080,boxblur=18:2,eq=brightness=-0.22:saturation=0.75[bg];"
          f"{under};[bga][1:v]overlay=format=auto,setsar=1[ov];" + motion.post(spec, folder, 'ov', 'v'))
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-t', f'{duration:.3f}', '-i', str(bg),
           '-i', str(overlay)]
    if audio:
        cmd += ['-i', str(audio)]
    cmd += extra + ['-filter_complex', vf, '-map', '[v]', '-map', '2:a' if audio else '0:a', '-c:v', 'libx264', '-crf', '21',
            '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', str(out)]
    subprocess.run(cmd, check=True)


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    out = Path(sys.argv[2]).resolve()
    work = out.with_suffix('.hf')
    work.mkdir(parents=True, exist_ok=True)
    build(spec, work)
    render(work, out)
    print(out)
