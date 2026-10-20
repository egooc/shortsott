// 쇼핑 태그 관문 — 공용 scripts/tag_gate.py --fail-on-warn 을 쇼핑 메타에 맞춰 부른다(10/20 관리자 adoption_check «tag_gate ❌»).
// 쇼핑 메타에는 tags 칸이 없고 업로드 때 shop_yt_tags.buildTags 로 만든다 — 실제로 넣을 태그·제목·설명을 임시 json 에 적어 넘기고, 원고는 plan.json.
// 쓰임: node scripts/shop_tag_gate.js <메타.json>   — 종료 코드는 tag_gate.py 그대로(0 통과 · 4 경고 · 5 검사 불가)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildTags } = require('./shop_yt_tags');

function check(metaPath) {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { return { code: 5, lines: [`⚠ 메타를 못 읽음: ${e.message}`] }; }
  const tmp = path.join(os.tmpdir(), `shop_tag_gate_${path.basename(metaPath)}`);
  fs.writeFileSync(tmp, JSON.stringify({ title: meta.title, description: meta.description, tags: buildTags(meta) }, null, 2) + '\n', 'utf8');
  const args = [path.join(__dirname, 'tag_gate.py'), tmp, '--fail-on-warn'];
  if (meta.file) args.push('--script', path.join(path.dirname(meta.file), 'plan.json'));
  const r = spawnSync('python', args, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  return { code: r.status == null ? 5 : r.status, lines };
}

module.exports = { check };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_tag_gate.js <메타.json>'); process.exit(2); }
  const r = check(f);
  for (const l of r.lines) console.log(l.replace(/shop_tag_gate_/, ''));
  if (r.code) console.error(`\x07✗✗✗ 태그 관문 ${r.code === 5 ? '검사 불가' : 'FAIL'} — ${path.basename(f)} 업로드 금지`);
  process.exit(r.code);
}
