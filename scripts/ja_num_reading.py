# -*- coding: utf-8 -*-
"""일본어 원고의 숫자를 TTS 읽기용 한자 숫자로 바꾼다 — 자막용 원문은 그대로 두고 읽기용 열을 따로 만든다.

    python scripts/ja_num_reading.py <원고.json>            # naze/정치 원고: lines[].text → read 채움(이미 있으면 둔다)
    python scripts/ja_num_reading.py --text "定数は465で…"    # 한 줄 변환
    python scripts/ja_num_reading.py --tsv <원문.txt>         # 줄마다 «원문<TAB>읽기용» 2열

왜 (2026-10-16 Supertonic ja 실측, reference/ja/tts-samples/NOTES.md): 아라비아 숫자·%·〇·中黒를 틀리게 읽었다.
  465→4065 · 233→2033 · 53.85%→5385% · 3.2%→«を超え»/«コア» · 二〇二六→26/2016 · 三・二→32.
  한자 숫자 + «点» + «パーセント» 로 쓰면 전부 맞게 읽었다.
규칙: 정수 → 万·億·兆 단위 한자 숫자(1,000 → 千, 쉼표 제거) · 소수 → «点» 뒤 한 자리씩 · %/％ → パーセント
  · 〇 섞인 한자 숫자열(二〇二六) → 자릿값 한자 숫자 · 한자 숫자 사이 «・» → «点» · 분수 a/b → b分のa · 전각 숫자도 같게.
"""
import argparse
import json
import re
import sys
from pathlib import Path

DIG = '〇一二三四五六七八九'
KD = {c: i for i, c in enumerate(DIG)}
KD['零'] = 0
UNITS = ['', '万', '億', '兆', '京']


def _four(n):
    """0~9999 → 千百十 표기(一千·一百·一十의 一 은 뺀다)."""
    out = ''
    for val, name in ((1000, '千'), (100, '百'), (10, '十')):
        q, n = divmod(n, val)
        if q:
            out += ('' if q == 1 else DIG[q]) + name
    if n:
        out += DIG[n]
    return out


def int_kanji(n):
    if n == 0:
        return 'ゼロ'
    parts, i = [], 0
    while n:
        n, g = divmod(n, 10000)
        if g:
            parts.append(_four(g) + UNITS[i])
        i += 1
    return ''.join(reversed(parts))


def dec_kanji(s):
    """'53.85' → 五十三点八五 (소수점 아래는 한 자리씩, 0 은 ゼロ)."""
    a, _, b = s.partition('.')
    head = int_kanji(int(a or '0'))
    return head + ('点' + ''.join('ゼロ' if c == '0' else DIG[int(c)] for c in b) if b else '')


ZEN = str.maketrans('０１２３４５６７８９．，％／', '0123456789.,%/')


def reading(text):
    t = text.translate(ZEN)
    # 〇 섞인 한자 숫자열(二〇二六) → 자릿값 한자 숫자. 두 자리 이상이고 〇 이 있을 때만(「一つ」 같은 낱말은 안 건드림)
    def kseq(m):
        s = m.group(0)
        return int_kanji(int(''.join(str(KD[c]) for c in s))) if '〇' in s else s
    t = re.sub('[〇一二三四五六七八九]{2,}', kseq, t)
    # 한자 숫자 사이 中黒(三・二) → 点
    t = re.sub(r'(?<=[〇一二三四五六七八九十])・(?=[〇一二三四五六七八九])', '点', t)
    # 분수 1/2 → 二分の一
    t = re.sub(r'(\d+)/(\d+)', lambda m: int_kanji(int(m.group(2))) + '分の' + int_kanji(int(m.group(1))), t)
    # 숫자(쉼표·소수 포함) → 한자 숫자
    t = re.sub(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?',
               lambda m: dec_kanji(m.group(0).replace(',', '')), t)
    t = t.replace('%', 'パーセント')
    return t


def fill_script(s):
    n = 0
    for ln in s.get('lines', []):
        if 'read' in ln:
            continue
        r = reading(ln['text'])
        if r != ln['text']:
            ln['read'] = r
            n += 1
    return n


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('script', nargs='?')
    ap.add_argument('--text')
    ap.add_argument('--tsv')
    a = ap.parse_args()
    if a.text:
        print(reading(a.text))
    elif a.tsv:
        for ln in Path(a.tsv).read_text(encoding='utf-8').splitlines():
            print('%s\t%s' % (ln, reading(ln)))
    elif a.script:
        p = Path(a.script)
        s = json.loads(p.read_text(encoding='utf-8'))
        n = fill_script(s)
        p.write_text(json.dumps(s, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('읽기용 문장 %d줄 채움 → %s' % (n, p))
    else:
        ap.print_usage()
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
