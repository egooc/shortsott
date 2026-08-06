const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const archiver = require('archiver');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { analyzeMidformVideo } = require('./geminiMidformService');
const { generateMidformScriptWithGptCli } = require('./gptMidformCliService');
const { validateSlotFills, normalizeSlotFillsToScript } = require('./gptMidformCliService');
const { generateAndSaveMovieResearch } = require('./movieResearchService');
const { generateDraft } = require('./capcutService');
const { getVideoMetadata } = require('../utils/ffprobe');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const TEST_RUNS_DIR = path.join(PROJECT_ROOT, 'midform', 'test_runs');
const DRAFTS_DIR = path.join(PROJECT_ROOT, 'server', 'output', 'drafts');
const STATE_FILE = 'pipeline_state.json';
const SOURCE_INFO_FILE = 'source_info.json';
const TRANSCRIPT_FILE = 'source_transcript.json';
const PREFLIGHT_FILE = 'preflight_gate.json';
const GEMINI_FILE = 'gemini_analysis.json';
const SLOT_MAP_FILE = 'slot_map.json';
const SCRIPT_FILE = 'script.json';
const SLOT_FILLS_FILE = 'slot_fills.json';
const MOVIE_RESEARCH_FILE = 'movie_research.json';
const DRAFT_INPUT_FILE = 'draft_input.json';
const SCRIPT_PREVIEW_DATA_FILE = 'script_preview_data.json';
const SCRIPT_PREVIEW_FILE = 'script_preview.md';
const QUALITY_WARNINGS_FILE = 'quality_warnings.md';
const REVIEW_RESUME_VALIDATION_FILE = 'review_resume_validation.json';
const TTS_REUSE_LOG_FILE = 'tts_reuse_log.json';
const TTS_DIR = 'tts';
const PIPELINE_TIMEOUT_MS = Number(process.env.MIDFORM_PIPELINE_STEP_TIMEOUT_MS || 60 * 60 * 1000);
const MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC = Number(process.env.MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC || 7);
const MIDFORM_TTS_CONFIG_PATH = path.join(PROJECT_ROOT, 'midform', 'config', 'tts.json');
const BASE_KOREAN_NARRATION_CHARS_PER_SEC = 4.8;

let activeRunId = '';

const STEP_DEFINITIONS = [
  ['prepare_source', 'Prepare source'],
  ['transcribe', 'Transcribe source'],
  ['preflight', 'Preflight material gate'],
  ['gemini_analysis', 'Gemini scene analysis'],
  ['movie_research', 'Pass 0 movie research'],
  ['slot_map', 'Slot map generation'],
  ['gpt_script', 'GPT slot fill'],
  ['review_checkpoint', 'Review checkpoint'],
  ['tts_assembly', 'TTS / caption assembly'],
  ['capcut_draft', 'CapCut draft generation']
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), 'utf8');
}

function normalizeReviewState(review, enabled = false) {
  if (enabled !== true && (!review || review.enabled !== true)) {
    return {
      enabled: false,
      status: 'skipped',
      pausedAt: '',
      resumedAt: '',
      previewPath: '',
      lastResumeError: null
    };
  }
  return {
    enabled: true,
    status: String(review?.status || 'pending'),
    pausedAt: String(review?.pausedAt || ''),
    resumedAt: String(review?.resumedAt || ''),
    previewPath: String(review?.previewPath || ''),
    lastResumeError: review?.lastResumeError || null
  };
}

function normalizeQualityWarnings(warnings) {
  return Array.isArray(warnings)
    ? warnings.map((warning) => ({
      slot_id: String(warning?.slot_id || '').trim(),
      rule_code: String(warning?.rule_code || 'QUALITY_GATE_WARNING').trim(),
      message: String(warning?.message || '').trim(),
      actual: warning?.actual ?? null,
      threshold: warning?.threshold ?? null,
      severity: String(warning?.severity || 'warning').trim()
    }))
    : [];
}

function buildPreflightRejectReasons(preflight) {
  const failures = Array.isArray(preflight?.failures) ? preflight.failures : [];
  const criteria = preflight?.criteria || {};
  const speech = preflight?.speech || {};
  return failures.map((failure) => {
    const code = String(failure?.code || '').trim();
    if (code === 'DIALOGUE_INSUFFICIENT') {
      return {
        code,
        message: String(failure?.message || '').trim(),
        check: 'speech_ratio',
        actual: Number(speech?.speech_ratio || 0),
        threshold: Number(criteria?.min_speech_ratio || 0),
        context: {
          utterance_count: Number(speech?.utterance_count || 0),
          min_utterances: Number(criteria?.min_utterances || 0),
          total_speech_sec: Number(speech?.total_speech_sec || 0),
          source_duration_sec: Number(speech?.source_duration_sec || 0)
        }
      };
    }
    return {
      code,
      message: String(failure?.message || '').trim(),
      check: 'preflight',
      actual: null,
      threshold: null,
      context: {}
    };
  });
}

function markPreflightBlocked(state, preflight, stdout = '') {
  state.status = 'blocked_preflight';
  state.completedAt = '';
  state.error = null;
  state.preflightGate = {
    status: 'rejected',
    overridden: false,
    rejectReasons: buildPreflightRejectReasons(preflight),
    preflight,
    stdout: String(stdout || '')
  };
  saveState(state);
}

function markPreflightOverride(state) {
  state.preflightGate = {
    ...(state.preflightGate || {}),
    status: 'overridden',
    overridden: true,
    overriddenAt: new Date().toISOString(),
    rejectReasons: Array.isArray(state.preflightGate?.rejectReasons) ? state.preflightGate.rejectReasons : []
  };
  state.input.preflightOverridden = true;
  saveState(state);
}

function normalizePreflightGateState(state) {
  const existing = state.preflightGate;
  if (existing && (Array.isArray(existing.rejectReasons) || existing.status === 'passed' || existing.status === 'overridden')) {
    return {
      status: String(existing.status || 'pending'),
      overridden: existing.overridden === true,
      overriddenAt: String(existing.overriddenAt || ''),
      rejectReasons: Array.isArray(existing.rejectReasons) ? existing.rejectReasons : [],
      preflight: existing.preflight || null,
      stdout: String(existing.stdout || '')
    };
  }
  const legacyPreflight = state.error?.code === 'MIDFORM_PREFLIGHT_REJECTED' ? state.error?.details?.preflight : null;
  if (legacyPreflight) {
    return {
      status: state.status === 'blocked_preflight' ? 'rejected' : 'rejected',
      overridden: false,
      overriddenAt: '',
      rejectReasons: buildPreflightRejectReasons(legacyPreflight),
      preflight: legacyPreflight,
      stdout: String(state.error?.details?.stdout || '')
    };
  }
  return { status: 'pending', overridden: false, overriddenAt: '', rejectReasons: [], preflight: null, stdout: '' };
}

function copyFileIntoRunIfPresent(sourcePath, destinationPath, label) {
  const raw = String(sourcePath || '').trim();
  if (!raw) return '';
  const resolved = assertInsideProject(raw, label);
  if (!fs.existsSync(resolved)) {
    throw createHttpError(400, 'MIDFORM_BOOTSTRAP_FILE_NOT_FOUND', `${label} was not found`, { sourcePath: raw, resolvedPath: resolved });
  }
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(resolved, destinationPath);
  return destinationPath;
}

