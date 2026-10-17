# -*- coding: utf-8 -*-
"""연금 편 숫자 역전사 대조 — 장면별 voice.wav 를 이어 Speechmatics 로 받아쓰고, 대본 숫자가 들리는 숫자에 있는지 장면마다 맞춘다.

    python ja-nenkin/render/num_audit.py ja-nenkin/ep01            # 이어 붙이기 → 받아쓰기(이미 있으면 재사용) → 대조
    python ja-nenkin/render/num_audit.py ja-nenkin/ep01 --only 12,40   # 그 장면만 다시 받아써서 대조(재합성 뒤)

결과: ep/audit/report.md 와 «불일치 N건 / 전체 숫자 M개» 한 줄. 불일치가 있으면 종료 코드 4.
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
    out = []
    for i, blk in enumerate(blocks):
        f = ep / 'seg' / f'{i:03d}-{blk["vid"]}-{R.key([blk, vis[blk["vid"]], R.CODE])}'
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
    bad, total, lines = 0, 0, []
    for k, i in enumerate(idx):
        heard = ''.join(w for a, b, w in words if offs[k] - .05 <= (a + b) / 2 < offs[k + 1] + .05)
        want = Counter(v for s in blocks[i]['sentences'] for v in N.values_arabic(s))
        got = Counter(nums(heard))
        miss = want - got
        total += sum(want.values())
        if miss:
            bad += sum(miss.values())
            lines.append(f'- [{i}] {blocks[i]["vid"]}: 대본 {dict(want)} · 빠짐 {dict(miss)}\n  들림: {heard}')
    head = f'숫자 역전사 대조: 불일치 {bad}건 / 전체 숫자 {total}개'
    (au / f'report_{tag}.md').write_text(head + '\n\n' + '\n'.join(lines) + '\n', encoding='utf-8')
    print(head)
    print('\n'.join(lines))
    return 4 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
