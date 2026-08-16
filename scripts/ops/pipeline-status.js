// One-shot health read of the whole line: schedules, producer, buffer, uploads,
// queue. This is the check that was being retyped by hand every time someone
// asked "is it running?", and getting it wrong in ways that mattered - counting
// held/ as pending, or reading a PowerShell-mangled regex as a real result.
//
//   node scripts/ops/pipeline-status.js [--json]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS, '_automation factory');
const UPLOADED_DIR = path.join(EXPORT_DIR, 'uploaded');
const HELD_DIR = path.join(EXPORT_DIR, 'held');
const QUEUE_DIR = path.join(ROOT, 'queue', 'process');

const base = (n) => n.replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');
const isKorean = (n) => /[가-힣]/.test(n);
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

function spentNames() {
  const names = new Set();
  for (const dir of [EXPORT_DIR, UPLOADED_DIR, HELD_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.toLowerCase().endsWith('.mp4')) names.add(base(f));
  }
  return names;
}

function bufferState() {
  const state = readJson(path.join(ROOT, 'server', 'data', 'hourly_upload_state.json'), {});
  const uploaded = new Set((state.history || []).map((h) => base(String(h.file || ''))));
  const files = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter((f) => f.toLowerCase().endsWith('.mp4'))
    : [];
  const ready = files.filter((f) => !uploaded.has(base(f)));
  return {
    ready_total: ready.length,
    ready_jp: ready.filter((f) => !isKorean(f)).length,
    ready_kr: ready.filter((f) => isKorean(f)).length,
    last_uploads: (state.history || []).slice(-4).map((h) => ({
      at: h.at, channel: h.channel, url: h.url
    }))
  };
}

function draftState() {
  const spent = spentNames();
  const ledger = readJson(path.join(ROOT, 'server', 'data', 'export_failures.json'), {});
  const waiting = [];
  const blocked = [];
  if (fs.existsSync(DRAFTS)) {
    for (const e of fs.readdirSync(DRAFTS, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '_automation factory') continue;
      if (spent.has(e.name)) continue;
      if (!fs.existsSync(path.join(DRAFTS, e.name, 'edit_manifest.json'))) continue;
      const attempts = (ledger[e.name] && ledger[e.name].attempts) || 0;
      (attempts >= 2 ? blocked : waiting).push(e.name);
    }
  }
  return { waiting, blocked };
}

function queueState() {
  if (!fs.existsSync(QUEUE_DIR)) return { unanalysed: 0, total: 0 };
  let unanalysed = 0;
  let total = 0;
  for (const id of fs.readdirSync(QUEUE_DIR).filter((n) => /^item_/.test(n))) {
    const cfg = readJson(path.join(QUEUE_DIR, id, 'item_config.json'), null);
    if (!cfg) continue;
    total += 1;
    if (!cfg.analysis_status) unanalysed += 1;
  }
  return { unanalysed, total };
}

function producerState() {
  const lockPath = path.join(ROOT, 'server', 'data', 'hourly_produce.lock');
  const lock = readJson(lockPath, null);
  let running = false;
  if (lock && lock.pid) {
    try { process.kill(lock.pid, 0); running = true; } catch { running = false; }
  }
  const logPath = path.join(ROOT, 'server', 'output', 'daily-reports', 'hourly-produce.log');
  let tail = [];
  try {
    tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-3);
  } catch { /* no log yet */ }
  return { running, since: lock && lock.at, tail };
}

function scheduledTasks() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-ScheduledTask | Where-Object { $_.TaskName -like '*Ottogi*' } | ForEach-Object { $i = Get-ScheduledTaskInfo -TaskName $_.TaskName; '{0}|{1}|{2}|{3}' -f $_.TaskName, $_.State, $i.LastTaskResult, $i.NextRunTime }"
    ], { encoding: 'utf8', timeout: 60000 });
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [name, state, result, next] = line.split('|');
      return { name, state, last_result: result, next_run: next };
    });
  } catch (error) {
    return [{ error: String(error.message || error).slice(0, 120) }];
  }
}

const report = {
  at: new Date().toISOString(),
  tasks: scheduledTasks(),
  producer: producerState(),
  buffer: bufferState(),
  drafts: draftState(),
  queue: queueState()
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[스케줄]`);
  for (const t of report.tasks) {
    console.log(t.error ? `  조회 실패: ${t.error}` : `  ${t.name.padEnd(22)} ${t.state} | 마지막결과 ${t.last_result} | 다음 ${t.next_run}`);
  }
  console.log(`[제작] ${report.producer.running ? `실행 중 (since ${report.producer.since})` : '대기'}`);
  report.producer.tail.forEach((l) => console.log(`  ${l.slice(0, 120)}`));
  console.log(`[버퍼] 업로드 가능 ${report.buffer.ready_total}편 (JP ${report.buffer.ready_jp} / KR ${report.buffer.ready_kr})`);
  report.buffer.last_uploads.forEach((u) => console.log(`  ${String(u.at).slice(5, 16)} ${u.channel} ${u.url}`));
  console.log(`[드래프트] 내보내기 대기 ${report.drafts.waiting.length} | 원장 차단 ${report.drafts.blocked.length}`);
  report.drafts.waiting.slice(0, 5).forEach((n) => console.log(`  대기 ${n.slice(0, 52)}`));
  console.log(`[큐] 총 ${report.queue.total} | 미분석 ${report.queue.unanalysed}`);
}
