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
// The edit plan targets roughly half the source, and the rendered cut comes in a little under that
// (49.9s measured against a 54s target on the clip that exposed this). Require enough source that
// the floor is reachable with that shrink allowed for, rather than discovering it after paying for
// the whole pipeline.
const DURATION_CONFIG_PATH = path.join(ROOT, 'midform', 'config', 'duration.json');
const PLAN_TARGET_FRACTION_OF_SOURCE = 0.5;
const RENDER_SHRINK_ALLOWANCE = 1.15;
function minSourceDurationSec() {
  let floor = 60;
  try { floor = Number(JSON.parse(fs.readFileSync(DURATION_CONFIG_PATH, 'utf8'))?.min_duration_sec) || floor; } catch { /* default */ }
  return Math.ceil((floor / PLAN_TARGET_FRACTION_OF_SOURCE) * RENDER_SHRINK_ALLOWANCE);
}
const MIN_SOURCE_DURATION_SEC = minSourceDurationSec();

const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');

// The channel's newest 30 uploads are the WRONG 30: the owner picks old clips whose engagement
// has already plateaued, and Clip Empire carries 386 videos - the old default saw 7.8% of the
// shelf and reported "queue exhausted" with 48 registered, unused clips sitting behind it
// (2026-08-22). Read the whole channel; the ledger filters what is already produced.
function parseArgs(argv) {
  const args = { limit: 500, recon: false, launch: 0, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--recon') args.recon = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--limit') { args.limit = Number(argv[i + 1]) || 500; i += 1; }
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

// Group unregistered clips by the movie their title names. Two title grammars exist in the
// source channels: Binge Society leads with the movie ("Pulp Fiction (1994): scene | Full
// Scene"), Clip Empire trails with it ("scene | Twilight: Eclipse 4K"). A row that fits
// neither stays in its own bucket rather than being dropped.
function movieNameOf(title) {
  const lead = title.match(/^([^|:()]{2,50}?)\s*\((?:19|20)\d{2}\)\s*[:\-]/);
  if (lead) return lead[1].trim();
  if (title.includes('|')) {
    let tail = title.split('|').pop().trim();
    tail = tail.replace(/\s*\(?(?:4K|Ultra HD|UHD|HD|Full Movie|Full Scene|Movieclips|Screen Bites|Binge Society)\)?\s*/gi, ' ')
      .replace(/\s*\((?:19|20)\d{2}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (tail.length > 2 && tail.length < 50) return tail;
  }
  const anywhere = title.match(/([A-Z][^|:()]{2,40}?)\s*\((?:19|20)\d{2}\)/);
  return anywhere ? anywhere[1].trim() : '(미분류)';
}

function aggregateResearchQueue(needsResearch, top = 25) {
  const groups = new Map();
  for (const row of needsResearch) {
    const name = movieNameOf(row.title || '');
    const group = groups.get(name) || { movie: name, clips: 0, total_views: 0, max_views: 0, sample_url: row.url };
    group.clips += 1;
    group.total_views += Number(row.view_count) || 0;
    group.max_views = Math.max(group.max_views, Number(row.view_count) || 0);
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.total_views - a.total_views).slice(0, top);
}

async function main() {
  const args = parseArgs(process.argv);
  const channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, 'utf8')).channels || [];
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const used = usedSourceIds();
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
    // The owner's selection rule is relative, not absolute: a clip that outperforms ITS OWN
    // channel's average has proven engagement regardless of the channel's size. The mean is
    // computed over every listed upload (including already-produced ones) so it describes the
    // channel, not the leftover pool.
    const viewCounts = entries.map((entry) => Number(entry.view_count) || 0).filter((count) => count > 0);
    const channelAvgViews = viewCounts.length ? Math.round(viewCounts.reduce((sum, count) => sum + count, 0) / viewCounts.length) : 0;
    report.channels.push({ id: channel.id, name: channel.name, listed: entries.length, avg_views: channelAvgViews });

    for (const entry of entries) {
      const row = {
        id: entry.id,
        title: entry.title || '',
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        channel: channel.name,
        duration_sec: Number(entry.duration) || null,
        view_count: Number(entry.view_count) || null,
        above_channel_avg: channelAvgViews > 0 && (Number(entry.view_count) || 0) > channelAvgViews
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
      // A source too short to reach min_duration_sec cannot produce a midform cut, but nothing
      // stopped it entering the queue - a 108s Breaking Dawn clip cost a download, transcript,
      // vision pass, TTS and two locale drafts to arrive at 49.9s against a 60s floor
      // (2026-08-24). The plan targets about half the source and the finished cut lands a little
      // under that, so the floor here is the duration minimum with that shrink allowed for.
      if (Number(row.duration_sec) > 0 && row.duration_sec < MIN_SOURCE_DURATION_SEC) {
        report.dropped.push({ ...row, reason: `too short for a midform cut: ${row.duration_sec}s < ${MIN_SOURCE_DURATION_SEC}s` });
        continue;
      }
      if (args.recon) row.recon = survivalRecon(movie);
      report.candidates.push(row);
    }
  }

  // Order: recon survivors first (when measured), then the clips that already PROVED they hold an
  // audience. The owner's own selection rule is "an old clip whose engagement has plateaued" -
  // a view count is that proof, and the shelf spans 20K to 2M, so ordering by duration first
  // spent a whole night on 100K-tier clips while 2M-tier ones sat unproduced (2026-08-22).
  report.candidates.sort((a, b) => ((b.recon?.live_results ?? 0) - (a.recon?.live_results ?? 0))
    || ((b.above_channel_avg ? 1 : 0) - (a.above_channel_avg ? 1 : 0))
    || ((b.view_count || 0) - (a.view_count || 0))
    || ((b.duration_sec || 0) - (a.duration_sec || 0)));

  // Standard post-scout step (owner directive 2026-08-30): the raw needs_research list is
  // hundreds of rows nobody reads. Aggregate it by movie and rank by proven audience, so the
  // morning pass researches DISTRIBUTOR + JAPAN RELEASE TITLE for the few movies that matter
  // and registers them in movie_catalog.json - that registration is what turns this backlog
  // into candidates (0 -> 30 the first time it was done).
  report.research_queue = aggregateResearchQueue(report.needs_research);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
  const jsonPath = path.join(REPORTS_DIR, `scout-${stamp}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const md = [
    `# 소스 정찰 ${report.at}`,
    '',
    `## 후보 ${report.candidates.length}건 (대장 통과${args.recon ? ' + 생존 정찰' : ''})`,
    ...report.candidates.map((c) => `- ${c.above_channel_avg ? '▲' : '-'} [${c.movie.key}] ${c.title} — ${c.url}`
      + ` (${(c.view_count || 0).toLocaleString()}뷰)` + (c.recon ? ` (생존 클립 ${c.recon.live_results}건)` : '')),
    '',
    `## 등록 조사 큐 (미등록 ${report.needs_research.length}건을 영화별 집계 — 상위부터 배급사·일본 개봉명 조사해 movie_catalog.json 등록)`,
    ...report.research_queue.map((g) => `- ${g.movie} — 클립 ${g.clips}개, 총 ${g.total_views.toLocaleString()}뷰 (최고 ${g.max_views.toLocaleString()})`),
    '',
    `## 카탈로그 미등록 원본 ${report.needs_research.length}건`,
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
