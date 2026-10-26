"""쇼핑 레퍼런스 풀 — 경쟁 쇼핑 채널에서 터진 영상(채널 평소 ×3 이상)을 모아 한 파일로 유지한다.

쇼핑 세션은 server/data/shop_ref_pool.json 만 읽는다. 사본은 docs/shop-ref-pool.md.
API 0원 경로:
- 유튜브 해시태그 쇼츠 페이지 → oEmbed로 채널 확인 → 채널 쇼츠 탭 최근 60편 → 3배 이상 편의 메타(yt-dlp -j).
- 인스타그램: 공개 프로필 API를 하루 1회 시험한다. 403/429면 그날은 멈춘다(로그인·쿠키·우회 금지).
결과는 호출마다 파일로 저장한다(10-25 일괄 저장 유실 교훈). 다시 돌리면 캐시를 재사용한다.

사용: python -I scripts/shop_ref_pool.py [--days 30] [--min-ratio 3]
"""
import argparse, datetime as dt, json, os, re, statistics, subprocess, sys, urllib.parse, urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / 'reference' / 'shop_ref_pool'
OUT = ROOT / 'server' / 'data' / 'shop_ref_pool.json'
DOC = ROOT / 'docs' / 'shop-ref-pool.md'
TAGS = ['쿠팡꿀템', '쿠팡추천템', '쿠팡파트너스', '살림꿀템', '살림템', '자취꿀템', '주방꿀템', '생활꿀템', '청소꿀템',
        '욕실꿀템', '육아꿀템', '캠핑꿀템', '차량꿀템', '꿀템추천', '쿠팡필수템', '쿠팡추천', '내돈내산꿀템', '삶의질상승템',
        '겨울필수템', '난방비절약', '원룸꿀템', '공간활용', '집꾸미기', '다이소꿀템']
GENERIC = set('꿀템 살림템 살림꿀템 생활꿀템 쿠팡추천템 쿠팡꿀템 쿠팡추천 꿀팁 쇼츠 shorts 추천템 자취꿀템 다이소 다이소꿀템 리뷰 아이디어상품 '
              '생활용품 주방용품 살림 꿀템추천 내돈내산 쿠팡 쿠팡파트너스 살림꿀팁 살림템추천 생활꿀팁 인테리어 집꾸미기 공간활용 '
              '쿠팡필수템 꿀정보 쇼핑 신박템 가성비템 추천 생활템 꿀템리뷰 다이소추천템 다이소신상 셀프인테리어 주방정리 수납정리 수납꿀팁 '
              '주방꿀템 신기한템 정리정돈 살림노하우 살림팁 자취 자취템 원룸 원룸꿀템 신박한아이템 꿀템소개 리빙 리빙템 홈인테리어 인테리어소품 '
              '겨울필수템 연예인 예능 먹방 레시피 쿠팡템 아이디어 생활의지혜 꿀팁공유 살림정보 쇼핑추천 육아꿀템 캠핑꿀템 차량꿀템 청소꿀템 욕실꿀템'.split())
SHOP = re.compile(r'쿠팡|파트너스|구매|프로필|링크|제품|스티커|인포크|번호')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'


def log(*a):
    print(*a, flush=True)


def ytdlp(args, timeout=600):
    r = subprocess.run(['yt-dlp', '--encoding', 'utf-8', *args], capture_output=True, timeout=timeout)
    return r.stdout.decode('utf-8', 'replace')


