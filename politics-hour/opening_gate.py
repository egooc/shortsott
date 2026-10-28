"""시작 관문(소유주 10-27 결정, 관리자 경유 — 레퍼런스 기준선 10-26 제안 ②): 첫 원본 발언을 15초 안에, «오늘의 쟁점» 목차 카드 금지.

    python opening_gate.py <ep폴더> [--estimate]      NEW_FROM(20261028) 이후 편이 걸리면 종료 4, 그 전 편은 경고만(종료 0)

- 첫 실제 장면 = episode.json 순서에서 콜드오픈(cold) 말고 첫 원음 인용(quote) 조각. 그 시작 시각 ≤ 15초.
  ★몽타주 훅(hook, 10-28 시사썰전 결)은 해설(nar)과 같은 «앞 조각»으로 센다. 훅 뒤에 오는 원음(cold — 제목 약속 발언)은
  0초 콜드오픈이 아니라 훅이 예고한 첫 원음이므로 첫 실제 장면으로 인정한다(훅이 없으면 지금처럼 cold 는 건너뛴다).
  앞 조각 길이: 렌더된 조각(work/concat.txt 의 normalized.mp4, 조각 수가 같을 때)이 있으면 그 길이,
  없으면 cold = out−in + cold_overlay.TAIL(.9), nar = audio 길이(있으면) 또는 공백 뺀 글자수 ÷ 5.2 + 숨 .35,
  hook = 공백·문장부호 뺀 글자수 ÷ HOOK_CPS(5.0, 훅은 0.9배속·구 사이 숨 .35 — 10/29 시안 실측 33자 6.58초) + 꼬리 .25,
  duration 필드가 있으면 그 값. --estimate 는 렌더 파일을 보지 않는다(렌더 전 — 옛 concat.txt 가 남아 있어도 속지 않게).
- 목차·차례 화면 = narration_overlay 의 «timeline» 템플릿 중 제목이 «오늘의 …»·목차·차례이거나 단계 머리가 번호(01·02…)인 것,
  그리고 «issue» 카드의 번호(no) 표시(«ISSUE 01»). 첫 실제 장면 앞에 있으면 실패.
계산 근거를 조각마다 출력한다. episode_check.py(종료 1)와 따로 돈다.
"""
import json
import re
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEW_FROM = '20261028'
LIMIT = 15.0
CHARS_PER_SEC = 5.2     # overlay/episode_check.py 와 같은 값(Supertonic F2 · 1.05배 실측)
PAD = .35               # overlay/assemble_hour.py 해설 뒤 숨
COLD_TAIL = .9          # overlay/cold_overlay.py TAIL
HOOK_CPS, HOOK_TAIL = 5.0, .25   # overlay/hook_overlay.py(speed .9·gap .35)·TAIL
TOC_TITLE = re.compile(r'오늘의|목차|차례|순서|쟁점 ?[0-9]|^\s*(01|1)\b')


def _probe(p):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                       capture_output=True, text=True)
    return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


