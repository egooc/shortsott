// 소유주가 모아 준 영상 목록에서 «지금 살아 있는 작품»을 뽑는다.
//
//   node scripts/whitelist-from-list.js <목록파일> [--out <이름>]
//   목록파일: 유튜브 URL 이나 영상 id 가 줄마다 들어 있으면 된다(PDF 에서 뽑은 것도 좋다).
//
// 왜 (2026-09-25 소유주: "무비리캡이나 미드 관련 채널들인데 여기서 살아있는 영화들 찾을수
//     있지 않을까? 레퍼런스 채널에서 뽑을 수 있는 건 일단 영화 화이트리스트랑.")
//   우리 판별기 셋이 무너졌다(사례 110) — 배급사 등급도, 생존자 신호도, 프로브도.
//   남은 단 하나의 단단한 증거는 **«같은 포맷으로 지금 살아 있다»** 이다.
//   그 증거를 가장 크게 모을 수 있는 곳이 이 목록이다.
//
// 무엇을 보나
//   · 살아 있는가 — `contentDetails.regionRestriction.blocked` 가 비어 있는가.
//     막힌 것은 «견딘 증거»가 아니므로 화이트리스트에서 뺀다.
//   · 어느 작품인가 — 설명문 첫 줄. 리캡 채널의 관행이다(사례 105).
//   · 우리 길이인가 — 60~200초. 길이가 다르면 정책도 다를 수 있다.
//   · 얼마나 오래 버텼는가 — 오래된 것일수록 «견딤»의 증거가 세다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const REPORT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const BAND = [60, 200];

async function accessToken(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`토큰 갱신 실패: ${JSON.stringify(d).slice(0, 140)}`);
  return d.access_token;
}

