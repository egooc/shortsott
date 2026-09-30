# 쇼핑 쇼츠(어랍숏 엔진) 한 편을 키워드 하나로 끝까지 모는 오케스트레이터.
#
#   python scripts/shop_pipeline.py prep    --wd arabshop03 [--keyword 风扇清洁刷] [--pages 1] [--max 6] [--add <URL|파일> ...]
#                                           더우인 검색 결과 + 틱톡·샤오홍슈·콰이쇼우·로컬을 한 폴더에 섞는다(같은 외형 제품만)
#   python scripts/shop_pipeline.py build   --wd arabshop03 --plan plan.json     소스 조립 + VTT + 서버 시작(무료)
#   python scripts/shop_pipeline.py voice   --wd arabshop03 --plan plan.json     편집표 제출 → 음성 합성(Typecast 과금)
#   python scripts/shop_pipeline.py advance --wd arabshop03                      다음 멈춤까지. 카메라는 자동
#   python scripts/shop_pipeline.py approve --wd arabshop03 [--note ...]         미리보기/검수 통과 기록 후 진행
#   python scripts/shop_pipeline.py bgm     --wd arabshop03                      Bicycle 믹스 → <wd>_bgm.mp4
#   python scripts/shop_pipeline.py note    --wd arabshop03 --kind text_leak --text '...' [--fix '...']
#                                           시트에서 잡은 결함 기록. 볼케이노 반려는 drive 가 자동 기록 → D:/volcano-runs/_gate_log.jsonl
#
# 사람(모델)이 하는 일은 셋뿐이다: plan.json 쓰기(샷 배치·원고), 미리보기 시트 보기, 검수 시트 보기.
# 나머지(검색·다운로드·샷 선별·조립·VTT·카메라·BGM)는 기계가 한다.
#
# plan.json
# {
#   "title": ["윗줄", "아랫줄"], "credit": "via Douyin 원본 N편",
#   "beats": [
#     {"type": "D", "shot": 12, "cue": "먼지 뭉치 실화", "sound": "bonk"},        원음 컷(원본 음성은 끈다)
#     {"type": "N", "text": "내레이션 한 문장", "shots": [18, 20], "fx": "(쓱)"},   내레이션 + 그 위 그림 샷들
#     ...
#   ],
#   "editorial": {"premise": ..., "title_promise": ..., "beats": [{"role", "what", "evidence", "beat_indices": [..]}]}
# }
# shot 번호는 prep 이 만든 _shots/shots.json 의 id 다(시트 _shots/shots_clean.jpg 에 #번호로 찍혀 있다).
# 샷을 통째로 이어 붙이므로 원음 컷의 경계가 곧 샷 경계다 — 엔진의 컷 경계 반려가 거의 사라진다.
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path

MIDFORM = Path(__file__).resolve().parents[1]
RUNS = Path('D:/volcano-runs')
TEMPLATE = RUNS / 'arabshop02'                      # runner·fonts·sfx·출입증을 복사해 올 폴더
VPY = Path.home() / '.volcano' / 'venv' / 'Scripts' / 'python.exe'
BGM = MIDFORM / 'assets' / 'bgm' / 'shopping' / 'Komiku_-_12_-_Bicycle.ogg'
FPS = 30
CHARS_PER_SEC = 8.3                                  # arabshop02 실측(공백 포함 글자/초)
FIRST_PAYLOAD = {"env": None, "env_probe_retry": False, "rinbox_engine": "film-editor-v1",
                 "review_policy": {"provider": "client"}, "review_client": "claude"}


def sh(cmd, **kw):
    print('  $', ' '.join(str(c) for c in cmd)[:200])
    return subprocess.run([str(c) for c in cmd], **kw)


def rj(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))


def wj(p, d):
    Path(p).write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def keep_plan(src, wd):
    dst = wd / 'plan.json'
    if Path(src).resolve() != dst.resolve():
        shutil.copy(src, dst)


def wd_path(name):
    return RUNS / name


def probe_dur(f):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(f)],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


