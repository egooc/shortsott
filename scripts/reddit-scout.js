// 어랍숏 소스를 레딧에서 찾아 후보 대장에 쌓는다. 받기는 따로 시킨다.
//
//   node scripts/reddit-scout.js --subs nextfuckinglevel,BeAmazed --period week
//   node scripts/reddit-scout.js --list
//   node scripts/reddit-scout.js --fetch <permalink> [--out <dir>]
//
// 왜 레딧인가 (2026-09-19)
//   틱톡은 `Your IP address is blocked`, 인스타는 `Instagram API is not granting access` 라 로그인 세션이 있어야 한다.
//   레딧은 **아무 등록 없이도** 돈다 — 비로그인 JSON 은 403 이지만 `top.rss` 는 200 이다.
//   덤으로 **피드 순서가 곧 바이럴 순위**다. 레퍼런스 @urabshorts 의 터진 편들이 전부 이미 퍼진 클립이었다(사례 61).
//
// 두 경로 (자동 선택)
//   · 기본 = RSS. 자격증명이 없으면 이쪽으로 돈다. 추천 수는 못 보고 **순위**로 대신한다.
//     속도 제한이 빡빡해 요청 사이를 띄운다. 몰아 부르면 429 가 난다.
//   · API = 앱을 등록했으면 이쪽. 추천 수·댓글 수까지 나와 거르기가 정확해진다. 필수는 아니다.
//     https://www.reddit.com/prefs/apps 에서 «script» 앱을 만들고 D:\midform\.env 에 두 줄을 넣으면 자동 전환된다:
//        REDDIT_CLIENT_ID=<앱 이름 아래 짧은 문자열>
//        REDDIT_CLIENT_SECRET=<secret>
//
// 권리에 관하여
//   레딧 게시물의 저작권은 **올린 사람이 아니라 원래 찍은 사람**에게 있다. 레딧은 재게시가 많아 원작자가
//   게시자와 다른 경우가 흔하다. 출처 표기는 이용 허락이 아니다 — 사례 62·63 과 같은 위험을 진다.
//   소유주가 표기 기준으로 가기로 했으므로 막지 않고 **기록한다**(rights.basis). 원작자가 확실하면 credit 을 고쳐라.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'server', 'data', 'social_source_queue.json');
const UA = 'midform-source-scout/1.0 (by /u/midform)';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

// 레퍼런스 @urabshorts 실측 기준 (사례 59·61)
const MIN_SEC = 25;
const MAX_SEC = 90;
// 사실상 무음 기준 (사례 62). 이보다 조용하면 어랍숏에 못 쓴다.
const MIN_DB = -45;
// 긴 변이 이보다 작으면 1080x1920 으로 올릴 때 뭉개진다. 296x640·630x480 같은 것이 섞여 온다.
const MIN_LONG_EDGE = 1280;
// ★기본 판은 레퍼런스 60편 실측(사례 66)에 **욕구 축**을 얹어 다시 짰다 (2026-09-21, 사례 71).
//   소유주 지적: "주제가 너무 심심해. 자극이나 도파민이 하나도 없다."
//   처음 판은 specializedtools·educationalgifs 처럼 **솜씨 구경** 판 위주였다. 그래서 도마뱀이 달걀 먹고
//   모래를 깎는, 예쁘지만 끌어당기지 않는 소재만 올라왔다.
//
//   레퍼런스 상위권이 실제로 건드리는 것은 솜씨가 아니라 **욕구**다:
//     고통·신체(클라이머 연고 200만) · 금기(N단어 89만) · 공포(환공포증 집 46만)
//     먹기·경쟁(식탐 친구 66만) · 돈(두바이 부자) · 사회적 마찰(답정너 34만)
//
//   ★유튜브 정책 안에서 간다(소유주 지시 2026-09-21). **소재는 안전하게, 자극은 프레임으로.**
//   넣지 않는 판: 유혈·부상·시신, 싸움·괴롭힘(PublicFreakout 류), 성적 내용, 위험 행동 따라하기 유발,
//   정치·종교·젠더 논쟁. 조회수는 나와도 광고 부적격이거나 신고를 부른다.
const DEFAULT_SUBS = [
  // 예상 밖·반전 — 긴장을 만드는 가장 안전한 축
  'Unexpected', 'therewasanattempt',
  // 규모·솜씨의 충격 (여전히 유효하되 비중을 낮춘다)
  'nextfuckinglevel', 'BeAmazed', 'Damnthatsinteresting',
  // 낯선 것·해외 — 레퍼런스 상위 4편이 여기서 나왔다
  'interestingasfuck',
  // 공포·긴장 (유혈 없는 것만). ★2026-09-21 교체: oddlyterrifying·mildlyinfuriating 은
  //   첫 실측에서 쓸 영상이 거의 안 나왔다 — 대부분 사진 게시물이다. 영상이 실제로 올라오는
  //   같은 축의 서브로 바꾼다.
  'nonononoyes',          // 긴장 → 무사히 끝나는 반전. 유혈 없이 조마조마함만 남는다
  'blackmagicfuckery',    // 규모·불가능 — "저게 왜 되지"가 그대로 제목 틀이 된다
  // 사회적 마찰 — 답정너·잔소리 결
  'Wellthatsucks',
];

