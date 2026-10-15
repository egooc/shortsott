// 구글 렌즈 반자동 시험 — 소재 프레임을 렌즈에 올려 «같은 장면이 이미 어디 있나»를 본다.
//
//   node scripts/lens-probe.js --frames <frames.json> --out <결과 폴더> [--headed]
//   frames.json = [{"id": "rinbox120ja_1", "path": "D:/.../f1.jpg", "group": "rinbox"}, ...]
//
// 왜 (10-16 소유주 «추천대로»): «숏폼 중복은 이미지 검색뿐»(제목·해시태그로는 안 된다). 반자동 도구로 갈지
//   정하기 전에 적중률과 차단 여부를 20회 안에서 잰다.
// 규칙(관리자 10-16):
// - 하루 20회 넘기지 않는다 — server/data/lens_count.json 에 날짜별로 센다. 넘을 것 같으면 시작하지 않는다.
// - 볼케이노킷(flow) 크롬과 다른 전용 프로필(server/data/lens-profile), 구글 로그인 없이.
// - 차단·캡차 신호(/sorry/, «unusual traffic» 등)가 보이면 그 자리에서 전부 멈추고 기록한다. 자동 재시도 없음.
// - 요청 사이 25~45초 쉰다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'server/data');
const PROFILE = path.join(DATA, 'lens-profile');
const COUNT = path.join(DATA, 'lens_count.json');
const LOG = path.join(DATA, 'lens_log.jsonl');
const DAILY_MAX = 20;
const BLOCK_RE = /\/sorry\/|unusual traffic|通常と異なるトラフィック|異常なトラフィック|ロボットではありません|비정상적인 트래픽|recaptcha/i;

function arg(name, fb) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fb;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

function readCount() {
  try { return JSON.parse(fs.readFileSync(COUNT, 'utf8')); } catch { return {}; }
}
function bump() {
  const c = readCount();
  c[today()] = (c[today()] || 0) + 1;
  fs.writeFileSync(COUNT, JSON.stringify(c, null, 2) + '\n', 'utf8');
  return c[today()];
}
function log(row) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', 'utf8');
}

async function blocked(page) {
  if (BLOCK_RE.test(page.url())) return 'url:' + page.url().slice(0, 80);
  const t = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '');
  const m = t.match(BLOCK_RE);
  return m ? 'text:' + m[0] : null;
}

async function results(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      const h = a.href;
      if (/google\.|gstatic\.|googleusercontent\./.test(new URL(h).hostname)) continue;
      const title = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!title || seen.has(h)) continue;
      seen.add(h);
      out.push({ title, url: h, host: new URL(h).hostname });
      if (out.length >= 15) break;
    }
    return out;
  });
}

async function one(page, f, outDir) {
  await page.goto('https://www.google.com/?hl=ja', { waitUntil: 'domcontentloaded' });
  await sleep(2000 + Math.random() * 2000);
  let b = await blocked(page);
  if (b) return { blocked: b };
  const cam = page.locator('[aria-label*="画像で検索"], [aria-label*="Search by image"], [aria-label*="이미지로 검색"]').first();
  await cam.click({ timeout: 15000 });
  await sleep(1500);
  // 숨은 input[type=file] 이 여럿이라 직접 넣으면 엉뚱한 곳에 들어간다(10-16 1회째) — «ファイルをアップロード» 를 눌러 파일 선택 창으로
  const link = page.locator('span:has-text("ファイルをアップロード"), [role=button]:has-text("ファイルをアップロード"), span:has-text("upload a file")').first();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), link.click({ timeout: 15000 })]);
  await chooser.setFiles(f.path);
  await page.waitForURL(/\/search|lens/, { timeout: 45000 }).catch(() => {});
  await sleep(6000 + Math.random() * 3000);
  b = await blocked(page);
  if (b) return { blocked: b };
  const all = await results(page);
  await page.screenshot({ path: path.join(outDir, f.id + '_all.png'), fullPage: false });
  // «完全一致»(같은 이미지) 탭이 있으면 거기 결과도 따로 본다
  let exact = [];
  const tab = page.locator('a:has-text("完全一致"), div[role=listitem]:has-text("完全一致"), a:has-text("Exact matches")').first();
  if (await tab.count()) {
    await tab.click({ timeout: 10000 }).catch(() => {});
    await sleep(4000 + Math.random() * 2000);
    b = await blocked(page);
    if (b) return { blocked: b, all };
    exact = await results(page);
    await page.screenshot({ path: path.join(outDir, f.id + '_exact.png'), fullPage: false });
  }
  return { all, exact, url: page.url() };
}

(async () => {
  const frames = JSON.parse(fs.readFileSync(arg('--frames'), 'utf8'));
  const outDir = arg('--out');
  fs.mkdirSync(outDir, { recursive: true });
  const used = readCount()[today()] || 0;
  if (used + frames.length > DAILY_MAX) {
    console.error(`오늘 ${used}회 썼다 — ${frames.length}회 더하면 하루 ${DAILY_MAX}회를 넘는다. 시작하지 않는다.`);
    process.exit(2);
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: !process.argv.includes('--headed'), locale: 'ja-JP', viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const res = [];
  for (const [i, f] of frames.entries()) {
    const n = bump();
    let r;
    try {
      r = await one(page, f, outDir);
    } catch (e) {
      r = { error: String(e.message || e).slice(0, 200) };
    }
    const row = { n, id: f.id, group: f.group, ...r };
    res.push(row);
    log({ id: f.id, group: f.group, n, blocked: r.blocked || null, error: r.error || null,
      all: (r.all || []).length, exact: (r.exact || []).length });
    console.log(`${n}회 ${f.id}: ${r.blocked ? '차단 ' + r.blocked : r.error ? '오류 ' + r.error : `결과 ${r.all.length} · 완전일치 ${r.exact.length}`}`);
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(res, null, 2) + '\n', 'utf8');
    if (r.blocked) {
      console.error('차단 신호 — 여기서 멈춘다(재시도 없음).');
      break;
    }
    if (i < frames.length - 1) await sleep(25000 + Math.random() * 20000);
  }
  await ctx.close();
})();
