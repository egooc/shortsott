# -*- coding: utf-8 -*-
"""수창용 롱폼 렌더 진입점 — 기업(ko)·연금(ja) 렌더러를 import 해서 원고 관문 자리만 이 레인 관문(gates.script)으로 바꾼다. 복사 없음.

    python -X utf8 monetize-longform/render.py <편 폴더> [렌더러 인자 그대로: --only a-b --tts-only --preview --no-gate]

편 폴더 lane.json {"lang": "ko"|"ja"} 로 렌더러를 고른다.

★10-22 소유주 «영상이 움직이질 않아 … 줌인·줌아웃·이동 주기로 했잖아» → 관리자 §7(22:0x 정정: 레퍼런스 실측 그림 8~9초·1.00→1.12·첫 60초 5초 컷·카드 1.06, SSIM ≥0.95 FAIL):
  ko  기업 렌더러(corp_render 10-22n)가 자체로 한다 — bg_shots(컷 9초·첫 60초 5초·줌 1.12·방향 교대) + 판은 board_bg 1.06 + 투명 오버레이(mov) + motion_gate(SSIM, 종료 4). 여기서는 손대지 않는다.
  ja  연금 렌더러는 stage_motion(판 영역 1.10·12초, 고령층)을 판 장면에 쓴다. 수창 ja 의 그림(pic) 장면만 여기서 바꾼다:
      그림을 하이퍼프레임에 넣지 않고(투명 배경 오버레이 mov) ffmpeg 배경층 motion_bg(샷 8.5초·첫 60초 5초·1.00↔1.12 교대·샷마다 초점 다름)로 장면 내내 움직인 뒤 합성.
      그림 장면은 stage_motion 을 건너뛴다(이중 줌 방지). 관문은 tools/motion_gate.py(SSIM ≥0.95 FAIL 종료 4) — chain_ja 가 렌더 뒤 돌린다.
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / 'ko-corp' / 'render'))
sys.path.insert(0, str(ROOT / 'ja-nenkin' / 'render'))
import gates  # noqa: E402

FPS = 30
# 관리자 22:0x 정정(레퍼런스 51만 편 실측: 그림 평균 8.3초마다 바뀌고 그 안에서 계속 당김): 샷 8~9초·1.00→1.12(방향 번갈아)·첫 60초 5초 컷
MOTION = {'zoom': 1.12, 'shot': 8.5, 'shot_first': 5.0, 'first_sec': 60.0, 'code': 'm3'}
DIRS = ['in', 'out']   # 천천히 당기기·밀기만, 샷마다 번갈아
SAFE_MOVES = ['in', 'right', 'in', 'left']   # ko 그림 컷 방향(10-23): 'out' 으로 끝나는 짝을 피한다
CURRENT = {}   # ja: stage() 가 방금 만든 장면(spec·d·start) — hf_render/stage_motion 이 그림 장면인지 알기 위해


def gate(ep, lang):
    bad = gates.script(Path(ep), lang)
    for b in bad:
        print('[관문] FAIL', b, flush=True)
    if bad:
        raise SystemExit(f'수창 원고 관문 {len(bad)}건 — TTS 중단')


def scene_index(p):
    """seg/<idx>-<vid>-<hash>/... 경로에서 장면 번호."""
    for q in [p] + list(p.parents):
        m = re.match(r'^(\d{3})-', q.name)
        if m:
            return int(m.group(1))
    return 0


def ffmpeg(args):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *args], check=True)


def motion_bg(img, d, i, out, start=None):
    """그림 한 장 → d초 배경 영상. 샷(≤8.5초, 편 첫 60초는 ≤5초)으로 나눠 샷마다 방향(in/out)·초점을 바꾼다.
    2배로 키운 뒤 zoompan — 계단 떨림 방지(기업 ken_burns 와 같은 방식). 돌려준 값 = 샷 수."""
    shot = MOTION['shot_first'] if (start if start is not None else 10 ** 6) < MOTION['first_sec'] else MOTION['shot']
    n_sh = max(1, math.ceil(d / shot))
    per = d / n_sh
    W, H = 3840, 2160
    Z = MOTION['zoom']
    tmp = out.parent / 'bgparts'
    tmp.mkdir(exist_ok=True)
    parts = []
    for k in range(n_sh):
        dk = per if k < n_sh - 1 else d - per * (n_sh - 1)
        n = max(2, int(round(dk * FPS)))
        move = DIRS[(i + k) % len(DIRS)]
        if k == n_sh - 1 and n_sh % 2 == 0:   # 10-23: 짝수 샷이 in→out 으로 끝나면 첫·끝 배율이 같아져 정지로 판정될 수 있다
            move = 'in'
        fx = [0.5, 0.3, 0.7, 0.4][(i + k) % 4]        # 샷마다 초점이 달라 같은 그림이라도 컷이 보인다
        fy = [0.45, 0.6, 0.35, 0.55][(i // 2 + k) % 4]
        z0, z1 = (1.0, Z) if move == 'in' else (Z, 1.0)
        zx = f'({z0}+({z1}-{z0})*on/{n - 1})'
        vf = (f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},'
              f"zoompan=z='{zx}':x='(iw-iw/zoom)*{fx}':y='(ih-ih/zoom)*{fy}':d=1:s=1920x1080:fps={FPS},setsar=1")
        pk = tmp / f'{k}.mp4'
        ffmpeg(['-loop', '1', '-framerate', str(FPS), '-t', f'{dk:.3f}', '-i', str(img), '-vf', vf, '-frames:v', str(n),
                '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', str(pk)])
        parts.append(pk)
    if len(parts) == 1:
        shutil.move(str(parts[0]), str(out))
    else:
        lst = tmp / 'list.txt'
        lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
        ffmpeg(['-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(out)])
    shutil.rmtree(tmp, ignore_errors=True)
    return n_sh


def pic_stage(orig, preview=False):
    """ja 렌더러에 'pic' 판을 더한다(발굴 시트 §3 — 지도·장면 그림을 판 가득 + 왼쪽 위 연도 + 오른쪽 위 숫자 카드).
    10-22부터 그림은 하이퍼프레임에 넣지 않고(투명 배경) ffmpeg 배경층(motion_bg)이 장면 내내 움직인다 — hf_render 패치가 합성.
    미리보기(정지 화면)만 그림을 판에 넣는다."""
    def stage(spec, d, img_dir, doc_dir, cues, cont=0):
        CURRENT.update({'d': d, 'pic': spec if spec.get('type') == 'pic' else None})
        if spec.get('type') != 'pic':
            return orig(spec, d, img_dir, doc_dir, cues, cont)
        fx, fy = spec.get('focus', [50, 45])
        pic_css = ('#mwrap{position:absolute;inset:0;overflow:hidden}'
                   f'#mpic{{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:{fx}% {fy}%}}') if preview else ''
        css = ('html,body,#root{background:transparent!important}' + pic_css +
               '#myr{position:absolute;left:28px;top:22px;background:rgba(20,30,48,.86);color:#fff;font-family:Serif;font-weight:900;'
               'font-size:64px;padding:6px 26px 10px;border-left:10px solid #c4342c}'
               '#mnum{position:absolute;right:28px;top:22px;background:rgba(255,255,255,.94);border:4px solid #142030;padding:14px 26px}'
               '#mnum .r{display:flex;justify-content:space-between;gap:36px;font-weight:900;font-size:50px;line-height:1.3}'
               '#mnum .r b{color:#c4342c}')
        body = f'<div id="mwrap"><img id="mpic" src="img/{spec["img"]}"></div>' if preview else ''
        js = []
        if spec.get('year'):
            body += f'<div id="myr">{spec["year"]}</div>'
            js.append('tl.from("#myr",{opacity:0,x:-30,duration:.4,ease:"power2.out"},.2);')
        if spec.get('nums'):
            body += '<div id="mnum">' + ''.join(f'<div class="r" id="mn{i}"><span>{a}</span><b>{b}</b></div>' for i, (a, b) in enumerate(spec['nums'])) + '</div>'
            for i in range(len(spec['nums'])):
                js.append(f'tl.from("#mn{i}",{{opacity:0,y:16,duration:.35,ease:"power2.out"}},{.5 + i * .6:.2f});')
        return css, body, js
    return stage


def patch_ja(M, ep, preview=False):
    """연금 렌더러: 그림 장면 = 투명 오버레이(mov) + motion_bg 배경 합성, 판 장면 = 연금 stage_motion 그대로."""
    import corp_render as C   # hf_render(folder, out, fmt) — mov(알파) 렌더만 빌려 쓴다
    M.CODE = M.CODE + '-' + MOTION['code']
    M.stage = pic_stage(M.stage, preview)
    if preview:
        return
    orig_hf, orig_motion = M.hf_render, M.stage_motion
    CURRENT['start'] = 0.0

    def hf_render(folder, out):
        folder, out = Path(folder), Path(out)
        pic = CURRENT.get('pic')
        if pic and pic.get('img'):
            i = scene_index(folder)
            C.hf_render(folder, folder.parent / 'overlay.mov', 'mov')
            shots = motion_bg(ep / 'img' / pic['img'], CURRENT['d'], i, folder.parent / 'bg.mp4', CURRENT.get('start'))
            ffmpeg(['-i', str(folder.parent / 'bg.mp4'), '-i', str(folder.parent / 'overlay.mov'), '-filter_complex', '[0:v][1:v]overlay=format=auto,setsar=1[v]',
                    '-map', '[v]', '-r', str(FPS), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', str(out)])
            for x in ('bg.mp4', 'overlay.mov'):
                (folder.parent / x).unlink(missing_ok=True)
            (folder.parent / 'motion.json').write_text(json.dumps({'shots': shots, 'zoom': MOTION['zoom'], 'by': 'monetize motion_bg'}) + '\n', encoding='utf-8')
        else:
            orig_hf(folder, out)
        CURRENT['start'] = CURRENT.get('start', 0.0) + CURRENT.get('d', 0.0)

    def stage_motion(src, d, out, audio=False):
        if CURRENT.get('pic'):           # 그림 장면은 이미 배경층이 움직였다 — 판 줌을 또 입히지 않는다
            shutil.copy2(src, out)
            return None
        return orig_motion(src, d, out, audio)
    M.hf_render, M.stage_motion = hf_render, stage_motion


def clip_bg(M, ep, clip, imgs, d, i, out, **kw):
    """★10-23 소유주 «AI 그림만 말고 유튜브 밖 커뮤니티의 실제 영상을 짧게 섞어라»(관리자 정정: 비중 10~15%·컷당 3~8초·원음 끔·저화질 허용·16:9 확대 크롭).
    장면 배경 = 실제 영상 clip['len']초(장면 머리) + 나머지는 그림 ken_burns. clip = {"key": clips.json 의 key, "in": 시작초, "len": 3~8, "focus": [fx, fy](크롭 중심 0~1)}.
    clips.json(편 폴더): {"clips": [{"key", "src"(절대 경로), "sub", "author", "title", "post", "dur", "rights": {...}, "checks": {...}}]} — 출처는 설명란 글로만(ko_pack)."""
    reg = {c['key']: c for c in json.loads((ep / 'clips.json').read_text(encoding='utf-8'))['clips']}
    c = reg[clip['key']]
    src = Path(c['src'])
    clen = min(float(clip.get('len', 6)), d)
    fx, fy = clip.get('focus', [0.5, 0.5])
    n_clip = int(round(clen * FPS))
    rest = d - clen
    tmp = out.parent / 'clipparts'
    tmp.mkdir(exist_ok=True)
    parts = []
    z = float(clip.get('zoom', 1.0))    # 16:9 확대 크롭(관리자 10-23): 비율이 다른 영상은 채워 자르고, zoom>1 이면 더 키워 로고·가장자리를 밖으로
    zw, zh = int(1920 * z) // 2 * 2, int(1080 * z) // 2 * 2
    vf = (f'scale={zw}:{zh}:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)*{fx}:(ih-1080)*{fy},fps={FPS},setsar=1,format=yuv420p')
    if rest < 1.0:                      # 나머지가 1초 미만이면 마지막 프레임을 늘려 장면을 채운다
        vf += f',tpad=stop_mode=clone:stop_duration={rest + 0.5:.3f}'
        n_clip = int(round(d * FPS)); rest = 0.0
    p0 = tmp / 'clip.mp4'
    ffmpeg(['-ss', f'{float(clip.get("in", 0)):.3f}', '-i', str(src), '-an', '-vf', vf, '-frames:v', str(n_clip),
            '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', str(p0)])
    parts.append(p0)
    shots = 1
    if rest > 0:
        p1 = tmp / 'rest.mp4'
        n_rest = int(round(d * FPS)) - n_clip
        M.ken_burns(imgs[0], n_rest / FPS, M.MOVES[i % len(M.MOVES)], p1, focus=(0.5, 0.2, 0.8)[i % 3], zoom=M.ZOOM, n=n_rest)
        parts.append(p1); shots = 2
    lst = tmp / 'list.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(out)])
    shutil.rmtree(tmp, ignore_errors=True)
    (out.parent / 'clip.json').write_text(json.dumps({'key': clip['key'], 'in': clip.get('in', 0), 'len': clen, 'sub': c.get('sub'), 'author': c.get('author'), 'd': d}, ensure_ascii=False) + '\n', encoding='utf-8')
    return shots


def patch_ko_clips(M, ep):
    """ko(corp_render): visuals 의 pic 장면에 'clip' 이 있으면 bg_shots 대신 clip_bg — corp_render 는 안 고친다(import 만)."""
    orig_html, orig_bg = M.scene_html, M.bg_shots
    cur = {}

    def scene_html(spec, d, cues, emph):
        cur['spec'] = spec
        return orig_html(spec, d, cues, emph)

    def bg_shots(imgs, d, i, out, **kw):
        spec = cur.get('spec') or {}
        if spec.get('type') == 'pic' and spec.get('clip'):
            return clip_bg(M, ep, spec['clip'], imgs, d, i, Path(out), **kw)
        # ★10-23 ko08·ko10 motion_gate 0.953/0.955: 컷이 in→…→out 로 끝나면 첫·끝 프레임이 같은 그림·같은 배율(1.00) — 'out' 을 빼고 당김·옆 이동만 번갈아
        kw.setdefault('moves', SAFE_MOVES)
        return orig_bg(imgs, d, i, out, **kw)

    orig_gate = M.motion_gate

    def motion_gate(seg, folder, shots=None):
        s = orig_gate(seg, folder, shots)
        if s >= M.SSIM_STILL:          # 실패한 조각은 지워 둔다 — 다음 실행이 같은 해시로 재사용하지 않게(10-23 ko08 두 번 재실행 교훈)
            try:
                shutil.rmtree(Path(folder), ignore_errors=True)
            except Exception:
                pass
        return s
    M.scene_html, M.bg_shots, M.motion_gate = scene_html, bg_shots, motion_gate


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    ep = Path(argv[0]).resolve()
    lane = json.loads((ep / 'lane.json').read_text(encoding='utf-8'))
    lang = lane['lang']
    held = os.environ.get('MONETIZE_LOCK_HELD') == '1'   # chain_ko/chain_ja 가 RENDERING.lock(monetize) 을 이미 잡고 자식으로 띄웠다 — 렌더러 자체 락(10-22 23:3x 추가)은 건너뛴다
    if lang == 'ko':
        import corp_render as M
        M.script_gates = lambda e: gate(e, 'ko')
        if held:
            M.take_lock = lambda e, o: None
        patch_ko_clips(M, ep)   # 컷 방향·실패 seg 정리 패치는 항상, clip 은 clips.json 있을 때만 쓰인다
    else:
        import nenkin_render as M
        M.script_gate = lambda e: gate(e, 'ja')
        if held:
            class _NoLock:
                def __init__(self, *a, **k): pass
                def __enter__(self): return self
                def __exit__(self, *a): return False
            M.render_lock = _NoLock
        M.CHANNEL = lane['channel']   # 연금 채널명이 0장 띠에 박히지 않게
        patch_ja(M, ep, '--preview' in argv)
    return M.main([str(ep), *argv[1:]])


if __name__ == '__main__':
    sys.exit(main())
