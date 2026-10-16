# -*- coding: utf-8 -*-
"""어랍숏 «새 카테고리 투입 키트» v1 — kit.json 하나로 N100 이 그대로 붙여 넣을 4종을 만들고 검사한다.

    python scripts/arabshot_kit.py check kits/arabshot/<key>/kit.json
    python scripts/arabshot_kit.py build kits/arabshot/<key>/kit.json      # 검사 통과 시 같은 폴더에 산출물

산출물(N100 형식 그대로, 10-16 N100 샘플 기준):
  frames.json   — ~/volcano-channel/config/script-frames.json 에 넣을 {레인키: {...}} 한 항목(「_공통」은 건드리지 않음)
  tpl.py        — tpl_render.py TPL 에 넣을 한 줄 (색 &HAABBGGRR)
  desc.json     — publish.json description 본문 예 + hashtags/tags (업로드가 덧붙이는 고지·음악 표기는 빼고)
  guide.md      — recipes/script-guides/<이름>.md 뼈대(맨 위 소유주 결정 블록 + 레퍼런스 실측 칸)
  CHECKLIST.md  — 어랍숏 고정 규칙(콜드오픈·효과 문구·컷 패턴·템포·BGM·facts·P1)
  channels.json — (kit.channel 이 있으면) channels.json 레인 항목: 바꿀 칸만 kit 에서, 운영 값은 base 그대로
  bgm_license.json — (kit.bgm 이 있으면) assets/bgm/<이름>_<레인키>/license.json 초안(sha256 은 N100 이 받은 뒤 채움)
검사: FAIL 이면 종료 코드 4, 산출물을 쓰지 않는다.
왜 (handoff-tools 백로그 8, 소유주 «템플릿 미리»): 도구의쓸모 교체 등 카테고리를 바꿀 때 형식 실수(자막 y·글꼴·범위 모순·출처 표기)를
  N100 게이트(own_gate·check_template·업로드 거부)에 가기 전에 잡는다.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import shorts_safe as SS  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BG = {'none', 'black', 'blur'}
MODES = {'pop', 'box', 'soft', 'sweep', 'bounce'}
COLOR = re.compile(r'^&H[0-9A-Fa-f]{8}$')
RANGES = ('sentences', 'chars', 'd', 'cuts', 'seconds')
CAP_Y_MAX = 1440        # N100 check_template: 자막 중심 y ≤ 1440
CAP_MAX_CHARS = 8       # N100 check_template: max_chars 8 · lines 1
CHECKLIST = """# 어랍숏 고정 규칙 — {name} (`{key}`)

N100 10-16 샘플 기준. 카테고리가 바뀌어도 이 줄들은 그대로다.

