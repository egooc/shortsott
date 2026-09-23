// 화이트리스트를 «만든다». 어디서 받아 오는 게 아니라 생존자를 세어서 짓는다.
//
//   node scripts/survivor-signal.js            신호를 재계산해 카탈로그에 적고 보고한다
//   node scripts/survivor-signal.js --dry      카탈로그를 안 건드리고 보고만 한다
//   node scripts/survivor-signal.js --json
//
// 왜 (2026-09-22 소유주: "어디서 찾을 방법은 없어? 화이트리스트같은거")
//   공개된 목록은 없다. 유튜브는 권리자의 Content ID 정책을 알려 주는 API 가 없고,
//   프로브는 46% 를 놓쳤다(사례 91). 그런데 **차단된 영상은 내려간다.**
//   그러니 «지금도 살아 있는 클립 수»가 곧 그 영화의 관용도다. 생존자 편향을 거꾸로 쓴다.
//
// 무엇을 세나 — 두 번 틀리고 세 번째에 맞은 것
//   ① 남의 클립 채널이 실은 편 수 → **안 갈린다.** 통과 4.7편 / 차단 4.2편 (2026-09-22 실측).
//      대형 클립 채널은 대부분 라이선스가 있다. 그들의 생존은 «계약»이지 관용이 아니다.
//   ② recon.live_results → **안 갈린다.** 검색 상한이 10 이라 전부 10 이다.
//   ③ recon.live_in_our_band — **우리 길이대(60~180초)에 살아 있는 클립 수. 여기서 갈렸다.**
//
//      ★2026-09-23 정정. 표본 12편일 때 나는 "5 이상인 영화 중 차단된 것은 0편"이라고 적었다.
//        **틀렸다.** 표본을 17편으로 늘리니 신호 6 인 헐크와 8 인 노컨트리가 차단됐다.
//        보증이 아니다. 그래도 **확률은 확실히 갈린다**:
//        신호 5 이상 : 차단 2 · 통과 9 → 차단율 18%
//        신호 5 미만 : 차단 4 · 통과 2 → 차단율 67%
//        전체        : 차단 6 · 통과 11 → 차단율 35%
//        신호 5 이상을 고르면 차단율이 **35% → 18% 로 반 토막** 난다. 그게 이 신호의 값어치다.
//      길이대가 중요한 이유: 권리자가 참고 못 하고 넘기는 길이가 따로 있다. 30초짜리가
//      수백 개 살아 있어도 우리와 상관없다 — 우리는 1~3분을 올린다.
//
// ★n=12 다. 증명이 아니다(우연일 확률 ~7%). 그래서 **막지 않고 고르는 순서만 바꾼다.**
//   공짜로 얻는 신호다 — 정찰이 이미 계산해 둔 값을 읽을 뿐이라 추가 비용이 0 이다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCOUT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const REPORT_DIR = SCOUT_DIR;
const GOOD = 5;   // 이 이상이면 «관용도 높음». 위 실측에서 나온 선이다.

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// 정찰 리포트를 전부 훑어 영화별 최댓값을 쓴다.
// 최댓값인 이유: 어떤 날은 검색이 적게 걸린다. 한 번이라도 «살아 있는 것»을 봤으면 산 것이다.
function signal() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(SCOUT_DIR).filter((f) => /^scout-.*\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    const j = readJson(path.join(SCOUT_DIR, f), null);
    if (!j) continue;
    for (const v of (j.candidates || [])) {
      const key = v.movie && v.movie.key;
      const band = v.recon && Number(v.recon.live_in_our_band);
      if (!key || !Number.isFinite(band)) continue;
      const cur = out[key] || { band: -1, seenAt: '', band_sec: null };
      if (band > cur.band) {
        out[key] = { band, seenAt: (j.at || f).slice(0, 10), band_sec: (v.recon.band_sec || null) };
      }
    }
  }
  return out;
}

const sig = signal();
const cat = readJson(CATALOG, null);
if (!cat || !cat.movies) { console.error('카탈로그를 못 읽었다'); process.exit(1); }
const movies = cat.movies;

// 카탈로그에 적어 둔다. 소스를 고르는 쪽(생산 프롬프트·풀)이 여기만 보면 되게.
let wrote = 0;
for (const [key, s] of Object.entries(sig)) {
  if (!movies[key]) continue;
  const line = `${s.band} (${s.seenAt})`;
  if (movies[key].survivor_band !== line) { movies[key].survivor_band = line; wrote += 1; }
}
if (!process.argv.includes('--dry')) fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2));

// 보고 — 쓸 수 있는 영화 중 신호가 좋은 것부터
const BANNED_FAMILY = /lionsgate|summit|vestron|artisan|sony|columbia|screen gems/i;

// ★이미 만든 영화는 뺀다 (2026-09-22). 이 목록은 생산 프롬프트가 «집는 순서»로 읽는다 —
//   안 빼면 신호 9 짜리 legally-blonde 가 맨 위에 떠서 그대로 다시 만든다.
//   드래프트 이름 추측이 아니라 upload_meta.json 의 movie.key 를 믿는다(catalog-pool 과 같은 이유).
function madeKeys() {
  const os = require('os');
  const D = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
  const out = new Set();
  const consider = (draft) => {
    if (!draft) return;
    for (const loc of ['', '-ko', '-ja']) {
      const m = readJson(path.join(D, draft + loc, 'upload_meta.json'), null);
      const k = m && m.movie && m.movie.key;
      if (k) { out.add(k); return; }
    }
  };
  const st = readJson(path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), { history: [] });
  for (const h of (st.history || [])) consider(h.draft);
  try { for (const n of fs.readdirSync(D)) consider(n); } catch { /* 이력만으로 센다 */ }
  return out;
}
const made = madeKeys();

