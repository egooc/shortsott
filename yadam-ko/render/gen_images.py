# -*- coding: utf-8 -*-
"""야담 ko 장면 그림 생성 — 연금JA ja-nenkin/render/gen_images.py 방식(GPT 이미지 + 레퍼런스 화면 첨부) + 인물 기준 그림 첨부.

    python -X utf8 yadam-ko/render/gen_images.py <편 폴더> [--jobs 4] [키 ...]

<편>/img_prompts.json = {
  "_style": "화풍 글", "_style_refs": ["yadam-ko/style_refs/ref_....png", ...(3장 이상)],
  "_chars": {"yeon": {"sheet": "chars/yeon.png", "desc": "인물 설명"}, ...},
  "<키>": {"desc": "장면 설명", "chars": ["yeon", "bae"]}  또는 "<키>": "장면 설명"
}
- 인물 기준 그림(chars/<이름>.png)은 키 "char_<이름>" 으로 먼저 만든다(첨부는 화풍 그림만).
- 장면 그림엔 화풍 그림 + 등장인물 기준 그림을 함께 붙여 얼굴·옷을 유지한다(기획서: 인물은 한 편 안에서 같은 얼굴).
- style_refs 가 3장 미만이거나 파일이 없으면 종료 4 — 글로만 화풍을 지시하지 않는다.
- 결과 img/<키>.png(있으면 건너뜀), 요청마다 img/_gen_log.jsonl 한 줄.
"""
import datetime
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NOTE = ('\n\n앞에 붙인 레퍼런스 화면은 화풍 기준이다 — 반실사 웹툰풍 채색, 부드러운 빛, 얼굴 그리는 법, 밝기를 그대로 따르고 '
        '내용(인물·구도·글자·로고)은 따라 하지 말 것. 그림 안에 글자·자막·로고·서명을 절대 넣지 말 것. 16:9 가로 그림.')
CHAR_NOTE = '\n\n뒤에 붙인 인물 기준 그림({names})의 얼굴·머리 모양·옷을 그대로 유지할 것(같은 사람).'


def main(argv):
    ep = Path(argv[0]).resolve()
    jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 4
    keys = [a for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] != '--jobs']
    P = json.loads((ep / 'img_prompts.json').read_text(encoding='utf-8'))
    refs = P.get('_style_refs') or []
    missing = [r for r in refs if not (ROOT / r).exists()]
    if len(refs) < 3 or missing:
        print(f'[관문] style_refs {len(refs)}장 · 없는 파일 {missing} — 레퍼런스 화면 3장 이상 없이는 그림 요청 금지(종료 4)')
        return 4
    C = P.get('_chars', {})
    (ep / 'img').mkdir(exist_ok=True)
    (ep / 'chars').mkdir(exist_ok=True)

    def item(k):
        v = P[k]
        return (v, []) if isinstance(v, str) else (v['desc'], v.get('chars', []))

    def one(k):
        if k.startswith('char_'):
            name = k[5:]
            out = ep / 'chars' / f'{name}.png'
            desc = (f'인물 기준 그림 한 장. 밝은 단색 배경 앞에 선 전신 모습(왼쪽)과 얼굴 가까이(오른쪽)를 나란히. '
                    f'인물: {C[name]["desc"]}')
            chars = []
        else:
            out = ep / 'img' / f'{k}.png'
            desc, chars = item(k)
            desc = '장면: ' + desc + ''.join(f'\n- {c}: {C[c]["desc"]}' for c in chars)
        if out.exists():
            return k, 'skip'
        sheets = [ep / C[c]['sheet'] for c in chars]
        lost = [str(s) for s in sheets if not s.exists()]
        if lost:
            return k, f'FAIL 인물 기준 그림 없음 {lost}'
        att = [x for r in refs for x in ('--attach', str(ROOT / r))] + [x for s in sheets for x in ('--attach', str(s))]
        prompt = P['_style'] + NOTE + (CHAR_NOTE.format(names='·'.join(chars)) if chars else '') + '\n\n' + desc
        r = subprocess.run(['node', str(ROOT / 'scripts' / 'gpt-ask.js'), '--session', '야담KO', '--no-search', *att, '--image', str(out), prompt],
                           capture_output=True, text=True, encoding='utf-8')
        ok = out.exists()
        with open(ep / 'img' / '_gen_log.jsonl', 'a', encoding='utf-8') as f:
            f.write(json.dumps({'at': datetime.datetime.now().isoformat(timespec='seconds'), 'key': k, 'chars': chars,
                                'prompt': prompt, 'ok': ok}, ensure_ascii=False) + '\n')
        return k, ('ok' if ok else 'FAIL ' + (r.stderr or r.stdout)[-300:])

    keys = keys or [k for k in P if not k.startswith('_')]
    bad = 0
    with ThreadPoolExecutor(jobs) as ex:
        for k, s in ex.map(one, keys):
            print(k, s, flush=True)
            bad += s.startswith('FAIL')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main(sys.argv[1:]))
