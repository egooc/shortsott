// 유튜브 쇼츠 검색 (innertube) — 검색 API 할당량을 안 쓰는 카테고리 수요 조사 (2026-10-15 소유주 «진행»).
//   A 롱투숏 longform_competition.search 규격을 받아 이쪽에서 다시 썼다(그쪽 파일이 저장소 밖이라 복사 아님).
//   node scripts/ops/yt-search.js "<검색어>" [--period week|month|year|today|hour] [--pages 3] [--gl KR --hl ko] [--no-channel] [--json]
//   → 쇼츠만(유형 필터 0x10,9). 결과 [{id,title,view_count,channel_id(@핸들),channel}] + 요약(100만+ 수 · 한국어 제목 비율 · 채널 수)
//   게시 시각·길이는 응답에 없다. 질의 사이 1.5초 쉬고, 429 가 나면 멈춘다(차단 규칙 문서 없음 — A 실측: 수십 질의 순차 무사).
//   require('./yt-search').search(q, period, pages, {gl, hl}) 로도 쓴다.
const UPLOAD = { hour: 1, today: 2, week: 3, month: 4, year: 5 };
const VERSION = '2.20261001.00.00';

function params(period) {
  return Buffer.from([0x12, 4, 0x08, UPLOAD[period] || 4, 0x10, 9]).toString('base64');
}

function views(text) {
  // hl=ko «조회수 1.2만회» · «조회수 3억회» · «조회수 950회»
  const m = /조회수\s*([\d.,]+)\s*(천|만|억)?\s*회/.exec(text || '');
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Math.round(n * ({ 천: 1e3, 만: 1e4, 억: 1e8 }[m[2]] || 1));
}

function collect(o, out, tok) {
  if (!o || typeof o !== 'object') return;
  if (o.shortsLockupViewModel) {
    const v = o.shortsLockupViewModel;
    const id = v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    const acc = v.accessibilityText || '';
    if (id) out.push({ id, title: acc.split(/,\s*조회수/)[0].trim(), view_count: views(acc) });
  }
  if (o.continuationCommand?.token) tok.push(o.continuationCommand.token);
  for (const k of Object.keys(o)) collect(o[k], out, tok);
}

async function post(body) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 429) throw Object.assign(new Error('429 — innertube 가 막았다. 멈춘다.'), { code: 429 });
  if (!r.ok) throw new Error(`innertube ${r.status}`);
  return r.json();
}

async function channelOf(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/${id}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { channel_id: (j.author_url || '').split('/').pop() || null, channel: j.author_name || null };
  } catch { return {}; }
}

async function search(q, period = 'month', pages = 3, { gl = 'KR', hl = 'ko', channels = true } = {}) {
  const context = { client: { clientName: 'WEB', clientVersion: VERSION, hl, gl } };
  const out = [], seen = new Set();
  let body = { context, query: q, params: params(period) };
  for (let p = 0; p < pages; p++) {
    const items = [], tok = [];
    collect(await post(body), items, tok);
    for (const it of items) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
    if (!tok.length) break;
    body = { context, continuation: tok[tok.length - 1] };
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (channels) {
    for (let i = 0; i < out.length; i += 8) {
      const got = await Promise.all(out.slice(i, i + 8).map((v) => channelOf(v.id)));
      got.forEach((c, k) => Object.assign(out[i + k], c));
    }
  }
  return out;
}

function summary(list) {
  const KO = /[가-힣]/;
  return {
    n: list.length,
    over_1m: list.filter((v) => (v.view_count || 0) >= 1e6).length,
    ko_title: list.filter((v) => KO.test(v.title)).length,
    channels: new Set(list.map((v) => v.channel_id).filter(Boolean)).size,
    median_views: (() => { const s = list.map((v) => v.view_count || 0).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; })(),
  };
}

module.exports = { search, summary };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const q = a.find((x, i) => !x.startsWith('--') && !(i && a[i - 1].startsWith('--') && !['--json', '--no-channel'].includes(a[i - 1])));
  if (!q) { console.error('검색어를 줘라'); process.exit(2); }
  search(q, opt('--period', 'month'), Number(opt('--pages', 3)), { gl: opt('--gl', 'KR'), hl: opt('--hl', 'ko'), channels: !a.includes('--no-channel') })
    .then((list) => {
      const s = summary(list);
      if (a.includes('--json')) { process.stdout.write(JSON.stringify({ q, summary: s, items: list }) + '\n'); return; }
      console.log(`«${q}» 쇼츠 ${s.n}건 · 100만+ ${s.over_1m} · 한국어 제목 ${s.ko_title} · 채널 ${s.channels} · 중앙값 ${s.median_views.toLocaleString()}회`);
      for (const v of list.slice(0, 10)) console.log(`  ${String(v.view_count ?? '?').padStart(10)}  ${v.channel_id || ''}  ${v.title.slice(0, 50)}`);
    })
    .catch((e) => { console.error(e.message); process.exit(e.code === 429 ? 3 : 1); });
}
