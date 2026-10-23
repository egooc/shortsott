# -*- coding: utf-8 -*-
"""수창용 롱폼 관문 — 인계 docs/handoff-monetize-longform-20261021.md §4-1(소유주 10-21 «devo-6 방식 지켜라, 대신 20분» → ★10-22 «억지로 늘리지 말고 여러 개» 약 10분).

    python -X utf8 monetize-longform/gates.py <편 폴더> candidate   후보표 3열(recent_hit·rising·bench) — 비면 주제 확정 금지
    python -X utf8 monetize-longform/gates.py <편 폴더> package     제목·썸네일 5안(packages.json drafts) — 없으면 원고 착수 금지
    python -X utf8 monetize-longform/gates.py <편 폴더> script      TTS 전 원고 관문 전부(render.py 가 렌더러 script_gate 자리에 넣는다)

편 폴더에 lane.json {"lang": "ko"|"ja", "channel": "..."} 이 있어야 한다. 종료 0 = 통과 · 3 = 걸림.
기존 공용 관문(ref_overlap·script_audit·comment_hook)은 import·호출만 한다(고치지 않는다).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ja-nenkin' / 'render'))
import nenkin_render as R  # noqa: E402  parse_script 만

PY = [sys.executable, '-X', 'utf8']
SC = ROOT / 'scripts'
# 원고 문장·장면 복제 0 — 기존 4레인 레퍼런스 + 이 레인 시트 전사(발굴 시트의 상위 영상 자막을 md 로)
REFS = {'ko': ['reference/ko_corp/corp_refs/transcripts', 'reference/ko_politics/politics_refs/transcripts', 'reference/monetize_ko/transcripts'],
        'ja': ['reference/ja_nenkin/nenkin_refs/transcripts', 'reference/ja_politics/politics_refs/transcripts', 'reference/monetize_ja/transcripts']}
AUDIT_LANE = {'ko': 'corp_ko', 'ja': 'nenkin_ja'}   # script_audit 롱폼 규칙(V12·V14·K3)이 걸리는 레인 이름
# ★10-22 소유주 «억지로 늘리지 말고 여러 개» + 관리자 정정(21:4x): 기본 약 10분(8분 미만 금지), 단 레퍼런스 «터진 편»(중앙값 ×3)의 길이가 20분 이상이면 그 길이를 따른다.
# 실측 ko 359~368자/분(ko02·ko03), ja 321자/분(ja02) → 공백 제외 글자 수 = 분 × RATE. 범위는 목표의 90~120%(10분 → ko 3,270~4,360·ja 2,890~3,850), 바닥 8분.
# 원고·그림까지 끝난 편(ko04·ko06·ko07·ko08·ja03·ja04, 20분)은 그대로 렌더, 새 원고부터 적용. 옛 20분 고정 범위: ko 7500~8500·ja 5900~7800.
RATE = {'ko': 363, 'ja': 321}
REF_CAP_MIN = 30   # 목표 길이 상한(분) — 10-24 관리자 승인
REF_LONG_MIN = 20          # 레퍼런스 중앙 길이가 이 분 이상이면 그 길이를 목표로
DUR_ENFORCE_FROM = '2026-10-23'   # 이 날짜 이후 만든 후보표(keywords.json at)는 recent_hit[].dur_sec 필수


def picked_row(ep):
    rows = (load(ep / 'keywords.json', {}) or {}).get('candidates') or []
    return next((r for r in rows if r.get('picked')), rows[0] if rows else {})


OLD_CHARS = {'ko': (7500, 8500), 'ja': (5900, 7800)}   # 10-23 전 후보표(원고·그림 끝난 20분 편)는 옛 범위 그대로


def target_minutes(ep):
    """목표 길이(분)와 근거. 관리자 10-22 21:5x 확정: 레퍼런스 터진 편(×3 이상) 길이 중 «가장 짧은» 것이 20분 이상이면 그 길이, 아니면 10분(소유주 «억지로 늘리지 말라»)."""
    durs = sorted(h['dur_sec'] / 60 for h in (picked_row(ep).get('recent_hit') or []) if isinstance(h, dict) and isinstance(h.get('dur_sec'), (int, float)))
    if durs:
        ref = durs[0]
        if ref >= REF_LONG_MIN:
            if ref > REF_CAP_MIN:   # 관리자 10-24 08:2x 승인: 모음집형 레퍼런스(80~100분)는 상한 30분 — «억지로 늘리지 말고 편수로»
                return REF_CAP_MIN, f'레퍼런스 터진 편 최단 {ref:.0f}분 → 상한 {REF_CAP_MIN}분 적용'
            return ref, f'레퍼런스 터진 편 최단 {ref:.0f}분 → 목표 {ref:.0f}분'
        return 10, f'레퍼런스 터진 편 최단 {ref:.0f}분(20분 미만) → 목표 10분'
    return 10, '레퍼런스 길이 없음 → 기본 10분'


def chars_range(ep, lang):
    at = str((load(ep / 'keywords.json', {}) or {}).get('at', ''))[:10]
    if at < DUR_ENFORCE_FROM:
        lo, hi = OLD_CHARS[lang]
        return lo, hi, 20, f'10-23 전 후보표({at}) → 옛 20분 범위 그대로'
    m, why = target_minutes(ep)
    lo = max(8 * RATE[lang], int(0.9 * m * RATE[lang]))
    return lo, int(1.2 * m * RATE[lang]), m, why
END_EVAL = {'ko': ('결국', '교훈', '정리하면', '대단한', '대단하', '놀라운', '인상적'),
            'ja': ('結局', '教訓', 'まとめると', 'すごい', '素晴らしい', '見事')}
REWIND_Q = re.compile(r'(어떻게 된 걸까|어떻게 됐을까|무슨 일이 있었던 걸까|どうなったのか|何があったのか)')
REWIND_BACK = re.compile(r'(시간을 거슬러|그날로 돌아가|이야기는 .{0,12}에서 시작|時をさかのぼ|時間を巻き戻|話は.{0,12}にさかのぼ)')


def load(p, default=None):
    p = Path(p)
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default


def candidate(ep):
    """keywords.json candidates 행마다 세 열 필수(소유주 10-21 01:5x «키워드·이슈 트래픽·채널 벤치»)."""
    rows = (load(ep / 'keywords.json', {}) or {}).get('candidates') or []
    if not rows:
        return ['후보표: keywords.json candidates 없음 — 주제 확정 금지']
    bad = []
    for i, r in enumerate(rows):
        lost = []
        hits = r.get('recent_hit') or []
        # ① 같은 시청층 국내 채널 30일 안 중앙값×3 편(yt_news_outliers.js 채널 목록만 바꿔 재사용)
        # ★10-22 소유주 «비슷한 롱폼 채널 중 터진 편» 열 필수: 채널명·조회·채널 중앙값 대비 배수 ≥3·공개일(days) — 없으면 그 주제 탈락
        if not hits or any(not isinstance(h, dict) or not h.get('video_id') or not h.get('channel') or not isinstance(h.get('views'), (int, float))
                           or not isinstance(h.get('ratio'), (int, float)) or h['ratio'] < 3 or not isinstance(h.get('days'), (int, float)) or h['days'] > 30 for h in hits):
            lost.append('recent_hit[{channel, video_id, views, ratio≥3, days≤30}] — 비슷한 롱폼 채널의 터진 편 없으면 탈락')
        # ★10-22 관리자 정정: 터진 편 길이(dur_sec)로 목표 길이를 정한다(≥20분이면 그 길이) — 새 후보표부터 필수
        if hits and str((load(ep / 'keywords.json', {}) or {}).get('at', ''))[:10] >= DUR_ENFORCE_FROM and any(not isinstance(h.get('dur_sec'), (int, float)) for h in hits if isinstance(h, dict)):
            lost.append('recent_hit[].dur_sec(터진 편 길이 초) — 목표 길이 계산용')
        # ② rising_keywords 스냅숏(상승 점수 + 스냅숏 파일)
        ri = r.get('rising') or {}
        if not isinstance(ri.get('score'), (int, float)) or not ri.get('snapshot'):
            lost.append('rising{score, snapshot}')
        # ③ 발굴 레퍼런스 시트 + 썸네일 자극어 패턴
        b = r.get('bench') or {}
        if not b.get('sheet') or not (ROOT / b['sheet']).exists() or not b.get('thumb_patterns'):
            lost.append('bench{sheet(있는 파일), thumb_patterns[]}')
        if not str(r.get('keyword', '')).strip():
            lost.append('keyword')
        if lost:
            bad.append(f'후보표 {i}번 «{r.get("keyword", "?")}»: {", ".join(lost)} 비었거나 맞지 않음')
    return bad


def package(ep):
    """제목·썸네일 먼저 — 5안(제목·썸네일 문구·근거 영상 id·예상 CTR 순위), 업로드 묶음은 상위 3안(packages_gate 가 따로 본다)."""
    d = (load(ep / 'packages.json', {}) or {}).get('drafts') or []
    if len(d) < 5:
        return [f'packages.json drafts {len(d)}안 — 5안 필요(원고 착수 금지)']
    bad = [f'drafts {i}번: {k} 없음' for i, x in enumerate(d) for k in ('title', 'thumb_text', 'basis_video', 'ctr_rank') if not x.get(k)]
    ranks = sorted(x.get('ctr_rank') for x in d if isinstance(x.get('ctr_rank'), int))
    if ranks != list(range(1, len(d) + 1)):
        bad.append(f'drafts ctr_rank 가 1~{len(d)} 한 번씩이 아님: {ranks}')
    return bad


def words(s):
    return {w for w in re.findall(r'[가-힣A-Za-z0-9]{2,}|[一-龥ァ-ヴー]{2,}', s)}


def script(ep, lang):
    bad, warn = [], []
    sp = ep / 'script.txt'
    blocks = R.parse_script(sp)
    sents = [s for b in blocks for s in b['sentences']]
    text = ''.join(sents)
    bad += package(ep)
    # 길이: 기본 약 10분, 레퍼런스 터진 편이 20분 이상이면 그 길이(8분 미만 금지)
    if lang in RATE:
        n = len(re.sub(r'\s', '', text))
        lo, hi, m, why = chars_range(ep, lang)
        print(f'[길이] {why} · 글자 {n}(공백 제외) ≈ {n / RATE[lang]:.1f}분 · 허용 {lo}~{hi}')
        if not lo <= n <= hi:
            bad.append(f'글자 수 {n}(공백 제외) — {lo}~{hi} ({why})')
    # 인트로 없이 썸네일 장면부터: 첫 문단 ↔ 1번 썸네일 문구 공통 낱말 ≥1
    d = sorted((load(ep / 'packages.json', {}) or {}).get('drafts') or [], key=lambda x: x.get('ctr_rank', 99))
    if d and blocks:
        first = ' '.join(blocks[0]['sentences'])
        common = words(first) & words(f'{d[0].get("thumb_text", "")} {d[0].get("title", "")}')
        if not common:
            bad.append(f'첫 문단과 1번 썸네일·제목 공통 낱말 0 — 썸네일 장면부터 시작해야 한다')
    # 되감기(결과 먼저 → 시간 역행) WARN
    for i, s in enumerate(sents[:-1]):
        if REWIND_Q.search(s) and any(REWIND_BACK.search(t) for t in sents[i + 1:i + 3]):
            warn.append(f'되감기 꼴 {i}번째 문장 «{s[:30]}»')
    # 엔딩 평가 금지: 끝 3문장
    for s in sents[-3:]:
        hit = [w for w in END_EVAL[lang] if w in s]
        if hit:
            bad.append(f'끝 3문장 평가·요약 어휘 {hit} «{s[:30]}»')
    # 화면 = 문장당 1~2장: 화면 하나에 2문장까지(렌더러는 화면 블록마다 그림·판 하나)
    vis = load(ep / 'visuals.json', {}) or {}
    for b in blocks:
        if len(b['sentences']) > 2:
            bad.append(f'화면 @{b["vid"]} 문장 {len(b["sentences"])}개 — 한 화면 2문장(약 12초)까지')
        if b['vid'] not in vis:
            bad.append(f'visuals.json 에 @{b["vid"]} 없음')
    if blocks and not len(sents) <= 2 * len(blocks):
        bad.append(f'화면 {len(blocks)}개 < 문장 {len(sents)}/2')
    # 불확실 팩트: 연금 렌더러 facts_gate 와 같은 형식 {facts: [{id, claim, status}], checked_by} — gpt-ask 교차 뒤 confirmed·fixed 만
    uf = load(ep / 'uncertain_facts.json')
    if uf is None:
        bad.append('uncertain_facts.json 없음(불확실 팩트 목록 → gpt-ask 교차 1회)')
    else:
        left = [f'#{x.get("id")}({x.get("status")})' for x in uf.get('facts', []) if x.get('status') not in ('confirmed', 'fixed')]
        if left:
            bad.append(f'불확실 팩트 미해결 {len(left)}건: {", ".join(left[:8])}')
        elif not uf.get('checked_by'):
            bad.append('uncertain_facts.json checked_by(교차 확인 기록) 없음')
    # 공용 관문 — 호출만
    refs = [a for r in REFS[lang] for a in ('--refs', str(ROOT / r))]
    r = subprocess.run(PY + [str(SC / 'ref_overlap.py'), str(sp), '--lang', lang, *refs], capture_output=True, text=True, encoding='utf-8')
    print('[관문] ref_overlap:', (r.stdout.strip().splitlines() or [r.stderr.strip()])[-1], f'(종료 {r.returncode})', flush=True)
    if r.returncode:
        bad.append(f'ref_overlap 종료 {r.returncode}')
    sys.path.insert(0, str(SC))
    import script_audit
    a = script_audit.audit(sp, lane=AUDIT_LANE[lang])
    if a.get('error') or a.get('warnings'):
        bad.append('script_audit ' + (a.get('error') or ' / '.join(f'[{w["code"]}] {w["msg"]}' if isinstance(w, dict) else f'[{w[0]}] {w[1]}' for w in a['warnings'])))
    r = subprocess.run(PY + [str(SC / 'comment_hook.py'), str(ep), '--lane', 'generic', '--spec', str(ep / 'comment_spec.json' if (ep / 'comment_spec.json').exists() else ep / 'packages.json'), '--script', str(sp)],
                       capture_output=True, text=True, encoding='utf-8')
    print('[관문] comment_hook:', (r.stdout.strip().splitlines() or [r.stderr.strip()])[0], f'(종료 {r.returncode})', flush=True)
    if r.returncode:
        bad.append(f'comment_hook 종료 {r.returncode}')
    for w in warn:
        print('[관문] WARN', w, flush=True)
    return bad


def main(argv=None):
    sys.stdout.reconfigure(encoding='utf-8')
    argv = sys.argv[1:] if argv is None else argv
    ep, what = Path(argv[0]).resolve(), argv[1]
    lang = (load(ep / 'lane.json', {}) or {}).get('lang')
    if lang not in ('ko', 'ja'):
        print('[관문] FAIL lane.json {"lang": "ko"|"ja"} 없음')
        return 3
    bad = candidate(ep) if what == 'candidate' else package(ep) if what == 'package' else script(ep, lang)
    for b in bad:
        print('[관문] FAIL', b)
    print('[관문]', 'FAIL' if bad else 'PASS', what, ep.name)
    return 3 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
