# -*- coding: utf-8 -*-
"""우리 ASS 와 볼케이노 ASS 를 견준다. 눈으로 보기 전에 기계가 잡게.

    python scripts/ass_diff.py <우리.ass> <볼케이노.ass>

왜 (2026-10-09): Format 줄에서 SecondaryColour 한 칸이 빠졌는데 Style 줄은 색을 넷 썼다.
  칸 수가 어긋나 libass 가 스타일을 통째로 버렸고 **제목이 아예 안 그려졌다.**
  렌더를 다 돌리고 화면을 봐야 알았다 — 3분이 날아갔다. 글자만 견줘도 1초면 잡힌다.

스타일 이름은 서로 다르다(우리 T1/T2/NAR/CAP, 볼케이노 Head/Narr/Dialogue) —
«무엇을 그리는 칸인가»로 짝지어 본다.
"""
import re
import sys
import io

PAIR = {'T1': 'Head', 'T2': 'Head', 'NAR': 'Narr', 'CAP': 'Dialogue', 'EFF': 'Effect', 'CR': 'Credit'}
# 견줄 칸(Format 이름) — 글꼴은 이름이 다를 수 있어 따로 본다
WATCH = ['Fontsize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour',
         'Bold', 'Italic', 'ScaleX', 'ScaleY', 'BorderStyle', 'Outline', 'Shadow',
         'Alignment', 'MarginL', 'MarginR', 'MarginV']


def styles(path):
    fmt, out, info = None, {}, {}
    for ln in io.open(path, encoding='utf-8'):
        ln = ln.rstrip('\n')
        if ln.startswith('Format:') and 'Fontname' in ln:
            fmt = [x.strip() for x in ln.split(':', 1)[1].split(',')]
        elif ln.startswith('Style:') and fmt:
            v = [x.strip() for x in ln.split(':', 1)[1].split(',')]
            if len(v) != len(fmt):
                print('  ★%s: Style 칸이 %d개인데 Format 은 %d개다 — libass 가 버린다'
                      % (path, len(v), len(fmt)))
            out[v[0]] = dict(zip(fmt, v))
        elif ln.startswith(('PlayResX:', 'PlayResY:', 'WrapStyle:', 'ScaledBorderAndShadow:')):
            k, _, val = ln.partition(':')
            info[k] = val.strip()
    return out, info


def events(path):
    """제목 줄의 **인라인 태그**를 뽑는다 — 색·크기를 스타일이 아니라 인라인으로 주기 때문이다."""
    out = []
    for ln in io.open(path, encoding='utf-8'):
        if not ln.startswith('Dialogue:'):
            continue
        head, _, text = ln.rstrip().partition(',,')
        cols = head.split(',')
        style = cols[3] if len(cols) > 3 else ''
        if style in ('T1', 'T2', 'Head'):
            m = re.search(r'[{]([^}]*)[}]', text)
            out.append((style, m.group(1) if m else ''))
    return out


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    a, ai = styles(sys.argv[1])
    b, bi = styles(sys.argv[2])
    bad = 0
    for k in sorted(set(ai) | set(bi)):
        if ai.get(k) != bi.get(k):
            print('머리말 %-22s 우리 %-10s 볼케이노 %s' % (k, ai.get(k), bi.get(k)))
            bad += 1
    for ours, theirs in PAIR.items():
        if ours not in a:
            continue
        if theirs not in b:
            print('%-4s → 볼케이노에 %s 가 없다(이 편이 안 쓴 것일 수 있다)' % (ours, theirs))
            continue
        for key in WATCH:
            x, y = a[ours].get(key), b[theirs].get(key)
            if x is None or y is None:
                continue
            try:
                same = abs(float(x) - float(y)) < 1e-6
            except ValueError:
                same = x == y
            if not same:
                print('%-4s(%-8s) %-16s 우리 %-12s 볼케이노 %s' % (ours, theirs, key, x, y))
                bad += 1
        if a[ours].get('Fontname') != b[theirs].get('Fontname'):
            print('%-4s(%-8s) %-16s 우리 %-20s 볼케이노 %s   ←이름은 달라도 된다(파일 실제 이름을 쓴다)'
                  % (ours, theirs, 'Fontname', a[ours].get('Fontname'), b[theirs].get('Fontname')))
    # ★제목 색은 인라인으로 준다 — 태그가 빠지면 강조색이 사라진다
    #   (2026-10-09 ja 에서 실제로 그랬다: 중복 블록을 지우다 인라인 태그 줄까지 날아갔다).
    ours = [t for _, t in events(sys.argv[1]) if chr(92) + 'c' in t]
    theirs = [t for _, t in events(sys.argv[2]) if chr(92) + 'c' in t]
    if len(ours) < len(theirs):
        print('★제목 인라인 색 태그가 모자란다: 우리 %d개 · 볼케이노 %d개 — 강조색이 사라진다'
              % (len(ours), len(theirs)))
        bad += 1
    print('\n어긋난 곳 %d' % bad if bad else '\n어긋난 곳 없음')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
