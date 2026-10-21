# -*- coding: utf-8 -*-
"""불확실 팩트 관문(G4, devo-6 · 관리자 10-21) — 원고 완성 뒤·TTS 전. 10/23편부터 막는다.

    python politics-hour/uncertain_facts.py <에피소드 폴더> --ask   해설 원문을 gpt-ask 로 교차 확인 1회 → <편>/uncertain_facts.json
    python politics-hour/uncertain_facts.py <에피소드 폴더>         검사만(exit 3 = 열린 항목·파일 없음·원고가 바뀜)

파일 형식·판정은 기업 레인 ko-corp/render/fact_gate.py(f476660)를 그대로 쓴다(사본 금지 — 파일 경로로 import):
  {"facts": [{"claim", "seg", "status": open|confirmed|fixed|cut, "source", "note"}], "cross_check": {"at", "gpt_file", "sha"}}
여기서 더하는 것: --ask(해설 조각 → gpt-ask 1회 → facts, 답 전문 audit/fact_answer.md) · sha(해설 원문 해시 — 확인 뒤 원고가 바뀌면 FAIL, --ask 다시).
손으로 open → confirmed/fixed/cut 로 바꿀 땐 source 에 근거를 적는다.
"""
import datetime
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

FROM = '20261023'
ROOT = Path(__file__).resolve().parent
GPT = ROOT.parent / 'scripts' / 'gpt-ask.js'
_spec = importlib.util.spec_from_file_location('corp_fact_gate', ROOT.parent / 'ko-corp' / 'render' / 'fact_gate.py')
corp = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(corp)
VERDICT = {'confirmed': 'confirmed', 'wrong': 'open', 'unverified': 'open'}


def nar_texts(ep):
    E = json.loads((Path(ep) / 'episode.json').read_text(encoding='utf-8'))
    return [(i, s['text']) for i, s in enumerate(E['segments']) if s.get('type') == 'nar' and s.get('text')]


def sha(ep):
    return hashlib.sha256('\n'.join(f'{i}\t{t}' for i, t in nar_texts(ep)).encode('utf-8')).hexdigest()[:16]


def ask(ep):
    ep = Path(ep)
    srcs = []
    for p in sorted((ep / 'issues').glob('*.json')):
        try:
            srcs += [u for u in json.loads(p.read_text(encoding='utf-8')).get('sources', []) if isinstance(u, str)]
        except Exception:
            pass
    body = '\n'.join(f'[{i}] {t}' for i, t in nar_texts(ep))
    prompt = f"""아래는 한국 정치 해설 영상의 해설 원고다(대괄호 = 조각 번호). 사실 주장 중 틀렸거나 확인이 필요한 것을 찾아 웹에서 교차 확인하라.
대상: 숫자·날짜·직함·누가 무엇을 말했는지·사건 순서·법·제도 설명. 의견·질문·인용 소개 문장은 사실 주장만 본다.
확인 근거로 쓸 수 있는 참고 보도:
{chr(10).join('- ' + u for u in srcs[:40])}

원고:
{body}

JSON 하나만 답하라(설명 금지): {{"items": [{{"seg": 조각 번호, "claim": "원고 속 문구 그대로", "verdict": "confirmed|wrong|unverified", "evidence": "출처 주소·근거 한 줄", "fix": "wrong·unverified 면 고칠 문장"}}]}}
확인한 주장 중 근거가 분명한 것은 confirmed 로 넣되, 의심이 남는 것만 wrong·unverified 로 둔다."""
    pf = ep / 'audit' / 'fact_prompt.md'
    pf.parent.mkdir(exist_ok=True)
    pf.write_text(prompt, encoding='utf-8')
    r = subprocess.run(['node', str(GPT), '--session', '정치 ko', '--file', str(pf)], capture_output=True, text=True, encoding='utf-8')
    raw = r.stdout
    (ep / 'audit' / 'fact_answer.md').write_text(raw, encoding='utf-8')
    return from_answer(ep, r.returncode)


def from_answer(ep, rc=0):
    """audit/fact_answer.md(gpt-ask 답) → uncertain_facts.json(기업 레인 형식)."""
    ep = Path(ep)
    raw = (ep / 'audit' / 'fact_answer.md').read_text(encoding='utf-8')
    m = re.search(r'\{[\s\S]*\}', raw)
    if rc or not m:
        sys.exit(f'gpt-ask 답을 못 읽음(종료 {rc}) — {ep / "audit" / "fact_answer.md"}')
    facts = [{'claim': x.get('claim', ''), 'seg': x.get('seg'), 'status': VERDICT.get(x.get('verdict'), 'open'),
              'source': x.get('evidence', ''), 'note': x.get('fix', '')} for x in json.loads(m.group(0)).get('items', [])]
    out = {'facts': facts, 'cross_check': {'at': datetime.datetime.now().isoformat(timespec='seconds'), 'gpt_file': 'audit/fact_answer.md',
                                           'sha': sha(ep), 'by': 'gpt-ask 교차 1회'}}
    (ep / 'uncertain_facts.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return out


def gate_lines(ep, uploads=()):
    ep = Path(ep)
    sys.path.insert(0, str(ROOT))
    import candidate_gate
    if candidate_gate.ep_date(ep, uploads) < FROM or not (ep / 'episode.json').exists():
        return []
    f = ep / 'uncertain_facts.json'
    if not f.exists():
        return [f'불확실 팩트: {f.name} 없음 — python politics-hour/uncertain_facts.py {ep} --ask (TTS 전)']
    d = json.loads(f.read_text(encoding='utf-8'))
    if (d.get('cross_check') or {}).get('sha') != sha(ep):
        return [f'불확실 팩트: 해설 원고가 교차 확인 뒤 바뀜(해시 {(d.get("cross_check") or {}).get("sha")} ≠ {sha(ep)}) — --ask 다시']
    ok, line = corp.check(ep)
    left = [x for x in d.get('facts', []) if x.get('status') == 'confirmed' and not str(x.get('source', '')).strip()]
    return ([] if ok else [line]) + [f'불확실 팩트 확인 근거 없음 [{x.get("seg")}] «{x.get("claim", "")[:40]}»' for x in left]


if __name__ == '__main__':
    ep = Path(sys.argv[1]).resolve()
    if '--ask' in sys.argv:
        d = ask(ep)
        print(f'[fact] {len(d["facts"])}건 → {ep / "uncertain_facts.json"}')
    if '--from-answer' in sys.argv:
        d = from_answer(ep)
        print(f'[fact] {len(d["facts"])}건(저장된 답에서) → {ep / "uncertain_facts.json"}')
    bad = gate_lines(ep)
    for b in bad:
        print('[fact] FAIL', b)
    if bad:
        sys.exit(3)
    print('[fact] PASS', ep.name)
