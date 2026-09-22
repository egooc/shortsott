# 완성본에서 «사건이 고조되는» 몇 초를 잘라 맨 앞에 붙인다 — 후킹 하이라이트.
#
#   python tools/hook_prepend.py <workdir> <final.mp4> <out.mp4>
#                                [--seconds 2.2] [--beat escalation] [--fade 0.35]
#
# 왜 (2026-09-22 소유주 지시)
#   "스토리상 가장 강력한 후킹이 되는 장면 몇 초를 최종 결과물에서 잘라 복사해서 맨 앞에 배치.
#    후킹 하이라이트 주고 본편 시작하는 것처럼."
#   어랍숏은 이걸 «소스 단계»에서 한다(사례 76). 명화관은 엔진을 다시 돌리면 ASR·TTS 실비가
#   또 나가므로 **완성본 후처리**로 붙인다.
#
# 어디를 자르나 — 추측하지 않는다
#   편집표의 `editorial.beats` 에 setup / escalation / reversal / payoff 가 들어 있고,
#   각 비트는 `sequence_indices` 로 타임라인 컷을 가리킨다. 그 인덱스를 timeline.json 의
#   `timeline_in`+`duration` 으로 바꾸면 **완성본에서의 시각**이 그대로 나온다.
#   (reframe 은 밴드·BGM·라우드니스만 얹고 길이를 바꾸지 않는다.)
#
#   ★기본값은 `escalation` 의 «끝부분»이다. payoff 를 쓰면 결말 대사가 미리 노출된다 —
#     소유주 지시: "페이오프를 궁금하게 사건이 고조되는 부분을 잡아야지. 결말대사노출이아니라."
#   ★자막은 그대로 따라온다. 완성본에서 자르므로 자막이 함께 찍힌다 — 그래야 알아듣는다.
#
# BGM
#   이어 붙이는 지점에서 음악이 툭 끊긴다. 하이라이트 꼬리에 페이드아웃, 본편 머리에
#   페이드인을 걸고 마지막에 라우드니스를 다시 맞춘다.
import json
import os
import subprocess
import sys

FPS = 30.0


