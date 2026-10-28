// midform social fan-out: exported mp4 -> Blotato -> Instagram / TikTok / Threads / Facebook.
//
//   node scripts/blotato-publish.js [--prefix 20260831a] [--only <folder>] [--dry-run]
//                                   [--limit N] [--platforms instagram,tiktok] [--no-warmup]
//                                   [--verify-accounts]
//
// YouTube is NOT routed through here. It stays on the OAuth path in auto-publish.js because
// that path carries the Content ID preflight (private + publishAt + Studio Checks window).
// This script only fans the same verified mp4 out to the non-YouTube platforms.
//
// - Channel mapping comes from midform/config/blotato_accounts.json. A platform ships only
//   when its status is "connected"; manual_only / unsupported are reported, never posted.
// - Captions come from the publish package (social_posts.<loc>.txt), same file auto-publish
//   reads for the YouTube title — one section per platform, gate-checked upstream.
// - Scheduling INHERITS the YouTube publishAt from auto_publish_state.json, so TikTok and
//   YouTube land on the same clock as the platform spec requires. No second slot system.
// - Warmup: the ja accounts were created 2026-08-31. Brand-new accounts that all fire at the
//   same minute get flagged, so posts are staggered per platform and capped per account/day
//   until the warmup date passes. --no-warmup overrides once the accounts are seasoned.
// - State (server/data/blotato_publish_state.json) is keyed draft+platform: a draft never
//   ships twice to the same platform, and the uploaded media URL is reused across platforms.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Optional: a worktree without installed deps still runs --dry-run off the process env.
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
catch { /* env comes from the process */ }

const ACCOUNTS_PATH = path.join(ROOT, 'midform', 'config', 'blotato_accounts.json');
const SPECS_PATH = path.join(ROOT, 'midform', 'config', 'platform_post_specs.json');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const UPLOADED_DIR = path.join(EXPORT_DIR, 'uploaded');
const YT_STATE_PATH = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'blotato_publish_state.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'blotato-publish-reports');

const API_BASE = 'https://backend.blotato.com/v2';
const FAN_OUT = ['instagram', 'tiktok', 'threads', 'facebook'];

// Brand-new accounts: one post per account per day, and never all at the same minute.
const WARMUP_UNTIL = '2026-09-14';
// Every platform posts on the YouTube clock — no spread (owner directive 2026-08-31).
// TikTok REQUIRES it: the same cut arriving later reads as a duplicate and the video loses
// feed distribution (platform_post_specs already said "YouTube와 동시각 필수"). The rest post
// together because spreading them bought nothing — the earlier per-platform offsets staggered
// channels that cannot observe each other's timing, while the only real co-occurrence (the ko
// and ja accounts ON THE SAME platform) stayed simultaneous regardless. Keep this at 0 unless
// there is measured evidence of a per-platform limit; the offsets were a guess, not a finding.
const STAGGER_MIN = { tiktok: 0, instagram: 0, threads: 0, facebook: 0 };

