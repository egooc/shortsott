# -*- coding: utf-8 -*-
import copy
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import arabshot_kit as K  # noqa: E402

KITS = Path(__file__).resolve().parents[1] / 'kits' / 'arabshot'


def load(name):
    return json.loads((KITS / name / 'kit.json').read_text(encoding='utf-8'))


def fails(kit):
    return {(a, m.split()[0]) for lv, a, m in K.check(kit) if lv == 'FAIL'}


class ArabshotKitTest(unittest.TestCase):
    def test_real_n100_sample_passes(self):
        # N100 10-16 실제 샘플(ko_mon frames · bike TPL · ott170-ko 설명란 · channels ko_mon) — 검사기 회귀
        self.assertEqual(fails(load('ko_mon_sample')), set())
        self.assertEqual(fails(load('ko_factory')), set())

    def test_catches_n100_gate_mistakes(self):
        k = load('ko_factory')
        bad = copy.deepcopy(k)
        bad['tpl']['cap']['y'] = 1500
        bad['tpl']['cap']['c'] = '#FFFFFF'          # TPL 은 &H 색
        bad['desc']['credit'] = 'u/someone'
        bad['desc']['hashtags'] = ['#공장']
        bad['channel']['look']['band'] = '&H00FFFFFF'  # channels 는 #RRGGBB
        bad['d'] = [3, 11]
        areas = {a for a, _ in fails(bad)}
        self.assertEqual(areas, {'tpl', 'desc', 'channel', 'frames'})
        # tpl: y>1440 · &H 색 · (y 1500 이면 shorts_safe 안전 영역도 FAIL) / desc: r·u/ · #shorts / channel: band / frames: d
        self.assertGreaterEqual(len(fails(bad)), 6)

    def test_video_box_bottom(self):
        k = load('ko_factory')
        self.assertEqual([m for lv, a, m in K.check(k) if a == 'tpl'], [])
        k['tpl']['box'] = [0, 380, 1080, 1080]  # 아래 끝 1460 — N100 실측 subject_low WARN
        self.assertEqual(len([m for lv, a, m in K.check(k) if lv == 'WARN' and a == 'tpl']), 1)

    def test_range_warnings(self):
        k = load('ko_factory')
        k['seconds'] = [20, 25]  # 초당 글자 8~11.8 · 컷당 1.5~2.5초
        warns = [m for lv, a, m in K.check(k) if lv == 'WARN' and a == 'frames']
        self.assertEqual(len(warns), 2, warns)

    def test_build_writes_n100_formats(self):
        with tempfile.TemporaryDirectory() as d:
            dst = Path(d) / 'ko_factory'
            shutil.copytree(KITS / 'ko_factory', dst)
            self.assertEqual(K.main(['build', str(dst / 'kit.json')]), 0)
            fr = json.loads((dst / 'frames.json').read_text(encoding='utf-8'))
            self.assertEqual(list(fr), ['ko_factory'])
            self.assertEqual(fr['ko_factory']['cuts'], [10, 13])
            line = (dst / 'tpl.py').read_text(encoding='utf-8').splitlines()[1]
            self.assertTrue(line.startswith("'factory': dict(bg='blur', box=(0, 380, 1080, 1070), cap=dict(mode='pop'"))
            ch = json.loads((dst / 'channels.json').read_text(encoding='utf-8'))['ko_factory']
            self.assertEqual((ch['template'], ch['slots_kst'], ch['handle']), ('factory', [12], '@라이드랩z'))
            self.assertIn('위험 행위', (dst / 'guide.md').read_text(encoding='utf-8'))
            desc = json.loads((dst / 'desc.json').read_text(encoding='utf-8'))
            self.assertTrue(desc['description'].endswith('🎥 @원작자'))


if __name__ == '__main__':
    unittest.main()
