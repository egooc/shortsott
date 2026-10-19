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
LOCKS = [Path('D:/midform/politics-hour/RENDERING.lock'), Path('D:/midform/politics-hour/RENDERING-ja.lock')]
FREE_GB = 8      # 관리자 10-17 23:19: 무거운 작업 전 다른 레인 lock 없음 + 빈 메모리 8GB 이상, 미달이면 15분마다 재확인


def free_gb():
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in
                    ('total', 'avail', 'tpf', 'apf', 'tv', 'av', 'aev')]
    m = MS(); m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.avail / 2 ** 30


def wait_gate():
    import time
    while True:
        locks = [x.name for x in LOCKS if x.exists()]
        gb = free_gb()
        print(f'[관문] 다른 레인 lock {", ".join(locks) or "없음"} · 빈 메모리 {gb:.1f}GB', flush=True)
        if not locks and gb >= FREE_GB:
            return gb
        time.sleep(15 * 60)
CODE = '2026-10-18b'   # 10-18 말 속도 1.0·문장 사이 0.7초 — 0.95는 숫자 중간이 끊겨 역전사 불일치 11/218(0.97도 2건), 1.0은 0
SUPERTONIC = {'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic',
              'voice': 'F2', 'speed': 1.0, 'steps': 8, 'gap': 0.7, 'lang': 'ja', 'num_reading': False}
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


def load_yomi(ep):
    """ep/yomi.json 의 읽기 표(없으면 빈 표)."""
    f = ep / 'yomi.json'
    return json.loads(f.read_text(encoding='utf-8')).get('yomi', {}) if f.exists() else {}


def apply_yomi(text, yomi):
    """고유명사·기호를 TTS 읽기로 — 영문 한 글자(표 칸 기호 A·B·C·D)는 앞뒤가 영문이 아닐 때만.
    10-18 역전사: 쉼표 바로 뒤의 «ビー»는 합성기가 삼킨다(«なら、ビーの»는 0/8, «ならビーの»는 들림) — 기호 앞 쉼표는 소리에서만 뺀다."""
    for w in sorted(yomi, key=len, reverse=True):
        pat = (r'、?(?<![A-Za-z])' + re.escape(w) + r'(?![A-Za-z])') if w.isascii() else re.escape(w)
        text = re.sub(pat, yomi[w], text)
    return text


def seg_name(i, blk, spec, yomi):
    """seg 폴더 이름 — 읽기 표가 걸리는 장면만 키에 그 항목을 넣어, 표를 고치면 그 장면만 다시 합성된다."""
    hit = {w: r for w, r in sorted(yomi.items()) if any(apply_yomi(s, {w: r}) != s for s in blk['sentences'])}
    return f'{i:03d}-{blk["vid"]}-{key([blk, spec, CODE] + ([hit] if hit else []))}'


def speak(sentences, out, yomi=None):
    job = dict(SUPERTONIC, out=str(Path(out).resolve()), sentences=[[N.to_say(apply_yomi(s, yomi or {})), chunks(s)] for s in sentences])
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
.cap nw{{white-space:nowrap}}
#src{{position:absolute;right:40px;bottom:290px;font-size:26px;font-weight:700;color:#4A4A4A;background:rgba(255,255,255,.85);padding:2px 12px}}
#fic{{position:absolute;right:40px;top:30px;font-size:30px;font-weight:900;color:#fff;background:#6B6B6B;padding:4px 18px 6px;border-radius:8px}}
#stage{{position:absolute;left:14px;right:14px;top:110px;bottom:290px}}
.card{{background:#fff;border:5px solid {BLUE};border-radius:24px;box-shadow:0 10px 0 rgba(30,90,168,.18)}}
.red{{color:{RED}}}
em{{font-style:normal;color:{RED}}}
img{{mix-blend-mode:multiply}}
'''


# v2(10-17 소유주 «레퍼런스와 너무 비슷하면 안 된다 → 일본 고령층 대상 매체에서»): サライ·ハルメク 잡지 특집면 문법 —
# 명조 헤드라인·평면 생지색·藍(구조)·朱(강조)·가는 金茶 괘선·원형 삽화·세로쓰기 장 표시. 질감 없음(소유주 취향).
AI, SHU, KIN, KINARI, SUMI = '#1D3557', '#C8442A', '#B08D57', '#F6F3EC', '#1A2433'
THEME = f'''
@font-face{{font-family:Serif;src:url(assets/NotoSerifJP.ttf);font-weight:100 900}}
#root{{background:{KINARI};color:{SUMI}}}
#frame,#band,#chap{{display:none}}
#side{{position:absolute;left:0;top:0;bottom:0;width:150px;background:{AI}}}
#side .no{{position:absolute;left:0;right:0;top:44px;text-align:center;font-family:Serif;font-weight:900;font-size:40px;color:{KIN};letter-spacing:.1em}}
#side .ti{{position:absolute;left:0;right:0;top:120px;bottom:300px;margin:auto;writing-mode:vertical-rl;font-family:Serif;font-weight:900;font-size:50px;
  line-height:1.15;color:#fff;letter-spacing:.1em;white-space:nowrap;display:flex;align-items:flex-start;justify-content:center}}
#capbar{{position:absolute;left:150px;right:0;bottom:0;height:248px;background:#fff;border-top:3px solid {AI}}}
#capbar::before{{content:"";position:absolute;left:0;top:-3px;width:180px;height:9px;background:{SHU}}}
.cap{{left:190px;right:50px;bottom:0;height:248px}}
.cap span{{color:{SUMI};font-size:92px;line-height:1.16;word-break:auto-phrase;text-wrap:balance;letter-spacing:.02em}}
#src{{right:40px;top:8px;bottom:auto;font-family:Serif;font-size:24px;font-weight:700;color:#5B5B5B;background:none;padding:0;z-index:5}}
#fic{{right:40px;top:46px;background:none;color:{SHU};border:3px solid {SHU};border-radius:0;font-family:Serif;font-size:32px;padding:2px 16px 4px}}
#stage{{left:150px;right:0;top:40px;bottom:262px}}
.card{{background:#fff;border:none;border-top:4px solid {AI};border-bottom:2px solid {KIN};border-radius:0;box-shadow:none}}
em,.red{{color:{SHU}}}
img{{mix-blend-mode:normal}}
#pic{{width:{{PIC}}px;height:{{PIC}}px;object-fit:cover;object-position:50% 14%;border-radius:50%;background:#fff;
  box-shadow:0 0 0 10px {KINARI},0 0 0 14px {KIN}}}
#ti div,#cd .ln,#ls .it,#tt,#fl .q{{word-break:auto-phrase;text-wrap:balance}}
#ti div{{font-family:Serif;color:{SUMI}}}
#ti .k{{font-family:Serif;background:none;color:{SHU};border:4px solid {SHU};border-radius:0;font-size:60px;padding:0 30px 6px}}
#cd .h,#ls .h{{display:block;background:none;color:{AI};font-family:Serif;font-weight:900;font-size:60px;padding:0 0 10px;margin-bottom:16px;
  border-bottom:2px solid {KIN};border-radius:0}}
