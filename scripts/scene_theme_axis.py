# -*- coding: utf-8 -*-
"""«어느 장면»을 고를지의 기준 — 상황 축으로 레퍼런스와 우리 영상을 함께 잰다.

    python scripts/scene_theme_axis.py              레퍼런스 652편 + 우리 영상을 잰다
    python scripts/scene_theme_axis.py --ours-only  우리 영상만
    python scripts/scene_theme_axis.py --locale ko  언어 고정(설명문 언어가 섞이면 집단이 왜곡된다)

왜 (2026-10-01, 사례 160 · 소유주 지시로 외부 글에서 뽑아낸 것)
  우리는 **작품**을 안전(`alive_clips.grade`)으로 고른다. 그런데 **그 작품 안에서
  어느 장면을 자를지**는 vision map 과 story arc 가 정하고 «수요» 기준이 없다.
  한 번도 재 본 적이 없는 축이다.

  레퍼런스 원고 652편에 상황 축을 붙여 보니 (전체 조회 중앙 317만):
  ```
  차별·편견      12,237,644 (3.83배)   …   병원·응급 6,459,743 (2.02배)
  어디에도 안 걸림  1,596,902 (0.50배)
  ```
  **어느 상황이 1등이냐가 요점이 아니다.** «알아볼 수 있는 일상 갈등 자리에 있느냐»가
  넷 중 하나로 가른다. 우리 ko 19편도 같은 방향이었다(걸림 305/일 · 안 걸림 115/일).

★언어를 섞지 마라. ja 설명문은 한국어 정규식에 안 걸려 «안 걸림» 집단으로 쏠린다 —
  첫 판에서 그렇게 ja 최고 성과작이 «안 걸림»에 들어가 집단을 부풀렸다.
★우리 표본은 19편이다. 방향만 본다. 근거의 무게는 레퍼런스 652편 쪽에 있다.
"""
import argparse
import io
import json
import os
import re
import statistics as st
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, 'server', 'data', 'narration_probe.json')
METRICS = os.path.join(ROOT, 'server', 'data', 'youtube_metrics.json')
CARDS = os.path.join(ROOT, 'server', 'data', 'youtube_upload_cards.json')

# 상황 축 — 영화 제목이 아니라 «장면이 벌어지는 자리»다. 652편을 읽고 뽑았다.
THEMES = {
    '차별·편견':      (r"racist|where are you from|speak english|immigrant|accent|black people|white people",
                      r"차별|인종|편견|무시당|이민|흑인|외국인|피부색"),
    '노숙자·빈곤':    (r"homeless|spare some|shelter|beg|food stamp|can you share any change",
                      r"노숙|구걸|적선|끼니|굶|가난|보육원"),
    '교실·훈육 모욕': (r"\bclass\b|teacher|student|homework|principal|detention|dumbest|\bexam\b|school",
                      r"학교|교실|선생|교사|학생|수업|숙제|시험|성적|교장|학위|하버드"),
    '직장·면접·해고': (r"interview|hired|fired|\bboss\b|resign|paycheck|promotion|looking for work",
                      r"면접|해고|상사|직장|회사|사장|월급|퇴사|승진|실직"),
    '서비스업 응대':   (r"\btable\b|\border\b|menu|kitchen|\bchef\b|waiter|waitress|cashier|convenience|customer|fries",
                      r"식당|가게|편의점|배달|주문|메뉴|손님|점원|계산|요리사|카페"),
    '교도소·수감':    (r"inmate|prison|cell block|parole|warden|\bjail\b",
                      r"교도소|수감|감옥|죄수|간수|가석방|복역"),
    '법정·경찰':      (r"lawyer|attorney|judge|court|\bsue\b|officer|police|arrest|your honor|testify",
                      r"법정|변호사|판사|고소|재판|경찰|체포|형사|수사|증언"),
    '무례·진상':      (r"excuse me|you hit my|delete it|get out of here|who do you think you are|\brude\b|manager|refund",
                      r"무례|진상|갑질|새치기|반말|행패|시비|따지"),
    '동물·반려견':    (r"\bdog\b|puppy|\bcat\b|animal|leash|\bvet\b",
                      r"강아지|반려견|고양이|동물|유기견"),
    '장애·질병':      (r"wheelchair|blind|deaf|autis|disabled|down syndrome|cerebral|cancer|tumor|seizure",
                      r"장애|휠체어|자폐|다운증후군|시각장애|청각"),
    '가족 갈등':      (r"\bdad\b|\bmom\b|father|mother|\bson\b|daughter|grandpa|grandma|parent",
                      r"아빠|엄마|아버지|어머니|아들|딸|할머니|할아버지|부모|가족"),
    '병원·응급':      (r"doctor|nurse|hospital|surgery|surgeon|breathe|choking|contraction|donor|patient|ambulance",
                      r"병원|의사|간호사|수술|응급|환자|진단|이식|기증|호흡|구급"),
}


