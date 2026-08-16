// Daily 03:00 cron entry (docs/daily-auto-pipeline-plan-2026-08-10.md).
//
//   npm run daily:pipeline    (registered in Windows Task Scheduler)
//
// Runs standalone like processJobWorker does - requires services directly, no
// HTTP server needed. Steps:
//   1. scorecard for the most recent finished job (best-effort, ~2min)
//   2. harvest: search -> dedupe ledger -> rank -> import 12 (harvested:true)
//   3. start the batch job (detached worker; this process exits right after)
//   4. write server/output/daily-reports/YYYYMMDD.md for the morning operator
// Every step is fail-soft: a failed harvest still writes a report saying so.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { harvestDailySources, loadHarvestConfig } = require('../server/services/sourceHarvestService');
const {
  bufferCountsByChannel,
  balanceLocalePlan,
  describePlan
} = require('../server/services/harvestBalanceService');
const { importYoutubeSourceQueueItems } = require('../server/services/processQueueService');
const { startProcessJob, listJobs } = require('../server/services/processJobService');

const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'daily-reports');

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function runScorecardForLastJob() {
  try {
    const finished = (listJobs()?.jobs || []).filter((job) => job.finished_at);
    if (!finished.length) return { ran: false, note: 'no finished job' };
    const last = finished.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))[0];
    execFileSync('node', [path.join(ROOT, 'scripts', 'highlight-arc-scorecard.js'), last.job_id], {
      cwd: ROOT, stdio: 'ignore', timeout: 15 * 60 * 1000, windowsHide: true
    });
    const scorecardPath = path.join(ROOT, 'server', 'output', 'scorecards', `${last.job_id}.json`);
    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    const ok = scorecard.rows.filter((row) => row.verdict === 'ok');
    return {
      ran: true,
      job_id: last.job_id,
      ok_count: ok.length,
      total: scorecard.rows.length,
      ok_folders: ok.map((row) => row.folder)
    };
  } catch (error) {
    return { ran: false, note: String(error.message || error).slice(0, 200) };
  }
}

// One harvest per day, whoever starts it. The scheduled run is not the only way
// this script gets invoked, and a second harvest on the same day imports another
// full day of sources on top of a batch that is still working through the first
// - far more than the line can analyse. The report is the record that today's
// harvest already happened.
function harvestAlreadyRanToday(reportPath) {
  try {
    return fs.readFileSync(reportPath, 'utf8').includes('## 오늘 소재 수집');
  } catch {
    return false;
  }
}

async function main() {
  const startedAt = new Date();
  const reportPath = path.join(REPORTS_DIR, `${dateStamp(startedAt)}.md`);
  if (harvestAlreadyRanToday(reportPath) && !process.argv.includes('--force')) {
    console.log(`daily pipeline already harvested today (${reportPath}); skipping. Use --force to override.`);
    return;
  }
  const lines = [`# 데일리 파이프라인 리포트 ${dateStamp(startedAt)}`, ''];

  // 1. Yesterday's scorecard
  const scorecard = runScorecardForLastJob();
  if (scorecard.ran) {
    lines.push(`## 전일 잡 스코어카드 (${scorecard.job_id})`);
    lines.push(`- ok ${scorecard.ok_count}/${scorecard.total} — 업로드 우선 대상:`);
    scorecard.ok_folders.forEach((folder) => lines.push(`  - ${folder}`));
  } else {
    lines.push(`## 전일 잡 스코어카드: 실행 안 됨 (${scorecard.note})`);
  }
  lines.push('');

  // 2. Harvest + import
  let harvest = null;
  try {
    // Weight today's split towards whichever channel is short. Uploads alternate
    // strictly, so the thin side is the one that decides when the line starves.
    const counts = bufferCountsByChannel();
    const configured = loadHarvestConfig().locale_plan || [];
    const balanced = balanceLocalePlan(configured, counts);
    lines.push('## 오늘 수확 배분');
    lines.push(`- 버퍼 잔량 JP ${counts.ja} / KR ${counts.ko}`);
    lines.push(`- 기본 계획 ${describePlan(configured)}`);
    lines.push(`- 적용 계획 ${describePlan(balanced)}`);
    lines.push('');

    harvest = await harvestDailySources({
      importItems: (rows) => importYoutubeSourceQueueItems({ items: rows }),
      localePlan: balanced
    });
    const imported = harvest.import_result.imported || [];
    lines.push('## 오늘 소재 수집');
    lines.push(`- 검색 ${harvest.queries.map((q) => `${q.query}(${q.results})`).join(', ')}`);
    lines.push(`- 발견 ${harvest.found_count} / 중복 제거 후 신규 ${harvest.fresh_count} / 임포트 ${imported.length}`);
    harvest.selected.forEach((candidate) => {
      lines.push(`  - [${candidate.target_locale}] ${candidate.title.slice(0, 60)} (${Math.round(candidate.duration_sec / 60)}분, heatmap ${candidate.heatmap_peak}, ${candidate.views.toLocaleString()} views)`);
    });
  } catch (error) {
    lines.push(`## 오늘 소재 수집 실패: ${String(error.message || error).slice(0, 300)}`);
  }
  lines.push('');

  // 3. Start the batch (detached worker survives this process exiting)
  const importedIds = (harvest?.import_result?.imported || [])
    .map((row) => row.item_id).filter(Boolean);
  if (importedIds.length) {
    try {
      const result = startProcessJob({
        item_ids: importedIds,
        stages: ['download', 'metadata', 'draft'],
        batch_name: `daily_${dateStamp(startedAt)}`,
        enqueue_if_active: true
      });
      lines.push(`## 배치 시작: ${result.job?.job_id || '?'} (${importedIds.length}개 아이템${result.queued ? ', 활성 잡 뒤 대기' : ''})`);
    } catch (error) {
      lines.push(`## 배치 시작 실패: ${String(error.message || error).slice(0, 300)}`);
    }
  } else {
    lines.push('## 배치 시작 안 함: 임포트된 신규 소재 없음');
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`daily pipeline done: ${reportPath}`);
}

main().catch((error) => {
  console.error('daily pipeline fatal:', error);
  process.exitCode = 1;
});
