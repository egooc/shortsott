# -*- coding: utf-8 -*-
"""scripts/style_refs.py 자기 테스트 — API 0, 임시 폴더만."""
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import style_refs as sr  # noqa: E402

with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    for n in ('a.jpg', 'b.png', 'c.webp', 'd.jpg', 'e.jpg', 'f.jpg'):
        (t / n).write_bytes(b'x')
    (t / 'note.txt').write_text('x', encoding='utf-8')
    r = sr.check([t / 'a.jpg', t / 'b.png', t / 'c.webp'], enforce=True)
    assert r['ok'] and r['code'] == 0 and not r['warnings'], r
    r = sr.check([], enforce=True)
    assert r['code'] == 4 and '비었음' in r['errors'][0], r
    assert sr.check([], now=sr.ENFORCE_FROM - dt.timedelta(hours=1))['code'] == 0    # 유예 전엔 0
    assert sr.check([], now=sr.ENFORCE_FROM)['code'] == 4
    r = sr.check([t / 'a.jpg', t / 'nope.jpg', t / 'note.txt'], enforce=True)
    assert r['code'] == 4 and any('파일 없음' in e for e in r['errors']) and any('그림 아님' in e for e in r['errors']), r
    r = sr.check([t / 'a.jpg'], enforce=True)
    assert r['ok'] and '권장' in r['warnings'][0]
    r = sr.check([t / n for n in ('a.jpg', 'b.png', 'c.webp', 'd.jpg', 'e.jpg', 'f.jpg')], enforce=True)
    assert r['ok'] and len(r['refs']) == 5 and r['warnings'], r
    assert sr.attach_args(['x.jpg', 'y.jpg']) == ['--attach', 'x.jpg', '--attach', 'y.jpg']
    # json — 상대 경로는 json 폴더 기준, 키 없음 → 빈 목록 → 4
    p = t / 'img_prompts.json'
    p.write_text(json.dumps({'_style': 's', 'style_refs': ['a.jpg', 'b.png', 'c.webp']}), encoding='utf-8')
    assert sr.refs_from(p) == [str((t / n).resolve()) for n in ('a.jpg', 'b.png', 'c.webp')]
    assert sr.main([str(p), '--enforce-now']) == 0
    p.write_text(json.dumps({'_style': 's'}), encoding='utf-8')
    assert sr.main([str(p), '--enforce-now']) == 4
    assert sr.main(['--refs', str(t / 'a.jpg'), str(t / 'b.png'), str(t / 'c.webp'), '--enforce-now']) == 0
    assert sr.main([str(t / 'missing.json'), '--enforce-now']) == 4
print('OK')
