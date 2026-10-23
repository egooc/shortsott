# -*- coding: utf-8 -*-
"""수창 편 seg/ 조각 캐시 자동 정리 + D: 빈 공간 관문 (관리자 10-23 07:5x: D: 3.4GB 사고 — 업로드 끝난 편의 seg/ 가 편당 2~3GB).

    python -X utf8 monetize-longform/tools/seg_prune.py            # 업로드 기록(video_id)이 있고 episode.mp4 가 있는 편의 seg/ 를 지운다
    python -X utf8 monetize-longform/tools/seg_prune.py --dry      # 대상만 보여 준다

기준: ep_*/upload.json 또는 packages.json 에 video_id 가 있고(업로드 성공 기록), episode.mp4 가 남아 있을 때만 seg/ 를 지운다.
남기는 것: episode.mp4·voice/·packages·upload.json·audit/·motion_check/(증명 png 는 손으로 정리).
night_chain.py 가 편마다 시작 전에 부르고, chain_ko/chain_ja 는 렌더 전 D: ≥15GB 관문(모자라면 정리 → 그래도 모자라면 종료 4·§10 한 줄).
"""
import datetime as dt
import json
import shutil
import sys
from pathlib import Path

ROOT = Path('D:/midform')
LANE = ROOT / 'monetize-longform'
HAND = ROOT / 'docs' / 'handoff-manager-20261014.md'
MIN_D_GB = 15


def disk_d_gb():
    return shutil.disk_usage('D:/').free / 1e9


def video_id(ep):
    for name in ('upload.json', 'packages.json'):
        p = ep / name
        if p.exists():
            try:
                v = json.loads(p.read_text(encoding='utf-8')).get('video_id')
            except Exception:
                v = None
            if v:
                return v
    return None


def targets():
    out = []
    for ep in sorted(LANE.glob('ep_*')):
        seg = ep / 'seg'
        if seg.is_dir() and (ep / 'episode.mp4').exists() and video_id(ep):
            mb = sum(f.stat().st_size for f in seg.rglob('*') if f.is_file()) // 2**20
            out.append((ep, mb))
    return out


def prune(log=print, dry=False):
    """업로드 끝난 편의 seg/ 를 지운다 → (지운 MB 합계, [편 이름])."""
    freed, names = 0, []
    for ep, mb in targets():
        if not dry:
            shutil.rmtree(ep / 'seg', ignore_errors=True)
        freed += mb
        names.append(ep.name)
        log(f'seg 정리{"(예정)" if dry else ""}: {ep.name}/seg {mb}MB (video_id {video_id(ep)})')
    if names:
        log(f'seg 정리 합계 {freed}MB · D: 빈 공간 {disk_d_gb():.1f}GB')
    return freed, names


def finish_prune(ep, log=print):
    """★관리자 10-23 11:1x: 최종 mp4 가 나오고 motion_gate 를 통과하면 업로드 전이라도 seg/ 를 바로 지운다.
    지우기 전에 seg_starts.json(목차·댓글 시각용)을 만든다 — ko_pack.build_seg_starts 재사용. 돌려준 값 = 지운 MB."""
    ep = Path(ep)
    seg = ep / 'seg'
    if not seg.is_dir() or not (ep / 'episode.mp4').exists():
        return 0
    if not (ep / 'seg_starts.json').exists():
        import sys as _s
        _s.path.insert(0, str(Path(__file__).resolve().parent))
        import ko_pack
        ko_pack.build_seg_starts(ep)
    ss = []
    for mj in seg.glob('*/motion.json'):   # 증명용 요약(첫·끝 SSIM) — seg 를 지우면 motion.json 도 사라지므로 먼저 남긴다
        try:
            v = json.loads(mj.read_text(encoding='utf-8')).get('ssim')
            if isinstance(v, (int, float)):
                ss.append(v)
        except Exception:
            pass
    if ss:
        ss.sort()
        (ep / 'motion_summary.json').write_text(json.dumps({'scenes': len(ss), 'min': ss[0], 'median': ss[len(ss) // 2], 'max': ss[-1], 'ge_095': sum(s >= 0.95 for s in ss)}) + chr(10), encoding='utf-8')
    mb = sum(f.stat().st_size for f in seg.rglob('*') if f.is_file()) // 2**20
    shutil.rmtree(seg, ignore_errors=True)
    log(f'seg 정리(렌더 끝): {ep.name}/seg {mb}MB · D: 빈 공간 {disk_d_gb():.1f}GB')
    return mb


def hand_line(text):
    with HAND.open('a', encoding='utf-8') as f:
        f.write(f'- 수창({dt.datetime.now():%H:%M}): {text}\n')


def disk_gate(ep_name, log=print, min_gb=MIN_D_GB):
    """렌더 전 D: 관문. 모자라면 자동 정리 뒤 재확인, 그래도 모자라면 §10 한 줄 적고 False(호출자는 종료 4)."""
    d = disk_d_gb()
    if d >= min_gb:
        return True
    freed, names = prune(log)
    d = disk_d_gb()
    if d >= min_gb:
        log(f'D: 관문 통과(정리 {freed}MB 뒤 {d:.1f}GB)')
        return True
    msg = f'{ep_name} 렌더 보류 — D: 빈 공간 {d:.1f}GB < {min_gb}GB(자동 정리 {freed}MB{", " + "·".join(names) if names else ""} 뒤에도 부족) → 종료 4. 관리자 확인 필요'
    log(msg)
    hand_line(msg)
    return False


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    before = disk_d_gb()
    freed, names = prune(dry='--dry' in sys.argv)
    print(f'D: {before:.1f} → {disk_d_gb():.1f}GB · 대상 {len(names)}편 {freed}MB')
