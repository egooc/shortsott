# -*- coding: utf-8 -*-
"""GPT v2 원고 표(| # | 시작초 | 길이초 | 배경 | 흑백 | 연도·장소 | 말하는.표정 | 이름표 | 대사 | 색 | 반응.표정 | 반응 대사 |) → beats.json.

    python -X utf8 ko-corp/cat/table_to_beats.py ko-corp/cat01 research/a3_v2.md

옛 beats.json 은 beats_v1.json 으로 한 번만 보관한다. bgm·pinned_comment 는 옛 것을 이어 쓴다.
«반응» 칸의 «등장:튀어나옴(x)» → 말하는 고양이 enter(아래에서 튀어나옴) + 효과음 boing. 대사 «—» = 표정 컷인.
"""
import json
import re
import sys
from pathlib import Path

PLACE = {'shop': '동네 금은방', 'shop_front': '금은방 앞', 'shop_front_autumn': '금은방 앞', 'workbench': '작업대', 'wholesale': '귀금속 도매상',
         'pawnshop': '전당포', 'shop_display': '진열장', 'imagine': '상상', 'street': '동네 골목', 'home': '집',
         'alley': '가게 옆 골목', 'consultation': '상담실', 'office': '정산 책상', 'storage': '보관실', 'repair_corner': '수리 코너',
         'wedding_table': '예물 상담석', 'market_stairs': '상가 계단'}


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1]).resolve()
    rows = [[c.strip() for c in ln.strip().strip('|').split('|')] for ln in (ep / sys.argv[2]).read_text(encoding='utf-8').splitlines()
            if re.match(r'^\|\s*\d+\s*\|', ln)]
    old = json.loads((ep / 'beats.json').read_text(encoding='utf-8'))
    keep = ep / ('beats_v1.json' if not (ep / 'beats_v1.json').exists() else f'beats_before_{Path(sys.argv[2]).stem}.json')   # 덮기 전 판 보관
    if not keep.exists():
        keep.write_text(json.dumps(old, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    peak = re.search(r'정점\s*=\s*\d+초\s*(\d+)번', (ep / sys.argv[2]).read_text(encoding='utf-8'))
    peak = int(peak.group(1)) if peak else None
    beats = []
    for r in rows:
        n, _t0, dur, bg, gray, when, spk, tag, line, color, react, rline = r[:12]
        fill = r[12] if len(r) > 12 else '—'
        bg = bg.removeprefix('new:')
        yr = re.match(r'(\d{4}년)', when)
        b = {'n': int(n), 'bg': bg, 'gray': gray.upper().startswith('Y'), 'dur': float(dur),
             'year': f'{yr.group(1)} · {PLACE.get(bg, bg)}' if yr else '2025년 · ' + PLACE.get(bg, bg), 'speaker': spk}
        if not yr and 'KRX' in when:   # 숫자 화면: 출처 기준을 보조 자막으로
            b['sub'] = '출처: 한국거래소 «2025년 상반기 KRX금시장 동향»(2025.7.2)' + ('' if len(r) > 12 else ' · ' + when)   # 3판: 기준은 도표 제목에
        if line in ('—', '-', ''):
            b['cutin'] = True
        else:
            b['line'], b['color'], b['tag'] = line, color if color in ('yellow', 'red') else 'yellow', '' if tag in ('—', '-') else tag
        enter = '튀어나옴' in react
        react = react.split('·')[0].strip()
        if react not in ('—', '-', '') and not b.get('cutin'):
            b['react'] = react
            if rline not in ('—', '-', ''):
                b['react_line'] = rline
        b['enter'] = enter
        if len(r) > 12:   # 3판: 소품·도표 칸 → prop / chart, 큰 고양이·4~5줄 배치
            b['v3'] = True
            if fill.startswith('prop:'):
                b['prop'] = fill[5:].strip()
            elif fill.startswith('chart:'):
                title, _, body = fill[6:].partition('=')
                rows = [x.strip().rsplit(' ', 1) for x in body.split(';') if x.strip()]
                b['chart'] = {'title': title.strip(), 'rows': [x if len(x) == 2 else [x[0], ''] for x in rows]}
        b['sfx'] = 'tada' if int(n) == peak else 'boing' if enter else 'womp' if b.get('color') == 'red' and 'despair' in spk else 'pop'
        beats.append(b)
    spec = {'bgm': old['bgm'], 'pinned_comment': old.get('pinned_comment'), 'peak_beat': peak, 'beats': beats}
    (ep / 'beats.json').write_text(json.dumps(spec, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(beats)}화면 · {sum(b["dur"] for b in beats):.0f}초 · 정점 {peak}번')


if __name__ == '__main__':
    main()
