// 쇼핑쇼츠를 유튜브 밖으로 퍼뜨린다 — 유튜브 예약 공개 시각에 맞춰
//   Blotato 4곳(인스타 릴스·틱톡·스레드·페이스북 페이지) 예약 + 네이버 클립(그 시각에 도는 윈도우 작업).
//
//   node scripts/shop_fanout.js <meta.json> --at <ISO>        한 편 예약(shop_schedule.js add 가 부른다)
//   node scripts/shop_fanout.js <meta.json> --at <ISO> --dry-run
//
// 2026-10-06 소유주: 쇼핑은 새 채널(쓸모연구소 @ssul-mo) + 같은 브랜드 계정 shorteg006 으로 같이 발행.
// 유튜브 밖은 댓글 링크를 못 누르므로 끝 멘트가 "프로필 링크"인 판(<작업폴더>_social.mp4)을 올리고,
// 프로필 링크는 인포크(link.inpock.co.kr/ssul_mo)로 걸려 있다. 게시물마다 파트너스 표기를 본문에 넣는다.
//
// Blotato 로 말하는 부분(업로드·타깃 블록·과거시각 클램프)은 blotato-publish.js 것을 그대로 쓴다.
// 페이스북 pageId 는 Blotato 기본값이 아니라 blotato_accounts.json 에 적힌 값만 쓴다(기본값은 마지막에 붙인 페이지로 바뀐다).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { api, uploadLocalFile, buildTarget, scheduleFor } = require('./blotato-publish');

const ACCOUNTS = path.join(ROOT, 'midform', 'config', 'blotato_accounts.json');
const STATE = path.join(ROOT, 'server', 'data', 'shop_fanout_state.json');
const CHANNEL = 'shopping';
const NAVER_PROFILE = 'naverclip-shopping';
const NAVER_CATEGORY = process.env.SHOP_NAVER_CATEGORY || '리빙, 홈';   // 2026-10-06 실측 1차 목록에 '리빙, 홈'·'쇼핑' 있음
// 글 표기는 disclosure.json text 스위치(2026-10-12 소유주: 끈다 — 영상 우상단 «광고»만)
const DISCLOSURE = require('./disclosure_cfg').textOn() ? '이 게시물은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.' : '';

// 인포크 상품 번호 — '프로필 링크 N번'(2026-10-07 소유주). 없으면 번호 없이 안내
const NUMBERS = 'D:/volcano-runs/_upload/product_numbers.json';
function numOf(meta) { try { return JSON.parse(fs.readFileSync(NUMBERS, 'utf8')).numbers[path.basename(path.dirname(meta.file))] || 0; } catch { return 0; } }
const cta = (meta) => (numOf(meta) ? `영상 속 제품은 프로필 링크 ${numOf(meta)}번에서 확인하세요` : '영상 속 제품은 프로필 링크에서 확인하세요');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8'); };

function socialMp4(meta) {
  const yt = meta.file;
  const dir = path.dirname(yt);
  const p = path.join(dir, `${path.basename(dir)}_social.mp4`);
  if (!fs.existsSync(p)) throw new Error(`프로필 링크 판 없음: ${p} — plan_social.json 으로 렌더할 것`);
  return p;
}

