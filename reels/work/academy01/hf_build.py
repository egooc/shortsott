# academy01 하이퍼프레임 그래픽 — 가로(A안)·세로 오버레이를 HTML+GSAP 로 짓고 투명 mov 로 렌더, 편집본과 합성한다.
#   python hf_build.py h|v [--to S]          → hf_h/ · hf_v/ 짓기 + 렌더 + 합성 → out_h(_test).mp4 / out_v(_test).mp4
# 렌더 방식은 politics-hour/overlay/quote_overlay.py 를 따른다(hyperframes 버전·임시 폴더 D:·worker 실패 시 1개로).
# 옛 박힌 그래픽(0~4초 «보강» 스티커 · 2:47~3:00 «Alicia…»/«토요일 수업» 상자)은 지우지 않고 새 하단 타이틀 카드로 덮는다.
import json, shutil, subprocess, sys, os
from html import escape as esc
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).parent
ROOT = Path('D:/midform/reels')
sys.path.insert(0, 'D:/midform/politics-hour/overlay')
from config import ASSETS, HYPERFRAMES  # noqa: E402

plan = json.loads((HERE / 'edit_plan.json').read_text(encoding='utf-8'))
FPS = 30
YEL, INK, CREAM = '#FFD23F', '#1E1C1A', '#FFF8E7'
VX, VY, VW, VH = 1920 - 540 - 120, 40, 540, 960


def to_edit(t):
    acc = 0.0
    for k0, k1 in plan['keep']:
        if t < k0:
            return acc
        if t <= k1:
            return acc + t - k0
        acc += k1 - k0
    return acc


E = to_edit
# 하단 타이틀 카드(원본 좌표 1080x1920). 옛 그래픽 자리(y 1360~1840)를 다 덮는다.
CARDS = [
    {'t0': 0.0, 't1': E(4.0), 'tag': '학부모 설명회', 'title': '보강', 'sub': '제한을 두지 않는 이유'},
    {'t0': E(167.2), 't1': E(171.9), 'tag': '보강', 'title': '언제나 환영', 'sub': '수업 밖 질문도'},
    {'t0': E(171.9), 't1': E(180.0), 'tag': '학부모 설명회', 'title': '토요일 수업', 'sub': '형님반 & 아우반'},
]


