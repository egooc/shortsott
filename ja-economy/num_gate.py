# -*- coding: utf-8 -*-
"""일본 경제 롱폼 숫자 읽기 관문(관리자 10-22 «경제는 숫자가 많다») — 연금 레인 도구를 그대로 import(사본 금지).

    python ja-economy/num_gate.py --test                    # 금액·연도·퍼센트 시험 문장 20개: 값 검산 → 합성 → 역전사 대조
    python ja-economy/num_gate.py <원고.txt> [--yomi yomi.json] [--out <폴더>]   # 한 줄 한 문장 원고로 같은 검사

단계(연금 ep01 절차와 같다):
  ① 값 검산 — scripts/ja_numread.check_line: TTS 읽기(한자)로 바꾼 값 = 원문 값
  ② 읽기 입력 — ja_numread.to_say(히라가나, 8 첫머리 처리) + ja-nenkin/render/nenkin_render.apply_yomi(yomi.json «yomi» 표)
  ③ 합성 — nenkin_render.speak(Supertonic F2) → 역전사 scripts/rinbox_transcribe.py(Speechmatics ja)
  ④ 대조 — ja-nenkin/render/num_audit.nums·names: 문장마다 원고 숫자가 들린 숫자에 있는지, yomi «audit» 고유명사 횟수
종료: 0 통과 · 3 소수 «점 빠짐» 형식만(청취 확인) · 4 실제 오독·값 불일치 · 5 검사 불가."""
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'ja-nenkin' / 'render'))
import ja_numread as N  # noqa: E402
import nenkin_render as R  # noqa: E402
import num_audit as A  # noqa: E402
import re  # noqa: E402

# 경제 레인 읽기 보정(공용 to_say 앞에서만, 공용 도구는 안 고친다) — 10-22 역전사 실측
#  ・«1ドル151円» → «いちドルひゃく…»가 «1ドル100151円»으로 들렸다(3회 같은 결과). «1ドル、151円»은 0건.
#  ・«株価は、3万8915円で» → «3万8115円»(3회). 쉼표 없는 «株価は3万8915円で»·«終値は、3万8915円でした»는 0건 → 규칙으로 못 잡아 원고 고쳐 쓰기(관문이 잡는다).
ECON_FIX = [(re.compile(r'(ドル|ユーロ|元|ウォン)(?=\d)'), r'\1、')]


def econ_say(s, yomi=None):
    for pat, rep in ECON_FIX:
        s = pat.sub(rep, s)
    return R.apply_yomi(s, yomi or {})

# 금액·연도·퍼센트·조수사가 섞인 경제 문장(일본 경제 해설 꼴) — 숫자 하나씩만이 아니라 큰 수 덩어리·소수·8 첫머리를 일부러 넣었다
TEST = [
    '日経平均株価は、3万8915円で取引を終えました。',
    '2024年の名目GDPは、およそ609兆円でした。',
    '消費者物価指数は、前の年より3.2%上がりました。',
    '日銀は政策金利を0.5%に引き上げました。',
    'トヨタの営業利益は、5兆3529億円と過去最高でした。',
    '1ドル151円台まで円安が進みました。',
    '最低賃金の全国平均は1055円になります。',
    '2026年4月から、保険料が月に800円上がります。',
    '国の借金は、1300兆円を超えています。',
    '実質賃金は、25か月連続でマイナスでした。',
    '貯蓄ゼロの世帯は、およそ23.7%にのぼります。',
    '1990年のバブル崩壊から、もう35年が経ちました。',
    '金の価格は、1グラム1万5000円を超えました。',
    '8万4000円の給付金が、2回に分けて支払われます。',
    '税収は、5年連続で過去最高の75兆2000億円でした。',
    '住宅ローンの変動金利は、平均0.38%です。',
    '新NISAの年間投資枠は、360万円です。',
    '65歳以上の世帯の平均貯蓄は、2414万円です。',
    'コメの価格は、5キロ4285円と、去年の2倍近くになりました。',
    '物価上昇率2%の目標は、9年かけても届きませんでした。',
]


