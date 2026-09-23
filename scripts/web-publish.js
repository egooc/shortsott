// 브라우저로 직접 올리는 발행 경로 — API/서드파티가 막힌 두 곳 전용.
//
//   node scripts/web-publish.js --site naverclip|facebook --login        1회 로그인(사람이 직접, 세션은 프로필에 남는다)
//   node scripts/web-publish.js --site <site> --explore                  현재 화면 구조 덤프(선택자 고칠 때)
//   node scripts/web-publish.js --site <site> [--prefix 20260919] [--only <draft>] [--limit N] [--dry-run] [--headless]
//                                [--target "게시할 위치 이름"] [--stop-before-publish] [--now]
//   기본은 유튜브 publishAt 과 같은 시각 예약. --now 는 즉시, --due 는 '지금이 그 시각인 것만' 발행(슬롯 작업용).
//
// 왜 브라우저인가 (둘 다 API 경로가 존재하지 않는다, 도구를 바꿔도 같다):
//   - ko Facebook: 수익화가 개인 프로필에 걸려 있고 Meta 는 페이지에만 서드파티 발행을 허용한다
//     (publish_actions 2018 폐지, 개인 타임라인 예약 2024초 종료). 비즈니스 스위트 화면이 유일한 창구다.
//   - ko 네이버 클립: 공개 API 가 없다. 2026 에 PC 웹 업로드(clipcreators.naver.com)가 생겨 자동화가 가능해졌다.
//
// 설계 원칙
//   1) 선택자는 midform/config/web_publish_selectors.json 에 있다. UI 가 바뀌면 코드가 아니라 JSON 을 고친다.
//   2) 로그인은 사람이 1회, 세션은 server/data/browser-profiles/<site> 에 남아 이후 무인 실행된다.
//      비밀번호는 이 저장소 어디에도 두지 않는다.
//   3) 설치된 Chrome 을 그대로 쓴다(channel: chrome). 네이버·메타는 순정 크로미움을 자동화로 의심한다.
//   4) 같은 드래프트를 두 번 올리지 않는다(state 의 draft:site 키). 실패하면 스크린샷과 HTML 을 남긴다 —
//      화면을 못 보는 원격 상황에서 무엇이 달라졌는지 읽을 수 있어야 한다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const SELECTORS = path.join(ROOT, 'midform', 'config', 'web_publish_selectors.json');
const SPECS = path.join(ROOT, 'midform', 'config', 'platform_post_specs.json');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'web_publish_state.json');
// 발행 시각의 진실 소스: auto-publish 가 유튜브에 건 publishAt. blotato 도 같은 값을 물려 쓴다 —
// 브라우저 발행만 즉시 나가면 같은 영상이 플랫폼마다 반나절씩 어긋난다(2026-09-18 실제로 그렇게 나갔다).
const YT_STATE_PATH = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const PROFILE_DIR = path.join(ROOT, 'server', 'data', 'browser-profiles');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'web-publish-reports');
const SHOTS_DIR = path.join(REPORTS_DIR, 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
function has(name) { return process.argv.includes(name); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }

// social_posts.<loc>.txt 파서 — blotato-publish.js 와 같은 규칙(빈 칸이면 템플릿 문구를 캡션으로 내보내지 않는다).
function parseSection(text, labels) {
  for (const label of labels) {
    const head = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = new RegExp(`\\[${head}[^\\]]*\\][^\\n]*\\n=+\\n([\\s\\S]*?)(?:\\n=+\\n|$)`, 'i').exec(String(text || ''));
    if (!section) continue;
    const body = section[1];
    const grab = (field) => {
      const m = new RegExp(`\\(${field}[^)]*\\)[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*\\(|$)`).exec(body);
      const value = m ? m[1].trim() : '';
      return value.startsWith('(') ? '' : value;
    };
    const caption = grab('캡션') || grab('본문');
    const title = grab('제목');
    const hashtags = [...String(grab('해시태그')).matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
    return { caption, title, hashtags };
  }
  return null;
}

function listDrafts({ prefix, only, locale }) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR)
    .filter((n) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(n))
    .filter((n) => (locale ? n.endsWith(`-${locale}`) : true))
    .filter((n) => (prefix ? n.startsWith(prefix) : true))
    .filter((n) => (only ? n === only : true))
    .sort();
}