function env(key) {
  if (process.env[key]) return process.env[key].trim();
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return '';
  const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

async function token() {
  const id = env('REDDIT_CLIENT_ID');
  const secret = env('REDDIT_CLIENT_SECRET');
  if (!id || !secret) {
    throw new Error('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 이 없다. '
      + 'https://www.reddit.com/prefs/apps 에서 script 앱을 만들고 D:\\midform\\.env 에 두 줄을 넣어라.');
  }
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`토큰 발급 실패 ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.access_token;
}

async function listing(tok, sub, period, limit) {
  const u = `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/top?t=${period}&limit=${limit}&raw_json=1`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`${sub} 목록 실패 ${r.status}`);
  const j = await r.json();
  return (j.data?.children || []).map((c) => c.data);
}

function showList() {
  const led = readJson(LEDGER, { items: [] });
  const rows = led.items.filter((x) => x.site === 'reddit');
  console.log(`레딧 후보 ${rows.length}건 (대장 전체 ${led.items.length})\n`);
  for (const it of rows.slice(-40)) {
    console.log(`${String(it.durationSec ?? '?').padStart(3)}s | ${String(it.score ?? '?').padStart(7)}점 | ${String(it.subreddit || '').slice(0, 20).padEnd(22)} | ${String(it.title || '').slice(0, 44)}`);
    console.log(`  ${it.url}`);
  }
}

function fetchOne() {
  const url = opt('--fetch');
  const led = readJson(LEDGER, { items: [] });
  const row = led.items.find((x) => x.url === url);
  if (!row) throw new Error('대장에 없는 주소다. 먼저 정찰로 후보에 올려라.');
  const out = opt('--out', path.join(ROOT, 'server', 'output', 'social-sources'));
  fs.mkdirSync(out, { recursive: true });

  const r = spawnSync('yt-dlp', ['-f', 'bv*+ba/b', '--user-agent', UA,
    '-o', path.join(out, '%(id)s.%(ext)s'), url], { encoding: 'utf8', timeout: 600000 });
  console.log((r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) throw new Error('받기 실패');

  // ★받고 나서 반드시 잰다. 사례 62 — 길이·화질만 보고 고르면 무음 소재를 끝까지 못 알아챈다.
  const file = fs.readdirSync(out).filter((f) => f.startsWith(String(row.id))).map((f) => path.join(out, f))[0];
  if (file) {
    const v = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 64 << 20 });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(v.stderr || '');
    const db = m ? Number(m[1]) : null;
    row.audioDb = db;
    console.log(db === null ? '\n경고: 오디오 트랙이 없다 — 어랍숏에는 쓰지 마라.'
      : `\n오디오 평균 ${db.toFixed(1)}dB ${db > -45 ? '(쓸 만하다)' : '(사실상 무음 — 쓰지 마라)'}`);
  }
  row.fetchedAt = new Date().toISOString();
  writeJson(LEDGER, led);
  console.log(`받음 → ${out}`);
  console.log(`출처 표기: ${row.credit} — 레딧은 재게시가 잦다. 원작자가 따로 있으면 credit 을 고쳐라.`);
}

// ── RSS 경로 ────────────────────────────────────────────────────────────────
// 앱 등록 없이도 돈다. `r/<sub>/top.rss?t=week` 는 비로그인 200 이다(JSON 은 403).
// 단 **속도 제한이 빡빡하다** — 몰아서 부르면 429 가 난다. 요청 사이를 띄우고 재시도한다.
// 추천 수는 RSS 에 없다. 대신 **피드 순서가 곧 상위 순위**라 자리 자체가 지표다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function rss(sub, period, tries = 4) {
  const u = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.rss?t=${period}`;
  for (let i = 0; i < tries; i += 1) {
    const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/atom+xml' } });
    if (r.status === 429) { await sleep(8000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`r/${sub} RSS ${r.status}`);
    const xml = await r.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const e = m[1];
      const pick = (re) => { const x = re.exec(e); return x ? x[1] : ''; };
      return {
        title: pick(/<title>([\s\S]*?)<\/title>/).trim(),
        url: pick(/<link href="([^"]+)"/),
        author: pick(/<name>([\s\S]*?)<\/name>/).replace(/^\/u\//, ''),
      };
    }).filter((x) => x.url);
  }
  throw new Error(`r/${sub} RSS 429 — 잠시 뒤 다시 돌려라`);
}

