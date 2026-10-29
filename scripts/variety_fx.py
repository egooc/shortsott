# -*- coding: utf-8 -*-
"""쇼폼 예능식 편집 + Earshot 효과음 짝 — 완성 9:16 영상 위에 «?!» 스티커·손글씨 속마음·꼬리표·이름표·빨간 화살표·
물음표 실루엣·펀치 줌을 얹고, 그래픽마다 맞는 효과음을 같은 프레임에 붙인다(10-28 소유주 «이어샷이랑 예능식 편집 페어링해서 쇼폼에»).

그래픽 결은 정치 politics-hour/overlay/hook_overlay.py(시사썰전 결, 16:9 롱폼 훅)를 1080x1920 으로 옮긴 것이다 — 그 파일은
건드리지 않고 하이퍼프레임 렌더만 quote_overlay.render 를 import 한다. 효과음은 D:/midform/tools/earshot 키트(launch, 코드 생성).

    python -X utf8 scripts/variety_fx.py <완성.mp4> <segs.json> --out <out.mp4> [--plan fx.json] [--dry]

segs.json = [{"t0": 초, "t1": 초, "text": "대사", "chunks": [[a, b, "자막 덩어리"], ...]}, ...]  (레인 렌더러의 줄 시각)
fx.json   = auto() 가 만든 효과 목록. --dry 면 fx.json 만 쓰고 끝(눈으로 고친 뒤 --plan 으로 렌더).
효과 하나 = {"t": 초, "dur": 초, "kind": sticker|note|tag|name|arrow|silhouette|punch, ...그래픽 값, "sfx": earshot 역할}
그래픽 자리: 자막(y 1330 부근)과 위 광고 표기(y 0~120)를 피해 y 220~1100 에 둔다.
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 묶음(효과음 72개·gsap) — 저장소 tools/variety_fx. N100 처럼 다른 PC 도 같은 상대 경로, 아니면 VFX_HOME
BUNDLE = Path(os.environ.get('VFX_HOME') or HERE.parent / 'tools' / 'variety_fx')
KIT = BUNDLE / 'kit'
PH = Path('D:/midform/politics-hour')          # 있으면 정치 레인 렌더 함수를 import, 없으면(N100) _hf_render
HYPERFRAMES = '0.8.140'                        # politics-hour config 의 hyperframes 판과 같게
# 글꼴은 저장소에 안 올린다(공개 저장소·재배포 조건). 찾는 순서: --fonts · 영상 위 폴더의 fonts(볼케이노 작업 폴더) · 정치 assets · 설치 글꼴
FONTS = {'Paper': ['Paperlogy-8ExtraBold.ttf', 'BMDOHYEON.ttf', 'SBAggroB.ttf'],
         'Aggro': ['SBAggroB.ttf', 'BMDOHYEON.ttf'],
         'Hand': ['BMYEONSUNG.ttf', 'HakgyoansimAllimjangTTF-R.ttf', 'BMDOHYEON.ttf']}
W, H, FPS = 1080, 1920, 30
REL = None   # --rel: 모든 효과음을 그 자리 믹스 대비 정확히 이 dB 로(역할별 LEVEL 무시). 팬튜브 «원음 위 -18dB 이하» = --rel -18
GAIN = 0.0   # --gain: 모든 효과음에 더할 dB(팬튜브처럼 원음 위에 낮게 깔 때 음수)
YEL, RED, INK, NAVY = '#F5C518', '#E61E2B', '#0b0f1c', '#10131c'
esc = lambda s: html.escape(str(s), quote=True)

# 그래픽 → 효과음 역할(earshot launch 키트). 소유주 «효과음이 거의 안 들려»(10-28) — 목소리와 맞먹게 둔다(LEVEL, 자리 믹스 대비 dB)
SFX = {'sticker': 'pop', 'note': 'pop', 'tag': 'tock', 'name': 'click', 'arrow': 'whoosh.short',
       'silhouette': 'swell', 'punch': 'hit', 'cta': 'bell', 'number': 'click.confirm'}
LEVEL = {'hit': 6.0, 'whoosh.long': 5.0, 'riser': 4.0, 'swell': 4.0, 'whoosh.short': 4.0, 'bell': 4.0,
         'click.confirm': 4.0, 'click': 4.0, 'pop': 5.0, 'tock': 4.0, 'snap': 4.0}

REVEAL = ('범인', '진짜', '비밀', '정체', '이유', '사실은', '알고 보니', '반전')
CTA = ('저장', '링크', '댓글', '팔로우', '구독')
NUM = re.compile(r'\{([^|}]*)\|[^}]*\}|(\d[\d,\.]*\s*(?:년|개|배|만|천|%|원|분|초|시간|번|명|가지)?)')


def _clean(s):
    return re.sub(r'\{([^|}]*)\|[^}]*\}', r'\1', s).replace(' / ', ' ').replace('/', ' ').strip()


def auto(segs):
    """대사 줄에서 효과 자리를 고른다. 같은 종류가 2초 안에 겹치지 않게, 한 줄에 그래픽 하나(+펀치 줌)."""
    fx, last = [], {}
    side = 0

    def add(e):
        if e['t'] - last.get(e['kind'], -9) < 2.0:
            return
        last[e['kind']] = e['t']
        e.setdefault('sfx', SFX.get(e.get('as', e['kind'])))
        fx.append(e)

    for i, s in enumerate(segs):
        text = _clean(s['text'])
        ch = s.get('chunks') or [[s['t0'], s['t1'], text]]
        side ^= 1
        x = 640 if side else 120
        if i == 0:
            add({'t': ch[0][0], 'dur': 0.5, 'kind': 'punch'})
            add({'t': ch[0][0] + 0.1, 'dur': ch[-1][1] - ch[0][0], 'kind': 'sticker', 'text': '!!', 'x': 760, 'y': 300, 'rot': 10})
            continue
        if any(w in text for w in CTA) and i >= len(segs) - 3:
            w = next(w for w in CTA if w in text)
            lines = ['잊기 전에', '저장!'] if w == '저장' else [_clean(ch[-2][2])[:10] if len(ch) > 1 else '지금', w + '!']
            add({'t': ch[-1][0], 'dur': s['t1'] - ch[-1][0], 'kind': 'tag', 'lines': lines, 'x': 120, 'y': 420, 'as': 'cta'})
            continue
        hit = next((w for w in REVEAL if w in text), None)
        if hit:
            k = next((j for j, c in enumerate(ch) if hit in c[2]), 0)
            add({'t': ch[k][0], 'dur': 0.45, 'kind': 'punch'})
            add({'t': ch[k][0] + 0.05, 'dur': s['t1'] - ch[k][0], 'kind': 'arrow', 'from': [260, 520], 'to': [520, 900]})
            add({'t': ch[k][0] + 0.1, 'dur': s['t1'] - ch[k][0], 'kind': 'sticker', 'text': '!!', 'x': 700, 'y': 330, 'rot': -8})
            continue
        m = next((NUM.search(c[2]) and c for c in ch if NUM.search(c[2]) and re.search(r'\d', c[2])), None)
        if m:
            num = re.search(r'\d[\d,\.]*\s*\S*', m[2]).group(0).rstrip('.')
            head = _clean(ch[max(0, ch.index(m) - 1)][2]) if ch.index(m) else ''
            add({'t': m[0], 'dur': s['t1'] - m[0], 'kind': 'tag', 'lines': [head[:10] or '무려', num], 'x': x, 'y': 360, 'as': 'number'})
            continue
        if text.endswith('?'):
            add({'t': ch[-1][0], 'dur': s['t1'] - ch[-1][0], 'kind': 'sticker', 'text': '?!', 'x': 720 if side else 140, 'y': 320,
                 'rot': 8 if side else -8})
            continue
        q = re.search(r'"([^"]+)"', s['text'])
        if q:
            react = '헉..' if '!' in q.group(1) else ('응..?' if '?' in q.group(1) else ('그치..', '오..', '와..')[i % 3])
            add({'t': ch[0][0] + 0.2, 'dur': s['t1'] - ch[0][0] - 0.2, 'kind': 'note', 'text': react, 'x': x, 'y': 560, 'rot': -6 if side else 6})
    return thin_sfx(fx)


# 소유주 «효과음이 너무 잦아»(10-28): 그래픽은 그대로 두고 소리는 큰 순간에만 — 우선순위 높은 것부터 SFX_GAP 초 간격, 한 편 최대 SFX_MAX 개
SFX_RANK = ['punch', 'cta', 'number', 'arrow', 'silhouette', 'tag', 'name', 'sticker', 'note']
SFX_GAP, SFX_MAX = 5.0, 6


def thin_sfx(fx):
    kept = []
    for e in sorted(fx, key=lambda e: (SFX_RANK.index(e.get('as', e['kind'])) if e.get('as', e['kind']) in SFX_RANK else 99, e['t'])):
        if e.get('sfx') and len(kept) < SFX_MAX and all(abs(e['t'] - t) >= SFX_GAP for t in kept):
            kept.append(e['t'])
        else:
            e['sfx'] = None
    return fx


def drop_kinds(fx, kinds, rethin=True):
    """레인이 금지한 그래픽 종류를 뺀다(쇼핑 성장 모드 빨간 화살표 금지 10-30). kind 또는 as 가 맞으면 뺀다.
    rethin=True(자동 배치)면 빠진 자리 효과음 몫을 남은 것들이 다시 나눠 갖는다."""
    kinds = {k.strip() for k in kinds if k.strip()}
    if not kinds:
        return fx
    fx = [e for e in fx if e.get('kind') not in kinds and e.get('as') not in kinds]
    if rethin:
        for e in fx:
            e['sfx'] = SFX.get(e.get('as', e['kind']))
        thin_sfx(fx)
    return fx


SIL = ('<svg viewBox="0 0 400 460" width="400" height="460"><path d="M200 40c62 0 104 46 104 112s-42 122-104 122S96 218 96 152 138 40 200 40z" '
       f'fill="{NAVY}" stroke="#fff" stroke-width="8"/><path d="M20 460c8-110 84-170 180-170s172 60 180 170z" fill="{NAVY}" stroke="#fff" '
       'stroke-width="8"/><text x="200" y="215" text-anchor="middle" font-family="Aggro" font-size="170" fill="#fff">?</text></svg>')


def font_dirs(video, extra=None):
    ds = [Path(extra)] if extra else []
    ds += [q / 'fonts' for q in Path(video).resolve().parents]
    ds += [PH / 'assets' / 'fonts', Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft/Windows/Fonts', Path('C:/Windows/Fonts')]
    return [d for d in ds if d.is_dir()]


def pick_fonts(dirs):
    got = {}
    for fam, names in FONTS.items():
        got[fam] = next((Path(n) for n in names if Path(n).is_absolute() and Path(n).is_file()), None)             or next((d / n for n in names for d in dirs if (d / n).is_file()), None)
        if not got[fam]:
            raise SystemExit(f'글꼴 없음: {fam} — {names} 중 하나를 --fonts 폴더에 두세요(찾은 곳: {[str(d) for d in dirs]})')
    return got


def build(fx, folder, d, fonts):
    """투명 오버레이 하이퍼프레임 index.html(1080x1920). 펀치 줌은 그래픽이 아니라 compose 에서."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    shutil.copy2(BUNDLE / 'gsap.min.js', folder / 'assets' / 'gsap.min.js')
    for fam, f in fonts.items():
        shutil.copy2(f, folder / 'assets' / f'{fam}{f.suffix}')
    css = f'''
@font-face{{font-family:Paper;src:url(assets/Paper{fonts['Paper'].suffix})}}
@font-face{{font-family:Aggro;src:url(assets/Aggro{fonts['Aggro'].suffix})}}
@font-face{{font-family:Hand;src:url(assets/Hand{fonts['Hand'].suffix})}}
html,body{{margin:0;background:transparent}}
#root{{position:relative;width:{W}px;height:{H}px;overflow:hidden;word-break:keep-all}}
.stk{{position:absolute;font-family:Aggro;font-size:260px;line-height:1;color:#fff;-webkit-text-stroke:18px #000;paint-order:stroke fill;opacity:0;letter-spacing:-20px}}
.note{{position:absolute;font-family:Hand;font-size:96px;color:#fff;-webkit-text-stroke:12px #000;paint-order:stroke fill;opacity:0}}
.nm,.tg{{position:absolute;opacity:0;font-family:Paper}}
.nm div,.tg div{{display:table;padding:8px 20px 10px;color:#fff;line-height:1.08}}
.nm .l0{{background:{RED};font-size:58px}} .nm .l1{{background:{INK};font-size:42px}}
.tg{{transform:rotate(-4deg)}} .tg .l0{{background:{INK};font-size:54px}} .tg .l1{{background:{RED};font-size:84px}}
.arr{{position:absolute;left:0;top:0;opacity:0}} .sil{{position:absolute;opacity:0}}
'''
    body, js = [], ['const tl=gsap.timeline({paused:true});']
    for k, e in enumerate(fx):
        a, b, kd = e['t'], e['t'] + e.get('dur', 1.0), e['kind']
        if kd == 'sticker':
            r = e.get('rot', 8)
            body.append(f'<div class="stk" id="e{k}" style="left:{e["x"]}px;top:{e["y"]}px">{esc(e["text"])}</div>')
            js.append(f'tl.fromTo("#e{k}",{{opacity:0,scale:.2,rotation:{-r}}},{{opacity:1,scale:1,rotation:{r},duration:.22,ease:"back.out(3.2)"}},{a:.3f});'
                      f'tl.to("#e{k}",{{rotation:{-r / 2},duration:.12,yoyo:true,repeat:1,ease:"sine.inOut"}},{a + .3:.3f});')
        elif kd == 'note':
            body.append(f'<div class="note" id="e{k}" style="left:{e["x"]}px;top:{e["y"]}px;transform:rotate({e.get("rot", -6)}deg)">{esc(e["text"])}</div>')
            js.append(f'tl.fromTo("#e{k}",{{opacity:0,y:18}},{{opacity:1,y:0,duration:.18,ease:"power2.out"}},{a:.3f});')
        elif kd in ('tag', 'name'):
            cls = 'tg' if kd == 'tag' else 'nm'
            body.append(f'<div class="{cls}" id="e{k}" style="left:{e["x"]}px;top:{e["y"]}px">'
                        + ''.join(f'<div class="l{i}">{esc(t)}</div>' for i, t in enumerate(e['lines'][:2])) + '</div>')
            js.append(f'tl.fromTo("#e{k}",{{opacity:0,scale:1.6}},{{opacity:1,scale:1,duration:.2,ease:"back.out(2.5)"}},{a:.3f});' if kd == 'tag' else
                      f'tl.fromTo("#e{k}",{{opacity:0,x:-30}},{{opacity:1,x:0,duration:.18,ease:"power3.out"}},{a:.3f});')
        elif kd == 'silhouette':
            body.append(f'<div class="sil" id="e{k}" style="left:{e["x"] - 200}px;top:{e["y"] - 230}px">{SIL}</div>')
            js.append(f'tl.fromTo("#e{k}",{{opacity:0,y:40}},{{opacity:1,y:0,duration:.22,ease:"power3.out"}},{a:.3f});')
        elif kd == 'arrow':
            import math
            (x1, y1), (x2, y2) = e['from'], e['to']
            ang = math.atan2(y2 - y1, x2 - x1)
            hx = [x2 - 56 * math.cos(ang - .5), x2 - 56 * math.cos(ang + .5)]
            hy = [y2 - 56 * math.sin(ang - .5), y2 - 56 * math.sin(ang + .5)]
            path = f'M{x1} {y1} Q{(x1 + x2) / 2 + (y2 - y1) * .18:.0f} {(y1 + y2) / 2 - (x2 - x1) * .18:.0f} {x2} {y2}'
            head = f'M{hx[0]:.0f} {hy[0]:.0f} L{x2} {y2} L{hx[1]:.0f} {hy[1]:.0f}'
            body.append(f'<svg class="arr" id="e{k}" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
                        + ''.join(f'<path d="{p}" fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" '
                                  f'pathLength="1" stroke-dasharray="1" class="{cl}"/>'
                                  for p, cl in ((path, 'p'), (head, 'h')) for c, w in (('#fff', 30), (RED, 16))) + '</svg>')
            js.append(f'tl.set("#e{k}",{{opacity:1}},{a:.3f});tl.fromTo("#e{k} .p",{{strokeDashoffset:1}},{{strokeDashoffset:0,duration:.25,ease:"power2.out"}},{a:.3f});'
                      f'tl.fromTo("#e{k} .h",{{strokeDashoffset:1}},{{strokeDashoffset:0,duration:.08}},{a + .23:.3f});')
        else:
            continue
        js.append(f'tl.set("#e{k}",{{opacity:0}},{min(b, d) - 1.5 / FPS:.3f});')
    js.append('window.__timelines=window.__timelines||{};window.__timelines["vfx"]=tl;')
    root = (f'<div id="root" data-composition-id="vfx" data-width="{W}" data-height="{H}" data-duration="{d:.3f}">'
            f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{"".join(body)}</section></div>')
    (folder / 'index.html').write_text(f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head><body>{root}'
                                      f'<script src="assets/gsap.min.js"></script><script>{"".join(js)}</script></body></html>', encoding='utf-8')


def render_overlay(folder, out):
    if (PH / 'overlay' / 'quote_overlay.py').is_file() and not os.environ.get('VFX_WORKERS'):
        sys.path.insert(0, str(PH / 'overlay'))
        import quote_overlay                  # 정치 레인 렌더 함수 import(복사·수정 없음): npx hyperframes → 알파 mov
        return quote_overlay.render(folder, out)
    _hf_render(folder, out)


def _hf_render(folder, out):
    """정치 폴더가 없는 PC(N100)용 — quote_overlay.render 와 같은 명령. 임시 프레임은 작업 폴더 안(C: 안 씀).
    VFX_WORKERS 로 동시 수(기본 2, 램 16GB PC 기준), 실패하면 1 로 다시."""
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    if not npx:
        raise SystemExit('npx 없음 — Node.js 가 필요합니다')
    tmp = Path(folder) / 'tmp'
    tmp.mkdir(exist_ok=True)
    env = dict(os.environ, TMP=str(tmp), TEMP=str(tmp))
    cmd = [npx, '--yes', f'hyperframes@{HYPERFRAMES}', 'render', '.', '--format', 'mov', '--fps', str(FPS),
           '--workers', str(os.environ.get('VFX_WORKERS') or 2), '--output', 'overlay.mov', '--quiet', '--frames-cache-dir', 'off']
    if subprocess.run(cmd, cwd=folder, env=env).returncode:
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(exist_ok=True)
        cmd[cmd.index('--workers') + 1] = '1'
        subprocess.run(cmd, cwd=folder, check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.move(str(Path(folder) / 'overlay.mov'), out)


def _pcm(path, sr=48000):
    import numpy as np
    p = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-vn', '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-'],
                       capture_output=True, check=True)
    return np.frombuffer(p.stdout, np.float32).reshape(-1, 2)


def sfx_track(fx, src, wav):
    """효과마다 키트 테이크를 그 자리 믹스 대비 LEVEL dB 로 얹은 효과음만의 트랙(48k 스테레오 f32 wav).
    earshot 설치 없이 numpy 만 쓴다 — 놓는 식은 earshot.forge.kit.place 와 같다(키트 lock 의 align·offset_ms)."""
    import numpy as np
    SR = 48000
    lock = json.loads((KIT / 'kit.lock.json').read_text(encoding='utf-8'))
    base = _pcm(src, SR)
    out = np.zeros_like(base); used = {}; rows = []
    rms = lambda x: 20 * np.log10(np.sqrt((np.asarray(x, np.float64) ** 2).mean()) + 1e-9)
    for e in fx:
        role = e.get('sfx')
        if not role:
            continue
        r = lock['roles'][role]; tks = r['takes']; tk = tks[used.get(role, 0) % len(tks)]; used[role] = used.get(role, 0) + 1
        al = r.get('align') or 'onset'
        st = e['t'] + float(r.get('offset_ms') or 0) / 1000 - float(tk[f'{al}_s'])
        y = _pcm(KIT / tk['file'], SR)
        pk = int(tk['peak_s'] * SR); fxl = rms(y[max(0, pk - 2400):pk + 4800])
        t = e['t']; bd = rms(base[int(max(0, t - .4) * SR):int((t + .4) * SR)])
        g = bd + (REL if REL is not None else LEVEL.get(role, 4.0) + GAIN) - fxl
        y = y * 10 ** (g / 20); i0 = int(round(st * SR)); off = max(0, -i0); i0 = max(0, i0)
        seg = y[off:off + max(0, len(out) - i0)]; out[i0:i0 + len(seg)] += seg
        rows.append({'t': round(t, 2), 'role': role, 'sound': r.get('sound'), 'take': tk['file'], 'gain_db': round(float(g), 1)})
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-i', '-',
                    '-c:a', 'pcm_f32le', str(wav)], input=out.astype(np.float32).tobytes(), check=True)
    return rows


