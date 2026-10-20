// 인포크 매니저 — 인스타 릴스 하나에 «댓글 키워드 → DM 링크» 자동화를 건다(2026-10-09).
//   node scripts/inpock_dm.js --key ffshop07 [--name "게키오치쿤 먼지떨이"] [--keywords 링크,구매,어디,정보] [--dry-run]
//   게시물은 썸네일 img alt(=인스타 본문)가 제목(해시태그 뺀 meta.title)으로 시작하는 것을 고른다 — 순서로 고르지 않는다.
//   아직 인스타에 안 올라갔으면 'not-posted' 로 끝낸다(종료 3). 버튼 링크는 쿠팡 subId igdm(DM 전환을 따로 잰다).
// 화면 순서(2026-10-08 실측): 자동화 추가하기 → 즉시 발송 → 게시물 직접 선택 → 특정 키워드(입력+Enter) →
//   (10/08 옛 화면 — 10/20 개편 뒤 순서는 본문 «5단계» 주석)
const fs = require('fs');
const path = require('path');
const { openInpock } = require('./inpock_browser');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);
const key = arg('--key'), name = arg('--name');
// 기본은 «아무 댓글»(2026-10-09 소유주 — 레퍼런스 계정 방식). --keywords 를 주면 그 키워드만
const keywords = String(arg('--keywords', '')).split(',').map((s) => s.trim()).filter(Boolean);
if (!key) { console.error('usage: --key <작업폴더> [--name <상품명>] [--keywords a,b] [--dry-run]'); process.exit(2); }
const SHOTS = path.join(__dirname, '..', 'server', 'output', 'web-publish-reports', 'shots');
const STATE = path.join(__dirname, '..', 'server', 'data', 'inpock_dm_state.json');
const REPLIES = [
  'DM으로 보내 드렸어요 😊', '메시지함 확인해 주세요!', '보내 드렸어요~ 팔로우하시면 링크가 바로 가요',
  '댓글 고마워요! DM 확인 부탁드려요', '방금 DM 드렸어요 🙌', '링크 보내 드렸어요, 확인해 보세요',
  'DM함에 넣어 드렸어요!', '감사해요 😊 메시지 보내 드렸어요', '확인해 보시라고 DM 드렸어요',
  '메시지로 보내 드렸습니다 🙏', '보내 드렸어요! 안 보이면 요청함도 봐 주세요', '댓글 감사해요~ DM 확인!',
];

