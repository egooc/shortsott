// tag-share — 검색 결과에서 «양산 꼬리표» 비율을 센다 (발굴 카드 2026-10-15-dogu-category-swap 요청, 도구개발).
//   «해외 양산 소스 + 한국어 설명» 채널들은 제목 끝에 #worker #process 같은 영어 꼬리표를 똑같이 단다.
//   그 비율이 높으면 국가 간 칸막이가 한국어 쪽에서 이미 메워지는 중이다 → 들어가면 같은 원본과 중복도로 부딪힌다.
//   판정 문턱은 없다(실측 근거가 아직 없다) — 숫자만 낸다. 문턱은 레인이 몇 번 써 본 뒤 정한다.
//
//   node scripts/tag-share.js "<검색어>" ["<검색어>" ...] [--lane ko|ja] [--tags worker,process] [--period month] [--pages 3] [--json]
//   node scripts/tag-share.js --from <yt-search --json 결과 파일> [...]   ← 이미 뽑은 결과를 다시 센다(네트워크 0)
//   셈: 꼬리표 편 비율 · 한국어 제목+꼬리표 비율 · 꼬리표 편 조회 점유율 · 꼬리표를 단 채널 수(상위 핸들)
//       · 꼬리표 편/나머지 중앙값 · 3채널 이상이 함께 단 영어 꼬리표 쌍(다른 양산 틀을 찾는 용도)
//   yt-search.js 는 N100 소유라 고치지 않고 require 로 부르기만 한다. 429 면 멈춘다(종료 코드 3).
//   require('./tag-share').tally(items, {tags}) — 네트워크 없는 셈(회귀 테스트가 쓴다).
const fs = require('fs');

const LANES = { ko: { gl: 'KR', hl: 'ko' }, ja: { gl: 'JP', hl: 'ja' } };
const DEFAULT_TAGS = ['worker', 'process'];
const KO = /[가-힣]/;
const JA = /[぀-ヿ]/;

function tagsOf(title) {
  return (String(title || '').normalize('NFKC').match(/#[^\s#]+/g) || [])
    .map((t) => t.slice(1).toLowerCase().replace(/[^\p{L}\p{N}_]+$/u, ''))
    .filter((t) => t && t !== 'shorts');
}

function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

function handleOf(v) {
  try { return decodeURIComponent(v.channel_id || ''); } catch { return v.channel_id || ''; }
}

const pct = (a, b) => (b ? Number((a / b).toFixed(3)) : 0);

function tally(items, { tags = DEFAULT_TAGS, lane = 'ko', minChannels = 3 } = {}) {
  const want = new Set(tags.map((t) => t.toLowerCase()));
  const local = lane === 'ja' ? JA : KO;
  const rows = (items || []).map((v) => {
    const t = tagsOf(v.title);
    return { id: v.id, title: v.title, views: v.view_count ?? null, handle: handleOf(v), tags: t, mass: t.some((x) => want.has(x)), local: local.test(v.title) };
  });
  const mass = rows.filter((r) => r.mass);
  const rest = rows.filter((r) => !r.mass);
  const total = rows.reduce((s, r) => s + (r.views || 0), 0);
  const massViews = mass.reduce((s, r) => s + (r.views || 0), 0);

  const byChannel = {};
  for (const r of mass) byChannel[r.handle || '?'] = (byChannel[r.handle || '?'] || 0) + 1;

  // 영어 꼬리표 쌍 — 같은 쌍을 서로 다른 채널 minChannels 곳 이상이 달면 «양산 틀» 후보다.
  const pairs = {};
  for (const r of rows) {
    const en = [...new Set(r.tags.filter((t) => /^[a-z0-9_]+$/.test(t)))].sort();
    for (let i = 0; i < en.length; i++) for (let j = i + 1; j < en.length; j++) {
      const k = `#${en[i]} #${en[j]}`;
      (pairs[k] = pairs[k] || new Set()).add(r.handle || r.id);
    }
  }
  const shared = Object.entries(pairs).filter(([, s]) => s.size >= minChannels)
    .map(([pair, s]) => ({ pair, channels: s.size })).sort((a, b) => b.channels - a.channels).slice(0, 10);

  return {
    n: rows.length,
    tags: [...want],
    mass: mass.length,
    mass_share: pct(mass.length, rows.length),
    local_mass: mass.filter((r) => r.local).length,
    local_mass_share: pct(mass.filter((r) => r.local).length, rows.length),
    mass_view_share: pct(massViews, total),
    mass_channels: Object.keys(byChannel).length,
    top_channels: Object.entries(byChannel).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([handle, n]) => ({ handle, n })),
    median_mass: median(mass.map((r) => r.views)),
    median_rest: median(rest.map((r) => r.views)),
    shared_pairs: shared,
  };
}

module.exports = { tally, tagsOf };

if (require.main === module) {
  const a = process.argv.slice(2);
  const valued = new Set(['--lane', '--tags', '--period', '--pages', '--from']);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const lane = opt('--lane', 'ko');
  const tags = opt('--tags', DEFAULT_TAGS.join(',')).split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
  const froms = a.map((x, i) => (x === '--from' ? a[i + 1] : null)).filter(Boolean);
  const queries = a.filter((x, i) => !x.startsWith('--') && !(i && valued.has(a[i - 1])));
  if ((!queries.length && !froms.length) || !LANES[lane]) {
    console.error('사용: node scripts/tag-share.js "<검색어>" ... [--lane ko|ja] [--tags worker,process]  또는  --from <결과.json>');
    process.exit(2);
  }
  (async () => {
    const jobs = froms.map((f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return { q: j.q || f, items: j.items || j }; });
    if (queries.length) {
      const { search } = require('./ops/yt-search');
      for (const q of queries) {
        jobs.push({ q, items: await search(q, opt('--period', 'month'), Number(opt('--pages', 3)), { ...LANES[lane], channels: true }) });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const res = jobs.map((j) => ({ q: j.q, ...tally(j.items, { tags, lane }) }));
    if (a.includes('--json')) { process.stdout.write(JSON.stringify({ lane, results: res }, null, 2) + '\n'); return; }
    const p = (x) => `${Math.round(x * 100)}%`;
    for (const r of res) {
      console.log(`«${r.q}» ${r.n}편 · 꼬리표(${r.tags.map((t) => '#' + t).join(' ')}) ${r.mass}편 ${p(r.mass_share)} · ${lane === 'ja' ? '일본어' : '한국어'} 제목+꼬리표 ${p(r.local_mass_share)} · 조회 점유 ${p(r.mass_view_share)}`);
      console.log(`    꼬리표 채널 ${r.mass_channels}곳 · 중앙값 꼬리표 ${r.median_mass.toLocaleString()} / 나머지 ${r.median_rest.toLocaleString()}`);
      if (r.top_channels.length) console.log(`    ${r.top_channels.map((c) => `${c.handle}(${c.n})`).join(' ')}`);
      if (r.shared_pairs.length) console.log(`    3채널+ 공통 쌍: ${r.shared_pairs.slice(0, 5).map((s) => `${s.pair}(${s.channels})`).join(' · ')}`);
    }
  })().catch((e) => { console.error(e.message); process.exit(e.code === 429 ? 3 : 1); });
}