#cd .ln{{color:{SUMI}}}
#ls .it i{{color:{SHU}}}
#ls .it.on{{color:{SHU}}}
#cs .c small{{background:{AI};border-radius:0;font-family:Sans}}
#cs .c b{{font-family:Serif;color:{SUMI};white-space:nowrap}}
#cs .c.r{{border-top-color:{SHU}}} #cs .c.r small{{background:{SHU}}} #cs .c.r b{{color:{SHU}}}
#cs .op{{color:{KIN};font-family:Serif}}
#tb th{{background:{AI};border-color:{AI};font-family:Serif}}
#tb td{{border:none;border-bottom:2px solid #D9CFBD;font-family:Sans}}
#tb tr.hi td{{color:{SHU};outline:none;background:#FBEDE8}}
#tt{{font-family:Serif;color:{AI}}}
#fl .n{{background:{SHU};border-radius:0;font-family:Serif}}
#fl .a{{color:{AI}}}
#mo .m b{{background:{AI};border-radius:0;font-family:Serif}} #mo .m.on b{{background:{SHU}}}
.bx{{border-color:{SHU}}} .nb{{background:{SHU};font-family:Serif}}
#bb{{border-color:{AI};border-radius:0;font-family:Serif;color:{AI}}}
#cd em,#ls em,#fl em{{background:linear-gradient(transparent 62%,rgba(200,68,42,.22) 62%) no-repeat;background-size:0% 100%}}
'''


def chrome(blk, spec):
    chap = blk['chap']
    if chap == '0':
        no, ti = '', '年金・給付金 手続きノート'
    elif chap == 'まとめ':
        no, ti = '', 'まとめ'
    else:
        no, ti = (chap.split('. ', 1) + [''])[:2] if '. ' in chap else ('', chap)
    body = f'<div id="side"><div class="no">{esc(("第" + "〇一二三四五六七八九"[int(no)] + "章") if no.isdigit() else "")}</div><div class="ti" style="font-size:{min(50, 640 // max(1, len(ti)))}px">{esc(ti)}</div></div><div id="capbar"></div>'
    if spec.get('fiction'):
        body += '<div id="fic">架空の例</div>'
    if spec.get('source'):
        body += f'<div id="src">出典：{esc(spec["source"])}</div>'
    return body


def plain(s):
    return re.sub(r'<[^>]+>', '', str(s))


class Clock:
    """말과 화면을 맞추는 시계 — 낱말이 들리는 순간(자막 덩어리 안 글자 위치 비례)을 돌려준다."""

    def __init__(self, cues, d):
        self.cues, self.d, self.used = cues, d, 0.0

    def find(self, kw):
        if not kw:
            return None
        for a, b, text in self.cues:
            k = text.find(kw)
            if k >= 0:
                return a + (b - a) * k / max(1, len(text))
        return None

    def auto(self, label, default):
        """kw 가 없으면 라벨 글자에서 말에 나오는 가장 긴 앞부분을 찾는다(6자 → 2자)."""
        txt = re.sub(r'[\s（）()・、。→＝=＋+−\-／/：:●■☑✓]', '', plain(label))
        for n in (8, 6, 5, 4, 3, 2):
            for i in range(0, max(1, len(txt) - n + 1)):
                t = self.find(txt[i:i + n])
                if t is not None:
                    return t
        return default

    def at(self, kw, label, default):
        t = self.find(kw) if kw else None
        if t is None:
            t = self.auto(label, default)
        return round(min(max(t, .25), self.d - .6), 2)


# 10-18 발굴 채점: 0부터 0.9초로 세면 정지 화면 표본에 중간값(«年2万円»)이 찍힌다 → 60%에서 0.45초만
COUNT_JS = '''function jpn(v,u){v=Math.round(v);var m=Math.floor(v/10000),r=v%10000,s='';
if(m)s+=m+'万';if(r||!m)s+=(m?r:r.toLocaleString('ja-JP'));return s+u}
function countUp(sel,to,u,t,pre){var o={v:to*.6},q=(to%10000===0&&to>=10000)?10000:(to%100===0?100:1);tl.to(o,{v:to,duration:.45,ease:"power2.out",onUpdate:function(){
document.querySelectorAll(sel).forEach(function(e){e.textContent=(pre||'')+jpn(Math.round(o.v/q)*q,u)})}},t);}
'''


def money(s):
    """«11万3600円» «約3万4500円» → (값, 단위, 앞말). 숫자 카운트가 가능한 표기만."""
    m = re.fullmatch(r'(約|年約|年)?(?:(\d+)万)?(\d[\d,]*)?(円)', plain(s).strip())
    if not m or not (m.group(2) or m.group(3)):
        return None
    v = int(m.group(2) or 0) * 10000 + int((m.group(3) or '0').replace(',', ''))
    return v, m.group(4), m.group(1) or ''


def stage(spec, d, img_dir, doc_dir, cues, cont=0):
    """가운데 판 — (css, body, js). cont = 앞 장면과 같은 표의 이어 그리기면 이미 보인 행 수(그 행은 처음부터 떠 있다). 요소는 해설이 그 낱말을 말하는 순간 나타난다(소유주 10-17 «문장·장면 흐름 따라 모션그래프»).
    움직임은 짧은 사건형 트윈만(정지 구간은 하이퍼프레임이 프레임을 재사용 — 상시 트윈은 15배 느려진다, politics motion.py)."""
    t = spec['type']
    ck = Clock(cues, d)
    css, js = '', []
    if t == 'title':          # 큰 글자 판 — 줄마다 말에 맞춰, 금액은 세며 올라간다
        lines = ''
        for i, ln in enumerate(spec['lines']):
            lines += f'<div class="l{i}" id="t{i}">{ln}</div>'
        css = f'''#ti{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
