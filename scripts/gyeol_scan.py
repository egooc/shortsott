# -*- coding: utf-8 -*-
"""결 분석 1단계(실측): 터진 편의 «많이 다시 본 구간»·댓글·정점 프레임을 한 번에 뽑는다.

쓰는 법:
  python -I scripts/gyeol_scan.py OUT_DIR VIDEO_ID [VIDEO_ID ...] [--no-frames]

하는 일(편마다, API 0원 · yt-dlp만):
  1) yt-dlp -j --write-comments(좋아요순 300개) → heatmap(100구간)·타임스탬프 댓글·좋아요 상위 댓글
  2) 정점 5개(처음 3% 제외 국소 최대) · 꺼지는 곳 3개(앞 3구간 최대 대비 하락폭)
  3) 정점 4개·꺼짐 2개 지점마다 -6~+15초 3초 간격 프레임 8칸 → OUT_DIR/pk/<id>.jpg
결과: OUT_DIR/scan.json, OUT_DIR/scan.md (사람이 읽는 요약)
주의: heatmap 은 «다시 본 상대값»이다. 실제 이탈률이 아니다. 꺼짐 = 건너뛰거나 다시 안 보는 구간으로만 읽는다.
다음 단계(장면 대사 판독·궁금증 고리)는 docs/gyeol-analysis-20261027.md §0 절차를 따른다.
"""
import json, os, re, subprocess, sys

TS = re.compile(r'\b\d{1,2}:\d{2}\b')


def ytdlp_json(vid, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return json.load(open(path, encoding='utf-8'))
    r = subprocess.run(['yt-dlp', '-q', '--skip-download', '--write-comments',
                        '--extractor-args', 'youtube:comment_sort=top;max_comments=300,all,0',
                        '-j', f'https://www.youtube.com/watch?v={vid}'],
                       capture_output=True)
    out = r.stdout.decode('utf-8', 'replace').strip()
    if not out:
        return None
    open(path, 'w', encoding='utf-8').write(out)  # 호출마다 저장
    return json.loads(out)


def analyse(d):
    hm = d.get('heatmap') or []
    dur = d.get('duration') or 0
    vals = [h['value'] for h in hm]
    pk = []
    for k in range(1, len(hm) - 1):
        if vals[k] >= vals[k - 1] and vals[k] >= vals[k + 1] and hm[k]['start_time'] > dur * 0.03:
            pk.append((round(vals[k], 3), round(hm[k]['start_time'])))
    pk = sorted(pk, reverse=True)[:5]
    dips = []
    for k in range(3, len(hm) - 2):
        dips.append((round(max(vals[k - 3:k]) - vals[k], 3), round(hm[k]['start_time'])))
    dips = sorted(dips, reverse=True)[:3]
    cm = d.get('comments') or []
    ts = [c for c in cm if TS.search(c.get('text', ''))]
    top = sorted([c for c in cm if c.get('parent') == 'root'], key=lambda c: -(c.get('like_count') or 0))[:15]
    return dict(title=d.get('title'), views=d.get('view_count'), likes=d.get('like_count'), dur=dur,
                hm=[(round(h['start_time']), round(h['value'], 3)) for h in hm], peaks=pk, dips=dips,
                ts=[(c.get('like_count'), c['text'][:200]) for c in ts][:30],
                top=[(c.get('like_count'), c['text'][:200]) for c in top])


def frames(vid, pts, out):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return
    url = subprocess.run(['yt-dlp', '-g', '-f', 'bv*[height<=360]/b', f'https://www.youtube.com/watch?v={vid}'],
                         capture_output=True).stdout.decode().strip().splitlines()
    if not url:
        return
    w, h = 320, 180
    font = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 18)
    im = Image.new('RGB', (w * 8, h * len(pts)), 'black')
    dr = ImageDraw.Draw(im)
    tmp = os.path.join(out, '_f.jpg')
    for r, (kind, t) in enumerate(pts):
        for k in range(8):
            s = max(0, t - 6 + k * 3)
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-ss', str(s), '-i', url[0], '-frames:v', '1',
                            '-vf', 'scale=320:180', '-y', tmp])
            if os.path.exists(tmp):
                im.paste(Image.open(tmp), (k * w, r * h))
                os.remove(tmp)
            dr.rectangle([k * w, r * h, k * w + 130, r * h + 22], fill='black')
            dr.text((k * w + 3, r * h), f'{kind}{t} {s // 60}:{s % 60:02d}', fill='yellow' if kind == 'P' else 'cyan', font=font)
    im.save(os.path.join(out, 'pk', f'{vid}.jpg'), quality=80)


def main():
    a = [x for x in sys.argv[1:] if not x.startswith('--')]
    no_frames = '--no-frames' in sys.argv
    out, ids = a[0], a[1:]
    for sub in ('j', 'pk'):
        os.makedirs(os.path.join(out, sub), exist_ok=True)
    res_path = os.path.join(out, 'scan.json')
    res = json.load(open(res_path, encoding='utf-8')) if os.path.exists(res_path) else {}
    for vid in ids:
        d = ytdlp_json(vid, os.path.join(out, 'j', f'{vid}.json'))
        if not d:
            print(vid, 'fail'); continue
        res[vid] = analyse(d)
        json.dump(res, open(res_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        v = res[vid]
        print(vid, v['dur'], 'peaks', [(p[1], p[0]) for p in v['peaks']], 'dips', [(x[1], x[0]) for x in v['dips']])
        if not no_frames and v['peaks']:
            frames(vid, [('P', p[1]) for p in v['peaks'][:4]] + [('D', x[1]) for x in v['dips'][:2]], out)
    md = ['# 결 분석 실측 요약', '']
    for vid, v in res.items():
        md += [f'## {v["title"]} ({vid})', f'- 조회 {v["views"]:,} · 길이 {v["dur"]}초',
               '- 정점(초:상대값): ' + ', '.join(f'{p[1]}:{p[0]}' for p in v['peaks']),
               '- 꺼짐(초:하락폭): ' + ', '.join(f'{x[1]}:{x[0]}' for x in v['dips']),
               '- 타임스탬프 댓글: ' + ' / '.join(f'({l}) {t[:60]}' for l, t in v['ts'][:8]),
               '- 좋아요 상위: ' + ' / '.join(f'({l}) {t[:60]}' for l, t in v['top'][:6]), '']
    open(os.path.join(out, 'scan.md'), 'w', encoding='utf-8').write('\n'.join(md).replace('\r', ''))


if __name__ == '__main__':
    main()
