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
// 투하 장부: 레인이 올린 잡탕 편 {gyeol, video_id, channel} 한 줄씩
const readDropLog = () => { try { return fs.readFileSync(D('docs/jabtang-mine/drops.jsonl'), 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j && j.gyeol && j.video_id); } catch { return []; } };
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
  const gy = arr(m.gyeol).map((g) => ({ ...g, drops: [...arr(g.drops)], our_channel: none(g.our_channel), status: g.status || (num(g.channels) >= 2 ? '검증됨' : '후보') }));
  for (const j of readDropLog()) {
    const g = gy.find((x) => x.id === j.gyeol);
    if (g && !g.drops.some((d) => vid(d.url) === j.video_id)) g.drops.push({ url: `https://www.youtube.com/shorts/${j.video_id}`, channel: j.channel });
  }
  const gname = new Map(gy.map((g) => [g.id, g.name || g.id]));
  for (const c of arr(m.channels)) for (const h of arr(c.hits)) if (h.gyeol && h.gyeol_label && !gname.has(h.gyeol)) gname.set(h.gyeol, h.gyeol_label);
  const by = (k) => gy.filter((g) => g.status === k).length;
  const nAssigned = gy.filter((g) => g.our_channel || g.status === '배정됨' || g.status === '투하').length; // 상태 칸이 늦게 바뀌어도 우리 채널이 적혔으면 배정
  const drops = gy.reduce((a, g) => a + arr(g.drops).length, 0);

  // 화면용 조각: 결 꼬리표(색 = 감정)와 결 미니 카드
  const gChip = (g) => ({ t: g['소재'] || g.name || g.id, n: g['감정'], c: g['감정'] });
  const evTxt = (e) => e && `${e.channel ? e.channel + ' «' : '«'}${String(e.title || '').slice(0, 40)}» ${fmt(num(e.views))}회${num(e.x) != null ? ` · 평소의 ${e.x}배` : ''}`;
  const gBlock = (g) => {
    const e = arr(g.evidence)[0] || g.best;
    const nd = arr(g.drops).length;
    return { title: g['소재'] || g.name, badge: { t: g['감정'] || '—', c: g['감정'] },
      kv: [['틀', g['틀']], ['근거', g.channels != null ? `남의 채널 ${g.channels}곳 · ${g.hits ?? '?'}편 터짐` : null], ['대표 편', evTxt(e)],
        ['투하', nd ? `${nd}편` : '아직 전']],
      quote: g.our_angle ? `우리 관점 — ${g.our_angle}` : null, link: e?.url || g.best?.url };
  };

  const gyeolCards = gy.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)).map((g) => {
    const dropTxt = arr(g.drops).map((d) => `${d.published || ''} «${d.title || ''}» ${fmt(num(d.views))}회 (채널 평소 ${fmt(num(d.channel_median))}회${num(d.views) != null && num(d.channel_median) ? `, ${(d.views / d.channel_median).toFixed(1)}배` : ''})`);
    return {
      title: g.name || g.id, tone: GYEOL_TONE[g.status] || '',
      sub: [g.channels != null && `남의 채널 ${g.channels}곳`, g.hits != null && `터진 편 ${g.hits}개`, dropTxt.length && `투하 ${dropTxt.length}편`].filter(Boolean).join(' · '),
      rec: g.our_angle ? `${g.our_channel ? g.our_channel + '에 ' : ''}우리 관점: ${g.our_angle}` : '',
      chips: [gChip(g), g['틀'] && { t: g['틀'], c: 'muted' }, g.our_channel ? { t: `→ ${g.our_channel}`, c: 'busy' } : { t: g.status, c: GYEOL_TONE[g.status] }].filter(Boolean),
      blocks: [
        ...arr(g.subs).map((x) => ({ title: x.name, badge: num(x.hits) != null ? { t: `${x.hits}편`, c: 'ok' } : null, kv: [['누가', x['대상']], ['어떤 순간', x['상황']]] })),
        ...(arr(g.evidence).length ? arr(g.evidence) : g.best ? [g.best] : []).map((e) => ({ title: e.channel || '대표 편', badge: num(e.x) != null ? { t: `평소의 ${e.x}배`, c: 'warn' } : null,
          kv: [['제목', e.title], ['조회', num(e.views) != null ? `${fmt(e.views)}회` : null]], link: e.url })),
        { title: '판단', kv: [['전문 채널', g.specialist], ['위험', g.risk], ['롱투숏', g.longshort_fit == null ? null : g.longshort_fit ? '맞음' : '안 맞음'], ['배정', g.our_channel || '아직'],
          ['투하', dropTxt.length ? dropTxt.join(' / ') : '아직 전']] },
      ],
      session: 'YTHOME-M-발굴분석',
    };
  });

  // 결 분석이 끝난 채널: 평소 조회 → 터진 편(몇 배) → 어느 결로 묶였나
  const CH_MAX = 80;
  const best = (c) => Math.max(0, ...arr(c.hits).filter((h) => h.gyeol).map((h) => num(h.views) || 0)); // 터진 편 조회가 큰 채널부터
  const allChans = arr(m.channels);
  const chans = allChans.filter((c) => arr(c.hits).some((h) => h.gyeol)).sort((a, b) => best(b) - best(a)).slice(0, CH_MAX);
  const gById = new Map(gy.map((g) => [g.id, g]));
  const idChip = (id) => (gById.get(id) ? gChip(gById.get(id)) : { t: gname.get(id) || id, c: 'muted' });
  const chanCards = chans.map((c) => {
    const hits = arr(c.hits);
    const ids = [...new Set([...arr(c.gyeol), ...hits.map((h) => h.gyeol).filter(Boolean)])];
    return {
      title: c.name || c.url || '이름 없음', tone: ids.length ? 'ok' : 'muted',
      sub: [num(c.median) != null && `평소 ${fmt(c.median)}회`, `터진 편 ${hits.length}개`].filter(Boolean).join(' · '),
      chips: ids.map(idChip),
      blocks: [
        ...hits.slice(0, 6).map((h) => ({ title: String(h.title || '').slice(0, 50), badge: num(h.x) != null ? { t: `평소의 ${h.x}배`, c: 'warn' } : null,
          chips: [h.gyeol ? idChip(h.gyeol) : { t: '결 미배정', c: 'muted' }], kv: [['조회', `${fmt(num(h.views))}회`]], link: h.url })),
        { title: '잡탕 판정', kv: [['이유', c.why], ['조회 잰 편', num(c.measured_videos) != null ? `${c.measured_videos}개` : null]], link: c.url },
      ],
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
      sub: `결 ${gs.length}개 · 투하 ${nd}편 · 꼬리표 색 = 감정`,
      chips: gs.map(gChip),
      blocks: gs.map(gBlock),
      session: 'YTHOME-M-발굴분석',
    };
  });
  const hitCards = allChans.flatMap((c) => arr(c.hits).map((h) => ({ c, h }))).sort((a, b) => (num(b.h.views) || 0) - (num(a.h.views) || 0)).slice(0, 30)
    .map(({ c, h }) => ({ title: String(h.title || '').slice(0, 60), tone: h.gyeol ? 'ok' : 'muted',
      sub: [c.name, `${fmt(num(h.views))}회`, num(h.x) != null && `평소의 ${h.x}배`].filter(Boolean).join(' · '),
      chips: [h.gyeol ? idChip(h.gyeol) : { t: '결 미배정', c: 'muted' }],
      blocks: [{ title: c.name || '채널', kv: [['채널 평소', `${fmt(num(c.median))}회`], ['이 편', `${fmt(num(h.views))}회`], ['결', h.gyeol ? gname.get(h.gyeol) || h.gyeol : '미배정']], link: h.url }],
      session: 'YTHOME-M-발굴분석' }));

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
    const med = num(d.channel_median) ?? num(track?.channels?.[t.channel_id]?.median);
    const ratio = views != null && med ? views / med : null;
    const age = pub ? (Date.now() - pub) / H : null;
    const pts = pub ? snaps.filter((x) => x.at >= pub).map((x) => [+((x.at - pub) / H).toFixed(2), x.views]) : [];
    return { g, d, id, t, snaps, last, pub, views, med, ratio, age, pts };
  }));
  const strikes = new Map(); // 결×채널마다 48h 넘어 평소 이하 횟수
  for (const r of dropRows) if (r.age >= 48 && r.ratio != null && r.ratio < 1) { const k = `${r.g.id}|${r.g.our_channel}`; strikes.set(k, (strikes.get(k) || 0) + 1); }
  const verdict = (r) => {
    if (r.t.gone) return ['안 보임(삭제·비공개)', 'bad'];
    if (!r.t.seen) return ['공개 전(예약)', 'muted'];
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
      right: `${r.views != null ? fmt(r.views) + '회' : '—'}${r.ratio != null ? ` · 평소의 ${r.ratio.toFixed(1)}배` : ''}`,
      chips: [{ t: v, c: tone }, { t: r.g.our_channel || '채널 미정', c: 'busy' }, gChip(r.g)],
      spark: r.pts.length >= 2 ? { pts: r.pts, c: tone, ref: r.med } : undefined,
      chart: { title: '공개 뒤 조회 추이', x: '공개 뒤 시간', y: 'n', series: [{ name: '조회', c: tone, pts: r.pts }],
        guides: r.med ? [{ y: r.med, label: `평소 ${fmt(r.med)}`, c: 'muted' }, { y: r.med * 2, label: '2배(계속)', c: 'ok' }] : [],
        empty: r.t.seen ? '측정이 두 번 쌓이면 선이 그려집니다(한 시간마다).' : '공개되면 한 시간마다 재기 시작합니다.' },
      blocks: [
        { title: '조회 흐름', kv: [['1시간', fmt(at(r, 1))], ['6시간', fmt(at(r, 6))], ['24시간', fmt(at(r, 24))], ['48시간', fmt(at(r, 48))], ['지금', fmt(r.views)],
          ['시간당', per != null ? `+${fmt(Math.round(per))}회` : null]] },
        { title: '반응', kv: [['채널 평소', r.med ? `${fmt(r.med)}회` : '—'], ['좋아요', r.last ? fmt(r.last.likes) : null], ['댓글', r.last ? fmt(r.last.comments) : null],
          ['좋아요율', r.last?.likes != null && r.views ? `${(r.last.likes / r.views * 100).toFixed(1)}%` : null], ['마지막 측정', r.last ? mdhm(r.last.at) : null]], link: r.d.url },
      ],
      session: 'YTHOME-M-발굴분석',
    };
  });
  const nWait = dropRows.filter((r) => r.age == null || r.age < 48).length;
  const nKeep = dropRows.filter((r) => r.age >= 24 && r.ratio >= 2).length;
  const nDrop = dropRows.filter((r) => r.age >= 24 && r.ratio != null && r.ratio < 1).length;

  // ── 배정·투하 추적 한 페이지 ──
  const shortT = (x) => String(x || '').replace(/#\S+/g, '').trim().slice(0, 18) || '제목 없음';
  const live = dropRows.filter((r) => r.pts.length);
  const ratioChart = { type: 'chart', title: '투하 편 전체 — 채널 평소 대비 몇 배인가', x: '공개 뒤 시간', y: 'x',
    series: live.filter((r) => r.med).map((r) => ({ name: shortT(r.t.title || r.d.title), c: verdict(r)[1], pts: r.pts.map(([h, v]) => [h, +(v / r.med).toFixed(2)]) })),
    guides: [{ y: 1, label: '평소', c: 'muted' }, { y: 2, label: '2배 — 계속', c: 'ok' }],
    empty: dropRows.length ? `투하 ${dropRows.length}편 — 아직 공개 전이거나 첫 측정 전입니다. 공개되면 한 시간마다 선이 자랍니다.` : '아직 투하한 편이 없습니다.',
    note: '선 하나 = 투하 편 하나. 초록 점선(2배) 위로 올라가면 그 결을 그 채널에서 계속, 회색 선(평소) 아래로 두 번이면 뺍니다.' };
  const barChart = { type: 'bars', title: '편별 지금 조회 — 막대 끝 눈금은 채널 평소·2배',
    items: dropRows.map((r) => ({ label: shortT(r.t.title || r.d.title), sub: `${r.g.our_channel || ''} · ${r.g['소재'] || r.g.name || r.g.id}`, value: r.views, ref: r.med, c: verdict(r)[1], tag: verdict(r)[0] })),
    empty: '아직 투하한 편이 없습니다.' };
  const chanTrack = [...assigned].sort((a, b) => b[1].length - a[1].length).map(([ch, gs]) => {
    const rows = dropRows.filter((r) => r.g.our_channel === ch);
    const keep = rows.filter((r) => r.age >= 24 && r.ratio >= 2).length, bad = rows.filter((r) => r.age >= 24 && r.ratio != null && r.ratio < 1).length;
    const waiting = gs.filter((g) => !g.drops.length);
    return {
      title: ch, tone: keep ? 'ok' : rows.length ? 'busy' : 'muted',
      pct: gs.length ? Math.round(rows.length / gs.length * 100) : 0,
      sub: `결 ${gs.length}개 배정 → 투하 ${rows.length}편 (막대 = 배정 중 투하한 비율)`,
      chips: [{ t: '배정', n: gs.length, c: 'busy' }, { t: '투하', n: rows.length, c: rows.length ? 'ok' : 'muted' }, { t: '계속', n: keep, c: 'ok' }, { t: '빼기', n: bad, c: bad ? 'bad' : 'muted' }, { t: '대기 결', n: waiting.length, c: 'warn' }],
      chart: rows.some((r) => r.pts.length && r.med) ? { title: `${ch} 투하 편 — 평소 대비 배수`, x: '공개 뒤 시간', y: 'x',
        series: rows.filter((r) => r.pts.length && r.med).map((r) => ({ name: shortT(r.t.title), c: verdict(r)[1], pts: r.pts.map(([h, v]) => [h, +(v / r.med).toFixed(2)]) })),
        guides: [{ y: 1, label: '평소', c: 'muted' }, { y: 2, label: '2배', c: 'ok' }] } : undefined,
      blocks: [
        ...rows.map((r) => ({ title: shortT(r.t.title || r.d.title), badge: { t: verdict(r)[0], c: verdict(r)[1] }, chips: [gChip(r.g)],
          kv: [['지금', r.views != null ? `${fmt(r.views)}회` : '—'], ['평소', r.med ? `${fmt(r.med)}회` : '—'], ['공개', r.pub ? mdhm(r.pub) : '예약']], link: r.d.url })),
        waiting.length ? { title: `아직 안 올린 결 ${waiting.length}개`, badge: { t: '대기', c: 'warn' }, chips: waiting.map(gChip) } : null,
      ].filter(Boolean),
      session: 'YTHOME-M-발굴분석',
    };
  });
  const trackTab = [
    { type: 'stats', items: [
      { label: '배정한 결', value: nAssigned, sub: `${assigned.size}개 채널`, drill: { title: '채널별 배정', items: assignCards } },
      { label: '투하 편', value: dropRows.length, sub: `공개 ${dropRows.filter((r) => r.t.seen).length} · 예약 ${dropRows.filter((r) => !r.t.seen && !r.t.gone).length}`, tone: dropRows.length ? 'ok' : '' },
      { label: '판정 대기', value: nWait, sub: '공개 48시간 전' },
      { label: '2배+ 계속', value: nKeep, tone: nKeep ? 'ok' : '' },
      { label: '평소 이하', value: nDrop, tone: nDrop ? 'bad' : '' },
    ] },
    { type: 'pipeline', title: '배정 → 투하 → 판정', stages: [['배정한 결', nAssigned], ['투하 편', dropRows.length], ['판정 대기', nWait], ['2배+ 계속', nKeep], ['평소 이하', nDrop]].map(([label, v]) => ({ label, count: fmt(v) })) },
    ratioChart,
    barChart,
    { type: 'list', title: `채널별 — 배정·투하·판정 (${chanTrack.length}개 채널)`, items: chanTrack, empty: '아직 배정된 채널이 없습니다.', note: '카드를 누르면 그 채널 투하 편들의 추이 그래프와, 아직 안 올린 결이 보입니다.' },
    { type: 'list', title: `투하 편 하나씩 — ${dropCards.length}편`, items: dropCards, empty: '아직 투하한 편이 없습니다.', note: '카드 겉의 작은 선 = 조회 추이. 누르면 큰 그래프(회색 = 채널 평소, 초록 = 2배)와 1·6·24·48시간 조회, 좋아요·댓글.' },
  ];

  const stages = [
    ['수집', st.channels_collected], ['조회 측정', st.channels_measured], ['잡탕 판정', st.channels_jabtang], ['터진 편', st.hit_videos],
    ['결 이름', st.gyeol_named ?? gy.length], ['검증', st.gyeol_real ?? by('검증됨')], ['배정', nAssigned], ['투하 편', drops],
  ];
  const overview = [
    { type: 'stats', items: [
      { label: '수집한 채널', value: fmt(num(st.channels_collected)), sub: st.channels_measured != null ? `조회 잰 곳 ${fmt(st.channels_measured)}` : '' },
      { label: '잡탕 채널', value: fmt(num(st.channels_jabtang)), sub: '최고 편이 평소의 10배+', drill: { title: `결 분석한 채널 — 터진 편 조회 큰 20곳 (전체는 «결 분석한 채널» 탭)`, items: chanCards.slice(0, 20) } },
      { label: '터진 편', value: fmt(num(st.hit_videos)), sub: '채널 평소의 5배+', drill: { title: '조회 큰 터진 편 30개 — 어느 결로 묶였나', items: hitCards } },
      { label: '찾은 결', value: num(st.gyeol_named) ?? gy.length, sub: `검증 ${num(st.gyeol_real) ?? by('검증됨')}`, drill: { title: `분석된 결 ${gyeolCards.length}개 — 누르면 소재·감정·틀·세부 결·근거`, items: gyeolCards.map(({ title, sub, tone, chips, blocks, session }) => ({ title, sub, tone, chips, session, blocks: blocks.filter((b) => b.kv?.[0]?.[0] === '누가') })) } },
      { label: '배정·투하', value: nAssigned, sub: `투하 ${drops}편`, tone: drops ? 'ok' : '', drill: { title: '우리 채널별 배정 — 어느 채널에 어떤 결', items: assignCards, empty: '아직 배정된 결이 없습니다.' } },
    ] },
    { type: 'list', title: `우리 채널 배정 — ${assignCards.length}개 채널에 결 ${nAssigned}개`, empty: '아직 우리 채널에 배정된 결이 없습니다.', items: assignCards, note: '카드를 누르면 그 채널에 배정된 결마다 소재·감정·틀, 남의 채널에서 터진 근거, 우리 관점, 투하 결과가 보입니다.' },
    { type: 'pipeline', title: '결을 찾는 순서', stages: stages.map(([label, v]) => ({ label, count: v == null ? '—' : fmt(v) })) },
    { type: 'note', text: '수집(인기 차트의 쇼츠 채널) → 조회 측정(최근 90일) → 잡탕 판정(최고 편이 평소의 10배 넘게 들쭉날쭉) → 터진 편(평소의 5배+)만 뽑기 → 썸네일·제목으로 결 이름(소재·감정·틀) → 서로 다른 채널 2곳+에서 같은 결이 터지면 검증 → 우리 채널 배정 → 투하 뒤 채널 평소와 비교.' },
    { type: 'list', title: `결 카드 (${mdhm(Date.parse(m.updated || 0))} 갱신)`, empty: '아직 이름 붙인 결이 없습니다.', items: gyeolCards },
  ];
  return { ...base, tabs: [
    { key: 'track', label: `배정·투하 추적 ${dropRows.length}`, sections: trackTab },
    { key: 'overview', label: '결 카드', sections: overview },
    { key: 'channels', label: `결 분석한 채널 ${allChans.length}`, sections: [
      chanCards.length ? { type: 'list', title: `채널별 결 분석 — 터진 편 조회 큰 ${chanCards.length}곳 (분석한 채널 전체 ${allChans.length}곳)`, items: chanCards, note: '카드를 누르면 그 채널의 평소 조회, 터진 편(평소의 몇 배), 각 편이 어느 결로 묶였는지 보입니다.' }
        : { type: 'note', text: '채널별 분석 표를 기다리는 중입니다 — 발굴분석 세션에 형식을 전달했습니다.' },
    ] },
  ] };
}

// 투하 편 주소들(추적기에 넘김)
function dropUrls() { return [...arr(readJson('docs/jabtang-mine/status.json')?.gyeol).flatMap((g) => arr(g.drops).map((d) => d.url)), ...readDropLog().map((j) => `https://www.youtube.com/shorts/${j.video_id}`)].filter(Boolean); }

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
