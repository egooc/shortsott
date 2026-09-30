// 더우인 영상을 워터마크 없이 가장 높은 H.264 화질로 받는다.
//
//   node scripts/douyin-grab.js --out <저장폴더> <영상URL|aweme_id> [...]
//   node scripts/douyin-grab.js --out <저장폴더> --allow-hevc <URL>   HEVC(4K 등)도 허용
//
// 왜 브라우저인가
//   yt-dlp 2026.08 은 더우인에서 403 "Fresh cookies" 로 죽는다. 크롬 쿠키는 DPAPI 로 못 읽고,
//   쿠키를 넣어도 요청 서명이 없어 같은 403 이다. 실제 크롬으로 영상 페이지를 열면 페이지가 스스로
//   aweme/detail 을 부르고, 그 응답의 video.bit_rate[] 에 해상도별 주소가 워터마크 없이 들어 있다.
//   검색 페이지는 캡차(验证码中间页)라 URL 은 따로 구해야 한다.
//
// 결과: <out>/dy_<id>.mp4 (H.264, 받은 그대로) + dy_<id>.json (설명·작성자·고른 화질·원본 URL)
// 영상 주소는 몇 시간이면 만료되므로 뽑자마자 받는다. 여러 편은 몇 초 간격을 둔다(차단 방지).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, 'server', 'data', 'browser-profiles', 'douyin');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('--out', null);
const ALLOW_HEVC = argv.includes('--allow-hevc');
const targets = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!OUT || !targets.length) { console.error('usage: node scripts/douyin-grab.js --out <dir> <url|id> ...'); process.exit(2); }

const idOf = (t) => (t.match(/(\d{15,})/) || [])[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickRate(detail) {
  const rates = (detail.video.bit_rate || []).map((b) => ({
    gear: b.gear_name, h265: !!b.is_h265, bps: b.bit_rate,
    w: b.play_addr.width, h: b.play_addr.height, urls: b.play_addr.url_list || [],
  })).filter((r) => r.urls.length && (ALLOW_HEVC || !r.h265));
  rates.sort((a, b) => (b.w * b.h) - (a.w * a.h) || b.bps - a.bps);
  return { best: rates[0], all: rates };
}

async function grabOne(ctx, target) {
  const id = idOf(target);
  if (!id) throw new Error(`aweme_id 를 못 찾았다: ${target}`);
  const url = `https://www.douyin.com/video/${id}`;
  const page = await ctx.newPage();
  let detail = null;
  page.on('response', async (r) => {
    if (!/aweme\/v1\/web\/aweme\/detail/.test(r.url())) return;
    try { const j = JSON.parse(await r.text()); if (j.aweme_detail) detail = j.aweme_detail; } catch (_) { /* 다른 응답 */ }
  });
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('  goto', e.message.split('\n')[0]); }
  for (let i = 0; i < 30 && !detail; i++) await page.waitForTimeout(500);
  const title = await page.title().catch(() => '');
  await page.close();
  if (!detail) throw new Error(`영상 정보(aweme/detail)가 오지 않았다 — 캡차·삭제·지역 차단 확인 (title=${title})`);

  const { best, all } = pickRate(detail);
  if (!best) throw new Error('받을 수 있는 화질이 없다' + (ALLOW_HEVC ? '' : ' (H.264 없음 — --allow-hevc 로 다시)'));
  const file = path.join(OUT, `dy_${id}.mp4`);
  let ok = false;
  for (const u of best.urls) {
    const r = spawnSync('curl', ['-sL', '--fail', '-A', UA, '-e', 'https://www.douyin.com/', '-o', file, u], { stdio: 'inherit' });
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 100000) { ok = true; break; }
  }
  if (!ok) throw new Error('내려받기 실패 (주소 만료이거나 차단)');
  const meta = {
    aweme_id: id, url, desc: detail.desc, author: detail.author && detail.author.nickname,
    author_uid: detail.author && detail.author.sec_uid, create_time: detail.create_time,
    duration_ms: detail.video.duration, picked: { gear: best.gear, w: best.w, h: best.h, h265: best.h265, bps: best.bps },
    available: all.map(({ urls, ...r }) => r), file, grabbed_at: new Date().toISOString(),
    rights: { basis: 'credit_only', statement: '더우인 공개 게시물. 출처 표기 기준(소유주 결정 2026-09-19).' },
  };
  fs.writeFileSync(path.join(OUT, `dy_${id}.json`), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`  ✓ ${id} ${best.w}x${best.h}${best.h265 ? ' HEVC' : ''} ${(fs.statSync(file).size / 1e6).toFixed(1)}MB · ${meta.author} · ${String(meta.desc).slice(0, 40)}`);
  return meta;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: true, viewport: { width: 1400, height: 1000 }, locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
  });
  let fail = 0;
  for (const [i, t] of targets.entries()) {
    if (i) await sleep(4000 + Math.random() * 3000);
    console.log(`[${i + 1}/${targets.length}] ${t}`);
    try { await grabOne(ctx, t); } catch (e) { fail++; console.log('  ✗', e.message); }
  }
  await ctx.close();
  process.exit(fail ? 1 : 0);
})();
