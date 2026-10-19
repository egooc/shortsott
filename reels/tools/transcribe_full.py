# 릴스·편집 전사 — rinbox_transcribe 의 submit/wait 를 그대로 쓰고, 구두점까지 든 json-v2 원본을 함께 남긴다.
#
#   python reels/tools/transcribe_full.py <원본.mp4> <출력폴더> [--lang ko]
#
# 산출: transcript.json([[start,end,word],...] 린박스 형식) + transcript_v2.json(Speechmatics 원본, 구두점 포함)
import argparse, json, subprocess, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import rinbox_transcribe as rt  # noqa: E402

sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('outdir')
    ap.add_argument('--lang', default='ko', choices=sorted(rt.LANG))
    a = ap.parse_args()
    out = Path(a.outdir); out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        audio = Path(td) / 'a.flac'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', a.src, '-vn', '-ac', '1', '-ar', '16000', str(audio)], check=True)
        print('  음성 %.1fMB 보냄 (%s)' % (audio.stat().st_size / 1e6, a.lang))
        job = rt.submit(audio, a.lang)
    print('  작업', job, '— 기다리는 중')
    (out / 'job.txt').write_text(job + '\n', encoding='utf-8')
    rt.wait(job)
    tr = json.loads(rt.req('%s/%s/transcript?format=json-v2' % (rt.API, job)))
    (out / 'transcript_v2.json').write_text(json.dumps(tr, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    ws = rt.words(tr, 0.0)
    (out / 'transcript.json').write_text(json.dumps(ws, ensure_ascii=False) + '\n', encoding='utf-8')
    print('  낱말 %d개 → %s' % (len(ws), out))


if __name__ == '__main__':
    main()