# 도식 장면(소유주 10-19 «도형화하고 그래프랑 모션 사용»). 시각은 원본 기준, steps 는 말이 나오는 순간 등장.
# 가로: 왼쪽 판(제목·요점)이 잠시 도식으로 바뀐다. 세로: 머리 위 카드로 뜬다.
SCENES = [
    {'type': 'chips', 't0': 52.0, 't1': 67.6, 'title': '이럴 때 빠져요',
     'steps': [(52.6, '✈️ 여행'), (55.3, '🤒 아파서'), (56.4, '⚡ 급한 일'), (58.9, '💭 깜빡')], 'result': (61.8, '보강 OK')},
    {'type': 'strike', 't0': 71.2, 't1': 80.5, 'title': '이런 조건, 없어요',
     'steps': [(71.2, '며칠까지만 보강'), (73.6, '질병일 때만 보강')], 'result': (78.3, '제한 없음')},
    {'type': 'bars', 't0': 102.4, 't1': 109.0, 'title': '누구 말이 더 셀까?',
     'steps': [(102.6, '학부모님 요청', 38), (104.7, '아이의 «못 배웠어요»', 92)]},
    {'type': 'progress', 't0': 173.9, 't1': 177.4, 'title': '형님반 진도', 'from': 1, 'to': 8, 'unit': '번 책'},
    {'type': 'calendar', 't0': 177.5, 't1': 199.2, 'title': '한 달 토요일',
     'steps': [(177.5, 'all'), (181.4, 'last'), (188.8, 'holiday')]},
    {'type': 'versus', 't0': 239.3, 't1': 266.5, 'title': 'ESL만 하면?',
     'left': ('말하기', "It's sunny. It's Monday."), 'right': ('학교 내신', '비인칭 주어를 쓰시오?'), 'flip': 255.6},
    {'type': 'week', 't0': 300.9, 't1': 315.0, 'title': '언제 할 수 있을까?', 'steps': [(300.9, 'week'), (306.1, 'sat'), (309.4, 'pm')]},
    {'type': 'strike', 't0': 341.6, 't1': 358.8, 'title': '처음 들은 말',
     'steps': [(343.8, '단기 특강이겠지'), (347.6, '해 봤자 얼마나 하겠어')], 'result': (353.0, '기한 없이 계속 ∞')},
]
SCENE_CSS = f'''
.scn{{position:absolute;width:880px;height:580px;opacity:0}}
.scn h3{{margin:0;font-family:Jua;font-weight:normal;font-size:72px;color:{INK}}}
.chip{{display:inline-block;margin:14px 14px 0 0;padding:18px 30px 12px;border:4px solid {INK};border-radius:999px;background:#fff;
  font-family:GB;font-size:44px;color:{INK}}}
.res{{position:absolute;left:0;bottom:10px;padding:22px 44px 14px;background:{YEL};border:5px solid {INK};border-radius:26px;
  font-family:Jua;font-size:76px;color:{INK}}}
.arrow{{position:absolute;left:30px;bottom:150px;font-family:GB;font-size:70px;color:{INK}}}
.row{{position:relative;margin-top:26px;font-family:GB;font-size:50px;color:{INK};display:inline-block}}
.row .x{{position:absolute;left:-6px;right:-6px;top:52%;height:8px;background:#E5511F;transform-origin:0 50%;transform:scaleX(0)}}
.stamp{{position:absolute;right:30px;bottom:30px;padding:20px 40px 12px;border:8px solid #E5511F;border-radius:20px;color:#E5511F;
  font-family:Jua;font-size:84px;transform:rotate(-8deg)}}
.bar{{margin-top:34px}}
.bar .lb{{font-family:GB;font-size:40px;color:{INK};margin-bottom:10px}}
.bar .tr{{height:64px;background:#fff;border:4px solid {INK};border-radius:32px;overflow:hidden}}
.bar .fl{{height:100%;background:{YEL};transform-origin:0 50%;transform:scaleX(0)}}
.big{{font-family:Jua;font-size:200px;color:{INK};line-height:1}}
.big small{{font-size:70px;margin-left:10px}}
.cal{{display:flex;gap:18px;margin-top:40px}}
.cal .d{{width:190px;height:190px;border:5px solid {INK};border-radius:26px;background:#fff;position:relative;
  display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Jua;font-size:50px;color:{INK}}}
.cal .d em{{font-style:normal;font-family:GB;font-size:30px;margin-top:6px}}
.cal .d .x{{position:absolute;inset:0;border-radius:22px;background:rgba(229,81,31,.88);color:#fff;display:flex;align-items:center;
  justify-content:center;font-family:Jua;font-size:48px;opacity:0}}
.vs{{display:flex;gap:30px;margin-top:40px}}
.vs .b{{flex:1;height:330px;border:5px solid {INK};border-radius:30px;background:#fff;padding:26px;box-sizing:border-box;position:relative}}
.vs .b b{{font-family:Jua;font-weight:normal;font-size:52px;color:{INK}}}
.vs .b p{{font-family:GB;font-size:40px;color:{INK};margin:24px 0 0;line-height:1.35}}
.vs .b .m{{position:absolute;right:22px;bottom:14px;font-family:Jua;font-size:90px}}
.wk{{display:flex;gap:12px;margin-top:40px;align-items:flex-end}}
.wk .c{{width:110px;text-align:center;font-family:Jua;font-size:44px;color:{INK}}}
.wk .c .s{{height:300px;border:4px solid {INK};border-radius:18px;background:#fff;margin-top:10px;position:relative;overflow:hidden}}
.wk .c .f{{position:absolute;left:0;right:0;bottom:0;height:100%;background:#9C978E;transform-origin:50% 100%;transform:scaleY(0)}}
.wk .c .am,.wk .c .pm{{position:absolute;left:0;right:0;height:50%;transform:scaleY(0)}}
.wk .c .am{{top:0;background:{YEL};transform-origin:50% 0}}
.wk .c .pm{{bottom:0;background:#F4B6C2;transform-origin:50% 100%}}
.wk .lg{{font-family:GB;font-size:30px;color:{INK};margin-left:20px;line-height:1.7}}
'''


