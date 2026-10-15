# -*- coding: utf-8 -*-
"""ja 「戦国なぜ」 쇼츠 원고 검사 — midform/config/ja_naze_script_frames.json 의 checks 를 기계로 건다.

    python scripts/naze_script_check.py <원고.json> [--json]

원고 형식은 틀 파일의 input_format. 종료 코드: 0 통과(WARN 만), 4 FAIL 있음, 2 인자 오류.
왜 (2026-10-16 소유주 «추천대로»): 歴史リワインド 독립 «なぜ» 쇼츠(중앙값 10.9만)의 틀을 수치로 고정한다 —
  답 먼저 → 구조 순서 → 닫는 한 줄 → 주제 CTA. 원고를 사람이 다 읽기 전에 형식 실수를 걸러낸다.
"""
import argparse
import json
import re
import sys
from pathlib import Path

FRAMES = Path(__file__).resolve().parents[1] / 'midform' / 'config' / 'ja_naze_script_frames.json'
HEDGE = ('諸説', 'とも言われ', 'といわれ', 'と伝わ', 'という説', 'とされ')


def frames():
    return json.loads(FRAMES.read_text(encoding='utf-8'))


def _read(line):
    return line.get('read') or line['text']


def check(s, fr=None):
    """[(level, id, msg)]"""
    fr = fr or frames()
    out = []
    title, key = s.get('title', ''), s.get('key', '')
    lines = s.get('lines', [])
    texts = [ln['text'] for ln in lines]
    if not lines:
        return [('FAIL', 'N0', '문장이 없다')]
    if len(title) > 40 or not re.search(r'[?？]$', title):
        out.append(('FAIL', 'N1', '제목은 40자 이내·물음표로 끝: %r (%d자)' % (title, len(title))))
    first = texts[0]
    if re.search(r'[かの][?？。]?$|[?？]$', first) or len(first) > 35:
        out.append(('FAIL', 'N2', '첫 문장은 답을 먼저(물음 금지·35자 이내): %r' % first))
    lo, hi = fr['length_sec']
    sec = sum(len(_read(ln)) for ln in lines) / fr['read_speed_chars_per_sec'] + fr['gap_sec'] * (len(lines) - 1)
    if not lo <= sec <= hi:
        out.append(('FAIL', 'N3', '읽는 시간 %.0f초 — %d~%d초 밖' % (sec, lo, hi)))
    lens = [len(t) for t in texts]
    if sum(lens) / len(lens) > 30 or max(lens) > 45:
        out.append(('FAIL', 'N4', '문장 평균 %.1f자·최대 %d자(기준 30·45)' % (sum(lens) / len(lens), max(lens))))
    terms = s.get('terms', [])
    body = ''.join(texts)
    missing = [t for t in terms if t not in body]
    if not 1 <= len(terms) <= 5 or missing:
        out.append(('WARN', 'N5', '용어 %d개(1~5)%s' % (len(terms), ', 본문에 없음: %s' % missing if missing else '')))
    if len(texts) < 2 or not key or key not in texts[-2]:
        out.append(('FAIL', 'N6', '닫는 줄에 key %r 없음: %r' % (key, texts[-2] if len(texts) > 1 else '')))
    if not key or key not in texts[-1] or not re.search('高評価|チャンネル登録', texts[-1]):
        out.append(('FAIL', 'N7', 'CTA 에 key·高評価/チャンネル登録 필요: %r' % texts[-1]))
    if not [u for u in s.get('sources', []) if re.match(r'https?://', u)]:
        out.append(('FAIL', 'N8', '출처 URL 없음'))
    for i, ln in enumerate(lines):
        r = _read(ln)
        bad = re.findall(r'[0-9０-９]+|[%％]|〇|(?<=[一二三四五六七八九十])・(?=[一二三四五六七八九十])', r)
        if bad:
            out.append(('FAIL', 'N9', '%d번 읽기용 문장에 %s — 한자 숫자·パーセント로(text 는 그대로 두고 read 를 달 것)'
                        % (i + 1, ''.join(sorted(set(bad))))))
    if s.get('contested') and not any(h in body for h in HEDGE):
        out.append(('FAIL', 'N10', '諸説 있는 주제인데 유보 표현이 없다'))
    if not any('時代劇' in t for t in texts[1:3]):
        out.append(('WARN', 'N11', '둘째·셋째 문장에 時代劇 장면 언급이 없다'))
    return out


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='戦国なぜ 쇼츠 원고 검사')
    ap.add_argument('script')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    issues = check(json.loads(Path(a.script).read_text(encoding='utf-8')))
    fails = [i for i in issues if i[0] == 'FAIL']
    if a.json:
        print(json.dumps({'ok': not fails, 'issues': issues}, ensure_ascii=False, indent=2))
    else:
        for lv, cid, msg in issues:
            print('%s %s %s' % (lv, cid, msg))
        print('PASS' if not fails else 'FAIL %d건' % len(fails))
    return 4 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
