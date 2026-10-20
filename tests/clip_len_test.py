# -*- coding: utf-8 -*-
"""scripts/clip_len.py 자기 테스트 — ffmpeg 로 색 화면 3토막(2초·4초·1초)을 만들어 컷 2개·최장 4초·3초 초과 1개를 확인."""
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import clip_len as cl  # noqa: E402

with tempfile.TemporaryDirectory() as t:
    out = Path(t) / 'three.mp4'
    src = ['-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=2:r=25', '-f', 'lavfi', '-i', 'testsrc=s=320x568:d=4:r=25',
           '-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=1:r=25']
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *src, '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', str(out)], check=True)
    r = cl.measure(out)
    assert r['cuts'] == 2 and abs(r['longest_sec'] - 4.0) < 0.15 and r['over_long'] == 1, r
    assert cl.main([str(Path(t) / 'nope.mp4')]) == 5
print('OK')
