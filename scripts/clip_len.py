# -*- coding: utf-8 -*-
"""완성본 컷 길이 — 편마다 «한 번에 이어지는 원본 클립»이 얼마나 긴지(devo 칼럼 V6, 10-20 관리자). 임계는 §5 60 소유주 결정 전이라 재기만 한다.

    python scripts/clip_len.py <완성본.mp4> [...] [--th 0.30] [--long 3.0] [--crop crop=w:h:x:y] [--json out]

ffmpeg scene 점수(select=gt(scene,th))로 컷을 찾고, 컷 사이 길이를 잰다. 자막·글자 덮개는 장면 점수를 거의 안 바꾸므로 컷으로 안 잡힌다.
천천히 미는 카메라·디졸브는 컷으로 안 잡혀 한 클립으로 길게 나올 수 있다(그 편은 눈으로 확인).
결과: 편별 {cuts, clips, longest_sec, longest_at, over_long(3초 초과 클립 수), mean_sec} — 제작 장부 열(clip_longest·clip_over3)로 옮길 수 있는 꼴.
종료: 0 · 5 = 검사 불가(파일 없음·ffmpeg 실패, gate_errors.jsonl).
"""
import datetime as _dt
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'


def duration(p):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())


# 틀이 있는 렌더(위 제목 띠·아래 자막 띠·검은 판)는 화면 대부분이 고정이라 장면 점수가 안 오른다 → 그림 창만 잘라 본다.
# 린박스 rinbox_render PIC_Y0~Y1 = 450~1470(rinbox-publish frameDup 과 같은 창). 파일 이름에 rinbox 가 있으면 자동.
CROP = {'rinbox': 'crop=1080:1020:0:450'}


def cuts(p, th=0.30, crop=None):
    vf = (crop + ',' if crop else '') + f"select='gt(scene,{th})',showinfo"
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(p), '-an', '-vf', vf, '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    return [float(m) for m in re.findall(r'pts_time:([\d.]+)', r.stderr)]


def measure(p, th=0.30, long=3.0, crop=None):
    dur = duration(p)
    crop = crop or next((v for k, v in CROP.items() if k in Path(p).name), None)
    cs = [c for c in cuts(p, th, crop) if 0.05 < c < dur - 0.05]
    edges = [0.0] + cs + [dur]
    clips = [round(b - a, 2) for a, b in zip(edges, edges[1:]) if b - a > 0.04]
    i = max(range(len(clips)), key=lambda k: clips[k])
    return {'file': str(p), 'crop': crop, 'duration': round(dur, 2), 'cuts': len(cs), 'clips': len(clips), 'longest_sec': clips[i],
            'longest_at': round(edges[i], 2), 'over_long': sum(1 for c in clips if c > long), 'long_th': long,
            'mean_sec': round(sum(clips) / len(clips), 2), 'clip_secs': clips}


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
    skip = {i + 1 for i, a in enumerate(argv) if a in ('--th', '--long', '--json', '--crop')}
    files = [a for i, a in enumerate(argv) if i not in skip and not a.startswith('--')]
    th, long = float(opt('--th', 0.30)), float(opt('--long', 3.0))
    res, code = [], 0
    for f in files:
        try:
            r = measure(f, th, long, opt('--crop'))
        except (OSError, ValueError, RuntimeError) as e:
            print(f'⚠ 컷 길이 측정 불가: {f} — {str(e)[:120]}')
            try:
                with LEDGER.open('a', encoding='utf-8') as fh:
                    fh.write(json.dumps({'at': _dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'gate': 'clip_len', 'script': f,
                                         'error': str(e)[:200]}, ensure_ascii=False) + '\n')
            except OSError:
                pass
            code = 5
            continue
        res.append(r)
        print(f'{Path(f).name} · {r["duration"]}초 · 컷 {r["cuts"]} · 클립 {r["clips"]}(평균 {r["mean_sec"]}초) · 최장 {r["longest_sec"]}초(@{r["longest_at"]}초) · {long:g}초 초과 {r["over_long"]}개')
    if opt('--json'):
        Path(opt('--json')).write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return code


if __name__ == '__main__':
    sys.exit(main())
