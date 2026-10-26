# -*- coding: utf-8 -*-
"""고양이 밈 레인 효과음을 직접 합성한다(권리 걱정 0). python -X utf8 ko-corp/cat/make_sfx.py → ko-corp/cat/sfx/*.wav
pop=말풍선 · boing=«띠용»(반전) · tada=«빠밤»(득의) · womp=«뿌우»(좌절)"""
import wave
from pathlib import Path

import numpy as np

SR = 48000
OUT = Path(__file__).resolve().parent / 'sfx'


def env(n, a=0.005, r=0.5):
    t = np.arange(n) / SR
    return np.minimum(1, t / a) * np.exp(-t / r)


def tone(f0, f1, dur, shape='sine', r=0.3, vib=0.0):
    n = int(dur * SR)
    f = np.geomspace(f0, f1, n) * (1 + vib * np.sin(2 * np.pi * 28 * np.arange(n) / SR))
    ph = 2 * np.pi * np.cumsum(f) / SR
    w = np.sin(ph) if shape == 'sine' else np.sign(np.sin(ph)) * 0.5 + np.sin(ph) * 0.5
    return w * env(n, r=r)


def save(name, x):
    x = x / max(1e-9, np.abs(x).max()) * 0.8
    with wave.open(str(OUT / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


OUT.mkdir(exist_ok=True)
save('pop', tone(900, 300, 0.09, r=0.04))
save('boing', tone(180, 720, 0.45, r=0.35, vib=0.08))
save('tada', np.concatenate([tone(523, 523, 0.12, 'square', 0.1), tone(784, 784, 0.5, 'square', 0.3)]))
save('womp', np.concatenate([tone(392, 370, 0.3, 'square', 0.4), tone(330, 300, 0.3, 'square', 0.4), tone(262, 200, 0.8, 'square', 0.6)]))
print(sorted(p.name for p in OUT.glob('*.wav')))