function safeSlug(value, fallback = 'source') {
  const slug = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9가-힣_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function timestampForId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

function createSteps() {
  return STEP_DEFINITIONS.map(([id, label]) => ({
    id,
    label,
    status: 'pending',
    startedAt: '',
    completedAt: '',
    error: null,
    summary: '',
    artifacts: {}
  }));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitKoreanSentences(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized.split(/(?<=[.!?。！？])\s+/).map((item) => item.trim()).filter(Boolean);
}

function visibleLength(text) {
  return normalizeText(text).replace(/\s+/g, '').length;
}

function formatSeconds(value) {
  return Number(value || 0).toFixed(2);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readTtsConfig() {
  if (!fs.existsSync(MIDFORM_TTS_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(MIDFORM_TTS_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ttsSpeedMultiplier() {
  const config = readTtsConfig();
  const rawSpeed = Number(config?.voice_settings?.speed || 1);
  return Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : 1;
}

function koreanNarrationCharsPerSec() {
  const config = readTtsConfig();
  const effective = Number(config?.effective_chars_per_sec);
  if (Number.isFinite(effective) && effective > 0) return effective;
  return BASE_KOREAN_NARRATION_CHARS_PER_SEC * ttsSpeedMultiplier();
}

function estimateSpeechSeconds(text) {
  return Number((visibleLength(text) / koreanNarrationCharsPerSec()).toFixed(2));
}

function classifyEnding(sentence) {
  const text = String(sentence || '').trim().replace(/["'“”‘’()\[\]{}]+$/g, '').replace(/[.!?。！？]+$/g, '').trim();
  if (!text) return 'other';
  if (/버렸(?:습니다|죠|는데)?$/.test(text)) return 'beoryeot';
  if (/(?:는데|했는데|였는데|이었는데|인데)$/.test(text)) return 'neunde';
  if (/(?:죠|했죠|였죠|이었죠|었죠|았죠)$/.test(text)) return 'jyo';
  if (/(?:습니다|했습니다|됩니다|였습니다|이었습니다|립니다|입니다|니다)$/.test(text)) return 'nida';
  return 'other';
}

function endingStatsFromSegments(segments) {
  const rows = [];
  const counts = { nida: 0, jyo: 0, neunde: 0, beoryeot: 0, other: 0 };
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || segment.tts_enabled === false || ['dialogue', 'dialogue_quote'].includes(String(segment.segment_type || ''))) continue;
    for (const sentence of splitKoreanSentences(segment.narration || '')) {
      const ending = classifyEnding(sentence);
      counts[ending] = (counts[ending] || 0) + 1;
      rows.push({ segment_id: String(segment.segment_id || ''), sentence, ending });
    }
  }
  const total = rows.length;
  const pct = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, total ? Number(((value / total) * 100).toFixed(1)) : 0]));
  return { total, counts, pct, rows };
}

function buildEditableSlotFills(script) {
  return {
    script_id: String(script?.script_id || '').trim(),
    slot_fills: Array.isArray(script?.slot_fills) ? script.slot_fills : [],
    quality_check: {
      all_slots_filled: true,
      slot_order_preserved: true,
      forbidden_eomi_count: 0,
      translationese_risk_count: 0,
      budget_violations: 0
    }
  };
}

function buildQualityWarningsMarkdown(warnings, previewData) {
  const normalizedWarnings = normalizeQualityWarnings(warnings);
  const ttsUnits = Array.isArray(previewData?.ttsUnits) ? previewData.ttsUnits : [];
  const sentenceIdsBySlot = new Map();
  for (const unit of ttsUnits) {
    const slotId = String(unit?.segment_id || '');
    if (!slotId) continue;
    const items = sentenceIdsBySlot.get(slotId) || [];
    items.push(String(unit?.caption_id || '').trim());
    sentenceIdsBySlot.set(slotId, items.filter(Boolean));
  }
  const lines = ['# quality_warnings', ''];
  if (!normalizedWarnings.length) {
    lines.push('- none');
    return `${lines.join('\n')}\n`;
  }
  for (const warning of normalizedWarnings) {
    lines.push(`## ${warning.slot_id || 'global'} · ${warning.rule_code}`);
    lines.push(`- message: ${warning.message}`);
    if (warning.actual !== null || warning.threshold !== null) {
      lines.push(`- actual_vs_threshold: ${warning.actual ?? '—'} / ${warning.threshold ?? '—'}`);
    }
    const sentenceIds = sentenceIdsBySlot.get(warning.slot_id || '') || [];
    if (sentenceIds.length) {
      lines.push(`- sentence_ids: ${sentenceIds.join(', ')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function slotRole(slotMap, slotId) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  const narrationSlots = slots.filter((slot) => slot?.type === 'narration').map((slot) => String(slot.slot_id || ''));
  const narrationIndex = narrationSlots.indexOf(slotId);
  if (narrationIndex < 0) return '';
  if (narrationIndex === 0) return 'hook';
  if (narrationIndex === narrationSlots.length - 1) return 'payoff';
  return 'bridge';
}

function adjacentDialogueTexts(slots, index) {
  const result = [];
  for (const direction of [-1, 1]) {
    let cursor = index + direction;
    while (cursor >= 0 && cursor < slots.length) {
      const slot = slots[cursor];
      if (!slot || slot.type !== 'dialogue') break;
      const line = normalizeText(slot.caption_source_text || slot.dialogue_original || '');
      if (line) result.push(line);
      cursor += direction;
    }
  }
  return [...new Set(result)];
}

function isBlackTransitionScene(scene) {
  const text = normalizeText([scene?.visible_action, scene?.translated_caption_ko, scene?.vertical_crop_note].filter(Boolean).join(' ')).toLowerCase();
  return /검은색|검은 화면|black/.test(text);
}

function lastNarrationSlotId(slots) {
  const narrationSlots = (Array.isArray(slots) ? slots : []).filter((slot) => slot?.type === 'narration');
  return narrationSlots.length ? String(narrationSlots[narrationSlots.length - 1].slot_id || '') : '';
}

function resolveLastNarrationVisibleEndSec(slot, geminiAnalysis, sourceVideoDurationSec) {
  const sceneIds = Array.isArray(slot?.scene_ids) ? slot.scene_ids.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const scenes = Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [];
  const sceneMap = new Map(scenes.map((scene) => [String(scene?.scene_id || '').trim(), scene]));
  const visibleEnds = sceneIds
    .map((sceneId) => sceneMap.get(sceneId))
    .filter(Boolean)
    .filter((scene) => !isBlackTransitionScene(scene))
    .map((scene) => safeNumber(scene?.end_sec, 0))
    .filter((value) => value > 0);
  if (visibleEnds.length) return Math.max(...visibleEnds);
  const sourceRange = Array.isArray(slot?.source_range) ? slot.source_range : [0, 0];
  return Math.min(safeNumber(sourceRange[1], 0), safeNumber(sourceVideoDurationSec, safeNumber(sourceRange[1], 0)));
}

function computeNarrationPreviewBudget(slot, index, slots, geminiAnalysis, sourceVideoDurationSec) {
  const sourceRange = Array.isArray(slot?.source_range) ? slot.source_range : [0, 0];
  const startSec = safeNumber(sourceRange[0], 0);
  const baseGapSec = Math.max(0, safeNumber(sourceRange[1], 0) - startSec);
  const isLastNarration = String(slot?.slot_id || '') === lastNarrationSlotId(slots);
  if (!isLastNarration) {
    return {
      gapSec: baseGapSec,
      visibleGapSec: baseGapSec,
      tailAllowanceSec: 0,
      lastSlotVideoBound: false,
      visibleEndSec: safeNumber(sourceRange[1], 0),
    };
  }
  const visibleEndSec = resolveLastNarrationVisibleEndSec(slot, geminiAnalysis, sourceVideoDurationSec);
  const visibleGapSec = Math.max(0, visibleEndSec - startSec);
  return {
    gapSec: visibleGapSec + MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC,
    visibleGapSec,
    tailAllowanceSec: MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC,
    lastSlotVideoBound: true,
    visibleEndSec,
  };
}

function buildScriptPreviewMarkdown(script, slotMap, previewData, slotFillsPath, geminiAnalysis = {}, sourceVideoDurationSec = 0) {
  const slots = Array.isArray(slotMap?.slots) ? slotMap.slots : [];
  const segments = Array.isArray(script?.segments) ? script.segments : [];
  const segmentById = new Map(segments.map((segment) => [String(segment?.segment_id || ''), segment]));
  const ttsUnits = Array.isArray(previewData?.ttsUnits) ? previewData.ttsUnits : [];
  const ttsBySegmentId = new Map();
  for (const unit of ttsUnits) {
    const segmentId = String(unit?.segment_id || '');
    if (!segmentId) continue;
    const items = ttsBySegmentId.get(segmentId) || [];
    items.push(unit);
    ttsBySegmentId.set(segmentId, items);
  }
  const lines = [
    '# script_preview',
    '',
    `- slot_fills_path: ${path.relative(PROJECT_ROOT, slotFillsPath).replace(/\\/g, '/')}`,
    `- script_path: ${path.relative(PROJECT_ROOT, path.join(path.dirname(slotFillsPath), SCRIPT_FILE)).replace(/\\/g, '/')}`,
    '',
    '검수 포인트: slot_fills를 수정한 뒤 resume 하면 텍스트 재검증 후 TTS/드래프트가 이어집니다.',
    ''
  ];
  // Hoisted above the loop: this path only runs with pauseBeforeTts, which was hardcoded
  // off until now - the use-before-declaration below had never executed.
  const qualityCheck = script?.quality_check || {};
  const endingRules = qualityCheck.ending_rules_check || {};
  const deferredSlotFillErrors = Array.isArray(qualityCheck.deferred_slot_fill_errors) ? qualityCheck.deferred_slot_fill_errors : [];
  const deferredBySlotId = new Map(
    deferredSlotFillErrors
      .map((message) => {
        const match = String(message || '').match(/^(s\d+)/);
        return [match ? match[1] : '', String(message || '')];
      })
      .filter(([slotId]) => Boolean(slotId))
  );
  slots.forEach((slot, index) => {
    const slotId = String(slot?.slot_id || '');
    const slotType = String(slot?.type || '');
    const sourceRange = Array.isArray(slot?.source_range) ? slot.source_range : [0, 0];
    const gapSec = Math.max(0, Number(sourceRange[1] || 0) - Number(sourceRange[0] || 0));
    if (slotType === 'dialogue') {
      lines.push(`## [dialogue ${slotId}] ${formatSeconds(sourceRange[0])}-${formatSeconds(sourceRange[1])} (source, ${formatSeconds(gapSec)}s)`);
      lines.push(`> ${normalizeText(slot.caption_source_text || '') || '(원문 없음)'}`);
      lines.push('');
      return;
    }
    const segment = segmentById.get(slotId) || {};
    const narration = normalizeText(segment.narration || '');
    const role = normalizeText(slot.dialogue_heavy_role || slotRole(slotMap, slotId));
    const estimatedSec = estimateSpeechSeconds(narration);
    const previewBudget = computeNarrationPreviewBudget(slot, index, slots, geminiAnalysis, sourceVideoDurationSec);
    const effectiveGapSec = previewBudget.gapSec;
    const overBudget = estimatedSec > effectiveGapSec + 0.05;
    lines.push(`## [narration ${slotId}] ${role || 'narration'} · ${formatSeconds(sourceRange[0])}-${formatSeconds(sourceRange[1])} (source)`);
    lines.push(`- gap (source-budget): ${formatSeconds(effectiveGapSec)}s`);
    if (previewBudget.lastSlotVideoBound) {
      lines.push(`- visible_gap_before_tail (source): ${formatSeconds(previewBudget.visibleGapSec)}s`);
      lines.push(`- final_tail_allowance (source): ${formatSeconds(previewBudget.tailAllowanceSec)}s`);
      lines.push(`- last_visible_video_end (source): ${formatSeconds(previewBudget.visibleEndSec)}s`);
    }
    lines.push(`- estimated_speech (timeline estimate): ${formatSeconds(estimatedSec)}s${overBudget ? ' ⚠' : ''}`);
    if (deferredBySlotId.has(slotId)) {
      lines.push(`- deferred_validation_warning: ${deferredBySlotId.get(slotId)} ⚠`);
    }
    lines.push(`- lip_sync_risk: ${slot?.lip_sync_risk === true ? 'true' : 'false'}`);
    const dialogueContext = adjacentDialogueTexts(slots, index);
    if (dialogueContext.length) {
      lines.push('- adjacent_dialogue:');
      dialogueContext.forEach((item) => lines.push(`  - [dialogue] ${item}`));
    }
    const sentenceUnits = ttsBySegmentId.get(slotId) || [];
    if (sentenceUnits.length) {
      lines.push('- narration_sentences:');
      sentenceUnits.forEach((unit) => {
        lines.push(`  - ${unit.caption_id}: ${normalizeText(unit.text || '')}`);
      });
    } else {
      lines.push(`- narration: ${narration || '(비어 있음)'}`);
    }
    lines.push('');
  });
  const endings = endingStatsFromSegments(segments);
  const narrationSlots = slots.filter((slot) => slot?.type === 'narration').map((slot) => String(slot.slot_id || ''));
  const payoffSlots = narrationSlots.filter((slotId) => slotRole(slotMap, slotId) === 'payoff');
  lines.push('---');
  lines.push('');
  lines.push('## summary');
  lines.push(`- ending_distribution: 니다 ${endings.counts.nida} (${endings.pct.nida}%), 죠 ${endings.counts.jyo} (${endings.pct.jyo}%), 는데 ${endings.counts.neunde} (${endings.pct.neunde}%), 버렸 ${endings.counts.beoryeot} (${endings.pct.beoryeot}%)`);
  lines.push(`- payoff_slots: ${payoffSlots.join(', ') || '(none)'}`);
  lines.push(`- closing_drip_present: ${endingRules.closing_drip_present === true ? 'true' : 'false'}`);
  lines.push(`- knowledge_context_used: ${qualityCheck.knowledge_context_used === true ? 'true' : 'false'}`);
  if (deferredSlotFillErrors.length) {
    lines.push(`- deferred_slot_fill_errors: ${deferredSlotFillErrors.length}`);
  }
  lines.push(`- quality_flags: duration_within_60_180=${qualityCheck.duration_within_60_180 === true ? 'true' : 'false'}, korean_ending_rules_ok=${qualityCheck.korean_ending_rules_ok === true ? 'true' : 'false'}, all_scene_ids_exist_in_gemini_analysis=${qualityCheck.all_scene_ids_exist_in_gemini_analysis === true ? 'true' : 'false'}`);
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

async function generatePreviewData(state, outputPath) {
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const scriptPath = path.join(PROJECT_ROOT, 'midform', 'scripts', 'assemble_slot_draft_input.py');
  const args = [
    scriptPath,
    '--script', state.artifacts.scriptPath,
    '--source-video', state.artifacts.sourceVideoPath,
    '--transcript', state.artifacts.transcriptPath,
    '--output', outputPath,
    '--tts-dir', path.join(state.runDir, TTS_DIR),
    '--movie-research', state.artifacts.movieResearchPath,
    '--gemini-analysis', state.artifacts.geminiAnalysisPath,
    '--preview-only'
  ];
  await execFileAsync(python, args, { errorCode: 'MIDFORM_PREVIEW_ASSEMBLY_FAILED' });
  return readJson(outputPath);
}

async function generateScriptPreviewArtifacts(state) {
  const previewDataPath = path.join(state.runDir, SCRIPT_PREVIEW_DATA_FILE);
  const scriptPreviewPath = path.join(state.runDir, SCRIPT_PREVIEW_FILE);
  const qualityWarningsPath = path.join(state.runDir, QUALITY_WARNINGS_FILE);
  const slotFillsPath = path.join(state.runDir, SLOT_FILLS_FILE);
  const previewData = await generatePreviewData(state, previewDataPath);
  const script = readJson(state.artifacts.scriptPath);
  const slotMap = readJson(state.artifacts.slotMapPath);
  const geminiAnalysis = readJsonIfExists(state.artifacts.geminiAnalysisPath) || {};
  const sourceVideoDurationSec = getVideoMetadata(state.artifacts.sourceVideoPath)?.duration_sec || 0;
  previewData.timeCoordinates = {
    source: {
      description: 'Original source-video timeline in seconds',
      fields: ['segments[].source_clips[].start/end', 'slotMap.slots[].source_range', 'last_visible_video_end_source']
    },
    timeline: {
      description: 'Draft/TTS timeline in seconds',
      fields: ['estimated_speech_timeline_sec']
    }
  };
  writeJson(previewDataPath, previewData);
  writeText(scriptPreviewPath, buildScriptPreviewMarkdown(script, slotMap, previewData, slotFillsPath, geminiAnalysis, sourceVideoDurationSec));
  writeText(qualityWarningsPath, buildQualityWarningsMarkdown(state.qualityWarnings || [], previewData));
  state.artifacts.scriptPreviewDataPath = previewDataPath;
  state.artifacts.scriptPreviewPath = scriptPreviewPath;
  state.artifacts.qualityWarningsPath = qualityWarningsPath;
  saveState(state);
  return { previewDataPath, scriptPreviewPath, qualityWarningsPath };
}

function seededArtifactInputPresent(payload = {}) {
  return Boolean(
    (payload.bootstrapScriptPath || payload.bootstrap_script_path)
    && (payload.bootstrapSlotMapPath || payload.bootstrap_slot_map_path)
    && (payload.bootstrapTranscriptPath || payload.bootstrap_transcript_path)
    && (payload.bootstrapSourceVideoPath || payload.bootstrap_source_video_path)
  );
}

async function bootstrapSeededRun(state, payload = {}) {
  ensureDir(state.runDir);
  const seededTtsDir = path.join(state.runDir, TTS_DIR);
  ensureDir(seededTtsDir);
  const artifactMap = {
    sourceVideoPath: copyFileIntoRunIfPresent(payload.bootstrapSourceVideoPath || payload.bootstrap_source_video_path, path.join(state.runDir, `source${path.extname(String(payload.bootstrapSourceVideoPath || payload.bootstrap_source_video_path || '')) || '.mp4'}`), 'bootstrapSourceVideoPath'),
    sourceInfoPath: copyFileIntoRunIfPresent(payload.bootstrapSourceInfoPath || payload.bootstrap_source_info_path, path.join(state.runDir, SOURCE_INFO_FILE), 'bootstrapSourceInfoPath'),
    transcriptPath: copyFileIntoRunIfPresent(payload.bootstrapTranscriptPath || payload.bootstrap_transcript_path, path.join(state.runDir, TRANSCRIPT_FILE), 'bootstrapTranscriptPath'),
    preflightPath: copyFileIntoRunIfPresent(payload.bootstrapPreflightPath || payload.bootstrap_preflight_path, path.join(state.runDir, PREFLIGHT_FILE), 'bootstrapPreflightPath'),
    geminiAnalysisPath: copyFileIntoRunIfPresent(payload.bootstrapGeminiAnalysisPath || payload.bootstrap_gemini_analysis_path, path.join(state.runDir, GEMINI_FILE), 'bootstrapGeminiAnalysisPath'),
    movieResearchPath: copyFileIntoRunIfPresent(payload.bootstrapMovieResearchPath || payload.bootstrap_movie_research_path, path.join(state.runDir, MOVIE_RESEARCH_FILE), 'bootstrapMovieResearchPath'),
    slotMapPath: copyFileIntoRunIfPresent(payload.bootstrapSlotMapPath || payload.bootstrap_slot_map_path, path.join(state.runDir, SLOT_MAP_FILE), 'bootstrapSlotMapPath'),
    scriptPath: copyFileIntoRunIfPresent(payload.bootstrapScriptPath || payload.bootstrap_script_path, path.join(state.runDir, SCRIPT_FILE), 'bootstrapScriptPath'),
    slotFillsPath: copyFileIntoRunIfPresent(payload.bootstrapSlotFillsPath || payload.bootstrap_slot_fills_path, path.join(state.runDir, SLOT_FILLS_FILE), 'bootstrapSlotFillsPath'),
    ttsManifestPath: copyFileIntoRunIfPresent(payload.bootstrapTtsManifestPath || payload.bootstrap_tts_manifest_path, path.join(seededTtsDir, 'gpt_midform_tts_manifest.json'), 'bootstrapTtsManifestPath')
  };
  if (!artifactMap.sourceInfoPath) {
    writeJson(path.join(state.runDir, SOURCE_INFO_FILE), {
      id: path.basename(artifactMap.sourceVideoPath, path.extname(artifactMap.sourceVideoPath)),
      title: state.input.movieTitle || path.basename(artifactMap.sourceVideoPath),
      webpage_url: '',
      original_url: '',
      duration: 0,
      source_video_path: artifactMap.sourceVideoPath,
      local_source_path: artifactMap.sourceVideoPath
    });
    artifactMap.sourceInfoPath = path.join(state.runDir, SOURCE_INFO_FILE);
  }
  if (!artifactMap.slotFillsPath) {
    const bootstrappedScript = readJson(artifactMap.scriptPath);
    artifactMap.slotFillsPath = persistSlotFillsArtifact(state, bootstrappedScript);
  }
  state.artifacts = {
    ...state.artifacts,
    ...artifactMap
  };
  const completedStepIds = new Set(['prepare_source', 'transcribe', 'preflight', 'gemini_analysis', 'movie_research', 'slot_map', 'gpt_script']);
  state.steps = state.steps.map((step) => {
    if (completedStepIds.has(step.id)) {
      return {
        ...step,
        status: 'completed',
        startedAt: step.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: null,
        summary: step.summary || 'Bootstrapped from existing artifacts'
      };
    }
    if (step.id === 'review_checkpoint') {
      return {
        ...step,
        status: 'running',
        startedAt: new Date().toISOString(),
        error: null
      };
    }
    return step;
  });
  state.status = 'running';
  state.startedAt = state.startedAt || new Date().toISOString();
  saveState(state);
  if (state.input.pauseBeforeTts === true) {
    const previewArtifacts = await generateScriptPreviewArtifacts(state);
    state.steps = state.steps.map((step) => step.id === 'review_checkpoint'
      ? {
        ...step,
        status: 'completed',
        completedAt: new Date().toISOString(),
        summary: 'Paused before TTS for manual review',
        artifacts: previewArtifacts,
        error: null
      }
      : step);
    state.status = 'paused_review';
    state.review = normalizeReviewState({
      ...(state.review || {}),
      enabled: true,
      status: 'paused_review',
      pausedAt: new Date().toISOString(),
      previewPath: previewArtifacts.scriptPreviewPath,
      lastResumeError: null
    }, true);
    saveState(state);
    return;
  }
  state.steps = state.steps.map((step) => step.id === 'review_checkpoint'
    ? {
      ...step,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      summary: 'Review checkpoint skipped for direct seeded run',
      error: null
    }
    : step);
  saveState(state);
  await runRemainingPipelineFromTts(state, Boolean(artifactMap.ttsManifestPath));
}

function buildValidationOptions(state, transcript, movieResearch) {
  return {
    transcript,
    transcriptPath: state.artifacts.transcriptPath,
    slotMapPath: state.artifacts.slotMapPath,
    movieResearch,
    movieResearchPath: state.artifacts.movieResearchPath,
    sourceInfoPath: state.artifacts.sourceInfoPath,
    preflightGatePath: state.artifacts.preflightPath,
    contentType: state.input.contentType
  };
}

async function revalidateReviewedScript(state) {
  const slotFillsPath = path.join(state.runDir, SLOT_FILLS_FILE);
  const slotFillScript = fs.existsSync(slotFillsPath)
    ? readJson(slotFillsPath)
    : buildEditableSlotFills(readJson(state.artifacts.scriptPath));
  const slotMap = readJson(state.artifacts.slotMapPath);
  const gemini = readJson(state.artifacts.geminiAnalysisPath);
  const transcript = readJson(state.artifacts.transcriptPath);
  const movieResearch = readJsonIfExists(state.artifacts.movieResearchPath);
  const validationOptions = buildValidationOptions(state, transcript, movieResearch);
  await validateSlotFills(slotFillScript, slotMap, gemini, validationOptions);
  const normalizedScript = await normalizeSlotFillsToScript(slotFillScript, slotMap, gemini, {
    ...validationOptions,
    scriptId: String(slotFillScript.script_id || readJson(state.artifacts.scriptPath)?.script_id || state.runId || '').trim()
  });
  writeJson(state.artifacts.scriptPath, normalizedScript);
  writeJson(slotFillsPath, buildEditableSlotFills(normalizedScript));
  const validationPath = path.join(state.runDir, REVIEW_RESUME_VALIDATION_FILE);
  const validationReport = {
    status: 'passed',
    validatedAt: new Date().toISOString(),
    scriptPath: state.artifacts.scriptPath,
    slotFillsPath,
    slotCount: Array.isArray(slotFillScript.slot_fills) ? slotFillScript.slot_fills.length : 0
  };
  writeJson(validationPath, validationReport);
  state.artifacts.reviewResumeValidationPath = validationPath;
  state.artifacts.scriptPath = state.artifacts.scriptPath;
  saveState(state);
  return validationReport;
}

function persistSlotFillsArtifact(state, script) {
  const slotFillsPath = path.join(state.runDir, SLOT_FILLS_FILE);
  writeJson(slotFillsPath, buildEditableSlotFills(script));
  state.artifacts.slotFillsPath = slotFillsPath;
  saveState(state);
  return slotFillsPath;
}

async function runRemainingPipelineFromTts(state, reuseExistingTts) {
  await runStep(state, 'tts_assembly', () => runTtsAssembly(state, { reuseExistingTts }));
  await runStep(state, 'capcut_draft', () => runCapcutDraft(state));
  state.status = Array.isArray(state.qualityWarnings) && state.qualityWarnings.length ? 'completed_with_warnings' : 'completed';
  state.completedAt = new Date().toISOString();
  state.review = normalizeReviewState({
    ...(state.review || {}),
    status: state.review?.enabled ? 'completed' : 'skipped',
    resumedAt: state.review?.enabled ? new Date().toISOString() : '',
    lastResumeError: null
  }, state.review?.enabled === true);
  saveState(state);
}

function createRunId(payload) {
  const title = payload.movieTitle || payload.movie_title || payload.sourceUrl || payload.source_url || payload.sourceVideoPath || payload.source_video_path || 'midform';
  return `run_${timestampForId()}_${safeSlug(title)}`;
}

function statePathForRun(runId) {
  return path.join(TEST_RUNS_DIR, runId, STATE_FILE);
}

function runDirForRun(runId) {
  return path.join(TEST_RUNS_DIR, runId);
}

function buildInitialState(payload) {
  const runId = createRunId(payload);
  const runDir = runDirForRun(runId);
  return {
    runId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: '',
    completedAt: '',
    runDir,
    input: {
      sourceUrl: String(payload.sourceUrl || payload.source_url || '').trim(),
      sourceVideoPath: String(payload.sourceVideoPath || payload.source_video_path || '').trim(),
      movieTitle: String(payload.movieTitle || payload.movie_title || '').trim(),
      contentType: String(payload.contentType || payload.content_type || 'movie_midform_recap').trim(),
      pauseBeforeTts: payload.pauseBeforeTts === true || payload.pause_before_tts === true,
      interactiveMode: payload.interactiveMode === true || payload.interactive_mode === true,
      preflightOverridden: payload.preflightOverridden === true || payload.preflight_overridden === true
    },
    steps: createSteps(),
    artifacts: {},
    error: null,
    qualityWarnings: [],
    preflightGate: {
      status: 'pending',
      overridden: false,
      rejectReasons: []
    },
    review: normalizeReviewState({
      enabled: payload.pauseBeforeTts === true || payload.pause_before_tts === true,
      status: payload.pauseBeforeTts === true || payload.pause_before_tts === true ? 'pending' : 'disabled',
      pausedAt: '',
      resumedAt: '',
      previewPath: '',
      lastResumeError: null
    }, payload.pauseBeforeTts === true || payload.pause_before_tts === true)
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(statePathForRun(state.runId), state);
}

function stepIndex(state, stepId) {
  return state.steps.findIndex((step) => step.id === stepId);
}

function updateStep(state, stepId, patch) {
  const index = stepIndex(state, stepId);
  if (index < 0) return;
  state.steps[index] = { ...state.steps[index], ...patch };
  saveState(state);
}

async function runStep(state, stepId, work) {
  updateStep(state, stepId, { status: 'running', startedAt: new Date().toISOString(), error: null });
  try {
    const result = await work();
    updateStep(state, stepId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      summary: result?.summary || '',
      artifacts: result?.artifacts || {}
    });
    return result || {};
  } catch (error) {
    const body = {
      message: error.message || 'Pipeline step failed',
      code: error.code || `${stepId.toUpperCase()}_FAILED`,
      details: error.details || {}
    };
    updateStep(state, stepId, { status: 'failed', completedAt: new Date().toISOString(), error: body });
    throw Object.assign(new Error(body.message), body);
  }
}

function createHttpError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function assertInsideProject(filePath, label) {
  const resolved = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(PROJECT_ROOT, filePath);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (!(relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative)))) {
    throw createHttpError(400, 'MIDFORM_PATH_OUTSIDE_PROJECT', `${label} must stay inside the project root`, { filePath });
  }
  return resolved;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: PROJECT_ROOT,
      env: getToolEnv(options.env || {}),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: options.maxBuffer || 100 * 1024 * 1024,
      timeout: options.timeout || PIPELINE_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      const allowedExitCodes = options.allowedExitCodes || [0];
      if (error && !allowedExitCodes.includes(error.code)) {
        reject(createHttpError(500, options.errorCode || 'MIDFORM_COMMAND_FAILED', error.message, {
          command,
          args,
          exitCode: error.code,
          stdout: String(stdout || '').slice(-4000),
          stderr: String(stderr || '').slice(-4000)
        }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: error ? error.code : 0 });
    });
  });
}