#ti div{{font-weight:900;font-size:{spec.get("size", 120)}px;line-height:1.25}}
#ti .k{{display:inline-block;background:{BLUE};color:#fff;padding:6px 36px 12px;border-radius:16px;font-size:64px;margin-bottom:24px}}'''
        body = f'<div id="ti">{lines}</div>'
        for i, ln in enumerate(spec['lines']):
            a = .15 if i == 0 else ck.at(None, ln, .15 + i * .45)
            js.append(f'tl.from("#t{i}",{{opacity:0,y:36,duration:.5,ease:"power3.out"}},{a:.2f});')
            for k, em in enumerate(re.findall(r'<em>(.*?)</em>', ln)):
                # 큰 글자 판의 금액은 세지 않고 최종값을 바로 — 썸네일·첫 20초 표본에 중간값이 찍히지 않게(10-18 발굴)
                js.append(f'tl.from("#t{i} em",{{scale:1.25,duration:.45,ease:"back.out(3)"}},{a + .3:.2f});')
        if spec.get('img'):
            css += '#ti{right:620px}#pic{position:absolute;right:40px;bottom:0}'
            body += f'<img id="pic" src="img/{spec["img"]}">'
            js.append('tl.from("#pic",{opacity:0,scale:.85,duration:.6,ease:"back.out(1.6)"},.25);')
        if re.match(r'<span class="k">\d', spec['lines'][0]):       # 장 제목: 藍 패널이 화면을 쓸고 지나간다
            body += '<div id="wipe"></div>'
            css += f'#wipe{{position:absolute;left:-150px;right:0;top:-40px;bottom:-262px;background:{AI};transform-origin:right;z-index:9}}'
            js.insert(0, 'tl.fromTo("#wipe",{scaleX:1},{scaleX:0,duration:.55,ease:"power3.inOut"},.0);')
        return css, body, js
    if t == 'img':            # 삽화 + 카드: 삽화가 먼저 앉고, 줄은 말할 때마다 하나씩
        side = spec.get('lines')
        css = f'''#pic{{position:absolute;left:{80 if side else 0}px;{"" if side else "right:0;margin:auto;"}top:0;bottom:0;margin-top:auto;margin-bottom:auto}}
#cd{{position:absolute;left:760px;right:50px;top:50%;transform:translateY(-50%);padding:34px 50px 40px}}
#cd .ln{{font-weight:900;font-size:{int(spec.get("size", 66) * 1.2)}px;line-height:1.34}}
#bb{{position:absolute;left:{spec.get("bx", 760)}px;top:{spec.get("by", 40)}px;background:#fff;border:5px solid {INK};padding:18px 48px 24px;font-weight:900;font-size:72px}}'''
        body = f'<img id="pic" src="img/{spec["img"]}">'
        js = ['tl.from("#pic",{opacity:0,scale:.86,duration:.6,ease:"back.out(1.5)"},.1);']
        if side:
            body += '<div id="cd" class="card">' + (f'<div class="h" id="h0">{esc(spec["head"])}</div>' if spec.get('head') else '') + ''.join(
                f'<div class="ln" id="l{i}">{ln}</div>' for i, ln in enumerate(side)) + '</div>'
            js.append('tl.from("#cd",{opacity:0,x:60,duration:.5,ease:"power3.out"},.3);')
            prev = .5
            for i, ln in enumerate(side):
                a = max(prev, ck.at((spec.get('at') or [None] * 9)[i] if spec.get('at') else None, ln, prev + .5))
                js.append(f'tl.from("#l{i}",{{opacity:0,x:30,duration:.4,ease:"power2.out"}},{a:.2f});')
                js.append(f'tl.to("#l{i} em",{{backgroundSize:"100% 100%",duration:.5,ease:"power1.out"}},{a + .35:.2f});')
                prev = a + .35
        if spec.get('bubble'):
            body += f'<div id="bb">{esc(spec["bubble"])}</div>'
            js.append(f'tl.from("#bb",{{opacity:0,scale:.5,y:20,duration:.4,ease:"back.out(2.4)"}},{ck.at(None, spec["bubble"], .6):.2f});')
        return css, body, js
    if t == 'doc':            # 공문서 — 말하는 칸으로 카메라가 다가가고, 빨간 테두리가 그려진다
        x0, y0, x1, y1 = spec.get('crop', [0, 0, 1, 1])
        pw, ph = spec.get('page', [1654, 2339])
        cw, ch = (x1 - x0) * pw, (y1 - y0) * ph
        sc = min(680 / ch, 1640 / cw)
        W, H = cw * sc, ch * sc
        css = f'''#dv{{position:absolute;left:0;right:0;top:0;margin:auto;width:{W:.0f}px;height:{H:.0f}px;overflow:hidden;border:4px solid #999;background:#fff;
  box-shadow:0 12px 30px rgba(0,0,0,.18)}}
#cam{{position:absolute;left:0;top:0;width:{W:.0f}px;height:{H:.0f}px;transform-origin:0 0}}
#cam img{{position:absolute;left:{-x0 * pw * sc:.0f}px;top:{-y0 * ph * sc:.0f}px;width:{pw * sc:.0f}px}}
.bx{{position:absolute;border:9px solid {RED};border-radius:10px;box-sizing:border-box}}
.nb{{position:absolute;width:84px;height:84px;border-radius:50%;background:{RED};color:#fff;font-weight:900;font-size:56px;line-height:80px;text-align:center}}'''
        body = f'<div id="dv"><div id="cam"><img src="docs/{spec["src"]}">'
        js = ['tl.from("#dv",{opacity:0,y:30,duration:.5,ease:"power2.out"},.05);']
        prev = .7
        for i, b in enumerate(spec.get('boxes', [])):
            bx0, by0, bx1, by1 = b['r']
            L, T, BW, BH = (bx0 - x0) * pw * sc, (by0 - y0) * ph * sc, (bx1 - bx0) * pw * sc, (by1 - by0) * ph * sc
            body += f'<div class="bx" id="b{i}" style="left:{L:.0f}px;top:{T:.0f}px;width:{BW:.0f}px;height:{BH:.0f}px"></div>'
            if b.get('n'):
                body += f'<div class="nb" id="n{i}" style="left:{max(0, L - 42):.0f}px;top:{max(0, T - 42):.0f}px">{esc(b["n"])}</div>'
            a = max(prev, ck.at(b.get('kw'), '', prev + 1.0))
            z = min(1.7, .78 * W / max(BW, 1), .78 * H / max(BH, 1))
            if z > 1.12:                                      # 칸이 작으면 다가간다
                tx, ty = W / 2 - z * (L + BW / 2), H / 2 - z * (T + BH / 2)
                tx, ty = min(0, max(W - z * W, tx)), min(0, max(H - z * H, ty))
                js.append(f'tl.to("#cam",{{scale:{z:.3f},x:{tx:.0f},y:{ty:.0f},duration:.9,ease:"power2.inOut"}},{a - .2:.2f});')
            js.append(f'tl.fromTo("#b{i}",{{clipPath:"inset(0 100% 100% 0)"}},{{clipPath:"inset(0 0% 0% 0)",duration:.6,ease:"power2.out"}},{a + .5:.2f});')
            if b.get('n'):
                js.append(f'tl.from("#n{i}",{{opacity:0,scale:.3,duration:.35,ease:"back.out(2.4)"}},{a + .8:.2f});')
            prev = a + 1.2
        body += '</div></div>'
        return css, body, js
    if t == 'cards':          # 숫자 식 — 카드가 말 순서대로 들어오고, 금액은 세며 올라가고, 결과 카드는 튄다
        css = f'''#cs{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:34px}}
#cs .c{{padding:24px 40px 30px;text-align:center;min-width:300px}}
#cs .c small{{display:block;font-weight:900;font-size:50px;color:#fff;margin:-24px -40px 18px;padding:8px 20px 12px}}
#cs .c b{{font-weight:900;font-size:{int(spec.get("size", 96) * 1.2)}px}}
#cs .op{{font-weight:900;font-size:110px}}
#nt{{position:absolute;left:0;right:0;bottom:70px;text-align:center;font-weight:700;font-size:46px;color:#333;word-break:auto-phrase}}'''
        body, prev = '<div id="cs">', .3
        items = spec['items']
        for k, it in enumerate(items):
            if isinstance(it, str):
                body += f'<div class="op" id="o{k}">{esc(it)}</div>'
                continue
            body += f'<div class="c card{" r" if it.get("red") else ""}" id="o{k}"><small>{esc(it["label"])}</small><b>{esc(it["value"])}</b></div>'
            a = max(prev, ck.at(it.get('kw'), it['value'], prev + .6))
            if k == 0 and not it.get('kw'):      # 첫 카드는 장면과 같이 — 금액이 말에 나올 때까지 판이 비어 있지 않게
                a = .3
            if k > 0 and isinstance(items[k - 1], str):       # 연산 기호는 카드 바로 앞에
                js.append(f'tl.from("#o{k - 1}",{{opacity:0,scale:.3,rotate:-90,duration:.35,ease:"back.out(2)"}},{a - .2:.2f});')
            js.append(f'tl.from("#o{k}",{{opacity:0,x:60,duration:.45,ease:"power3.out"}},{a:.2f});')
            mv = money(it['value'])
            if mv:
                js.append(f'countUp("#o{k} b",{mv[0]},"{mv[1]}",{a + .05:.2f},"{mv[2]}");')
            if it.get('red'):
                js.append(f'tl.fromTo("#o{k}",{{scale:1}},{{scale:1.08,duration:.18,yoyo:true,repeat:1,ease:"power1.inOut"}},{a + .95:.2f});')
            prev = a + .4
        body += '</div>' + (f'<div id="nt">{esc(spec["note"])}</div>' if spec.get('note') else '')
        if spec.get('note'):
            js.append(f'tl.from("#nt",{{opacity:0,y:16,duration:.4}},{max(prev, ck.at(None, spec["note"], prev + .4)):.2f});')
        return css, body, js
    if t == 'table':          # 표 — 행이 말 순서대로 열리고, 朱 표시가 지금 말하는 행으로 미끄러진다
        css = f'''#tb{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:{spec.get("w", 1600)}px;height:max-content;border-collapse:collapse;background:#fff}}
#tb th{{color:#fff;font-weight:900;font-size:50px;padding:10px 18px}}
#tb td{{font-weight:800;font-size:{spec.get("size", 56)}px;padding:10px 22px;text-align:center;position:relative}}
#tt{{position:absolute;left:0;right:0;top:-6px;text-align:center;font-weight:900;font-size:54px}}
#tb .mk{{position:absolute;left:0;top:10%;bottom:10%;width:12px;background:{SHU};transform:scaleY(0)}}'''
        rows = ''.join(f'<tr id="r{i}" class="{"hi" if i in spec.get("hi", []) else ""}">'
                       + ''.join(f'<td>{"<i class=\"mk\"></i>" if j == 0 else ""}{c}</td>' for j, c in enumerate(r)) + '</tr>'
                       for i, r in enumerate(spec['rows']))
        body = (f'<div id="tt">{esc(spec.get("title", ""))}</div>' if spec.get('title') else '') + \
            f'<table id="tb"><tr>{"".join(f"<th>{esc(h)}</th>" for h in spec["head"])}</tr>{rows}</table>'
        # 같은 표가 이어지는 장면은 틀·앞 행을 다시 그리지 않는다 — 행이 줄었다 다시 느는 재시작(10-19 발굴 재채점)
        js = [] if cont else ['tl.from("#tt",{opacity:0,y:-16,duration:.4},.05);', 'tl.from("#tb",{opacity:0,y:24,duration:.45,ease:"power2.out"},.15);']
        if cont:
            js.append(f'tl.set("#r{cont - 1} .mk",{{scaleY:1}},0);')
        prev, times = .5, []
        for i, r in enumerate(spec['rows']):
            if i < cont:
                times.append(0)
                continue
            kw = (spec.get('at') or [None] * 12)[i] if spec.get('at') else None
            a = .4 if i == cont else max(prev, ck.at(kw, ' '.join(map(str, r)), prev + .6))   # 첫 행은 장면과 같이 — 빈 표 화면 12%(10-18 발굴)
            times.append(a)
            js.append(f'tl.from("#r{i}",{{opacity:0,x:-30,duration:.4,ease:"power2.out"}},{a:.2f});')
            js.append(f'tl.to("#r{i} .mk",{{scaleY:1,duration:.25}},{a + .1:.2f});')
            if i:
                js.append(f'tl.to("#r{i - 1} .mk",{{scaleY:0,duration:.2}},{a + .1:.2f});')
            for j, c in enumerate(r):
                mv = money(c)
                if mv and (i in spec.get('hi', []) or '<span' in str(c)):
                    sel = f'#r{i} td:nth-child({j + 1})' + (' span' if '<span' in str(c) else '')
                    js.append(f'countUp("{sel}",{mv[0]},"{mv[1]}",{a + .05:.2f},"{mv[2]}");')
            prev = a + .35
        return css, body, js
    if t == 'bars':           # 막대그래프 — 묶음이 말 순서대로 자라고, 값은 막대 끝에서 세며 올라간다(10-18 발굴: 그래프 0장)
        groups = spec['groups']
        top = spec.get('max') or max(sum(b['value'] for b in g['bars']) if spec.get('stack') else max(b['value'] for b in g['bars']) for g in groups)
        W = spec.get('bw', 1050)
        css = f'''#bc{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:{spec.get("w", 1600)}px;height:max-content;padding:22px 48px 30px}}
#bc .g{{display:flex;align-items:center;margin:18px 0}}
#bc .h{{font-weight:900;font-size:52px;color:{AI};margin-bottom:10px}}
#bc .gl{{flex:none;width:300px;white-space:nowrap;font-weight:900;font-size:{spec.get("size", 56)}px;color:{SUMI}}}
#bc .bs{{flex:1}}
#bc .b{{display:flex;align-items:center;margin:8px 0}}
#bc .bar{{height:{spec.get("bh", 64)}px;background:#9AA7B8;transform-origin:left center;border-radius:4px}}
#bc .bar.r{{background:{SHU}}}
#bc .seg{{display:inline-block;height:100%;transform-origin:left center}}
#bc .bn{{flex:none;white-space:nowrap;font-weight:800;font-size:42px;color:#555;width:200px}}
#bc .bv{{font-weight:900;font-size:{spec.get("size", 56)}px;margin-left:18px;white-space:nowrap}}
#bc .bv.r{{color:{SHU}}}
#bc .lg{{font-weight:800;font-size:38px;color:#555;margin-top:10px}}
#bc .lg i{{display:inline-block;width:34px;height:26px;margin:0 10px 0 26px;vertical-align:-3px}}
#nt{{position:absolute;left:0;right:0;bottom:60px;text-align:center;font-weight:900;font-size:60px;color:{SHU};word-break:auto-phrase}}'''
        body, prev = '<div id="bc" class="card">' + (f'<div class="h">{esc(spec["title"])}</div>' if spec.get('title') else ''), .3
        for i, g in enumerate(groups):
            body += f'<div class="g" id="g{i}"><div class="gl">{esc(g["label"])}</div><div class="bs">'
            if spec.get('stack'):
                tot = sum(b['value'] for b in g['bars'])
                segs = ''.join(f'<i class="seg" id="g{i}s{k}" style="width:{b["value"] / tot * 100:.2f}%;background:{b.get("color", SHU if b.get("red") else "#9AA7B8")}"></i>'
                               for k, b in enumerate(g['bars']))
                body += (f'<div class="b"><div class="bar" style="width:{tot / top * W:.0f}px;background:none;display:flex">{segs}</div>'
                         f'<b class="bv{" r" if g.get("red") else ""}" id="g{i}v0">{esc(g.get("total_label", ""))}</b></div>')
            else:
                for k, b in enumerate(g['bars']):
                    body += (f'<div class="b">' + (f'<span class="bn">{esc(b["name"])}</span>' if b.get('name') else '')
                             + f'<div class="bar{" r" if b.get("red") else ""}" id="g{i}b{k}" style="width:{b["value"] / top * W:.0f}px"></div>'
                             f'<b class="bv{" r" if b.get("red") else ""}" id="g{i}v{k}">{esc(b["label"])}</b></div>')
            body += '</div></div>'
            kw = (spec.get('at') or [None] * 12)[i] if spec.get('at') else None
            a = .4 if i == 0 else max(prev, ck.at(kw, g['label'], prev + .8))
            js.append(f'tl.from("#g{i}",{{opacity:0,duration:.3}},{a:.2f});')
            if spec.get('stack'):
                for k, b in enumerate(g['bars']):
                    js.append(f'tl.from("#g{i}s{k}",{{scaleX:0,duration:.5,ease:"power2.out"}},{a + .1 + k * .55:.2f});')
                js.append(f'tl.from("#g{i}v0",{{opacity:0,x:-20,duration:.3}},{a + .1 + len(g["bars"]) * .55:.2f});')
            else:
                for k, b in enumerate(g['bars']):
                    js.append(f'tl.from("#g{i}b{k}",{{scaleX:0,duration:.55,ease:"power2.out"}},{a + .1 + k * .35:.2f});')
                    js.append(f'tl.from("#g{i}v{k}",{{opacity:0,x:-20,duration:.3}},{a + .45 + k * .35:.2f});')
            prev = a + .6
        if spec.get('legend'):
            body += '<div class="lg">' + ''.join(f'<i style="background:{c}"></i>{esc(n)}' for n, c in spec['legend']) + '</div>'
        body += '</div>' + (f'<div id="nt">{esc(spec["note"])}</div>' if spec.get('note') else '')
        if spec.get('note'):
            js.append(f'tl.from("#nt",{{opacity:0,y:16,duration:.4}},{max(prev, ck.at(None, spec["note"], prev + .4)):.2f});')
        return css, body, js
    if t in ('toc', 'list'):  # 목차·목록 — 항목이 말할 때 들어오고, 앞 항목은 옅어진다(지금 말하는 것에 눈이 가게)
        on = spec.get('on', -1)
        css = f'''#ls{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:{spec.get("w", 1700)}px;height:max-content;padding:26px 56px 34px}}
#ls .it{{font-weight:900;font-size:{int(spec.get("size", 62) * 1.2)}px;line-height:1.42;color:#333}}
#ls .it i{{font-style:normal;display:inline-block;width:88px}}
#ls .it.dim{{color:#9A9A9A}}'''
        mark = spec.get('mark', '✓' if t == 'list' else None)
        body = '<div id="ls" class="card">' + (f'<div class="h">{esc(spec["head"])}</div>' if spec.get('head') else '')
        for i, x in enumerate(spec['items']):
            cls = 'on' if i == on else ('dim' if on >= 0 and t == 'toc' else '')
            body += f'<div class="it {cls}" id="i{i}"><i>{mark or f"{i + 1}."}</i>{x}</div>'
        body += '</div>'
        js = ['tl.from("#ls",{opacity:0,y:24,duration:.45,ease:"power2.out"},.05);']
        prev, times = .45, []
        for i, x in enumerate(spec['items']):
            kw = (spec.get('at') or [None] * 12)[i] if spec.get('at') else None
            a = max(prev, ck.at(kw, x, prev + .5))
            times.append(a)
            js.append(f'tl.from("#i{i}",{{opacity:0,x:-40,duration:.4,ease:"power3.out"}},{a:.2f});')
            js.append(f'tl.to("#i{i} em",{{backgroundSize:"100% 100%",duration:.5}},{a + .35:.2f});')
            prev = a + .35
        if t == 'list' and len(times) > 2:
            for i in range(len(times) - 1):
                js.append(f'tl.to("#i{i}",{{opacity:.45,duration:.3}},{times[i + 1]:.2f});')
            js.append(f'tl.to("#ls .it",{{opacity:1,duration:.3}},{min(d - .5, times[-1] + 1.6):.2f});')
        return css, body, js
    if t == 'flow':           # 판정 질문 — 질문이 뜨고, 답이 도장처럼 찍힌다
        css = f'''#fl{{position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:1600px;height:max-content;padding:30px 60px 40px}}
#fl .n{{display:inline-block;color:#fff;font-weight:900;font-size:52px;padding:4px 26px 8px}}
#fl .q{{font-weight:900;font-size:68px;line-height:1.35;margin-top:16px}}
#fl .a{{margin-top:24px;font-weight:900;font-size:60px}}'''
        body = f'<div id="fl" class="card"><div class="n">{esc(spec["n"])}</div><div class="q">{spec["q"]}</div>' + \
            (f'<div class="a" id="an">{spec["a"]}</div>' if spec.get('a') else '') + '</div>'
        js = ['tl.from("#fl",{opacity:0,y:24,duration:.45},.05);', 'tl.from("#fl .n",{opacity:0,scale:.4,duration:.35,ease:"back.out(2.4)"},.3);']
        if spec.get('a'):
            a = ck.at(spec.get('a_kw'), spec['a'], d * .55)
            js.append(f'tl.from("#an",{{opacity:0,scale:1.6,duration:.35,ease:"power4.out"}},{a:.2f});')
            js.append(f'tl.to("#an em",{{backgroundSize:"100% 100%",duration:.5}},{a + .35:.2f});')
        return css, body, js
    if t == 'months':         # 지급월 — 표시가 달을 따라 걸어가고, 12월에서 터진다
        css = f'''#mo{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:22px}}
#mo .m{{width:230px;text-align:center}}
#mo .m b{{display:block;font-weight:900;font-size:58px;color:#fff;padding:6px 0 10px}}
#mo .m span{{display:block;margin-top:16px;font-weight:900;font-size:48px;line-height:1.3}}
#mo .m.on span{{color:{SHU}}}
#walk{{position:absolute;top:calc(50% - 120px);left:0;width:230px;height:10px;background:{SHU}}}
#nt{{position:absolute;left:0;right:0;bottom:70px;text-align:center;font-weight:800;font-size:48px}}'''
        n = len(spec['items'])
        body = '<div id="mo">' + ''.join(f'<div class="m{" on" if m.get("on") else ""}" id="m{i}"><b>{esc(m["m"])}</b><span>{m.get("v", "")}</span></div>'
                                         for i, m in enumerate(spec['items'])) + '</div>' + (f'<div id="nt">{spec["note"]}</div>' if spec.get('note') else '')
        js = [f'tl.from("#m{i}",{{opacity:0,y:24,duration:.35,ease:"power2.out"}},{.2 + i * .22:.2f});' for i in range(n)]
        hit = ck.at(None, '12月', .2 + n * .22 + .8)
        js.append(f'tl.fromTo("#m{n - 1} b",{{scale:1}},{{scale:1.18,duration:.22,yoyo:true,repeat:1}},{hit:.2f});')
        if spec.get('note'):
            js.append(f'tl.from("#nt",{{opacity:0,y:16,duration:.4}},{ck.at(spec.get("note_kw"), spec["note"], hit + .6):.2f});')
        return css, body, js
    raise SystemExit('모르는 화면 종류: ' + t)


