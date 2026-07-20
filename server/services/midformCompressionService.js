const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');
const {
  MIDFORM_SLOT_FILLS_SCHEMA_PATH,
  MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH,
  MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH,
  runCodexCli,
  extractJson
} = require('./gptMidformCliService');

const COMPRESS_RUNS_DIR = path.join(PROJECT_ROOT, 'midform', 'test_runs');
const DEFAULT_TARGET_SEC = 180;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), 'utf8');
}

function timestampForId() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
}

function safeSlug(value, fallback = 'compress') {
  const slug = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9가-힣_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  return slug || fallback;
}

function roundSec(value) {
  return Number((Number(value) || 0).toFixed(3));
}

function formatClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: PROJECT_ROOT,
      env: getToolEnv(options.env || {}),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: options.maxBuffer || 100 * 1024 * 1024,
      timeout: options.timeout || 15 * 60 * 1000
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function normalizeSourceUrl(source) {
  const text = String(source || '').trim();
  if (!text) throw new Error('--source is required');
  return text;
}

function createCompressionRun(sourceUrl) {
  const hint = sourceUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] || crypto.randomUUID().slice(0, 8);
  const runId = `compress_${timestampForId()}_${safeSlug(hint)}`;
  const runDir = path.join(COMPRESS_RUNS_DIR, runId);
  ensureDir(runDir);
  return { runId, runDir };
}

