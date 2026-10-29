# -*- coding: utf-8 -*-
"""고양이 밈 대사 음성 — beats.json 의 대사(line)·반응 대사(react_line)를 인물마다 다른 Supertonic ko 목소리로 읽는다.

    python -X utf8 ko-corp/cat/cat_voice.py ko-corp/cat01            합성 → voice/voice.json → 역전사 대조
    python -X utf8 ko-corp/cat/cat_voice.py ko-corp/cat01 --no-audit  합성만
    python -X utf8 ko-corp/cat/cat_voice.py ko-corp/cat01 --engine supertonic   옛 무료 목소리(4판)

5판(10-30 소유주 #29 «tts 타입캐스트로 가자»): 기본 엔진 = Typecast(유료, 키 ~/.volcano/keys/typecast).
클립마다 요청 본문 해시로 voice/tc/<해시>.wav 에 보관 — 같은 대사·목소리는 다시 결제하지 않는다.

왜(10-29 소유주 #25 «tts 어디갔어 왜 빠졌어?»): 헤이루만 레퍼런스가 내레이션 0 이라 1~3판은 자막·효과음뿐이었다.
화면의 대사 글자를 그대로 말로 읽는다(자막 = 말). 숫자·연도는 ko_say 로 한글 읽기, 역전사 대조(ko TTS 오독 10-19)로 확인한다.
cat_render.py 는 voice/voice.json 이 있으면 화면 길이를 말 길이에 맞춰 늘리고 목소리를 섞는다.
결과: voice/<n>_a.wav(대사)·<n>_b.wav(반응) · voice/voice.json {"<n>": {"a": 초, "b": 초}} · 불일치면 종료 4.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import hashlib
import urllib.request
import wave
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ko-corp' / 'render'))
from ko_say import say  # noqa: E402

TTS = {'python': 'D:/midform/tts-lab/supertonic/.venv/Scripts/python.exe', 'dir': 'D:/midform/tts-lab/supertonic',
       'speed': 1.08, 'steps': 8, 'gap': 0.6, 'lang': 'ko', 'num_reading': False}
WORKER = ROOT / 'ja-nenkin' / 'render' / 'supertonic_worker.py'
VOICE = {'boss': 'M1', 'resident': 'F2', 'guest': 'F3', 'dealer': 'M3'}   # 사장·주민·손님·도매상 — 인물마다 다른 목소리
TC = {'endpoint': 'https://api.typecast.ai/v1/text-to-speech', 'model': 'ssfm-v30', 'language': 'kor', 'tempo': 1.1, 'seed': 42}
TC_VOICE = {'boss': ('tc_68257f68bc6e3c161ab5078d', 'Piljae'), 'resident': ('tc_692799c46508f6b9468c54c7', 'Daeun'),
            'guest': ('tc_6a21054564d676539427427e', 'Hyejin'), 'dealer': ('tc_69fc0cff784968297fb45daa', 'Sanghyun')}


def spoken(line):
    """화면 줄바꿈 «/»·«\\n» 을 띄어쓰기로. 말 끝 «…» 은 마침표로."""
    t = re.sub(r'\s*(/|\\n|\n)\s*', ' ', line).replace('…', '.').strip()
    return re.sub(r'\s+', ' ', t)


def clips(beats):
    """(파일 이름, 인물, 문장) 목록 — 대사는 말하는 고양이, 반응 대사는 반응 고양이 목소리."""
    out = []
    for b in beats:
        if b.get('line'):
            out.append((f'{b["n"]:02d}_a', b['speaker'].split('.')[0], spoken(b['line'])))
        if b.get('react_line'):
            out.append((f'{b["n"]:02d}_b', b['react'].split('.')[0], spoken(b['react_line'])))
    return out


def synth(voice, items, vdir):
    """한 목소리의 문장을 한 번에 합성(모델 한 번만 올림)하고, 문장 구간대로 잘라 파일마다 저장."""
    whole = vdir / f'_{voice}.wav'
    job = dict(TTS, voice=voice, out=str(whole), sentences=[[say(s), [s]] for _, s in items])
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(job, f, ensure_ascii=False)
    r = subprocess.run([TTS['python'], str(WORKER), f.name], capture_output=True, text=True, encoding='utf-8',
                       env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    os.unlink(f.name)
    if r.returncode:
        raise SystemExit(r.stderr[-2000:])
    cues = json.loads(r.stdout.strip().splitlines()[-1])
    with wave.open(str(whole)) as w:
        params, sr, frames = w.getparams(), w.getframerate(), w.readframes(w.getnframes())
    width = params.sampwidth * params.nchannels
    secs = {}
    for (name, _), (a, b, _t) in zip(items, cues):
        with wave.open(str(vdir / f'{name}.wav'), 'wb') as o:
            o.setparams(params)
            o.writeframes(frames[int(a * sr) * width:int(b * sr) * width])
        secs[name] = round(b - a, 3)
    whole.unlink()
    return secs


def trim_wav(src, dst, db=-40):
    """앞뒤 무음을 잘라 모노 PCM16 으로 저장(ffmpeg), 길이(초)를 돌려준다."""
    cut = f'silenceremove=start_periods=1:start_threshold={db}dB'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-af', f'{cut},areverse,{cut},areverse,apad=pad_dur=0.05',
                    '-ac', '1', '-c:a', 'pcm_s16le', str(dst)], check=True)
    with wave.open(str(dst)) as w:
        return round(w.getnframes() / w.getframerate(), 3)


def typecast(who, items, vdir):
    """Typecast 로 한 문장씩. 받은 원본은 voice/tc/<본문 해시>.wav 에 두고 재사용(재결제 없음)."""
    key = (Path.home() / '.volcano' / 'keys' / 'typecast').read_text(encoding='utf-8').strip()
    cache = vdir / 'tc'
    cache.mkdir(exist_ok=True)
    secs = {}
    for name, s in items:
        body = {'text': say(s), 'voice_id': TC_VOICE[who][0], 'model': TC['model'], 'language': TC['language'], 'seed': TC['seed'],
                'prompt': {'emotion_type': 'preset', 'emotion_preset': 'normal', 'emotion_intensity': 1},
                'output': {'volume': 100, 'audio_pitch': 0, 'audio_tempo': TC['tempo'], 'audio_format': 'wav'}}
        raw = cache / (hashlib.sha1(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16] + '.wav')
        if not raw.exists():
            req = urllib.request.Request(TC['endpoint'], data=json.dumps(body, ensure_ascii=False).encode(),
                                         headers={'X-API-KEY': key, 'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            tmp = raw.with_suffix('.part')
            tmp.write_bytes(data)
            tmp.replace(raw)
        secs[name] = trim_wav(raw, vdir / f'{name}.wav')
    return secs


def audit(ep, items, vdir):
    """이어 붙여 Speechmatics ko 로 받아쓰고, 대사의 숫자가 클립마다 들렸는지 센다(ko-corp/render/audit.py 파서 재사용)."""
    import audit as A
    au = ep / 'audit'
    au.mkdir(exist_ok=True)
    wav, tr = au / 'cat_voice.wav', au / 'cat_voice.json'
    offs = A.concat([vdir / f'{n}.wav' for n, _ in items], wav)
    subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'rinbox_transcribe.py'), str(wav), str(tr), '--lang', 'ko'], check=True)
    words = json.loads(tr.read_text(encoding='utf-8'))
    bad, total, lines = 0, 0, []
    for k, (name, s) in enumerate(items):
        heard = ' '.join(w for a, b, w in words if offs[k] - .05 <= (a + b) / 2 < offs[k + 1] + .05)
        want = Counter(v for v in A.script_values(s) if v is not None)
        miss = want - Counter(A.values(heard))
        total += sum(want.values())
        bad += sum(miss.values())
        lines.append(f'- {name} {"✘ 빠짐 " + str(dict(miss)) if miss else "○"} · 대본: {s}\n  들림: {heard}')
    head = f'역전사 대조: 숫자 {total - bad}/{total} (불일치 {bad}건)'
    (au / 'report_cat_voice.md').write_text(head + '\n\n' + '\n'.join(lines) + '\n', encoding='utf-8')
    print(head)
    print('\n'.join(x for x in lines if '✘' in x))
    return bad


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1]).resolve()
    beats = json.loads((ep / 'beats.json').read_text(encoding='utf-8'))['beats']
    vdir = ep / 'voice'
    vdir.mkdir(exist_ok=True)
    items = clips(beats)
    secs = {}
    engine = sys.argv[sys.argv.index('--engine') + 1] if '--engine' in sys.argv else 'typecast'
    for who in sorted({w for _, w, _ in items}):
        mine = [(n, s) for n, w, s in items if w == who]
        secs.update(typecast(who, mine, vdir) if engine == 'typecast' else synth(VOICE[who], mine, vdir))
    table = {}
    for name, sec in secs.items():
        n, part = name.split('_')
        table.setdefault(str(int(n)), {})[part] = sec
    voices = {k: v[1] for k, v in TC_VOICE.items()} if engine == 'typecast' else VOICE
    (vdir / 'voice.json').write_text(json.dumps({'engine': engine, 'voices': voices, 'speed': TC['tempo'] if engine == 'typecast' else TTS['speed'], 'clips': table}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'음성 {len(items)}개 · {engine} · 합 {sum(secs.values()):.1f}초 · 목소리 {voices}')
    if '--no-audit' not in sys.argv and audit(ep, [(n, s) for n, _, s in items], vdir):
        sys.exit(4)


if __name__ == '__main__':
    main()
