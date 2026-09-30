# 어느 플랫폼 영상이든 한 폴더로 받아 H.264 로 맞추고 출처 json 을 남긴다. 쇼핑 소스 섞기용.
#
#   python scripts/social_grab.py --out <footage 폴더> <URL|파일> [...]
#
# 판별
#   douyin.com / v.douyin.com      → scripts/douyin-grab.js (실제 크롬, 1080p H.264)
#   tiktok.com                     → yt-dlp (IP 차단 편은 건너뜀). HEVC 로 오니 H.264 로 바꾼다
#   xiaohongshu.com / xhslink.com  → 노트 HTML 을 curl 로만 받아 __INITIAL_STATE__ 의 masterUrl (브라우저는 막힌다, 비로그인 720p)
#   kuaishou.com / chenzhongtech   → 아이폰 UA 로 모바일 페이지를 받아 mainMvUrls
#   로컬 파일                       → 그대로 복사
# 결과: <out>/<접두>_<id>.mp4 + 같은 이름 .json (platform·url·author·desc·rights)
# 접두: dy_ tt_ xhs_ ks_ local_ — shot_picker·shop_pipeline 은 접두와 무관하게 폴더의 mp4 를 다 쓴다.
import argparse, json, os, re, shutil, subprocess, sys, urllib.parse
from pathlib import Path

MIDFORM = Path(__file__).resolve().parents[1]
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
UA_M = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')


def run(cmd, **kw):
    return subprocess.run([str(c) for c in cmd], **kw)


def probe(f):
    r = run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height',
             '-of', 'json', f], capture_output=True, text=True)
    s = json.loads(r.stdout or '{}').get('streams') or [{}]
    return s[0]


