// Retire jobs stuck in 'queued' with no worker.
//
// cancelJob only asks a worker to stop, so a queued job that never got one stays
// queued forever - seven of them accumulated here, the oldest from June. They
// are excluded from the active check once cancel_requested is set, so they are
// not blocking anything today; but they crowd every job listing, and the moment
// that predicate changes they would block the queue again.
//
// Refuses to touch anything while a job is running, because rewriting rows under
// a live worker is how a good run gets lost.
//
//   node scripts/ops/clear-stale-jobs.js [--apply] [--older-than-hours 2]
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { listJobs, readJob } = require(path.join(ROOT, 'server', 'services', 'processJobService'));
const { upsertJob } = require(path.join(ROOT, 'server', 'services', 'processJobDbService'));

const apply = process.argv.includes('--apply');
const hoursIdx = process.argv.indexOf('--older-than-hours');
const minAgeHours = hoursIdx > -1 ? Number(process.argv[hoursIdx + 1]) : 2;

const raw = listJobs();
const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);

const running = jobs.filter((j) => j.status === 'running');
if (running.length) {
  console.log(`실행 중인 잡이 있어 중단: ${running.map((j) => j.job_id).join(', ')}`);
  console.log('진행분이 끝난 뒤 다시 실행하세요.');
  process.exitCode = 1;
  return;
}

const cutoff = Date.now() - minAgeHours * 3600 * 1000;
const stale = jobs.filter((j) => {
  if (j.status !== 'queued') return false;
  const stamp = Date.parse(j.updated_at || j.created_at || '');
  return Number.isFinite(stamp) && stamp < cutoff;
});

console.log(`대기 상태로 ${minAgeHours}시간 이상 방치된 잡: ${stale.length}개`);
for (const job of stale) {
  console.log(`  ${job.job_id} | ${job.batch_name || '-'} | ${job.updated_at || job.created_at}`);
  if (!apply) continue;
  const full = readJob(job.job_id);
  upsertJob({
    ...full,
    status: 'cancelled',
    stage: 'cancelled',
    cancel_requested: true,
    finished_at: full.finished_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: full.error || 'retired: queued with no worker'
  });
}
console.log(apply ? '취소 상태로 정리했습니다.' : '(dry-run — --apply 로 실제 정리)');
