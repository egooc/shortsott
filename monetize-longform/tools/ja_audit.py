# -*- coding: utf-8 -*-
"""수창 ja 역전사 대조 — 연금 num_audit 를 그대로 쓰되, seg 폴더 이름 해시에 들어가는 CODE 를 수창 render.py 와 같게(-m3) 맞춘다.
(10-23 01:45 ja03 사고: num_audit 가 연금 CODE 로 폴더를 찾아 «voice.wav 없음».)

    python -X utf8 monetize-longform/tools/ja_audit.py monetize-longform/ep_ja03 [--only 12,40]
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parents[1] / 'ja-nenkin' / 'render'))
import render  # noqa: E402  수창 진입점 — MOTION['code']
import nenkin_render as R  # noqa: E402
import num_audit  # noqa: E402

R.CODE = R.CODE + '-' + render.MOTION['code']   # render.patch_ja 와 같은 접미사 → 같은 seg 폴더 이름

if __name__ == '__main__':
    sys.exit(num_audit.main())
