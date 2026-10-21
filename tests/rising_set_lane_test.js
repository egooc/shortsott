// scripts/rising_keywords.js setLane 자기 테스트 — 임시 파일만(네트워크 0)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setLane } = require(process.env.RK || '../scripts/rising_keywords.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-'));
const file = path.join(dir, 'seeds.json');
fs.writeFileSync(file, JSON.stringify({ _doc: 'x', lanes: { politics_ko: { lang: 'ko', geo: 'KR', mode: 'rising', seeds: ['a'] }, corp_ko: { lang: 'ko', geo: 'KR', mode: 'evergreen', seeds: ['해태'] } } }, null, 2) + '\n', 'utf8');
let r = setLane('corp_ko', { seeds: ['해태', '하이트맥주'] }, { merge: true, file });
assert.deepStrictEqual(r.lanes, ['politics_ko', 'corp_ko']);
let d = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.deepStrictEqual(d.lanes.corp_ko.seeds, ['해태', '하이트맥주']);
assert.strictEqual(d.lanes.corp_ko.mode, 'evergreen');
assert.deepStrictEqual(d.lanes.politics_ko.seeds, ['a']);   // 다른 레인 그대로
assert.strictEqual(d._doc, 'x');
r = setLane('monetize_ko', { lang: 'ko', geo: 'KR', mode: 'evergreen', seeds: ['수익'] }, { file });
assert.ok(r.added && r.lanes.length === 3);
assert.throws(() => setLane('corp_ko', { seeds: ['x'] }, { file }), /mode/);   // merge 없이 반쪽 값은 거절
assert.throws(() => setLane('../x', { lang: 'ko', mode: 'rising', seeds: [] }, { file }), /꼴/);
assert.ok(fs.readFileSync(file, 'utf8').endsWith('}\n'));
fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
