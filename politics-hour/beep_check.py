"""렌더 뒤 삐 확인(소유주 10-27 결정, 관리자 경유) — after_render 흐름·upload_gate 에서 부른다.

    python beep_check.py <ep폴더>        하나라도 어긋나면 종료 4

1) work/beep_log.json 의 삐 구간마다 최종 work/episode.mp4 의 그 시각 음성에서 1kHz(950~1050Hz) 대역이
   전체 에너지의 RATIO 이상인지 FFT 로 본다. 시각 = concat.txt 조각 길이 누적(L컷·음량 정규화는 시각을 안 바꾼다) + 조각 안 시각.
2) 지금 profanity.json 으로 전사(transcripts/)를 다시 훑어, 인용 구간에 욕설 토큰이 있는데 beep_log 에 없으면 실패.
   L컷 꼬리(episode.json "lcut", 인용 out 뒤 원음이 다음 조각 첫머리에 깔린다) 구간의 욕설 토큰도 실패.
3) 인용·콜드 조각의 전사 파일이 없으면 검사 불가 → 실패.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'overlay'))
sys.path.insert(0, str(HERE))
import beep  # noqa: E402
import profanity  # noqa: E402

RATIO = .6
BAND = (950, 1050)
SR = 48000


def _dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout)


def tone_ratio(mp4, t0, t1):
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{t0:.3f}', '-t', f'{t1 - t0:.3f}', '-i', str(mp4), '-vn',
                        '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True)
    x = np.frombuffer(r.stdout, dtype=np.float32)
    if x.size < SR * .03:
        return None
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    f = np.fft.rfftfreq(x.size, 1 / SR)
    total = spec[(f >= 50) & (f <= 16000)].sum()
    return float(spec[(f >= BAND[0]) & (f <= BAND[1])].sum() / total) if total > 0 else 0.0


def check(ep):
    ep = Path(ep)
    E = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    segs = E['segments']
    work = (ep / E.get('workdir', 'work')).resolve()
    mp4, logp, cat = work / 'episode.mp4', work / 'beep_log.json', work / 'concat.txt'
    bad, notes = [], []
    expected = beep.plan(ep, segs)
    if not logp.exists():
        need = [x for x in expected if x['beeps'] or not x['transcript']]
        if need:
            bad.append(f'work/beep_log.json 없음 — 삐 처리 전에 렌더된 편인데 처리할 조각 {len(need)}개: '
                       + '; '.join(f'[{x["seg"]}] {[b["word"] for b in x["beeps"]] or "전사 없음"}' for x in need))
        else:
            notes.append('beep_log.json 없음(삐 처리 전 렌더) — 전사에 욕설 토큰 없음')
        logged = []
    else:
        logged = json.loads(logp.read_text(encoding='utf-8')).get('segments', [])
    parts = [Path(l.split("'")[1]) for l in cat.read_text(encoding='utf-8').splitlines() if l.strip()] if cat.exists() else []
    if len(parts) != len(segs):
        bad.append(f'concat.txt 조각 {len(parts)}개 ≠ episode.json {len(segs)}개 — 시각을 잴 수 없음(다시 렌더)')
        return bad, notes
    starts, t = [], 0.0
    for p in parts:
        starts.append(t)
        t += _dur(p)
    # 1) 기록된 삐가 최종본에 있는가
    for x in logged:
        for b in x['beeps']:
            a0 = starts[x['seg']] + b['local0']
            a1 = starts[x['seg']] + b['local1']
            m = min(.06, (a1 - a0) / 4)
            r = tone_ratio(mp4, a0 + m, a1 - m)
            line = f'[{x["seg"]}] «{b["word"]}» {a0:.2f}~{a1:.2f}초(조각 안 {b["local0"]:.2f}~{b["local1"]:.2f}) 1kHz 비율 {r if r is None else round(r, 2)}'
            (notes if r is not None and r >= RATIO else bad).append(line + ('' if r is not None and r >= RATIO else f' — {RATIO} 미만, 삐 없음'))
    # 2) 전사에 욕설이 있는데 기록에 없는가 · 3) 전사 없음
    have = {(x['seg'], round(b['local0'], 2)) for x in logged for b in x['beeps']}
    for x in expected:
        if not x['transcript']:
            bad.append(f'[{x["seg"]}] {x["type"]} {x["src"]} 전사 파일 없음(transcripts/{Path(x["src"]).stem}.json) — 욕설 검사 불가')
        for b in x['beeps']:
            if (x['seg'], round(b['local0'], 2)) not in have:
                bad.append(f'[{x["seg"]}] 전사 욕설 «{b["word"]}»(src {b["src0"]:.2f}초)가 beep_log 에 없음 — 삐 없이 나감')
    lc = float(E.get('lcut') or 0)
    for i, s in enumerate(segs[:-1]):
        if lc and s['type'] == 'quote' and segs[i + 1]['type'] != 'cold':
            toks = profanity.load_transcript(ep, s['src'])
            for a, b, w in (profanity.token_hits(toks, s['out'], s['out'] + lc) if toks else []):
                if a >= s['out'] - .001:
                    bad.append(f'[{i}] L컷 꼬리({lc}초)에 욕설 «{w}»(src {a:.2f}초) — out 을 앞당겨라')
    return bad, notes


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1])
    if not ep.exists():
        ep = HERE / 'episodes' / sys.argv[1]
    bad, notes = check(ep)
    for n in notes:
        print('[삐] 확인', n)
    for b in bad:
        print('[삐] FAIL', b)
    print('[삐]', 'PASS' if not bad else f'{len(bad)}건 실패', ep.name)
    sys.exit(4 if bad else 0)
