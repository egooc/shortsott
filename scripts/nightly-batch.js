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
const TEST_RUNS_DIR = path.join(ROOT, 'midform', 'test_runs');
const TEMPLATE_RUNS_DIR = path.join(ROOT, 'midform', 'test_runs', 'template_runs');
const SCOUT_REPORTS_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'nightly-reports');

// The scout excludes already-produced sources, but --skip-scout reuses an OLDER report - so a
// source produced after that report was written stays in the queue and gets re-produced from
// scratch (The Arrival's signal-detection clip burned two full attempts on 2026-08-22 while its
// finished draft sat installed). Read the same ledger the scout reads, at queue-build time.
function usedSourceIds() {
  const ids = new Set();
  if (!fs.existsSync(TEST_RUNS_DIR)) return ids;
  for (const run of fs.readdirSync(TEST_RUNS_DIR)) {
    const infoPath = path.join(TEST_RUNS_DIR, run, 'source_info.json');
    try { ids.add(String(JSON.parse(fs.readFileSync(infoPath, 'utf8')).id || '')); } catch { /* not a run dir */ }
  }
  ids.delete('');
  return ids;
}

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

// A failed source used to be abandoned outright: the download, the STT, the vision pass and the
// TTS were all paid for and then thrown away, and the next night's scout would not even offer it
// again (its source_info.json puts it in the used ledger). One 2026-08-23 batch lost 8 of 9
// candidates that way, three of them to nothing worse than a closing-style title. Two changes:
// the cheap failures are retried against the SAME compress run, and whatever still fails is
// written down instead of vanishing.
const FAILURE_QUEUE_PATH = path.join(ROOT, 'server', 'data', 'production_failure_queue.json');
// Everything decided while writing slot_fills - titles, closing style, narration economy, house
// wording, the narration sentences themselves, the caption for each kept line - is regenerated by
// re-running compress-apply, which reuses the expensive stages. A GEOMETRY failure (window
// overlap, reserved-range collision, plan timing) or a draft-builder crash is NOT of this kind
// and goes straight to the queue for a human pass.
//
// The test is not the stage the failure surfaced in, it is where the offending value was decided
// (2026-08-24): two queued failures were classified unrecoverable purely because one was a
// preflight and one was a run-stage throw, yet both named a fills value.
// `dialogue_lines_all_captioned` is a preflight check whose input is the fills caption array, and
// a revelation-staging narration is a sentence the generator wrote. Both re-roll.
const FILLS_REGENERABLE = [
  /upload_text\.title_candidates/i,
  /breaks house style/i,
  /narration economy/i,
  /upload_text\.[a-z_]+ is required/i,
  // A kept line whose caption the generator never wrote. Geometry is fine; the array is short.
  /would ship with no caption and vanish/i,
  // The narration truth rules - the sentence claims something the footage or transcript does not
  // show. Re-rolling the fills gives the generator another pass at that slot.
  /stages a revelation the source never shows/i,
  /narration states only what the transcript or footage shows/i,
  // Caption arrays the generator got wrong. These are checked during generation and retried
  // there, so reaching the queue means the retries ran out - but a fresh generation samples
  // differently and does land it, and the alternative is discarding a paid-for compress run.
  /caption_kr_dialogue must have exactly/i,
  /caption_kr_dialogue has \d+ blank caption/i,
  /translation_mode must be faithful_dialogue/i,
  // An empty NARRATE slot (casebook 21). Same reasoning.
  /empty (Japanese )?narration slots/i
];
const RECOVERY_ATTEMPTS = 2;

function readFailureQueue() {
  try { return JSON.parse(fs.readFileSync(FAILURE_QUEUE_PATH, 'utf8')); } catch { return { entries: [] }; }
}

function recordFailure(entry) {
  const queue = readFailureQueue();
  queue.entries = (queue.entries || []).filter((e) => e.source_id !== entry.source_id);
  queue.entries.push(entry);
  queue.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(FAILURE_QUEUE_PATH), { recursive: true });
  fs.writeFileSync(FAILURE_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');
}