def save(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    for _ in range(5):                          # Windows 잠금(백신·색인)으로 교체가 거부되면 잠시 뒤 다시
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            __import__('time').sleep(1)
    p.write_text(tmp.read_text(encoding='utf-8'), encoding='utf-8')


def scan_tags(day):
    """해시태그 쇼츠 → (id, 조회) 목록. 태그마다 파일로 저장."""
    seen = {}
    for t in TAGS:
        f = WORK / 'tags' / day / f'{t}.txt'
        if not f.exists():
            u = 'https://www.youtube.com/hashtag/' + urllib.parse.quote(t) + '/shorts'
            out = ytdlp(['--flat-playlist', '--playlist-end', '300', u, '--print', '%(id)s\t%(view_count)s'])
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(out, encoding='utf-8')
        for line in f.read_text(encoding='utf-8').splitlines():
            p = line.split('\t')
            if len(p) == 2 and p[1].isdigit():
                seen[p[0]] = max(seen.get(p[0], 0), int(p[1]))
    return seen


def oembed(vid):
    f = WORK / 'oembed' / f'{vid}.json'
    if f.exists():
        try:
            return json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            return None
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(
            f'https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/{vid}', headers={'User-Agent': UA}), timeout=20))
    except Exception:
        d = {}
    save(f, d)
    return d or None


def channel_shorts(url, day):
    h = re.sub(r'[^A-Za-z0-9]', '', urllib.parse.unquote(url).split('@')[-1])[:40] or 'x'
    f = WORK / 'chan' / day / f'{h}.txt'
    if not f.exists():
        out = ytdlp(['--flat-playlist', '--playlist-end', '60', url.rstrip('/') + '/shorts', '--print', '%(id)s\t%(view_count)s\t%(title)s'])
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(out, encoding='utf-8')
    rows = []
    for line in f.read_text(encoding='utf-8').splitlines():
        p = line.split('\t')
        if len(p) >= 2 and p[1].isdigit():
            rows.append((p[0], int(p[1]), p[2] if len(p) > 2 else ''))
    return rows


def video_meta(vid):
    f = WORK / 'video' / f'{vid}.json'
    if f.exists():
        return json.loads(f.read_text(encoding='utf-8'))
    out = ytdlp(['--skip-download', '--write-comments', '--extractor-args', 'youtube:max_comments=4,4,0,0;comment_sort=top',
                 '-j', f'https://www.youtube.com/shorts/{vid}'], timeout=180)
    try:
        d = json.loads(out)
    except Exception:
        d = {}
    keep = {k: d.get(k) for k in ('id', 'title', 'description', 'upload_date', 'view_count', 'like_count', 'comment_count', 'channel', 'channel_url')}
    keep['pinned'] = [c.get('text', '')[:200] for c in (d.get('comments') or []) if c.get('is_pinned') or c.get('author_is_uploader')][:2]
    save(f, keep)
    return keep


def product_key(m):
    text = (m.get('title') or '') + ' ' + (m.get('description') or '')[:600]
    ch = re.sub(r'\s', '', m.get('channel') or '')
    tags = [t for t in re.findall(r'#([0-9A-Za-z가-힣]+)', text)
            if t not in GENERIC and not t.lower().startswith('shorts') and t not in ch and ch not in t]
    title = re.sub(r'#\S+', '', m.get('title') or '').strip()
    return tags[:4], title


