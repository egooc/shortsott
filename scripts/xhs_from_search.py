# TikHub 샤오홍슈 검색 응답(json)에서 노트를 골라 CDN 직주소로 받는다.
# 노트 페이지는 보안 제한으로 자주 막히지만 검색 응답엔 mp4 주소가 여러 개(백업 호스트 포함) 들어 있다.
#
#   python scripts/xhs_from_search.py --search xhs_search.json --out <footage> <note_id> [...]
import argparse, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import social_grab as g  # noqa: E402


def note_urls(search_json):
    d = json.loads(Path(search_json).read_text(encoding='utf-8'))
    res = {}

    def walk(x):
        if isinstance(x, dict):
            if x.get('id') and x.get('type') == 'video' and x['id'] not in res:
                u = re.findall(r'https?://[^"\s]+?\.mp4[^"\s]*', json.dumps(x))
                if u:
                    # sns-bak 호스트가 되고 sns-video-v28 은 막혔다(2026-09-30)
                    res[x['id']] = {'urls': sorted(set(u), key=lambda s: ('bak' not in s, s)),
                                    'title': x.get('title') or x.get('desc') or '',
                                    'author': (x.get('user') or {}).get('nickname')}
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(d.get('data'))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--search', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('ids', nargs='+')
    a = ap.parse_args()
    Path(a.out).mkdir(parents=True, exist_ok=True)
    notes = note_urls(a.search)
    for nid in a.ids:
        n = notes.get(nid)
        if not n:
            print(f'  ✗ {nid} — 검색 응답에 영상 주소가 없다')
            continue
        for u in n['urls']:
            try:
                f = g.grab_direct(u, a.out)
                meta = Path(a.out, f).with_suffix('.json')
                m = json.loads(meta.read_text(encoding='utf-8'))
                m.update(id=nid, note_id=nid, url=f'https://www.xiaohongshu.com/explore/{nid}', cdn=u,
                         author=n['author'], desc=n['title'][:300])
                meta.write_text(json.dumps(m, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                s = g.probe(Path(a.out, f))
                print(f"  ✓ {nid} → {f} {s.get('width')}x{s.get('height')} · {n['title'][:30]}")
                break
            except Exception:
                continue
        else:
            print(f'  ✗ {nid} — 주소 {len(n["urls"])}개 모두 실패')


if __name__ == '__main__':
    main()
