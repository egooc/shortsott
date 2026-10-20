# -*- coding: utf-8 -*-
"""ko TTS 입력용 숫자 → 한글 읽기. 자막은 아라비아 숫자 그대로, 소리만 바꾼다.

왜(10-19 실화 ②편 실측): Supertonic ko 가 «3시 8분»을 «4시 8분»으로 읽었다. 금액·연도·날짜가 사실인 레인은
한 글자 오독이 사실 오류라, 숫자는 전부 한글로 풀어서 넣고 업로드 전 역전사 대조(audit)로 확인한다.

    python ko-corp/render/ko_say.py "1997년 11월 1일, 어음 196억 원"     # 시험
"""
import re
import sys

DIG = '영일이삼사오육칠팔구'
NATIVE = {1: '한', 2: '두', 3: '세', 4: '네', 5: '다섯', 6: '여섯', 7: '일곱', 8: '여덟', 9: '아홉', 10: '열',
          20: '스물', 30: '서른', 40: '마흔', 50: '쉰', 60: '예순', 70: '일흔', 80: '여든', 90: '아흔'}
NATIVE_COUNTERS = ('개', '번', '살', '시', '명', '가지', '사람', '곳', '군데', '장', '대')   # 49 이하만 고유어(10-20 ep01: «쉰다섯 곳»이 두 번 다 «15곳»으로 들렸다)
MONTH = {6: '유', 10: '시'}
YOMI = {'INI': '아이엔아이', 'KIA': '기아', 'LG': '엘지', 'IMF': '아이엠에프', 'htb': '에이치티비', 'KBO': '케이비오', 'JP모건': '제이피모건',
        'UBS': '유비에스', 'CVC': '씨브이씨', '%': ' 퍼센트'}


def under10k(n, drop_one=True, gap=''):
    """1~9999 한자어 읽기. 천·백·십 앞의 1은 읽지 않는다(천구백, 백, 십). gap 은 «천» 뒤에 띄는 칸(금액용)."""
    out = ''
    for unit, name in ((1000, '천'), (100, '백'), (10, '십')):
        q, n = divmod(n, unit)
        if q:
            out += ('' if q == 1 and drop_one else DIG[q]) + name + (gap if unit == 1000 and n else '')
    if n:
        out += DIG[n]
    return out


def sino(n, gap=''):
    if n == 0:
        return '영'
    out = []
    for unit, name in ((10 ** 12, '조'), (10 ** 8, '억'), (10 ** 4, '만'), (1, '')):
        q, n = divmod(n, unit)
        if q:
            w = under10k(q, gap=gap)
            if name == '만' and q == 1:
                w = ''            # 만 원(일만 원 아님)
            out.append(w + name)
    return ' '.join(out)


def native(n):
    if n in NATIVE:
        return NATIVE[n]
    t, o = divmod(n, 10)
    return (NATIVE[t * 10] if t else '') + (NATIVE[o] if o else '')


def _num(s):
    return int(s.replace(',', ''))


def money(m):
    """«3조 3,900억» «636억 5,000만» «1만 4,000» 같은 큰 단위 묶음 → 한 덩어리로 읽는다."""
    total = 0
    for v, u in re.findall(r'(\d[\d,]*)\s*(조|억|만)?', m.group(0)):
        total += _num(v) * {'조': 10 ** 12, '억': 10 ** 8, '만': 10 ** 4, '': 1}[u]
    return sino(total, gap=' ')  # 10-20 ep01 역전사: «천삼백이십오억»이 붙어 «1030 25억»·«2876억»으로 들렸다 → «천 삼백이십오억»


def say(text):
    for w in sorted(YOMI, key=len, reverse=True):
        text = text.replace(w, YOMI[w])
    # 소수(약 3.5배) → 삼 점 오
    text = re.sub(r'(\d+)\.(\d+)', lambda m: sino(int(m.group(1))) + ' 점 ' + ' '.join(DIG[int(c)] for c in m.group(2)), text)
    # 월: 유월·시월
    text = re.sub(r'(\d{1,2})월', lambda m: MONTH.get(int(m.group(1)), sino(int(m.group(1)))) + '월', text)
    # 날짜 «11일» → «십일일»(10-20 ep01: «십일 일»이 두 번 다 «12일»로 들렸다)
    text = re.sub(r'(?<![\d,])(\d{1,2})일', lambda m: sino(int(m.group(1))) + '일', text)
    # 조·억·만 묶음(단위가 하나라도 붙은 것) → 먼저
    text = re.sub(r'\d[\d,]*\s*(?:조|억|만)(?:\s*\d[\d,]*\s*(?:억|만))*(?:\s*\d[\d,]*(?=\s*[원명]))?', money, text)
    # 고유어 단위(99 이하, 앞이 숫자가 아닐 때)
    text = re.sub(r'(?<![\d,])(\d{1,2})\s*(' + '|'.join(NATIVE_COUNTERS) + r')(?![가-힣]*원)',
                  lambda m: (native(int(m.group(1))) if int(m.group(1)) < 50 else sino(int(m.group(1)))) + ' ' + m.group(2), text)
    # 나머지 수
    text = re.sub(r'\d[\d,]*', lambda m: sino(_num(m.group(0))) + ' ', text)
    return re.sub(r' {2,}', ' ', text).replace(' ,', ',').replace(' .', '.').strip()


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    for a in sys.argv[1:]:
        print(say(a))
