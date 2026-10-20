"""업로드 전 키워드 관문 — keywords.json 없이는 업로드 단계로 못 넘어간다(관리자 10-17, 소유주 «롱폼은 키워드랑 태그야»).

    python politics-hour/upload_gate.py <에피소드 폴더> [upload.json ...]

검사: <에피소드>/keywords.json 이 있고 keywords 가 3~5개. upload.json 을 주면 키워드마다 제목·설명 첫 두 줄·태그 중
한 곳 이상에 들어 있어야 하고, 태그는 15~25개.
쇼츠 upload.json(경로에 '/shorts/')은 한 쟁점만 다루므로 키워드 2개 이상만 보고 태그 개수는 안 본다.
썸네일 큰 낱말(thumb/thumb_k*.json 의 big → keywords.json thumb → keywords 1~2위)은 롱폼 첫 30초(콜드오픈+첫 해설)·쇼츠 첫 5초에 다 나와야 한다(10-17).
episode.json 에 "tts_say": true 인 편(10/20~)은 overlay/tts_audit.py 역전사 대조 결과(audit/result.json)가 ok 여야 한다.
하나라도 어긋나면 exit 3 — 업로드하지 말고 관리자에게 보고."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts')); import guide_words   # 가이드 낱말 공용 판정(소유주 10-18 «조회 0 = 가이드 위반»)

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
    short = 'shorts' in Path(up).resolve().parts
    miss = [k for k in kws if k.split('(')[0].strip() not in hay]
    if short and len(kws) - len(miss) < 2:
        bad.append(f'{Path(up).name}: 쇼츠 키워드 {len(kws) - len(miss)}개 (2개 이상이어야 함)')
    for k in ([] if short else miss):
        bad.append(f'{Path(up).name}: 키워드 «{k}» 가 제목·설명 첫 두 줄·태그에 없음')
    if not short and not 15 <= len(tags) <= 25:
        bad.append(f'{Path(up).name}: 태그 {len(tags)}개 (15~25개여야 함)')
# 썸네일 큰 낱말 → 첫 장면(관리자·소유주 10-17 «썸네일에 나오는 내용이 훅으로 처음에 들어가야»):
# 롱폼은 콜드오픈 words + 첫 해설(text·화면 카드), 쇼츠는 plan 의 제목·해설 카드·첫 자막(첫 5초)에 큰 낱말의 낱말마다 다 들어 있어야 한다.
def big_words(cfg_path):
    cfg = json.loads(cfg_path.read_text(encoding='utf-8')) if cfg_path.exists() else {}
    kwj = json.loads(kp.read_text(encoding='utf-8')) if kp.exists() else {}
    return cfg.get('big') or kwj.get('thumb') or kws[:2]


def need(words, hay, where):
    for w in words:
        lost = [t for t in w.split() if t not in hay]
        if lost:
            bad.append(f'{where}: 썸네일 큰 낱말 «{w}» 의 {lost} 가 첫 장면에 안 나옴')


epj = ep / 'episode.json'
if epj.exists():
    segs = json.loads(epj.read_text(encoding='utf-8'))['segments']
    cold = next((s for s in segs if s['type'] == 'cold'), {})
    nar = next((s for s in segs if s['type'] == 'nar'), {})
    hay = ' '.join([' '.join(w[1] for w in cold.get('words', [])), nar.get('text', ''), json.dumps(nar.get('visual', {}), ensure_ascii=False)])
    need(big_words(ep / 'thumb' / 'thumb_k.json'), hay, '롱폼 첫 30초(콜드오픈+도입)')
# 제목 맨 앞 낱말 = 썸네일 1순위 큰 낱말(관리자 10-17): 롱폼 upload.json 제목이 big[0] 으로 시작해야 한다.
top = (big_words(ep / 'thumb' / 'thumb_k.json') or [''])[0]
for up in sys.argv[2:]:
    if 'shorts' in Path(up).resolve().parts:
        continue
    t = json.loads(Path(up).read_text(encoding='utf-8')).get('title', '')
    if top and not t.startswith(top):
        bad.append(f'{Path(up).name}: 제목 «{t}» 이 썸네일 1순위 낱말 «{top}» 으로 시작하지 않음')
# 자동 교체 대체 포장(packages.json 1번~, 관리자 10-18): 포장마다 big(인용 썸네일의 핵심 낱말)이 있어야 하고,
# 제목은 big[0] 으로 시작, big 낱말은 롱폼 첫 30초에 나와야 한다 — 교체 순간엔 사람이 못 보니 업로드 전에 미리 통과시킨다.
pkp = ep / 'packages.json'
if pkp.exists() and epj.exists():
    for i, pkg in enumerate(json.loads(pkp.read_text(encoding='utf-8'))['packages'][1:], 1):
        if not pkg.get('big'):
            bad.append(f'packages.json {i}번: big(핵심 낱말) 없음')
            continue
        if not pkg['title'].startswith(pkg['big'][0]):
            bad.append(f'packages.json {i}번: 제목 «{pkg["title"]}» 이 «{pkg["big"][0]}» 으로 시작하지 않음')
        if not (Path(__file__).resolve().parent.parent / pkg['thumbnail']).exists():
            bad.append(f'packages.json {i}번: 썸네일 없음 {pkg["thumbnail"]}')
        need(pkg['big'], hay, f'packages.json {i}번 첫 30초')
        if 'tags' in pkg and not 15 <= len(pkg['tags']) <= 25:   # 교체 때 태그도 통째로 바뀐다(관리자 10-18)
            bad.append(f'packages.json {i}번: 태그 {len(pkg["tags"])}개 (15~25개여야 함)')
        if 'tags' in pkg or 'desc_head' in pkg:
            phay = ' '.join([pkg['title'], *pkg.get('desc_head', []), *pkg.get('tags', [])])
            for k in kws:
                if k.split('(')[0].strip() not in phay:
                    bad.append(f'packages.json {i}번: 키워드 «{k}» 가 제목·desc_head·tags 에 없음')
for up in sys.argv[2:]:
    if 'shorts' not in Path(up).resolve().parts:
        continue
    name = Path(up).name.split('.')[0]
    plan = Path(up).parent.parent / 'ls' / Path(up).parent.name / name / 'plan.json'
    if not plan.exists():
        bad.append(f'{name}: plan.json 없음 {plan}')
        continue
    pj = json.loads(plan.read_text(encoding='utf-8'))
    seq = [s for s in pj['sequence'] if 'captions' in s]
    first = [c.split('|')[-1] for c in (seq[0]['captions'][:3] if seq else [])]
    hay = ' '.join([*pj.get('title', []), *[c for n in pj.get('narration', []) for c in n.get('cards', [])], *first])
    need(big_words(ep / 'thumb' / f'thumb_k_{name}.json'), hay, f'{name} 첫 5초(제목·해설 카드·첫 자막)')
# 댓글 장치(관리자 10-20 소유주 질책 «댓글 반응을 노리는 원고 반영이 안 됐다»): 쇼츠는 expected_comment 가 있어야 하고,
# 롱폼·쇼츠 모두 고정 댓글에 질문 한 줄(«?»)이 있어야 한다 — 발췌 원음이라 본문에 못 넣으면 고정 댓글 질문이 그 장치다.
for up in sys.argv[2:]:
    u = json.loads(Path(up).read_text(encoding='utf-8'))
    if 'shorts' in Path(up).resolve().parts and not (u.get('expected_comment') or '').strip():
        bad.append(f'{Path(up).name}: expected_comment 없음(정정/경험담/훈수/공감/논쟁 + 유도 대사)')
    if '?' not in (u.get('pinned_comment') or ''):
        bad.append(f'{Path(up).name}: 고정 댓글에 질문 한 줄(«?») 없음 — 논쟁·훈수를 부르는 질문으로')
sys.path.insert(0, str(Path(__file__).resolve().parent / 'overlay')); import tts_audit   # 해설 TTS 역전사 숫자·고유명사 대조(10/20편부터, tts_say 편만 요구)
bad += tts_audit.gate_lines(ep)
bad += guide_words.gate_lines([*sys.argv[2:], *[p for p in [ep / 'packages.json'] if p.exists()]], lang='ko', lane='politics')   # 제목·설명·태그·썸네일 낱말, 우회 GUIDE_OK=1 은 소유주 말 있을 때만
for b in bad:
    print('[gate] FAIL', b)
if bad:
    sys.exit(3)
print('[gate] PASS', ep.name, ' · '.join(kws))