def _wav_sec(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


def is_toc(seg):
    v = seg.get('visual') or {}
    if v.get('type') == 'timeline':
        steps = v.get('steps') or []
        numbered = steps and all(re.fullmatch(r'\s*\d{1,2}\s*', str(s[0] if isinstance(s, list) else s)) for s in steps)
        if TOC_TITLE.search(v.get('title', '')) or numbered:
            return f'timeline «{v.get("title", "")}»' + (' (번호 단계)' if numbered else '')
    if v.get('type') == 'issue' and v.get('no') is not None:
        return f'issue 번호 카드 «ISSUE {v.get("no")}»'
    return None


def rendered(ep, n):
    """조각 수가 같으면 렌더된 조각 경로 목록, 아니면 None."""
    E = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    c = (ep / E.get('workdir', 'work')) / 'concat.txt'
    if not c.exists():
        return None
    parts = [Path(l.split("'")[1]) for l in c.read_text(encoding='utf-8').splitlines() if l.strip()]
    return parts if len(parts) == n and all(p.exists() for p in parts) else None


def seg_len(ep, s, part=None):
    if part is not None:
        d = _probe(part)
        if d is not None:
            return d, '렌더 조각'
    if s.get('duration'):
        return float(s['duration']), 'duration 필드'
    if s['type'] == 'cold':
        return s['out'] - s['in'] + COLD_TAIL, f'cold out−in {s["out"] - s["in"]:.2f} + 꼬리 {COLD_TAIL}'
    if s['type'] == 'quote':
        return s['out'] - s['in'], 'quote out−in'
    if s['type'] == 'hook':
        n = len(re.sub(r'[\s\W_]', '', s.get('text', '') or ' '.join(l.get('say', '') for l in s.get('lines', []))))
        return n / HOOK_CPS + HOOK_TAIL, f'hook 글자 {n} ÷ {HOOK_CPS} + 꼬리 {HOOK_TAIL}'
    if s.get('audio') and (ep / s['audio']).exists():
        return _wav_sec(ep / s['audio']) + PAD, f'audio {s["audio"]} + 숨 {PAD}'
    n = len(re.sub(r'\s', '', s.get('text', '')))
    return n / CHARS_PER_SEC + PAD, f'글자 {n} ÷ {CHARS_PER_SEC} + 숨 {PAD}'


def check(ep, estimate=False):
    """(실패 목록, 근거 줄 목록, 첫 장면 시작초)."""
    ep = Path(ep)
    segs = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))['segments']
    parts = None if estimate else rendered(ep, len(segs))
    bad, why, t = [], [], 0.0
    first = None
    hooked = False
    for i, s in enumerate(segs):
        if s['type'] == 'quote' or (s['type'] == 'cold' and hooked):
            first = i
            break
        hooked = hooked or s['type'] == 'hook'
        d, basis = seg_len(ep, s, parts[i] if parts else None)
        toc = is_toc(s)
        label = (s.get('visual') or {}).get('title') or (' '.join(w[1] for w in s.get('words', [])) if s['type'] == 'cold' else
                                                         s.get('text', '') if s['type'] == 'hook' else '')
        why.append(f'[{i}] {s["type"]:<5} {t:6.1f}→{t + d:6.1f}초 ({basis}) {label[:30]}')
        if toc:
            bad.append(f'[{i}] 목차·차례 화면 {toc} 이 첫 실제 장면 앞에 있음 — 빼라(번호·목록 없이 바로 첫 발췌로)')
        t += d
    if first is None:
        bad.append('원음 인용(quote) 조각이 없음')
        return bad, why, None
    s = segs[first]
    who = s.get('speaker', '') if s['type'] == 'quote' else '훅 뒤 원음 ' + ' '.join(w[1] for w in s.get('words', []))[:30]
    why.append(f'[{first}] {s["type"]} 첫 실제 장면 시작 {t:.1f}초 — {who} {s.get("tag", "")}'
               f' ({"렌더 조각 길이" if parts else "추정"})')
    if t > LIMIT:
        bad.append(f'첫 실제 장면(원음 발췌 [{first}] {who}) 시작 {t:.1f}초 — {LIMIT:.0f}초 이내여야 함'
                   f'(앞 해설을 그 발췌 뒤로 옮겨라)')
    return bad, why, t


def gate_lines(ep, estimate=False):
    """upload_gate·render_episode 용 — NEW_FROM 이후 편만 실패 줄을 돌려주고, 그 전 편은 출력만."""
    ep = Path(ep)
    if not (ep / 'episode.json').exists():
        return []
    bad, why, _ = check(ep, estimate)
    for w in why:
        print('[시작]', w)
    if ep.name[:8] < NEW_FROM:
        for b in bad:
            print('[시작] 경고', b, f'({ep.name} < {NEW_FROM})')
        return []
    return [f'시작 관문: {b}' for b in bad]


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1])
    if not ep.exists():
        ep = HERE / 'episodes' / sys.argv[1]
    bad, why, t = check(ep, '--estimate' in sys.argv)
    for w in why:
        print('[시작]', w)
    enforce = ep.name[:8] >= NEW_FROM
    for b in bad:
        print('[시작]', 'FAIL' if enforce else '경고', b)
    print('[시작]', 'PASS' if not bad else (f'{len(bad)}건 실패' if enforce else f'{len(bad)}건 — 경고만({ep.name} < {NEW_FROM})'), ep.name)
    sys.exit(4 if bad and enforce else 0)
