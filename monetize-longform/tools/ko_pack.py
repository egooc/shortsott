# -*- coding: utf-8 -*-
"""수창 ko 편 포장기 — 렌더 뒤 한 번: seg_starts.json → 목차 시각, comment_spec at_sec 실측, description.txt(≤4,900자), upload.json.

    python -X utf8 monetize-longform/tools/ko_pack.py monetize-longform/ep_ko03 [--dry]

입력: script.txt(## N. 제목), seg_starts.json(렌더 산출), packages.json(packages[0]), lane.json(purpose·categoryId),
      docs/research_*.md(마크다운 링크 → 출처), points.json(선택: {"points": [..3], "notice": [..]}), comment_spec.json.
출력: description.txt, upload.json(video_id 없음), comment_spec.json(at_sec 갱신). 기존 video_id 가 있으면 보존.
"""
import html
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAT = {'ko_event': '15', 'ko_mon2_old': '28', 'ko_robot': '28', 'ko_mon': '2', 'ko_highlight': '27'}


def load(p, default=None):
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default


def mmss(s):
    s = int(round(s))
    return f'{s // 60}:{s % 60:02d}'


def chapters(ep):
    out, cur = [], None
    for line in (ep / 'script.txt').read_text(encoding='utf-8').splitlines():
        m = re.match(r'^## (\d+)\.?\s*(.*)$', line.strip())
        if m:
            cur = (int(m.group(1)), m.group(2).strip())
            continue
        if line.startswith('@') and cur is not None:
            out.append((cur[0], cur[1], line[1:].strip()))
            cur = None
    return out


def build_seg_starts(ep):
    """seg/<idx>-<vid>-<hash>/segment.mp4 길이를 순서대로 더해 seg_starts.json 을 만든다(렌더러가 안 남길 때)."""
    out, t = {}, 0.0
    dirs = sorted([d for d in (ep / 'seg').iterdir() if d.is_dir() and (d / 'segment.mp4').exists()], key=lambda d: int(d.name.split('-')[0]))
    if not dirs:
        raise SystemExit('seg/*/segment.mp4 없음 — 렌더 뒤에 실행')
    for d in dirs:
        idx, vid = d.name.split('-')[0], '-'.join(d.name.split('-')[1:-1])
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(d / 'segment.mp4')], capture_output=True, text=True)
        dur = round(float(r.stdout.strip()), 2)
        out.setdefault(vid, []).append([int(idx), round(t, 2), dur])
        t += dur
    (ep / 'seg_starts.json').write_text(json.dumps(out, ensure_ascii=False) + chr(10), encoding='utf-8')
    print(f'seg_starts.json 생성: {len(dirs)}개 · 합계 {t:.1f}초')
    return out