def to_h264(src, dst):
    """HEVC·VP9·AV1 은 편집기에서 오프라인이 된다(인수인계 §7-3). H.264 면 그대로 둔다."""
    if probe(src).get('codec_name') == 'h264':
        if Path(src) != Path(dst):
            shutil.move(src, dst)
        return
    r = run(['ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'libx264', '-preset', 'medium', '-crf', 18,
             '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst])
    if r.returncode:
        raise RuntimeError('H.264 변환 실패')
    os.remove(src)


def write_meta(out, stem, **meta):
    meta.setdefault('rights', {'basis': 'credit_only', 'statement': '공개 게시물. 출처 표기 기준(소유주 결정 2026-09-19).'})
    Path(out, stem + '.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def grab_tiktok(url, out):
    tmp = Path(out, '_tt_%(id)s.%(ext)s')
    r = run(['yt-dlp', '-q', '--no-warnings', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '--write-info-json',
             '-o', tmp, url], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1][:200])
    info_f = sorted(Path(out).glob('_tt_*.info.json'), key=os.path.getmtime)[-1]
    info = json.loads(info_f.read_text(encoding='utf-8'))
    vid = info['id']
    got = [f for f in Path(out).glob(f'_tt_{vid}.*') if f.suffix != '.json']
    info_f.unlink()
    vids = [f for f in got if probe(f).get('codec_name')]
    if not vids:                                   # 사진 슬라이드 게시물은 음악(mp3)만 내려온다
        for f in got:
            f.unlink()
        raise RuntimeError('영상이 아닌 게시물(사진 슬라이드)')
    to_h264(str(vids[0]), str(Path(out, f'tt_{vid}.mp4')))
    write_meta(out, f'tt_{vid}', platform='tiktok', id=vid, url=info.get('webpage_url', url),
               author=info.get('uploader'), desc=(info.get('description') or '')[:300], views=info.get('view_count'))
    return f'tt_{vid}.mp4'


def http(url, ua, referer=None):
    cmd = ['curl', '-sL', '--compressed', '-A', ua]
    if referer:
        cmd += ['-e', referer]
    r = run(cmd + [url], capture_output=True)
    return r.stdout.decode('utf-8', 'replace')


def download(url, dst, referer):
    r = run(['curl', '-sL', '--fail', '-A', UA, '-e', referer, '-o', dst, url])
    if r.returncode or not Path(dst).exists() or Path(dst).stat().st_size < 100000:
        raise RuntimeError('영상 받기 실패(주소 만료·차단)')


def grab_xhs(url, out):
    html = http(url, UA)
    m = re.search(r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>', html, re.S)
    if not m:
        raise RuntimeError('노트 정보 없음 — 보안 제한·지역 차단·삭제 확인')
    state = json.loads(re.sub(r'\bundefined\b', 'null', m.group(1)))
    notes = (state.get('note') or {}).get('noteDetailMap') or {}
    for nid, v in notes.items():
        note = (v or {}).get('note') or {}
        stream = (((note.get('video') or {}).get('media') or {}).get('stream') or {})
        cands = [(s.get('width', 0) * s.get('height', 0), s.get('masterUrl'), c) for c in ('h264', 'h265')
                 for s in (stream.get(c) or []) if s.get('masterUrl')]
        if not cands:
            continue
        cands.sort(key=lambda x: (x[2] == 'h264', x[0]), reverse=True)
        tmp = Path(out, f'_xhs_{nid}.mp4')
        download(cands[0][1], tmp, 'https://www.xiaohongshu.com/')
        to_h264(str(tmp), str(Path(out, f'xhs_{nid}.mp4')))
        write_meta(out, f'xhs_{nid}', platform='xiaohongshu', id=nid, url=url,
                   author=(note.get('user') or {}).get('nickname'), desc=(note.get('title') or note.get('desc') or '')[:300])
        return f'xhs_{nid}.mp4'
    raise RuntimeError('영상 노트가 아니다(이미지 노트이거나 볼 수 없음)')


def grab_kuaishou(url, out):
    m = re.search(r'(?:photo|short-video)/([0-9A-Za-z]+)', url)
    if not m:
        raise RuntimeError('콰이쇼우 영상 ID 를 못 찾았다')
    pid = m.group(1)
    html = http(f'https://v.m.chenzhongtech.com/fw/photo/{pid}', UA_M)
    mm = re.search(r'"mainMvUrls"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"([^"]+)"', html)
    if not mm:
        raise RuntimeError('mainMvUrls 없음 — 차단 확인')
    vurl = mm.group(1).encode().decode('unicode_escape')
    tmp = Path(out, f'_ks_{pid}.mp4')
    download(vurl, tmp, 'https://v.m.chenzhongtech.com/')
    to_h264(str(tmp), str(Path(out, f'ks_{pid}.mp4')))
    cap = re.search(r'"caption"\s*:\s*"([^"]*)"', html)
    write_meta(out, f'ks_{pid}', platform='kuaishou', id=pid, url=url, desc=cap.group(1)[:300] if cap else '')
    return f'ks_{pid}.mp4'


def grab_douyin(url, out):
    r = run(['node', MIDFORM / 'scripts' / 'douyin-grab.js', '--out', out, url], cwd=MIDFORM,
            capture_output=True, text=True, encoding='utf-8')
    line = [l for l in r.stdout.splitlines() if '✓' in l or '✗' in l]
    if r.returncode or not line or '✗' in line[-1]:
        raise RuntimeError(line[-1] if line else 'douyin-grab 실패')
    aid = re.search(r'(\d{15,})', line[-1]).group(1)
    meta = Path(out, f'dy_{aid}.json')
    d = json.loads(meta.read_text(encoding='utf-8'))
    d['platform'] = 'douyin'
    meta.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return f'dy_{aid}.mp4'


def grab_direct(url, out):
    host = urllib.parse.urlparse(url).netloc
    plat = 'xiaohongshu' if 'xhscdn' in host else ('kuaishou' if 'kwai' in host or 'yximgs' in host else 'direct')
    ref = {'xiaohongshu': 'https://www.xiaohongshu.com/', 'kuaishou': 'https://www.kuaishou.com/'}.get(plat, url)
    vid = re.sub(r'[^0-9A-Za-z]+', '', Path(urllib.parse.urlparse(url).path).stem)[-24:]
    pre = {'xiaohongshu': 'xhs', 'kuaishou': 'ks'}.get(plat, 'url')
    tmp = Path(out, f'_{pre}_{vid}.mp4')
    download(url, tmp, ref)
    to_h264(str(tmp), str(Path(out, f'{pre}_{vid}.mp4')))
    write_meta(out, f'{pre}_{vid}', platform=plat, id=vid, url=url, desc='')
    return f'{pre}_{vid}.mp4'


def grab_local(path, out):
    src = Path(path)
    stem = 'local_' + re.sub(r'[^0-9A-Za-z_-]+', '_', src.stem)[:40]
    tmp = Path(out, '_' + stem + src.suffix)
    shutil.copy(src, tmp)
    to_h264(str(tmp), str(Path(out, stem + '.mp4')))
    write_meta(out, stem, platform='local', id=src.stem, url=str(src), desc='')
    return stem + '.mp4'


def grab(target, out):
    host = urllib.parse.urlparse(target).netloc.lower() if '://' in target else ''
    if not host:
        return grab_local(target, out)
    if urllib.parse.urlparse(target).path.lower().endswith('.mp4'):   # 검색 API 가 준 CDN 직주소(샤오홍슈 등)
        return grab_direct(target, out)
    if 'douyin' in host:
        return grab_douyin(target, out)
    if 'tiktok' in host:
        return grab_tiktok(target, out)
    if 'xiaohongshu' in host or 'xhslink' in host:
        return grab_xhs(target, out)
    if 'kuaishou' in host or 'chenzhongtech' in host:
        return grab_kuaishou(target, out)
    raise RuntimeError(f'모르는 플랫폼: {host}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('targets', nargs='+')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fail = 0
    for t in a.targets:
        try:
            f = grab(t, a.out)
            s = probe(Path(a.out, f))
            print(f"  ✓ {f} {s.get('width')}x{s.get('height')} {s.get('codec_name')}")
        except Exception as e:
            fail += 1
            print(f'  ✗ {t[:80]} — {e}')
    sys.exit(1 if fail == len(a.targets) else 0)


if __name__ == '__main__':
    main()
