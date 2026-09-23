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

async function api(method, endpoint, body) {
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
async function uploadLocalFile(filePath) {
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
  return blocked ? blocked.blockedPublishAt : '';
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
        if (!mediaUrl) {
          console.log(`[media] uploading ${path.basename(mp4Path)}`);
          mediaUrl = await uploadLocalFile(mp4Path);
          state.media = { ...(state.media || {}), [draftName]: mediaUrl };
          writeState(state);
        }
        const result = await api('POST', '/posts', {
          post: {
            accountId: String(mapping.accountId),
            content: { text, mediaUrls: [mediaUrl], platform },
            target
          },
          scheduledTime
        });
        const id = result?.postSubmissionId || result?.id || 'submitted';
        console.log(`[post] ${locale}/${platform} @ ${scheduledTime} -> ${id}`);
        lines.push(`- OK ${platform} [${locale}] ${scheduledTime}: ${draftName} (${id})`);
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

module.exports = { parseSection, composeText, buildTarget, scheduleFor, localeOf, findMp4 };