function parseVttTime(value) {
  const text = String(value || '').trim().replace(',', '.');
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return roundSec(parts[0] * 60 + parts[1]);
  if (parts.length === 3) return roundSec(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
}

function cleanVttText(text) {
  return String(text || '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVtt(vttText) {
  const cues = [];
  const lines = String(vttText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    const timing = line.includes('-->') ? line : lines[index + 1]?.trim() || '';
    if (!timing.includes('-->')) {
      index += 1;
      continue;
    }
    if (timing !== line) index += 1;
    const [startRaw, endRaw] = timing.split('-->').map((part) => part.trim().split(/\s+/)[0]);
    const startSec = parseVttTime(startRaw);
    const endSec = parseVttTime(endRaw);
    index += 1;
    const textLines = [];
    while (index < lines.length && lines[index].trim()) {
      const nextLine = lines[index].trim();
      if (!/^NOTE\b|^STYLE\b|^REGION\b/i.test(nextLine)) textLines.push(nextLine);
      index += 1;
    }
    const text = cleanVttText(textLines.join(' '));
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && text) {
      cues.push({ start_sec: startSec, end_sec: endSec, text });
    }
    index += 1;
  }
  return cues;
}

function findVttFile(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.vtt'))
    .map((entry) => path.join(dirPath, entry.name));
  files.sort((left, right) => {
    const leftName = path.basename(left).toLowerCase();
    const rightName = path.basename(right).toLowerCase();
    const score = (name) => (name.includes('.en') ? 0 : 1) + (name.includes('live_chat') ? 10 : 0);
    return score(leftName) - score(rightName) || leftName.localeCompare(rightName);
  });
  return files[0] || '';
}

async function loadYoutubeMetadata(sourceUrl, runDir) {
  const ytDlp = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  const result = await execFileAsync(ytDlp, ['--dump-single-json', '--skip-download', '--no-playlist', sourceUrl], { timeout: 10 * 60 * 1000 });
  const metadata = JSON.parse(result.stdout.trim());
  const metadataPath = path.join(runDir, 'source_info.json');
  writeJson(metadataPath, metadata);
  return { metadata, metadataPath };
}

async function extractTimedTranscript(sourceUrl, runDir) {
  const ytDlp = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  const subtitleDir = path.join(runDir, 'subtitles_raw');
  ensureDir(subtitleDir);
  await execFileAsync(ytDlp, [
    '--skip-download',
    '--no-playlist',
    '--write-sub',
    '--write-auto-sub',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'vtt',
    '-o', path.join(subtitleDir, '%(id)s.%(ext)s'),
    sourceUrl
  ], { timeout: 15 * 60 * 1000 });
  const vttPath = findVttFile(subtitleDir);
  if (!vttPath) {
    const blocked = { status: 'blocked', code: 'SUBTITLE_NOT_FOUND', message: '자막 없음: 이번 스코프에서는 STT fallback을 수행하지 않습니다.' };
    writeJson(path.join(runDir, 'compress_state.json'), blocked);
    throw Object.assign(new Error(blocked.message), { code: blocked.code, details: blocked });
  }
  const transcript = parseVtt(fs.readFileSync(vttPath, 'utf8'));
  if (!transcript.length) throw Object.assign(new Error('Timed subtitle file did not contain usable cues'), { code: 'SUBTITLE_PARSE_EMPTY', details: { vttPath } });
  const transcriptPath = path.join(runDir, 'transcript_timed.json');
  writeJson(transcriptPath, transcript);
  return { transcript, transcriptPath, vttPath };
}

function extractHeatmap(metadata, runDir) {
  const raw = Array.isArray(metadata?.heatmap) ? metadata.heatmap : [];
  const items = raw
    .map((item) => ({
      start_sec: roundSec(item?.start_time ?? item?.start_sec),
      end_sec: roundSec(item?.end_time ?? item?.end_sec),
      score: Number(item?.value ?? item?.score ?? 0)
    }))
    .filter((item) => Number.isFinite(item.start_sec) && Number.isFinite(item.end_sec) && item.end_sec > item.start_sec && Number.isFinite(item.score));
  const heatmap = items.length
    ? { status: 'available', source: 'yt-dlp.info.heatmap', reason: '', items }
    : { status: 'unavailable', source: 'yt-dlp.info.heatmap', reason: metadata?.heatmap === null ? 'heatmap_null' : 'heatmap_missing_or_empty', items: [] };
  const heatmapPath = path.join(runDir, 'heatmap.json');
  writeJson(heatmapPath, heatmap);
  return { heatmap, heatmapPath };
}

function compactTranscript(transcript) {
  return transcript.map((cue, index) => ({
    cue_id: `T${String(index + 1).padStart(4, '0')}`,
    start_sec: cue.start_sec,
    end_sec: cue.end_sec,
    text: cue.text
  }));
}

function buildBeatsPrompt(transcript, metadata) {
  return [
    'You are segmenting a long movie clip transcript into narrative beats for a Korean midform compression workflow.',
    'Return JSON only matching the schema. Do not use markdown.',
    '',
    'Rules:',
    '- Use only the provided timed transcript. Do not invent events, motives, or dialogue.',
    '- Every beat start_sec/end_sec must stay inside the provided cue ranges.',
    '- Preserve source order.',
    '- Make beats story-sized, not subtitle-sized. Prefer 5-9 beats for a 5-10 minute clip.',
    '- key_dialogue must quote exact source dialogue snippets from the transcript.',
    '- dramatic_weight and hook_potential are 1 to 5.',
    '- dialogue_quality must be one of high, mid, low.',
    '',
    `Video title: ${metadata?.title || ''}`,
    `Duration: ${metadata?.duration || ''}`,
    '',
    'Timed transcript JSON:',
    JSON.stringify(compactTranscript(transcript), null, 2)
  ].join('\n');
}

function buildEditPlanPrompt(beats, heatmap, targetSec, metadata) {
  return [
    'You are designing a 3-minute Korean midform compression edit plan from narrative beats and YouTube most-replayed data.',
    'Return JSON only matching the schema. Do not use markdown.',
    '',
    'Goal structure:',
    '1. cold_open: put the highest replay / strongest hook beat first as a short teaser. Do not reveal the answer.',
    '2. bridge: one rewind narration slot explaining "how did this happen?".',
    '3. body: continue selected beats in story order.',
    '4. body_peak: when the cold_open beat arrives in story order, replay it with full context.',
    '5. payoff: close with the strongest unresolved implication or reveal supported by the transcript.',
    '',
    'Rules:',
    '- If heatmap.status is available, cold_open_selection.source must be heatmap_peak and pick the beat overlapping the highest score segment.',
    '- If heatmap is unavailable, set fallback_used true and choose max hook_potential, then dramatic_weight.',
    '- cold_open must be short, about 3-6 seconds when possible.',
    '- KEEP_DIALOGUE keeps original dialogue. NARRATE compresses via narration. DROP removes low-value side branches.',
    '- Keep estimated_total_sec close to target_sec without exceeding it badly.',
    '- Include role values cold_open, bridge, body, body_peak, payoff where appropriate.',
    '',
    `Video title: ${metadata?.title || ''}`,
    `Target seconds: ${targetSec}`,
    '',
    'Narrative beats:',
    JSON.stringify(beats, null, 2),
    '',
    'Heatmap:',
    JSON.stringify(heatmap, null, 2)
  ].join('\n');
}

function buildSlotFillsPrompt(beats, editPlan) {
  return [
    'You are writing Korean narration slot_fills for a midform compression edit plan.',
    'Return JSON only matching the slot_fills schema. Do not use markdown.',
    '',
    'Rules:',
    '- Use Korean narration that creates curiosity, not plain visual relay.',
    '- KEEP_DIALOGUE slots should have empty narration and empty caption_units unless the slot role is bridge/payoff narration.',
    '- NARRATE slots should compress omitted story context clearly.',
    '- cold_open narration must plant a question and must not reveal the answer.',
    '- body_peak should let original dialogue carry the answer when decision is KEEP_DIALOGUE.',
    '- caption_kr should be a concise Korean caption line for the narration; empty for dialogue-only slots.',
    '',
    'Narrative beats:',
    JSON.stringify(beats, null, 2),
    '',
    'Edit plan:',
    JSON.stringify(editPlan, null, 2)
  ].join('\n');
}

function validateBeats(beatsObject, transcript) {
  const beats = Array.isArray(beatsObject?.beats) ? beatsObject.beats : [];
  if (!beats.length) throw new Error('narrative beats output is empty');
  const minStart = Math.min(...transcript.map((cue) => cue.start_sec));
  const maxEnd = Math.max(...transcript.map((cue) => cue.end_sec));
  for (const beat of beats) {
    if (!String(beat.beat_id || '').trim()) throw new Error('beat_id is required');
    if (!(Number(beat.end_sec) > Number(beat.start_sec))) throw new Error(`${beat.beat_id} has invalid time range`);
    if (Number(beat.start_sec) < minStart - 0.5 || Number(beat.end_sec) > maxEnd + 0.5) throw new Error(`${beat.beat_id} is outside transcript range`);
  }
  return beatsObject;
}

function validateEditPlan(editPlan) {
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  if (!timeline.length) throw new Error('edit plan timeline is empty');
  if (!timeline.some((item) => item.role === 'cold_open')) throw new Error('edit plan is missing cold_open role');
  if (!timeline.some((item) => item.role === 'bridge')) throw new Error('edit plan is missing bridge role');
  return editPlan;
}

async function runJsonGeneration(prompt, outputSchemaPath, validator) {
  let feedback = '';
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const fullPrompt = feedback ? `${prompt}\n\nPrevious JSON failed validation. Fix only these issues:\n${feedback}` : prompt;
    const result = await runCodexCli(fullPrompt, { outputSchemaPath });
    const parsed = extractJson(result.outputText || result.stdout);
    try {
      const validated = validator(parsed);
      return { parsed: validated, cli: { promptPath: result.promptPath, outputPath: result.outputPath, attempts: attempt, stderr: result.stderr.slice(0, 2000) } };
    } catch (error) {
      lastError = error;
      feedback = error.message || 'validation failed';
    }
  }
  throw lastError || new Error('JSON generation failed validation');
}