def load(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def run(argv):
    proc = subprocess.run(argv, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode('utf-8', 'replace')[-1500:])
        raise SystemExit(f'ffmpeg 실패: {argv[0]}')


def beat_window(workdir, beat_name, seconds, tail):
    """비트 이름 → 완성본에서의 (비트명, 시작초, 길이초).

    ★«궁금하게» 만드는 한 줄을 찾아 그 위에 창을 얹는다 (소유주 지시 2026-09-22).
      비트의 끝을 기계적으로 자르면 대화 중간 토막이 걸린다 — 실측: 헐크 편에서
      "따라와요." 한 줄만 나와 후킹이 되지 않았다.
      그래서 비트 안의 자막 중 **의문문**을 먼저 고른다. 질문은 답을 기다리게 만든다.
      없으면 가장 긴 자막(정보량이 큰 줄)으로 내려간다.
    """
    payload = load(os.path.join(workdir, 'next_payload.json'))
    rinbox = payload.get('rinbox') or {}
    edit = payload.get('rinbox_edit') or {}
    beats = ((edit.get('editorial') or {}).get('beats')) or []
    if not beats:
        raise SystemExit('편집표에 editorial.beats 가 없다 — 어느 구간이 고조인지 알 수 없다')

    timeline_path = rinbox.get('timeline_path')
    if not timeline_path or not os.path.exists(timeline_path):
        raise SystemExit('timeline.json 을 찾지 못했다')
    clips = load(timeline_path).get('clips') or []

    # 고조 → 반전 → 도입. payoff 는 쓰지 않는다 — 결말 대사가 미리 노출된다.
    picked = None
    for want in [beat_name, 'escalation', 'reversal', 'setup']:
        picked = next((b for b in beats if b.get('role') == want), None)
        if picked:
            break
    if not picked:
        raise SystemExit('쓸 수 있는 비트가 없다')

    idxs = [i for i in (picked.get('sequence_indices') or []) if 0 <= i < len(clips)]
    if not idxs:
        raise SystemExit(f"비트 {picked.get('role')} 의 sequence_indices 가 타임라인과 맞지 않는다")

    first = clips[min(idxs)]
    last = clips[max(idxs)]
    floor = float(first['timeline_in'])
    beat_end = float(last['timeline_in']) + float(last['duration'])

    # 비트 안의 모든 자막을 «완성본 절대 시각»으로 펼친다
    lines = []
    for i in idxs:
        clip = clips[i]
        base = float(clip['timeline_in'])
        for cap in (clip.get('captions') or []):
            try:
                a, b, text = float(cap[0]), float(cap[1]), str(cap[2])
            except (TypeError, ValueError, IndexError):
                continue
            lines.append((base + a, base + b, text, i))

    lines.sort(key=lambda x: x[0])

    def gap_after(i):
        """이 자막이 끝나고 다음 자막이 시작할 때까지의 «빈 시간»."""
        if i + 1 < len(lines):
            return max(0.0, lines[i + 1][0] - lines[i][1])
        return max(0.0, beat_end - lines[i][1])

    def score(i):
        _, _, text, clip_index = lines[i]
        value = 0.01 * len(text)
        if text.rstrip().endswith('?') or text.rstrip().endswith('까') or '뭐라고' in text:
            value += 3.0
        # ★원본이 이미 쉬어 주는 자리를 고른다 (소유주 지적: 정지 프레임이 이상하다).
        #   뒤에 빈 시간이 있으면 «맺음»이 실제 영상으로 생긴다 — 얼려 붙일 필요가 없다.
        value += min(gap_after(i), 1.5) * 1.2
        value += 0.02 * idxs.index(clip_index)
        return value

    if lines:
        pos = max(range(len(lines)), key=score)
        start_at, end_at, text, _ = lines[pos]

        # ★«후킹과 맺음»이 다 들어가야 한다 (소유주 지적 2026-09-22: "조금 급한 감이 느껴져").
        #   ① 앞: 바로 앞 자막(받쳐 주는 말)부터 시작한다. 없으면 1.2초 앞에서.
        lead = lines[pos - 1][0] if pos > 0 else start_at - 1.2
        start = max(floor, min(lead, start_at - 0.4))

        # ② 뒤: ★다음 자막이 시작되기 «전»에 끊는다. 안 그러면 질문의 답이 하이라이트 안에서
        #    나와 버려 궁금할 이유가 사라진다(실측: "방금 뭐라고 했어요?" 뒤로 "그들은 못
        #    받았어요"가 따라 들어왔다).
        next_at = lines[pos + 1][0] if pos + 1 < len(lines) else beat_end
        # 다음 자막 직전까지, 최대 tail 만큼 «실제 영상»으로 여운을 둔다.
        core_end = min(end_at + tail, max(end_at + 0.05, next_at - 0.08))
        seconds = max(1.6, core_end - start)
        held = core_end - end_at
        note = f'"{text}" (앞 받침 + 여운 {held:.1f}s 슬로우)'
    else:
        start = beat_end - 0.5 - seconds
        note = '(자막 없음 — 비트 끝)'

    start = max(floor, min(start, beat_end - seconds))
    start = round(start * FPS) / FPS
    return picked.get('role'), start, seconds, note, max(0.0, held if lines else 0.0)


def main():
    argv = sys.argv[1:]
    if len(argv) < 3:
        raise SystemExit('사용법: hook_prepend.py <workdir> <final.mp4> <out.mp4> '
                         '[--seconds 2.2] [--beat escalation] [--fade 0.35] [--tail 0.9] [--slow 0.55] [--at <초>]')
    workdir, src, out = argv[0], argv[1], argv[2]

    def opt(name, default):
        return argv[argv.index(name) + 1] if name in argv else default

    seconds = float(opt('--seconds', '2.2'))
    fade = float(opt('--fade', '0.35'))
    beat = opt('--beat', 'escalation')
    tail = float(opt('--tail', '0.9'))   # 질문이 끝난 뒤 물고 있는 시간 = 맺음
    slow = float(opt('--slow', '0.55'))  # 여운 구간 재생 속도 (0.55 = 약 1.8배 길어짐)

    if '--at' in argv:
        role, start, length, note, tail_raw = 'manual', float(opt('--at', '0')), seconds, '(수동 지정)', 0.0
    else:
        role, start, length, note, tail_raw = beat_window(workdir, beat, seconds, tail)
    tmp_dir = os.path.dirname(os.path.abspath(out)) or '.'
    hook = os.path.join(tmp_dir, '_hook.mp4')
    body = os.path.join(tmp_dir, '_body.mp4')
    joined = os.path.join(tmp_dir, '_joined.mp4')
    listfile = os.path.join(tmp_dir, '_hook_concat.txt')

    enc = ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
           '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000']

    # ① 하이라이트 = «질문까지 정속» + «여운은 슬로우».
    #    ★정지 프레임은 쓰지 않는다(소유주 지적: "정지프레임 좀 이상한데"). 얼리면 끊긴 것처럼 보인다.
    #    소유주 제안대로 여운 구간만 느리게 돌린다 — 움직임이 남아 있어 멈춘 것처럼 보이지 않고,
    #    시간은 늘어나 맺음이 생긴다. 느려진 목소리는 어색하므로 소리는 그 구간에서 내린다.
    core = max(0.1, length - tail_raw)
    hook_a = os.path.join(tmp_dir, '_hook_a.mp4')
    hook_b = os.path.join(tmp_dir, '_hook_b.mp4')
    run(['ffmpeg', '-v', 'error', '-ss', f'{start:.6f}', '-t', f'{core:.6f}', '-i', src,
         *enc, '-y', hook_a])
    if tail_raw >= 0.15:
        run(['ffmpeg', '-v', 'error', '-ss', f'{start + core:.6f}', '-t', f'{tail_raw:.6f}', '-i', src,
             '-vf', f'setpts={1.0 / slow:.4f}*PTS',
             '-af', (f'atempo={max(0.5, slow):.4f},'
                     f'afade=t=out:st=0:d={min(fade, tail_raw / slow):.3f}'),
             *enc, '-y', hook_b])
        with open(listfile, 'w', encoding='utf-8') as fh:
            fh.write("file '" + os.path.basename(hook_a) + "'\n")
            fh.write("file '" + os.path.basename(hook_b) + "'\n")
        run(['ffmpeg', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listfile,
             *enc, '-y', hook])
    else:
        os.replace(hook_a, hook)
    for path in (hook_a, hook_b):
        try:
            os.remove(path)
        except OSError:
            pass
    # ② 본편 — 머리에 페이드인
    run(['ffmpeg', '-v', 'error', '-i', src,
         '-af', f'afade=t=in:st=0:d={fade:.3f}',
         *enc, '-y', body])
    # ③ 이어 붙이기. ★반드시 재인코딩 — -c copy 는 타임스탬프가 어긋난다(사례 67)
    with open(listfile, 'w', encoding='utf-8') as fh:
        fh.write(f"file '{os.path.basename(hook)}'\nfile '{os.path.basename(body)}'\n")
    run(['ffmpeg', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listfile,
         *enc, '-movflags', '+faststart', '-y', joined])
    # ④ 라우드니스 재정렬 (이어 붙이며 흐트러진다)
    run(['ffmpeg', '-v', 'error', '-i', joined,
         '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
         '-movflags', '+faststart', '-y', out])

    for path in (hook, body, joined, listfile):
        try:
            os.remove(path)
        except OSError:
            pass

    print(f'[hook] {role} 비트 {start:.2f}~{start + length:.2f}초 → 맨 앞 '
          f'· 고른 줄 {note} · 페이드 {fade}s → {out}')


if __name__ == '__main__':
    main()