def transitions(d, cont=False):
    """장면 넘김 — 판이 살짝 밀려 들어온다. 나갈 때 사라지지 않는다: 끝 0.28초 페이드+들어올 때 빈 판이 겹쳐 장면 경계마다
    본문이 빈 순간이 생겼다(10-19 발굴 «14초 본문 빈 순간»). 첫 프레임부터 본문이 보이게 불투명도 0.4에서 시작. 같은 표 이어 그리기는 넘김 없음."""
    return [] if cont else ['tl.fromTo("#stage",{opacity:.4,x:-28},{opacity:1,x:0,duration:.3,ease:"power2.out"},0);']


FROM0 = re.compile(r'tl\.from\(("[^"]+"),\{opacity:0,([^}]*)\},([0-9.]+)\);')


def no_blank(js):
    """장면 첫 0.45초 안에 들어오는 요소는 0초에 불투명도 0.4에서 시작 — 첫 요소가 투명도 0으로 0.15~0.4초 기다리면
    장면 경계마다 본문이 빈 화면이 찍혔다(10-19 발굴 «14초 본문 빈 순간», 재렌더 뒤 13.9·24.6초에 남아 있던 것)."""
    def fix(m):
        return f'tl.from({m.group(1)},{{opacity:.4,{m.group(2)}}},0);' if float(m.group(3)) <= .45 else m.group(0)
    return [FROM0.sub(fix, x) for x in js]


