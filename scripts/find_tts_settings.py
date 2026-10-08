# -*- coding: utf-8 -*-
"""볼케이노가 쓰는 **TTS 설정을 영수증 해시로 알아낸다.** TTS 를 사지 않는다.

    python scripts/find_tts_settings.py

어떻게 되나 (2026-10-09)
  볼케이노는 TTS 요청 본문의 sha256 을 영수증에 남긴다:
    <회차>/paid/<해시>/receipt.json  →  body_sha256
  그리고 본문 모양과 해시 방법이 실행기에 다 드러나 있다:
    film_editor.py 30~32   digest(v) = sha256(json.dumps(v, sort_keys=True, ensure_ascii=False))
    film_editor.py 491~495 typecast_body(text, settings)
  그러므로 Typecast 목소리 목록(1143개) × 감정 × 속도를 돌려 **해시가 맞는 조합**을 찾으면
  voice_id·emotion·tempo 를 알 수 있다. 서버 설정을 볼 수 없어도 된다.

  요청한 글은 회차 편집표의 해설을 이은 것이다. 엔진이 `cursor += len(text) + 1` 로 넘어가므로
  사이에 한 글자(줄바꿈)가 들어간다 — 글자 수가 영수증과 맞는지로 확인한다.

결과 (2026-10-09): 명화관 9편 전부
    voice_id tc_611c3f692fac944dff493a04 (SeHee) · emotion tonedown · tempo 1.2
  린박스 회차도 같은 값이었다.

먼저 목소리 목록이 있어야 한다(없으면 받는다):
    cache/typecast_voices.json
"""
import hashlib, io, json, glob
from pathlib import Path


def digest(v):
    return hashlib.sha256(json.dumps(v, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode('utf-8')).hexdigest()


def body(text, vid, model, lang, emotion, tempo, seed=42):
    return {'text': text, 'voice_id': vid, 'model': model, 'language': lang, 'seed': seed,
            'prompt': {'emotion_type': 'preset', 'emotion_preset': emotion, 'emotion_intensity': 1},
            'output': {'volume': 100, 'audio_pitch': 0, 'audio_tempo': tempo, 'audio_format': 'wav'}}


voices = json.load(io.open('D:/midform/cache/typecast_voices.json', encoding='utf-8'))
ids = []
for v in voices:
    for k in ('voice_id', 'id', 'voiceId'):
        if isinstance(v, dict) and v.get(k):
            ids.append((v[k], v.get('voice_name') or v.get('name') or ''))
            break

WANT = None   # None 이면 모든 회차
EM = ['normal', 'tonedown', 'toneup', 'tonemid', 'happy', 'sad', 'angry', 'calm', 'excited', 'neutral']
TEMPO = [1.2, 1.0, 1.05, 1.1, 1.15, 1.25, 1.3, 1.35, 1.4, 0.95, 0.9, 1.45, 1.5]
for rj in sorted(glob.glob('D:/volcano-runs/*/paid/*/receipt.json')):
    wd = Path(rj).parents[2]
    if WANT and wd.name not in WANT:
        continue
    r = json.load(io.open(rj, encoding='utf-8'))
    ed = sorted(glob.glob(str(wd / 'edits' / '*' / 'effective-edit.json'))) or \
         sorted(glob.glob(str(wd / 'edits' / '*' / 'edit.json')))
    if not ed:
        continue
    e = json.load(io.open(ed[0], encoding='utf-8'))
    text = '\n'.join(n['text'] for n in e['narration'])
    if len(text) != r.get('characters'):
        t2 = ' '.join(n['text'] for n in e['narration'])
        text = t2 if len(t2) == r.get('characters') else text
    if len(text) != r.get('characters'):
        print('%-10s 글자 수 불일치 %d vs %s — 건너뜀' % (wd.name, len(text), r.get('characters')))
        continue
    hit = None
    for vid, vname in ids:
        for em in EM:
            for tp in TEMPO:
                if digest(body(text, vid, r['model'], r['language'], em, tp)) == r['body_sha256']:
                    hit = (vid, vname, em, tp)
                    break
            if hit:
                break
        if hit:
            break
    print('%-10s %s/%s %3d자 → %s' % (wd.name, r['model'], r['language'], len(text),
                                      ('%s(%s) emotion=%s tempo=%s' % (hit[1], hit[0], hit[2], hit[3])) if hit else '못 찾음'))
