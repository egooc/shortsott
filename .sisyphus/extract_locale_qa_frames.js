const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const { extractVideoClipChainFromDraftContent } = require('../server/services/midformFinalDraftOverlapService');

const QA_ROOT = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'locale_manual_qa_20260729');

const samples = [
  {
    id: 'emotional_dialogue_fences',
    label: 'emotional dialogue — Fences father/son',
    sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/source.mp4')
  },
  {
    id: 'reveal_reversal_bucky_wakanda',
    label: 'reveal/reversal — Bucky Wakanda deprogramming',
    sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_010_H9GPm8uG8Es_bucky_wakanda_raw/source.mp4')
  }
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function rel(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function midpoint(range) {
  return Number((((range?.[0] || 0) + (range?.[1] || 0)) / 2).toFixed(3));
}

function clipSummary(chain) {
  return chain.map((clip, index) => ({
    index,
    clip_id: clip.clip_id,
    source_range: clip.source_range,
    timeline_range: clip.timeline_range,
    duration_sec: clip.duration_sec
  }));
}

function selectedClips(chain) {
  const opening = chain.filter((clip) => Number(clip.timeline_range?.[0] || 0) < 15).slice(0, 5);
  const tail = chain.slice(-5);
  const middleStart = Math.max(0, Math.floor(chain.length / 2) - 2);
  const middle = chain.slice(middleStart, middleStart + 5);
  return { opening, middle, tail };
}

function extractFrame(sourceVideoPath, outPath, second) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-ss', String(Math.max(0, second)), '-i', sourceVideoPath, '-frames:v', '1', '-vf', 'scale=360:-1', outPath], { cwd: PROJECT_ROOT, stdio: 'ignore' });
}

function makeContactSheet(framePaths, outPath) {
  if (!framePaths.length) return '';
  const listPath = `${outPath}.txt`;
  fs.writeFileSync(listPath, framePaths.map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-filter_complex', `tile=${framePaths.length}x1:padding=8:margin=8`, outPath], { cwd: PROJECT_ROOT, stdio: 'ignore' });
  return outPath;
}

const report = [];
for (const sample of samples) {
  const workspaceDir = path.join(QA_ROOT, sample.id);
  const overlap = readJson(path.join(workspaceDir, 'overlap_report_final_draft.ko_vs_ja.json'));
  const sampleReport = { sample: sample.id, label: sample.label, workspace: rel(workspaceDir), overlap, locales: {} };
  for (const locale of ['ko', 'ja']) {
    const draftContentPath = path.join(workspaceDir, `draft_content.${locale}.json`);
    const chain = extractVideoClipChainFromDraftContent(readJson(draftContentPath));
    const buckets = selectedClips(chain);
    const frameRoot = path.join(workspaceDir, 'manual_review_frames', locale);
    const sheets = {};
    for (const [bucketName, clips] of Object.entries(buckets)) {
      const framePaths = clips.map((clip, index) => {
        const outPath = path.join(frameRoot, `${bucketName}_${String(index + 1).padStart(2, '0')}_${clip.clip_id}.jpg`);
        extractFrame(sample.sourceVideoPath, outPath, midpoint(clip.source_range));
        return outPath;
      });
      const sheetPath = path.join(frameRoot, `${bucketName}_contact_sheet.jpg`);
      makeContactSheet(framePaths, sheetPath);
      sheets[bucketName] = rel(sheetPath);
    }
    sampleReport.locales[locale] = {
      draft_folder: rel(path.join(workspaceDir, `draft_${locale}`)),
      draft_content: rel(draftContentPath),
      clip_count: chain.length,
      opening_chain: clipSummary(buckets.opening),
      middle_chain: clipSummary(buckets.middle),
      payoff_tail_chain: clipSummary(buckets.tail),
      contact_sheets: sheets
    };
  }
  report.push(sampleReport);
}

writeJson(path.join(QA_ROOT, 'manual_visual_chain_report.json'), report);
process.stdout.write(JSON.stringify(report.map((item) => ({ sample: item.sample, workspace: item.workspace, status: item.overlap.final_status, sheets: { ko: item.locales.ko.contact_sheets, ja: item.locales.ja.contact_sheets } })), null, 2));
