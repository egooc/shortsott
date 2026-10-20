# -*- coding: utf-8 -*-
"""제목 점검 — 공용, 경고형(10-20, 하늘구름땅바람 S1·S2·S7 + 관리자 «위험 행위×대상» 요청).

    python scripts/title_check.py <제목 문구 | upload.json | spec.json | meta.json | packages.json> ...
                                  [--lane longshort|fantube|n100|rinbox|politics_shorts|shopping|politics_ko|politics_ja|nenkin_ja|corp_ko]
                                  [--kind shorts|long] [--lang ko|ja] [--keywords 낱말,낱말] [--jargon 사전.json] [--json out] [--fail-on-warn]

쇼츠 검사(△ 경고):
  패턴    10패턴(결과 숨김·이유·저격·숫자·금지/경고·말하다 만다·실화 도장·친근 말투·대사 그대로·최상급) 중 하나도 없으면
  길이    해시태그 뺀 글자 수가 15자 안팎(ko 8~22, ja 8~25) 밖
  앞10자  키워드(--keywords 또는 json 의 keywords) 중 하나가 앞 10자 안에 없음 / 키워드가 없으면 앞이 «오늘은·여러분…» 같은 군말
  결과노출 «결국 ~했다·알고 보니 ~였다·정답은» 처럼 답을 제목에서 말함
  설명형  «A: B»·«A - B»·나열(«·» 2개+) 요약형
  해시태그 제목 안 # 2개 이상 · 최상급 2개 이상(역대급·소름·레전드…)
  가이드  guide_words.hits() 범주 + ★위험 행위×신체 대상(끓는 물·불·칼… + 손·얼굴·아이…), «~했더니» 결과 유도가 겹치면 그것도 표시
          (근거: 롱투숏 ls11 «펄펄 끓는 물에 손 넣었더니» 10-18 08시 조회 1·피드 0 — 실측 1건이라 경고만)
  title_pattern  spec/upload json 에 title_pattern 필드가 없음
롱폼 검사: 앞10자 키워드 · 가이드 · 전문용어 풀이(사전 낱말이 제목에 있으면 제목 «(…)»·«— …» 또는 설명 첫 줄에 풀이 문구, S7)
종료 코드: 0 (경고가 있어도 0 — 경고형) · 4 = --fail-on-warn 이고 경고 있음 · 5 = 검사 불가(파일을 못 읽음·제목 없음, gate_errors.jsonl).
기록: 매 실행의 경고 종류를 server/data/title_check_log.jsonl 에 남긴다(조합 종류 포함).
import: from title_check import check_title  →  check_title(title, kind='shorts', lang='ko', keywords=(), jargon=None, desc='') → [(코드, 메시지)]
"""
import datetime as _dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import guide_words  # noqa: E402

LOG = ROOT / 'server' / 'data' / 'title_check_log.jsonl'
LEDGER = ROOT / 'server' / 'data' / 'gate_errors.jsonl'
LONG_LANES = {'politics_ko', 'politics_ja', 'nenkin_ja', 'corp_ko'}
JA_LANES = {'politics_ja', 'nenkin_ja', 'rinbox_ja'}
JARGON = {'politics_ko': ROOT / 'politics-hour' / 'jargon.json', 'corp_ko': ROOT / 'ko-corp' / 'jargon.json'}

