// 같은 포맷 경쟁 채널이 «지금 살려 두고 있는 영화» 목록을 뽑는다.
//
//   node scripts/rival-films.js [--limit 400] [--report]
//
// 왜 (2026-09-23 소유주: "명화관은 차단이 너무 많은데 이거 어떻게 풀어내지? 이게 계속 문젠데")
//   지금까지 판별기를 다섯 개 만들었지만 전부 «우리가 이미 고른 영화»를 채점하는 것이었다.
//   정작 물어야 할 것은 **무엇을 고르는가**다. 그리고 그 답이 남의 채널에 적혀 있었다.
//
//   실측 2026-09-23: 경쟁 채널 영상의 «설명문 첫 줄»이 작품명이다.
//       "Scary Movie 6 (무서운 영화 6) 장르: 코미디..."
//       "Undisputed II: Last Man Standing, 2006 (언디스퓨티드 2) 장르: 액션..."
//       "Jack, 1996 (잭) 장르: 코미디..."
//   그리고 그 목록에 **대작이 없다.** 마블도, 매트릭스도, 글래디에이터도 없다.
//   중간급 드라마 · 옛 영화 · 비디오 직행 액션 · TV 시리즈다.
//   우리는 정확히 반대로 골라 왔다 — 권리자가 제일 열심히 지키는 제목들이다.
//
//   ★이 목록이 우리가 만들 수 있는 **가장 날카로운 화이트리스트**다.
//     «우리 길이 · 우리 구조 · 지금 이 순간 살아 있음»을 한꺼번에 증명한다.
//     생존자 신호(사례 92)는 검색 결과를 셌을 뿐이라 이보다 무디다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const BACKLOG = path.join(ROOT, 'server', 'data', 'rival_backlog.json');
const STORE = path.join(ROOT, 'server', 'data', 'rival_films.json');
const REPORT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const LIMIT = Number(arg('--limit', '400'));

async function accessToken(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`토큰 갱신 실패: ${JSON.stringify(d).slice(0, 140)}`);
  return d.access_token;
}

// 설명문 첫 조각에서 작품명을 뽑는다. 흔한 꼴:
//   "English Title, 2006 (한국어 제목) 장르: ..."
//   "English Title (한국어 제목) 장르: ..."
//   "Atlanta S03 E01 (애틀랜타 시즌 3 ...) 장르: ..."   ← TV 도 섞인다
function titleOf(desc) {
  const head = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!head) return null;
  const cut = head.split(/장르\s*:/)[0].trim();      // 「장르:」 앞까지가 제목 덩어리다
  if (!cut || cut.length > 120) return null;
  // 《한국어 제목》 (English, 2011) 꼴도 흔하다 — 그때는 괄호 «안»이 영어 제목과 연도다.
  const kr = /^[《「『]([^》」』]+)[》」』]\s*\(([^)]+)\)/.exec(cut);
  let en; let ko;
  if (kr) { ko = kr[1].trim(); en = kr[2].trim(); }
  else {
    const m = /^(.+?)\s*\(([^)]+)\)/.exec(cut);
    en = (m ? m[1] : cut).trim().replace(/[,\s]+$/, '');
    ko = m ? m[2].trim() : '';
  }
  en = en.replace(/^[🎞️🎬\s]+/, '').trim();
  // 연도는 영어·한국어 어느 쪽에 붙어 있어도 줍는다.
  const yr = (/(19|20)\d{2}/.exec(`${en} ${ko}`) || [])[0] || '';
  const isTv = /\bS\d{1,2}\s*E\d{1,2}\b/i.test(en);
  return en ? { en: en.replace(/,?\s*(19|20)\d{2}\s*$/, '').trim(), ko, year: yr, tv: isTv } : null;
}

(async () => {
  const store = readJson(STORE, { at: '', films: {} });

  if (!process.argv.includes('--report')) {
    const raw = readJson(PROFILES, []);
    const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
    const profile = profiles.find((p) => p.purpose === 'ko_highlight') || profiles[0];
    if (!profile) { console.error('업로드 프로필이 없다.'); process.exit(1); }
    const token = await accessToken(profile);

    const snap = (readJson(BACKLOG, { snapshots: [] }).snapshots || []).slice(-1)[0];
    if (!snap) { console.error('경쟁 채널 스냅숏이 없다 — rival-backlog.js 를 먼저 돌려라.'); process.exit(1); }
    // 살아 있는 것만 본다. 막힌 것은 «견딘 증거»가 아니다.
    const alive = Object.values(snap.rows).filter((r) => !r.blocked).slice(0, LIMIT);
    const ids = alive.map((r) => r.id);

    for (let i = 0; i < ids.length; i += 50) {
      const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.slice(i, i + 50).join(',')}`,
        { headers: { Authorization: `Bearer ${token}` } })).json();
      for (const it of v.items || []) {
        const t = titleOf((it.snippet || {}).description);
        if (!t) continue;
        const key = `${t.en}|${t.year}`;
        const row = store.films[key] || { en: t.en, ko: t.ko, year: t.year, tv: t.tv, seen: 0, channels: [] };
        row.seen += 1;
        const ch = (snap.rows[it.id] || {}).ch || '';
        if (ch && !row.channels.includes(ch)) row.channels.push(ch);
        store.films[key] = row;
      }
    }
    store.at = new Date().toISOString();
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
  }

  const films = Object.values(store.films || {});
  // 우리 카탈로그에 이미 있는 것은 새 정보가 아니다.
  const cat = readJson(CATALOG, {}).movies || {};
  const known = Object.values(cat).map((m) => String(m.title_en || '').toLowerCase());
  const fresh = films.filter((f) => !known.includes(String(f.en).toLowerCase()));

  const lines = [`# 경쟁 채널이 살려 두고 있는 작품 ${new Date().toLocaleString('ko-KR')}`, ''];
  lines.push(`살아 있는 영상에서 뽑은 작품 **${films.length}편** · 그중 우리 카탈로그에 없는 것 **${fresh.length}편**`, '');
  lines.push('_이 목록은 «우리 길이 · 우리 구조 · 지금 살아 있음»을 한꺼번에 증명한다._');
  lines.push('_생존자 신호(사례 92)는 검색 결과를 셌을 뿐이라 이보다 무디다._', '');
  lines.push('## 아직 안 쓴 작품 (많이 쓰이는 순)', '');
  for (const f of fresh.sort((a, b) => b.seen - a.seen).slice(0, 60)) {
    lines.push(`- ${String(f.seen).padStart(2)}회 · ${f.year || '????'} · ${f.en}${f.ko ? ` (${f.ko})` : ''}`
      + `${f.tv ? '  [TV]' : ''}  _${f.channels.join(',')}_`);
  }
  const text = lines.join('\n');
  console.log(text);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}-rival-films.md`), `${text}\n`, 'utf8');
})().catch((e) => { console.error('rival-films fatal:', e.message || e); process.exitCode = 1; });