def scene_html_js(js, idx, sc, to):
    """도식 하나 → (html, 등장·퇴장 js). 시각은 편집 시각으로 바꿔 쓴다."""
    sid = f'g{idx}'
    t0, t1 = E(sc['t0']), E(sc['t1'])
    h = [f'<div class="scn" id="{sid}"><h3>{esc(sc["title"])}</h3>']
    js.append(f'tl.fromTo("#{sid}",{{opacity:0,y:30}},{{opacity:1,y:0,duration:.4,ease:"power3.out"}},{t0:.3f});')
    js.append(f'tl.from("#{sid} h3",{{x:-40,duration:.4,ease:"power3.out"}},{t0:.3f});')
    ty = sc['type']
    at = lambda t: max(t0 + .3, E(t))
    if ty == 'chips':
        h.append('<div>' + ''.join(f'<span class="chip" id="{sid}c{i}">{esc(s)}</span>' for i, (_, s) in enumerate(sc['steps'])) + '</div>')
        for i, (t, _) in enumerate(sc['steps']):
            js.append(f'tl.from("#{sid}c{i}",{{scale:0,opacity:0,duration:.35,ease:"back.out(2.2)"}},{at(t):.3f});')
        tr, s = sc['result']
        h.append(f'<div class="arrow" id="{sid}a">↓</div><div class="res" id="{sid}r" style="left:120px">{esc(s)}</div>')
        js.append(f'tl.from("#{sid}a",{{y:-30,opacity:0,duration:.3}},{at(tr) - .2:.3f});')
        js.append(f'tl.from("#{sid}r",{{scale:.4,opacity:0,duration:.45,ease:"back.out(2.4)"}},{at(tr):.3f});')
    elif ty == 'strike':
        h.append('<div>' + ''.join(f'<div><span class="row" id="{sid}w{i}">{esc(s)}<span class="x"></span></span></div>' for i, (_, s) in enumerate(sc['steps'])) + '</div>')
        for i, (t, _) in enumerate(sc['steps']):
            js.append(f'tl.from("#{sid}w{i}",{{x:-30,opacity:0,duration:.35}},{at(t):.3f});')
            js.append(f'tl.to("#{sid}w{i} .x",{{scaleX:1,duration:.35,ease:"power2.inOut"}},{at(t) + 1.2:.3f});')
        tr, s = sc['result']
        h.append(f'<div class="stamp" id="{sid}s">{esc(s)}</div>')
        js.append(f'tl.from("#{sid}s",{{scale:2.4,opacity:0,duration:.35,ease:"power4.in"}},{at(tr):.3f});')
    elif ty == 'bars':
        for i, (t, lb, v) in enumerate(sc['steps']):
            h.append(f'<div class="bar"><div class="lb">{esc(lb)}</div><div class="tr"><div class="fl" id="{sid}b{i}" style="width:{v}%"></div></div></div>')
            js.append(f'tl.to("#{sid}b{i}",{{scaleX:1,duration:.8,ease:"power2.out"}},{at(t):.3f});')
    elif ty == 'progress':
        h.append(f'<div class="big"><span id="{sid}n">{sc["from"]}</span><small>{esc(sc["unit"])}</small></div>'
                 f'<div class="bar"><div class="tr"><div class="fl" id="{sid}b" style="width:100%"></div></div></div>')
        js.append(f'tl.fromTo("#{sid}b",{{scaleX:{sc["from"] / sc["to"]:.3f}}},{{scaleX:1,duration:1.6,ease:"power1.inOut"}},{t0 + .4:.3f});')
        js.append(f'const {sid}o={{v:{sc["from"]}}};tl.to({sid}o,{{v:{sc["to"]},duration:1.6,ease:"power1.inOut",'
                  f'onUpdate:()=>{{document.getElementById("{sid}n").textContent=Math.round({sid}o.v)}}}},{t0 + .4:.3f});')
    elif ty == 'calendar':
        h.append('<div class="cal">' + ''.join(f'<div class="d" id="{sid}d{i}">토<em>{i + 1}주</em><div class="x">{"휴강" if i == 3 else "행사"}</div></div>' for i in range(4)) + '</div>')
        js.append(f'tl.from("#{sid} .d",{{y:40,opacity:0,duration:.35,stagger:.1,ease:"back.out(2)"}},{t0 + .2:.3f});')
        js.append(f'tl.to("#{sid}d3 .x",{{opacity:1,duration:.3}},{at(sc["steps"][1][0]):.3f});')
        js.append(f'tl.to("#{sid}d1 .x",{{opacity:1,duration:.3}},{at(sc["steps"][2][0]):.3f});')
    elif ty == 'versus':
        (lt, lx), (rt, rx) = sc['left'], sc['right']
        h.append(f'<div class="vs"><div class="b" id="{sid}l"><b>{esc(lt)}</b><p>{esc(lx)}</p><span class="m" style="color:#2E9E5B">○</span></div>'
                 f'<div class="b" id="{sid}r"><b>{esc(rt)}</b><p>{esc(rx)}</p><span class="m" style="color:#E5511F">?</span></div></div>')
        js.append(f'tl.from("#{sid}l",{{x:-40,opacity:0,duration:.4}},{t0 + .2:.3f});')
        js.append(f'tl.from("#{sid}r",{{x:40,opacity:0,duration:.4}},{at(sc["flip"]):.3f});')
        js.append(f'tl.from("#{sid}r .m",{{scale:3,opacity:0,duration:.35,ease:"power4.in"}},{at(sc["flip"]) + 1.5:.3f});')
    elif ty == 'week':
        days = '월화수목금토'
        h.append('<div class="wk">' + ''.join(
            f'<div class="c">{d}<div class="s">' + ('<div class="am"></div><div class="pm"></div>' if d == '토' else '<div class="f"></div>') + '</div></div>'
            for d in days) + '<div class="lg">■ 정규 수업<br><span style="color:#C99A00">■ 토요일 오전</span><br><span style="color:#D77D90">■ 오후는 엄마</span></div></div>')
        js.append(f'tl.to("#{sid} .f",{{scaleY:1,duration:.5,stagger:.08,ease:"power2.out"}},{t0 + .3:.3f});')
        js.append(f'tl.to("#{sid} .am",{{scaleY:1,duration:.5,ease:"back.out(2)"}},{at(sc["steps"][1][0]):.3f});')
        js.append(f'tl.to("#{sid} .pm",{{scaleY:1,duration:.5}},{at(sc["steps"][2][0]):.3f});')
    h.append('</div>')
    js.append(f'tl.to("#{sid}",{{opacity:0,y:-20,duration:.3}},{t1 - .3:.3f});')
    return ''.join(h)


