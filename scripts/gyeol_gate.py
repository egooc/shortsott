"""결 표 관문 — 결 표 없는 렌더·발행을 막는다(소유주 «결분석 다 잡고 가자», 관리자 배정 10-29).

  python -X utf8 scripts/gyeol_gate.py <작업 폴더 | 결 표 파일> [--strict] [--json]

작업 폴더에서 gyeol_table.md 또는 gyeol_table.json 을 찾아 세 가지를 본다.
  ① 레퍼런스 출처 — docs/gyeol-analysis-*.md(§ 번호) 또는 가이드 파일(…GUIDE….md, docs/…/*.md), 또는 «레퍼런스: <주소·영상 id>» 줄
  ② «초·결·우리 장면» 3열 표, 초가 읽히는 줄 4개 이상(초는 12.3 · 12.3s · 12초 · 1:05 꼴)
  ③ 반전 장면의 초(결 칸에 반전·뒤집기·전환, «…예고» 줄은 빼고) + 약속 장면의 초(결 칸에 약속·최종 답·정점·회수, 또는 본문 «약속 … 15:42» 꼴)
JSON 꼴: {"reference": "...", "rows": [{"t": 12.3, "gyeol": "반전", "scene": "..."}...]}

종료 코드: 0 통과 · 4 결 표 없음/항목 빠짐 · 5 결 표를 읽지 못함(표·JSON 형식 아님).
enforce_from(아래 ENFORCE_FROM, KST) 전에는 4·5 대신 경고만 찍고 0 — --strict 면 날짜와 상관없이 막는다.
레인 연결: 렌더·발행 스크립트 앞에 한 줄 — `python -X utf8 D:/midform/scripts/gyeol_gate.py <작업 폴더> || exit /b`
"""
import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

ENFORCE_FROM = '2026-10-31T00:00:00+09:00'
NAMES = ('gyeol_table.md', 'gyeol_table.json')
REF = re.compile(r'docs/gyeol-analysis[-\w]*\.md|[\w/.-]*GUIDE[\w-]*\.md|docs/[\w/-]+\.md|레퍼런스\s*[:：]\s*\S+', re.I)
TURN = re.compile(r'반전|뒤집|전환|turn|reveal', re.I)
PROMISE = re.compile(r'약속|최종\s*답|정점|회수|payoff', re.I)
PROMISE_TEXT = re.compile(r'약속[^\n|]{0,40}?(\d{1,2}:\d{2}|\d+(?:\.\d+)?\s*(?:초|s)\b)')


def sec(v):
    v = str(v).strip()
    m = re.fullmatch(r'(\d{1,2}):(\d{2}(?:\.\d+)?)', v)
    if m:
        return int(m.group(1)) * 60 + float(m.group(2))
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(?:s|초)?', v)
    return float(m.group(1)) if m else None


def find(target):
    p = Path(target)
    if p.is_file():
        return p
    for n in NAMES:
        if (p / n).is_file():
            return p / n
    return None


def md_rows(text):
    """마크다운 표들에서 (초, 결, 장면) 줄. 머리줄에 초·결·장면(또는 대사·scene) 열이 다 있는 표만."""
    rows, tables, lines = [], 0, text.splitlines()
    for i in range(len(lines) - 1):
        if not (lines[i].strip().startswith('|') and re.match(r'^\s*\|[\s:|-]+\|\s*$', lines[i + 1])):
            continue
        head = [c.strip() for c in lines[i].strip().strip('|').split('|')]
        col = lambda keys: next((k for k, h in enumerate(head) if any(x in h.lower() for x in keys)), None)
        ct = col(('초', '시각', 'time', 'sec'))
        cg = next((k for k, h in enumerate(head) if '결' in h), None)
        cs = col(('우리 장면',)) if col(('우리 장면',)) is not None else col(('장면', '대사', 'scene'))
        if None in (ct, cg, cs) or len({ct, cg, cs}) < 3:
            continue
        tables += 1
        for ln in lines[i + 2:]:
            if not ln.strip().startswith('|'):
                break
            c = [x.strip() for x in ln.strip().strip('|').split('|')]
            if len(c) <= max(ct, cg, cs):
                continue
            rows.append({'t': sec(c[ct]), 'gyeol': c[cg], 'scene': c[cs]})
    return rows, tables


