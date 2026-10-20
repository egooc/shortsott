// 발굴용 키(YOUTUBE_API_KEY_SEARCH) 쿼터 장부 — 호출마다 server/data/api_quota.jsonl 에 {at, day, tool, endpoint, units} 한 줄,
// 도구별·전체 하루 상한(config/api_quota.json, KST 날짜)을 넘으면 호출 전에 멈춘다(10-20 12:55 키 429 뒤 관리자 지시).
//   const quota = require('./api_quota');
//   quota.spend('yt_news_outliers', 'playlistItems');   // 상한 넘으면 QuotaStop 을 던진다(호출하지 말 것), 아니면 기록
//   quota.blocked()   // 오늘 429/403 을 받아 멈춘 상태면 그 사유(문자열), 아니면 null — 키는 하나라 모든 도구가 같이 멈춘다
//   quota.markBlocked('yt_news_outliers', 'commentThreads 429')   // 429/403 을 받으면 부른다(그날 남은 호출 전부 중지)
//   quota.summary()   // 07:40 보고용 한 줄: «발굴 키 쿼터 10-20: 계 612/9000 · yt_news_outliers 420 · …»
// 파이썬 쪽은 scripts/api_quota.py — 같은 장부·같은 설정.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'server', 'data', 'api_quota.jsonl');
const CFG = path.join(ROOT, 'config', 'api_quota.json');
const LEDGER = path.join(ROOT, 'server', 'data', 'gate_errors.jsonl');

class QuotaStop extends Error {}

const day = (d = new Date()) => new Date(d.getTime() + 9 * 36e5).toISOString().slice(0, 10);
const cfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

function rows(d = day()) {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.day === d);
}

function used(d = day()) {
  const by = {};
  let total = 0;
  for (const r of rows(d)) { if (r.blocked) continue; by[r.tool] = (by[r.tool] || 0) + (r.units || 0); total += r.units || 0; }
  return { total, by };
}

function blocked(d = day()) {
  const b = rows(d).find((r) => r.blocked);
  return b ? `${b.tool} ${b.blocked}` : null;
}

function loud(tool, msg) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), gate: 'api_quota', lane: tool, error: msg }) + '\n', 'utf8');
}

function spend(tool, endpoint) {
  const c = cfg();
  const units = endpoint === 'search' ? c.units.search : c.units.default;
  const b = blocked();
  if (b) throw new QuotaStop(`발굴 키 오늘 중지(${b}) — 내일 KST 0시까지 호출 금지`);
  const u = used();
  const cap = c.tools[tool] ?? c.tools.other;
  if ((u.by[tool] || 0) + units > cap) { const m = `${tool} 하루 상한 ${cap}단위 도달`; loud(tool, m); throw new QuotaStop(m); }
  if (u.total + units > c.day_total) { const m = `발굴 키 전체 하루 상한 ${c.day_total}단위 도달`; loud(tool, m); throw new QuotaStop(m); }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), day: day(), tool, endpoint, units }) + '\n', 'utf8');
  return units;
}

function markBlocked(tool, why) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), day: day(), tool, endpoint: null, units: 0, blocked: why }) + '\n', 'utf8');
  loud(tool, `발굴 키 ${why} — 오늘 남은 호출 전부 중지`);
}

function summary(d = day()) {
  const c = cfg();
  const u = used(d);
  const parts = Object.entries(u.by).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}/${c.tools[t] ?? c.tools.other}`);
  const b = blocked(d);
  return `발굴 키 쿼터 ${d.slice(5)}: 계 ${u.total}/${c.day_total}` + (parts.length ? ` · ${parts.join(' · ')}` : '') + (b ? ` · ★중지: ${b}` : '');
}

module.exports = { spend, markBlocked, blocked, used, summary, QuotaStop, day };

if (require.main === module) console.log(summary(process.argv[2]));
