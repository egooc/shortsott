# 네이버 데이터랩 검색어 트렌드로 쇼핑 후보 키워드의 주간 추세를 본다.
#
#   python scripts/naver_trend.py "틈새청소솔=틈새청소솔,침대밑 청소" "가습기청소=가습기 청소,가습기청소" [--weeks 16]
#
# 키: ~/.volcano/keys/naver_hub_id · naver_hub_secret (볼케이노와 같은 자리, 네이버 개발자센터 앱)
# 값은 요청한 그룹들 사이의 상대값(최고=100)이다 — 한 번에 넣은 그룹끼리만 비교된다. 최대 5그룹.
# 마지막 주가 진행 중이면 값이 낮게 나오므로 완결된 주만 쓴다.
import argparse, datetime, json, sys, urllib.request
from pathlib import Path

K = Path.home() / '.volcano' / 'keys'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('groups', nargs='+', help='이름=키워드1,키워드2')
    ap.add_argument('--weeks', type=int, default=16)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    today = datetime.date.today()
    last_sunday = today - datetime.timedelta(days=today.isoweekday() % 7 or 7)   # 완결된 주의 끝
    start = last_sunday - datetime.timedelta(weeks=a.weeks) + datetime.timedelta(days=1)
    groups = []
    for g in a.groups[:5]:
        name, kws = g.split('=', 1)
        groups.append({'groupName': name, 'keywords': [k.strip() for k in kws.split(',') if k.strip()]})
    body = {'startDate': start.isoformat(), 'endDate': last_sunday.isoformat(), 'timeUnit': 'week', 'keywordGroups': groups}
    req = urllib.request.Request('https://openapi.naver.com/v1/datalab/search', data=json.dumps(body).encode(),
                                 headers={'X-Naver-Client-Id': (K / 'naver_hub_id').read_text().strip(),
                                          'X-Naver-Client-Secret': (K / 'naver_hub_secret').read_text().strip(),
                                          'Content-Type': 'application/json'})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    print(f'{start} ~ {last_sunday} (주간, 그룹 간 상대값)')
    for g in r['results']:
        pts = [p['ratio'] for p in g['data']]
        if len(pts) < 8:
            print(g['title'], '데이터 부족')
            continue
        recent, prev = sum(pts[-4:]) / 4, sum(pts[-8:-4]) / 4
        trend = (recent - prev) / prev * 100 if prev else 0
        bar = ''.join('▁▂▃▄▅▆▇█'[min(7, int(p / 12.5))] for p in pts)
        print(f"{g['title']:<10} {bar}  최근4주 평균 {recent:5.1f} · 직전4주 대비 {trend:+5.0f}%")


if __name__ == '__main__':
    main()
