# -*- coding: utf-8 -*-
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import jidaigeki_watch as J  # noqa: E402

T = dt.date(2026, 10, 16)


class WindowTest(unittest.TestCase):
    def st(self, text, pub='2026-06-27'):
        w = J.parse_window(text, pub)
        return w, J.window_status(w, T)

    def test_haishin_kikan_until(self):
        # 必殺仕事人Ⅴ·激闘編 설명란(발굴 10-16 실측)
        w, s = self.st('40周年記念 全33話を毎週土曜20時に順次配信\n配信期間：2026年10月14日まで')
        self.assertEqual(w['end'], dt.date(2026, 10, 14))
        self.assertEqual(s, '기간 경과')

    def test_title_two_week_window(self):
        # 柳生三代の剣 第11話 제목 «※10/14-10/27無料公開»
        w, s = self.st('ドラマ「徳川武芸帳 柳生三代の剣」[第11話]【公式】※10/14-10/27無料公開', '2026-10-14')
        self.assertEqual((w['start'], w['end']), (dt.date(2026, 10, 14), dt.date(2026, 10, 27)))
        self.assertTrue(s.startswith('공개 중'))

    def test_same_month_short_end(self):
        # 映画 愛と誠 «10/2～15無料公開»
        w, s = self.st('映画「愛と誠」※10/2～15無料公開', '2026-10-02')
        self.assertEqual(w['end'], dt.date(2026, 10, 15))
        self.assertEqual(s, '기간 경과')

    def test_from_only_is_no_limit(self):
        w, s = self.st('「必殺仕事人Ⅲ」第1話【公式】※2025.11.19～無料公開', '2025-11-19')
        self.assertEqual((w['kind'], w['start']), ('from', dt.date(2025, 11, 19)))
        self.assertTrue(s.startswith('기한 없음'))
        w, _ = self.st('ドラマ「天下騒乱」第一部【公式】※3/18～無料公開', '2026-03-18')
        self.assertEqual(w['start'], dt.date(2026, 3, 18))

    def test_always_year_end_and_unknown(self):
        self.assertEqual(self.st('当チャンネルで常時無料公開となっている')[1], '상시 공개')
        w, s = self.st('【年内限定】「黒革の手帖」全6話 一挙無料公開！', '2026-09-01')
        self.assertEqual(w['end'], dt.date(2026, 12, 31))
        self.assertTrue(self.st('期間限定で配信中')[1].startswith('기간 미상'))
        self.assertEqual(self.st('本編です')[1], '기한 표기 없음')

    def test_relative_limited_from_publish(self):
        # 国際放映 «1週間限定無料配信»·«半年間限定», 新東宝 «2週間限定» — 공개일부터
        w, s = self.st('【名優・宝田明主演ドラマ・1週間限定無料配信】平四郎危機一発 第13話', '2026-10-12')
        self.assertEqual(w['end'], dt.date(2026, 10, 19))
        self.assertTrue(s.startswith('공개 중'))
        w, _ = self.st('【半年間限定無料配信】平四郎危機一発 第1話', '2026-05-01')
        self.assertEqual(w['end'], dt.date(2026, 10, 30))
        self.assertEqual(self.st('【2週間限定無料配信】北海の叛乱', '2026-09-01')[1], '기간 경과')

    def test_year_rollover(self):
        # 12월에 올린 «1/5まで» 류는 다음 해
        w, _ = self.st('※12/20-1/5無料公開', '2025-12-20')
        self.assertEqual(w['end'], dt.date(2026, 1, 5))

    def test_region(self):
        self.assertEqual(J.region_kr({'regionRestriction': {'allowed': ['JP']}})[0], False)
        self.assertEqual(J.region_kr({'regionRestriction': {'blocked': ['CN']}})[0], True)
        self.assertEqual(J.region_kr({})[0], True)
        self.assertAlmostEqual(J.iso_minutes('PT46M12S'), 46.2, places=1)


if __name__ == '__main__':
    unittest.main()