# ---------------------------------------------------------------- prep
def cmd_prep(a):
    wd = wd_path(a.wd)
    foot = wd / 'footage'
    foot.mkdir(parents=True, exist_ok=True)
    if a.keyword:                                       # 더우인 검색(TikHub 유료, 요청 --pages 회)
        cand = wd / 'search.json'
        if not cand.exists():
            r = sh(['node', MIDFORM / 'scripts' / 'douyin-search.js', '--keyword', a.keyword, '--pages', a.pages,
                    '--sort', 'likes', '--max-dur', a.max_dur, '--out', cand], cwd=MIDFORM)
            if r.returncode:
                sys.exit('검색 실패')
        ids = [c['aweme_id'] for c in rj(cand)['candidates']][:a.max]
        missing = [i for i in ids if not (foot / f'dy_{i}.mp4').exists()]
        if missing:
            sh(['node', MIDFORM / 'scripts' / 'douyin-grab.js', '--out', foot, *missing], cwd=MIDFORM)
    if a.add:                                           # 틱톡·샤오홍슈·콰이쇼우·더우인 URL·로컬 파일을 섞는다
        sh([sys.executable, MIDFORM / 'scripts' / 'social_grab.py', '--out', foot, *a.add],
           env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    vids = sorted(str(p) for p in foot.glob('*.mp4') if not p.name.startswith('_'))
    if not vids:
        sys.exit('받은 영상이 없다')
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    sh([sys.executable, '-W', 'ignore', MIDFORM / 'scripts' / 'shot_picker.py', '--out', wd / '_shots', *vids], env=env)
    for item in ('runner', 'fonts', 'sfx_norm'):
        if not (wd / item).exists():
            shutil.copytree(TEMPLATE / item, wd / item)
    if not (wd / '.volcano_runner_key.json').exists():
        shutil.copy(TEMPLATE / '.volcano_runner_key.json', wd / '.volcano_runner_key.json')
    meta = [rj(p.with_suffix('.json')) for p in map(Path, vids) if p.with_suffix('.json').exists()]
    wj(wd / 'sources.json', [{'file': Path(v).name, 'platform': m.get('platform', 'douyin'),
                              'id': m.get('aweme_id') or m.get('id'), 'url': m.get('url'), 'author': m.get('author'),
                              'desc': m.get('desc'), 'rights': m.get('rights')}
                             for v, m in zip([v for v in vids if Path(v).with_suffix('.json').exists()], meta)])
    by = {}
    for m in meta:
        by[m.get('platform', 'douyin')] = by.get(m.get('platform', 'douyin'), 0) + 1
    print('  소스:', ', '.join(f'{k} {v}편' for k, v in by.items()), '— 외형이 같은 제품만 섞였는지 시트로 확인하라')
    print(f'\n준비 끝 — 시트: {wd / "_shots" / "shots_clean.jpg"}\n다음: plan.json 을 쓰고 build')


# ---------------------------------------------------------------- build
SENTENCE_END = ('요', '죠', '다', '까', '네')   # 존댓말 종결 — 카드가 문장 경계를 넘지 않게 여기서 끊는다


def split_cards(text, limit=9):
    """문장(존댓말 종결 어미)마다 먼저 끊고, 문장 안에서는 카드 수를 최소로·길이를 고르게 나눈다."""
    words = text.split()
    sentences, cur = [], []
    for w in words:
        cur.append(w)
        if w.endswith(SENTENCE_END):
            sentences.append(cur)
            cur = []
    if cur:
        sentences.append(cur)
    L = lambda ws: len(''.join(ws))
    cards = []
    for ws in sentences:
        n = len(ws)
        best = {n: (0, 0, [])}                 # i → (카드 수, 가장 긴 카드, 나눔)
        for i in range(n - 1, -1, -1):
            opts = []
            for k in range(i + 1, n + 1):
                seg = ws[i:k]
                if L(seg) > limit and k > i + 1:
                    break
                c, mx, rest = best[k]
                opts.append((c + 1, max(mx, L(seg)), [' '.join(seg)] + rest))
            best[i] = min(opts, key=lambda o: (o[0], o[1]))
        cards += best[0][2]
    return cards


def layout(wd, plan):
    """plan 의 beat 순서대로 샷을 이어 붙인 타임라인을 계산한다. 샷 하나 = 조각 하나."""
    shots = {s['id']: s for s in rj(wd / '_shots' / 'shots.json')['shots']}
    order, seen = [], set()
    for b in plan['beats']:
        for sid in ([b['shot']] if b['type'] == 'D' else b['shots']):
            if sid in seen:
                sys.exit(f'샷 #{sid} 를 두 번 썼다 — 같은 원본 구간 반복은 엔진이 반려한다')
            s = shots.get(sid)
            if not s or not s.get('usable'):
                sys.exit(f'샷 #{sid} 는 없거나 쓸 수 없다(text/dup/short)')
            seen.add(sid)
            order.append(s)
    pos, t = {}, 0.0
    for s in order:
        n = int(round((s['t1'] - s['t0']) * FPS)) - 2      # 앞뒤 1프레임씩 깎아 이웃 샷이 새지 않게
        dur = n / FPS
        pos[s['id']] = (round(t, 6), round(t + dur, 6))
        t += dur
    return order, pos, t


def cmd_build(a):
    wd = wd_path(a.wd)
    plan = rj(a.plan)
    keep_plan(a.plan, wd)
    vids = {Path(v).name: v for v in rj(wd / '_shots' / 'shots.json')['videos']}
    order, pos, total = layout(wd, plan)
    parts = wd / '_parts'
    if parts.exists():
        shutil.rmtree(parts)
    parts.mkdir()
    vf = ('scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,'
          'pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1')
    shifts = rj(wd / '_shots' / 'shots.json').get('shift_up_px', {})
    for i, s in enumerate(order):
        a0 = s['t0'] + 1 / FPS
        n = int(round((pos[s['id']][1] - pos[s['id']][0]) * FPS))
        up = int(shifts.get(s['video'], 0))
        vfi = vf
        # 가장자리 문구를 창 밖으로 밀어낸다. pad 로 빈자리를 채우면 창 테두리에 검은 띠가 생겨서(arabshop08)
        # 잘라 낸 만큼 살짝 확대해 1080x1920 을 다시 꽉 채운다.
        if up > 0:      # 위쪽 문구 띠 — 위를 잘라 낸다
            vfi += f',crop=1080:{1920 - up}:0:{up},scale=-2:1920:flags=lanczos,crop=1080:1920'
        elif up < 0:    # 아래쪽 자막 — 아래를 잘라 낸다
            vfi += f',crop=1080:{1920 + up}:0:0,scale=-2:1920:flags=lanczos,crop=1080:1920'
        sh(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{a0:.4f}', '-i', vids[s['video']], '-frames:v', n,
            '-vf', vfi, '-c:v', 'libx264', '-crf', 18, '-preset', 'medium',
            '-af', 'aresample=48000,apad', '-c:a', 'aac', '-b:a', '128k', '-ac', 2,
            '-t', f'{n / FPS:.6f}', parts / f'p{i:02d}.mp4'], check=True)
    # 실제로 나온 프레임 수로 위치를 다시 잡는다(원본 끝에 걸린 조각은 요청보다 짧게 나온다)
    counts = []
    for i in range(len(order)):
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries',
                            'stream=nb_read_frames', '-of', 'csv=p=0', str(parts / f'p{i:02d}.mp4')],
                           capture_output=True, text=True)
        counts.append(int(r.stdout.strip()))
    pos, f0 = {}, 0
    for s_, n in zip(order, counts):
        pos[s_['id']] = (round(f0 / FPS, 6), round((f0 + n) / FPS, 6))
        f0 += n
    total = f0 / FPS
    # 이어 붙이기는 concat 필터(디코딩 후 프레임 단위)로 한다. concat demuxer 는 조각마다 붙는 인코더 지연
    # (시작 0.067s)과 조각별 오디오 길이 차이로 시간표가 밀려, 엔진의 컷 위치가 뒤로 갈수록 3→10프레임
    # 어긋났다(arabshop03 · 29.69fps)
    src = wd / 'volcano_src.mp4'
    ins, fc = [], ''
    for i in range(len(order)):
        ins += ['-i', parts / f'p{i:02d}.mp4']
        fc += (f'[{i}:v:0]setpts=PTS-STARTPTS[v{i}];'
               f'[{i}:a:0]asetpts=PTS-STARTPTS,apad,atrim=end={counts[i] / FPS:.6f}[a{i}];')
    fc += ''.join(f'[v{i}][a{i}]' for i in range(len(order))) + f'concat=n={len(order)}:v=1:a=1[v][a]'
    sh(['ffmpeg', '-loglevel', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
        '-r', FPS, '-fps_mode', 'cfr', '-c:v', 'libx264', '-crf', 18, '-preset', 'medium',
        '-c:a', 'aac', '-b:a', '128k', '-ar', 48000, '-movflags', '+faststart', src], check=True)
    # 검증: 프레임 수·시작 시각·fps 가 계산과 맞아야 한다
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries',
                        'stream=nb_read_frames,start_time,avg_frame_rate', '-of', 'json', str(src)],
                       capture_output=True, text=True)
    st = json.loads(r.stdout)['streams'][0]
    if int(st['nb_read_frames']) != f0 or abs(float(st.get('start_time') or 0)) > 1e-3 or st['avg_frame_rate'] != '30/1':
        sys.exit(f"소스 시간표 불일치: frames {st['nb_read_frames']}≠{f0} · start {st.get('start_time')} · fps {st['avg_frame_rate']}")
    print(f"  소스 검증 OK — {f0}프레임 · 30fps · 시작 0")

    # 원음 자막: 원음 컷 가운데 0.8초(짧으면 줄인다)
    vtt, k = ['WEBVTT', ''], 1
    for b in plan['beats']:
        if b['type'] != 'D':
            continue
        if len(b['cue']) > 11:
            sys.exit(f"원음 자막은 11자 이하: {b['cue']}")
        s0, s1 = pos[b['shot']]
        mid, half = (s0 + s1) / 2, min(0.4, (s1 - s0) / 2 - 0.1)
        if half < 0.2:
            sys.exit(f"샷 #{b['shot']} 가 원음 컷으로 쓰기엔 짧다({s1 - s0:.2f}s)")
        b['_cue'] = [round(mid - half, 3), round(mid + half, 3)]
        ts = lambda x: f'{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{x % 60:06.3f}'
        vtt += [str(k), f"{ts(b['_cue'][0])} --> {ts(b['_cue'][1])}", b['cue'], '']
        k += 1
    (wd / 'volcano_src.vtt').write_text('\n'.join(vtt), encoding='utf-8')
    wj(wd / 'layout.json', {'total': total, 'pos': {str(k): v for k, v in pos.items()},
                            'cues': [b.get('_cue') for b in plan['beats']]})

    used_files = {s['video'] for s in order}             # 크레딧·권리 기록엔 실제로 쓴 영상만
    srcs = [s for s in (rj(wd / 'sources.json') if (wd / 'sources.json').exists() else []) if s.get('file') in used_files]
    wj(wd / 'src.json', {
        'kind': 'local_video', 'path': src.as_posix(),
        'rights': {'basis': 'credit_only', 'statement': '공개 게시물 재편집: ' + ', '.join(
            f"{s.get('platform')}:{s.get('id')}({s.get('author')})" for s in srcs) + '. 출처 표기 기준(소유주 결정 2026-09-19).'},
        'attribution': plan.get('credit', 'via Douyin'), 'license': 'none-credit_only',
        'license_url': srcs[0]['url'] if srcs else ''})
    # 소스를 새로 만들었으면 서버 쪽 상태도 새로 시작한다
    stale = wd / '_stale'
    for f in ('ingest.json', 'identity.json', 'transcript.json', 'transcript.txt', 'source-timing.json',
              'input_brief.json', 'editor.lock', 'logs', 'source-catalog', 'edits'):
        if (wd / f).exists():
            stale.mkdir(exist_ok=True)
            shutil.move(str(wd / f), str(stale / f'{f}.{os.getpid()}'))
    wj(wd / 'next_payload.json', FIRST_PAYLOAD)
    warn_voice(plan, pos)
    drive(wd, 'start', source=(wd / 'src.json').read_text(encoding='utf-8'))
    print(f'\n조립 끝 — 소스 {total:.1f}s · 다음: voice (음성 과금)')


