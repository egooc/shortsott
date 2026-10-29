"""gyeol_gate 자체 시험 — 가짜 폴더로 종료 코드(0·4·5)와 유예를 본다."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / 'scripts' / (sys.argv[1] if len(sys.argv) > 1 else 'gyeol_gate.py')
GOOD = """# 시험 편 결 표
기준: docs/gyeol-analysis-20261027.md §2

| 초 | 결 | 우리 장면 |
|---|---|---|
| 0.5 | 후킹 | 첫 컷 |
| 8.2 | 들뜬 선언 | A 가 컵을 든다 |
| 11.0 | 뒤집기 | B 가 막는다 |
| 16.1 | 제목 질문 | 왜 이렇게 많아졌을까 |
| 40.0 | 약속 | 하루 점주 수락 |
"""
fails = 0


def run(target, *extra):
    r = subprocess.run([sys.executable, '-X', 'utf8', str(GATE), str(target), *extra], capture_output=True, text=True, encoding='utf-8')
    return r.returncode, r.stdout


def check(name, ok, out=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        print(out); fails += 1


with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    empty = d / 'empty'; empty.mkdir()
    c, o = run(empty, '--strict'); check('결 표 없는 폴더 → 종료 4', c == 4, o)
    c, o = run(empty); check('유예 기간(--strict 없음)엔 경고만 → 종료 0 또는 enforce 뒤 4', c in (0, 4) and ('유예' in o or c == 4), o)
    junk = d / 'junk'; junk.mkdir(); (junk / 'gyeol_table.md').write_text('결 표는 나중에 쓸게요\n', encoding='utf-8')
    c, o = run(junk, '--strict'); check('표 형식 아님 → 종료 5', c == 5, o)
    badj = d / 'badj'; badj.mkdir(); (badj / 'gyeol_table.json').write_text('{"rows": 3}', encoding='utf-8')
    c, o = run(badj, '--strict'); check('JSON 형식 아님 → 종료 5', c == 5, o)
    good = d / 'good'; good.mkdir(); (good / 'gyeol_table.md').write_text(GOOD, encoding='utf-8')
    c, o = run(good, '--strict'); check('갖춘 결 표 → 종료 0', c == 0, o)
    noref = d / 'noref'; noref.mkdir(); (noref / 'gyeol_table.md').write_text(GOOD.replace('기준: docs/gyeol-analysis-20261027.md §2', ''), encoding='utf-8')
    c, o = run(noref, '--strict'); check('레퍼런스 출처 없음 → 종료 4', c == 4 and 'FAIL 레퍼런스' in o, o)
    noprom = d / 'noprom'; noprom.mkdir(); (noprom / 'gyeol_table.md').write_text(GOOD.replace('| 40.0 | 약속 |', '| 40.0 | 수락 |'), encoding='utf-8')
    c, o = run(noprom, '--strict'); check('약속 장면 없음 → 종료 4', c == 4 and 'FAIL 약속' in o, o)
    few = d / 'few'; few.mkdir(); (few / 'gyeol_table.md').write_text('\n'.join(GOOD.splitlines()[:7]) + '\n', encoding='utf-8')
    c, o = run(few, '--strict'); check('줄 4개 미만 → 종료 4', c == 4, o)
    tz = d / 'teaser'; tz.mkdir(); (tz / 'gyeol_table.md').write_text(GOOD.replace('| 0.5 | 후킹 |', '| 0.5 | 반전 예고 |'), encoding='utf-8')
    c, o = run(tz, '--strict'); check('«반전 예고» 줄은 반전 초로 안 잡는다(11.0)', c == 0 and '반전 장면 초 11' in o, o)
    js = d / 'js'; js.mkdir()
    (js / 'gyeol_table.json').write_text(json.dumps({'reference': 'docs/fantube/GUIDE_TOP2x12.md', 'rows': [
        {'t': 0.3, 'gyeol': '후킹', 'scene': 'a'}, {'t': '0:07', 'gyeol': '반전', 'scene': 'b'},
        {'t': '12초', 'gyeol': '설명', 'scene': 'c'}, {'t': 20, 'gyeol': '정점', 'scene': 'd'}]}, ensure_ascii=False), encoding='utf-8')
    c, o = run(js, '--strict'); check('JSON 결 표(가이드 출처·1:05·12초 꼴) → 종료 0', c == 0, o)
zunda = Path('D:/volcano-runs/zunda_ko')
if zunda.is_dir():
    c, o = run(zunda, '--strict'); check('실제 결 표(동네물음표 3분) → 종료 0', c == 0, o)
sys.exit(1 if fails else 0)
