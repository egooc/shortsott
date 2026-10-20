// scripts/hook_table.js 자기 테스트 — 임시 장부·폴더로 편 모으기·경로 풀기·70% 묶음(API 0, GPT 0)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, resolve, split, md } = require('../scripts/hook_table');

const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-'));
const now = Date.parse('2026-10-20T09:00:00Z');
const led = path.join(t, 'ledger.jsonl');
fs.writeFileSync(led, [
  { lane: 'fantube', id: 'ep09', youtube_id: 'AAA', at: '2026-10-15T00:00:00Z' },
  { lane: 'fantube', id: 'ep01', youtube_id: 'OLD', at: '2026-08-01T00:00:00Z' },          // 30일 밖
  { lane: 'n100_ko_event', id: 'ott1', youtube_id: 'N1', at: '2026-10-19T00:00:00Z' },      // 로컬 폴더 없는 레인
  { lane: 'ko_longshort', id: 'lx02', youtube_id: 'P1,P2', at: '2026-10-17T00:00:00Z' },
  { lane: 'politics_short', id: '20261017-shorts', youtube_id: 'SKIP', at: '2026-10-17T00:00:00Z' },
].map((r) => JSON.stringify(r)).join('\n') + '\n');
const pr = path.join(t, 'shorts');
fs.mkdirSync(path.join(pr, '20261020'), { recursive: true });
fs.writeFileSync(path.join(pr, '20261020', 'upload_log.jsonl'), JSON.stringify({ meta: 's2_hamkke.upload.json', videoId: 'H1', publishAt: '2026-10-20T09:00:00Z' }) + '\n');
const rows = collect({ now, ledger: led, politicsRoot: pr });
assert.deepStrictEqual(rows.map((r) => r.videoId).sort(), ['AAA', 'H1', 'P1', 'P2']);
assert.strictEqual(rows.find((r) => r.videoId === 'H1').id, '20261020/s2_hamkke');
// 경로: 정치 쇼츠 plan·final, 팬튜브 spec·out
fs.mkdirSync(path.join(pr, 'ls', '20261020', 's2_hamkke', '_render'), { recursive: true });
fs.writeFileSync(path.join(pr, 'ls', '20261020', 's2_hamkke', 'plan.json'), '{}');
fs.writeFileSync(path.join(pr, 'ls', '20261020', 's2_hamkke', '_render', 'final.mp4'), '');
const r1 = resolve('politics_short', '20261020/s2_hamkke', { politicsRoot: pr });
assert.ok(r1.spec.endsWith('plan.json') && r1.video.endsWith('final.mp4'), JSON.stringify(r1));
fs.mkdirSync(path.join(t, 'runs', 'fantube', 'ep09'), { recursive: true });
fs.writeFileSync(path.join(t, 'runs', 'fantube', 'ep09', 'spec.json'), '{}');
const r2 = resolve('fantube', 'ep09', { runs: path.join(t, 'runs') });
assert.ok(r2.spec && r2.video === null, JSON.stringify(r2));
// 70% 묶음
const g = split([{ stay_ratio: 82 }, { stay_ratio: 70 }, { stay_ratio: 55 }, { stay_ratio: null }]);
assert.deepStrictEqual([g.high.length, g.low.length, g.none.length], [2, 1, 1]);
assert.ok(md([{ lane: 'fantube', id: 'ep09', videoId: 'AAA', stay_ratio: 82, avp: 90, first_sentence: 'a|b' }], { api: true }).includes('## 70% 이상 (1편)'));
fs.rmSync(t, { recursive: true, force: true });
console.log('OK');
