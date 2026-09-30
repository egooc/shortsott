# -*- coding: utf-8 -*-
"""이미 만든 완성본을 61~70초 규격으로 **잘라서 살린다**.

    python scripts/recut_to_band.py            무엇을 어떻게 자를지 계산만 하고 보여준다
    python scripts/recut_to_band.py --apply    실제로 자르고 매니페스트를 고친다
    python scripts/recut_to_band.py --only <드래프트이름>

왜 (2026-09-28 소유주: "잘라서 살릴수 있으면 살려줘")
  길이 규격을 61~70초로 좁혔는데(사례 147) 미발행 재고는 전부 90~120초다.
  버리면 통째로 낭비다. 사례 111 이 «완성본을 잘라» 통과시킨 그 방법을 쓴다.

무엇을 자르나 — **앞도 뒤도 아니고 가운데다.**
  · 앞을 자르면 제목 카드와 후킹이 날아간다(제목은 0프레임에 있어야 한다).
  · 뒤를 자르면 결말이 날아간다. 리캡에서 결말은 물건 그 자체다.
  → 그래서 **머리와 꼬리를 남기고 가운데 한 덩어리를 덜어낸다.**

어디서 자르나
  매니페스트 세그먼트 «사이의 빈틈»에서만 자른다. 빈틈은 말이 없는 자리라 소리가 튀지 않는다.
  세그먼트 한가운데를 자르면 단어가 잘린다 — 그건 하지 않는다.

안전망
  매니페스트를 고치면 발행 경로의 **동기화 감사**(Groq STT 전수 대조)와 **승인 해시**가 둘 다
  다시 걸린다. 둘 다 fail-closed 다 — 잘못 자르면 발행이 막히지 조용히 나가지 않는다.
  그래서 여기서는 «맞게 고치는 것»만 하고, 검증은 그 두 문지기에게 맡긴다.
  원본은 `_recut_backup/` 에 남긴다. 되돌릴 수 있어야 한다.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

HOME = os.path.expanduser('~')
DRAFTS = os.path.join(HOME, 'Desktop', '캡컷아웃풋', 'CapCut Drafts')
EXPORT = os.path.join(DRAFTS, '_automation factory')
BACKUP = os.path.join(DRAFTS, '_recut_backup')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LO, HI = 61.0, 70.0
AIM = 67.0           # 목표. 상한에 붙이지 않고 여유를 둔다
KEEP_HEAD = 18.0     # 제목·후킹·첫 내레이션은 반드시 남긴다
KEEP_TAIL = 12.0     # 결말은 반드시 남긴다
MIN_GAP = 0.25       # 이보다 좁은 틈에서는 자르지 않는다


def read_json(path, fallback=None):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return fallback


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    return float((out or '0').strip() or 0)


def pending_drafts():
    state = read_json(os.path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), {}) or {}
    done = {h['draft'] for h in (state.get('history') or []) if h.get('url')}
    rows = []
    for name in sorted(os.listdir(EXPORT)):
        if not name.endswith('.mp4'):
            continue
        draft = name[:-4]
        if draft in done:
            continue
        rows.append(draft)
    return rows


def plan_cut(segments, total):
    """가운데에서 덜어낼 [A, B] 를 고른다. 세그먼트 사이 빈틈에서만 자른다."""
    need = total - AIM
    if need <= 0:
        return None
    best = None
    n = len(segments)
    for i in range(1, n):                       # i 번째 세그먼트부터 지운다
        gap_a = segments[i]['s'] - segments[i - 1]['e']
        if gap_a < MIN_GAP or segments[i - 1]['e'] < KEEP_HEAD:
            continue
        cut_a = segments[i - 1]['e'] + gap_a / 2.0
        for j in range(i, n - 1):               # j 번째까지 지운다
            gap_b = segments[j + 1]['s'] - segments[j]['e']
            if gap_b < MIN_GAP:
                continue
            if total - segments[j + 1]['s'] < KEEP_TAIL:
                continue
            cut_b = segments[j]['e'] + gap_b / 2.0
            new_total = total - (cut_b - cut_a)
            if not (LO <= new_total <= HI):
                continue
            # 목표에 가깝고, 잘라내는 덩어리가 한가운데에 있을수록 좋다
            mid = (cut_a + cut_b) / 2.0
            score = abs(new_total - AIM) + abs(mid - total / 2.0) * 0.15
            if best is None or score < best['score']:
                best = {'a': cut_a, 'b': cut_b, 'new_total': new_total, 'score': score,
                        'drop_from': i, 'drop_to': j}
    return best


def rewrite_manifest(manifest, cut_a, cut_b, new_total):
    removed = cut_b - cut_a
    out = []
    for seg in manifest.get('segments') or []:
        s = float(seg.get('timeline_start_sec', 0))
        e = float(seg.get('timeline_end_sec', 0))
        if s >= cut_a and e <= cut_b:
            continue                            # 덜어낸 구간
        new = dict(seg)
        if s >= cut_b:
            new['timeline_start_sec'] = round(s - removed, 3)
            new['timeline_end_sec'] = round(e - removed, 3)
        out.append(new)
    result = dict(manifest)
    result['segments'] = out
    result['actual_timeline_duration_sec'] = round(new_total, 3)
    result['recut'] = {'removed_sec': round(removed, 3),
                       'cut_at': [round(cut_a, 3), round(cut_b, 3)],
                       'reason': '61~70초 규격(사례 147)에 맞추려고 가운데 한 덩어리를 덜어냈다'}
    return result


def cut_video(src, dst, cut_a, cut_b):
    f = (f"[0:v]trim=0:{cut_a:.3f},setpts=PTS-STARTPTS[v0];"
         f"[0:a]atrim=0:{cut_a:.3f},asetpts=PTS-STARTPTS[a0];"
         f"[0:v]trim=start={cut_b:.3f},setpts=PTS-STARTPTS[v1];"
         f"[0:a]atrim=start={cut_b:.3f},asetpts=PTS-STARTPTS[a1];"
         f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
    proc = subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
         '-filter_complex', f, '-map', '[v]', '-map', '[a]',
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dst],
        capture_output=True, text=True, encoding='utf-8', errors='replace')
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-400:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--only')
    args = ap.parse_args()

    drafts = pending_drafts()
    if args.only:
        drafts = [d for d in drafts if d == args.only]
    if not drafts:
        print('대상 없음')
        return 0

    ok = skipped = 0
    for draft in drafts:
        mp4 = os.path.join(EXPORT, draft + '.mp4')
        draft_dir = os.path.join(DRAFTS, draft)
        man_path = os.path.join(draft_dir, 'edit_manifest.json')
        manifest = read_json(man_path)
        total = duration(mp4)
        if not manifest:
            print(f'  건너뜀  {draft:34} 매니페스트 없음')
            skipped += 1
            continue
        if total <= HI:
            print(f'  그대로  {draft:34} {total:.1f}초 — 이미 규격 안')
            continue
        segs = [{'s': float(x.get('timeline_start_sec', 0)),
                 'e': float(x.get('timeline_end_sec', 0)),
                 'k': x.get('caption_kind', '')} for x in (manifest.get('segments') or [])]
        segs.sort(key=lambda x: x['s'])
        plan = plan_cut(segs, total)
        if not plan:
            print(f'  ★불가  {draft:34} {total:.1f}초 — 빈틈에서 61~70초로 못 맞춘다')
            skipped += 1
            continue
        drop = segs[plan['drop_from']:plan['drop_to'] + 1]
        kinds = {}
        for d in drop:
            kinds[d['k']] = kinds.get(d['k'], 0) + 1
        print(f'  자름    {draft:34} {total:.1f}초 → {plan["new_total"]:.1f}초  '
              f'[{plan["a"]:.2f}~{plan["b"]:.2f}] 제거 {plan["b"]-plan["a"]:.1f}초 '
              f'· 세그 {len(drop)}개 {kinds}')
        if not args.apply:
            continue
        os.makedirs(BACKUP, exist_ok=True)
        shutil.copy2(mp4, os.path.join(BACKUP, draft + '.mp4'))
        shutil.copy2(man_path, os.path.join(BACKUP, draft + '.edit_manifest.json'))
        # ★임시 파일을 EXPORT 안에 두지 마라. 거기는 «올릴 것»만 있는 곳이라,
        #   작업 중인 반쪽 파일을 다른 도구가 완성본으로 읽는다(2026-09-28 실측: check-length 가 깨졌다).
        os.makedirs(BACKUP, exist_ok=True)
        tmp = os.path.join(BACKUP, draft + '.recut.tmp.mp4')
        cut_video(mp4, tmp, plan['a'], plan['b'])
        got = duration(tmp)
        if not (LO <= got <= HI):
            os.remove(tmp)
            print(f'    ★렌더 결과가 규격 밖({got:.1f}초) — 되돌림')
            skipped += 1
            continue
        os.replace(tmp, mp4)
        new_man = rewrite_manifest(manifest, plan['a'], plan['b'], got)
        with open(man_path, 'w', encoding='utf-8') as fh:
            json.dump(new_man, fh, ensure_ascii=False, indent=2)
        print(f'    완료 {got:.1f}초 · 세그 {len(manifest.get("segments") or [])}'
              f'→{len(new_man["segments"])} · 원본은 _recut_backup/')
        ok += 1

    print(f'\n{"적용" if args.apply else "계산만"} · 처리 {ok}편 · 건너뜀 {skipped}편')
    if args.apply and ok:
        print('★승인이 무효화된다(빌드 해시 변경). 발행 전에 재승인이 필요하다:')
        print('   node scripts/approve-publish.js "<드래프트이름>"')
    return 0


if __name__ == '__main__':
    sys.exit(main())
