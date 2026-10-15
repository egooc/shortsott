"""소재 준비 — 공식 영상 하나에서 «쓸 만한 구간»을 사람이 고르기 좋게 펼쳐 놓는다.

    python scout_source.py <youtube id> [--windows 3] [--pad 25]

D:/volcano-runs/fantube/src/<id>/ 에:
  v.mp4 · v.info.json           원본(1080p avc1)과 메타
  peaks.json                    다시보기(heatmap) 정점 구간들(겹치면 합침, 앞뒤 pad 초)
  tr_<a>_<b>.json               구간 받아쓰기(Speechmatics, rinbox_transcribe.py)
  sheet_<a>.jpg                 구간 장면 묶음(1초 간격, 시각 표기)
  subs_<a>.jpg                  구간 원본 자막 띠 묶음(1초 간격) — 자막 문안·화자 이름표를 여기서 읽는다
heatmap 이 없으면 영상 전체를 4등분해 앞 3구간을 쓴다.
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path('D:/volcano-runs/fantube/src')


def frame(src, t, w, h, vf=''):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(src), '-frames:v', '1',
                          '-vf', (vf + ',' if vf else '') + f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                         capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3).copy() if len(raw) == w * h * 3 else np.zeros((h, w, 3), np.uint8)


def label(im, s):
    cv2.putText(im, s, (3, 18), cv2.FONT_HERSHEY_SIMPLEX, .55, (0, 255, 255), 2)
    return im


def main(vid, n_win=3, pad=25):
    d = ROOT / vid
    d.mkdir(parents=True, exist_ok=True)
    mp4 = d / 'v.mp4'
    if not mp4.exists():
        subprocess.run(['yt-dlp', '-q', '-f', 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]', '--merge-output-format', 'mp4',
                        '--write-info-json', '-o', str(d / 'v.%(ext)s'), f'https://www.youtube.com/watch?v={vid}'], check=True)
    info = json.loads((d / 'v.info.json').read_text(encoding='utf-8'))
    dur = float(info.get('duration') or 0)
    heat = sorted(info.get('heatmap') or [], key=lambda x: -x['value'])
    wins = []
    for h in heat:
        if h['start_time'] < 20:                   # 첫 20초(오프닝·제목)는 정점이어도 뺀다
            continue
        a, b = max(0, h['start_time'] - pad), min(dur, h['end_time'] + pad)
        for w in wins:
            if a <= w[1] and b >= w[0]:
                w[0], w[1] = min(w[0], a), max(w[1], b)
                break
        else:
            wins.append([a, b])
        if len(wins) >= n_win:
            break
    if not wins:
        q = dur / 4
        wins = [[q * k, q * k + 60] for k in range(n_win)]
    wins = [[round(a, 1), round(b, 1)] for a, b in sorted(wins)]
    (d / 'peaks.json').write_text(json.dumps({'title': info.get('title'), 'duration': dur, 'windows': wins}, ensure_ascii=False) + '\n',
                                  encoding='utf-8')
    for a, b in wins:
        tr = d / f'tr_{int(a)}_{int(b)}.json'
        if not tr.exists():
            subprocess.run([sys.executable, '-X', 'utf8', 'D:/midform/scripts/rinbox_transcribe.py', str(mp4), str(tr), '--lang', 'ko',
                            '--from', f'{a:.1f}', '--to', f'{b:.1f}'], capture_output=True, env={**__import__('os').environ, 'PYTHONIOENCODING': 'utf-8'})
        ts = np.arange(a, b, 1.0)
        tiles = [label(frame(mp4, t, 240, 135), f'{t:.0f}') for t in ts]
        while len(tiles) % 8:
            tiles.append(np.zeros((135, 240, 3), np.uint8))
        cv2.imwrite(str(d / f'sheet_{int(a)}.jpg'), np.vstack([np.hstack(tiles[k:k + 8]) for k in range(0, len(tiles), 8)]))
        strips = [label(frame(mp4, t + .4, 640, 60, 'crop=1500:140:210:880'), f'{t:.0f}') for t in ts]
        if len(strips) % 2:
            strips.append(np.zeros((60, 640, 3), np.uint8))
        cv2.imwrite(str(d / f'subs_{int(a)}.jpg'), np.vstack([np.hstack(strips[k:k + 2]) for k in range(0, len(strips), 2)]))
        print('구간', a, b, tr.exists())
    print(json.dumps(wins))


if __name__ == '__main__':
    a = sys.argv
    main(a[1], int(a[a.index('--windows') + 1]) if '--windows' in a else 3, float(a[a.index('--pad') + 1]) if '--pad' in a else 25)
