# -*- coding: utf-8 -*-
"""戦国なぜ 소재 은행 만들기 — GPT 검증 결과(verify/out*.txt)를 모아 출처 URL 을 실제로 열어 본 뒤 bank.json 으로.

    python reference/ja/sengoku-naze/build_bank.py [--no-fetch]

- keep=true 이고 열리는 출처(HTTP 200·리다이렉트 끝 200)가 1개 이상인 것만 은행에 넣는다.
- 순서: punch 높은 순 → confidence high 먼저 → 후보 번호.
- URL 확인 결과는 verify/url_status.json 에 캐시(다시 돌릴 때 안 연다). 요청 간격 0.5초, 429/403 은 그대로 기록하고 넘어간다.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import candidates as C  # noqa: E402

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'


def results():
    out = {}
    for f in sorted((HERE / 'verify').glob('out*.txt')):
        t = f.read_text(encoding='utf-8')
        if '[' not in t:  # 아직 도는 중이거나 실패한 묶음
            continue
        for r in json.loads(t[t.find('['):t.rfind(']') + 1]):
            out[r['idx']] = r
    return out


def fetch(url):
    url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ja'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # noqa — 일부 관공서는 파이썬이 중간 인증서를 못 읽는다 → curl 로 다시
        try:
            r = subprocess.run(['curl', '-s', '-o', os.devnull, '-L', '-m', '20', '-A', UA, '-w', '%{http_code}', url],
                               capture_output=True, text=True, timeout=30)
            code = r.stdout.strip()
            return int(code) if code.isdigit() and code != '000' else 'ERR ' + type(e).__name__
        except Exception:  # noqa
            return 'ERR ' + type(e).__name__


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-fetch', action='store_true')
    a = ap.parse_args()
    cands = C.C + getattr(C, 'C2', [])
    res = results()
    cache_p = HERE / 'verify' / 'url_status.json'
    cache = json.loads(cache_p.read_text(encoding='utf-8')) if cache_p.exists() else {}
    cache = {u: v for u, v in cache.items() if v == 200 or isinstance(v, int)}  # ERR 는 다시 연다
    bank, dropped = [], []
    for idx, r in sorted(res.items()):
        if not r.get('keep'):
            continue
        ok = []
        for s in r.get('sources', []):
            u = s.get('url', '')
            if not re.match(r'https?://', u):
                continue
            if u not in cache and not a.no_fetch:
                cache[u] = fetch(u)
                time.sleep(0.5)
            if cache.get(u) == 200:
                ok.append(s)
        cat, scene, q = cands[idx]
        row = {'idx': idx, 'category': cat, 'scene': scene, 'title': q, 'hook': r.get('hook', ''),
               'answer': r.get('answer', ''), 'period': r.get('period', ''), 'confidence': r.get('confidence', ''),
               'punch': r.get('punch', 0), 'sources': ok,
               'sources_unreachable': [s for s in r.get('sources', []) if s not in ok]}
        (bank if ok else dropped).append(row)
    cache_p.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    rank = {'high': 0, 'mid': 1, 'low': 2}
    bank.sort(key=lambda b: (-int(b['punch'] or 0), rank.get(b['confidence'], 3), b['idx']))
    for i, b in enumerate(bank, 1):
        b['rank'] = i
    (HERE / 'bank.json').write_text(json.dumps({
        'version': 'v1-20261016', 'angle': '時代劇でよく見る○○、実際は?',
        'note': 'GPT(웹 검색) 검증 + 출처 URL 실제 열림(200) 확인. 歴史リワインド 50편 주제는 검증 단계에서 제외. 원고 쓸 때 출처 원문을 다시 읽을 것.',
        'count': len(bank), 'items': bank, 'dropped_unreachable': dropped}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    bad = {u: s for u, s in cache.items() if s != 200}
    print('은행 %d개 · 출처 안 열려 빠짐 %d개 · 안 열린 URL %d/%d' % (len(bank), len(dropped), len(bad), len(cache)))
    for u, s in list(bad.items())[:30]:
        print('  %s %s' % (s, u))


if __name__ == '__main__':
    main()
