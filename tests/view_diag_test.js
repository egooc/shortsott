// scripts/view_diag.js 자기 테스트 — API 0.
const assert = require('assert');
const { diagnose, wall, band, firstBranch } = require('../scripts/view_diag.js');

assert.strictEqual(wall(112).name, '스와이프 벽');            // 팬튜브 112
assert.strictEqual(wall(1450).name, '리액션 벽');             // 지구관측소 드라마 1,100~1,900
assert.strictEqual(wall(25000).name, '포맷 벽');
assert.strictEqual(wall(5000, 'long'), null);
assert.strictEqual(band(800).range, '0~1,000');
assert.strictEqual(band(15000).cause, '영상은 좋은데 중복도');
// 첫 분기: 노출 깨짐이 먼저
let b = firstBranch({ kind: 'long', impressions: 1000, ctr: 1, avp: 10, base: { impressions: 10000 } });
assert.strictEqual(b.broken, '노출');
b = firstBranch({ kind: 'long', impressions: 9000, ctr: 2.1, avp: 10, base: { impressions: 10000 } });
assert.strictEqual(b.broken, '클릭률');
b = firstBranch({ kind: 'long', impressions: 9000, ctr: 5, avp: 22, base: { impressions: 10000 } });
assert.strictEqual(b.broken, '지속률');
b = firstBranch({ kind: 'shorts', avp: 41 });                 // 노출 수치 없어도 지속 깨짐은 잡고, 필요한 수치는 적는다
assert.strictEqual(b.broken, '지속률');
assert.deepStrictEqual(b.need, ['노출수(스튜디오)']);
b = firstBranch({ kind: 'shorts' });
assert.strictEqual(b.broken, null);
assert.ok(b.prescription.includes('보류'));
const d = diagnose({ views: 1450, kind: 'shorts', avp: 82, impressions: 60000, base: { impressions: 80000 } });
assert.ok(d.line.includes('리액션 벽') && d.line.includes('세 숫자 정상'), d.line);
console.log('OK');
