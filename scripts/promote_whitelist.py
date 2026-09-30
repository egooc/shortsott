# -*- coding: utf-8 -*-
"""해설로 지은 화이트리스트를 **생산이 고를 수 있는 카탈로그**로 승격시킨다.

    python scripts/promote_whitelist.py          무엇이 들어갈지 보여주기만 한다
    python scripts/promote_whitelist.py --apply  movie_catalog.json 에 쓴다

왜 (2026-09-28 소유주: "레퍼런스 채널 통해서 영화 화이트리스트 찾고 그거 클립 찾아서
    명화관식으로 편집 업로드 진행해. 차단 회피 혹은 차단 안 당하는 생산을 하라고.")

  `whitelist_works.json` 에 60건이 있는데 그중 49건이 `movie_catalog.json` 에 없다.
  **생산은 카탈로그에서만 소재를 고른다.** 그래서 레퍼런스 채널에서 찾아낸 작품을
  지금 구조로는 한 편도 쓸 수 없었다 — 끊어진 고리가 여기였다.

무엇을 채우고 무엇을 비워 두나
  · `title_ja` 는 **일본 개봉명**이어야 한다. ja 해시태그가 반드시 이 값을 쓴다(카탈로그 _doc).
    확신하는 것만 적고, 모르는 것은 비워 둔 채 `needs_title_ja` 를 세운다.
    → **ja 회차는 title_ja 가 빈 항목을 쓰지 마라.** ko 는 바로 쓸 수 있다.
  · `distributor_tier` 는 전부 `preflight` 다 — 화이트리스트는 «고를 이유»지 «안전 보증»이 아니다.
    판정은 프로브와 3층이 한다.
  · ★단, `banned_distributors`(Sony·Columbia·TriStar…)에 걸리는 작품은 `banned` 로 넣는다.
    레퍼런스 채널이 그 작품들을 살려 두고 있다는 것은 사실이지만(불릿 트레인·스파이더맨 등),
    금지 배급사 정책을 이 스크립트가 임의로 뒤집지 않는다. 소유주가 정할 일이다.
"""
import argparse
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, 'midform', 'config', 'movie_catalog.json')
WHITELIST = os.path.join(ROOT, 'server', 'data', 'whitelist_works.json')

