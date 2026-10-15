// 노출 저하(피드 저하) 감시 — 평소보다 확 꺾인 편이 연달아 나오면 «처음 꺾인 편»을 용의자로 짚는다.
//
//   node scripts/rinbox-feed-watch.js [ja|ko] [--json]
//
// 왜 (2026-10-12 소유주: «이 책 내용은 다 사실이야. 다 참고해야 돼. 시스템 갖춰야 돼»):
//   쇼츠 운영 전자책 1장 — 잘 되던 채널이 갑자기 안 나올 때 원인은 대개 가이드라인 오판 하나다.
//   «제일 처음 조회수가 안 나온 영상»을 찾아 3일 지나도 회복이 없으면 비공개하면 뒤 편들이 돌아온다.
//   (예: 대본에 «코인»«광고»가 들어가자 AI 가 스팸으로 보고 4편 내리 꺾였다.)
//   이걸 눈으로 하던 일을 숫자로 한다. ★비공개는 하지 않는다 — 후보만 보여 주고 사람이 고른다.
//
// 판정
//   기준선 = 그 채널에서 공개 3일 넘은 최근 30편의 «하루당 조회» 중앙값.
//   꺾임   = 공개 24시간 넘은 편의 하루당 조회가 기준선의 25% 미만.
//   경보   = 시간순으로 꺾임이 3편 이상 연속 → 그 연속의 첫 편이 용의자.
//   차단(regionRestriction)된 편은 «꺾임»이 아니라 저작권 문제라 따로 적는다(check-claims 몫).
require('dotenv').config({ path: 'D:/midform/.env' });
const fs = require('fs');
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const args = process.argv.slice(2);
const WANT = (args.find((a) => !a.startsWith('--')) || '').trim();
const JSON_OUT = args.includes('--json');
const STATE = 'D:/midform/server/data/rinbox_publish_state.json';

const DROP_RATIO = 0.25;
// 터짐(책 2장 «48시간 100만이면 하루 2~3개씩 민다») — 공개 72시간 안에 기준선 3배 이상.
// 우리 채널 규모에선 100만 고정값이 아니라 기준선 배수로 본다. 결과는 HOT 파일에 남겨 제작 쪽이 읽는다.
const HOT_RATIO = 3;
const HOT_PATH = 'D:/midform/server/data/rinbox_hot.json';
const RUN_MIN = 3;

const { riskOf: riskHits, needsNote, describeHits } = require('./lib/feedSafety');
function riskOf(title, desc) {
  const out = riskHits(title, desc).map((h) => `${h.where} «${h.word}» ${h.why}`);
  if (needsNote(title, desc)) out.push('픽션 안내 문구 없음 — rinbox-desc-safety.js 로 붙인다');
  return out;
}