def judge(target):
    """→ (종료 코드, 줄들). 날짜 유예는 main 이 처리."""
    f = find(target)
    if not f:
        return 4, [f'FAIL 결 표 없음 — {target} 에 gyeol_table.md 또는 gyeol_table.json 이 있어야 한다']
    try:
        text = f.read_text(encoding='utf-8-sig')
    except (OSError, UnicodeDecodeError) as e:
        return 5, [f'FAIL 결 표를 읽지 못함({f.name}): {e}']
    if f.suffix.lower() == '.json':
        try:
            j = json.loads(text)
            ref = str(j.get('reference') or j.get('source') or '')
            rows = [{'t': sec(r.get('t', r.get('sec', ''))), 'gyeol': str(r.get('gyeol', '')), 'scene': str(r.get('scene', ''))} for r in j['rows']]
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            return 5, [f'FAIL 결 표 JSON 형식 아님({f.name}): {e} — {{"reference", "rows":[{{"t","gyeol","scene"}}]}}']
        promise_text = PROMISE_TEXT.search(json.dumps(j, ensure_ascii=False))
        has_ref = bool(ref.strip()) and bool(REF.search(ref) or re.search(r'https?://|^[\w-]{11}$', ref.strip()))
    else:
        rows, tables = md_rows(text)
        if not tables:
            return 5, [f'FAIL 결 표를 읽지 못함({f.name}) — 머리줄에 «초 | 결 | 우리 장면» 열이 있는 마크다운 표가 없다']
        promise_text = PROMISE_TEXT.search(text)
        has_ref = bool(REF.search(text))
    good = [r for r in rows if r['t'] is not None and r['gyeol'] and r['scene']]
    turn = [r for r in good if TURN.search(r['gyeol']) and '예고' not in r['gyeol']]   # «반전 예고» 줄은 반전 초가 아니다(롱투숏 A 10-29)
    prom = [r for r in good if PROMISE.search(r['gyeol'])]
    out, bad = [f'결 표: {f}'], False
    checks = [
        (has_ref, '레퍼런스 출처', 'docs/gyeol-analysis-*.md §번호 · 가이드 파일 · «레퍼런스: 주소» 중 하나'),
        (len(good) >= 4, f'초·결·장면 줄 {len(good)}개(4개 이상)', '초가 읽히고 결·장면 칸이 찬 줄이 4개 이상'),
        (bool(turn), f'반전 장면 초 {turn[0]["t"]:g}' if turn else '반전 장면 초', '결 칸에 반전·뒤집기·전환 줄'),
        (bool(prom or promise_text), f'약속 장면 초 {prom[0]["t"]:g}' if prom else ('약속 장면 ' + promise_text.group(1) if promise_text else '약속 장면 초'),
         '결 칸에 약속·최종 답·정점·회수 줄, 또는 본문에 «약속 … 15:42»'),
    ]
    for ok, name, need in checks:
        out.append(f'{"PASS" if ok else "FAIL"} {name}' + ('' if ok else f' — 필요: {need}'))
        bad |= not ok
    return (4 if bad else 0), out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target')
    ap.add_argument('--strict', action='store_true', help='enforce_from 날짜 전이어도 막는다')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    code, lines = judge(a.target)
    grace = not a.strict and dt.datetime.now(dt.timezone.utc) < dt.datetime.fromisoformat(ENFORCE_FROM)
    if code and grace:
        lines.append(f'[유예] {ENFORCE_FROM[:10]} 전이라 경고만 — 그날부터 종료 {code}')
    if a.json:
        print(json.dumps({'code': code, 'enforced': not grace, 'lines': lines}, ensure_ascii=False))
    else:
        print('\n'.join(lines))
    sys.exit(0 if grace else code)


if __name__ == '__main__':
    main()
