"""인용 장면 위에 얹을 모션그래픽(투명 배경)을 하이퍼프레임으로 렌더한다.

    python quote_overlay.py <spec.json> <출력.mov>

spec: {"speaker": "이진숙", "role": "국민의힘 의원", "color": "#E61E2B", "tag": "국감 현장 · 10.12",
       "phrases": ["대통령이 왕입니까", "국민 대신한 질문"], "side": "left"|"right",
       "person": [x0, y0, x1, y1], "duration": 27.8}

구성: 정당색 띠가 쓸려 들어오고 → 발언자 카드 → 큰 따옴표와 핵심 문구가 한 단어씩 올라오며
노란 형광 밑줄이 그어진다 → 문구가 둘이면 중간에 교체 → 끝 0.6초에 걷힌다.
그래픽은 인물 영역(person)을 피해 빈 쪽에만 놓는다.
"""
import html
import re
import chrome
import motion
import json
import shutil
import subprocess
import sys
from pathlib import Path

from config import ASSETS, HYPERFRAMES
FONTS = ['Paperlogy-8ExtraBold.ttf', 'ROKAFSansMedium.ttf', 'BMYEONSUNG.ttf']
VERSION = HYPERFRAMES
FPS = 30


def build(spec, folder):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    shutil.copy2(ASSETS / 'gsap.min.js', folder / 'assets' / 'gsap.min.js')
    for f in FONTS:
        shutil.copy2(ASSETS / 'fonts' / f, folder / 'assets' / f)
    d = float(spec['duration'])
    side = spec['side']
    x0, _, x1, _ = spec.get('person', [.3, 0, .7, 1])
    room = (x0 if side == 'left' else 1 - x1) * 1920
    width = int(max(420, min(620, room - 90)))
    left = 60 if side == 'left' else 1920 - 60 - width
    esc = lambda s: html.escape(str(s), quote=True)
    phrases = spec['phrases'][:2]
    def words(p):
        out = ''
        for w in p.split():
            # *강조* 표기는 단어 안 어디에 있어도 노란색으로 바꾼다
            inner = esc(w)
            if '*' in w:
                parts = re.split(r'(\*[^*]+\*)', w)
                inner = ''.join('<b class="k">' + esc(x.strip('*')) + '</b>' if x.startswith('*') else esc(x) for x in parts)
            out += f'<span class="w">{inner}</span> '
        return out
    phrase_html = ''.join(f'<div class="phrase" id="p{i}">{words(p)}<div class="hl" id="hl{i}"></div></div>'
                          for i, p in enumerate(phrases))
    color = spec.get('color', '#F5C518')
    css = f'''
@font-face{{font-family:Paper;src:url(assets/Paperlogy-8ExtraBold.ttf)}}
@font-face{{font-family:Body;src:url(assets/ROKAFSansMedium.ttf)}}
@font-face{{font-family:Hand;src:url(assets/BMYEONSUNG.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:1920px;height:1080px;overflow:hidden;word-break:keep-all}}
#panel{{position:absolute;left:{left}px;top:250px;width:{width}px}}
#bar{{height:10px;background:{color};transform-origin:{'left' if side == 'left' else 'right'} center;border-radius:5px}}
#card{{margin-top:18px;padding:20px 26px;background:rgba(10,14,28,.78);border-left:8px solid {color};
  border-radius:6px}}
#name{{font-family:Paper;font-size:58px;color:#fff;line-height:1.05}}
#role{{font-family:Body;font-size:28px;color:#cfd6e6;margin-top:8px}}
#tag{{display:inline-block;margin-top:14px;font-family:Body;font-size:22px;color:#111;background:#F5C518;
  padding:4px 12px;border-radius:4px}}
#quote{{position:relative;margin-top:26px;min-height:240px}}
#mark{{position:absolute;left:-6px;top:-58px;font-family:Paper;font-size:150px;color:{color};opacity:.9}}
.phrase{{position:absolute;left:0;top:30px;width:{width}px;font-family:Paper;font-size:54px;line-height:1.25;
  color:#fff;text-shadow:0 4px 18px rgba(0,0,0,.85)}}
.w{{display:inline-block;opacity:0;transform:translateY(30px)}}
.k{{color:#F5C518;font-weight:inherit}}
#shade{{position:absolute;top:0;bottom:0;{side}:0;width:{width + 260}px;
  background:linear-gradient(to {'right' if side == 'left' else 'left'},rgba(4,6,14,.72),rgba(4,6,14,.38) 60%,rgba(4,6,14,0))}}
#source{{bottom:60px !important}}
.hl{{position:absolute;left:0;bottom:-10px;height:14px;width:100%;background:#F5C518;opacity:.85;
  transform:scaleX(0);transform-origin:left center;border-radius:3px}}
#source{{position:absolute;left:40px;bottom:30px;font-family:Body;font-size:22px;color:rgba(255,255,255,.88);
  background:rgba(0,0,0,.45);padding:4px 12px;border-radius:4px}}
#live{{position:relative;display:inline-block;margin-left:10px;vertical-align:top;margin-top:14px;font-family:Body;font-size:22px;color:#fff;background:#d4202c;
  padding:4px 12px 4px 30px;border-radius:4px}}
#live:before{{content:"";position:absolute;left:11px;top:50%;width:11px;height:11px;margin-top:-5.5px;
  border-radius:50%;background:#fff}}
'''
    css += chrome.CSS
    swap = d * .5 if len(phrases) > 1 else None
    js = [f'const tl=gsap.timeline({{paused:true}});',
          f'tl.from("#bar",{{scaleX:0,duration:.45,ease:"power3.out"}},0);',
          f'tl.from("#card",{{x:{-60 if side == "left" else 60},opacity:0,duration:.5,ease:"power3.out"}},.15);',
          'tl.from("#tag",{y:12,opacity:0,duration:.35},.45);',
          'tl.from("#mark",{scale:.3,opacity:0,duration:.45,ease:"back.out(1.6)"},.6);',
          'tl.from("#live",{opacity:0,x:-12,duration:.35},.5);',
          *chrome.blink('#live', .35, .6, .8, d - .6)]
    for i in range(len(phrases)):
        t0 = .9 if i == 0 else swap
        js.append(f'tl.to("#p{i} .w",{{opacity:1,y:0,duration:.35,stagger:.09,ease:"power2.out"}},{t0:.3f});')
        js.append(f'tl.to("#hl{i}",{{scaleX:1,duration:.5,ease:"power2.inOut"}},{t0 + .6:.3f});')
        if i == 0 and swap:
            js.append(f'tl.to("#p0",{{opacity:0,y:-24,duration:.35}},{swap - .4:.3f});')
    js.append(f'tl.to("#panel,#live",{{opacity:0,y:-16,duration:.5,ease:"power2.in"}},{max(.5, d - .6):.3f});')
    cbody, cjs = chrome.parts(spec, d)
    js[1:1] = ['tl.from("#shade",{opacity:0,duration:.6},.1);'] + cjs
    js.append('window.__timelines=window.__timelines||{};window.__timelines["quote"]=tl;')
    body = (f'<div id="root" data-composition-id="quote" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
            f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">'
            f'<div id="shade"></div>{cbody}<div id="source">{esc(spec.get("source", ""))}</div><div id="panel"><div id="bar"></div><div id="card">'
            f'<div id="name">{esc(spec["speaker"])}</div><div id="role">{esc(spec.get("role", ""))}</div>'
            f'<div id="tag">{esc(spec.get("tag", ""))}</div><div id="live">원음</div></div>'
            f'<div id="quote"><div id="mark">“</div>{phrase_html}</div></div></section></div>')
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head><body>{body}'
        f'<script src="assets/gsap.min.js"></script><script>{"".join(js)}</script></body></html>', encoding='utf-8')


