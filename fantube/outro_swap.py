"""엔딩 애교 움짤 돌리기. python outro_swap.py <spec.json> <pool id>
spec 의 마지막 구간(엔딩 움짤)을 outro_pool.json 의 항목으로 바꾸고, 끝에 붙어 있던 closer 자막·sparkle 의 끝을 길이 차만큼 옮긴다.
풀 항목 규칙(린박스·롱투숏 10/15 답): 말 끝 +0.3~0.5초까지 담고, 클립 앞·끝에 15프레임 이하 샷이 끼면 안 된다(경계 −1프레임/+1프레임). 안쪽 경계는 둔다."""
import json
import sys
from pathlib import Path

POOL = Path(__file__).with_name('outro_pool.json')


def swap(spec_path, pid):
    p = Path(spec_path)
    spec = json.loads(p.read_text(encoding='utf-8'))
    pool = {o['id']: o for o in json.loads(POOL.read_text(encoding='utf-8'))}
    new = {k: v for k, v in pool[pid].items() if k not in ('id', 'note', 'rule')}
    old = spec['segments'][-1]
    total = sum(s['end'] - s['start'] for s in spec['segments'])
    delta = (new['end'] - new['start']) - (old['end'] - old['start'])
    spec['segments'][-1] = new
    for c in spec.get('captions', []):
        if abs(c.get('end', -1) - total) < 0.05:
            c['end'] = round(c['end'] + delta, 3)
    for e in spec.get('events', []):
        if abs(e.get('until', -1) - total) < 0.05:
            e['until'] = round(e['until'] + delta, 3)
    spec['outro'] = pid
    p.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{p.parent.name}: 엔딩 → {pid} (길이 {delta:+.2f}s)')


if __name__ == '__main__':
    swap(sys.argv[1], sys.argv[2])