def run(sentences, out, yomi=None, table=None):
    out.mkdir(parents=True, exist_ok=True)
    bad_val = []
    for i, s in enumerate(sentences):
        read, ok, a, k = N.check_line(s)
        if not ok:
            bad_val.append(f'- [{i}] 값 불일치 «{s}» → «{read}» 값 {a} ≠ {k}')
    wav, tr = out / 'voice.wav', out / 'transcript.json'
    timings = R.speak([econ_say(x) for x in sentences], wav, yomi or {})
    # 문장마다 자막 덩어리 수만큼 시각이 나온다 → 문장 창(앞뒤 0.05초)
    wins, j = [], 0
    for s in sentences:
        n = len(R.chunks(s))
        wins.append((timings[j][0], timings[j + n - 1][1]))
        j += n
    subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'rinbox_transcribe.py'), str(wav), str(tr), '--lang', 'ja'],
                   check=True, capture_output=True)
    words = json.loads(tr.read_text(encoding='utf-8'))
    bad = fmt_n = total = nbad = ntotal = 0
    lines = []
    for i, (s, (a0, b0)) in enumerate(zip(sentences, wins)):
        heard = ''.join(w for a, b, w in words if a0 - .05 <= (a + b) / 2 < b0 + .05)
        want = Counter(N.values_arabic(s))
        got = Counter(A.nums(heard))
        miss = want - got
        fmt = Counter()
        for v, c in list(miss.items()):   # 소수 «점» 없이 붙어 들림 = 받아쓰기 형식(연금 num_audit 와 같은 처리)
            if isinstance(v, float) and v != int(v):
                glued = int(repr(v).replace('.', ''))
                k_ = min(c, (got - Counter(want))[glued])
                if k_:
                    fmt[v] = k_
                    miss[v] -= k_
        miss = +miss
        nw, nmiss = A.names([s], heard, table or {})
        total += sum(want.values()); bad += sum(miss.values()); fmt_n += sum(fmt.values())
        ntotal += nw; nbad += sum(nmiss.values())
        mark = 'FAIL' if miss or nmiss else ('형식' if fmt else 'ok')
        lines.append(f'- [{i}] {mark} «{s}» · 읽기 «{N.to_say(econ_say(s, yomi))}» · 들림 «{heard}»'
                     + (f' · 오독 {dict(miss)}' if miss else '') + (f' · 점 빠짐 {dict(fmt)}' if fmt else '') + (f' · 고유명사 빠짐 {nmiss}' if nmiss else ''))
    head = (f'[num-ja-econ] 값 검산 {len(sentences) - len(bad_val)}/{len(sentences)} · 역전사 숫자 {total - bad}/{total}'
            f' · 고유명사 {ntotal - nbad}/{ntotal} · 점 빠짐 형식 {fmt_n}건')
    (out / 'report.md').write_text(head + '\n\n' + '\n'.join(bad_val + lines) + '\n', encoding='utf-8')
    print(head)
    print('\n'.join(bad_val + [l for l in lines if ' ok ' not in l[:12]]))
    return 4 if bad or nbad or bad_val else (3 if fmt_n else 0)


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    if '--test' in argv:
        sents, out = TEST, Path(opt('--out') or HERE / '_test' / 'num_gate')
    else:
        src = Path(argv[0])
        sents = [l.strip() for l in src.read_text(encoding='utf-8').splitlines() if l.strip() and not l.startswith('#')]
        out = Path(opt('--out') or src.parent / 'audit')
    yf = Path(opt('--yomi')) if opt('--yomi') else None
    y = json.loads(yf.read_text(encoding='utf-8')) if yf and yf.exists() else {}
    try:
        return run(sents, out, y.get('yomi', {}), y.get('audit', {}))
    except (OSError, ValueError, subprocess.CalledProcessError) as e:
        print(f'[num-ja-econ] 검사 불가: {e}')
        return 5


if __name__ == '__main__':
    sys.exit(main())
