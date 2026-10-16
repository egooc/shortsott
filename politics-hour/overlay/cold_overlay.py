"""롱폼 첫머리(콜드 오픈) — 썸네일에 쓴 그 대사 장면을 이름표·인용 카드 없이 큰 자막으로만 먼저 친다.

10-15 소유주: «롱폼 첫머리는 네임카드랑 자막으로 하지 말고 별도 편집으로 더 자극적이고 큰 자막으로… 네임카드 없이».
spec: {"words": [[원본 기준 상대초, "낱말", 강조?], ...], "source": "영상: 방송사 날짜", "duration": 3.0}
구성: 첫 프레임 흰 번쩍 → 원본이 천천히 당겨지고 → 큰 낱말이 말하는 시각에 한 개씩 쾅 찍힌다(강조는 노랑)
→ 끝까지 남아 있다가 다음 인트로의 대각선 띠가 덮는다. 출처 표기는 왼쪽 아래에 늘 남긴다.
"""
import html
import shutil
import subprocess
from pathlib import Path

from config import ASSETS

FPS = 30
TAIL = .9                                   # 말 끝난 뒤 멈춤 + 효과음 길이(휘익 .45초 → 쾅 → 잦아듦)
SFX = ASSETS / 'sfx' / 'transition_hit.wav'  # 직접 합성한 효과음(저작권 없음), 타격 시점 .45초
HIT = .45
YEL, RED = '#F5C518', '#d4202c'


def build(spec, folder):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    shutil.copy2(ASSETS / 'gsap.min.js', folder / 'assets' / 'gsap.min.js')
    shutil.copy2(ASSETS / 'fonts' / 'Paperlogy-8ExtraBold.ttf', folder / 'assets' / 'Paperlogy-8ExtraBold.ttf')
    shutil.copy2(ASSETS / 'fonts' / 'ROKAFSansMedium.ttf', folder / 'assets' / 'ROKAFSansMedium.ttf')
    shutil.copy2(ASSETS / 'fonts' / 'SBAggroB.ttf', folder / 'assets' / 'SBAggroB.ttf')   # 어랍숏·쇼핑과 같은 센 글꼴
    d = float(spec['duration'])
    esc = lambda s: html.escape(str(s), quote=True)
    words = spec['words']
    spans = ''.join(f'<span class="w{" k" if hot else ""}" id="w{i}">{esc(t)}</span> ' for i, (_, t, hot) in enumerate(words))
    css = f'''
@font-face{{font-family:Paper;src:url(assets/Paperlogy-8ExtraBold.ttf)}}
@font-face{{font-family:Body;src:url(assets/ROKAFSansMedium.ttf)}}
@font-face{{font-family:Aggro;src:url(assets/SBAggroB.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:1920px;height:1080px;overflow:hidden;word-break:keep-all}}
#shade{{position:absolute;left:0;right:0;bottom:0;height:520px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.78))}}
#cap{{position:absolute;left:60px;right:60px;bottom:120px;text-align:center;font-family:Aggro;font-size:160px;line-height:1.1;letter-spacing:-6px;color:#fff;
  transform:rotate(-3deg);-webkit-text-stroke:18px #000;paint-order:stroke fill;text-shadow:10px 10px 0 {RED},0 18px 40px rgba(0,0,0,.6)}}
#cap .w{{display:inline-block;opacity:0}} #cap .k{{color:{YEL};font-size:1.18em}}
#edge{{position:absolute;inset:0;box-shadow:inset 0 0 0 0 {RED};opacity:0}}
#live{{position:absolute;left:60px;top:54px;font-family:Paper;font-size:40px;color:#fff;background:{RED};padding:8px 22px;border-radius:6px}}
#live i{{display:inline-block;width:16px;height:16px;border-radius:50%;background:#fff;margin-right:14px;vertical-align:4px}}
#source{{position:absolute;left:40px;bottom:30px;font-family:Body;font-size:22px;color:rgba(255,255,255,.88);background:rgba(0,0,0,.4);padding:4px 10px;border-radius:4px}}
#flash{{position:absolute;inset:0;background:#fff;opacity:0}}
'''
    js = ['const tl=gsap.timeline({paused:true});',
          'tl.fromTo("#flash",{opacity:.85},{opacity:0,duration:.35,ease:"power2.out"},0);',
          'tl.from("#live",{x:-60,opacity:0,duration:.3,ease:"power3.out"},.1);']
    for i, (t, _, hot) in enumerate(words):
        t = max(.05, min(float(t), d - .3))
        js.append(f'tl.fromTo("#w{i}",{{opacity:0,scale:{2.4 if hot else 1.6},rotation:{-8 if hot else 0}}},'
                  f'{{opacity:1,scale:1,rotation:0,duration:.14,ease:"back.out(3)"}},{t:.3f});')
        if hot:   # 강조 낱말: 자막 흔들림 + 가장자리 빨간 번쩍
            js.append(f'tl.fromTo("#cap",{{x:-18,y:8}},{{x:0,y:0,duration:.22,ease:"elastic.out(1,.25)",immediateRender:false}},{t:.3f});'
                      f'tl.fromTo("#edge",{{opacity:.9,boxShadow:"inset 0 0 0 26px {RED}"}},{{opacity:0,duration:.3,immediateRender:false}},{t:.3f});')
    sp = float(spec.get('speech', d))
    if d > sp:   # 효과음 «쾅»에 맞춰 자막이 한 번 더 튀고 화면이 번쩍
        js.append(f'tl.fromTo("#cap",{{scale:1}},{{scale:1.12,duration:.08,yoyo:true,repeat:1,ease:"power2.out",immediateRender:false}},{sp + HIT:.3f});'
                  f'tl.fromTo("#flash",{{opacity:.7}},{{opacity:0,duration:.3,immediateRender:false}},{sp + HIT:.3f});'
                  f'tl.fromTo("#edge",{{opacity:1,boxShadow:"inset 0 0 0 40px {RED}"}},{{opacity:0,duration:.4,immediateRender:false}},{sp + HIT:.3f});')
    js.append('window.__timelines=window.__timelines||{};window.__timelines["cold"]=tl;')
    body = (f'<div id="root" data-composition-id="cold" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
            f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">'
            f'<div id="shade"></div><div id="live"><i></i>현장 원음</div><div id="cap">{spans}</div>'
            f'<div id="source">{esc(spec.get("source", ""))}</div><div id="edge"></div><div id="flash"></div></section></div>')
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head><body>{body}'
        f'<script src="assets/gsap.min.js"></script><script>{"".join(js)}</script></body></html>', encoding='utf-8')


