# -*- coding: utf-8 -*-
"""후보표 관문 — 원고 착수 전(10/21편부터, 관리자 10-20 Z12·Z7).

    python politics-hour/candidate_gate.py <에피소드 폴더>

<편>/keywords.json 의 "candidates" 목록이 있어야 하고, 행마다 아래 칸이 비어 있지 않아야 한다:
  keyword        후보 낱말
  rising_score   rising_keywords 상승 점수(숫자)
  excerpt        우리 진영 토크쇼·토론 발췌(출처·영상 ID) — 없으면 "없음" 이 아니라 후보에서 뺀다
  emotion_now    Z7 «지금 우리 진영 시청자가 대신 느끼려는 감정» 한 문장(인물 기준)
  comment_count  Z12 네이버 «댓글 많은 뉴스» 댓글 수(숫자, 뉴스 기사 commentCount)
  reason         선택·탈락 사유
하나라도 빠지면 exit 3 — 원고(script_*.py)를 쓰지 않는다. upload_gate 도 이 검사를 다시 돈다.
"""
import json
import re
import sys
from pathlib import Path

NEED = ('keyword', 'rising_score', 'excerpt', 'emotion_now', 'comment_count', 'reason')
NUM = ('rising_score', 'comment_count')
FROM = '20261021'   # 이 날짜 편부터 요구한다


def ep_date(ep, uploads=()):
    """편 날짜 YYYYMMDD — upload.json 의 date·publish_at·publishAt·status.publishAt → 폴더 이름(8자리) → keywords.json at.
    못 읽으면 '99999999'(새 편으로 보고 규칙을 다 건다 — 임시 폴더에서 규칙이 빠지지 않게, 관리자 10-20 정치JA)."""
    ep = Path(ep)
    for up in [*uploads, ep / 'upload.json']:
        try:
            u = json.loads(Path(up).read_text(encoding='utf-8'))
        except Exception:
            continue
        for v in (u.get('date'), u.get('publish_at'), u.get('publishAt'), (u.get('status') or {}).get('publishAt')):
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
    rows = json.loads(kp.read_text(encoding='utf-8')).get('candidates') or []
    if not rows:
        return ['후보표: keywords.json 에 candidates 없음(상승 점수·발췌·지금의 감정·댓글 수·사유) — 원고 착수 금지']
    bad = []
    for i, r in enumerate(rows):
        lost = [k for k in NEED if r.get(k) in (None, '', [])]
        lost += [k for k in NUM if k not in lost and not isinstance(r.get(k), (int, float))]
        if lost:
            bad.append(f'후보표 {i}번 «{r.get("keyword", "?")}»: {", ".join(lost)} 비었거나 숫자 아님')
    return bad


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    b = gate_lines(sys.argv[1])
    for x in b:
        print('[candidate] FAIL', x)
    if b:
        sys.exit(3)
    print('[candidate] PASS', Path(sys.argv[1]).name)