// 유튜브 설명란에서 본문 문단만 가져오고, 쿠팡 링크 줄은 "프로필 링크"로 바꾼다. 끝의 @출처 줄은 그대로 둔다.
// 인스타는 인포크 매니저가 댓글 키워드에 DM 으로 링크를 보낸다(inpock_dm.js, 2026-10-09 소유주) — 안내 한 줄을 더 넣는다
// 2026-10-12: 모바일은 첫 줄만 보인다 — 행동 지시를 맨 위로, 한 단어 댓글(규칙은 «아무 댓글»이라 무엇을 써도 간다)
const DM_LINE = '💬 댓글에 "링크"라고 남겨 주시면 DM으로 보내 드려요';
function socialText(meta, { maxTags = 5, dm = false } = {}) {
  const titleTags = [...String(meta.title).matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
  const title = String(meta.title).replace(/#[^\s#]+/g, '').trim();
  const blocks = String(meta.description).split(/\n\s*\n/);
  const body = blocks.filter((b) => !/🛒|link\.coupang|쿠팡 파트너스|^@/m.test(b)).join('\n\n').trim();
  const credits = blocks.filter((b) => /^@/m.test(b) && b.split('\n').every((l) => /^@\S+$/.test(l.trim()))).join('\n');
  const tags = [...new Set([...titleTags, '살림템', '쿠팡추천'])].slice(0, maxTags).map((t) => `#${t}`).join(' ');
  return [dm ? DM_LINE : '', title, body, `🛒 ${cta(meta)}`, DISCLOSURE, tags, credits]
    .filter(Boolean).join('\n\n');
}

// 플랫폼별 쿠팡 링크(subId) — 같은 상품도 어디서 클릭·구매가 났는지 리포트에서 갈라 본다(2026-10-08 Open API).
// 파트너스 단축 링크(meta.affiliate_link)를 따라가 상품 주소를 얻고 딥링크를 subId 붙여 새로 만든다. 결과는 sublinks.json 에 캐시.
const SUBLINKS = 'D:/volcano-runs/_upload/sublinks.json';
async function subLink(meta, subId) {
  const key = path.basename(path.dirname(meta.file));
  const cache = readJson(SUBLINKS, {});
  if (cache[key]?.[subId]) return cache[key][subId];
  const r = await fetch(meta.affiliate_link, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
  const loc = r.headers.get('location') || '';
  const m = loc.match(/coupang\.com\/vp\/products\/(\d+)(?:\?[^#]*?itemId=(\d+))?/);
  if (!m) throw new Error(`상품 주소를 못 얻었다: ${meta.affiliate_link}`);
  const product = `https://www.coupang.com/vp/products/${m[1]}${m[2] ? `?itemId=${m[2]}` : ''}`;
  const dl = await require('./coupang_api').deeplink([product], subId);
  const link = dl.data?.[0]?.shortenUrl;
  if (!link) throw new Error(`딥링크 실패: ${JSON.stringify(dl).slice(0, 120)}`);
  cache[key] = { ...(cache[key] || {}), product, [subId]: link };
  writeJson(SUBLINKS, cache);
  return link;
}

// 스레드는 본문 링크가 눌린다 — 프로필을 거치지 않고 쿠팡으로 바로(2026-10-08 소유주)
function threadsText(meta, link) {
  if (link) {
    const title = String(meta.title).replace(/#[^\s#]+/g, '').trim();
    const tags = [...String(meta.title).matchAll(/#([^\s#]+)/g)].map((m) => `#${m[1]}`).slice(0, 2).join(' ');
    return [title, `🛒 영상 속 제품 ${link}`, DISCLOSURE, tags].filter(Boolean).join('\n\n');
  }
  return threadsTextProfile(meta);
}

function threadsTextProfile(meta) {
  const title = String(meta.title).replace(/#[^\s#]+/g, '').trim();
  const tags = [...String(meta.title).matchAll(/#([^\s#]+)/g)].map((m) => `#${m[1]}`).slice(0, 2).join(' ');
  return [title, `${cta(meta)}.`, DISCLOSURE, tags].filter(Boolean).join('\n\n');
}

async function blotato(meta, mp4, atIso, dry, log) {
  const cfg = readJson(ACCOUNTS, {}).channels?.[CHANNEL];
  if (!cfg) throw new Error(`blotato_accounts.json 에 channels.${CHANNEL} 없음`);
  const state = readJson(STATE, { history: [], media: {} });
  const key = path.basename(path.dirname(meta.file));
  const text = socialText(meta);
  let mediaUrl = state.media[mp4];
  let failed = 0;
  for (const [platform, mapping] of Object.entries(cfg.platforms)) {
    if (mapping.status !== 'connected') continue;
    if (state.history.some((h) => h.key === key && h.platform === platform)) { log(`  - ${platform}: 이미 예약됨`); continue; }
    const when = scheduleFor(atIso, platform, true);   // 새 계정 — 플랫폼마다 몇 분씩 어긋나게
    // 스레드는 500자 한도를 «글자 수가 아닌 자체 셈»으로 잰다(이모지·줄바꿈이 더 든다, 2026-10-06 422) — 짧은 판을 따로 쓴다.
    const t = platform === 'threads' ? threadsText(meta, await subLink(meta, 'threads').catch(() => '')) : platform === 'tiktok' ? text.slice(0, 2200) : platform === 'instagram' ? socialText(meta, { dm: true }) : text;
    // 인스타는 끝 멘트가 «댓글에 링크»인 판(<작업폴더>_ig.mp4)이 있으면 그걸 쓴다 — DM 자동화가 인스타만 된다(2026-10-12, 커브에릭: 영상 두 판)
    const igMp4 = path.join(path.dirname(mp4), `${path.basename(path.dirname(mp4))}_ig.mp4`);
    const file = platform === 'instagram' && fs.existsSync(igMp4) ? igMp4 : mp4;
    if (dry) { log(`  [dry] ${platform} @ ${when} ${path.basename(file)} ${t.slice(0, 50).replace(/\n/g, ' ')}…`); continue; }
    let url = file === mp4 ? mediaUrl : state.media[file];
    if (!url) { url = await uploadLocalFile(file); state.media[file] = url; writeJson(STATE, state); }
    if (file === mp4) mediaUrl = url;
    try {
    const target = buildTarget(platform, mapping, { isAiGenerated: true });
    const r = await api('POST', '/posts', { post: { accountId: String(mapping.accountId), content: { text: t, mediaUrls: [url], platform }, target }, scheduledTime: when });
    const id = String(r?.postSubmissionId || r?.id || 'submitted');
    state.history.push({ key, platform, accountId: String(mapping.accountId), pageId: mapping.pageId || null, scheduledTime: when, submissionId: id, at: new Date().toISOString() });
    writeJson(STATE, state);
    log(`  ✓ ${platform} @ ${when} (${id})`);
    } catch (e) { failed += 1; log(`  ✗ ${platform}: ${String(e.message).slice(0, 200)}`); }   // 한 곳이 막혀도 나머지는 간다
  }
  if (failed) throw new Error(`${failed}곳 실패`);
}

// 네이버 클립: 달력 예약은 고장이라(메모 naverclip-native-schedule-is-broken) 그 시각에 도는 윈도우 작업으로.
// web-publish.js 의 --rinbox 입력 어댑터를 쓴다 — mp4 옆에 .rinbox.json(제목)·.social.ko.txt(네이버 섹션)를 둔다.
function writeSidecars(meta, mp4) {
  const title = String(meta.title).replace(/#[^\s#]+/g, '').trim();
  const tags = [...new Set([...[...String(meta.title).matchAll(/#([^\s#]+)/g)].map((m) => m[1]), '살림템', '쿠팡추천', '생활꿀템'])];
  const blocks = String(meta.description).split(/\n\s*\n/);
  const body = blocks.filter((b) => !/🛒|link\.coupang|쿠팡 파트너스|^@/m.test(b)).join(' ').replace(/\s+/g, ' ').trim();
  // 네이버 설명칸은 300자에서 잘린다 — 표기·안내를 앞에, 본문을 뒤에(2026-10-07 탱글티저 편 표기가 잘렸다)
  const caption = [DISCLOSURE, `${cta(meta)}.`, body].filter(Boolean).join('\n');
  const social = `[네이버 클립]\n====\n(제목)\n${title}\n(캡션)\n${caption}\n(해시태그)\n${tags.map((t) => `#${t}`).join(' ')}\n`;
  fs.writeFileSync(`${mp4}.rinbox.json`, `${JSON.stringify({ locale: 'ko', title, channel: CHANNEL, naverCategory: NAVER_CATEGORY, naverCategory2: '리빙, 홈', noInfoTag: true }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${mp4}.social.ko.txt`, social, 'utf8');
  return title;
}

function naver(meta, mp4, atIso, dry, log) {
  const title = String(meta.title).replace(/#[^\s#]+/g, '').trim();
  const k = new Date(Date.parse(atIso) + 9 * 3600e3);
  const pad = (n) => String(n).padStart(2, '0');
  const name = `midform-shop-naver-${path.basename(path.dirname(meta.file))}`;
  const args = ['--site', 'naverclip', '--profile', NAVER_PROFILE, '--rinbox', `"${mp4}"`, '--now'];   // 카테고리·정보태그 생략은 곁딸린 메타로
  const cmd = `cmd /c cd /d "${ROOT}" && node scripts/web-publish.js ${args.join(' ')}`;
  if (dry) { log(`  [dry] naverclip @ ${k.toISOString().slice(0, 16)} KST · ${title}`); return; }
  writeSidecars(meta, mp4);
  const r = spawnSync('schtasks', ['/create', '/f', '/tn', name, '/tr', cmd, '/sc', 'once',
    '/sd', `${k.getUTCFullYear()}/${pad(k.getUTCMonth() + 1)}/${pad(k.getUTCDate())}`, '/st', `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`네이버 작업 등록 실패: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
  log(`  ✓ naverclip @ ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())} KST (작업 ${name})`);
}

async function fanout(metaPath, atIso, { dry = false, log = console.log } = {}) {
  const meta = readJson(metaPath, null);
  if (!meta) throw new Error(`메타 없음: ${metaPath}`);
  const mp4 = socialMp4(meta);
  log(`[fanout] ${path.basename(metaPath)} → ${atIso}`);
  let fail = 0;
  try { await blotato(meta, mp4, atIso, dry, log); } catch (e) { fail += 1; log(`  ✗ blotato: ${e.message}`); }
  try { naver(meta, mp4, atIso, dry, log); } catch (e) { fail += 1; log(`  ✗ naverclip: ${e.message}`); }
  return fail;
}

module.exports = { fanout, socialText, DM_LINE, threadsText, writeSidecars, numOf, subLink };

if (require.main === module) {
  const a = process.argv.slice(2);
  // node scripts/shop_fanout.js sublink <meta.json> <subId> — subId 붙은 쿠팡 링크 한 줄(인포크 새 항목은 subId inpock, 10/17)
  if (a[0] === 'sublink') {
    subLink(readJson(path.resolve(a[1]), null), a[2]).then((l) => { console.log(l); process.exit(0); })
      .catch((e) => { console.error(e.message); process.exit(1); });
    return;
  }
  const at = a[a.indexOf('--at') + 1];
  if (!a[0] || a.indexOf('--at') < 0) { console.error('usage: shop_fanout.js <meta.json> --at <ISO> [--dry-run]'); process.exit(2); }
  fanout(path.resolve(a[0]), at, { dry: a.includes('--dry-run') })
    .then((f) => process.exit(f ? 1 : 0))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
