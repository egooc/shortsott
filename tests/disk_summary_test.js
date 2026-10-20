// scripts/disk_summary.js 자기 테스트 — 임시 폴더 크기 셈·실제 요약 한 줄 꼴(API 0)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { diskSummary, dirSize } = require('../scripts/disk_summary');

const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
fs.mkdirSync(path.join(t, 'a', 'b'), { recursive: true });
fs.writeFileSync(path.join(t, 'a', 'x.bin'), Buffer.alloc(1000));
fs.writeFileSync(path.join(t, 'a', 'b', 'y.bin'), Buffer.alloc(500));
assert.strictEqual(dirSize(t), 1500);
fs.rmSync(t, { recursive: true, force: true });
const r = diskSummary();
assert.ok(/^디스크 — C: 빈 [\d.?]+GB/.test(r.line) && r.line.includes('hf-render 잔재'), r.line);
assert.ok(r.sessions.length <= 5);
console.log('OK');
