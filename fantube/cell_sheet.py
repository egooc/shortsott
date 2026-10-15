"""무대 단체 샷에서 멤버 위치를 «칸 시트 판독»으로 잡는다 — N100 subject_pos.py 방식(소유주 10/15 안내).
자동 추적(stage_track.py)이 놓치는 원거리 샷을 메운다: 샷마다 한 프레임에 8×5 칸(A~H × 1~5)을 덮고
기준 사진을 옆에 붙인 시트를 만들면, 제작 세션(Claude)이 시트를 보고 cells.json 에 칸을 적는다.

    python cell_sheet.py sheet <영상> <구간 "a-b,c-d"> <기준 사진> <out_dir>   → out_dir/cells_sheet_N.jpg + cells_todo.json
    python cell_sheet.py marks <out_dir>                                          → out_dir/track_cells.json (fantube track 형식)
cells.json: {"shots":[{"t":5.0,"cell":"D2"}, ...]}  (null = 그 샷에 없음 → 그 샷은 쓰지 않거나 이웃 값)
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, 'D:/midform/fantube')
COLS, ROWS = 8, 5


def frame(src, t):
    cap = cv2.VideoCapture(str(src))
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, f = cap.read()
    cap.release()
    return f if ok else None


def grid(img):
    h, w = img.shape[:2]
    out = img.copy()
    for c in range(1, COLS):
        cv2.line(out, (w * c // COLS, 0), (w * c // COLS, h), (0, 255, 255), 2)
    for r in range(1, ROWS):
        cv2.line(out, (0, h * r // ROWS), (w, h * r // ROWS), (0, 255, 255), 2)
    for c in range(COLS):
        for r in range(ROWS):
            cv2.putText(out, f'{"ABCDEFGH"[c]}{r + 1}', (w * c // COLS + 8, h * r // ROWS + 34),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 255), 3)
    return out


def cell_center(cell, w=1920, h=1080):
    c, r = 'ABCDEFGH'.index(cell[0]), int(cell[1:]) - 1
    return (c + 0.5) / COLS, (r + 0.5) / ROWS          # 정규화 cx, cy (stage_track marks 와 같은 단위)


def sheet(src, spans, ref, out_dir):
    import fantube as F
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    shots = []
    for sp in spans.split(','):
        a, b = (float(x) for x in sp.split('-'))
        cuts = [a] + [c for c in F._cuts_in(src, a, b - a) if c > a + 0.2] + [b]
        for s, e in zip(cuts, cuts[1:]):
            if e - s >= 0.3:
                shots.append({'t': round((s + e) / 2, 2), 'from': round(s, 2), 'to': round(e, 2), 'cell': None})
    refimg = cv2.imread(str(ref))
    tiles = []
    for i, sh in enumerate(shots):
        g = grid(frame(src, sh['t']))
        g = cv2.resize(g, (960, 540))
        cv2.putText(g, f'#{i} t={sh["t"]}', (10, 525), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
        tiles.append(g)
    r = cv2.resize(refimg, (int(refimg.shape[1] * 540 / refimg.shape[0]), 540))
    for k in range(0, len(tiles), 4):
        page = tiles[k:k + 4]
        while len(page) < 4:
            page.append(np.zeros_like(tiles[0]))
        img = np.vstack([np.hstack(page[:2]), np.hstack(page[2:])])
        img = np.hstack([img, np.vstack([r, np.zeros((540, r.shape[1], 3), np.uint8)])])
        cv2.imwrite(str(out / f'cells_sheet_{k // 4}.jpg'), img)
    (out / 'cells_todo.json').write_text(json.dumps({'src': str(src), 'shots': shots}, ensure_ascii=False, indent=1) + '\n',
                                         encoding='utf-8')
    print(len(shots), '샷 →', out)


def marks(out_dir):
    out = Path(out_dir)
    d = json.loads((out / 'cells.json').read_text(encoding='utf-8'))
    m = []
    for sh in d['shots']:
        if not sh.get('cell'):
            continue
        cx, cy = cell_center(sh['cell'])
        for t in (sh['from'] + 0.02, sh['to'] - 0.02):     # 샷 안에서는 고정(샷 경계에서 점프)
            m.append([round(t, 2), round(cx, 4), round(cy, 4), 0])
    (out / 'track_cells.json').write_text(json.dumps({'marks': m}) + '\n', encoding='utf-8')
    print(len(m), '점 →', out / 'track_cells.json')


if __name__ == '__main__':
    a = sys.argv
    sheet(*a[2:6]) if a[1] == 'sheet' else marks(a[2])
