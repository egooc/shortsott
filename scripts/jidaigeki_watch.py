# -*- coding: utf-8 -*-
"""時代劇 공식 채널 공개 감시 — 새로 올라온 본편·지역 제한·설명란 配信期間을 읽어 C·발굴에 알릴 보고서를 만든다.

    python scripts/jidaigeki_watch.py [--max 100] [--json]

- 채널 목록은 midform/config/jidaigeki_watch.json(松竹シネマPLUSシアター·東映時代劇YouTube).
- Data API(발굴용 키 .env YOUTUBE_API_KEY_SEARCH, 업로드 토큰 금지): 업로드 재생목록 playlistItems + videos.list
  (snippet·contentDetails) — 50편에 1단위씩, 1회 실행에 몇 단위.
- 받지 않는다. 알림만(관리자 10-16 승인 설계).
- 配信期間 파싱이 핵심이다: «配信期間：2026年10月14日まで» · «※10/14-10/27無料公開» · «※2025.11.19～無料公開» · «10/2～15無料公開».
  끝날짜가 지났으면 «기간 경과», 시작만 있으면 «기한 없음», 못 읽으면 «기간 미상»(사람 확인).
- 지역: 한국에서 안 보이는 편(JP 한정 등)은 «소재 아님»으로 표시(VPN·프록시 금지 — 10-16 관리자 확정).
- 처음 돌리면 지금 있는 편을 전부 «기준선»으로 기록하고, 다음부터 새 편만 «새로 공개»로 알린다.

상태: server/data/jidaigeki_watch/state.json · 보고서: server/data/jidaigeki_watch/<날짜>.md
종료 코드: 0 정상(새 편 없음 포함), 2 설정·키 오류, 3 API 오류(429·403 — 우회하지 않고 멈춘다).
"""
import argparse
import datetime as dt
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

import api_quota  # 발굴 키 쿼터 장부(10-20)
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / 'midform' / 'config' / 'jidaigeki_watch.json'
OUT = ROOT / 'server' / 'data' / 'jidaigeki_watch'
API = 'https://www.googleapis.com/youtube/v3/'
JST = dt.timezone(dt.timedelta(hours=9))
SEP = r'[-‐－–〜～~]'


def env_key():
    for ln in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
        if ln.startswith('YOUTUBE_API_KEY_SEARCH='):
            return ln.split('=', 1)[1].strip().strip('"\'')
    return None


def api(path, **q):
    url = API + path + '?' + urllib.parse.urlencode(q)
    api_quota.spend('discovery_search', path)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            api_quota.mark_blocked('jidaigeki_watch', '%s %s' % (path, e.code))
        raise SystemExit('API 오류 %s %s — 멈춘다(우회 안 함)' % (e.code, path)) from None


