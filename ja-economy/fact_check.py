# -*- coding: utf-8 -*-
"""일본 경제 롱폼 불확실 팩트 관문(G4) — ko politics-hour/uncertain_facts.py(from_answer·sha·corp.check)를 import, 원고 읽기와 질문만 경제판.

    python ja-economy/fact_check.py <편 폴더> --ask    script.txt 해설을 gpt-ask 로 교차 확인 1회 → <편>/uncertain_facts.json
    python ja-economy/fact_check.py <편 폴더>          검사만(exit 3 = 열린 항목·파일 없음·원고가 바뀜 · TTS 금지)

원고 = <편>/script.txt 한 줄 한 문장(«#» 줄 제외), 조각 번호 = 문장 순번. 손으로 open → confirmed/fixed/cut 로 바꿀 땐 source 에 근거."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
_spec = importlib.util.spec_from_file_location('uncertain_facts_ko', ROOT / 'politics-hour' / 'uncertain_facts.py')
uf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(uf)


def nar_texts(ep):
    lines = (Path(ep) / 'script.txt').read_text(encoding='utf-8').splitlines()
    return list(enumerate(l.strip() for l in lines if l.strip() and not l.startswith('#')))


uf.nar_texts = nar_texts   # sha()·from_answer() 가 모듈 전역 nar_texts 를 부른다


def ask(ep):
    ep = Path(ep)
    body = '\n'.join(f'[{i}] {t}' for i, t in nar_texts(ep))
    prompt = f"""아래는 일본 경제 해설 영상(일본어)의 해설 원고다(대괄호 = 문장 번호). 사실 주장 중 틀렸거나 확인이 필요한 것을 찾아 웹에서 교차 확인하라.
대상: 숫자(금액·비율·배당)·날짜·연도·직함·사건 순서·회사 사이 거래(출자·인수·합병)·인물이 무엇을 했는지. 의견·질문·해석 문장은 사실 주장만 본다.
일본어 자료(회사 공시·니혼게이자이 등 보도)를 우선 근거로 써라.

원고:
{body}

JSON 하나만 답하라(설명 금지): {{"items": [{{"seg": 문장 번호, "claim": "원고 속 문구 그대로", "verdict": "confirmed|wrong|unverified", "evidence": "출처 주소·근거 한 줄", "fix": "wrong·unverified 면 고칠 일본어 문장"}}]}}
확인한 주장 중 근거가 분명한 것은 confirmed 로 넣되, 의심이 남는 것만 wrong·unverified 로 둔다."""
    pf = ep / 'audit' / 'fact_prompt.md'
    pf.parent.mkdir(exist_ok=True)
    pf.write_text(prompt, encoding='utf-8')
    r = subprocess.run(['node', str(uf.GPT), '--session', '일본 경제', '--file', str(pf)], capture_output=True, text=True, encoding='utf-8')
    (ep / 'audit' / 'fact_answer.md').write_text(r.stdout, encoding='utf-8')
    return uf.from_answer(ep, r.returncode)


def gate_lines(ep):
    ep = Path(ep)
    f = ep / 'uncertain_facts.json'
    if not f.exists():
        return [f'불확실 팩트: {f.name} 없음 — python ja-economy/fact_check.py {ep} --ask (TTS 전)']
    d = json.loads(f.read_text(encoding='utf-8'))
    if (d.get('cross_check') or {}).get('sha') != uf.sha(ep):
        return [f'불확실 팩트: 원고가 교차 확인 뒤 바뀜(해시 {(d.get("cross_check") or {}).get("sha")} ≠ {uf.sha(ep)}) — --ask 다시']
    ok, line = uf.corp.check(ep)
    left = [x for x in d.get('facts', []) if x.get('status') == 'confirmed' and not str(x.get('source', '')).strip()]
    return ([] if ok else [line]) + [f'불확실 팩트 확인 근거 없음 [{x.get("seg")}] «{x.get("claim", "")[:40]}»' for x in left]


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(sys.argv[1]).resolve()
    if '--ask' in sys.argv:
        d = ask(ep)
        print(f'[fact-econ] {len(d["facts"])}건 → {ep / "uncertain_facts.json"}')
    bad = gate_lines(ep)
    for b in bad:
        print('[fact-econ] FAIL', b)
    if bad:
        sys.exit(3)
    print('[fact-econ] PASS', ep.name)
