"""정치 롱폼 보관 기간 정리(소유주 10-18 «일주일로 진행»): 매일 새벽 schtasks 가 부른다.

    python politics-hour/cleanup.py            지울 목록과 크기만 보여 준다(기본)
    python politics-hour/cleanup.py --apply    실제로 지운다

- 7일 지난 편: 받아 둔 원본 방송(episodes/<날짜>/src), 렌더 중간 파일(work/seg·work_coldtest*),
  쇼츠 렌더 중간 파일(shorts/ls/<날짜>/*/_render 안의 final.mp4 말고 전부). 썸네일 교체는 완성 영상만 쓰므로 필요 없다.
- 30일 지난 편: 완성 영상(work/episode.mp4·쇼츠 final.mp4). 늦게 반응이 오는 편의 새 썸네일·재업로드 예비본용.
- 원고·썸네일·packages.json·keywords.json·기록은 계속 둔다(편당 몇 MB).
- 날짜 = 폴더 이름(공개일). 업로드 기록(upload_log.jsonl 의 videoId)이 없는 편, 렌더 중(RENDERING.lock)에는 아무것도 안 지운다."""
import json, shutil, sys, time
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / 'server' / 'data'
KEEP_SRC, KEEP_FINAL = 7, 30
apply = '--apply' in sys.argv


def size(p):
    return p.stat().st_size if p.is_file() else sum(f.stat().st_size for f in p.rglob('*') if f.is_file())


def uploaded(log):
    if not log.exists():
        return False
    return any(json.loads(l).get('videoId') for l in log.read_text(encoding='utf-8').splitlines() if l.strip())


if (ROOT / 'RENDERING.lock').exists():
    print('[cleanup] 렌더 중(RENDERING.lock) — 건너뜀')
    sys.exit(0)
today = datetime.strptime(sys.argv[sys.argv.index('--today') + 1], '%Y%m%d').date() if '--today' in sys.argv else date.today()   # 시험용
targets = []
for ep in sorted((ROOT / 'episodes').iterdir()):
    try:
        age = (today - datetime.strptime(ep.name, '%Y%m%d').date()).days
    except ValueError:
        continue
    if age <= KEEP_SRC:
        continue
    if not uploaded(ep / 'upload_log.jsonl'):
        print(f'[cleanup] {ep.name} 업로드 기록 없음 — 건너뜀')
        continue
    targets += [ep / 'src', ep / 'work' / 'seg', *ep.glob('work_coldtest*')]
    if age > KEEP_FINAL:
        targets.append(ep / 'work' / 'episode.mp4')
    ls = ROOT / 'shorts' / 'ls' / ep.name
    if ls.exists() and uploaded(ROOT / 'shorts' / ep.name / 'upload_log.jsonl'):
        for r in ls.glob('*/_render'):
            targets += [f for f in r.iterdir() if f.name != 'final.mp4' or age > KEEP_FINAL]
targets = [t for t in targets if t.exists()]
total = 0
for t in targets:
    n = size(t)
    total += n
    print(f'[cleanup] {"삭제" if apply else "대상"} {t.relative_to(ROOT)} {n / 2**30:.2f}GB')
    if apply:
        shutil.rmtree(t) if t.is_dir() else t.unlink()
print(f'[cleanup] {"삭제" if apply else "대상"} {len(targets)}건 {total / 2**30:.2f}GB')
if apply and targets:
    with open(DATA / 'politics_cleanup.jsonl', 'a', encoding='utf-8') as f:
        f.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'n': len(targets), 'gb': round(total / 2**30, 2),
                            'paths': [str(t.relative_to(ROOT)) for t in targets]}, ensure_ascii=False) + '\n')
