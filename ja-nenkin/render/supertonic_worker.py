"""Supertonic 3 로 해설 음성을 만든다 — politics-hour/overlay/supertonic_worker.py 의 ja 키트 복제본(원본은 고치지 않는다).

    <supertonic python> supertonic_worker.py <job.json>

job: {"dir": "<supertonic 저장소>", "voice": "F2", "speed": 1.05, "steps": 8, "gap": 0.5,
      "lang": "ja",                 ← 추가: 원본은 'ko' 로 박혀 있다(기본 ja)
      "num_reading": true,          ← 추가: 문장 속 숫자를 읽기용 한자 숫자로 바꿔 읽는다(자막 덩어리는 그대로)
      "sentences": [["문장", ["자막 덩어리", ...]], ...], "out": "voice.wav"}
문장마다 따로 합성하고 gap 초를 두어 잇는다. 문장 안 자막 덩어리의 시각은 글자 수 비율로 나눈다.
결과로 [[시작초, 끝초, 문구], ...] 를 표준출력에 JSON 으로 낸다.

왜 숫자 변환(10-16 실측): Supertonic ja 는 465→4065·3.2%→«コア» 로 읽는다. 한자 숫자·点·パーセント 로 바꾸면 맞게 읽는다.
  변환은 D:/midform/scripts/ja_num_reading.py 를 import 한다(복제 금지).
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

lang = job.get('lang', 'ja')
say_of = (lambda s: s)
if job.get('num_reading', lang == 'ja'):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
    from ja_num_reading import reading  # noqa: E402
    say_of = reading

tts = load_text_to_speech(str(root / 'assets' / 'onnx'), False)
style = load_voice_style([str(root / 'assets' / 'voice_styles' / f'{job["voice"]}.json')])
sr, gap = tts.sample_rate, float(job.get('gap', .3))
pieces, cues, t = [], [], 0.0


def trim(w, db=-40.0, pad=.05):
    """문장 앞뒤 합성기 무음을 pad 초만 남기고 자른다 — ko 9f685ff 와 같은 수정(양끝 0.5초 안팎이 붙어 문장 사이가 1초 넘게 벌어졌다)."""
    hop = max(1, int(sr * .01))
    rms = np.sqrt(np.convolve(w.astype(np.float64) ** 2, np.ones(hop) / hop, mode='same'))
    on = np.flatnonzero(rms > 10 ** (db / 20))
    if not on.size:
        return w
    return w[max(0, on[0] - int(sr * pad)):min(len(w), on[-1] + int(sr * pad))]
for i, (sentence, parts) in enumerate(job['sentences']):
    say = say_of(sentence)
    np.random.seed(zlib.crc32(say.encode()))          # 같은 문장은 같은 소리
    wav, dur = tts(say, lang, style, int(job.get('steps', 8)), float(job.get('speed', 1.05)))
    w = trim(wav[0, :int(sr * float(dur[0]))])
    d = len(w) / sr
    pieces.append(w)
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
