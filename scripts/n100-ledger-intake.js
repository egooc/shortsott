#!/usr/bin/env node
// N100 하루 성과 JSON(server/data/n100_daily/YYYY-MM-DD.json) → 제작 장부(server/data/production_ledger.jsonl) 행 추가.
//   node scripts/n100-ledger-intake.js server/data/n100_daily/2026-10-15.json
// 규격은 docs/production-ledger.md. lane 은 n100_<N100 레인 키>, session 은 "N100".
// 같은 lane/id 가 이미 장부에 있으면 건너뛴다(여러 번 돌려도 안전). JSON 쓰기는 JSON.stringify + '\n', UTF-8.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'server/data/production_ledger.jsonl');

function main() {
  const file = process.argv[2];
  if (!file) { console.error('사용법: node scripts/n100-ledger-intake.js <n100 daily json>'); process.exit(2); }
  const daily = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(daily.videos)) { console.error('videos 배열이 없다'); process.exit(2); }

  const have = new Set();
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); have.add(`${r.lane}/${r.id}`); } catch (_) { /* 깨진 줄은 무시 */ }
    }
  }

  const rows = [];
  for (const v of daily.videos) {
    const lane = `n100_${v.lane}`;
    if (have.has(`${lane}/${v.id}`)) continue;
    const note = [v.channel ? `채널=${String(v.channel).trim()}` : null,
      v.subject_read_secs != null ? `subject_read_secs=${v.subject_read_secs}` : null].filter(Boolean).join(' · ');
    rows.push({
      at: v.finished_at || `${daily.date}T23:59:59+09:00`,
      session: 'N100',
      lane,
      id: v.id,
      title: '',
      started_at: v.started_at || null,
      finished_at: v.finished_at || null,
      render_secs: v.render_secs ?? null,
      gpt_calls: v.gpt_calls || 0,
      rejected: v.rejected || 0,
      youtube_id: v.youtube_id || null,
      publish_at: v.publish_at || null,
      note,
    });
  }
  if (rows.length) {
    fs.appendFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  console.log(`${path.basename(file)}: ${daily.videos.length}편 중 ${rows.length}편 추가, ${daily.videos.length - rows.length}편 이미 있음`);
}

main();
