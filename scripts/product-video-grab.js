// 판매처 상품 영상 수집기 — 알리·타오바오 같은 «상품 페이지에 붙은 영상»을 받아 온다.
//
//   node scripts/product-video-grab.js --out D:/volcano-runs/shop04/footage <상품URL> [<상품URL> ...]
//   node scripts/product-video-grab.js --out ... --headed <상품URL>      창을 띄워 눈으로 본다
//
// 왜 필요한가 (2026-09-28)
//   쇼핑 채널 소재를 한국 리뷰 유튜브에서 구하다 벽에 부딪혔다. 한국 리뷰·예능 영상은 장르 관습상
//   화면에 자막을 굽는다 — 13편 중 11편이 번인이었고, 깨끗해 보이던 나머지 한 편마저 노란 자막
//   띠가 전 구간에 깔려 있었다(shop03). 남의 자막이 박힌 화면은 그대로 완성본에 나간다.
//   반면 «판매자가 찍은 상품 영상»은 자막이 없고 컷이 잘게 나뉘어 있다 — 쇼핑 숏폼에 딱 맞는다.
//   그런데 알리는 순수 curl 을 막는다(봇 차단 셸 75KB 만 준다). 그래서 진짜 브라우저로 연다.
//
// 어떻게 찾나
//   ① 네트워크를 엿본다 — 페이지가 실제로 받아 가는 .mp4 / .m3u8 요청을 모은다. 가장 확실하다.
//   ② 페이지 안의 videoId 를 읽는다 — 알리는 runParams 에 넣어 두고
//      cloud.video.taobao.com/play/u/<uid>/p/1/e/6/t/10301/<videoId>.mp4 로 제공한다.
//   ③ 영상 썸네일을 눌러 재생을 유도한다 — 안 누르면 요청 자체가 안 나가는 페이지가 있다.
//
// ★받은 파일을 그대로 쓰지 마라. 반드시 화면 검사를 통과시켜라:
//     python D:/volcano-runs/_preset_trials/소스_화면검사2.py <파일>
//   판매자 영상에도 «가격·할인» 글자가 구워져 있는 것이 섞여 있다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.resolve(__dirname, '..', 'server', 'data', 'browser-profiles', 'shopgrab');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}

const OUT = path.resolve(arg('--out', path.resolve(__dirname, '..', 'tmp', 'product-video')));
const HEADED = process.argv.includes('--headed');
const WAIT = Number(arg('--wait', '18000'));
const urls = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));

// 광고·추천 위젯이 끼워 넣는 영상까지 긁으면 엉뚱한 것을 받는다. 상품 영상이 놓이는 곳만 남긴다.
const MEDIA = /\.(mp4|m3u8)(\?|$)/i;
const NOISE = /(sprite|icon|logo|placeholder|blank)/i;

function pick(found) {
  // 같은 영상이 화질별로 여러 번 나온다 — 바이트가 가장 큰 것을 고른다.
  const byId = new Map();
  for (const f of found) {
    const id = (f.url.match(/\/(\d{6,})\.mp4/) || [, f.url])[1];
    const prev = byId.get(id);
    if (!prev || (f.bytes || 0) > (prev.bytes || 0)) byId.set(id, f);
  }
  return [...byId.values()].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
}

