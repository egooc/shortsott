"""쟁점 브리핑 쇼츠 렌더 — 컷·소리·카메라는 롱투숏 렌더러(D:/midform/scripts/longshort_render.py)를 쓰고,
화면(틀·자막·이름표·끝 카드)은 전부 이 파일의 하이퍼프레임 문서가 그린다.

    python briefing_render.py <plan.json> [--out out.mp4] [--frame-only]

10-15 소유주: «구조는 비슷하게 가도 템플릿은 다르게»(롱투숏의 청록·분홍·G마켓·외곽선 자막 금지),
«롱폼에서 요소를 떼와서» — 롱폼 오버레이(overlay/chrome.py·quote_overlay.py·narration_overlay.py)의
남색·노랑 #F5C518·빨강 NEWS, 페이퍼로지·공군체, 노란 태그·로고 상자, 정당색 띠 인물 카드, 어두운 상자 자막,
아래 티커, 대각선 전환 띠를 그대로 쓴다.
렌더러 파일은 고치지 않는다(롱투숏 세션 소유) — frame_html·render_frame·자막 쓰기만 바꿔 끼운다.

plan 에 더하는 키:
  "date": "10.15 (목)", "credit": "영상: 방송사 날짜"(출처 표기는 늘 보인다)
  "speakers": {"키": {"name": "서영교", "role": "더불어민주당 의원", "color": "#1E5BD8"}},
  sequence 칸마다 "who": "키" — 그 칸이 나오는 동안 이름표가 뜬다(누군지 모르는 칸은 비운다).
  "end": "첫 줄\\n둘째 줄" — 마지막 END_S 초 끝 카드(없으면 기본 문구).
  "ticker": ["...", "..."] — 아래 티커 문구(없으면 제목·구호).
  컷 칸마다 "voices": [[원본초, "키"(, "l"|"r")], ...] — 그 시각부터 말하는 사람(자막 색이 바뀐다). 없으면 그 칸의 who.
    세 번째 값(l·r)을 주면 «끼어드는 말» — 아래 자막이 아니라 그 목소리가 나는 쪽 화면 위에 말풍선으로 튀어나온다
    (10-15 소유주 «끼어드는 말이 나오는 방향 쪽에다가 … 화면에다 띄울 수 있는 거 아니야?»).
    speakers 에 이름 없이 색만 있는 키({"color": ...})도 된다 — 누군지 모르는 목소리는 이름표 없이 색만 가른다.
  "hot": ["꼬리를", ...] — 자막에서 노랗게(흰 상자면 빨갛게) 튀게 할 낱말.
10-15 소유주: «자막을 좀더 자극적으로 색감 표현하고 화자 분리가 됐으면 좋겠어. 컬러로.»
"""
import html, shutil, sys
from pathlib import Path
sys.path.insert(0, 'D:/midform/scripts')
import longshort_render as L

HERE = Path(__file__).resolve().parent
FONT_DIR = HERE.parent / 'assets' / 'fonts'
NAVY, YEL, RED = '#0b0f1c', '#F5C518', '#d4202c'      # 롱폼 chrome.py 와 같은 값
END_S = 3.0
END_DEFAULT = '판단은 여러분의 몫\n매일 국감 쟁점 · 쟁점 브리핑'
_caps = []                 # 렌더러가 넘겨준 자막 칸 (시작, 끝, 글[, y])
_nar = []                  # 그중 해설 칸


def seg_times(plan, total):
    """칸별 (시작, 끝) 출력 시각. 해설 칸 길이 = 전체 - 컷 길이 합."""
    seq = plan['sequence']
    cuts = [round((s['source_out'] - s['source_in']) * L.R.FPS) / L.R.FPS for s in seq if 'source_in' in s]
    nar = max(0.0, (total - sum(cuts)) / max(1, sum(1 for s in seq if 'narration' in s)))
    out, t, ci = [], 0.0, 0
    for s in seq:
        d = nar if 'narration' in s else cuts[ci]
        ci += 'source_in' in s
        out.append((t, t + d)); t += d
    return out


def voice_at(plan, total, t):
    """출력 시각 t 에 말하는 사람 키 — 해설 칸이면 'nar'."""
    for (a, b), s in zip(seg_times(plan, total), plan['sequence']):
        if a <= t < b:
            if 'narration' in s:
                return 'nar'
            src, key, side = s['source_in'] + (t - a), s.get('who'), None
            for v in s.get('voices', []):
                if src >= v[0]:
                    key, side = v[1], (v[2] if len(v) > 2 else None)
            return key, side
    return None, None


def cap_html(text, hot):
    e = html.escape
    return ' '.join('<b>%s</b>' % e(w) if any(h in w for h in hot) else e(w) for w in text.split())


