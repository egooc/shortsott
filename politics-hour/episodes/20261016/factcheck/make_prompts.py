"""사실 확인 프롬프트: 원고 + 쓰는 인용(화자·핵심 문구) — gpt-ask.js 로 보낸다."""
import json, re, sys
from pathlib import Path
H = Path(__file__).resolve().parent.parent
HEAD = ('너는 한국 정치 유튜브 원고의 사실 확인 담당이다. 아래는 2026-10-16 공개할 롱폼 원고 1부(파이썬 파일 안의 문자열)와, 원고가 끼워 넣는 실제 발언 영상 인용 목록이다.\n'
        '할 일:\n1. 원고 해설(text·visual·source)에서 확인 가능한 사실 주장(인물 이름·직함·소속 정당, 날짜, 숫자, 인용 발언, 사건 경과)을 최대 12개 뽑아라.\n'
        '2. 각 주장을 웹 검색으로 확인하라. 언론 기사·공식 자료만 출처로 인정한다.\n'
        '3. 표로 답하라: | # | 원고 문장(짧게) | 판정(맞음/틀림/일부 틀림/확인 불가) | 근거 한 줄 | 출처 URL |\n'
        '4. 표 아래에 «사실처럼 썼지만 실제로는 주장·평가인 문장»을 최대 5개 적어라. 한 의원 발언을 정당 전체로 일반화한 곳, «약속»과 «검토»를 섞은 곳도 짚어라.\n'
        '5. 인용 목록의 화자 이름·직함·날짜가 보도와 다르면 따로 적어라.\n'
        '6. 마지막 줄: 전체 위험도(낮음/중간/높음)와 이유 한 줄.\n한국어로 답하라. 추측으로 판정하지 마라.\n')
for n in sys.argv[1:]:
    code = (H / f'script_{n}.py').read_text(encoding='utf-8')
    quotes = json.loads((H / 'issues' / f'{n}.json').read_text(encoding='utf-8'))['quotes']
    used = []
    for m in re.finditer(r"q\(quotes, (\w+|'[^']+'), ([\d.]+)", code):
        src, t = m.group(1), float(m.group(2))
        src = src.strip("'") if src.startswith("'") else re.search(rf"{src}[^=]*?= *'([^']+)'", code) and None
        for x in quotes:
            if abs(x['in'] - t) < .05 and (src is None or x['src'] == src):
                used.append(f"- {x['speaker']} ({x['role']}, {x['tag']}): " + ' / '.join(p.replace('*', '') for p in x['phrases']) + f"  [{x['source']}]")
                break
    body = HEAD + '\n--- 원고 ---\n' + code + '\n--- 인용 목록 ---\n' + '\n'.join(used) + '\n'
    (H / 'factcheck' / f'prompt_{n}.txt').write_text(body, encoding='utf-8')
    print(n, len(used), '인용')
