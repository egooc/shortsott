# -*- coding: utf-8 -*-
"""무음 갭 검사(규칙집 E4) — 본문 중 −40 dBFS 이하가 0.35초 이상 이어지면 FAIL.

    python scripts/silence_gap.py <영상·음성> [--db -40] [--min 0.35] [--edge 0.5] [--allow 120-125 --allow end:6] [--json]

- ffmpeg silencedetect 로 잰다(영상은 소리만 읽는다).
- 시작·끝 --edge 초(기본 0.5)는 뺀다(E4). 엔드카드·의도적 페이드는 --allow 로 뺀다:
  «a-b»(초) · «end:N»(끝 N초) · «start:N»(처음 N초). 여러 번 줄 수 있다.
- 갭이 하나라도 있으면 종료 코드 4, 없으면 0. 시각 목록은 «분:초».
왜: TTS 레인에서 문장 사이·인용 사이가 벌어지면 시청 이탈 지점이 된다(전자책 08 p21, 정치·쇼핑·어랍숏 공용).
"""
import argparse
import json
import re
import subprocess
import sys


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def detect(path, db=-40.0, mn=0.35):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-vn', '-af',
                        'silencedetect=noise=%sdB:d=%s' % (db, mn), '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    out, start = [], None
    for ln in r.stderr.splitlines():
        m = re.search(r'silence_start: (-?[\d.]+)', ln)
        if m:
            start = max(0.0, float(m.group(1)))
        m = re.search(r'silence_end: ([\d.]+)', ln)
        if m and start is not None:
            out.append((start, float(m.group(1))))
            start = None
    if start is not None:  # 파일 끝까지 무음
        out.append((start, None))
    return out


def parse_allow(items, total):
    rng = []
    for a in items or []:
        if a.startswith('end:'):
            rng.append((total - float(a[4:]), total))
        elif a.startswith('start:'):
            rng.append((0.0, float(a[6:])))
        else:
            x, _, y = a.partition('-')
            rng.append((float(x), float(y)))
    return rng


def gaps(silences, total, edge=0.5, allow=(), mn=0.35):
    """빼는 구간을 잘라 낸 뒤에도 mn 초 이상 남는 무음만."""
    cut = [(0.0, edge), (total - edge, total)] + list(allow)
    out = []
    for s, e in silences:
        e = total if e is None else e
        pieces = [(s, e)]
        for a, b in cut:
            nxt = []
            for x, y in pieces:
                if b <= x or a >= y:
                    nxt.append((x, y))
                    continue
                if x < a:
                    nxt.append((x, a))
                if b < y:
                    nxt.append((b, y))
            pieces = nxt
        out += [(x, y) for x, y in pieces if y - x >= mn]
    return out


def mmss(t):
    return '%d:%05.2f' % (int(t // 60), t % 60)


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='무음 갭 검사(E4)')
    ap.add_argument('path')
    ap.add_argument('--db', type=float, default=-40.0)
    ap.add_argument('--min', type=float, default=0.35)
    ap.add_argument('--edge', type=float, default=0.5)
    ap.add_argument('--allow', action='append', default=[])
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    total = duration(a.path)
    found = gaps(detect(a.path, a.db, a.min), total, a.edge, parse_allow(a.allow, total), a.min)
    if a.json:
        print(json.dumps({'ok': not found, 'total': round(total, 2),
                          'gaps': [{'start': round(x, 2), 'end': round(y, 2), 'sec': round(y - x, 2)} for x, y in found]},
                         ensure_ascii=False, indent=2))
    else:
        for x, y in found:
            print('FAIL 무음 %s ~ %s (%.2f초)' % (mmss(x), mmss(y), y - x))
        print('%s — 길이 %s, 무음 갭 %d개(%.0f dBFS 이하 %.2f초+, 앞뒤 %.1f초·허용 구간 제외)'
              % ('PASS' if not found else 'FAIL', mmss(total), len(found), a.db, a.min, a.edge))
    return 4 if found else 0


if __name__ == '__main__':
    sys.exit(main())
