// Build a contact sheet for the clips the numbers like least, so a human eye is spent where it pays.
//
// The audio verifier can prove a clip carries its line; it cannot tell whether the person on screen
// is the one speaking, or whether the shot makes sense. That judgement is the owner's, and reviewing
// twenty-five clips per source to find the two weak ones wastes it. This takes the verifier's report,
// ranks the clips by how little confidence we have in them, and renders three frames from each into
// one strip with the caption underneath.
//
//   node midform/scripts/build_review_contact_sheet.js <verify.json> <source.mp4> <out_dir> [--top 5]
//
// Needs ffmpeg on PATH. Writes one jpg per clip plus an index.md naming what to look for.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const verifyPath = process.argv[2];
const sourcePath = process.argv[3];
const outDir = process.argv[4];
const topIdx = process.argv.indexOf('--top');
const TOP = topIdx > 0 ? Number(process.argv[topIdx + 1]) : 5;

if (!verifyPath || !sourcePath || !outDir) {
  console.error('usage: build_review_contact_sheet.js <verify.json> <source.mp4> <out_dir> [--top N]');
  process.exit(2);
}

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const report = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
const rows = (report.rows || []).filter((row) => row.status === 'checked');
const findings = report.findings || [];

// Rank by weakness: a finding against the clip counts most, then low containment, then a boundary
// this tool moved. Clips nothing is wrong with are not worth the owner's attention.
const findingsByClip = new Map();
for (const finding of findings) {
  for (const id of String(finding.clip).split('+')) {
    findingsByClip.set(id, [...(findingsByClip.get(id) || []), finding]);
  }
}
const ranked = rows
  .map((row) => {
    const own = findingsByClip.get(row.id) || [];
    const severity = own.reduce((sum, f) => sum + (f.level === 'FAIL' ? 10 : 1), 0);
    return { ...row, findings: own, weakness: severity + (1 - (row.timeline_containment ?? 1)) * 5 };
  })
  .filter((row) => row.weakness > 0.05)
  .sort((a, b) => b.weakness - a.weakness)
  .slice(0, TOP);

if (!ranked.length) {
  console.log('nothing scored weak enough to be worth a look');
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const lines = ['# 검수 대상 클립 (수치가 가장 약한 순)', '',
  '자동 판정이 못 보는 것만 봐주세요: **말하는 사람이 화면에 있는지**, 컷이 자연스러운지.', ''];

for (const [index, row] of ranked.entries()) {
  const span = Math.max(0.2, row.end - row.start);
  const stamps = [row.start + span * 0.15, row.start + span * 0.5, row.start + span * 0.85];
  const frames = [];
  for (const [n, at] of stamps.entries()) {
    const framePath = path.join(outDir, `.${row.id}_${n}.jpg`);
    const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(at.toFixed(3)), '-i', sourcePath,
      '-frames:v', '1', '-vf', 'scale=420:-1', framePath, '-y'], { encoding: 'utf8' });
    if (result.status === 0 && fs.existsSync(framePath)) frames.push(framePath);
  }
  if (!frames.length) continue;
  const sheet = path.join(outDir, `${String(index + 1).padStart(2, '0')}_${row.id}.jpg`);
  const args = frames.flatMap((frame) => ['-i', frame]);
  spawnSync(ffmpeg, ['-v', 'error', ...args, '-filter_complex', `hstack=inputs=${frames.length}`, sheet, '-y'], { encoding: 'utf8' });
  for (const frame of frames) fs.rmSync(frame, { force: true });

  lines.push(`## ${index + 1}. ${row.id} — ${row.start.toFixed(2)}~${row.end.toFixed(2)}s`);
  lines.push('');
  lines.push(`- 대사: "${String(row.line).slice(0, 80)}"`);
  lines.push(`- 발화 구간: ${row.spoken_start}~${row.spoken_end}s · 타임라인 포함률 ${row.timeline_containment}`);
  for (const finding of row.findings) lines.push(`- ${finding.level} ${finding.kind}: ${finding.detail}`);
  lines.push(`- 프레임: ![${row.id}](${path.basename(sheet)})`);
  lines.push('');
}

const indexPath = path.join(outDir, 'index.md');
fs.writeFileSync(indexPath, lines.join('\n'));
console.log(`${ranked.length} clips -> ${indexPath}`);