// RSS 에는 길이가 없다. 게시물 하나씩 yt-dlp 로 재서 영상인지·몇 초인지·**소리가 붙어 있는지** 본다.
//
// ★소리 확인을 받기 전에 한다. 레딧에는 소리 없는 영상이 흔하다 — 짤(GIF)을 mp4 로 올린 것,
//   원본에서 오디오를 떼고 올린 재게시물이 섞여 있다. 실제로 첫 후보가 **-91dB 무음**이었다(사례 62 의 반복).
//   형식 목록에 `audio only` 가 보이는 것만으로는 판정이 안 된다 — 레딧은 **무음 AAC 트랙**을 붙여 내보낸다.
function probePost(url) {
  // ★2026-09-21: 해상도도 같이 받는다. 같은 호출이라 공짜인데, 이게 없어서 630x480 짜리를
  //   받아 보고서야 버렸다(20:10 arab16). 대장에 적어 두면 고를 때 바로 걸러진다.
  const meta = spawnSync('yt-dlp', ['--skip-download', '--no-warnings', '--user-agent', BROWSER_UA,
    '--print', '%(id)s\t%(duration)s\t%(width)s\t%(height)s', url], { encoding: 'utf8', timeout: 90000 });
  const line = (meta.stdout || '').trim().split('\n').pop();
  if (!line || !line.includes('\t')) return null;
  const [id, dur, w, h] = line.split('\t');
  const width = Number(w) || 0;
  const height = Number(h) || 0;

  // ★형식 목록에 `audio only` 가 있는 것만으로는 모자란다. 레딧은 **무음 AAC 트랙**을 붙여 내보내는 일이 잦아
  //   목록상 소리가 있는 것처럼 보인다(실측: BeAmazed 6위 글이 목록 통과 후 -91dB 였다).
  //   그러니 **음원만 받아 실제로 잰다.** 40초짜리 오디오는 수백 KB라 영상 전체를 받는 것보다 훨씬 싸다.
  const g = spawnSync('yt-dlp', ['-f', 'ba', '-g', '--no-warnings', '--user-agent', BROWSER_UA, url],
    { encoding: 'utf8', timeout: 90000 });
  const audioUrl = (g.stdout || '').trim().split('\n')[0];
  if (!audioUrl) return { id, dur: Number(dur) || 0, width, height, audioDb: null };

  const v = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-user_agent', BROWSER_UA,
    '-t', '30', '-i', audioUrl, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20 });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(v.stderr || '');
  return { id, dur: Number(dur) || 0, width, height, audioDb: m ? Number(m[1]) : null };
}