def compose_sfx_only(src, sfx_wav, out):
    """그래픽·줌 없이 효과음만 — 영상은 다시 인코딩하지 않고 그대로 복사(팬튜브 «원본 컷 그대로»)."""
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(src), '-i', str(sfx_wav), '-filter_complex',
                    '[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a]',
                    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', str(out)], check=True)
    sys.path.insert(0, str(HERE))
    import loudnorm_final
    return loudnorm_final.normalize(str(out))


def compose(src, overlay, sfx_wav, fx, out):
    """원본 위에 펀치 줌(0.45초 1.12→1) + 알파 오버레이 + 효과음 트랙. 영상은 다시 인코딩, 소리는 원본+효과음 합."""
    z = '1'
    for e in fx:
        if e['kind'] == 'punch':
            a, b = e['t'], e['t'] + e.get('dur', .45)
            z = f"if(between(t,{a:.3f},{b:.3f}),1.12-0.12*(t-{a:.3f})/{b - a:.3f},{z})"
    vf = (f"[0:v]scale='trunc(iw*({z})/2)*2':'trunc(ih*({z})/2)*2':eval=frame,crop={W}:{H}:(iw-{W})/2:(ih-{H})/2,setsar=1[bg];"
          f"[bg][1:v]overlay=format=auto,format=yuv420p[v];"
          f"[0:a]aresample=48000[a0];[2:a]aresample=48000[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a]")
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(src), '-i', str(overlay), '-i', str(sfx_wav),
                    '-filter_complex', vf, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium',
                    '-c:a', 'aac', '-b:a', '192k', str(out)], check=True)
    sys.path.insert(0, str(HERE))
    import loudnorm_final
    return loudnorm_final.normalize(str(out))