def scene_windows():
    return [(E(s['t0']), E(s['t1'])) for s in SCENES]


def in_scene(t, pad=0.0):
    return any(a - pad <= t < b + pad for a, b in scene_windows())


def logo_png(out):
    import numpy as np
    from PIL import Image
    im = Image.open(ROOT / 'ref/rockys/p01.jpg').convert('RGB')
    a = np.asarray(im).astype(int)
    alpha = np.clip((765 - a.sum(2)) * 3, 0, 255).astype(np.uint8)
    im = im.convert('RGBA'); im.putalpha(Image.fromarray(alpha))
    im.crop(im.getbbox()).save(out)


CSS_BASE = f'''
@font-face{{font-family:Jua;src:url(assets/Jua-Regular.ttf)}}
@font-face{{font-family:GM;src:url(assets/GmarketSansMedium.otf)}}
@font-face{{font-family:GB;src:url(assets/GmarketSansBold.otf)}}
html,body{{margin:0;background:transparent;overflow:hidden}}
#root{{position:relative;overflow:hidden}}
.pill{{display:inline-block;background:{YEL};border:4px solid {INK};border-radius:999px;font-family:Jua;color:{INK};padding:12px 26px 8px}}
.sub{{position:absolute;transform:translateX(-50%);white-space:nowrap;background:rgba(255,255,255,.95);border-radius:22px;
  font-family:GM;color:{INK};padding:20px 32px 16px;opacity:0;box-shadow:0 4px 0 rgba(30,28,26,.12)}}
.vspace{{position:absolute;width:1080px;height:1920px;transform-origin:0 0;overflow:hidden}}
.card{{position:absolute;left:30px;top:1340px;width:1020px;height:520px;box-sizing:border-box;background:{CREAM};
  border:6px solid {INK};border-radius:40px;opacity:0;display:flex;align-items:center;gap:36px;padding:0 50px}}
.card img{{height:330px}}
.card .tag{{font-size:44px}}
.card .t{{font-family:Jua;font-size:132px;line-height:1.05;color:{INK};margin-top:18px}}
.card .s{{font-family:GB;font-size:46px;color:{INK};margin-top:6px}}
.card .s b{{background:linear-gradient(transparent 55%,{YEL} 55%)}}
'''


