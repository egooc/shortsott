// 유튜브 지원 현황판(잡탕 광산·발굴분석·도구개발) 공용 — office/modules/{jabtang,discovery,tools}.js 가 쓴다.
// 읽기 전용. 각 판은 오피스에서 프로젝트처럼 따로 뜬다(board.parent = 'shortsott').
//   docs/jabtang-mine/status.json            잡탕 광산 (발굴분석 세션이 매일 덮어씀)
//   docs/work-status/<도구개발|발굴분석>.json  세션 진행판 (각 세션이 일 바뀔 때마다)
//   docs/handoff-manager-20261014.md §10     세션이 남긴 기록 줄 — 줄 그대로가 아니라 카드로 정리해 보인다

const fs = require('fs');
const path = require('path');
const { vid } = require('./droptrack');

const ROOT = path.resolve(__dirname, '../../..');
const D = (p) => path.join(ROOT, p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(D(p), 'utf8')); } catch { return null; } };
const kst = (ms) => new Date(ms + 9 * 3600e3);
const mdhm = (ms) => { if (!ms) return '—'; const d = kst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.toISOString().slice(11, 16)}`; };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const fmt = (v) => v == null ? '—' : v >= 10000 ? `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}만` : v.toLocaleString('ko-KR');
const arr = (v) => (Array.isArray(v) ? v : []);

// ── 잡탕 광산 ──
const GYEOL_TONE = { 후보: 'muted', 검증됨: 'warn', 배정됨: 'busy', 투하: 'ok' };
const RANK = { 투하: 0, 배정됨: 1, 검증됨: 2, 후보: 3 };

function mineDashboard(track) {
  const m = readJson('docs/jabtang-mine/status.json');
  const base = { title: '잡탕 광산', updated_at: m?.updated ? new Date(Date.parse(m.updated)).toISOString() : new Date().toISOString(),
    board: { parent: 'shortsott', manager: 'YTHOME-M-발굴분석', sessions: ['YTHOME-M-발굴분석'] } };
  if (!m) return { ...base, tabs: [{ key: 'overview', label: '현황', sections: [{ type: 'note', text: '첫 판을 기다리는 중입니다. 발굴분석 세션이 결 카드를 올리면 5분 안에 채워집니다.' }] }] };

  const st = m.stage || {};
  const none = (v) => (v == null || /^(없음|none|-|)$/i.test(String(v).trim()) ? null : v);
  const gy = arr(m.gyeol).map((g) => ({ ...g, our_channel: none(g.our_channel), status: g.status || (num(g.channels) >= 2 ? '검증됨' : '후보') }));
  const gname = new Map(gy.map((g) => [g.id, g.name || g.id]));
  for (const c of arr(m.channels)) for (const h of arr(c.hits)) if (h.gyeol && h.gyeol_label && !gname.has(h.gyeol)) gname.set(h.gyeol, h.gyeol_label);
  const by = (k) => gy.filter((g) => g.status === k).length;
  const nAssigned = gy.filter((g) => g.our_channel || g.status === '배정됨' || g.status === '투하').length; // 상태 칸이 늦게 바뀌어도 우리 채널이 적혔으면 배정
  const drops = gy.reduce((a, g) => a + arr(g.drops).length, 0);

  const gyeolCards = gy.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)).map((g) => {
    const ev = (arr(g.evidence).length ? arr(g.evidence) : g.best ? [g.best] : [])
      .map((e) => [e.channel, e.title && `«${e.title}»`, num(e.views) != null && `${fmt(e.views)}회`, num(e.x) != null && `평소의 ${e.x}배`].filter(Boolean).join(' '));
    const dropTxt = arr(g.drops).map((d) => `${d.published || ''} «${d.title || ''}» ${fmt(num(d.views))}회 (채널 평소 ${fmt(num(d.channel_median))}회${num(d.views) != null && num(d.channel_median) ? `, ${(d.views / d.channel_median).toFixed(1)}배` : ''})`);
    return {
      title: g.name || g.id, tone: GYEOL_TONE[g.status] || '',
      sub: [g.status, g.channels != null && `독립 채널 ${g.channels}곳`, g.hits != null && `터진 편 ${g.hits}개`, g.our_channel && `→ ${g.our_channel}`, dropTxt.length && `투하 ${dropTxt.length}편`].filter(Boolean).join(' · '),
      detail: [`소재: ${g['소재'] || '—'}`, `감정: ${g['감정'] || '—'}`, `틀: ${g['틀'] || '—'}`, ev.length && `근거: ${ev.join(' / ')}`,
        ...arr(g.subs).map((x) => `세부 결: ${x.name}${x['대상'] ? ` — 대상 ${x['대상']}` : ''}${x['상황'] ? ` · 상황 ${x['상황']}` : ''}${num(x.hits) != null ? ` (터진 편 ${x.hits}개)` : ''}`),
        g.specialist && `이 결만 하는 전문 채널: ${g.specialist}`, g.risk && `위험: ${g.risk}`, g.longshort_fit != null && `롱투숏에 ${g.longshort_fit ? '맞음' : '안 맞음'}`,
        dropTxt.length ? `투하 결과: ${dropTxt.join(' / ')}` : g.our_channel && '아직 투하 전'].filter(Boolean).join('\n'),
      rec: g.our_angle ? `${g.our_channel ? g.our_channel + '에 ' : ''}우리 관점: ${g.our_angle}` : '',
      session: 'YTHOME-M-발굴분석',
    };
  });

  // 결 분석이 끝난 채널: 평소 조회 → 터진 편(몇 배) → 어느 결로 묶였나
  const CH_MAX = 80;
  const best = (c) => Math.max(0, ...arr(c.hits).filter((h) => h.gyeol).map((h) => num(h.views) || 0)); // 터진 편 조회가 큰 채널부터
  const allChans = arr(m.channels);
  const chans = allChans.filter((c) => arr(c.hits).some((h) => h.gyeol)).sort((a, b) => best(b) - best(a)).slice(0, CH_MAX);
  const chanCards = chans.map((c) => {
    const hits = arr(c.hits);
    const gs = [...new Set([...arr(c.gyeol), ...hits.map((h) => h.gyeol).filter(Boolean)])].map((id) => gname.get(id) || id);
    return {
      title: c.name || c.url || '이름 없음', tone: gs.length ? 'ok' : 'muted',
      sub: [num(c.median) != null && `평소 ${fmt(c.median)}회`, `터진 편 ${hits.length}개`, gs.length ? `결: ${gs.join(', ')}` : '결 없음'].join(' · '),
      detail: [c.why && `잡탕 판정: ${c.why}`, num(c.measured_videos) != null && `조회 잰 편 ${c.measured_videos}개`,
        ...hits.slice(0, 8).map((h) => `«${String(h.title || '').slice(0, 60)}» ${fmt(num(h.views))}회${num(h.x) != null ? ` (평소의 ${h.x}배)` : ''} → ${h.gyeol ? gname.get(h.gyeol) || h.gyeol : '결 미배정'}`),
        c.url && `채널 주소: ${c.url}`].filter(Boolean).join('\n'),
      session: 'YTHOME-M-발굴분석',
    };
  });

  // 우리 채널별로 어느 결이 배정됐나
  const assigned = new Map();
  for (const g of gy) if (g.our_channel) { if (!assigned.has(g.our_channel)) assigned.set(g.our_channel, []); assigned.get(g.our_channel).push(g); }
  const assignCards = [...assigned].sort((a, b) => b[1].length - a[1].length).map(([ch, gs]) => {
    const nd = gs.reduce((a, g) => a + arr(g.drops).length, 0);
    return {
      title: ch, tone: nd ? 'ok' : 'busy',
      sub: `결 ${gs.length}개 · 투하 ${nd}편`,
      right: gs.map((g) => g.name || g.id).join(' / '),
      detail: gs.map((g) => {
        const e = arr(g.evidence)[0] || g.best;
        return [`■ ${g.name || g.id}`, `  소재 ${g['소재'] || '—'} · 감정 ${g['감정'] || '—'} · 틀 ${g['틀'] || '—'}`,
          g.channels != null && `  남의 채널 ${g.channels}곳에서 ${g.hits ?? '?'}편 터짐`,
          e && `  대표 편: ${e.channel ? e.channel + ' ' : ''}«${String(e.title || '').slice(0, 50)}» ${fmt(num(e.views))}회${num(e.x) != null ? ` (평소의 ${e.x}배)` : ''}`,
          g.our_angle && `  우리 관점: ${g.our_angle}`,
          arr(g.drops).length ? `  투하: ${arr(g.drops).map((d) => `«${d.title || ''}» ${fmt(num(d.views))}회`).join(', ')}` : '  아직 투하 전'].filter(Boolean).join('\n');
      }).join('\n\n'),
      session: 'YTHOME-M-발굴분석',
    };
  });
  const hitCards = allChans.flatMap((c) => arr(c.hits).map((h) => ({ c, h }))).sort((a, b) => (num(b.h.views) || 0) - (num(a.h.views) || 0)).slice(0, 30)
    .map(({ c, h }) => ({ title: String(h.title || '').slice(0, 60), tone: h.gyeol ? 'ok' : 'muted',
      sub: [c.name, `${fmt(num(h.views))}회`, num(h.x) != null && `평소의 ${h.x}배`].filter(Boolean).join(' · '),
      right: h.gyeol ? `결: ${gname.get(h.gyeol) || h.gyeol}` : '결 미배정',
      detail: [`채널: ${c.name || '—'} (평소 ${fmt(num(c.median))}회)`, h.url && `영상: ${h.url}`].filter(Boolean).join('\n'), session: 'YTHOME-M-발굴분석' }));

  // 투하 편 추적: 배정 → 공개 → 24h 중간 → 48h 판정. 조회 기록은 droptrack 이 한 시간마다 공개 수치로 쌓는다.
  const tv = track?.videos || {};
  const H = 3600e3;
  const dropRows = gy.flatMap((g) => arr(g.drops).map((d) => {
    const id = vid(d.url);
    const t = (id && tv[id]) || {};
    const snaps = arr(t.snaps);
    const last = snaps[snaps.length - 1];
    const pub = Date.parse(t.published || d.published || '') || null;
    const views = last ? last.views : num(d.views);
    const med = num(d.channel_median);
    const ratio = views != null && med ? views / med : null;
    const age = pub ? (Date.now() - pub) / H : null;
    return { g, d, id, t, snaps, last, pub, views, med, ratio, age };
  }));
  const strikes = new Map(); // 결×채널마다 48h 넘어 평소 이하 횟수
  for (const r of dropRows) if (r.age >= 48 && r.ratio != null && r.ratio < 1) { const k = `${r.g.id}|${r.g.our_channel}`; strikes.set(k, (strikes.get(k) || 0) + 1); }
  const verdict = (r) => {
    if (r.t.gone) return ['안 보임(삭제·비공개)', 'bad'];
    if (r.ratio == null) return [r.med ? '조회 기다리는 중' : '채널 평소 조회 없음', 'muted'];
    if ((strikes.get(`${r.g.id}|${r.g.our_channel}`) || 0) >= 2) return ['평소 이하 2번 — 이 채널에서 빼기', 'bad'];
    const tag = r.age == null || r.age < 24 ? '중간' : r.age < 48 ? '24시간' : '판정';
    if (r.age != null && r.age < 24) return [`판정 대기 · 지금 평소의 ${r.ratio.toFixed(1)}배`, 'busy'];
    if (r.ratio >= 2) return [`${tag}: 2배+ — 계속`, 'ok'];
    if (r.ratio < 1) return [`${tag}: 평소 이하`, 'bad'];
    return [`${tag}: 평소~2배 — 지켜보기`, 'warn'];
  };
  const at = (r, h) => { if (!r.pub) return null; const s = r.snaps.find((x) => x.at >= r.pub + h * H && x.at <= r.pub + (h * 1.25 + 1) * H); return s ? s.views : null; }; // 그 시점 근처에 잰 값만(늦게 잰 값을 그 시점으로 속이지 않게)
  const dropCards = dropRows.sort((a, b) => (b.pub || 0) - (a.pub || 0)).map((r) => {
    const [v, tone] = verdict(r);
    const per = r.snaps.length >= 2 ? (r.last.views - r.snaps[r.snaps.length - 2].views) / Math.max(1, (r.last.at - r.snaps[r.snaps.length - 2].at) / H) : null;
    return {
      title: r.t.title || r.d.title || r.d.url || '제목 없음', tone,
      pct: r.ratio != null ? Math.round(Math.min(100, r.ratio / 2 * 100)) : undefined, // 막대 = 판정선(평소의 2배)까지
      sub: [r.g.our_channel, `결: ${r.g.name || r.g.id}`, r.age != null && `공개 ${r.age < 48 ? Math.floor(r.age) + '시간' : Math.floor(r.age / 24) + '일'} 전`].filter(Boolean).join(' · '),
      right: `${r.views != null ? fmt(r.views) + '회' : '—'}${r.ratio != null ? ` · 평소의 ${r.ratio.toFixed(1)}배` : ''} · ${v}`,
      detail: [`채널 평소 조회: ${r.med ? fmt(r.med) + '회' : '—'}`,
        `조회 흐름: 1시간 ${fmt(at(r, 1))} → 6시간 ${fmt(at(r, 6))} → 24시간 ${fmt(at(r, 24))} → 48시간 ${fmt(at(r, 48))} → 지금 ${fmt(r.views)}`,
        per != null && `최근 시간당 +${fmt(Math.round(per))}회`,
        r.last && `좋아요 ${fmt(r.last.likes)} · 댓글 ${fmt(r.last.comments)}${r.last.likes != null && r.views ? ` · 좋아요율 ${(r.last.likes / r.views * 100).toFixed(1)}%` : ''}`,
        `판정 기준: 공개 48시간 뒤 평소의 2배+ 계속 · 평소 이하 2번이면 이 채널에서 이 결 빼기`,
        r.last && `마지막 측정: ${mdhm(r.last.at)}`, r.d.url && `영상: ${r.d.url}`].filter(Boolean).join('\n'),
      session: 'YTHOME-M-발굴분석',
    };
  });
  const nWait = dropRows.filter((r) => r.age == null || r.age < 48).length;
  const nKeep = dropRows.filter((r) => r.age >= 24 && r.ratio >= 2).length;
  const nDrop = dropRows.filter((r) => r.age >= 24 && r.ratio != null && r.ratio < 1).length;

  const stages = [
    ['수집', st.channels_collected], ['조회 측정', st.channels_measured], ['잡탕 판정', st.channels_jabtang], ['터진 편', st.hit_videos],
    ['결 이름', st.gyeol_named ?? gy.length], ['검증', st.gyeol_real ?? by('검증됨')], ['배정', nAssigned], ['투하 편', drops],
  ];
  const overview = [
    { type: 'stats', items: [
      { label: '수집한 채널', value: fmt(num(st.channels_collected)), sub: st.channels_measured != null ? `조회 잰 곳 ${fmt(st.channels_measured)}` : '' },
      { label: '잡탕 채널', value: fmt(num(st.channels_jabtang)), sub: '최고 편이 평소의 10배+', drill: { title: `결 분석한 채널 — 터진 편 조회 큰 20곳 (전체는 «결 분석한 채널» 탭)`, items: chanCards.slice(0, 20) } },
      { label: '터진 편', value: fmt(num(st.hit_videos)), sub: '채널 평소의 5배+', drill: { title: '조회 큰 터진 편 30개 — 어느 결로 묶였나', items: hitCards } },
      { label: '찾은 결', value: num(st.gyeol_named) ?? gy.length, sub: `검증 ${num(st.gyeol_real) ?? by('검증됨')}`, drill: { title: `분석된 결 ${gyeolCards.length}개 — 누르면 소재·감정·틀·세부 결·근거`, items: gyeolCards.map(({ title, sub, tone, detail, session }) => ({ title, sub, tone, session, detail: detail.split('\n').filter((l) => !l.startsWith('근거')).join('\n') })) } },
      { label: '배정·투하', value: nAssigned, sub: `투하 ${drops}편`, tone: drops ? 'ok' : '', drill: { title: '우리 채널별 배정 — 어느 채널에 어떤 결', items: assignCards, empty: '아직 배정된 결이 없습니다.' } },
    ] },
    { type: 'list', title: `우리 채널 배정 — ${assignCards.length}개 채널에 결 ${nAssigned}개`, empty: '아직 우리 채널에 배정된 결이 없습니다.', items: assignCards, note: '카드를 누르면 그 채널에 배정된 결마다 소재·감정·틀, 남의 채널에서 터진 근거, 우리 관점, 투하 결과가 보입니다.' },
    { type: 'pipeline', title: '배정 이후 흐름', stages: [['배정한 결', nAssigned], ['투하 편', drops], ['판정 대기(48시간 전)', nWait], ['2배+ 계속', nKeep], ['평소 이하', nDrop]].map(([label, v]) => ({ label, count: fmt(v) })) },
    { type: 'list', title: `투하 편 추적 ${dropCards.length}편 — 한 시간마다 조회·좋아요·댓글`, empty: '아직 투하한 편이 없습니다. 발굴분석이 올린 편 주소를 적으면 한 시간 안에 여기서 조회를 재기 시작합니다.', items: dropCards,
      note: '막대는 판정선(채널 평소의 2배)까지 얼마나 왔는지. 카드를 누르면 1·6·24·48시간 조회 흐름, 시간당 증가, 좋아요·댓글이 보입니다.' },
    { type: 'pipeline', title: '결을 찾는 순서', stages: stages.map(([label, v]) => ({ label, count: v == null ? '—' : fmt(v) })) },
    { type: 'note', text: '수집(인기 차트의 쇼츠 채널) → 조회 측정(최근 90일) → 잡탕 판정(최고 편이 평소의 10배 넘게 들쭉날쭉) → 터진 편(평소의 5배+)만 뽑기 → 썸네일·제목으로 결 이름(소재·감정·틀) → 서로 다른 채널 2곳+에서 같은 결이 터지면 검증 → 우리 채널 배정 → 투하 뒤 채널 평소와 비교.' },
    { type: 'list', title: `결 카드 (${mdhm(Date.parse(m.updated || 0))} 갱신)`, empty: '아직 이름 붙인 결이 없습니다.', items: gyeolCards },
  ];
  return { ...base, tabs: [
    { key: 'overview', label: '결 카드', sections: overview },
    { key: 'channels', label: `결 분석한 채널 ${allChans.length}`, sections: [
      chanCards.length ? { type: 'list', title: `채널별 결 분석 — 터진 편 조회 큰 ${chanCards.length}곳 (분석한 채널 전체 ${allChans.length}곳)`, items: chanCards, note: '카드를 누르면 그 채널의 평소 조회, 터진 편(평소의 몇 배), 각 편이 어느 결로 묶였는지 보입니다.' }
        : { type: 'note', text: '채널별 분석 표를 기다리는 중입니다 — 발굴분석 세션에 형식을 전달했습니다.' },
    ] },
  ] };
}

// 투하 편 주소들(추적기에 넘김)
function dropUrls() { return arr(readJson('docs/jabtang-mine/status.json')?.gyeol).flatMap((g) => arr(g.drops).map((d) => d.url)).filter(Boolean); }

// ── 세션 진행판 ──
const noBlock = (b) => !b || /^(없음|없다|none|-)$/i.test(String(b).trim());

// §10 기록 줄 «- 도구개발(08:09): variety_fx --no-kind 추가(c11c6ff, …) — …» → 카드 하나
function logCard(line, session) {
  line = line.trim();
  const m = line.match(/^-\s*[^(:]+\(([^)]*)\):\s*(.*)$/);
  const when = m ? m[1] : '';
  const body = (m ? m[2] : line.slice(2)).trim();
  let head = body.replace(/\([^()]*\)/g, '').split(/ — |\. |: /)[0].replace(/\b[0-9a-f]{7,40}\b/g, '').replace(/\s{2,}/g, ' ').trim();
  if (head.length > 48) head = head.slice(0, 46) + '…';
  const tone = /실패|막힘|오류|사고|대기/.test(body) ? 'warn' : /끝|완료|통과|반영|추가/.test(body) ? 'ok' : 'muted';
  return { title: head || body.slice(0, 46), sub: when, tone, detail: body.split(/ — |(?<=\.) /).map((x) => x.trim()).filter(Boolean).join('\n'), session };
}
function logCards(prefix, session, max = 8) {
  let t = '';
  try { t = fs.readFileSync(D('docs/handoff-manager-20261014.md'), 'utf8'); } catch {}
  return t.split('\n').filter((l) => l.startsWith(`- ${prefix}(`)).slice(-max).reverse().map((l) => logCard(l, session));
}

function workDashboard({ key, title, prefix, session, extra = [] }) {
  const w = readJson(`docs/work-status/${key}.json`);
  const sections = [];
  let updated = new Date().toISOString();
  if (w) {
    if (w.updated) updated = new Date(Date.parse(w.updated)).toISOString();
    const now = (arr(w.now).length ? arr(w.now) : arr(w.tasks)).map((x) => ({ ...x, title: x.title || x.what || '', blocked: noBlock(x.blocked) ? null : x.blocked }));
    const done = arr(w.done).map((d) => ({ ...d, title: d.title || d.what || '' })).filter((d) => !d.at || Date.parse(d.at) > Date.now() - 7 * 864e5);
    sections.push({ type: 'stats', items: [
      { label: '하는 일', value: now.length },
      { label: '막힌 일', value: now.filter((x) => x.blocked).length, tone: now.some((x) => x.blocked) ? 'bad' : 'ok' },
      { label: '7일 끝낸 일', value: done.length },
      { label: '마지막 갱신', value: w.updated ? mdhm(Date.parse(w.updated)) : '—' },
    ] });
    sections.push({ type: 'list', title: '지금 하는 일', empty: '진행 중인 일이 없습니다.', items: now.map((x) => ({
      title: x.title, pct: num(x.pct),
      sub: [x.lane && `${x.lane}용`, x.stage].filter(Boolean).join(' · '),
      right: x.blocked ? `막힘: ${x.blocked}` : x.next ? `다음: ${x.next}` : '',
      tone: x.blocked ? 'bad' : 'busy',
      detail: [x.lane && `어느 레인: ${x.lane}`, x.stage && `지금 단계: ${x.stage}`, x.next && `다음 단계: ${x.next}`, x.blocked && `막힌 것: ${x.blocked}`,
        x.note && `메모: ${x.note}`, x.updated && `갱신: ${mdhm(Date.parse(x.updated))}`].filter(Boolean).join('\n'),
      rec: x.blocked ? '막힌 걸 풀 사람이 소유주인지 다른 세션인지 확인' : '', session,
    })) });
    sections.push({ type: 'list', title: '끝낸 일 (최근 7일)', empty: '최근 7일에 끝낸 일이 없습니다.', items: done.map((d) => ({
      title: d.title, sub: [d.lane, d.at && mdhm(Date.parse(d.at))].filter(Boolean).join(' · '), tone: 'ok', detail: d.result || '', session,
    })) });
  } else sections.push({ type: 'note', text: `${title} 세션이 아직 진행판을 올리지 않았습니다. 아래는 세션이 남긴 최근 기록입니다.` });
  sections.push(...extra);
  return {
    title, updated_at: updated, board: { parent: 'shortsott', manager: session, sessions: [session] },
    tabs: [
      { key: 'now', label: '진행', sections },
      { key: 'log', label: '최근 기록', sections: [{ type: 'list', title: '세션이 남긴 기록', empty: '기록이 없습니다.', items: logCards(prefix, session, 15) }] },
    ],
  };
}

module.exports = { dropUrls, mineDashboard, workDashboard };
