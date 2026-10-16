# -*- coding: utf-8 -*-
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import ja_politics_script_check as C  # noqa: E402

SPEECH = '○高市内閣総理大臣　お答えいたします。食料品の消費税率を一年間一パーセントとします。財源は確保いたします。'

GOOD = {
    'no': 1, 'title': '食料品消費税1%', 'question': 'なぜ1%なのか',
    'summary': '政府は食料品の消費税率を一年間1%とする方針を示した。',
    'subjects': [{'name': '高市早苗', 'public_role': '内閣総理大臣', 'speaker_group': '自由民主党'}],
    'public_interest': '税制は国民生活に直結する公共の利害に関する事実である。',
    'timeline': [['2026.10.07', '衆議院本会議で答弁', 's1']],
    'facts_confirmed': [{'text': '一年間1%とする方針', 'source_id': 's1'}],
    'allegations': [{'text': '財源が不足すると野党は主張している', 'by': '立憲民主党', 'source_id': 's1'}],
    'sides': {'ours': {'position': '物価高対策として必要'}, 'other': {'position': '財源の裏付けがない'}},
    'quotes': [
        {'side': 'ours', 'origin': 'kokkai', 'src': 'src/a.mp4', 'in': 10.0, 'out': 22.0, 'speaker': '高市早苗',
         'tag': '衆議院本会議 · 2026.10.07', 'text': '食料品の消費税率を一年間一パーセントとします。',
         'minutes': {'speechURL': 'https://kokkai.ndl.go.jp/txt/x/1', 'speechID': 'x_1', 'speech': SPEECH},
         'phrases': ['一年間*一パーセント*']},
        {'side': 'ours', 'origin': 'kantei', 'src': 'src/k.mp4', 'in': 0.0, 'out': 90.0, 'speaker': '高市早苗',
         'tag': '総理会見 · 2026.10.08', 'text': '国民の皆様の暮らしを守ります。', 'source': '出典: 首相官邸(加工して作成)'},
    ],
    'sources': [{'id': 's1', 'url': 'https://www.kantei.go.jp/x', 'outlet': '首相官邸', 'date': '2026-10-07'}],
    'script': [{'type': 'nar', 'text': 'あ' * 800}, {'type': 'quote', 'q': 0}, {'type': 'nar', 'text': 'い' * 100},
               {'type': 'quote', 'q': 1}],
}


def ids(issues, level='FAIL'):
    return {cid for lv, cid, _ in issues if lv == level}


class JaPoliticsCheckTest(unittest.TestCase):
    def test_good_passes(self):
        self.assertEqual(ids(C.check(GOOD)), set())

    def test_kokkai_over_20s_and_banned_source(self):
        s = copy.deepcopy(GOOD)
        s['quotes'][0]['out'] = 35.0
        s['quotes'][1]['source'] = '出典: gov-online'
        self.assertEqual(ids(C.check(s)), {'SRC'})
        s = copy.deepcopy(GOOD)
        s['quotes'][1]['out'] = 900.0  # kantei 는 길이 제한 없음
        self.assertEqual(ids(C.check(s)), set())

    def test_no_minutes_is_warn_not_fail(self):
        s = copy.deepcopy(GOOD)
        del s['quotes'][0]['minutes']['speech']
        s['quotes'][0]['minutes']['speechURL'] = ''
        self.assertEqual(ids(C.check(s)), set())
        self.assertIn('D3', ids(C.check(s), 'WARN'))

    def test_minutes_mismatch_and_cut_quote(self):
        s = copy.deepcopy(GOOD)
        s['quotes'][0]['text'] = '食料品の消費税率をゼロにします。'
        s['quotes'][0]['phrases'] = []
        self.assertIn('D3', ids(C.check(s)))
        s = copy.deepcopy(GOOD)
        s['quotes'][0]['text'] = '一年間一パーセントとします。'
        s['quotes'][0]['phrases'] = []
        self.assertIn('D7', ids(C.check(s)))

    def test_defamation_rules(self):
        s = copy.deepcopy(GOOD)
        s['subjects'][0]['public_role'] = ''
        s['public_interest'] = ''
        s['allegations'][0]['text'] = '財源が不足している'
        s['script'][0]['text'] = '野党議員は売国奴です。'
        s['facts_confirmed'][0]['source_id'] = 's9'
        self.assertTrue({'D1', 'D2', 'D3', 'D4', 'D5'} <= ids(C.check(s)))
        s = copy.deepcopy(GOOD)
        s['script'][2]['text'] = '立憲民主党は反対しています。'
        self.assertIn('D6', ids(C.check(s), 'WARN'))

    def test_ratio_and_factcheck(self):
        fr = C.frames()
        s = copy.deepcopy(GOOD)
        s['script'][0]['text'] = 'あ' * 50  # 해설 ≈27초 vs 원음 102초
        extra, _, _ = C.ratio_check([s], fr, episode=False)
        self.assertEqual(ids(extra, 'WARN'), {'RATIO'})
        extra, _, _ = C.ratio_check([s], fr, episode=True)
        self.assertEqual(ids(extra), {'RATIO', 'LEN'})
        s['text_cards'] = [{'text': 'う' * 1000}]  # 글자 카드는 해설로 센다
        s['script'].append({'type': 'card', 'c': 0})
        extra, nar, _ = C.ratio_check([s], fr, episode=False)
        self.assertEqual(ids(extra, 'WARN'), set())
        self.assertAlmostEqual(nar, (50 + 100 + 1000) / 5.6, places=1)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'issues' / '1.json'
            p.parent.mkdir()
            self.assertIn('F1', ids(C.check(GOOD, fr, p)))
            (Path(d) / 'factcheck').mkdir()
            fc = Path(d) / 'factcheck' / 'script_1.md'
            fc.write_text('| 문장 | 판정 |\n|---|---|\n| a | 틀림 |\n', encoding='utf-8')
            self.assertIn('F1', ids(C.check(GOOD, fr, p)))
            fc.write_text('| 문장 | 판정 |\n|---|---|\n| a | 맞음 |\n', encoding='utf-8')
            self.assertNotIn('F1', ids(C.check(GOOD, fr, p)))

    def test_pair_and_shorts(self):
        self.assertIn('PAIR', ids(C.check(GOOD), 'WARN'))
        s = copy.deepcopy(GOOD)
        s['quotes'][0].update(q_pair='p1', q_role='ask')
        s['quotes'][1].update(q_pair='p1', q_role='answer')
        self.assertNotIn('PAIR', ids(C.check(s), 'WARN'))
        fr = C.frames()
        sh = copy.deepcopy(GOOD)
        sh['quotes'][0]['out'] = 20.0
        sh['script'] = [{'type': 'nar', 'text': 'あ' * 350}, {'type': 'quote', 'q': 0}]  # 해설 62.5초 + 원음 10초 = 86%
        extra, _, _ = C.ratio_check([sh], fr, False, shorts=True)
        self.assertEqual(ids(extra), set())
        sh['quotes'][0]['out'] = 30.0  # 원음 20초 > 15초
        extra, _, _ = C.ratio_check([sh], fr, False, shorts=True)
        self.assertIn('RATIO', ids(extra))


if __name__ == '__main__':
    unittest.main()
