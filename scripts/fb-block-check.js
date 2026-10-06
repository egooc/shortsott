// 페이스북 개인 프로필에 올린 편이 «차단됐는지» 센다. 유튜브의 check-claims 에 해당한다.
//
//   node scripts/fb-block-check.js                 훑어서 보여주고 기록한다
//   node scripts/fb-block-check.js --scrolls 24    더 깊이 훑는다(기본 16)
//   node scripts/fb-block-check.js --json          기계용 출력
//
// 왜 (2026-10-06 소유주: "명화관 스타일 재개하는데 유튜브는 안올릴게" → "진행해줘")
//   유튜브를 뺀 자리를 페이스북·인스타가 받는다. 그런데 **페이스북도 막는다.**
//   프로필을 열어 보니 올린 편에 이런 딱지가 붙어 있었다:
//   ```
//   콘텐츠 소유자가 회원님의 동영상에 소유권 링크를 추가했습니다.   ← 소유권 매칭
//   회원님의 동영상이 차단되어 다른 사람이 볼 수 없습니다.          ← 전면 차단
//   회원님의 동영상이 차단되어 국가 252개에서 볼 수 없습니다.       ← 사실상 전면
//   ```
//   유튜브 차단율을 한 달 동안 42% 로 잘못 알고 있다가 68% 였던 일(사례 154)이 있었다.
//   **그 자리를 모르는 채로 옮기는 것이 가장 위험하다.** 그래서 먼저 세는 도구를 만든다.
//
// 읽기만 한다. 아무것도 지우거나 내리지 않는다 — 유튜브 쪽 unschedule() 이 영상 72편을
// 영구 비공개로 만든 전례가 있어서, 이 도구는 **세기만** 한다(docs/HALT-myeonghwagwan.md).
//
// ★갓 올린 편은 판정하지 마라. 페이스북도 유튜브처럼 매칭에 시간이 걸린다.
//   `FRESH_HOURS` 보다 어린 편은 «아직 이름»으로 따로 센다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'server', 'data', 'browser-profiles', 'facebook_profile');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STATE = path.join(ROOT, 'server', 'data', 'fb_block_state.json');
const REPORTS = path.join(ROOT, 'server', 'output', 'fb-block-reports');

const FRESH_HOURS = 6;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCROLLS = Number(arg('--scrolls', 16));
const AS_JSON = process.argv.includes('--json');

// 차단 딱지 — 문구가 셋이라 종류까지 구분해 적는다.
const MARKS = [
  ['소유권매칭', /콘텐츠 소유자가 회원님의 동영상에 소유권 링크를 추가했습니다/],
  ['전면차단', /동영상이 차단되어 다른 사람이 볼 수 없습니다/],
  ['국가차단', /동영상이 차단되어 국가 (\d+)개에서 볼 수 없습니다/],
];

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// "11분 전" · "약 1시간 전" · "5시간 전" · "1일 전" → 시간
function ageHours(text) {
  let m = text.match(/(\d+)\s*분\s*전/); if (m) return Number(m[1]) / 60;
  m = text.match(/(\d+)\s*시간\s*전/); if (m) return Number(m[1]);
  m = text.match(/(\d+)\s*일\s*전/); if (m) return Number(m[1]) * 24;
  m = text.match(/(\d+)\s*주\s*전/); if (m) return Number(m[1]) * 168;
  return null;
}

// 본문 첫 문장 — 같은 글이 DOM 에 두 번 그려지므로 이걸로 합친다.
function captionOf(text) {
  const after = text.split(/공유 대상: [^ ]+ /)[1] || text;
  return after.replace(/… 더 보기.*$/s, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

(async () => {
  fs.mkdirSync(REPORTS, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', executablePath: CHROME, headless: true,
    viewport: { width: 1280, height: 1100 }, locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // 피드는 가상 스크롤이라 한 번에 다 안 들어온다. 돌면서 모으고 사라진 것은 기억해 둔다.
  const bucket = new Map();
  for (let i = 0; i < SCROLLS; i++) {
    const rows = await page.evaluate(() => [...document.querySelectorAll('div[aria-posinset]')]
      .map((a) => (a.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 30));
    for (const t of rows) {
      const cap = (t.split(/공유 대상: [^ ]+ /)[1] || t).replace(/… 더 보기.*$/s, '')
        .replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!cap) continue;
      const prev = bucket.get(cap);
      // 같은 글의 두 벌 중 «딱지가 붙은 쪽»을 남긴다 — 겉 article 에만 붙는 경우가 있다.
      if (!prev || t.length > prev.length) bucket.set(cap, t);
    }
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1100);
  }
  await ctx.close();

  const posts = [];
  for (const [cap, text] of bucket) {
    let kind = '';
    let countries = 0;
    for (const [name, re] of MARKS) {
      const m = text.match(re);
      if (m) { kind = name; if (m[1]) countries = Number(m[1]); break; }
    }
    const hours = ageHours(text);
    posts.push({ caption: cap, blocked: !!kind, kind, countries, ageHours: hours,
                 fresh: hours !== null && hours < FRESH_HOURS });
  }
  posts.sort((a, b) => (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9));

  const judged = posts.filter((p) => !p.fresh);
  const blocked = judged.filter((p) => p.blocked);
  const freshBlocked = posts.filter((p) => p.fresh && p.blocked);

  const now = new Date().toISOString();
  const state = readJson(STATE, { checks: [] });
  state.checks.push({ at: now, total: posts.length, judged: judged.length,
                      blocked: blocked.length, freshBlocked: freshBlocked.length, posts });
  state.checks = state.checks.slice(-60);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');

  if (AS_JSON) { console.log(JSON.stringify(posts, null, 2)); return; }

  const pct = judged.length ? Math.round((100 * blocked.length) / judged.length) : 0;
  const lines = [];
  lines.push(`# 페이스북 차단 확인 ${now}`);
  lines.push('');
  lines.push(`- 훑은 게시물 **${posts.length}건**`);
  lines.push(`- 판정 대상 ${judged.length}건(${FRESH_HOURS}시간 넘은 것) 중 **차단 ${blocked.length}건 · ${pct}%**`);
  lines.push(`- 아직 어린 것 ${posts.length - judged.length}건 (그중 벌써 막힌 것 ${freshBlocked.length}건)`);
  lines.push('');
  for (const p of posts) {
    const age = p.ageHours === null ? '?' : p.ageHours < 1 ? `${Math.round(p.ageHours * 60)}분`
      : p.ageHours < 24 ? `${Math.round(p.ageHours)}시간` : `${Math.round(p.ageHours / 24)}일`;
    const tag = p.blocked ? `☠${p.kind}${p.countries ? `(${p.countries}개국)` : ''}` : '  통과';
    lines.push(`- ${tag} · ${age} · ${p.caption}`);
  }
  const body = lines.join('\n') + '\n';
  const f = path.join(REPORTS, `${now.slice(0, 10).replace(/-/g, '')}-fb-block.md`);
  fs.appendFileSync(f, body + '\n', 'utf8');
  console.log(body);
  console.log(`기록: ${f}`);
})();
