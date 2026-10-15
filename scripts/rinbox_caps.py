# -*- coding: utf-8 -*-
"""린박스 자막 칸 — 렌더 전에 전사 토큰과 맞대 본다(음성 사기 전에 멈추게).

    python scripts/rinbox_caps.py draft <transcript.json> <in> <out> [--lang ja] [--gap 0.25]
        구간의 전사 토큰을 모아 자막 칸 초안을 뽑는다(JSON 배열). 토큰 쪽은 그대로 두고 «토큰글|보일글» 의 보일글만 고친다.
    python scripts/rinbox_caps.py check <plan.json> [<plan.json> ...]
        편집표의 모든 클립 자막을 렌더러와 같은 규칙으로 돌려 본다. 불일치·글자 수 초과·자막 없는 남은 토큰을 적는다.

왜 (10-15 C 린박스): 손으로 쓴 자막 칸이 전사 토큰과 안 맞아 렌더가 «자막이 전사 토큰과 안 맞는다»로 3번 멈췄다.
  C 의 scratchpad autocap.py·checkcap.py 를 옮겼다(실측 렌더 중단 3→0회).
  ★칸↔토큰 맞춤은 rinbox_render.card_times 를 그대로 import 한다 — 복제하면 렌더러가 바뀔 때 어긋난다.
   명화관 card_times 는 다르다(꼬리 0.3초를 받지 않고 word_ids 칸을 받는다) — 린박스 전용이다.
  글자 수 한도도 렌더러의 CAP_MAX(ja 11 · ko 12 · en 24)를 쓴다.

종료 코드: 0 통과, 4 불일치·초과 있음, 2 인자 오류.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rinbox_render as RR  # noqa: E402  card_times·CAP_MAX·JOIN 의 진짜 출처
import rinbox_reuse as R  # noqa: E402  words_of

TAIL = 0.3  # card_times 가 컷 끝 뒤로 받는 말꼬리(초). 아래 tokens_in 이 card_times 와 같은지 테스트가 지킨다


def tokens_in(words, t0, t1):
    """card_times 가 이 구간에서 받는 토큰. 초안을 뽑을 때만 쓴다 — 판정은 늘 card_times 로 한다."""
    return [(s, min(e, t1), x) for s, e, x in words if s >= t0 - 1e-3 and e <= t1 + TAIL]


def draft(words, t0, t1, mx, gap=0.25):
    """토큰 경계에서만 끊는다(쉼 gap 초 이상 또는 mx 자 초과 직전). 끝에 card_times 로 되짚어 검증한다."""
    cards, cur, last = [], '', None
    for s, e, x in tokens_in(words, t0, t1):
        if cur and (s - last > gap or len(cur + x) > mx):
            cards.append(cur)
            cur = ''
        cur += x
        last = e
    if cur:
        cards.append(cur)
    RR.card_times(words, t0, t1, cards, '')  # 안 맞으면 여기서 SystemExit — 초안이 렌더러와 어긋났다는 뜻
    cut = [x for s, e, x in words if t0 <= s < t1 and e > t1 + TAIL]
    return cards, cut


def check_plan(plan_path):
    """[(클립 번호, 종류, 설명)] — 종류 mismatch·too_long·leftover."""
    p = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    lang = p.get('lang', 'ko')
    mx = RR.CAP_MAX[lang]
    words = R.words_of(p['transcript'])
    out = []
    for k, it in enumerate(p['sequence']):
        if 'source_in' not in it:
            continue
        t0, t1, caps = it['source_in'], it['source_out'], it.get('captions', [])
        for c in caps:
            show = c.split('|', 1)[-1]
            if len(show) > mx:
                out.append((k, 'too_long', '%r 보일글 %d자 > %d' % (show, len(show), mx)))
        try:
            RR.card_times(words, t0, t1, caps, RR.JOIN.get(lang, ''))
        except SystemExit as e:
            out.append((k, 'mismatch', str(e)))
            continue
        used = sum(len(c.split('|', 1)[0].replace(' ', '')) for c in caps)
        rest = ''.join(x for _, _, x in tokens_in(words, t0, t1))[used:]
        if rest.strip():
            out.append((k, 'leftover', '자막 없는 남은 토큰: %s' % rest))
    return out


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='린박스 자막 칸 초안·대조')
    sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('draft')
    d.add_argument('transcript')
    d.add_argument('t0', type=float)
    d.add_argument('t1', type=float)
    d.add_argument('--lang', default='ja')
    d.add_argument('--max', type=int, help='칸 글자 수(기본 렌더러 CAP_MAX[lang])')
    d.add_argument('--gap', type=float, default=0.25)
    c = sub.add_parser('check')
    c.add_argument('plans', nargs='+')
    c.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    if a.cmd == 'draft':
        cards, cut = draft(R.words_of(a.transcript), a.t0, a.t1, a.max or RR.CAP_MAX[a.lang], a.gap)
        print(json.dumps(cards, ensure_ascii=False))
        if cut:  # out 바로 뒤 TAIL 을 넘겨 잘리는 토큰(렌더러가 안 받는다) — 말이 끊기는지 눈으로 확인
            print('  ! out 에서 잘리는 토큰: %s' % cut, file=sys.stderr)
        return 0

    bad = 0
    rep = {}
    for pf in a.plans:
        issues = check_plan(pf)
        rep[pf] = [{'clip': k, 'kind': kind, 'msg': msg} for k, kind, msg in issues]
        name = Path(pf).resolve().parent.name
        for k, kind, msg in issues:
            if kind != 'leftover':
                bad += 1
            if not a.json:
                print('%s #%d %s %s' % (name, k, kind, msg))
    if a.json:
        print(json.dumps({'ok': bad == 0, 'bad': bad, 'plans': rep}, ensure_ascii=False, indent=2))
    else:
        print('불일치·초과 %d건' % bad)
    return 4 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