function buildNarrativeBeatsMarkdown({ runId, metadata, heatmap, beatsObject, editPlan, paths }) {
  const cold = editPlan.cold_open_selection || {};
  const rows = (editPlan.timeline || []).map((item) => {
    const time = item.start_sec || item.end_sec ? `${formatClock(item.start_sec)}-${formatClock(item.end_sec)}` : '-';
    return `| ${item.role} | ${item.beat_id || '-'} | ${item.decision} | ${time} | ${item.reason} |`;
  });
  const beatRows = (beatsObject.beats || []).map((beat) => {
    const dialogue = Array.isArray(beat.key_dialogue) ? beat.key_dialogue.join(' / ') : String(beat.key_dialogue || '');
    return `| ${beat.beat_id} | ${formatClock(beat.start_sec)}-${formatClock(beat.end_sec)} | ${beat.summary} | ${dialogue} | ${beat.dramatic_weight} | ${beat.dialogue_quality} | ${beat.hook_potential} |`;
  });
  return [
    '# Narrative Compression Review',
    '',
    `- run_id: ${runId}`,
    `- title: ${metadata?.title || ''}`,
    `- source: ${metadata?.webpage_url || metadata?.original_url || ''}`,
    '',
    '## Cold Open Candidate',
    '',
    `- selected_beat: ${cold.beat_id || ''}`,
    `- source: ${cold.source || ''}`,
    `- fallback_used: ${cold.fallback_used === true}`,
    `- fallback_reason: ${cold.fallback_reason || ''}`,
    `- heatmap_status: ${heatmap.status}`,
    `- heatmap_peak: ${cold.heatmap_peak_start_sec || cold.heatmap_peak_end_sec ? `${formatClock(cold.heatmap_peak_start_sec)}-${formatClock(cold.heatmap_peak_end_sec)}` : '-'}`,
    `- reason: ${cold.reason || ''}`,
    '',
    '## Timeline Plan',
    '',
    '| role | beat | decision | time | reason |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Narrative Beats',
    '',
    '| beat | range | summary | key_dialogue | weight | dialogue_quality | hook |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...beatRows,
    '',
    '## Artifact Paths',
    '',
    `- transcript_timed: ${paths.transcriptPath}`,
    `- heatmap: ${paths.heatmapPath}`,
    `- narrative_beats: ${paths.beatsPath}`,
    `- edit_plan: ${paths.editPlanPath}`
  ].join('\n');
}