def continues(prev, spec):
    """앞 장면과 같은 표(제목·머리줄 같고 앞 장면 행이 이번 행의 앞부분)면 이어 그릴 행 수, 아니면 0."""
    if not prev or prev.get('type') != 'table' or spec.get('type') != 'table':
        return 0
    if prev.get('title') != spec.get('title') or prev.get('head') != spec.get('head'):
        return 0
    n = len(prev['rows'])
    same = [[plain(str(c)) for c in r] for r in spec['rows'][:n]] == [[plain(str(c)) for c in r] for r in prev['rows']]   # 朱 표시만 옮겨 간 행은 같은 행
    return n if n < len(spec['rows']) and same else 0


NOBREAK = re.compile(r'(?:年約|年|月|約|毎月)?(?<![\d#x])\d[\d,.]*(?:[万億]\d[\d,]*)*[万億]?(?:円|歳|回|人|か月|年|月|日|パーセント|%)?')


def captions(cues, d, emph=()):
    body, js = '', []
    for i, (a, b, text) in enumerate(cues):
        tx = NOBREAK.sub(lambda m: f'<nw>{m.group()}</nw>', esc(text))   # «年 / 11万円» 같은 숫자 덩어리 중간 줄바꿈 금지(강조보다 먼저 묶는다)
        for w in sorted(emph, key=len, reverse=True):
            tx = tx.replace(esc(w), f'<em>{esc(w)}</em>')
        body += f'<div class="cap" id="c{i}"><span>{tx}</span></div>'
        end = cues[i + 1][0] if i + 1 < len(cues) else d   # 문장 사이 쉼에도 자막 띠를 비우지 않는다(다음 자막이 뜰 때 내린다)
        # 장면 경계에서 띠가 1~2프레임 비던 곳 87(10-19 발굴): 첫 자막은 2프레임 앞당기고(0 아래로는 안 감), 마지막 자막은 장면 끝까지 둔다
        start = max(0.0, a - 2 / FPS) if i == 0 else a
        js.append(f'tl.set("#c{i}",{{opacity:1}},{start:.3f});' + (f'tl.set("#c{i}",{{opacity:0}},{end:.3f});' if i + 1 < len(cues) else ''))
    return body, js


