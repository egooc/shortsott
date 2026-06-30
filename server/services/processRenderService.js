const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_FPS = 30;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || options.timeout || 10 * 60 * 1000);
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
      env: getToolEnv(options.env || {})
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill failures; the rejection below is the actionable result.
          }
          const error = new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`);
          error.code = 'ETIMEDOUT';
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }, timeoutMs)
      : null;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function ffmpegPath() {
  return resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' });
}

function normalizePathForFfmpeg(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function escapeConcatPath(filePath) {
  return normalizePathForFfmpeg(filePath).replace(/'/g, "'\\''");
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const cs = Math.floor((value % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assText(text) {
  return String(text || '')
    .replace(/\r?\n/g, '\\N')
    .replace(/[{}]/g, '');
}

function normalizeAnimationName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['slide_up', 'fade_in', 'pop', 'none'].includes(raw)) return raw;
  return 'none';
}

function estimateCaptionLines(text, charsPerLine = 24) {
  const raw = String(text || '').trim();
  if (!raw) return 1;
  const explicitLines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (explicitLines.length > 1) {
    return Math.max(explicitLines.length, Math.ceil(Math.max(...explicitLines.map((line) => line.trim().length)) / charsPerLine));
  }
  return Math.max(1, Math.ceil(raw.length / charsPerLine));
}

function explainerVerticalOffset(text) {
  const length = String(text || '').trim().length;
  const lines = estimateCaptionLines(text);
  if (lines <= 2 && length <= 54) return 0;
  if (lines === 3 || length <= 82) return 90;
  if (lines === 4 || length <= 112) return 165;
  return 245;
}

function explainerAnimatedText(text, animation, startSec, endSec) {
  const duration = Math.max(0.1, endSec - startSec);
  const anim = normalizeAnimationName(animation);
  const safe = assText(text);
  const offsetY = explainerVerticalOffset(text);
  const baseY = 1685 - offsetY;
  if (anim === 'fade_in') {
    return `{\\an2\\pos(540,${baseY})\\fad(280,120)}${safe}`;
  }
  if (anim === 'slide_up') {
    const startY = 1780 - offsetY;
    const endY = baseY;
    const moveMs = Math.min(650, Math.max(250, Math.round(duration * 1000 * 0.35)));
    return `{\\move(540,${startY},540,${endY},0,${moveMs})\\fad(180,100)}${safe}`;
  }
  if (anim === 'pop') {
    const popMs = Math.min(420, Math.max(220, Math.round(duration * 1000 * 0.25)));
    return `{\\an2\\pos(540,${baseY})\\fscx82\\fscy82\\t(0,${popMs},\\fscx106\\fscy106)\\t(${popMs},${popMs + 180},\\fscx100\\fscy100)\\fad(80,100)}${safe}`;
  }
  return `{\\an2\\pos(540,${baseY})}${safe}`;
}

function channelAnimatedText(text, repeat) {
  const safe = assText(text);
  if (!repeat) return safe;
  return `{\\fad(180,180)\\t(0,900,\\fscx104\\fscy104)\\t(900,1800,\\fscx100\\fscy100)}${safe}`;
}

function createAssSubtitleFile({ manifest, outputPath, durationSec }) {
  const channelTag = manifest.channel_tag || {};
  const explainerBlocks = Array.isArray(manifest.explainer_blocks) ? manifest.explainer_blocks : [];
  const channelText = channelAnimatedText(channelTag.text || 'PROCESS LAB', manifest.channel_tag_animation_repeat !== false);

  const events = [];
  if (channelText.trim()) {
    events.push(`Dialogue: 0,${assTime(0)},${assTime(durationSec)},Channel,,0,0,0,,${channelText}`);
  }

  for (const block of explainerBlocks) {
    const start = Math.max(0, Number(block.start_sec) || 0);
    const end = Math.max(start + 0.1, Number(block.end_sec) || durationSec);
    const text = explainerAnimatedText(block.text || '', block.animation, start, Math.min(end, durationSec));
    if (!text.trim()) continue;
    events.push(`Dialogue: 0,${assTime(start)},${assTime(Math.min(end, durationSec))},Explainer,,0,0,0,,${text}`);
  }

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Channel,Malgun Gothic,42,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,3,2,0,7,70,70,80,1',
    'Style: Explainer,Malgun Gothic,58,&H00FFFFFF,&H000000FF,&H00101010,&HAA000000,-1,0,0,0,100,100,0,0,3,2,0,2,90,90,210,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events
  ].join('\n');

  fs.writeFileSync(outputPath, ass, 'utf8');
  return { path: outputPath, eventsCount: events.length };
}

function getBgmPath(manifest, draftFolder) {
  const candidates = [
    manifest.bgm_draft_path,
    path.join(draftFolder, 'audio', 'bgm.mp3'),
    path.join(draftFolder, 'audio', 'bgm.wav'),
    path.join(draftFolder, 'audio', 'bgm.m4a')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function buildSegmentFilter(segment, manifest) {
  const globalTransform = manifest.global_video_transform || {};
  const mirrorApplied = globalTransform.mirror?.applied === true;
  const scale = Math.max(1, Number(segment.scale || segment.zoom_scale || 1));
  const width = Math.max(DEFAULT_WIDTH, Math.round(DEFAULT_WIDTH * scale / 2) * 2);
  const height = Math.max(DEFAULT_HEIGHT, Math.round(DEFAULT_HEIGHT * scale / 2) * 2);
  const panX = Number(segment.pan_x || 0);
  const panY = Number(segment.pan_y || 0);
  const rotation = Number(segment.rotation || 0);
  const targetDuration = Math.max(0.1, Number(segment.timeline_end_sec || 0) - Number(segment.timeline_start_sec || 0));
  const sourceDuration = Math.max(0.1, Number(segment.source_end_sec || 0) - Number(segment.source_start_sec || 0));
  const setPtsFactor = targetDuration / sourceDuration;

  const filters = [];
  if (mirrorApplied || segment.mirror === true) filters.push('hflip');
  filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
  if (Math.abs(rotation) > 0.001) {
    filters.push(`rotate=${rotation}*PI/180:fillcolor=black`);
  }
  const cropX = `min(max((iw-${DEFAULT_WIDTH})/2+${panX}*(iw-${DEFAULT_WIDTH}),0),iw-${DEFAULT_WIDTH})`;
  const cropY = `min(max((ih-${DEFAULT_HEIGHT})/2+${panY}*(ih-${DEFAULT_HEIGHT}),0),ih-${DEFAULT_HEIGHT})`;
  filters.push(`crop=${DEFAULT_WIDTH}:${DEFAULT_HEIGHT}:x='${cropX}':y='${cropY}'`);
  filters.push(`fps=${DEFAULT_FPS}`);
  filters.push(`setpts=${setPtsFactor.toFixed(6)}*PTS`);
  return filters.join(',');
}

async function renderSegment({ sourceVideoPath, segment, index, tempDir, manifest }) {
  const sourceStart = Math.max(0, Number(segment.source_start_sec) || 0);
  const sourceEnd = Math.max(sourceStart + 0.1, Number(segment.source_end_sec) || sourceStart + 0.1);
  const duration = sourceEnd - sourceStart;
  const outputPath = path.join(tempDir, `segment_${String(index + 1).padStart(3, '0')}.mp4`);
  const filter = buildSegmentFilter(segment, manifest);
  await runProcess(ffmpegPath(), [
    '-y',
    '-ss', String(sourceStart),
    '-t', String(duration),
    '-i', sourceVideoPath,
    '-vf', filter,
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    outputPath
  ]);
  return outputPath;
}

async function concatSegments(segmentPaths, outputPath, tempDir) {
  const concatListPath = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(
    concatListPath,
    segmentPaths.map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`).join('\n'),
    'utf8'
  );
  await runProcess(ffmpegPath(), [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    outputPath
  ]);
}