function buildJob(draft) {
  const locale = draft.endsWith('-ja') ? 'ja' : 'ko';
  const dir = path.join(DRAFTS_DIR, draft);
  // 유튜브 업로드가 끝난 판은 _automation factory/uploaded 로 옮겨진다 — 두 곳 다 본다.
  const mp4 = [path.join(EXPORT_DIR, `${draft}.mp4`), path.join(EXPORT_DIR, 'uploaded', `${draft}.mp4`)]
    .find((f) => fs.existsSync(f));
  if (!mp4) return { draft, locale, error: `mp4 없음: ${draft}.mp4 (factory·uploaded 모두)` };
  const socialPath = path.join(dir, `social_posts.${locale}.txt`);
  const text = fs.existsSync(socialPath) ? fs.readFileSync(socialPath, 'utf8') : '';
  const manifest = readJson(path.join(dir, 'edit_manifest.json'), {});
  return {
    draft, locale, mp4,
    titleLines: manifest.title_lines || [],
    durationSec: manifest.actual_timeline_duration_sec || 0,
    yt: parseSection(text, ['YouTube Shorts', 'YouTube']),
    fb: parseSection(text, ['Facebook Reels', 'Facebook']),
    ig: parseSection(text, ['Instagram Reels', 'Instagram']),
    nv: parseSection(text, ['네이버 클립', 'naver_clip']),   // 2026-09-18 생성기 수정으로 ko 패키지에 생긴 섹션
    // 정보태그 검색어: 패키지의 (정보태그) 줄을 그대로 쓴다 — 카탈로그 표기와 네이버 작품명이 같아야 붙는다.
    movieTitle: (new RegExp('\\(정보태그[^)]*\\)[^\\n]*\\n([^\\n]+)').exec(text) || [])[1]?.trim() || '',
    // ★유튜브 차단본도 여기서는 살린다 (소유주 지시 2026-09-23). check-claims 가 publishAt 을
    //   지우면서 blockedPublishAt 에 옮겨 두므로 그걸 물려 쓴다. 차단 여부는 따로 들고 간다 —
    //   아래 --due 판정에서 «이미 지난 시각»을 지금 발행으로 바꿔야 하기 때문이다.
    publishAt: ytSlot(draft).at,
    ytBlocked: ytSlot(draft).blocked
  };
}

// 유튜브가 잡아 둔 발행 시각. 차단돼 publishAt 이 지워졌으면 blockedPublishAt 을 쓰고
// «차단된 편»이라고 표시해 돌려준다 — 그 시각은 이미 지났을 수 있어 호출자가 달리 다뤄야 한다.
function ytSlot(draft) {
  const hist = readJson(YT_STATE_PATH, { history: [] }).history || [];
  const live = hist.find((h) => h.draft === draft && h.publishAt);
  if (live) return { at: live.publishAt, blocked: false };
  const blocked = hist.find((h) => h.draft === draft && h.blockedPublishAt);
  return blocked ? { at: blocked.blockedPublishAt, blocked: true } : { at: '', blocked: false };
}

// 후보 선택자를 위에서부터 시도한다. text=/css=/role=역할:이름 세 가지만 쓴다.
function locator(page, spec) {
  const s = String(spec);
  if (s.startsWith('css=')) return page.locator(s.slice(4));
  if (s.startsWith('text=')) return page.getByText(s.slice(5), { exact: false }).first();
  if (s.startsWith('role=')) {
    // 이름 끝에 ! 를 붙이면 정확히 일치만 인정한다. 실측 2026-09-18: '게시'로 느슨하게 찾았더니
    // 설정 목록의 '그룹에 공유 … 게시물을 공유하여'가 먼저 걸려 엉뚱한 창이 열렸다(게시는 안 됐다).
    let [role, name] = s.slice(5).split(':');
    const exact = Boolean(name && name.endsWith('!'));
    if (exact) name = name.slice(0, -1);
    return page.getByRole(role, name ? { name, exact } : undefined).first();
  }
  return page.locator(s);
}

