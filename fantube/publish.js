// 최애모먼트 발행 한 번에 — 업로드(예약) → 태그 게이트 → 업로드 기록 → 제작 장부.
//   node fantube/publish.js <epNN> <upload.json> <publishAt ISO>
// 태그 게이트(10/16 관리자): 태그를 넣고 다시 읽어 0개면 예약을 풀어 비공개로 두고 멈춘다(exit 2, 관리자 보고).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const [ep, meta, at] = process.argv.slice(2);
if (!ep || !meta || !at) throw new Error('usage: node fantube/publish.js <epNN> <upload.json> <publishAt ISO>');
const ROOT = path.join(__dirname, '..');
const LOG = 'D:/volcano-runs/fantube/_upload/upload_log.jsonl';

const out = execFileSync('node', [path.join(ROOT, 'scripts', 'yt-upload.js'), meta, '--purpose', 'idol_fantube_ko', '--publish-at', at],
  { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(out);
const last = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), meta: path.basename(meta), videoId: last.videoId, publishAt: last.publishAt }) + '\n', 'utf8');

const g = spawnSync('node', [path.join(__dirname, 'yt_tags.js'), last.videoId, meta, '--gate'], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(g.stdout); process.stderr.write(g.stderr);
if (g.status !== 0) { console.error(`[publish] 태그 게이트 실패(${g.status}) — 공개 금지, 관리자 보고`); process.exit(2); }

const l = spawnSync('node', [path.join(__dirname, 'ledger.js'), ep, '--youtube-id', last.videoId, '--publish-at', at], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(l.stdout); process.stderr.write(l.stderr);
console.log(`[publish] ${ep} → ${last.videoId} · ${at} · 태그 확인 끝`);
