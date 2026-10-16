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
TITLES = {1: '대법관 재제청 공방', 2: '대통령 부모 묘소 논란', 3: 'DMZ 폭발 규탄 결의안', 4: 'KTX·SRT 통합'}
FOLLOWUP = {2}   # 이전 편에서 다룬 쟁점의 후속


def main():
    segs, labels = [], {}
    packs = {}
    for n in ISSUES:
        packs[n] = json.loads((HERE / 'issues' / f'{n}.json').read_text(encoding='utf-8'))
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
    intro = {'type': 'nar', 'issue_tag': '쟁점 브리핑 · 10월 14일', 'bg': first_bg, 'source': labels[first_bg['src']],
             'visual': {'type': 'timeline', 'title': '오늘의 쟁점', 'steps': order},
             'text': '쟁점 브리핑입니다. 오늘은 10월 14일, 지금 가장 뜨겁게 맞붙고 있는 쟁점 ' + str(len(ISSUES)) + '가지를 정리합니다. '
                     '쟁점마다 무엇이 문제인지 짚고, 양쪽이 실제로 한 말을 같은 무게로 들려 드리겠습니다. 판단은 보시는 분의 몫입니다.'}
    outro = {'type': 'nar', 'issue_tag': '쟁점 브리핑 · 10월 14일', 'bg': first_bg, 'source': labels[first_bg['src']],
             'visual': {'type': 'timeline', 'title': '오늘 정리한 쟁점', 'steps': order},
             'text': '오늘 쟁점 브리핑은 여기까지입니다. 양쪽의 주장과 실제 발언을 가능한 한 같은 무게로 담았습니다. '
                     '어느 쪽 말에 더 무게를 둘지는, 판단은 시청자 여러분께 맡기겠습니다.'}
    ep = {'workdir': 'work', 'segments': [intro] + segs + [outro],
          'chrome': {'brand': '쟁점 브리핑', 'date': '10.14 (수)', 'ticker': list(TITLES.values()) + ['국정감사 10월 27일까지']}}
    out = HERE / 'episode.json'
    out.write_text(json.dumps(ep, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(out, len(ep['segments']), '조각')


main()