# 영문제목 -> (카탈로그 키, 일본 개봉명 또는 '', 배급, 종류)
# ★title_ja 는 확신하는 것만 적었다. 빈 값은 «모른다»는 뜻이지 «없다»가 아니다.
INFO = {
    'The Curious Case of Benjamin Button': ('benjamin-button', 'ベンジャミン・バトン 数奇な人生', 'Paramount', 'movie'),
    'Room': ('room-2015', 'ルーム', 'A24', 'movie'),
    'Front of the Class': ('front-of-the-class', '', 'Hallmark Hall of Fame (CBS)', 'movie'),
    'The Parent Trap': ('the-parent-trap', 'ファミリー・ゲーム/双子の天使', 'Disney', 'movie'),
    'The Truman Show': ('the-truman-show', 'トゥルーマン・ショー', 'Paramount', 'movie'),
    "Brad's Status": ('brads-status', '', 'Amazon Studios / Annapurna', 'movie'),
    'Cargo': ('cargo-2017', 'カーゴ', 'Netflix', 'movie'),
    'A Man Called Otto': ('a-man-called-otto', 'オットーという男', 'Sony / Columbia', 'movie'),
    'Cleveland Abduction': ('cleveland-abduction', '', 'Lifetime (A+E)', 'movie'),
    'Guardians of the Galaxy Vol. 3': ('gotg-vol3', 'ガーディアンズ・オブ・ギャラクシー：VOLUME3', 'Disney / Marvel', 'movie'),
    'Radio': ('radio-2003', '', 'Sony / Columbia', 'movie'),
    'Spider-Man: No Way Home': ('spider-man-no-way-home', 'スパイダーマン：ノー・ウェイ・ホーム', 'Sony / Columbia', 'movie'),
    'Mask': ('mask-1985', '', 'Universal', 'movie'),
    'Bullet Train': ('bullet-train', 'ブレット・トレイン', 'Sony / Columbia', 'movie'),
    'Hidden Figures': ('hidden-figures', 'ドリーム', '20th Century Fox (Disney)', 'movie'),
    'The Help': ('the-help', 'ヘルプ 心がつなぐストーリー', 'Disney (Touchstone / DreamWorks)', 'movie'),
    'The Station Agent': ('the-station-agent', 'ステーション・エージェント', 'Miramax', 'movie'),
    'The Shape of Water': ('the-shape-of-water', 'シェイプ・オブ・ウォーター', 'Fox Searchlight (Disney)', 'movie'),
    'Thor: Love and Thunder': ('thor-love-and-thunder', 'ソー：ラブ＆サンダー', 'Disney / Marvel', 'movie'),
    'Mr. Church': ('mr-church', 'ミスター・チャーチ', 'Cinelou / Envision', 'movie'),
    'A Street Cat Named Bob': ('a-street-cat-named-bob', 'ボブという名の猫 幸せのハイタッチ', 'Sony / Stage 6', 'movie'),
    'The Indian in the Cupboard': ('indian-in-the-cupboard', '', 'Columbia / Paramount', 'movie'),
    'White Fang': ('white-fang', 'ホワイト・ファング', 'Disney', 'movie'),
    'Bruce Almighty': ('bruce-almighty', 'ブルース・オールマイティ', 'Universal', 'movie'),
    'Goal! The Dream Begins': ('goal-the-dream-begins', 'GOAL！', 'Buena Vista (Disney)', 'movie'),
    "The Time Traveler's Wife": ('time-travelers-wife', 'きみがぼくを見つけた日', 'Warner / New Line', 'movie'),
    'My Mister': ('tv-my-mister', 'マイ・ディア・ミスター〜私のおじさん〜', 'tvN (CJ ENM)', 'tv'),
    'Fluke': ('fluke-1995', 'フルーク', 'MGM / UA', 'movie'),
    'Pirates of the Caribbean: On Stranger Tides': ('potc-on-stranger-tides', 'パイレーツ・オブ・カリビアン／生命の泉', 'Disney', 'movie'),
    'Free Guy': ('free-guy', 'フリー・ガイ', '20th Century (Disney)', 'movie'),
    'All the Bright Places': ('all-the-bright-places', '', 'Netflix', 'movie'),
    "My Sister's Keeper": ('my-sisters-keeper', 'わたしのなかのあなた', 'Warner / New Line', 'movie'),
    'The Ron Clark Story': ('the-ron-clark-story', '', 'TNT', 'movie'),
    "A Dog's Journey": ('a-dogs-journey', '僕のワンダフル・ジャーニー', 'Universal / Amblin', 'movie'),
    'Seven Pounds': ('seven-pounds', '7つの贈り物', 'Sony / Columbia', 'movie'),
    'Music of the Heart': ('music-of-the-heart', 'ミュージック・オブ・ハート', 'Miramax', 'movie'),
    '42': ('forty-two', '42 〜世界を変えた男〜', 'Warner', 'movie'),
    'Spider-Man 3': ('spider-man-3', 'スパイダーマン3', 'Sony / Columbia', 'movie'),
    'Legend': ('legend-2015', 'レジェンド 狂気の美学', 'StudioCanal / Universal', 'movie'),
    'Doctor Strange': ('doctor-strange', 'ドクター・ストレンジ', 'Disney / Marvel', 'movie'),
    'Pokemon Detective Pikachu': ('detective-pikachu', '名探偵ピカチュウ', 'Warner', 'movie'),
    'Spider-Man: Far From Home': ('spider-man-far-from-home', 'スパイダーマン：ファー・フロム・ホーム', 'Sony / Columbia', 'movie'),
    'Desperate Housewives': ('tv-desperate-housewives', 'デスパレートな妻たち', 'ABC (Disney)', 'tv'),
    'Transporter 2': ('transporter-2', 'トランスポーター2', '20th Century Fox (Disney)', 'movie'),
    'Oppenheimer': ('oppenheimer', 'オッペンハイマー', 'Universal', 'movie'),
    'Interstellar': ('interstellar', 'インターステラー', 'Paramount / Warner', 'movie'),
    'Spider-Man: Homecoming': ('spider-man-homecoming', 'スパイダーマン：ホームカミング', 'Sony / Columbia', 'movie'),
    'Dr. Dolittle': ('dr-dolittle', 'ドクター・ドリトル', '20th Century Fox (Disney)', 'movie'),
    'Arrival': ('arrival-2016', 'メッセージ', 'Paramount', 'movie'),
}