def instagram_probe(day):
    """공개 프로필 API를 1회 시험한다. 결과를 파일로 남기고, 403/429면 False."""
    f = WORK / 'ig' / f'probe-{day}.json'
    if f.exists():
        return json.loads(f.read_text(encoding='utf-8')).get('ok', False)
    req = urllib.request.Request('https://i.instagram.com/api/v1/users/web_profile_info/?username=instagram',
                                 headers={'User-Agent': UA, 'x-ig-app-id': '936619743392459'})
    try:
        code = urllib.request.urlopen(req, timeout=20).status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception:
        code = 0
    ok = code == 200
    save(f, {'day': day, 'status': code, 'ok': ok})
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--min-ratio', type=float, default=3.0)
    ap.add_argument('--min-pool-views', type=int, default=30000)
    a = ap.parse_args()
    day = dt.datetime.now().strftime('%Y-%m-%d')
    since = (dt.datetime.now() - dt.timedelta(days=a.days)).strftime('%Y%m%d')

    seen = scan_tags(day)
    log('해시태그 쇼츠', len(seen))
    chans = defaultdict(int)
    for vid, v in sorted(seen.items(), key=lambda x: -x[1]):
        if v < a.min_pool_views:
            continue
        d = oembed(vid)
        if d and d.get('author_url'):
            chans[d['author_url']] += 1
    prev = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {'channels': {}, 'rows': []}
    keep = set(prev.get('channels', {}))        # 풀은 줄지 않는다: 한 번 들어온 채널은 계속 본다
    seed = WORK / 'seed.txt'                    # 손으로 넣는 채널(한 줄에 채널 URL 하나)
    if seed.exists():
        keep |= {l.strip() for l in seed.read_text(encoding='utf-8').splitlines() if l.strip().startswith('http')}
    for u in keep:
        chans.setdefault(u, 0)
    sel = [u for u, n in chans.items() if n >= 2 or u in keep]
    log('채널', len(sel))

    chinfo, rows = dict(prev.get('channels', {})), {r['id']: r for r in prev.get('rows', [])}
    for u in sel:
        sh = channel_shorts(u, day)[:30]
        if len(sh) < 5:
            continue
        med = statistics.median(v for _, v, _ in sh)
        chinfo[u] = {'name': chinfo.get(u, {}).get('name', ''), 'platform': 'youtube', 'median30': med, 'checked': day}
        for vid, v, t in sh:
            if med <= 0 or v < a.min_ratio * med:
                continue
            m = video_meta(vid)
            if not m.get('upload_date') or m['upload_date'] < since:
                continue
            blob = (m.get('title') or '') + (m.get('description') or '') + ' '.join(m.get('pinned') or [])
            if not re.search(r'[가-힣]', m.get('title') or '') or not SHOP.search(blob):
                continue                        # 한국어 쇼핑 영상만(구매 동선 낱말이 있어야)
            chinfo[u]['name'] = m.get('channel') or chinfo[u]['name']
            tags, title = product_key(m)
            r = rows.get(vid, {})
            r.update(id=vid, platform='youtube', channel=m.get('channel'), channel_url=u, url=f'https://www.youtube.com/shorts/{vid}',
                     views=v, ratio=round(v / med, 1), product=title[:80], product_tags=tags, uploaded=m['upload_date'],
                     like_rate=round((m.get('like_count') or 0) / max(v, 1), 4), pinned=m.get('pinned', [])[:1],
                     boost_suspect=(m.get('like_count') or 0) / max(v, 1) < 0.001, first_seen=r.get('first_seen', day), updated=day)
            rows[vid] = r
        save(WORK / 'progress.json', {'day': day, 'channels_done': len(chinfo), 'rows': len(rows)})   # 중간 저장

    # 겹친 채널 수: 같은 상품 해시태그를 쓴 서로 다른 채널 수
    rows = {k: r for k, r in rows.items() if re.search(r'[가-힣]', r.get('product') or '')}
    tag_ch = defaultdict(set)
    for r in rows.values():
        r['product_tags'] = [x for x in r.get('product_tags', []) if x not in GENERIC]
        for t in r.get('product_tags', []):
            tag_ch[t].add(r['channel_url'])
    for r in rows.values():
        r['overlap_channels'] = max([len(tag_ch[t]) for t in r.get('product_tags', [])] or [1])
    ig_ok = instagram_probe(day)
    live = sorted((r for r in rows.values() if r['uploaded'] >= since), key=lambda r: (-r['overlap_channels'], -r['ratio']))
    pool = {'updated': day, 'window_days': a.days, 'min_ratio': a.min_ratio, 'instagram': 'ok' if ig_ok else 'blocked(공개 API 403/429 — 오늘 건너뜀)',
            'channels': chinfo, 'rows': live,
            'note': '행=경쟁 채널에서 평소(최근 30편 중앙)의 min_ratio배 이상 터진 영상. overlap_channels=같은 상품 해시태그를 쓴 서로 다른 채널 수. boost_suspect=좋아요 비율 0.1% 미만.'}
    save(OUT, pool)
    export_extra(live)
    new = [r for r in live if r['first_seen'] == day]
    write_doc(pool, new)
    log(f"풀 {len(chinfo)}채널/{len(live)}편, 오늘 새로 {len(new)}편, 인스타 {pool['instagram']}")
    for r in sorted(new, key=lambda r: (-r['overlap_channels'], -r['ratio']))[:5]:
        log(f"  {r['product'][:40]} ×{r['ratio']} {r['views']} 겹침{r['overlap_channels']} {r['url']}")


