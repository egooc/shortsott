# -*- coding: utf-8 -*-
"""레퍼런스 롱폼 프레임 시트 — 기획 가이드(상위 2채널×12편) 7항목 분석용. 영상만 저화질로 받아 타임코드 박은 시트 2장을 만든다.

    python ja-nenkin/render/ref_sheet.py <영상id> [<영상id> ...] [--out reference/ja_nenkin/sheets]

- 받기: yt-dlp 영상 스트림만(240~360p, 소리·자막 요청 없음), 캐시 server/data/ref_sheet/<id>.mp4 (gitignore).
- 시트 A(<id>_open.jpg): 0~90초를 5초마다 18칸 — 콜드오픈 70초 규칙 대조용.
- 시트 B(<id>_body.jpg): 90초부터 끝까지 60초마다(최대 40칸) — 장 구조·화면 문법용.
- 요청 사이 3~5초 무작위로 쉰다. 429·403 이면 그 자리에서 멈춘다(재시도·우회 없음).
"""
import random
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'server' / 'data' / 'ref_sheet'
FONT = ROOT / 'ja-nenkin' / 'ep01' / 'thumb' / 'NotoSansJP.ttf'
CW, CH, COLS = 320, 180, 6


def fetch(vid):
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f'{vid}.mp4'
    if out.exists() and out.stat().st_size > 0:
        return out
    r = subprocess.run(['yt-dlp', '-q', '--no-warnings', '-f', 'bv*[height<=360][ext=mp4]/bv*[height<=360]/wv*',
                        '--no-write-subs', '--no-playlist', '-o', str(out), f'https://www.youtube.com/watch?v={vid}'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode or not out.exists():
        msg = (r.stderr or '')[-300:]
        if '429' in msg or '403' in msg:
            raise SystemExit(f'중단 — {vid}: {msg.strip()}')
        print(f'✗ {vid}: {msg.strip()}')
        return None
    return out


def duration(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout or 0)


def frame(p, t):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(p), '-frames:v', '1', '-vf', f'scale={CW}:{CH}',
                        '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True)
    if not r.stdout:
        return None
    from io import BytesIO
    return Image.open(BytesIO(r.stdout)).convert('RGB')


def sheet(p, times, out, title):
    rows = (len(times) + COLS - 1) // COLS
    img = Image.new('RGB', (COLS * CW, rows * (CH + 26) + 40), 'white')
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(str(FONT), 20)
    d.text((8, 6), title, fill='black', font=f)
    for k, t in enumerate(times):
        x, y = (k % COLS) * CW, 40 + (k // COLS) * (CH + 26)
        fr = frame(p, t)
        if fr:
            img.paste(fr, (x, y))
        d.text((x + 6, y + CH + 2), f'{int(t // 60):02d}:{int(t % 60):02d}', fill='red', font=f)
    img.save(out, quality=85)


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    outdir = Path(argv[argv.index('--out') + 1]) if '--out' in argv else ROOT / 'reference' / 'ja_nenkin' / 'sheets'
    ids = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] != '--out')]
    outdir.mkdir(parents=True, exist_ok=True)
    for n, vid in enumerate(ids):
        if (outdir / f'{vid}_body.jpg').exists():
            print(f'= {vid} 있음')
            continue
        if n:
            time.sleep(random.uniform(3, 5))
        p = fetch(vid)
        if not p:
            continue
        dur = duration(p)
        sheet(p, [t for t in range(0, 90, 5) if t < dur], outdir / f'{vid}_open.jpg', f'{vid} 0~90초 (5초 간격)')
        body = [t for t in range(90, int(dur), 60)]
        if len(body) > 40:
            body = body[::(len(body) + 39) // 40]
        sheet(p, body, outdir / f'{vid}_body.jpg', f'{vid} 90초~끝 (60초 간격) · 전체 {int(dur // 60)}분')
        print(f'✓ {vid} {int(dur // 60)}분')
    return 0


if __name__ == '__main__':
    sys.exit(main())
