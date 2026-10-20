// scripts/view_diag.js 자기 테스트 — API 0.
const assert = require('assert');
const { diagnose, wall, band, firstBranch, at48, relative, autopsy, THRESH } = require('../scripts/view_diag.js');

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
// 10-21 G8·G16·V13
assert.strictEqual(THRESH.ctr.long, 5);
assert.deepStrictEqual([at48(300, 100).verdict, at48(40, 100).verdict, at48(100, 100).verdict, at48(null, 100).verdict], ['오름', '꺾임', '보통', null]);
assert.strictEqual(relative(100, 10, [{ views: 1000, hours: 10 }, { views: 2000, hours: 20 }]).verdict, '열세');
assert.ok(diagnose({ views: 300, kind: 'shorts', views_48h: 300, lane_median_48h: 1000, hours: 48, competitors: [{ views: 900, hours: 48 }] }).line.includes('48h 꺾임'));
const a = autopsy({ ours: { title: '크랜베리 밭 물에 잠그는 이유', first3s: '빨간 밭은 왜', segments: 6, duration: 48 }, ref: { title: '크랜베리 밭 수확 이유', first3s: '농부가 밭에 물을', segments: 16, duration: 45 } });
assert.ok(a.same_topic.verdict === '같은 소재' && a.flow.verdict === '우리가 느림' && a.next_fix, JSON.stringify(a));
assert.strictEqual(autopsy({ ours: { title: 'a 고양이' }, ref: { title: '강아지 산책' }, missing: [{ what: '끝 반전' }] }).next_fix, '끝 반전');
console.log('OK');
