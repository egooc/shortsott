# -*- coding: utf-8 -*-
"""장면 그림 일괄 생성 — img_prompts.json 의 각 키 → img/<키>.png (이미 있으면 건너뜀). GPT 창구 gpt-ask.js, 동시 3건.

    python ko-corp/tools/gen_images.py ko-corp/ep02 [키 ...]
    python ko-corp/tools/gen_images.py ko-corp/cat01 --prompts cast_prompts.json --dir cast   다른 프롬프트 파일·출력 폴더

화풍은 글이 아니라 레퍼런스 화면으로 맞춘다(관리자 10-24 §7): img_prompts.json 의 "_style_refs" = 레퍼런스 터진 편 캡처 3~5장
(ko-corp/style_refs, 로고·글자·자막 잘라낸 것) 경로 목록. 비었거나 파일이 없으면 종료 4. 요청마다 img/prompt_log.jsonl 에 style_refs 를 남긴다.
"""
import datetime
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NOTE = '\n\n붙인 그림은 화풍 기준이다 — 선·색·빛·질감·밝기·인물 묘사 정도를 그대로 따르고, 내용(인물·물체·구도·글자·로고)은 따라 하지 말 것.'


def style_refs(P):
    refs = [ROOT / r for r in P.pop('_style_refs', [])]
    if len(refs) < 3 or any(not r.exists() for r in refs):
        print(f'화풍 관문: _style_refs {len(refs)}장(3장 이상 필요) · 없는 파일 {[str(r) for r in refs if not r.exists()]} — 그림 요청 중단')
        raise SystemExit(4)
    return refs


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:]
    opt = {k: argv[argv.index(k) + 1] for k in ('--prompts', '--dir') if k in argv}
    ep = Path(argv[0]).resolve()
    P = json.loads((ep / opt.get('--prompts', 'img_prompts.json')).read_text(encoding='utf-8'))
    style = P.pop('_style')
    refs = style_refs(P)
    note = '\n\n' + P.pop('_note') if '_note' in P else NOTE  # 캐릭터 낱장처럼 첨부 그림의 «같은 고양이»를 따라야 할 때 덮어쓴다
    keys = [a for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] not in opt] or list(P)
    outdir = ep / opt.get('--dir', 'img')
    outdir.mkdir(exist_ok=True)
    log = outdir / 'prompt_log.jsonl'

    def one(k):
        out = outdir / f'{k}.png'
        if out.exists():
            return k, 'skip'
        prompt = f'{style}{note}\n\n장면: {P[k]}'
        att = [x for r in refs for x in ('--attach', str(r))]
        r = subprocess.run(['node', 'D:/midform/scripts/gpt-ask.js', '--session', '기업 흥망', '--no-search', *att, '--image', str(out), prompt],
                           capture_output=True, text=True, encoding='utf-8')
        with open(log, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'key': k, 'at': datetime.datetime.now().isoformat(timespec='seconds'), 'ok': out.exists(), 'prompt': prompt,
                                'style_refs': [r.relative_to(ROOT).as_posix() for r in refs]}, ensure_ascii=False) + '\n')
        return k, ('ok' if out.exists() else 'FAIL ' + (r.stderr or r.stdout)[-300:])

    with ThreadPoolExecutor(3) as ex:
        for k, s in ex.map(one, keys):
            print(k, s, flush=True)


if __name__ == '__main__':
    main()