def subs_js(js, subs, to):
    for i, x in enumerate(subs):
        if x['t0'] >= to:
            break
        t0, t1 = x['t0'], min(x['t1'], to)
        js.append(f'tl.fromTo("#s{i}",{{opacity:0,y:16}},{{opacity:1,y:0,duration:.18,ease:"power2.out"}},{t0:.3f});')
        js.append(f'tl.to("#s{i}",{{opacity:0,duration:.1}},{max(t0 + .2, t1 - .1):.3f});')


def cards_html_js(js, to):
    out = []
    for i, c in enumerate(CARDS):
        if c['t0'] >= to:
            break
        out.append(f'<div class="card" id="c{i}"><img src="assets/logo.png"><div><span class="pill tag">{esc(c["tag"])}</span>'
                   f'<div class="t">{esc(c["title"])}</div><div class="s"><b>{esc(c["sub"])}</b></div></div></div>')
        # 카드 판은 첫 프레임부터 덮여 있어야 한다(옛 그래픽이 비치면 안 됨) — 글자만 들어온다
        js.append(f'tl.set("#c{i}",{{opacity:1}},{c["t0"]:.3f});')
        js.append(f'tl.from("#c{i} .tag",{{x:-30,opacity:0,duration:.35,ease:"power3.out"}},{c["t0"] + .05:.3f});')
        js.append(f'tl.from("#c{i} .t",{{y:30,opacity:0,duration:.4,ease:"back.out(1.6)"}},{c["t0"] + .15:.3f});')
        js.append(f'tl.from("#c{i} .s",{{y:16,opacity:0,duration:.35}},{c["t0"] + .35:.3f});')
        js.append(f'tl.from("#c{i} img",{{rotation:-8,scale:.85,duration:.5,ease:"back.out(2)"}},{c["t0"]:.3f});')
        nxt = CARDS[i + 1]['t0'] if i + 1 < len(CARDS) else None
        if nxt is None or nxt - c['t1'] > .05:   # 이어지는 카드가 없을 때만 내려간다(옛 그래픽이 사라진 뒤)
            js.append(f'tl.to("#c{i}",{{y:620,duration:.45,ease:"power2.in"}},{c["t1"]:.3f});')
        else:
            js.append(f'tl.set("#c{i}",{{opacity:0}},{nxt:.3f});')
    return ''.join(out)


def in_card(t):
    return any(c['t0'] - .05 <= t < c['t1'] + .5 for c in CARDS)