// 설명문에서 작품명. 여러 꼴이 섞여 있어 넓게 받는다(사례 105 에서 쓰던 것을 확장).
//   "English Title, 2006 (한국어 제목) 장르: ..."   ·   "《한국어》 (English, 2011) 감독: ..."
//   "Movie: Title (2011)"                          ·   "Title (2011)" 한 줄
function titleOf(desc) {
  const head = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!head) return null;
  const cut = head.split(/장르\s*:|감독\s*:|출연\s*:|Director|Starring/i)[0].trim();
  if (!cut || cut.length > 140) return null;
  const kr = /^[《「『]([^》」』]+)[》」』]\s*\(([^)]+)\)/.exec(cut);
  let en; let ko;
  if (kr) { ko = kr[1].trim(); en = kr[2].trim(); }
  else {
    const m = /^(?:movie|film|series|drama)?\s*:?\s*(.+?)\s*\(([^)]+)\)/i.exec(cut);
    en = (m ? m[1] : cut).trim();
    ko = m ? m[2].trim() : '';
  }
  en = en.replace(/^[🎞️🎬📽️\s#]+/, '').replace(/[,\s]+$/, '').trim();
  if (!en || en.length < 2 || en.length > 90) return null;
  if (/^#/.test(en)) return null;                      // 해시태그 덩어리는 작품명이 아니다
  const yr = (/(19|20)\d{2}/.exec(`${en} ${ko}`) || [])[0] || '';
  const tv = /\bS\d{1,2}\s*E\d{1,2}\b|시즌\s*\d|Season\s*\d/i.test(`${en} ${ko}`);
  return { en: en.replace(/,?\s*\(?(19|20)\d{2}\)?\s*$/, '').trim(), ko, year: yr, tv };
}

function ids(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of text.matchAll(/(?:watch\?v=|shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/g)) out.add(m[1]);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(t)) out.add(t);
  }
  return [...out];
}

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('사용법: whitelist-from-list.js <목록파일>'); process.exit(2); }
  const list = ids(file);
  console.log(`목록에서 영상 ${list.length}편을 읽었다`);

  const raw = readJson(PROFILES, []);
  const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
  const profile = profiles.find((p) => p.purpose === 'ko_highlight') || profiles[0];
  if (!profile) { console.error('업로드 프로필이 없다.'); process.exit(1); }
  const token = await accessToken(profile);

  const rows = [];
  for (let i = 0; i < list.length; i += 50) {
    const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics'
      + `&id=${list.slice(i, i + 50).join(',')}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (j.error) { console.error('videos.list 실패:', String(j.error.message).slice(0, 120)); break; }
    for (const it of j.items || []) {
      const cd = it.contentDetails || {};
      const mm = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(cd.duration || '') || [];
      const sec = Number(mm[1] || 0) * 3600 + Number(mm[2] || 0) * 60 + Number(mm[3] || 0);
      const rr = cd.regionRestriction || {};
      rows.push({
        id: it.id,
        ch: (it.snippet || {}).channelTitle || '',
        title: (it.snippet || {}).title || '',
        at: String((it.snippet || {}).publishedAt || '').slice(0, 10),
        views: Number((it.statistics || {}).viewCount || 0),
        sec,
        blocked: Array.isArray(rr.blocked) ? rr.blocked.length : 0,
        work: titleOf((it.snippet || {}).description),
      });
    }
  }

  const gone = list.length - rows.length;          // 목록에 있었는데 조회가 안 되는 것 = 내려간 것
  const alive = rows.filter((r) => !r.blocked);
  const inBand = alive.filter((r) => r.sec >= BAND[0] && r.sec <= BAND[1]);
  const named = inBand.filter((r) => r.work);

  // 작품별로 묶는다
  const works = {};
  for (const r of named) {
    const key = `${r.work.en}|${r.work.year}`;
    const w = works[key] || { ...r.work, n: 0, views: 0, chs: new Set(), oldest: '9999' };
    w.n += 1; w.views += r.views; w.chs.add(r.ch);
    if (r.at && r.at < w.oldest) w.oldest = r.at;
    works[key] = w;
  }

  const cat = readJson(CATALOG, {}).movies || {};
  const known = new Set(Object.values(cat).map((m) => String(m.title_en || '').toLowerCase()));
  const list2 = Object.values(works).sort((a, b) => b.n - a.n || b.views - a.views);

  const lines = [`# 목록에서 뽑은 화이트리스트 ${new Date().toLocaleString('ko-KR')}`, ''];
  lines.push(`목록 ${list.length}편 · 조회됨 ${rows.length}편 · **내려간 것 ${gone}편**`);
  lines.push(`살아 있음 ${alive.length}편 · 우리 길이(${BAND[0]}~${BAND[1]}초) ${inBand.length}편 · 작품명 확인 ${named.length}편`);
  lines.push(`→ **작품 ${list2.length}편** (우리 카탈로그에 없는 것 ${list2.filter((w) => !known.has(w.en.toLowerCase())).length}편)`, '');
  lines.push('_막힌 것·길이가 다른 것은 뺐다. «우리 길이로 지금 살아 있음»만 증거로 친다._', '');
  lines.push('## 작품 (쓰인 편 수 순)', '');
  for (const w of list2.slice(0, 80)) {
    const isNew = known.has(w.en.toLowerCase()) ? '' : ' ★새것';
    lines.push(`- ${String(w.n).padStart(2)}편 · ${w.year || '????'} · ${w.en}${w.ko ? ` (${w.ko})` : ''}`
      + `${w.tv ? ' [TV]' : ''}${isNew} · 최초 ${w.oldest} · ${[...w.chs].slice(0, 2).join(',')}`);
  }

  const text = lines.join('\n');
  console.log(`\n${text.split('\n').slice(0, 12).join('\n')}`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const name = arg('--out', `${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')}-whitelist`);
  fs.writeFileSync(path.join(REPORT_DIR, `${name}.md`), `${text}\n`, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'server', 'data', 'whitelist_works.json'),
    JSON.stringify(list2.map((w) => ({ ...w, chs: [...w.chs] })), null, 2));
  console.log(`\n보고서: server/output/scout-reports/${name}.md`);
})().catch((e) => { console.error('whitelist fatal:', e.message || e); process.exitCode = 1; });
