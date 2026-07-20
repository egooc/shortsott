const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { createProcessDraft, normalizeConfig } = require('../server/services/processEditService');
const { listQueue, validateOutputRoot } = require('../server/services/processQueueService');
const { resolveTool, getToolEnv } = require('../server/utils/toolPaths');
const highlightDb = require('../server/services/highlightPatternDbService');
const { getVideoMetadata } = require('../server/utils/ffprobe');

function parseArgs(argv = []) {
  const arg = argv.find((item) => item.startsWith('--assignmentId='));
  return { assignmentId: arg ? String(arg.split('=')[1] || '').trim() : '' };
}

function dateStamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function safeName(value = '', fallback = 'trackb') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || fallback;
}

function trackBDraftName(pairId, member) {
  return `${dateStamp()}-${member.group_label}-${member.target_duration_group}-${safeName(pairId, 'pair')}`;
}

function trimVideo(sourcePath, targetPath, startSec, durationSec) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  execFileSync(resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' }), [
    '-y', '-ss', String(startSec), '-t', String(durationSec), '-i', sourcePath,
    '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', targetPath
  ], { cwd: path.join(__dirname, '..'), env: getToolEnv(), stdio: 'pipe' });
}

function copyDraftTree(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const result = spawnSync('robocopy', [sourceDir, targetDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe'
  });
  if (result.error) throw result.error;
  const status = Number(result.status);
  if (!Number.isFinite(status) || status > 7) {
    const stderr = String(result.stderr || result.stdout || '').trim();
    throw new Error(`robocopy failed (${status}): ${stderr}`);
  }
}

function durationRangeForGroup(group = '') {
  return String(group || '').toUpperCase() === 'LONG'
    ? { min: 6, max: 10 }
    : { min: 3, max: 5 };
}

async function main() {
  const { assignmentId } = parseArgs(process.argv.slice(2));
  if (!assignmentId) throw new Error('assignmentId is required');
  const assignment = highlightDb.getAbAssignment(assignmentId);
  if (!assignment) throw new Error(`assignment not found: ${assignmentId}`);
  const source = highlightDb.getById(assignment.source_video_id);
  if (!source?.video_path) throw new Error(`source video missing: ${assignment.source_video_id}`);
  const queue = listQueue();
  const outputRoot = validateOutputRoot(queue.queueConfig?.output?.output_root || '').resolvedPath;
  const duration = Number((assignment.end_sec - assignment.start_sec).toFixed(3));
  const tempRoot = path.join(process.cwd(), 'server', 'output', 'trackb_render_tmp', assignment.pair_id, assignment.group_label);
  const trimPath = path.join(tempRoot, `${assignment.target_duration_group.toLowerCase()}_source.mp4`);
  trimVideo(source.video_path, trimPath, assignment.start_sec, duration);

  const config = normalizeConfig({
    source_video: trimPath,
    target_duration_sec: duration,
    use_tts: false,
    use_bgm: false,
    capcut_template_id: queue.queueConfig.capcut_template_id || 'process_default',
    capcut_template_draft_name: queue.queueConfig.kr_highlight_capcut_template_draft_name || queue.queueConfig.jp_highlight_capcut_template_draft_name || queue.queueConfig.capcut_template_draft_name || 'sample draft',
    video_transform_preset: queue.queueConfig.video_transform_preset || 'steady_zoom_process',
    upload_title: `Track B ${assignment.group_label} ${assignment.target_duration_group}`,
    upload_description: '',
    upload_hashtags: ['#worker', '#process', '#trackb', '#daily', '#abtest'],
    variant_policy_id: 'trackb_highlight_exact',
    caption_mode: 'long_bottom_explainer',
    output_language: 'ja',
    explainer_blocks: [{
      block_id: `trackb_${assignment.group_label}`,
      text: `${assignment.group_label} ${assignment.target_duration_group} highlight draft`,
      start_sec: 0,
      end_sec: duration,
      style_role: 'main_explainer',
      style_profile: 'highlight_explainer',
      anchor_zone: 'lower_third',
      animation: 'echo_slam'
    }]
  });

  const result = await createProcessDraft({
    config,
    useExistingConfig: false,
    createZip: false,
    ttsFiles: [],
    captionUnits: [],
    captionWarnings: [],
    srtFile: ''
  });

  const draftManifest = JSON.parse(fs.readFileSync(result.editManifestPath, 'utf8'));
  const renderedTimelineSec = Number(draftManifest.actual_timeline_duration_sec || draftManifest.target_duration_sec || 0);
  const renderedSourceMeta = getVideoMetadata(path.join(result.draftPath, 'video', 'source.mp4'));
  const renderedSourceSec = Number(renderedSourceMeta.duration_sec || 0);
  const expected = durationRangeForGroup(assignment.target_duration_group);
  const inRange = renderedTimelineSec >= expected.min && renderedTimelineSec <= expected.max;

  const finalDir = path.join(outputRoot, 'trackb', trackBDraftName(assignment.pair_id, assignment));
  copyDraftTree(result.draftPath, finalDir);
  if (!inRange) {
    highlightDb.updateAbAssignmentStatus(assignment.id, {
      status: 'dropped',
      droppedReason: 'invalid_duration_window',
      now: new Date().toISOString()
    });
  }
  console.log(JSON.stringify({
    pairId: assignment.pair_id,
    assignmentId: assignment.id,
    groupLabel: assignment.group_label,
    targetDurationGroup: assignment.target_duration_group,
    outputFolder: finalDir,
    draftPath: result.draftPath,
    manifestPath: path.join(finalDir, 'edit_manifest.json'),
    expectedDurationRangeSec: expected,
    assignmentDurationSec: duration,
    renderedTimelineSec,
    renderedSourceSec,
    validDuration: inRange,
    seamSimilarity: assignment.seam_similarity,
    scheduledPublishAt: assignment.scheduled_publish_at
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: true, message: error.message, code: error.code || '', details: error.details || null }, null, 2));
  process.exit(1);
});
