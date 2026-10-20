// scripts/disk_summary.js 자기 테스트 — 임시 폴더 크기 셈·실제 요약 한 줄 꼴(API 0)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { diskSummary, dirSize, laneOf, daily } = require('../scripts/disk_summary');

const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
fs.mkdirSync(path.join(t, 'a', 'b'), { recursive: true });
fs.writeFileSync(path.join(t, 'a', 'x.bin'), Buffer.alloc(1000));
fs.writeFileSync(path.join(t, 'a', 'b', 'y.bin'), Buffer.alloc(500));
assert.strictEqual(dirSize(t), 1500);
assert.deepStrictEqual(['rinbox102ja', 'ls34', 'lx01', 'fantube', 'ls_src', '_upload'].map(laneOf), ['rinbox*', 'ls*', 'lx*', 'fantube', 'ls_src', '_upload']);
// 하루 1줄 — 같은 날 두 번이면 한 줄, 다음 날엔 직전 날짜 줄을 돌려준다
const f = path.join(t, 'daily.jsonl');
const D0 = Date.parse('2026-10-20T03:00:00Z');
assert.strictEqual(daily([{ drive: 'D', free: 100 }], { r: { a: 1 } }, { now: D0, file: f }), null);
daily([{ drive: 'D', free: 90 }], { r: { a: 2 } }, { now: D0 + 3600e3, file: f });
assert.strictEqual(fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).length, 1);
const prev = daily([{ drive: 'D', free: 50 }], { r: { a: 9 } }, { now: D0 + 86400e3, file: f });
assert.ok(prev && prev.date === '2026-10-20' && prev.free.D === 100, JSON.stringify(prev));
fs.rmSync(t, { recursive: true, force: true });
const r = diskSummary({ dailyFile: path.join(os.tmpdir(), `ds-daily-${process.pid}.jsonl`) });
assert.ok(/^디스크 — C: 빈 [\d.?]+GB/.test(r.line) && r.line.includes('hf-render 잔재'), r.line);
assert.ok(r.sessions.length <= 5 && r.line2.startsWith('D: 폴더 — volcano-runs '), r.line2);
fs.rmSync(path.join(os.tmpdir(), `ds-daily-${process.pid}.jsonl`), { force: true });
console.log('OK');
