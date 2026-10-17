"""업로드 전 키워드 관문 — keywords.json 없이는 업로드 단계로 못 넘어간다(관리자 10-17, 소유주 «롱폼은 키워드랑 태그야»).

    python politics-hour/upload_gate.py <에피소드 폴더> [upload.json ...]

검사: <에피소드>/keywords.json 이 있고 keywords 가 3~5개. upload.json 을 주면 키워드마다 제목·설명 첫 두 줄·태그 중
한 곳 이상에 들어 있어야 하고, 태그는 15~25개.
쇼츠 upload.json(경로에 '/shorts/')은 한 쟁점만 다루므로 키워드 2개 이상만 보고 태그 개수는 안 본다.
하나라도 어긋나면 exit 3 — 업로드하지 말고 관리자에게 보고."""
import json, sys
from pathlib import Path

ep = Path(sys.argv[1])
bad = []
kp = ep / 'keywords.json'
if not kp.exists():
    bad.append(f'keywords.json 없음: {kp}')
    kws = []
else:
    kws = json.loads(kp.read_text(encoding='utf-8')).get('keywords', [])
    if not 3 <= len(kws) <= 5:
        bad.append(f'keywords {len(kws)}개 (3~5개여야 함)')
for up in sys.argv[2:]:
    u = json.loads(Path(up).read_text(encoding='utf-8'))
    tags = u.get('tags') or []
    hay = ' '.join([u.get('title', ''), *u.get('description', '').split('\n')[:2], *tags])
    short = '/shorts/' in up.replace('\\', '/')
    miss = [k for k in kws if k.split('(')[0].strip() not in hay]
    if short and len(kws) - len(miss) < 2:
        bad.append(f'{Path(up).name}: 쇼츠 키워드 {len(kws) - len(miss)}개 (2개 이상이어야 함)')
    for k in ([] if short else miss):
        bad.append(f'{Path(up).name}: 키워드 «{k}» 가 제목·설명 첫 두 줄·태그에 없음')
    if not short and not 15 <= len(tags) <= 25:
        bad.append(f'{Path(up).name}: 태그 {len(tags)}개 (15~25개여야 함)')
for b in bad:
    print('[gate] FAIL', b)
if bad:
    sys.exit(3)
print('[gate] PASS', ep.name, ' · '.join(kws))
