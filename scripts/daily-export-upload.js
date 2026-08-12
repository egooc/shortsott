// Export shipped highlight drafts through the real CapCut app, then schedule
// YouTube uploads through Phase 3 (docs/daily-auto-pipeline-plan-2026-08-10.md;
// approved 2026-08-11: first publish at run time + 60min, then one video every
// 120min, private + publishAt scheduling).
//
//   node scripts/daily-export-upload.js [--job job_id] [--all] [--limit N]
//                                       [--skip-export] [--dry-run]
//
// - Picks the latest finished batch job unless --job is given.
// - Exports scorecard-ok drafts only (server/output/scorecards/<job>.json);
//   --all exports every shipped draft. Drafts whose mp4 already exists in the
//   export dir are not re-exported.
// - CapCut export is screen automation (scripts/capcut_export_one.py) and
//   needs an unlocked desktop; run via Task Scheduler, not an agent shell.
// - Upload uses Phase 3 services directly: importUploadFiles matches each mp4
//   to its metadata TXT (from the batch's _metadata_exports), then one upload
//   job is created with per-item publishAt and started.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { listJobs } = require('../server/services/processJobService');
const {
  importUploadFiles,
  createUploadJob,
  startUploadJob,
  listUploadJobs
} = require('../server/services/youtubeUploadService');

const EXPORT_DIR = 'C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/_automation factory';
const FIRST_PUBLISH_DELAY_MIN = 60;
const PUBLISH_INTERVAL_MIN = 120;
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'daily-reports');

function parseArgs(argv) {
  const args = { all: false, limit: 0, dryRun: false, skipExport: false, job: '' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--skip-export') args.skipExport = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[i + 1]) || 0, i += 1;
    else if (argv[i] === '--job') args.job = String(argv[i + 1] || ''), i += 1;
  }
  return args;
}

function latestFinishedJobId() {
  const jobs = (listJobs()?.jobs || []).filter((job) => job.finished_at);
  jobs.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  return jobs[0]?.job_id || '';
}

// Shipped highlight drafts with their metadata TXT paths, from the job report.
function collectShippedDrafts(jobId) {
  const db = require(path.join(ROOT, 'server', 'node_modules', 'better-sqlite3'))(
    path.join(ROOT, 'server', 'data', 'process_jobs.db'), { readonly: true });
  const row = db.prepare('select job_json from process_jobs where job_id=?').get(jobId);
  db.close();
  if (!row) throw new Error(`job not found: ${jobId}`);
  const byFolder = new Map();
  const metadataFiles = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const folder = node.highlight_output_folder || node.output_folder
      || node.korean_full_output_folder;
    const window = node.highlight_source_window || node.source_window;
    // Highlight rows carry a source window; Full (F/KF) rows are recognized
    // by their folder code instead.
    const isFullFolder = typeof folder === 'string' && /-K?F-/.test(path.basename(folder));
    if (typeof folder === 'string' && folder && (window || isFullFolder) && !byFolder.has(folder)) {
      byFolder.set(folder, true);
    }
    for (const list of [node.highlight_metadata_export_files, node.metadata_export_files, node.metadata_files]) {
      if (Array.isArray(list)) list.forEach((file) => typeof file === 'string' && file.endsWith('.txt') && metadataFiles.add(file));
    }
    Object.values(node).forEach(visit);
  };
  visit(JSON.parse(row.job_json));
  return { folders: [...byFolder.keys()], metadataFiles: [...metadataFiles] };
}

function scorecardOkFolders(jobId) {
  const scorecardPath = path.join(ROOT, 'server', 'output', 'scorecards', `${jobId}.json`);
  if (!fs.existsSync(scorecardPath)) return null;
  const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
  return new Set(scorecard.rows.filter((r) => r.verdict === 'ok').map((r) => r.folder));
}

function exportDraft(draftName) {
  try {
    const out = execFileSync('python', [
      path.join(ROOT, 'scripts', 'capcut_export_one.py'),
      '--draft-name', draftName,
      '--export-dir', EXPORT_DIR
    ], { encoding: 'utf8', timeout: 10 * 60 * 1000, windowsHide: true });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    const stdout = String(error.stdout || '').trim().split('\n').pop();
    try { return JSON.parse(stdout); } catch { /* fall through */ }
    return { status: 'error', error: String(error.message || error).slice(0, 200) };
  }
}

// Slots are PER CHANNEL: each channel independently publishes its first video
// at +60min and one every 120min after - 12/day/channel fits exactly in 24h,
// and JP/KR channels never compete for slots (approved 2026-08-11).
function publishAtIso(indexInChannel) {
  const at = new Date(Date.now() + (FIRST_PUBLISH_DELAY_MIN + indexInChannel * PUBLISH_INTERVAL_MIN) * 60 * 1000);
  return at.toISOString();
}

