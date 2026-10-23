# -*- coding: utf-8 -*-
"""수창 ko 편 포장 묶음 생성 — packages.json drafts[0..2] + compose.json variants → packages[0..2] (thumb_compose 전에 한 번).

    python -X utf8 monetize-longform/tools/ko_bundles.py monetize-longform/ep_ko07 --tags "낱말1" "낱말2" ... --hashtags "#a" "#b" "#c" --desc "첫 줄" "둘째 줄"

- title = draft.title (big[0] 로 시작해야 packages_gate 통과 — drafts 에서 보장)
- tags = keywords + --tags (15~25개로 자름), hashtags 1~5, desc_head 2줄(--desc 없으면 keywords.json candidates[0].angle 로 임시)
- thumbnail = thumb/compose/thumb_<i>.png, style = compose <symbol>
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main(argv):
    ep = (ROOT / argv[0]).resolve()
    def opt(name):
        if name not in argv:
            return []
        i = argv.index(name) + 1
        out = []
        while i < len(argv) and not argv[i].startswith('--'):
            out.append(argv[i])
            i += 1
        return out
    tags, hashtags, desc = opt('--tags'), opt('--hashtags'), opt('--desc')
    pk = json.loads((ep / 'packages.json').read_text(encoding='utf-8'))
    cj = json.loads((ep / 'compose.json').read_text(encoding='utf-8'))
    kw = json.loads((ep / 'keywords.json').read_text(encoding='utf-8'))
    drafts = sorted(pk['drafts'], key=lambda x: x['ctr_rank'])
    base = list(dict.fromkeys(pk.get('keywords', []) + tags))[:25]
    if len(base) < 15:
        raise SystemExit(f'태그 {len(base)}개 — 15개 이상 필요(--tags 로 보충)')
    if not desc:
        desc = [kw['candidates'][0]['angle'], '확인된 숫자만 쓰고, 확정되지 않은 것은 확정되지 않았다고 말합니다.']
    out = []
    rel = str(ep.relative_to(ROOT)).replace('\\', '/')
    for i in range(3):
        d, v = drafts[i], cj['variants'][i]
        out.append({"title": d['title'], "thumbnail": f"{rel}/thumb/compose/thumb_{i}.png", "style": f"compose {v['symbol']}", "big": d['big'],
                    "tags": base, "hashtags": hashtags[:5] or pk.get('hashtags', []), "desc_head": desc[:2], "keywords": pk.get('keywords', [])})
    pk['packages'] = out
    pk.setdefault('applied', [])
    (ep / 'packages.json').write_text(json.dumps(pk, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{ep.name}: packages 3 · tags {len(base)} · hashtags {len(out[0]["hashtags"])}')


if __name__ == '__main__':
    main(sys.argv[1:])