function findDownloadedSource(runDir) {
  const candidates = fs.readdirSync(runDir)
    .filter((name) => /^source\.[A-Za-z0-9]+$/.test(name))
    .map((name) => path.join(runDir, name))
    .filter((filePath) => fs.statSync(filePath).isFile());
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || '';
}

async function prepareSource(state) {
  const runDir = state.runDir;
  ensureDir(runDir);
  const sourceInfoPath = path.join(runDir, SOURCE_INFO_FILE);
  const localSource = state.input.sourceVideoPath;
  if (localSource) {
    const sourcePath = assertInsideProject(localSource, 'sourceVideoPath');
    if (!fs.existsSync(sourcePath)) throw createHttpError(400, 'SOURCE_VIDEO_NOT_FOUND', 'sourceVideoPath was not found', { sourcePath });
    const targetPath = path.join(runDir, `source${path.extname(sourcePath) || '.mp4'}`);
    fs.copyFileSync(sourcePath, targetPath);
    writeJson(sourceInfoPath, {
      id: path.basename(sourcePath, path.extname(sourcePath)),
      title: state.input.movieTitle || path.basename(sourcePath),
      webpage_url: '',
      original_url: '',
      duration: 0,
      source_video_path: targetPath,
      local_source_path: sourcePath
    });
    state.artifacts.sourceVideoPath = targetPath;
    state.artifacts.sourceInfoPath = sourceInfoPath;
    saveState(state);
    return { summary: 'Local source copied', artifacts: { sourceVideoPath: targetPath, sourceInfoPath } };
  }

  if (!state.input.sourceUrl) {
    throw createHttpError(400, 'SOURCE_REQUIRED', 'sourceUrl or sourceVideoPath is required');
  }
  const ytDlp = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  const metadata = await execFileAsync(ytDlp, ['--js-runtimes', 'node', '--dump-single-json', '--no-playlist', state.input.sourceUrl], { errorCode: 'YTDLP_METADATA_FAILED' });
  const parsed = JSON.parse(metadata.stdout.trim());
  writeJson(sourceInfoPath, parsed);
  await execFileAsync(ytDlp, ['--js-runtimes', 'node', '--no-playlist', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', path.join(runDir, 'source.%(ext)s'), state.input.sourceUrl], { errorCode: 'YTDLP_DOWNLOAD_FAILED' });
  const sourceVideoPath = findDownloadedSource(runDir);
  if (!sourceVideoPath) throw createHttpError(500, 'SOURCE_DOWNLOAD_MISSING', 'yt-dlp completed but no source file was found', { runDir });
  state.artifacts.sourceVideoPath = sourceVideoPath;
  state.artifacts.sourceInfoPath = sourceInfoPath;
  saveState(state);
  return { summary: parsed.title || 'Source downloaded', artifacts: { sourceVideoPath, sourceInfoPath } };
}

async function transcribeSource(state) {
  const outputPath = path.join(state.runDir, TRANSCRIPT_FILE);
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'transcribe_source.py');
  await execFileAsync(python, [scriptPath, state.artifacts.sourceVideoPath, '--output', outputPath], { errorCode: 'MIDFORM_TRANSCRIBE_FAILED' });
  state.artifacts.transcriptPath = outputPath;
  saveState(state);
  const transcript = readJson(outputPath);
  return { summary: `${transcript.utterance_count || 0} utterances`, artifacts: { transcriptPath: outputPath } };
}

async function runPreflight(state) {
  const outputPath = path.join(state.runDir, PREFLIGHT_FILE);
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const scriptPath = path.join(PROJECT_ROOT, 'midform', 'scripts', 'preflight_material_gate.py');
  const args = [scriptPath, '--source-info', state.artifacts.sourceInfoPath, '--transcript', state.artifacts.transcriptPath, '--output', outputPath];
  if (state.input.movieTitle) args.push('--movie-title', state.input.movieTitle);
  const result = await execFileAsync(python, args, { allowedExitCodes: [0, 2], errorCode: 'MIDFORM_PREFLIGHT_FAILED' });
  const preflight = readJson(outputPath);
  state.artifacts.preflightPath = outputPath;
  saveState(state);
  if (result.exitCode === 2 || preflight.status !== 'pass') {
    throw createHttpError(422, 'MIDFORM_PREFLIGHT_REJECTED', 'Preflight material gate rejected this source', { preflight, stdout: result.stdout });
  }
  return { summary: `speech ratio ${preflight.speech?.speech_ratio ?? 'n/a'}`, artifacts: { preflightPath: outputPath } };
}

async function runGemini(state) {
  const transcript = readJson(state.artifacts.transcriptPath);
  const gemini = await analyzeMidformVideo(state.artifacts.sourceVideoPath, state.input.contentType, { transcript });
  const outputPath = path.join(state.runDir, GEMINI_FILE);
  writeJson(outputPath, {
    ...gemini,
    source_transcript: transcript,
    source_info: readJsonIfExists(state.artifacts.sourceInfoPath) || {}
  });
  state.artifacts.geminiAnalysisPath = outputPath;
  saveState(state);
  return { summary: `${Array.isArray(gemini.scenes) ? gemini.scenes.length : 0} scenes`, artifacts: { geminiAnalysisPath: outputPath } };
}

async function runMovieResearch(state) {
  const outputPath = path.join(state.runDir, MOVIE_RESEARCH_FILE);
  const result = await generateAndSaveMovieResearch({
    geminiAnalysisPath: state.artifacts.geminiAnalysisPath,
    sourceInfoPath: state.artifacts.sourceInfoPath,
    transcriptPath: state.artifacts.transcriptPath,
    preflightGatePath: state.artifacts.preflightPath,
    outputPath
  });
  state.artifacts.movieResearchPath = outputPath;
  saveState(state);
  const title = result.movie_identity?.title_kr || result.movie_identity?.title_en || result.movie_identity?.status || 'movie research saved';
  return { summary: title, artifacts: { movieResearchPath: outputPath } };
}

async function runSlotMap(state) {
  const outputPath = path.join(state.runDir, SLOT_MAP_FILE);
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const scriptPath = path.join(PROJECT_ROOT, 'midform', 'scripts', 'build_slot_map.py');
  await execFileAsync(python, [scriptPath, '--transcript', state.artifacts.transcriptPath, '--gemini', state.artifacts.geminiAnalysisPath, '--output', outputPath, '--source-video', state.artifacts.sourceVideoPath], { errorCode: 'MIDFORM_SLOT_MAP_FAILED' });
  state.artifacts.slotMapPath = outputPath;
  saveState(state);
  const slotMap = readJson(outputPath);
  return { summary: `${Array.isArray(slotMap.slots) ? slotMap.slots.length : 0} slots`, artifacts: { slotMapPath: outputPath } };
}

async function runGptScript(state) {
  const gemini = readJson(state.artifacts.geminiAnalysisPath);
  const transcript = readJson(state.artifacts.transcriptPath);
  const slotMap = readJson(state.artifacts.slotMapPath);
  const movieResearch = readJsonIfExists(state.artifacts.movieResearchPath);
  const result = await generateMidformScriptWithGptCli(gemini, {
    transcript,
    transcriptPath: state.artifacts.transcriptPath,
    slotMap,
    slotMapPath: state.artifacts.slotMapPath,
    movieResearch,
    movieResearchPath: state.artifacts.movieResearchPath,
    sourceInfoPath: state.artifacts.sourceInfoPath,
    preflightGatePath: state.artifacts.preflightPath,
    contentType: state.input.contentType,
    interactiveMode: state.input.interactiveMode === true
  });
  const outputPath = path.join(state.runDir, SCRIPT_FILE);
  writeJson(outputPath, result.script);
  state.artifacts.scriptPath = outputPath;
  state.artifacts.gptCli = result.cli || {};
  state.artifacts.deferredSlotFillErrors = Array.isArray(result.cli?.deferredValidationErrors) ? result.cli.deferredValidationErrors : [];
  state.qualityWarnings = normalizeQualityWarnings(result.cli?.deferredValidationWarnings || []);
  persistSlotFillsArtifact(state, result.script);
  saveState(state);
  return { summary: `${Array.isArray(result.script.segments) ? result.script.segments.length : 0} segments`, artifacts: { scriptPath: outputPath, cli: result.cli || {} } };
}

async function runTtsAssembly(state, options = {}) {
  const outputPath = path.join(state.runDir, DRAFT_INPUT_FILE);
  const ttsDir = path.join(state.runDir, TTS_DIR);
  ensureDir(ttsDir);
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const scriptPath = path.join(PROJECT_ROOT, 'midform', 'scripts', 'assemble_slot_draft_input.py');
  const args = [
    scriptPath,
    '--script', state.artifacts.scriptPath,
    '--source-video', state.artifacts.sourceVideoPath,
    '--transcript', state.artifacts.transcriptPath,
    '--output', outputPath,
    '--tts-dir', ttsDir,
    '--movie-research', state.artifacts.movieResearchPath,
    '--gemini-analysis', state.artifacts.geminiAnalysisPath
  ];
  if (options.reuseExistingTts && state.artifacts.ttsManifestPath && fs.existsSync(state.artifacts.ttsManifestPath)) {
    args.push('--reuse-tts-manifest', state.artifacts.ttsManifestPath);
  }
  await execFileAsync(python, args, { errorCode: 'MIDFORM_TTS_ASSEMBLY_FAILED' });
  const ttsManifestPath = path.join(ttsDir, 'gpt_midform_tts_manifest.json');
  state.artifacts.draftInputPath = outputPath;
  state.artifacts.ttsManifestPath = ttsManifestPath;
  saveState(state);
  const draftInput = readJson(outputPath);
  let ttsReuseLogPath = '';
  if (draftInput.ttsReuseSummary && typeof draftInput.ttsReuseSummary === 'object') {
    ttsReuseLogPath = path.join(state.runDir, TTS_REUSE_LOG_FILE);
    writeJson(ttsReuseLogPath, draftInput.ttsReuseSummary);
    state.artifacts.ttsReuseLogPath = ttsReuseLogPath;
    saveState(state);
  }
  return { summary: `${draftInput.captionUnits?.length || 0} caption units`, artifacts: { draftInputPath: outputPath, ttsManifestPath, ttsReuseLogPath } };
}

async function runCapcutDraft(state) {
  const draftInput = readJson(state.artifacts.draftInputPath);
  const result = await generateDraft(
    draftInput.segments || [],
    draftInput.ttsFiles || [],
    draftInput.captionUnits || [],
    draftInput.captionWarnings || [],
    draftInput.srtFile || '',
    draftInput.resolution || { width: 1080, height: 1920 },
    draftInput.fps || 30,
    draftInput.audioPathMode || 'absolute',
    draftInput.videoPlacementMode || 'source_clips',
    draftInput.useCapcutTemplate !== false,
    draftInput.gptScript || draftInput.claudeScript || {},
    {
      slotMap: draftInput.slotMap || {},
      sourceTranscriptPath: state.artifacts.transcriptPath,
      source_transcript_path: state.artifacts.transcriptPath,
      source_video_path: state.artifacts.sourceVideoPath,
      draft_output_mode: state.input.draft_output_mode || state.input.draftOutputMode || 'folder_only',
      package_zip: state.input.package_zip === true || state.input.packageZip === true,
      movieResearch: draftInput.movieResearch || {},
      geminiAnalysis: draftInput.geminiAnalysis || {}
    }
  );
  state.artifacts.draft = result;
  state.artifacts.srtPath = result.draftSubtitlePath || '';
  state.artifacts.draftZipPath = result.zipPath || '';
  saveState(state);
  return { summary: result.draftPath || 'draft generated', artifacts: { draft: result, srtPath: state.artifacts.srtPath, draftPath: result.draftPath || '', draftZipPath: state.artifacts.draftZipPath } };
}

async function runPipelineAfterPreflight(state) {
  await runStep(state, 'gemini_analysis', () => runGemini(state));
  await runStep(state, 'movie_research', () => runMovieResearch(state));
  await runStep(state, 'slot_map', () => runSlotMap(state));
  await runStep(state, 'gpt_script', () => runGptScript(state));
  if (state.input.interactiveMode === true && Array.isArray(state.qualityWarnings) && state.qualityWarnings.length > 0) {
    await generateScriptPreviewArtifacts(state);
  }
  if (state.input.pauseBeforeTts === true || (state.input.interactiveMode === true && Array.isArray(state.qualityWarnings) && state.qualityWarnings.length > 0)) {
    const reviewResult = await runStep(state, 'review_checkpoint', async () => {
      const artifacts = await generateScriptPreviewArtifacts(state);
      return {
        summary: Array.isArray(state.qualityWarnings) && state.qualityWarnings.length
          ? 'Validation warnings deferred to manual review'
          : 'Paused before TTS for manual review',
        artifacts
      };
    });
    state.status = 'paused_review';
    state.review = normalizeReviewState({
      ...(state.review || {}),
      status: 'paused_review',
      pausedAt: new Date().toISOString(),
      previewPath: reviewResult?.artifacts?.scriptPreviewPath || state.artifacts.scriptPreviewPath || '',
      lastResumeError: null
    }, true);
    state.completedAt = '';
    saveState(state);
    return;
  }
  await runStep(state, 'tts_assembly', () => runTtsAssembly(state, { reuseExistingTts: false }));
  await runStep(state, 'capcut_draft', () => runCapcutDraft(state));
  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  saveState(state);
}

async function runPipeline(state) {
  activeRunId = state.runId;
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  saveState(state);
  try {
    await runStep(state, 'prepare_source', () => prepareSource(state));
    await runStep(state, 'transcribe', () => transcribeSource(state));
    try {
      await runStep(state, 'preflight', () => runPreflight(state));
      state.preflightGate = {
        status: 'passed',
        overridden: false,
        rejectReasons: []
      };
      saveState(state);
    } catch (error) {
      if (state.input.interactiveMode === true && error.code === 'MIDFORM_PREFLIGHT_REJECTED') {
        markPreflightBlocked(state, error.details?.preflight || {}, error.details?.stdout || '');
        return;
      }
      throw error;
    }
    await runPipelineAfterPreflight(state);
  } catch (error) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.error = {
      message: error.message || 'Midform pipeline failed',
      code: error.code || 'MIDFORM_PIPELINE_FAILED',
      details: error.details || {}
    };
    saveState(state);
  } finally {
    if (activeRunId === state.runId) activeRunId = '';
  }
}

