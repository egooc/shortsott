# -*- coding: utf-8 -*-
"""쇼츠 주고받기 보조 관문 — 10-20 15:00 소유주 «토론·국감장에서 주고받는 중요 멘트랑 반응이나 대응을 가져와야 되는데,
우린 토론 주장을 줄줄이 다 가져오니까 반응이 덜하지.» (관리자 전달, 10/21 쇼츠부터)

    python politics-hour/shorts/exchange_gate.py <plan.json>      표 + FAIL 목록, FAIL 이면 종료 3

plan.json sequence 칸마다:
  "role": attack | reaction | counter | narration | question
  "speaker": speakers 키(해설·TTS 는 "nar")
구조: 공격/질문 멘트 A(3~8초) → 반응 컷 B(1~3초, 말 없어도 됨) → 받아치기 C(3~10초) → (한 번 더) → 끝 질문.
★공용 scripts/exchange_check.py(도구개발 fba0506)가 attack·reaction·counter 개수 · attack≠counter 쌍 · 같은 화자 연속 12초 ·
  해설 30% 를 본다 — upload_gate 가 그걸 --enforce-now 로 부르고, 이 파일은 거기 없는 것만 본다(같은 검사를 두 벌 두지 않는다).
  speaker 는 공용 도구와 같게 "who"(없으면 "speaker")를 읽는다.
FAIL:
  · role 없는 칸 · 마지막 칸 role=question · 발언자(nar 빼고) 2명 이상
  · 길이: attack 3~8 · reaction 1~3 · counter 3~10초
  · 해설(nar) 카드는 칸마다 1줄 이하, 해설 칸은 2개 이하(반응 컷 위 한 줄 + 끝 질문)
  · "layout": "close"(3단 얼굴 띠 틀) 아니면 FAIL
"""
import json
import sys
from pathlib import Path

ROLES = {'attack', 'reaction', 'counter', 'narration', 'question'}
LEN = {'attack': (3, 8), 'reaction': (1, 3), 'counter': (3, 10)}
NAR_DEFAULT = 2.5      # 해설 칸 길이를 모르면(렌더 전) 이만큼으로 본다


def dur(s):
    if 'source_in' in s:
        return round(s['source_out'] - s['source_in'], 2)
    return float(s.get('dur', NAR_DEFAULT))


def check(plan, name='쇼츠'):
    seq, bad, rows = plan.get('sequence', []), [], []
    if plan.get('layout') != 'close':
        bad.append(f'{name}: "layout": "close"(3단 얼굴 띠 틀) 아님')
    nar = {n['id']: n for n in plan.get('narration', [])}
    for i, s in enumerate(seq):
        r, sp, d = s.get('role'), s.get('who') or s.get('speaker') or ('nar' if 'narration' in s else None), dur(s)
        rows.append((i, r, sp, d))
        if r not in ROLES:
            bad.append(f'{name} {i}번 칸: role 없음({r})')
            continue
        lo_hi = LEN.get(r)
        if lo_hi and not lo_hi[0] <= d <= lo_hi[1]:
            bad.append(f'{name} {i}번 칸 {r} {d:.1f}초 — {lo_hi[0]}~{lo_hi[1]}초 밖')
        if 'narration' in s and len(nar.get(s['narration'], {}).get('cards', [])) > 1:
            bad.append(f'{name} {i}번 칸 해설 카드 {len(nar[s["narration"]]["cards"])}줄 — 1줄 이하')
    roles = [r for _, r, _, _ in rows]
    if not roles or roles[-1] != 'question':
        bad.append(f'{name}: 마지막 칸이 끝 질문(question)이 아님')
    people = {sp for _, r, sp, _ in rows if sp and sp != 'nar'}
    if len(people) < 2:
        bad.append(f'{name}: 발언자 {len(people)}명 — 2명 이상(한 사람 주장만은 롱폼 발췌 소재)')
    if sum(1 for s in seq if 'narration' in s) > 2:
        bad.append(f'{name}: 해설 칸 {sum(1 for s in seq if "narration" in s)}개 — 2개 이하')
    return bad, rows


def main():
    pf = Path(sys.argv[1])
    plan = json.loads(pf.read_text(encoding='utf-8'))
    bad, rows = check(plan, pf.parent.name)
    t = 0.0
    print('칸 | role | speaker | 초 | 누적')
    for i, r, sp, d in rows:
        t += d
        print(f'{i} | {r} | {sp} | {d:.1f} | {t:.1f}')
    for b in bad:
        print('FAIL ' + b)
    print('통과' if not bad else f'FAIL {len(bad)}건')
    sys.exit(3 if bad else 0)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
