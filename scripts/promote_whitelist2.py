# -*- coding: utf-8 -*-
"""화이트리스트를 카탈로그로 승격시킨다 — 2차(2026-09-29).

    python scripts/promote_whitelist2.py          들어갈 것을 보여준다
    python scripts/promote_whitelist2.py --apply  쓴다

1차(`promote_whitelist.py`)는 49건을 손으로 적은 표로 올렸다. 이번엔 73건이라 그 방식이 안 맞는다.
그래서 **아는 것만 채우고 모르는 것은 «모른다»고 표시한다.**

무엇을 표시하나 — 둘 다 안전에 직결된다
  · `needs_distributor`  배급사를 모른다 → 금지 배급사(Sony·Columbia·Lionsgate…)인지 판정할 수 없다.
                         **확인 전에는 만들지 마라.** 고르는 순서에서 뒤로 민다.
  · `needs_title_ja`     일본 개봉명을 모른다 → ja 해시태그를 못 만든다. **ko 전용.**

★«모른다»를 «괜찮다»로 바꿔 적지 마라. 오늘 하루에만 내가 빈 값·강제 언어·할당량 소진을
  «결과»로 기록해서 세 번 틀렸다. 모르면 모른다고 적고 순위를 내리는 것이 맞다.
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')
WHITELIST = os.path.join(ROOT, 'server', 'data', 'whitelist_works.json')

# 내가 확신하는 것만 적는다. 없는 것은 «확인 필요»로 남는다.
DIST = {
    'Where Hope Grows': 'Roadside Attractions', 'Its Bruno': 'Netflix',
    'Freedom Writers': 'Paramount', 'Courageous': 'Sony / TriStar',
    'The Cleaning Lady': 'Fox (Warner Bros. TV)', 'Animal Control': 'Fox',
    'The Good Doctor': 'ABC (Sony TV)', 'Shameless': 'Showtime (Paramount)',
    'The Intouchables': 'Gaumont / The Weinstein Company', 'Mona Lisa Smile': 'Sony / Columbia',
    'The Menu': 'Searchlight (Disney)', 'Maleficent': 'Disney',
    'Follow the Stars Home': 'CBS', 'Paddington 2': 'StudioCanal / Warner',
    'Joyeux Noel': 'Sony Pictures Classics', 'The Hurt Locker': 'Summit Entertainment',
    'Paulie': 'Universal / DreamWorks', 'The Greatest Beer Run Ever': 'Apple',
    'A Million Ways to Die in the West': 'Universal', 'Greys Anatomy': 'ABC (Disney)',
    'Stick It': 'Buena Vista (Disney)', 'Stop! Or My Mom Will Shoot': 'Universal',
    'Land of the Lost': 'Universal', 'Run Sweetheart Run': 'Amazon',
    'There She Goes': 'BBC', 'Dr. Dolittle: Million Dollar Mutts': '20th Century Fox (Disney)',
    'Just Like Heaven': 'DreamWorks (Universal)', 'Kraven the Hunter': 'Sony / Columbia',
    'The Experiment': 'Sony / Stage 6', 'Sin City: A Dame to Kill For': 'Dimension (Weinstein)',
    'National Security': 'Sony / Columbia', 'RoboCop': 'Sony / Columbia',
    'The Matrix': 'Warner', 'Paulette': 'France 2 Cinema',
    'Take Me to the River': 'Film Movement',
}
# 일본 개봉명 — 확신하는 것만.
JA = {
    'Paddington 2': 'パディントン2', 'Maleficent': 'マレフィセント',
    'The Menu': 'ザ・メニュー', 'The Intouchables': '最強のふたり',
    'Freedom Writers': 'フリーダム・ライターズ', 'Mona Lisa Smile': 'モナリザ・スマイル',
    'The Hurt Locker': 'ハート・ロッカー', 'Joyeux Noel': 'メリー・クリスマス',
    'Greys Anatomy': 'グレイズ・アナトミー 恋の解剖学', 'The Good Doctor': 'グッド・ドクター 名医の条件',
    'Shameless': 'シェイムレス 俺たちに恥はない', 'A Million Ways to Die in the West': '荒野はつらいよ',
    'Land of the Lost': '宇宙人ポール'  if False else '',   # 확신 없음 → 비워 둔다
    'RoboCop': 'ロボコップ', 'The Matrix': 'マトリックス',
    'Just Like Heaven': 'noれ' if False else '',
    'Kraven the Hunter': 'クレイヴン・ザ・ハンター',
}


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def slug(en):
    s = re.sub(r'[^a-z0-9]+', '-', en.lower()).strip('-')
    return s[:40] or 'x'


def build_match(en, ko, ja):
    words = [w for w in re.split(r'[^A-Za-z0-9]+', en) if w]
    loose = r'\b' + r'[^a-z0-9]*'.join(w.lower() for w in words) + r'\b'
    alts = [loose] + [re.escape(t) for t in (ko, ja) if t]
    return '|'.join(a for a in alts if a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    cat = read_json(CATALOG, {})
    movies = cat['movies']
    banned_words = [b.lower() for b in cat.get('banned_distributors') or []]
    have = {}
    for k, v in movies.items():
        for n in (v.get('title_en'), v.get('title_ko'), k):
            if n:
                have[norm(n)] = k

    wl = read_json(WHITELIST, [])
    added = []
    for w in wl:
        en = w['en']
        if norm(en) in have:
            continue
        key = slug(en)
        if key in movies:
            key = key + '-' + str(w.get('year') or 'x')
        ko = w.get('ko') or en
        ja = JA.get(en, '')
        dist = DIST.get(en, '')
        is_banned = bool(dist) and any(b in dist.lower() for b in banned_words)
        is_tv = bool(re.search(r'season|series', en, re.I)) or en in (
            'The Good Doctor', 'Shameless', 'Greys Anatomy', 'The Cleaning Lady',
            'Animal Control', 'There She Goes', 'Its Bruno')
        word, word_ja = ('드라마', 'ドラマ') if is_tv else ('영화', '映画')
        e = {
            'match': build_match(en, ko, ja),
            'title_ko': ko, 'title_en': en, 'title_ja': ja,
            'year': int(w['year']) if str(w.get('year') or '').isdigit() else None,
            'distributor': dist or '확인 필요',
            'distributor_tier': 'banned' if is_banned else 'preflight',
            'credit_ko': f"{word} '{ko}'의 장면으로 제작되었습니다.",
            'credit_ja': (f'{word_ja}『{ja}』のシーンから制作しました。' if ja else ''),
            'note': ('2026-09-29 화이트리스트 2차 승격. 레퍼런스 채널에서 우리 길이대·차단 0으로 생존 확인. '
                     '등급 preflight — 판정은 3층(check-claims)이 한다.'),
            'rival_proven': (f"2026-09-29 {'/'.join(w['chs'])} · {w['n']}편 · 누적 {w['views']:,}회 · "
                             f"최초 {w['oldest']} · 차단 0"),
            'whitelist_confidence': {'channels': len(w.get('chs') or []), 'clips': w.get('n'),
                                     'chs': w.get('chs'), 'oldest': w.get('oldest'),
                                     'measured_at': dt.date.today().isoformat()},
        }
        if is_tv:
            e['kind'] = 'tv'
        if not dist:
            e['needs_distributor'] = True
            e['note'] += ' ★배급사 미확인 — 금지 배급사인지 판정 불가. 확인 전에는 만들지 마라.'
        if not ja:
            e['needs_title_ja'] = True
            e['note'] += ' ★title_ja 미확인 — ja 회차에 쓰지 마라(ko 전용).'
        if is_banned:
            e['note'] += f' ★금지 배급사({dist})라 banned 로 넣었다.'
        movies[key] = e
        added.append((key, e, w))

    nd = sum(1 for _, e, _ in added if e.get('needs_distributor'))
    nj = sum(1 for _, e, _ in added if e.get('needs_title_ja'))
    nb = sum(1 for _, e, _ in added if e['distributor_tier'] == 'banned')
    for key, e, w in sorted(added, key=lambda t: -t[2]['views'])[:20]:
        flags = []
        if e['distributor_tier'] == 'banned':
            flags.append('☠금지')
        if e.get('needs_distributor'):
            flags.append('배급사?')
        if e.get('needs_title_ja'):
            flags.append('ko전용')
        print(f"  + {key[:30]:32} {e['title_ko'][:18]:20} {str(e['year'] or ''):5} "
              f"{e['distributor'][:22]:24} {' '.join(flags)}")
    print(f'\n{"적용" if args.apply else "계산만"} · 추가 {len(added)}건 '
          f'(금지 {nb} · 배급사 미확인 {nd} · ko전용 {nj})')

    if args.apply and added:
        with io.open(CATALOG, 'w', encoding='utf-8') as fh:
            json.dump(cat, fh, ensure_ascii=False, indent=2)
        print(f'카탈로그 총 {len(movies)}건')
    return 0


if __name__ == '__main__':
    sys.exit(main())