def warn_voice(plan, pos):
    for i, b in enumerate(plan['beats']):
        if b['type'] != 'N':
            continue
        need = len(b['text']) / CHARS_PER_SEC + 0.2
        have = sum(pos[s][1] - pos[s][0] for s in b['shots'])
        if have < need:
            print(f"  ⚠ beat {i} 내레이션 예상 {need:.1f}s > 그림 {have:.1f}s — 엔진이 앞 장면을 끌어와 반복한다. 샷을 더 붙여라")


# ---------------------------------------------------------------- voice (편집표)
MIN_PARTIAL = 20          # 엔진은 샷을 일부만 쓸 때 15프레임 '초과'를 요구한다(15 도 반려됨) — 여유 두고 20
NARR_PAD = 0.17           # 엔진 내레이션 길이 = 발화 구간 + 약 0.17s (arabshop02 6개 실측, 오차 ±0.04s)


def measured_durations(wd, plan):
    """이미 산 음성의 단어 시각으로 내레이션별 길이를 잰다. 없거나 원고가 다르면 None."""
    import glob
    resps = sorted(glob.glob(str(wd / 'paid' / '*' / 'response.json')), key=os.path.getmtime)
    texts = [b['text'] for b in plan['beats'] if b['type'] == 'N']
    for f in reversed(resps):
        words = rj(f).get('words') or []
        if ''.join(w['text'] for w in words).replace(' ', '') != ''.join(texts).replace(' ', ''):
            continue
        out, wi = [], 0
        for t in texts:
            target, acc, first, last = t.replace(' ', ''), '', None, None
            while wi < len(words) and len(acc) < len(target):
                w = words[wi]
                first = first or w
                last = w
                acc += w['text'].replace(' ', '')
                wi += 1
            out.append(round((last['end'] - first['start'] + NARR_PAD) * FPS) / FPS)
        return out
    return None


