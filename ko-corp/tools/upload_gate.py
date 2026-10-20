# -*- coding: utf-8 -*-
"""업로드 전 포장 관문(관리자 10-20) — 업로드 스크립트가 맨 앞에서 부른다. 하나라도 걸리면 종료 4(업로드 금지).

    python -X utf8 ko-corp/tools/upload_gate.py ko-corp/ep01

packages_gate(포장 3묶음) · title_check --fail-on-warn(전문용어 풀이 = ko-corp/jargon.json) · tag_gate --fail-on-warn(제목·설명·태그 공통 낱말, 태그 내용 일치).
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SC = ROOT / 'scripts'


def run(ep):
    pk = str(ep / 'packages.json')
    steps = [
        ('packages_gate', [str(SC / 'packages_gate.py'), str(ep)]),
        ('title_check', [str(SC / 'title_check.py'), pk, '--lane', 'corp_ko', '--jargon', str(ROOT / 'ko-corp' / 'jargon.json'), '--fail-on-warn']),
        ('tag_gate', [str(SC / 'tag_gate.py'), pk, '--script', str(ep / 'script.txt'), '--fail-on-warn']),
    ]
    bad = 0
    for name, cmd in steps:
        r = subprocess.run([sys.executable, '-X', 'utf8', *cmd], capture_output=True, text=True, encoding='utf-8')
        lines = r.stdout.strip().splitlines()
        print(f'{name} 종료 {r.returncode} — {lines[-1] if lines else r.stderr.strip()}', flush=True)
        if r.returncode:
            print(r.stdout, flush=True)
            bad += 1
    return 4 if bad else 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(run(Path(sys.argv[1]).resolve()))
