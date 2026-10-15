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
