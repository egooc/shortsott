# -*- coding: utf-8 -*-
"""ja 정치 롱폼 원고 검사 — midform/config/ja_politics_script_frames.json 의 checks(D1~D7·F1)와 소재·비율 상한을 기계로 건다.

    python scripts/ja_politics_script_check.py issues/1.json [issues/2.json ...] [--episode] [--fetch] [--json]

- 입력은 틀의 issue_schema 형식(issues/<no>.json). 해설·인용 순서는 선택 필드 script([{type:nar,text,read?},{type:quote,q:N}]).
- 파일 여러 개 + --episode 면 한 편으로 보고 편 길이(20~40분)·해설 비율(≥60%)을 FAIL 로 건다. 아니면 비율은 WARN.
- D3·D7: 국회 인용은 minutes.speech(회의록 원문)와 대조. 없으면 --fetch 로 회의록 API(speechID) 조회,
  그래도 없으면(회의록이 아직 API에 없음) FAIL 대신 «회의록 대조 대기» WARN.
- F1: issues/ 옆 factcheck/script_<no>.md. 없거나 «틀림» 판정이 남아 있으면 FAIL.
종료 코드: 0 통과(WARN 만), 4 FAIL 있음, 2 인자 오류.
왜 (2026-10-16 정치JA 요청·관리자 합의): 명예훼손(刑法230条の2)·인용(著作権法32条) 위험을 사람이 원고를 다 읽기 전에 거른다.
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

FRAMES = Path(__file__).resolve().parents[1] / 'midform' / 'config' / 'ja_politics_script_frames.json'
HEDGE = ('主張', '報じ', '疑い', 'とされ', '指摘', 'と述べ', '批判', '見方', 'という')
PRIVATE = ('家族', '病気', '病状', '住所', '自宅', '交際', '不倫', '宗教', '信仰', '離婚', '子ども', '子供', '妻', '夫人')
INSULT = ('売国奴', '嘘つき', 'うそつき', 'バカ', '馬鹿', 'アホ', 'クズ', 'ゴミ', 'キチガイ', '死ね', '無能', '低能', '発狂', '国賊')
INSULT_COND = ('犯罪者',)  # 확정 판결이 있으면 쓸 수 있다 — 사람 확인
PARTY_RE = r'^(自民党|自由民主党|維新|日本維新の会|立憲民主党|立憲|共産党|日本共産党|れいわ(新選組)?|中道改革連合|参政党|日本保守党|公明党|国民民主党)は'


def frames():
    return json.loads(FRAMES.read_text(encoding='utf-8'))


def norm(t):
    """회의록 대조용 — 공백·구두점·괄호 주석 제거."""
    t = re.sub(r'[（(][^）)]*[）)]', '', t or '')
    return re.sub(r'[\s　、。，．,.・「」『』！？!?…―—-]', '', t)


def origin(q, fr):
    if q.get('origin') in ('kantei', 'kokkai'):
        return q['origin']
    hay = ' '.join(str(q.get(k, '')) for k in ('src', 'source', 'tag')) + ' ' + str((q.get('minutes') or {}).get('speechURL', ''))
    for kind in ('kokkai', 'kantei'):
        if any(m in hay for m in fr['source_limits'][kind]['match']):
            return kind
    return None


def fetch_speech(speech_id):
    url = 'https://kokkai.ndl.go.jp/api/speech?' + urllib.parse.urlencode(
        {'speechID': speech_id, 'recordPacking': 'json', 'maximumRecords': 1})
    with urllib.request.urlopen(url, timeout=20) as r:
        recs = json.loads(r.read().decode('utf-8')).get('speechRecord') or []
    return recs[0].get('speech', '') if recs else ''


def nar_texts(s):
    return [seg.get('text', '') for seg in s.get('script', []) if seg.get('type') == 'nar']


def durations(s, fr):
    """(해설 초, 원음 초) — 해설은 읽기 글자 ÷ 속도."""
    rate = fr['episode_limits']['read_speed_chars_per_sec']
    qs = s.get('quotes', [])
    nar = sum(len(seg.get('read') or seg.get('text', '')) for seg in s.get('script', []) if seg.get('type') == 'nar') / rate
    used = [seg['q'] for seg in s.get('script', []) if seg.get('type') == 'quote' and isinstance(seg.get('q'), int)]
    src = sum(max(0.0, qs[i]['out'] - qs[i]['in']) for i in used if 0 <= i < len(qs))
    return nar, src


def check(s, fr=None, base=None, fetch=False):
    """[(level, id, msg)] — 논점 파일 하나."""
    fr = fr or frames()
    out = []
    no = s.get('no', '?')
    subjects = {x.get('name'): x for x in s.get('subjects', [])}
    src_ids = {x.get('id') for x in s.get('sources', [])}
    quotes = s.get('quotes', [])
    nars = nar_texts(s)
    commentary = nars + [s.get('summary', ''), s.get('title', ''), s.get('question', '')] + [
        (s.get('sides', {}).get(k) or {}).get('position', '') for k in ('ours', 'other', 'third')]

    # D1 공공성 — 인용 발언자·subjects 모두 공적 지위가 있다
    for name, x in subjects.items():
        if not (x.get('public_role') or '').strip():
            out.append(('FAIL', 'D1', 'subjects %r 에 public_role 이 없다' % name))
    for i, q in enumerate(quotes):
        if q.get('speaker') not in subjects:
            out.append(('FAIL', 'D1', 'quotes[%d] 발언자 %r 가 subjects 에 없다' % (i, q.get('speaker'))))

    # D2 공익 목적·사생활
    if not (s.get('public_interest') or '').strip():
        out.append(('FAIL', 'D2', 'public_interest 가 비었다'))
    hits = sorted({w for t in commentary for w in PRIVATE if w in t})
    if hits:
        out.append(('WARN', 'D2', '사생활 낱말 %s — 공적 활동과 관련 있는지 사람 확인' % hits))

    # D3 진실성 — 출처·회의록
    for k, f in (('facts_confirmed', lambda x: x.get('source_id')), ('allegations', lambda x: x.get('source_id')),
                 ('timeline', lambda x: x[2] if len(x) > 2 else None)):
        for i, x in enumerate(s.get(k, [])):
            sid = f(x)
            if sid not in src_ids:
                out.append(('FAIL', 'D3', '%s[%d] source_id %r 가 sources 에 없다' % (k, i, sid)))
    for i, x in enumerate(s.get('sources', [])):
        if not re.match(r'https?://', x.get('url', '')):
            out.append(('FAIL', 'D3', 'sources[%d] url 이 없다' % i))

    # 소재 상한 · D3 회의록 · D7 문장 경계
    lim = fr['source_limits']
    for i, q in enumerate(quotes):
        hay = ' '.join(str(q.get(k, '')) for k in ('src', 'source', 'tag'))
        bad = [m for m in lim['banned']['match'] if m in hay]
        if bad:
            out.append(('FAIL', 'SRC', 'quotes[%d] 금지 소재 %s — %s' % (i, bad, lim['banned']['why'])))
        kind = origin(q, fr)
        sec = q.get('out', 0) - q.get('in', 0)
        if kind is None:
            out.append(('WARN', 'SRC', 'quotes[%d] 소재 종류를 모른다 — origin 에 kantei|kokkai' % i))
        elif lim[kind]['max_quote_sec'] and sec > lim[kind]['max_quote_sec']:
            out.append(('FAIL', 'SRC', 'quotes[%d] 국회 중계 %.1f초 — 한 구간 ≤%d초(32条 인용)'
                        % (i, sec, lim[kind]['max_quote_sec'])))
        if sec <= 0:
            out.append(('FAIL', 'SRC', 'quotes[%d] in/out 이 비었거나 거꾸로(%s~%s)' % (i, q.get('in'), q.get('out'))))
        for ph in q.get('phrases', []):
            if norm(ph.replace('*', '')) not in norm(q.get('text', '')):
                out.append(('FAIL', 'D7', 'quotes[%d] phrase %r 가 원문에 없다' % (i, ph)))
        if kind != 'kokkai':
            continue
        m = q.get('minutes') or {}
        speech = m.get('speech', '')
        if not speech and fetch and m.get('speechID'):
            try:
                speech = fetch_speech(m['speechID'])
            except Exception as e:  # 네트워크 실패는 판정 보류
                out.append(('WARN', 'D3', 'quotes[%d] 회의록 조회 실패: %s' % (i, e)))
        if not m.get('speechURL') or not speech:
            out.append(('WARN', 'D3', 'quotes[%d] 회의록 대조 대기(%s) — 회의록이 API 에 올라오면 다시 돌린다'
                        % (i, q.get('tag', ''))))
            continue
        body, t = norm(speech), norm(q.get('text', ''))
        pos = body.find(t)
        if not t or pos < 0:
            out.append(('FAIL', 'D3', 'quotes[%d] 원문이 회의록 발언에 없다 — 받아쓰기 확인' % i))
            continue
        # D7: 원문 앞이 문장 시작, 끝이 문장 끝인지(구두점은 norm 에서 빠지므로 원문으로 본다)
        raw = re.sub(r'\s', '', speech)
        head = re.sub(r'\s', '', q.get('text', ''))[:6]
        k0 = raw.find(head)
        if k0 > 0 and raw[k0 - 1] not in '。？！?!」○':
            out.append(('FAIL', 'D7', 'quotes[%d] 문장 중간에서 시작한다 — 앞 「。」 뒤부터' % i))
        if not re.search(r'[。？！?!」]$', q.get('text', '').strip()):
            out.append(('FAIL', 'D7', 'quotes[%d] 문장 끝(「。」)에서 끝나지 않는다' % i))

    # D4 의혹은 의혹으로
    for i, a in enumerate(s.get('allegations', [])):
        if not any(h in a.get('text', '') for h in HEDGE):
            out.append(('FAIL', 'D4', 'allegations[%d] 유보 표현이 없다: %r' % (i, a.get('text', '')[:40])))
        if not (a.get('by') or '').strip():
            out.append(('FAIL', 'D4', 'allegations[%d] by(누가 주장하나)가 비었다' % i))
    for t in nars:
        for a in s.get('allegations', []):
            core = a.get('text', '')[:12]
            if core and core in t and not any(h in t for h in HEDGE):
                out.append(('FAIL', 'D4', '해설이 의혹을 확정처럼 쓴다: %r' % t[:40]))

    # D5 인신공격어(해설만 — 인용 원문은 제외)
    for t in commentary:
        w = [x for x in INSULT if x in t]
        if w:
            out.append(('FAIL', 'D5', '해설에 %s: %r' % (w, t[:40])))
        w = [x for x in INSULT_COND if x in t]
        if w:
            out.append(('WARN', 'D5', '%s — 확정 판결이 있는지 사람 확인: %r' % (w, t[:40])))

    # D6 일반화 — 한 사람 인용 직후 해설 첫 문장 주어가 정당
    seq = s.get('script', [])
    for j in range(1, len(seq)):
        if seq[j].get('type') == 'nar' and seq[j - 1].get('type') == 'quote':
            first = re.split(r'[。！？]', seq[j].get('text', ''))[0]
            if re.match(PARTY_RE, first):
                out.append(('WARN', 'D6', '한 의원 인용 뒤 정당 전체가 주어: %r' % first[:40]))

    # F1 사실 확인 표
    if base is not None:
        fc = base.parent.parent / 'factcheck' / ('script_%s.md' % no)
        if not fc.exists():
            out.append(('FAIL', 'F1', 'factcheck 표 없음: %s' % fc))
        else:
            txt = fc.read_text(encoding='utf-8')
            wrong = len(re.findall(r'\|\s*(틀림|誤り)\s*\|', txt))
            if wrong:
                out.append(('FAIL', 'F1', 'factcheck 에 «틀림» %d건 — 고친 뒤 표를 다시 낸다' % wrong))

    if not s.get('script'):
        out.append(('WARN', 'RATIO', 'script 가 없다 — 해설·원음 비율을 잴 수 없다'))
    return out


def ratio_check(items, fr, episode):
    lim = fr['episode_limits']
    nar = sum(durations(s, fr)[0] for s in items)
    src = sum(durations(s, fr)[1] for s in items)
    out = []
    if nar + src <= 0:
        return out, nar, src
    share = nar / (nar + src)
    lv = 'FAIL' if episode else 'WARN'
    if share < lim['narration_share_min']:
        out.append((lv, 'RATIO', '해설 %.0f%% · 원음 %.0f%% — 해설 ≥%d%%'
                    % (share * 100, 100 - share * 100, lim['narration_share_min'] * 100)))
    if episode:
        lo, hi = lim['episode_min']
        mins = (nar + src) / 60
        if not lo <= mins <= hi:
            out.append(('FAIL', 'LEN', '편 %.1f분 — %d~%d분 밖(콜드·오프닝·클로징 제외 추정)' % (mins, lo, hi)))
    return out, nar, src


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='ja 정치 롱폼 원고 검사(D1~D7·F1·소재·비율)')
    ap.add_argument('issues', nargs='+')
    ap.add_argument('--episode', action='store_true', help='파일들을 한 편으로 보고 편 길이·비율을 FAIL 로')
    ap.add_argument('--fetch', action='store_true', help='회의록 API 로 speechID 원문 조회')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    fr = frames()
    items, report = [], []
    for p in a.issues:
        path = Path(p)
        s = json.loads(path.read_text(encoding='utf-8'))
        items.append(s)
        report.append({'file': p, 'no': s.get('no'), 'issues': check(s, fr, path, a.fetch)})
    extra, nar, src = ratio_check(items, fr, a.episode)
    fails = [i for r in report for i in r['issues'] if i[0] == 'FAIL'] + [i for i in extra if i[0] == 'FAIL']
    if a.json:
        print(json.dumps({'ok': not fails, 'files': report, 'episode': extra,
                          'narration_sec': round(nar, 1), 'source_sec': round(src, 1)}, ensure_ascii=False, indent=2))
    else:
        for r in report:
            print('== %s (no %s)' % (r['file'], r['no']))
            for lv, cid, msg in r['issues']:
                print('%s %s %s' % (lv, cid, msg))
        for lv, cid, msg in extra:
            print('%s %s %s' % (lv, cid, msg))
        print('해설 %.0f초 · 원음 %.0f초' % (nar, src))
        print('PASS' if not fails else 'FAIL %d건' % len(fails))
    return 4 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