def page(folder, cid, d, css, body, js, ep, pic=560):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    if not (folder / 'assets' / 'NotoSansJP.ttf').exists():
        shutil.copy2(FONTS / 'NotoSansJP.ttf', folder / 'assets' / 'NotoSansJP.ttf')
    if not (folder / 'assets' / 'NotoSerifJP.ttf').exists():   # 굵기 가변(OFL, Google Fonts) — 명조 헤드라인 900
        shutil.copy2(HERE / 'fonts' / 'NotoSerifJP-VF.ttf', folder / 'assets' / 'NotoSerifJP.ttf')
    shutil.copy2(GSAP, folder / 'assets' / 'gsap.min.js')
    for sub in ('img', 'docs'):
        link = folder / sub
        if not link.exists():
            shutil.copytree(ep / sub, link)
    (folder / 'index.html').write_text(
        f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>{CSS}{css}{THEME.replace("{PIC}", str(pic))}</style></head><body>'
        f'<div id="root" data-composition-id="{cid}" data-width="1920" data-height="1080" data-duration="{d:.3f}">'
        f'<section class="clip" data-start="0" data-duration="{d:.3f}" style="position:absolute;inset:0">{body}</section></div>'
        f'<script src="assets/gsap.min.js"></script><script>const tl=gsap.timeline({{paused:true}});{COUNT_JS}{"".join(js)}'
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
            k = continues(vis[blocks[i - 1]['vid']] if i else None, spec)
            sc, sb, sj = stage(spec, d, ep / 'img', ep / 'docs', cues, k)
            cb, cj = captions(cues, d, emph)
            f = out / f'{i:03d}'
            page(f, f's{i}', d, sc, chrome(blk, spec) + f'<div id="stage">{sb}</div>' + cb, transitions(d, bool(k)) + no_blank(sj) + cj, ep)
            last = max((a for a, b, x in cues if b - a > 1.5), default=d * .8)
            subprocess.run([npx, '--yes', f'hyperframes@{HYPERFRAMES}', 'snapshot', '.', '--at', f'{min(d - .1, last + .8):.2f}', '--no-end',
                            '--describe', 'false', '-o', str(f / 'snap')], cwd=f, capture_output=True)
            (out / 'png').mkdir(exist_ok=True)
            for p in sorted((f / 'snap').glob('*.png'))[:1]:
                shutil.copy2(p, out / 'png' / f'v{i:03d}_{blk["vid"]}.png')
            print(i, blk['vid'], flush=True)
        return 0
    if '--no-gate' not in argv:
        wait_gate()
    work = ep / 'seg'
    work.mkdir(exist_ok=True)
    yomi = load_yomi(ep)
    parts, total = [], 0.0
    for i in rng:
        blk, spec = blocks[i], vis[blocks[i]['vid']]
        folder = work / seg_name(i, blk, spec, yomi)
        final = folder / 'segment.mp4'
        if not final.exists():
            folder.mkdir(parents=True, exist_ok=True)
            wav = folder / 'voice.wav'
            if wav.exists() and (folder / 'cues.json').exists():      # --tts-only 로 미리 만든 소리는 다시 합성하지 않는다
                cues = json.loads((folder / 'cues.json').read_text(encoding='utf-8'))
            else:
                cues = speak(blk['sentences'], wav, yomi)
                (folder / 'cues.json').write_text(json.dumps(cues, ensure_ascii=False) + '\n', encoding='utf-8')
            if '--tts-only' in argv:
                print(f'[{i}] tts {wav_seconds(wav):.1f}s', flush=True)
                continue
            d = round(wav_seconds(wav) + .45, 3)
            k = continues(vis[blocks[i - 1]['vid']] if i else None, spec)
            sc, sb, sj = stage(spec, d, ep / 'img', ep / 'docs', cues, k)
            cb, cj = captions(cues, d, emph)
            page(folder / 'hf', f's{i}', d, sc, chrome(blk, spec) + f'<div id="stage">{sb}</div>' + cb, transitions(d, bool(k)) + no_blank(sj) + cj, ep)
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
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', str(out)], check=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
    import loudnorm_final   # 카이안 K12 -14 LUFS 2패스(옛 1패스 I=-16 은 ①편 -16.0 으로 나왔다)
    print(loudnorm_final.normalize(out))
    print(out, f'{total / 60:.1f}분')
    return 0


if __name__ == '__main__':
    sys.exit(main())