def frame_html(plan, total):
    e = html.escape
    keys = set(plan.get('title_keys', []))
    y0, y1 = L.PIC_Y0, L.PIC_Y1
    title = ''.join('<div class="ln l%d">%s</div>' % (i, ' '.join(
        '<span class="w%s">%s</span>' % (' k' if w in keys else '', e(w)) for w in ln.split()))
        for i, ln in enumerate(plan['title']))
    T = '%.3f' % total
    ticker = plan.get('ticker') or [' '.join(plan['title']), '실제 발언 그대로 · 판단은 시청자 몫', '매일 국감 쟁점은 쟁점 브리핑']
    tick = ''.join('<span>◆ %s</span>' % e(x) for x in ticker) * 6
    css = f"""
@font-face{{font-family:Paper;src:url(assets/Paperlogy-8ExtraBold.ttf)}}
@font-face{{font-family:Body;src:url(assets/ROKAFSansMedium.ttf)}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:1080px;height:1920px;overflow:hidden;word-break:keep-all;font-family:Paper;color:#fff}}
.band{{position:absolute;left:0;right:0;background:{NAVY}}}
#top{{top:0;height:{y0}px}} #bot{{top:{y1}px;bottom:0}}
#tagbar{{position:absolute;left:30px;top:30px;font-size:28px;color:#111;background:{YEL};padding:6px 16px;border-radius:4px;letter-spacing:1px}}
#bug{{position:absolute;right:30px;top:26px;display:flex;align-items:stretch}}
#bug .b{{background:#1a2036;color:#fff;font-size:28px;padding:6px 16px;border-left:6px solid {YEL}}}
#bug .l{{background:{RED};color:#fff;font-size:22px;padding:10px 12px}}
#bug .d{{background:rgba(255,255,255,.92);color:#111;font-size:22px;padding:10px 12px;font-family:Body}}
#title{{position:absolute;left:60px;right:60px;top:130px;text-align:center;font-size:82px;line-height:1.2;letter-spacing:-2px}}
#title .ln{{white-space:nowrap}} #title .l0{{color:#fff}} #title .l1{{color:{YEL}}}
#title .w{{display:inline-block}}   /* 10-16 쇼츠 안전 영역(scripts/shorts_safe.py): 위 UI 130·좌우 60·버튼 열 x<950 — 자막 820·말풍선 right 130 */ #title .l0 .k{{color:{YEL}}} #title .l1 .k{{color:#fff}}
#pic{{position:absolute;left:0;right:0;top:{y0}px;height:{y1 - y0}px;box-shadow:inset 0 6px 0 {YEL}}}
#source{{position:absolute;left:60px;top:{y1 - 50}px;font-family:Body;font-size:22px;color:rgba(255,255,255,.9);
  background:rgba(0,0,0,.45);padding:4px 10px;border-radius:4px}}
.card{{position:absolute;left:60px;top:{y0 + 26}px;padding:14px 22px;background:rgba(10,14,28,.80);border-left:8px solid {YEL};opacity:0}}
.card .n{{font-size:50px;line-height:1.05}} .card .r{{font-family:Body;font-size:25px;color:#cfd6e6;margin-top:6px}}
.cap{{position:absolute;left:0;right:0;text-align:center;opacity:0}}
.cap span{{display:inline-block;max-width:820px;font-size:70px;line-height:1.18;color:#fff;background:#1a2036;padding:8px 30px 12px;border-radius:10px;
  border:4px solid #fff;box-shadow:0 10px 26px rgba(0,0,0,.55);text-shadow:0 3px 0 rgba(0,0,0,.45)}}
.cap span b{{font-weight:normal;color:{YEL}}}
.cap.nar span{{color:#111;background:{YEL};border-color:#111;text-shadow:none}} .cap.nar span b{{color:{RED}}}
.cap.lt span{{color:#111;background:#fff;border-color:#111;text-shadow:none}} .cap.lt span b{{color:{RED}}}
.fl{{position:absolute;top:{y0 + int((y1 - y0) * .44)}px;opacity:0;max-width:600px}}   /* 화면 밖 목소리: 얼굴(위 3분의 1) 아래 어깨 높이 — 말하는 사람 얼굴을 가리지 않게(10-15 s2) */
.fl.l{{left:60px}} .fl.r{{right:130px}}
.fl span{{position:relative;display:inline-block;font-size:64px;line-height:1.15;padding:16px 28px;border-radius:26px;color:#111;background:#fff;
  border:6px solid {RED};box-shadow:0 12px 30px rgba(0,0,0,.6)}}
.fl span b{{font-weight:normal;color:{RED}}}
.fl span:after{{content:"";position:absolute;bottom:-34px;border:18px solid transparent;border-top:20px solid {RED}}}
.fl.l span:after{{left:40px}} .fl.r span:after{{right:40px}}
.fl.l span{{transform:rotate(-4deg)}} .fl.r span{{transform:rotate(4deg)}}
.fl em{{display:block;width:max-content;font-style:normal;font-family:Body;font-size:28px;color:#fff;padding:6px 14px;border-radius:6px;margin-bottom:10px}}
.fl.r em{{margin-left:auto}}
.fl.l span:after{{left:-30px;bottom:20px;border:16px solid transparent;border-right:24px solid {RED};border-left:0}}
.fl.r span:after{{right:-30px;left:auto;bottom:20px;border:16px solid transparent;border-left:24px solid {RED};border-right:0}}
#prog{{position:absolute;left:0;right:0;top:{y1}px;height:8px;background:#ffffff1c}}
#prog i{{position:absolute;left:0;top:0;bottom:0;width:100%;background:{YEL};transform-origin:0 50%;transform:scaleX(0)}}
#tick{{position:absolute;left:0;right:0;top:{y1 + 8}px;height:56px;background:#05070d;overflow:hidden;font-family:Body;font-size:26px;line-height:56px}}
#tick .c{{position:absolute;left:0;top:0;bottom:0;z-index:2;background:{RED};padding:0 18px;font-family:Paper;font-size:26px}}
#tick .r{{position:absolute;left:110px;top:0;white-space:nowrap;color:#e6e9f2}} #tick .r span{{margin-right:36px}}
#logo{{position:absolute;left:0;right:0;top:{y1 + 96}px;display:flex;justify-content:center}}
#logo .b{{background:#1a2036;color:#fff;font-size:44px;padding:10px 26px;border-left:8px solid {YEL}}}
#logo .l{{background:{RED};color:#fff;font-size:30px;padding:0 16px;display:flex;align-items:center}}
#slog{{position:absolute;left:0;right:0;top:{y1 + 190}px;text-align:center;font-family:Body;font-size:26px;color:#cfd6e6}}
#endc{{position:absolute;left:60px;right:60px;top:{y0 + 150}px;background:rgba(10,14,28,.9);border-left:10px solid {YEL};padding:34px 30px;opacity:0}}
#endc span{{display:block;font-size:58px;line-height:1.3;color:#fff}} #endc span:first-child{{color:{YEL}}}
.stg{{position:absolute;top:-300px;height:2600px;width:520px;transform:rotate(18deg)}}
"""
    body = (f'<div class="band" id="top"></div><div class="band" id="bot"></div><div id="pic"></div>'
            f'<div id="tagbar">쟁점 브리핑 · 국감 현장</div>'
            f'<div id="bug"><div class="b">쟁점 브리핑</div><div class="l">NEWS</div><div class="d">{e(plan.get("date", ""))}</div></div>'
            f'<div id="title">{title}</div><div id="source">{e(plan.get("credit", ""))}</div>'
            f'<div id="prog"><i></i></div><div id="tick"><div class="c">쟁점</div><div class="r">{tick}</div></div>'
            f'<div id="logo"><div class="b">쟁점 브리핑</div><div class="l">NEWS</div></div>'
            f'<div id="slog">실제 발언 그대로 · 판단은 시청자 몫</div>')
    for k, v in plan.get('speakers', {}).items():
        if not v.get('name'):
            continue
        body += (f'<div class="card" id="tag_{k}" style="border-left-color:{v.get("color", YEL)}">'
                 f'<div class="n">{e(v["name"])}</div><div class="r">{e(v.get("role", ""))}</div></div>')
    nar, spk, hot, floats = set(_nar), plan.get('speakers', {}), plan.get('hot', []), set()
    for i, c in enumerate(_caps):
        y = c[3] if len(c) > 3 else L.CAP_Y
        who, side = ('nar', None) if c in nar else voice_at(plan, total, (c[0] + c[1]) / 2)
        if side:
            col = spk.get(who, {}).get('color', RED)
            lab = spk.get(who, {}).get('label') or spk.get(who, {}).get('name') or ''
            lab = f'<em style="background:{col}">{e(lab)}</em>' if lab else ''
            body += (f'<div class="fl {side}" id="c{i}">{lab}<span style="border-color:{col}">{cap_html(c[2], hot)}</span></div>')
            floats.add(i)
            continue
        col = spk.get(who, {}).get('color') if who != 'nar' else None
        cls = ' nar' if who == 'nar' else ('' if col else ' lt')
        sty = f'background:{col}' if col else ''
        body += (f'<div class="cap{cls}" id="c{i}" style="top:{y - 52}px"><span style="{sty}">{cap_html(c[2], hot)}</span></div>')
    body += '<div id="endc">%s</div>' % ''.join('<span>%s</span>' % e(x) for x in plan.get('end', END_DEFAULT).split('\n'))
    body += (f'<div class="stg" id="sg0" style="left:-620px;background:{YEL}"></div>'
             f'<div class="stg" id="sg1" style="left:-1150px;background:{NAVY}"></div>')
    js = ['const tl=gsap.timeline({paused:true});',
          'tl.fromTo("#sg0",{x:0},{x:2600,duration:.55,ease:"power3.inOut"},0);',
          'tl.fromTo("#sg1",{x:0},{x:3000,duration:.6,ease:"power3.inOut"},0);',
          f'tl.to("#prog i",{{scaleX:1,duration:{T},ease:"none"}},0);',
          f'tl.fromTo("#tick .r",{{x:0}},{{x:-{int(total * 90)},duration:{T},ease:"none"}},0);',
          'tl.from("#title .w",{opacity:0,y:30,duration:.28,stagger:.05,ease:"power3.out"},.3);',
          'tl.from("#tagbar",{x:-40,opacity:0,duration:.4,ease:"power3.out"},.35);',
          'tl.from("#bug",{opacity:0,y:-20,duration:.4},.3);']
    for i, c in enumerate(_caps):
        if i in floats and c[0] >= total - END_S - .2:   # 끝 카드 구간에 새로 뜨는 말풍선은 띄우지 않는다
            continue
        js.append(f'tl.set("#c{i}",{{opacity:1}},{c[0]:.3f});'
                  f'tl.fromTo("#c{i}",{{scale:{.4 if i in floats else 1.18}}},{{scale:1,duration:.2,ease:"back.out(3)"}},{c[0]:.3f});'
                  f'tl.set("#c{i}",{{opacity:0}},{min(c[1], total - END_S) if i in floats else c[1]:.3f});')   # 말풍선은 끝 카드 뒤로 비치지 않게
    runs = []                                # 이름표: 같은 사람이 이어지는 칸은 한 번에 켠다
    for (a, b), s in zip(seg_times(plan, total), plan['sequence']):
        w = s.get('who')
        if w and runs and runs[-1][0] == w and abs(runs[-1][2] - a) < 1e-3:
            runs[-1][2] = b
        elif w:
            runs.append([w, a, b])
    for w, a, b in runs:
        b = min(b, total - END_S)
        if b - a < .5:
            continue
        js.append(f'tl.to("#tag_{w}",{{opacity:1,duration:.2}},{a + .1:.3f});'
                  f'tl.from("#tag_{w}",{{x:-40,duration:.4,ease:"power3.out"}},{a + .1:.3f});'
                  f'tl.to("#tag_{w}",{{opacity:0,duration:.2}},{b - .2:.3f});')
    t_end = max(0, total - END_S)
    js += [f'tl.to("#endc",{{opacity:1,duration:.25}},{t_end:.3f});',
           f'tl.from("#endc",{{x:-40,duration:.4,ease:"power3.out"}},{t_end:.3f});',
           'window.__timelines=window.__timelines||{};window.__timelines["longshort"]=tl;']
    return ('<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + css + '</style></head><body>'
            f'<div id="root" data-composition-id="longshort" data-width="1080" data-height="1920" data-duration="{T}">'
            f'<section class="clip" data-start="0" data-duration="{T}" style="position:absolute;inset:0">{body}</section></div>'
            '<script src="assets/gsap.min.js"></script><script>' + ''.join(js) + '</script></body></html>')