- [ ] 콜드오픈 1.6초 — 가장 센 그림, 위험 외침형 자막(예: «밀고 온다?!»)
- [ ] 화면 카드(효과 문구) 공백 포함 11자 이하 · 효과 문구 y = 내레이션 y − 170
- [ ] 사건형 13컷 `N N D N N D N N N D N D N` (D = 딴지 컷, 피사체 옆 subject_pos)
- [ ] 완성본 템포 1.12배 · BGM 은 해설보다 20dB 아래
- [ ] 숫자가 들어간 문장은 facts.json 필수 · P1 시트(p1.json) 필수
- [ ] 끝 카드 없음 — 마무리는 원고 규칙(끝 문장 = 여운{ending})
- [ ] 설명란 출처는 «🎥 @원작자» 만(레딧 r/·u/ 는 업로드 거부, @ 없으면 거부) · 제목에 한글/가나 섞이면 거부 · hashtags 에 #shorts
- [ ] 머리띠(제목 2줄, y≈161/269, title_hl 강조)는 TPL 밖 title 스타일
- [ ] 감정 문장 45~50% · S1 중복도 사전 검사 · banned 구절 · 실명 인물에게 지어낸 사건·발언 금지 · 사고·유혈 금지
{extra}"""


def _rng(v):
    return isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v) and v[0] <= v[1]


def check(kit):
    """[(level, area, msg)]"""
    out = []
    for k in ('key', 'name', 'lang', 'frames', 'tpl', 'desc'):
        if k not in kit:
            out.append(('FAIL', 'kit', '%s 가 없다' % k))
    if any(lv == 'FAIL' for lv, _, _ in out):
        return out
    if not re.match(r'^(ko|ja|en)_[a-z0-9_]+$', kit['key']):
        out.append(('FAIL', 'frames', '레인 키는 «ko_xxx» 꼴(channel.json 의 channel 값): %r' % kit['key']))
    # ① script-frames
    for k in RANGES:
        if not _rng(kit.get(k)):
            out.append(('FAIL', 'frames', '%s 는 [하한, 상한] 이어야 한다: %r' % (k, kit.get(k))))
    if not any(lv == 'FAIL' and a == 'frames' for lv, a, _ in out):
        (s0, s1), (c0, c1), (d0, d1), (k0, k1), (t0, t1) = (kit[k] for k in RANGES)
        if c1 / s0 > 40 or c0 / s1 < 15:
            out.append(('WARN', 'frames', '문장당 글자 %.0f~%.0f — 어랍숏 30자 문장 규칙과 멀다' % (c0 / s1, c1 / s0)))
        if not (4.5 <= c0 / t1 and c1 / t0 <= 7.0):
            out.append(('WARN', 'frames', '초당 글자 %.1f~%.1f — 도구의쓸모 5.3~5.9(템포 1.12)와 멀다' % (c0 / t1, c1 / t0)))
        if d1 > k0:
            out.append(('FAIL', 'frames', '딴지 컷 d 상한 %d > 컷 하한 %d' % (d1, k0)))
        if not (2.5 <= t0 / k1 and t1 / k0 <= 5.0):
            out.append(('WARN', 'frames', '컷당 %.1f~%.1f초 — 2.5~5초 밖' % (t0 / k1, t1 / k0)))
    if not kit['frames'] or not all(isinstance(f, str) and re.match(r'^\d+ ', f) for f in kit['frames']):
        out.append(('FAIL', 'frames', 'frames 는 «1 원리 공개(기본)» 꼴 문자열 목록'))
    v = kit.get('voice')
    if v is not None and not {'style', 'share', 'run', 'kinds', 'flat'} <= set(v):
        out.append(('WARN', 'frames', 'voice 에 style·share·run·kinds·flat 중 빠진 칸(check-script-voice.js 가 읽음)'))
    # ② TPL
    t = kit['tpl']
    cap = t.get('cap', {})
    if not re.match(r'^[a-z][a-z0-9_]*$', t.get('key', '')):
        out.append(('FAIL', 'tpl', 'TPL 키는 영소문자: %r' % t.get('key')))
    if t.get('bg') not in BG:
        out.append(('FAIL', 'tpl', 'bg 는 %s 중 하나: %r' % ('|'.join(sorted(BG)), t.get('bg'))))
    box = t.get('box')
    if not (isinstance(box, list) and len(box) == 4 and box[0] >= 0 and box[1] >= 0
            and box[0] + box[2] <= 1080 and box[1] + box[3] <= 1920):
        out.append(('FAIL', 'tpl', 'box (x, y, w, h) 가 1080x1920 밖: %r' % box))
    elif t.get('bg') != 'none' and box[1] + box[3] > 1450:
        out.append(('WARN', 'tpl', '영상 칸 아래 끝 %d > 1450 — N100 check_template subject_low' % (box[1] + box[3])))
    if cap.get('mode') not in MODES:
        out.append(('FAIL', 'tpl', 'cap.mode 는 %s 중 하나: %r' % ('|'.join(sorted(MODES)), cap.get('mode'))))
    for c in ('c', 'k', 'oc'):
        if c in cap and not COLOR.match(str(cap[c])):
            out.append(('FAIL', 'tpl', 'cap.%s 색은 &HAABBGGRR: %r' % (c, cap[c])))
    if cap.get('y', 9999) > CAP_Y_MAX:
        out.append(('FAIL', 'tpl', '자막 중심 y %s > %d (N100 check_template)' % (cap.get('y'), CAP_Y_MAX)))
    font = SS.find_font(cap.get('font', ''), dirs=[str(ROOT / 'assets' / 'fonts')]) if cap.get('font') else None
    if not font:
        out.append(('WARN', 'tpl', '글꼴 %r 을 이 PC 에서 못 찾았다 — 폭은 1em 근사(N100 은 편 폴더 fonts/)' % cap.get('font')))
    if isinstance(cap.get('y'), (int, float)) and isinstance(cap.get('size'), (int, float)):
        els = [{'name': 'narr', 'x': 540, 'y': cap['y'], 'an': 5, 'fs': cap['size'], 'max_chars': CAP_MAX_CHARS,
                'outline': cap.get('o', 0), 'font': font},
               {'name': 'effect', 'x': 540, 'y': cap['y'] - 170, 'an': 5, 'fs': cap['size'], 'max_chars': 11,
                'outline': cap.get('o', 0), 'font': font, 'grade': 'decor'}]
        for lv, rule, msg in SS.check_template(els):
            out.append((lv, 'tpl', '%s %s' % (rule, msg)))
    # ③ 설명란
    d = kit['desc']
    credit = d.get('credit', '')
    if not credit.startswith('@') or re.search(r'(^|\s)(r|u)/', credit):
        out.append(('FAIL', 'desc', '출처는 «@원작자» (r/·u/ 금지): %r' % credit))
    if '#shorts' not in [h.lower() for h in d.get('hashtags', [])]:
        out.append(('FAIL', 'desc', 'hashtags 에 #shorts 가 없다'))
    if any(h.startswith('#') for h in d.get('tags', [])) or any(' ' in x for x in d.get('tags', [])):
        out.append(('WARN', 'desc', 'tags 는 # 없이 일반 명사 하나씩'))
    # ④ channels.json 레인 항목(선택) — 색은 #RRGGBB(recaption 층), TPL 의 &H 색과 다른 층
    c = kit.get('channel')
    if c is not None:
        hexc = re.compile(r'^#[0-9A-Fa-f]{6}$')
        if not c.get('lanes') or any(x.startswith(('r/', '/r/')) for x in c['lanes']):
            out.append(('FAIL', 'channel', 'lanes 는 서브레딧 이름 목록(r/ 없이)'))
        if not hexc.match(str(c.get('look', {}).get('band', ''))):
            out.append(('FAIL', 'channel', 'look.band 는 #RRGGBB'))
        for part, st in (c.get('caption_style') or {}).items():
            for k in ('color', 'outline_color'):
                if k in st and not hexc.match(str(st[k])):
                    out.append(('FAIL', 'channel', 'caption_style.%s.%s 는 #RRGGBB: %r' % (part, k, st[k])))
            idle = (st.get('karaoke') or {}).get('idle_color')
            if idle and not hexc.match(idle):
                out.append(('FAIL', 'channel', 'caption_style.%s.karaoke.idle_color 는 #RRGGBB' % part))
        base = c.get('base', {})
        for k in ('handle', 'slots_kst', 'per_day'):
            if k not in base:
                out.append(('WARN', 'channel', 'base 에 %s 가 없다 — 운영 채널 값을 그대로 옮겨야 한다' % k))
    return out


def tpl_line(t):
    def val(x):
        return repr(tuple(x)) if isinstance(x, list) else repr(x)
    cap = ', '.join('%s=%s' % (k, val(v)) for k, v in t['cap'].items())
    extra = ''.join(', %s=%s' % (k, val(t[k])) for k in ('border',) if k in t)
    return "'%s': dict(bg=%r, box=%s%s, cap=dict(%s))," % (t['key'], t['bg'], val(t['box']), extra, cap)


def guide_md(kit, base=None):
    ref = kit.get('ref')
    L = ['# %s — 원고 지침 (`%s`)' % (kit['name'], kit['key']), '',
         '> **소유주 결정** — %s' % kit.get('decision', '(날짜 · 소유주 말 그대로 · 이 카테고리를 왜 하는가 · 하지 말 것)'), '',
         '## 틀', ''] + ['- %s' % f for f in kit['frames']] + [
         '', '## 수치(script-frames 와 같다)', '',
         '- 문장 %s · 글자 %s · 딴지 컷 %s · 컷 %s · 초 %s' % tuple('%s~%s' % tuple(kit[k]) for k in RANGES)]
    if kit.get('voice'):
        L.append('- 말투: %s' % json.dumps(kit['voice'], ensure_ascii=False))
    L += ['', '## 레퍼런스 실측(W15 — 벤치 대본 20~100편)', '']
    if ref and (ROOT / ref / 'channel.json').exists():
        ch = json.loads((ROOT / ref / 'channel.json').read_text(encoding='utf-8'))
        L += ['- 출처: `%s` (ref_analyze) — %s, 조회 중앙 %s, 중앙 길이 %s초, 3배+ 편 %.0f%%'
              % (ref, ch.get('title'), f"{ch.get('views_median', 0):,}", ch.get('duration_median_sec'), ch.get('share_over_3x', 0) * 100),
              '- 상·하위 차이 Top 5는 `%s/class.md` 를 옮겨 적는다.' % ref]
    else:
        L += ['- (ref_analyze 로 벤치 채널을 재고 `ref` 에 경로를 넣으면 여기 숫자가 채워진다)']
        if kit.get('bench'):
            L += ['- 잴 벤치 채널: %s' % ' · '.join(kit['bench'])]
    L += ['', '## 구조 빈도·고유 표현', '', '- (벤치 대본에서 구조별 % — 첫 문장 유형·전환 장치·끝 문장)', '',
          '## 금지', ''] + ['- %s' % b for b in kit.get('banned', [])] + ['']
    body = kit.get('guide_body')  # 손으로 쓴 지침 본문(kit.json 옆 파일) — 뼈대 뒤에 붙인다
    if body and base and (base / body).exists():
        L += ['---', '', (base / body).read_text(encoding='utf-8').rstrip(), '']
    return '\n'.join(L)


def build(kit, out):
    entry = {k: kit[k] for k in ('name', 'guide', 'frames') if k in kit}
    entry.update({k: kit[k] for k in RANGES})
    for k in ('voice', 'banned'):
        if k in kit:
            entry[k] = kit[k]
    (out / 'frames.json').write_text(json.dumps({kit['key']: entry}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (out / 'tpl.py').write_text('# tpl_render.py TPL 에 붙여 넣는다\n' + tpl_line(kit['tpl']) + '\n', encoding='utf-8')
    d = kit['desc']
    (out / 'desc.json').write_text(json.dumps({'description': '%s\n\n🎥 %s' % (d.get('body_example', ''), d['credit']),
                                               'hashtags': d['hashtags'], 'tags': d.get('tags', [])},
                                              ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (out / 'guide.md').write_text(guide_md(kit, out), encoding='utf-8')
    (out / 'CHECKLIST.md').write_text(CHECKLIST.format(name=kit['name'], key=kit['key'],
                                                       ending=' · ' + kit['ending'] if kit.get('ending') else '',
                                                       extra=''.join('- [ ] %s\n' % x for x in kit.get('extra_rules', []))),
                                    encoding='utf-8')
    if 'channel' in kit:
        (out / 'channels.json').write_text(json.dumps({kit['key']: channel_entry(kit)}, ensure_ascii=False, indent=2) + '\n',
                                           encoding='utf-8')
    if 'bgm' in kit:
        b = kit['bgm']
        (out / 'bgm_license.json').write_text(json.dumps(dict(
            {'title': b['title'], 'composer': 'Kevin MacLeod', 'license': 'CC BY 4.0',
             'license_url': 'https://creativecommons.org/licenses/by/4.0/', 'source_url': b.get('source_url', ''),
             'sha256': '', 'file': b['file'], 'folder': 'assets/bgm/%s_%s/' % (b['folder_name'], kit['key']),
             'credit': '"%s" by Kevin MacLeod (incompetech.com)' % b['title']}), ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8')


def channel_entry(kit):
    """channels.json 레인 항목 — 바꿀 칸(lanes·category·pinpoint·look·caption_style·template·bgm)만 kit 에서,
    나머지(status·handle·슬롯·voice …)는 kit['channel']['base'] 그대로(관리자 10-16: 채널·발행 슬롯·업로드는 유지)."""
    c = kit['channel']
    e = dict(c.get('base', {}))
    for k in ('format', 'lanes', 'category', 'pinpoint', 'note', 'look', 'caption_style'):
        if k in c:
            e[k] = c[k]
    e['template'] = kit['tpl']['key']
    if 'bgm_under' in c:
        e['bgm'] = {'under': c['bgm_under'], 'off': False}
    return e


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='어랍숏 새 카테고리 투입 키트')
    ap.add_argument('cmd', choices=['check', 'build'])
    ap.add_argument('kit')
    a = ap.parse_args(argv)
    path = Path(a.kit)
    kit = json.loads(path.read_text(encoding='utf-8'))
    issues = check(kit)
    for lv, area, msg in issues:
        print('%s [%s] %s' % (lv, area, msg))
    if any(lv == 'FAIL' for lv, _, _ in issues):
        print('FAIL — 산출물을 쓰지 않는다')
        return 4
    if a.cmd == 'build':
        build(kit, path.parent)
        print('→ %s/{frames.json, tpl.py, desc.json, guide.md, CHECKLIST.md%s%s}' % (
            path.parent, ', channels.json' if 'channel' in kit else '', ', bgm_license.json' if 'bgm' in kit else ''))
    else:
        print('PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