PATTERNS = {
    'ko': [
        ('결과 숨김', r'했더니|봤더니|하더니|더니$|벌어진 일|의 최후|결과는|결말|그 다음|그 후'),
        ('이유', r'이유|비밀|까닭|진짜 정체|정체'),
        ('저격', r'만 아는|들만|직장인|[0-9]{2}년대생|엄마들|아빠들|남자들|여자들|학생|자취생|초보|당신|너만'),
        ('숫자', r'[0-9]+\s*(가지|개|위|년|살|명|원|만|억|배|초|분|일|번|%)|TOP|vs|VS|[0-9]+:[0-9]+'),
        ('금지·경고', r'[가-힣]지 마(세요|라|요)?|따라하지|절대|주의|금지|조심|모르면 손해|하면 안'),   # «닦지 마세요» 쇼핑 표준 훅(10-20)
        ('말하다 만다', r'(\.\.\.|…)$|라는데$|했는데$|인데$|는데…'),
        ('실화 도장', r'실제|실화|바디캠|썰|진짜로|CCTV|현장'),
        ('친근 말투', r'ㅋㅋ|ㄷㄷ|ㅠ|ㅎㅎ|임$|함$|각$|ㄹㅇ|실화냐|미쳤'),
        ('대사 그대로', r'^[«"“\'].+[»"”\']|[«"“].+[»"”]'),
        ('최상급', r'역대급|소름|레전드|최고|최악|끝판왕|미친|충격'),
    ],
    'ja': [
        ('결과 숨김', r'したら|てみたら|た結果|の末路|その後|まさかの'),
        ('이유', r'理由|秘密|正体|わけ|ワケ'),
        ('저격', r'だけが知る|の人|世代|初心者|あなた|知らない人'),
        ('숫자', r'[0-9０-９]+\s*(つ|個|位|年|歳|人|円|万|億|倍|秒|分|日|回|%)|TOP|vs'),
        ('금지·경고', r'絶対|注意|禁止|ダメ|しないで|危険'),
        ('말하다 만다', r'(\.\.\.|…)$|のに$|けど$'),
        ('실화 도장', r'実話|実際|本当に|現場'),
        ('친근 말투', r'w$|笑|ｗ'),
        ('대사 그대로', r'「.+」'),
        ('최상급', r'史上最|最強|衝撃|神|鳥肌|伝説|ヤバ'),
    ],
}
SUPERLATIVE = {'ko': r'역대급|소름|레전드|최고|최악|끝판왕|미친|충격|경악|대박|역대|미쳤', 'ja': r'史上最|最強|衝撃|神|鳥肌|伝説|ヤバ|驚愕'}
FILLER_OPEN = {'ko': r'^(오늘은|오늘|이번에|이번엔|여러분|안녕|드디어|혹시|그냥|요즘)', 'ja': r'^(今日は|今回は|皆さん|こんにちは|ついに)'}
RESULT_SHOWN = {'ko': r'결국 .*(했다|됐다|였다|이었다|밝혀졌다|성공|실패)|알고 보니 .*(였다|이었다|더라)|정답은|범인은|결과는 .*(였다|다)$',
                'ja': r'結局.*(した|だった)|正解は|犯人は'}
BODY = {'ko': ['손', '발', '얼굴', '눈', '입', '혀', '몸', '팔', '다리', '피부', '아이', '아기', '애기', '맨손', '맨발'],
        'ja': ['手', '足', '顔', '目', '口', '舌', '体', '腕', '肌', '子ども', '子供', '赤ちゃん', '素手', '素足']}
RESULT_LURE = {'ko': r'했더니|봤더니|넣었더니|더니|해 봤|해봤', 'ja': r'したら|てみたら|た結果'}
LEN_RANGE = {'ko': (8, 22), 'ja': (8, 25)}
COMBO_EXCLUDE = ['칼국수', '칼제비', '칼칼', '칼퇴', '불고기', '불닭', '불맛', '불판', '불꽃놀이', '가스레인지']   # 위험 낱말을 품은 음식·일상 낱말


def _strip_tags(t):
    return re.sub(r'\s*#\S+', '', t).strip()


def risky_combo(title, lang='ko'):
    """위험 행위(guide_words risky.objects)×신체 대상 → (종류 문자열, 낱말들) 또는 None."""
    W = guide_words.load()
    risky = W[lang].get('risky') or {}
    for x in COMBO_EXCLUDE:
        title = title.replace(x, ' ')
    obj = list(dict.fromkeys(n for w, n in (risky.get('objects') or {}).items() if w in title))
    body = [b for b in BODY[lang] if re.search(rf'(?<![가-힣]){re.escape(b)}' if lang == 'ko' else re.escape(b), title)]
    if not (obj and body):
        return None
    lure = re.search(RESULT_LURE[lang], title)
    kind = f'위험 행위×신체 대상({"·".join(obj)} × {"·".join(body)})' + (' + 결과 유도' if lure else '')
    return kind, obj + body + ([lure.group(0)] if lure else [])