_orig_render_frame = L.render_frame
_orig_nar_events = L.narration_events


def render_frame(plan, total, work):
    """롱투숏 틀 굽기에 이 채널 글꼴(롱폼과 같은 것)만 더 얹는다."""
    d = work / 'frame.hf' / 'assets'
    d.mkdir(parents=True, exist_ok=True)
    for f in ('Paperlogy-8ExtraBold.ttf', 'ROKAFSansMedium.ttf'):
        shutil.copy2(FONT_DIR / f, d / f)
    return _orig_render_frame(plan, total, work)


def narration_events(plan, work, lang):
    ev = _orig_nar_events(plan, work, lang)
    _nar[:] = [tuple(x) for x in ev]
    return ev


def write_ass(path, title, credit, events, total, lang):
    """자막은 하이퍼프레임 틀이 그린다 — ASS 는 빈 껍데기만(롱투숏 외곽선 자막을 안 쓴다)."""
    _caps[:] = [tuple(x) for x in events]
    return L.write_ass(path, title, credit, [], total, lang)


L.R.CAP_MAX['ko'] = 18      # 자막은 이 틀이 그린다(두 줄까지 감김) — 칸을 말끝에서 끊으려면 12자로는 모자란다(10-15)
L.frame_html = frame_html
L.render_frame = render_frame
L.narration_events = narration_events
L._write_ass = write_ass
if __name__ == '__main__':
    L.main()
