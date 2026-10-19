# -*- coding: utf-8 -*-
"""loudnorm_final·gap_check·lufs_table 자기 테스트(API 0원) — ffmpeg 합성 소리로.

    python tests/loudness_gap_test.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import gap_check  # noqa: E402
import loudnorm_final  # noqa: E402
import lufs_table  # noqa: E402


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True)


def main():
    ok = True
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        quiet = td / 'quiet.mp4'
        ff('-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8',
           '-af', 'volume=-22dB', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', str(quiet))
        r = loudnorm_final.normalize(quiet, td / 'norm.mp4')
        m = lufs_table.measure(td / 'norm.mp4')
        if not (abs(m['I'] + 14) <= 1 and m['TP'] <= -1 and not r['skipped']):
            print('FAIL 정규화', r, m); ok = False
        if not loudnorm_final.normalize(td / 'norm.mp4', td / 'again.mp4')['skipped']:
            print('FAIL 이미 맞춘 파일을 다시 건드림'); ok = False
        gap = td / 'gap.wav'   # 소리 1초 · 무음 1.2초 · 소리 1초 · 무음 0.5초 · 소리 1초
        ff('-f', 'lavfi', '-i', 'sine=f=440:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
           '-filter_complex', '[1]atrim=0:1.2[s1];[1]atrim=0:0.5[s2];[0]asplit=3[a][b][c];[a][s1][b][s2][c]concat=n=5:v=0:a=1',
           '-ar', '44100', '-ac', '1', str(gap))
        over, cap, mid = gap_check.gaps(gap, 'long')
        if len(mid) != 2 or len(over) != 1 or not 1.1 < over[0][1] < 1.3:
            print('FAIL 롱폼 무음', over, mid); ok = False
        if len(gap_check.gaps(gap, 'shorts')[0]) != 2:
            print('FAIL 쇼츠 무음 상한 0.4'); ok = False
    print('OK' if ok else 'FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
