"""쟁점 원고(script_N.py)와 쟁점 자료(issues/N.json)를 묶어 episode.json 을 만든다.

    python build_episode.py            -> episode.json, 그다음 episode_check.py 로 검사
해설 배경 영상도 남의 영상이므로 출처(영상: 채널 날짜)를 붙인다.
"""
import importlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ISSUES = [int(a) for a in sys.argv[1:]] or [1, 2, 3, 4]
TITLES = {1: '옥중 영치금 22억', 2: '조희대 국감', 3: '지뢰 규탄 결의안 채택', 4: '주진우 vs 서영교'}
FOLLOWUP = {3}   # 이전 편에서 다룬 쟁점의 후속
# 첫머리(10-15 소유주): 썸네일에 쓴 그 장면을 «쟁점 브리핑입니다» 앞에 잠깐 먼저 — 본문 인용(같은 src·화자, 구간을 품는 것)의 일부
COLD_OPEN = {'src': 'src/eHf71pXdShI.mp4', 'speaker': '서영교', 'in': 533.6, 'out': 536.63,
             'phrases': ['잘못했으면 *꼬리를* *딱* *내려야지* 말이야']}   # 낱말마다 *강조* = 노랑   # 503초 쪽은 회의장 전경이라 얼굴이 안 보인다 — 클로즈업 구간
PUNDITS = HERE / 'issues' / 'pundits.json'   # 시사 스피커 논평(쟁점 번호별), 쟁점 자료의 quotes 에 합친다


def main():
    segs, labels = [], {}
    packs = {}
    for n in ISSUES:
        packs[n] = json.loads((HERE / 'issues' / f'{n}.json').read_text(encoding='utf-8'))
        if PUNDITS.exists():
            packs[n]['quotes'] += json.loads(PUNDITS.read_text(encoding='utf-8')).get(str(n), [])
        for x in packs[n]['quotes']:
            labels.setdefault(x['src'], x['source'].split(' (')[0])
    first_bg = None
    for n in ISSUES:
        mod = importlib.import_module(f'script_{n}')
        labels.update(getattr(mod, 'BROLL_SOURCE', {}))
        k = 0
        for s in mod.segments(packs[n]['quotes']):
            s = dict(s, issue_tag=mod.TAG)
            if n in FOLLOWUP:
                s['followup'] = True
            if s['type'] == 'nar':
                src, start = mod.BROLL[k % len(mod.BROLL)]; k += 1
                s['bg'] = {'src': src, 'start': start}
                first_bg = first_bg or s['bg']
                vid = labels.get(src)
                if not vid:
                    sys.exit(f'배경 영상 출처를 모른다: {src}')
                s['source'] = f'{s["source"]} · {vid}' if s.get('source') else vid
            segs.append(s)
    # 강조 *...* 가 여러 낱말에 걸치면 인용 템플릿이 낱말마다만 읽어 별표가 남는다 -> 낱말마다 감싼다
    star_words = lambda m: ' '.join(f'*{w}*' for w in m.group(1).split())
    for s in segs:
        if s['type'] == 'quote':
            s['phrases'] = [re.sub(r'\*([^*]+)\*', star_words, p) for p in s['phrases']]
    # 시각 화면이 없는 짧은 해설은 다음에 말할 사람을 띄우는 연결 화면으로
    for i, s in enumerate(segs):
        if s['type'] == 'nar' and 'visual' not in s:
            nxt = segs[i + 1] if i + 1 < len(segs) and segs[i + 1]['type'] == 'quote' else None
            s['visual'] = {'type': 'bridge', 'title': nxt['speaker'] if nxt else '', 'sub': nxt['role'] if nxt else ''}
    order = [[f'{i + 1:02d}', TITLES[n]] for i, n in enumerate(ISSUES)]
    intro = {'type': 'nar', 'issue_tag': '쟁점 브리핑 · 10월 15일', 'bg': first_bg, 'source': labels[first_bg['src']],
             'visual': {'type': 'timeline', 'title': '오늘의 쟁점', 'steps': order},
             'text': '쟁점 브리핑입니다. 10월 15일, 국정감사 2주차 법사위가 발칵 뒤집혔습니다. 오늘 짚을 쟁점은 ' + str(len(ISSUES)) + '가지입니다. '
                     '감옥에서 쌓인 영치금 22억, 국감장에서 끝내 선서를 거부한 대법원장, 북한 규탄 결의안 앞에서 또 자리를 뜬 국민의힘, 그리고 대통령 골프를 사흘 내내 물고 늘어진 주진우 의원입니다. '
                     '실제 발언 그대로, 하나씩 보겠습니다.'}
    outro = {'type': 'nar', 'issue_tag': '쟁점 브리핑 · 10월 15일', 'bg': first_bg, 'source': labels[first_bg['src']],
             'visual': {'type': 'timeline', 'title': '오늘 정리한 쟁점', 'steps': order},
             'text': '오늘 쟁점 브리핑은 여기까지입니다. 국감은 10월 27일까지 이어집니다. 내일도 국감장에서 나온 실제 발언 그대로, 시원하게 정리해 드리겠습니다. '
                     '판단은 시청자 여러분께 맡기겠습니다. 구독과 좋아요로 함께해 주십시오.'}
    cold = []
    if COLD_OPEN:   # 10-15 소유주: 이름표·인용 카드 없이 큰 자막만(overlay/cold_overlay.py)
        base = next(s for s in segs if s['type'] == 'quote' and s['speaker'] == COLD_OPEN['speaker']
                    and s['src'] == COLD_OPEN['src'] and s['in'] <= COLD_OPEN['in'] and COLD_OPEN['out'] <= s['out'] + .5)
        vid = Path(COLD_OPEN['src']).stem
        toks = [w for w in json.loads((HERE / 'transcripts' / f'{vid}.json').read_text(encoding='utf-8'))
                if COLD_OPEN['in'] - .05 <= w[0] < COLD_OPEN['out']]
        shown = ' '.join(COLD_OPEN['phrases']).split()
        toks = toks[-len(shown):] if len(toks) >= len(shown) else toks + [toks[-1]] * (len(shown) - len(toks))   # 앞 군말(«예»)은 버린다
        words = [[round(tk[0] - COLD_OPEN['in'], 3), w.strip('*'), w.startswith('*')] for tk, w in zip(toks, shown)]
        cold = [{'type': 'cold', 'src': base['src'], 'in': COLD_OPEN['in'], 'out': COLD_OPEN['out'],
                 'words': words, 'source': base['source']}]
    ep = {'workdir': 'work', 'segments': cold + [intro] + segs + [outro],
          'chrome': {'stance': 'partisan', 'brand': '쟁점 브리핑', 'date': '10.15 (목)', 'ticker': list(TITLES.values()) + ['국정감사 10월 27일까지']}}
    out = HERE / 'episode.json'
    out.write_text(json.dumps(ep, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(out, len(ep['segments']), '조각')


main()