def _ts(x):
    x = x.replace(',', '.').split(':')
    x = ['0'] * (3 - len(x)) + x
    return int(x[0]) * 3600 + int(x[1]) * 60 + float(x[2])


HEADISH = ('head', 'title', 'top', 'hook')


def _ass_cues(txt):
    r"""ASS → (대사 조각들, 제목 띠 아래 y[1920 기준]).
    제목 띠 = 스타일 이름이 Head/Title/Top/Hook 류이거나, 영상 거의 내내(80%+) 떠 있는 위쪽 1/3 줄.
    아래 끝은 \pos 가 있으면 그 y, 없으면 스타일 정렬·MarginV 로 셈 — 정렬(\an·스타일) 7~9 는 y 가 글자 위, 4~6 가운데, 1~3 아래.
    PlayResY 가 1920 이 아니면 비율로 바꾼다(N100 템플릿 자막, 10-29 «!!» 가 두 줄 제목 끝 글자를 가린 일)."""
    resy = float((re.search(r'^PlayResY:\s*([\d.]+)', txt, re.M) or [0, 1920])[1])
    k = 1920 / resy
    styles, fmt = {}, None
    for ln in txt.splitlines():
        if ln.startswith('Format:') and fmt is None and 'Fontsize' in ln:
            fmt = [x.strip().lower() for x in ln.split(':', 1)[1].split(',')]
        elif ln.startswith('Style:') and fmt:
            v = [x.strip() for x in ln.split(':', 1)[1].split(',')]
            d = dict(zip(fmt, v))
            styles[d.get('name', '')] = {'fs': float(d.get('fontsize') or 60), 'an': int(d.get('alignment') or 2), 'mv': float(d.get('marginv') or 0)}
    ev = []
    for ln in txt.splitlines():
        if not ln.startswith('Dialogue:'):
            continue
        f = ln.split(':', 1)[1].split(',', 9)
        ev.append((f[3].strip(), _ts(f[1].strip()), _ts(f[2].strip()), f[9]))
    end = max((e[2] for e in ev), default=0)
    cues, top = [], 0
    for st, a, b, raw in ev:
        sty = styles.get(st, {'fs': 60, 'an': 2, 'mv': 0})
        m = re.search(r'\\pos\(([\d.]+),([\d.]+)\)', raw); fs = re.search(r'\\fs([\d.]+)', raw); an = re.search(r'\\an(\d)', raw)
        fsz, al = float(fs.group(1)) if fs else sty['fs'], int(an.group(1)) if an else sty['an']
        n = raw.count('\\N') + 1
        y = float(m.group(2)) if m else (sty['mv'] if al >= 7 else (resy / 2 if al >= 4 else resy - sty['mv']))
        bottom = y + fsz * 1.25 * n if al >= 7 else (y + fsz * 1.25 * n / 2 if al >= 4 else y)
        t = re.sub(r'\{[^}]*\}', '', raw).replace('\\N', ' ').strip()
        head = not st.startswith('Disc') and (any(h in st.lower() for h in HEADISH) or (end and b - a >= .8 * end and bottom < resy * .35))
        if head:
            top = max(top, int(bottom * k + 100))     # +100: 첫 화면 펀치 줌(1.12배)·스티커 튀는 크기에도 안 닿게
        elif t and st not in ('Credit', 'Effect') and not st.startswith('Disc'):   # Disc* = 쇼핑 광고 표기
            cues.append((a, b, t, st == 'Dialogue'))
    return cues, top


