# -*- coding: utf-8 -*-
"""릴레이 쇼츠 전용 관문 — 주고받기 관문(exchange_gate.py: 공격→반응→대응, 한 사람 12초)을 대신한다.
릴레이는 «같은 날 여러 방송에서 같은 결의 말을 한 사람처럼 잇는» 형식이라 맞받기 쌍이 없다(소유주 10-28).
원음 비율·얼굴 크게·출처 표기·욕설·군사 낱말·호칭 규칙은 그대로 지킨다.

    python politics-hour/shorts/relay_gate.py <relay.json> <name.upload.json>     FAIL 이면 종료 3

FAIL:
  · 길이 40~55초 · 해설(TTS) 0 = 원음 100%(렌더 지도의 컷 합 = 영상 길이)
  · 화자 3명+ · 방송 3곳+ · 방송 날짜는 최신 날짜에서 하루 안(같은 날~전날)
  · 컷 1.5~10.5초 · 같은 사람 연속 12초 이하
  · 첫 컷 role=hook · 마지막 컷 role=punch · 사실 카드 1장+ (원 출처 card_sources 또는 카드 src 필수)
  · 자막 = 전사 원문 부분 문자열(띄어쓰기만 붙임 허용 — joins) · 욕설은 xx 로 가려짐 · 컷마다 show·date·who 이름 있음
  · 얼굴: 컷마다 얼굴 폭 ≥ 화면 25%(fit 컷 금지) · 확대 ≤ 2.4배
  · 포장: 제목 머리 15자에 인물 이름 · 이름만 쓴 «이재명» 금지 · 욕설(profanity.py) 0 · 군사·내란 낱말 0 · 가이드 낱말(guide_words) 0
  · 음량 -14±1 LUFS · 컷 이음새 무음 0.4초 이하(gap_check shorts)
  ★10-29 몽타주 훅(소유주 «숏폼에도 예능편집넣고 · 훅 넣고»)이 있으면: 본편 길이 40~55초·전체 60초 이하, 훅 2~5초·한마디 0.5~2.2초·2~4개,
    한마디는 본편 컷의 전사 이어진 낱말 그대로이고 그 컷 구간 안(약속 — 본편에 다시 나온다), 화자 2명+, 강조 자막은 그 한마디의 부분,
    장식(스티커·속마음) 글자에 욕설·군사 낱말 0. 컷 합 + 훅 = 영상 길이(해설 0).
  ★10-29 주제 인물 화면(소유주 «김건희 주제는 김건희가 나와야지 · 목소리는 기자 목소리 그대로 · 앞으로도 이런 케이스는 이렇게») — 어기면 종료 4:
    주제 인물 = relay.json "subject"(없으면 업로드 메타 villain → relay villains[0]).
    ① 훅 조각마다 화면이 주제 인물 — b_roll.person == subject 이거나 그 조각 화자가 subject.
    ② 전언 컷(quoted_person 있음)과 그 컷에서 딴 훅 조각은 b_roll 이 quoted_person 얼굴이고 그 꼬리표에 «전언».
    ③ 본편에 주제 인물 장면(b_roll person == subject 또는 화자가 subject) 2회 이상.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, 'D:/midform/scripts')
import profanity as PF          # noqa: E402
import guide_words              # noqa: E402
import gap_check                # noqa: E402

MIL = ['내란', '계엄', '쿠데타', '군사', '사령관', '파병', '작전', '지뢰', '국방', '전작권', 'DMZ', '철책', '청해부대', '북한군', '전쟁', '무기', '폭동']


def norm(s):
    return re.sub(r'\s+', '', s)


def check(plan, up, m):
    bad, warn = [], []
    cuts, total = m['cuts'], m['total']
    spk = plan['speakers']
    hk = (m.get('hook') or {}).get('clips') or []
    hd = sum(h['t1'] - h['t0'] for h in hk)
    if not 40 <= total - hd <= 55:
        bad.append(f'본편 길이 {total - hd:.1f}초 — 40~55초 밖')
    if total > 60:
        bad.append(f'길이 {total:.1f}초 — 60초 이하')
    if hk:
        bad += hook_lines(plan, hk, hd)
    for dc in m.get('decos', []):
        if PF.hits(dc['text'], ('all',)) or any(w in dc['text'] for w in MIL):
            bad.append(f'장식 «{dc["text"]}» 욕설·군사 낱말')
    s = sum(c['t1'] - c['t0'] for c in cuts) + hd
    if abs(s - total) > 0.1:
        bad.append(f'컷 합 {s:.2f} ≠ 영상 {total:.2f} — 원음 아닌 칸이 섞였다')
    if plan.get('narration'):
        bad.append('해설(narration) 칸이 있다 — 릴레이는 원음 100%')
    who = {c['who'] for c in cuts}
    shows = {c['show'] for c in cuts}
    if len(who) < 3:
        bad.append(f'화자 {len(who)}명 — 3명 이상')
    if len(shows) < 3:
        bad.append(f'방송 {len(shows)}곳 — 3곳 이상')
    dates = sorted({c['date'] for c in cuts})
    from datetime import date
    dd = [date(*map(int, d.split('.'))) for d in dates]
    if (max(dd) - min(dd)).days > 1:
        bad.append(f'방송 날짜 {dates} — 같은 날~전날만')
    run_who, run = None, 0.0
    for c in cuts:
        d = c['t1'] - c['t0']
        if not 1.5 <= d <= 10.5:
            bad.append(f'컷 {c["k"]} {d:.1f}초 — 1.5~10.5초 밖')
        run = run + d if c['who'] == run_who else d
        run_who = c['who']
        if run > 12.0:
            bad.append(f'컷 {c["k"]} {c["who"]} 연속 {run:.1f}초 — 12초 이하')
        if not (c.get('show') and c.get('date') and spk.get(c['who'], {}).get('name')):
            bad.append(f'컷 {c["k"]}: 출처(show·date) 또는 화자 이름 없음')
        lg = c['log']
        if lg.get('mode') != 'single':
            bad.append(f'컷 {c["k"]}: 얼굴 클로즈업 아님({lg.get("mode")})')
        elif lg['face_frac'] < 0.25 or lg['upscale'] > 2.4:
            bad.append(f'컷 {c["k"]}: 얼굴 {lg["face_frac"] * 100:.0f}% · 확대 {lg["upscale"]}배 — 얼굴 ≥25%·확대 ≤2.4배')
    if cuts[0].get('role') != 'hook':
        bad.append('첫 컷 role 이 hook(감정 한마디)이 아님')
    if cuts[-1].get('role') != 'punch':
        bad.append('마지막 컷 role 이 punch(전망·한 방)가 아님')
    if not m.get('cards'):
        bad.append('사실 카드 0장 — 숫자·결정이 나오는 컷에 3~4초')
    for k in m.get('cards', []):
        if not (k.get('src') and plan.get('card_sources')):
            bad.append(f'사실 카드 «{k.get("head")}»: 원 출처(src·card_sources) 없음')
        if not 3.0 <= k['t1'] - k['t0'] <= 4.2:
            bad.append(f'사실 카드 «{k.get("head")}» {k["t1"] - k["t0"]:.1f}초 — 3~4초')
    # 자막 = 전사 부분 문자열
    for cp in m['captions']:
        c = plan['cuts'][cp['cut']]
        ws = json.loads(Path(c['transcript']).read_text(encoding='utf-8'))
        ws = ws if isinstance(ws, list) else ws['words']
        full = ' '.join(w[2] for w in ws)
        if cp['raw'] not in full:
            bad.append(f'자막 «{cp["raw"]}» 이 전사 원문에 없다')
        shown = cp['text']
        if norm(PF.mask(cp['raw'])) != norm(shown):
            bad.append(f'자막 «{shown}» — 띄어쓰기 말고 글자가 바뀌었다')
        if PF.hits(shown, ('all',)):
            bad.append(f'자막 «{shown}» 욕설이 가려지지 않았다')
        for w in MIL:
            if w in shown:
                bad.append(f'자막 «{shown}» 군사·내란 낱말 «{w}»')
    for t in plan['title']:
        for w in MIL:
            if w in t:
                bad.append(f'화면 제목 «{t}» 군사·내란 낱말 «{w}»')
    # 포장
    title = up.get('title', '')
    pack = '\n'.join([title, up.get('description', ''), up.get('pinned_comment', ''), ' '.join(up.get('tags', []))])
    names = [v['name'] for v in spk.values()] + plan.get('villains', [])
    if not any(n in title[:15] for n in names):
        bad.append(f'제목 머리 15자에 인물 이름 없음: «{title[:15]}»')
    if re.search(r'이재명(?!\s*(대통령|정부))', pack):
        bad.append('포장에 이름만 쓴 «이재명» — «이재명 대통령»')
    for h in PF.hits(pack):
        bad.append(f'포장 욕설·비속어: {h}')
    for w in MIL:
        if w in pack:
            bad.append(f'포장 군사·내란 낱말 «{w}»')
    tg = [h[1:] for h in re.findall(r'#\S+', up.get('description', '')) if h != '#shorts']
    for k in plan.get('keywords', []):
        if k not in title and k.replace(' ', '') not in tg:
            bad.append(f'키워드 «{k}» 가 제목·해시태그에 없음')
    lo = m.get('loudness') or {}
    if not -15.0 <= float(lo.get('after', 0)) <= -13.0:
        bad.append(f'음량 {lo.get("after")} LUFS — -14±1')
    return bad, warn


def hook_lines(plan, hk, hd):
    bad = []
    if not 2.0 <= hd <= 5.0:
        bad.append(f'훅 {hd:.1f}초 — 2~5초')
    if not 2 <= len(hk) <= 4:
        bad.append(f'훅 한마디 {len(hk)}개 — 2~4개')
    if len({h['who'] for h in hk}) < 2:
        bad.append('훅 화자 1명 — 구마다 다른 얼굴(2명+)')
    for h in hk:
        c = plan['cuts'][h['cut']]
        d = h['t1'] - h['t0']
        if not 0.5 <= d <= 2.2:
            bad.append(f'훅 «{h["say"]}» {d:.2f}초 — 0.5~2.2초')
        ws = json.loads(Path(c['transcript']).read_text(encoding='utf-8'))
        ws = ws if isinstance(ws, list) else ws['words']
        if h['say'] not in ' '.join(w[2] for w in ws):
            bad.append(f'훅 «{h["say"]}» 이 전사 원문에 없다')
        if not (c['in'] - .05 <= h['in'] and h['out'] <= c['out'] + .05):
            bad.append(f'훅 «{h["say"]}» {h["in"]}~{h["out"]} 이 본편 컷 {h["cut"]} 구간 밖 — 본편에 다시 나와야 한다')
        plain = re.sub(r'[*#]', '', h['caps'])
        if norm(plain) not in norm(h['say']):
            bad.append(f'훅 자막 «{plain}» 이 한마디 «{h["say"]}» 의 부분이 아니다')
        if PF.hits(plain, ('all',)) or any(w in plain for w in MIL):
            bad.append(f'훅 자막 «{plain}» 욕설·군사 낱말')
    return bad


def subject_lines(plan, up, m):
    subj = plan.get('subject') or up.get('villain') or (plan.get('villains') or [None])[0]
    if not subj:
        return ['주제 인물(subject) 미정 — relay.json "subject"']
    spk = plan['speakers']
    name = lambda w: spk.get(w, {}).get('name', '').replace(' 씨', '').strip()
    lab = lambda k: ' · '.join(x for x in (spk.get(k, {}).get('name'), spk.get(k, {}).get('role')) if x)
    bad = []
    for h in (m.get('hook') or {}).get('clips') or []:
        brs = h.get('b_roll') or []
        if name(h['who']) != subj and not any(b['person'] == subj for b in brs):
            bad.append(f'훅 «{h["say"]}»: 화면이 주제 인물 «{subj}» 아님(화자 {name(h["who"])}) — b_roll 로 {subj} 장면을 덮어라')
        q = plan['cuts'][h['cut']].get('quoted_person')
        if q and not any(b['person'] == q and '전언' in lab(b.get('tag') or '') for b in brs):
            bad.append(f'훅 «{h["say"]}»: 전언(«{q}» 말) 조각인데 {q} 화면·«전언» 꼬리표 없음')
    n = 0
    for c in m['cuts']:
        brs = c.get('b_roll') or []
        q = c.get('quoted_person') or plan['cuts'][c['k']].get('quoted_person')
        if q and not any(b['person'] == q and '전언' in lab(b.get('tag') or '') for b in brs):
            bad.append(f'컷 {c["k"]}: 전언(«{q}» 말) 컷인데 {q} 화면(b_roll)·«전언» 꼬리표 없음')
        n += (name(c['who']) == subj) + sum(b['person'] == subj for b in brs)
    if n < 2:
        bad.append(f'본편 주제 인물 «{subj}» 장면 {n}회 — 2회 이상(b_roll 또는 본인 발언)')
    return bad


def main():
    pf, uf = Path(sys.argv[1]), Path(sys.argv[2])
    plan = json.loads(pf.read_text(encoding='utf-8'))
    up = json.loads(uf.read_text(encoding='utf-8'))
    m = json.loads((pf.parent / f'{plan["name"]}.render.json').read_text(encoding='utf-8'))
    bad, warn = check(plan, up, m)
    bad += guide_words.gate_lines([str(uf)], lang='ko', lane='politics')
    bad += gap_check.gate_lines(str(pf.parent / f'{plan["name"]}.mp4'), kind='shorts')
    sbad = subject_lines(plan, up, m)
    print(f'{plan["name"]} · {m["total"]:.1f}초 · 컷 {len(m["cuts"])} · 화자 {len({c["who"] for c in m["cuts"]})} · 방송 {len({c["show"] for c in m["cuts"]})}')
    for c in m['cuts']:
        print(f'  {c["k"]} {c["t0"]:5.1f}~{c["t1"]:5.1f} {plan["speakers"][c["who"]]["name"]} | {c["show"]} {c["date"]} | {c.get("role")} | 얼굴 {c["log"].get("face_frac", 0) * 100:.0f}% ×{c["log"].get("upscale")}')
    for w in warn:
        print('△ ' + w)
    for b in bad + sbad:
        print('FAIL ' + b)
    print('통과' if not (bad or sbad) else f'FAIL {len(bad) + len(sbad)}건')
    sys.exit(4 if sbad else 3 if bad else 0)


if __name__ == '__main__':
    main()
