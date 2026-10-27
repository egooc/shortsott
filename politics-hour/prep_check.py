"""내일 편 착수 점검(10-23 사고: 10/24 롱폼 사전 준비를 놓쳐 07:00 공개가 빠졌다).
매일 15:00 schtasks 로 돈다. 날짜 폴더에 원고·발췌·keywords.json 이 있고 candidate_gate 가 통과해야 0.
아니면 handoff-manager §10 에 «★정치 ko 내일 편 미착수» 줄을 남기고 종료 4.
사용: python prep_check.py [YYYYMMDD]   (생략하면 내일)"""
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
HANDOFF = HERE.parent / 'docs' / 'handoff-manager-20261014.md'


def missing(day):
    ep = HERE / 'episodes' / day
    if not ep.is_dir():
        return [f'episodes/{day} 폴더 없음']
    bad = []
    if not list(ep.glob('script_*.py')):
        bad.append('원고(script_*.py) 없음')
    src = ep / 'src'
    if not src.is_dir() or not any(src.glob('*.mp4')):
        bad.append('발췌(src/*.mp4) 없음')
    if not (ep / 'keywords.json').is_file():
        bad.append('keywords.json 없음')
        return bad
    r = subprocess.run([sys.executable, str(HERE / 'candidate_gate.py'), str(ep)], cwd=HERE,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        fails = [x for x in r.stdout.splitlines() if 'FAIL' in x][:3]
        bad.append(f'candidate_gate rc={r.returncode} ' + ' / '.join(fails))
    return bad


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    pos = [a for a in sys.argv[1:] if not a.startswith('--')]
    day = pos[0] if pos else (date.today() + timedelta(days=1)).strftime('%Y%m%d')
    bad = missing(day)
    if not bad:
        print(f'[prep] PASS {day}')
        sys.exit(0)
    line = f'- ★정치 ko 내일 편 미착수({datetime.now():%m-%d %H:%M} prep_check {day}): ' + ' · '.join(bad)
    print(line)
    if '--no-log' not in sys.argv:
        with open(HANDOFF, 'a', encoding='utf-8') as f:
            f.write('\n' + line + '\n')
    sys.exit(4)
