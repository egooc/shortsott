# -*- coding: utf-8 -*-
"""일본어 TTS 숫자 읽기 — 아라비아 숫자를 한자 읽기로 바꾸고, 바꾼 값이 원문 값과 같은지 거꾸로 검산한다.

    python scripts/ja_numread.py "11万3600円、2,400円、5.105パーセント"     # 변환 결과
    python scripts/ja_numread.py --check ja-nenkin/ep01/script.txt            # 대본 전체 검산(불일치면 종료 코드 4)

왜: nenkin 채널이 8,052엔을 «8万52»처럼 읽은 사고(고정 댓글) — 합성음은 쉼표·자릿수를 틀리게 읽는다.
규칙: 정수는 万·億 단위 한자(一千 → 千, 一百 → 百, 一十 → 十), 소수점 아래는 한 자리씩(5.105 → 五点一〇五).
화면 자막은 아라비아 숫자 그대로 두고 TTS 입력에만 쓴다.
"""
import re
import sys

D = '〇一二三四五六七八九'
SMALL = [(1000, '千'), (100, '百'), (10, '十')]
BIG = [(10 ** 8, '億'), (10 ** 4, '万')]
NUM = re.compile(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?')


def under_10k(n):
    out = ''
    for v, ch in SMALL:
        q, n = divmod(n, v)
        if q:
            out += ('' if q == 1 else D[q]) + ch
    return out + (D[n] if n else '')


def int_kanji(n):
    if n == 0:
        return '〇'
    out = ''
    for v, ch in BIG:
        q, n = divmod(n, v)
        if q:
            out += under_10k(q) + ch
    return out + under_10k(n)


def num_kanji(s):
    s = s.replace(',', '')
    if '.' in s:
        a, b = s.split('.')
        return int_kanji(int(a)) + '点' + ''.join(D[int(c)] for c in b)
    return int_kanji(int(s))


def to_read(text):
    return NUM.sub(lambda m: num_kanji(m.group()), text)


# ---------- 검산: 한자 읽기 → 값 ----------
KD = {c: i for i, c in enumerate(D)}
KD['零'] = 0
KS = {'十': 10, '百': 100, '千': 1000}
KB = {'万': 10 ** 4, '億': 10 ** 8}
KNUM = re.compile('[〇一二三四五六七八九十百千万億]+(?:点[〇一二三四五六七八九]+)?')


def kanji_int(s):
    total, sect, digit = 0, 0, None
    for c in s:
        if c in KD:
            digit = KD[c]
        elif c in KS:
            sect += (1 if digit is None else digit) * KS[c]
            digit = None
        elif c in KB:
            sect += digit or 0
            total += (sect or 1) * KB[c]
            sect, digit = 0, None
    return total + sect + (digit or 0)


def kanji_val(s):
    if '点' in s:
        a, b = s.split('点')
        return float('%d.%s' % (kanji_int(a), ''.join(str(KD[c]) for c in b)))
    return kanji_int(s)


def values_arabic(text):
    """«11万3600円» 처럼 万·億 를 낀 표기는 하나의 값으로 묶는다."""
    out = []
    for m in re.finditer(r'(?:(\d[\d,]*(?:\.\d+)?)億)?(?:(\d[\d,]*(?:\.\d+)?)万)?(\d[\d,]*(?:\.\d+)?)?', text):
        if not m.group(0) or not any(m.groups()):
            continue
        oku, man, rest = (float(x.replace(',', '')) if x else 0 for x in m.groups())
        v = oku * 10 ** 8 + man * 10 ** 4 + rest
        out.append(int(v) if v == int(v) else v)
    return out


def values_kanji(text):
    return [kanji_val(m.group()) for m in KNUM.finditer(text)]


def check_line(display):
    """바꾼 자리만 검산한다(원문에 원래 있던 一人·一度 같은 한자는 빼고)."""
    marked = NUM.sub(lambda m: '<' + num_kanji(m.group()) + '>', display)
    marked = re.sub(r'>([万億])', lambda m: m.group(1) + '>', marked)   # «11万»: 단위는 바꾼 자리에 붙인다
    marked = marked.replace('><', '')                # «11万3600» 은 한 덩어리
    k = [kanji_val(x) for x in re.findall(r'<([^>]*)>', marked)]
    read = marked.replace('<', '').replace('>', '')
    return read, values_arabic(display) == k, values_arabic(display), k


# ---------- 말소리용 히라가나 읽기(금액·비율) ----------
# 10-17 실측: Supertonic ja 는 «五点一〇五»를 5.15 로, «三万四千五百円»을 3万1500 으로 들리게 읽었다(Speechmatics 역전사).
# 금액·비율·万 단위는 히라가나로 넣어 읽기를 못 박는다. 날짜·나이 등 조수사는 한자 그대로(合成기가 조수사 읽기는 맞게 한다).
KANA_D = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう']
KANA_DEC = ['ゼロ', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう']
HYAKU = {1: 'ひゃく', 3: 'さんびゃく', 6: 'ろっぴゃく', 8: 'はっぴゃく'}
SEN = {1: 'せん', 3: 'さんぜん', 8: 'はっせん'}


def kana_10k(n):
    q, n = divmod(n, 1000); out = SEN.get(q, KANA_D[q] + 'せん') if q else ''
    q, n = divmod(n, 100); out += HYAKU.get(q, KANA_D[q] + 'ひゃく') if q else ''
    q, n = divmod(n, 10); out += ('じゅう' if q == 1 else KANA_D[q] + 'じゅう') if q else ''
    return out + KANA_D[n]


def int_kana(n):
    if n == 0:
        return 'ゼロ'
    out = ''
    for v, unit in ((10 ** 8, 'おく'), (10 ** 4, 'まん')):
        q, n = divmod(n, v)
        if q:
            out += kana_10k(q) + unit
    return out + kana_10k(n)




def money_kana(m):
    v = values_arabic(m.group())[0]
    if isinstance(v, float):
        a, b = ('%s' % v).split('.')
        return int_kana(int(a)) + 'てん' + ''.join(KANA_DEC[int(c)] for c in b)
    return int_kana(v)


TSU = {'1': 'ひとつ', '2': 'ふたつ', '3': 'みっつ', '4': 'よっつ', '5': 'いつつ', '6': 'むっつ', '7': 'ななつ', '8': 'やっつ', '9': 'ここのつ'}
NIN = {'1': 'ひとり', '2': 'ふたり'}
KAI = {'1': 'いっかい', '6': 'ろっかい', '8': 'はっかい', '10': 'じゅっかい'}


def to_say(text):
    """TTS 입력 — 정치JA scripts/ja_num_reading.say()(조수사까지 히라가나, 84개 역전사 0 불일치)를 쓰고(10-17 합의),
    say() 가 아직 못 읽는 つ·人·回 조수사만 앞에서 히라가나로 바꾼다(«1つ目»→いちつ目 실측)."""
    from ja_num_reading import say
    text = re.sub(r'(?<![\d,])([1-9])つ', lambda m: TSU[m.group(1)], text)
    text = re.sub(r'(?<![\d,])([12])人', lambda m: NIN[m.group(1)], text)
    text = re.sub(r'(?<![\d,])(10|[168])回', lambda m: KAI[m.group(1)], text)
    return say(text)


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['--check']:
        bad = 0
        lines = open(argv[1], encoding='utf-8').read().splitlines()
        for i, line in enumerate(lines, 1):
            if not line or line.startswith(('#', '@')) or not NUM.search(line):
                continue
            read, ok, a, k = check_line(line)
            if not ok:
                bad += 1
                print('FAIL %d: %s\n     → %s\n     값 %s ≠ %s' % (i, line, read, a, k))
        print('숫자 검산: %s' % ('OK' if not bad else 'FAIL %d줄' % bad))
        return 4 if bad else 0
    print(to_read(' '.join(argv)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
