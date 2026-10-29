# -*- coding: utf-8 -*-
"""고양이 밈 편 결 비교본 — D:/volcano-runs/zunda_ko/compare_gyeol.py 와 같은 틀(gyeol_scan 기준: heatmap 100구간·정점 5·꺼짐 3, 첫 3% 제외).

    python -X utf8 ko-corp/cat/compare_gyeol.py ko-corp/cat01 0K3KNGhjdRU "인도 카레집 편"      → <편>/out/compare_gyeol.jpg

① 5초 간격 화면(원본 헤이루만 편 | 우리 episode.mp4)
② 헤이루만 터진 편 «많이 다시 본» 곡선(회색)·평균(검정), 가로 = 편 길이 % / 세로선 = 우리 결 지점(gyeol_table.md 의 초)
③ 편 전체 위치(%) — 원본 정점(●)·꺼짐(×) vs 우리 결 지점
맨 위 한 줄 = out/stats.json(배경·포즈·인물·같은 구도 연속 최대·같은 배경 최장)
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'D:/midform/scripts')
from gyeol_scan import analyse  # noqa: E402

FB = 'D:/midform/assets/fonts/rinbox/GmarketSansBold.otf'
FM = 'D:/midform/assets/fonts/rinbox/GmarketSansMedium.otf'
f = lambda s, b=True: ImageFont.truetype(FB if b else FM, s)
HM = json.load(open('D:/midform/reference/gyeol/hm.json', encoding='utf-8'))
REFS = {k: v for k, v in HM.items() if v.get('g') == 'heiru' and v.get('hm')}
COLS = {'큰 질문': (230, 60, 60), '정점': (20, 160, 80), '들뜬 선언': (40, 140, 220), '반전': (30, 80, 200),
        '속마음': (200, 40, 160), '전환 카드': (120, 120, 130), '마지막 한 줄': (230, 120, 20)}


def frames(src, out, dur):
    out.mkdir(parents=True, exist_ok=True)
    for s in range(0, int(dur) + 1, 5):
        p = out / f'{s:03d}.jpg'
        if not p.exists():
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-ss', str(s), '-i', str(src), '-frames:v', '1',
                            '-vf', 'scale=256:144,format=yuvj420p', str(p)])


def dur_of(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout.strip())


def kind(g):
    for k in COLS:
        if k in g:
            return k
    return '반전' if '반전' in g else None


def main():
    ep = Path(sys.argv[1]).resolve()
    rid = sys.argv[2]
    ours_mp4, ref_mp4 = ep / 'out' / 'episode.mp4', ep / 'ref' / f'{rid}.mp4'
    OD, RD = dur_of(ours_mp4), dur_of(ref_mp4)
    frames(ours_mp4, ep / 'out' / 'cmp' / 'ours', OD)
    frames(ref_mp4, ep / 'out' / 'cmp' / 'ref', RD)
    st = json.loads((ep / 'out' / 'stats.json').read_text(encoding='utf-8'))
    EV = []
    for ln in (ep / 'gyeol_table.md').read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\|\s*([\d.]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|', ln)
        if m:
            EV.append((float(m[1]), m[2].strip(), m[3].strip()))

    WW, TW, TH, cols = 3200, 256, 144, 6
    secs = list(range(0, int(max(OD, RD)) + 1, 5))
    blk = (TW * 2 + 18, TH + 26)
    rows1 = (len(secs) + cols - 1) // cols
    G2H = 560
    G3H = 80 + 46 * (len(REFS) + 1)
    im = Image.new('RGB', (WW, 90 + rows1 * blk[1] + 60 + G2H + 120 + G3H + 40), 'white')
    d = ImageDraw.Draw(im)
    title = sys.argv[3] if len(sys.argv) > 3 else rid   # 한국어 이름(원제 일본어는 글꼴에 없음)
    d.text((30, 24), f'갈림길 경제 고양이 시범 {ep.name} v2 vs 원본 헤이루만 — 결 비교 (gyeol_scan 기준)', font=f(40), fill=(20, 20, 30))
    d.text((1650, 30), f"우리 {st['길이(초)']:.0f}초: 배경 {st['배경']}종 · 포즈 {st['포즈']}개 · 인물 {st['인물']}명 · 같은 구도 연속 최대 {st['구도 반복 최대']}컷 · 같은 배경 최장 {st['같은 배경 최장(초)']}초 · 화면 {st['화면']}개",
           font=f(26), fill=(20, 120, 60))
    y = 90
    for n, s in enumerate(secs):
        x0, y0 = (n % cols) * (blk[0] + 2) + 20, y + (n // cols) * blk[1]
        d.text((x0, y0), f'{s // 60}:{s % 60:02d}', font=f(18), fill=(220, 40, 40))
        for k, p in enumerate((ep / 'out' / 'cmp' / 'ref' / f'{s:03d}.jpg', ep / 'out' / 'cmp' / 'ours' / f'{s:03d}.jpg')):
            if p.exists():
                im.paste(Image.open(p).convert('RGB').resize((TW, TH)), (x0 + k * (TW + 4), y0 + 22))
    y += rows1 * blk[1] + 20
    d.text((30, y), f'① 위: 5초 간격 — 칸마다 왼쪽 원본({rid} {title[:30]}, {RD:.0f}초) · 오른쪽 우리({OD:.0f}초)', font=f(24, False), fill=(90, 90, 100))
    y += 40
    # ② 곡선(편 길이 %) + 우리 결 지점
    X0, Y0, GW, GH = 120, y + 40, WW - 200, G2H - 120
    d.text((30, y), f'② 헤이루만 {len(REFS)}편 «많이 다시 본» 상대값(회색)·평균(검정), 가로 = 편 길이 %, 첫 3% 제외 / 세로선 = 우리 결 지점(gyeol_table.md)', font=f(28), fill=(20, 20, 30))
    d.rectangle((X0, Y0, X0 + GW, Y0 + GH), outline=(180, 180, 190))
    for pct in range(0, 101, 10):
        xx = X0 + GW * pct / 100
        d.line((xx, Y0, xx, Y0 + GH), fill=(235, 235, 240))
        d.text((xx - 30, Y0 + GH + 6), f'{pct}% · {OD * pct / 100:.0f}s', font=f(18, False), fill=(90, 90, 100))
    acc = {}
    for v in REFS.values():
        pts = [(t / v['dur'] * 100, val) for t, val in v['hm'] if t > v['dur'] * 0.03]
        mx = max(val for _, val in pts) or 1
        d.line([(X0 + GW * p / 100, Y0 + GH - GH * val / mx) for p, val in pts], fill=(185, 185, 195), width=2)
        for p, val in pts:
            acc.setdefault(round(p / 4), []).append(val / mx)
    mean = sorted((k * 4, sum(a) / len(a)) for k, a in acc.items())
    d.line([(X0 + GW * min(p, 100) / 100, Y0 + GH - GH * m) for p, m in mean], fill=(20, 20, 30), width=5)
    d.rectangle((X0 + GW * 0.75, Y0, X0 + GW * 0.90, Y0 + GH), outline=(20, 160, 80), width=2)
    d.text((X0 + GW * 0.75 + 4, Y0 + 4), '헤이루만 답 75~90%', font=f(18), fill=(20, 160, 80))
    k = 0
    for t, g, scene in EV:
        kd = kind(g)
        c = COLS.get(kd, (150, 150, 160))
        xx = X0 + GW * t / OD
        d.line((xx, Y0, xx, Y0 + GH), fill=c, width=4 if kd in ('정점', '큰 질문') else 2)
        d.text((xx + 4, Y0 + 30 + (k % 12) * 26), f'{g[:10]} {t:.0f}s', font=f(18), fill=c)
        k += 1
    y = Y0 + GH + 50
    # ③ 전체 위치
    d.text((30, y), '③ 편 전체 위치(%) — 원본 정점(●)·꺼짐(×), gyeol_scan 기준 / 맨 아래 = 우리 결 지점(● 정점 · ▲ 반전 · ■ 질문)', font=f(28), fill=(20, 20, 30))
    y += 50
    PX0, PW = 420, WW - 480
    for pct in range(0, 101, 10):
        xx = PX0 + PW * pct / 100
        d.line((xx, y, xx, y + 46 * (len(REFS) + 1)), fill=(235, 235, 240))
        d.text((xx - 14, y + 46 * (len(REFS) + 1) + 4), f'{pct}%', font=f(18, False), fill=(90, 90, 100))
    for i, (key, v) in enumerate(REFS.items()):
        a = analyse({'heatmap': [{'start_time': t, 'value': val} for t, val in v['hm']], 'duration': v['dur']})
        yy = y + i * 46 + 20
        d.text((30, yy - 12), f"{key} · {v['views'] // 10000}만회", font=f(20, False), fill=(60, 60, 70) if key != rid else (220, 40, 40))
        d.line((PX0, yy, PX0 + PW, yy), fill=(200, 200, 210), width=2)
        for val, t in a['peaks']:
            xx = PX0 + PW * t / v['dur']
            d.ellipse((xx - 8, yy - 8, xx + 8, yy + 8), fill=(230, 90, 20))
        for drop, t in a['dips']:
            xx = PX0 + PW * t / v['dur']
            d.line((xx - 7, yy - 7, xx + 7, yy + 7), fill=(60, 60, 200), width=3)
            d.line((xx - 7, yy + 7, xx + 7, yy - 7), fill=(60, 60, 200), width=3)
    yy = y + len(REFS) * 46 + 20
    d.text((30, yy - 12), f'우리 {ep.name} 설계', font=f(22), fill=(20, 120, 60))
    d.line((PX0, yy, PX0 + PW, yy), fill=(20, 120, 60), width=2)
    for t, g, _ in EV:
        xx, kd = PX0 + PW * t / OD, kind(g)
        if kd == '정점':
            d.ellipse((xx - 11, yy - 11, xx + 11, yy + 11), fill=(20, 160, 80))
        elif kd == '반전':
            d.polygon([(xx, yy - 10), (xx - 9, yy + 8), (xx + 9, yy + 8)], fill=(30, 80, 200))
        elif kd in ('큰 질문', '들뜬 선언'):
            d.rectangle((xx - 7, yy - 7, xx + 7, yy + 7), fill=COLS[kd])
    out = ep / 'out' / 'compare_gyeol.jpg'
    im.save(out, quality=88)
    print(out, im.size, '결 지점', len(EV), '· 원본', len(REFS), '편')


if __name__ == '__main__':
    main()
