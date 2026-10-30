// 유튜브 지원 현황판(잡탕 광산·발굴분석·도구개발) 공용 — office/modules/{jabtang,discovery,tools}.js 가 쓴다.
// 읽기 전용. 각 판은 오피스에서 프로젝트처럼 따로 뜬다(board.parent = 'shortsott').
//   docs/jabtang-mine/status.json            잡탕 광산 (발굴분석 세션이 매일 덮어씀)
//   docs/work-status/<도구개발|발굴분석>.json  세션 진행판 (각 세션이 일 바뀔 때마다)
//   docs/handoff-manager-20261014.md §10     세션이 남긴 기록 줄 — 줄 그대로가 아니라 카드로 정리해 보인다

const fs = require('fs');
const path = require('path');

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

function mineDashboard() {
  const m = readJson('docs/jabtang-mine/status.json');
  const base = { title: '잡탕 광산', updated_at: m?.updated ? new Date(Date.parse(m.updated)).toISOString() : new Date().toISOString(),
    board: { parent: 'shortsott', manager: 'YTHOME-M-발굴분석', sessions: ['YTHOME-M-발굴분석'] } };
  if (!m) return { ...base, tabs: [{ key: 'overview', label: '현황', sections: [{ type: 'note', text: '첫 판을 기다리는 중입니다. 발굴분석 세션이 결 카드를 올리면 5분 안에 채워집니다.' }] }] };

  const st = m.stage || {};
  const gy = arr(m.gyeol).map((g) => ({ ...g, status: g.status || (num(g.channels) >= 2 ? '검증됨' : '후보') }));
  const gname = new Map(gy.map((g) => [g.id, g.name || g.id]));
  const by = (k) => gy.filter((g) => g.status === k).length;
  const drops = gy.reduce((a, g) => a + arr(g.drops).length, 0);

  const gyeolCards = gy.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)).map((g) => {
    const ev = (arr(g.evidence).length ? arr(g.evidence) : g.best ? [g.best] : [])
      .map((e) => [e.channel, e.title && `«${e.title}»`, num(e.views) != null && `${fmt(e.views)}회`, num(e.x) != null && `평소의 ${e.x}배`].filter(Boolean).join(' '));
    const dropTxt = arr(g.drops).map((d) => `${d.published || ''} «${d.title || ''}» ${fmt(num(d.views))}회 (채널 평소 ${fmt(num(d.channel_median))}회${num(d.views) != null && num(d.channel_median) ? `, ${(d.views / d.channel_median).toFixed(1)}배` : ''})`);
    return {
      title: g.name || g.id, tone: GYEOL_TONE[g.status] || '',
      sub: [g.status, g.channels != null && `독립 채널 ${g.channels}곳`, g.hits != null && `터진 편 ${g.hits}개`, g.our_channel && `→ ${g.our_channel}`, dropTxt.length && `투하 ${dropTxt.length}편`].filter(Boolean).join(' · '),
      detail: [`소재: ${g['소재'] || '—'}`, `감정: ${g['감정'] || '—'}`, `틀: ${g['틀'] || '—'}`, ev.length && `근거: ${ev.join(' / ')}`,
        g.specialist && `이 결만 하는 전문 채널: ${g.specialist}`, g.risk && `위험: ${g.risk}`, g.longshort_fit != null && `롱투숏에 ${g.longshort_fit ? '맞음' : '안 맞음'}`,
        dropTxt.length ? `투하 결과: ${dropTxt.join(' / ')}` : g.our_channel && '아직 투하 전'].filter(Boolean).join('\n'),
      rec: g.our_angle ? `${g.our_channel ? g.our_channel + '에 ' : ''}우리 관점: ${g.our_angle}` : '',
      session: 'YTHOME-M-발굴분석',
    };
  });

  // 결 분석이 끝난 채널: 평소 조회 → 터진 편(몇 배) → 어느 결로 묶였나
  const chans = arr(m.channels);
  const chanCards = chans.sort((a, b) => arr(b.hits).length - arr(a.hits).length).map((c) => {
    const hits = arr(c.hits);
    const gs = [...new Set([...arr(c.gyeol), ...hits.map((h) => h.gyeol).filter(Boolean)])].map((id) => gname.get(id) || id);
    return {
      title: c.name || c.url || '이름 없음', tone: gs.length ? 'ok' : 'muted',
      sub: [num(c.median) != null && `평소 ${fmt(c.median)}회`, `터진 편 ${hits.length}개`, gs.length ? `결: ${gs.join(', ')}` : '결 없음'].join(' · '),
      detail: [c.why && `잡탕 판정: ${c.why}`, num(c.measured_videos) != null && `조회 잰 편 ${c.measured_videos}개`,
        ...hits.map((h) => `«${h.title || ''}» ${fmt(num(h.views))}회${num(h.x) != null ? ` (평소의 ${h.x}배)` : ''} → ${h.gyeol ? gname.get(h.gyeol) || h.gyeol : '결 미배정'}`),
        c.url && `채널 주소: ${c.url}`].filter(Boolean).join('\n'),
      session: 'YTHOME-M-발굴분석',
    };
  });

  const stages = [
    ['수집', st.channels_collected], ['조회 측정', st.channels_measured], ['잡탕 판정', st.channels_jabtang], ['터진 편', st.hit_videos],
    ['결 이름', st.gyeol_named ?? gy.length], ['검증', st.gyeol_real ?? by('검증됨')], ['배정', by('배정됨') + by('투하')], ['투하 편', drops],
  ];
  const overview = [
    { type: 'stats', items: [
      { label: '수집한 채널', value: fmt(num(st.channels_collected)), sub: st.channels_measured != null ? `조회 잰 곳 ${fmt(st.channels_measured)}` : '' },
      { label: '잡탕 채널', value: fmt(num(st.channels_jabtang)), sub: '최고 편이 평소의 10배+' },
      { label: '터진 편', value: fmt(num(st.hit_videos)), sub: '채널 평소의 5배+' },
      { label: '찾은 결', value: num(st.gyeol_named) ?? gy.length, sub: `검증 ${num(st.gyeol_real) ?? by('검증됨')}` },
      { label: '배정·투하', value: by('배정됨') + by('투하'), sub: `투하 ${drops}편`, tone: drops ? 'ok' : '' },
    ] },
    { type: 'pipeline', title: '결을 찾는 순서', stages: stages.map(([label, v]) => ({ label, count: v == null ? '—' : fmt(v) })) },
    { type: 'note', text: '수집(인기 차트의 쇼츠 채널) → 조회 측정(최근 90일) → 잡탕 판정(최고 편이 평소의 10배 넘게 들쭉날쭉) → 터진 편(평소의 5배+)만 뽑기 → 썸네일·제목으로 결 이름(소재·감정·틀) → 서로 다른 채널 2곳+에서 같은 결이 터지면 검증 → 우리 채널 배정 → 투하 뒤 채널 평소와 비교.' },
    { type: 'list', title: `결 카드 (${mdhm(Date.parse(m.updated || 0))} 갱신)`, empty: '아직 이름 붙인 결이 없습니다.', items: gyeolCards },
  ];
  return { ...base, tabs: [
    { key: 'overview', label: '결 카드', sections: overview },
    { key: 'channels', label: `결 분석한 채널 ${chanCards.length}`, sections: [
      chanCards.length ? { type: 'list', title: '채널별 결 분석', items: chanCards, note: '카드를 누르면 그 채널의 터진 편과 각 편이 어느 결로 묶였는지 보입니다.' }
        : { type: 'note', text: '채널별 분석 표를 기다리는 중입니다 — 발굴분석 세션에 형식을 전달했습니다.' },
    ] },
  ] };
}

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

module.exports = { mineDashboard, workDashboard };
