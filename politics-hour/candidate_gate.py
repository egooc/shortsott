# -*- coding: utf-8 -*-
"""후보표 관문 — 원고 착수 전(10/21편부터, 관리자 10-20 Z12·Z7).

    python politics-hour/candidate_gate.py <에피소드 폴더> [--fill]   --fill: 공용 news_outliers 결과로 빈 news_outlier 칸 채운 뒤 검사

<편>/keywords.json 의 "candidates" 목록이 있어야 하고, 행마다 아래 칸이 비어 있지 않아야 한다:
  keyword        후보 낱말
  rising_score   rising_keywords 상승 점수(숫자)
  excerpt        우리 진영 토크쇼·토론 발췌(출처·영상 ID) — 없으면 "없음" 이 아니라 후보에서 뺀다
  emotion_now    Z7 «지금 우리 진영 시청자가 대신 느끼려는 감정» 한 문장(인물 기준)
  comment_count  Z12 네이버 «댓글 많은 뉴스» 댓글 수(숫자, 뉴스 기사 commentCount)
  reason         선택·탈락 사유
  news_outlier   뉴스 채널 아웃라이어(소유주 10-20 «뉴스 채널 롱폼에서 터진 것이 알고리즘 신호»): 최근 24~48h 정치 소재 편 중
                 채널 최근 30편 조회 중앙값 대비 ≥3배 — [{channel, video_id, views, ratio, title_words, thumb_words, kind(long|shorts)}]
                 찾아봤는데 없으면 {"none": "본 채널 묶음·시각"} 로 적는다(빈칸은 FAIL). 포장엔 낱말을 신호로만, 복제 금지.
  vicarious      (10/23편부터, G15) {"type": 집단 공감|감정 대변|상식 회복|권력 역전, "comments": 본문+댓글에서 읽은 반응·농담,
                 "essence": 대리만족 한 문장} — 원고는 이 본질에서 쓴다. 댓글 속 농담은 대변 장치로, 위치 역전은 결말에.
하나라도 빠지면 exit 3 — 원고(script_*.py)를 쓰지 않는다. upload_gate 도 이 검사를 다시 돈다.
"""
import json
import re
import sys
from pathlib import Path

NEED = ('keyword', 'rising_score', 'excerpt', 'emotion_now', 'comment_count', 'reason', 'news_outlier')
OUT_KEYS = ('channel', 'video_id', 'views', 'ratio', 'title_words', 'thumb_words')
NUM = ('rising_score', 'comment_count')
FROM = '20261021'   # 이 날짜 편부터 요구한다
# 대리만족 유형(큰제로 07-18, 관리자 G15 10-21): 소재 → 본문+댓글 파악 → 본질(대리만족 한 문장) → 대본. 10/23편부터.
VICARIOUS = ('집단 공감', '감정 대변', '상식 회복', '권력 역전')
VIC_FROM = '20261023'
# 소유주 10-22 «비슷한 롱폼 채널 중 터진 게 있나 레퍼런스 확인하고 주제를 잡고»: 고른 주제(keywords 에 든 행)는 news_outlier 에
# kind=long·ratio≥3 편이 하나 이상 있어야 한다. {"none"} 이거나 쇼츠뿐이면 그 주제는 탈락. 10/23편부터.
REF_FROM = '20261023'


def target_sec(ep):
    """목표 길이(초): 기본 약 10분(600). 고른 주제의 레퍼런스(kind=long·×3) 중 가장 짧은 편이 20분 이상이면 그 길이(소유주 10-22 «추천대로»)."""
    kp = Path(ep) / 'keywords.json'
    if not kp.exists():
        return 600, None
    kd = json.loads(kp.read_text(encoding='utf-8'))
    picked = set(kd.get('keywords') or [])
    refs = [o for r in kd.get('candidates') or [] if r.get('keyword') in picked and isinstance(r.get('news_outlier'), list)
            for o in r['news_outlier'] if isinstance(o, dict) and o.get('kind') == 'long' and isinstance(o.get('sec'), (int, float))
            and o['sec'] <= 3600]   # 1시간 넘는 편은 생방송 다시보기(10-22 실측 6ukOlHpL-QM 5.4시간) — 길이 기준에서 뺀다
    top = min(refs, key=lambda o: o['sec'], default=None)   # 가장 짧은 터진 편(관리자 10-22 21:5x 정정, «억지로 늘리지 말고»)
    return (top['sec'] if top and top['sec'] >= 1200 else 600), top


