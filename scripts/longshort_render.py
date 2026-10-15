# 롱투숏(채널 A) 렌더러 — 린박스 렌더러(rinbox_render.py)를 불러 쓰고 화면 틀만 바꾼다.
#
#   python scripts/longshort_render.py <plan.json> [--out out.mp4] [--frame-only]
#
# 왜 따로: 2026-10-13 소유주가 롱투숏 프리셋으로 «B 브랜드 틀 + 크롭»(강형욱은훌륭하다형)과
#   «첫머리 해설 한 줄만»을 골랐고, 하이퍼프레임으로 모션그래픽을 조금 넣자고 했다.
#   컷·음성·자막·카메라·관문은 린박스와 같아야 하므로 베끼지 않고 import 한다(린박스가 고치면 같이 고쳐진다).
#   바뀌는 것은 ① 그림 창 자리 ② 제목·크레딧을 ASS 대신 하이퍼프레임 틀로 ③ 검정 바탕 위에 틀 영상.
#
# 화면 (1080x1920)
#   y   0~ 380  남색 바탕·격자 + 머리줄(FIELD LOG·REC 타임코드) + 제목 2줄(흰·네온 시안, 강조 마젠타)
#               (10-13 저녁 소유주 «야생 소스 vs 최첨단 사이버 틀» 대비로 갈아엎음 — frame_html)
#   y 330~1430  그림 1080x1100 (원본 크롭, 린박스 카메라 그대로) · 왼쪽 위 꼬리표에 출처 · 아래 테두리에 진행 막대
#   y 1430~1530 채널명 알약 · 그 아래는 쇼츠 화면이 덮는 자리(격자 바닥 장식 = 유튜브 글씨의 어두운 받침)
#   자막은 그림 안쪽 아래
#
# plan.json 은 rinbox_render 와 같고 아래만 더한다
#   "brand": {"name": "채널명", "color": "#FF7A00", "accent": "#FFE14D"}
#   "title_keys": ["강조할 낱말", ...]      강조색으로 칠한다(없으면 둘째 줄 전체)
#   "mirror": false                          ★롱투숏은 뒤집지 않는다(지문 깨는 변형은 만들지 않는다)
import argparse, html, json, os, re, shutil, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rinbox_render as R

HF_VERSION = '0.8.80'          # 정치 롱폼 엔진(longform_hyperframes.py)과 같은 핀
# 쇼츠 화면 가림(10-13 소유주 «맨 아래는 유튜브 프레임 때문에 안 보인다») — 아래 ~390px(제목·채널명)과 오른쪽 버튼 줄을 피해
#   보여야 할 것(그림·출처·채널명·진행 막대)은 y 1530 위로 올리고, 그 아래는 유튜브 글씨의 어두운 받침으로만 쓴다
PIC_Y0, PIC_Y1 = 330, 1430
CAP_Y = 1322
FONTS = R.MIDFORM / 'assets' / 'fonts' / 'rinbox'
GSAP = R.MIDFORM / 'cache' / 'volcano-longform' / 'assets' / 'gsap.min.js'
DEFAULT_BRAND = {'name': '지구관측소', 'color': '#22F3FF', 'accent': '#FF2E88', 'bg': '#05070E'}
LS_FONTS = R.MIDFORM / 'assets' / 'fonts' / 'longshort'   # Orbitron·Share Tech Mono (OFL)

# 린박스 화면 상수를 이 채널 것으로 갈아 끼운다 — window()·pic_cam() 이 실행 때 이 값을 읽는다
R.PIC_Y0, R.PIC_Y1, R.PIC_H = PIC_Y0, PIC_Y1, PIC_Y1 - PIC_Y0
R.TITLE_MAX = {**R.TITLE_MAX, 'ko': 11}


