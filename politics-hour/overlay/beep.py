"""원음 인용 속 욕설 삐 처리(소유주 10-27 결정, 관리자 경유) — assemble_hour.py 가 부른다.

낱말 시각 = 그 발췌의 Speechmatics 전사(편 폴더 transcripts/<src 이름>.json, [[start, end, word], ...], src 기준 초).
quote·cold 조각의 [in, out] 과 겹치는 욕설 토큰(politics-hour/profanity.json scope all)을 앞뒤 PAD 만큼 넓혀
원음을 끄고 1kHz 사인으로 바꾼다. 자막(phrases·words)은 profanity.mask 로 «xx».
처리한 구간은 work/beep_log.json 에 조각 번호·조각 안 시각·src 시각으로 남는다(렌더 뒤 beep_check.py 가 최종 mp4 에서 확인).
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import profanity  # noqa: E402

FREQ = 1000
PAD = .05
GAIN = .3   # 사인 크기(조각 loudnorm 전), 원음은 그 구간 0


def seg_intervals(ep_dir, seg):
    """조각 하나의 삐 구간 [{local0, local1, src0, src1, word}] 과 전사 유무."""
    if seg['type'] not in ('quote', 'cold'):
        return [], True
    toks = profanity.load_transcript(ep_dir, seg['src'])
    if toks is None:
        return [], False
    d = seg['out'] - seg['in']
    out = []
    for a, b, w in profanity.token_hits(toks, seg['in'], seg['out']):
        l0, l1 = max(0.0, a - seg['in'] - PAD), min(d, b - seg['in'] + PAD)
        if l1 - l0 > .02:
            out.append({'local0': round(l0, 3), 'local1': round(l1, 3), 'src0': a, 'src1': b, 'word': w})
    return out, True


def masked(seg):
    """자막 가림 — 바뀐 게 있으면 새 조각 dict, 없으면 그대로."""
    if seg['type'] == 'quote' and seg.get('phrases'):
        ph = [profanity.mask(p) for p in seg['phrases']]
        if ph != seg['phrases']:
            return dict(seg, phrases=ph)
    if seg['type'] == 'cold' and seg.get('words'):
        ws = [[w[0], profanity.mask(w[1]), *w[2:]] for w in seg['words']]
        if ws != seg['words']:
            return dict(seg, words=ws)
    return seg


def plan(ep_dir, segments):
    """episode.json 조각 전부 → beep_log 항목 목록."""
    log = []
    for i, s in enumerate(segments):
        if s['type'] not in ('quote', 'cold'):
            continue
        iv, has = seg_intervals(ep_dir, s)
        m = masked(s)
        entry = {'seg': i, 'type': s['type'], 'src': s['src'], 'in': s['in'], 'out': s['out'], 'transcript': has, 'beeps': iv}
        if m is not s:
            entry['masked'] = m.get('phrases') or [w[1] for w in m.get('words', [])]
        if iv or m is not s or not has:
            log.append(entry)
    return log


def apply(raw, intervals, out):
    """raw 조각(mp4)의 소리에서 intervals(조각 안 초) 구간만 원음을 끄고 1kHz 사인을 깐다. 영상은 복사."""
    on = '+'.join(f'between(t,{x["local0"]:.3f},{x["local1"]:.3f})' for x in intervals)
    fc = (f'[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=0:enable=\'{on}\'[o];'
          f'[1:a]aformat=channel_layouts=stereo,volume={GAIN},volume=0:enable=\'not({on})\'[s];'
          f'[o][s]amix=inputs=2:duration=first:normalize=0[a]')
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(raw), '-f', 'lavfi', '-i', f'sine=frequency={FREQ}:sample_rate=48000',
                    '-filter_complex', fc, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', str(out)],
                   check=True)
    return out