def compose(src, start, spec, overlay, out):
    """원본을 1.32배에서 1.44배로 당기며(가운데) 오버레이를 얹는다 — 방송사 로고·«현장영상» 띠(네 귀퉁이)는 잘려 나간다. 소리는 원음.
    말(speech)이 끝나면 마지막 장면을 멈추고 전환 효과음을 깐다(TAIL)."""
    d = float(spec['duration'])
    sp = float(spec.get('speech', d))
    frames = max(1, round(d * FPS))
    hold = max(.5, sp - .3)   # 말 끝 무렵 원본이 다음 화면(분할 화면 등)으로 넘어가는 수가 있어 조금 앞 프레임에서 멈춘다
    vf = (f"[0:v]fps={FPS},scale=1920:1080,trim=duration={hold:.3f},tpad=stop_mode=clone:stop_duration={d - hold + .1:.3f},"
          f"zoompan=z='1.32+0.12*on/{frames}':x='iw/2-iw/zoom/2':y='ih*0.5-ih/zoom/2':"
          f"d=1:s=1920x1080:fps={FPS},trim=duration={d:.3f}[bg];[bg][1:v]overlay=format=auto,setsar=1[v];"
          f"[0:a]aresample=48000,afade=t=out:st={sp - .12:.3f}:d=0.12,apad=whole_dur={d:.3f}[a0];"
          f"[2:a]aresample=48000,adelay={int(sp * 1000)}|{int(sp * 1000)},volume=0.9[fx];"
          f"[a0][fx]amix=inputs=2:duration=first:normalize=0[a]")
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-t', f'{sp:.3f}', '-i', str(src),
                    '-i', str(overlay), '-i', str(SFX), '-filter_complex', vf, '-map', '[v]', '-map', '[a]', '-t', f'{d:.3f}',
                    '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', str(out)],
                   check=True)