async function firstVisible(page, candidates, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const c of candidates || []) {
      const el = locator(page, c);
      try { if (await el.isVisible({ timeout: 400 })) return { el, used: c }; } catch { /* 다음 후보 */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function need(page, candidates, what) {
  const found = await firstVisible(page, candidates);
  if (!found) throw new Error(`화면에서 «${what}» 를 못 찾았다 (후보: ${(candidates || []).join(' | ')}) — 선택자 갱신 필요`);
  return found.el;
}

async function dumpFailure(page, tag) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const base = path.join(SHOTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`);
  try { await page.screenshot({ path: `${base}.png`, fullPage: false }); } catch { /* 화면 캡처 실패는 삼킨다 */ }
  try {
    // 눈에 보이는 버튼·입력칸 이름만 추린다 — 전체 HTML 은 읽기에 너무 크다.
    const landmarks = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button,[role=button],input,textarea,[contenteditable=true],a')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        out.push([el.tagName.toLowerCase(), el.getAttribute('role') || '', el.getAttribute('aria-label') || '',
          el.getAttribute('placeholder') || '', (el.innerText || '').trim().slice(0, 40), el.getAttribute('type') || ''].join(' | '));
      }
      return out.slice(0, 200);
    });
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${landmarks.join('\n')}`, 'utf8');
  } catch { /* 덤프 실패는 삼킨다 */ }
  return base;
}

// 파일 입력칸은 대개 화면에 숨겨져 있다(버튼은 껍데기다). 그래서 '보이는가'를 묻지 않고 DOM 에 붙어 있으면 쓴다.
// 실측 2026-09-18: '동영상 추가'를 클릭하면 상위 오버레이가 클릭을 가로채 실패했다 — 클릭 없이 입력칸에 바로 파일을 넣는다.
// 파일 입력칸은 대개 숨겨져 있고(버튼은 껍데기다) 페이스북은 같은 입력칸을 여러 개 심어 둔다(실측 2026-09-18: 2개 이상).
// 그래서 '보이는가'를 묻지 않고, 뒤에 붙은 것부터(다이얼로그가 나중에 마운트된다) 하나씩 넣어 보고 미리보기가 생기면 그것이 진짜다.
async function attachFile(page, candidates, opener, filePath) {
  const tryAll = async () => {
    for (const c of candidates || []) {
      const all = locator(page, c);
      const n = await all.count().catch(() => 0);
      for (let i = n - 1; i >= 0; i -= 1) {
        try {
          await all.nth(i).setInputFiles(filePath, { timeout: 15000 });
          // 미리보기 <video> 나 진행 표시가 뜨면 제대로 물린 것이다.
          const ok = await page.waitForFunction(
            () => document.querySelector('video') || /처리 중|업로드 중|Processing/.test(document.body.innerText),
            null, { timeout: 20000 }).catch(() => null);
          if (ok) return true;
        } catch { /* 다음 입력칸 */ }
      }
    }
    return false;
  };
  if (await tryAll()) return true;
  // 입력칸이 아직 없으면 여는 버튼을 순서대로 누른다. 한 번에 안 열리는 곳이 있다 —
  // 네이버 클립은 '업로드'가 드롭다운을 열고 그 안의 '동영상 업로드'를 다시 눌러야 한다(실측 2026-09-18).
  for (const step of opener || []) {
    const btn = await firstVisible(page, [step], 6000);
    if (!btn) continue;
    await btn.el.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1800);
    for (const c of candidates || []) {
      if (await locator(page, c).count().catch(() => 0)) break;
    }
  }
  if (await tryAll()) return true;
  throw new Error('파일을 물릴 입력칸을 못 찾았다(미리보기가 생기지 않음) — 선택자 갱신 필요');
}

const nlChar = () => String.fromCharCode(10);

// publishAt(UTC ISO) → 한국시간 조각. 네이버 예약 드롭다운은 KST 로 고르게 돼 있다.
function kstParts(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { y: d.getUTCFullYear(), m: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()), hh: p(d.getUTCHours()), mm: p(d.getUTCMinutes()), ms: t };
}