def build_h(folder, to):
    secs = plan['sections']
    css = CSS_BASE + f'''
#hole{{position:absolute;left:{VX}px;top:{VY}px;width:{VW}px;height:{VH}px;border-radius:26px;box-shadow:0 0 0 4000px {CREAM}}}
#ring{{position:absolute;left:{VX - 10}px;top:{VY - 10}px;width:{VW + 20}px;height:{VH + 20}px;border-radius:34px;box-sizing:border-box;border:10px solid {INK}}}
#band{{position:absolute;left:0;top:1000px;width:1920px;height:80px;background:{YEL}}}
#logo{{position:absolute;left:120px;top:70px;height:170px}}
.sec{{position:absolute;inset:0;opacity:0}}
.sec .pill{{position:absolute;left:300px;top:118px;font-size:44px}}
.sec .tt{{position:absolute;left:120px;font-family:Jua;font-size:104px;color:{INK};line-height:1}}
.sec .ul{{position:absolute;left:120px;top:520px;height:20px;background:{YEL};transform-origin:0 50%}}
.pt{{position:absolute;left:120px;width:860px;height:62px;box-sizing:border-box;border:3px solid {INK};border-radius:31px;background:#fff;
  font-family:GB;font-size:38px;color:#78746E;display:flex;align-items:center}}
.pt i{{font-style:normal;width:44px;height:44px;border-radius:50%;background:{INK};color:#fff;font-family:GB;font-size:28px;
  display:flex;align-items:center;justify-content:center;margin:0 18px 0 12px;padding-top:3px;box-sizing:border-box}}
.sub{{font-size:44px;left:560px;top:898px}}
''' + SCENE_CSS
    js = ['const tl=gsap.timeline({paused:true});']
    body = ['<div id="hole"></div><div id="ring"></div><div id="band"></div><img id="logo" src="assets/logo.png">']
    for si, s in enumerate(secs):
        if s['t0'] >= to:
            break
        w = max(len(t) for t in s['title']) * 104
        body.append(f'<div class="sec" id="sec{si}"><span class="pill">{esc(s["tag"])}</span><div class="secin">'
                    f'<div class="tt" style="top:300px">{esc(s["title"][0])}</div><div class="tt" style="top:420px">{esc(s["title"][1])}</div>'
                    f'<div class="ul" style="width:{w}px"></div>'
                    + ''.join(f'<div class="pt" id="p{si}_{i}" style="top:{590 + i * 76}px"><i>{i + 1}</i>{esc(p)}</div>' for i, (_, p) in enumerate(s['points']))
                    + '</div></div>')
        t0 = s['t0']
        js += [f'tl.set("#sec{si}",{{opacity:1}},{t0:.3f});',
               f'tl.from("#sec{si} .pill",{{x:-40,opacity:0,duration:.4,ease:"power3.out"}},{t0 + .1:.3f});',
               f'tl.from("#sec{si} .tt",{{y:40,opacity:0,duration:.5,stagger:.12,ease:"power3.out"}},{t0 + .2:.3f});',
               f'tl.from("#sec{si} .ul",{{scaleX:0,duration:.5,ease:"power2.inOut"}},{t0 + .6:.3f});',
               f'tl.from("#sec{si} .pt",{{x:-50,opacity:0,duration:.35,stagger:.08,ease:"power2.out"}},{t0 + .7:.3f});']
        if si + 1 < len(secs):
            js.append(f'tl.to("#sec{si}",{{opacity:0,duration:.25}},{secs[si + 1]["t0"] - .25:.3f});')
        for i, (tp, _) in enumerate(s['points']):
            tp = max(tp, t0 + 1.2)
            if tp >= to:
                break
            js.append(f'tl.to("#p{si}_{i}",{{backgroundColor:"{YEL}",color:"{INK}",scale:1.03,duration:.3,ease:"back.out(2)"}},{tp:.3f});')
            js.append(f'tl.to("#p{si}_{i}",{{scale:1,duration:.2}},{tp + .3:.3f});')
            if i > 0:
                js.append(f'tl.to("#p{si}_{i - 1}",{{backgroundColor:"#fff",color:"{INK}",duration:.3}},{tp:.3f});')
    for gi, sc in enumerate(SCENES):
        a, b = E(sc['t0']), E(sc['t1'])
        if a >= to:
            continue
        si = next(i for i, s in enumerate(secs) if s['t0'] <= a < s['t1'])
        body.append(f'<div style="position:absolute;left:120px;top:250px">{scene_html_js(js, gi, sc, to)}</div>')
        js.append(f'tl.to("#sec{si} .secin",{{opacity:0,duration:.25}},{a - .25:.3f});')
        js.append(f'tl.to("#sec{si} .secin",{{opacity:1,duration:.3}},{b:.3f});')
    subs = plan['subs']
    body += [f'<div class="sub" id="s{i}">{esc(x["text"])}</div>' for i, x in enumerate(subs) if x['t0'] < to]
    subs_js(js, subs, to)
    js2 = []
    body.append(f'<div class="vspace" style="left:{VX}px;top:{VY}px;transform:scale({VW / 1080})">{cards_html_js(js2, to)}</div>')
    return css, ''.join(body), js + js2


