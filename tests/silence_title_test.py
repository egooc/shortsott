# -*- coding: utf-8 -*-
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import silence_gap as SG  # noqa: E402
import title_lint as TL  # noqa: E402


class SilenceGapTest(unittest.TestCase):
    def test_gaps_cut_edges_and_allow(self):
        sil = [(0.0, 0.4), (2.0, 2.6), (5.0, 5.2), (8.0, 10.0)]
        # 앞 0.4 는 edge 로 빠짐, 2.0~2.6 갭, 5.0~5.2 는 짧음, 끝 8~10 은 end:2 허용
        self.assertEqual(SG.gaps(sil, 10.0, 0.5, SG.parse_allow(['end:2'], 10.0)), [(2.0, 2.6)])
        self.assertEqual(SG.gaps(sil, 10.0, 0.5, SG.parse_allow(['1.9-2.7', 'end:2'], 10.0)), [])
        # 허용 구간이 갭 가운데만 자르면 남은 조각 중 0.35초+ 만
        self.assertEqual(SG.gaps([(2.0, 3.0)], 10.0, 0.5, [(2.2, 2.5)]), [(2.5, 3.0)])

    def test_real_audio(self):
        if not shutil.which('ffmpeg'):
            self.skipTest('ffmpeg 없음')
        with tempfile.TemporaryDirectory() as d:
            w = os.path.join(d, 'a.wav')
            # 소리 1초 · 무음 0.6초 · 소리 1초 · 무음 0.2초 · 소리 1초
            f = ('sine=f=440:d=1[a];anullsrc=d=0.6[b];sine=f=440:d=1[c];anullsrc=d=0.2[e];sine=f=440:d=1[g];'
                 '[a][b][c][e][g]concat=n=5:v=0:a=1')
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-filter_complex', f, '-ar', '16000', w], check=True)
            found = SG.gaps(SG.detect(w), SG.duration(w))
            self.assertEqual(len(found), 1)
            self.assertAlmostEqual(found[0][0], 1.0, delta=0.05)
            self.assertEqual(SG.main([w]), 4)
            self.assertEqual(SG.main([w, '--allow', '0.9-1.7']), 0)


class TitleLintTest(unittest.TestCase):
    def levels(self, t, **k):
        return {(lv, r) for lv, r, _ in TL.lint(t, **k)}

    def test_politics_longform_regression(self):
        # 10/15·10/16 쟁점브리핑 롱폼 실제 제목 — 75자·77자라 T3 기준이면 반려
        t15 = '"틀렸으면 꼬리를 내릴 줄 알아야지" 서영교, 주진우 직격… 조희대 선서 거부·윤석열 영치금 22억 | 국정감사 쟁점 브리핑 10.15'
        t16 = '"솔직히 기억은 나지 않습니다" 오세훈, 한강버스 수사의뢰서 추궁에… 조희대 재제청·막말 3인방 제명론 | 국정감사 쟁점 브리핑 10.16'
        self.assertIn(('FAIL', 'length'), self.levels(t15))
        self.assertIn(('FAIL', 'length'), self.levels(t16))

    def test_good_and_rules(self):
        self.assertEqual(TL.lint('오세훈 "기억 안 나" | 한강버스 쟁점 10.16'), [])
        self.assertIn(('FAIL', 'separator'), self.levels('구분자 없는 제목 오세훈 한강버스 10.16'))
        self.assertIn(('WARN', 'separator_space'), self.levels('오세훈 "기억 안 나"|한강버스 쟁점 10.16 정리'))
        self.assertIn(('WARN', 'number'), self.levels('오세훈 기억 안 난다는 답변 | 한강버스 쟁점 정리'))
        self.assertIn(('FAIL', 'banned'), self.levels('빨갱이 소리 들은 의원 | 국감 쟁점 10.16 정리'))
        self.assertIn(('FAIL', 'banned'), self.levels('立憲議員が発狂した理由 | 争点ブリーフィング10月', lang='ja'))
        self.assertNotIn(('WARN', 'number'), self.levels('高市総理の答弁を三分で | 争点ブリーフィング解説', lang='ja'))

    def test_politics_ja_lane(self):
        self.assertEqual(TL.main(['高市総理、消費税1%の理由 | 争点まとめ', '--lane', 'politics_ja']), 0)
        self.assertEqual(TL.main(['高市総理が野党を論破した日 | 消費税1%', '--lane', 'politics_ja']), 4)
        mock = TL.LANES['politics_ja']['mock']
        self.assertIn(('FAIL', 'mock'), self.levels('野党撃沈 | 消費税1%の国会答弁まとめ', lang='ja', mock=mock))
        # 16~30자: 31자면 WARN(40 넘으면 FAIL 은 그대로)
        self.assertIn(('WARN', 'length'), self.levels('あ' * 14 + ' | ' + 'い' * 14 + '1', lang='ja', mn=16, mx=30))
        # 쇼츠 레인은 구분자 없이 통과, 롱폼 레인은 구분자 없으면 FAIL
        self.assertEqual(TL.main(['なぜ消費税は1%になったのか', '--lane', 'politics_ja_short']), 0)
        self.assertEqual(TL.main(['なぜ消費税は1%になったのか', '--lane', 'politics_ja']), 4)


if __name__ == '__main__':
    unittest.main()