async function resumeRun(runId) {
  if (activeRunId) {
    throw createHttpError(409, 'MIDFORM_PIPELINE_BUSY', 'A midform pipeline run is already active', { activeRunId });
  }
  const state = getRun(runId);
  if (state.status !== 'paused_review') {
    throw createHttpError(409, 'MIDFORM_REVIEW_NOT_PAUSED', 'This run is not paused for review', { runId, status: state.status });
  }
  activeRunId = state.runId;
  state.status = 'running';
  state.error = null;
  state.review = normalizeReviewState({
    ...(state.review || {}),
    status: 'resuming',
    lastResumeError: null
  }, true);
  saveState(state);
  try {
    await revalidateReviewedScript(state);
    const previewArtifacts = await generateScriptPreviewArtifacts(state);
    state.review = normalizeReviewState({
      ...(state.review || {}),
      previewPath: previewArtifacts.scriptPreviewPath,
      status: 'validated'
    }, true);
    saveState(state);
    await runRemainingPipelineFromTts(state, true);
    return getRun(state.runId);
  } catch (error) {
    state.status = 'paused_review';
    state.completedAt = '';
    state.review = normalizeReviewState({
      ...(state.review || {}),
      status: 'paused_review',
      lastResumeError: {
        message: error.message || 'Resume validation failed',
        code: error.code || 'MIDFORM_REVIEW_RESUME_FAILED',
        details: error.details || {}
      }
    }, true);
    saveState(state);
    throw error;
  } finally {
    if (activeRunId === state.runId) activeRunId = '';
  }
}

