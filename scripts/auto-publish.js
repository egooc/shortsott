// midform full publish chain: installed CapCut drafts -> real CapCut export -> verified mp4
// -> loudness-normalized -> scheduled YouTube upload on the right channel (KR/JP).
//
//   node scripts/auto-publish.js [--prefix 20260819a] [--only <folder>] [--dry-run]
//                                [--skip-export] [--limit N]
//
// - Discovers installed draft folders (<date>-<name>-<ko|ja>) under the CapCut Drafts dir.
// - CapCut export is screen automation (scripts/capcut_export_one.py): unlocked desktop only,
//   one draft at a time, CapCut relaunched per draft.
// - A fresh mp4 ships only if ffprobe duration matches the draft manifest (the silk-weaving
//   incident: a failed in-app search exports a DIFFERENT project under the requested name).
// - Uploads are private + publishAt. Slots are per channel: first at +60min, then every
//   120min — the claim-check window before publishAt is the Content ID preflight layer 3;
//   the run report says exactly what to glance at in Studio.
// - State (server/data/auto_publish_state.json) remembers what shipped; a draft never ships
//   twice, including "(1)" copy-suffix exports of the same draft.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const {
  listYouTubeUploadProfiles,
  createUploadJob,
  startUploadJob,
  listUploadJobs,
  loadJob
} = require('../server/services/youtubeUploadService');
const { normalizeUploadLoudness } = require('../server/services/uploadLoudnessService');
const { buildUploadMeta } = require('./build-upload-metadata');

const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const UPLOADED_DIR = path.join(EXPORT_DIR, 'uploaded');
const HELD_DIR = path.join(EXPORT_DIR, 'held');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'auto-publish-reports');

const FIRST_PUBLISH_DELAY_MIN = 60;
const PUBLISH_INTERVAL_MIN = 120;
const DURATION_TOLERANCE_SEC = 2.0;

function parseArgs(argv) {
  const args = { prefix: '', only: '', dryRun: false, skipExport: false, limit: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--skip-export') args.skipExport = true;
    else if (argv[i] === '--prefix') { args.prefix = String(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--only') { args.only = String(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--limit') { args.limit = Number(argv[i + 1]) || 0; i += 1; }
  }
  return args;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { history: [] }; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function canonicalName(mp4OrFolder) {
  return String(mp4OrFolder).replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');
}

function discoverDrafts({ prefix, only }) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR)
    .filter((name) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(name))
    .filter((name) => !prefix || name.startsWith(prefix))
    .filter((name) => !only || name === only)
    .map((name) => path.join(DRAFTS_DIR, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'draft_content.json'))
      && fs.existsSync(path.join(dir, 'edit_manifest.json')))
    .sort();
}

function manifestDurationSec(draftDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(draftDir, 'edit_manifest.json'), 'utf8'));
    if (Number(m.actual_timeline_duration_sec)) return Number(m.actual_timeline_duration_sec);
    if (Number(m.total_video_duration_sec)) return Number(m.total_video_duration_sec);
    const segs = m.segments || [];
    return segs.length
      ? Math.max(...segs.map((s) => (s.timeline_start_sec || 0) + (s.timeline_duration_sec || 0)))
      : 0;
  } catch { return 0; }
}

function ffprobeDurationSec(videoPath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath
    ], { encoding: 'utf8', timeout: 30000 });
    return Number(String(out).trim());
  } catch { return NaN; }
}

function exportDraft(draftName) {
  try {
    const out = execFileSync('python', [
      path.join(ROOT, 'scripts', 'capcut_export_one.py'),
      '--draft-name', draftName,
      '--export-dir', EXPORT_DIR
    ], { encoding: 'utf8', timeout: 12 * 60 * 1000, windowsHide: true });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    const lastLine = String(error.stdout || '').trim().split('\n').pop();
    try { return JSON.parse(lastLine); } catch { /* fall through */ }
    return { status: 'error', error: String(error.message || error).slice(0, 200) };
  }
}

