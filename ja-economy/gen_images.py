# -*- coding: utf-8 -*-
"""그림 요청 관문(관리자 §7 10-24 «레퍼런스 화면을 붙여 화풍을 맞춘다») — 공용 monetize-longform/tools/gen_images.py --style-ref 를 그대로 부른다(사본 금지).

    python -X utf8 ja-economy/gen_images.py <편 폴더> [--lane ja_economy|politics_ja] [--jobs 2] [키 ...]

style_refs = <편>/img_prompts.json «_style_refs»(경로 목록) 가 있으면 그것, 없으면 레인 기본 폴더의 png/jpg 전부.
빈 목록·없는 파일이면 종료 4(그림 요청 안 함). 통과하면 <편>/img/_style_refs.json 에 키마다 붙인 경로를 남긴다.
레퍼런스는 터진 편 화면에서 로고·글자·실존 인물 얼굴을 잘라낸 것만 둔다 — 구도·글자는 따라 하지 않는다(공용 도구 문구)."""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SHARED = ROOT / 'monetize-longform' / 'tools' / 'gen_images.py'
LANE_REFS = {
    'ja_economy': ROOT / 'reference' / 'ja_economy' / 'style_refs',     # 경제꽈배기 터진 편 4장(10-24)
    'politics_ja': ROOT / 'reference' / 'politics_ja' / 'style_refs',   # 그림 쓰는 편이 생기면 채운다 — 비어 있으면 관문이 막는다
}
SESSION = {'ja_economy': '일본 경제', 'politics_ja': '정치JA'}


def style_refs(ep, lane):
    P = json.loads((ep / 'img_prompts.json').read_text(encoding='utf-8'))
    refs = P.get('_style_refs')
    if not refs:
        d = LANE_REFS[lane]
        refs = sorted(str(p) for p in d.glob('*') if p.suffix.lower() in ('.png', '.jpg', '.jpeg') and not p.name.startswith('_')) if d.exists() else []
    return [str((ep / r).resolve()) if not Path(r).is_absolute() else r for r in refs], P


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    ep = Path(argv[0]).resolve()
    lane = argv[argv.index('--lane') + 1] if '--lane' in argv else 'ja_economy'
    refs, P = style_refs(ep, lane)
    missing = [r for r in refs if not Path(r).exists()]
    if not refs or missing:
        print(f'[img-gate] FAIL style_refs {"없음" if not refs else "파일 없음 " + ", ".join(missing)} — 레퍼런스 터진 편 화면 3~5장을 {LANE_REFS[lane]} 에 두거나 img_prompts.json «_style_refs» 에 적어라')
        return 4
    rest = [a for i, a in enumerate(argv[1:], 1) if a != '--lane' and argv[i - 1] != '--lane']
    keys = [a for i, a in enumerate(rest) if not a.startswith('--') and (i == 0 or rest[i - 1] not in ('--jobs', '--session'))]
    opts = [a for a in rest if a not in keys]
    keys = keys or [k for k in P if not k.startswith('_')]   # 키를 늘 넘긴다 — 공용 도구는 «_style» 만 빼므로 «_style_refs» 가 키로 섞이지 않게
    log = ep / 'img' / '_style_refs.json'
    log.parent.mkdir(exist_ok=True)
    old = json.loads(log.read_text(encoding='utf-8')) if log.exists() else {}
    old.update({k: refs for k in keys})
    log.write_text(json.dumps(old, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'[img-gate] PASS style_refs {len(refs)}장 · 그림 {len(keys)}개')
    sess = [] if '--session' in opts else ['--session', SESSION[lane]]
    return subprocess.run([sys.executable, '-X', 'utf8', str(SHARED), str(ep), *opts, *keys, *sess,
                           *[x for r in refs for x in ('--style-ref', r)]]).returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
