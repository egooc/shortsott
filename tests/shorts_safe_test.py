# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import shorts_safe as ss  # noqa: E402

HEAD = """[Script Info]
PlayResX: {px}
PlayResY: {py}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: NAR,Pretendard,{fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass(lines, px=1080, py=1920, fs=64):
    return HEAD.format(px=px, py=py, fs=fs) + '\n'.join(
        'Dialogue: 0,0:00:0%d.00,0:00:0%d.00,NAR,,0,0,0,,%s' % (i, i + 1, t) for i, t in enumerate(lines)) + '\n'


class ShortsSafeTest(unittest.TestCase):
    def fails(self, text):
        return [r for r in ss.check_ass(text) if any(i[0] == 'FAIL' for i in r['issues'])]

    def test_made_template_y1745_fails(self):
        # 10-16 소유주 지적: 엔진룸 made 내레이션 y=1745
        f = self.fails(ass([r'{\an5\pos(540,1745)}공장 안에서 무슨 일이']))
        self.assertEqual(len(f), 1)
        self.assertIn('bottom_ui', [i[1] for i in f[0]['issues']])

    def test_fixed_y1440_passes(self):
        self.assertEqual(self.fails(ass([r'{\an5\pos(540,1440)}공장 안에서 무슨 일이'])), [])

    def test_zou_y1600_and_home_y1790_fail(self):
        self.assertEqual(len(self.fails(ass([r'{\an5\pos(540,1600)}象が', r'{\an5\pos(540,1790)}로봇']))), 2)

    def test_bottom_edge_over_1500_fails_even_with_center_ok(self):
        # 중심 1440, 3줄 64px → 아래 끝 약 1559
        f = self.fails(ass([r'{\an5\pos(540,1440)}한줄\N두줄\N세줄']))
        self.assertTrue(any('아래 끝' in i[2] for i in f[0]['issues']))

    def test_right_button_column(self):
        f = self.fails(ass([r'{\an6\pos(1010,1000)}좋아요']))
        rules = [i[1] for i in f[0]['issues']]
        self.assertIn('right_buttons', rules)

    def test_top_ui(self):
        f = self.fails(ass([r'{\an8\pos(540,60)}제목']))
        self.assertIn('top_ui', [i[1] for i in f[0]['issues']])

    def test_centered_too_wide(self):
        f = self.fails(ass([r'{\an5\pos(540,900)}' + '가' * 15]))  # 15 x 64 = 960 > 860
        self.assertIn('center_width', [i[1] for i in f[0]['issues']])

    def test_playres_scaling(self):
        # 540x960 캔버스의 y=872 = 1920 기준 1744
        self.assertEqual(len(self.fails(ass([r'{\an5\pos(270,872)}자막'], px=540, py=960, fs=32))), 1)
        self.assertEqual(self.fails(ass([r'{\an5\pos(270,720)}자막'], px=540, py=960, fs=32)), [])

    def test_style_alignment_margin_without_pos(self):
        text = ass(['자막']).replace(',5,0,0,0,1', ',2,0,0,200,1')  # an2, MarginV 200 → 아래 끝 1720
        self.assertEqual(len(self.fails(text)), 1)

    def test_drawing_and_empty_lines_ignored(self):
        self.assertEqual(ss.check_ass(ass([r'{\p1\pos(0,1800)}m 0 0 l 100 0', r'{\pos(540,1800)}'])), [])

    def test_template_check(self):
        tpl = {'elements': [
            {'name': 'made.narr', 'x': 540, 'y': 1745, 'an': 5, 'fs': 64, 'max_chars': 12},
            {'name': 'made.video', 'kind': 'video', 'box': [0, 460, 1080, 1460]},
            {'name': 'wild.narr', 'x': 540, 'y': 1330, 'an': 5, 'fs': 64, 'max_chars': 12},
        ]}
        issues = ss.check_template(tpl)
        self.assertTrue(any(lv == 'FAIL' and 'made.narr' in m for lv, _, m in issues))
        self.assertTrue(any(lv == 'WARN' and 'made.video' in m for lv, _, m in issues))
        self.assertFalse(any('wild.narr' in m for _, _, m in issues))

    def test_rinbox122ja_font_metrics_regression(self):
        # 10-16 C 실측: libass 는 크기를 줄 높이(Noto Sans JP 1.448em)로 쓴다. 제목 「岸に着いていた」 실폭 약 700(x 190~890)
        # 1em 으로 셈하던 첫 판은 1022 로 부풀어 120~122ja 가 전부 오탐 FAIL 이었다. 진짜 걸린 것은 출처 CR(중심 1539) 하나.
        path = os.path.join(os.path.dirname(__file__), 'fixtures', 'shorts_safe', 'rinbox122ja_cap.ass')
        if not ss.find_font('Noto Sans JP', True):
            self.skipTest('Noto Sans JP 글꼴 없음')
        with open(path, encoding='utf-8') as f:
            rows = ss.check_ass(f.read())
        t2 = next(r for r in rows if r['style'] == 'T2')
        self.assertTrue(680 <= t2['box'][2] - t2['box'][0] <= 730, t2['box'])
        self.assertFalse(any(r['estimated'] for r in rows))
        bad = {r['style'] for r in rows if any(i[0] == 'FAIL' for i in r['issues'])}
        self.assertEqual(bad, {'CR'})
        cap = max(r['box'][2] - r['box'][0] for r in rows if r['style'] == 'CAP')
        self.assertLess(cap, 640)

    def test_font_metrics_reader(self):
        f = ss.find_font('Noto Sans JP', True)
        if not f:
            self.skipTest('Noto Sans JP 글꼴 없음')
        self.assertEqual(ss.font_metrics(f), (1000, 1448))
        self.assertAlmostEqual(ss.em_size(146, f), 100.8, places=1)

    def test_decor_grade_downgrades_to_warn(self):
        tpl = {'elements': [
            {'name': 'ticker', 'box': [0, 1438, 1080, 1652], 'grade': 'decor'},
            {'name': 'bug', 'box': [800, 26, 1000, 70], 'grade': 'decor'},
            {'name': 'source', 'box': [60, 1520, 400, 1560]},
        ]}
        issues = ss.check_template(tpl)
        self.assertFalse(any(lv == 'FAIL' and ('ticker' in m or 'bug' in m) for lv, _, m in issues))
        self.assertTrue(any(lv == 'WARN' and 'ticker' in m for lv, _, m in issues))
        self.assertTrue(any(lv == 'FAIL' and 'source' in m for lv, _, m in issues))
        f = [r for r in ss.check_ass(ass([r'{\an5\pos(540,1745)}티커']), decor_styles={'NAR'})
             if any(i[0] == 'FAIL' for i in r['issues'])]
        self.assertEqual(f, [])

    def test_ass_with_frame_text_boxes(self):
        # 롱투숏: 제목은 ASS 가 아니라 frame.mov 에 그린다 → --tpl 로 상자를 같이 넣는다
        with tempfile.TemporaryDirectory() as d:
            a_ = os.path.join(d, 'cap.ass')
            with open(a_, 'w', encoding='utf-8') as f:
                f.write(ass([r'{\an5\pos(540,1200)}자막']))
            t = os.path.join(d, 'frame.json')
            with open(t, 'w', encoding='utf-8') as f:
                f.write('{"elements": [{"name": "frame.title", "box": [90, 80, 990, 280]}]}\n')
            self.assertEqual(ss.main([a_, '--no-preview']), 0)
            self.assertEqual(ss.main([a_, '--tpl', t, '--no-preview']), 4)

    def test_fonts_dir_next_to_ass(self):
        # N100: 편 폴더의 ASS 옆 fonts/ 에 글꼴이 있다 — 인자 없이 찾아야 한다
        src = ss.find_font('Noto Sans JP', True)
        if not src:
            self.skipTest('Noto Sans JP 글꼴 없음')
        import shutil
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, 'fonts'))
            shutil.copy(src, os.path.join(d, 'fonts', 'x.otf'))
            p = os.path.join(d, 'cap.ass')
            with open(p, 'w', encoding='utf-8') as f:
                f.write(ass([r'{\an5\pos(540,1200)}字幕']).replace('Pretendard', 'Noto Sans JP'))
            with open(p, encoding='utf-8') as f:
                rows = ss.check_ass(f.read(), font_dirs=(os.path.join(d, 'fonts'),))
            self.assertFalse(rows[0]['estimated'])

    def test_cli_exit_codes_and_preview(self):
        with tempfile.TemporaryDirectory() as d:
            bad = os.path.join(d, 'bad.ass')
            with open(bad, 'w', encoding='utf-8') as f:
                f.write(ass([r'{\an5\pos(540,1745)}자막']))
            good = os.path.join(d, 'good.ass')
            with open(good, 'w', encoding='utf-8') as f:
                f.write(ass([r'{\an5\pos(540,1440)}자막']))
            self.assertEqual(ss.main([bad, '--json']), 4)
            self.assertTrue(os.path.exists(os.path.join(d, 'qc', 'shorts_safe.jpg')))
            self.assertEqual(ss.main([good, '--no-preview']), 0)


if __name__ == '__main__':
    unittest.main()
