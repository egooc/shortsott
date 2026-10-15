# -*- coding: utf-8 -*-
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import naze_script_check as N  # noqa: E402

BODY = [
    '刀の棟で打っても、相手の骨は簡単に折れます。',
    '鉄の棒で殴るのと、ほとんど変わらないからです。',
    'しかも打った側の刀も、無事では済みません。',
    '刀は刃の方向の力に強く作られています。',
    '棟の方向から強く当てると、曲がりやすいのです。',
    '曲がった刀は、鞘に戻らなくなります。',
    '戦いの最中に刀が使えなくなれば、命取りです。',
]


def good():
    lines = [{'text': '時代劇の峰打ち、実は相手の骨を折る技でした。'},
             {'text': '時代劇では、悪人を峰打ちで気絶させますよね。'},
             {'text': 'でも実際には、そんなに優しい技ではありません。'}]
    lines += [{'text': t} for t in BODY * 3]
    lines += [{'text': '刃筋を立てない一撃は、刀の寿命も縮めました。',
               'read': '刃筋を立てない一撃は、刀の寿命も縮めました。'},
              {'text': '峰打ちは、優しさではなく覚悟の技だったのです。'},
              {'text': '峰打ちのような時代劇の本当が気になる方は、高評価とチャンネル登録を。'}]
    return {'title': '時代劇の峰打ち、実際は相手を気絶させられた?', 'key': '峰打ち', 'lines': lines,
            'terms': ['棟', '刃筋'], 'sources': ['https://example.org/mineuchi'], 'contested': False}


class NazeScriptCheckTest(unittest.TestCase):
    def ids(self, s, level='FAIL'):
        return {i for lv, i, _ in N.check(s) if lv == level}

    def test_good_passes(self):
        self.assertEqual(self.ids(good()), set())
        self.assertEqual(self.ids(good(), 'WARN'), set())

    def test_question_hook_fails(self):
        s = good()
        s['lines'][0]['text'] = '峰打ちで、本当に気絶させられたのでしょうか?'
        self.assertIn('N2', self.ids(s))

    def test_length_window(self):
        s = good()
        s['lines'] = s['lines'][:3] + s['lines'][-2:]
        self.assertIn('N3', self.ids(s))
        s = good()
        s['lines'][3:3] = [{'text': t} for t in BODY * 4]
        self.assertIn('N3', self.ids(s))

    def test_closing_and_cta_need_key(self):
        s = good()
        s['lines'][-2]['text'] = 'それが本当の姿だったのです。'
        s['lines'][-1]['text'] = '気になる方は、高評価とチャンネル登録を。'
        self.assertTrue({'N6', 'N7'} <= self.ids(s))

    def test_numbers_must_be_kanji_in_read(self):
        s = good()
        s['lines'][4] = {'text': '刀の重さは約1.2kgです。'}
        self.assertIn('N9', self.ids(s))
        s['lines'][4] = {'text': '刀の重さは約1.2kgです。', 'read': '刀の重さは約一点二キロです。'}
        self.assertNotIn('N9', self.ids(s))
        s['lines'][4] = {'text': '率は3.2%です。', 'read': '率は三・二パーセントです。'}
        self.assertIn('N9', self.ids(s))

    def test_sources_and_contested(self):
        s = good()
        s['sources'] = []
        s['contested'] = True
        self.assertTrue({'N8', 'N10'} <= self.ids(s))
        s = copy.deepcopy(good())
        s['contested'] = True
        s['lines'][5]['text'] = '刀が折れたという話も、諸説あります。'
        self.assertNotIn('N10', self.ids(s))

    def test_title_and_scene_warn(self):
        s = good()
        s['title'] = '峰打ちの真実'
        s['lines'][1]['text'] = '悪人を棟で打って気絶させる場面があります。'
        self.assertIn('N1', self.ids(s))
        self.assertIn('N11', self.ids(s, 'WARN'))


if __name__ == '__main__':
    unittest.main()
