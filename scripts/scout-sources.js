// Scout the configured source channels for new candidate clips and run the automatable
// layers of the Content ID preflight (source-casebook doctrine, 3-layer defense):
//   layer 1 (selection)  — movie identity vs the distributor ledger: banned studios drop here.
//   layer 2 (recon)      — are third-party clips of the same film surviving on YouTube right
//                          now? --recon runs the search and lists live results for a glance.
//   layer 3 (publication)— cannot be automated (Studio Checks after a private upload);
//                          auto-publish.js schedules private+publishAt so the window exists.
//
//   node scripts/scout-sources.js [--limit 30] [--recon] [--launch N] [--json]
//
// - Already-used sources (any midform/test_runs/*/source_info.json id) never come back.
// - A candidate whose movie is not in movie_catalog.json is reported as needs_research:
//   fill the catalog entry (identity + distributor tier + 일본 개봉명) before producing it.
// - --launch N hands the top N verified candidates to the full-auto pipeline
//   (runMidformFullAutoWorkflow), one at a time.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const CHANNELS_PATH = path.join(ROOT, 'midform', 'config', 'source_channels.json');
const CATALOG_PATH = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const TEST_RUNS_DIR = path.join(ROOT, 'midform', 'test_runs');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');

function parseArgs(argv) {
  const args = { limit: 30, recon: false, launch: 0, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--recon') args.recon = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--limit') { args.limit = Number(argv[i + 1]) || 30; i += 1; }
    else if (argv[i] === '--launch') { args.launch = Number(argv[i + 1]) || 0; i += 1; }
  }
  return args;
}

function ytDlpJson(args, timeoutMs = 120000) {
  const out = execFileSync('yt-dlp', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

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

function classify(title, catalog) {
  for (const [key, movie] of Object.entries(catalog.movies || {})) {
    if (new RegExp(movie.match, 'i').test(title)) return { key, ...movie };
  }
  return null;
}

// Layer 2: list currently-live third-party clips of the same film. Existence of recent
// survivors is the doctrine's signal that the studio tolerates clips (monetize-claims
// rather than blocks). The list goes in the report for a human glance; the script only
// asserts the count.
function survivalRecon(movie) {
  try {
    const data = ytDlpJson(['--flat-playlist', '-J', `ytsearch10:${movie.title_en} movie clip scene`]);
    const entries = (data.entries || []).filter((entry) => entry && entry.id);
    return {
      live_results: entries.length,
      samples: entries.slice(0, 5).map((entry) => ({ id: entry.id, title: entry.title, channel: entry.channel || entry.uploader || '' }))
    };
  } catch (error) {
    return { live_results: -1, error: String(error.message || error).slice(0, 120) };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, 'utf8')).channels || [];
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const used = usedSourceIds();
  // Transient failures (network, quota, download) stay eligible for up to 3 attempts even
  // though their aborted run dirs would otherwise mark them 'used' forever.
  let retryable = {};
  try { retryable = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'retry_sources.json'), 'utf8')); } catch { /* none */ }
  for (const [id, entry] of Object.entries(retryable)) {
    if (Number(entry?.attempts || 0) < 3) used.delete(id);
  }
  const report = { at: new Date().toISOString(), channels: [], candidates: [], needs_research: [], dropped: [] };

  for (const channel of channels) {
    console.log(`scouting: ${channel.name} (${channel.id})`);
    let entries = [];
    try {
      const data = ytDlpJson(['--flat-playlist', '--playlist-end', String(args.limit), '-J', channel.url]);
      entries = (data.entries || []).filter((entry) => entry && entry.id);
    } catch (error) {
      console.log(`  channel listing failed: ${String(error.message || error).slice(0, 120)}`);
      report.channels.push({ id: channel.id, error: String(error.message || error).slice(0, 200) });
      continue;
    }
    report.channels.push({ id: channel.id, name: channel.name, listed: entries.length });

    for (const entry of entries) {
      const row = {
        id: entry.id,
        title: entry.title || '',
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        channel: channel.name,
        duration_sec: Number(entry.duration) || null
      };
      if (used.has(entry.id)) continue; // already produced — silence, not noise
      const movie = classify(row.title, catalog);
      if (!movie) {
        report.needs_research.push(row);
        continue;
      }
      row.movie = { key: movie.key, title_en: movie.title_en, distributor: movie.distributor, tier: movie.distributor_tier };
      if (movie.distributor_tier === 'banned') {
        report.dropped.push({ ...row, reason: `banned distributor: ${movie.distributor}` });
        continue;
      }
      if (args.recon) row.recon = survivalRecon(movie);
      report.candidates.push(row);
    }
  }

  // Order: recon survivors first (when measured), then longer sources (more material).
  report.candidates.sort((a, b) => ((b.recon?.live_results ?? 0) - (a.recon?.live_results ?? 0))
    || ((b.duration_sec || 0) - (a.duration_sec || 0)));

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
  const jsonPath = path.join(REPORTS_DIR, `scout-${stamp}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const md = [
    `# 소스 정찰 ${report.at}`,
    '',
    `## 후보 ${report.candidates.length}건 (대장 통과${args.recon ? ' + 생존 정찰' : ''})`,
    ...report.candidates.map((c) => `- [${c.movie.key}] ${c.title} — ${c.url}`
      + (c.recon ? ` (생존 클립 ${c.recon.live_results}건)` : '')),
    '',
    `## 카탈로그 미등록 ${report.needs_research.length}건 — movie_catalog.json에 배급사/개봉명 등록 후 재정찰`,
    ...report.needs_research.map((c) => `- ${c.title} — ${c.url}`),
    '',
    `## 제외 ${report.dropped.length}건`,
    ...report.dropped.map((c) => `- ${c.title} — ${c.reason}`)
  ].join('\n');
  const mdPath = path.join(REPORTS_DIR, `scout-${stamp}.md`);
  fs.writeFileSync(mdPath, `${md}\n`, 'utf8');
  console.log(`candidates=${report.candidates.length} needs_research=${report.needs_research.length} dropped=${report.dropped.length}`);
  console.log(`report: ${mdPath}`);
  if (args.json) console.log(JSON.stringify(report.candidates.slice(0, 10), null, 2));

  if (args.launch > 0 && report.candidates.length) {
    const { runMidformFullAutoWorkflow } = require('../server/services/midformFullAutoService');
    for (const candidate of report.candidates.slice(0, args.launch)) {
      console.log(`[launch] full-auto: ${candidate.title}`);
      try {
        const summary = await runMidformFullAutoWorkflow({ source: candidate.url });
        console.log(`  -> ${summary.status || 'done'}`);
      } catch (error) {
        console.log(`  -> FAILED: ${String(error.message || error).slice(0, 200)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('scout-sources fatal:', error.message || error);
  process.exitCode = 1;
});
