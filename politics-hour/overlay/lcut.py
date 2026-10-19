# -*- coding: utf-8 -*-
"""L컷 오디오 후처리 — 이어 붙인 episode.mp4 에서 인용(quote) → 다음 조각 경계마다, 원본 src 의 out 뒤 0.3~0.5초 소리를
다음 조각 첫머리에 페이드아웃으로 깐다(정치 이어 붙이기 문법 10-18: 말은 끝났는데 현장 소리가 살짝 남아 넘어간다).

조각 캐시(work/seg/*/normalized.mp4)는 건드리지 않는다. 영상 스트림은 복사, 음성만 다시 섞는다.
import 해도 실행되지 않는다(정치 JA 도 import) — 부르는 쪽: render_episode.py(episode.json "lcut": 0.4).

    from lcut import apply
    apply('episodes/20261020')                  # episode.json·work/concat.txt 를 읽어 work/episode.mp4 를 제자리 교체
    python -X utf8 politics-hour/overlay/lcut.py episodes/20261020 [--sec 0.4] [--out x.mp4]

꼬리 소리 크기: 그 인용 조각(normalized.mp4, 조각별 loudnorm 뒤)의 마지막 1초와 원본 src 의 out 앞 1초 크기 차이만큼 맞춘다.
다음 조각이 cold(효과음)면 깔지 않는다. 꼬리가 원본 끝을 넘으면 있는 만큼만.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SEC_MIN, SEC_MAX = 0.3, 0.5


def _dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout)


def _mean_db(src, start, dur):
    r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-ss', f'{max(0, start):.3f}', '-t', f'{dur:.3f}', '-i', str(src),
                        '-vn', '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    m = re.search(r'mean_volume:\s*(-?[\d.]+) dB', r.stderr)
    return float(m.group(1)) if m else None


def plan(ep_dir, sec=0.4):
    """[(다음 조각 시작초, 원본 src, out, 꼬리 길이, 이득 dB)] — 실제 섞기 전에 볼 수 있게 따로 둔다."""
    sec = min(SEC_MAX, max(SEC_MIN, float(sec)))
    ep = Path(ep_dir).resolve()
    E = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    work = (ep / E['workdir']).resolve()
    parts = [Path(l.split("'")[1]) for l in (work / 'concat.txt').read_text(encoding='utf-8').splitlines() if l.strip()]
    segs = E['segments']
    assert len(parts) == len(segs), (len(parts), len(segs))
    starts, t = [], 0.0
    for p in parts:
        starts.append(t); t += _dur(p)
    out = []
    for i, s in enumerate(segs[:-1]):
        if s['type'] != 'quote' or segs[i + 1]['type'] == 'cold':
            continue
        src = (ep / s['src']).resolve()
        tail = min(sec, max(0.0, _dur(src) - s['out']))
        if tail < 0.1:
            continue
        a, b = _mean_db(parts[i], _dur(parts[i]) - 1.0, 1.0), _mean_db(src, s['out'] - 1.0, 1.0)
        gain = (a - b) if a is not None and b is not None else 0.0
        out.append((round(starts[i + 1], 3), str(src), s['out'], round(tail, 3), round(max(-20.0, min(12.0, gain)), 1)))
    return out


def apply(ep_dir, sec=0.4, out=None):
    """work/episode.mp4 에 L컷 꼬리를 섞는다. 반환: {'cuts': N, 'out': 경로}. 실패하면 원본은 그대로."""
    ep = Path(ep_dir).resolve()
    E = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    video = (ep / E['workdir']).resolve() / 'episode.mp4'
    cuts = plan(ep, sec)
    if not cuts:
        return {'cuts': 0, 'out': str(video)}
    tmpd = Path(tempfile.mkdtemp(prefix='lcut_', dir=str(video.parent)))
    try:
        tails = []
        for k, (at, src, o, d, g) in enumerate(cuts):
            w = tmpd / f't{k:02d}.wav'
            fade = max(0.1, d * 0.8)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{o:.3f}', '-t', f'{d:.3f}', '-i', src, '-vn',
                            '-af', f'aresample=48000,volume={g}dB,afade=t=in:d=0.02,afade=t=out:st={d - fade:.3f}:d={fade:.3f}',
                            '-ac', '2', str(w)], check=True)
            tails.append((at, w))
        inputs = ['-i', str(video)]
        chains = []
        for k, (at, w) in enumerate(tails):
            inputs += ['-i', str(w)]
            ms = int(round(at * 1000))
            chains.append(f'[{k + 1}:a]adelay={ms}|{ms}[d{k}]')
        mix = ''.join(f'[d{k}]' for k in range(len(tails)))
        fc = ';'.join(chains) + f';[0:a]{mix}amix=inputs={len(tails) + 1}:duration=first:normalize=0:dropout_transition=0[a]'
        dst = Path(out) if out else tmpd / 'episode.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *inputs, '-filter_complex', fc, '-map', '0:v', '-map', '[a]',
                        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(dst)], check=True)
        if abs(_dur(dst) - _dur(video)) > 0.2:
            raise RuntimeError(f'L컷 결과 길이가 다르다 {_dur(dst)} vs {_dur(video)}')
        if not out:
            dst.replace(video)
        return {'cuts': len(tails), 'out': str(out or video)}
    finally:
        import shutil
        shutil.rmtree(tmpd, ignore_errors=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    a = sys.argv[1:]
    sec = float(a[a.index('--sec') + 1]) if '--sec' in a else 0.4
    o = a[a.index('--out') + 1] if '--out' in a else None
    if '--plan' in a:
        for c in plan(a[0], sec):
            print(c)
    else:
        print(json.dumps(apply(a[0], sec, o), ensure_ascii=False))
