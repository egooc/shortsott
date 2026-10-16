"""렌더가 끝난 뒤 제목·설명(챕터·출처)을 만든다 -> meta.txt"""
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ep = json.loads((HERE / 'episode.json').read_text(encoding='utf-8'))
parts = [Path(l.split("'")[1]) for l in (HERE / 'work' / 'concat.txt').read_text(encoding='utf-8').splitlines() if l.strip()]
assert len(parts) == len(ep['segments']), (len(parts), len(ep['segments']))


def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout)


def stamp(t):
    t = int(t)
    return f'{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}' if t >= 3600 else f'{t // 60}:{t % 60:02d}'


chapters, clock, seen = [('0:00', '오늘의 쟁점')], 0.0, set()
for s, p in zip(ep['segments'], parts):
    tag = s.get('issue_tag', '')
    if tag.startswith('ISSUE') and tag not in seen:
        seen.add(tag)
        chapters.append((stamp(clock), tag.replace('ISSUE ', '').replace(' · ', ' ')))
    clock += dur(p)
chapters.append((stamp(clock - dur(parts[-1])), '정리'))

videos = []
for s in ep['segments']:
    if s['type'] == 'quote' and s['source'] not in videos:
        videos.append(s['source'])
links = []
for n in (1, 2, 3, 4):
    for u in json.loads((HERE / 'issues' / f'{n}.json').read_text(encoding='utf-8')).get('sources', []):
        if 'youtube.com' not in u and u not in links:
            links.append(u)

titles = [t.split(' · ', 1)[1] for t in dict.fromkeys(s.get('issue_tag', '') for s in ep['segments']) if t.startswith('ISSUE')]
# 제목은 주제를 다 밝히지 않는다: 썸네일 발언 + 궁금증, 쟁점 목록은 설명란·챕터에만(소유주 10/14)
title = '"솔직히 기억은 나지 않습니다" 오세훈, 한강버스 수사의뢰서 추궁에… 조희대 재제청·막말 3인방 제명론 | 국정감사 쟁점 브리핑 10.16'   # 10-15 소유주: 후킹 + 검색 낱말(인물·위원회·쟁점·국정감사). 태그는 upload.json tags 15~20개
desc = [f'한강버스 수사의뢰서부터 문체위 «오만하겠습니다»까지. 오늘의 쟁점 {len(titles)}가지, 국감장에서 나온 실제 발언 그대로 정리했습니다.', '',
        *[f'{a} {b}' for a, b in chapters], '',
        '■ 인용 영상 출처', *[v.replace('영상: ', '- ') for v in videos], '',
        '■ 참고 보도', *[f'- {u}' for u in links], '',
        '※ 의원·패널의 주장으로 소개한 내용은 확인된 사실이 아닙니다. 사실관계 오류는 댓글로 알려 주시면 바로잡겠습니다.']
out = HERE / 'meta.txt'
out.write_text(title + '\n\n' + '\n'.join(desc) + '\n', encoding='utf-8')
print(out, f'{clock / 60:.1f}분')
