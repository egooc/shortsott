// Nightly production batch (owner directive 2026-08-20): work runs between 00:00 and 07:00,
// two sources per night -> four videos (ko+ja per source, two per channel), published on the
// fixed 08:00/18:00 slots by auto-publish.
//
//   node scripts/nightly-batch.js [--sources 2] [--deadline-hour 7] [--dry-run]
//                                 [--skip-scout] [--skip-produce]
//
// Stages, each behind the deadline guard (work that would cross 07:00 is left for the next
// night rather than started):
//   1. scout   — scout-sources.js --recon; top candidates, distinct movies preferred.
//   2. produce — runMidformFullAutoWorkflow per source (ko+ja drafts + gates + packages).
//   3. install — copy each produced draft_ko/draft_ja to a FRESH dated CapCut folder
//                (CapCut caches opened folders; never reuse a name).
//   4. publish — auto-publish.js --prefix <tonight>: CapCut export, verification, slot upload.
// Everything lands in server/output/nightly-reports/<date>.md.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const TEMPLATE_RUNS_DIR = path.join(ROOT, 'midform', 'test_runs', 'template_runs');
const SCOUT_REPORTS_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'nightly-reports');

function parseArgs(argv) {
  const args = { sources: 2, deadlineHour: 7, dryRun: false, skipScout: false, skipProduce: false, produceOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--skip-scout') args.skipScout = true;
    else if (argv[i] === '--skip-produce') args.skipProduce = true;
    else if (argv[i] === '--produce-only') args.produceOnly = true; // stop after install: no export, no upload
    else if (argv[i] === '--sources') { args.sources = Number(argv[i + 1]) || 2; i += 1; }
    else if (argv[i] === '--deadline-hour') { args.deadlineHour = Number(argv[i + 1]); i += 1; }
  }
  return args;
}

// KST wall clock (UTC+9, DST-free).
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstStamp() { return kstNow().toISOString().slice(0, 10).replace(/-/g, ''); }

function makeDeadlineGuard(deadlineHour) {
  // The deadline is "the next <deadlineHour>:00 KST after the batch started" — a batch
  // started at 23:50 must still stop at 07:00, not at 07:00 the day after.
  const start = kstNow();
  const deadline = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), deadlineHour));
  if (deadline.getTime() <= start.getTime()) deadline.setUTCDate(deadline.getUTCDate() + 1);
  const deadlineMs = deadline.getTime() - 9 * 3600 * 1000;
  return {
    deadlineIso: new Date(deadlineMs).toISOString(),
    expired: () => Date.now() >= deadlineMs,
    remainMin: () => Math.floor((deadlineMs - Date.now()) / 60000)
  };
}

function latestScoutReport() {
  if (!fs.existsSync(SCOUT_REPORTS_DIR)) return null;
  const files = fs.readdirSync(SCOUT_REPORTS_DIR).filter((f) => /^scout-\d+\.json$/.test(f)).sort();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(SCOUT_REPORTS_DIR, files[files.length - 1]), 'utf8'));
}

// Prefer variety: one candidate per movie first, then refill from the remainder.
function pickSources(candidates, count) {
  const byMovie = new Map();
  for (const candidate of candidates) {
    const key = candidate.movie?.key || candidate.id;
    if (!byMovie.has(key)) byMovie.set(key, candidate);
  }
  const primary = [...byMovie.values()].slice(0, count);
  if (primary.length >= count) return primary;
  const chosen = new Set(primary.map((c) => c.id));
  return [...primary, ...candidates.filter((c) => !chosen.has(c.id))].slice(0, count);
}

function listTemplateRunDirs() {
  if (!fs.existsSync(TEMPLATE_RUNS_DIR)) return new Set();
  return new Set(fs.readdirSync(TEMPLATE_RUNS_DIR));
}

function installDraft(templateRunDir, folderName) {
  const installed = [];
  for (const locale of ['ko', 'ja']) {
    const src = path.join(templateRunDir, `draft_${locale}`);
    if (!fs.existsSync(path.join(src, 'draft_content.json'))) continue;
    const target = path.join(DRAFTS_DIR, `${folderName}-${locale}`);
    if (fs.existsSync(target)) continue; // fresh names only — never overwrite (CapCut cache trap)
    fs.cpSync(src, target, { recursive: true });
    const posts = path.join(templateRunDir, `social_posts.${locale}.txt`);
    if (fs.existsSync(posts)) fs.copyFileSync(posts, path.join(target, `social_posts.${locale}.txt`));
    installed.push(path.basename(target));
  }
  return installed;
}