const usable = Object.entries(movies).filter(([k, m]) => m && m.distributor_tier && m.distributor_tier !== 'banned'
  && !BANNED_FAMILY.test(String(m.distributor || '')) && (Number(m.year) || 0) >= 1990
  && !made.has(k));

// ★시리즈 전작·후속이 banned 면 같이 의심한다 (2026-09-23).
//   02:45 회차가 스스로 찾아낸 규칙이다 — 소스가 제일 좋았던 «셜록 홈즈: 그림자 게임»을
//   전작 sherlock-holmes-2009 가 banned 라는 이유로 접었다. 같은 권리자·같은 참고 자료를
//   쓰는 쪽이라 **배급사 통계보다 한 단계 가까운 증거**다.
//   판정: 키의 앞 두 토막이 같거나(sherlock-holmes-*), 영어 제목의 앞 두 단어가 같으면 한 식구.
//   ★막지는 않는다. 표시만 한다 — 전작이 막혔다고 후속이 반드시 막히는 것은 아니다.
function franchiseRisk(key, movies) {
  const head = (k) => String(k).split('-').slice(0, 2).join('-');
  const lead = (m) => String((m || {}).title_en || '').toLowerCase().split(/\s+/).slice(0, 2).join(' ');
  const myHead = head(key);
  const myLead = lead(movies[key]);
  for (const [k2, m2] of Object.entries(movies)) {
    if (k2 === key || !m2 || m2.distributor_tier !== 'banned') continue;
    if (head(k2) === myHead) return k2;
    if (myLead && myLead.length > 4 && lead(m2) === myLead) return k2;
  }
  return null;
}

// ★«경쟁 채널에서 생존 확인»은 검색 결과 수보다 **강한 증거**다 (2026-09-23).
//   생존자 신호는 «그 영화 클립이 검색에 몇 개 살아 있나»를 셀 뿐이다.
//   rival_proven 은 «우리와 같은 길이·같은 구조의 채널이 지금 그 작품을 올려 두고 있다»는 뜻이라
//   한 단계 가깝다. 신호가 없다고 뒤로 밀면 TV 는 영원히 안 뽑힌다 — 그래서 여기서 받아 준다.
//   ★강한 증거이지 보증이 아니다. 프로브와 3층은 똑같이 거친다(사례 106·107).
const PROVEN_BAND = 5;   // «먼저 쓸 것» 문턱과 같은 값. 더 높이지 않는다 — 우대가 아니라 «같은 줄»이다.
const scored = usable.map(([k, m]) => ({
  k,
  year: m.year,
  band: sig[k] ? sig[k].band : (m.rival_proven ? PROVEN_BAND : null),
  proven: !!m.rival_proven && !sig[k],
  kin: franchiseRisk(k, movies),
}));
const good = scored.filter((r) => r.band !== null && r.band >= GOOD).sort((a, b) => b.band - a.band);
const weak = scored.filter((r) => r.band !== null && r.band < GOOD).sort((a, b) => b.band - a.band);
const unknown = scored.filter((r) => r.band === null);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ good: good.map((r) => r.k), weak: weak.map((r) => r.k), unknown: unknown.length, threshold: GOOD }, null, 2));
  process.exit(0);
}

const lines = [`# 생존자 신호 ${new Date().toLocaleString('ko-KR')}`, ''];
lines.push(`정찰 리포트에서 ${Object.keys(sig).length}편의 «우리 길이대 생존 클립 수»를 읽었다`
  + ` · 이미 만든 ${made.size}편은 뺐다`
  + `${wrote ? ` · 카탈로그 ${wrote}편 갱신` : ''}.`, '');
lines.push(`## 먼저 쓸 것 — 생존 ${GOOD}편 이상 (${good.length}편)`, '');
for (const r of good.slice(0, 30)) {
  lines.push(`- ${r.proven ? ' 확' : String(r.band).padStart(2)}  ${r.year}  ${r.k}`
    + (r.proven ? '   (경쟁 채널 생존 확인)' : '')
    + (r.kin ? `   ★한 식구 ${r.kin} 가 차단됐다 — 같이 의심하라` : ''));
}
lines.push('', `## 신호 약함 — ${GOOD}편 미만 (${weak.length}편). 나중에, 또는 다른 선택지가 없을 때`, '');
for (const r of weak.slice(0, 20)) lines.push(`- ${String(r.band).padStart(2)}  ${r.year}  ${r.k}`);
lines.push('', `## 아직 모름 ${unknown.length}편 — 정찰이 recon 을 안 붙였다. 쓰기 전에 정찰을 한 번 돌려라.`);
lines.push('', '_실측 근거(17편, 2026-09-23 갱신): 신호 5 이상 차단율 **18%** (2/11) ·_'
  + ' _5 미만 **67%** (4/6) · 전체 35%._');
lines.push('_★보증이 아니다. 신호 6 인 헐크와 8 인 노컨트리도 차단됐다._'
  + ' _확률을 반으로 줄일 뿐이다 — 막지 않고 «고르는 순서»만 바꾼다._');
lines.push('_★«한 식구» 표시는 시리즈 전작·후속이 차단된 경우다. 배급사 통계보다 가까운 증거지만_'
  + ' _막는 규칙은 아니다 — 소스가 유난히 좋으면 프로브로 확인하고 가라._');

const text = lines.join('\n');
console.log(text);
fs.mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
fs.writeFileSync(path.join(REPORT_DIR, `${stamp}-survivor.md`), `${text}\n`, 'utf8');
