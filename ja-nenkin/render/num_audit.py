# -*- coding: utf-8 -*-
"""연금 편 숫자 역전사 대조 — 장면별 voice.wav 를 이어 Speechmatics 로 받아쓰고, 대본 숫자가 들리는 숫자에 있는지 장면마다 맞춘다.

    python ja-nenkin/render/num_audit.py ja-nenkin/ep01            # 이어 붙이기 → 받아쓰기(이미 있으면 재사용) → 대조
    python ja-nenkin/render/num_audit.py ja-nenkin/ep01 --only 12,40   # 그 장면만 다시 받아써서 대조(재합성 뒤)

결과: ep/audit/report.md 와 «숫자 N/M·고유명사 N/M»(맞은 수/전체) 한 줄. 불일치가 있으면 종료 코드 4.
고유명사는 ep/yomi.json 의 audit 표(표기: [들려도 되는 다른 표기…])로 장면마다 대본 횟수만큼 들렸는지 센다.
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
sys.path.insert(0, str(HERE.parents[1] / 'scripts'))
import nenkin_render as R  # noqa: E402
import ja_numread as N  # noqa: E402


def segs(ep, blocks, vis):
    """장면 순서대로 현재 대본에 맞는 seg 폴더(voice.wav 있는 것)."""
    out, yomi = [], R.load_yomi(ep)
    for i, blk in enumerate(blocks):
        f = ep / 'seg' / R.seg_name(i, blk, vis[blk["vid"]], yomi)
        if not (f / 'voice.wav').exists():
            raise SystemExit(f'voice.wav 없음: {f.name}')
        out.append(f)
    return out


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


def nums(text):
    """들린 숫자: 아라비아(万·億 묶음) + 한자 숫자."""
    return N.values_arabic(text) + N.values_kanji(text)


def count(text, w):
    """영문 한 글자(표 칸 기호)는 앞뒤가 영문이 아닐 때만 센다(대소문자 무시)."""
    if w.isascii() and len(w) == 1:
        return len(re.findall(r'(?<![A-Za-z])' + re.escape(w) + r'(?![A-Za-z])', text, re.I))
    return text.count(w)


def names(sentences, heard, table):
    """고유명사: 대본 횟수 대비 들린 횟수(표기 또는 다른 표기) — 빠진 것만 돌려준다."""
    want, miss = 0, {}
    for w, alts in table.items():
        n = sum(count(s, w) for s in sentences)
        if not n:
            continue
        want += n
        got = count(heard, w) + sum(count(heard, a) for a in alts)
        if got < n:
            miss[w] = n - got
    return want, miss


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    only = [int(x) for x in argv[argv.index('--only') + 1].split(',')] if '--only' in argv else None
    blocks = R.parse_script(ep / 'script.txt')
    vis = json.loads((ep / 'visuals.json').read_text(encoding='utf-8'))
    vis.pop('_emph', None)
    folders = segs(ep, blocks, vis)
    au = ep / 'audit'
    au.mkdir(exist_ok=True)
    idx = only or list(range(len(blocks)))
    tag = 'all' if not only else 'only_' + '_'.join(map(str, only))
    wav, tr = au / f'{tag}.wav', au / f'{tag}.json'
    offs = concat([folders[i] / 'voice.wav' for i in idx], wav)
    if not tr.exists():
        subprocess.run([sys.executable, '-X', 'utf8', str(HERE.parents[1] / 'scripts' / 'rinbox_transcribe.py'),
                        str(wav), str(tr), '--lang', 'ja'], check=True)
    words = json.loads(tr.read_text(encoding='utf-8'))
    yf = ep / 'yomi.json'
    table = json.loads(yf.read_text(encoding='utf-8')).get('audit', {}) if yf.exists() else {}
    bad, total, lines = 0, 0, []
    nbad, ntotal = 0, 0
    for k, i in enumerate(idx):
        heard = ''.join(w for a, b, w in words if offs[k] - .05 <= (a + b) / 2 < offs[k + 1] + .05)
        want = Counter(v for s in blocks[i]['sentences'] for v in N.values_arabic(s))
        got = Counter(nums(heard))
        miss = want - got
        total += sum(want.values())
        nw, nmiss = names(blocks[i]['sentences'], heard, table)
        ntotal += nw
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