def iso_minutes(d):
    m = re.match(r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', d or '')
    if not m:
        return 0.0
    dd, h, mi, s = (int(x or 0) for x in m.groups())
    return dd * 1440 + h * 60 + mi + s / 60


def _date(y, mo, d):
    try:
        return dt.date(int(y), int(mo), int(d))
    except ValueError:
        return None


def parse_window(desc, published):
    """설명란에서 공개 창. {'start','end','raw','kind'} — kind: window|until|from|none.
    published 는 YYYY-MM-DD(연도 없는 표기의 해를 정할 때 쓴다)."""
    t = desc or ''
    pub = dt.date.fromisoformat(published[:10]) if published else dt.date.today()

    def year_for(mo):
        y = pub.year
        return y + 1 if int(mo) < pub.month - 6 else y  # 12월 공개 «1/5まで» 같은 해넘김

    m = re.search(r'(?:配信期間|公開期間|無料公開期間)[：:\s]*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日[^\n]{0,20}?(?:' + SEP +
                  r'\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日|まで)', t)
    if m:
        y1, mo1, d1, y2, mo2, d2 = m.groups()
        if mo2:  # «A〜B» 둘 다 있음
            s = _date(y1 or year_for(mo1), mo1, d1)
            return {'start': s, 'end': _date(y2 or year_for(mo2), mo2, d2), 'raw': m.group(0), 'kind': 'window'}
        return {'start': None, 'end': _date(y1 or year_for(mo1), mo1, d1), 'raw': m.group(0), 'kind': 'until'}
    m = re.search(r'(\d{1,2})/(\d{1,2})\s*' + SEP + r'\s*(?:(\d{1,2})/)?(\d{1,2})\s*(?:無料)?(?:公開|配信)', t)
    if m:
        mo1, d1, mo2, d2 = m.groups()
        mo2 = mo2 or mo1
        return {'start': _date(year_for(mo1), mo1, d1), 'end': _date(year_for(mo2), mo2, d2), 'raw': m.group(0), 'kind': 'window'}
    m = re.search(r'(\d{4})[./年](\d{1,2})[./月](\d{1,2})日?\s*' + SEP + r'\s*(?:無料)?(?:公開|配信)', t)
    if m:
        return {'start': _date(*m.groups()), 'end': None, 'raw': m.group(0), 'kind': 'from'}
    m = re.search(r'(\d{1,2})/(\d{1,2})\s*' + SEP + r'\s*(?:無料)?(?:公開|配信)', t)
    if m:
        mo, d = m.groups()
        return {'start': _date(year_for(mo), mo, d), 'end': None, 'raw': m.group(0), 'kind': 'from'}
    m = re.search(r'(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日[^\n]{0,12}?まで[^\n]{0,8}?(?:公開|配信|視聴)', t)
    if m:
        y, mo, d = m.groups()
        return {'start': None, 'end': _date(y or year_for(mo), mo, d), 'raw': m.group(0), 'kind': 'until'}
    # «1週間限定無料配信»·«2週間限定»·«半年間限定» — 공개일부터 센다(国際放映·新東宝)
    m = re.search(r'(半年間?|\d+)\s*(週間|ヶ月|か月|カ月|日間|年間)?\s*限定', t)
    if m and (m.group(1).startswith('半年') or m.group(2)):
        n = 1 if m.group(1).startswith('半年') else int(m.group(1))
        days = {'週間': 7 * n, 'ヶ月': 30 * n, 'か月': 30 * n, 'カ月': 30 * n, '日間': n, '年間': 365 * n}.get(m.group(2) or '', 0)
        if m.group(1).startswith('半年'):
            days = 182
        return {'start': pub, 'end': pub + dt.timedelta(days=days), 'raw': m.group(0), 'kind': 'window'}
    m = re.search(r'【?年内限定】?', t)
    if m:
        return {'start': None, 'end': dt.date(pub.year, 12, 31), 'raw': m.group(0), 'kind': 'until'}
    if re.search(r'常時無料公開|常時公開', t):
        return {'start': None, 'end': None, 'raw': '常時無料公開', 'kind': 'always'}
    if re.search(r'期間限定|限定公開', t):
        return {'start': None, 'end': None, 'raw': re.search(r'[^\n]{0,20}(?:期間限定|限定公開)[^\n]{0,20}', t).group(0),
                'kind': 'unknown'}
    return {'start': None, 'end': None, 'raw': '', 'kind': 'none'}


def window_status(w, today):
    if w['kind'] == 'none':
        return '기한 표기 없음'
    if w['kind'] == 'always':
        return '상시 공개'
    if w['kind'] == 'unknown':
        return '기간 미상(사람 확인)'
    if w['end'] and w['end'] < today:
        return '기간 경과'
    if w['end']:
        return '공개 중 · %s까지(%d일 남음)' % (w['end'].isoformat(), (w['end'] - today).days)
    return '기한 없음(%s부터)' % (w['start'].isoformat() if w['start'] else '?')


def region_kr(cd):
    rr = (cd or {}).get('regionRestriction') or {}
    if 'allowed' in rr:
        return 'KR' in rr['allowed'], 'allowed=' + ','.join(rr['allowed'][:5])
    if 'blocked' in rr:
        return 'KR' not in rr['blocked'], 'blocked=' + ','.join(rr['blocked'][:5])
    return True, '제한 없음'


def fetch_channel(ch, key, mx):
    up = 'UU' + ch['id'][2:]
    ids, token = [], None
    while len(ids) < mx:
        r = api('playlistItems', part='contentDetails', playlistId=up, maxResults=50, key=key, **({'pageToken': token} if token else {}))
        ids += [i['contentDetails']['videoId'] for i in r.get('items', [])]
        token = r.get('nextPageToken')
        if not token:
            break
    vids = []
    for i in range(0, len(ids[:mx]), 50):
        r = api('videos', part='snippet,contentDetails', id=','.join(ids[i:i + 50]), key=key)
        vids += r.get('items', [])
    return vids


def run(mx=100, today=None):
    conf = json.loads(CONF.read_text(encoding='utf-8'))
    key = env_key()
    if not key:
        raise SystemExit(2)
    today = today or dt.datetime.now(JST).date()
    OUT.mkdir(parents=True, exist_ok=True)
    sp = OUT / 'state.json'
    state = json.loads(sp.read_text(encoding='utf-8')) if sp.exists() else {}
    first = not state
    rows = []
    # ★결 우선 — thread_report 실측(近衛十四郎 91%·暴れん坊将軍 75%, 10-16). C 가 설정 파일에 더한다
    prio = [k for k in conf.get('priority_keywords', []) if k]
    for ch in conf['channels']:
        ch_first = ch['id'] not in state  # 새로 더한 채널은 그 채널만 기준선으로 잡는다
        seen = state.setdefault(ch['id'], {})
        inc = re.compile(ch['include']) if ch.get('include') else None  # AMG 처럼 時代劇만 볼 채널
        for v in fetch_channel(ch, key, mx):
            sn, cd = v['snippet'], v['contentDetails']
            if inc and not inc.search(sn['title']):
                continue
            mins = iso_minutes(cd.get('duration'))
            # 松竹은 창을 제목에 적는다(«※10/14-10/27無料公開») — 제목을 먼저 본다
            w = parse_window(sn['title'] + '\n' + sn.get('description', ''), sn.get('publishedAt', ''))
            ok_kr, region = region_kr(cd)
            new = v['id'] not in seen
            seen.setdefault(v['id'], today.isoformat())
            rows.append({'channel': ch['name'], 'id': v['id'], 'title': sn['title'], 'published': sn['publishedAt'][:10],
                         'minutes': round(mins, 1), 'feature': mins >= conf.get('min_minutes', 20),
                         'kr_visible': ok_kr, 'region': region, 'window': {k: (x.isoformat() if isinstance(x, dt.date) else x)
                                                                           for k, x in w.items()},
                         'status': window_status(w, today), 'new': new and not ch_first,
                         'priority': [k for k in prio if k in sn['title'] or k in sn.get('description', '')]})
    sp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return rows, first, today


def report(rows, first, today):
    feat = [r for r in rows if r['feature']]
    star = lambda r: '★결 우선(%s) ' % '·'.join(r['priority']) if r.get('priority') else ''  # noqa: E731
    new = sorted([r for r in feat if r['new']], key=lambda r: not r.get('priority'))
    usable = [r for r in feat if r['kr_visible'] and r['status'] not in ('기간 경과',)]
    lines = ['# 時代劇 공식 채널 감시 %s%s' % (today.isoformat(), ' (기준선 첫 실행)' if first else ''), '']
    lines.append('본편(%d분+) %d편 · 새로 공개 %d편 · 한국에서 보이고 기간 안 지난 것 %d편 · 기간 경과 %d편 · JP 한정 등 %d편'
                 % (20, len(feat), len(new), len(usable), sum(r['status'] == '기간 경과' for r in feat),
                    sum(not r['kr_visible'] for r in feat)))
    lines.append('')
    if new:
        lines.append('## 새로 공개')
        for r in new:
            lines.append('- %s[%s] %s (%s분) %s · %s · %s · ID %s · https://youtu.be/%s' % (
                star(r), r['channel'], r['title'], r['minutes'], r['published'], r['status'],
                '한국 OK' if r['kr_visible'] else '소재 아님(%s)' % r['region'], r['id'], r['id']))
        lines.append('')
    soon = sorted([r for r in usable if r['window'].get('end')], key=lambda r: (not r.get('priority'), r['window']['end']))
    if soon:
        lines.append('## 끝나는 날이 있는 공개 중 본편(빠른 순)')
        for r in soon[:30]:
            lines.append('- %s[%s] %s · %s · ID %s · https://youtu.be/%s' % (star(r), r['channel'], r['title'][:60], r['status'], r['id'], r['id']))
        lines.append('')
    unk = [r for r in feat if r['status'].startswith('기간 미상')]
    if unk:
        lines.append('## 기간 미상 — 설명란을 사람이 확인')
        for r in unk[:20]:
            lines.append('- [%s] %s · «%s» · ID %s · https://youtu.be/%s' % (r['channel'], r['title'][:60], r['window']['raw'], r['id'], r['id']))
        lines.append('')
    lines.append('※ 받지 않았다. 컷 밀도는 받은 뒤 화면검사로 잰다. 기간 경과 편의 사용 여부는 소유주 결정 대기.')
    return '\n'.join(lines) + '\n'


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--max', type=int, default=100, help='채널마다 최근 몇 편까지 볼지')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    rows, first, today = run(a.max)
    md = report(rows, first, today)
    (OUT / ('%s.md' % today.isoformat())).write_text(md, encoding='utf-8')
    (OUT / ('%s.json' % today.isoformat())).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(rows, ensure_ascii=False, indent=2) if a.json else md)


if __name__ == '__main__':
    main()