async function overridePreflightRun(runId) {
  if (activeRunId) {
    throw createHttpError(409, 'MIDFORM_PIPELINE_BUSY', 'A midform pipeline run is already active', { activeRunId });
  }
  const state = getRun(runId);
  if (state.status !== 'blocked_preflight') {
    throw createHttpError(409, 'MIDFORM_PREFLIGHT_NOT_BLOCKED', 'This run is not waiting on preflight override', { runId, status: state.status });
  }
  if (state.input?.interactiveMode !== true) {
    throw createHttpError(403, 'MIDFORM_PREFLIGHT_OVERRIDE_FORBIDDEN', 'Preflight override is only allowed for interactive runs', { runId });
  }
  activeRunId = state.runId;
  state.status = 'running';
  state.error = null;
  markPreflightOverride(state);
  try {
    await runPipelineAfterPreflight(state);
    return getRun(state.runId);
  } catch (error) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.error = {
      message: error.message || 'Midform pipeline failed after preflight override',
      code: error.code || 'MIDFORM_PIPELINE_FAILED',
      details: error.details || {}
    };
    saveState(state);
    throw error;
  } finally {
    if (activeRunId === state.runId) activeRunId = '';
  }
}

function startRun(payload = {}) {
  if (activeRunId) {
    throw createHttpError(409, 'MIDFORM_PIPELINE_BUSY', 'A midform pipeline run is already active', { activeRunId });
  }
  const state = buildInitialState(payload);
  ensureDir(state.runDir);
  saveState(state);
  setImmediate(() => {
    const work = seededArtifactInputPresent(payload)
      ? bootstrapSeededRun(state, payload)
      : runPipeline(state);
    Promise.resolve(work).catch((error) => {
      state.status = 'failed';
      state.completedAt = new Date().toISOString();
      state.error = {
        message: error.message || 'Midform pipeline failed',
        code: error.code || 'MIDFORM_PIPELINE_FAILED',
        details: error.details || {}
      };
      saveState(state);
      console.error('[midform.pipeline] unhandled run failure', error);
    });
  });
  return state;
}