// The workspace is transient; the queue is the record. Snapshot the report while it still
// describes this source.
function readMismatchReport(ctx) {
  if (!ctx?.workspaceDir) return '';
  const file = path.join(ROOT, 'midform', 'test_runs', 'template_runs', ctx.workspaceDir, 'narration_mismatch_report.md');
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The workspace a failed run left behind carries the two things a resume needs: which template
// was used and which compress run to pin.
function findRunContext(freshDirs) {
  for (const dir of freshDirs) {
    const summary = readJsonQuiet(path.join(TEMPLATE_RUNS_DIR, dir, 'run_summary.json'));
    if (!summary) continue;
    const compressRunId = summary.internal?.bootstrap_source_run_id || summary.internal?.compression_run_id || '';
    if (summary.template_path && compressRunId) {
      return { workspaceDir: dir, templatePath: summary.template_path, compressRunId, summary };
    }
  }
  return null;
}

function failureText(summary) {
  return JSON.stringify(summary?.failure_reason || {});
}

function isFillsRegenerable(text) {
  return FILLS_REGENERABLE.some((re) => re.test(text));
}

// The machine eye reports a suggested_rewrite for every sentence it rejects, grounded in what the
// frames actually show. Applying those is deterministic and free; re-rolling the fills is neither,
// and the generator cannot see the frames so it can miss the same way twice. Try the rewrite FIRST
// and fall back to a re-roll only if it does not stick.
function mismatchIssues(text) {
  // failedText is JSON.stringify(failure_reason), so the gate's message is an ESCAPED string
  // inside it - the issue array cannot be sliced out of the raw text, its quotes are all \".
  // Unwrap the record first; fall back to the raw text for a message passed in bare.
  let message = String(text || '');
  try {
    const record = JSON.parse(message);
    if (record && typeof record.message === 'string') message = record.message;
  } catch { /* not a record - treat what we were given as the message */ }

  const marker = 'narration_visual_match failed:';
  const at = message.indexOf(marker);
  if (at < 0) return [];
  const tail = message.slice(at + marker.length);
  const start = tail.indexOf('[');
  if (start < 0) return [];
  // The gate may append prose after the array, so find its end by balancing brackets - and skip
  // brackets that fall inside a quoted string, because a rewrite can legitimately contain one.
  let depth = 0;
  let inString = false;
  for (let i = start; i < tail.length; i += 1) {
    const ch = tail[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(tail.slice(start, i + 1));
          // on_screen is what makes an issue actionable - it is the frame fact the next pass has
          // to write from. suggested_rewrite is deliberately NOT required, and deliberately not
          // used: it describes the picture, and narration that describes the picture is a caption.
          return Array.isArray(parsed) ? parsed.filter((issue) => issue && issue.segment_id && issue.on_screen) : [];
        } catch { return []; }
      }
    }
  }
  return []; // unbalanced - a truncated record, which is exactly what the 600-char cap produced
}

