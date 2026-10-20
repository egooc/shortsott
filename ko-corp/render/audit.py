# -*- coding: utf-8 -*-
"""기업 흥망 역전사 대조 — 장면별 voice.wav 를 이어 Speechmatics ko 로 받아쓰고, 대본 숫자·고유명사가 들렸는지 장면마다 맞춘다.
연금 num_audit.py 의 ko 판(숫자 파서만 한국어로). ko TTS 시각·숫자 오독(10-19 실화 ②편) 관문.

    python -X utf8 ko-corp/render/audit.py ko-corp/ep01              # 이어 붙이기 → 받아쓰기(있으면 재사용) → 대조
    python -X utf8 ko-corp/render/audit.py ko-corp/ep01 --only 12,40  # 그 장면만 다시 받아써서 대조(재합성 뒤)

결과: ep/audit/report_*.md 와 «숫자 N/M·고유명사 N/M» 한 줄. 불일치가 있으면 종료 코드 4.
고유명사 표: ep/names.json {"표기": ["들려도 되는 다른 표기", ...]} — 장면마다 대본 횟수만큼 들렸는지 센다.
"""
import json
import re
import subprocess
import sys
import wave
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import corp_render as C  # noqa: E402

D = {c: i for i, c in enumerate('영일이삼사오육칠팔구')}
D.update({'공': 0})
SMALL = {'십': 10, '백': 100, '천': 1000}
BIG = {'만': 10 ** 4, '억': 10 ** 8, '조': 10 ** 12}
NATIVE = {'한': 1, '하나': 1, '두': 2, '둘': 2, '세': 3, '셋': 3, '네': 4, '넷': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9, '열': 10,
          '스물': 20, '서른': 30, '마흔': 40, '쉰': 50}
MONTHS = {'시월': 10, '유월': 6}
RUN = re.compile(r'[0-9,영공일이삼사오육칠팔구십백천만억조]+')


def parse_run(s):
    """«3조3,900억» «이천백오십오억» «만» «1997» 같은 덩어리 → 정수(못 읽으면 None)."""
    s = s.replace(',', '')
    if not s or not re.search(r'[0-9일이삼사오육칠팔구십백천만억조]', s):
        return None
    total, sect, num = 0, 0, None
    for ch in re.findall(r'\d+|.', s):
        if ch.isdigit():
            num = int(ch)
        elif ch in D:
            num = D[ch]
        elif ch in SMALL:
            sect += (num if num is not None else 1) * SMALL[ch]; num = None
        elif ch in BIG:
            sect += num or 0
            total += (sect or 1) * BIG[ch]; sect, num = 0, None
    return total + sect + (num or 0)


def values(text):
    """들린 수: 숫자·한자어 수(단위 묶음은 공백을 지우고 하나로), 고유어 1~99, 시월·유월."""
    out = []
    t = re.sub(r'(?<=\d)일', ' ', text)  # «23일» 의 날짜 «일» 은 숫자 1 이 아니다
    t = re.sub(r'(?<=[0-9조억만천백십])\s+(?=[0-9일이삼사오육칠팔구십백천])', '', t)
    for w, v in MONTHS.items():
        out += [v] * t.count(w)
    for m in RUN.finditer(t):
        v = parse_run(m.group())
        if v is not None:
            out.append(v)
    for m in re.finditer(r'(열|스물|서른|마흔|쉰)?\s*(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉)?\s*(?=개|번|명|곳|가지|살|시)', text):
        if m.group(0).strip():
            out.append(sum(NATIVE[g] for g in m.groups() if g))
    return out


def script_values(sentence):
    """대본 숫자(아라비아): 단위 묶음 «3조 3,900억» 은 하나의 값, «1만 4,000명» 도 하나."""
    t = re.sub(r'(?<=[0-9조억만])\s+(?=[0-9])', '', sentence)
    return [parse_run(m.group()) for m in re.finditer(r'\d[\d,]*(?:[조억만](?:\d[\d,]*[억만]?)*)?', t)]


def concat(wavs, out):
    offs, t = [], 0.0
    with wave.open(str(out), 'wb') as w:
        for k, p in enumerate(wavs):
            with wave.open(str(p)) as r:
                if k == 0:
                    w.setparams(r.getparams())
                w.writeframes(r.readframes(r.getnframes()))
                offs.append(t)
                t += r.getnframes() / r.getframerate()
    return offs + [t]


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    only = [int(x) for x in argv[argv.index('--only') + 1].split(',')] if '--only' in argv else None
    blocks = C.R.parse_script(ep / 'script.txt')
    vis = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
    vis.pop('_emph', None)
    idx = only or list(range(len(blocks)))
    folders = [C.voice_dir(ep, blocks[i]) for i in idx]
    lack = [f.name for f in folders if not (f / 'voice.wav').exists()]
    if lack:
        raise SystemExit('voice.wav 없음: ' + ', '.join(lack[:5]))
    au = ep / 'audit'
    au.mkdir(exist_ok=True)
    tag = 'all' if not only else 'only_' + '_'.join(map(str, only))
    wav, tr = au / f'{tag}.wav', au / f'{tag}.json'
    offs = concat([f / 'voice.wav' for f in folders], wav)
    if not tr.exists() or only:
        subprocess.run([sys.executable, '-X', 'utf8', str(HERE.parents[1] / 'scripts' / 'rinbox_transcribe.py'),
                        str(wav), str(tr), '--lang', 'ko'], check=True)
    words = json.loads(tr.read_text(encoding='utf-8'))
    nf = ep / 'names.json'
    table = json.loads(nf.read_text(encoding='utf-8')) if nf.exists() else {}
    bad = total = nbad = ntotal = 0
    lines = []
    for k, i in enumerate(idx):
        heard = ' '.join(w for a, b, w in words if offs[k] - .05 <= (a + b) / 2 < offs[k + 1] + .05)
        want = Counter(v for s in blocks[i]['sentences'] for v in script_values(s))
        miss = want - Counter(values(heard))
        total += sum(want.values())
        nmiss = {}
        flat = heard.replace(' ', '')
        for w, alts in table.items():
            n = sum(s.count(w) for s in blocks[i]['sentences'])
            if n:
                ntotal += n
                got = sum(flat.count(x.replace(' ', '')) for x in [w, *alts])
                if got < n:
                    nmiss[w] = n - got
        nbad += sum(nmiss.values())
        if miss or nmiss:
            bad += sum(miss.values())
            lines.append(f'- [{i}] {blocks[i]["vid"]}: 숫자 대본 {dict(want)} · 빠짐 {dict(miss)} · 고유명사 빠짐 {nmiss}\n  들림: {heard}')
    head = f'역전사 대조: 숫자 {total - bad}/{total}·고유명사 {ntotal - nbad}/{ntotal} (불일치 숫자 {bad}건·고유명사 {nbad}건)'
    (au / f'report_{tag}.md').write_text(head + '\n\n' + '\n'.join(lines) + '\n', encoding='utf-8')
    print(head)
    print('\n'.join(lines))
    return 4 if bad or nbad else 0


if __name__ == '__main__':
    sys.exit(main())