async function burnAssAndAudio({ inputVideoPath, assPath, bgmPath, outputPath, durationSec, bgmVolume }) {
  const assFilterPath = normalizePathForFfmpeg(assPath).replace(/:/g, '\\:').replace(/'/g, "\\'");
  const filters = [`[0:v]ass='${assFilterPath}'[v]`];
  const args = ['-y', '-i', inputVideoPath];
  if (bgmPath) {
    args.push('-stream_loop', '-1', '-i', bgmPath);
    filters.push(`[1:a]volume=${Number(bgmVolume || 0.18)},atrim=0:${durationSec},asetpts=PTS-STARTPTS[a]`);
  }
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[v]');
  if (bgmPath) args.push('-map', '[a]');
  else args.push('-an');
  args.push(
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p'
  );
  if (bgmPath) args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
  args.push(outputPath);
  await runProcess(ffmpegPath(), args);
}

async function renderProcessFinalMp4({ draftFolder, outputPath = '', enabled = true } = {}) {
  if (!enabled) {
    return { enabled: false, status: 'skipped', reason: 'direct render disabled' };
  }
  const resolvedDraftFolder = path.resolve(draftFolder || '');
  const manifestPath = path.join(resolvedDraftFolder, 'edit_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`edit_manifest.json not found: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  const sourceVideoPath = manifest.draft_video_path || path.join(resolvedDraftFolder, 'video', 'source.mp4');
  if (!fs.existsSync(sourceVideoPath)) {
    throw new Error(`render source video not found: ${sourceVideoPath}`);
  }

  const segmentPlan = Array.isArray(manifest.segment_transform_plan) ? manifest.segment_transform_plan : [];
  if (!segmentPlan.length) {
    throw new Error('segment_transform_plan is empty; cannot render final mp4');
  }

  const tempDir = path.join(resolvedDraftFolder, 'render_tmp');
  ensureDir(tempDir);
  const finalPath = outputPath
    ? path.resolve(outputPath)
    : path.join(resolvedDraftFolder, 'final.mp4');
  ensureDir(path.dirname(finalPath));

  const durationSec = Number(manifest.target_duration_sec || segmentPlan[segmentPlan.length - 1]?.timeline_end_sec || 0);
  const assPath = path.join(tempDir, 'overlays.ass');
  const assSummary = createAssSubtitleFile({ manifest, outputPath: assPath, durationSec });
  const animationSummary = (manifest.explainer_blocks || []).map((block) => ({
    block_id: block.block_id,
    animation: normalizeAnimationName(block.animation),
    start_sec: Number(block.start_sec || 0),
    end_sec: Number(block.end_sec || durationSec)
  }));

  const segmentPaths = [];
  for (let i = 0; i < segmentPlan.length; i += 1) {
    segmentPaths.push(await renderSegment({
      sourceVideoPath,
      segment: segmentPlan[i],
      index: i,
      tempDir,
      manifest
    }));
  }

  const joinedPath = path.join(tempDir, 'joined_video.mp4');
  await concatSegments(segmentPaths, joinedPath, tempDir);
  const bgmPath = getBgmPath(manifest, resolvedDraftFolder);
  await burnAssAndAudio({
    inputVideoPath: joinedPath,
    assPath,
    bgmPath,
    outputPath: finalPath,
    durationSec,
    bgmVolume: manifest.bgm_volume || 0.18
  });

  const stats = fs.statSync(finalPath);
  const renderSummary = {
    enabled: true,
    status: 'success',
    renderer: 'ffmpeg_direct',
    outputPath: finalPath,
    fileSize: stats.size,
    durationSec,
    sourceVideoPath,
    bgmPath,
    segmentCount: segmentPlan.length,
    overlayEventsCount: assSummary.eventsCount,
    textAnimationsApplied: animationSummary,
    limitations: [
      'CapCut template clone effects are approximated, not pixel-identical.',
      'FFmpeg text animation supports slide_up, fade_in, pop, and none.'
    ]
  };

  manifest.direct_render = renderSummary;
  writeJson(manifestPath, manifest);

  const reportPath = path.join(resolvedDraftFolder, 'direct_render_report.json');
  writeJson(reportPath, renderSummary);

  return {
    ...renderSummary,
    manifestPath,
    reportPath
  };
}

module.exports = {
  renderProcessFinalMp4
};
