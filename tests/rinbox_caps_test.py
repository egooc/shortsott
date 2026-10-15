# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import rinbox_caps as C  # noqa: E402
import rinbox_render as RR  # noqa: E402

# 10.0~13.0 구간: 「それは」「光栄だな」 / 쉼 0.5 / 「来て」「くださる」 / 컷 끝 13.0 을 0.2 넘는 꼬리 「ね」 / 0.5 넘는 「よ」
WORDS = [[10.0, 10.4, 'それは'], [10.4, 11.0, '光栄だな'], [11.5, 11.8, '来て'], [11.8, 12.6, 'くださる'],
         [12.7, 13.2, 'ね'], [12.9, 13.5, 'よ']]


def plan(d, seq, lang='ja'):
    tr = os.path.join(d, 'transcript.json')
    with open(tr, 'w', encoding='utf-8') as f:
        f.write(json.dumps(WORDS, ensure_ascii=False) + '\n')
    p = os.path.join(d, 'plan.json')
    with open(p, 'w', encoding='utf-8') as f:
        f.write(json.dumps({'transcript': tr, 'lang': lang, 'sequence': seq}, ensure_ascii=False, indent=2) + '\n')
    return p


class RinboxCapsTest(unittest.TestCase):
    def w(self):
        return [tuple(x) for x in WORDS]

    def test_tokens_in_matches_card_times(self):
        # 초안용 토큰 범위가 렌더러 card_times 와 같아야 한다(꼬리 0.3초 안 「ね」 받고, 넘는 「よ」 안 받음)
        toks = C.tokens_in(self.w(), 10.0, 13.0)
        self.assertEqual([x for _, _, x in toks], ['それは', '光栄だな', '来て', 'くださる', 'ね'])
        got = RR.card_times(self.w(), 10.0, 13.0, [x for _, _, x in toks], '')
        self.assertEqual([(a, b) for a, b, _ in got], [(s, e) for s, e, _ in toks])
        with self.assertRaises(SystemExit):
            RR.card_times(self.w(), 10.0, 13.0, [x for _, _, x in toks] + ['よ'], '')

    def test_draft_splits_on_gap_and_max(self):
        cards, cut = C.draft(self.w(), 10.0, 13.0, 11)
        self.assertEqual(cards, ['それは光栄だな', '来てくださるね'])
        self.assertEqual(cut, ['よ'])
        cards, _ = C.draft(self.w(), 10.0, 13.0, 5)
        self.assertEqual(cards, ['それは', '光栄だな', '来て', 'くださるね'])

    def test_check_pass_mismatch_long_leftover(self):
        with tempfile.TemporaryDirectory() as d:
            ok = plan(d, [{'source_in': 10.0, 'source_out': 13.0, 'captions': ['それは光栄だな', '来てくださるね']}])
            self.assertEqual(C.check_plan(ok), [])
            self.assertEqual(C.main(['check', ok]), 0)
        with tempfile.TemporaryDirectory() as d:
            p = plan(d, [{'source_in': 10.0, 'source_out': 13.0, 'captions': ['それは光栄だ', 'な来てくださるね']},
                         {'source_in': 10.0, 'source_out': 13.0, 'captions': ['それは光栄だな来てくださるね']},
                         {'source_in': 10.0, 'source_out': 13.0, 'captions': ['それは光栄だな']},
                         {'source_in': 10.0, 'source_out': 13.0,
                          'captions': ['それは光栄だな', '来てくだはる|来てくださるね']}])
            kinds = [(k, kind) for k, kind, _ in C.check_plan(p)]
            self.assertIn((0, 'mismatch'), kinds)
            self.assertIn((1, 'too_long'), kinds)
            self.assertIn((2, 'leftover'), kinds)
            self.assertIn((3, 'mismatch'), kinds)  # 토큰 쪽을 고치면 안 된다 — 보일글만 고친다
            self.assertEqual(C.main(['check', p]), 4)

    def test_c_regression_three_mismatches(self):
        # 10-15 C: 손자막 토큰 불일치 3건으로 렌더가 3번 멈췄다 — 렌더 전에 3건 모두 한 번에 잡혀야 한다
        with tempfile.TemporaryDirectory() as d:
            bad = ['それわ光栄だな', '来てくださるね']
            p = plan(d, [{'source_in': 10.0, 'source_out': 13.0, 'captions': bad}] * 3 + [{'kind': 'narration'}])
            self.assertEqual(len([1 for _, kind, _ in C.check_plan(p) if kind == 'mismatch']), 3)

    def test_real_plans_if_present(self):
        p = 'D:/volcano-runs/rinbox104ja/plan_local.json'
        if not os.path.exists(p):
            self.skipTest('린박스 런 폴더 없음')
        issues = C.check_plan(p)
        self.assertEqual([kind for _, kind, _ in issues], ['leftover'])  # C checkcap 과 같은 결과(「で」)


if __name__ == '__main__':
    unittest.main()
