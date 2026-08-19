// Hourly alternating upload (design 2026-08-15, user).
//
// Production and upload are decoupled on purpose. A longform highlight source
// yields up to 5 shorts at once, so "produce one item per hour" cannot map 1:1
// onto "upload one video per hour". Instead the draft pipeline keeps a buffer
// of exported mp4s in the export dir, and this script drains that buffer one
// video per run, alternating channels: JP, then an hour later KR, then JP.
// Each channel therefore publishes every two hours, 24 videos a day across the
// two.
//
// Each video is uploaded now and scheduled to publish one hour later
// (privacyStatus private + publishAt, which is how YouTube expresses a
// scheduled release). With the hourly alternation that puts a JP release and a
// KR release an hour apart, and two hours between releases on the same channel.
//
//   node scripts/hourly-upload.js [--dry-run] [--channel jp|kr]

const PUBLISH_DELAY_MIN = 60;

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  importUploadFiles,
  createUploadJob,
  startUploadJob,
  listUploadJobs,
  loadJob,
  listYouTubeUploadProfiles
} = require('../server/services/youtubeUploadService');

const ROOT = path.join(__dirname, '..');
const EXPORT_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const UPLOADED_DIR = path.join(EXPORT_DIR, 'uploaded');
const HELD_DIR = path.join(EXPORT_DIR, 'held');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'hourly_upload_state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastChannel: '', lastUploadAt: '', history: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// CapCut appends " (1)", "(2)" when a name already exists, so the draft folder
// that holds the metadata TXT is the mp4 name with any such suffix removed.
function draftFolderFor(mp4Name) {
  const base = mp4Name.replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');
  const dir = path.join(DRAFTS_DIR, base);
  return fs.existsSync(dir) ? dir : '';
}

function channelOf(variant) {
  return String(variant || '').startsWith('ko') ? 'kr' : 'jp';
}

// Does this mp4 actually contain the draft it is named after?
//
// The export drives CapCut's GUI, and when its search fails to re-filter it
// opens a different project and the finished file is renamed to the requested
// draft's name - nothing downstream can tell them apart. On 2026-08-17 the same
// silk-weaving video went to YouTube three times under three different titles.
// The draft's timeline length is in its manifest, so a file whose real duration
// does not match is not the video it claims to be, and must not ship.
const DURATION_TOLERANCE_SEC = 1.5;

function contentMatchesDraft(videoPath, draftDir) {
  let expected = 0;
  try {
    expected = Number(JSON.parse(fs.readFileSync(path.join(draftDir, 'edit_manifest.json'), 'utf8')).actual_timeline_duration_sec || 0);
  } catch {
    return { ok: true, reason: 'manifest 없음 - 검사 불가' };
  }
  if (!expected) return { ok: true, reason: 'manifest에 길이 없음' };

  let actual = NaN;
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath
    ], { encoding: 'utf8', timeout: 30000 });
    actual = Number(String(out).trim());
  } catch {
    return { ok: true, reason: 'ffprobe 실패 - 검사 불가' };
  }
  if (!Number.isFinite(actual)) return { ok: true, reason: 'ffprobe 결과 없음' };

  const diff = Math.abs(actual - expected);
  return diff <= DURATION_TOLERANCE_SEC
    ? { ok: true }
    : { ok: false, reason: `manifest ${expected.toFixed(1)}s vs 파일 ${actual.toFixed(1)}s` };
}

// Which queue item a draft was cut from. For a Full this is the identity that
// decides whether it has already been published; the draft folder name is not,
// because every regeneration of a Full makes a new dated folder from the same
// source. Nineteen videos went out across three sources before anyone noticed
// (2026-08-16) - the drafts left over from a week of Full regenerations all
// looked distinct to a name-based check.
function sourceItemOf(draftDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(draftDir, 'edit_manifest.json'), 'utf8'));
    return (String(m.source_video_path || '').split(path.sep).find((p) => /^item_\d+$/.test(p))) || '';
  } catch {
    return '';
  }
}

