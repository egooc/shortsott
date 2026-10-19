# -*- coding: utf-8 -*-
"""롱폼 포장 관문 — 업로드 전에 packages.json 묶음 3개 이상이 교체 준비가 됐는지 본다(소유주 10-18 «모든 롱폼은 썸네일을
성과에 따라 계속 수정할 준비 — 제목·키워드·해시태그도»). 연금·실화·기업 흥망 레인용, 정치는 politics-hour/upload_gate.py.

    python scripts/packages_gate.py <에피소드 폴더> [--lang ja|ko] [--lane nenkin]

포맷은 정치 views_check.js(1ef5c90) 그대로 — 교체는 그 스크립트가 한다(ROOTS 에 ja-nenkin·ko-truecrime·biz-rise-fall):
    {"video_id", "purpose", "packages": [{"title", "thumbnail", "style", "big", "tags", "hashtags", "desc_head"}, ...], "applied": []}
    packages[0] = 업로드 때 포장, 1번부터 교체용. thumbnail 은 D:/midform 기준 상대경로.

묶음마다: 제목이 big[0] 으로 시작 · 썸네일 파일 있음 · 태그 15~25개 · keywords.json 1·2위가 제목·desc_head·태그 안에 ·
해시태그 1~5개(#로 시작) · desc_head 두 줄. 그리고 guide_words 가이드 낱말 0.
종료 코드 0 = 통과 · 4 = 걸림(업로드 중단).
경고(△, 막지 않음 — 차단 여부는 소유주 뒤, 카이안 K6 10-19): 태그·해시태그 중 제목과 설명 두 줄에 함께 나오는 낱말 수 < 2 ·
태그가 원고(script.txt, 없으면 seg/*/cues.json·*.srt)에 실제로 나오는 비율 < 50%.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import guide_words  # noqa: E402

FIELDS = ('title', 'thumbnail', 'big', 'tags', 'hashtags', 'desc_head')


def keywords(ep):
    kp = ep / 'keywords.json'
    if not kp.exists():
        return []
    k = json.loads(kp.read_text(encoding='utf-8')).get('keywords', [])
    return [x if isinstance(x, str) else x.get('keyword', '') for x in k][:2]


WARN_COMMON, WARN_RATIO = 2, 0.5   # 측정 뒤 조정


def content_text(ep):
    """영상 안 말 — 원고 우선, 없으면 자막 큐·srt."""
    s = ep / 'script.txt'
    if s.exists():
        return s.read_text(encoding='utf-8')
    parts = [f.read_text(encoding='utf-8') for f in sorted(ep.glob('seg/*/cues.json')) + sorted(ep.glob('*.srt'))]
    return '\n'.join(parts)


def norm(s):
    return ''.join(s.split()).lower()


def warnings(ep, lang='ko'):
    """[(묶음 번호, 공통 낱말 [..], 원고에 나온 태그 비율, 원고에 없는 태그 [..])] 와 경고 줄."""
    ep = Path(ep)
    pk = json.loads((ep / 'packages.json').read_text(encoding='utf-8'))
    body = norm(content_text(ep))
    stats, lines = [], []
    for i, p in enumerate(pk.get('packages', [])):
        words = list(dict.fromkeys([*p.get('tags', []), *(h.lstrip('#') for h in p.get('hashtags', []))]))
        head = norm(' '.join(p.get('desc_head', [])))
        common = [w for w in words if norm(w) and norm(w) in norm(p.get('title', '')) and norm(w) in head]
        tags = p.get('tags', [])
        miss = [w for w in tags if not all(norm(x) in body for x in w.split())] if body else []   # 여러 낱말 태그는 낱말마다
        ratio = 1 - len(miss) / len(tags) if tags and body else None
        stats.append((i, common, ratio, miss))
        if len(common) < WARN_COMMON:
            lines.append(f'{i}번: 제목·설명 두 줄·태그 공통 낱말 {len(common)}개 {common} (≥{WARN_COMMON} 권장)')
        if ratio is None:
            lines.append(f'{i}번: 원고(script.txt·cues.json·srt) 없음 — 태그-내용 일치 못 잼')
        elif ratio < WARN_RATIO:
            lines.append(f'{i}번: 원고에 나오는 태그 {ratio:.0%} (≥{WARN_RATIO:.0%} 권장) · 없는 태그 {miss[:8]}')
    return stats, lines


def check(ep, lang='ko', lane=None):
    ep = Path(ep)
    pp = ep / 'packages.json'
    if not pp.exists():
        return [f'{ep.name}: packages.json 없음']
    pk = json.loads(pp.read_text(encoding='utf-8'))
    pkgs = pk.get('packages', [])
    bad = []
    if not pk.get('purpose'):
        bad.append('purpose(업로드 채널) 없음 — views_check 가 인증할 채널')
    if len(pkgs) < 3:
        bad.append(f'묶음 {len(pkgs)}개 (3개 이상이어야 함)')
    kws = keywords(ep)
    for i, p in enumerate(pkgs):
        miss = [f for f in FIELDS if not p.get(f)]
        if miss:
            bad.append(f'{i}번: 빈 칸 {miss}')
            continue
        if not p['title'].lstrip('【').startswith(p['big'][0]):
            bad.append(f'{i}번: 제목 «{p["title"]}» 이 «{p["big"][0]}» 으로 시작하지 않음')
        if not (ROOT / p['thumbnail']).exists():
            bad.append(f'{i}번: 썸네일 없음 {p["thumbnail"]}')
        if not 15 <= len(p['tags']) <= 25:
            bad.append(f'{i}번: 태그 {len(p["tags"])}개 (15~25개여야 함)')
        if not 1 <= len(p['hashtags']) <= 5 or not all(h.startswith('#') for h in p['hashtags']):
            bad.append(f'{i}번: 해시태그 {p["hashtags"]} (#로 시작 1~5개)')
        if len(p['desc_head']) != 2:
            bad.append(f'{i}번: desc_head {len(p["desc_head"])}줄 (두 줄이어야 함)')
        hay = ' '.join([p['title'], *p['desc_head'], *p['tags']])
        bad += [f'{i}번: 키워드 «{k}» 가 제목·desc_head·태그에 없음' for k in kws if k and k not in hay]
    for i, p in enumerate(pkgs if os.environ.get('GUIDE_OK') != '1' else []):   # 태그·해시태그·설명 두 줄도 가이드 낱말 검사(fields 는 제목·big·description 만)
        text = ' '.join([*p.get('tags', []), *p.get('hashtags', []), *p.get('desc_head', [])])
        bad += [f'{i}번 태그·설명 · 가이드 {c}: {w}' for c, w in guide_words.hits(text, lang, lane)]
    bad += guide_words.gate_lines([pp], lang=lang, lane=lane)
    return bad


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    lang = argv[argv.index('--lang') + 1] if '--lang' in argv else 'ko'
    lane = argv[argv.index('--lane') + 1] if '--lane' in argv else None
    bad = check(argv[0], lang, lane)
    print('\n'.join(f'✗ {b}' for b in bad) if bad else f'✓ 포장 관문 통과 ({argv[0]})')
    warn = warnings(argv[0], lang)[1] if (Path(argv[0]) / 'packages.json').exists() else []
    if warn:
        print('\n'.join(f'△ {w}' for w in warn))
    return 4 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