def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def build_match(en, ko, ja):
    """드래프트 폴더명·소스 제목에 걸릴 정규식. 영문은 낱말 사이를 느슨하게 둔다."""
    words = [w for w in re.split(r'[^A-Za-z0-9]+', en) if w]
    loose = r'[^a-z0-9]*'.join(w.lower() for w in words)
    alts = [loose]
    for t in (ko, ja):
        if t:
            alts.append(re.escape(t))
    return '|'.join(alts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    cat = json.load(io.open(CATALOG, encoding='utf-8'))
    movies = cat['movies']
    banned_words = [b.lower() for b in cat.get('banned_distributors') or []]
    have = {}
    for k, v in movies.items():
        for n in (v.get('title_en'), v.get('title_ko'), k):
            if n:
                have[norm(n)] = k

    wl = json.load(io.open(WHITELIST, encoding='utf-8'))
    added, skipped, unknown = [], [], []
    for w in wl:
        en = w['en']
        if norm(en) in have:
            skipped.append(en)
            continue
        info = INFO.get(en)
        if not info:
            unknown.append(en)
            continue
        key, ja, dist, kind = info
        if key in movies:
            skipped.append(en)
            continue
        is_banned = any(b in dist.lower() for b in banned_words)
        ko = w.get('ko') or ''
        word = '드라마' if kind == 'tv' else '영화'
        word_ja = 'ドラマ' if kind == 'tv' else '映画'
        entry = {
            'match': build_match(en, ko, ja),
            'title_ko': ko or en,
            'title_en': en,
            'title_ja': ja,
            'year': int(w['year']) if str(w.get('year') or '').isdigit() else None,
            'distributor': dist,
            'distributor_tier': 'banned' if is_banned else 'preflight',
            'credit_ko': f"{word} '{ko or en}'의 장면으로 제작되었습니다.",
            'credit_ja': (f"{word_ja}『{ja}』のシーンから制作しました。" if ja else ''),
            'note': ('2026-09-28 화이트리스트 승격. 레퍼런스 채널에서 우리 길이대·차단 0으로 생존 확인. '
                     '등급은 preflight — 판정은 프로브와 3층이 한다.'),
            'rival_proven': (f"2026-09-28 {'/'.join(w['chs'])} · {w['n']}편 · 누적 {w['views']:,}회 · "
                             f"최초 게시 {w['oldest']} · 차단 0"),
        }
        if kind == 'tv':
            entry['kind'] = 'tv'
        if not ja:
            entry['needs_title_ja'] = True
            entry['note'] += ' ★title_ja 미확인 — ja 회차에 쓰지 마라(ko 전용).'
        if is_banned:
            entry['note'] += (f' ★금지 배급사({dist})라 banned 로 넣었다. 레퍼런스 채널은 이 작품을 '
                              '살려 두고 있어 정책과 증거가 충돌한다 — 소유주 결정 사항이다.')
        movies[key] = entry
        added.append((key, entry))

    added.sort(key=lambda kv: kv[0])
    for key, e in added:
        flags = []
        if e['distributor_tier'] == 'banned':
            flags.append('☠금지배급사')
        if e.get('needs_title_ja'):
            flags.append('ko전용')
        print(f"  + {key:28} {e['title_ko'][:20]:22} {str(e['year'] or ''):5} "
              f"{e['distributor'][:26]:28} {' '.join(flags)}")
    if unknown:
        print('\n  정보 표에 없어 건너뜀:', ', '.join(unknown))
    ko_only = sum(1 for _, e in added if e.get('needs_title_ja'))
    ban = sum(1 for _, e in added if e['distributor_tier'] == 'banned')
    print(f"\n{'적용' if args.apply else '계산만'} · 추가 {len(added)}건 "
          f"(ko전용 {ko_only} · 금지배급사 {ban}) · 이미 있음 {len(skipped)}건")

    if args.apply and added:
        with io.open(CATALOG, 'w', encoding='utf-8') as fh:
            json.dump(cat, fh, ensure_ascii=False, indent=2)
        print(f'{CATALOG} 에 기록 · 총 {len(movies)}건')
    return 0


if __name__ == '__main__':
    sys.exit(main())