def main(argv):
    ep = (ROOT / argv[0]).resolve() if not Path(argv[0]).is_absolute() else Path(argv[0])
    dry = '--dry' in argv
    seg = load(ep / 'seg_starts.json')
    if not seg:
        seg = build_seg_starts(ep)
    starts = {vid: v[0][1] for vid, v in seg.items()}
    total = max(v[-1][1] + v[-1][2] for v in seg.values())
    pk = load(ep / 'packages.json')
    p0 = pk['packages'][0]
    lane = load(ep / 'lane.json', {})
    purpose = lane.get('purpose', pk.get('purpose'))
    cat = str(lane.get('categoryId') or CAT.get(purpose, '27'))
    pts = load(ep / 'points.json', {})
    lang = lane.get('lang', 'ko')   # ja 편(ja03~)도 같은 포장기 — 설명 라벨만 언어별(10-23)
    L = {'ko': dict(toc='▼목차', ch='{t} {n}장 {title}', outro='여러분의 답은?', pts='▼이 영상의 포인트', src='▼출처(공개 자료)', more='・그 밖의 자료는 영상 속 표기를 참고해 주세요(전체 {k}건)',
                    notice=['숫자와 연도는 아래 공개 자료를 바탕으로 했고, 자료마다 다른 부분은 «약»·«추정»으로 구분해 말합니다.', '그림은 설명을 위해 만든 것으로, 실존 인물·실제 제품의 재현이 아닙니다.']),
         'ja': dict(toc='▼目次', ch='{t} 第{n}章 {title}', outro='あなたはどちら派？', pts='▼この動画のポイント', src='▼出典（公表資料・辞典）', more='・そのほかの資料は動画内の表記をご覧ください（全{k}件）',
                    notice=['人数・年号は下の公表資料と辞典をもとにしています。資料ごとに数字が違う点は「およそ」「記録によれば」と区別して話しています。', '場面の絵は説明のために作ったもので、実在の人物・史料の再現ではありません。'])}[lang]
    # 댓글 at_sec
    cs = load(ep / 'comment_spec.json')
    q_vid = next((v for v in ('ending_q', 'end_question') if v in starts), None)
    if cs and q_vid:
        cs['expected_comment']['at_sec'] = round(starts[q_vid] + 0.3, 1)
        cs['_note'] = re.sub(r'at_sec 는.*$', f'at_sec 는 렌더 실측(@{q_vid} 시작 {starts[q_vid]:.1f} + 0.3, 전체 {total:.1f}초).', cs.get('_note', ''), flags=re.S)
    # 목차
    ch = chapters(ep)
    first_vid = next(iter(seg))
    toc = [f'0:00 {pts.get("intro") or p0["big"][0] + " — " + p0["title"].split("｜")[0]}']
    for n, title, vid in ch:
        if vid in starts and n >= 1:
            toc.append(L['ch'].format(t=mmss(starts[vid]), n=n, title=title))
    if q_vid:
        toc.append(f'{mmss(starts[q_vid])} {pts.get("outro") or L["outro"]}')
    # 출처
    seen, urls = [], set()
    for md in sorted(ep.glob('docs/research_*.md')):
        for m in re.finditer(r'\[([^\]]+)\]\((https?://[^)\s]+)\)', md.read_text(encoding='utf-8')):
            t, u = m.group(1).strip(), m.group(2).strip()
            if u not in urls and not t.lower().startswith(('http', 'www')):
                urls.add(u)
                seen.append((t, u))
    head = '\n'.join(p0['desc_head']) + f'\n\n{L["toc"]}\n' + '\n'.join(toc) + f'\n\n{L["pts"]}\n' + '\n'.join('・' + x for x in pts.get('points', [])) + '\n\n' + '\n'.join('※ ' + x for x in pts.get('notice', L['notice'])) + f'\n\n{L["src"]}\n'
    tail = '\n' + ' '.join(p0['hashtags'])
    budget = 4900 - len(head) - len(tail)
    src, n = '', 0
    for t, u in seen:
        line = f'・{t}\n　{u}\n'
        if len(src) + len(line) > budget - 60:
            break
        src += line
        n += 1
    if n < len(seen):
        src += L['more'].format(k=len(seen)) + '\n'
    # ★10-23 실제 영상 인용(clips.json): 장면표에 실제로 들어간 클립만, 출처는 글로만(URL 없음 — 관리자 지시)
    cj = load(ep / 'clips.json')
    vis_clips = {x['clip']['key'] for x in (load(ep / 'visuals.json', {}) or {}).values() if isinstance(x, dict) and x.get('clip')}
    if cj and vis_clips:
        lines = []
        for c in cj['clips']:
            if c['key'] not in vis_clips:
                continue
            if c.get('source') == 'Reddit':
                lines.append(f"・{c.get('title_ko', c['key'])} — Reddit r/{c.get('sub')} · u/{c.get('author')}")
            else:
                author = html.unescape(re.sub(r'<[^>]+>', '', str(c.get('author', '')))).strip()  # Commons 작성자 칸의 HTML 앵커·엔티티 제거(10-24)
                lines.append(f"・{c.get('title_ko', c['key'])} — {c.get('source', '')} · {author} · {c.get('license', '')}".replace(' ·  ·', ' ·').rstrip(' ·'))
        vs = ('\n▼영상 출처(짧은 인용, 원음 없음)\n' if lang == 'ko' else '\n▼映像の出典（短い引用・音声なし）\n') + '\n'.join(lines) + '\n'
        if len(head) + len(src) + len(vs) + len(tail) <= 4900:
            src += vs
    desc = head + src + tail
    old = load(ep / 'upload.json', {})
    up = {"file": str(ep / 'episode.mp4').replace('\\', '/'), "title": p0['title'], "description": desc,
          "pinned_comment": cs.get('pinned_comment') if cs else None, "privacy": "public", "categoryId": cat, "defaultLanguage": lang,
          "madeForKids": False, "thumbnail": str(ROOT / p0['thumbnail']).replace('\\', '/'), "tags": p0['tags'],
          "_note": f"{lane.get('channel', '')} 업로드용 메타(yt-upload.js 꼴, purpose {purpose}). 소유주 10-22 «바로 올리고 바로 공개» → public·containsSyntheticMedia=true(yt_publish --synthetic)·태그 gate(yt_tags_purpose). 댓글은 업로더가 publishAt 없으면 pinned_comment 로 달고 고정은 스튜디오. 교체 포장은 packages[1·2]. 영상 {mmss(total)}({total:.1f}초). categoryId {cat}."}
    for k in ('video_id', 'uploaded_at', 'tags_verified', 'published_at', 'comment_id'):
        if k in old:
            up[k] = old[k]
    print(f'{ep.name}: {mmss(total)} · 목차 {len(toc)} · 출처 {n}/{len(seen)} · 설명 {len(desc)}자 · 댓글 at_sec {cs["expected_comment"]["at_sec"] if cs and q_vid else "-"}')
    if dry:
        print(desc[:1200])
        return 0
    (ep / 'description.txt').write_text(desc, encoding='utf-8')
    (ep / 'upload.json').write_text(json.dumps(up, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if cs:
        (ep / 'comment_spec.json').write_text(json.dumps(cs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    r = subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'packages_gate.py'), str(ep.relative_to(ROOT)).replace('\\', '/'), '--lang', lang], capture_output=True, text=True, encoding='utf-8')
    print((r.stdout.strip().splitlines() or [r.stderr.strip()])[-1], f'(종료 {r.returncode})')
    return r.returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