def read_json(p, fb):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fb


def tags(text, ko=False):
    t = (text or '').lower()
    return [k for k, (en, kr) in THEMES.items() if re.search(kr if ko else en, t)]


def med(xs):
    return st.median(xs) if xs else 0.0


def reference():
    rows = [r for r in read_json(PROBE, {}).values() if r.get('text') and r.get('views')]
    if not rows:
        print('레퍼런스 원고가 없다 — whitelist_from_narration.py 로 먼저 모아라')
        return
    allmed = med([r['views'] for r in rows])
    hit = defaultdict(list)
    none = []
    for r in rows:
        ts = tags(r['text'])
        if not ts:
            none.append(r)
        for k in ts:
            hit[k].append(r)
    print(f'레퍼런스 {len(rows)}편 · 전체 조회 중앙 {allmed:,.0f}')
    print(f"\n{'상황':20} {'편수':>5} {'중앙 조회':>13} {'배수':>6} {'채널':>5}")
    for k, g in sorted(hit.items(), key=lambda kv: -med([x['views'] for x in kv[1]])):
        m = med([x['views'] for x in g])
        print(f"  {k:18} {len(g):>5} {m:>13,.0f} {m/allmed:>6.2f} {len({x['channel'] for x in g}):>5}")
    m0 = med([x['views'] for x in none])
    print(f"  {'어디에도 안 걸림':18} {len(none):>5} {m0:>13,.0f} {m0/allmed:>6.2f}")
    print('\n→ 어느 상황이 1등이냐가 아니라 «걸리느냐»가 가른다.')


def ours(locale):
    m = read_json(METRICS, {})
    cards = read_json(CARDS, [])
    cl = cards if isinstance(cards, list) else (cards.get('cards') or list(cards.values()))
    byvid = {c['youtubeVideoId']: c for c in cl if c.get('youtubeVideoId')}
    last = {}
    for s in m.get('snapshots', []):
        for r in s['rows']:
            last[r['videoId']] = r
    pub = [r for r in last.values()
           if r['privacy'] == 'public' and r.get('ageDays', 0) >= 2
           and (not locale or r['locale'] == locale)]
    if not pub:
        print('잴 영상이 없다')
        return
    ko = (locale or 'ko') == 'ko'
    hit, miss, per = [], [], defaultdict(list)
    for r in pub:
        txt = (r['title'] or '') + ' ' + ((byvid.get(r['videoId']) or {}).get('description') or '')
        ts = tags(txt, ko=ko)
        (hit if ts else miss).append(r)
        for k in ts:
            per[k].append(r['viewsPerDay'])
    lab = locale or '전체'
    print(f'\n우리 공개 영상 {len(pub)}편 ({lab})')
    print(f'  상황 축에 걸림 {len(hit):>3}편 · 중앙 {med([x["viewsPerDay"] for x in hit]):>6.0f}/일')
    print(f'  안 걸림       {len(miss):>3}편 · 중앙 {med([x["viewsPerDay"] for x in miss]):>6.0f}/일')
    print(f"\n{'상황':20} {'우리 편수':>7} {'중앙 일조회':>10}")
    for k in THEMES:
        v = per.get(k, [])
        mark = '   ← 한 편도 없다' if not v else ''
        print(f"  {k:18} {len(v):>7} {med(v):>10.0f}{mark}")
    if not locale:
        print('\n★언어를 섞어 쟀다. 설명문 언어가 다르면 «안 걸림»으로 쏠린다 — --locale ko 로 다시 봐라.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ours-only', action='store_true')
    ap.add_argument('--locale', default='')
    args = ap.parse_args()
    if not args.ours_only:
        reference()
    ours(args.locale)
    return 0


if __name__ == '__main__':
    sys.exit(main())
