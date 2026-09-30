# -*- coding: utf-8 -*-
"""설명문 첫 줄에서 작품명을 뽑는다 — 채널이 대놓고 적어 주는 경우.

    python scripts/titles_from_desc.py            뽑아서 보여준다
    python scripts/titles_from_desc.py --apply    바로 확정한다

왜 (2026-09-29)
  원고를 듣고 읽어서 제목을 다는 데 시간이 다 갔는데, **대한숏·헛개리카노는 설명문에
  작품명을 그대로 적어 두고 있었다.**
  ```
  《불릿 트레인》 (Bullet Train, 2022) 감독: 데이비드 리치 …
  《트루먼 쇼》 (The Truman Show, 1998) 감독: 피터 위어 …
  ```
  `rival-films.js` 가 이미 같은 일을 했지만(사례 105) 다른 형식만 알았고,
  나는 그 사실을 알면서도 새 수확기에 안 옮겼다. 93편을 헛되이 듣고 읽고 있었다.

★여기서 나온 것은 **채널이 직접 적은 값**이라 댓글보다 훨씬 믿을 만하다.
  그래도 형식이 안 맞으면 건너뛴다 — 억지로 짜내면 엉뚱한 것이 들어간다.
"""
import argparse
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'server', 'data', 'narration_probe.json')

# 《한국어 제목》 (English Title, 2022)  ·  《제목 시즌 7 13화: 부제》 (Show S7 E13, 2025)
PAT = re.compile(r'[《〈「](?P<ko>[^》〉」]{1,60})[》〉」]\s*[（(]\s*(?P<en>[^,()）]{1,80}?)\s*,?\s*(?P<year>(19|20)\d{2})?\s*[)）]')


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def parse(desc):
    m = PAT.search((desc or '').replace('\n', ' '))
    if not m:
        return None
    ko = m.group('ko').strip()
    en = re.sub(r'\s+', ' ', m.group('en')).strip(' ,“”"')
    # 「Show Season 7 Episode 13, "Three Billboards"」 처럼 화수가 붙으면 시리즈명만 남긴다
    en = re.split(r'\s+Season\s+\d|\s+S\d+\s*E\d+|\s+Episode\s+\d', en, 1)[0].strip()
    ko = re.split(r'\s*시즌\s*\d|\s*\d+화', ko, 1)[0].strip()
    if len(en) < 2 or len(ko) < 1:
        return None
    return ko, en, m.group('year') or ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    store = read_json(STORE, {})
    hits, miss = [], []
    for vid, r in store.items():
        if r.get('film_en'):
            continue
        got = parse(r.get('desc'))
        (hits if got else miss).append((vid, r, got))

    by_channel = {}
    for vid, r, got in hits:
        by_channel.setdefault(r['channel'], 0)
        by_channel[r['channel']] += 1
    print(f'미확정 {len(hits) + len(miss)}편 · 설명문에서 제목이 나온 것 {len(hits)}편')
    for ch, n in sorted(by_channel.items(), key=lambda kv: -kv[1]):
        print(f'   {ch[:22]:24} {n}편')

    for vid, r, got in hits[:14]:
        ko, en, year = got
        print(f'  {vid}  {en[:40]:42} {ko[:20]:22} {year}')
    if len(hits) > 14:
        print(f'  … 외 {len(hits) - 14}편')

    if not args.apply:
        print('\n계산만 · 확정하려면 --apply')
        return 0

    for vid, r, got in hits:
        ko, en, year = got
        store[vid].update({'film_en': en, 'film_ko': ko, 'year': year,
                           'title_source': 'description'})
    with io.open(STORE, 'w', encoding='utf-8') as fh:
        json.dump(store, fh, ensure_ascii=False, indent=2)
    print(f'\n{len(hits)}편 확정 (출처: 채널 설명문)')
    print('★whitelist_works.json 을 다시 지으려면:')
    print('   python scripts/whitelist_from_narration.py --commit <빈 tsv>  또는 --report')
    return 0


if __name__ == '__main__':
    sys.exit(main())
