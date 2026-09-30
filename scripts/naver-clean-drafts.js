// 네이버 클립 콘텐츠 목록에서 "제목이 파일명 그대로인 초안"만 지운다.
//
//   node scripts/naver-clean-drafts.js            무엇을 지울지 보여주기만 함(기본 안전)
//   node scripts/naver-clean-drafts.js --delete   실제 삭제
//
// 왜 필요한가: 업로드 폼은 파일을 붙이는 순간 서버에 초안을 만든다. 자동화 선택자를 맞추느라 폼을 여러 번
// 열었다 닫으면 그만큼 초안이 쌓인다(2026-09-18 에 8건). 사람이 만든 초안까지 지우면 안 되므로,
// 제목이 아직 "<파일명>.mp4" 인 것 — 즉 설명을 한 번도 채우지 않은 자동화 잔재 — 만 대상으로 한다.
const path = require('path');
const { chromium } = require('playwright-core');

const PROFILE = path.resolve(__dirname, '..', 'server', 'data', 'browser-profiles', 'naverclip');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LIST = 'https://clipcreators.naver.com/web/contents/clips';

(async () => {
  const doDelete = process.argv.includes('--delete');
  // --match <조각>: 제목에 그 조각이 든 초안만 대상으로 한다. 목록에는 다른 채널(명화관)의
  // 잔재도 섞여 있어서, 내가 만든 것만 지우고 싶을 때 쓴다. 없으면 예전처럼 전부가 대상이다.
  const mi = process.argv.indexOf('--match');
  const match = mi > 0 ? String(process.argv[mi + 1] || '') : '';
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', executablePath: CHROME, headless: false,
    viewport: { width: 1440, height: 1100 }, locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', async (d) => { console.log('  확인창:', d.message().slice(0, 80)); await d.accept().catch(() => {}); });

  let removed = 0;
  for (let round = 0; round < 30; round += 1) {
    await page.goto(LIST, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    // 한 번에 한 건씩: 삭제하면 목록이 다시 그려져 인덱스가 밀린다.
    let rows = page.locator('tr').filter({ hasText: '초안' }).filter({ hasText: '.mp4' });
    if (match) rows = rows.filter({ hasText: match });
    const n = await rows.count().catch(() => 0);
    if (!n) { console.log(round === 0 ? '지울 초안이 없다.' : `정리 끝 — 총 ${removed}건 삭제.`); break; }
    const row = rows.first();
    const label = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 60);
    if (!doDelete) {
      const all = [];
      for (let i = 0; i < n; i += 1) all.push((await rows.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 60));
      console.log(`삭제 대상 ${n}건 (지우려면 --delete):`);
      all.forEach((t) => console.log('  - ' + t));
      break;
    }
    console.log(`[${round + 1}] 삭제: ${label}`);
    // 행 끝의 더보기(⋮) → 삭제
    const more = row.locator('button').last();
    await more.click().catch(() => {});
    await page.waitForTimeout(1200);
    const del = page.locator('li,button').filter({ hasText: '삭제' }).first();
    if (!(await del.count().catch(() => 0))) { console.log('  삭제 메뉴를 못 찾았다 — 중단'); break; }
    await del.click().catch(() => {});
    await page.waitForTimeout(1500);
    // 확인 모달
    const confirm = page.getByRole('button', { name: /삭제|확인/ }).last();
    if (await confirm.count().catch(() => 0)) { await confirm.click().catch(() => {}); }
    await page.waitForTimeout(2500);
    removed += 1;
  }
  await ctx.close();
})().catch((e) => { console.error('[clean]', e.message); process.exit(1); });
