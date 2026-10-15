// docs/shared-tools.md 의 표를 읽어 server/data/tool_registry.json 을 만든다(기계용 사본).
//   node scripts/tool-registry-sync.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const md = fs.readFileSync(path.join(ROOT, 'docs/shared-tools.md'), 'utf8');
const rows = [];
let section = '';
for (const line of md.split('\n')) {
  const h = line.match(/^## (.+)/);
  if (h) { section = h[1]; continue; }
  if (!line.startsWith('|') || line.startsWith('|---') || /^\| (도구|날짜|스킬) \|/.test(line)) continue;
  const c = line.split('|').slice(1, -1).map((s) => s.trim());
  if (c.length < 4) continue;
  if (section.startsWith('4-1')) rows.push({ section, date: c[0], tool: c[1], lane: c[2], decision: c[3], why: c[4] });
  else if (section.startsWith('4.')) rows.push({ section, date: c[0], files: c[1], area: c[2], reviewer: c[3], verdict: c[4] });
  else if (section.startsWith('5.')) rows.push({ section, skill: c[0], where: c[1], what: c[2], refer: c[3] });
  else rows.push({ section, tool: c[0], owner: c[1], path: c[2], what: c[3], used_by: c[4], candidates: c[5], status: c[6] });
}
const out = path.join(ROOT, 'server/data/tool_registry.json');
fs.writeFileSync(out, JSON.stringify({ updated: new Date().toISOString(), source: 'docs/shared-tools.md', entries: rows }, null, 2) + '\n', 'utf8');
console.log(rows.length + ' entries -> ' + out);
