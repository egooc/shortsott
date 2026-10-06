// ko 페이스북 «개인 프로필» 에 올린 편이 막혔는지 센다. 유튜브의 check-claims 에 해당한다.
//
//   node scripts/fb-block-check.js                 콘텐츠 라이브러리를 훑어 보여주고 기록한다
//   node scripts/fb-block-check.js --feed          프로필 피드 쪽도 같이 본다(차단 문구 확인용)
//   node scripts/fb-block-check.js --scrolls 24    더 깊이 훑는다(기본 16)
//   node scripts/fb-block-check.js --json          기계용 출력
//
// 왜 (2026-10-06 소유주: "명화관 스타일 재개하는데 유튜브는 안올릴게" → "진행해줘")
//   유튜브를 뺀 자리를 페이스북·인스타가 받는다. 그런데 **페이스북도 막는다.**
//   유튜브 차단율을 한 달 동안 42% 로 잘못 알고 있다가 68% 였던 일(사례 154)이 있었다.
//   옮겨 간 자리의 차단율을 모르는 채로 가는 것이 가장 위험하다.
//
// 어디를 읽나 — **프로페셔널 대시보드 › 콘텐츠 라이브러리**가 정답이다.
//   처음엔 프로필 피드를 긁었는데(«차단되어 볼 수 없습니다» 문구) 그쪽이 덜 잡는다.
//   실측 2026-10-06: 피드에서 «통과»로 보인 벤자민 버튼 편이 라이브러리에서는
//   **수익화 일시 중단됨** 이었다. 라이브러리는 조회·시청자·수익까지 한 줄에 준다.
//   ★행은 `tr[role=row]` 다. `div[role=row]` 는 0개다(2026-10-06 실측).
//   ★ko 는 Blotato 가 아니라 플레이라이트로 개인 프로필에 올려서 분석 API 에 안 잡힌다.
//     `fb-profile-export.js` 가 같은 화면의 CSV 를 받으려 했지만 받는 탭이 바로 닫혀
//     불안정하다. 화면을 직접 읽는 이 경로가 더 안전하다.
//
// 읽기만 한다. 아무것도 지우거나 내리지 않는다 — 유튜브 쪽 unschedule() 이 차단 판정마다
// privacyStatus='private' 을 박아 영상 72편을 영구 비공개로 만든 전례가 있다
// (docs/HALT-myeonghwagwan.md). 같은 실수를 플랫폼만 바꿔 되풀이하지 않는다.
//
// ★갓 올린 편은 판정하지 마라. 페이스북도 매칭에 시간이 걸린다. FRESH_HOURS 미만은
//   «아직 어림»으로 따로 센다. 다만 15분 만에 걸린 편도 있었으니 어린 편의 «통과»는
//   통과가 아니라 **미판정**이다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'server', 'data', 'browser-profiles', 'facebook_profile');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STATE = path.join(ROOT, 'server', 'data', 'fb_block_state.json');
const REPORTS = path.join(ROOT, 'server', 'output', 'fb-block-reports');
const LIBRARY = 'https://www.facebook.com/professional_dashboard/content/content_library';

const FRESH_HOURS = 6;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCROLLS = Number(arg('--scrolls', 16));
const AS_JSON = process.argv.includes('--json');
const WITH_FEED = process.argv.includes('--feed');

// 라이브러리가 붙이는 딱지. 문구가 바뀌면 여기만 고친다.
const BADGES = [
  ['수익화중단', /수익화 일시 중단됨|수익화가 일시 중단/],
  ['배포제한', /배포 제한|제한된 배포/],
  ['삭제됨', /삭제됨|removed/i],
];
// 프로필 피드 쪽 문구(--feed 일 때만).
const FEED_MARKS = [
  ['소유권매칭', /콘텐츠 소유자가 회원님의 동영상에 소유권 링크를 추가했습니다/],
  ['전면차단', /동영상이 차단되어 다른 사람이 볼 수 없습니다/],
  ['국가차단', /동영상이 차단되어 국가 (\d+)개에서 볼 수 없습니다/],
];

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// 라이브러리 시각: "오늘 오후 2:04" · "어제 오전 9:12" · "10월 4일" → 대략의 나이(시간)
function ageFrom(text) {
  const now = new Date();
  let m = text.match(/오늘 (오전|오후) (\d+):(\d+)/);
  if (m) {
    let h = Number(m[2]) % 12 + (m[1] === '오후' ? 12 : 0);
    const t = new Date(now); t.setHours(h, Number(m[3]), 0, 0);
    return Math.max(0, (now - t) / 3600000);
  }
  if (/어제/.test(text)) return 24;
  m = text.match(/(\d+)월 (\d+)일/);
  if (m) {
    const t = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    return Math.max(0, (now - t) / 3600000);
  }
  return null;
}

