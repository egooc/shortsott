# 결 분석 GPT 질의 생성(기업흥망 ko): 받아쓰기 + heatmap(있을 때) + 댓글 → gpt/q_<id>.md
#   python -X utf8 mkq_corp.py            (scan.json 의 모든 편)
import json, re, sys
from pathlib import Path

H = Path(__file__).parent
d = json.loads((H / 'scan.json').read_text(encoding='utf-8'))
(H / 'gpt').mkdir(exist_ok=True)


def body(vid):
    ls = [l for l in (H / 'tr' / f'{vid}.md').read_text(encoding='utf-8').splitlines() if l.startswith('[')]
    txt = lambda l: l.split('] ', 1)[-1]
    # 자동 자막의 굴러가는 줄(다음 줄이 이 줄을 품음)은 뺀다
    return '\n'.join(l for i, l in enumerate(ls) if not (i + 1 < len(ls) and txt(l) in txt(ls[i + 1])))


for vid, v in d.items():
    hm = ' '.join(f"{int(t)}:{x:.2f}" for t, x in v['hm']) if v['hm'] else '(이 편은 유튜브가 그래프를 공개하지 않음 — 댓글·대사로만 추정하고 «추정»이라 적어라)'
    ts = '\n'.join(f'- (좋아요 {l}) {t}' for l, t in v['ts'][:25]) or '(없음)'
    top = '\n'.join(f'- (좋아요 {l}) {t[:300]}' for l, t in v['top'][:15])
    q = f"""아래는 한국 유튜브 «기업·업종 흥망» 롱폼 1황 채널의 터진 영상 1편 자료다. 제목: {v['title']} / 조회 {int(v['views']):,} / 길이 {v['dur']}초.
자료 A = 시각별 대사(자동 자막, 오타 있음). 자료 B = «가장 많이 다시 본 구간» 그래프(구간 시작초:상대값 0~1). 자료 C = 타임스탬프 댓글, 자료 D = 좋아요 상위 댓글.
처음 3% 구간은 늘 높으니 무시한다. 지어내지 말고 자료에 있는 것만 쓴다. 한국어로만.

해 줄 일 — 아래 표와 결론만:
⓪ 첫 30초: 0~30초 대사 요지와 «큰 질문»(제목이 약속한 것)이 몇 초에 걸리는지, 그 답(제목이 약속한 장면)이 몇 초(전체의 몇 %)에 오는지
① 정점 표: 그래프 정점 4개(그래프가 없으면 댓글이 가리키는 장면 4개, «추정») | 초 | 상대값 | 그때 대사 | 왜 다시 보는지(한 줄)
② 댓글 반응 표: 좋아요 상위 댓글 6개 | 요지 | 연결되는 장면(초) | 유형(웃음·분노·공감·정정·경험담·지식 보탬)
③ 궁금증 고리 표: | 질문이 걸리는 초 | 질문 | 답이 풀리는 초 | 간격(초) | 반전 여부 | — 영상 전체에서 빠짐없이
④ 꺼짐 표: 그래프가 크게 꺼지는 곳 3개(그래프가 없으면 숫자·조건 나열·정리 같은 지루할 대사 3곳, «추정») | 초 | 대사 | 이유
⑤ 갈림길 장치: «두 갈래 비교»(사람·회사·선택)가 있으면 몇 초에 무엇과 무엇을 맞대는지, «들뜬 선언/성공 → 뒤집기» 줄의 초 목록, 돈 숫자를 «내 손해·내 지갑»으로 바꾼 줄
⑥ 이 편의 «터지는 포인트» 3줄.

자료 B:
{hm}

자료 C:
{ts}

자료 D:
{top}

자료 A:
{body(vid)}
"""
    (H / 'gpt' / f'q_{vid}.md').write_text(q, encoding='utf-8')
    print(vid, len(q))
