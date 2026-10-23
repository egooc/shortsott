# -*- coding: utf-8 -*-
"""공개된 뒤 고정용 댓글을 한 번만 단다 — upload.json 에 comment_id 가 있으면 아무것도 안 한다(예약 작업이 여러 번 돌아도 안전).

  python monetize-longform/tools/comment_once.py <ep_dir> --purpose <p>
종료 코드: 0 이미 있음/달림 · 그 외 yt_publish 종료 코드(비공개면 실패 → 다음 예약에 재시도).
"""
import datetime
import json
import subprocess
import sys
from pathlib import Path

ep = Path(sys.argv[1])
purpose = sys.argv[sys.argv.index('--purpose') + 1]
meta = ep / 'upload.json'
u = json.loads(meta.read_text(encoding='utf-8'))


def logged_comment():
    # yt_publish 는 upload.json 을 안 건드리고 upload_log.jsonl 에 commentId 를 남긴다
    log = ep / 'upload_log.jsonl'
    if not log.exists():
        return None
    for line in log.read_text(encoding='utf-8').splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('videoId') == u.get('video_id') and d.get('commentId'):
            return d['commentId']
    return None


cid = u.get('comment_id') or logged_comment()
if cid:
    if not u.get('comment_id'):
        u['comment_id'] = cid
        meta.write_text(json.dumps(u, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('이미 댓글 있음', cid)
    sys.exit(0)
r = subprocess.run(['node', 'monetize-longform/tools/yt_publish.js', u['video_id'], str(meta), '--purpose', purpose, '--comment'],
                   capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=r'D:\midform')
out = (r.stdout or '') + (r.stderr or '')
with (ep / 'comment_task.log').open('a', encoding='utf-8') as f:
    f.write(f"{datetime.datetime.now():%m-%d %H:%M} exit {r.returncode} {out[-300:]}\n")
cid = logged_comment()
if cid:
    u['comment_id'] = cid
    meta.write_text(json.dumps(u, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(out[-200:])
sys.exit(0 if cid else (r.returncode or 1))
