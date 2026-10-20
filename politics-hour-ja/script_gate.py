"""정치JA 원고 관문 — 원고 착수 전·TTS 전에 돈다(관리자 10-20 docs/materials-audit-20261020.md 4·6번, ref_overlap).

    python politics-hour-ja/script_gate.py <편 폴더> [--before-script]

① 후보표 = ko politics-hour/candidate_gate.py 를 import(사본 금지): keywords.json "candidates" 행마다
   keyword·rising_score·excerpt(官邸·国会 영상 출처·ID)·emotion_now(Z7 인물의 지금 대리만족 한 문장)·comment_count(Z12 댓글 수, JA 는 Yahoo!ニュース
   기사 댓글 수)·reason. 10/21편(폴더 이름 20261021)부터. 없으면 원고 착수 금지.
② (--before-script 가 아니면) 첫 말 인사 금지: 첫 해설·콜드오픈 문장이 인사·채널명·날짜 낭독이면 FAIL(관리자 §7 70초 규칙).
③ (--before-script 가 아니면) scripts/ref_overlap.py --lane politics_ja — 해설만(인용 quote·공문 원문 card 제외).
종료: 0 통과 · 3 FAIL · ref_overlap 이 4·5 면 그 코드."""
import json, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GREETING = re.compile(r'^(こんにちは|こんばんは|おはよう|皆さん|みなさん|どうも|ようこそ|今週も|本日も|本日は|今日も|今週の国会[、。です]|国会ノート[、。です]'
                      r'|\d+月\d+日|令和\d+年\d+月)')
FROM = '20261021'
sys.path.insert(0, str(ROOT / 'politics-hour'))
import candidate_gate   # noqa: E402  ko 후보표 관문(28ca994) 그대로


def candidates_errors(ep):
    return candidate_gate.gate_lines(ep)


def spoken(ep):
    sys.path.insert(0, str(Path(__file__).parent / 'render'))
    import ja_render
    epj = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    return [s for s in ja_render.segments(epj) if s.get('type') in ('cold', 'nar', 'card', 'chapter') and s.get('text')]


def main():
    ep = Path(sys.argv[1])
    bad = candidates_errors(ep)
    rc_ref = 0
    if '--before-script' not in sys.argv:
        segs = spoken(ep)
        first = next((s['text'] for s in segs if s.get('type') in ('cold', 'nar')), '')
        if ep.name < FROM:
            pass
        elif GREETING.match(first.strip()):
            bad.append(f'첫 말이 인사·채널명·날짜: «{first[:30]}»')
        else:
            print(f'[script-ja] PASS 첫 말 인사 아님: «{first[:30]}»')
        with tempfile.TemporaryDirectory() as tmp:
            nar = Path(tmp) / 'nar.json'
            nar.write_text(json.dumps([s['text'] for s in segs if s.get('type') != 'card'], ensure_ascii=False), encoding='utf-8')
            rc_ref = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'ref_overlap.py'), str(nar), '--lane', 'politics_ja']).returncode
    if not candidates_errors(ep):
        print('[script-ja] PASS 후보표(상승 점수·발췌·지금의 감정·댓글 수·사유)')
    for b in bad:
        print('[script-ja] FAIL', b)
    sys.exit(rc_ref or (3 if bad else 0))


if __name__ == '__main__':
    main()
