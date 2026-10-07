# -*- coding: utf-8 -*-
"""볼케이노 명화관이 내는 결과를 **숫자로 못 박는다.** 자체 렌더러가 맞춰야 할 기준이다.

    python scripts/render_contract.py <편집폴더|워크디렉토리>            계약서를 뽑는다
    python scripts/render_contract.py <A> --compare <B>                 둘을 견준다
    python scripts/render_contract.py <편집폴더> --save <이름>           기준선으로 저장
    python scripts/render_contract.py <편집폴더> --against <이름>        저장된 기준선과 견준다

왜 (2026-10-08 소유주: "만들어야지. 편집표는 양쪽 공통이 아니라 볼케이노 명화관이 맞고
    그걸 기준으로 우리 스타일을 지켜야지")

  자체 렌더러는 «볼케이노와 비슷한 것»이 아니라 **볼케이노 명화관이 내는 바로 그 모양**을
  내야 한다. 그러려면 그 모양이 무엇인지 숫자로 적혀 있어야 한다. 말로 적으면 어긋난다.

  두 가지로 쓴다
    1) 자체 렌더러의 과녁 — 같은 편집표로 낸 결과를 이 계약서와 견준다.
    2) 볼케이노 갱신 감시 — 실행기가 갱신되면(사례 166) 계약서가 바뀌는지 본다.
       바뀌면 우리 렌더러도 따라가야 한다는 뜻이고, 안 바뀌면 안 따라가도 된다는 뜻이다.

무엇을 재나 — **결과물에서 보이는 것만** 잰다. 볼케이노 내부 코드는 안 부른다
  (`film_editor.py` 를 직접 쓰면 그쪽 갱신에 우리가 깨진다 — 린박스 세션 판단, 동의한다).

  화면   해상도 · fps · 프레임 수 · 길이
  소리   라우드니스(I·LRA) · 표본율 · 채널
  자막   스타일별 글꼴·크기·색·외곽선·정렬, 큐 수, 등장/퇴장 시각, pos 좌표
  구성   편집표의 해설 수·원음 구간 수·컷 경계 시각

★`captions.ass` 가 우리 «스타일»의 진짜 명세다. 폰트 이름과 색까지 여기 적혀 있다.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'server', 'data', 'render_contracts')


def read_json(p, fb=None):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def find_edit_dir(path):
    """편집 폴더(edit.json 이 있는 곳)를 찾는다. 워크디렉토리를 주면 가장 최근 것을 고른다."""
    if os.path.isfile(os.path.join(path, 'edit.json')):
        return path
    eds = os.path.join(path, 'edits')
    if os.path.isdir(eds):
        cand = [os.path.join(eds, d) for d in os.listdir(eds)
                if os.path.isfile(os.path.join(eds, d, 'edit.json'))]
        if cand:
            return max(cand, key=os.path.getmtime)
    return None


def probe(mp4):
    out = {}
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json',
                            '-show_entries', 'stream=codec_type,codec_name,width,height,'
                            'r_frame_rate,nb_frames,sample_rate,channels',
                            '-show_entries', 'format=duration', mp4],
                           capture_output=True, text=True, timeout=90)
        d = json.loads(r.stdout or '{}')
        for s in d.get('streams', []):
            if s.get('codec_type') == 'video' or s.get('width'):
                out.update({'width': s.get('width'), 'height': s.get('height'),
                            'fps': s.get('r_frame_rate'), 'frames': int(s.get('nb_frames') or 0),
                            'vcodec': s.get('codec_name')})
            elif s.get('sample_rate'):
                out.update({'sample_rate': int(s.get('sample_rate') or 0),
                            'channels': s.get('channels'), 'acodec': s.get('codec_name')})
        out['duration'] = round(float((d.get('format') or {}).get('duration') or 0), 3)
    except Exception as exc:
        out['probe_error'] = str(exc)[:120]
    try:
        r = subprocess.run(['ffmpeg', '-nostats', '-hide_banner', '-i', mp4,
                            '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'],
                           capture_output=True, text=True, timeout=240)
        txt = r.stderr or ''
        m = re.search(r'^\s*I:\s*(-?[\d.]+) LUFS', txt, re.M)
        if m:
            out['loudness_lufs'] = float(m.group(1))
        m = re.search(r'^\s*LRA:\s*([\d.]+) LU', txt, re.M)
        if m:
            out['lra'] = float(m.group(1))
    except Exception:
        pass
    return out


def t2s(t):
    h, m, s = t.split(':')
    return round(int(h) * 3600 + int(m) * 60 + float(s), 3)


def read_ass(path):
    """스타일 명세와 큐 시각. 글꼴·색까지 들어 있어 이게 «우리 스타일»의 진짜 명세다."""
    if not os.path.isfile(path):
        return {}
    txt = io.open(path, encoding='utf-8-sig', errors='replace').read()
    info = dict(re.findall(r'^(PlayResX|PlayResY|WrapStyle|ScaledBorderAndShadow):\s*(.+)$',
                           txt, re.M))
    fmt = re.search(r'^Format:\s*(.+)$', txt, re.M)
    cols = [c.strip() for c in fmt.group(1).split(',')] if fmt else []
    styles = {}
    for line in re.findall(r'^Style:\s*(.+)$', txt, re.M):
        v = [x.strip() for x in line.split(',')]
        d = dict(zip(cols, v))
        styles[d.get('Name', v[0])] = {
            'font': d.get('Fontname'), 'size': d.get('Fontsize'),
            'colour': d.get('PrimaryColour'), 'outline_colour': d.get('OutlineColour'),
            'outline': d.get('Outline'), 'align': d.get('Alignment'),
            'margin_l': d.get('MarginL'), 'margin_r': d.get('MarginR'), 'margin_v': d.get('MarginV'),
        }
    cues = []
    for ln in re.findall(r'^Dialogue:\s*(.+)$', txt, re.M):
        p = ln.split(',', 9)
        if len(p) < 10:
            continue
        pos = re.search(r'\\pos\((\d+),(\d+)\)', p[9])
        cues.append({'style': p[3], 'in': t2s(p[1]), 'out': t2s(p[2]),
                     'pos': [int(pos.group(1)), int(pos.group(2))] if pos else None,
                     'chars': len(re.sub(r'\{[^}]*\}', '', p[9]).strip())})
    per = defaultdict(list)
    for c in cues:
        per[c['style']].append(c)
    by_style = {}
    for s, g in per.items():
        xs = sorted({tuple(c['pos']) for c in g if c['pos']})
        by_style[s] = {'cues': len(g), 'first_in': min(c['in'] for c in g),
                       'last_out': max(c['out'] for c in g),
                       'max_chars': max(c['chars'] for c in g),
                       'positions': [list(x) for x in xs][:6]}
    return {'info': info, 'styles': styles, 'cue_count': len(cues), 'by_style': by_style}


def build(edit_dir):
    ed = read_json(os.path.join(edit_dir, 'edit.json'), {})
    seq = ed.get('sequence') or []
    cuts = [{'in': s['source_in'], 'out': s['source_out'],
             'captions': len(s.get('captions') or [])}
            for s in seq if 'source_in' in s]
    mp4 = next((os.path.join(edit_dir, f) for f in sorted(os.listdir(edit_dir))
                if f.startswith('final-') and f.endswith('.mp4')), None)
    return {
        'edit_dir': edit_dir,
        'edit': {
            'title_lines': len(ed.get('title') or []),
            'narration': len(ed.get('narration') or []),
            'cards_per_narration': [len(n.get('cards') or []) for n in (ed.get('narration') or [])],
            'sequence_items': len(seq),
            'source_cuts': len(cuts),
            'cut_spans': [round(c['out'] - c['in'], 3) for c in cuts],
            'captions_per_cut': [c['captions'] for c in cuts],
            'beats': [b.get('role') for b in ((ed.get('editorial') or {}).get('beats') or [])],
            'editorial_version': (ed.get('editorial') or {}).get('version'),
        },
        'captions': read_ass(os.path.join(edit_dir, 'captions.ass')),
        'output': probe(mp4) if mp4 else {'missing': True},
        'output_file': os.path.basename(mp4) if mp4 else None,
    }


def walk(a, b, path=''):
    """숫자는 작은 흔들림을 눈감아 준다 — 길이·라우드니스는 인코딩마다 미세하게 다르다."""
    TOL = {'duration': 0.05, 'loudness_lufs': 0.5, 'lra': 0.5}
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            out += walk(a.get(k), b.get(k), f'{path}.{k}' if path else k)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append((path, f'{len(a)}개', f'{len(b)}개'))
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                out += walk(x, y, f'{path}[{i}]')
    else:
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
            tol = next((v for k, v in TOL.items() if path.endswith(k)), 0)
            if abs(a - b) > tol:
                out.append((path, a, b))
        elif a != b:
            out.append((path, a, b))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target')
    ap.add_argument('--compare')
    ap.add_argument('--save')
    ap.add_argument('--against')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    d = find_edit_dir(args.target)
    if not d:
        print(f'{args.target} 에서 edit.json 을 못 찾았다'); return 1
    c = build(d)

    if args.json and not (args.compare or args.against):
        print(json.dumps(c, ensure_ascii=False, indent=1)); return 0

    other = None
    if args.compare:
        od = find_edit_dir(args.compare)
        if not od:
            print(f'{args.compare} 에서 edit.json 을 못 찾았다'); return 1
        other = build(od)
        label = od
    elif args.against:
        p = os.path.join(STORE, args.against + '.json')
        other = read_json(p)
        if other is None:
            print(f'{p} 가 없다'); return 1
        label = p

    if other is None:
        o, cap = c['output'], c['captions']
        print(f"계약서 · {os.path.basename(d)}")
        print(f"  화면   {o.get('width')}x{o.get('height')} {o.get('fps')} · {o.get('frames')}프레임 · {o.get('duration')}초")
        print(f"  소리   {o.get('loudness_lufs')} LUFS · LRA {o.get('lra')} · {o.get('sample_rate')}Hz {o.get('channels')}ch")
        print(f"  자막   큐 {cap.get('cue_count')}개 · 스타일 {len(cap.get('styles') or {})}종")
        for s, v in (cap.get('styles') or {}).items():
            b = (cap.get('by_style') or {}).get(s) or {}
            print(f"         {s:9} {v['font']:18} {v['size']:>3}pt 색{v['colour']} 외곽{v['outline']} 정렬{v['align']}"
                  f"  큐{b.get('cues', 0):>3} 최장{b.get('max_chars', 0):>3}자")
        e = c['edit']
        print(f"  구성   해설 {e['narration']} · 원음컷 {e['source_cuts']} · beats {e['beats']}")
        if args.save:
            os.makedirs(STORE, exist_ok=True)
            with io.open(os.path.join(STORE, args.save + '.json'), 'w', encoding='utf-8') as fh:
                json.dump(c, fh, ensure_ascii=False, indent=1)
            print(f"\n기준선 저장 · {os.path.join(STORE, args.save + '.json')}")
        return 0

    # 견주기 — 편집표가 다르면 구성이 다른 게 당연하므로 «스타일·화면 규격»만 본다.
    keys = ['captions.styles', 'captions.info', 'output.width', 'output.height',
            'output.fps', 'output.sample_rate', 'output.channels', 'output.vcodec', 'output.acodec']
    diffs = [x for x in walk(c, other) if any(x[0].startswith(k) for k in keys)]
    print(f"견줌\n  A {d}\n  B {label}\n")
    if not diffs:
        print('  스타일·화면 규격 일치 — 같은 모양이다')
    else:
        print(f'  어긋난 항목 {len(diffs)}개')
        for p, a, b in diffs:
            print(f"    {p:46} A={a}  B={b}")
    soft = [x for x in walk(c, other) if x[0].startswith('output.')
            and not any(x[0].startswith(k) for k in keys)]
    if soft:
        print('\n  (편집표가 다르면 당연히 달라지는 것)')
        for p, a, b in soft[:8]:
            print(f"    {p:46} A={a}  B={b}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