def load_segs(path):
    """대사 시각표. .json(t0·t1·text·chunks) 그대로, 아니면 자막 파일(.ass·.srt·.vtt)에서 만든다 → (segs, 위쪽 안전 y).
    ASS(볼케이노 어랍숏 captions.ass): Head=영상 내내 떠 있는 제목 → 그 아래부터 그래픽, Narr 조각은 0.08초 넘게 끊기면 새 줄,
    Dialogue(원음 대사) 줄은 따옴표로 감싸 반응 손글씨 대상, Effect·Credit 은 뺀다."""
    p = Path(path); txt = p.read_text(encoding='utf-8-sig')
    if p.suffix.lower() == '.json':
        return json.loads(txt), 0
    cues, top = [], 0
    if p.suffix.lower() == '.ass':
        cues, top = _ass_cues(txt)
    else:
        for blk in re.split(r'\n\s*\n', txt.replace('\r', '')):
            ls = blk.split('\n')
            k = next((i for i, l in enumerate(ls) if '-->' in l), None)
            if k is None:
                continue
            m = re.search(r'([\d:.,]+)\s*-->\s*([\d:.,]+)', ls[k])
            t = re.sub(r'<[^>]+>', '', ' '.join(l.strip() for l in ls[k + 1:] if l.strip())).strip()
            if t:
                cues.append((_ts(m.group(1)), _ts(m.group(2)), t, False))
    cues.sort()
    segs = []
    for a, b, t, dlg in cues:
        if dlg:
            segs.append({'t0': a, 't1': b, 'text': f'"{t}"', 'chunks': [[a, b, t]]})
        elif segs and not segs[-1]['text'].startswith('"') and a - segs[-1]['t1'] < .08 and len(segs[-1]['chunks']) < 3:   # 틈 없이 이어지는 자막(쇼핑)은 3조각마다 끊는다
            segs[-1]['t1'] = b; segs[-1]['text'] += ' / ' + t; segs[-1]['chunks'].append([a, b, t])
        else:
            segs.append({'t0': a, 't1': b, 'text': t, 'chunks': [[a, b, t]]})
    for i, sg in enumerate(segs):
        sg['i'] = i
    return segs, top