function getRun(runId) {
  const safeRunId = path.basename(String(runId || '').trim());
  if (!safeRunId || safeRunId !== runId) {
    throw createHttpError(400, 'MIDFORM_RUN_ID_INVALID', 'Invalid runId', { runId });
  }
  const state = readJsonIfExists(statePathForRun(safeRunId));
  if (!state) throw createHttpError(404, 'MIDFORM_RUN_NOT_FOUND', 'Midform pipeline run not found', { runId: safeRunId });
  state.review = normalizeReviewState(state.review, state.input?.pauseBeforeTts === true);
  state.preflightGate = normalizePreflightGateState(state);
  if (state.artifacts?.ttsReuseLogPath && fs.existsSync(state.artifacts.ttsReuseLogPath)) {
    state.artifacts.ttsReuseSummary = readJsonIfExists(state.artifacts.ttsReuseLogPath);
  }
  state.qualityWarnings = normalizeQualityWarnings(state.qualityWarnings || state.artifacts?.gptCli?.deferredValidationWarnings || state.artifacts?.deferredValidationWarnings || []);
  return state;
}

function readReviewArtifacts(runId) {
  const state = getRun(runId);
  const previewDataPath = state.artifacts.scriptPreviewDataPath;
  const previewMarkdownPath = state.artifacts.scriptPreviewPath;
  const slotFillsPath = state.artifacts.slotFillsPath || path.join(state.runDir, SLOT_FILLS_FILE);
  const previewData = readJsonIfExists(previewDataPath);
  const slotFills = readJsonIfExists(slotFillsPath);
  if (!previewData || !slotFills) {
    throw createHttpError(404, 'MIDFORM_REVIEW_ARTIFACTS_NOT_FOUND', 'Review artifacts are not available for this run', {
      runId,
      previewDataPath,
      slotFillsPath
    });
  }
  return {
    runId: state.runId,
    status: state.status,
    review: state.review,
    previewData,
    previewMarkdown: previewMarkdownPath && fs.existsSync(previewMarkdownPath) ? fs.readFileSync(previewMarkdownPath, 'utf8') : '',
    slotFills,
    paths: {
      previewDataPath,
      previewMarkdownPath,
      slotFillsPath
    }
  };
}

