# -*- coding: utf-8 -*-
"""ko 정치 인용형 썸네일(politics-hour/thumb_quote.py)을 그대로 돌린다 — 한국어 글꼴(가나·한자 없음)만 일본어 Noto Sans JP Black 으로(사본 금지).

    python -X utf8 politics-hour-ja/thumb_quote_ja.py <편 폴더> <설정.json> <out.png>      (설정 형식은 thumb_quote.py 머리말 그대로)
"""
import runpy
import sys
from pathlib import Path

from PIL import ImageFont

ROOT = Path(__file__).resolve().parents[1]
JP = str(ROOT / 'politics-hour-ja' / 'assets' / 'fonts' / 'NotoSansJP.ttf')
_tt = ImageFont.truetype


def truetype(font=None, size=10, *a, **k):
    if isinstance(font, str) and 'Paperlogy' in font:
        f = _tt(JP, size, *a, **k)
        try:
            f.set_variation_by_name('Black')
        except Exception:
            pass
        return f
    return _tt(font, size, *a, **k)


# 누끼(cutout·layout)는 .venv-vision 의 rembg 가 필요하다. ko thumb_quote.py 가 스스로 거기서 다시 돌면 이 글꼴 바꿔치기가 빠지므로 여기서 먼저 옮겨 탄다(10-29)
VENV_VISION = ROOT / '.venv-vision' / 'Scripts' / 'python.exe'
if Path(sys.executable).resolve() != VENV_VISION.resolve() and VENV_VISION.exists():
    import importlib.util
    import subprocess
    if importlib.util.find_spec('rembg') is None:
        sys.exit(subprocess.run([str(VENV_VISION), '-X', 'utf8', __file__, *sys.argv[1:]]).returncode)

ImageFont.truetype = truetype
sys.argv = [str(ROOT / 'politics-hour' / 'thumb_quote.py')] + sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