def ep_date(ep, uploads=()):
    """편 날짜 YYYYMMDD — upload.json 의 date·publish_at·publishAt·status.publishAt → 폴더 이름(8자리) → keywords.json at.
    못 읽으면 '99999999'(새 편으로 보고 규칙을 다 건다 — 임시 폴더에서 규칙이 빠지지 않게, 관리자 10-20 정치JA)."""
    ep = Path(ep)
    for up in [*uploads, ep / 'upload.json']:
        try:
            u = json.loads(Path(up).read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(u, dict):
            continue
        for v in (u.get('date'), u.get('publish_at'), u.get('publishAt'), (u['status'] if isinstance(u.get('status'), dict) else {}).get('publishAt')):
            m = re.match(r'(\d{4})-?(\d{2})-?(\d{2})', str(v or ''))
            if m:
                return ''.join(m.groups())
    if re.fullmatch(r'\d{8}', ep.name):
        return ep.name
    try:
        m = re.match(r'(\d{4})-?(\d{2})-?(\d{2})', json.loads((ep / 'keywords.json').read_text(encoding='utf-8')).get('at', ''))
        if m:
            return ''.join(m.groups())
    except Exception:
        pass
    return '99999999'


def gate_lines(ep, uploads=()):
    ep = Path(ep)
    if ep_date(ep, uploads) < FROM:
        return []
    kp = ep / 'keywords.json'
    if not kp.exists():
        return [f'후보표: keywords.json 없음 {kp}']
    kd = json.loads(kp.read_text(encoding='utf-8'))
    rows = kd.get('candidates') or []
    picked = set(kd.get('keywords') or [])
    if not rows:
        return ['후보표: keywords.json 에 candidates 없음(상승 점수·발췌·지금의 감정·댓글 수·사유·뉴스 아웃라이어) — 원고 착수 금지']
    bad = []
    for i, r in enumerate(rows):
        lost = [k for k in NEED if r.get(k) in (None, '', [])]
        lost += [k for k in NUM if k not in lost and not isinstance(r.get(k), (int, float))]
        no = r.get('news_outlier')
        if 'news_outlier' not in lost and not (isinstance(no, dict) and str(no.get('none', '')).strip()):
            rows_o = no if isinstance(no, list) else [no]
            # thumb_words 는 빈 목록도 받는다(썸네일 판독은 GPT 하루 10장 한도 — yt_news_outliers --thumbs 를 꼭 필요한 편만)
            if not rows_o or any(not isinstance(o, dict) or [k for k in OUT_KEYS if o.get(k) in ((None, '') if k == 'thumb_words' else (None, '', []))]
                                 for o in rows_o):
                lost.append('news_outlier(' + '·'.join(OUT_KEYS) + ' 또는 {"none": 사유})')
            elif any(not isinstance(o.get('ratio'), (int, float)) or o['ratio'] < 3 for o in rows_o):
                lost.append('news_outlier ratio ≥3 아님')
        if ep_date(ep, uploads) >= REF_FROM and r.get('keyword') in picked:
            longs = [o for o in (no if isinstance(no, list) else []) if isinstance(o, dict) and o.get('kind') == 'long'
                     and isinstance(o.get('ratio'), (int, float)) and o['ratio'] >= 3]
            if not longs:
                lost.append('고른 주제인데 비슷한 롱폼 채널의 터진 편(kind=long·채널 중앙값 ×3 이상) 없음 — 탈락시키고 keywords 에서 빼라')
        if ep_date(ep, uploads) >= VIC_FROM:
            v = r.get('vicarious')
            if not isinstance(v, dict) or v.get('type') not in VICARIOUS or not str(v.get('essence', '')).strip() or not str(v.get('comments', '')).strip():
                lost.append('vicarious({"type": ' + '|'.join(VICARIOUS) + ', "comments": 댓글에서 읽은 반응·농담, "essence": 대리만족 한 문장})')
        if lost:
            bad.append(f'후보표 {i}번 «{r.get("keyword", "?")}»: {", ".join(lost)} 비었거나 맞지 않음')
    bad += villain_lines(ep, kd, uploads)
    return bad


# 소유주 10-23 «정치 쪽은 항상 빌런을 찾아서 빌런을 계속 파야 돼. 야당 여당 상관없이» — 편마다 빌런 한 명,
# keywords.json "villain": {"name": 인물, "issue": 이어 파는 이슈, "why": 댓글이 그를 미워하는 이유(실측 반응), "since": 처음 판 편 날짜}.
# 빌런 = keywords 1순위 = 썸네일 1순위 낱말(그래서 제목 맨 앞·해시태그에도 들어간다). 전 편 빌런을 버리면 "switch": 사유 필수.
VILLAIN_FROM = '20261024'


def villain_lines(ep, kd, uploads=()):
    if ep_date(ep, uploads) < VILLAIN_FROM:
        return []
    v = kd.get('villain')
    if not isinstance(v, dict) or not str(v.get('name', '')).strip() or not str(v.get('why', '')).strip():
        return ['빌런: keywords.json "villain": {"name", "why"(댓글 반응), "since"} 없음 — 여야 상관없이 한 명을 정해 계속 판다']
    bad, name = [], v['name'].strip()
    if (kd.get('keywords') or [''])[0] != name:
        bad.append(f'빌런 «{name}» 이 keywords 1순위가 아님')
    if (kd.get('thumb') or [''])[0] != name:
        bad.append(f'빌런 «{name}» 이 썸네일 1순위(thumb[0])가 아님')
    prev = sorted(p for p in ep.parent.glob('2026*/keywords.json') if p.parent.name < ep.name)
    pv = next((json.loads(p.read_text(encoding='utf-8')).get('villain') for p in reversed(prev)
               if isinstance(json.loads(p.read_text(encoding='utf-8')).get('villain'), dict)), None)
    # 소유주 10-23 «빌런들이 키워드에 분명히 올라와 있다 — 구글 트렌드·네이버 트렌드에서 왜 안 찾냐» — 빌런은 상승 검색어 표(rising_keywords politics_ko) 상위 5위 안에서
    rk = Path(__file__).resolve().parents[1] / 'server' / 'data' / 'rising_keywords' / 'politics_ko_latest.json'
    if rk.exists():
        top = [r['keyword'] for r in sorted(json.loads(rk.read_text(encoding='utf-8')).get('rows') or [], key=lambda r: -(r.get('rising_score') or 0))][:5]
        if name not in top and name not in (v.get('rising_top5') or []):
            bad.append(f'빌런 «{name}» 이 상승 검색어 상위 5위({" · ".join(top)}) 밖 — 표에서 사람을 골라라')
    else:
        bad.append('상승 검색어 표 없음 — node scripts/rising_keywords.js --lane politics_ko 먼저')
    # 소유주 10-23 «이슈 하나 잡아서 꾸준히 가라고, 꾸준히» — villain.issue(예: «소방 재정 빨대») 도 전 편과 같아야 한다, 바꾸면 switch 사유
    if not str(v.get('issue', '')).strip():
        bad.append(f'빌런 «{name}»: "issue"(이어 파는 이슈 한 줄) 없음')
    elif pv and pv.get('name') == name and pv.get('issue') and pv.get('issue') != v['issue'] and not str(v.get('switch', '')).strip():
        bad.append(f'전 편 이슈 «{pv.get("issue")}» 를 버렸다 — 계속 파거나 "switch": 사유(조회·검색어 실측)')
    if pv and pv.get('name') != name and not str(v.get('switch', '')).strip():
        bad.append(f'전 편 빌런 «{pv.get("name")}» 을 버렸다 — 계속 파거나 "switch": 사유(조회·댓글 실측)')
    return bad


NEWS = Path(__file__).resolve().parents[1] / 'server' / 'data' / 'news_outliers' / 'politics_ko_latest.json'


def fill(ep):
    """공용 yt_news_outliers.js 결과(관리자 10-20, e274987)를 후보행 news_outlier 로 옮긴다 — 이미 적힌 칸은 안 건드린다.
    후보 낱말(공백 무시)이 아웃라이어 keyword·title_words 와 겹치면 그 편들(video_id 중복 제거, 배수 큰 순 3편), 없으면 {none}."""
    kp = Path(ep) / 'keywords.json'
    k = json.loads(kp.read_text(encoding='utf-8'))
    d = json.loads(NEWS.read_text(encoding='utf-8'))
    sq = lambda x: re.sub(r'\s', '', str(x))
    sec = {o['video_id']: o.get('sec') for o in d.get('outliers', [])}
    n = 0
    for r in k.get('candidates', []):
        if r.get('news_outlier'):
            continue
        kw = sq(r.get('keyword', ''))
        hits = {}
        for c in d.get('candidates', []):
            o = c['news_outlier']
            if kw and (kw in sq(c['keyword']) or sq(c['keyword']) in kw or any(kw in sq(w) for w in o.get('title_words', []))):
                hits.setdefault(o['video_id'], o)
        for o in hits.values():   # 길이로 롱폼·쇼츠 표시(10/23부터 고른 주제는 kind=long 이 있어야 한다)
            s = sec.get(o['video_id'])
            if s is not None and 'kind' not in o:
                o['kind'] = 'long' if s > 180 else 'shorts'
            if s is not None:
                o.setdefault('sec', s)   # 레퍼런스 길이 — 20분 이상이면 그 길이를 따른다(upload_gate 길이 관문)
        r['news_outlier'] = sorted(hits.values(), key=lambda o: (o.get('kind') != 'long', -o['ratio']))[:3] or {'none': f'yt_news_outliers {d.get("at")} {len(d.get("channels", []))}채널 해당 없음'}
        n += 1
    kp.write_text(json.dumps(k, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return n


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if '--fill' in sys.argv:
        print(f'[candidate] news_outlier 채움 {fill(sys.argv[1])}행 ← {NEWS}')
    b = gate_lines(sys.argv[1])
    for x in b:
        print('[candidate] FAIL', x)
    if b:
        sys.exit(3)
    print('[candidate] PASS', Path(sys.argv[1]).name)
