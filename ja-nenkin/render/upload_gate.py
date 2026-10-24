# -*- coding: utf-8 -*-
"""연금JA 업로드 전 관문(관리자 10-20 adoption) — 하나라도 실패면 종료 4, 업로드 금지.

    python ja-nenkin/render/upload_gate.py ja-nenkin/ep01 [--concat concat_v5.txt]

순서: title_check --lane nenkin_ja --jargon ja-nenkin/jargon.json --fail-on-warn
      → tag_gate packages.json --script script.txt --fail-on-warn → packages_gate <편> --lang ja --lane nenkin
      → motion_gate <편> --concat <올릴 판의 concat>(10-22, 장면 첫·끝 판 SSIM ≥0.95 면 FAIL) — --concat 없으면 concat.txt
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SC = ROOT / 'scripts'


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    pk, py = ep / 'packages.json', sys.executable
    steps = [
        ('title_check', [py, str(SC / 'title_check.py'), str(pk), '--lane', 'nenkin_ja',
                         '--jargon', str(ROOT / 'ja-nenkin' / 'jargon.json'), '--fail-on-warn']),
        ('tag_gate', [py, str(SC / 'tag_gate.py'), str(pk), '--script', str(ep / 'script.txt'), '--fail-on-warn']),
        ('packages_gate', [py, str(SC / 'packages_gate.py'), str(ep), '--lang', 'ja', '--lane', 'nenkin']),
        ('motion_gate', [py, str(Path(__file__).parent / 'motion_gate.py'), str(ep), '--concat',
                         argv[argv.index('--concat') + 1] if '--concat' in argv else 'concat.txt']),
    ]
    up = ep / 'upload.json'   # 10-24 사고: 15분 넘는 편은 longUploadsStatus allowed 여야(upload.json 이 있을 때 그 file 로 잰다)
    if up.exists():
        import json
        steps.append(('long_upload', ['node', str(Path(__file__).parent / 'long_upload_check.js'), 'nenkin_ja',
                                      json.loads(up.read_text(encoding='utf-8'))['file']]))
    else:
        steps.append(('long_upload', [py, '-c', 'import sys; print("upload.json 없음 — 올릴 파일을 모른다"); sys.exit(4)']))
    bad = []
    for name, cmd in steps:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', env={**__import__('os').environ, 'PYTHONIOENCODING': 'utf-8'})
        last = (r.stdout.strip().splitlines() or [r.stderr.strip()[-200:]])[-1]
        print(f'[{name}] {last} (종료 {r.returncode})')
        if r.returncode:
            bad.append(name)
            print(r.stdout)
    print('✓ 업로드 관문 통과' if not bad else f'✗ 업로드 관문 실패: {", ".join(bad)} — 업로드 금지')
    return 4 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
