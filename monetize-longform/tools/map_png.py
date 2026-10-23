# -*- coding: utf-8 -*-
"""세력지도 PNG — 현대 도도부현 경계(Natural Earth 10m admin-1, 퍼블릭 도메인)를 옛 나라 대신 쓴다(대략 지도, 해설에서 «今の〇〇県»).

    python -X utf8 monetize-longform/tools/map_png.py <편 폴더>/maps.json <출력 폴더>

maps.json: {"<이름>": {"bbox": [서경, 남위, 동경, 북위], "fill": {"현 이름(name_ja)": "세력키"}, "labels": [[경도, 위도, "글자", 크기]],
           "marks": [[경도, 위도, "글자"]], "arrows": [[경도1, 위도1, 경도2, 위도2]], "legend": ["세력키", ...]}}
세력키 색은 POWERS. 지도 색은 가문별 고정(발굴 시트 §3: 주인공 가문 빨강, 바탕 회청색).
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
GEO = ROOT / 'reference' / 'geo' / 'japan_pref_ne.geojson'
FONT = ROOT / 'ja-nenkin' / 'render' / 'fonts' / 'NotoSerifJP-VF.ttf'
W, H = 1770, 778   # 연금 THEME 의 판 자리(#stage 1770x778)에 딱 맞게 — cover 로 범례가 잘리지 않게
SEA, LAND, LINE = (122, 142, 158), (226, 220, 204), (150, 140, 120)
POWERS = {'豊臣': ((196, 52, 44), '豊臣'), '秀長': ((232, 140, 30), '秀長'), '徳川': ((46, 92, 158), '徳川'),
          '毛利': ((62, 142, 90), '毛利'), '長宗我部': ((128, 88, 176), '長宗我部'), '島津': ((120, 74, 42), '島津'),
          '柴田': ((90, 108, 124), '柴田'), '大友': ((201, 162, 39), '大友'), '北条': ((70, 70, 70), '北条'),
          '織田': ((170, 40, 40), '織田'), '東軍': ((46, 92, 158), '東軍'), '西軍': ((196, 52, 44), '西軍'), '注目': ((232, 140, 30), '')}


def font(size):
    f = ImageFont.truetype(str(FONT), size)
    try:
        f.set_variation_by_axes([900])
    except Exception:
        pass
    return f


def proj(bbox, W=W, H=H):
    x0, y0, x1, y1 = bbox
    k = math.cos(math.radians((y0 + y1) / 2))
    sx = W / ((x1 - x0) * k)
    sy = H / (y1 - y0)
    s = min(sx, sy)
    ox = (W - (x1 - x0) * k * s) / 2
    oy = (H - (y1 - y0) * s) / 2
    return lambda lon, lat: (ox + (lon - x0) * k * s, oy + (y1 - lat) * s)


def rings(geom):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    for poly in polys:
        yield poly[0]


def draw_map(spec, feats, out):
    W, H = spec.get('size', (globals()['W'], globals()['H']))   # 썸네일 틀은 16:9 (size: [1920, 1080])
    P = proj(spec['bbox'], W, H)
    im = Image.new('RGB', (W, H), SEA)
    d = ImageDraw.Draw(im)
    fill = spec.get('fill', {})
    for f in feats:
        c = POWERS[fill[f['ja']]][0] if f['ja'] in fill else LAND
        for r in rings(f['geom']):
            pts = [P(x, y) for x, y in r]
            if len(pts) > 2:
                d.polygon(pts, fill=c, outline=LINE)
    for a in spec.get('arrows', []):
        p1, p2 = P(a[0], a[1]), P(a[2], a[3])
        d.line([p1, p2], fill=(255, 255, 255), width=10)
        ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
        tip = [p2, (p2[0] - 34 * math.cos(ang - .45), p2[1] - 34 * math.sin(ang - .45)), (p2[0] - 34 * math.cos(ang + .45), p2[1] - 34 * math.sin(ang + .45))]
        d.polygon(tip, fill=(255, 255, 255))
    for m in spec.get('marks', []):
        x, y = P(m[0], m[1])
        d.ellipse([x - 14, y - 14, x + 14, y + 14], fill=(255, 255, 255), outline=(30, 30, 30), width=4)
        if len(m) > 2:
            f = font(40)
            d.text((x + 22, y - 26), m[2], font=f, fill=(20, 20, 20), stroke_width=6, stroke_fill=(255, 255, 255))
    for lab in spec.get('labels', []):
        x, y = P(lab[0], lab[1])
        f = font(lab[3] if len(lab) > 3 else 56)
        d.text((x, y), lab[2], font=f, fill=(255, 255, 255), anchor='mm', stroke_width=7, stroke_fill=(30, 30, 30))
    if spec.get('legend'):
        f = font(40)
        y = H - 70 * len(spec['legend']) - 40
        for k in spec['legend']:
            c, name = POWERS[k]
            d.rectangle([60, y, 110, y + 50], fill=c, outline=(255, 255, 255), width=3)
            d.text((128, y + 25), name, font=f, fill=(255, 255, 255), anchor='lm', stroke_width=5, stroke_fill=(30, 30, 30))
            y += 70
    im.save(out)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    specs = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    feats = [{'ja': f['properties']['name_ja'], 'geom': f['geometry']} for f in json.loads(GEO.read_text(encoding='utf-8'))['features']]
    names = {f['ja'] for f in feats}
    for name, spec in specs.items():
        if name.startswith('_'):
            continue
        miss = [k for k in spec.get('fill', {}) if k not in names]
        if miss:
            raise SystemExit(f'{name}: 없는 현 이름 {miss}')
        draw_map(spec, feats, out / f'{name}.png')
        print(name)


if __name__ == '__main__':
    main()