def build_v(folder, to):
    css = CSS_BASE + f'''
#lcard{{position:absolute;left:40px;top:48px;padding:18px 22px;background:rgba(255,255,255,.92);border:4px solid {INK};border-radius:28px}}
#lcard img{{height:150px;display:block}}
#vtag{{position:absolute;left:250px;top:96px;font-size:46px}}
.key{{position:absolute;left:540px;top:500px;transform:translateX(-50%);white-space:nowrap;background:{YEL};border:5px solid {INK};
  border-radius:30px;font-family:Jua;font-size:70px;color:{INK};padding:22px 40px 16px;opacity:0}}
#motto{{position:absolute;left:0;width:1080px;top:1830px;text-align:center;font-family:GB;font-size:28px;color:#fff;
  text-shadow:0 2px 6px rgba(0,0,0,.45)}}
.sub{{font-size:50px;left:540px}}
''' + SCENE_CSS + f'''
.vw .scn{{background:{CREAM};border:5px solid {INK};border-radius:36px;padding:30px;width:940px;height:640px;box-sizing:border-box}}
'''
    js = ['const tl=gsap.timeline({paused:true});',
          'tl.from("#lcard",{x:-40,opacity:0,duration:.45,ease:"power3.out"},.1);',
          'tl.from("#vtag",{x:-30,opacity:0,duration:.4,ease:"power3.out"},.3);']
    body = ['<div id="lcard"><img src="assets/logo.png"></div>',
            f'<span class="pill" id="vtag">{esc(plan["sections"][0]["tag"])}</span>']
    secs = plan['sections']
    for si, s in enumerate(secs[1:], 1):
        if s['t0'] < to:
            js.append(f'tl.to("#vtag",{{opacity:0,duration:.2}},{s["t0"] - .2:.3f});')
            js.append(f'tl.call(()=>{{document.getElementById("vtag").textContent={json.dumps(s["tag"], ensure_ascii=False)}}},null,{s["t0"]:.3f});')
            js.append(f'tl.to("#vtag",{{opacity:1,duration:.3}},{s["t0"]:.3f});')
    # 핵심 카드: 소절(요점) 시작 뒤 5초. 하단 타이틀 카드가 떠 있는 동안은 생략
    k = 0
    for s in secs:
        for i, (tp, p) in enumerate([(s['t0'], s['key'])] + [(tp, p) for tp, p in s['points']]):
            tp = s['t0'] + 4.5 if i == 0 else tp     # 파트 시작은 하단 카드 뒤에
            if tp >= to or in_card(tp) or in_card(tp + 4) or in_scene(tp, 5):
                continue
            body.append(f'<div class="key" id="k{k}">{esc(p)}</div>')
            js.append(f'tl.fromTo("#k{k}",{{opacity:0,scale:.7}},{{opacity:1,scale:1,duration:.35,ease:"back.out(2)"}},{tp:.3f});')
            js.append(f'tl.to("#k{k}",{{opacity:0,y:-20,duration:.3}},{tp + 4.6:.3f});')
            k += 1
    for gi, sc in enumerate(SCENES):
        if E(sc['t0']) < to:
            body.append(f'<div class="vw" style="position:absolute;left:173px;top:190px;transform:scale(.78);transform-origin:0 0">'
                        f'{scene_html_js(js, gi, sc, to)}</div>')
    subs = plan['subs']
    for i, x in enumerate(subs):
        if x['t0'] >= to:
            break
        top = 1180 if in_card(x['t0']) else 1560       # 하단 카드가 덮는 동안 자막은 위로
        body.append(f'<div class="sub" id="s{i}" style="top:{top}px">{esc(x["text"])}</div>')
    subs_js(js, subs, to)
    body.append('<div id="motto">Read for Fun · Read to Think · Read to Learn</div>')
    js2 = []
    body.append(f'<div class="vspace" style="left:0;top:0">{cards_html_js(js2, to)}</div>')
    return css, ''.join(body), js + js2