def write_ass(path, title, credit, events, total, lang):
    """자막만 ASS 로 — 제목·크레딧은 하이퍼프레임 틀이 그린다."""
    font = 'Gmarket Sans Bold' if lang == 'ko' else 'Noto Sans JP'
    head = ['[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes',
            'PlayResX: %d' % R.W, 'PlayResY: %d' % R.H, '', '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, '
            'Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, '
            'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            'Style: CAP,%s,88,&H00FFFFFF,&H000E0705,&H00FFF322,1,0,0,0,100,100,0,0,1,7,4,5,0,0,0,1' % font,
            '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    # 칸은 (시작, 끝, 글) 또는 (시작, 끝, 글, y) — 해설 칸은 plan 의 nar_cap_y 로 올릴 수 있다(원본에 박힌 자막과 안 겹치게)
    body = ['Dialogue: 1,%s,%s,CAP,,0,0,0,,{\\pos(%d,%d)}%s' % (R.ass_time(e[0]), R.ass_time(e[1]), R.W // 2,
                                                             e[3] if len(e) > 3 else CAP_Y, R.esc(e[2]))
            for e in events]
    path.write_text('\n'.join(head + body) + '\n', encoding='utf-8')


def frame_html(plan, total):
    """사이버 HUD 틀 — 2026-10-13 소유주: «소스는 야생 로드, 틀·모션은 세련된 최첨단·사이버틱으로 대비».
    검은 남색 바탕 · 네온 시안/마젠타 · 원근 격자 · 화면 모서리 브래킷 · 타임코드 · 진행 막대 · 글리치 제목."""
    b = {**DEFAULT_BRAND, **plan.get('brand', {})}
    C, A, BG = b['color'], b['accent'], b.get('bg', '#05070E')
    keys = set(plan.get('title_keys', []))
    e = html.escape

    def title_markup():
        return ''.join('<span class="ln l%d">%s</span>' % (i, ' '.join(
            '<span class="w%s">%s</span>' % (' k' if w in keys else '', e(w)) for w in ln.split()))
            for i, ln in enumerate(plan['title']))
    h = PIC_Y1 - PIC_Y0
    ep = e(str(plan.get('episode', '001')))
    digits = ''.join('<i>%d</i>' % d for d in list(range(10)) + [0])
    six = ''.join('<i>%d</i>' % d for d in list(range(6)) + [0])
    bars = ''.join('<b style="height:%dpx"></b>' % (14 + (i * 37) % 46) for i in range(18))
    css = f"""
@font-face{{font-family:GB;src:url(assets/GmarketSansBold.otf)}}
@font-face{{font-family:ORB;src:url(assets/Orbitron.ttf)}}
@font-face{{font-family:STM;src:url(assets/ShareTechMono.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:1080px;height:1920px;overflow:hidden;word-break:keep-all}}
.band{{position:absolute;left:0;right:0;background:{BG};overflow:hidden}}
#top{{top:0;height:{PIC_Y0}px}} #bot{{top:{PIC_Y1}px;bottom:0}}
.glow{{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,{C}22,transparent 60%)}}
#bot .glow{{background:radial-gradient(ellipse at 50% 100%,{A}26,transparent 65%)}}
.fine{{position:absolute;inset:0;opacity:.10;background-image:linear-gradient({C} 1px,transparent 1px),linear-gradient(90deg,{C} 1px,transparent 1px);background-size:40px 40px}}
.scan{{position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 2px,transparent 2px 4px)}}
#floor{{position:absolute;left:-540px;right:-540px;top:90px;height:900px;transform:perspective(420px) rotateX(62deg);transform-origin:50% 0;
  background-image:linear-gradient({C}AA 2px,transparent 2px),linear-gradient(90deg,{C}AA 2px,transparent 2px);background-size:90px 90px;opacity:.35;
  -webkit-mask-image:linear-gradient(transparent,#000 40%)}}
.mono{{font-family:STM,GB;color:{C};letter-spacing:2px}}
#hdr{{position:absolute;left:36px;right:36px;top:22px;font-size:26px;display:flex;justify-content:space-between}}
#rec{{color:#fff}} #rec .dot{{color:{A};text-shadow:0 0 12px {A}}}
.tc{{display:inline-block;height:28px;overflow:hidden;vertical-align:top}} .tc span{{display:block}} .tc i{{display:block;font-style:normal;height:28px;line-height:28px}}
.tt{{position:absolute;left:30px;right:30px;top:74px;text-align:center;font-family:GB;font-size:96px;line-height:1.16;letter-spacing:-2px}}
.tt .ln{{display:block;white-space:nowrap}}
#title .l0{{color:#fff;text-shadow:0 0 22px rgba(255,255,255,.35)}}
#title .l1{{color:{C};text-shadow:0 0 18px {C},0 0 46px {C}88}}
#title .k{{color:{A};text-shadow:0 0 18px {A},0 0 46px {A}88}}
#title .w{{display:inline-block;opacity:0}}
#g1,#g2{{opacity:0;mix-blend-mode:screen}} #g1 .ln{{color:{A}}} #g2 .ln{{color:{C}}}
#wipe{{position:absolute;left:0;top:74px;width:14px;height:230px;background:#fff;box-shadow:0 0 30px {C},0 0 60px {C};opacity:0}}
#pic{{position:absolute;left:0;right:0;top:{PIC_Y0}px;height:{h}px}}
#pic .edge{{position:absolute;left:0;right:0;height:2px;background:{C};box-shadow:0 0 14px {C}}}
.br{{position:absolute;width:70px;height:70px;border:0 solid {C};filter:drop-shadow(0 0 8px {C})}}
.tl{{left:18px;top:18px;border-left-width:6px;border-top-width:6px}} .tr{{right:18px;top:18px;border-right-width:6px;border-top-width:6px}}
.bl{{left:18px;bottom:18px;border-left-width:6px;border-bottom-width:6px}} .brr{{right:18px;bottom:18px;border-right-width:6px;border-bottom-width:6px}}
.tag{{position:absolute;top:30px;font-size:24px;padding:4px 10px;background:{BG}CC;border:1px solid {C}88}}
#sweep{{position:absolute;left:0;right:0;top:0;height:140px;background:linear-gradient(transparent,{C}33 85%,{C}AA 98%,transparent);opacity:0}}
#src{{position:absolute;left:0;right:0;top:{PIC_Y1 + 120}px;text-align:center;font-size:24px;opacity:.6}}
#src .lab{{color:{A};margin-right:14px}}
#logo{{position:absolute;left:0;right:0;top:{PIC_Y1 + 18}px;text-align:center}}
#logo span{{display:inline-block;font-family:GB;font-size:46px;color:#fff;padding:12px 50px;background:{C}14;border:3px solid {C};
  clip-path:polygon(22px 0,100% 0,100% calc(100% - 22px),calc(100% - 22px) 100%,0 100%,0 22px);text-shadow:0 0 14px {C};white-space:nowrap}}
#eq{{position:absolute;right:40px;top:{PIC_Y1 + 300}px;height:60px;display:flex;align-items:flex-end;gap:5px}}
#eq b{{display:block;width:7px;background:{C};box-shadow:0 0 8px {C};transform-origin:50% 100%}}
#coord{{position:absolute;left:40px;top:{PIC_Y1 + 312}px;font-size:24px;line-height:1.5;opacity:.85}}
#prog{{position:absolute;left:0;right:0;top:{PIC_Y1 + 2}px;height:6px;background:{C}22}}
#prog i{{position:absolute;left:0;top:0;bottom:0;width:100%;background:linear-gradient(90deg,{A},{C});box-shadow:0 0 12px {C};transform-origin:0 50%;transform:scaleX(0)}}
"""
    body = (f'<div class="band" id="top"><div class="fine"></div><div class="glow"></div><div class="scan"></div></div>'
            f'<div class="band" id="bot"><div id="floor"></div><div class="glow"></div><div class="scan"></div></div>'
            f'<div id="hdr" class="mono"><span>◢ OBSERVATORY // {ep}</span>'
            f'<span id="rec"><span class="dot">●</span> REC 00:<span class="tc"><span id="d10">{six}</span></span>'
            f'<span class="tc"><span id="d1">{digits}</span></span></span></div>'
            f'<div class="tt" id="g1">{title_markup()}</div><div class="tt" id="g2">{title_markup()}</div>'
            f'<div class="tt" id="title">{title_markup()}</div><div id="wipe"></div>'
            f'<div id="pic"><div class="edge" style="top:-2px"></div><div class="edge" style="bottom:-2px"></div>'
            f'<div class="br tl"></div><div class="br tr"></div><div class="br bl"></div><div class="br brr"></div>'
            f'<div class="tag mono" style="left:104px">SRC ▸ {e(re.sub(r'^출처\s*[·:|/-]*\s*', '', plan.get('credit', '')))}</div><div class="tag mono" style="right:104px">SIG ▮▮▮▮▯</div>'
            f'<div id="sweep"></div></div>'
            f'<div id="src" class="mono"><span class="lab">◉ SOURCE</span>{e(re.sub(r"^출처\s*[·:|/-]*\s*", "", plan.get("credit", "")))}</div>'
            f'<div id="logo"><span>{e(b["name"])}</span></div>'
            f'<div id="coord" class="mono">OBS.ONLINE<br>NODE {ep} ▸ SYNC</div><div id="eq">{bars}</div>'
            f'<div id="prog"><i></i></div>')
    T = '%.3f' % total
    js = ['const tl=gsap.timeline({paused:true});',
          f'tl.to("#prog i",{{scaleX:1,duration:{T},ease:"none"}},0);',
          f'tl.to("#floor",{{backgroundPosition:"0px 900px",duration:{T},ease:"none"}},0);',
          f'tl.to(".fine",{{backgroundPosition:"0px 40px",duration:{T},ease:"none"}},0);',
          # 타임코드 — 숫자 띠를 계단식으로 올린다(시킹해도 결정적)
          # (계단 tween+repeat 은 끝부분에서 실제보다 10초쯤 앞서 보였다 → 초마다 tl.set 으로 박는다)
          ''.join('tl.set("#d1",{y:%d},%d);tl.set("#d10",{y:%d},%d);' % (-28 * (t % 10), t, -28 * (t // 10 % 6), t)
                  for t in range(int(total) + 1)),
          f'tl.to("#rec .dot",{{opacity:.15,duration:.5,yoyo:true,repeat:{int(total / .5)},ease:"steps(1)"}},0);',
          # 제목: 흰 빛줄이 훑고 지나가며 낱말이 기울어진 채 미끄러져 들어온다
          'tl.fromTo("#wipe",{x:0,opacity:1},{x:1080,duration:.55,ease:"power2.in"},.05);',
          'tl.set("#wipe",{opacity:0},.62);',
          'tl.fromTo("#title .w",{opacity:0,x:-60,skewX:-25,filter:"blur(10px)"},'
          '{opacity:1,x:0,skewX:0,filter:"blur(0px)",duration:.35,stagger:.06,ease:"expo.out"},.12);',
          'tl.from("#pic .br",{scale:1.6,opacity:0,duration:.4,stagger:.05,ease:"back.out(2)"},.25);',
          'tl.from("#pic .tag,#hdr,#src,#coord",{opacity:0,y:12,duration:.3,stagger:.06},.4);',
          'tl.from("#logo span",{scaleX:0,duration:.45,ease:"expo.out"},.55);',
          'tl.from("#eq b",{scaleY:0,duration:.3,stagger:.02},.6);']
    for i in range(18):
        js.append('tl.to("#eq b:nth-child(%d)",{scaleY:%.2f,duration:%.2f,yoyo:true,repeat:%d,ease:"sine.inOut"},.9);'
                  % (i + 1, .25 + (i * 7 % 10) / 14, .28 + (i * 13 % 9) / 20, int(total / .3)))
    # 글리치 — 처음 한 번 + 7초마다, 0.18초만 색 분리가 튄다
    for t in [0.75] + [x * 7.0 + 3.5 for x in range(int(total // 7) + 1) if x * 7.0 + 3.5 < total - .5]:
        js.append('tl.set("#g1",{opacity:.9,x:-9,y:2},%.2f);tl.set("#g2",{opacity:.9,x:8,y:-2},%.2f);'
                  'tl.set("#title",{x:4,skewX:-6},%.2f);tl.set("#g1",{x:6},%.2f);tl.set("#g2",{x:-5},%.2f);'
                  'tl.set("#g1,#g2",{opacity:0,x:0,y:0},%.2f);tl.set("#title",{x:0,skewX:0},%.2f);'
                  % (t, t, t, t + .07, t + .07, t + .18, t + .18))
    # 화면 훑기·로고 맥박 — 6초마다
    for t in [x * 6.0 + 2.0 for x in range(int(total // 6) + 1) if x * 6.0 + 2.0 < total - 1]:
        js.append('tl.fromTo("#sweep",{y:-140,opacity:1},{y:%d,duration:1.1,ease:"none"},%.2f);tl.set("#sweep",{opacity:0},%.2f);'
                  % (h, t, t + 1.1))
        js.append('tl.to("#logo span",{filter:"drop-shadow(0 0 22px %s)",duration:.2,yoyo:true,repeat:1},%.2f);' % (C, t + .5))
    js.append('window.__timelines=window.__timelines||{};window.__timelines["longshort"]=tl;')
    return ('<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + css + '</style></head><body>'
            f'<div id="root" data-composition-id="longshort" data-width="1080" data-height="1920" data-duration="{T}">'
            f'<section class="clip" data-start="0" data-duration="{T}" style="position:absolute;inset:0">{body}</section></div>'
            '<script src="assets/gsap.min.js"></script><script>' + ''.join(js) + '</script></body></html>')


def hf_launcher():
    npx = shutil.which('npx.exe') or shutil.which('npx.cmd') or shutil.which('npx')
    if not npx:
        sys.exit('npx 없음 — Node.js 설치 확인')
    return [npx, '--yes', 'hyperframes@' + HF_VERSION]


def render_frame(plan, total, work):
    """틀(바탕·제목·로고)을 투명 MOV(ProRes 4444)로 굽는다. 같은 문서면 다시 굽지 않는다."""
    d = work / 'frame.hf'
    (d / 'assets').mkdir(parents=True, exist_ok=True)
    shutil.copy2(GSAP, d / 'assets' / 'gsap.min.js')
    shutil.copy2(FONTS / 'GmarketSansBold.otf', d / 'assets' / 'GmarketSansBold.otf')
    for f in ('Orbitron.ttf', 'ShareTechMono.ttf'):
        shutil.copy2(LS_FONTS / f, d / 'assets' / f)
    doc = frame_html(plan, total)
    out = work / 'frame.mov'
    stamp = work / 'frame.stamp'
    if out.is_file() and stamp.is_file() and stamp.read_text(encoding='utf-8') == doc:
        return out
    (d / 'index.html').write_text(doc, encoding='utf-8')
    r = subprocess.run([*hf_launcher(), 'render', '.', '--output', 'frame.mov', '--format', 'mov',
                        '--fps', str(R.FPS), '--workers', '1', '--frames-cache-dir', 'off'], cwd=d,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode or not (d / 'frame.mov').is_file():
        sys.exit('하이퍼프레임 틀 렌더 실패:\n' + (r.stdout + r.stderr)[-2000:])
    os.replace(d / 'frame.mov', out)
    stamp.write_text(doc, encoding='utf-8')
    return out


_state = {}
_run = R.run
_write_ass = write_ass


def run(cmd, **kw):
    """린박스 마지막 합성(검정 캔버스+그림+ASS)만 가로채 틀 영상을 얹는다. 나머지 명령은 그대로."""
    cmd = [str(c) for c in cmd]
    if '-filter_complex' in cmd and cmd[cmd.index('-filter_complex') + 1].startswith('color=c=black'):
        k = cmd.index('-filter_complex')
        fc = cmd[k + 1]
        if '[bg][0:v]overlay=0:%d:shortest=1[p];' % PIC_Y0 not in fc:
            sys.exit('린박스 합성식이 바뀌었다 — longshort_render.run 을 맞춰라:\n' + fc)
        ass = fc[fc.index('[p]ass='):]
        frame = render_frame(_state['plan'], _state['total'], _state['work'])
        cmd[k + 1] = ('color=c=black:s=%dx%d:r=%d[bg];[bg][0:v]overlay=0:%d:shortest=1[pp];'
                      '[pp][2:v]overlay=0:0:format=auto[p];%s' % (R.W, R.H, R.FPS, PIC_Y0, ass))
        cmd[k:k] = ['-i', str(frame)]
    return _run(cmd, **kw)


def narration_events(plan, work, lang):
    """해설 칸도 자막으로 — 린박스는 해설에 자막을 안 달지만 롱투숏 첫머리 한 줄은 글로도 보여야 한다.
    시각은 pieces.json(해설 조각이 결과물 몇 프레임째인지)과 TTS 낱말 시각(캐시라 다시 사지 않는다)으로 잰다."""
    pieces = [p for p in json.loads((work / 'pieces.json').read_text(encoding='utf-8'))['pieces'] if p['kind'] == 'nar']
    nar = {n['id']: n for n in plan['narration']}
    ids = [s['narration'] for s in plan['sequence'] if 'narration' in s]
    cache = R.MIDFORM / 'cache' / 'tts'
    out = []
    for nid, pc in zip(ids, pieces):
        _, meta = R.tts(' '.join(nar[nid]['cards']), lang, cache)
        w = meta['words']
        a = max(0, w[0]['start'] - .065) if w else 0
        words = [(x['start'], x['end'], x['text']) for x in w]
        t0 = pc['out_f0'] / R.FPS
        for ca, cb, text in R.card_times(words, 0, meta['duration'], nar[nid]['cards'], R.JOIN[lang]):
            out.append((t0 + ca - a, min(t0 + cb - a, t0 + pc['frames'] / R.FPS), text, plan.get('nar_cap_y', CAP_Y)))
    return out


def write_ass_hook(path, title, credit, events, total, lang):
    _state['total'] = total          # 합성 직전에 길이를 알아야 틀을 같은 길이로 굽는다
    events = sorted(events + narration_events(_state['plan'], _state['work'], lang))
    return _write_ass(path, title, credit, events, total, lang)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--out', default=None)
    ap.add_argument('--frame-only', action='store_true', help='틀만 구워 본다(길이는 plan 의 frame_seconds, 기본 8초)')
    a = ap.parse_args()
    plan = json.loads(Path(a.plan).read_text(encoding='utf-8'))
    if plan.get('mirror', True):
        sys.exit('롱투숏은 "mirror": false 여야 한다 — 뒤집기는 지문 깨는 변형이다')
    work = Path(a.plan).resolve().parent / '_render'
    work.mkdir(exist_ok=True)
    if a.frame_only:
        print(render_frame(plan, float(plan.get('frame_seconds', 8)), work))
        return
    _state.update(plan=plan, work=work)
    R.write_ass = write_ass_hook
    R.run = run
    sys.argv = [sys.argv[0], a.plan] + (['--out', a.out] if a.out else [])
    R.main()
    end_fade(Path(a.out) if a.out else work / 'final.mp4', float(plan.get('end_fade', 0.6)))


def end_fade(out, d):
    """끝 소리만 d 초 동안 잦아들게 — 소유주(10-13) «너무 갑자기 끝내네, 자연스럽게 끝내야지».
    마지막 컷은 펀치 대사 뒤 반응(웃음·한숨)까지 담고, 그 꼬리를 페이드로 닫는다. 그림·길이는 그대로(관문 수치 불변)."""
    if d <= 0 or not out.is_file():
        return
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(out)],
                               capture_output=True, text=True).stdout.strip())
    tmp = out.with_name(out.stem + '.fade.mp4')
    _run(['ffmpeg', '-loglevel', 'error', '-y', '-i', out, '-af', 'afade=t=out:st=%.3f:d=%.3f' % (dur - d, d),
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', tmp])
    os.replace(tmp, out)
    print('끝 페이드 %.1f초' % d)


if __name__ == '__main__':
    main()
