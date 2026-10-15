# 린박스 이름 관문 — 자막·내레이션·제목·설명에 나오는 인물 이름을 작품 배역표와 대조한다.
#
#   python scripts/rinbox_names.py <plan.json> [<곁딸린 .rinbox.json>]      문제가 있으면 종료코드 1
#
# 왜 (2026-10-08): 전사를 그대로 믿고 사마귀 편에 「정희」「차수현」을 썼는데 실제 배역은 정이신·차수열이었다
# (위키). 볼케이노에도 이 장치는 없었다 — 내레이션은 모델이 쓰고 이름은 아무도 대조하지 않았다.
# 렌더러가 TTS 를 사기 «전에» 이걸 부른다 — 틀린 이름은 돈을 쓰기 전에 막는다.
#
# 배역표는 rinbox_catalog.json 의 works.<작품>.cast — 출처(source)로 확인한 이름만 넣는다.
#   cast: [{"name": "정이신", "aliases": ["정이신 씨"], "actor": "고현정"}, ...]
#   asr_fixes: {"정희": "정이신", ...}   ← 전사가 자주 틀리는 꼴. 화면·내레이션·설명에 보이면 막는다.
#
# 판정
#   ✗ 막음  — asr_fixes 의 틀린 꼴이 «보이는 글»(자막 표시글·내레이션·제목·설명)에 있다
#   △ 경고  — 호칭(씨·님·さん·様…)이 붙은 이름이 배역표에 없다(지나가는 인물일 수 있어 막지는 않는다)
import json, re, sys
from pathlib import Path

CATALOG = Path('D:/midform/midform/config/rinbox_catalog.json')
KO_TITLE = r'(?:씨|님|선생님|대표님|대표|실장님|실장|과장님|과장|팀장님|팀장|회장님|회장|형사님|형사|검사님|검사|사장님|사장|원장님|원장)'
JA_TITLE = r'(?:さん|様|殿|ちゃん|くん|君|先生)'
# 호칭 앞에 와도 이름이 아닌 말(직함·대명사 등)
NOT_NAMES = {'선생', '대표', '과장', '실장', '팀장', '회장', '사장', '원장', '아저씨', '아가', '언니', '오빠', '형', '누나',
             '할아버', '할머', '아버', '어머', '여러분', '자매', '형제', '하느', '하나', '부처', '스님', '신부', '수녀', '우리', '그쪽', '거기', '당신', '자기', '선배', '후배', '손님', '고객',
             '上', '奥', '親分', '旦那', 'お嬢', 'お姫', '姫', '殿', 'お客', '皆', '先生', 'お兄', 'お姉', 'お父', 'お母', 'おばあ', 'おじい',
             '馬場', '赤木', '将軍', '社長', '部長', '課長', '兄', '姉', '母', '父',
             # 사람을 부르는 보통명사(2026-10-09 85ja 「娘さん」 오탐)
             '娘', '息子', '坊', '嬢', '爺', '婆', '女将', '若', '親方', '番頭', '大家', '奥方', '家老', '殿様', '浪人', '親父'}


def visible_texts(plan, meta):
    out = []
    for n in plan.get('narration', []):
        out.append(('내레이션 ' + n['id'], ' '.join(n['cards'])))
    for i, s in enumerate(plan.get('sequence', [])):
        for c in s.get('captions', []):
            out.append(('자막#%d' % i, c.split('|', 1)[1] if '|' in c else c))
    out.append(('제목', ' '.join(plan.get('title', []))))
    if meta:
        out.append(('설명', meta.get('description', '')))
        out.append(('메타 제목', meta.get('title', '')))
    return out


def check(plan_path, meta_path=None):
    plan = json.loads(Path(plan_path).read_text(encoding='utf-8'))
    meta = json.loads(Path(meta_path).read_text(encoding='utf-8')) if meta_path else None
    cat = json.loads(CATALOG.read_text(encoding='utf-8'))['works']
    work_key = (meta or {}).get('work') or plan.get('work')
    if not work_key:   # 크레딧으로 작품을 찾는다
        work_key = next((k for k, w in cat.items() if re.search(w.get('match', '$^'), plan.get('credit', ''), re.I)), None)
    work = cat.get(work_key or '', {})
    cast = work.get('cast') or []
    fixes = work.get('asr_fixes') or {}
    names = set()
    for c in cast:
        names.add(c['name']); names.update(c.get('aliases', []))
        if len(c['name']) >= 3 and re.match(r'^[가-힣]+$', c['name']):
            names.add(c['name'][1:])               # 한국 이름은 성을 뺀 부름(은호·지윤)도 맞다
    errors, warns, seen = [], [], set()
    for where, text in visible_texts(plan, meta):
        for wrong, right in fixes.items():
            if wrong in text.replace(right, ''):     # 맞는 이름 안에 든 글자는 빼고 본다
                errors.append('%s: 「%s」 → 배역표는 「%s」' % (where, wrong, right))
        # 이름 뒤에 바로 붙는 호칭만 본다(「들뜬 대표」 같은 수식어를 이름으로 읽지 않게). 앞은 낱말 경계.
        for m in re.finditer(r'(?<![가-힣])([가-힣]{2,3})(?:\s?씨|님|\s(?:대표|실장|과장|팀장|회장|형사|검사|사장|원장)님?)(?![가-힣])', text):
            seen.add(m.group(1))
        # 일본어는 한자·가타카나 덩어리 + 호칭(히라가나가 섞인 「その前にお姫」 같은 꼴은 이름이 아니다)
        #   앞에 「お・ご」가 붙은 꼴(お前さん·お客さん·ご隠居さん)은 미화어라 이름이 아니다(85ja 「前」 오탐).
        for m in re.finditer(r'(?<![一-龥ァ-ヶーおご])([一-龥ァ-ヶー]{1,5})' + JA_TITLE, text):
            seen.add(m.group(1))
    actors = {c.get('actor') for c in cast if c.get('actor')}
    credit = plan.get('credit', '') + ' ' + ' '.join(plan.get('title', []))
    for nm in sorted(seen):
        # 「막은 검사」「도와준 형사」처럼 꾸미는 말(관형형 -은·-는·-던·-을)은 이름이 아니다(88ko 오탐)
        if re.match(r'^[가-힣]+(?:은|는|던|을)$', nm) and len(nm) >= 2 and nm[-1] in '은는던을' and nm not in names:
            continue
        if nm in actors or nm in credit or nm in NOT_NAMES or any(nm.startswith(x) for x in NOT_NAMES if len(x) > 1):
            continue
        if not any(nm == n or nm in n or n in nm for n in names):
            warns.append('호칭 붙은 이름 「%s」 가 배역표에 없다' % nm)
    print('이름 관문 · 작품 %s · 배역표 %d명%s' % (work_key or '?', len(cast), '' if cast else ' ★배역표 없음 — 이름을 쓰려면 먼저 등록'))
    for e in errors:
        print('  ✗', e)
    for w in warns:
        print('  △', w)
    if not errors and not warns:
        print('  통과')
    return not errors


if __name__ == '__main__':
    ok = check(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    sys.exit(0 if ok else 1)