def jargon_missing(title, desc, jargon):
    """사전 낱말이 제목에 있는데 풀이가 없으면 [(낱말, 인정 문구들)]."""
    out = []
    first = (desc or '').strip().splitlines()[0] if (desc or '').strip() else ''
    for word, glosses in (jargon or {}).items():
        if word.startswith('_') or word not in title:
            continue
        if any(word != w and word in w and w in title for w in jargon):   # «탄핵소추안» 이 걸렸으면 «탄핵소추» 는 따로 안 센다
            continue
        after = title.split(word, 1)[1]
        if re.match(r'\s*[(（]|\s*[—–-]\s', after):
            continue
        if any(g in title or g in first for g in glosses):
            continue
        out.append((word, glosses))
    return out


def check_title(title, kind='shorts', lang='ko', keywords=(), jargon=None, desc=''):
    t = _strip_tags(title or '')
    warns = []
    if kind == 'shorts':
        pats = [name for name, rx in PATTERNS[lang] if re.search(rx, t)]
        if not pats:
            warns.append(('패턴', '10패턴(결과 숨김·이유·저격·숫자·금지·말하다 만다·실화·친근 말투·대사·최상급) 중 하나도 없음'))
        lo, hi = LEN_RANGE[lang]
        n = len(re.sub(r'\s', '', t))
        if not lo <= n <= hi:
            warns.append(('길이', f'공백 빼고 {n}자 — 15자 안팎({lo}~{hi})'))
        if re.search(RESULT_SHOWN[lang], t):
            warns.append(('결과노출', '제목이 답을 말함 — 가장 궁금한 순간 직전까지만'))
        if re.search(r'\S\s*[:：]\s*\S|\s[-–—]\s', t) or t.count('·') >= 2:
            warns.append(('설명형', '«A: B»·«A - B»·나열 요약형 제목'))
        if len(re.findall(r'#\S+', title or '')) >= 2:
            warns.append(('해시태그', '제목 안 해시태그 2개 이상'))
        sup = re.findall(SUPERLATIVE[lang], t)
        if len(sup) >= 2:
            warns.append(('최상급', f'최상급 {len(sup)}개({"·".join(sup)}) — 하나만'))
    kws = [k for k in keywords if k]
    if kws:
        if not any(k in t[:10] for k in kws):
            warns.append(('앞10자', f'키워드({"·".join(kws)}) 중 하나도 앞 10자 «{t[:10]}» 안에 없음'))
    elif re.search(FILLER_OPEN[lang], t):
        warns.append(('앞10자', f'앞이 군말로 시작 «{t[:10]}» — 핵심 낱말을 앞으로'))
    combo = risky_combo(t, lang)
    if combo:
        warns.append(('위험×신체', f'{combo[0]} — 피드 0 사례(롱투숏 ls11) 조합'))
    for cat, ws in guide_words.hits(t, lang):
        if not (combo and cat == '위험 행위'):
            warns.append(('가이드', f'{cat}: {ws}'))
    if kind == 'long':
        for word, gl in jargon_missing(t, desc, jargon):
            warns.append(('전문용어', f'«{word}» 풀이 없음 — 제목 «{word}(…)»·«{word} — …» 또는 설명 첫 줄에 «{gl[0]}» 류'))
    return warns