async function runCompression(source, options = {}) {
  const sourceUrl = normalizeSourceUrl(source);
  const targetSec = Number(options.target || options.targetSec || DEFAULT_TARGET_SEC) || DEFAULT_TARGET_SEC;
  const { runId, runDir } = createCompressionRun(sourceUrl);
  const statePath = path.join(runDir, 'compress_state.json');
  writeJson(statePath, { runId, status: 'running', sourceUrl, targetSec, createdAt: new Date().toISOString() });

  const { metadata, metadataPath } = await loadYoutubeMetadata(sourceUrl, runDir);
  const { transcript, transcriptPath, vttPath } = await extractTimedTranscript(sourceUrl, runDir);
  const { heatmap, heatmapPath } = extractHeatmap(metadata, runDir);

  const beatsResult = await runJsonGeneration(
    buildBeatsPrompt(transcript, metadata),
    MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH,
    (parsed) => validateBeats(parsed, transcript)
  );
  const beatsPath = path.join(runDir, 'narrative_beats.json');
  writeJson(beatsPath, beatsResult.parsed);

  const editResult = await runJsonGeneration(
    buildEditPlanPrompt(beatsResult.parsed.beats, heatmap, targetSec, metadata),
    MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH,
    validateEditPlan
  );
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  writeJson(editPlanPath, editResult.parsed);

  const markdownPath = path.join(runDir, 'narrative_beats.md');
  writeText(markdownPath, `${buildNarrativeBeatsMarkdown({
    runId,
    metadata,
    heatmap,
    beatsObject: beatsResult.parsed,
    editPlan: editResult.parsed,
    paths: { transcriptPath, heatmapPath, beatsPath, editPlanPath }
  })}\n`);

  const manifestPath = path.join(runDir, 'compression_manifest.json');
  const manifest = {
    runId,
    phase: 1,
    sourceUrl,
    targetSec,
    title: metadata?.title || '',
    createdAt: new Date().toISOString(),
    pipelineBootstrapConnected: false,
    paths: { runDir, metadataPath, transcriptPath, vttPath, heatmapPath, beatsPath, editPlanPath, markdownPath },
    heatmapStatus: heatmap.status,
    coldOpenSelection: editResult.parsed.cold_open_selection || null
  };
  writeJson(manifestPath, manifest);
  writeJson(statePath, { ...manifest, status: 'phase1_review_ready', manifestPath });
  return { ...manifest, manifestPath, status: 'phase1_review_ready' };
}

async function runCompressionApply(runIdOrPath) {
  const raw = String(runIdOrPath || '').trim();
  if (!raw) throw new Error('compress-apply requires a runId or run directory path');
  const runDir = path.isAbsolute(raw) ? raw : path.join(COMPRESS_RUNS_DIR, raw);
  const beatsPath = path.join(runDir, 'narrative_beats.json');
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  if (!fs.existsSync(beatsPath) || !fs.existsSync(editPlanPath)) throw new Error(`Compression artifacts not found in ${runDir}`);
  const beatsObject = readJson(beatsPath);
  const editPlan = readJson(editPlanPath);
  const result = await runJsonGeneration(
    buildSlotFillsPrompt(beatsObject.beats || [], editPlan),
    MIDFORM_SLOT_FILLS_SCHEMA_PATH,
    (parsed) => parsed
  );
  const slotFillsPath = path.join(runDir, 'compression_slot_fills.json');
  writeJson(slotFillsPath, result.parsed);
  const applyStatePath = path.join(runDir, 'compress_apply_state.json');
  const applyState = {
    status: 'slot_fills_generated_pipeline_not_connected',
    runDir,
    slotFillsPath,
    generatedAt: new Date().toISOString(),
    pipelineBootstrapConnected: false,
    note: 'Phase 1 only: existing pipeline bootstrap connection intentionally not performed.'
  };
  writeJson(applyStatePath, applyState);
  return applyState;
}

module.exports = {
  runCompression,
  runCompressionApply,
  parseVtt,
  extractHeatmap
};
