# -*- coding: utf-8 -*-
"""유튜브 자막 json3 → 레퍼런스 전사 md(연금JA 규약: '# 제목', '- 채널 · 날짜 · 조회 · 길이 · URL', '[m:ss] 문장' 줄).
ref_overlap.py 가 읽는 폴더 형식. 같은 이름의 .info.json 이 옆(또는 --info-dir)에 있으면 머리줄을 채운다.

    python scripts/json3_to_md.py <subs 폴더 또는 *.json3 ...> --out reference/ko_corp/corp_refs/transcripts [--info-dir server/data/ref_corp]
"""
import json
import re
import sys
from pathlib import Path


def stamp(ms):
    s = int(ms // 1000)
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f'[{h}:{m:02d}:{s:02d}]' if h else f'[{m}:{s:02d}]'


def lines(j3):
    out = []
    for ev in json.loads(Path(j3).read_text(encoding='utf-8')).get('events', []):
        tx = ''.join(sg.get('utf8', '') for sg in ev.get('segs') or []).replace('\n', ' ').strip()
        tx = re.sub(r'\s+', ' ', tx)
        if tx and tx != '[음악]':
            out.append((ev.get('tStartMs', 0), tx))
    # 자동 자막의 굴러가는 두 줄(앞 줄 반복)을 걷어낸다
    dedup = []
    for t, tx in out:
        if dedup and (tx == dedup[-1][1] or dedup[-1][1].endswith(tx)):
            continue
        dedup.append((t, tx))
    return dedup


def header(vid, info_dir):
    f = Path(info_dir) / f'{vid}.info.json' if info_dir else None
    if not f or not f.exists():
        return f'# {vid}\n\n- https://youtu.be/{vid}\n'
    d = json.loads(f.read_text(encoding='utf-8'))
    up = d.get('upload_date') or ''
    up = f'{up[:4]}-{up[4:6]}-{up[6:]}' if len(up) == 8 else up
    dur = int(d.get('duration') or 0)
    return (f"# {d.get('title', vid)}\n\n- {d.get('channel', '')} · {up} · {d.get('view_count', 0):,}회 · "
            f"{dur // 60}분 {dur % 60}초 · https://youtu.be/{vid}\n")


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    out = Path(argv[argv.index('--out') + 1])
    info_dir = argv[argv.index('--info-dir') + 1] if '--info-dir' in argv else None
    srcs = []
    skip = {i + 1 for i, a in enumerate(argv) if a in ('--out', '--info-dir')}
    for i, a in enumerate(argv):
        if a.startswith('--') or i in skip:
            continue
        p = Path(a)
        srcs += sorted(p.glob('*.json3')) if p.is_dir() else [p]
    out.mkdir(parents=True, exist_ok=True)
    for j3 in srcs:
        vid = j3.name.split('.')[0]
        ls = lines(j3)
        body = '\n'.join(f'{stamp(t)} {tx}' for t, tx in ls)
        (out / f'{vid}.md').write_text(header(vid, info_dir or j3.parent.parent) + '\n' + body + '\n', encoding='utf-8')
        print(f'{vid}: {len(ls)}줄')
    return 0


if __name__ == '__main__':
    sys.exit(main())
