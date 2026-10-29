"""variety_fx 자체 시험 — 렌더 없이: 자막 파일 → 시각표, 제목 띠 피하기, 효과음 솎기, 키트 파일 존재."""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sp = importlib.util.spec_from_file_location('variety_fx', ROOT / 'scripts' / (sys.argv[1] if len(sys.argv) > 1 else 'variety_fx.py'))
v = importlib.util.module_from_spec(sp)
sp.loader.exec_module(v)

ASS = r"""[Script Info]
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Head,SB Aggro Bold,106,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,20,20,0,1
Style: Narr,BM DoHyeon,107,&H00F9F8F8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,9,0,5,20,20,0,1

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
# N100 야생일지 템플릿 꼴(10-29 스티커가 두 줄 제목 끝 글자를 가림): \pos 없음·정렬 8·MarginV·PlayResY 1280
TPL = r"""[Script Info]
PlayResX: 720
PlayResY: 1280

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,X,64,&H0,&H0,&H0,&H0,0,0,0,0,100,100,0,0,1,0,0,8,20,20,90,1
Style: Sub,X,60,&H0,&H0,&H0,&H0,0,0,0,0,100,100,0,0,1,0,0,2,20,20,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:56.00,Title,,0,0,0,,코끼리가 코를\N내려놓았더니
Dialogue: 0,0:00:01.00,0:00:02.00,Sub,,0,0,0,,무슨 일이?
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
    check('ASS 제목 띠 아래 = 501(정렬 8·pos 269 + 106×1.25 + 100)', top == 501)
    check('ASS 줄 묶기: 대사 1 + 해설 3', [s['text'] for s in segs] ==
          ['"보풀 실화"', '아끼는 니트 몇 번 / 입었더니 보풀이', '진짜 범인은', '제품은 고정 / 댓글에 있어요'])
    fx = v.keep_below(v.auto(segs), top)
    check('그래픽이 제목 띠 아래', all(e.get('y', 999) >= top for e in fx) and all(e['from'][1] >= top for e in fx if 'from' in e))
    cta = [e for e in fx if e.get('as') == 'cta']
    check('CTA 박스 = 앞 조각 + 댓글!', cta and cta[0]['lines'] == ['제품은 고정', '댓글!'])
    t2 = Path(d) / 't.ass'; t2.write_text(TPL, encoding='utf-8')
    segs3, top3 = v.load_segs(t2)
    check('템플릿 자막: pos 없는 두 줄 제목·PlayResY 1280 → 475', top3 == 475 and len(segs3) == 1)
    fx3 = v.keep_below(v.auto(segs3 * 2), top3)
    check('템플릿 자막: 스티커가 제목 띠 아래', all(e.get('y', 999) >= top3 for e in fx3))
    s = Path(d) / 'c.srt'; s.write_text(SRT, encoding='utf-8')
    segs2, top2 = v.load_segs(s)
    check('SRT 2줄·제목 없음', len(segs2) == 2 and top2 == 0 and abs(segs2[0]['t0'] - .5) < 1e-6)

many = [{'t': t, 'kind': 'sticker', 'sfx': 'pop'} for t in range(0, 40, 2)] + [{'t': 1, 'kind': 'punch', 'sfx': 'hit'}]
kept = [e['t'] for e in v.thin_sfx(many) if e.get('sfx')]
check('효과음 솎기: 최대 6·5초 간격', len(kept) <= v.SFX_MAX and all(abs(x - y) >= v.SFX_GAP for i, x in enumerate(kept) for y in kept[i + 1:]))
check('펀치(hit)가 먼저 남는다', 1 in kept)

# 그래픽 종류 빼기(쇼핑 성장 모드 화살표 금지 10-30)
if hasattr(v, 'drop_kinds'):
    mix = [{'t': 1, 'kind': 'arrow', 'sfx': 'swoosh'}, {'t': 1.5, 'kind': 'sticker', 'sfx': None}, {'t': 9, 'kind': 'tag', 'as': 'cta', 'sfx': 'x'}]
    left = v.drop_kinds([dict(e) for e in mix], ['arrow'])
    check('--no-kind arrow: 화살표만 빠지고 빈 효과음 몫은 남은 것이 받는다', [e['kind'] for e in left] == ['sticker', 'tag'] and left[0]['sfx'])
    check('--no-kind cta: as 이름으로도 뺀다', [e['kind'] for e in v.drop_kinds([dict(e) for e in mix], ['cta'], rethin=False)] == ['arrow', 'sticker'])
    with tempfile.TemporaryDirectory() as d:
        a = Path(d) / 'c.ass'; a.write_text(ASS, encoding='utf-8')
        out = Path(d) / 'o.mp4'
        import subprocess
        r = subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / (sys.argv[1] if len(sys.argv) > 1 else 'variety_fx.py')), 'x.mp4', str(a),
                            '--out', str(out), '--dry', '--no-kind', 'arrow,note'], capture_output=True, text=True, encoding='utf-8')
        kinds = {e['kind'] for e in json.loads((out.with_suffix('.vfx') / 'fx.json').read_text(encoding='utf-8'))} if r.returncode == 0 else {'?'}
        check('--dry --no-kind arrow,note: fx.json 에 화살표·메모 없음', r.returncode == 0 and not kinds & {'arrow', 'note', '?'})

lock = json.loads((v.KIT / 'kit.lock.json').read_text(encoding='utf-8'))
need = set(v.SFX.values())
check('쓰는 효과음 역할의 테이크 파일이 다 있다',
      all(lock['roles'].get(r) and all((v.KIT / t['file']).is_file() for t in lock['roles'][r]['takes']) for r in need))
check('gsap 동봉', (v.BUNDLE / 'gsap.min.js').is_file())
# 효과음만(팬튜브) — 영상은 복사, 효과음은 자리 믹스 대비 --rel dB
import subprocess as sp, shutil
if shutil.which('ffmpeg'):
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / 's.mp4'
        sp.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=300:d=4',
                '-shortest', '-c:v', 'libx264', '-c:a', 'aac', str(src)], check=True)
        plan = Path(d) / 'p.json'; plan.write_text(json.dumps([{'t': 1.5, 'kind': 'sfx', 'sfx': 'pop'}]), encoding='utf-8')
        out = Path(d) / 'o.mp4'
        r = sp.run([sys.executable, '-X', 'utf8', str(sp_path := ROOT / 'scripts' / (sys.argv[1] if len(sys.argv) > 1 else 'variety_fx.py')),
                    str(src), str(plan), '--plan', str(plan), '--sfx-only', '--rel', '-18', '--out', str(out)], capture_output=True, text=True, encoding='utf-8')
        md5 = lambda f: sp.run(['ffmpeg', '-v', 'error', '-i', str(f), '-map', '0:v', '-f', 'md5', '-'], capture_output=True, text=True).stdout
        rows = json.loads((out.with_suffix('.vfx') / 'sfx_rows.json').read_text(encoding='utf-8')) if r.returncode == 0 else []
        check('효과음만: 영상 그대로 복사', r.returncode == 0 and md5(src) == md5(out))
        check('효과음만: 1개만 들어감', len(rows) == 1)
sys.exit(1 if fails else 0)
