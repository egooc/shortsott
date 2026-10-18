# -*- coding: utf-8 -*-
"""thumb_compose.py 자기 테스트(API 0원) — 미리 둔 합성 그림으로 --no-gpt 합성·관문(제목·윗줄 큰 낱말·글자 수·얼굴)을 확인한다.

    python tests/thumb_compose_test.py
"""
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import thumb_compose as T  # noqa: E402


def setup(td, variants, titles):
    out = td / 'thumb' / 'compose'
    out.mkdir(parents=True)
    p = Image.new('RGB', (800, 800), (255, 255, 255))
    ImageDraw.Draw(p).ellipse([200, 250, 600, 550], fill=(90, 50, 30), outline=(40, 20, 10), width=6)
    p.save(out / 'product.png')
    for s in {v['symbol'] for v in variants}:
        b = Image.new('RGB', (1536, 1024), (30, 40, 80))
        ImageDraw.Draw(b).polygon([(700, 1024), (1536, 300), (1536, 1024)], fill=(200, 140, 60))
        b.save(out / f'bg_{s}.png')
    (td / 'packages.json').write_text(json.dumps({'packages': [{'title': t, 'big': ['초코파이']} for t in titles]}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (td / 'compose.json').write_text(json.dumps({'product': {'name': 'x', 'desc': 'x'}, 'chip': '기업 흥망', 'variants': variants},
                                                ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    ok = True
    good = [{'symbol': 'fork', 'top': '초코파이는 남았다', 'bottom': '그룹은 왜 무너졌나'},
            {'symbol': 'crack', 'top': '초코파이', 'bottom': '같은 뿌리, 다른 운명', 'quote': True}]
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        setup(td, good, ['초코파이는 남고 그룹은 무너졌다', '초코파이와 동양그룹'])
        rc = T.main([str(td), '--no-gpt', '--write-packages'])
        if rc != 0:
            print('FAIL 정상 설정이 관문에 걸림'); ok = False
        im = T.load(td / 'thumb' / 'compose' / 'thumb_0.png')
        if im.size != (1280, 720):
            print('FAIL 크기', im.size); ok = False
        pk = json.loads((td / 'packages.json').read_text(encoding='utf-8'))
        if not pk['packages'][1]['thumbnail'].endswith('thumb_1.png') or 'quote' not in pk['packages'][1]['style']:
            print('FAIL packages 갱신', pk['packages'][1]); ok = False
        if not (td / 'thumb' / 'compose' / 'sheet.png').exists():
            print('FAIL 시트 없음'); ok = False
    bad = [{'symbol': 'fork', 'top': '동양그룹은 무너졌다', 'bottom': '초코파이만 남은 이유가 뭘까요 정말로'}]
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        setup(td, bad, ['그룹은 무너졌다'])
        rc = T.main([str(td), '--no-gpt'])
        if rc != 4:
            print('FAIL 나쁜 설정이 관문 통과'); ok = False
    v = {'top': '초코파이', 'bottom': '짧다'}
    msgs = T.gate(0, {'title': '초코파이 이야기', 'big': ['초코파이']}, v, {'top': 100, 'bottom': 120}, 1)
    if not any('크지 않음' in m for m in msgs) or not any('얼굴' in m for m in msgs):
        print('FAIL gate 메시지', msgs); ok = False
    print('OK' if ok else 'FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
