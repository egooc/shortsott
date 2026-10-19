# -*- coding: utf-8 -*-
"""렌더 마지막 단계 음량 정규화(카이안 K12 -14 LUFS, 10-19) — 레인 렌더러가 import 하는 공용 모듈.
2패스 loudnorm(측정 → linear 적용), 영상은 스트림 복사·음성만 AAC 재인코딩이라 몇 초~수십 초.

    python scripts/loudnorm_final.py <in.mp4> [<out.mp4>]          # out 생략 = 제자리 교체

렌더러에서(마지막 mux 직후 한 줄):
    sys.path.insert(0, 'D:/midform/scripts'); import loudnorm_final
    loudnorm_final.normalize(out_path)                    # {'before': -16.3, 'after': -14.0, 'tp': -1.6}

이미 -14±0.5 이고 TP ≤ -1 이면 손대지 않는다. 실패하면 원본을 그대로 두고 예외를 올린다(원본 보존).
업로드 쪽 server/services/uploadLoudnessService.js(허용 ±2)와 목표값이 같다.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TARGET, TP, LRA = -14.0, -1.5, 11
SKIP_TOL = 0.5


def _ff(args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-nostats', *args], capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


def measure(path):
    """loudnorm 1패스 측정값(dict, 문자열 숫자)."""
    r = _ff(['-i', str(path), '-vn', '-af', f'loudnorm=I={TARGET}:TP={TP}:LRA={LRA}:print_format=json', '-f', 'null', '-'])
    m = re.search(r'\{[^{}]*"input_i"[^{}]*\}', r.stderr)
    if not m:
        raise RuntimeError(f'loudnorm 측정 실패: {path}\n{r.stderr[-400:]}')
    return json.loads(m.group(0))


def normalize(src, dst=None, target=TARGET):
    src = Path(src)
    dst = Path(dst) if dst else src
    m = measure(src)
    before, tp = float(m['input_i']), float(m['input_tp'])
    if abs(before - target) <= SKIP_TOL and tp <= -1.0:
        if dst != src:
            dst.write_bytes(src.read_bytes())
        return {'before': before, 'after': before, 'tp': tp, 'skipped': True}
    ln = (f'loudnorm=I={target}:TP={TP}:LRA={LRA}:measured_I={m["input_i"]}:measured_TP={m["input_tp"]}'
          f':measured_LRA={m["input_lra"]}:measured_thresh={m["input_thresh"]}:offset={m["target_offset"]}:linear=true')
    # 원본 피크가 높으면 linear 만으로는 TP 를 못 지키고, AAC 인코딩도 피크를 넘긴다(정치 ko 10/19편 TP -0.2, 10-19 보고).
    # 그래서 TP > -1 이면 48k 로 내린 뒤 리미터(alimiter, 샘플 피크)를 -2.5 → -4 dBFS 로 걸어 다시 만든다.
    tmp = dst.with_name(dst.stem + '.loudnorm_tmp' + dst.suffix)
    best = None
    for lim_db in (None, -2.5, -4.0):
        af = ln + ',aresample=48000' + (f',alimiter=limit={10 ** (lim_db / 20):.4f}:level=disabled' if lim_db else '')
        r = _ff(['-y', '-i', str(src), '-map', '0', '-c:v', 'copy', '-af', af, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
                 '-movflags', '+faststart', str(tmp)])
        if r.returncode != 0 or not tmp.exists():
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f'loudnorm 적용 실패: {src}\n{r.stderr[-400:]}')
        a = measure(tmp)
        got = {'before': before, 'after': float(a['input_i']), 'tp': float(a['input_tp']), 'skipped': False, 'limiter_db': lim_db}
        if best is None or got['tp'] < best['tp']:
            best = got
            os.replace(tmp, dst.with_name(dst.stem + '.loudnorm_best' + dst.suffix))
        tmp.unlink(missing_ok=True)
        if got['tp'] <= -1.0:
            break
    os.replace(dst.with_name(dst.stem + '.loudnorm_best' + dst.suffix), dst)
    return best


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    r = normalize(argv[0], argv[1] if len(argv) > 1 else None)
    print(f'{r["before"]:.1f} → {r["after"]:.1f} LUFS · TP {r["tp"]:.1f}' + (' (그대로)' if r['skipped'] else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
