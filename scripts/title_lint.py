# -*- coding: utf-8 -*-
"""롱폼 제목 린터(규칙집 T3) — `{좌측 후킹} | {우측 정리}`, 구분자 앞뒤 공백 1칸, 공백 포함 25~35자, 40자 초과 반려.

    python scripts/title_lint.py "제목" [--lang ko|ja] [--min 25] [--max 35] [--reject 40] [--json]
    python scripts/title_lint.py --file titles.txt [--lang ja]      # 한 줄에 제목 하나
    python scripts/title_lint.py "제목" --lane politics_ja           # ja 정치: 16~30자 · 감정·조롱어 FAIL

판정(levels): FAIL = 반려 / WARN = 사람 확인.
- FAIL: « | » 구분자 없음·둘 이상 · 길이 > reject · 금지어(욕설·비하·혐오 — 侮辱罪·명예훼손 대비, ja 원고 틀 D5 와 같은 결)
- WARN: 길이가 min~max 밖(reject 이하) · 구분자 앞뒤 공백이 1칸이 아님 · 숫자 없음 · 한쪽이 비었거나 5자 미만
금지어 사전은 아래 BANNED(소형). N100 own_policy 사전은 이 PC에 없어 import 하지 않는다 — 받으면 합친다.
종료 코드: 0 통과(WARN 만 포함), 4 FAIL 있음.
"""
import argparse
import json
import re
import sys
from pathlib import Path

BANNED = {
    'ko': ['병신', '븅신', '씨발', '시발', '좆', '개새끼', '새끼', '꺼져', '미친놈', '미친년', '닥쳐', '틀딱', '한남충', '김치녀',
           '빨갱이', '토착왜구', '수꼴', '좌좀', '좌빨', '일베충', '대깨', '홍어', '쪽바리', '짱깨', '죽어라'],
    'ja': ['死ね', 'バカ', '馬鹿', 'アホ', 'クズ', 'ゴミ', 'キチガイ', '基地外', '売国奴', '発狂', '逝く', '逝った', 'ガイジ',
           'チョン', 'シナ人', '土人', 'ブサイク', '低能'],
}

# 레인별 기본값 — 10-16 정치JA: ja 정치는 16~30자(25~35 는 時代劇 실측), 감정·조롱어는 FAIL
LANES = {
    'politics_ja': {'lang': 'ja', 'min': 16, 'max': 30,
                    'mock': ['論破', '撃沈', 'ブチギレ', 'ヤバい', 'やばい', 'すごすぎる', 'まさか', '発狂', '逝く', 'ｗ']},
}
LANES['politics_ja_short'] = LANES['politics_ja']


def lint(title, lang='ko', mn=25, mx=35, reject=40, mock=()):
    out = []
    t = title.strip()
    n = len(t)
    seps = t.count('|')
    if seps == 0:
        out.append(('FAIL', 'separator', '구분자 « | » 가 없다'))
    elif seps > 1:
        out.append(('FAIL', 'separator', '구분자 « | » 가 %d개다(하나만)' % seps))
    else:
        if not re.search(r'(?<! ) \|(?= )(?!  )', ' ' + t + ' ') or re.search(r'\s{2,}\||\|\s{2,}', t):
            out.append(('WARN', 'separator_space', '구분자 앞뒤 공백은 1칸씩(« | »)'))
        left, right = [x.strip() for x in t.split('|')]
        if len(left) < 5 or len(right) < 5:
            out.append(('WARN', 'side_short', '좌측 후킹·우측 정리 중 한쪽이 5자 미만(%d/%d)' % (len(left), len(right))))
    if n > reject:
        out.append(('FAIL', 'length', '%d자 — %d자 초과는 반려' % (n, reject)))
    elif not mn <= n <= mx:
        out.append(('WARN', 'length', '%d자 — 권장 %d~%d자' % (n, mn, mx)))
    hits = [w for w in BANNED.get(lang, []) if w in t]
    if hits:
        out.append(('FAIL', 'banned', '금지어: %s' % ', '.join(hits)))
    hits = [w for w in mock if w in t and w not in BANNED.get(lang, [])]
    if hits:
        out.append(('FAIL', 'mock', '감정·조롱어: %s' % ', '.join(hits)))
    if not re.search(r'[0-9０-９]|[一二三四五六七八九十百千万億兆]', t if lang == 'ja' else re.sub(r'[一-龥]', '', t)):
        out.append(('WARN', 'number', '숫자가 없다(숫자 제목이 클릭률에 유리 — 규칙집 T 계열)'))
    return out


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='롱폼 제목 린터(T3)')
    ap.add_argument('title', nargs='?')
    ap.add_argument('--file')
    ap.add_argument('--lane', choices=sorted(LANES), help='레인 기본값(lang·길이·감정어) — 따로 준 --lang/--min/--max 가 이긴다')
    ap.add_argument('--lang', choices=['ko', 'ja'])
    ap.add_argument('--min', type=int)
    ap.add_argument('--max', type=int)
    ap.add_argument('--reject', type=int, default=40)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    lane = LANES.get(a.lane, {})
    a.lang = a.lang or lane.get('lang', 'ko')
    a.min = a.min if a.min is not None else lane.get('min', 25)
    a.max = a.max if a.max is not None else lane.get('max', 35)
    titles = ([a.title] if a.title else []) + (Path(a.file).read_text(encoding='utf-8').splitlines() if a.file else [])
    titles = [t for t in titles if t.strip()]
    if not titles:
        ap.print_usage()
        return 2
    res = [{'title': t, 'chars': len(t.strip()), 'issues': lint(t, a.lang, a.min, a.max, a.reject, lane.get('mock', ()))} for t in titles]
    fail = any(lv == 'FAIL' for r in res for lv, _, _ in r['issues'])
    if a.json:
        print(json.dumps({'ok': not fail, 'titles': res}, ensure_ascii=False, indent=2))
    else:
        for r in res:
            lv = 'FAIL' if any(i[0] == 'FAIL' for i in r['issues']) else 'WARN' if r['issues'] else 'PASS'
            print('%s (%d자) %s' % (lv, r['chars'], r['title']))
            for l2, _, msg in r['issues']:
                print('   %s %s' % (l2, msg))
    return 4 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
