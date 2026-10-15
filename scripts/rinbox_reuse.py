# 린박스 재사용 관문 — 이번 편의 원음 대사가 이미 발행된 편에서 쓰였는지 «글자»로 대조한다.
#
#   python scripts/rinbox_reuse.py <plan.json>        # 통과면 0, 발행 편과 겹치면 1
#
# 왜 (2026-10-09): 옛 편들은 소스 영상 ID 가 남아 있지 않고 원본도 지웠다. 남은 건 폴더마다의 transcript.json 과
# 편집표뿐이다. 영상 ID 대신 대사 글자로 찾으면 «다른 편집본에 같은 장면이 들어 있는» 경우까지 잡힌다
# (SBS Catch 는 같은 장면을 모음 영상 여러 개에 넣는다).
#
# 방법: 이번 컷마다 전사 글자(공백 뺀)를 12자 조각으로 썰어, 다른 폴더 전사에서 같은 조각이 나오는 자리를 찾고,
# 그 자리가 그 폴더 편집표(plan_local.json / edits/*/effective-edit.json)의 쓴 구간 안이면 «재사용»이다.
# 그 폴더의 완성본이 발행 기록(retracted 아님)에 있으면 ✗, 아니면 △(초안·버린 편).
import glob, json, re, sys
from pathlib import Path

RUNS = Path('D:/volcano-runs')
# 린박스 편은 전부 rinbox_publish_state 에 «file»(final-<해시>.mp4 / rinboxNN-*.mp4, 이름이 유일)로 남는다.
# auto_publish_state 는 옛 캡컷 드래프트 경로라 file 키가 없다 — 넣으면 아무것도 안 맞으면서 «통과»만 띄운다
# (명화관 지적 2026-10-09). ★폴더 판정은 basename 비교라 출력 이름이 유일하다는 전제다.
STATES = [Path('D:/midform/server/data/rinbox_publish_state.json')]
GRAM = 12


def words_of(path):
    try:
        j = json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return []
    if isinstance(j, dict):
        j = j.get('words') or j.get('segments') or []
    out = []
    for w in j:
        if isinstance(w, (list, tuple)) and len(w) >= 3:
            out.append((float(w[0]), float(w[1]), str(w[2])))
        elif isinstance(w, dict) and 'start' in w:
            out.append((float(w['start']), float(w.get('end', w['start'])), str(w.get('text') or w.get('word') or '')))
    return out


def norm(s):
    return re.sub(r'[\s、。，．,.!?！？「」…・ー〜~]', '', s)


def text_index(words):
    """글자열과, 글자 위치 → 원본 시각 표."""
    s, at = '', []
    for a, b, x in words:
        x = norm(x)
        s += x
        at += [a] * len(x)
    return s, at


def used_ranges(d):
    rs = []
    for f in [d / 'plan_local.json'] + sorted(d.glob('edits/*/effective-edit.json')) + sorted(d.glob('edits/*/edit.json')):
        if not f.exists():
            continue
        try:
            j = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        for s in j.get('sequence') or j.get('clips') or []:
            if isinstance(s, dict) and s.get('source_in') is not None and s.get('source_out') is not None:
                rs.append((float(s['source_in']), float(s['source_out'])))
        if rs:
            break
    return rs


def published_files():
    out = set()
    for p in STATES:
        if p.exists():
            for h in json.loads(p.read_text(encoding='utf-8')).get('history', []):
                if not h.get('retracted') and h.get('file'):
                    out.add(h['file'])
    return out


def check(plan_path):
    plan = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    me = Path(plan_path).resolve().parent
    mine = words_of(plan['transcript'])
    pub = published_files()
    grams = {}
    for s in plan['sequence']:
        if 'source_in' not in s:
            continue
        t = norm(''.join(x for a, b, x in mine if s['source_in'] - 1e-3 <= a and b <= s['source_out'] + 0.3))
        for i in range(0, max(0, len(t) - GRAM + 1), 4):
            grams.setdefault(t[i:i + GRAM], (s['source_in'], s['source_out']))
    hits = {}
    for d in sorted(RUNS.glob('rinbox*')):
        if d.resolve() == me or not d.is_dir():
            continue
        # 전사는 plan 이 가리키는 쪽 — 같은 소스를 다른 폴더 전사로 굽는 편이 있다(80ja → rinbox69ja)
        tr = d / 'transcript.json'
        pl = d / 'plan_local.json'
        if pl.exists():
            try:
                tr = Path(json.loads(pl.read_text(encoding='utf-8')).get('transcript') or tr)
            except Exception:
                pass
        if not tr.exists():
            continue
        rs = used_ranges(d)
        if not rs:
            continue
        s, at = text_index(words_of(tr))
        for g, mine_rng in grams.items():
            k = s.find(g)
            while k >= 0:
                t = at[k]
                if any(a - 0.5 <= t <= b + 0.5 for a, b in rs):
                    hits.setdefault(d.name, set()).add(mine_rng)
                    break
                k = s.find(g, k + 1)
    bad = False
    print('재사용 관문 · 대조 조각 %d개' % len(grams))
    for name, rngs in sorted(hits.items()):
        files = {p.name for p in (RUNS / name).rglob('*.mp4')}
        live = bool(files & pub)
        bad |= live
        print('  %s %s 와 겹침 — 이번 컷 %s' % ('✗' if live else '△', name + ('(발행)' if live else '(미발행)'),
                                         ', '.join('%.1f~%.1f' % r for r in sorted(rngs))))
    if not hits:
        print('  통과')
    return not bad


if __name__ == '__main__':
    sys.exit(0 if check(sys.argv[1]) else 1)
