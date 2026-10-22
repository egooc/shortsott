"""1시간 정치 롱폼 조립기: 해설 화면(모션그래픽+TTS+자막)과 인용 장면(당겨 잡기+오버레이+원음)을 번갈아 잇는다.

    python assemble_hour.py <episode.json> [--tts google|typecast]

episode.json
{
  "workdir": "D:/volcano-runs/hour-20261013",
  "segments": [
    {"type": "nar", "text": "해설 문장...", "visual": {"type": "facts", "title": "...", "items": [...]},
     "bg": {"src": "D:/.../clip.mp4", "start": 30}, "source": "출처: ..."},
    {"type": "quote", "src": "D:/.../clip.mp4", "in": 56.6, "out": 84.4, "speaker": "이진숙",
     "role": "국민의힘 의원", "color": "#E61E2B", "tag": "과방위 국감 · 10.12",
     "phrases": ["...", "..."], "source": "영상: 국회방송 2026.10.12"}
  ]
}
세그먼트마다 결과를 workdir/seg/<번호>-<지문>.mp4 로 남겨 두고, 입력이 같으면 다시 만들지 않는다.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import narration_overlay  # noqa: E402
import quote_overlay  # noqa: E402
import cold_overlay  # noqa: E402
import tts  # noqa: E402

from config import PYTHON as VISION_PY
PAD = .35  # 해설 음성 뒤 숨
CODE = '2026-10-13c'  # 템플릿을 고치면 올려서 저장된 조각을 다시 만든다


def key(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def overlay(builder, spec, out):
    work = out.with_suffix('.hf')
    work.mkdir(parents=True, exist_ok=True)
    builder.build(spec, work)
    quote_overlay.render(work, out)


def narration(seg, folder, provider, chrome):
    wav = folder / 'voice.wav'
    if seg.get('audio'):
        import shutil
        shutil.copy2(Path(path_base) / seg['audio'], wav); cues = seg['captions']
    else:
        say = None
        if seg.get('tts_say'):   # episode.json "tts_say": true — TTS 입력만 숫자를 한글 읽기로(10/20편부터), 자막은 숫자 그대로
            sys.path.insert(0, 'D:/midform/ko-corp/render')
            from ko_say import say
            keep = seg.get('tts_keep') or []   # 한글 읽기로 오히려 틀리는 표기는 원문대로 둔다(10/19 «십삼 점 삼»이 «133»으로 들림)
            if keep:
                raw_say = say
                def say(s, _k=keep):
                    marks = {f'§{chr(65 + n)}§': w for n, w in enumerate(_k)}   # 숫자 없는 표시(say 가 안 건드린다)
                    for m, w in marks.items():
                        s = s.replace(w, m)
                    s = raw_say(s)
                    for m, w in marks.items():
                        s = s.replace(m, w)
                    return s
        if seg.get('tts_yomi'):   # TTS 입력만 읽기로 바꾼다, 자막은 원문 표기
            base_say = say
            def say(s, _y=seg['tts_yomi'], _b=base_say):
                for w in sorted(_y, key=len, reverse=True):
                    s = s.replace(w, _y[w])
                return _b(s) if _b else s
        _, cues = tts.speak(provider, seg['text'], str(wav), say=say)
    dur = round(tts.wav_seconds(wav) + PAD, 3)
    spec = dict(chrome, **seg['visual'], duration=dur, captions=cues, issue_tag=seg.get('issue_tag', ''), followup=seg.get('followup', False))
    if seg.get('source'):
        spec['source'] = seg['source']
    mov = folder / 'overlay.mov'
    overlay(narration_overlay, spec, mov)
    out = folder / 'segment.mp4'
    narration_overlay.compose(seg['bg']['src'], seg['bg'].get('start', 0), dur, mov, out, audio=wav, spec=spec)
    return out


def quote(seg, folder, chrome):
    side = json.loads(subprocess.run([VISION_PY, str(HERE / 'person_side.py'), seg['src'], str(seg['in']), str(seg['out'])],
                                     capture_output=True, text=True, check=True).stdout)
    spec = dict(chrome, **{k: seg[k] for k in ('speaker', 'role', 'color', 'tag', 'phrases', 'source', 'issue_tag', 'followup') if k in seg})
    spec.update(side=side['side'], person=side['person'], duration=round(seg['out'] - seg['in'], 3))
    mov = folder / 'overlay.mov'
    overlay(quote_overlay, spec, mov)
    out = folder / 'segment.mp4'
    quote_overlay.compose(seg['src'], seg['in'], spec, mov, out)
    return out


def cold(seg, folder):
    """첫머리: 썸네일 대사 장면을 이름표 없이 큰 자막으로(cold_overlay.py)."""
    d = round(seg['out'] - seg['in'], 3)   # 말이 끝나면 마지막 장면을 멈추고 전환 효과음(휘익→쾅)을 친 뒤 인트로로(10-15 소유주)
    spec = {'words': seg['words'], 'source': seg.get('source', ''), 'duration': round(d + cold_overlay.TAIL, 3), 'speech': d}
    mov = folder / 'overlay.mov'
    overlay(cold_overlay, spec, mov)
    out = folder / 'segment.mp4'
    cold_overlay.compose(seg['src'], seg['in'], spec, mov, out)
    return out


def normalize(src, out):
    """모든 조각을 같은 규격(1920x1080·30fps·SAR1·AAC 48k 스테레오)으로 맞춰 이어 붙일 수 있게 한다."""
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(src), '-vf', 'fps=30,scale=1920:1080,setsar=1',
                    '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                    '-af', 'aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11', '-ac', '2', '-c:a', 'aac', '-b:a', '160k',
                    str(out)], check=True)


def main(path, provider):
    global path_base
    path_base = Path(path).resolve().parent
    ep = json.loads(Path(path).read_text(encoding='utf-8'))
    work = (path_base / ep['workdir']).resolve(); (work / 'seg').mkdir(parents=True, exist_ok=True)
    parts, clock = [], 0.0
    for i, seg in enumerate(ep['segments']):
        voice = tts.voice_id(provider) if seg['type'] == 'nar' and not seg.get('audio') else None  # 목소리를 바꾸면 해설만 다시 만든다
        if seg['type'] == 'nar' and ep.get('tts_say'):
            seg = dict(seg, tts_say=True)   # 키에도 들어가 켜고 끄면 해설만 다시 만든다(끈 편의 저장본은 그대로)
        yomi = {w: r for w, r in (ep.get('tts_yomi') or {}).items() if seg['type'] == 'nar' and w in seg.get('text', '')}
        if yomi:   # episode.json "tts_yomi": {표기: 읽기} — 그 낱말이 든 해설만 키가 바뀐다(10-22 «추미애»→«추미의» 들림). 조각 하나만이면 그 조각에 "tts_yomi"
            seg = dict(seg, tts_yomi={**yomi, **(seg.get('tts_yomi') or {})})
        folder = work / 'seg' / f'{i:03d}-{seg["type"]}-{key([seg, provider, ep.get("chrome", {}), CODE] + ([voice] if voice else []))}'
        final = folder / 'normalized.mp4'
        if not final.exists():
            folder.mkdir(parents=True, exist_ok=True)
            chrome = dict(ep.get('chrome', {}), ticker_at=clock)
            seg = dict(seg, src=str((path_base / seg['src']).resolve())) if seg.get('src') else seg
            if seg.get('bg'):
                seg = dict(seg, bg=dict(seg['bg'], src=str((path_base / seg['bg']['src']).resolve())))
            raw = (narration(seg, folder, provider, chrome) if seg['type'] == 'nar' else
                   cold(seg, folder) if seg['type'] == 'cold' else quote(seg, folder, chrome))
            normalize(raw, final)
            # 합친 뒤에는 큰 중간 파일(투명 MOV·하이퍼프레임 작업 폴더·합성 전 영상)을 지운다. normalized.mp4 만 남긴다.
            import shutil
            for junk in [folder / 'overlay.mov', raw, folder / 'grid.png', folder / 'streak.png', folder / 'ticker.txt']:
                Path(junk).unlink(missing_ok=True)
            shutil.rmtree(folder / 'overlay.hf', ignore_errors=True)
        parts.append(final)
        clock += float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(final)],
                                      capture_output=True, text=True).stdout)
        print(f'[{i + 1}/{len(ep["segments"])}] {seg["type"]} {final}', flush=True)
    lst = work / 'concat.txt'
    lst.write_text(''.join(f"file '{p.as_posix()}'\n" for p in parts), encoding='utf-8')
    out = work / 'episode.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst),
                    '-c', 'copy', '-movflags', '+faststart', str(out)], check=True)
    dur = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(out)],
                         capture_output=True, text=True).stdout.strip()
    print(json.dumps({'episode': str(out), 'seconds': float(dur), 'segments': len(parts)}, ensure_ascii=False))


if __name__ == '__main__':
    provider = sys.argv[sys.argv.index('--tts') + 1] if '--tts' in sys.argv else 'google'  # none = 미리 만든 음성만
    main(sys.argv[1], provider)