async function main() {
  const args = parseArgs(process.argv);
  const guard = makeDeadlineGuard(args.deadlineHour);
  const stamp = kstStamp();
  const prefix = `${stamp}n`; // n = nightly; distinct from manual installs (a, b, ...)
  const lines = [`# nightly batch ${new Date().toISOString()} (deadline ${guard.deadlineIso}, prefix ${prefix})`, ''];
  const finish = (status) => {
    lines.push('', `- status: ${status}`);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.appendFileSync(path.join(REPORTS_DIR, `${stamp}.md`), `${lines.join('\n')}\n\n`, 'utf8');
    console.log(`report: ${path.join(REPORTS_DIR, `${stamp}.md`)}`);
  };

  console.log(`deadline ${guard.deadlineIso} (${guard.remainMin()}min left)`);

  // 1. Scout
  if (!args.skipScout && !guard.expired()) {
    console.log('[stage] scout');
    const scout = spawnSync('node', [path.join(ROOT, 'scripts', 'scout-sources.js'), '--limit', '30', '--recon'],
      { encoding: 'utf8', timeout: 30 * 60 * 1000 });
    lines.push(`- scout: exit=${scout.status}`);
    if (scout.status !== 0) console.log(String(scout.stderr || '').slice(-300));
  }
  const report = latestScoutReport();
  const candidates = (report?.candidates || []).filter((c) => (c.recon?.live_results ?? 1) > 0);
  const picked = pickSources(candidates, args.sources);
  lines.push(`- 후보 ${candidates.length}건 중 ${picked.length}건 선택:`,
    ...picked.map((c) => `  - [${c.movie?.key}] ${c.title} — ${c.url}`));
  console.log(`picked ${picked.length}/${args.sources} source(s)`);
  if (!picked.length) { finish('no_candidates'); return; }
  if (args.dryRun) { finish('dry_run'); return; }

  // 2-3. Produce + install, one source at a time so a failure costs one source, not the night.
  const installedFolders = [];
  if (!args.skipProduce) {
    const { runMidformFullAutoWorkflow } = require('../server/services/midformFullAutoService');
    for (const [index, candidate] of picked.entries()) {
      if (guard.expired()) { lines.push(`- DEADLINE before producing: ${candidate.title}`); break; }
      console.log(`[stage] produce ${index + 1}/${picked.length}: ${candidate.title} (${guard.remainMin()}min left)`);
      const before = listTemplateRunDirs();
      const startedMs = Date.now();
      try {
        const summary = await runMidformFullAutoWorkflow({ source: candidate.url });
        // Per-source wall time goes in the report: the owner decides from tonight's numbers
        // whether two sources fit the 00:00-07:00 window or the plan needs rework.
        lines.push(`- produce ${summary.status || 'done'} (${Math.round((Date.now() - startedMs) / 60000)}min): ${candidate.title}`);
        // A returned-but-failed summary is a failure: record WHY (the 2026-08-20 night lost
        // both sources to a yt-dlp 403 and the report said only "failed").
        if (summary.status === 'failed') {
          lines.push(`  - failure: ${JSON.stringify(summary.failure_reason || {}).slice(0, 300)}`);
          console.log(`  failed: ${JSON.stringify(summary.failure_reason || {}).slice(0, 200)}`);
          continue;
        }
      } catch (error) {
        lines.push(`- produce FAILED (${Math.round((Date.now() - startedMs) / 60000)}min): ${candidate.title} — ${String(error.message || error).slice(0, 200)}`);
        console.log(`  FAILED: ${String(error.message || error).slice(0, 200)}`);
        continue;
      }
      const fresh = [...listTemplateRunDirs()].filter((dir) => !before.has(dir));
      for (const dir of fresh) {
        const folderName = `${prefix}-${candidate.movie?.key || 'movie'}-${String(candidate.id).slice(0, 6)}`;
        const installed = installDraft(path.join(TEMPLATE_RUNS_DIR, dir), folderName);
        installedFolders.push(...installed);
        if (installed.length) lines.push(`  - installed: ${installed.join(', ')}`);
      }
    }
  }
  if (!installedFolders.length && !args.skipProduce) { finish('nothing_installed'); return; }

  // --produce-only: the drafts are installed and that is tonight's whole job (export and
  // upload stay off until the owner turns them on).
  if (args.produceOnly) {
    lines.push('', `- 설치 완료 ${installedFolders.length}편 (produce-only — 내보내기/업로드 생략):`,
      ...installedFolders.map((name) => `  - ${name}`));
    finish('produced_only');
    return;
  }

  // 4. Publish (CapCut export + fixed-slot scheduled upload). auto-publish has its own
  //    per-draft guards; the deadline only decides whether we start it at all.
  if (guard.expired()) { finish('deadline_before_publish'); return; }
  console.log(`[stage] publish (${guard.remainMin()}min left)`);
  const publish = spawnSync('node', [path.join(ROOT, 'scripts', 'auto-publish.js'), '--prefix', prefix],
    { encoding: 'utf8', timeout: Math.max(10, guard.remainMin()) * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(String(publish.stdout || '').slice(-1500));
  lines.push(`- publish: exit=${publish.status}`,
    ...String(publish.stdout || '').trim().split('\n').slice(-12).map((line) => `  ${line}`));
  finish(publish.status === 0 ? 'ok' : 'publish_failed');
}

main().catch((error) => {
  console.error('nightly-batch fatal:', error.message || error);
  process.exitCode = 1;
});