async function readLibrary(page) {
  await page.goto(LIBRARY, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  // 가상 스크롤이라 한 번에 다 안 들어온다. 돌면서 모으고 사라진 것은 기억해 둔다.
  const bucket = new Map();
  for (let i = 0; i < SCROLLS; i++) {
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr[role="row"]')]
      .map((tr) => {
        const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim());
        // ★첫 칸은 체크박스라 비어 있다. 제목·딱지가 든 칸은 «가장 긴 칸»이다.
        //   cells[0] 을 제목으로 보면 전부 걸러져 0건이 된다(2026-10-06 실측).
        let hi = 0;
        for (let i = 1; i < cells.length; i++) if (cells[i].length > cells[hi].length) hi = i;
        return { head: cells[hi] || '', nums: cells.slice(hi + 1, hi + 7) };
      })
      .filter((r) => r.head.length > 4));
    for (const r of rows) {
      const title = r.head.split('\n')[0].trim();
      if (!title || title === '미리 보기') continue;
      if (!bucket.has(title) || r.head.length > bucket.get(title).head.length) bucket.set(title, r);
    }
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1200);
  }
  const out = [];
  for (const [title, r] of bucket) {
    let kind = '';
    for (const [name, re] of BADGES) if (re.test(r.head)) { kind = name; break; }
    const hours = ageFrom(r.head);
    const views = Number((r.nums[0] || '').replace(/[^\d]/g, '')) || 0;
    out.push({ where: 'library', title, blocked: !!kind, kind, views,
               ageHours: hours, fresh: hours !== null && hours < FRESH_HOURS });
  }
  return out;
}

async function readFeed(page) {
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const bucket = new Map();
  for (let i = 0; i < SCROLLS; i++) {
    const rows = await page.evaluate(() => [...document.querySelectorAll('div[aria-posinset]')]
      .map((a) => (a.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 30));
    for (const t of rows) {
      const cap = (t.split(/공유 대상: [^ ]+ /)[1] || t).replace(/… 더 보기.*$/s, '').trim().slice(0, 60);
      if (!cap) continue;
      if (!bucket.has(cap) || t.length > bucket.get(cap).length) bucket.set(cap, t);
    }
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1100);
  }
  const out = [];
  for (const [cap, text] of bucket) {
    let kind = '';
    for (const [name, re] of FEED_MARKS) if (re.test(text)) { kind = name; break; }
    out.push({ where: 'feed', title: cap, blocked: !!kind, kind });
  }
  return out;
}

(async () => {
  fs.mkdirSync(REPORTS, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', executablePath: CHROME, headless: true,
    viewport: { width: 1600, height: 1100 }, locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const lib = await readLibrary(page);
  const feed = WITH_FEED ? await readFeed(page) : [];
  await ctx.close();

  // «사진 스토리» 는 페이스북이 자동으로 만드는 것이라 우리 편이 아니다.
  const posts = lib.filter((p) => p.title !== '사진 스토리').sort(
    (a, b) => (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9));
  const judged = posts.filter((p) => !p.fresh);
  const blocked = judged.filter((p) => p.blocked);
  const freshBlocked = posts.filter((p) => p.fresh && p.blocked);

  const now = new Date().toISOString();
  const state = readJson(STATE, { checks: [] });
  state.checks.push({ at: now, total: posts.length, judged: judged.length,
                      blocked: blocked.length, freshBlocked: freshBlocked.length, posts, feed });
  state.checks = state.checks.slice(-60);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');

  if (AS_JSON) { console.log(JSON.stringify({ posts, feed }, null, 2)); return; }

  const pct = judged.length ? Math.round((100 * blocked.length) / judged.length) : 0;
  const L = [];
  L.push(`# 페이스북 차단 확인 ${now}`);
  L.push('');
  L.push(`- 콘텐츠 라이브러리 **${posts.length}건** (자동 생성 «사진 스토리» 제외)`);
  L.push(`- 판정 대상 ${judged.length}건(${FRESH_HOURS}시간 넘은 것) 중 **막힘 ${blocked.length}건 · ${pct}%**`);
  L.push(`- 아직 어린 것 ${posts.length - judged.length}건 (그중 벌써 막힌 것 ${freshBlocked.length}건)`);
  L.push('');
  for (const p of posts) {
    const age = p.ageHours === null ? '?' : p.ageHours < 1 ? `${Math.round(p.ageHours * 60)}분`
      : p.ageHours < 24 ? `${Math.round(p.ageHours)}시간` : `${Math.round(p.ageHours / 24)}일`;
    L.push(`- ${p.blocked ? `☠${p.kind}` : '  통과  '} · ${age.padStart(5)} · 조회 ${String(p.views).padStart(5)} · ${p.title.slice(0, 54)}`);
  }
  if (feed.length) {
    L.push('');
    L.push(`## 프로필 피드 쪽 (문구 확인용) — 막힘 ${feed.filter((f) => f.blocked).length}/${feed.length}`);
    for (const f of feed.filter((x) => x.blocked)) L.push(`- ☠${f.kind} · ${f.title.slice(0, 54)}`);
  }
  const body = L.join('\n') + '\n';
  fs.appendFileSync(path.join(REPORTS, `${now.slice(0, 10).replace(/-/g, '')}-fb-block.md`), body + '\n', 'utf8');
  console.log(body);
})();