def keep_below(fx, top):
    """제목 띠(위쪽 top px)와 겹치는 그래픽을 그 아래로 내린다."""
    for e in fx:
        if 'y' in e and e['y'] < top:
            e['y'] = top
        if 'from' in e and e['from'][1] < top + 120:
            e['from'] = [e['from'][0], e['from'][1] + top]
            e['to'] = [e['to'][0], e['to'][1] + top]
    return fx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video'); ap.add_argument('segs'); ap.add_argument('--out', required=True)
    ap.add_argument('--plan'); ap.add_argument('--dry', action='store_true')
    ap.add_argument('--size', default='1080x1920', help='출력 그래픽 크기 WxH — 16:9 롱폼은 1920x1080(좌표는 fx.json 에 그 크기 기준으로)')
    ap.add_argument('--style', help='JSON {"colors": {"RED": "#..", "INK": "#..", "YEL": "#..", "NAVY": "#.."}, "fonts": {"Paper": [파일명 또는 절대경로], "Aggro": [...], "Hand": [...]}}')
    ap.add_argument('--sfx-only', action='store_true', help='그래픽·펀치 줌 없이 효과음만(영상 복사). plan 의 kind 는 무엇이든 t·sfx 만 쓴다(예: {"t":3.6,"kind":"sfx","sfx":"whoosh.short"})')
    ap.add_argument('--gain', type=float, default=0.0, help='모든 효과음 dB 더하기(기본 0 = 자리 믹스 +4~6dB). 소유주 10-28: -3~-7dB 는 «거의 안 들려»')
    ap.add_argument('--rel', type=float, help='효과음 크기를 그 자리 믹스 대비 이 dB 로 고정(예: -18). --gain 보다 우선')
    ap.add_argument('--top', type=int, help='제목 띠 아래 y(1920 기준) 직접 지정 — 자동 계산보다 우선')
    ap.add_argument('--no-kind', action='append', default=[], help='뺄 그래픽 종류(쉼표·여러 번 가능): arrow·sticker·note·tag·punch·silhouette 또는 as 이름 cta·number. 예: --no-kind arrow')
    ap.add_argument('--fonts', help='글꼴 폴더(없으면 영상 위 폴더의 fonts → 정치 assets → 설치 글꼴)')
    a = ap.parse_args()
    global W, H, YEL, RED, INK, NAVY, GAIN, REL
    GAIN, REL = a.gain, a.rel
    W, H = (int(x) for x in a.size.lower().split('x'))
    if a.style:   # 레인별 결(예: 정치JA 일본 보도 색·일본어 글꼴) — 코드 안 고치고 바꾼다
        st = json.loads(Path(a.style).read_text(encoding='utf-8'))
        c = st.get('colors', {})
        YEL, RED, INK, NAVY = c.get('YEL', YEL), c.get('RED', RED), c.get('INK', INK), c.get('NAVY', NAVY)
        for fam, names in st.get('fonts', {}).items():
            FONTS[fam] = names if isinstance(names, list) else [names]
    out = Path(a.out); work = out.with_suffix('.vfx'); work.mkdir(parents=True, exist_ok=True)
    segs, top = load_segs(a.segs)
    top = a.top if a.top is not None else top
    print('제목 띠 아래 y =', top)
    fx = json.loads(Path(a.plan).read_text(encoding='utf-8')) if a.plan else keep_below(auto(segs), top)
    fx = drop_kinds(fx, ','.join(a.no_kind).split(','), rethin=not a.plan)
    fonts = None if a.sfx_only else pick_fonts(font_dirs(a.video, a.fonts))
    (work / 'fx.json').write_text(json.dumps(fx, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(len(fx), 'effects →', work / 'fx.json')
    if a.dry:
        return
    d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a.video],
                             capture_output=True, text=True, check=True).stdout)
    if a.sfx_only:
        rows = sfx_track(fx, a.video, work / 'sfx.wav')
        ln = compose_sfx_only(a.video, work / 'sfx.wav', out)
    else:
        build(fx, work / 'hf', d, fonts)
        render_overlay(work / 'hf', work / 'overlay.mov')
        rows = sfx_track(fx, a.video, work / 'sfx.wav')
        ln = compose(a.video, work / 'overlay.mov', work / 'sfx.wav', fx, out)
    (work / 'sfx_rows.json').write_text(json.dumps(rows, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('done', out, ln)


if __name__ == '__main__':
    main()
