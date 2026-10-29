# -*- coding: utf-8 -*-
"""고양이 밈 대사 음성 — beats.json 의 대사(line)·반응 대사(react_line)를 인물마다 다른 Supertonic ko 목소리로 읽는다.

    python -X utf8 ko-corp/cat/cat_voice.py ko-corp/cat01            합성 → voice/voice.json → 역전사 대조
    python -X utf8 ko-corp/cat/cat_voice.py ko-corp/cat01 --no-audit  합성만

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
    for who in sorted({w for _, w, _ in items}):
        secs.update(synth(VOICE[who], [(n, s) for n, w, s in items if w == who], vdir))
    table = {}
    for name, sec in secs.items():
        n, part = name.split('_')
        table.setdefault(str(int(n)), {})[part] = sec
    (vdir / 'voice.json').write_text(json.dumps({'voices': VOICE, 'speed': TTS['speed'], 'clips': table}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'음성 {len(items)}개 · 합 {sum(secs.values()):.1f}초 · 목소리 {VOICE}')
    if '--no-audit' not in sys.argv and audit(ep, [(n, s) for n, _, s in items], vdir):
        sys.exit(4)


if __name__ == '__main__':
    main()
