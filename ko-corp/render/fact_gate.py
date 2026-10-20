"""불확실 팩트 관문(관리자 10-21 G4 · devo-6): 원고 완성 뒤 uncertain_facts.json → gpt-ask 교차 1회 → 열린 항목 0건이어야 TTS.

  python -X utf8 ko-corp/render/fact_gate.py <편 폴더>        한 줄 출력, 막히면 종료 4

uncertain_facts.json:
  {"facts": [{"claim": "원고 속 확인 안 된 문장", "scene": "vid", "status": "open|confirmed|fixed|cut", "source": "확인 근거", "note": ""}],
   "cross_check": {"at": "2026-10-23T10:00", "gpt_file": "research/a5.md"}}
  status: open=아직 모름 · confirmed=교차 확인으로 맞음 · fixed=원고를 고침 · cut=원고에서 뺌. facts 가 빈 목록이어도 cross_check 는 있어야 한다.
10-23 전(ENFORCE_FROM)엔 알림만 — 그날부터 막는다(공용 도구 유예 규칙, 10-20).
"""
import datetime
import json
import sys
from pathlib import Path

ENFORCE_FROM = datetime.date(2026, 10, 23)
STATUS = {'open', 'confirmed', 'fixed', 'cut'}


def check(ep):
    """(통과 여부, 한 줄) — 통과 = 파일 있음 · 교차 확인 파일 있음 · 모르는 status 0 · open 0."""
    f = Path(ep) / 'uncertain_facts.json'
    if not f.exists():
        return False, f'불확실 팩트 관문: {f.name} 없음'
    d = json.loads(f.read_text(encoding='utf-8'))
    facts = d.get('facts')
    if not isinstance(facts, list):
        return False, '불확실 팩트 관문: facts 목록 없음'
    gpt = (d.get('cross_check') or {}).get('gpt_file')
    if not gpt or not (Path(ep) / gpt).exists():
        return False, f'불확실 팩트 관문: 교차 확인 파일 없음({gpt})'
    bad = [x for x in facts if x.get('status') not in STATUS]
    if bad:
        return False, f'불확실 팩트 관문: status 이상 {len(bad)}건 — {bad[0].get("claim", "")[:40]}'
    n = {s: sum(x['status'] == s for x in facts) for s in sorted(STATUS)}
    head = f'불확실 팩트 {len(facts)}건 · 열림 {n["open"]} · 확인 {n["confirmed"]} · 고침 {n["fixed"]} · 뺌 {n["cut"]} · 교차 {gpt}'
    if n['open']:
        return False, head + ' — 열림: ' + ' / '.join(x.get('claim', '')[:40] for x in facts if x['status'] == 'open')
    return True, head


def gate(ep, today=None):
    """막는 날짜부터는 실패면 SystemExit, 그 전엔 알림 한 줄만."""
    ok, line = check(ep)
    enforce = (today or datetime.date.today()) >= ENFORCE_FROM
    print(line if ok else (line + (' — TTS 중단' if enforce else f' — 알림만({ENFORCE_FROM} 부터 막음)')), flush=True)
    if not ok and enforce:
        raise SystemExit(4)
    return ok


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    gate(Path(sys.argv[1]))
