# -*- coding: utf-8 -*-
"""깜빡임 고치기 도우미 — 화면 검사가 «앞/끝 N프레임이 다른 샷» 이라고 한 구간 가장자리에서
실제 샷 경계·근처 낱말·소리 크기를 뽑아 «어디로 옮기면 되는지» 를 제안한다. 계획은 고치지 않는다.

    python scripts/rinbox_flashfix.py <plan.json> <원본초> [<원본초> ...]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rinbox_render as R   # noqa: E402

sys.stdout.reconfigure(encoding='utf-8')


def level(src, a, dur):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-ss', '%.3f' % a, '-t', '%.3f' % dur, '-i', src, '-vn',
                        '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    m = re.search(r'mean_volume: (-?[\d.]+) dB', r.stderr)
    return float(m.group(1)) if m else None


def main(plan_path, times):
    p = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    src = p['source']
    words = json.loads(Path(p['transcript']).read_text(encoding='utf-8'))
    for t in times:
        b = R.snap_to_shot(src, t, 0.5) + 1 / R.FPS        # snap 은 한 프레임 당겨 준다 — 실제 경계로 되돌린다
        near = [w for w in words if b - 1.2 < w[1] and w[0] < b + 1.2]
        print('== %.2f 근처 실제 샷 경계 %.3f  (끝을 자를 땐 %.3f — 경계 시각엔 새 샷 첫 장이 들어간다)' % (t, b, b - 1 / R.FPS))
        for w in near:
            mark = '  ←경계 걸침' if w[0] < b < w[1] else ''
            print('   %.2f~%.2f %s%s' % (w[0], w[1], w[2], mark))
        print('   소리: 경계 앞 0.15초 %.1fdB · 뒤 0.15초 %.1fdB' % (level(src, b - 0.15, 0.15), level(src, b, 0.15)))


if __name__ == '__main__':
    main(sys.argv[1], [float(x) for x in sys.argv[2:]])
