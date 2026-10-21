# -*- coding: utf-8 -*-
"""전문 용어 풀이 두 출처 교차 확인 관문(G23, 관리자 10-21) — 10/23편부터.

    python politics-hour/jargon_gate.py <에피소드 폴더> [upload.json …]

제목(upload.json·packages.json 묶음)에 jargon.json 낱말이 있으면 jargon_sources.json 에 그 낱말의 풀이와
서로 다른 도메인 출처 2곳 이상(url·says)이 있어야 한다. 풀이 문구 자체는 공용 title_check 가 본다.
"""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

FROM = '20261023'
ROOT = Path(__file__).resolve().parent


def titles(ep, uploads=()):
    out = []
    for up in [*uploads, ep / 'upload.json']:
        try:
            out.append(json.loads(Path(up).read_text(encoding='utf-8')).get('title') or '')
        except Exception:
            pass
    try:
        out += [p.get('title') or '' for p in json.loads((ep / 'packages.json').read_text(encoding='utf-8')).get('packages', [])]
    except Exception:
        pass
    return [t for t in out if t]


def gate_lines(ep, uploads=()):
    ep = Path(ep)
    sys.path.insert(0, str(ROOT))
    import candidate_gate
    if candidate_gate.ep_date(ep, uploads) < FROM:
        return []
    jargon = {k: v for k, v in json.loads((ROOT / 'jargon.json').read_text(encoding='utf-8')).items() if not k.startswith('_')}
    rec = json.loads((ROOT / 'jargon_sources.json').read_text(encoding='utf-8'))
    bad = []
    for t in titles(ep, uploads):
        for w in jargon:
            if w not in t or any(w != x and w in x and x in t for x in jargon):
                continue
            r = rec.get(w) or {}
            doms = {urlparse(s.get('url', '')).netloc.removeprefix('www.') for s in r.get('sources', []) if s.get('url') and str(s.get('says', '')).strip()}
            doms.discard('')
            if not str(r.get('gloss', '')).strip() or len(doms) < 2:
                bad.append(f'전문 용어 «{w}»(제목 «{t[:30]}…»): jargon_sources.json 에 풀이+서로 다른 출처 2곳(url·says) 기록 없음 — 지금 {len(doms)}곳')
    return sorted(set(bad))


if __name__ == '__main__':
    bad = gate_lines(Path(sys.argv[1]).resolve(), sys.argv[2:])
    for b in bad:
        print('[jargon] FAIL', b)
    sys.exit(3 if bad else 0)
