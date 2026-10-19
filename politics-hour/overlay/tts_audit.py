# -*- coding: utf-8 -*-
"""해설 TTS 역전사 대조 — 렌더가 끝난 편의 해설 voice.wav 를 이어 Speechmatics ko 로 받아쓰고,
원고의 숫자·고유명사가 해설마다 그대로 들렸는지 맞춘다(10/20편부터, 관리자 10-19 «3시 8분→4시 8분» 대책).

숫자 파서·이어 붙이기는 기업 흥망 ko-corp/render/audit.py 것을 import 한다(새로 만들지 않는다 — 관리자 10-19).
TTS 입력 쪽 한글 읽기는 episode.json "tts_say": true 로 assemble_hour 가 ko_say.say 를 쓴다(자막은 숫자 그대로).

    python -X utf8 politics-hour/overlay/tts_audit.py politics-hour/episodes/20261020

결과: <편>/audit/result.json {ok, numbers:[맞음, 전체], names:[맞음, 전체], bad:[...]} 와 report.md.
upload_gate.py 가 result.json 을 읽는다: tts_say 편인데 결과가 없거나 ok=false 면 FAIL.
고유명사 표: <편>/names.json {"표기": ["들려도 되는 다른 표기", ...]} — 없으면 keywords.json 낱말만 센다.
"""
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, 'D:/midform/ko-corp/render')
import audit as A  # noqa: E402  values·script_values·concat (기업 흥망 세션 소유, 고치지 않는다)

SCRIPTS = Path('D:/midform/scripts')
DEC = re.compile(r'\d+\.\d+')


def sentences(text):
    return [s for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s]


def name_table(ep):
    nf = ep / 'names.json'
    table = json.loads(nf.read_text(encoding='utf-8')) if nf.exists() else {}
    shared = json.loads((Path(__file__).resolve().parents[1] / 'names_ko.json').read_text(encoding='utf-8'))
    for w, alts in shared.items():
        if not w.startswith('_'):
            table.setdefault(w, alts)
    kf = ep / 'keywords.json'
    if kf.exists():
        k = json.loads(kf.read_text(encoding='utf-8'))
        for w in (k.get('keywords', k) if isinstance(k, dict) else k):
            w = w if isinstance(w, str) else w.get('keyword', '')
            if w and w not in table:
                table[w] = []
    return table


