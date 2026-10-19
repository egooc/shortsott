# academy01 편집표 — 컷(빈 구간·헛말 정리)과 자막 덩어리를 원본 시각 → 편집 시각으로 만든다.
#   python plan_edit.py  → edit_plan.json (keep 구간 · subs · sections)
import json, re, sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).parent
tr = json.loads((HERE / 'transcript_v2.json').read_text(encoding='utf-8'))
DUR = 430.75

GAP_MAX, GAP_KEEP = 0.45, 0.25      # 0.45초 넘는 말 사이 공백은 0.25초로
DROP = [(187.20, 189.00), (230.25, 230.70), (424.00, 425.10)]   # «사실 1.» 헛시작 · «어?» · «음.»
LEAD, TAIL = 0.15, 0.30

# 문장 단위 텍스트 교정(전사 오류·학원 이름)
FIX = [("보강'", '보강'), ('라키스', '락키스'), ('이에스엘', 'ESL'), ('보강대가', '보강 사유가'),
       ('얘기해 하는', '얘기하는'), ('어디있어요', '어디 있어요'), ('우리나라게', '우리나라 게'),
       ('못배웠는데', '못 배웠는데'), ('이해 안되서', '이해 안 돼서'), ('만들고싶단', '만들고 싶단'),
       ('해야될까', '해야 될까'), ('토요일밖에 없는거예요', '토요일밖에 없는 거예요'), ('셀로 돌아갈', '새로 돌아갈'),
       ('가르쳐 줄거야', '가르쳐 줄 거야'), ('해주구요', '해 주고요'), ('안심시켜줘야', '안심시켜 줘야')]
OVERRIDE = {263.39: "왜냐면 It's sunny, It's Monday, It's January, It's dark 다 배웠단 말이에요."}
FILLERS = {'어', '음', '어?', '어,'}

# 문장 모으기(낱말 시각 유지)
sents, cur = [], []
for x in tr['results']:
    c = x['alternatives'][0]['content']
    if x['type'] == 'punctuation':
        if cur:
            cur[-1][2] += c
        if c in '.?!' and cur:
            sents.append(cur); cur = []
        continue
    cur.append([float(x['start_time']), float(x['end_time']), c])
if cur:
    sents.append(cur)


def in_drop(t0, t1):
    return any(t0 >= a - 0.05 and t1 <= b + 0.05 for a, b in DROP)


# keep 구간: 낱말 사이 공백을 줄이고 DROP 을 뺀다
words = [w for s in sents for w in s if not in_drop(w[0], w[1])]
keep, a = [], max(0.0, words[0][0] - LEAD)
for w0, w1 in zip(words, words[1:]):
    gap = w1[0] - w0[1]
    if gap > GAP_MAX or in_drop(w0[1], w1[0]) and gap > 0.2:
        keep.append([a, w0[1] + GAP_KEEP / 2]); a = w1[0] - GAP_KEEP / 2
keep.append([a, min(DUR, words[-1][1] + TAIL)])
for b0, b1 in DROP:   # DROP 이 낱말 사이 공백 안에 안 걸린 경우 잘라 낸다
    nk = []
    for k0, k1 in keep:
        if b1 <= k0 or b0 >= k1:
            nk.append([k0, k1])
        else:
            if b0 > k0: nk.append([k0, b0])
            if b1 < k1: nk.append([b1, k1])
    keep = nk
keep = [[round(k0, 3), round(k1, 3)] for k0, k1 in keep if k1 - k0 > 0.05]


def to_edit(t):
    acc = 0.0
    for k0, k1 in keep:
        if t < k0:
            return acc
        if t <= k1:
            return acc + t - k0
        acc += k1 - k0
    return acc


EDIT_DUR = to_edit(DUR)

# 자막 덩어리: 문장마다 낱말을 모아 19자 안팎으로, 끝 꼬리(짧은 마지막 덩어리)는 앞에 붙인다
MAXC = 19
subs = []
for s in sents:
    s = [w for w in s if not in_drop(w[0], w[1])]
    if not s:
        continue
    if all(re.sub(r'[.,?!]', '', w[2]) in FILLERS for w in s):
        continue
    ov = next((v for k, v in OVERRIDE.items() if abs(s[0][0] - k) < 0.1), None)
    if ov:
        toks = ov.split(); t0, t1 = s[0][0], s[-1][1]
        s = [[t0 + (t1 - t0) * i / len(toks), t0 + (t1 - t0) * (i + 1) / len(toks), tk] for i, tk in enumerate(toks)]
    chunks, cur = [], []
    for w in s:
        if cur and len(' '.join(x[2] for x in cur + [w])) > MAXC:
            chunks.append(cur); cur = []
        cur.append(w)
    if cur:
        if chunks and len(' '.join(x[2] for x in cur)) <= 5 and len(' '.join(x[2] for x in chunks[-1] + cur)) <= 23:
            chunks[-1] += cur
        else:
            chunks.append(cur)
    for ch in chunks:
        txt = ' '.join(w[2] for w in ch)
        for a_, b_ in FIX:
            txt = txt.replace(a_, b_)
        txt = re.sub(r'(^|\s)(어|음)[,.?]?(?=\s|$)', ' ', txt)
        txt = re.sub(r'\s+', ' ', txt).strip()
        txt = txt.rstrip('.,')
        if txt:
            subs.append({'t0': round(to_edit(ch[0][0]), 3), 't1': round(to_edit(ch[-1][1]), 3), 'text': txt})
# 자막 사이 짧은 틈은 메운다(깜빡임 방지)
for x, y in zip(subs, subs[1:]):
    if y['t0'] - x['t1'] < 0.6:
        x['t1'] = y['t0']
    else:
        x['t1'] += 0.3

E = to_edit
sections = [
    {'t0': 0, 't1': E(171.9), 'tag': '학부모 설명회 | 보강', 'title': ['보강에 제한을', '두지 않는 이유'], 'key': '보강, 제한 두지 않아요',
     'points': [(E(39.6), '휴강하면 당연히 보강'), (E(67.9), '기한·사유 따지지 않아요'), (E(101.1), '놓친 진도는 아이가 먼저 물어요'),
                (E(149.9), '수업 밖 질문도 언제나 환영')]},
    {'t0': E(171.9), 't1': EDIT_DUR, 'tag': '학부모 설명회 | 토요일 수업', 'title': ['토요일 수업을', '계속하는 이유'], 'key': '토요일 수업, 기한 없이 계속',
     'points': [(E(171.9), '토요일 오전, 무료 형님반'), (E(253.5), '내신 영어까지 잡아 주기'), (E(332.3), '아이들에게 주는 보너스'),
                (E(389.5), '기한 없이 계속합니다')]},
]
plan = {'keep': keep, 'edit_dur': round(EDIT_DUR, 3), 'subs': subs, 'sections': sections}
(HERE / 'edit_plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('keep', len(keep), '구간 · 원본 %.1f초 → %.1f초 · 자막 %d개' % (DUR, EDIT_DUR, len(subs)))
for x in subs:
    print('%6.2f-%6.2f %s' % (x['t0'], x['t1'], x['text']))
