"""variety_fx 자체 시험 — 렌더 없이: 자막 파일 → 시각표, 제목 띠 피하기, 효과음 솎기, 키트 파일 존재."""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sp = importlib.util.spec_from_file_location('variety_fx', ROOT / 'scripts' / 'variety_fx.py')
v = importlib.util.module_from_spec(sp)
sp.loader.exec_module(v)

ASS = r"""[Script Info]
PlayResX: 1080
PlayResY: 1920

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,0:00:00.00,0:00:18.03,Head,,0,0,0,,{\pos(540,161)\fs106}니트 보풀
Dialogue: 1,0:00:00.00,0:00:18.03,Head,,0,0,0,,{\pos(540,269)\fs106}버리지 마세요
Dialogue: 1,0:00:00.10,0:00:00.90,Dialogue,,0,0,0,,{\pos(540,1250)\fs98}보풀 실화
Dialogue: 1,0:00:01.03,0:00:02.03,Narr,,0,0,0,,{\pos(540,1250)\fs107}아끼는 니트 몇 번
Dialogue: 1,0:00:02.03,0:00:02.83,Narr,,0,0,0,,{\pos(540,1250)\fs107}입었더니 보풀이
Dialogue: 1,0:00:03.66,0:00:04.13,Narr,,0,0,0,,{\pos(540,1250)\fs107}진짜 범인은
Dialogue: 1,0:00:07.80,0:00:08.96,Effect,,0,0,0,,{\pos(540,1060)\fs78}(쓱쓱)
Dialogue: 1,0:00:16.36,0:00:17.06,Narr,,0,0,0,,{\pos(540,1250)\fs107}제품은 고정
Dialogue: 1,0:00:17.06,0:00:18.03,Narr,,0,0,0,,{\pos(540,1250)\fs107}댓글에 있어요
"""
SRT = "1\n00:00:00,500 --> 00:00:01,400\n이 회사는 1994년\n\n2\n00:00:05,000 --> 00:00:06,000\n왜 그럴까요?\n"

fails = 0


def check(name, ok):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name)
    fails += 0 if ok else 1


with tempfile.TemporaryDirectory() as d:
    a = Path(d) / 'c.ass'; a.write_text(ASS, encoding='utf-8')
    segs, top = v.load_segs(a)
    check('ASS 제목 띠 아래 = 472', top == 472)
    check('ASS 줄 묶기: 대사 1 + 해설 3', [s['text'] for s in segs] ==
          ['"보풀 실화"', '아끼는 니트 몇 번 / 입었더니 보풀이', '진짜 범인은', '제품은 고정 / 댓글에 있어요'])
    fx = v.keep_below(v.auto(segs), top)
    check('그래픽이 제목 띠 아래', all(e.get('y', 999) >= top for e in fx) and all(e['from'][1] >= top for e in fx if 'from' in e))
    cta = [e for e in fx if e.get('as') == 'cta']
    check('CTA 박스 = 앞 조각 + 댓글!', cta and cta[0]['lines'] == ['제품은 고정', '댓글!'])
    s = Path(d) / 'c.srt'; s.write_text(SRT, encoding='utf-8')
    segs2, top2 = v.load_segs(s)
    check('SRT 2줄·제목 없음', len(segs2) == 2 and top2 == 0 and abs(segs2[0]['t0'] - .5) < 1e-6)

many = [{'t': t, 'kind': 'sticker', 'sfx': 'pop'} for t in range(0, 40, 2)] + [{'t': 1, 'kind': 'punch', 'sfx': 'hit'}]
kept = [e['t'] for e in v.thin_sfx(many) if e.get('sfx')]
check('효과음 솎기: 최대 6·5초 간격', len(kept) <= v.SFX_MAX and all(abs(x - y) >= v.SFX_GAP for i, x in enumerate(kept) for y in kept[i + 1:]))
check('펀치(hit)가 먼저 남는다', 1 in kept)

lock = json.loads((v.KIT / 'kit.lock.json').read_text(encoding='utf-8'))
need = set(v.SFX.values())
check('쓰는 효과음 역할의 테이크 파일이 다 있다',
      all(lock['roles'].get(r) and all((v.KIT / t['file']).is_file() for t in lock['roles'][r]['takes']) for r in need))
check('gsap 동봉', (v.BUNDLE / 'gsap.min.js').is_file())
sys.exit(1 if fails else 0)