(async () => {
  if (!KEY) throw new Error('YOUTUBE_API_KEY 가 .env 에 없다');
  const hist = (JSON.parse(fs.readFileSync(STATE, 'utf8')).history || [])
    .filter((e) => e.url && !e.retracted).filter((e) => !WANT || e.locale === WANT);
  const byId = new Map();
  for (const e of hist) {
    const m = /[?&]v=([\w-]{11})/.exec(e.url) || /shorts\/([\w-]{11})/.exec(e.url);
    if (m) byId.set(m[1], e);
  }
  const ids = [...byId.keys()];
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos'
      + `?part=snippet,statistics,status,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${KEY}`)).json();
    if (r.error) throw new Error(r.error.message);
    for (const v of r.items || []) {
      if (v.status.privacyStatus !== 'public') continue;
      const e = byId.get(v.id);
      const hours = (Date.now() - Date.parse(v.snippet.publishedAt)) / 36e5;
      const views = Number(v.statistics.viewCount || 0);
      const rr = (v.contentDetails || {}).regionRestriction || {};
      vids.push({
        id: v.id, locale: e.locale, work: e.work || '', at: v.snippet.publishedAt, hours, views,
        perDay: views / Math.max(hours / 24, 0.5),
        blocked: (rr.blocked || []).length,
        title: v.snippet.title, desc: v.snippet.description || '',
      });
    }
  }

  const report = {};
  for (const loc of [...new Set(vids.map((v) => v.locale))].sort()) {
    const all = vids.filter((v) => v.locale === loc).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const mature = all.filter((v) => v.hours >= 72 && !v.blocked).slice(-30).map((v) => v.perDay).sort((a, b) => a - b);
    const base = mature.length ? mature[Math.floor(mature.length / 2)] : 0;
    const judged = all.filter((v) => v.hours >= 24 && !v.blocked);
    for (const v of judged) v.drop = base > 0 && v.perDay < base * DROP_RATIO;

    // 꺾임 연속 구간 찾기 — 가장 최근 구간이 지금 문제다
    const runs = [];
    let cur = [];
    for (const v of judged) {
      if (v.drop) cur.push(v); else { if (cur.length) runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    const alerts = runs.filter((r) => r.length >= RUN_MIN).map((r) => ({
      ongoing: r[r.length - 1] === judged[judged.length - 1],
      suspect: r[0], count: r.length,
      advice: r[0].hours >= 72
        ? '공개 3일이 지났다 — 회복 기미 없으면 이 편을 비공개 후보로 (사람이 판단)'
        : '아직 3일 전 — 기다린다',
    }));
    report[loc] = {
      baseline_per_day: Math.round(base), sample: mature.length,
      recent: judged.slice(-10),
      alerts,
      hot: all.filter((v) => !v.blocked && v.hours >= 12 && v.hours <= 72 && base > 0 && v.perDay >= base * HOT_RATIO),
      blocked: all.filter((v) => v.blocked),
      risky: all.map((v) => ({ v, hits: riskOf(v.title, v.desc) })).filter((x) => x.hits.length),
    };
  }

  const hotOut = {};
  for (const [loc, r] of Object.entries(report)) {
    hotOut[loc] = r.hot.map((v) => ({ id: v.id, work: v.work, title: v.title, at: v.at,
      perDay: Math.round(v.perDay), x_baseline: +(v.perDay / r.baseline_per_day).toFixed(1),
      push: '같은 작품·같은 제목 패턴으로 하루 2~3편' }));
  }
  fs.writeFileSync(HOT_PATH, JSON.stringify({ at: new Date().toISOString(), hot: hotOut }, null, 2) + '\n', 'utf8');

  if (JSON_OUT) {
    const slim = (v) => ({ id: v.id, at: v.at, work: v.work, views: v.views, perDay: Math.round(v.perDay), title: v.title });
    console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, r]) => [k, {
      baseline_per_day: r.baseline_per_day, sample: r.sample,
      recent: r.recent.map((v) => ({ ...slim(v), drop: v.drop })),
      alerts: r.alerts.map((a) => ({ ...a, suspect: slim(a.suspect) })),
      blocked: r.blocked.map(slim),
      risky: r.risky.map((x) => ({ ...slim(x.v), hits: x.hits })),
    }])), null, 2));
    return;
  }

  for (const [loc, r] of Object.entries(report)) {
    console.log(`\n══ ${loc}  기준선 ${r.baseline_per_day}/일 (공개 3일+ ${r.sample}편 중앙값) · 꺾임 = ${Math.round(r.baseline_per_day * DROP_RATIO)}/일 미만`);
    console.log('── 최근 10편');
    for (const v of r.recent) {
      console.log(`${v.drop ? ' ▼' : '  '} ${String(Math.round(v.perDay)).padStart(7)}/일 ${String(v.views).padStart(7)}회 `
        + `${v.at.slice(5, 16).replace('T', ' ')}  ${v.id}  ${v.title.slice(0, 36)}`);
    }
    if (!r.alerts.length) console.log('── 경보 없음');
    for (const a of r.alerts) {
      console.log(`── ${a.ongoing ? '★지금 진행 중' : '지난'} 경보: ${a.count}편 연속 꺾임. 처음 꺾인 편 = ${a.suspect.id} «${a.suspect.title.slice(0, 40)}»`);
      console.log(`   ${a.advice}`);
      const hits = riskOf(a.suspect.title, a.suspect.desc);
      if (hits.length) console.log(`   위험 단어: ${hits.join(' · ')}`);
    }
    if (r.blocked.length) console.log(`── 차단 ${r.blocked.length}편 (check-claims 로 확인): ${r.blocked.map((v) => v.id).join(' ')}`);
    if (r.hot.length) {
      console.log(`── ★터진 편 (72시간 안 기준선 ${HOT_RATIO}배+) — 같은 작품을 하루 2~3편 밀어라`);
      for (const v of r.hot) console.log(`   ${String(Math.round(v.perDay)).padStart(7)}/일 (${(v.perDay / r.baseline_per_day).toFixed(1)}배)  ${v.work}  ${v.title.slice(0, 34)}`);
    }
    if (r.risky.length) {
      console.log('── 위험 단어가 든 편');
      for (const x of r.risky.slice(-15)) console.log(`   ${x.v.id}  ${x.v.title.slice(0, 30)}  — ${x.hits.join(' · ')}`);
    }
  }
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 1; });
