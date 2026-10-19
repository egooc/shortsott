# -*- coding: utf-8 -*-
"""packages_gate.py 자기 테스트(API 0원) — 임시 에피소드로 통과·실패 사례.

    python tests/packages_gate_test.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import packages_gate as G  # noqa: E402

TAGS = ['연금', '연금 신청', '기초연금', '국민연금', '노령연금', '연금 수령', '연금 계산', '연금 개혁', '연금 인상',
        '연금 조회', '연금 세금', '연금 소득', '연금 공단', '연금 상담', '연금 정보', '은퇴']


def pkg(title, big, thumb, **kw):
    p = {'title': title, 'thumbnail': thumb, 'style': 'A', 'big': [big], 'tags': list(TAGS),
         'hashtags': ['#연금'], 'desc_head': ['연금 신청 방법을 정리합니다.', '공단 자료로 확인했습니다.']}
    p.update(kw)
    return p


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    ok = True
    with tempfile.TemporaryDirectory(dir=str(G.ROOT)) as td:
        ep = Path(td)
        thumb = ep / 't.png'
        thumb.write_bytes(b'x')
        rel = thumb.relative_to(G.ROOT).as_posix()
        write(ep / 'keywords.json', {'keywords': ['연금', '연금 신청']})
        good = {'video_id': None, 'purpose': 'test', 'applied': [],
                'packages': [pkg('연금 신청 방법', '연금', rel), pkg('연금 받는 날', '연금', rel), pkg('연금 세금 정리', '연금', rel)]}
        write(ep / 'packages.json', good)
        if G.check(ep):
            print('FAIL 정상 포장이 걸림', G.check(ep)); ok = False
        (ep / 'script.txt').write_text('연금 신청 방법과 기초연금, 국민연금을 정리합니다.', encoding='utf-8')
        st, wl = G.warnings(ep)
        if not (st[0][2] is not None and st[0][2] < 0.5 and any('원고에 나오는 태그' in w for w in wl)):
            print('FAIL 태그-내용 경고 못 냄', st[0][2], wl); ok = False
        if G.check(ep):
            print('FAIL 경고가 관문을 막음'); ok = False
        bad = dict(good, purpose=None, packages=[
            pkg('국민연금 이야기', '연금', 'nope.png', tags=TAGS[:5], hashtags=['연금'], desc_head=['한 줄']),
            pkg('연금 받는 날', '연금', rel, tags=TAGS[:15] + ['총기 난사'])])
        write(ep / 'packages.json', bad)
        msgs = ' / '.join(G.check(ep))
        for need in ('purpose', '묶음 2개', '시작하지 않음', '썸네일 없음', '태그 5개', '해시태그', 'desc_head 1줄', '가이드'):
            if need not in msgs:
                print('FAIL 못 잡음:', need, '|', msgs); ok = False
    print('OK' if ok else 'FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
