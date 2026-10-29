# -*- coding: utf-8 -*-
"""빌런 감시(소유주 10-29 «2주 고정이 아니라 뉴스에 민감해야 — 부정 여론이 큰 인물이 새로 생기면 발 빠르게 한 발 담가라»).

    python -X utf8 politics-hour-ja/villain_watch.py [--out <폴더>]

야후 국내 댓글 랭킹(시간당 댓글 수) + 공용 뉴스 아웃라이어(server/data/news_outliers/politics_ja_latest.json)에서
정치인 이름(«○○氏·首相·代表·大臣·相·議員·幹事長…» 앞 한자 2~4자 + 알려진 이름표)을 뽑아 인물별로 합친다.
현재 빌런(최신 편 keywords.json candidates[0].villain.name)보다 시간당 댓글 합이 크거나 80건/시 이상인 새 인물 = «새 빌런 신호».
출력: <out>/<YYYYMMDD-HHMM>.md · 종료 0 신호 없음 · 2 새 빌런 신호(편 기획 때 후보표에 올린다) · 5 랭킹 못 읽음. 요청 1회, 차단(403·429)이면 멈춘다."""
import datetime
import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RANK = 'https://news.yahoo.co.jp/ranking/comment/domestic'
NEWS = ROOT / 'server' / 'data' / 'news_outliers' / 'politics_ja_latest.json'
# 정치인 직함만(«氏»·«代表»는 기업인·연예인도 붙어 뺀다 — 당 대표는 KNOWN 표로 잡는다)
TITLE = r'(?:首相|総理|大臣|副大臣|農水相|農相|外相|財務相|防衛相|官房長官|幹事長|政調会長|議員|知事|元首相)'
NAME = re.compile(r'([一-龥々]{2,4})(?:・[一-龥々]{1,4})?' + TITLE)
# 성만 나오는 기사 제목이 많아 자주 나오는 이름은 표로 보탠다(성 → 표기)
KNOWN = ['高市', '石破', '岸田', '麻生', '茂木', '小泉', '林芳正', '森山', '萩生田', '玉木', '榛葉', '野田', '小川淳也', '渡辺創', '辻元',
         '長妻', '岡本三成', '吉村', '藤田', '武部', '簗', '西田昌司', '神谷', '山本太郎', '田村智子']
# 우리 시청층(여당 지지·40~60대)의 편 — 비판 기사가 많아도 빌런 후보가 아니다(소유주 10-29 «진영 색깔에 맞춰서»)
OURS = {'高市'}
NOT = {'所属', '自民', '公明', '維新', '国民', '立憲', '共産', '中道', '参政', '政府', '首相', '内閣', '国会', '与党', '野党', '同党', '新党', '民主', '日本'}


def ranking():
    req = urllib.request.Request(RANK, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'})
    s = urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'replace')
    rows = []
    for li in re.findall(r'<li[^>]*>(.*?)</li>', s, re.S):
        t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', li)).strip()
        m = re.match(r'(\d+) (?:\d+:\d+ )?(.*?) (\S+(?:（[^）]*）)?) (\d+/\d+\(.\) \d+:\d+) (\d+) 件/時', t)
        if m:
            rows.append({'rank': int(m.group(1)), 'title': m.group(2), 'src': m.group(3), 'at': m.group(4), 'per_h': int(m.group(5))})
    return rows


def people(title):
    found = {m.group(1) for m in NAME.finditer(title) if m.group(1) not in NOT}
    found |= {k for k in KNOWN if k in title}
    # 성만 잡힌 것과 전체 이름이 같이 잡히면 전체 이름만
    return {p for p in found if not any(p != q and p in q for q in found) and not any(o in p for o in OURS)}


def merge(agg):
    # «武部»와 «武部新»처럼 성과 전체 이름이 다른 기사에서 따로 잡히면 긴 이름 하나로 합친다
    for p in sorted(agg, key=len):
        q = next((q for q in agg if q != p and q.startswith(p)), None)
        if q:
            a, b = agg.pop(p), agg[q]
            b['per_h'] += a['per_h']; b['n'] += a['n']; b['titles'] += a['titles']; b['news'] += a['news']
    return agg


def current_villain():
    eps = sorted((HERE / 'episodes').glob('*/keywords.json'), reverse=True)
    for f in eps:
        for c in json.loads(f.read_text(encoding='utf-8')).get('candidates', []):
            if isinstance(c, dict) and (c.get('villain') or {}).get('name'):
                return c['villain']['name']
    return ''


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    out = Path(argv[argv.index('--out') + 1]) if '--out' in argv else HERE / '_scan' / 'villain_watch'
    out.mkdir(parents=True, exist_ok=True)
    try:
        rows = ranking()
    except Exception as e:   # 차단·연결 실패는 우회하지 않는다
        print(f'[villain] 랭킹 못 읽음: {e}')
        return 5
    if not rows:
        print('[villain] 랭킹 형식이 바뀜(행 0)')
        return 5
    agg = defaultdict(lambda: {'per_h': 0, 'n': 0, 'titles': [], 'news': 0})
    for r in rows:
        for p in people(r['title']):
            a = agg[p]
            a['per_h'] += r['per_h']; a['n'] += 1; a['titles'].append(f'{r["rank"]}위 {r["per_h"]}건/시 «{r["title"][:60]}»')
    news_at = ''
    if NEWS.exists():
        nd = json.loads(NEWS.read_text(encoding='utf-8'))
        news_at = nd.get('at', '')
        seen = set()
        for c in nd.get('candidates', []):
            o = c.get('news_outlier') or {}
            if o.get('video_id') in seen:
                continue
            seen.add(o.get('video_id'))
            t = ' '.join([*o.get('title_words', []), *o.get('quotes', [])])
            for p in people(t):
                agg[p]['news'] += 1
    agg = merge(agg)
    cur = current_villain()
    cur_h = next((a['per_h'] for p, a in agg.items() if cur and (p in cur or cur in p)), 0)
    top = sorted(agg.items(), key=lambda x: (-x[1]['per_h'], -x[1]['news']))[:10]
    new = [(p, a) for p, a in top if not (cur and (p in cur or cur in p)) and (a['per_h'] >= max(80, cur_h + 1))]
    now = datetime.datetime.now()
    lines = [f'# 빌런 감시 {now:%Y-%m-%d %H:%M} — 현재 빌런 {cur or "없음"} {cur_h}건/시 · 랭킹 {len(rows)}행 · 뉴스 아웃라이어 {news_at}', '',
             '| 인물 | 시간당 댓글 합 | 기사 수 | 뉴스 터진 롱폼 | 기사 |', '|---|---|---|---|---|']
    lines += [f'| {p}{" ★새 신호" if (p, a) in new else ""} | {a["per_h"]} | {a["n"]} | {a["news"]} | {" / ".join(a["titles"][:2])} |' for p, a in top]
    (out / f'{now:%Y%m%d-%H%M}.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('\n'.join(lines))
    return 2 if new else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