function parseArgs(argv) {
  const args = {
    prefix: '', only: '', dryRun: false, limit: 0, noWarmup: false,
    verifyAccounts: false, platforms: null
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--no-warmup') args.noWarmup = true;
    else if (argv[i] === '--verify-accounts') args.verifyAccounts = true;
    else if (argv[i] === '--prefix') { args.prefix = String(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--only') { args.only = String(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--limit') { args.limit = Number(argv[i + 1]) || 0; i += 1; }
    else if (argv[i] === '--platforms') {
      args.platforms = String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return args;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function apiKey() {
  const key = String(process.env.BLOTATO_API_KEY || '').trim();
  if (!key) {
    throw new Error('BLOTATO_API_KEY is not set — add it to .env (Blotato > Settings > API keys)');
  }
  return key;
}

// ── 틱톡은 Zernio 로 (소유주 2026-10-07) ─────────────────────────────────────
// Blotato Starter 는 틱톡을 24시간에 계정 3개까지만 올린다 — 4번째 계정이 매일 실패했다.
// 모든 발행기(blotato-publish·rinbox-social·shop_fanout·fanout-backfill …)가 이 api() 를 거치므로
// 여기 한 곳에서 «틱톡 + Zernio 에 연결된 계정»이면 Zernio 로 돌린다. 매핑: midform/config/zernio_accounts.json
// (Blotato accountId → Zernio _id). 매핑에 없는 틱톡 계정은 그대로 Blotato 로 간다.
const ZERNIO_MAP_PATH = path.join(ROOT, 'midform', 'config', 'zernio_accounts.json');
// ── 발행 경로 스위치 (관리자 배정 10-29) ─────────────────────────────────────
// Blotato 미갱신(past_due) → publish_routes.json blotato=off 면 Blotato 호출 0회. 인스타·페북·스레드 글은
// 실패가 아니라 skip:blotato_off 로 돌려준다(발행기들이 그 id 를 그대로 기록 → 레인 fill·발행 FAIL 안 남).
// 틱톡은 소유주가 Zernio 2계정을 고를 때까지 skip:zernio_hold(keep 계정은 예외).
const routes = require('./publish-routes');
function zernioTarget(endpoint, body) {
  if (endpoint !== '/posts' || body?.post?.content?.platform !== 'tiktok') return '';
  return zernioIdFor(body.post.accountId);
}
async function zernioPost(zid, body) {
  const key = String(process.env.ZERNIO_API_KEY || '').trim();
  if (!key) throw new Error('ZERNIO_API_KEY 가 .env 에 없다');
  const t = body.post.target || {};
  // uploadLocalFile(Blotato 꺼짐)·zernioUpload(틱톡 보류)는 local:<경로> 만 돌려준다 — 실제 글이 나갈 때 여기서 Zernio 에 올린다
  const urls = [];
  for (const url of body.post.content.mediaUrls || []) urls.push(String(url).startsWith('local:') ? await zernioUploadNow(String(url).slice(6)) : url);
  const req = {
    content: String(body.post.content.text || '').slice(0, 2200),
    mediaItems: urls.map((url) => ({ type: 'video', url })),
    platforms: [{ platform: 'tiktok', accountId: zid }],
    tiktokSettings: {
      privacy_level: t.privacyLevel || 'PUBLIC_TO_EVERYONE',
      allow_comment: !t.disabledComments, allow_duet: !t.disabledDuet, allow_stitch: !t.disabledStitch,
      video_made_with_ai: t.isAiGenerated !== false,           // 합성 음성 — 표시를 끄지 않는다(blotato_accounts 메모)
      content_preview_confirmed: true, express_consent_given: true   // TikTok 법적 필수 동의(Zernio 문서)
    }
  };
  // Blotato 와 같은 뜻: 미래 시각이면 예약, 아니면 즉시
  const when = Date.parse(body.scheduledTime || '');
  if (Number.isFinite(when) && when > Date.now() + 60e3) { req.scheduledFor = new Date(when).toISOString().slice(0, 19); req.timezone = 'UTC'; } else req.publishNow = true;
  const r = await fetch('https://zernio.com/api/v1/posts', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const text = await r.text();
  if (!r.ok) throw new Error(`zernio POST /posts -> ${r.status} ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return { postSubmissionId: `zernio:${j.post?._id || j._id}`, via: 'zernio' };
}

async function api(method, endpoint, body) {
  const off = routes.blotatoOff();
  if (method === 'POST' && endpoint === '/posts') {
    const platform = body?.post?.content?.platform;
    if (platform === 'tiktok') {
      const hold = routes.tiktokHold(body.post.accountId);
      if (hold) return routes.skipped(hold);
      if (off && !zernioTarget(endpoint, body)) return routes.skipped('zernio_unmapped');
    } else if (off) return routes.skipped('blotato_off');
  }
  // 건너뛴 글의 상태 조회·예약 취소(check-claims 등)
  if (/^\/(?:posts|schedules)\/skip:/.test(endpoint)) return method === 'DELETE' ? { ok: true } : { status: 'skipped', publicUrl: '' };
  const zid = method === 'POST' ? zernioTarget(endpoint, body) : '';
  if (zid) return zernioPost(zid, body);
  // Zernio 로 보낸 글의 상태 조회·예약 취소(check-claims 의 cancelSocialForDraft 등) — 같은 경로로 받아 Zernio 에 묻는다
  const zm = /^\/(?:posts|schedules)\/zernio:([\w-]+)$/.exec(endpoint);
  if (zm) {
    const r = await fetch(`https://zernio.com/api/v1/posts/${zm[1]}`, { method: method === 'DELETE' ? 'DELETE' : 'GET', headers: { Authorization: `Bearer ${String(process.env.ZERNIO_API_KEY || '').trim()}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`zernio ${method} /posts/${zm[1]} -> ${r.status} ${text.slice(0, 200)}`);
    const j = text ? JSON.parse(text) : {};
    const p = j.post || j;
    return method === 'DELETE' ? { ok: true } : { status: p.status, publicUrl: (p.platforms || [])[0]?.platformPostUrl || '' };
  }
  if (off) throw routes.offError(`${method} ${endpoint}`);
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: { 'blotato-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  if (!response.ok) {
    const detail = parsed ? JSON.stringify(parsed).slice(0, 300) : text.slice(0, 300);
    throw new Error(`${method} ${endpoint} -> ${response.status} ${detail}`);
  }
  return parsed;
}

// Local mp4 -> presigned PUT -> public URL Blotato can fetch when it publishes.
// 틱톡이 Zernio 로 가는 계정이면 영상도 Zernio 저장소에 올린다 — Blotato 저장소를 안 거친다.
// /v1/media/presign 은 Blotato /media/uploads 와 같은 모양이다(presign → PUT → publicUrl).
function zernioIdFor(accountId) {
  try { return JSON.parse(fs.readFileSync(ZERNIO_MAP_PATH, 'utf8')).tiktok?.[String(accountId)] || ''; } catch { return ''; }
}
async function zernioUpload(filePath) {
  // 틱톡 보류 중(publish_routes tiktok.hold)엔 Zernio 저장소에 미리 올리지 않는다 — 실제 글이 나갈 때 zernioPost 가 올린다
  if ((routes.routes().tiktok || {}).hold) return `local:${path.resolve(filePath)}`;
  return zernioUploadNow(filePath);
}
async function zernioUploadNow(filePath) {
  const key = String(process.env.ZERNIO_API_KEY || '').trim();
  if (!key) throw new Error('ZERNIO_API_KEY 가 .env 에 없다');
  const bytes = fs.readFileSync(filePath);
  const r = await fetch('https://zernio.com/api/v1/media/presign', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: path.basename(filePath), contentType: 'video/mp4', size: bytes.length })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`zernio POST /media/presign -> ${r.status} ${text.slice(0, 300)}`);
  const { uploadUrl, publicUrl } = JSON.parse(text);
  if (!uploadUrl || !publicUrl) throw new Error('zernio presign 이 URL 을 안 줬다');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes
  });
  if (!put.ok) throw new Error(`zernio presigned PUT -> ${put.status} ${(await put.text()).slice(0, 200)}`);
  return publicUrl;
}

async function uploadLocalFile(filePath) {
  // Blotato 꺼짐: 아무 데도 안 올리고 표시만 — 틱톡(Zernio) 글이면 zernioPost 가 그때 올리고, 메타 글은 어차피 건너뛴다
  if (routes.blotatoOff()) return `local:${path.resolve(filePath)}`;
  const filename = path.basename(filePath);
  const { presignedUrl, publicUrl } = await api('POST', '/media/uploads', { filename });
  if (!presignedUrl || !publicUrl) throw new Error('presigned upload returned no URL');
  const bytes = fs.readFileSync(filePath);
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes
  });
  if (!put.ok) throw new Error(`presigned PUT -> ${put.status} ${(await put.text()).slice(0, 200)}`);
  return publicUrl;
}