def titles_from(arg):
    """→ [(이름, 제목, 설명, keywords, title_pattern 유무 또는 None)]"""
    p = Path(arg)
    if not (p.suffix == '.json' and p.exists()):
        if p.suffix == '.json':
            raise FileNotFoundError(arg)
        return [('(문구)', arg, '', [], None)]
    d = json.loads(p.read_text(encoding='utf-8'))
    kws = d.get('keywords') or []
    if isinstance(kws, dict):
        kws = kws.get('keywords') or []
    kws = [k if isinstance(k, str) else str(k.get('keyword', '')) for k in kws]
    out = []
    if 'packages' in d:
        for i, k in enumerate(d['packages']):
            # 포장 표준(packages_gate FIELDS)은 desc_head(설명 첫 두 줄 목록) — description 이 없으면 그것을 쓴다(기업 10-20)
            desc = k.get('description') or '\n'.join(map(str, k.get('desc_head') or []))
            out.append((f'{p.name} {i}번', k.get('title', ''), desc, kws, None))
    top = d.get('top') if isinstance(d.get('top'), dict) else None
    title = d.get('title') or (f"{top.get('l1', '')} {top.get('l2', '')}".strip() if top else '')
    if isinstance(title, list) and all(isinstance(x, str) for x in title):   # 화면 제목 두 줄(롱투숏 plan.title) → 한 제목
        title = ' '.join(title)
    for i, tt in enumerate(title if isinstance(title, list) else [title] if title else []):   # 제목 후보 목록이면 하나씩
        if isinstance(tt, dict):
            tt = tt.get('text') or tt.get('title') or ''
        out.append((p.name + (f' 후보{i}' if isinstance(title, list) else ''), str(tt), d.get('description', ''), kws, 'title_pattern' in d))
    return out


def _append(path, rec):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError as e:
        print(f'⚠ 기록 실패({path.name}): {e}')


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    lane = opt('--lane')
    kind = opt('--kind') or ('long' if lane in LONG_LANES else 'shorts')
    lang = opt('--lang') or ('ja' if lane in JA_LANES else 'ko')
    jpath = opt('--jargon') or (JARGON.get(lane) if lane else None)
    skip = {i + 1 for i, a in enumerate(argv) if a in ('--lane', '--kind', '--lang', '--keywords', '--jargon', '--json')}
    args = [a for i, a in enumerate(argv) if i not in skip and not a.startswith('--')]
    now = _dt.datetime.now().astimezone().isoformat(timespec='seconds')
    try:
        jargon = json.loads(Path(jpath).read_text(encoding='utf-8')) if jpath else None
        items = [it for a in args for it in titles_from(a)]
        if not items or not any(it[1].strip() for it in items):
            raise ValueError('제목 없음')
    except (OSError, ValueError) as e:
        print(f'⚠ 제목 점검 불가: {e} — 통과로 치지 않음(종료 5)')
        _append(LEDGER, {'at': now, 'gate': 'title_check', 'lane': lane, 'script': ' '.join(args), 'error': str(e)})
        return 5
    extra_kw = [k.strip() for k in (opt('--keywords') or '').split(',') if k.strip()]
    results, nwarn = [], 0
    for name, title, desc, kws, has_pat in items:
        ws = check_title(title, kind, lang, extra_kw or kws, jargon, desc)
        if has_pat is False and kind == 'shorts':
            ws.append(('title_pattern', 'spec/upload json 에 title_pattern 필드 없음'))
        nwarn += len(ws)
        results.append({'name': name, 'title': title, 'warnings': [{'code': c, 'msg': m} for c, m in ws]})
        print(f'{"△" if ws else "✓"} {name}: «{title}»')
        for c, m in ws:
            print(f'    △ [{c}] {m}')
        _append(LOG, {'at': now, 'lane': lane, 'kind': kind, 'title': title, 'codes': [c for c, _ in ws],
                      'combo': next((m.split(' — ')[0] for c, m in ws if c == '위험×신체'), None)})
    if opt('--json'):
        Path(opt('--json')).write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'제목 점검({lane or "-"}/{kind}/{lang}): {len(results)}개 · 경고 {nwarn}건' + (' — 경고형, 업로드는 막지 않음' if nwarn else ''))
    return 4 if (nwarn and '--fail-on-warn' in argv) else 0


if __name__ == '__main__':
    sys.exit(main())
