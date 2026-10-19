"""해설 음성 공급자. 모두 (wav 경로, 자막 큐[(시작초, 끝초, 문구)]) 를 돌려준다.

  google    Google Cloud TTS(무료 사용량). SSML mark 로 자막 덩어리마다 시각을 받는다.
            프로젝트에 결제 계정이 연결돼 있어야 한다(무료 한도 안에서는 청구 없음).
  typecast  1편에서 이미 결제한 음성만 재사용한다(새 요청 없음). 글자 시각으로 자막을 자른다.
  supertonic  Supertonic 3 로컬(무료·CPU). 소유주 선택 목소리 F2(10/13). 문장별로 만들어 잇는다.
"""
import base64
import hashlib
import html
import json
import re
import subprocess
import sys
import urllib.request
import wave
from pathlib import Path

from config import GOOGLE_PROJECT as PROJECT, GOOGLE_VOICE as _VOICE, SUPERTONIC
GOOGLE_VOICE = {'languageCode': 'ko-KR', 'name': _VOICE}
GOOGLE_RATE = 1.12
MAX_CHUNK = 22


def chunks(text):
    """자막 덩어리: 문장 끝에서 끊고, 긴 문장은 쉼표·공백에서 22자 안쪽으로 나눈다."""
    out = []
    for sent in re.split(r'(?<=[.!?])\s+', text.strip()):
        cur = ''
        for word in sent.split():
            if cur and len(cur) + 1 + len(word) > MAX_CHUNK:
                out.append(cur); cur = word
            else:
                cur = (cur + ' ' + word).strip()
            if cur.endswith(',') and len(cur) > MAX_CHUNK * .5:
                out.append(cur); cur = ''
        if cur:
            out.append(cur)
    return out


def wav_seconds(path):
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def google(text, out):
    parts = chunks(text)
    ssml = '<speak>' + ''.join(f'<mark name="c{i}"/>{html.escape(p)} ' for i, p in enumerate(parts)) + '<mark name="end"/></speak>'
    token = subprocess.run(['gcloud', 'auth', 'application-default', 'print-access-token'], capture_output=True,
                           text=True, shell=sys.platform == 'win32').stdout.strip()
    body = {'input': {'ssml': ssml}, 'voice': GOOGLE_VOICE, 'enableTimePointing': ['SSML_MARK'],
            'audioConfig': {'audioEncoding': 'LINEAR16', 'sampleRateHertz': 48000, 'speakingRate': GOOGLE_RATE}}
    req = urllib.request.Request('https://texttospeech.googleapis.com/v1beta1/text:synthesize',
                                 data=json.dumps(body).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + token, 'x-goog-user-project': PROJECT,
                                          'Content-Type': 'application/json'})
    data = json.loads(urllib.request.urlopen(req, timeout=120).read())
    Path(out).write_bytes(base64.b64decode(data['audioContent']))
    marks = {m['markName']: m['timeSeconds'] for m in data.get('timepoints', [])}
    total = wav_seconds(out)
    cues = []
    for i, p in enumerate(parts):
        a = marks.get(f'c{i}', 0); b = marks.get(f'c{i + 1}', marks.get('end', total))
        cues.append((a, b, p.rstrip('.')))
    return out, cues


def typecast_cached(text, out, workdir='D:/volcano-runs/politics-20261012-grave'):
    """이미 결제한 1편 음성만 쓴다. 없으면 실패(새 유료 요청은 하지 않는다)."""
    sys.path.insert(0, 'D:/midform/longform/engine')
    from film_editor import digest
    import longform_engine as eng
    settings = eng.voice_settings({'narration': {'tempo': 1.05, 'sentence_gap_add_seconds': .3}})
    folder = Path(workdir) / 'geumbit' / 'voice' / digest({'text': text, 'voice': settings})
    paid = sorted(folder.glob('paid/*/response.json'))
    if not paid:
        raise SystemExit('결제된 음성 없음: ' + text[:30])
    data = json.loads(paid[0].read_text(encoding='utf-8'))
    Path(out).write_bytes((paid[0].parent / 'narration.wav').read_bytes())
    chars = data['characters']
    cues, pos = [], 0
    for p in chunks(text):
        start = text.index(p.split()[0], pos); end = start + len(p)
        a = chars[start]['start']; b = chars[min(end, len(chars)) - 1]['end']
        cues.append((a, b, p.rstrip('.'))); pos = end
    return out, cues


def supertonic(text, out, say=None):
    """문장마다 합성하고 문장 안 자막 덩어리는 글자 수 비율로 시각을 나눈다(supertonic_worker.py).
    say: 소리로 낼 문장만 바꾸는 함수(숫자 → 한글 읽기, ko-corp/render/ko_say.say). 자막 덩어리는 원고 표기 그대로(10-19 «3시 8분→4시 8분» 대책)."""
    import tempfile
    sentences = [s for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s]
    job = dict(SUPERTONIC, out=str(Path(out).resolve()),
               sentences=[[say(s) if say else s, [p.rstrip('.') for p in chunks(s)]] for s in sentences])
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(job, f, ensure_ascii=False)
    try:
        res = subprocess.run([SUPERTONIC['python'], str(Path(__file__).with_name('supertonic_worker.py')), f.name],
                             capture_output=True, text=True, encoding='utf-8', check=True,
                             env=dict(__import__('os').environ, PYTHONIOENCODING='utf-8'))
    finally:
        Path(f.name).unlink(missing_ok=True)
    return out, [tuple(c) for c in json.loads(res.stdout.strip().splitlines()[-1])]


PROVIDERS = {'google': google, 'typecast': typecast_cached, 'supertonic': supertonic}


def voice_id(provider):
    """조각 저장본 구분에 쓰는 목소리 설정. 로컬 경로는 빼고 목소리·속도만 본다."""
    if provider == 'supertonic':
        return {k: SUPERTONIC[k] for k in ('voice', 'speed', 'steps', 'gap')}
    return {'google': GOOGLE_VOICE, 'rate': GOOGLE_RATE} if provider == 'google' else provider


def speak(provider, text, out, say=None):
    if say and provider != 'supertonic':
        raise ValueError('숫자 한글 읽기(say)는 supertonic 에서만 — 다른 공급자는 자막 시각이 소리 글자에 묶여 있다')
    return PROVIDERS[provider](text, out, say=say) if say else PROVIDERS[provider](text, out)
