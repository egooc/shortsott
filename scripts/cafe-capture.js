// 네이버 카페 글 한 편을 읽고 구간별로 캡처한다.
//
//   node scripts/cafe-capture.js <글URL> [--out <폴더이름>] [--headed]
//
// 네이버 카페 본문은 iframe(`cafe_main`) 안에 있다. 새 주소(/f-e/cafes/..)로 리다이렉트되면
// iframe 이 없고 본문이 바로 문서에 있다 — 둘 다 받는다.
// 로그인이 필요한 글이면 --headed 로 띄워 사람이 한 번 로그인한다. 프로필이 남아 다음엔 자동이다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(ROOT, 'server', 'data', 'browser-profiles', 'naver');
const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http'));
const HEADED = args.includes('--headed');
const oi = args.indexOf('--out');
const OUTNAME = oi > 0 ? args[oi + 1] : 'cafe-post';
const OUT = path.join(ROOT, 'server', 'output', 'cafe-report', OUTNAME);

if (!url) { console.error('글 URL 을 주세요.'); process.exit(2); }

(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', executablePath: CHROME, headless: !HEADED,
    viewport: { width: 1200, height: 1000 }, locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('열린 주소:', page.url());

  // 본문이 있는 프레임을 찾는다
  let frame = page.mainFrame();
  for (const f of page.frames()) {
    const has = await f.evaluate(() => !!document.querySelector(
      '.se-main-container, #postViewArea, .ArticleContentBox, .article_viewer, .content')).catch(() => false);
    if (has) { frame = f; break; }
  }
  console.log('본문 프레임:', frame.url().slice(0, 90) || '(메인)');

  const data = await frame.evaluate(() => {
    const pick = (...sels) => { for (const s of sels) { const e = document.querySelector(s); if (e) return e; } return null; };
    const body = pick('.se-main-container', '#postViewArea', '.ArticleContentBox .article_viewer',
                      '.article_viewer', '.ContentRenderer', '.content');
    const titleEl = pick('.title_text', '.tit-box .b', 'h3.title_text', '.ArticleTitle .title_text', 'h1', 'h2');
    const imgs = body ? [...body.querySelectorAll('img')]
      .map(i => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt || '' }))
      .filter(i => i.src && !/^data:/.test(i.src) && (i.w >= 80 || i.w === 0)) : [];
    return {
      title: titleEl ? titleEl.innerText.trim() : document.title,
      author: (pick('.nick_btn', '.nickname', '.p-nick', '.ArticleWriterProfile .nickname') || {}).innerText || '',
      date: (pick('.date', '.article_info .date', '.ArticleWriterProfile .date') || {}).innerText || '',
      html: body ? body.innerHTML : '',
      text: body ? body.innerText : document.body.innerText,
      imgs,
      loginWall: /로그인|네이버로 로그인|권한이 없|가입/.test(document.body.innerText) && !body,
    };
  });

  console.log('제목:', data.title);
  console.log('글자수:', (data.text || '').length, '· 이미지', data.imgs.length, '장');
  if (data.loginWall) console.log('★로그인/권한 벽으로 보인다 — --headed 로 한 번 로그인하라');

  // 구간별 캡처: 본문 요소 기준으로 화면 높이만큼 잘라 찍는다
  const target = await frame.$('.se-main-container, #postViewArea, .article_viewer, .ContentRenderer, .content');
  const shots = [];
  if (target) {
    const box = await target.boundingBox();
    if (box) {
      const step = 900;
      const n = Math.max(1, Math.ceil(box.height / step));
      for (let i = 0; i < n; i++) {
        const y = box.y + i * step;
        await page.evaluate((yy) => window.scrollTo(0, Math.max(0, yy - 60)), y);
        await page.waitForTimeout(700);
        const f = `shots/part-${String(i + 1).padStart(2, '0')}.png`;
        await page.screenshot({ path: path.join(OUT, f),
          clip: { x: Math.max(0, box.x - 8), y: 60, width: Math.min(1180, box.width + 16), height: Math.min(step, 900) } })
          .catch(async () => { await page.screenshot({ path: path.join(OUT, f) }); });
        shots.push(f);
        console.log('  캡처', f);
      }
    }
  }
  if (!shots.length) {
    await page.screenshot({ path: path.join(OUT, 'shots/part-01.png'), fullPage: true });
    shots.push('shots/part-01.png');
  }

  // 본문 이미지를 내려받는다
  const saved = [];
  for (let i = 0; i < data.imgs.length; i++) {
    const im = data.imgs[i];
    try {
      const r = await ctx.request.get(im.src, { headers: { referer: page.url() } });
      if (!r.ok()) throw new Error(String(r.status()));
      const ext = (im.src.match(/\.(jpe?g|png|gif|webp)/i) || [,'jpg'])[1].toLowerCase();
      const f = `images/img-${String(i + 1).padStart(2, '0')}.${ext}`;
      fs.writeFileSync(path.join(OUT, f), await r.body());
      saved.push({ file: f, ...im });
    } catch (e) { console.log('  이미지 실패', i + 1, String(e.message).slice(0, 40)); }
  }
  console.log('내려받은 이미지', saved.length, '장');

  fs.writeFileSync(path.join(OUT, 'post.json'),
    JSON.stringify({ url, finalUrl: page.url(), ...data, imgs: saved, shots }, null, 2));
  fs.writeFileSync(path.join(OUT, 'post.txt'), data.text || '');
  console.log('저장:', OUT);
  await ctx.close();
})();