function saveReviewSlotFills(runId, slotFillPayload) {
  const state = getRun(runId);
  if (state.status !== 'paused_review') {
    throw createHttpError(409, 'MIDFORM_REVIEW_NOT_PAUSED', 'This run is not paused for review', { runId, status: state.status });
  }
  const slotFillsPath = state.artifacts.slotFillsPath || path.join(state.runDir, SLOT_FILLS_FILE);
  writeJson(slotFillsPath, slotFillPayload);
  state.artifacts.slotFillsPath = slotFillsPath;
  saveState(state);
  return {
    runId: state.runId,
    saved: true,
    slotFillsPath,
    review: state.review
  };
}

function listRuns() {
  ensureDir(TEST_RUNS_DIR);
  return fs.readdirSync(TEST_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJsonIfExists(path.join(TEST_RUNS_DIR, entry.name, STATE_FILE)))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((state) => ({
      runId: state.runId,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      input: state.input,
      currentStep: state.status === 'paused_review' ? 'review_checkpoint' : (state.steps.find((step) => step.status === 'running')?.id || ''),
      review: normalizeReviewState(state.review, state.input?.pauseBeforeTts === true),
      preflightGate: normalizePreflightGateState(state),
      qualityWarnings: normalizeQualityWarnings(state.qualityWarnings || []),
      error: state.error
    }));
}

function artifactPathFor(runId, kind) {
  const state = getRun(runId);
  const filePath = kind === 'srt'
    ? state.artifacts.srtPath
    : (kind === 'draft_folder' ? state.artifacts.draft?.draftPath : state.artifacts.draftZipPath);
  if (!filePath || !fs.existsSync(filePath)) {
    throw createHttpError(404, `MIDFORM_${kind.toUpperCase()}_NOT_FOUND`, `${kind} artifact not found`, { runId, filePath });
  }
  return filePath;
}

function zipRunDirectory(runId) {
  const state = getRun(runId);
  const zipPath = path.join(DRAFTS_DIR, `${state.runId}_artifacts.zip`);
  ensureDir(DRAFTS_DIR);
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(state.runDir, state.runId);
    archive.finalize();
  });
}

module.exports = {
  startRun,
  resumeRun,
  overridePreflightRun,
  getRun,
  readReviewArtifacts,
  saveReviewSlotFills,
  listRuns,
  artifactPathFor,
  zipRunDirectory
};