// Hand the judge's verdict to the generator for the next pass. runCompressionApply reads this
// file out of the compress run and turns it into a "do not repeat these sentences" section.
function recordNarrationRejections(compressRunId, issues) {
  const file = path.join(ROOT, 'midform', 'test_runs', compressRunId, 'narration_visual_rejections.json');
  try {
    // Accumulate: a sentence rejected on attempt 1 must still be off the table on attempt 2.
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first rejection */ }
    const merged = [...(Array.isArray(existing) ? existing : []), ...issues];
    const seen = new Set();
    const deduped = merged.filter((item) => {
      const key = `${item.locale}|${item.segment_id}|${item.sentence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    fs.writeFileSync(file, JSON.stringify(deduped, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

// The step the old recovery loop was missing entirely. `run --resume bootstrap` CONVERTS
// compression_slot_fills.json into the pipeline contract - it does not rewrite it, and
// runCompressionApply has exactly one caller, the compress-apply subcommand. So the previous
// "regenerating fills" retry re-ran the whole pipeline over byte-identical narration and failed
// the same way, twice, at full cost. Regenerate the fills first, then resume.
// Returns '' on success, otherwise WHY it failed. A bare false told the morning pass nothing:
// "fills regeneration failed" appeared twice in one run with no way to tell a validation wall from
// a Vertex outage, and the two want opposite responses (2026-08-24).
function regenerateFillsWithReason(compressRunId, timeoutMs) {
  const step = (subcommand) => spawnSync('node', [
    path.join(ROOT, 'scripts', 'midform.js'), subcommand, compressRunId
  ], { encoding: 'utf8', timeout: timeoutMs, cwd: ROOT });
  const lastMeaningfulLine = (result) => {
    const text = `${result.stderr || ''}\n${result.stdout || ''}`;
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (result.error) return String(result.error.message || result.error);
    // The stack trace is noise; the thrown message is the one line worth keeping.
    const thrown = lines.find((line) => /^(Error|TypeError|MIDFORM_|\[midform\])/.test(line));
    return (thrown || lines[lines.length - 1] || 'no output').slice(0, 300);
  };
  const apply = step('compress-apply');
  if (apply.status !== 0) return `compress-apply exit ${apply.status}: ${lastMeaningfulLine(apply)}`;
  // finalizeEditPlan runs over the new fills before bootstrap reads the plan.
  const refresh = step('compress-refresh');
  if (refresh.status !== 0) return `compress-refresh exit ${refresh.status}: ${lastMeaningfulLine(refresh)}`;
  return '';
}

function regenerateFills(compressRunId, timeoutMs) {
  const reason = regenerateFillsWithReason(compressRunId, timeoutMs);
  if (reason) console.log(`  fills regeneration failed: ${reason}`);
  return !reason;
}

// Resume the SAME compress run: download, transcript, vision and beats are reused, only the
// fills and everything downstream of them are rebuilt.
function resumeFromBootstrap(templatePath, compressRunId, timeoutMs) {
  const result = spawnSync('node', [
    path.join(ROOT, 'scripts', 'midform.js'), 'run',
    '--template', templatePath,
    '--resume', 'bootstrap',
    '--bootstrap-run', compressRunId
  ], { encoding: 'utf8', timeout: timeoutMs, cwd: ROOT });
  return result;
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
    // The morning pass reads the report, so the backlog has to be visible there - a queue nobody
    // is told about is the same as the discarded runs it replaced.
    const pending = (readFailureQueue().entries || []);
    if (pending.length) {
      lines.push('', `- 아침 수술 대기 ${pending.length}건 (production_failure_queue.json):`,
        ...pending.slice(0, 10).map((e) => `  - [${e.movie || '?'}] ${String(e.title).slice(0, 60)} — ${String(e.failure).slice(0, 90)}`));
    }
    lines.push('', `- status: ${status}`);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.appendFileSync(path.join(REPORTS_DIR, `${stamp}.md`), `${lines.join('\n')}\n\n`, 'utf8');
    console.log(`report: ${path.join(REPORTS_DIR, `${stamp}.md`)}`);
    if (pending.length) console.log(`morning queue: ${pending.length} source(s)`);
  };

  console.log(`deadline ${guard.deadlineIso} (${guard.remainMin()}min left)`);

  // 1. Scout
  if (!args.skipScout && !guard.expired()) {
    console.log('[stage] scout');
    // No --limit: the scout's own default reads the whole channel. Pinning 30 here silently
    // undid the default and the nightly scout still saw only the newest 30 uploads - which by
    // 2026-08-23 were all produced, so the batch scouted itself to zero candidates while 48
    // registered clips (including the 2M-view ones) sat further down the shelf.
    const scout = spawnSync('node', [path.join(ROOT, 'scripts', 'scout-sources.js'), '--recon'],
      { encoding: 'utf8', timeout: 30 * 60 * 1000 });
    lines.push(`- scout: exit=${scout.status}`);
    if (scout.status !== 0) console.log(String(scout.stderr || '').slice(-300));
  }
  const report = latestScoutReport();
  const used = usedSourceIds();
  const candidates = (report?.candidates || [])
    .filter((c) => (c.recon?.live_results ?? 1) > 0)
    .filter((c) => !used.has(String(c.id || '')));
  // The whole verified pool is the work queue: diversity-first picks lead, the rest stand by
  // as fallbacks. A gate-failed source costs its own minutes, not the night's quota — the
  // batch keeps pulling candidates until `sources` of them SUCCEED or the deadline lands
  // (2026-08-20 daytime trial: one source burned 35min on a caption gate and shipped nothing).
  const primary = pickSources(candidates, args.sources);
  const primaryIds = new Set(primary.map((c) => c.id));
  const queue = [...primary, ...candidates.filter((c) => !primaryIds.has(c.id))];
  lines.push(`- 후보 ${candidates.length}건, 목표 ${args.sources}개 성공 (예비 ${queue.length - primary.length}건):`,
    ...primary.map((c) => `  - [${c.movie?.key}] ${c.title} — ${c.url}`));
  console.log(`queue ${queue.length} candidate(s), target ${args.sources} success(es)`);
  if (!queue.length) { finish('no_candidates'); return; }
  if (args.dryRun) { finish('dry_run'); return; }

  // 2-3. Produce + install: walk the queue until `sources` candidates SUCCEED (a failed one
  //  costs only its own minutes) or the deadline lands.
  const installedFolders = [];
  if (!args.skipProduce) {
    const { runMidformFullAutoWorkflow } = require('../server/services/midformFullAutoService');
    let successes = 0;
    let attempts = 0;
    for (const candidate of queue) {
      if (successes >= args.sources) break;
      if (guard.expired()) { lines.push(`- DEADLINE with ${successes}/${args.sources} succeeded`); break; }
      attempts += 1;
      console.log(`[stage] produce attempt ${attempts} (${successes}/${args.sources} ok): ${candidate.title} (${guard.remainMin()}min left)`);
      const before = listTemplateRunDirs();
      const startedMs = Date.now();
      let failedText = '';
      try {
        let summary = await runMidformFullAutoWorkflow({ source: candidate.url });
        // Per-source wall time goes in the report: the owner decides from real numbers
        // whether the 00:00-07:00 window holds or the plan needs rework.
        lines.push(`- produce ${summary.status || 'done'} (${Math.round((Date.now() - startedMs) / 60000)}min): ${candidate.title}`);
        // A returned-but-failed summary is a failure: record WHY (the 2026-08-20 night lost
        // both sources to a yt-dlp 403 and the report said only "failed").
        if (summary.status === 'failed') {
          failedText = failureText(summary);
          lines.push(`  - failure: ${failedText.slice(0, 300)}`);
          console.log(`  failed: ${failedText.slice(0, 200)}`);

          // Cheap recovery: anything decided while writing slot_fills gets another pass against
          // the compress run we already paid for, instead of costing the whole source.
          const ctx = findRunContext([...listTemplateRunDirs()].filter((d) => !before.has(d)));
          let issues = mismatchIssues(failedText);
          if (ctx && (issues.length || isFillsRegenerable(failedText))) {
            for (let recovery = 1; recovery <= RECOVERY_ATTEMPTS && !guard.expired(); recovery += 1) {
              const budgetMs = Math.max(60_000, guard.remainMin() * 60_000);
              // Tell the generator what the judge caught, so this pass is not a coin flip on the
              // same prompt. Nothing is pasted in for it - only the frame fact and the ban.
              if (issues.length) {
                recordNarrationRejections(ctx.compressRunId, issues);
                lines.push(`  - recover ${recovery}: ${issues.length} rejected sentence(s) fed back`);
              }
              console.log(`  [recover ${recovery}/${RECOVERY_ATTEMPTS}] regenerating fills on ${ctx.compressRunId}`);
              lines.push(`  - recover ${recovery}: regenerate fills + resume bootstrap on ${ctx.compressRunId}`);
              if (!regenerateFills(ctx.compressRunId, budgetMs)) {
                lines.push('  - recover: fills regeneration failed; giving up on this source');
                break;
              }
              resumeFromBootstrap(ctx.templatePath, ctx.compressRunId, budgetMs);
              const after = readJsonQuiet(path.join(TEMPLATE_RUNS_DIR, ctx.workspaceDir, 'run_summary.json'));
              if (after && after.status !== 'failed') {
                summary = after;
                failedText = '';
                lines.push(`  - recovered on attempt ${recovery}: ${after.status}`);
                console.log(`  recovered: ${after.status}`);
                break;
              }
              failedText = failureText(after);
              issues = mismatchIssues(failedText);
              // a different wall now - stop paying for retries
              if (!isFillsRegenerable(failedText) && !issues.length) break;
            }
          }
          if (failedText) {
            recordFailure({
              source_id: candidate.id,
              title: candidate.title,
              url: candidate.url,
              movie: candidate.movie?.key || '',
              view_count: candidate.view_count || null,
              failed_at: new Date().toISOString(),
              // NOT truncated. The queue outlives the workspace - auto_template_* dirs are reused
              // by the next source, so by morning the report this entry points at can belong to a
              // different movie (casebook 17). A machine-eye failure carries its own
              // suggested_rewrite for every sentence inside this text, and a 600-char cap cut that
              // payload off mid-string, leaving an entry that could name the defect but not fix it.
              failure: failedText,
              fills_regenerable: isFillsRegenerable(failedText),
              // Kept separate from fills_regenerable: this one is fixed by editing named sentences,
              // not by asking the generator for a new draft.
              mismatch_rewritable: mismatchIssues(failedText).length > 0,
              workspace_dir: ctx?.workspaceDir || '',
              compress_run_id: ctx?.compressRunId || '',
              template_path: ctx?.templatePath || '',
              // The morning pass reads these directly; see the run-diagnose / rebuild-loop skills.
              mismatch_report: ctx ? path.join('midform/test_runs/template_runs', ctx.workspaceDir, 'narration_mismatch_report.md') : '',
              // ...and a copy of it, for the same reason the failure text is kept whole.
              mismatch_report_text: readMismatchReport(ctx)
            });
            lines.push('  - queued for the morning pass (production_failure_queue.json)');
            continue;
          }
        }
      } catch (error) {
        const message = String(error.message || error).slice(0, 300);
        lines.push(`- produce FAILED (${Math.round((Date.now() - startedMs) / 60000)}min): ${candidate.title} — ${message}`);
        console.log(`  FAILED: ${message}`);
        const ctx = findRunContext([...listTemplateRunDirs()].filter((d) => !before.has(d)));
        recordFailure({
          source_id: candidate.id,
          title: candidate.title,
          url: candidate.url,
          movie: candidate.movie?.key || '',
          view_count: candidate.view_count || null,
          failed_at: new Date().toISOString(),
          failure: message,
          fills_regenerable: false,
          workspace_dir: ctx?.workspaceDir || '',
          compress_run_id: ctx?.compressRunId || '',
          template_path: ctx?.templatePath || ''
        });
        lines.push('  - queued for the morning pass (production_failure_queue.json)');
        continue;
      }
      const fresh = [...listTemplateRunDirs()].filter((dir) => !before.has(dir));
      let installedForCandidate = 0;
      for (const dir of fresh) {
        const folderName = `${prefix}-${candidate.movie?.key || 'movie'}-${String(candidate.id).slice(0, 6)}`;
        const installed = installDraft(path.join(TEMPLATE_RUNS_DIR, dir), folderName);
        installedFolders.push(...installed);
        installedForCandidate += installed.length;
        if (installed.length) lines.push(`  - installed: ${installed.join(', ')}`);
      }
      if (installedForCandidate > 0) {
        successes += 1;
        // A source that came back on a later night must not stay on the morning list.
        const queue = readFailureQueue();
        if ((queue.entries || []).some((e) => e.source_id === candidate.id)) {
          queue.entries = queue.entries.filter((e) => e.source_id !== candidate.id);
          fs.writeFileSync(FAILURE_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');
        }
      } else {
        lines.push(`  - no draft to install (counted as failure): ${candidate.title}`);
        recordFailure({
          source_id: candidate.id,
          title: candidate.title,
          url: candidate.url,
          movie: candidate.movie?.key || '',
          failed_at: new Date().toISOString(),
          failure: 'run reported success but produced no installable draft',
          fills_regenerable: false
        });
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

// The morning pass works the same failure queue with the same classification, so it imports these
// rather than keeping a second copy of the regex list that would drift out of step.
module.exports = {
  FAILURE_QUEUE_PATH,
  FILLS_REGENERABLE,
  RECOVERY_ATTEMPTS,
  readFailureQueue,
  isFillsRegenerable,
  mismatchIssues,
  recordNarrationRejections,
  regenerateFills,
  regenerateFillsWithReason,
  resumeFromBootstrap,
  installDraft,
  readJsonQuiet,
  failureText,
  TEMPLATE_RUNS_DIR
};

if (require.main === module) {
  main().catch((error) => {
    console.error('nightly-batch fatal:', error.message || error);
    process.exitCode = 1;
  });
}