function profileFor(channel) {
  const raw = listYouTubeUploadProfiles();
  const list = Array.isArray(raw) ? raw : (raw.profiles || []);
  const wantKo = channel === 'kr';
  // listYouTubeUploadProfiles redacts the token itself and exposes
  // hasRefreshToken instead, so the connected check reads that flag.
  return list.find((p) => {
    const isKo = String(p.purpose || '').startsWith('ko');
    return isKo === wantKo && p.hasRefreshToken;
  }) || null;
}

function readyVideos() {
  if (!fs.existsSync(EXPORT_DIR)) return [];
  return fs.readdirSync(EXPORT_DIR)
    .filter((name) => name.toLowerCase().endsWith('.mp4'))
    .map((name) => {
      const full = path.join(EXPORT_DIR, name);
      return { name, full, mtime: fs.statSync(full).mtimeMs, draftDir: draftFolderFor(name) };
    })
    .filter((entry) => entry.draftDir)
    .sort((a, b) => a.mtime - b.mtime);
}

// The manifest is the source of truth for the public title/description: the
// metadata TXT was mis-tagged for the ja_full lane before 2026-08-14 and older
// drafts in the buffer still carry Korean upload fields under Japanese
// captions.
function manifestOverrides(draftDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(draftDir, 'edit_manifest.json'), 'utf8'));
    const out = {};
    if (m.upload_title) out.title = String(m.upload_title).slice(0, 100);
    if (m.upload_description) out.description = String(m.upload_description);
    if (Array.isArray(m.upload_hashtags)) out.tags = m.upload_hashtags.map((t) => String(t).replace(/^#/, ''));
    return out;
  } catch {
    return {};
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const forced = (argv.find((a) => a.startsWith('--channel')) || '').split('=')[1]
    || (argv.includes('--channel') ? argv[argv.indexOf('--channel') + 1] : '');

  const state = readState();
  const target = forced || (state.lastChannel === 'jp' ? 'kr' : 'jp');
  console.log(`target channel: ${target} (last: ${state.lastChannel || 'none'})`);

  const pool = readyVideos();
  console.log(`ready buffer: ${pool.length} mp4`);

  // One draft must never ship twice. Repeated export attempts leave "(1)",
  // "(2)" copies of the same draft in the buffer, and treating each file as its
  // own video put the same 玉子焼き Full on the JP channel four times and the
  // same KR Full three times (2026-08-15). Identity is the draft name with any
  // copy suffix removed, checked against everything already uploaded.
  const alreadyUploaded = new Set(
    (state.history || []).map((h) => String(h.file || '').replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, ''))
  );

  // A Full is the whole process of one source summarized, so a source gets
  // exactly one of them - ever. Highlights are deliberately several per source
  // (different windows, different moments), so they are left to the per-draft
  // check above.
  const publishedFullSources = new Set();
  for (const entry of state.history || []) {
    const draftName = String(entry.file || '').replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');
    if (!/-F-/.test(draftName)) continue;
    const item = sourceItemOf(path.join(DRAFTS_DIR, draftName));
    if (item) publishedFullSources.add(item);
  }

  function pickFor(wanted) {
    for (const entry of pool) {
      const draftName = entry.name.replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');
      if (alreadyUploaded.has(draftName)) {
        console.log(`skip duplicate of already-uploaded draft: ${entry.name}`);
        continue;
      }
      if (/-F-/.test(draftName)) {
        const item = sourceItemOf(entry.draftDir);
        if (item && publishedFullSources.has(item)) {
          console.log(`skip Full from an already-published source (${item}): ${entry.name}`);
          continue;
        }
      }
      const content = contentMatchesDraft(entry.full, entry.draftDir);
      if (!content.ok) {
        // Hold it rather than skip: left in place it would be reconsidered every
        // hour, and it is not a video anyone should ship.
        try {
          fs.mkdirSync(HELD_DIR, { recursive: true });
          fs.renameSync(entry.full, path.join(HELD_DIR, entry.name));
        } catch { /* best effort */ }
        console.log(`held (content does not match its draft): ${entry.name} — ${content.reason}`);
        continue;
      }
      const txt = fs.readdirSync(entry.draftDir).find((n) => n.toLowerCase().endsWith('.txt'));
      if (!txt) continue;
      const imported = importUploadFiles({
        videoFiles: [{ originalname: entry.name, path: entry.full }],
        metadataFiles: [{ originalname: txt, path: path.join(entry.draftDir, txt) }]
      });
      const first = (imported.candidates || [])[0];
      if (!first) continue;
      if (channelOf(first.variant) !== wanted) continue;
      return { entry, candidate: first };
    }
    return null;
  }

  // Strict alternation deadlocks the whole line when one side runs dry: an hour
  // with no KR video uploads nothing, so lastChannel never advances and the next
  // hour targets KR again. Measured 2026-08-15 21:00 KST, with 23 JP videos
  // sitting in the buffer unable to ship behind a single missing KR one.
  // So a starved turn yields to the other channel instead of idling. The target
  // is still whatever the alternation asks for, and it is retried every hour, so
  // the JP/KR split re-balances by itself once the starved side has stock again.
  let hit = pickFor(target);
  let channel = target;
  if (!hit && !forced) {
    const other = target === 'jp' ? 'kr' : 'jp';
    hit = pickFor(other);
    if (hit) {
      channel = other;
      console.log(`no ${target} video ready; falling back to ${other} to keep the hour`);
    }
  }

  if (!hit) {
    console.log(`nothing ready for ${target}; buffer has no matching video`);
    return;
  }
  const picked = hit.entry;
  const candidate = hit.candidate;

  const profile = profileFor(channel);
  if (!profile) throw new Error(`no connected upload profile for channel ${channel}`);
  console.log(`profile: ${profile.id} / ${profile.channelTitle || profile.name}`);

  const item = {
    ...candidate,
    ...manifestOverrides(picked.draftDir),
    profileId: profile.id,
    privacyStatus: 'private',
    publishAt: new Date(Date.now() + PUBLISH_DELAY_MIN * 60 * 1000).toISOString()
  };
  console.log(`picked: ${picked.name}`);
  console.log(`variant: ${item.variant} | title: ${String(item.title).slice(0, 60)}`);
  console.log(`publishAt: ${item.publishAt} (KST ${new Date(item.publishAt).toLocaleString('ko-KR')})`);

  if (dryRun) {
    console.log('dry-run; not uploading');
    return;
  }

  const job = createUploadJob([item]);
  startUploadJob(job.jobId);
  console.log(`upload job: ${job.jobId}`);

  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    const cur = (listUploadJobs() || []).find((e) => e.jobId === job.jobId);
    if (!cur || ['queued', 'running', 'cancelling'].includes(cur.status)) continue;

    const full = loadJob(job.jobId);
    const uploaded = (full.items || [])[0] || {};
    console.log(`RESULT ${cur.status}: ${cur.successCount}/${cur.total} | ${uploaded.youtubeUrl || uploaded.error || ''}`);

    if (cur.successCount > 0) {
      fs.mkdirSync(UPLOADED_DIR, { recursive: true });
      fs.renameSync(picked.full, path.join(UPLOADED_DIR, picked.name));
      state.lastChannel = channel;
      state.lastUploadAt = new Date().toISOString();
      state.history = [...(state.history || []), {
        at: state.lastUploadAt,
        channel,
        file: picked.name,
        url: uploaded.youtubeUrl || ''
      }].slice(-200);
      writeState(state);
      console.log('moved to uploaded/ and state updated');
    }
    return;
  }
  console.log('TIMEOUT waiting for upload job');
}

main().catch((error) => {
  console.error('FAILED:', String(error.message || error).slice(0, 400));
  process.exit(1);
});
