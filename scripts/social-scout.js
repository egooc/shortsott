// 어랍숏 소스를 틱톡·인스타에서 찾아 후보 대장에 쌓는다. 받기는 따로 시킨다.
//
//   node scripts/social-scout.js --site tiktok --login
//   node scripts/social-scout.js --site tiktok --search "신기한 동물" --limit 40
//   node scripts/social-scout.js --list                      쌓인 후보 보기
//   node scripts/social-scout.js --site tiktok --fetch <url> 한 편만 받기(대장에 있는 것만)
//
// 왜 브라우저인가
//   yt-dlp 로 틱톡을 치면 `Your IP address is blocked`, 인스타는 `Instagram API is not granting access` 다.
//   페이스북·네이버 발행에 쓰는 것과 **같은 방식**(설치된 Chrome + 영속 프로필)으로 사람이 1회 로그인하면
//   이후 무인으로 돈다. 세션은 server/data/browser-profiles/<site> 에 남는다.
//
// 권리에 관하여 (읽고 지나가라)
//   **출처 표기는 이용 허락이 아니다.** 틱톡·인스타 영상은 올린 사람에게 저작권이 있고, 두 플랫폼의 약관은
//   타인 콘텐츠의 내려받기·재배포를 금한다. 표기만 하고 올리면 원작자 신고 시 내려가고 채널에 경고가 쌓인다.
//   소유주는 이 위험을 알고 표기 기준으로 가기로 했다(2026-09-19). 그래서 막지 않는다 — 대신 **기록한다.**
//   후보마다 `rights.basis` 가 남는다: credit_only(표기만) / permission_requested / permission_granted.
//   나중에 어느 편이 왜 내려갔는지 추적하려면 이 칸이 있어야 한다. 허락을 받았으면 evidence 에 근거를 적어라.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'server', 'data', 'browser-profiles');
const LEDGER = path.join(ROOT, 'server', 'data', 'social_source_queue.json');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

// 레퍼런스 @urabshorts 실측에서 나온 기준 (케이스북 사례 59·61)
const MIN_SEC = 25;
const MAX_SEC = 90;

const COLLECT_TIKTOK = `() => Array.from(document.querySelectorAll('a[href]'))
  .map(a => a.href)
  .filter(h => /tiktok\\.com\\/@[^/]+\\/video\\/[0-9]+/.test(h))`;

const COLLECT_INSTAGRAM = `() => Array.from(document.querySelectorAll('a[href]'))
  .map(a => a.href)
  .filter(h => /instagram\\.com\\/(reel|p)\\//.test(h))`;

const SITES = {
  tiktok: {
    home: 'https://www.tiktok.com/',
    loggedIn: '[data-e2e="profile-icon"], [data-e2e="nav-profile"]',
    search: (q) => `https://www.tiktok.com/search/video?q=${encodeURIComponent(q)}`,
    collect: COLLECT_TIKTOK,
  },
  instagram: {
    home: 'https://www.instagram.com/',
    loggedIn: 'a[href="/direct/inbox/"], svg[aria-label="홈"], svg[aria-label="Home"]',
    search: (q) => `https://www.instagram.com/explore/tags/${encodeURIComponent(String(q).replace(/^#/, ''))}/`,
    collect: COLLECT_INSTAGRAM,
  },
};

async function openBrowser(site, headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(path.join(PROFILE_DIR, site), {
    channel: 'chrome',
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    headless,
    viewport: { width: 1440, height: 960 },
    locale: 'ko-KR',
  });
}