def engine_cuts(wd):
    import glob
    fs = sorted(glob.glob(str(wd / 'source-catalog' / '*.json')), key=os.path.getmtime)
    return sorted(rj(fs[-1]).get('cuts') or []) if fs else None


def fit_by_fragments(a, b, dur, cuts):
    """[a,b] 를 엔진 컷으로 조각낸 뒤, 통째 조각 여러 개 + (필요하면) 부분 조각 하나로 dur 을 정확히 채운다.
    건너뛴 조각은 양끝이 컷이라 빈틈 반려가 안 난다. a(또는 b)가 엔진 컷이 아니면 그 조각은 이웃 클립과 같은
    엔진 샷이므로 반드시 붙여 쓴다(앞 조각은 a 부터, 뒤 조각은 b 까지). arabshop08 에서 필요해졌다."""
    from itertools import combinations
    pts = sorted({a, b, *[c for c in cuts if a + 1e-3 < c < b - 1e-3]})
    frags = [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    if not frags:
        return None
    is_cut = lambda x: any(abs(x - c) < 1e-3 for c in cuts)
    must_first, must_last = not is_cut(a), not is_cut(b)
    L = lambda f: f[1] - f[0]
    minp = MIN_PARTIAL / FPS
    n = len(frags)
    best = None
    for k in range(0, n + 1):
        for whole in combinations(range(n), k):
            tot = sum(L(frags[i]) for i in whole)
            rest = dur - tot
            if rest < -1e-6:
                continue
            opts = []
            if rest < 1 / FPS:
                opts.append(None)
            else:
                for p in range(n):
                    if p in whole:
                        continue
                    if minp - 1e-6 <= rest <= L(frags[p]) + 1e-6:
                        opts.append(p)
            for p in opts:
                used = set(whole) | ({p} if p is not None else set())
                if must_first and 0 not in used:
                    continue
                if must_last and n - 1 not in used:
                    continue
                if must_first and p == 0 and n > 1:
                    continue                                   # 앞 조각을 부분만 쓰면 a 쪽에 빈틈
                pics = []
                for i in sorted(used):
                    f0, f1 = frags[i]
                    if i == p:
                        s0 = f1 - rest if (i == n - 1 and must_last) else f0
                        pics.append((round(s0, 6), round(rest, 6)))
                    else:
                        pics.append((round(f0, 6), round(L(frags[i]), 6)))
                # 붙어 있는 그림은 하나로 합친다
                merged = []
                for s, w in pics:
                    if merged and abs(merged[-1][0] + merged[-1][1] - s) < 1e-3:
                        merged[-1] = (merged[-1][0], round(merged[-1][1] + w, 6))
                    else:
                        merged.append((s, w))
                score = (len(merged), -sum(w for _, w in merged[:1]))
                if best is None or score < best[0]:
                    best = (score, merged)
    return best[1] if best else None


def fit_pictures(spans, dur, cuts):
    """내레이션 길이 dur 를 샷들(spans)에 채운다.
    샷들이 소스에서 연달아 붙어 있으면(build 가 그렇게 만든다) 그림 하나로 이어 재생하고, 시작점을 프레임 단위로
    밀어 가며 엔진 컷으로 쪼개진 조각을 모두 '통째로' 또는 MIN_PARTIAL 이상 쓰는 자리를 고른다."""
    contiguous = all(abs(spans[i][0] - spans[i - 1][1]) < 1e-3 for i in range(1, len(spans)))
    if contiguous:
        picked = fit_by_fragments(spans[0][0], spans[-1][1], dur, cuts)
        if picked:
            return picked, 0.0
        a, b = spans[0][0], spans[-1][1]
        if b - a < dur - 1e-6:
            return [(round(a, 6), round(b - a, 6))], dur - (b - a)
        edges = sorted({a, b, *[c for c in cuts if a < c < b]})
        # 먼저 '앞뒤 남는 부분에 엔진 컷이 끼어 있는' 시작점을 찾는다 — 없으면 이웃 클립과 같은 엔진 샷 안에
        # 빈틈이 생겨 same_shot_source_gap 로 반려된다(arabshop08). 컷 목록에 a·b 가 없으면 그 자리는 컷이 아니다.
        cutset = [c for c in cuts]
        near = lambda x, y: any(x - 1e-3 <= c <= y + 1e-3 for c in cutset)
        for off in range(0, int(round((b - a - dur) * FPS)) + 1):
            s0 = a + off / FPS
            s1 = s0 + dur
            lead_ok = off == 0 or near(a, s0)
            tail_ok = abs(b - s1) < 1e-3 or near(s1, b)
            if not (lead_ok and tail_ok):
                continue
            bad = False
            for e0, e1 in zip(edges, edges[1:]):
                used = max(0.0, min(s1, e1) - max(s0, e0))
                if 1e-6 < used < (e1 - e0) - 1e-6 and used * FPS < MIN_PARTIAL - 0.01:
                    bad = True
                    break
            if not bad:
                return [(round(s0, 6), round(dur, 6))], 0.0
        for off in range(0, int(round((b - a - dur) * FPS)) + 1):
            s0 = a + off / FPS
            s1 = s0 + dur
            bad = False
            for e0, e1 in zip(edges, edges[1:]):
                used = max(0.0, min(s1, e1) - max(s0, e0))
                if 1e-6 < used < (e1 - e0) - 1e-6 and used * FPS < MIN_PARTIAL - 0.01:
                    bad = True
                    break
            if not bad:
                return [(round(s0, 6), round(dur, 6))], 0.0
        return [(round(a, 6), round(dur, 6))], 0.0
    pics, left = [], dur
    for i, (a, b) in enumerate(spans):
        if left <= 1e-6:
            break
        take = min(b - a, left)
        if take < b - a - 1e-6:                                   # 마지막 샷 — 일부만 쓴다
            best = None
            for off in range(0, int(round((b - a - take) * FPS)) + 1):
                s0 = a + off / FPS
                s1 = s0 + take
                edges = [a] + [c for c in cuts if a < c < b] + [b]
                ok = True
                for e0, e1 in zip(edges, edges[1:]):
                    used = max(0.0, min(s1, e1) - max(s0, e0))
                    whole = e1 - e0
                    if used > 1e-6 and used < whole - 1e-6 and used * FPS < MIN_PARTIAL - 0.01:
                        ok = False
                        break
                if ok:
                    best = s0
                    break
            if best is None:
                best = a
            pics.append((round(best, 6), round(take, 6)))
        else:
            pics.append((round(a, 6), round(take, 6)))
        left -= take
    # 마지막 그림이 너무 짧으면 바로 앞 그림에서 넘겨받는다(앞 그림은 시작점 그대로 두고 끝만 줄인다)
    if len(pics) > 1 and pics[-1][1] * FPS < MIN_PARTIAL:
        need = MIN_PARTIAL / FPS - pics[-1][1]
        s_prev, w_prev = pics[-2]
        if (w_prev - need) * FPS >= MIN_PARTIAL:
            pics[-2] = (s_prev, round(w_prev - need, 6))
            a, b = spans[len(pics) - 1]
            pics[-1] = (round(a, 6), round(pics[-1][1] + need, 6))
    return pics, left


def make_edit(wd, plan):
    lay = rj(wd / 'layout.json')
    pos = {int(k): v for k, v in lay['pos'].items()}
    FX = {'position': [540, 1060], 'color': '#AB70FF', 'outline_color': '#000000'}
    narration, seq, idx_of_beat = [], [], {}
    durs, cuts = measured_durations(wd, plan), engine_cuts(wd)
    fitted = durs is not None and cuts is not None
    print(f"  그림 맞추기: {'실측 음성 길이·엔진 컷 사용' if fitted else '실측 없음 — 샷 길이 비율(첫 음성 구매 뒤 다시 voice 하면 맞춘다)'}")
    ni = 0
    for i, b in enumerate(plan['beats']):
        idx_of_beat[i] = len(seq)
        if b['type'] == 'D':
            s0, s1 = pos[b['shot']]
            c = lay['cues'][i]
            seq.append({'source_in': s0, 'source_out': s1, 'captions': [[c[0], c[1], b['cue']]],
                        'source_audio_gain_db': -96, 'effects': [],
                        'sounds': [{'at_frame': 8, 'asset': b['sound'], 'gain_db': -13}] if b.get('sound') else []})
        else:
            nid = f'n{len(narration)}'
            cards = b.get('cards') or split_cards(b['text'])
            assert ' '.join(cards) == b['text'], (cards, b['text'])
            if fitted:
                pics, short = fit_pictures([pos[s] for s in b['shots']], durs[ni], cuts)
                if short > 1 / FPS:
                    print(f"  ⚠ {nid} 음성 {durs[ni]:.2f}s 인데 그림이 {short:.2f}s 모자란다 — plan 에 샷을 더 붙여라")
                pictures = [{'source_in': s0, 'weight': w} for s0, w in pics]
            else:
                pictures = [{'source_in': pos[s][0], 'weight': round(pos[s][1] - pos[s][0], 3)} for s in b['shots']]
            ni += 1
            narration.append({'id': nid, 'text': b['text'], 'cards': cards, 'source': pictures[0]['source_in']})
            clip = {'narration': nid,
                    'pictures': pictures,
                    'effects': [dict(start_frame=20, end_frame=55, text=b['fx'], **FX)] if b.get('fx') else [],
                    'sounds': [{'at_frame': 20, 'asset': b['sound'], 'gain_db': -14}] if b.get('sound') else []}
            seq.append(clip)
    ed = plan.get('editorial', {})
    beats = [{'role': x['role'], 'what': x['what'], 'evidence': x['evidence'],
              'sequence_indices': [idx_of_beat[j] for j in x['beat_indices']]} for x in ed.get('beats', [])]
    out = {'title': plan['title'], 'credit': plan.get('credit', 'via Douyin'), 'narration': narration, 'sequence': seq,
            'editorial': {'version': 'story-cards-v1', 'premise': ed.get('premise', ''),
                          'title_promise': ed.get('title_promise', ''), 'beats': beats}}
    return out, fitted


def cmd_voice(a):
    wd = wd_path(a.wd)
    plan = rj(a.plan)
    keep_plan(a.plan, wd)
    edit, fitted = make_edit(wd, plan)
    wj(wd / 'edit_draft.json', edit)
    p = rj(wd / 'next_payload.json')
    p['rinbox_edit'] = edit
    for k in ('rinbox_camera', 'rinbox_preview', 'rinbox_review', 'rinbox_edit_patch'):
        p.pop(k, None)
    if a.retry:
        p['rinbox_retry'] = a.retry
    wj(wd / 'next_payload.json', p)
    step = current_step(wd) or 'rinbox_plan'
    drive(wd, step)
    # 소스를 새로 만든 직후엔 엔진 컷·음성 길이가 없어 비율로만 놓았다 — 이제 생겼으면 한 번 더 맞춘다
    if brief(wd).get('message', '').startswith('원본 컷') and not fitted:
        if measured_durations(wd, plan) is not None and engine_cuts(wd) is not None:
            edit, fitted = make_edit(wd, plan)
            p = rj(wd / 'next_payload.json')
            p['rinbox_edit'] = edit
            wj(wd / 'next_payload.json', p)
            wj(wd / 'edit_draft.json', edit)
            drive(wd, current_step(wd))
    report(wd)


# ---------------------------------------------------------------- 서버 구동
GATE_LOG = RUNS / '_gate_log.jsonl'   # 볼케이노 반려·사람 검수 적발을 한 줄씩 쌓는다 — 나중에 자체 게이트의 학습 자료


def gate_log(wd, source, kind, message, detail=None):
    """source: volcano(서버·엔진 반려) | review(모델이 시트에서 적발) | picker(shot_picker 가 거름)"""
    import datetime
    rec = {'at': datetime.datetime.now().isoformat(timespec='seconds'), 'wd': Path(wd).name,
           'source': source, 'kind': kind, 'message': message, 'detail': detail}
    with open(GATE_LOG, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def log_volcano_stop(wd, step):
    r = brief(wd)
    msg = r.get('message', '')
    if not msg or r.get('status') != 'need_input':
        return
    routine = ('장면별 이미지를 실제로 열어', '원본과 실제 예상 구도를', '실제 출력 영상과 남은 검수', '원본 자막으로 새 대본과')
    if msg.startswith(routine):
        return                                             # 정상 멈춤(사람 차례)은 반려가 아니다
    kind = 'boundary' if msg.startswith('원본 컷') else 'edit_invalid'
    gate_log(wd, 'volcano', kind, msg[:300], {'step': step, 'issues': last_boundary_issues(wd) if kind == 'boundary' else None})


def drive(wd, step, source=None):
    cmd = [VPY, wd / 'runner' / 'volcano_drive.py', '--workdir', wd, '--step', step,
           '--payload', wd / 'next_payload.json', '--tool', 'volcano_video', '--max-steps', 30]
    if source:
        cmd += ['--source', source]
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    with open(wd / 'drive.log', 'a', encoding='utf-8') as log:
        r = subprocess.run([str(c) for c in cmd], env=env, stdout=log, stderr=subprocess.STDOUT)
    print(f'  drive {step} → exit {r.returncode}')
    if r.returncode == 3:
        log_volcano_stop(wd, step)
    return r.returncode


def brief(wd):
    f = wd / 'input_brief.json'
    return rj(f)['response'] if f.exists() else {}


def current_step(wd):
    return brief(wd).get('next_step')


def last_boundary_issues(wd):
    fs = sorted(wd.glob('boundary-*.json'), key=lambda p: p.stat().st_mtime)
    if not fs:
        return []
    d = rj(fs[-1])
    iss = (d.get('audit') or {}).get('issues') or (d.get('timeline') or {}).get('picture_boundary_issues') or []
    return [{k: v for k, v in i.items() if k != 'source_shots'} for i in iss]


def mosaic(files, out, cols=14, size=170):
    code = f'''
from PIL import Image, ImageDraw
fs={[str(f) for f in files]!r}
W=H={size}; cols={cols}
rows=max(1,(len(fs)+cols-1)//cols)
c=Image.new('RGB',(cols*W,rows*(H+14)),'black'); d=ImageDraw.Draw(c)
for i,f in enumerate(fs):
    im=Image.open(f); im.thumbnail((W,H)); x=(i%cols)*W; y=(i//cols)*(H+14)
    c.paste(im,(x,y+14)); d.text((x+2,y),f.split('/')[-1].split(chr(92))[-1][:-4],fill='yellow')
c.save({str(out)!r},quality=88)
'''
    subprocess.run([str(VPY), '-c', code], check=True)


def report(wd):
    r = brief(wd)
    step = r.get('next_step')
    print(f'\n■ 멈춘 곳: {step} — {r.get("message", "")[:300]}')
    iss = last_boundary_issues(wd)
    if r.get('message', '').startswith('원본 컷') and iss:
        for i in iss:
            print('   경계:', i)
    pv = wd / '_pv'
    pv.mkdir(exist_ok=True)
    if 'camera_preview_brief' in r:
        d = Path(r['camera_preview_brief']['sample_sheets'][0]).parent
        crops = sorted(d.glob('c*-crop-*.jpg'), key=lambda f: (int(f.name.split('-')[0][1:]), f.name))
        for n in range(0, len(crops), 84):
            mosaic(crops[n:n + 84], pv / f'preview{n // 84}.jpg')
        print(f'   미리보기 모자이크: {pv}/preview*.jpg · 레이아웃: {d / "layout-0.jpg"}')
    if 'review_brief' in r:
        sheets = r['review_brief']['sample_sheets']
        for n in range(0, len(sheets), 5):
            code = f'''
from PIL import Image
fs={sheets[n:n + 5]!r}
ims=[Image.open(f) for f in fs]; w=sum(i.width for i in ims); h=max(i.height for i in ims)
c=Image.new('RGB',(w,h)); x=0
for i in ims: c.paste(i,(x,0)); x+=i.width
c.thumbnail((2600,2600)); c.save({str(pv / f"review{n // 5}.jpg")!r},quality=85)
'''
            subprocess.run([str(VPY), '-c', code], check=True)
        print(f'   검수 시트 {len(sheets)}장 → {pv}/review*.jpg (전부 보고 approve)')


def cmd_advance(a):
    wd = wd_path(a.wd)
    for _ in range(4):
        step = current_step(wd)
        r = brief(wd)
        if 'camera_brief' in r and 'camera_preview_brief' not in r:
            t = r['camera_brief']['template']
            for s in t['source_shots'].values():         # 세로 원본 → 정사각형 창은 폭 전체. 가로 중심은 가운데
                s['points'] = [[s['source_in'], 0.5]]
            p = rj(wd / 'next_payload.json')
            p['rinbox_camera'] = t
            p.pop('rinbox_preview', None)
            wj(wd / 'next_payload.json', p)
            drive(wd, step)
            continue
        break
    report(wd)


def cmd_approve(a):
    wd = wd_path(a.wd)
    r = brief(wd)
    p = rj(wd / 'next_payload.json')
    if 'camera_preview_brief' in r:
        p['rinbox_preview'] = {'preview_id': r['camera_preview_brief']['preview_id'], 'visual_checked': True, 'blockers': []}
    elif 'review_brief' in r:
        b = r['review_brief']
        p['rinbox_review'] = {'render_id': b['render_id'], 'verdict': 'pass', 'visual_checked': True,
                              'audio_listened': False, 'blockers': [], 'notes': a.note or [],
                              'reviewed_sheets': sorted(set(b.get('reviewed_sheets', [])) | set(b['sheet_indices']))}
    else:
        sys.exit(f'승인할 것이 없다 — 지금 단계: {r.get("next_step")}')
    wj(wd / 'next_payload.json', p)
    rc = drive(wd, r['next_step'])
    if rc == 0:
        finals = sorted(wd.glob('edits/*/final-*.mp4'), key=lambda f: f.stat().st_mtime)
        shutil.copy(finals[-1], wd / f'{wd.name}_final.mp4')
        print(f'\n완료 — {wd / (wd.name + "_final.mp4")} · 다음: bgm')
    else:
        report(wd)


# ---------------------------------------------------------------- bgm
def cmd_note(a):
    """모델이 미리보기·검수 시트에서 잡은 결함을 기록한다(볼케이노가 통과시킨 것)."""
    gate_log(wd_path(a.wd), a.source, a.kind, a.text, {'fix': a.fix} if a.fix else None)
    print(f'기록 — {GATE_LOG}')


def cmd_bgm(a):
    wd = wd_path(a.wd)
    src = wd / f'{wd.name}_final.mp4'
    out = wd / f'{wd.name}_bgm.mp4'
    dur = probe_dur(src)
    loop = ['-stream_loop', '-1'] if dur > probe_dur(BGM) - 0.3 else []
    fc = (f'[1:a]aresample=48000,volume=-8dB,afade=t=in:d=0.3,afade=t=out:st={max(0, dur - 1.0):.2f}:d=1.0[bgm];'
          '[0:a]asplit=2[v][sc];[bgm][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[duck];'
          '[v][duck]amix=inputs=2:duration=first:normalize=0,volume=-2.5dB,aresample=192000,'
          'alimiter=limit=0.75:level=false,aresample=48000[a]')
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, *loop, '-i', BGM, '-filter_complex', fc,
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], check=True)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(out), '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True)
    print('\n'.join(l for l in r.stderr.splitlines() if l.strip().startswith(('I:', 'Peak:')))[-80:])
    print(f'완성 — {out}')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    p = sp.add_parser('prep'); p.add_argument('--wd', required=True); p.add_argument('--keyword', default=None)
    p.add_argument('--add', nargs='*', default=[], help='섞을 URL(틱톡·샤오홍슈·콰이쇼우·더우인)이나 로컬 파일')
    p.add_argument('--pages', default='1'); p.add_argument('--max', type=int, default=6); p.add_argument('--max-dur', default='90')
    p = sp.add_parser('build'); p.add_argument('--wd', required=True); p.add_argument('--plan', required=True)
    p = sp.add_parser('voice'); p.add_argument('--wd', required=True); p.add_argument('--plan', required=True)
    p.add_argument('--retry', default=None)
    p = sp.add_parser('advance'); p.add_argument('--wd', required=True)
    p = sp.add_parser('approve'); p.add_argument('--wd', required=True); p.add_argument('--note', action='append')
    p = sp.add_parser('bgm'); p.add_argument('--wd', required=True)
    p = sp.add_parser('note'); p.add_argument('--wd', required=True)
    p.add_argument('--kind', required=True, help='text_leak | wrong_product | picture_mismatch | card_split | rights | other')
    p.add_argument('--text', required=True); p.add_argument('--fix', default=None)
    p.add_argument('--source', default='review')
    a = ap.parse_args()
    {'prep': cmd_prep, 'build': cmd_build, 'voice': cmd_voice, 'advance': cmd_advance,
     'approve': cmd_approve, 'bgm': cmd_bgm, 'note': cmd_note}[a.cmd](a)


if __name__ == '__main__':
    main()
