# -*- coding: utf-8 -*-
"""제목 키워드 관문 입력 — 유튜브 자동완성(실제 검색어)을 씨앗 낱말마다 받아 편 폴더 keyword_suggest.json 에 둔다.
소유주 10-24: «터진 레퍼런스 확인하고 들어갈 때 제목에 키워드를 잘 묻혀야 돼, 알고리즘하고는 별개로, 제목이랑 해시태그에».

    python -X utf8 monetize-longform/tools/kw_suggest.py <편 폴더> "씨앗1" "씨앗2" ...   (씨앗 없으면 keywords.json·packages.json keywords)
gates.py package 가 이 파일을 읽어: 포장 묶음마다 제목에 검색어 2개 이상, 해시태그에 2개 이상(공백 무시) 없으면 FAIL.
API 키 없음 — suggestqueries(ds=yt) 공개 주소, 1초 간격. 실패하면 소리 내고 종료 5.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


def suggest(q):
    u = 'https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ko&q=' + urllib.parse.quote(q)
    with urllib.request.urlopen(u, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))[1]


def main():
    a = sys.argv[1:]
    if not a or a[0] in ('-h', '--help'):
        print(__doc__.strip())
        return 5
    ep = Path(a[0])
    seeds = a[1:]
    if not seeds:
        pk = json.loads((ep / 'packages.json').read_text(encoding='utf-8')) if (ep / 'packages.json').exists() else {}
        seeds = list(pk.get('keywords') or [])
    if not seeds:
        print('씨앗 낱말 없음')
        return 5
    rows, err = [], []
    for s in seeds:
        try:
            got = suggest(s)
            rows.append({'seed': s, 'suggest': got[:8]})
        except Exception as e:  # noqa: BLE001
            err.append(f'{s}: {e}')
        time.sleep(1.1)
    if not rows:
        print('자동완성 전부 실패:', err)
        return 5
    phrases = list(dict.fromkeys([s for r in rows for s in [r['seed']] + r['suggest']]))
    out = {'at': time.strftime('%Y-%m-%d %H:%M'), 'source': 'youtube suggestqueries ds=yt hl=ko', 'seeds': seeds, 'rows': rows, 'phrases': phrases, 'errors': err}
    (ep / 'keyword_suggest.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{ep.name}: 씨앗 {len(seeds)} · 검색어 {len(phrases)} → keyword_suggest.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
