# -*- coding: utf-8 -*-
"""실영상 컷 사전 검사(관리자 10-24 검수 지적 2가지) — 렌더 전에 돌린다.

  python monetize-longform/tools/clip_check.py <ep_dir> [--min-motion 9.0] [--ack-misread]

① 등록 검사: visuals.json 의 clip 키가 전부 clips.json 에 있는가(없으면 렌더 50번째에서 KeyError).
② 움직임 검사: 쓰는 구간(in~in+len)의 평균 프레임 차이(0~255)가 min-motion 미만이면 «거의 정지» → FAIL(토바 석양 사례).
③ 오인 검사(표): 컷 장면의 해설 문장에 연도·특정 사건 낱말이 있으면 컷의 장소 설명과 나란히 찍는다 —
   다른 장소 영상 위에 «946년의 그날» 같은 줄이 오면 해설을 «비슷한 분출은 이렇게 시작합니다» 식으로 바꾸거나 그 장소 영상만 붙인다.
   (자동 판정은 못 하므로 표를 보고 고친 뒤 --ack-misread 로 통과 기록.)
종료: 0 통과 · 4 FAIL(①②) · 3 ③ 표 미확인(--ack-misread 없음)
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

EVENT_RE = re.compile(r'(\d{3,4}년|946|1702|1903|2002년|그날|당시|그때)')


def motion_score(src, t_in, length):
    # 480x270 회색, 4fps 로 뽑아 인접 프레임 평균 절대차
    cmd = ['ffmpeg', '-v', 'error', '-ss', f'{t_in:.2f}', '-t', f'{length:.2f}', '-i', str(src), '-vf', 'scale=480:270,fps=4,format=gray', '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (480 * 270)
    if n < 2:
        return 0.0
    fr = np.frombuffer(raw[: n * 480 * 270], dtype=np.uint8).reshape(n, 270, 480).astype(np.int16)
    # 2초 간격(4fps×8) 평균 절대차 — 인접 프레임 차이는 느린 팬에 속는다. ko10 실측: 토바 석양 7.1(정지 판정) · 칸라온 9.4 · 나머지 19~52
    step = 8 if n > 8 else 1
    return float(np.abs(fr[step:] - fr[:-step]).mean())


def usage():
    print(__doc__.strip())
    return 5


def main():
    a = sys.argv[1:]
    if not a or a[0] in ('-h', '--help') or a[0].startswith('-'):
        return usage()
    ep = Path(a[0])
    if not (ep / 'visuals.json').exists():
        print(f'visuals.json 없음: {ep}')
        return usage()
    if not (ep / 'clips.json').exists():
        v0 = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
        if any(k != '_emph' and isinstance(s, dict) and 'clip' in s for k, s in v0.items()):
            print('FAIL ① clip 장면이 있는데 clips.json 이 없다')
            return 4
        print('clip 장면 없음 — clip_check 해당 없음(PASS)')
        return 0
    min_motion = float(a[a.index('--min-motion') + 1]) if '--min-motion' in a else 9.0
    v = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
    reg = {c['key']: c for c in json.loads((ep / 'clips.json').read_text(encoding='utf-8'))['clips']}
    # script.txt: "@장면키" 줄 뒤에 그 화면의 문장들(한 줄 = 한 문장), '#'은 주석, '##'은 장
    lines_by_scene = {}
    cur = None
    for ln in (ep / 'script.txt').read_text(encoding='utf-8').splitlines():
        ln = ln.strip()
        if not ln or ln.startswith('#'):
            continue
        if ln.startswith('@'):
            cur = ln[1:].strip()
            continue
        if cur:
            lines_by_scene.setdefault(cur, []).append(ln)
    fails = []
    table = []
    for key, spec in v.items():
        if key == '_emph' or 'clip' not in spec:
            continue
        c = spec['clip']
        if c['key'] not in reg:
            fails.append(f'① {key}: clips.json 에 {c["key"]} 없음')
            continue
        r = reg[c['key']]
        m = motion_score(r['src'], float(c.get('in', 0)), float(c['len']))
        tag = 'OK' if m >= min_motion else 'FAIL(정지)'
        if m < min_motion:
            fails.append(f'② {key}←{c["key"]} 움직임 {m:.2f} < {min_motion}')
        text = ' '.join(lines_by_scene.get(key, []))
        ev = EVENT_RE.findall(text) if text else []
        table.append((key, c['key'], r.get('title_ko', ''), f'{m:.2f} {tag}', '·'.join(sorted(set(ev))) or '-', (text or '')[:40]))
    print(f'{"장면":<18}{"컷":<18}{"컷 장소":<28}{"움직임":<14}{"사건 낱말":<12}해설')
    for row in table:
        print(f'{row[0]:<18}{row[1]:<18}{row[2][:26]:<28}{row[3]:<14}{row[4]:<12}{row[5]}')
    for f in fails:
        print('FAIL', f)
    if fails:
        return 4
    acked = '--ack-misread' in a or (ep / 'clip_misread_ack.txt').exists()   # 운전기 경로에선 편 폴더의 확인 파일로 통과
    if any(r[4] != '-' for r in table) and not acked:
        print('③ 사건 낱말이 있는 컷 장면이 있다 — 해설을 맞추거나 그 장소 영상으로 바꾼 뒤 --ack-misread 로 통과')
        return 3
    print('clip_check PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