async function scoutRss() {
  const subs = String(opt('--subs', DEFAULT_SUBS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
  const period = opt('--period', 'week');
  const topN = Number(opt('--limit', 12));
  const led = readJson(LEDGER, { items: [] });
  const known = new Set(led.items.map((x) => x.url));
  let added = 0;

  for (const sub of subs) {
    let entries = [];
    try { entries = await rss(sub, period); } catch (e) { console.log(`[${sub}] ${e.message}`); continue; }
    console.log(`\n[r/${sub}] ${period} 상위 ${entries.length}건 (RSS · 순서가 곧 순위)`);
    let rank = 0;
    for (const en of entries.slice(0, topN)) {
      rank += 1;
      if (known.has(en.url)) continue;
      const p = probePost(en.url);
      await sleep(1500);
      if (!p) { console.log(`  건너뜀 ${rank}위 | 영상 아님 | ${en.title.slice(0, 44)}`); continue; }
      const lenOk = p.dur >= MIN_SEC && p.dur <= MAX_SEC;
      const audible = p.audioDb !== null && p.audioDb > MIN_DB;
      // ★해상도 문턱 (2026-09-21). 긴 변이 1280 미만이면 1080x1920 으로 올릴 때 뭉개진다.
      //   630x480 짜리를 받아 보고서야 버린 적이 있어 여기서 미리 자른다.
      const bigEnough = Math.max(p.width, p.height) >= MIN_LONG_EDGE;
      const fits = lenOk && audible && bigEnough;
      const dbTxt = p.audioDb === null ? '무음' : `${p.audioDb.toFixed(0)}dB`;
      const resTxt = p.width ? `${p.width}x${p.height}` : '?';
      console.log(`${fits ? '적합' : '  탈락'} | ${String(rank).padStart(2)}위 | ${String(p.dur).padStart(3)}s | ${dbTxt.padStart(6)} | ${resTxt.padStart(9)} | ${en.title.slice(0, 40)}`);
      if (!fits) continue;
      led.items.push({
        site: 'reddit', url: en.url, id: p.id, subreddit: sub,
        durationSec: p.dur, rank, score: null, author: en.author, title: en.title, audioDb: p.audioDb,
        width: p.width, height: p.height,
        addedAt: new Date().toISOString(), source: 'rss',
        credit: `via r/${sub} · u/${en.author}`,
        rights: { basis: 'credit_only', evidence: '', note: '출처 표기만. 레딧 게시자가 원작자가 아닐 수 있다 — 쓰기 전에 원작자를 확인하라.' },
      });
      added += 1;
    }
    await sleep(4000);
  }
  writeJson(LEDGER, led);
  console.log(`\n대장에 ${added}건 추가 (총 ${led.items.length}) → ${LEDGER}`);
  console.log('받으려면: node scripts/reddit-scout.js --fetch <permalink>');
}

async function scout() {
  const subs = String(opt('--subs', DEFAULT_SUBS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
  const period = opt('--period', 'week');
  const minScore = Number(opt('--min-score', 3000));
  const limit = Number(opt('--limit', 50));

  const tok = await token();
  const led = readJson(LEDGER, { items: [] });
  const known = new Set(led.items.map((x) => x.url));
  let added = 0;

  for (const sub of subs) {
    let posts = [];
    try { posts = await listing(tok, sub, period, limit); } catch (e) { console.log(`[${sub}] ${e.message}`); continue; }
    console.log(`\n[r/${sub}] ${period} 상위 ${posts.length}건`);
    for (const p of posts) {
      const rv = (p.secure_media || p.media || {}).reddit_video;
      if (!rv || !p.is_video) continue;
      const dur = Number(rv.duration) || 0;
      const score = Number(p.score) || 0;
      // has_audio 는 있을 때만 믿는다. 없으면 받아서 잰다(사례 62).
      const audioKnownSilent = rv.has_audio === false;
      const fits = dur >= MIN_SEC && dur <= MAX_SEC && score >= minScore && !audioKnownSilent;
      const url = `https://www.reddit.com${p.permalink}`;
      console.log(`${fits ? '적합' : '  탈락'} | ${String(dur).padStart(3)}s | ${String(score).padStart(7)}점 | ${String(p.title || '').slice(0, 46)}`);
      if (!fits || known.has(url)) continue;
      led.items.push({
        site: 'reddit',
        url,
        id: p.id,
        subreddit: p.subreddit,
        durationSec: dur,
        score,
        comments: Number(p.num_comments) || 0,
        author: p.author,
        title: p.title || '',
        over18: !!p.over_18,
        addedAt: new Date().toISOString(),
        credit: `via r/${p.subreddit} · u/${p.author}`,
        rights: {
          basis: 'credit_only',
          evidence: '',
          note: '출처 표기만. 레딧 게시자가 원작자가 아닐 수 있다 — 쓰기 전에 원작자를 확인하라.',
        },
      });
      added += 1;
    }
  }
  writeJson(LEDGER, led);
  console.log(`\n대장에 ${added}건 추가 (총 ${led.items.length}) → ${LEDGER}`);
  console.log('받으려면: node scripts/reddit-scout.js --fetch <permalink>');
}

async function main() {
  if (has('--list')) { showList(); return; }
  if (has('--fetch')) { fetchOne(); return; }
  // 자격증명이 있으면 API(추천 수까지 나온다), 없으면 RSS 로 돈다.
  if (has('--rss') || !env('REDDIT_CLIENT_ID') || !env('REDDIT_CLIENT_SECRET')) {
    if (!has('--rss')) console.log('[reddit] 앱 자격증명이 없다 — RSS 경로로 돈다(추천 수는 못 본다, 순위로 대신한다).\n');
    await scoutRss();
    return;
  }
  await scout();
}

main().catch((e) => { console.error('[reddit]', e.message); process.exit(1); });
