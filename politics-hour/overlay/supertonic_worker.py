"""Supertonic 3 로 해설 음성을 만든다. Supertonic 전용 venv 의 파이썬으로 실행한다(tts.py 가 부른다).

    <supertonic python> supertonic_worker.py <job.json>

job: {"dir": "<supertonic 저장소>", "voice": "M5", "speed": 1.05, "steps": 8, "gap": 0.3,
      "sentences": [["문장", ["자막 덩어리", ...]], ...], "out": "voice.wav"}
문장마다 따로 합성하고 gap 초를 두어 잇는다. 문장 안 자막 덩어리의 시각은 글자 수 비율로 나눈다.
결과로 [[시작초, 끝초, 문구], ...] 를 표준출력에 JSON 으로 낸다.
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
style = load_voice_style([str(root / 'assets' / 'voice_styles' / f'{job["voice"]}.json')])
sr, gap = tts.sample_rate, float(job.get('gap', .3))
pieces, cues, t = [], [], 0.0
for i, (sentence, parts) in enumerate(job['sentences']):
    np.random.seed(zlib.crc32(sentence.encode()))          # 같은 문장은 같은 소리
    wav, dur = tts(sentence, 'ko', style, int(job.get('steps', 8)), float(job.get('speed', 1.05)))
    d = float(dur[0])
    pieces.append(wav[0, :int(sr * d)])
    weights = [max(1, len(p.replace(' ', ''))) for p in parts]
    acc = 0
    for p, w in zip(parts, weights):
        a = t + d * acc / sum(weights); acc += w
        cues.append([round(a, 3), round(t + d * acc / sum(weights), 3), p])
    t += d
    if i < len(job['sentences']) - 1:
        pieces.append(np.zeros(int(sr * gap), dtype=np.float32)); t += gap
sf.write(job['out'], np.concatenate(pieces), sr, subtype='PCM_16')
print(json.dumps(cues, ensure_ascii=False))
