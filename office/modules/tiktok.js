// AI 오피스 현황판 — 틱톡 수익화. 유튜브 아래 따로 뜨는 판(10-30 소유주 «유튜브 안에 대시보드를 틱톡수익화로 따로»).
// 대상: docs/office/tiktok-accounts.json 의 5자리만. 수치는 lib/ttrack.js 가 office/data/tiktok-track.json 에 쌓는다.
// 수익화 조건(크리에이터 리워드): 팔로워 1만 · 최근 30일 조회 10만 · 1분 이상 영상.
delete require.cache[require.resolve('./lib/ttrack')];
const fs = require('fs');
const path = require('path');
const { refreshTikTok } = require('./lib/ttrack');

const ROOT = path.resolve(__dirname, '../..');
const NEED_FOLLOW = 10000, NEED_VIEWS = 100000;
const CIRC = '①②③④⑤';
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; } };
const fmt = (n) => n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만` : n.toLocaleString('ko-KR');
const kst = (ms) => new Date(ms + 9 * 3600e3);
const md = (ms) => { const d = kst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const mdhm = (ms) => `${md(ms)} ${kst(ms).toISOString().slice(11, 16)}`;
const median = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const durT = (s) => s == null ? '길이 —' : s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
const last = (v) => v.snaps[v.snaps.length - 1] || {};
// 공개 h시간 시점의 조회: 그 시각 전후로 잰 값 중 가까운 것(너무 이른 값은 안 씀)
function viewsAt(v, h) {
  const target = v.pub + h * 3600e3, grace = Math.max(0.5, h * 0.15) * 3600e3;
  let best = null;
  for (const s of v.snaps) if (s.at >= v.pub + h * 3600e3 * 0.6 && s.at <= target + grace) best = s;
  return best ? best.views : null;
}
const STOCK_TONE = { 시험: 'busy', 재검수: 'warn', 통과: 'ok', 올림: 'muted' };

module.exports = {
  project: 'board-tiktok', title: '틱톡 수익화',
  run: async () => {
    const cfg = readJson('docs/office/tiktok-accounts.json') || { items: [] };
    const slots = cfg.items || [];
    const t = await refreshTikTok(slots.map((s) => s.handle).filter(Boolean));
    const now = Date.now();
    const vids = Object.entries(t.videos || {}).map(([id, v]) => ({ id, ...v }));

    const rows = slots.map((s) => {
      const no = CIRC[s.slot - 1] || String(s.slot);
      const a = s.handle ? (t.accounts || {})[s.handle] : null;
      const mine = s.handle ? vids.filter((v) => v.h === s.handle).sort((x, y) => y.pub - x.pub) : [];
      const in30 = mine.filter((v) => now - v.pub < 30 * 864e5);
      const views30 = in30.reduce((n, v) => n + (last(v).views || 0), 0);
      const long30 = in30.filter((v) => v.dur >= 60).length;
      const fol = a?.followers ?? null;
      const okF = fol != null && fol >= NEED_FOLLOW, okV = views30 >= NEED_VIEWS, okL = long30 > 0;
      const ready = okF && okV && okL;
      const med24 = median(in30.map((v) => viewsAt(v, 24)));
      return { s, no, a, mine, in30, views30, long30, fol, okF, okV, okL, ready, med24 };
    });

    const slotCard = (r) => {
      const { s, no } = r;
      if (!s.handle) return { title: `${no} ${s.name}`, sub: `계정 대기 · ${s.owner_session}`, tone: 'muted',
        chips: [{ t: '계정 대기', c: 'muted' }, { t: `재고 ${(s.stock || []).length}편`, c: 'muted' }],
        blocks: [{ title: '할 일', kv: [['계정 만들기', '소유주'], ['연결', '만든 뒤 Zernio 연결 → 이 판이 자동으로 채움'], ['맡은 세션', s.owner_session]] }], session: s.owner_session };
      const pct = Math.round(100 * Math.min(1, (r.fol || 0) / NEED_FOLLOW, r.views30 / NEED_VIEWS, r.okL ? 1 : 0));
      const pts = r.mine.filter((v) => last(v).views != null).map((v) => [v.pub, last(v).views]).sort((x, y) => x[0] - y[0]);
      return {
        title: `${no} ${s.name}`, sub: `@${s.handle} · ${r.a?.src === 'zernio' ? '한 시간마다' : '6시간마다'} 잼`, tone: r.ready ? 'ok' : 'busy', pct,
        chips: [
          { t: r.ready ? '신청 가능' : '조건 진행 중', c: r.ready ? 'ok' : 'busy' },
          { t: `팔로워 ${fmt(r.fol)}/1만`, c: r.okF ? 'ok' : 'warn' },
          { t: `30일 조회 ${fmt(r.views30)}/10만`, c: r.okV ? 'ok' : 'warn' },
          { t: `1분+ ${r.long30}편`, c: r.okL ? 'ok' : 'bad' },
        ],
        spark: pts.length >= 2 ? { pts: pts.map(([x, y]) => [(x - pts[0][0]) / 3600e3, y]), c: r.ready ? 'ok' : 'busy' } : undefined,
        chart: { title: '편별 조회', xt: 'date', y: 'n', series: [{ name: '조회', c: 'busy', pts }], empty: '최근 40일 올린 편이 없습니다.' },
        blocks: [
          { title: '수익화 조건', badge: { t: r.ready ? '신청 가능' : `${pct}%`, c: r.ready ? 'ok' : 'busy' },
            kv: [['팔로워', `${fmt(r.fol)} / 1만`], ['최근 30일 조회', `${fmt(r.views30)} / 10만 (30일 안에 올린 편 합)`], ['1분 이상 편', `${r.long30}편 (30일)`], ['맡은 세션', s.owner_session]] },
          ...r.mine.slice(0, 3).map((v) => ({ title: v.title || v.id, badge: v.dur != null && v.dur < 60 ? { t: '리워드 제외', c: 'bad' } : null,
            chips: [{ t: md(v.pub), c: 'muted' }, { t: `${fmt(last(v).views)}회`, c: 'busy' }, { t: durT(v.dur), c: v.dur >= 60 ? 'ok' : 'warn' }], link: v.url })),
        ],
        session: s.owner_session,
      };
    };

    // 편별 추적: 최근 30일, 1·6·24·48시간
    const videoCards = vids.filter((v) => now - v.pub < 30 * 864e5).sort((x, y) => y.pub - x.pub).slice(0, 40).map((v) => {
      const r = rows.find((x) => x.s.handle === v.h);
      const at = [1, 6, 24, 48].map((h) => [h, viewsAt(v, h)]);
      const lv = last(v);
      const short = v.dur != null && v.dur < 60;
      return {
        title: v.title || v.id, sub: `${r ? `${r.no} ${r.s.name}` : '@' + v.h} · ${mdhm(v.pub)}`, tone: short ? 'warn' : 'busy',
        chips: [
          ...(short ? [{ t: '리워드 제외', c: 'bad' }] : []),
          { t: `지금 ${fmt(lv.views)}회`, c: 'busy' },
          ...at.filter(([, n]) => n != null).map(([h, n]) => ({ t: `${h}h ${fmt(n)}`, c: 'muted' })),
          { t: durT(v.dur), c: short ? 'warn' : 'ok' },
        ],
        spark: v.snaps.length >= 2 ? { pts: v.snaps.map((s) => [(s.at - v.pub) / 3600e3, s.views]), c: short ? 'warn' : 'busy' } : undefined,
        chart: { title: '공개 뒤 조회', y: 'n', series: [{ name: '조회', c: 'busy', pts: v.snaps.map((s) => [(s.at - v.pub) / 3600e3, s.views]) }] },
        blocks: [{ title: '시점별', kv: [...at.map(([h, n]) => [`${h}시간`, n != null ? `${fmt(n)}회` : '잰 값 없음']), ['좋아요', fmt(lv.likes)], ['댓글', fmt(lv.comments)], ['길이', durT(v.dur)]], link: v.url }],
      };
    });

    // 자리 비교: 24시간 조회 중앙값, 팔로워 추이
    const live = rows.filter((r) => r.s.handle);
    const cmpBars = { type: 'bars', title: '자리별 24시간 조회 중앙값(최근 30일)',
      items: live.map((r) => ({ label: `${r.no} ${r.s.name}`, sub: `${r.in30.length}편`, value: r.med24, c: r.ready ? 'ok' : 'busy' })),
      empty: '연결된 계정이 아직 없습니다.' };
    const folChart = { type: 'chart', title: '자리별 팔로워 추이', xt: 'date', y: 'n',
      series: live.filter((r) => (r.a?.hist || []).length).map((r, i) => ({ name: `${r.no} ${r.s.name}`, c: ['busy', 'ok', 'warn', 'bad', 'muted'][i % 5], pts: r.a.hist.map((p) => [p.at, p.followers]) })),
      guides: [{ y: NEED_FOLLOW, label: '1만', c: 'ok' }], empty: '팔로워 기록이 쌓이는 중입니다.' };

    // 제작 재고
    const stockCards = slots.map((s) => {
      const st = s.stock || [];
      const by = (k) => st.filter((x) => x.state === k).length;
      return { title: `${CIRC[s.slot - 1]} ${s.name}`, sub: s.owner_session, tone: st.length ? 'busy' : 'muted',
        chips: [{ t: `시험 편 ${st.length}`, c: st.length ? 'busy' : 'muted' }, ...['재검수', '통과', '올림'].filter(by).map((k) => ({ t: `${k} ${by(k)}`, c: STOCK_TONE[k] }))],
        blocks: st.length ? st.slice(-6).reverse().map((x) => ({ title: x.title || x.id, badge: { t: x.state || '시험', c: STOCK_TONE[x.state] || 'busy' }, chips: x.at ? [{ t: x.at, c: 'muted' }] : [] }))
          : [{ title: '아직 기록 없음', kv: [['적는 곳', '맡은 세션이 틱톡 계정 설정 파일의 stock 에 한 줄씩']] }],
        session: s.owner_session };
    });

    const linked = live.length, ready = rows.filter((r) => r.ready).length;
    const longAll = rows.reduce((n, r) => n + r.long30, 0), viewsAll = rows.reduce((n, r) => n + r.views30, 0);
    return {
      title: '틱톡 수익화', updated_at: new Date(t.fetched_at || now).toISOString(),
      board: { parent: 'shortsott', manager: 'YTHOME-M-HEAD', sessions: [...new Set(slots.map((s) => s.owner_session))] },
      tabs: [
        { key: 'glance', label: '한눈에', sections: [
          { type: 'stats', items: [
            { label: '신청 가능', value: `${ready}/${slots.length}`, tone: ready ? 'ok' : 'muted' },
            { label: '계정 연결', value: `${linked}/${slots.length}`, tone: linked < slots.length ? 'warn' : 'ok' },
            { label: '30일 조회', value: fmt(viewsAll) },
            { label: '1분+ 편(30일)', value: String(longAll), tone: longAll ? 'ok' : 'warn' },
          ] },
          { type: 'list', title: '자리별 수익화 조건', items: rows.map(slotCard), compact: true },
          cmpBars,
        ] },
        { key: 'videos', label: `편별 추적 ${videoCards.length}`, sections: [
          { type: 'list', title: '최근 30일 올린 편 — 1·6·24·48시간', items: videoCards, compact: true, empty: '연결된 계정에 최근 30일 올린 편이 없습니다.' },
        ] },
        { key: 'compare', label: '자리 비교', sections: [cmpBars, folChart] },
        { key: 'stock', label: '제작 재고', sections: [{ type: 'list', title: '자리별 시험 편', items: stockCards, compact: true }] },
      ],
    };
  },
};