(async () => {
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { rules: [] };
  if (!has('--dry-run') && state.rules.some((r) => r.key === key)) { console.log('[inpock-dm] 이미 걸림:', key); return; }
  const meta = JSON.parse(fs.readFileSync(`D:/volcano-runs/_upload/${key}.json`, 'utf8'));
  const { subLink } = require('./shop_fanout');
  const link = await subLink(meta, 'igdm');
  const title = String(meta.title).replace(/#[^\s#]+/g, '').trim();
  const message = `요청하신 ${name ? `«${name}» ` : '영상 속 제품 '}링크예요 👇\n아래 버튼을 누르면 쿠팡 상품 페이지로 이동해요.${require('./disclosure_cfg').textOn() ? '\n\n이 메시지는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.' : ''}`;

  const h = await openInpock();
  const p = h.page;
  const shot = async (tag) => { fs.mkdirSync(SHOTS, { recursive: true }); const f = path.join(SHOTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-inpock-dm-${key}-${tag}.png`); await p.screenshot({ path: f, fullPage: true }); return f; };
  const next = () => p.getByRole('button', { name: '다음', exact: true }).click({ timeout: 10000 });
  try {
    // 게시물 목록 API(managers/feeds) 응답에 본문 전체가 온다 — 화면 aria-label 은 40자에서 잘려 제목 4~5자밖에 안 남는다(10/20)
    const feeds = [];
    p.on('response', async (r) => {
      if (!/\/managers\/feeds\?/.test(r.url())) return;
      try { for (const d of (await r.json()).data || []) feeds.push(d); } catch { /* 무시 */ }
    });
    await p.goto('https://link.inpock.co.kr/admin/manager/trigger/default/new/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    // 게시물 썸네일(인스타 CDN 그림)이 늦게 뜬다 — 3초 고정 대기로는 빈 목록을 보고 «not-posted» 로 끝났다(10/20)
    await p.waitForSelector('img[src*="cdninstagram"], img[src*="fbcdn"]', { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(1500);
    // 게시물 썸네일의 alt 가 인스타 본문 전체다(2026-10-09 실측) — 제목으로 시작하는 것을 고른다
    const imgs = p.locator('img');
    let picked = false;
    // 10/20 실측: 인포크 화면이 바뀌어 img alt 가 비고 본문은 감싼 button(role=option) 의 aria-label 로 옮겨갔다 — 그걸 먼저 본다.
    // 제목은 띄어쓰기를 빼고 비교하고, 재포장으로 제목이 바뀐 편(meta.title_before)은 옛 제목으로도 찾는다(인스타 본문은 그대로라서).
    const sq = (x) => String(x || '').replace(/#[^\s#]+/g, '').replace(/\s+/g, '');
    const wants = [meta.title, meta.title_before].filter(Boolean).map(sq).filter(Boolean);
    // 썸네일 순서 = feeds 응답 순서. 본문 전체에 제목(띄어쓰기 무시)이 든 게시물의 썸네일 주소로 찾아 누른다.
    const hit = feeds.filter((d) => wants.some((w) => sq(d.caption).includes(w)));
    if (process.env.INPOCK_DEBUG) console.log('[feeds]', feeds.length, 'hit', hit.map((d) => d.permalink).join(' '));
    if (hit.length > 1) { const e = new Error(`ambiguous: 제목이 같은 게시물 ${hit.length}개 — 고르지 않음`); e.code = 3; throw e; }
    if (hit.length === 1) {
      const key = String(hit[0].thumbnail_url || '').split('?')[0].split('/').pop();
      for (let i = 0, n = await imgs.count(); i < n && !picked; i += 1) {
        const src = (await imgs.nth(i).getAttribute('src')) || '';
        if (key && src.includes(key)) { await imgs.nth(i).scrollIntoViewIfNeeded(); await imgs.nth(i).click(); picked = true; }
      }
    }
    if (!picked) { const e = new Error(`not-posted: 인스타에 «${title}» 게시물이 아직 없다`); e.code = 3; throw e; }
    await p.waitForTimeout(1000);
    // ★2026-10-20 인포크 화면 개편(5단계) — 01 게시물 → 02 댓글 조건·팔로워 구분 → 03 DM(팔로우 확인/팔로워/비팔로워 탭) → 04 언제 보낼까(즉시 발송 기본) → 05 추가 설정(답글·DM 공유·DM 코드) → [자동화 등록]
    const onStep = async (no) => (await p.evaluate(() => document.body.innerText)).includes(`${no}단계`);   // 화면 글에 «N단계»(숨은 글) 가 있다
    const step = async (no) => { for (let k = 0; k < 6; k += 1) { if (await onStep(no)) return; await p.waitForTimeout(800); } throw new Error(`${no}단계 화면이 안 나옴`); };
    await next(); await step(2);
    // 02 댓글 조건: 기본 «모든 댓글»(2026-10-09 소유주 «아무 댓글»). --keywords 면 «키워드가 있을 때»
    if (keywords.length) {
      await p.getByText('키워드가 있을 때', { exact: true }).click(); await p.waitForTimeout(800);
      const kw = p.locator('input[placeholder*="키워드"]').first();
      for (const k of keywords) { await kw.fill(k); await p.keyboard.press('Enter'); await p.waitForTimeout(400); }
    }
    // 팔로워 구분(2026-10-12 소유주 승인 — 팔로우해야 링크) · ★등록 후엔 바꿀 수 없다
    const gate = !has('--no-follow-gate');
    if (gate) { await p.getByText('팔로워만 다르게', { exact: true }).click(); await p.waitForTimeout(800); }
    await next(); await step(3);
    // 03 DM: 팔로워 탭에 링크 메시지(팔로우 확인·비팔로워 탭은 인포크 기본 문구)
    if (gate) { await p.getByText('팔로워', { exact: true }).first().click(); await p.waitForTimeout(1200); }
    const ta = p.locator('textarea[placeholder="DM으로 보낼 메시지를 써 주세요"]');
    await ta.click(); await p.keyboard.press('Control+A'); await p.keyboard.insertText(message);
    // 버튼 카드 → 버튼 수정 → «눌러서 다른 링크로 바꿀 수 있어요» → 주소 붙여넣기 → 넣기 → 이름 → 수정 완료
    await p.locator('div,button').filter({ hasText: /^상품 보러 가기/ }).last().click(); await p.waitForTimeout(1200);
    await p.getByText('눌러서 다른 링크로 바꿀 수 있어요').click(); await p.waitForTimeout(1200);
    await p.locator('input[placeholder="https://"]').fill(link);
    await p.getByRole('button', { name: '넣기', exact: true }).click({ timeout: 8000 }); await p.waitForTimeout(1200);
    const bn = p.locator('input[placeholder="예) 쿠폰 받기"]');
    await bn.click(); await p.keyboard.press('Control+A'); await p.keyboard.insertText('상품 보러 가기');
    const linkShown = (await p.evaluate(() => document.body.innerText)).includes(link.replace(/^https?:\/\//, ''));
    await p.getByRole('button', { name: '수정 완료', exact: true }).click({ timeout: 8000 }); await p.waitForTimeout(1200);
    if ((await ta.inputValue()) !== message) throw new Error('메시지가 안 들어갔다');
    if (!linkShown) throw new Error(`버튼 링크가 안 바뀌었다: ${link}`);
    if (has('--dry-run')) console.log('[inpock-dm] 링크 메시지 화면:', await shot('filled'));
    for (let k = 0; k < 3; k += 1) {   // 팔로워 구분이면 «다음»이 탭을 넘긴다 — 04 가 나올 때까지
      await next(); await p.waitForTimeout(1500);
      if (/(^|\s)04\s/.test(await p.evaluate(() => document.body.innerText))) break;
    }
    await step(4);   // 04 즉시 발송(기본)
    await next(); await step(5);
    // 05 추가 설정: «댓글에 답글 달기» 기본 켜짐(인포크 정중한 랜덤 문구 — 2026-10-12 소유주 승인 랜덤 답글), --no-reply 면 끈다
    if (has('--no-reply')) console.log('[inpock-dm] ⚠ --no-reply: 새 화면에서는 손으로 꺼야 한다(토글 위치 미확인)');
    const f = await shot('before-register');
    console.log('[inpock-dm] 등록 전 화면:', f);
    console.log((await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').replace(/^.*자동화 추가/, '').slice(0, 900));
    if (has('--dry-run')) { console.log('[inpock-dm] dry-run — 여기서 멈춤(저장 안 함)'); return; }
    // 첫 클릭은 «등록할 내용» 요약까지 스크롤만 하고 저장하지 않았다(10/20 실측) — 저장 요청(POST)이 나갈 때까지 최대 3번 누른다
    let saved = null;
    p.on('response', (r) => { if (r.request().method() !== 'GET' && /trigger/i.test(r.url())) saved = saved || `${r.request().method()} ${r.status()} ${r.url().slice(0, 90)}`; });
    // 누르면 «자동화를 등록할까요?» 확인 창이 뜬다 → [등록하기]
    for (let k = 0; k < 3 && !saved; k += 1) {
      const confirm = p.getByRole('button', { name: '등록하기', exact: true });
      if (await confirm.isVisible().catch(() => false)) await confirm.click({ timeout: 10000 });
      else await p.getByRole('button', { name: '자동화 등록', exact: true }).click({ timeout: 10000 });
      await p.waitForTimeout(3000);
    }
    console.log('[inpock-dm] 저장 요청:', saved || '없음');
    if (!saved) throw new Error('자동화 등록을 눌러도 저장 요청이 안 나갔다');
    console.log('[inpock-dm] 등록 누른 뒤:', await shot('after-register'));
    console.log((await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').replace(/^.*로그아웃/, '').slice(0, 600));
    if (has('--stop-after-register')) return;
    await p.goto('https://link.inpock.co.kr/admin/manager/?tab=trigger', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    const total = +((await p.evaluate(() => document.body.innerText)).match(/총\s*(\d+)\s*개/) || [])[1];
    const done = await shot('registered');
    state.rules.push({ key, title, name: name || null, keywords, followGate: gate, link, at: new Date().toISOString(), shot: done });
    fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}
`, 'utf8');
    console.log('[inpock-dm] 등록:', key, keywords.length ? keywords.join('·') : '아무 댓글', `(목록 ${total}개)`, done);
  } catch (e) { console.error('[inpock-dm] 실패 화면:', await shot('fail').catch(() => '')); throw e; } finally { await h.close(); }
})().then(() => process.exit(0)).catch((e) => { console.error('[inpock-dm] 실패:', e.message.split('\n')[0]); process.exit(e.code || 1); });
