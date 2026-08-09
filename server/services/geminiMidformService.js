const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { GoogleAuth } = require('google-auth-library');
const { getVideoMetadata } = require('../utils/ffprobe');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_VERTEX_LOCATION = 'global';
const MIDFORM_PROMPT_DIR = path.join(__dirname, '../../midform/prompts');
const MIDFORM_SCHEMA_DIR = path.join(__dirname, '../../midform/schemas');
const DEFAULT_MIDFORM_SCHEMA_FILE = 'gemini_response_schema.json';
const MIDFORM_CHUNK_THRESHOLD_SEC = 90;
const MIDFORM_CHUNK_TARGET_SEC = 35;
const MIDFORM_CHUNK_OVERLAP_SEC = 2;
const MIDFORM_CHUNK_SNAP_WINDOW_SEC = 6;
const MIDFORM_MIN_FINAL_CHUNK_SEC = 12;
const MIDFORM_CHUNK_DELAY_MIN_MS = 3000;
const MIDFORM_CHUNK_DELAY_MAX_MS = 5000;
const execFileAsync = promisify(execFile);

function createError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function loadMidformPrompt(fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName || safeName !== fileName) {
    throw createError(400, 'MIDFORM_PROMPT_INVALID', 'Invalid midform prompt file name', { fileName });
  }

  const promptPath = path.join(MIDFORM_PROMPT_DIR, safeName);
  if (!fs.existsSync(promptPath)) {
    throw createError(500, 'MIDFORM_PROMPT_NOT_FOUND', 'Midform prompt file not found', { promptPath });
  }

  return fs.readFileSync(promptPath, 'utf8');
}

function loadMidformResponseSchema() {
  const schemaFileName = String(process.env.GEMINI_MIDFORM_SCHEMA_FILE || DEFAULT_MIDFORM_SCHEMA_FILE).trim();
  const safeName = path.basename(schemaFileName);
  if (!safeName || safeName !== schemaFileName) {
    throw createError(400, 'MIDFORM_SCHEMA_INVALID', 'Invalid midform schema file name', { schemaFileName });
  }

  const schemaPath = path.join(MIDFORM_SCHEMA_DIR, safeName);
  if (!fs.existsSync(schemaPath)) {
    throw createError(500, 'MIDFORM_SCHEMA_NOT_FOUND', 'Midform response schema file not found', { schemaPath });
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function getVertexConfig() {
  return {
    project: String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim(),
    location: String(process.env.GOOGLE_CLOUD_LOCATION || DEFAULT_VERTEX_LOCATION).trim(),
    model: String(process.env.VERTEX_GEMINI_MODEL || GEMINI_MODEL).trim()
  };
}

async function getVertexAccessToken() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) {
    throw createError(500, 'VERTEX_ADC_TOKEN_MISSING', 'Vertex ADC token could not be acquired');
  }
  return token;
}

function extractVertexResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part?.text || '').join('').trim();
  if (!text) {
    throw createError(500, 'VERTEX_GEMINI_EMPTY_RESPONSE', 'Vertex Gemini returned an empty response', { response: data });
  }
  return text;
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = String(text || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '');
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) {
      throw createError(500, 'GEMINI_MIDFORM_JSON_PARSE_ERROR', 'Gemini midform response was not valid JSON', {
        snippet: String(text || '').slice(0, 400)
      });
    }
    return JSON.parse(match[0]);
  }
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundSec(value) {
  return Number(safeNumber(value, 0).toFixed(3));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkDelayMs() {
  return MIDFORM_CHUNK_DELAY_MIN_MS + Math.floor(Math.random() * (MIDFORM_CHUNK_DELAY_MAX_MS - MIDFORM_CHUNK_DELAY_MIN_MS + 1));
}

function validTranscriptUtterances(transcript) {
  return (Array.isArray(transcript?.utterances) ? transcript.utterances : [])
    .map((utterance) => ({
      utt_id: String(utterance?.utt_id || utterance?.id || '').trim(),
      start: safeNumber(utterance?.start, NaN),
      end: safeNumber(utterance?.end, NaN),
      text: String(utterance?.text || '').trim()
    }))
    .filter((utterance) => utterance.utt_id && Number.isFinite(utterance.start) && Number.isFinite(utterance.end) && utterance.end > utterance.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function snapBoundaryToSilence(desiredBoundary, utterances, durationSec) {
  const desired = Math.max(1, Math.min(durationSec - 1, desiredBoundary));
  const candidates = [];
  for (let index = 0; index < utterances.length - 1; index += 1) {
    const current = utterances[index];
    const next = utterances[index + 1];
    if (next.start <= current.end) continue;
    const midpoint = (current.end + next.start) / 2;
    if (Math.abs(midpoint - desired) <= MIDFORM_CHUNK_SNAP_WINDOW_SEC) {
      candidates.push({ value: midpoint, distance: Math.abs(midpoint - desired) });
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.distance - b.distance);
    return roundSec(candidates[0].value);
  }
  const containing = utterances.find((utterance) => utterance.start < desired && utterance.end > desired);
  if (containing) {
    const before = containing.start;
    const after = containing.end;
    const snapped = Math.abs(before - desired) <= Math.abs(after - desired) ? before : after;
    return roundSec(Math.max(1, Math.min(durationSec - 1, snapped)));
  }
  return roundSec(desired);
}

function buildChunkPlan(durationSec, transcript) {
  const sourceDuration = safeNumber(durationSec, 0);
  if (sourceDuration <= 0) return [];
  if (sourceDuration <= MIDFORM_CHUNK_THRESHOLD_SEC) {
    return [{ index: 1, start_sec: 0, end_sec: roundSec(sourceDuration), duration_sec: roundSec(sourceDuration), overlap_before_sec: 0 }];
  }

  const utterances = validTranscriptUtterances(transcript);
  const boundaries = [0];
  let cursor = 0;
  while (cursor + MIDFORM_CHUNK_TARGET_SEC < sourceDuration - 1) {
    let boundary = snapBoundaryToSilence(cursor + MIDFORM_CHUNK_TARGET_SEC, utterances, sourceDuration);
    if (boundary <= cursor + 8) boundary = roundSec(Math.min(sourceDuration - 1, cursor + MIDFORM_CHUNK_TARGET_SEC));
    boundaries.push(boundary);
    cursor = boundary;
  }
  boundaries.push(roundSec(sourceDuration));
  if (boundaries.length > 2 && sourceDuration - boundaries[boundaries.length - 2] < MIDFORM_MIN_FINAL_CHUNK_SEC) {
    boundaries.splice(boundaries.length - 2, 1);
  }

  return boundaries.slice(0, -1).map((boundary, index) => {
    const start = index === 0 ? 0 : Math.max(0, boundary - MIDFORM_CHUNK_OVERLAP_SEC);
    const end = boundaries[index + 1];
    return {
      index: index + 1,
      start_sec: roundSec(start),
      end_sec: roundSec(end),
      duration_sec: roundSec(end - start),
      overlap_before_sec: index === 0 ? 0 : MIDFORM_CHUNK_OVERLAP_SEC,
      snapped_boundary_sec: roundSec(boundary)
    };
  }).filter((chunk) => chunk.end_sec > chunk.start_sec + 1);
}

async function extractChunkVideo(sourcePath, chunk, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const ffmpeg = resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' });
  const outputPath = path.join(outputDir, `chunk_${String(chunk.index).padStart(2, '0')}_${Math.round(chunk.start_sec * 1000)}_${Math.round(chunk.end_sec * 1000)}.mp4`);
  const baseArgs = ['-y', '-ss', String(chunk.start_sec), '-to', String(chunk.end_sec), '-i', sourcePath];
  const copyArgs = [...baseArgs, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath];
  try {
    await execFileAsync(ffmpeg, copyArgs, { timeout: 120_000, env: getToolEnv() });
  } catch (copyError) {
    const transcodeArgs = [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', outputPath];
    try {
      await execFileAsync(ffmpeg, transcodeArgs, { timeout: 240_000, env: getToolEnv() });
    } catch (transcodeError) {
      throw createError(500, 'MIDFORM_CHUNK_EXTRACT_FAILED', 'Failed to extract Gemini midform video chunk', {
        chunk,
        copyError: copyError.message,
        transcodeError: transcodeError.message
      });
    }
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
    throw createError(500, 'MIDFORM_CHUNK_OUTPUT_MISSING', 'Extracted Gemini midform chunk was not created or is too small', { chunk, outputPath });
  }
  return outputPath;
}

function transcriptForChunk(transcript, chunk) {
  const utterances = validTranscriptUtterances(transcript)
    .filter((utterance) => utterance.end >= chunk.start_sec && utterance.start <= chunk.end_sec)
    .map((utterance) => ({
      ...utterance,
      start: roundSec(Math.max(0, utterance.start - chunk.start_sec)),
      end: roundSec(Math.max(0, utterance.end - chunk.start_sec)),
      absolute_start: roundSec(utterance.start),
      absolute_end: roundSec(utterance.end)
    }));
  return { ...(transcript || {}), utterances };
}

function transcriptPromptSection(transcript) {
  const utterances = Array.isArray(transcript?.utterances) ? transcript.utterances : [];
  if (!utterances.length) return '';
  const compact = utterances.map((utterance) => ({
    utt_id: String(utterance?.utt_id || '').trim(),
    start: Number(utterance?.start),
    end: Number(utterance?.end),
    text: String(utterance?.text || '').trim()
  })).filter((utterance) => utterance.utt_id && Number.isFinite(utterance.start) && Number.isFinite(utterance.end) && utterance.end > utterance.start);
  if (!compact.length) return '';
  return [
    '',
    '## Source transcript utterances',
    'Use these utterances as the single source of truth for spoken dialogue text and timing.',
    JSON.stringify(compact, null, 2)
  ].join('\n');
}

function midformPrompt(contentType, transcript = null, chunkContext = null) {
  const promptTemplate = loadMidformPrompt('gemini_analysis_midform.md');
  const chunkSection = chunkContext ? [
    '',
    '## Chunk context',
    `This video clip is chunk ${chunkContext.index}/${chunkContext.total_chunks} from the full ${chunkContext.total_duration_sec}s source video.`,
    `It covers absolute source time ${chunkContext.start_sec}s to ${chunkContext.end_sec}s.`,
    'Return every scene timecode relative to this chunk video, where this chunk starts at 0. Do not return absolute source timecodes.',
    'Do not describe scenes outside this chunk.'
  ].join('\n') : '';
  return `${promptTemplate.replace(/movie_midform_recap/g, contentType || 'movie_midform_recap')}${chunkSection}${transcriptPromptSection(transcript)}`;
}

function validateRequiredTopLevelFields(parsed) {
  const required = [
    'source',
    'story_context',
    'scenes',
    'characters',
    'safety_scan',
    'integrity_check'
  ];
  const missing = required.filter((key) => parsed?.[key] === undefined);
  if (missing.length > 0) {
    throw createError(500, 'GEMINI_MIDFORM_SCHEMA_VALIDATION_FAILED', 'Gemini midform response is missing required fields', { missing });
  }
}

function buildVertexEndpoint(config) {
  const override = String(process.env.GEMINI_VERTEX_ENDPOINT_OVERRIDE || '').trim();
  if (override) return override;
  const host = config.location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${config.location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${config.project}/locations/${config.location}/publishers/google/models/${config.model}:generateContent`;
}

async function requestVertexMidformAnalysis({ videoPath, prompt, token, endpoint }) {
  const config = getVertexConfig();
  if (!config.project) {
    throw createError(400, 'GOOGLE_CLOUD_PROJECT_REQUIRED', 'GOOGLE_CLOUD_PROJECT is required for Vertex ADC mode');
  }
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'video/mp4',
              data: fs.readFileSync(videoPath).toString('base64')
            }
          },
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: loadMidformResponseSchema(),
      temperature: 0.1
    }
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw createError(500, 'VERTEX_MIDFORM_REQUEST_FAILED', error.message, { cause: error?.stack || String(error) });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createError(response.status, 'VERTEX_MIDFORM_ANALYSIS_FAILED', 'Vertex Gemini midform analysis failed', {
      status: response.status,
      endpoint,
      response: data
    });
  }
  return data;
}

function offsetSceneTimes(scene, offsetSec, sourceDurationSec) {
  const start = Math.max(0, roundSec(safeNumber(scene.start_sec, 0) + offsetSec));
  const end = Math.min(sourceDurationSec, Math.max(start + 0.1, roundSec(safeNumber(scene.end_sec, start) + offsetSec)));
  return {
    ...scene,
    start_sec: roundSec(start),
    end_sec: roundSec(end),
    duration_sec: roundSec(end - start)
  };
}

function rangesOverlapSeconds(a, b) {
  return Math.max(0, Math.min(a.end_sec, b.end_sec) - Math.max(a.start_sec, b.start_sec));
}

function mergeSafetyScans(chunkResults, sourceDurationSec) {
  const keys = ['violence', 'sexual', 'gore', 'minor_safety', 'sensitive_topic'];
  const merged = {};
  for (const key of keys) {
    const timecodes = [];
    let present = false;
    for (const item of chunkResults) {
      const scan = item.result?.safety_scan?.[key] || {};
      present = present || scan.present === true;
      for (const value of Array.isArray(scan.timecodes) ? scan.timecodes : []) {
        const absolute = roundSec(safeNumber(value, 0) + item.chunk.start_sec);
        if (absolute >= 0 && absolute <= sourceDurationSec) timecodes.push(absolute);
      }
    }
    merged[key] = { present, timecodes: Array.from(new Set(timecodes)).sort((a, b) => a - b) };
  }
  return merged;
}

function mergeCharacters(chunkResults, sourceDurationSec) {
  const byName = new Map();
  for (const item of chunkResults) {
    for (const character of Array.isArray(item.result?.characters) ? item.result.characters : []) {
      const safeName = String(character.safe_display_name || '').trim();
      if (!safeName) continue;
      const firstSeen = Math.min(sourceDurationSec, Math.max(0, roundSec(safeNumber(character.first_seen_sec, 0) + item.chunk.start_sec)));
      const previous = byName.get(safeName);
      byName.set(safeName, {
        safe_display_name: safeName,
        role: String(previous?.role || character.role || 'unknown'),
        first_seen_sec: previous ? Math.min(previous.first_seen_sec, firstSeen) : firstSeen
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.first_seen_sec - b.first_seen_sec || a.safe_display_name.localeCompare(b.safe_display_name));
}

function mergeChunkScenes(chunkResults, sourceDurationSec) {
  let merged = [];
  for (const item of chunkResults) {
    const scenes = (Array.isArray(item.result?.scenes) ? item.result.scenes : [])
      .map((scene) => offsetSceneTimes(scene, item.chunk.start_sec, sourceDurationSec))
      .filter((scene) => scene.end_sec > scene.start_sec && scene.start_sec < sourceDurationSec);
    for (const scene of scenes) {
      merged = merged.filter((existing) => rangesOverlapSeconds(existing, scene) <= 0.5);
      merged.push(scene);
    }
  }
  merged.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);
  return merged.map((scene, index) => ({
    ...scene,
    scene_id: `scene_${String(index + 1).padStart(3, '0')}`,
    duration_sec: roundSec(scene.end_sec - scene.start_sec)
  }));
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    let last = i;
    previous[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const old = previous[j + 1];
      previous[j + 1] = left[i] === right[j]
        ? last
        : Math.min(last + 1, previous[j] + 1, previous[j + 1] + 1);
      last = old;
    }
  }
  return previous[right.length];
}

function textSimilarity(a, b) {
  const left = String(a || '').replace(/\s+/g, ' ').trim();
  const right = String(b || '').replace(/\s+/g, ' ').trim();
  if (!left || !right) return 0;
  const maxLength = Math.max(left.length, right.length);
  return maxLength ? 1 - (levenshteinDistance(left, right) / maxLength) : 0;
}

function assertChunkQuality({ chunkResults, merged, durationSec }) {
  const emptyChunks = chunkResults.filter((item) => !Array.isArray(item.result?.scenes) || item.result.scenes.length < 1);
  if (emptyChunks.length) {
    throw createError(500, 'MIDFORM_CHUNK_EMPTY_SCENES', 'Gemini midform chunk analysis returned an empty scenes array for one or more chunks', {
      chunks: emptyChunks.map((item) => item.chunk)
    });
  }
  const outOfRange = merged.scenes.filter((scene) => scene.start_sec < 0 || scene.end_sec > durationSec + 0.001 || scene.end_sec <= scene.start_sec);
  if (outOfRange.length) {
    throw createError(500, 'MIDFORM_CHUNK_TIMECODE_OUT_OF_RANGE', 'Merged Gemini midform scene timecodes exceeded source duration', { scenes: outOfRange });
  }
  const duplicateGroups = [];
  const visited = new Set();
  for (let i = 0; i < merged.scenes.length; i += 1) {
    if (visited.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < merged.scenes.length; j += 1) {
      if (textSimilarity(merged.scenes[i].visible_action, merged.scenes[j].visible_action) >= 0.9) group.push(j);
    }
    if (group.length >= 3) {
      group.forEach((index) => visited.add(index));
      duplicateGroups.push(group.map((index) => ({
        scene_id: merged.scenes[index].scene_id,
        start_sec: merged.scenes[index].start_sec,
        end_sec: merged.scenes[index].end_sec,
        visible_action: merged.scenes[index].visible_action
      })));
    }
  }
  if (duplicateGroups.length) {
    // A single-location source legitimately yields near-identical visible_action lines — people
    // seated in a plane cabin, scene after scene. That is the footage, not the chunk-merge copy
    // bug this check exists to catch; the bug's signature is the SAME description repeated in
    // distant parts of the video. Fail only on distant repeats.
    const CONTIGUOUS_GAP_SEC = 45;
    const distantGroups = duplicateGroups.filter((group) => {
      const starts = group.map((entry) => Number(entry.start_sec)).sort((a, b) => a - b);
      for (let k = 1; k < starts.length; k += 1) {
        if (starts[k] - starts[k - 1] > CONTIGUOUS_GAP_SEC) return true;
      }
      return false;
    });
    if (distantGroups.length) {
      throw createError(500, 'MIDFORM_CHUNK_DUPLICATE_SCENE_SUMMARY', 'Merged Gemini midform scene summaries contain 3+ highly similar visible_action entries', { duplicateGroups: distantGroups });
    }
  }
}

function mergeChunkResults(chunkResults, durationSec, contentType) {
  const first = chunkResults[0]?.result || {};
  const scenes = mergeChunkScenes(chunkResults, durationSec);
  const characters = mergeCharacters(chunkResults, durationSec);
  const merged = {
    ...first,
    source: {
      ...(first.source || {}),
      duration_sec: roundSec(durationSec),
      content_type: contentType || 'movie_midform_recap'
    },
    story_context: first.story_context || {},
    scenes,
    characters: characters.length ? characters : (first.characters || []),
    safety_scan: mergeSafetyScans(chunkResults, durationSec),
    integrity_check: {
      ...(first.integrity_check || {}),
      total_scenes_count: scenes.length,
      all_scene_times_within_source: scenes.every((scene) => scene.start_sec >= 0 && scene.end_sec <= durationSec + 0.001 && scene.end_sec > scene.start_sec),
      total_duration_sec: roundSec(durationSec),
      no_empty_required_fields: scenes.every((scene) => String(scene.visible_action || '').trim())
    },
    chunk_analysis: {
      enabled: true,
      threshold_sec: MIDFORM_CHUNK_THRESHOLD_SEC,
      target_chunk_sec: MIDFORM_CHUNK_TARGET_SEC,
      overlap_sec: MIDFORM_CHUNK_OVERLAP_SEC,
      chunks: chunkResults.map((item) => ({
        index: item.chunk.index,
        start_sec: item.chunk.start_sec,
        end_sec: item.chunk.end_sec,
        duration_sec: item.chunk.duration_sec,
        scenes_count: Array.isArray(item.result?.scenes) ? item.result.scenes.length : 0,
        log_path: item.logPath,
        chunk_video_path: item.chunkVideoPath,
        summary_sample: (item.result?.scenes || []).slice(0, 2).map((scene) => scene.visible_action)
      }))
    }
  };
  assertChunkQuality({ chunkResults, merged, durationSec });
  return merged;
}

async function analyzeMidformVideoSingle({ videoPath, contentType, options, token, endpoint, chunkContext = null }) {
  const prompt = midformPrompt(contentType, options.transcript || options.sourceTranscript || null, chunkContext);
  const data = await requestVertexMidformAnalysis({ videoPath, prompt, token, endpoint });

  try {
    const parsed = extractJson(extractVertexResponseText(data));
    if (options.validateTopLevel !== false) {
      validateRequiredTopLevelFields(parsed);
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    throw createError(500, 'GEMINI_MIDFORM_JSON_PARSE_ERROR', error.message, {
      response: data
    });
  }
}

async function analyzeMidformVideoChunked({ videoPath, contentType, options, durationSec, token, endpoint }) {
  const chunks = buildChunkPlan(durationSec, options.transcript || options.sourceTranscript || null);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const baseName = path.basename(videoPath, path.extname(videoPath)).replace(/[^A-Za-z0-9_.-]+/g, '_') || 'source';
  const rootDir = options.chunkLogDir || path.join(path.dirname(videoPath), 'logs', `gemini_midform_chunks_${stamp}_${baseName}`);
  const videoDir = path.join(rootDir, 'videos');
  const logsDir = path.join(rootDir, 'responses');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const chunkResults = [];

  for (const chunk of chunks) {
    const chunkVideoPath = await extractChunkVideo(videoPath, chunk, videoDir);
    const chunkTranscript = transcriptForChunk(options.transcript || options.sourceTranscript || null, chunk);
    // A truncated response (model stops mid-JSON) is stochastic: one bad chunk used to kill the
    // whole vision map and with it the run (Shelter chunk_6 died mid-string). Retry the chunk
    // itself before giving up.
    let result = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await analyzeMidformVideoSingle({
          videoPath: chunkVideoPath,
          contentType,
          options: { ...options, transcript: chunkTranscript, sourceTranscript: chunkTranscript },
          token,
          endpoint,
          chunkContext: {
            ...chunk,
            total_chunks: chunks.length,
            total_duration_sec: roundSec(durationSec)
          }
        });
        break;
      } catch (error) {
        const retryable = String(error?.code || '') === 'GEMINI_MIDFORM_JSON_PARSE_ERROR';
        if (!retryable || attempt === 3) throw error;
        await sleep(2000 * attempt);
      }
    }
    const logPath = path.join(logsDir, `chunk_${String(chunk.index).padStart(2, '0')}_response.json`);
    fs.writeFileSync(logPath, `${JSON.stringify({ chunk, result }, null, 2)}\n`, 'utf8');
    chunkResults.push({ chunk, result, logPath, chunkVideoPath });
    if (chunk.index < chunks.length) await sleep(chunkDelayMs());
  }

  const merged = mergeChunkResults(chunkResults, durationSec, contentType);
  fs.writeFileSync(path.join(rootDir, 'chunk_plan.json'), `${JSON.stringify({ duration_sec: durationSec, chunks }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(rootDir, 'merged_analysis.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

async function analyzeMidformVideo(videoPath, contentType = 'movie_midform_recap', options = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw createError(400, 'SOURCE_VIDEO_REQUIRED', 'source video file is required');
  }

  const config = getVertexConfig();
  if (!config.project) {
    throw createError(400, 'GOOGLE_CLOUD_PROJECT_REQUIRED', 'GOOGLE_CLOUD_PROJECT is required for Vertex ADC mode');
  }

  const token = await getVertexAccessToken();
  const endpoint = buildVertexEndpoint(config);
  const metadata = getVideoMetadata(videoPath);
  const durationSec = safeNumber(options.sourceDurationSec || metadata.duration_sec, 0);
  const shouldChunk = options.chunkAnalysis !== false && durationSec > MIDFORM_CHUNK_THRESHOLD_SEC;
  if (shouldChunk) {
    return analyzeMidformVideoChunked({ videoPath, contentType, options, durationSec, token, endpoint });
  }
  return analyzeMidformVideoSingle({ videoPath, contentType, options, token, endpoint });
}

// Converts a JSON Schema (as written for the Codex CLI --output-schema) to the OpenAPI subset
// Vertex responseSchema accepts. Strips keywords Vertex rejects/ignores; keeps type/properties/
// required/enum/items. Verified against the compress edit_plan schema in the migration probe.
function toVertexResponseSchema(node) {
  if (Array.isArray(node)) return node.map(toVertexResponseSchema);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (['additionalProperties', '$schema', '$id', '$ref', 'definitions'].includes(key)) continue;
      out[key] = toVertexResponseSchema(value);
    }
    return out;
  }
  return node;
}

// Text-only structured-JSON generation via Vertex Gemini, mirroring runCodexCli's contract
// (returns the raw model text for the caller to extractJson + validate). Reuses the same auth,
// endpoint, and response-extraction path as scene analysis.
async function generateVertexJson({ prompt, responseSchema, model, temperature = 0.1 }) {
  const config = getVertexConfig();
  if (!config.project) {
    throw createError(400, 'GOOGLE_CLOUD_PROJECT_REQUIRED', 'GOOGLE_CLOUD_PROJECT is required for Vertex ADC mode');
  }
  const token = await getVertexAccessToken();
  const endpoint = buildVertexEndpoint({ ...config, model: String(model || config.model).trim() });
  const body = {
    contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toVertexResponseSchema(responseSchema),
      temperature
    }
  };
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw createError(500, 'VERTEX_COMPRESS_REQUEST_FAILED', error.message, { cause: error?.stack || String(error) });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createError(response.status, 'VERTEX_COMPRESS_GENERATION_FAILED', 'Vertex Gemini JSON generation failed', {
      status: response.status,
      endpoint,
      response: JSON.stringify(data).slice(0, 1200)
    });
  }
  return extractVertexResponseText(data);
}

module.exports = {
  analyzeMidformVideo,
  buildChunkPlan,
  loadMidformPrompt,
  loadMidformResponseSchema,
  getVertexConfig,
  generateVertexJson,
  toVertexResponseSchema,
  MIDFORM_SCHEMA_DIR,
  DEFAULT_MIDFORM_SCHEMA_FILE
};
