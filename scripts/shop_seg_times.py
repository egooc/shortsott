# -*- coding: utf-8 -*-
"""쇼핑 plan.json 문장 → 완성본(_ff.mp4) 자막 시각표. variety_fx 의 segs.json 으로 준다(10-29 예능식 편집 A/C 비교).
cap.ass 만 주면 질문 «?»가 자막에 없어 «?!» 스티커가 빠진다 — 문장 원문(plan)을 붙여야 C판과 같은 결과.
원본: D:/volcano-runs/sfx_test/tools/seg_times.py(도구개발, ffref55 전용)를 작업 폴더 인자로 일반화.

    python -X utf8 scripts/shop_seg_times.py <wd> [--plan plan.json] [--ass cap.ass] [--out <wd>/seg_times.json]
    유튜브에 올라가는 건 _social 판이다(shop_schedule) → --plan plan_social.json --ass <wd>/cap_social.ass --out <wd>/seg_social.json

자막은 <wd>/cap_ff.ass(ff 렌더 직후 떠 둔 사본)를 먼저, 없으면 <wd>/_ff/cap.ass — 다른 판 렌더가 _ff/cap.ass 를 덮으니
_ff 렌더 바로 다음에 돌리거나 사본을 떠 둔다.
"""
import argparse
import json
import re
import sys
from pathlib import Path


def ts(s):
    h, m, x = s.split(':')
    return int(h) * 3600 + int(m) * 60 + float(x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wd')
    ap.add_argument('--plan', default='plan.json')
    ap.add_argument('--out')
    ap.add_argument('--ass', help='자막 파일(유튜브용 _social 판은 <wd>/cap_social.ass)')
    a = ap.parse_args()
    wd = Path(a.wd)
    ass = Path(a.ass) if a.ass else wd / 'cap_ff.ass' if (wd / 'cap_ff.ass').exists() else wd / '_ff' / 'cap.ass'
    caps = []
    for ln in ass.read_text(encoding='utf-8').splitlines():
        if ln.startswith('Dialogue:') and ',Cap,' in ln:
            f = ln.split(',', 9)
            caps.append((ts(f[1]), ts(f[2]), re.sub(r'\{[^}]*\}', '', f[9])))
    norm = lambda s: re.sub(r'[\s"\'.,!?…~()]', '', s)
    plan = json.loads((wd / a.plan).read_text(encoding='utf-8'))
    out, k = [], 0
    for i, s in enumerate(plan['segments']):
        want = norm(re.sub(r'\{([^|}]*)\|[^}]*\}', r'\1', s['text']).replace('/', ''))
        got, chunks = '', []
        while k < len(caps) and len(norm(got)) < len(want):
            got += caps[k][2]
            chunks.append(caps[k])
            k += 1
        if not chunks:
            sys.exit(f'자막이 모자람: 문장 {i} «{s["text"]}» — {ass} 가 이 plan 의 렌더인지 확인')
        out.append({'i': i, 't0': chunks[0][0], 't1': chunks[-1][1], 'text': s['text'], 'chunks': [[x, y, t] for x, y, t in chunks]})
    if k != len(caps):
        print(f'경고: 남은 자막 {len(caps) - k}줄 — 문장·자막 맞춤이 어긋났을 수 있음', file=sys.stderr)
    dst = Path(a.out) if a.out else wd / 'seg_times.json'
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    for o in out:
        print(o['i'], round(o['t0'], 2), round(o['t1'], 2), o['text'])


if __name__ == '__main__':
    main()
