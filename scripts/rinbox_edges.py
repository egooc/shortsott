# -*- coding: utf-8 -*-
# 편집표 구간의 시작·끝 ±0.7초 안 샷 경계(ffmpeg scene>0.12)를 찍는다.
#   python scripts/rinbox_edges.py <source.mp4> <plan.json>...
# 왜(2026-10-15): 素浪人花山大吉 소스에서 rinbox_screen.py 의 shot_cuts 가 경계를 0곳으로 봤다(실제 scene 0.25~0.33).
#   저대비 흑백 컷을 놓치면 깜빡임 검사가 통과로 나온다 — 109ja 끝 2256.70 이 2256.55 경계를 넘었는데 통과였다.
#   렌더 전에 이걸로 끝·시작이 경계를 넘는지 본다. 끝은 «경계 − 1프레임» 보다 앞이어야 한다.
import json, subprocess, re, sys
src = sys.argv[1]
for pf in sys.argv[2:]:
    p = json.load(open(pf, encoding='utf-8'))
    print('##', pf)
    for s in p['sequence']:
        if 'source_in' not in s: continue
        for tag, t in (('in', s['source_in']), ('out', s['source_out'])):
            a = t - 0.7
            r = subprocess.run(['ffmpeg', '-hide_banner', '-ss', '%.3f' % a, '-t', '1.4', '-i', src, '-vf',
                                "scale=160:120,select='gte(scene,0)',metadata=print", '-an', '-f', 'null', '-'],
                               capture_output=True, text=True, encoding='utf-8', errors='replace')
            pts = None; hits = []
            for line in r.stderr.splitlines():
                m = re.search(r'pts_time:([\d.]+)', line)
                if m: pts = float(m.group(1))
                m = re.search(r'scene_score=([\d.]+)', line)
                if m and pts is not None and float(m.group(1)) > 0.12:
                    hits.append('%.2f(%.2f)' % (a + pts, float(m.group(1))))
            print('  %s %.2f: %s' % (tag, t, ' '.join(hits) or '-'))
