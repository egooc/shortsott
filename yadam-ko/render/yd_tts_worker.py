# -*- coding: utf-8 -*-
"""야담 낭독 음성 — Supertonic 3 로컬(무료·CPU), 줄마다 목소리를 바꿔 wav 한 개씩 만든다.
Supertonic 전용 venv 파이썬으로 실행한다(yadam_render.py 가 부른다). 정치 롱폼 supertonic_worker.py 와 같은 합성·앞뒤 무음 자르기.

    <supertonic python> yd_tts_worker.py <job.json>

job: {"dir": "<supertonic 저장소>", "steps": 8, "items": [{"voice": "F2", "speed": 0.95, "text": "문장", "out": "x.wav"}, ...]}
결과: 표준출력 마지막 줄에 [[out, 초], ...] JSON.
"""
import json
import sys
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
root = Path(job['dir'])
sys.path.insert(0, str(root / 'py'))
from helper import load_text_to_speech, load_voice_style  # noqa: E402

tts = load_text_to_speech(str(root / 'assets' / 'onnx'), False)
sr = tts.sample_rate
styles = {}


def trim(w, db=-40.0, pad=.05):
    hop = max(1, int(sr * .01))
    rms = np.sqrt(np.convolve(w.astype(np.float64) ** 2, np.ones(hop) / hop, mode='same'))
    on = np.flatnonzero(rms > 10 ** (db / 20))
    if not on.size:
        return w
    return w[max(0, on[0] - int(sr * pad)):min(len(w), on[-1] + int(sr * pad))]


res = []
for it in job['items']:
    v = it['voice']
    if v not in styles:
        styles[v] = load_voice_style([str(root / 'assets' / 'voice_styles' / f'{v}.json')])
    np.random.seed(zlib.crc32((v + it['text']).encode()))
    wav, dur = tts(it['text'], 'ko', styles[v], int(job.get('steps', 8)), float(it.get('speed', 1.0)))
    w = trim(wav[0, :int(sr * float(dur[0]))])
    sf.write(it['out'], w, sr, subtype='PCM_16')
    res.append([it['out'], round(len(w) / sr, 3)])
    print(f'{len(res)}/{len(job["items"])}', file=sys.stderr, flush=True)
print(json.dumps(res, ensure_ascii=False))