EXTRA = Path('D:/volcano-runs/_cand/refs/seller_pool_extra.json')   # 쇼핑 shop_seller_pool.js 가 읽는 경로
BASE = ROOT / 'reference' / 'shop_comp_1025' / 'hits30.json'          # 같은 스크립트가 따로 읽는 10-25 납품분
IGREFS = Path('D:/volcano-runs/_cand/refs/ig_refs.json')             # 쇼핑 shop_ref_discover.js 상태 파일


def export_extra(live):
    """쇼핑 형식 {id,ch,views,x,date,title,url,platform}으로 덧붙인다. 기존 행은 지우지 않고 갱신만 한다."""
    try:
        base = {h['id'] for h in json.loads(BASE.read_text(encoding='utf-8'))}
    except Exception:
        base = set()
    try:
        cur = {h['id']: h for h in json.loads(EXTRA.read_text(encoding='utf-8'))}
    except Exception:
        cur = {}
    for r in live:
        if r['id'] in base:
            continue
        cur[r['id']] = {'id': r['id'], 'ch': r['channel'] or '', 'views': r['views'], 'x': r['ratio'], 'date': r['uploaded'],
                        'title': r['product'], 'url': r['url'], 'platform': r['platform'], 'overlap_channels': r['overlap_channels'],
                        'boost_suspect': r['boost_suspect']}
    # 인스타: 쇼핑 세션이 TikHub로 모은 ig_refs.json 의 outliers 를 그대로 옮긴다(발굴은 인스타를 직접 호출하지 않는다)
    try:
        ig = json.loads(IGREFS.read_text(encoding='utf-8'))
    except Exception:
        ig = {}
    for code, o in (ig.get('outliers') or {}).items():
        if not o.get('at') or not o.get('x'):
            continue
        cur[code] = {'id': code, 'ch': o.get('username', ''), 'views': o.get('plays') or 0, 'x': o['x'], 'date': o['at'].replace('-', '')[:8],
                     'title': re.sub(r'\s+', ' ', o.get('caption') or '')[:80], 'url': o.get('url') or f'https://www.instagram.com/reel/{code}/',
                     'platform': 'instagram', 'overlap_channels': 1, 'boost_suspect': False, 'via': 'ig_refs(TikHub, 쇼핑)'}
    save(EXTRA, sorted(cur.values(), key=lambda h: h['date'], reverse=True))


def write_doc(pool, new):
    L = [f"# 쇼핑 레퍼런스 풀 (자동 생성 {pool['updated']})", '',
         '정본은 `server/data/shop_ref_pool.json`이다. 이 문서는 사본이고, `scripts/shop_ref_pool.py`가 매일 덮어쓴다.', '',
         f"- 채널 {len(pool['channels'])}곳, 최근 {pool['window_days']}일에 평소의 {pool['min_ratio']:g}배 이상 터진 영상 {len(pool['rows'])}편",
         f"- 인스타그램: {pool['instagram']}", '',
         '| 상품(제목) | 채널 | 조회 | 배수 | 겹친 채널 | 올린 날 | 표시 |', '|---|---|---|---|---|---|---|']
    for r in pool['rows'][:120]:
        mark = '광고 부스트 의심' if r.get('boost_suspect') else ''
        if r['first_seen'] == pool['updated']:
            mark = (mark + ' 새로 들어옴').strip()
        L.append(f"| [{r['product'][:50].replace('|', '/')}]({r['url']}) | {(r['channel'] or '').replace('|', '/')} | {r['views']:,} | ×{r['ratio']} | {r['overlap_channels']} | {r['uploaded'][4:6]}-{r['uploaded'][6:]} | {mark} |")
    DOC.write_text('\n'.join(L) + '\n', encoding='utf-8')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