async function main() {
  const args = parseArgs(process.argv);
  // --job accepts a comma-separated list: a logical batch can span several
  // job records (e.g. a draft-stage retry), and separate runs would double-
  // book the per-channel publishAt slots.
  const jobIds = String(args.job || latestFinishedJobId() || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!jobIds.length) throw new Error('no finished batch job found');
  const jobId = jobIds[0];
  const folders = [...new Set(jobIds.flatMap((id) => collectShippedDrafts(id).folders))];
  const okSet = args.all ? null : scorecardOkFolders(jobId);
  const lines = [`# 내보내기+업로드 리포트 ${new Date().toISOString()}`, `- job: ${jobIds.join(', ')}`, ''];

  let targets = folders.filter((folder) => fs.existsSync(folder));
  // HOLD (2026-08-12, user directive): KR Full (F/KF) drafts must NOT be
  // auto-exported/uploaded until the user confirms the draft quality in
  // CapCut. Highlights (H) keep flowing. Flip to false after confirmation.
  // User confirmed the KR Full draft quality 2026-08-12 (bold caption face
  // included) - exports resumed.
  const HOLD_KR_FULL_EXPORT = false;
  if (HOLD_KR_FULL_EXPORT) {
    const held = targets.filter((folder) => /-K?F-/.test(path.basename(folder)));
    if (held.length) {
      lines.push(`- KR Full 보류(드래프트 컨펌 대기): ${held.length}건`, ...held.map((folder) => `  - ${path.basename(folder)}`), '');
      console.log(`KR Full hold: ${held.length} draft(s) skipped pending user confirmation`);
    }
    targets = targets.filter((folder) => !/-K?F-/.test(path.basename(folder)));
  }
  // The scorecard only judges highlight arcs; Full (F/KF) drafts bypass it.
  if (okSet) {
    targets = targets.filter((folder) =>
      /-K?F-/.test(path.basename(folder)) || okSet.has(path.basename(folder)));
  }
  // Anything already moved to uploaded/ has been published - never redo it.
  // CapCut truncates long export names (H03 once lost its " Hnn" suffix), so
  // match by prefix in either direction instead of exact name.
  const uploadedDir = path.join(EXPORT_DIR, 'uploaded');
  const uploadedStems = fs.existsSync(uploadedDir)
    ? fs.readdirSync(uploadedDir).filter((f) => f.endsWith('.mp4')).map((f) => f.replace(/\(\d+\)\.mp4$|\.mp4$/, ''))
    : [];
  const alreadyUploaded = (draftName) => uploadedStems.some((stem) =>
    stem.length >= 20 && (draftName.startsWith(stem) || stem.startsWith(draftName)));
  targets = targets.filter((folder) => !alreadyUploaded(path.basename(folder)));
  if (args.limit > 0) targets = targets.slice(0, args.limit);
  console.log(`job ${jobId}: ${folders.length} shipped, ${targets.length} targeted${okSet ? ' (scorecard ok)' : ''}`);

  // 1. Export via CapCut (skip drafts already exported)
  const exported = [];
  for (const folder of targets) {
    const draftName = path.basename(folder);
    const expectedPath = path.join(EXPORT_DIR, `${draftName}.mp4`);
    if (fs.existsSync(expectedPath)) {
      console.log(`[skip-export] already exists: ${draftName}`);
      exported.push({ draftName, outputPath: expectedPath, reused: true });
      continue;
    }
    if (args.skipExport) continue;
    if (args.dryRun) { console.log(`[dry-run] would export: ${draftName}`); continue; }
    console.log(`[export] ${draftName}`);
    const result = exportDraft(draftName);
    console.log(`  -> ${result.status} (${result.elapsed_sec || '?'}s)`);
    lines.push(`- export ${result.status}: ${draftName}`);
    if (result.status === 'exported') {
      // CapCut truncates long export names and appends "(1)" on collision -
      // that broke TXT metadata matching once (2026-08-12, H-053808 H02 went
      // out with a folder-name fallback title). Rename the fresh file to the
      // full draft name so the matcher always sees the canonical name.
      let outputPath = result.output_path;
      const canonicalPath = path.join(EXPORT_DIR, `${draftName}.mp4`);
      if (outputPath && path.resolve(outputPath) !== path.resolve(canonicalPath) && fs.existsSync(outputPath) && !fs.existsSync(canonicalPath)) {
        fs.renameSync(outputPath, canonicalPath);
        console.log(`  -> renamed to canonical: ${path.basename(canonicalPath)}`);
        outputPath = canonicalPath;
      }
      exported.push({ draftName, outputPath });
    }
  }

  if (args.dryRun || !exported.length) {
    console.log(args.dryRun ? 'dry-run done' : 'nothing exported; stopping before upload');
    return;
  }

  // 2. Match metadata + create upload candidates. TXTs come from scanning
  // _metadata_exports directly (job-report paths proved unreliable); the
  // production fuzzy matcher pairs them with the videos.
  const videoFiles = exported.map((entry) => ({
    originalname: path.basename(entry.outputPath),
    path: entry.outputPath
  }));
  // Directory scan only - mixing in job-report paths once produced DUPLICATE
  // records for the same TXT (path strings differed), and two records under
  // one key makes the matcher treat every video as ambiguous and fall back.
  const metadataRoot = path.join(path.dirname(EXPORT_DIR), '_metadata_exports');
  const metadataInputs = [];
  const seenNames = new Set();
  if (fs.existsSync(metadataRoot)) {
    const dateDirs = fs.readdirSync(metadataRoot).sort().slice(-4);
    for (const dateDir of dateDirs) {
      for (const file of fs.readdirSync(path.join(metadataRoot, dateDir))) {
        if (file.endsWith('.txt') && !seenNames.has(file)) {
          seenNames.add(file);
          metadataInputs.push({ originalname: file, path: path.join(metadataRoot, dateDir, file) });
        }
      }
    }
  }
  const importResult = importUploadFiles({ videoFiles, metadataFiles: metadataInputs });
  (importResult.warnings || []).forEach((warning) => console.log('[match-warning]', warning));

  // 3. Per-variant channel profile (the globally "active" profile may belong
  // to the other channel) + schedule: first at +60min, then every 120min.
  const profileStore = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const profileList = Array.isArray(profileStore.profiles) ? profileStore.profiles : Object.values(profileStore.profiles || {});
  const profileForVariant = (variant) => {
    // Exact purpose first (ko_full -> ko_full profile); fall back to the
    // same-language channel so KR Full still reaches the KR channel while its
    // profile purpose is ko_highlight.
    const isKorean = String(variant).startsWith('ko');
    const wanted = isKorean ? (variant === 'ko_full' ? ['ko_full', 'ko_highlight'] : ['ko_highlight', 'ko_full']) : ['jp_highlight', 'jp_full'];
    for (const purpose of wanted) {
      const candidates = profileList.filter((profile) => (profile.purpose || '') === purpose);
      const connected = candidates.find((profile) => profile.channelTitle || profile.channel_title || profile.channel);
      const chosen = (connected || candidates[0])?.id;
      if (chosen) return chosen;
    }
    return '';
  };
  const channelCounters = new Map();
  const items = importResult.candidates.map((candidate) => {
    const channelKey = String(candidate.variant).startsWith('ko') ? 'ko' : 'ja';
    const indexInChannel = channelCounters.get(channelKey) || 0;
    channelCounters.set(channelKey, indexInChannel + 1);
    return {
      ...candidate,
      uploadProfileId: profileForVariant(candidate.variant),
      privacyStatus: 'private',
      publishAt: publishAtIso(indexInChannel)
    };
  });
  const missingProfile = items.filter((item) => !item.uploadProfileId);
  if (missingProfile.length) {
    throw new Error(`no channel profile for variant(s): ${[...new Set(missingProfile.map((item) => item.variant))].join(', ')}`);
  }
  items.forEach((item) => console.log(`[schedule] ${item.title?.slice(0, 40)} -> ${item.publishAt}`));
  lines.push('', ...items.map((item) => `- 예약 ${item.publishAt}: ${item.originalName}`));

  // 4. Upload job
  const job = createUploadJob(items);
  startUploadJob(job.jobId);
  console.log(`upload job started: ${job.jobId} (${items.length} items)`);

  // Poll until terminal so cron logs carry the outcome.
  for (let i = 0; i < 240; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const current = (listUploadJobs() || []).find((entry) => entry.jobId === job.jobId);
    if (!current) continue;
    if (!['queued', 'running', 'cancelling'].includes(current.status)) {
      console.log(`upload job ${current.status}: success ${current.successCount}/${current.total}`);
      lines.push('', `- upload job ${job.jobId}: ${current.status} (${current.successCount}/${current.total})`);
      // Successful uploads move to uploaded/ so the next run cannot re-upload
      // them (importUploadFiles copies the file, so the original is free).
      if (current.successCount > 0) {
        fs.mkdirSync(uploadedDir, { recursive: true });
        for (const entry of exported) {
          try {
            const target = path.join(uploadedDir, path.basename(entry.outputPath));
            if (fs.existsSync(entry.outputPath)) fs.renameSync(entry.outputPath, target);
          } catch (error) {
            console.log(`[move-warning] ${path.basename(entry.outputPath)}: ${error.message}`);
          }
        }
      }
      break;
    }
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.appendFileSync(path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-upload.md`), `${lines.join('\n')}\n`, 'utf8');
}

main().catch((error) => {
  console.error('daily-export-upload fatal:', error.message || error);
  process.exitCode = 1;
});
