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
// Relative requires: resolving these through an absolute path loaded a second
// copy of the service, and the writes went somewhere the running app never read
// - the script reported success while every row stayed queued (2026-08-17).
const { listJobs, readJob } = require('../../server/services/processJobService');
const { upsertJob, getJob } = require('../../server/services/processJobDbService');

const apply = process.argv.includes('--apply');
const hoursIdx = process.argv.indexOf('--older-than-hours');
const minAgeHours = hoursIdx > -1 ? Number(process.argv[hoursIdx + 1]) : 2;

const raw = listJobs();
const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);

// The drain keeps something running almost all the time now, so waiting for an
// idle window meant never cleaning up. --force proceeds anyway: only rows that
// are 'queued' and old are rewritten, and the running job is never among them,
// so a live worker's own row is not touched (user, 2026-08-17).
const running = jobs.filter((j) => j.status === 'running');
if (running.length && !process.argv.includes('--force')) {
  console.log(`실행 중인 잡이 있어 중단: ${running.map((j) => j.job_id).join(', ')}`);
  console.log('진행분이 끝난 뒤 다시 실행하거나 --force 를 쓰세요.');
  process.exitCode = 1;
  return;
}
if (running.length) {
  console.log(`--force: 실행 중 ${running.map((j) => j.job_id).join(', ')} 는 건드리지 않습니다.`);
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
  // Read it back. A previous version of this script reported success while
  // nothing changed, because the write went to a second copy of the service.
  const after = getJob(job.job_id);
  console.log(`     -> ${after ? after.status : '조회 실패'}`);
}
if (apply) {
  const left = (() => {
    const raw2 = listJobs();
    const all = Array.isArray(raw2) ? raw2 : (raw2.jobs || []);
    return all.filter((j) => j.status === 'queued').length;
  })();
  console.log(`정리 완료. 남은 queued: ${left}개`);
} else {
  console.log('(dry-run — --apply 로 실제 정리)');
}