def render(folder, out):
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    import os
    tmp = Path(folder) / 'tmp'            # 임시 프레임을 C: 대신 작업 폴더(D:)에 둔다
    tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMP=str(tmp), TEMP=str(tmp))
    cmd = [npx, '--yes', f'hyperframes@{VERSION}', 'render', '.', '--format', 'mov', '--fps', str(FPS),
           '--workers', '4', '--output', 'overlay.mov', '--quiet', '--frames-cache-dir', 'off']
    if subprocess.run(cmd, cwd=folder, env=env).returncode:
        # 4 workers 는 프레임을 PNG 로 디스크에 쌓는다(49초 인용 ≈ 12GB). 모자라면 1 worker 스트리밍으로 다시
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(exist_ok=True)
        cmd[cmd.index('--workers') + 1] = '1'
        subprocess.run(cmd, cwd=folder, check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.move(str(folder / 'overlay.mov'), out)


def compose(src, start, spec, overlay, out, zoom=1.6, folder=None):
    """인물 중심으로 당겨 잡은 원본 위에 오버레이를 얹는다. 출처는 overlay 안의 #source 로 남는다."""
    d = float(spec['duration'])
    x0, y0, x1, _ = spec['person']
    face_x = (x0 + x1) / 2 * 1920
    face_top = (y0 + (x1 - x0) / 3 * .4) * 1080
    cw, ch = 1920 / zoom, 1080 / zoom
    anchor = .38 if spec['side'] == 'right' else .62          # 그래픽 반대쪽 3분할선에 인물
    cx = min(max(face_x - anchor * cw, 0), 1920 - cw)
    cy = min(max(face_top - .12 * ch, 140), 1080 - ch)        # 위쪽 140px(방송사 로고 띠)는 항상 잘린다
    frames = round(d * FPS)
    z = f"{zoom}+{zoom * .04}*on/{frames}"
    vf = (f"[0:v]fps={FPS},scale=1920:1080,zoompan=z='{z}':x='{cx:.1f}+({cw:.1f}-iw/zoom)/2':"
          f"y='{cy:.1f}+({ch:.1f}-ih/zoom)/2':d=1:s=1920x1080:fps={FPS},eq=saturation=0.92[bg];"
          f"[bg][1:v]overlay=format=auto,setsar=1[ov];" + motion.post(spec, folder or Path(out).parent, 'ov', 'v'))
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-t', f'{d:.3f}', '-i', str(src),
                    '-i', str(overlay), '-filter_complex', vf, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264',
                    '-crf', '21', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', str(out)],
                   check=True)


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    out = Path(sys.argv[2]).resolve()
    work = out.with_suffix('.hf')
    build(spec, work)
    render(work, out)
    print(out)