// Sections look like "[Instagram Reels] ...\n====\n(캡션 ...)\n<body>\n\n(해시태그 ...)\n#a #b".
// Same shape build-upload-metadata.js parses for [YouTube]; only the label differs.
function parseSection(text, labels) {
  for (const label of labels) {
    const head = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = new RegExp(`\\[${head}[^\\]]*\\][^\\n]*\\n=+\\n([\\s\\S]*?)(?:\\n=+\\n|$)`, 'i')
      .exec(String(text || ''));
    if (!section) continue;
    const body = section[1];
    // Same empty-field trap as build-upload-metadata.js: consume only the label line, and
    // treat a capture that is itself a "(label)" as empty, so an unfilled package reads empty
    // instead of shipping the template scaffolding as a caption.
    const grab = (field) => {
      const m = new RegExp(`\\(${field}[^)]*\\)[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*\\(|$)`).exec(body);
      const value = m ? m[1].trim() : '';
      return value.startsWith('(') ? '' : value;
    };
    const caption = grab('캡션') || grab('본문');
    const hashtags = [...String(grab('해시태그')).matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
    return { caption, hashtags };
  }
  return null;
}

// Caption + hashtags, trimmed to the platform contract already written in platform_post_specs.
function composeText(section, spec) {
  const max = Number(spec?.hashtags?.max ?? 3);
  const tags = section.hashtags.slice(0, Math.max(0, max));
  const text = tags.length ? `${section.caption}\n\n${tags.map((t) => `#${t}`).join(' ')}` : section.caption;
  const capMax = Number(spec?.caption_max || 2200);
  return text.length > capMax ? text.slice(0, capMax) : text;
}

// Platform-specific target block. Every required field from blotato_list_accounts lives here.
function buildTarget(platform, mapping, options) {
  if (platform === 'instagram') {
    return { targetType: 'instagram', mediaType: 'reel', shareToFeed: true };
  }
  if (platform === 'threads') {
    return { targetType: 'threads', replyControl: 'everyone' };
  }
  if (platform === 'facebook') {
    if (!mapping.pageId) throw new Error('facebook mapping has no pageId — page not connected');
    return { targetType: 'facebook', pageId: String(mapping.pageId), mediaType: 'reel' };
  }
  if (platform === 'tiktok') {
    return {
      targetType: 'tiktok',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      disabledComments: false,
      disabledDuet: false,
      disabledStitch: false,
      isBrandedContent: false,
      isYourBrand: false,
      // TTS narration is synthetic voice, so the AIGC flag is the honest declaration.
      // Undisclosed AI audio is a takedown risk on TikTok; disclosing costs nothing.
      isAiGenerated: options.isAiGenerated !== false
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

function localeOf(folderName) {
  const m = /-(ko|ja)$/.exec(String(folderName || ''));
  return m ? m[1] : '';
}

function discoverDrafts({ prefix, only }) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR)
    .filter((name) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(name))
    .filter((name) => !prefix || name.startsWith(prefix))
    .filter((name) => !only || name === only)
    .map((name) => path.join(DRAFTS_DIR, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'draft_content.json')))
    .sort();
}

// auto-publish moves the file to uploaded/ once YouTube accepted it; look in both places.
function findMp4(draftName) {
  for (const dir of [EXPORT_DIR, UPLOADED_DIR]) {
    const candidate = path.join(dir, `${draftName}.mp4`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// The platform spec requires TikTok to land at the same clock time as YouTube, so the
// social schedule is derived from what auto-publish already booked for this draft.
function youtubePublishAt(draftName) {
  const state = readJson(YT_STATE_PATH, { history: [] });
  const entry = (state.history || []).find((h) => h.draft === draftName && h.publishAt);
  if (entry) return entry.publishAt;
  // ★유튜브가 Content ID 로 막은 편도 다른 플랫폼에는 올린다 (소유주 지시 2026-09-23).
  //   "타 플랫폼은 재사용 컨텐츠에 대해 상대적으로 다른 정책을 가지고 있기도 하고.
  //    올려야 돼 버리지 말고 — 그야말로 낭비한 거야 버리게 되면."
  //   check-claims 가 publishAt 을 지울 때 blockedPublishAt 에 옮겨 둔다. 그걸 물려 쓴다.
  //   그 시각은 대개 이미 지났지만 scheduleFor() 가 «지금 + 3분»으로 당겨 준다.
  const blocked = (state.history || []).find((h) => h.draft === draftName && h.blockedPublishAt);
  if (blocked) return blocked.blockedPublishAt;
  // ★유튜브에 «아예 안 올린» 편도 소셜에는 올린다 (2026-09-23).
  //   차단본만 살려 놨더니 유튜브 이력이 통째로 없는 편(다른 채널 것, 유튜브 슬롯을 못 잡은 것)이
  //   계속 SKIP 됐다. 소셜은 유튜브의 부속이 아니다 — 시각만 물려 쓸 뿐이다.
  //   기준 시각이 없으면 «지금»으로 둔다. scheduleFor() 가 지금+3분으로 잡아 준다.
  return new Date().toISOString();
}

function warmupActive(args) {
  if (args.noWarmup) return false;
  return new Date().toISOString().slice(0, 10) <= WARMUP_UNTIL;
}

// Minutes of headroom when the inherited publishAt has already passed.
const PAST_CLAMP_MIN = 3;

function scheduleFor(baseIso, platform, warmup) {
  if (!baseIso) return '';
  const offset = warmup ? Number(STAGGER_MIN[platform] || 0) : 0;
  const wanted = Date.parse(baseIso) + offset * 60 * 1000;
  // The YouTube publishAt this inherits is in the past whenever the fan-out runs after the
  // cut went public - a fan-out skipped for a day, or one recovered by hand. Blotato rejects
  // that with 422 "Cannot schedule a post in the past", which made those videos permanently
  // unreachable on the reach axis (War Dogs ko, 2026-09-05). Post them shortly from now
  // instead, keeping the per-platform stagger.
  const floor = Date.now() + PAST_CLAMP_MIN * 60 * 1000 + offset * 60 * 1000;
  return new Date(Math.max(wanted, floor)).toISOString();
}

// One post per account per day while warming up — counted from what we already shipped.
function warmupBlocked(state, locale, platform, dayKey) {
  return (state.history || []).some((h) => h.locale === locale
    && h.platform === platform
    && String(h.scheduledTime || h.at || '').slice(0, 10) === dayKey);
}

async function verifyAccounts(config) {
  const live = await api('GET', '/users/me/accounts');
  const rows = Array.isArray(live) ? live : (live.items || live.accounts || []);
  const byId = new Map(rows.map((a) => [String(a.id), a]));
  let drift = 0;
  for (const [locale, entry] of Object.entries(config.locales || {})) {
    for (const [platform, mapping] of Object.entries(entry.platforms || {})) {
      if (mapping.status !== 'connected' || !mapping.accountId) continue;
      const live_ = byId.get(String(mapping.accountId));
      if (!live_) {
        console.log(`  DRIFT ${locale}/${platform}: accountId ${mapping.accountId} not in workspace`);
        drift += 1;
        continue;
      }
      // GET /users/me/accounts does not return subaccounts — pages only show up in the MCP
      // listing. So a pageId can be checked only when the row happens to carry them; absent
      // the field there is nothing to compare against and silence is not drift.
      if (platform === 'facebook' && mapping.pageId && Array.isArray(live_.subaccounts)) {
        const pages = live_.subaccounts.map((s) => String(s.id));
        if (!pages.includes(String(mapping.pageId))) {
          console.log(`  DRIFT ${locale}/facebook: pageId ${mapping.pageId} not among [${pages.join(', ') || 'none'}]`);
          drift += 1;
          continue;
        }
      }
      console.log(`  ok ${locale}/${platform}: ${mapping.accountId}${mapping.pageId ? ` page ${mapping.pageId}` : ''}`);
    }
  }
  console.log(drift ? `${drift} mapping(s) drifted — fix blotato_accounts.json` : 'mapping matches workspace');
  return drift;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = readJson(ACCOUNTS_PATH, null);
  if (!config) throw new Error(`cannot read ${ACCOUNTS_PATH}`);
  const specs = readJson(SPECS_PATH, { platforms: {} });

  if (args.verifyAccounts) {
    process.exitCode = (await verifyAccounts(config)) ? 1 : 0;
    return;
  }

  const state = readJson(STATE_PATH, { history: [] });
  const done = new Set((state.history || []).map((h) => `${h.draft}:${h.platform}`));
  const warmup = warmupActive(args);
  const wanted = args.platforms || FAN_OUT;
  const lines = [`# blotato-publish ${new Date().toISOString()}${warmup ? ' (warmup)' : ''}`, ''];

  let targets = discoverDrafts(args);
  if (args.limit > 0) targets = targets.slice(0, args.limit);
  console.log(`targets: ${targets.length} draft folder(s)${warmup ? ' | warmup active' : ''}`);

  for (const draftDir of targets) {
    const draftName = path.basename(draftDir);
    const locale = localeOf(draftName);
    const entry = config.locales?.[locale];
    if (!entry) { lines.push(`- SKIP(no ${locale} mapping): ${draftName}`); continue; }

    const socialPath = path.join(draftDir, `social_posts.${locale}.txt`);
    if (!fs.existsSync(socialPath)) {
      lines.push(`- SKIP(no publish package): ${draftName}`);
      continue;
    }
    const socialText = fs.readFileSync(socialPath, 'utf8');

    const mp4Path = findMp4(draftName);
    if (!mp4Path) { lines.push(`- SKIP(no exported mp4): ${draftName}`); continue; }

    const baseIso = youtubePublishAt(draftName);
    if (!baseIso) {
      // Without a YouTube booking there is no agreed clock; publishing now would break the
      // "same time as YouTube" contract and skip the Content ID window.
      lines.push(`- SKIP(no YouTube publishAt yet — run auto-publish first): ${draftName}`);
      continue;
    }

    let mediaUrl = (state.media || {})[draftName] || '';

    for (const platform of wanted) {
      const mapping = entry.platforms?.[platform];
      if (!mapping) continue;
      if (mapping.status !== 'connected') {
        lines.push(`- ${platform} ${mapping.status} [${locale}]: ${draftName} — ${mapping.status === 'manual_only' ? '수동 발행' : 'Blotato 대상 아님'}`);
        continue;
      }
      if (done.has(`${draftName}:${platform}`)) continue;

      const spec = specs.platforms?.[platform] || {};
      const section = parseSection(socialText, [spec.label, platform].filter(Boolean));
      if (!section || !section.caption) {
        lines.push(`- SKIP(no [${spec.label || platform}] section): ${draftName}`);
        continue;
      }

      const scheduledTime = scheduleFor(baseIso, platform, warmup);
      const dayKey = scheduledTime.slice(0, 10);
      if (warmup && warmupBlocked(state, locale, platform, dayKey)) {
        lines.push(`- HOLD(warmup 1/day) ${platform} [${locale}]: ${draftName}`);
        continue;
      }

      const text = composeText(section, spec);
      let target;
      try { target = buildTarget(platform, mapping, {}); }
      catch (error) { lines.push(`- FAIL ${platform} [${locale}]: ${draftName} — ${error.message}`); continue; }

      if (args.dryRun) {
        console.log(`[dry-run] ${locale}/${platform} @ ${scheduledTime}: ${text.slice(0, 60).replace(/\n/g, ' ')}…`);
        lines.push(`- dry-run ${platform} [${locale}] ${scheduledTime}: ${draftName}`);
        continue;
      }

      try {
        // 틱톡이 Zernio 로 가는 계정이면 미디어도 Zernio 에 올린다(Blotato 스토리지를 안 거친다).
        const toZernio = platform === 'tiktok' && !!zernioIdFor(mapping.accountId);
        let postUrl;
        if (toZernio) {
          postUrl = (state.mediaZernio || {})[draftName] || '';
          if (!postUrl) {
            console.log(`[media:zernio] uploading ${path.basename(mp4Path)}`);
            postUrl = await zernioUpload(mp4Path);
            state.mediaZernio = { ...(state.mediaZernio || {}), [draftName]: postUrl };
            writeState(state);
          }
        } else {
          if (!mediaUrl) {
            console.log(`[media] uploading ${path.basename(mp4Path)}`);
            mediaUrl = await uploadLocalFile(mp4Path);
            state.media = { ...(state.media || {}), [draftName]: mediaUrl };
            writeState(state);
          }
          postUrl = mediaUrl;
        }
        const result = await api('POST', '/posts', {
          post: {
            accountId: String(mapping.accountId),
            content: { text, mediaUrls: [postUrl], platform },
            target
          },
          scheduledTime
        });
        const id = result?.postSubmissionId || result?.id || 'submitted';
        if (result?.skipped === 'zernio_hold') { lines.push(`- SKIP(zernio_hold) ${platform} [${locale}]: ${draftName}`); continue; }
        console.log(`[post] ${locale}/${platform} @ ${scheduledTime} -> ${id}`);
        lines.push(result?.skipped ? `- SKIP(${result.skipped}) ${platform} [${locale}]: ${draftName}` : `- OK ${platform} [${locale}] ${scheduledTime}: ${draftName} (${id})`);
        state.history = [...(state.history || []), {
          at: new Date().toISOString(),
          draft: draftName,
          locale,
          platform,
          accountId: String(mapping.accountId),
          scheduledTime,
          submissionId: String(id)
        }].slice(-1000);
        writeState(state);
      } catch (error) {
        console.log(`[fail] ${locale}/${platform}: ${error.message}`);
        lines.push(`- FAIL ${platform} [${locale}]: ${draftName} — ${error.message}`);
      }
    }
  }

  lines.push('', '## 수동 발행 잔여',
    '- ko Facebook: 수익화가 개인 프로필에 있어 서드파티 발행 불가 — 비즈니스 스위트 직접(크로스포스트 해제).',
    '- ko 네이버 클립: Blotato 미지원 — 앱 직접 업로드, 정보태그 필수.');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-blotato-publish.md`);
  fs.appendFileSync(reportPath, `${lines.join('\n')}\n\n`, 'utf8');
  console.log(`report: ${reportPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('blotato-publish fatal:', error.message || error);
    process.exitCode = 1;
  });
}

// 린박스는 캡컷 드래프트를 만들지 않으므로 discoverDrafts 가 못 본다(rinbox-social.js 가 따로 찾는다).
// 다만 **Blotato 로 말하는 부분**은 한 곳이어야 한다 — 업로드·타깃 블록·과거시각 클램프는
// 사고를 한 번씩 겪고 고친 자리다(War Dogs ko 422, facebook pageId 누락). 복제하면 갈라진다.
module.exports = {
  api, uploadLocalFile, API_BASE, zernioUpload, zernioIdFor,
  parseSection, composeText, buildTarget, scheduleFor, localeOf, findMp4
};
