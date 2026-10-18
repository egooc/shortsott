# -*- coding: utf-8 -*-
"""char_anim.py 자기 테스트(API 0원) — 합성 시트로 투명 배경·머리 폭 정렬·타이밍·mov 알파를 확인한다.

    python tests/char_anim_test.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import char_anim as C  # noqa: E402


def figure(d, ox, oy, s, mark=False):
    """머리(원)+몸(사다리꼴)+안쪽 흰 봉투. s=크기 배율."""
    d.ellipse([ox - 60 * s, oy, ox + 60 * s, oy + 130 * s], fill=(240, 200, 170), outline=(90, 60, 40), width=4)
    d.polygon([(ox - 100 * s, oy + 300 * s), (ox + 100 * s, oy + 300 * s), (ox + 70 * s, oy + 140 * s), (ox - 70 * s, oy + 140 * s)],
              fill=(200, 170, 120), outline=(90, 60, 40))
    d.rectangle([ox - 40 * s, oy + 190 * s, ox + 40 * s, oy + 240 * s], fill=(255, 255, 255), outline=(90, 60, 40), width=3)
    if mark:   # 머리 옆 떨어진 효과선 — 머리 폭에 섞이면 안 된다
        d.line([ox + 90 * s, oy, ox + 130 * s, oy - 10 * s], fill=(240, 180, 0), width=6)


def make_sheet(path):
    W, H = 1200, 900
    im = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    specs = [(0, 0, 1.0), (10, 5, 1.0), (-15, 20, .85), (0, 0, 1.15), (5, 10, 1.0), (0, 30, .92)]
    for k, (dx, dy, s) in enumerate(specs):
        r, c = divmod(k, 3)
        figure(d, c * 400 + 200 + dx, r * 450 + 60 + dy, s, mark=(k == 2))
    im.save(path)


def main():
    ok = True
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        sheet = td / 'sheet.png'
        make_sheet(sheet)
        assert C.main(['frames', str(sheet), str(td), '--kind', 'action']) == 0
        F = [np.array(Image.open(td / 'frames' / f'{i}.png')) for i in range(6)]
        # 1) 배경은 투명, 안쪽 흰 봉투는 불투명
        a0 = F[0][..., 3]
        if a0[5, 5] != 0:
            print('FAIL 배경 알파'); ok = False
        if a0[60 + 215, 200] < 250:
            print('FAIL 안쪽 흰색이 지워짐'); ok = False
        # 2) 머리 폭·맨 위가 0번과 같다(효과선 있는 2번 포함)
        t0, c0, w0 = C.head(a0)
        for i, f in enumerate(F[1:], 1):
            t, c, w = C.head(f[..., 3])
            if abs(w - w0) > 4 or abs(t - t0) > 3 or abs(c - c0) > 3:
                print(f'FAIL 정렬 {i}: 폭 {w:.0f}/{w0:.0f} 위 {t:.0f}/{t0:.0f} 가운데 {c:.0f}/{c0:.0f}'); ok = False
        # 3) 타이밍 파싱·길이
        tm = C.parse_timing('0 0.5\n2 0.1 shake:14  # 주석\n5 1 tremble\n')
        if tm != [(0, .5, 'none', 0.0), (2, .1, 'shake', 14.0), (5, 1.0, 'tremble', 1.5)]:
            print('FAIL 타이밍', tm); ok = False
        tf = td / 't.txt'
        tf.write_text('0 0.5\n2 0.1 shake:14\n5 1 jump:20\n', encoding='utf-8')
        mov = td / 'a.mov'
        assert C.main(['anim', str(td), str(tf), '--height', '300', '--out', str(mov), '--png-seq', str(td / 'seq')]) == 0
        n = len(list((td / 'seq').glob('*.png')))
        if n != 15 + 3 + 30:
            print('FAIL 프레임 수', n); ok = False
        pf = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', str(mov)],
                            capture_output=True, text=True).stdout.strip()
        if not pf.startswith('yuva'):
            print('FAIL mov 알파 없음', pf); ok = False
        # 4) face 합성은 몸이 0번 그대로(타원 밖 차이 없음)
        assert C.main(['frames', str(sheet), str(td / 'f'), '--kind', 'face']) == 0
        # 5) 프롬프트에 여백 지시
        p = C.sheet_prompt('action', C.ACTION_POSES['surprise'], '', 3, 2)
        if '70%' not in p or 'NO text' not in p:
            print('FAIL 프롬프트'); ok = False
    print('OK' if ok else 'FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