(async () => {
  if (!urls.length) {
    console.error('상품 URL 을 하나 이상 주세요.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    executablePath: CHROME,
    headless: !HEADED,
    viewport: { width: 1400, height: 1000 },
    locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  const report = [];
  for (const url of urls) {
    const found = [];
    const onResp = (res) => {
      const u = res.url();
      if (MEDIA.test(u) && !NOISE.test(u)) {
        const len = Number(res.headers()['content-length'] || 0);
        found.push({ url: u, bytes: len, status: res.status() });
      }
    };
    page.on('response', onResp);
    console.log('\n== ' + url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log('  열기 실패: ' + e.message.split('\n')[0]);
      page.off('response', onResp);
      continue;
    }
    await page.waitForTimeout(4000);

    // ③ 재생을 유도한다 — 알리는 갤러리 **첫 섬네일에 마우스를 올려야** 영상을 불러온다.
    //    누르기만 해서는 요청이 안 나가는 페이지가 많아 hover 를 먼저 한다.
    const thumbs = page.locator('[class*="slider--img"], [class*="thumb"] img, [class*="gallery"] img');
    const tn = Math.min(await thumbs.count().catch(() => 0), 8);
    for (let i = 0; i < tn; i += 1) {
      await thumbs.nth(i).hover({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(1200);
      if (found.length) break;
    }
    if (!found.length) {
      for (const sel of ['video', '[class*="video"]', '[class*="Video"]', '[data-pl*="video"]']) {
        const el = page.locator(sel).first();
        if (await el.count().catch(() => 0)) {
          await el.hover({ timeout: 2500 }).catch(() => {});
          await el.click({ timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(2500);
          if (found.length) break;
        }
      }
    }
    await page.waitForTimeout(WAIT);

    // 진단 — 0건일 때 «영상이 없는 상품» 인지 «내가 못 찾은» 것인지 가른다.
    const diag = await page.evaluate(() => {
      const h = document.documentElement.innerHTML;
      return { html: h.length, videoId: (h.match(/videoId/g) || []).length,
               mp4: (h.match(/\.mp4/g) || []).length,
               videoEls: document.querySelectorAll('video').length };
    }).catch(() => null);
    if (diag) {
      console.log('  진단 html %dKB · videoId %d · .mp4 %d · <video> %d · 섬네일 %d'
        .replace('%dKB', Math.round(diag.html / 1024) + 'KB')
        .replace('%d', diag.videoId).replace('%d', diag.mp4)
        .replace('%d', diag.videoEls).replace('%d', tn));
    }

    // ② 페이지 안에서 videoId 를 직접 읽는다 (네트워크로 안 잡혔을 때의 보루)
    const ids = await page.evaluate(() => {
      const out = [];
      const html = document.documentElement.innerHTML;
      const re = /"videoId"\s*:\s*"?(\d{6,})/g;
      let m;
      while ((m = re.exec(html))) out.push(m[1]);
      const u = /"videoUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/g;
      const urls2 = [];
      while ((m = u.exec(html))) urls2.push(m[1].replace(/\\u002F/g, '/'));
      return { ids: [...new Set(out)].slice(0, 5), urls: [...new Set(urls2)].slice(0, 5) };
    }).catch(() => ({ ids: [], urls: [] }));

    // 제품 원문 — 볼케이노 쇼핑 단계의 payload.transcript 에 넣으면 대본이 좋아진다.
    // ★판매글의 «최고·1위·정품» 같은 광고 문구는 사실이 아니다. 스펙 항목만 가져온다.
    const spec = await page.evaluate(() => {
      const t = (document.querySelector('h1') || {}).textContent || document.title;
      const rows = [];
      document.querySelectorAll('li,tr,div').forEach((el) => {
        const s = (el.innerText || '').trim().replace(/\s+/g, ' ');
        if (s.length > 3 && s.length < 90 && /[:：]/.test(s) && el.children.length <= 3) rows.push(s);
      });
      return { title: (t || '').trim().slice(0, 200), rows: [...new Set(rows)].slice(0, 40) };
    }).catch(() => null);
    if (spec) console.log('  제품 원문: 제목 "' + spec.title.slice(0, 60) + '" · 스펙 줄 ' + spec.rows.length);

    page.off('response', onResp);

    for (const u of ids.urls) found.push({ url: u.startsWith('//') ? 'https:' + u : u, bytes: 0, status: 0 });
    const best = pick(found);
    console.log('  네트워크에서 잡은 미디어 ' + found.length + '건 · 서로 다른 영상 ' + best.length + '개');
    if (ids.ids.length) console.log('  페이지 안 videoId: ' + ids.ids.join(', '));
    best.slice(0, 6).forEach((f, i) => {
      console.log('   [' + (i + 1) + '] ' + (f.bytes ? (f.bytes / 1e6).toFixed(1) + 'MB ' : '') + f.url.slice(0, 150));
    });
    report.push({ page: url, videos: best, videoIds: ids.ids, spec });
  }

  const rp = path.join(OUT, '_grab.json');
  fs.writeFileSync(rp, JSON.stringify(report, null, 1), 'utf8');
  console.log('\n기록: ' + rp);
  console.log('내려받기: yt-dlp 또는 curl -L -o <파일> "<위 URL>"');
  console.log('★받은 뒤 반드시: python D:/volcano-runs/_preset_trials/소스_화면검사2.py <파일>');
  await ctx.close();
})().catch((e) => { console.error('[grab]', e.message); process.exit(1); });
