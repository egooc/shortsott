# -*- coding: utf-8 -*-
"""썸네일이 안 붙으면 공개를 1시간 미룬다(최대 그날 22:00) — 관리자 결정 10-24 00:3x.

  python monetize-longform/tools/thumb_or_delay.py <ep_dir> --purpose <p> [--cap 22]

흐름: yt_thumb.js 시도 → 성공이면 끝(0). 실패(403 = 미인증 채널)면 upload.json 의 publish_at 을 +1h 로 미루고
yt_publish.js --publish-at 로 유튜브에 반영(종료 3). 미룬 시각이 cap 시(기본 22:00)를 넘으면 더 미루지 않고 그대로 둔다(종료 5).
결과는 ep_dir/thumb_delay.log 와 handoff-manager §10 한 줄.
"""
import datetime
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(r'D:\midform')


def run(args):
    r = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=str(ROOT))
    return r.returncode, ((r.stdout or '') + (r.stderr or '')).replace('Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94', '').strip()


def main():
    a = sys.argv[1:]
    ep = Path(a[0]); purpose = a[a.index('--purpose') + 1]
    cap = int(a[a.index('--cap') + 1]) if '--cap' in a else 22
    meta = ep / 'upload.json'
    u = json.loads(meta.read_text(encoding='utf-8'))
    vid = u['video_id']
    log = ep / 'thumb_delay.log'
    now = datetime.datetime.now()
    rc, out = run(['node', 'monetize-longform/tools/yt_thumb.js', vid, str(meta), '--purpose', purpose])
    if rc == 0:
        line = f"{now:%m-%d %H:%M} 썸네일 설정됨 {vid} — 공개 {u.get('publish_at')} 그대로"
        log.open('a', encoding='utf-8').write(line + '\n'); print(line); return 0
    pub = datetime.datetime.fromisoformat(u['publish_at'])
    new = pub + datetime.timedelta(hours=1)
    if new.hour > cap or (new.hour == cap and new.minute > 0) or new.date() != pub.date():
        line = f"{now:%m-%d %H:%M} 썸네일 실패({out[-80:]}) — {pub:%H:%M} 공개는 상한 {cap}:00 이라 더 안 미룸(자동 프레임 썸네일로 공개)"
        log.open('a', encoding='utf-8').write(line + '\n'); print(line); return 5
    rc2, out2 = run(['node', 'monetize-longform/tools/yt_publish.js', vid, str(meta), '--purpose', purpose, '--publish-at', new.isoformat()])
    if rc2 == 0:
        for name in ('upload.json', 'upload_c.json'):
            p = ep / name
            if p.exists():
                d = json.loads(p.read_text(encoding='utf-8')); d['publish_at'] = new.isoformat()
                p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    line = f"{now:%m-%d %H:%M} 썸네일 실패 — 공개 {pub:%H:%M} → {new:%H:%M} 미룸(yt_publish 종료 {rc2})"
    log.open('a', encoding='utf-8').write(line + '\n'); print(line)
    with (ROOT / 'docs' / 'handoff-manager-20261014.md').open('a', encoding='utf-8') as f:
        f.write(f"- 수창({now:%H:%M}): {ep.name} {vid} 썸네일 아직 403(미인증) — 공개 {pub:%H:%M} → {new:%H:%M} 미룸(상한 {cap}:00). 댓글 작업도 같이 미룰 것.\n")
    return 3


if __name__ == '__main__':
    sys.exit(main())