function profileByPurpose(purpose) {
  const raw = listYouTubeUploadProfiles();
  const list = Array.isArray(raw) ? raw : (raw.profiles || []);
  // The listing redacts the token; midform's service exposes maskedRefreshToken,
  // the newer content-pipeline service exposes hasRefreshToken. Either means connected.
  return list.find((p) => String(p.purpose || '') === purpose
    && (p.hasRefreshToken || p.maskedRefreshToken)) || null;
}

async function main() {
  const args = parseArgs(process.argv);
  const state = readState();
  const lines = [`# auto-publish ${new Date().toISOString()}`, ''];
  const shipped = new Set((state.history || []).map((h) => canonicalName(h.draft || h.file || '')));

  let targets = discoverDrafts(args)
    .filter((dir) => !shipped.has(canonicalName(path.basename(dir))));
  if (args.limit > 0) targets = targets.slice(0, args.limit);
  console.log(`targets: ${targets.length} draft folder(s)`);
  if (!targets.length) return;

  const profiles = {
    ko: profileByPurpose('ko_highlight'),
    ja: profileByPurpose('jp_highlight')
  };
  for (const [loc, prof] of Object.entries(profiles)) {
    console.log(`${loc} channel: ${prof ? `${prof.channelTitle || prof.id}` : 'NOT CONNECTED — this locale will be skipped'}`);
  }

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const channelCounters = new Map();
  const items = [];

  for (const draftDir of targets) {
    const draftName = path.basename(draftDir);
    const locale = /-ja$/.test(draftName) ? 'ja' : 'ko';
    if (!profiles[locale]) { lines.push(`- SKIP(no ${locale} profile): ${draftName}`); continue; }

    // 1. Metadata first: a draft that cannot build metadata must not be exported at all
    //    (banned distributor / missing publish package).
    let meta;
    try {
      const metaPath = path.join(draftDir, 'upload_meta.json');
      meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        : buildUploadMeta(draftDir);
    } catch (error) {
      console.log(`[meta-fail] ${draftName}: ${error.message}`);
      lines.push(`- META FAIL: ${draftName} — ${error.message}`);
      continue;
    }

    // 2. Export (reuse an existing mp4 from a previous run).
    const mp4Path = path.join(EXPORT_DIR, `${draftName}.mp4`);
    if (!fs.existsSync(mp4Path)) {
      if (args.skipExport) { lines.push(`- SKIP(no mp4, --skip-export): ${draftName}`); continue; }
      if (args.dryRun) { console.log(`[dry-run] would export ${draftName}`); continue; }
      console.log(`[export] ${draftName}`);
      const result = exportDraft(draftName);
      console.log(`  -> ${result.status} (${result.elapsed_sec || '?'}s)`);
      lines.push(`- export ${result.status}: ${draftName}`);
      if (result.status !== 'exported') continue;
      // CapCut truncates long names and appends "(1)" on collision; canonicalize.
      if (result.output_path && path.resolve(result.output_path) !== path.resolve(mp4Path)
        && fs.existsSync(result.output_path) && !fs.existsSync(mp4Path)) {
        fs.renameSync(result.output_path, mp4Path);
      }
      if (!fs.existsSync(mp4Path)) { lines.push(`  - output missing after export: ${draftName}`); continue; }
    }

    // 3. The file must BE the draft it is named after (wrong-project export guard).
    const expected = manifestDurationSec(draftDir);
    const actual = ffprobeDurationSec(mp4Path);
    if (expected && Number.isFinite(actual) && Math.abs(actual - expected) > DURATION_TOLERANCE_SEC) {
      fs.mkdirSync(HELD_DIR, { recursive: true });
      fs.renameSync(mp4Path, path.join(HELD_DIR, path.basename(mp4Path)));
      console.log(`[held] ${draftName}: manifest ${expected.toFixed(1)}s vs file ${actual.toFixed(1)}s`);
      lines.push(`- HELD(duration mismatch): ${draftName} — manifest ${expected.toFixed(1)}s vs file ${actual.toFixed(1)}s`);
      continue;
    }

    // 4. Loudness contract: normalize toward -14 LUFS, fail-open.
    let uploadPath = mp4Path;
    if (!args.dryRun) {
      try {
        const norm = await normalizeUploadLoudness(mp4Path, (msg) => console.log(`  [loudness] ${msg}`));
        if (norm.applied && norm.path) uploadPath = norm.path;
      } catch (error) {
        console.log(`  [loudness] skipped: ${error.message}`);
      }
    }

    // 5. Per-channel publishAt slot.
    const indexInChannel = channelCounters.get(locale) || 0;
    channelCounters.set(locale, indexInChannel + 1);
    const publishAt = new Date(Date.now()
      + (FIRST_PUBLISH_DELAY_MIN + indexInChannel * PUBLISH_INTERVAL_MIN) * 60 * 1000).toISOString();

    items.push({
      filePath: uploadPath,
      originalName: `${draftName}.mp4`,
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      variant: meta.variant,
      uploadProfileId: profiles[locale].id,
      privacyStatus: 'private',
      publishAt,
      _draftName: draftName,
      _mp4Path: mp4Path
    });
    console.log(`[schedule] ${locale} | ${meta.title.slice(0, 44)} -> ${publishAt}`);
    lines.push(`- 예약 ${publishAt} [${locale}]: ${draftName} — ${meta.title}`);
  }

  if (args.dryRun || !items.length) {
    console.log(args.dryRun ? 'dry-run done' : 'nothing to upload');
    return;
  }

  const job = createUploadJob(items.map(({ _draftName, _mp4Path, ...item }) => item));
  startUploadJob(job.jobId);
  console.log(`upload job: ${job.jobId} (${items.length} items)`);
  lines.push('', `- upload job: ${job.jobId}`);

  for (let poll = 0; poll < 240; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const current = (listUploadJobs() || []).find((entry) => entry.jobId === job.jobId);
    if (!current || ['queued', 'running', 'cancelling'].includes(current.status)) continue;

    const full = loadJob(job.jobId);
    console.log(`RESULT ${current.status}: ${current.successCount}/${current.total}`);
    lines.push(`- result: ${current.status} (${current.successCount}/${current.total})`);
    for (const [index, item] of items.entries()) {
      const uploaded = (full.items || [])[index] || {};
      const ok = uploaded.status === 'completed' || Boolean(uploaded.youtubeUrl);
      lines.push(`  - ${ok ? 'OK' : 'FAIL'} ${item._draftName}: ${uploaded.youtubeUrl || uploaded.error || uploaded.status || ''}`);
      if (!ok) continue;
      fs.mkdirSync(UPLOADED_DIR, { recursive: true });
      try { fs.renameSync(item._mp4Path, path.join(UPLOADED_DIR, path.basename(item._mp4Path))); } catch { /* best effort */ }
      state.history = [...(state.history || []), {
        at: new Date().toISOString(),
        draft: item._draftName,
        locale: item.variant === 'ko_highlight' ? 'ko' : 'ja',
        publishAt: item.publishAt,
        url: uploaded.youtubeUrl || ''
      }].slice(-500);
    }
    writeState(state);
    break;
  }

  lines.push('', '## Content ID 프리플라이트 (3층)',
    '- 업로드는 전부 비공개+publishAt 예약. 공개 시각 전에 Studio > 콘텐츠 > 각 영상 "검사(Checks)" 탭에서 소유권 주장을 확인할 것.',
    '- 차단(Block) 주장 발견 시: 해당 영상 예약 해제 + source-casebook 권리자 대장에 기록.');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-auto-publish.md`);
  fs.appendFileSync(reportPath, `${lines.join('\n')}\n\n`, 'utf8');
  console.log(`report: ${reportPath}`);
}

main().catch((error) => {
  console.error('auto-publish fatal:', error.message || error);
  process.exitCode = 1;
});
