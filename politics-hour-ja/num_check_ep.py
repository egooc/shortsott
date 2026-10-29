# -*- coding: utf-8 -*-
"""정치JA 해설 역전사 관문(숫자·인명) — 렌더된 해설 조각(normalized.mp4)마다 따로 받아써서 원고와 대조한다.
전체 영상을 한 번에 받아쓰면 조각 경계 시각이 밀려 오탐이 많았다(10-29 中道 편 40/58). 조각 단위는 경계 문제가 없다.

    python -X utf8 politics-hour-ja/num_check_ep.py <편 폴더> [--only 3,5]

숫자 = scripts/ja_numread.values_arabic(원고) vs ja-nenkin/render/num_audit.nums(들림) · 인명 = ja_render.YOMI 의 한자 이름이 원고에 있으면 들림에
그 한자나 히라가나 읽기가 있어야 한다. 받아쓰기는 <조각>/heard.json 에 남겨 다시 돌릴 때 재사용.
종료: 0 통과 · 4 오독(숫자·이름) · 5 검사 불가."""
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'ja-nenkin' / 'render'), str(HERE / 'render')]
import ja_numread as N  # noqa: E402
import num_audit as A  # noqa: E402
import ja_render  # noqa: E402

NAMES = [k for k in ja_render.YOMI if len(k) >= 2 and not k.startswith(('一', '後', '納'))]


def heard(seg_dir):
    j = seg_dir / 'heard.json'
    if not j.exists():
        subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'rinbox_transcribe.py'), str(seg_dir / 'normalized.mp4'), str(j), '--lang', 'ja'],
                       check=True, capture_output=True)
    return ''.join(w for a, b, w in json.loads(j.read_text(encoding='utf-8')))


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(argv[0])
    epj = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    only = {int(x) for x in argv[argv.index('--only') + 1].split(',')} if '--only' in argv else None
    segs = ja_render.segments(epj)
    seg_root = Path(epj['workdir']) / 'seg'
    tot = bad = 0
    lines = []
    for k, s in enumerate(segs):
        if s['type'] != 'nar' or (only and k not in only):
            continue
        dirs = sorted(seg_root.glob(f'{k:03d}-nar-*'), key=lambda p: p.stat().st_mtime)
        if not dirs or not (dirs[-1] / 'normalized.mp4').exists():
            print(f'[num-ja] 검사 불가: {k}번 조각 없음'); return 5
        h = heard(dirs[-1])
        want = Counter(N.values_arabic(s['text'])); got = Counter(A.nums(h))
        miss = +(want - got)
        nm = [n for n in NAMES if n in s['text'] and n not in h and ja_render.YOMI[n] not in h]
        tot += sum(want.values()); bad += sum(miss.values()) + len(nm)
        if miss or nm:
            lines.append(f'- [{k}] FAIL «{s["text"][:60]}» 들림 «{h[:80]}»' + (f' 숫자 {dict(miss)}' if miss else '') + (f' 이름 {nm}' if nm else ''))
    print(f'[num-ja] 해설 숫자 {tot}개 · 오독+이름 빠짐 {bad}건')
    print('\n'.join(lines))
    return 4 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
