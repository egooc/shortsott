# 롱투숏 해설 밑 깔개 — 원본에서 내레이터 목소리만 뺀 소리(현장음·배경음악)를 해설 조각 밑에 깐다.
#
#   python scripts/longshort_bed.py <plan.json> <no_vocals.wav> [--gain -14] [--out ...]
#
# 왜 (2026-10-13 소유주): 해외 소스는 영어 내레이션을 빼고 한국어 해설로 끄는데, 그러면 해설 구간엔 원본 소리가 0이다.
#   «나레이션 줄이고 바깥 사운드 키우고 이런 건 안 돼?» → Demucs(D:/midform/.venv-sep, htdemucs --two-stems vocals)로
#   목소리와 나머지를 갈라 나머지를 깐다. 렌더러(longshort_render → rinbox_render)는 건드리지 않고 완성본 위에 덧입힌다.
#   조각 지도는 _render/pieces.json(결과 몇 프레임째 = 원본 몇 초)을 쓴다. 원음 컷 조각은 이미 원음이라 깔지 않는다.
# ★깔개에 배경음악이 섞여 있으면 Content ID 대상이 될 수 있다 — 발행 전 소유주 확인.
import argparse, json, subprocess, sys
from pathlib import Path


def run(cmd):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode:
        sys.exit('명령 실패: %s\n%s' % (' '.join(str(c) for c in cmd)[:300], r.stderr[-1500:]))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan'); ap.add_argument('bed')
    ap.add_argument('--gain', type=float, default=-3.0, help='해설 밑 깔개 음량(dB, 원 스템 기준)')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    work = Path(a.plan).resolve().parent / '_render'
    pj = json.loads((work / 'pieces.json').read_text(encoding='utf-8'))
    fps = pj['fps']
    final = work / 'final.mp4'
    out = Path(a.out) if a.out else work / 'final_bed.mp4'
    nars = [p for p in pj['pieces'] if p['kind'] == 'nar']
    if not nars:
        sys.exit('해설 조각이 없다')
    # 해설 조각마다 원본 같은 자리의 깔개를 잘라 결과 시각에 맞춰 놓는다(앞뒤 0.15초 페이드)
    ins, parts = ['-i', final], []
    for k, p in enumerate(nars):
        d = p['frames'] / fps
        ins += ['-ss', '%.3f' % p['src_t0'], '-t', '%.3f' % d, '-i', a.bed]
        parts.append('[%d:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=%.1fdB,'
                     'afade=t=in:d=0.15,afade=t=out:st=%.3f:d=0.15,adelay=%d|%d[b%d]'
                     % (k + 1, a.gain, max(0, d - .15), round(p['out_f0'] / fps * 1000), round(p['out_f0'] / fps * 1000), k))
    fc = (';'.join(parts) + ';' + ''.join('[b%d]' % k for k in range(len(nars)))
          + 'amix=inputs=%d:normalize=0[bed];[0:a][bed]amix=inputs=2:normalize=0:duration=first,'
            'loudnorm=I=-16:TP=-1.5:LRA=11[a]' % len(nars))
    run(['ffmpeg', '-loglevel', 'error', '-y', *ins, '-filter_complex', fc, '-map', '0:v', '-map', '[a]',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out])
    print('깔개 %d곳 → %s' % (len(nars), out))


if __name__ == '__main__':
    main()
