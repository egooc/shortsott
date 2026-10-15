# -*- coding: utf-8 -*-
"""戦国なぜ 쇼츠 음성 — Supertonic(무료·CPU)으로 원고 문장마다 합성해 잇는다. Supertonic 전용 venv 파이썬으로 돌린다.

    D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe scripts/naze_voice.py <원고.json> <출력 폴더> [--voice F2] [--speed 1.05]

- 읽는 글은 줄의 read(없으면 text). 숫자는 원고 단계에서 한자 숫자로 바꿔 둔다(naze_script_check N9) — 10-16 실측 오독.
- 출력: voice.wav(문장 사이 gap 초) · timing.json [{i, start, end, text}] — naze_render.py 가 읽는다.
- 같은 문장은 같은 소리(문장 해시로 시드 고정) — 정치 supertonic_worker 와 같은 방식. 언어만 ja.
"""
import argparse
import json
import sys
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path('D:/midform/tts-lab/supertonic')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('script')
    ap.add_argument('out')
    ap.add_argument('--voice', default='F2')
    ap.add_argument('--speed', type=float, default=1.05)
    ap.add_argument('--steps', type=int, default=8)
    ap.add_argument('--gap', type=float, default=0.3)
    a = ap.parse_args()
    sys.path.insert(0, str(ROOT / 'py'))
    from helper import load_text_to_speech, load_voice_style
    s = json.loads(Path(a.script).read_text(encoding='utf-8'))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tts = load_text_to_speech(str(ROOT / 'assets' / 'onnx'), False)
    style = load_voice_style([str(ROOT / 'assets' / 'voice_styles' / f'{a.voice}.json')])
    sr = tts.sample_rate
    pieces, timing, t = [], [], 0.0
    for i, ln in enumerate(s['lines']):
        say = ln.get('read') or ln['text']
        np.random.seed(zlib.crc32(say.encode()))
        wav, dur = tts(say, 'ja', style, a.steps, a.speed)
        w = wav[0, :int(sr * float(dur[0]))]
        pieces.append(w)
        timing.append({'i': i, 'start': round(t, 3), 'end': round(t + len(w) / sr, 3), 'text': ln['text']})
        t += len(w) / sr
        if i < len(s['lines']) - 1:
            pieces.append(np.zeros(int(sr * a.gap), dtype=np.float32))
            t += a.gap
    sf.write(str(out / 'voice.wav'), np.concatenate(pieces), sr, subtype='PCM_16')
    (out / 'timing.json').write_text(json.dumps({'voice': a.voice, 'speed': a.speed, 'total': round(t, 3), 'lines': timing},
                                                ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('voice %.1fs · %d문장 → %s' % (t, len(timing), out))


if __name__ == '__main__':
    main()
