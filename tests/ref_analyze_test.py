# -*- coding: utf-8 -*-
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import ref_analyze as R  # noqa: E402


class RefAnalyzeTest(unittest.TestCase):
    def test_json3_words_and_sentences(self):
        d = {'events': [{'tStartMs': 1000, 'dDurationMs': 2000, 'segs': [{'utf8': '>> 여기'}, {'utf8': ' 진짜', 'tOffsetMs': 400}]},
                        {'tStartMs': 2000, 'segs': [{'utf8': '\n'}]},
                        {'tStartMs': 2200, 'dDurationMs': 800, 'segs': [{'utf8': '좋다.'}]},
                        {'tStartMs': 5000, 'dDurationMs': 900, 'segs': [{'utf8': '얼마예요'}]}]}
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / 'a.ko.json3'
            f.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
            w = R.words_from_json3(f)
        self.assertEqual([x[2] for x in w], ['여기', '진짜', '좋다.', '얼마예요'])
        self.assertEqual(w[0][:2], [1.0, 1.4])
        s = R.sentences(w, 'ko')
        self.assertEqual([x['text'] for x in s], ['여기 진짜 좋다.', '얼마예요'])  # 구두점 · 0.7초+ 쉼에서 끊는다
        self.assertEqual(R.first_type('얼마예요', 'ko'), 'statement')
        self.assertEqual(R.first_type('이게 만 원이라고?', 'ko'), 'question')
        self.assertEqual(R.first_type('여기 3천 원입니다', 'ko'), 'number')

    def test_pick_excludes_young_and_private(self):
        now = dt.datetime(2026, 10, 16, tzinfo=dt.timezone.utc)
        mk = lambda i, days, v, p='public': {'id': str(i), 'pub': (now - dt.timedelta(days=days)).isoformat(), 'views': v,
                                             'privacy': p, 'sec': 40}
        rows = [mk(i, 5 + i, 100 * (i + 1)) for i in range(10)] + [mk('new', 1, 10 ** 7), mk('priv', 10, 10 ** 7, 'private')]
        pool, top, bot = R.pick(rows, 4, now)
        self.assertNotIn('new', [r['id'] for r in pool])
        self.assertNotIn('priv', [r['id'] for r in pool])
        self.assertEqual([r['id'] for r in top], ['9', '8'])
        self.assertEqual([r['id'] for r in bot], ['1', '0'])

    def test_compare_ranks_biggest_gap(self):
        top = [{'speech_share': 0.9, 'sec': 40, 'title_digit': True, 'first_type': 'question'} for _ in range(4)]
        bot = [{'speech_share': 0.3 + i * 0.01, 'sec': 40 + i, 'title_digit': False, 'first_type': 'statement'} for i in range(4)]
        d = R.compare(top, bot)
        self.assertIn(d[0]['key'], ('speech_share', 'title_digit', 'first_type=question', 'first_type=statement'))
        self.assertLess(abs([x for x in d if x['key'] == 'sec'][0]['effect']), abs(d[0]['effect']))

    def test_missing_transcript_is_not_silence(self):
        top = [{'source': 'auto', 'speech_share': 0.9, 'title_chars': 20} for _ in range(4)]
        bot = [{'source': 'none', 'speech_share': 0.0, 'title_chars': 30 + i} for i in range(4)]
        keys = {x['key'] for x in R.compare(top, bot)}
        self.assertNotIn('speech_share', keys)  # 하위군 전사가 없으면 원고 칸은 비교하지 않는다
        self.assertIn('title_chars', keys)

    def test_speech_union(self):
        r = {'id': 'x', 'views': 1, 'sec': 10}
        row = R.script_row(r, [[0, 4, '가'], [1, 5, '나'], [8, 9, '다']], 'ko', 'auto')
        self.assertEqual(row['speech_share'], 0.6)

    def test_gate(self):
        self.assertEqual(R.gate({}, '2026-10-16')[0], True)
        self.assertEqual(R.gate({'2026-10-16': {'runs': 1, '429': 1}}, '2026-10-16')[0], False)
        self.assertEqual(R.gate({'2026-10-16': {'runs': 3, '429': 0}}, '2026-10-16')[0], False)
        self.assertEqual(R.gate({'2026-10-15': {'runs': 3, '429': 1}}, '2026-10-16')[0], True)

    def test_bad_transcript_excluded_from_text_cells(self):
        self.assertFalse(R.transcript_ok('이들도我的話我的愛是我為你付出的愛我的話', 'ko'))
        self.assertTrue(R.transcript_ok('그거 알지? 여기 진짜 좋다', 'ko'))
        top = [{'source': 'auto', 'transcript_ok': i > 0, 'first_type': 'question', 'first_speech_sec': 1.0 + i * 0.1}
               for i in range(4)]
        bot = [{'source': 'auto', 'transcript_ok': True, 'first_type': 'statement', 'first_speech_sec': 3.0 + i * 0.1}
               for i in range(4)]
        d = {x['key']: x for x in R.compare(top, bot)}
        self.assertEqual(d['first_type=question']['top'], 1.0)  # 오류 1편 빼고 3편
        self.assertIn('first_speech_sec', d)

    def test_playlist_choice(self):
        c = {'id': 'UCabc123', 'contentDetails': {'relatedPlaylists': {'uploads': 'UUabc123'}}}
        self.assertEqual(R.playlist_id(c), 'UUabc123')
        self.assertEqual(R.playlist_id(c, shorts=True), 'UUSHabc123')
        self.assertEqual(R.playlist_id(c, long=True), 'UULFabc123')


if __name__ == '__main__':
    unittest.main()