// yt-dlp 가 쓸 수 있게 Netscape 형식으로 쿠키를 뽑는다. 로그인한 그 세션 그대로 받는다.
async function dumpCookies(ctx, file) {
  const rows = await ctx.cookies();
  const lines = ['# Netscape HTTP Cookie File', '# social-scout.js 가 브라우저 프로필에서 뽑았다'];
  for (const c of rows) {
    const expires = c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400;
    lines.push([c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path,
      c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function showList() {
  const led = readJson(LEDGER, { items: [] });
  const byBasis = {};
  for (const it of led.items) {
    const k = (it.rights || {}).basis || '?';
    byBasis[k] = (byBasis[k] || 0) + 1;
  }
  const summary = Object.entries(byBasis).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음';
  console.log(`후보 ${led.items.length}건 — ${summary}\n`);
  for (const it of led.items.slice(-40)) {
    const basis = (it.rights || {}).basis || '?';
    console.log(`${String(it.site || '').padEnd(9)} | ${String(it.durationSec == null ? '?' : it.durationSec).padStart(3)}s | ${String(it.author || '?').slice(0, 20).padEnd(22)} | ${basis}`);
    console.log(`  ${it.url}`);
  }
}

async function fetchOne(site) {
  const url = opt('--fetch');
  const led = readJson(LEDGER, { items: [] });
  const row = led.items.find((x) => x.url === url);
  if (!row) throw new Error('대장에 없는 주소다. 먼저 --search 로 후보에 올려라.');
  const out = opt('--out', path.join(ROOT, 'server', 'output', 'social-sources'));
  fs.mkdirSync(out, { recursive: true });

  const ctx = await openBrowser(site, true);
  const jar = await dumpCookies(ctx, path.join(out, `.cookies-${site}.txt`));
  await ctx.close();

  const r = spawnSync('yt-dlp', ['--cookies', jar, '-f', 'bv*+ba/b',
    '-o', path.join(out, '%(id)s.%(ext)s'), url], { encoding: 'utf8', timeout: 600000 });
  try { fs.unlinkSync(jar); } catch { /* 이미 지워졌으면 그만 */ }
  console.log((r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) throw new Error('받기 실패 — 로그인 세션이 만료됐을 수 있다. --login 을 다시 돌려라.');

  row.fetchedAt = new Date().toISOString();
  writeJson(LEDGER, led);
  console.log(`\n받음 → ${out}`);
  console.log(`출처 표기: ${row.credit || '(대장에 credit 을 채워라)'}`);
  console.log(`권리 근거: ${(row.rights || {}).basis || '?'} — 허락을 받았으면 rights.basis 를 permission_granted 로 고치고 evidence 를 적어라.`);
}

async function scout(site, spec) {
  const ctx = await openBrowser(site, has('--headless'));
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    if (has('--login')) {
      await page.goto(spec.home, { waitUntil: 'domcontentloaded' });
      console.log(`[login] ${site}: 열린 창에서 직접 로그인하세요. 감지되면 저장하고 닫습니다 (최대 10분).`);
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const ok = await page.locator(spec.loggedIn).first().isVisible().catch(() => false);
        if (ok) { console.log(`[login] ${site}: 확인됨 — 세션 저장(${path.join(PROFILE_DIR, site)})`); return; }
        await page.waitForTimeout(2000);
      }
      throw new Error('10분 안에 로그인이 확인되지 않았다');
    }

    const q = opt('--search');
    if (!q) throw new Error('--search "검색어" 또는 --login 이 필요하다');
    const limit = Number(opt('--limit', 30));

    await page.goto(spec.search(q), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const loggedIn = await page.locator(spec.loggedIn).first().isVisible().catch(() => false);
    if (!loggedIn) throw new Error(`로그인 세션이 없다. 먼저: node scripts/social-scout.js --site ${site} --login`);

    const urls = new Set();
    for (let i = 0; i < 12 && urls.size < limit; i += 1) {
      const found = await page.evaluate(spec.collect);
      for (const u of found) urls.add(String(u).split('?')[0]);
      await page.mouse.wheel(0, 2400);
      await page.waitForTimeout(1200);
    }
    console.log(`[scout] ${site} "${q}" — 링크 ${urls.size}개 수집, 메타를 확인한다`);

    const jar = await dumpCookies(ctx, path.join(PROFILE_DIR, `.cookies-${site}.txt`));
    const led = readJson(LEDGER, { items: [] });
    const known = new Set(led.items.map((x) => x.url));
    let added = 0;

    for (const url of [...urls].slice(0, limit)) {
      if (known.has(url)) continue;
      const r = spawnSync('yt-dlp', ['--cookies', jar, '--skip-download',
        '--print', '%(id)s\t%(duration)s\t%(uploader)s\t%(channel)s\t%(like_count)s\t%(view_count)s\t%(title)s', url],
        { encoding: 'utf8', timeout: 90000 });
      const line = (r.stdout || '').trim().split('\n').pop();
      if (!line || !line.includes('\t')) continue;
      const [id, dur, uploader, channel, likes, views, title] = line.split('\t');
      const d = Number(dur) || 0;
      const fits = d >= MIN_SEC && d <= MAX_SEC;
      const author = uploader && uploader !== 'NA' ? uploader : channel;
      console.log(`${fits ? '적합' : '  탈락'} | ${String(d).padStart(3)}s | ${String(author || '?').slice(0, 18).padEnd(20)} | ${String(title || '').slice(0, 38)}`);
      if (!fits) continue;
      led.items.push({
        site,
        url,
        id,
        durationSec: d,
        author,
        likes: Number(likes) || null,
        views: Number(views) || null,
        title: title || '',
        addedAt: new Date().toISOString(),
        credit: author ? `© ${author}` : '',
        // ★소유주가 정한 기준. 허락을 받으면 permission_granted 로 바꾸고 evidence 에 근거를 적어라.
        rights: { basis: 'credit_only', evidence: '', note: '출처 표기만. 원작자 허락은 받지 않았다.' },
      });
      added += 1;
    }
    try { fs.unlinkSync(jar); } catch { /* 이미 지워졌으면 그만 */ }
    writeJson(LEDGER, led);
    console.log(`\n대장에 ${added}건 추가 (총 ${led.items.length}) → ${LEDGER}`);
    console.log(`받으려면: node scripts/social-scout.js --site ${site} --fetch <url>`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (has('--list')) { showList(); return; }
  const site = opt('--site', 'tiktok');
  const spec = SITES[site];
  if (!spec) throw new Error(`모르는 사이트: ${site} (tiktok|instagram)`);
  if (has('--fetch')) { await fetchOne(site); return; }
  await scout(site, spec);
}

main().catch((e) => { console.error('[scout]', e.message); process.exit(1); });