// 페이스북 개인 프로필 작성기에는 예약이 없다(실측 2026-09-18: 저장/게시 두 버튼뿐).
// 그래서 그 시각에 이 스크립트를 한 번 실행하도록 윈도우 작업 스케줄러에 1회성 작업을 건다.
function scheduleWindowsTask(site, draft, k) {
  const { spawnSync } = require('child_process');
  const name = `midform-${site}-${draft}`;
  const cmd = `cmd /c cd /d "${ROOT}" && node scripts\web-publish.js --site ${site} --only ${draft} --now`;
  const r = spawnSync('schtasks', ['/create', '/f', '/tn', name, '/tr', cmd, '/sc', 'once',
    '/sd', `${k.y}/${k.m}/${k.d}`, '/st', `${k.hh}:${k.mm}`], { encoding: 'utf8' });   // 이 PC 의 schtasks 는 yyyy/mm/dd 를 요구한다(실측)
  if (r.status !== 0) throw new Error(`작업 등록 실패: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
  return name;
}

const drivers = {
  // 네이버 클립(실측 2026-09-18): /web/upload 로 바로 간다. 필수는 설명·커버·카테고리이고 커버는 자동 선택된다.
  // 설명칸은 300자 제한이라 제목+캡션+해시태그를 여기에 합쳐 넣는다(별도 태그 입력칸이 없다).
  async naverclip(page, job, sel, spec, opts) {
    if (job.durationSec && job.durationSec > 180) throw new Error(`네이버 클립 3분 제한 초과: ${job.durationSec}s`);
    await page.goto(sel.home, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await attachFile(page, sel.fileInput, sel.openUploader, job.mp4);

    // 네이버 전용 섹션(제목·캡션·태그 5~10)이 있으면 그것을 쓰고, 옛 패키지면 유튜브 섹션으로 물러선다.
    const body = job.nv || job.yt || job.ig || { caption: '', hashtags: [] };
    const title = body.title || (job.titleLines || []).join(' ');
    const tags = body.hashtags.slice(0, Number(spec?.hashtags?.max || 10)).map((t) => `#${t}`).join(' ');
    const LIMIT = 300;   // 화면 카운터 실측값. platform_post_specs 의 500 은 실제와 다르다.
    let desc = [title, body.caption].filter(Boolean).join(nlChar());
    if (tags) {
      const room = LIMIT - tags.length - 1;
      desc = `${desc.slice(0, Math.max(0, room))}${nlChar()}${tags}`;   // 해시태그는 검색 핵심이라 먼저 자리를 준다
    }
    desc = desc.slice(0, LIMIT);
    const field = await need(page, sel.titleField, '설명 입력칸');
    await field.click();
    await field.fill(desc).catch(async () => { await page.keyboard.type(desc, { delay: 6 }); });

    // 카테고리는 필수다. 비운 채 등록을 누르면 발행되지 않고 조용히 초안으로 저장되며 /web/draft/… 로 넘어간다
    // (2026-09-18 에 이렇게 초안만 5건 쌓였다). 선택지는 role=option 이 아니라 그냥 <li> 라서 역할로는 못 집는다.
    // force 클릭은 드롭다운 오버레이에 가로막히므로 일반 클릭으로 누르고, 버튼 라벨이 바뀌었는지로 성공을 확인한다.
    const pickFromList = async (openName, want) => {
      const opener = page.getByRole('button', { name: openName }).first();
      if (!(await opener.count().catch(() => 0))) return false;
      await opener.click().catch(() => {});
      await page.waitForTimeout(1200);
      const item = page.locator('li').filter({ hasText: want }).first();
      if (!(await item.count().catch(() => 0))) { await page.keyboard.press('Escape'); return false; }
      await item.click().catch(() => {});
      await page.waitForTimeout(1200);
      const label = (await opener.innerText().catch(() => '')).trim();
      return label.includes(want);
    };
    let categoryOk = false;
    if (sel.categoryPick) {
      categoryOk = await pickFromList(new RegExp(`1차 카테고리|${sel.categoryPick}`), sel.categoryPick);
      if (!categoryOk) throw new Error(`1차 카테고리 «${sel.categoryPick}» 선택 실패 — 비우면 등록이 초안으로 떨어진다`);
      if (sel.category2Pick) await pickFromList(/2차 카테고리/, sel.category2Pick);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(600);
    }
    // 정보태그(실측): '영화·방송·시상식'을 누르면 검색 모달이 뜬다 — 작품명을 검색해 [선택]을 눌러야 붙는다.
    // 네이버는 태그 검색 유입 비중이 커서 작품 태그가 노출의 핵심이다(platform_post_specs: info_tag 필수).
    const infoOpen = await firstVisible(page, sel.infoTagOpen, 5000);
    if (infoOpen) {
      await infoOpen.el.click({ force: true }).catch(() => {});
      const q = sel.infoTagQuery || opts.movieTitle || '';
      const box = await firstVisible(page, sel.infoTagSearch, 6000);
      if (box && q) {
        await box.el.fill(q).catch(async () => { await page.keyboard.type(q, { delay: 20 }); });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2500);
        const choose = await firstVisible(page, sel.infoTagChoose, 6000);
        if (choose) { await choose.el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      }
      const close = await firstVisible(page, sel.infoTagClose, 3000);
      if (close) await close.el.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // 등록 예약: 유튜브·blotato 와 같은 시각에 공개되게 한다. 네이버는 네이티브 예약이 있어 프로세스를 띄워 둘 필요가 없다.
    // 드롭다운 선택지는 카테고리와 마찬가지로 전부 <li> 이고, 날짜는 달력의 '일' 숫자다(실측 2026-09-18).
    if (opts.slot) {
      const k = opts.slot;   // KST 기준 {y, m, d, hh, mm}
      const cb = await firstVisible(page, sel.scheduleCheckbox, 5000);
      if (!cb) throw new Error('등록 예약 체크박스를 못 찾았다 — 예약 발행 불가');
      await cb.el.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      const dateBtn = page.locator('button').filter({ hasText: /^\d{4}\.\d{2}\.\d{2}$/ }).first();
      const shown = (await dateBtn.innerText().catch(() => '')).trim();
      if (shown !== `${k.y}.${k.m}.${k.d}`) {
        await dateBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
        const day = page.locator('li,td').filter({ hasText: new RegExp(`^${Number(k.d)}$`) }).first();
        if (!(await day.count().catch(() => 0))) throw new Error(`달력에서 ${k.m}/${k.d} 을 못 찾았다 — 다른 달이면 수동 확인 필요`);
        await day.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      const setPart = async (candidates, want, label) => {
        const btn = await firstVisible(page, candidates, 4000);
        if (!btn) throw new Error(`${label} 드롭다운을 못 찾았다`);
        await btn.el.click().catch(() => {});
        await page.waitForTimeout(1000);
        const item = page.locator('li').filter({ hasText: new RegExp(`^${want}$`) }).first();
        if (!(await item.count().catch(() => 0))) throw new Error(`${label} 에 ${want} 가 없다`);
        await item.click().catch(() => {});
        await page.waitForTimeout(900);
      };
      await setPart(sel.scheduleHourBtn, k.hh, '시간');
      await setPart(sel.scheduleMinuteBtn, k.mm, '분');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(600);
    }
    // AI 활용 설정: 내레이션이 TTS 라 켜 둔다(끄면 정책 위반 소지).
    const ai = await firstVisible(page, sel.aiToggle, 3000);
    if (ai) {
      const on = await ai.el.getAttribute('aria-checked').catch(() => null);
      if (on !== 'true') await ai.el.click({ force: true }).catch(() => {});
    }
    // 인코딩이 끝나야 등록이 먹는다. 진행 문구가 사라질 때까지 기다린다(3분 컷은 보통 1~2분).
    for (let i = 0; i < 60; i += 1) {
      const busy = await firstVisible(page, sel.encodingMarker, 1500);
      if (!busy) break;
      await page.waitForTimeout(5000);
    }
    // 등록 후 초안 URL 로 튕기면 발행 실패다 — 성공 문구만 보고 판단하면 초안을 성공으로 오인한다.
    return { descChars: desc.length, category: sel.categoryPick || '', infoTag: sel.infoTagQuery || opts.movieTitle || '', urlBefore: page.url() };
  },

  // Facebook: 비즈니스 스위트 릴스 작성기. 실측(2026-09-18) 화면은 만들기 → 수정 → 공유하기 3단계이고,
  // "게시할 위치"가 계정마다 다르다(기본값이 ja 페이지 Numaochicinema 였다). 잘못된 자산에 올리는 것이
  // 가장 비싼 실수라 --target 으로 못박고, 화면의 선택값이 다르면 올리지 않고 멈춘다.
  async facebook(page, job, sel, spec, opts) {
    await page.goto(sel.home, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const want = opts.target;
    if (want) {
      const picker = await firstVisible(page, sel.targetPicker, 8000);
      const shown = picker ? (await picker.el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : '';
      if (shown && !shown.includes(want)) {
        // 드롭다운에서 고르기를 시도하고, 그래도 안 맞으면 멈춘다.
        await picker.el.click().catch(() => {});
        const option = await firstVisible(page, [`text=${want}`], 4000);
        if (option) await option.el.click().catch(() => {});
        await page.waitForTimeout(1200);
        const after = (await picker.el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!after.includes(want)) throw new Error(`게시 대상이 «${want}» 가 아니다(화면: ${after || '알 수 없음'}) — 대상 확인 전에는 올리지 않는다`);
      }
    }

    await attachFile(page, sel.fileInput, sel.openUploader, job.mp4);
    // 업로드 처리(썸네일 생성)까지 기다린다 — 바로 다음 단계를 누르면 비어 있는 릴스가 만들어진다.
    await page.waitForTimeout(4000);

    const body = job.fb || job.yt || { caption: '', hashtags: [] };
    const tags = body.hashtags.slice(0, Number(spec?.hashtags?.max || 3));
    const text = [body.caption, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n')
      .slice(0, Number(spec?.caption_max || 2200));
    // 실측 2026-09-18: 1단계는 영상 미리보기 + '저작권이 있는 콘텐츠 확인 중' 이고 설명칸은 '다음' 뒤에 나온다.
    // 저작권 검사가 끝나야 '다음'이 눌리므로 click 의 자동 대기(활성화될 때까지)에 맡기고 최대 3단계까지 넘긴다.
    let field = (await firstVisible(page, sel.captionField, 3000))?.el;
    for (let step = 0; !field && step < 3; step += 1) {
      const nxt = await firstVisible(page, sel.next, 20000);
      if (!nxt) break;
      await nxt.el.click({ timeout: 90000 }).catch(() => {});   // 저작권 확인이 길면 여기서 기다린다
      await page.waitForTimeout(3000);
      field = (await firstVisible(page, sel.captionField, 10000))?.el;
    }
    if (!field) throw new Error('설명 입력칸까지 도달하지 못했다 — 선택자 갱신 필요');
    await field.click();
    await page.keyboard.type(text, { delay: 4 });   // contenteditable 이라 fill 대신 타이핑

    const tagField = await firstVisible(page, sel.hashtagField, 3000);
    if (tagField && tags.length) {
      for (const t of tags) { await tagField.el.type(t, { delay: 20 }); await page.keyboard.press('Enter'); }
    }

    // 크로스포스트는 반드시 꺼야 한다(소유주 지시): 켜져 있으면 같은 영상이 다른 자산에도 중복 게시된다.
    const cross = await firstVisible(page, sel.crosspostToggle, 2500);
    if (cross) {
      const box = cross.el.locator('input[type=checkbox]').first();
      if (await box.count() && await box.isChecked().catch(() => false)) await box.uncheck().catch(() => {});
    }
    return { crosspostSeen: Boolean(cross), target: want || '' };
  }
};

// 개인 프로필(ko)은 비즈니스 스위트에 자산으로 뜨지 않는다(2026-09-18 확인) — facebook.com 작성기를 같은 드라이버로 몬다.
// 화면 구성이 같고 차이는 '게시할 위치' 선택기가 없다는 것뿐이라, 선택자 JSON 만 다르게 준다.
drivers.facebook_profile = drivers.facebook;

async function openBrowser(site, headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(path.join(PROFILE_DIR, site), {
    channel: 'chrome',
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    headless,
    viewport: { width: 1440, height: 960 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    // 네이버·메타는 자동화 표식을 본다. 사용자 프로필을 그대로 쓰면서 표식만 감춘다.
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
  });
}

async function main() {
  const site = arg('--site', '');
  if (!drivers[site]) throw new Error('usage: --site naverclip|facebook|facebook_profile [--login|--explore|--dry-run] [--prefix|--only]');
  const selAll = readJson(SELECTORS, {});
  const sel = selAll[site];
  if (!sel) throw new Error(`선택자 없음: ${site} (${SELECTORS})`);
  const specs = readJson(SPECS, {});
  const spec = (specs.platforms || {})[site === 'naverclip' ? 'naver_clip' : 'facebook'] || {};
  const headless = has('--headless');
  const ctx = await openBrowser(site, headless);
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    if (has('--login')) {
      await page.goto(sel.loginUrl || sel.home, { waitUntil: 'domcontentloaded' });
      console.log(`[login] ${site}: 열린 창에서 직접 로그인하세요. 로그인이 감지되면 자동으로 저장하고 닫습니다 (최대 10분).`);
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const ok = await firstVisible(page, sel.loggedInMarker, 2000);
        if (ok) { console.log(`[login] ${site}: 로그인 확인됨 — 세션 저장 완료(${path.join(PROFILE_DIR, site)})`); return; }
      }
      throw new Error('10분 안에 로그인이 확인되지 않았다');
    }

    if (has('--explore')) {
      await page.goto(sel.home, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const base = await dumpFailure(page, `${site}-explore`);
      console.log(`[explore] ${site}: ${base}.png / ${base}.txt 에 화면과 요소 목록을 남겼다`);
      return;
    }

    // --dry-run 은 무엇을 어떤 문구로 올릴지 확인하는 용도라 로그인 없이 돈다.
    if (!has('--dry-run')) {
      await page.goto(sel.home, { waitUntil: 'domcontentloaded' });
      const loggedIn = await firstVisible(page, sel.loggedInMarker, 10000);
      if (!loggedIn) throw new Error(`${site}: 로그인 세션이 없다 — 먼저 --login 으로 1회 로그인할 것`);
    }

    const state = readJson(STATE_PATH, { history: [] });
    const done = new Set((state.history || []).map((h) => `${h.draft}:${h.site}`));
    const locale = site === 'naverclip' ? 'ko' : arg('--locale', 'ko');
    // --due: 지금(±30분)이 발행 시각인 것만 고른다. 예약 기능이 없는 곳(페이스북 개인 프로필)을
    // 슬롯 시각에 도는 작업으로 처리하기 위한 모드 — 드래프트마다 1회성 작업을 만드는 것보다 쌓이지 않는다.
    const dueOnly = has('--due');
    const nowMs = Date.now();
    const drafts = listDrafts({ prefix: arg('--prefix', ''), only: arg('--only', ''), locale })
      .filter((d) => !done.has(`${d}:${site}`))
      .filter((d) => {
        if (!dueOnly) return true;
        const job = buildJob(d);
        const at = Date.parse(job.publishAt || '');
        if (!Number.isFinite(at)) return false;
        // ★유튜브 차단본은 그 슬롯이 이미 지나 있다. 30분 창으로 보면 영원히 안 걸린다 —
        //   그래서 «시각이 지났으면 지금 발행»으로 본다. 앞으로 잡힌 것이면 평소대로 창을 쓴다.
        if (job.ytBlocked) return at <= nowMs + 30 * 60 * 1000;
        return Math.abs(at - nowMs) <= 30 * 60 * 1000;
      })
      .slice(0, Number(arg('--limit', '0')) || undefined);
    console.log(`targets: ${drafts.length} draft(s) [${site}]`);
    const lines = [`# web-publish ${site} ${new Date().toISOString()}`, ''];

    for (const draft of drafts) {
      const job = buildJob(draft);
      if (job.error) { console.log(`[skip] ${draft}: ${job.error}`); lines.push(`- 건너뜀 ${draft}: ${job.error}`); continue; }
      if (has('--dry-run')) {
        const body = site === 'naverclip' ? (job.nv || job.yt) : site.startsWith('facebook') ? (job.fb || job.yt) : (job.yt || job.ig);
        console.log(`[dry] ${draft} ${job.durationSec}s | ${(body?.caption || '').slice(0, 60)} | #${(body?.hashtags || []).join(' #')}`);
        continue;
      }
      try {
        // 같은 영상이 플랫폼마다 다른 시각에 나가지 않도록, 기본은 유튜브 publishAt 에 맞춘다.
        // --now 를 붙였을 때만 즉시 발행한다(2026-09-18 사고 재발 방지).
        const k = (has('--now') || dueOnly) ? null : kstParts(job.publishAt);   // --due 는 이미 그 시각이다
        const future = k && k.ms > Date.now() + 60 * 1000;
        if (future && !sel.scheduleCheckbox) {
          // 네이티브 예약이 없는 곳(페이스북 개인 프로필) — 그 시각에 스스로 다시 실행되도록 걸어 둔다.
          const taskName = scheduleWindowsTask(site, draft, k);
          console.log(`[예약] ${site} ${draft} -> ${k.y}.${k.m}.${k.d} ${k.hh}:${k.mm} KST (작업 ${taskName})`);
          lines.push(`- 예약 ${site}: ${draft} — ${k.y}.${k.m}.${k.d} ${k.hh}:${k.mm} KST (윈도우 작업 ${taskName})`);
          continue;
        }
        const extra = await drivers[site](page, job, sel, spec, { target: arg('--target', ''), movieTitle: job.movieTitle || '', slot: future ? k : null });
        // 작성기가 여러 단계면 게시 버튼이 나올 때까지 '다음'을 누른다(최대 4번).
        let submit = await firstVisible(page, sel.submit, 4000);
        for (let step = 0; !submit && step < 4; step += 1) {
          const nxt = await firstVisible(page, sel.next, 6000);
          if (!nxt) break;
          await nxt.el.click();
          await page.waitForTimeout(2500);
          submit = await firstVisible(page, sel.submit, 4000);
        }
        if (!submit) throw new Error('게시 버튼까지 도달하지 못했다 — 선택자 갱신 필요');
        if (has('--stop-before-publish')) {
          const base = await dumpFailure(page, `${site}-${draft}-preflight`);
          console.log(`[hold] ${draft}: 게시 직전에서 멈췄다 — ${base}.png 확인 후 --stop-before-publish 없이 다시 실행`);
          continue;
        }
        await submit.el.click();
        await page.waitForTimeout(2500);
        // 등록 뒤 확인 모달이 한 번 더 뜨는 곳이 있다(네이버). 있으면 눌러 주고, 없으면 그냥 지나간다.
        const confirm = await firstVisible(page, sel.confirmSubmit, 4000);
        if (confirm) { await confirm.el.click({ force: true }).catch(() => {}); await page.waitForTimeout(2000); }
        // 성공 신호가 문구가 아니라 페이지 이동인 곳이 있다(네이버: 등록되면 /web/contents/clips 로 간다).
        let ok = null;
        if (sel.successUrl) {
          ok = await page.waitForURL((u) => String(u).includes(sel.successUrl), { timeout: 120000 }).then(() => true).catch(() => null);
        }
        if (!ok) ok = await firstVisible(page, sel.successMarker, sel.successUrl ? 5000 : 120000);
        if (!ok) throw new Error('게시 확인 문구가 뜨지 않았다 — 실제 게시 여부를 직접 확인할 것');
        // 네이버는 검증에 걸리면 조용히 /web/draft/<id> 로 넘어간다. 그 상태를 성공으로 적으면 안 된다.
        if (/\/web\/draft\//.test(page.url())) throw new Error(`초안으로만 저장됐다(${page.url()}) — 필수 항목이 빈 채 등록됐다`);
        state.history = [...(state.history || []), { draft, site, locale: job.locale, at: new Date().toISOString(), url: page.url(), ...extra }];
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        console.log(`[ok] ${site} ${draft}`);
        lines.push(`- OK ${site}: ${draft}${extra?.needsInfoTag ? ' — 정보태그는 앱에서 확인 필요' : ''}`);
      } catch (e) {
        const base = await dumpFailure(page, `${site}-${draft}`);
        console.log(`[fail] ${site} ${draft}: ${e.message}`);
        console.log(`       화면: ${base}.png / 요소목록: ${base}.txt`);
        lines.push(`- 실패 ${site}: ${draft} — ${e.message} (${path.basename(base)}.png)`);
      }
    }
    if (!has('--dry-run')) {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const rp = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-web-publish.md`);
      fs.appendFileSync(rp, `${lines.join('\n')}\n\n`, 'utf8');
      console.log(`report: ${rp}`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => { console.error(`[web-publish] ${e.message}`); process.exit(1); });