def run(ep, retranscribe=False):
    """편 폴더 → result dict. 해설 조각(voice.wav)만 본다. 인용 원음은 대상 아님."""
    ep = Path(ep).resolve()
    E = json.loads((ep / 'episode.json').read_text(encoding='utf-8'))
    work = (ep / E['workdir']).resolve()
    parts = [Path(l.split("'")[1]) for l in (work / 'concat.txt').read_text(encoding='utf-8').splitlines() if l.strip()]
    nars = [(i, s, parts[i].parent / 'voice.wav') for i, s in enumerate(E['segments']) if s['type'] == 'nar']
    lack = [str(w) for _, _, w in nars if not w.exists()]
    if lack:
        raise SystemExit('voice.wav 없음: ' + ', '.join(lack[:3]))
    au = ep / 'audit'
    au.mkdir(exist_ok=True)
    wav, tr = au / 'nar.wav', au / 'nar.json'
    voices = [w for _, _, w in nars]
    stale = retranscribe or not tr.exists() or any(w.stat().st_mtime > tr.stat().st_mtime for w in voices)
    offs = A.concat(voices, wav)   # 시각표는 매번 다시 잰다(받아쓰기는 해설이 바뀌었을 때만 — 유료)
    if stale:
        subprocess.run([sys.executable, '-X', 'utf8', str(SCRIPTS / 'rinbox_transcribe.py'), str(wav), str(tr), '--lang', 'ko'], check=True)
    words = json.loads(tr.read_text(encoding='utf-8'))
    table = name_table(ep)
    total = bad = ntotal = nbad = 0
    lines = []
    for k, (i, s, _) in enumerate(nars):
        sents = sentences(s['text'])
        heard = ' '.join(w for a, b, w in words if offs[k] - .05 <= (a + b) / 2 < offs[k + 1] + .05)
        # 받아쓰기는 수를 대개 아라비아 숫자로 «14일» «13.3이었습니다» 처럼 붙여 준다 — 아라비아 숫자는 원고와 같은 파서로,
        # 남은 한글 부분만 한자어·고유어 수 파서로 읽는다(«14일»의 «일»을 1로 붙여 읽지 않게)
        # 소수(18.2%·27.1%)는 한 덩어리로 맞춘다 — 쪼개 세면 «27.1→27.2» 가 다른 곳의 1 에 묻힌다(10/19편 실측)
        dec_want = Counter(d for x in sents for d in DEC.findall(x))
        dmiss = dec_want - Counter(DEC.findall(heard))
        rest = DEC.sub(' ', heard)
        heard_vals = A.script_values(rest) + A.values(re.sub(r'\d[\d,.]*', ' ', rest))
        want = Counter(v for x in sents for v in A.script_values(DEC.sub(' ', x))) + Counter(dec_want)
        miss = (want - Counter(dec_want)) - Counter(heard_vals) + dmiss
        total += sum(want.values()); bad += sum(miss.values())
        flat, nmiss = heard.replace(' ', ''), {}
        for w, alts in table.items():
            n = sum(x.replace(' ', '').count(w.replace(' ', '')) for x in sents)
            if n:
                ntotal += n
                got = sum(flat.count(x.replace(' ', '')) for x in [w, *alts])
                if got < n:
                    nmiss[w] = n - got
        nbad += sum(nmiss.values())
        if miss or nmiss:
            lines.append(f'- [{i}] 숫자 원고 {dict(want)} · 빠짐 {dict(miss)} · 고유명사 빠짐 {nmiss}\n  원고: {s["text"][:120]}\n  들림: {heard[:200]}')
    res = {'ok': not bad and not nbad, 'numbers': [total - bad, total], 'names': [ntotal - nbad, ntotal], 'bad': lines,
           'nar_segments': len(nars), 'tts_say': bool(E.get('tts_say'))}
    head = f'역전사 대조: 숫자 {total - bad}/{total} · 고유명사 {ntotal - nbad}/{ntotal}'
    (au / 'report.md').write_text(head + '\n\n' + '\n'.join(lines) + '\n', encoding='utf-8')
    (au / 'result.json').write_text(json.dumps(res, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return res


def gate_lines(ep):
    """upload_gate 용: 어긋남 문장 목록(빈 목록 = 통과). tts_say 를 켠 편(10/20~)만 결과를 요구한다."""
    ep = Path(ep)
    E = json.loads((ep / 'episode.json').read_text(encoding='utf-8')) if (ep / 'episode.json').exists() else {}
    rf = ep / 'audit' / 'result.json'
    if not rf.exists():
        return ['역전사 대조 결과 없음 — python -X utf8 politics-hour/overlay/tts_audit.py ' + ep.as_posix()] if E.get('tts_say') else []
    r = json.loads(rf.read_text(encoding='utf-8'))
    if r['ok']:
        return []
    return [f'역전사 대조 불일치 숫자 {r["numbers"][0]}/{r["numbers"][1]} · 고유명사 {r["names"][0]}/{r["names"][1]} — {ep.as_posix()}/audit/report.md']


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    r = run(sys.argv[1], '--retranscribe' in sys.argv)
    print(f'역전사 대조: 숫자 {r["numbers"][0]}/{r["numbers"][1]} · 고유명사 {r["names"][0]}/{r["names"][1]} · {"OK" if r["ok"] else "FAIL"}')
    print('\n'.join(r['bad']))
    sys.exit(0 if r['ok'] else 4)
