// 쿠팡 검색 결과에서 상품명·가격·로켓배송·리뷰 수를 뽑는다. 상품 확정용(명세서 2-1: 로켓배송·리뷰 급증).
//
//   node scripts/coupang_search.js "문풍지" [--headed] [--out cand.json]
//
// 쿠팡은 봇 차단(Akamai)이 강하다. 실제 크롬 + 영속 프로필(server/data/browser-profiles/coupang)로 연다.
// 막히면 --headed 로 한 번 사람이 열어 통과시키면 쿠키가 남는다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, 'server', 'data', 'browser-profiles', 'coupang');
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const HEADED = argv.includes('--headed');
const OUT = opt('--out', null);
const q = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!q) { console.error('usage: node scripts/coupang_search.js <검색어> [--headed] [--out f]'); process.exit(2); }

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: !HEADED,
    viewport: { width: 1400, height: 1000 }, locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}&channel=user&sorter=scoreDesc&listSize=36`;
  let status = null;
  page.on('response', (r) => { if (r.url().startsWith('https://www.coupang.com/np/search')) status = r.status(); });
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('goto', e.message.split('\n')[0]); }
  await page.waitForTimeout(HEADED ? 15000 : 6000);
  const title = await page.title().catch(() => '');
  const items = await page.evaluate(() => {
    const out = [];
    const cards = document.querySelectorAll('li[class*="ProductUnit"], li.search-product, #product-list > li, ul#productList > li');
    for (const li of cards) {
      const a = li.querySelector('a[href*="/vp/products/"]');
      if (!a) continue;
      const txt = (sel) => { const e = li.querySelector(sel); return e ? e.textContent.trim() : ''; };
      const name = txt('[class*="productName"], .name, [class*="ProductUnit_productName"]') || a.getAttribute('title') || '';
      const price = txt('[class*="priceValue"], .price-value, strong[class*="Price"]');
      const reviews = (txt('[class*="ratingTotalCount"], .rating-total-count') || '').replace(/[^0-9]/g, '');
      const rocket = !!li.querySelector('img[src*="rocket"], img[alt*="로켓"], [class*="badge"] img[src*="rocket"]');
      const ad = /광고|AD/.test(txt('[class*="AdMark"], .ad-badge-text'));
      out.push({ name: name.slice(0, 80), price, reviews: reviews ? +reviews : 0, rocket, ad,
                 url: 'https://www.coupang.com' + a.getAttribute('href').split('?')[0] });
    }
    return out;
  }).catch(() => []);
  console.log(`status ${status} · title "${title.slice(0, 40)}" · 상품 ${items.length}개`);
  const top = items.filter((x) => !x.ad).sort((a, b) => b.reviews - a.reviews);
  for (const x of top.slice(0, 15)) console.log(`${x.rocket ? '🚀' : '  '} 리뷰 ${String(x.reviews).padStart(6)} · ${x.price.padStart(8)}원 · ${x.name}`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ q, at: new Date().toISOString(), items }, null, 2) + '\n', 'utf8');
  await ctx.close();
})();
