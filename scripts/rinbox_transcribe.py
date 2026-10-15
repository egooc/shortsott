# 린박스 전사 — 볼케이노 없이 Speechmatics 를 직접 불러 transcript.json 을 만든다.
#
#   python scripts/rinbox_transcribe.py <원본.mp4> <출력 transcript.json> --lang ja|ko [--from 600 --to 900]
#
# 왜 (2026-10-08 자립): 지금까지 transcript.json 은 볼케이노가 만들어 둔 걸 재사용했다. 새 작품은 그게 없으니
# 직접 받아써야 한다. 키·제공자는 볼케이노가 쓰던 것과 같다(~/.volcano/keys/speechmatics · 같은 계정 청구).
#
# 형식은 볼케이노 transcript.json 과 같다: [[start, end, text], ...] — 낱말(일본어는 형태소)만, 구두점은 뺀다.
# `--from/--to` 를 주면 그 구간만 떼어 보내고(돈을 아낀다) 시각은 원본 기준으로 되돌려 적는다.
import argparse, json, subprocess, sys, tempfile, time, urllib.request, uuid
from pathlib import Path

# cp949 콘솔에서 한국어 진행 메시지를 찍다 죽으면 이미 낸 작업이 다시 청구된다(10/14 정치 편 중복 제출)
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

API = 'https://asr.api.speechmatics.com/v2/jobs'
LANG = {'ja': 'ja', 'ko': 'ko', 'en': 'en'}


def key():
    return (Path.home() / '.volcano' / 'keys' / 'speechmatics').read_bytes().decode('utf-8-sig').strip()


def req(url, data=None, headers=None, method=None):
    h = {'Authorization': 'Bearer ' + key()}
    h.update(headers or {})
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=300) as resp:
        return resp.read()


def submit(audio, lang):
    cfg = {'type': 'transcription',
           'transcription_config': {'language': LANG[lang], 'operating_point': 'enhanced'}}
    b = uuid.uuid4().hex
    body = b''.join([
        ('--%s\r\nContent-Disposition: form-data; name="config"\r\n\r\n' % b).encode(),
        json.dumps(cfg).encode(), b'\r\n',
        ('--%s\r\nContent-Disposition: form-data; name="data_file"; filename="%s"\r\n'
         'Content-Type: application/octet-stream\r\n\r\n' % (b, Path(audio).name)).encode(),
        Path(audio).read_bytes(), b'\r\n', ('--%s--\r\n' % b).encode()])
    j = json.loads(req(API + '/', body, {'Content-Type': 'multipart/form-data; boundary=' + b}, 'POST'))
    return j['id']


def wait(job, limit=1800):
    t0 = time.time()
    while time.time() - t0 < limit:
        st = json.loads(req('%s/%s' % (API, job)))['job']['status']
        if st == 'done':
            return
        if st in ('rejected', 'deleted', 'expired'):
            sys.exit('Speechmatics 작업 %s: %s' % (job, st))
        time.sleep(10)
    sys.exit('Speechmatics 작업이 %d초 안에 안 끝났다: %s' % (limit, job))


def words(tr, offset):
    out = []
    for x in tr.get('results') or []:
        if x.get('type') != 'word':
            continue
        w = ((x.get('alternatives') or [{}])[0].get('content') or '').strip()
        if w:
            out.append([round(float(x['start_time']) + offset, 2), round(float(x['end_time']) + offset, 2), w])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--lang', required=True, choices=sorted(LANG))
    ap.add_argument('--from', dest='t0', type=float, default=None)
    ap.add_argument('--to', dest='t1', type=float, default=None)
    a = ap.parse_args()
    off = a.t0 or 0.0
    with tempfile.TemporaryDirectory() as td:
        audio = Path(td) / 'a.flac'
        cut = (['-ss', '%.3f' % a.t0] if a.t0 is not None else []) + (['-to', '%.3f' % a.t1] if a.t1 is not None else [])
        # -ss 를 -i 앞에 두면 -to 는 «잘라낸 뒤 기준»이 되므로 길이로 바꿔 준다
        if a.t0 is not None and a.t1 is not None:
            cut = ['-ss', '%.3f' % a.t0, '-t', '%.3f' % (a.t1 - a.t0)]
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *cut, '-i', a.src, '-vn', '-ac', '1', '-ar', '16000', str(audio)],
                       check=True)
        mb = audio.stat().st_size / 1e6
        print('  음성 %.1fMB 보냄 (%s)' % (mb, a.lang))
        job = submit(audio, a.lang)
    print('  작업', job, '— 기다리는 중')
    wait(job)
    tr = json.loads(req('%s/%s/transcript?format=json-v2' % (API, job)))
    ws = words(tr, off)
    Path(a.out).write_text(json.dumps(ws, ensure_ascii=False) + '\n', encoding='utf-8')
    print('  낱말 %d개 → %s' % (len(ws), a.out))


if __name__ == '__main__':
    main()
