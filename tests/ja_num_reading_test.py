# -*- coding: utf-8 -*-
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from ja_num_reading import reading, int_kanji, fill_script  # noqa: E402


class JaNumReadingTest(unittest.TestCase):
    def test_supertonic_misreads_regression(self):
        # 10-16 Supertonic 실측 오독 사례(reference/ja/tts-samples/NOTES.md)
        self.assertEqual(reading('衆議院の定数は465で'), '衆議院の定数は四百六十五で')
        self.assertEqual(reading('過半数の233議席'), '過半数の二百三十三議席')
        self.assertEqual(reading('投票率は53.85%でした'), '投票率は五十三点八五パーセントでした')
        self.assertEqual(reading('前の年度より3.2%増えました'), '前の年度より三点二パーセント増えました')
        self.assertEqual(reading('2026年度予算案'), '二千二十六年度予算案')
        self.assertEqual(reading('総額は115兆5千億円'), '総額は百十五兆五千億円')
        self.assertEqual(reading('二〇二六年度'), '二千二十六年度')
        self.assertEqual(reading('三・二パーセント'), '三点二パーセント')

    def test_units_and_commas(self):
        self.assertEqual(int_kanji(1000), '千')
        self.assertEqual(int_kanji(10000), '一万')
        self.assertEqual(int_kanji(1845), '千八百四十五')
        self.assertEqual(int_kanji(100000000), '一億')
        self.assertEqual(reading('約1,200,000人'), '約百二十万人')
        self.assertEqual(reading('０．５％'), '〇点五パーセント'.replace('〇', 'ゼロ'))

    def test_fraction_and_untouched_words(self):
        self.assertEqual(reading('3分の1'), '三分の一')
        self.assertEqual(reading('1/3が反対'), '三分の一が反対')
        self.assertEqual(reading('一つの理由'), '一つの理由')  # 〇 없는 한자 낱말은 그대로
        self.assertEqual(reading('十手は36センチ'), '十手は三十六センチ')

    def test_fill_script_keeps_existing_read(self):
        s = {'lines': [{'text': '1845年7月18日'}, {'text': '数字なし'}, {'text': '5月', 'read': 'ごがつ'}]}
        self.assertEqual(fill_script(s), 1)
        self.assertEqual(s['lines'][0]['read'], '千八百四十五年七月十八日')
        self.assertNotIn('read', s['lines'][1])
        self.assertEqual(s['lines'][2]['read'], 'ごがつ')


if __name__ == '__main__':
    unittest.main()
