# -*- coding: utf-8 -*-
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import ja_numread as N  # noqa: E402


class JaNumreadTest(unittest.TestCase):
    def test_readings(self):
        self.assertEqual(N.to_read('8,052円'), '八千五十二円')   # nenkin 오독 사고
        self.assertEqual(N.to_read('11万3600円'), '十一万三千六百円')
        self.assertEqual(N.to_read('82万6500円'), '八十二万六千五百円')
        self.assertEqual(N.to_read('5.105パーセント'), '五点一〇五パーセント')
        self.assertEqual(N.to_read('1000万円と110円'), '千万円と百十円')
        self.assertEqual(N.to_read('令和9年分、9月7日'), '令和九年分、九月七日')

    def test_round_trip(self):
        for s in ('年およそ11万3600円', '2月から10月までの5回分で、7000円', '62万円超85万円以下', '1億2000万3円', '0円'):
            read, ok, a, k = N.check_line(s)
            self.assertTrue(ok, (s, read, a, k))

    def test_check_catches_misread(self):
        # 사람이 손으로 고친 읽기가 값을 바꾸면 잡는다
        self.assertNotEqual(N.values_arabic('8,052円'), N.values_kanji('八万五十二円'))

    def test_say_kana_for_money(self):
        # 10-17 역전사 실측: 한자로는 5.105→5.15, 3万4500→3万1500 으로 들렸다
        self.assertEqual(N.to_say('年およそ3万4500円'), '年およそさんまんよんせんごひゃく円')
        self.assertEqual(N.to_say('5.105パーセント'), 'ごてんいちゼロごパーセント')
        self.assertEqual(N.to_say('8,052円'), 'はっせんごじゅうに円')
        self.assertEqual(N.to_say('300万円と600円'), 'さんびゃくまん円とろっぴゃく円')
        self.assertEqual(N.to_say('73歳'), '七十三歳')   # 조수사는 한자


if __name__ == '__main__':
    unittest.main()