def build(kind, to):
    folder = HERE / f'hf_{kind}'
    if folder.exists():
        shutil.rmtree(folder)
    (folder / 'assets').mkdir(parents=True)
    shutil.copy2(ASSETS / 'gsap.min.js', folder / 'assets/gsap.min.js')
    for f in ('Jua-Regular.ttf', 'GmarketSansMedium.otf', 'GmarketSansBold.otf'):
        shutil.copy2(ROOT / 'assets/fonts' / f, folder / 'assets' / f)
    logo_png(folder / 'assets/logo.png')
    W, H = (1920, 1080) if kind == 'h' else (1080, 1920)
    css, body, js = (build_h if kind == 'h' else build_v)(folder, to)
    js.append(f'window.__timelines=window.__timelines||{{}};window.__timelines["rk{kind}"]=tl;')
    html = (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head><body>'
            f'<div id="root" data-composition-id="rk{kind}" data-width="{W}" data-height="{H}" data-duration="{to:.3f}" style="width:{W}px;height:{H}px">'
            f'<section class="clip" data-start="0" data-duration="{to:.3f}" style="position:absolute;inset:0">{body}</section></div>'
            f'<script src="assets/gsap.min.js"></script><script>{"".join(js)}</script></body></html>')
    (folder / 'index.html').write_text(html, encoding='utf-8')
    return folder


def render(folder):
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    tmp = folder / 'tmp'; tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMP=str(tmp), TEMP=str(tmp))
    cmd = [npx, '--yes', f'hyperframes@{HYPERFRAMES}', 'render', '.', '--format', 'mov', '--fps', str(FPS),
           '--workers', '2', '--output', 'overlay.mov', '--quiet', '--frames-cache-dir', 'off']
    if subprocess.run(cmd, cwd=folder, env=env).returncode:
        shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir(exist_ok=True)
        cmd[cmd.index('--workers') + 1] = '1'
        subprocess.run(cmd, cwd=folder, check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)
    return folder / 'overlay.mov'


def compose(kind, ov, to, test):
    out = HERE / (f'out_{kind}' + ('_test' if test else '') + '.mp4')
    ed = HERE / 'edited.mp4'
    if kind == 'h':
        fc = (f'color=c=black:s=1920x1080:r={FPS}:d={to:.3f}[bg];[0:v]scale={VW}:{VH}:flags=lanczos,setsar=1[vs];'
              f'[bg][vs]overlay={VX}:{VY}[b2];[b2][1:v]overlay=0:0:format=auto,format=yuv420p[v]')
    else:
        fc = '[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', ed, '-i', ov, '-filter_complex', fc, '-map', '[v]', '-map', '0:a',
                    '-t', f'{to:.3f}', '-r', str(FPS), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
                    '-c:a', 'copy', '-movflags', '+faststart', str(out)], check=True)
    return out


if __name__ == '__main__':
    kind = sys.argv[1]
    to = float(sys.argv[sys.argv.index('--to') + 1]) if '--to' in sys.argv else plan['edit_dur']
    folder = build(kind, to)
    if '--build-only' in sys.argv:
        sys.exit(0)
    ov = render(folder)
    print('→', compose(kind, ov, to, '--to' in sys.argv))
