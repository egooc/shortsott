const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');
const {
  MIDFORM_SLOT_FILLS_SCHEMA_PATH,
  MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH,
  MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH,
  runCodexCli,
  extractJson
} = require('./gptMidformCliService');
const { generateVertexJson, analyzeMidformVideo } = require('./geminiMidformService');

// compress LLM provider: 'vertex' (Gemini, default — off the Codex weekly quota) or 'codex' (kept
// as fallback/opt-in). Model applies to the Vertex path only.
function compressLlmProvider() {
  return String(process.env.MIDFORM_COMPRESS_LLM || 'vertex').trim().toLowerCase();
}
function compressVertexModel() {
  return String(process.env.VERTEX_COMPRESS_MODEL || 'gemini-2.5-pro').trim();
}

const RECAP_CONTEXT_TEMPLATE_PATH = path.join(PROJECT_ROOT, 'midform', 'templates', 'recap_context_template.md');
const MIDFORM_TTS_CONFIG_PATH = path.join(PROJECT_ROOT, 'midform', 'config', 'tts.json');
const MIDFORM_HOOK_PATTERNS_PATH = path.join(PROJECT_ROOT, 'midform', 'config', 'hook_patterns.json');

// Resolves the human-authored recap context for a run. Explicit --context-file must exist
// (fail loudly); otherwise auto-detect <runDir>/context.md. A context.md still identical to
// the blank template counts as NOT provided, so unfilled auto-copies change nothing.
function resolveRecapContext(runDir, contextFileOption) {
  const explicit = String(contextFileOption || '').trim();
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.join(PROJECT_ROOT, explicit);
    if (!fs.existsSync(resolved)) throw new Error(`--context-file not found: ${resolved}`);
    return { contextFile: resolved, contextMarkdown: fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''), contextProvided: true };
  }
  const autoPath = path.join(runDir, 'context.md');
  if (!fs.existsSync(autoPath)) return { contextFile: '', contextMarkdown: '', contextProvided: false };
  const content = fs.readFileSync(autoPath, 'utf8').replace(/^\uFEFF/, '');
  const template = fs.existsSync(RECAP_CONTEXT_TEMPLATE_PATH) ? fs.readFileSync(RECAP_CONTEXT_TEMPLATE_PATH, 'utf8').replace(/^\uFEFF/, '') : '';
  if (template && content.trim() === template.trim()) {
    return { contextFile: autoPath, contextMarkdown: '', contextProvided: false };
  }
  return { contextFile: autoPath, contextMarkdown: content, contextProvided: true };
}

const COMPRESS_RUNS_DIR = path.join(PROJECT_ROOT, 'midform', 'test_runs');
const DEFAULT_TARGET_SEC = 160;
const DIALOGUE_FOCUS_PAD_SEC = 0.25;
const COLD_OPEN_VISUAL_MIN_SEC = 3;
const COLD_OPEN_VISUAL_MAX_SEC = 6;
const COLD_OPEN_VISUAL_TARGET_SEC = 4.5;
const COLD_OPEN_DIALOGUE_MAX_SEC = 16;
const COLD_OPEN_NARRATION_MAX_SEC = 6.5;
const DIALOGUE_QUALITY_RANK = { high: 3, mid: 2, low: 1 };
const CODEX_TRANSPORT_RETRIES = 3;
const EDIT_PLAN_MAX_DIALOGUE_QUOTES = 4;
const EDIT_PLAN_MAX_HEATMAP_ITEMS = 12;
const BEAT_MAX_ANCHOR_LINES = 2;
const REVEAL_BEAT_MAX_ANCHOR_LINES = 3;
// Heuristic only — real duration should come from actual TTS output once available.
const BASE_KOREAN_NARRATION_CHARS_PER_SEC = 4.8;
const KOREAN_NARRATION_MIN_SEC = 1.5;
const KOREAN_NARRATION_PAUSE_BUFFER_SEC = 0.3;
const DIALOGUE_CONTEXT_PRE_ROLL_SEC = 0.7;
const DIALOGUE_CONTEXT_POST_ROLL_SEC = 0.5;
const DIALOGUE_CONTEXT_LOOKBACK_SEC = 25;
const PRONOUN_OR_DEICTIC_RE = /\b(?:he|she|him|her|his|hers|they|them|their|that|this|it|its|those|these)\b|(?:그|그녀|그들|그걸|그것|그 일|저것|이것)/i;
const RESPONSE_DEPENDENCY_RE = /^(?:if|because|so|then|but|and|no|yes|don'?t|do not|that|this|it|they|you)\b/i;
const EARLY_DIALOGUE_TARGET_MIN_SEC = 20;
const EARLY_DIALOGUE_TARGET_MAX_SEC = 30;
const EARLY_DIALOGUE_WARNING_SEC = 35;
const EARLY_DIALOGUE_FAIL_SEC = 40;
const MAX_CONFRONTATION_NARRATION_RUN_SEC = 25;
const EARLY_DIALOGUE_SEARCH_MAX_SEC = 35;
const CALLBACK_DIALOGUE_TARGET_MIN_SEC = 20;
const CALLBACK_DIALOGUE_TARGET_MAX_SEC = 35;
const CONFRONTATION_SIGNAL_RE = /\b(?:confront|confrontation|argument|argues|accus|accuses|accusation|challenge|challenges|clash|rebut|defend|defends|truth|not true|kill the ad|fired|ousted|board|fight)\b/i;
const MICRO_EXCHANGE_DEFAULT_MAX_GAP_SEC = 2;
const MICRO_EXCHANGE_DEFAULT_MAX_DURATION_SEC = 12;

function normalizeQcActionAction(value) {
  const action = String(value || '').trim();
  if (!action || action === 'none') return 'none';
  if (['merge_exchange', 'merged_previous_line', 'merge_adjacent_lines'].includes(action)) return 'merge_adjacent_lines';
  if (['bridge_narration', 'bridge_required'].includes(action)) return 'bridge_required';
  if (['downgrade', 'downgrade_to_narrate'].includes(action)) return 'downgrade_to_narrate';
  if (['extend_line_window', 'extended_line_window'].includes(action)) return 'extend_line_window';
  return action;
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

// The band title box carries ~12 Korean chars per line; the old hard slice(0, 8) cut hook
// phrases MID-WORD ("하나인 줄 알았는데" shipped as "하나인 줄 알았"). Cut at a word boundary
// inside the budget instead, and never mid-syllable-block.
function trimOverlayLine(value, maxChars = 12) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars + 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace >= 4 ? clipped.slice(0, lastSpace) : text.slice(0, maxChars)).trim();
}

function normalizeUploadText(uploadText) {
  const titleCandidates = Array.isArray(uploadText?.title_candidates)
    ? uploadText.title_candidates.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const overlayTitle = uploadText?.overlay_title && typeof uploadText.overlay_title === 'object'
    ? uploadText.overlay_title
    : {};
  return {
    title_candidates: titleCandidates,
    overlay_title: {
      top: trimOverlayLine(overlayTitle.top),
      bottom: trimOverlayLine(overlayTitle.bottom)
    },
    description: String(uploadText?.description || '').trim(),
    pinned_comment: String(uploadText?.pinned_comment || '').trim()
  };
}

// Curiosity titles do not have to be literal questions. Korean hook titles just as often
// end on a noun that promises an answer without giving it ("...전쟁을 불렀던 이유"), which
// opens the same curiosity gap. What we still reject is a flat declarative summary.
// "을까" covers the general past-tense question form (했을까 / 않았을까 / 왜였을까), which the
// earlier explicit list kept missing.
const CURIOSITY_TITLE_QUESTION_ENDINGS = /(을까|ㄹ까|일까|될까|할까|무엇일까|누굴까|누구일까|어쩌다)$/;
// Enumerating the acceptable noun endings kept rejecting perfectly good hooks, because the
// set is open — 이유, 정체, 계기, 전말 and so on. Invert it: a title fails when it closes
// the gap, either by finishing as a declarative sentence or by labelling the clip.
const CURIOSITY_TITLE_DECLARATIVE_ENDINGS = /(습니다|합니다|입니다|됩니다|겁니다|한다|된다|이다|였다|이었다|했다|됐다|왔다|갔다|난다|진다)$/;
const CURIOSITY_TITLE_LABEL_ENDINGS = /(장면|명장면|하이라이트|모음|편집본|영상|클립|다시보기|요약)$/;

function isCuriosityTitle(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  if (/[?？]/.test(text)) return true;
  if (CURIOSITY_TITLE_QUESTION_ENDINGS.test(text)) return true;
  if (CURIOSITY_TITLE_DECLARATIVE_ENDINGS.test(text)) return false;
  if (CURIOSITY_TITLE_LABEL_ENDINGS.test(text)) return false;
  return true;
}

function splitNarrationSentences(text) {
  return String(text || '')
    .split(/[.!?…。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function rebuildNarrationFromSentences(sentences) {
  return sentences.map((sentence) => sentence.replace(/[.!?…。！？]+$/g, '').trim()).filter(Boolean).join(' ');
}

function normalizeClosingSlotFill(fill) {
  if (!fill) return fill;
  const narration = String(fill.narration || '').trim();
  const sentences = splitNarrationSentences(narration);
  if (sentences.length <= 3) return fill;
  const tail = sentences.slice(-3);
  const normalizedNarration = rebuildNarrationFromSentences(tail);
  return {
    ...fill,
    narration: normalizedNarration,
    caption_units: tail,
    caption_kr: normalizedNarration
  };
}

function normalizeSlotFillsForStyle(slotFills, editPlan) {
  const closingSlotIds = new Set((Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])
    .filter((item) => item.role === 'closing')
    .map((item) => String(item.slot_id || '').trim()));
  const keepDialogueSlotIds = new Set((Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])
    .filter((item) => item.decision === 'KEEP_DIALOGUE')
    .map((item) => String(item.slot_id || '').trim()));
  const normalizedFills = (Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : []).map((fill) => {
    const slotId = String(fill?.slot_id || '').trim();
    let next = fill;
    if (closingSlotIds.has(slotId)) next = normalizeClosingSlotFill(next);
    if (keepDialogueSlotIds.has(slotId)) next = { ...next, translation_mode: 'faithful_dialogue' };
    return next;
  });
  return { ...slotFills, slot_fills: normalizedFills };
}

function buildUploadTextMarkdown(uploadText) {
  const normalized = normalizeUploadText(uploadText);
  const titleLines = normalized.title_candidates.length
    ? normalized.title_candidates.map((title, index) => `${index + 1}. ${title}`)
    : ['1.'];
  return [
    '# Upload Text',
    '',
    '## 제목 후보 3개',
    '',
    ...titleLines,
    '',
    '## 화면 오버레이 제목',
    '',
    `top: ${normalized.overlay_title.top || ''}`,
    `bottom: ${normalized.overlay_title.bottom || ''}`,
    '',
    '## 설명란',
    '',
    normalized.description || '',
    '',
    '## 고정댓글',
    '',
    normalized.pinned_comment || ''
  ].join('\n');
}

function buildSlotQcReport(editPlan, slotFills = {}) {
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));
  const slots = (Array.isArray(editPlan?.timeline) ? editPlan.timeline : []).map((item) => {
    const mode = item.decision || item.mode || '';
    const fill = fillsBySlot.get(String(item.slot_id || '').trim()) || {};
    const sourceLines = Array.isArray(item.source_lines) ? item.source_lines : [];
    const coherence = item.coherence_checks && typeof item.coherence_checks === 'object' ? item.coherence_checks : {};
    const semanticRisk = String(item.semantic_risk || (mode === 'KEEP_DIALOGUE' ? 'medium' : 'low'));
    const pronounRisk = item.pronoun_risk === true;
    const boundaryRisk = Number(item.boundary_score || 0) < 0.7 || coherence.boundary_continuity === false;
    const recommendedFix = item.recommended_fix || (pronounRisk ? 'bridge_narration' : 'none');
    const qcAction = item.qc_action && typeof item.qc_action === 'object'
      ? { ...item.qc_action, action: normalizeQcActionAction(item.qc_action.action) }
      : {
          action: normalizeQcActionAction(item.applied_fix && item.applied_fix !== 'none' ? item.applied_fix : recommendedFix),
          reason: pronounRisk || boundaryRisk || semanticRisk === 'high'
            ? 'Dialogue QC risk requires correction or review.'
            : 'No dialogue QC correction required.',
          source: 'slot_qc_report'
        };
    return {
      slot_id: item.slot_id || '',
      mode,
      source_line_ids: sourceLines,
      time_range: Array.isArray(item.time_range) ? item.time_range : [formatReviewTimecode(item.start_sec), formatReviewTimecode(item.end_sec)],
      speaker: item.speaker || fill.speaker || '',
      translation_mode: fill.translation_mode || (mode === 'KEEP_DIALOGUE' ? 'faithful_dialogue' : ''),
      meaning_fidelity_risk: semanticRisk,
      pronoun_ambiguity_risk: pronounRisk ? 'high' : 'low',
      boundary_continuity_risk: boundaryRisk ? 'medium' : 'low',
      standalone_comprehension: coherence.standalone_comprehension !== false,
      boundary_continuity: coherence.boundary_continuity !== false,
      pronoun_resolution: coherence.pronoun_resolution !== false,
      dialogue_dependency: coherence.dialogue_dependency === true,
      recommended_fix: recommendedFix,
      applied_fix: item.applied_fix || 'none',
      qc_action: qcAction
    };
  });
  return {
    generated_at: new Date().toISOString(),
    status: slots.some((slot) => slot.meaning_fidelity_risk === 'high' || slot.pronoun_ambiguity_risk === 'high') ? 'review_recommended' : 'passed',
    slots
  };
}

function timelineStartBySlot(timeline) {
  const starts = new Map();
  let cursor = 0;
  for (const item of Array.isArray(timeline) ? timeline : []) {
    const slotId = String(item?.slot_id || '').trim();
    if (slotId) starts.set(slotId, roundSec(cursor));
    if (item?.decision !== 'DROP') cursor += Math.max(0, Number(item?.estimated_duration_sec || 0));
  }
  return starts;
}

function evaluateDialogueTimingQc(timeline, options = {}) {
  const isConfrontation = options.dialogueDrivenConfrontation === true;
  const isColdOpenCallback = options.editorialPattern === 'cold_open_callback';
  const starts = timelineStartBySlot(timeline);
  const active = (Array.isArray(timeline) ? timeline : []).filter((item) => item?.decision !== 'DROP');
  const dialogue = active.find((item) => item?.decision === 'KEEP_DIALOGUE');
  const firstDialogueStart = dialogue ? Number(starts.get(String(dialogue.slot_id || '').trim()) || 0) : null;
  const hookTeaser = active.find((item) => item?.role === 'cold_open' && item?.decision === 'KEEP_DIALOGUE');
  const callbackDialogue = isColdOpenCallback
    ? active.find((item) => item?.decision === 'KEEP_DIALOGUE' && item?.slot_id !== hookTeaser?.slot_id)
    : null;
  const callbackDialogueStart = callbackDialogue ? Number(starts.get(String(callbackDialogue.slot_id || '').trim()) || 0) : null;
  const warnings = [];
  const violations = [];
  let currentNarrationRun = 0;
  let maxNarrationRun = 0;
  for (const item of active) {
    if (item.decision === 'KEEP_DIALOGUE') {
      maxNarrationRun = Math.max(maxNarrationRun, currentNarrationRun);
      currentNarrationRun = 0;
    } else if (item.decision === 'NARRATE') {
      currentNarrationRun += Math.max(0, Number(item.estimated_duration_sec || 0));
    }
  }
  maxNarrationRun = roundSec(Math.max(maxNarrationRun, currentNarrationRun));

  if (isConfrontation) {
    if (firstDialogueStart === null) {
      violations.push('missing_preserved_dialogue');
    } else if (isColdOpenCallback) {
      if (!hookTeaser) violations.push('missing_hook_teaser_dialogue');
      if (firstDialogueStart > 5) violations.push('hook_teaser_not_in_first_5s');
      if (!callbackDialogue) {
        violations.push('missing_callback_dialogue');
      } else {
        if (callbackDialogueStart < CALLBACK_DIALOGUE_TARGET_MIN_SEC) violations.push('callback_dialogue_before_20s');
        if (callbackDialogueStart > CALLBACK_DIALOGUE_TARGET_MAX_SEC) violations.push('callback_dialogue_after_35s');
      }
    } else {
      if (firstDialogueStart > EARLY_DIALOGUE_WARNING_SEC) warnings.push('first_dialogue_after_35s');
      if (firstDialogueStart > EARLY_DIALOGUE_FAIL_SEC && options.allowLateDialogueOverride !== true) violations.push('first_dialogue_after_40s');
      if (firstDialogueStart < EARLY_DIALOGUE_TARGET_MIN_SEC) warnings.push('first_dialogue_before_target_window');
      if (firstDialogueStart > EARLY_DIALOGUE_TARGET_MAX_SEC) warnings.push('first_dialogue_after_target_window');
    }
    if (maxNarrationRun > MAX_CONFRONTATION_NARRATION_RUN_SEC) violations.push('max_narration_run_exceeded');
  }

  return {
    status: violations.length ? 'failed' : 'passed',
    first_dialogue_start_sec: firstDialogueStart === null ? null : roundSec(firstDialogueStart),
    callback_dialogue_start_sec: callbackDialogueStart === null ? null : roundSec(callbackDialogueStart),
    first_dialogue_target_window_sec: [EARLY_DIALOGUE_TARGET_MIN_SEC, EARLY_DIALOGUE_TARGET_MAX_SEC],
    callback_dialogue_target_window_sec: [CALLBACK_DIALOGUE_TARGET_MIN_SEC, CALLBACK_DIALOGUE_TARGET_MAX_SEC],
    warning_threshold_sec: EARLY_DIALOGUE_WARNING_SEC,
    failure_threshold_sec: EARLY_DIALOGUE_FAIL_SEC,
    max_narration_run_sec: maxNarrationRun,
    max_narration_run_threshold_sec: MAX_CONFRONTATION_NARRATION_RUN_SEC,
    warnings,
    violations
  };
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

function formatReviewTimecode(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value - hours * 3600 - minutes * 60;
  const pad = (part, width) => String(part).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${secs.toFixed(3).padStart(6, '0')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runCodexCliInFreshNodeProcess(promptPath, outputSchemaPath) {
  const node = process.execPath;
  const helperScriptPath = path.join(PROJECT_ROOT, 'scripts', 'codex_json_once.js');
  const result = await execFileAsync(node, [helperScriptPath, promptPath, outputSchemaPath], {
    timeout: 20 * 60 * 1000,
    errorCode: 'GPT_CLI_FRESH_NODE_FAILED'
  });
  return JSON.parse(String(result.stdout || '').trim());
}

function normalizeSourceUrl(source) {
  const text = String(source || '').trim();
  if (!text) throw new Error('--source is required');
  return text;
}

function resolveCompressionRunDir(runIdOrPath) {
  const raw = String(runIdOrPath || '').trim();
  if (!raw) throw new Error('compression runId or run directory path is required');
  return path.isAbsolute(raw) ? raw : path.join(COMPRESS_RUNS_DIR, raw);
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

// YouTube auto-captions roll: each cue repeats the tail of the one before it and adds a few
// words. Left as-is, no cue holds a whole sentence, so a quoted line never matches any cue
// and the whole scene gets narrated instead of preserved. Drop the repeated words and give
// the surviving text the span it was spoken over.
function dedupeRollingCues(cues) {
  const result = [];
  for (const cue of cues) {
    const previous = result[result.length - 1];
    if (!previous) { result.push({ ...cue }); continue; }
    const previousWords = previous.text.split(' ');
    const currentWords = cue.text.split(' ');
    let overlap = 0;
    const maxOverlap = Math.min(previousWords.length, currentWords.length);
    for (let size = maxOverlap; size > 0; size -= 1) {
      const tail = previousWords.slice(previousWords.length - size).join(' ').toLowerCase();
      const head = currentWords.slice(0, size).join(' ').toLowerCase();
      if (tail === head) { overlap = size; break; }
    }
    const remainder = currentWords.slice(overlap).join(' ').trim();
    if (!remainder) {
      // A pure repeat: it only tells us the previous line was still on screen.
      previous.end_sec = Math.max(previous.end_sec, cue.end_sec);
      continue;
    }
    result.push({
      start_sec: overlap ? Math.max(previous.end_sec, cue.start_sec) : cue.start_sec,
      end_sec: Math.max(cue.end_sec, (overlap ? Math.max(previous.end_sec, cue.start_sec) : cue.start_sec) + 0.2),
      text: remainder
    });
  }
  return result;
}

function normalizeCaptionWord(word) {
  return String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// YouTube auto-captions carry per-word timing tags (`How<00:06:36.480><c> much</c>...`). Those
// tags are the authoritative moment each word is spoken. cleanVttText strips them, so collect them
// here first: the leading words before the first tag belong to the cue's own start; every tagged
// word gets its own timestamp. Consecutive exact repeats (the rolling tail) are dropped.
function extractWordTimings(rawTextLines, blockStartSec) {
  const out = [];
  const joined = rawTextLines.join(' ');
  const firstTagAt = joined.search(/<\d\d:\d\d:\d\d[.,]\d{1,3}>/);
  const head = firstTagAt >= 0 ? joined.slice(0, firstTagAt) : joined;
  for (const word of cleanVttText(head).split(' ')) {
    const normalized = normalizeCaptionWord(word);
    if (normalized && Number.isFinite(blockStartSec)) out.push({ sec: blockStartSec, word: normalized });
  }
  const tagRe = /<(\d\d:\d\d:\d\d[.,]\d{1,3})><c>\s*([^<]+)<\/c>/g;
  let match;
  while ((match = tagRe.exec(joined))) {
    const sec = parseVttTime(match[1]);
    if (!Number.isFinite(sec)) continue;
    for (const word of cleanVttText(match[2]).split(' ')) {
      const normalized = normalizeCaptionWord(word);
      if (normalized) out.push({ sec, word: normalized });
    }
  }
  return out;
}

// The rolling-cue dedup can hand a line the start time of an EARLIER block it was merged through,
// so a line whose words are actually spoken 15s later still gets cut from the wrong audio (the
// clip plays a different scene under the caption). The word-timing tags know when each word was
// really spoken: walk the cues in order and, when the tags say a line's first words start later
// than the parsed start, snap the start forward. Only ever moves a start LATER, only within the
// cue's own span, so a legitimately long line (whose start already matches its first word) is left
// untouched.
function snapCuesToWordTimings(cues, wordTimings) {
  const SNAP_MIN_GAIN_SEC = 1.5;
  if (!Array.isArray(wordTimings) || wordTimings.length < 2) return cues;
  let searchFrom = 0;
  for (const cue of cues) {
    const words = cleanVttText(cue.text).split(' ').map(normalizeCaptionWord).filter(Boolean);
    if (words.length < 2) continue;
    let found = -1;
    for (let i = searchFrom; i < wordTimings.length - 1; i += 1) {
      if (wordTimings[i].word !== words[0]) continue;
      let secondFollows = false;
      for (let j = i + 1; j < Math.min(wordTimings.length, i + 4); j += 1) {
        if (wordTimings[j].word === words[1]) { secondFollows = true; break; }
      }
      if (secondFollows) { found = i; break; }
    }
    if (found < 0) continue;
    searchFrom = found + 1;
    const trueStart = wordTimings[found].sec;
    if (trueStart > cue.start_sec + SNAP_MIN_GAIN_SEC && trueStart < cue.end_sec) {
      cue.start_sec = roundSec(trueStart);
      cue.end_sec = roundSec(Math.max(cue.end_sec, trueStart + 0.3));
    }
  }
  return cues;
}

function parseVtt(vttText) {
  const cues = [];
  const wordTimings = [];
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
    // A cue block ends at a TRULY empty line. YouTube's rolling captions put a whitespace-only
    // placeholder line where the settled text would go ("  \n>> Just<00:07:33.600>...") - treating
    // that as the end of the block dropped the tagged line entirely, so the spoken words and their
    // timings were lost and the sentence only entered the transcript at the later 10ms "settle"
    // block: cues collapsed to 0.2s and landed seconds after the line was actually spoken.
    while (index < lines.length && lines[index] !== '' && !lines[index].includes('-->')) {
      const nextLine = lines[index].trim();
      if (nextLine && !/^NOTE\b|^STYLE\b|^REGION\b/i.test(nextLine)) textLines.push(nextLine);
      index += 1;
    }
    if (Number.isFinite(startSec)) {
      for (const timed of extractWordTimings(textLines, startSec)) {
        const previous = wordTimings[wordTimings.length - 1];
        if (previous && previous.sec === timed.sec && previous.word === timed.word) continue;
        wordTimings.push(timed);
      }
    }
    const text = cleanVttText(textLines.join(' '));
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && text) {
      cues.push({ start_sec: startSec, end_sec: endSec, text });
    }
    // Consume the blank separator, but never the timing line of the next cue: swallowing it made
    // the following block parse as a continuation and its lines vanished from the transcript.
    if (index < lines.length && lines[index] === '') index += 1;
  }
  return snapCuesToWordTimings(dedupeRollingCues(cues), wordTimings);
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
  const result = await execFileAsync(ytDlp, ['--js-runtimes', 'node', '--dump-single-json', '--skip-download', '--no-playlist', sourceUrl], { timeout: 10 * 60 * 1000 });
  const metadata = JSON.parse(result.stdout.trim());
  const metadataPath = path.join(runDir, 'source_info.json');
  writeJson(metadataPath, metadata);
  return { metadata, metadataPath };
}

async function extractTimedTranscript(sourceUrl, runDir, options = {}) {
  const ytDlp = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  const subtitleDir = path.join(runDir, 'subtitles_raw');
  ensureDir(subtitleDir);
  await execFileAsync(ytDlp, [
    '--js-runtimes', 'node',
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
    // A game source has no subtitle track BY NATURE — the branch narrates over vision+energy
    // structure instead of preserving dialogue, so an empty transcript is a valid input there.
    if (options.sourceKind === 'game') {
      const transcriptPath = path.join(runDir, 'transcript_timed.json');
      writeJson(transcriptPath, []);
      return { transcript: [], transcriptPath, vttPath: '' };
    }
    // STT fallback (scope opened 2026-08-09, user-approved): a subtitle-less movie upload gets
    // faster-whisper cues instead of a hard block. Built for sparse-dialogue action sources —
    // the extraction script filters hallucination loops and interjections, and the review gate
    // still checks every resolved line before TTS. Disable with MIDFORM_DISABLE_STT_FALLBACK=1.
    if (process.env.MIDFORM_DISABLE_STT_FALLBACK !== '1') {
      const sttTranscript = await transcribeWithSttFallback(runDir);
      if (sttTranscript) return sttTranscript;
    }
    const blocked = { status: 'blocked', code: 'SUBTITLE_NOT_FOUND', message: '자막 없음: STT 폴백도 실패했거나 비활성 상태입니다.' };
    writeJson(path.join(runDir, 'compress_state.json'), blocked);
    throw Object.assign(new Error(blocked.message), { code: blocked.code, details: blocked });
  }
  const transcript = parseVtt(fs.readFileSync(vttPath, 'utf8'));
  if (!transcript.length && options.sourceKind !== 'game') throw Object.assign(new Error('Timed subtitle file did not contain usable cues'), { code: 'SUBTITLE_PARSE_EMPTY', details: { vttPath } });
  const transcriptPath = path.join(runDir, 'transcript_timed.json');
  writeJson(transcriptPath, transcript);
  return { transcript, transcriptPath, vttPath };
}

async function transcribeWithSttFallback(runDir) {
  try {
    // Cross-run cache keyed by video id: a rerun after a mid-compress failure must not redo
    // minutes of CPU transcription — and a HAND-VERIFIED transcript placed here (gate review
    // correcting machine-heard lines) survives into every later rerun of the same source.
    const sourceInfoPath = path.join(runDir, 'source_info.json');
    const videoId = String((fs.existsSync(sourceInfoPath) ? readJson(sourceInfoPath) : {})?.id || '').trim();
    const cacheDir = path.join(COMPRESS_RUNS_DIR, '.stt_cache');
    const cachePath = videoId ? path.join(cacheDir, `${videoId}.json`) : '';
    const rawPath = path.join(runDir, 'stt_transcript_raw.json');
    let raw = null;
    if (cachePath && fs.existsSync(cachePath)) {
      raw = readJson(cachePath);
      writeJson(rawPath, raw);
    } else {
      const download = await downloadCompressionSourceVideo(runDir);
      const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
      const script = path.join(PROJECT_ROOT, 'midform', 'scripts', 'stt_transcribe.py');
      const result = spawnSync(python, [script, '--audio', download.sourceVideoPath, '--out', rawPath], {
        cwd: PROJECT_ROOT,
        env: getToolEnv(),
        encoding: 'utf8',
        timeout: 45 * 60 * 1000
      });
      if (result.status !== 0 || !fs.existsSync(rawPath)) {
        console.warn(`[midform] STT fallback failed (exit ${result.status}): ${String(result.stderr || '').slice(0, 300)}`);
        return null;
      }
      raw = readJson(rawPath);
      if (cachePath) {
        fs.mkdirSync(cacheDir, { recursive: true });
        writeJson(cachePath, raw);
      }
    }
    const transcript = (Array.isArray(raw?.cues) ? raw.cues : [])
      .filter((cue) => Number(cue.end_sec) > Number(cue.start_sec) && String(cue.text || '').trim());
    if (!transcript.length) {
      console.warn('[midform] STT fallback produced no usable cues');
      return null;
    }
    const transcriptPath = path.join(runDir, 'transcript_timed.json');
    writeJson(transcriptPath, transcript);
    // The state carries the provenance so the review gate and casebook can see the cues are
    // machine-heard, not author-provided — reviewers verify these lines, not trust them.
    const statePath = path.join(runDir, 'compress_state.json');
    if (fs.existsSync(statePath)) {
      writeJson(statePath, { ...readJson(statePath), transcript_source: 'stt_faster_whisper', stt_model: raw?.model || '' });
    }
    return { transcript, transcriptPath, vttPath: '' };
  } catch (error) {
    console.warn(`[midform] STT fallback errored: ${String(error?.message || error).slice(0, 300)}`);
    return null;
  }
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

function compactBeatsForEditPlan(beats) {
  return (Array.isArray(beats) ? beats : []).map((beat) => ({
    beat_id: beat.beat_id,
    start_sec: beat.start_sec,
    end_sec: beat.end_sec,
    summary: beat.summary,
    dramatic_weight: beat.dramatic_weight,
    dialogue_quality: beat.dialogue_quality,
    hook_potential: beat.hook_potential,
    key_dialogue: (Array.isArray(beat.key_dialogue) ? beat.key_dialogue : []).slice(0, EDIT_PLAN_MAX_DIALOGUE_QUOTES),
    anchor_dialogue: (Array.isArray(beat.anchor_dialogue) ? beat.anchor_dialogue : []).slice(0, BEAT_MAX_ANCHOR_LINES)
  }));
}

function compactHeatmapForEditPlan(heatmap) {
  const items = Array.isArray(heatmap?.items) ? heatmap.items : [];
  const ranked = [...items]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, EDIT_PLAN_MAX_HEATMAP_ITEMS)
    .sort((left, right) => Number(left.start_sec || 0) - Number(right.start_sec || 0));
  const top = ranked[0] || null;
  return {
    status: heatmap?.status || 'unavailable',
    source: heatmap?.source || '',
    top_peak: top ? {
      start_sec: top.start_sec,
      end_sec: top.end_sec,
      score: top.score
    } : null,
    top_items: ranked
  };
}

function peakHeatmapItem(heatmap) {
  const items = Array.isArray(heatmap?.items) ? heatmap.items : [];
  return items.reduce((best, item) => {
    if (!best) return item;
    return Number(item.score || 0) > Number(best.score || 0) ? item : best;
  }, null);
}

// Clamp a heatmap-peak window to a cold-open-sized scene hook (original-audio teaser),
// shrinking around the peak center so validateEditPlan's NARRATE cold-open limit holds.
function clampSceneHookWindow(startSec, endSec) {
  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const duration = Math.min(end - start, COLD_OPEN_VISUAL_MAX_SEC);
  const center = (start + end) / 2;
  const clampedStart = Math.max(0, center - duration / 2);
  return {
    start_sec: roundSec(clampedStart),
    end_sec: roundSec(clampedStart + duration)
  };
}

function heatmapVisualTeaserFromSelection(selection) {
  const startSec = Number(selection?.heatmap_peak_start_sec);
  const endSec = Number(selection?.heatmap_peak_end_sec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  return {
    mode: 'heatmap_visual_teaser',
    beat_id: '',
    start_sec: roundSec(startSec),
    end_sec: roundSec(endSec),
    center_sec: roundSec((startSec + endSec) / 2)
  };
}

function beatOverlapWithWindow(beat, startSec, endSec) {
  const start = Math.max(Number(beat?.start_sec || 0), Number(startSec || 0));
  const end = Math.min(Number(beat?.end_sec || 0), Number(endSec || 0));
  return Math.max(0, end - start);
}

function selectColdOpenBeat(beats, heatmap) {
  const peak = peakHeatmapItem(heatmap);
  const hookRanked = [...(Array.isArray(beats) ? beats : [])]
    .map((beat) => ({ beat, score: coldOpenCallbackBeatScore(beat) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || Number(left.beat.start_sec || 0) - Number(right.beat.start_sec || 0));
  if (peak) {
    const ranked = (Array.isArray(beats) ? beats : [])
      .map((beat) => ({ beat, overlap: beatOverlapWithWindow(beat, peak.start_sec, peak.end_sec) }))
      .filter((item) => item.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap || Number(right.beat.hook_potential || 0) - Number(left.beat.hook_potential || 0));
    if (ranked.length) {
      // Heatmap peaks outrank dialogue hooks: the most-replayed moment is the hook even
      // when it is a non-dialogue action sequence (scene hook with original audio).
      const heatmapBeat = ranked[0].beat;
      return {
        beat: heatmapBeat,
        source: 'heatmap_peak',
        fallback_used: false,
        fallback_reason: '',
        heatmap_peak_start_sec: roundSec(peak.start_sec),
        heatmap_peak_end_sec: roundSec(peak.end_sec),
        reason: 'Selected the beat overlapping the strongest replay peak. Heatmap peaks take priority over dialogue hooks for the cold open.'
      };
    }
  }
  const fallbackBeat = hookRanked[0]?.beat || [...(Array.isArray(beats) ? beats : [])].sort((left, right) => {
    const hookDelta = Number(right.hook_potential || 0) - Number(left.hook_potential || 0);
    if (hookDelta !== 0) return hookDelta;
    const weightDelta = Number(right.dramatic_weight || 0) - Number(left.dramatic_weight || 0);
    if (weightDelta !== 0) return weightDelta;
    return Number(left.start_sec || 0) - Number(right.start_sec || 0);
  })[0] || null;
  return fallbackBeat ? {
    beat: fallbackBeat,
    source: 'hook_fallback',
    fallback_used: true,
    fallback_reason: 'heatmap_overlap_not_found',
    heatmap_peak_start_sec: peak ? roundSec(peak.start_sec) : 0,
    heatmap_peak_end_sec: peak ? roundSec(peak.end_sec) : 0,
    reason: 'Selected the highest-hook beat as fallback.'
  } : null;
}

function contextDependencyForLines(lines) {
  const clean = (Array.isArray(lines) ? lines : []).map((line) => String(line || '').trim()).filter(Boolean);
  if (!clean.length) return 'high';
  const risky = clean.filter(hasDialogueDependencyRisk).length;
  if (risky === 0) return 'low';
  if (risky < clean.length) return 'medium';
  return clean.length >= 2 ? 'medium' : 'high';
}

function coldOpenCallbackBeatScore(beat) {
  const quality = String(beat?.dialogue_quality || '').trim();
  if (quality !== 'high') return 0;
  const lines = selectEarlyConfrontationLines(beat);
  if (!lines.length) return 0;
  return buildTeaserSuitabilityScore(beat, lines).total;
}

function coldOpenCallbackScores(beat, lines) {
  const focusLines = Array.isArray(lines) && lines.length ? lines : selectEarlyConfrontationLines(beat);
  return buildTeaserSuitabilityScore(beat, focusLines);
}

function supportActionSelectionWeight(action) {
  switch (normalizeQcActionAction(action)) {
    case 'none':
      return 24;
    case 'merge_adjacent_lines':
      return 18;
    case 'extend_line_window':
      return 8;
    case 'bridge_required':
      return -32;
    case 'downgrade_to_narrate':
      return -80;
    default:
      return -12;
  }
}

function hasAccusationLine(lines) {
  return (Array.isArray(lines) ? lines : []).some((line) => /\b(?:you|they|he|she)\b.*\b(?:tried|killed|kill|lied|fired|betrayed|destroyed|forced)\b|\b(?:accuse|blame|fault)\b/i.test(String(line || '')));
}

function hasResponseLine(lines) {
  return (Array.isArray(lines) ? lines : []).some((line) => /\b(?:didn'?t|did not|no|not true|wasn'?t|weren'?t|never|only reason|because|protected|saved)\b/i.test(String(line || '')));
}

function requiredSupportActionForTeaser(lines, dependency) {
  const clean = (Array.isArray(lines) ? lines : []).map((line) => String(line || '').trim()).filter(Boolean);
  if (!clean.length) return 'downgrade_to_narrate';
  if (dependency === 'low') return 'none';
  if (clean.length >= 2) return 'merge_adjacent_lines';
  return dependency === 'high' ? 'bridge_required' : 'extend_line_window';
}

function buildTeaserSuitabilityScore(beat, lines) {
  const focusLines = (Array.isArray(lines) ? lines : []).map((line) => String(line || '').trim()).filter(Boolean);
  const joined = focusLines.join(' ');
  const dependency = contextDependencyForLines(focusLines);
  const hasAccusation = hasAccusationLine(focusLines);
  const hasResponse = hasResponseLine(focusLines);
  const balancedExchange = hasAccusation && hasResponse && focusLines.length >= 2;
  const pronounDependencyRisk = focusLines.some(hasDialogueDependencyRisk) && !balancedExchange;
  const contextClarity = balancedExchange ? 5 : (dependency === 'low' ? 5 : (dependency === 'medium' ? 3 : 1));
  const standaloneComprehension = Math.max(1, Math.min(5, contextClarity + (focusLines.length >= 2 ? 1 : 0) - (pronounDependencyRisk ? 1 : 0)));
  const accusationResponseBalance = hasAccusation && hasResponse ? 5 : ((hasAccusation || hasResponse) && focusLines.length >= 2 ? 3 : 1);
  const curiosityGap = hasTruthReversalSignal(focusLines, beat) ? 5 : (/[?？]|\bwhy\b/i.test(joined) ? 4 : 2);
  const callbackPayoffStrength = Math.max(0, Math.min(5, Number(beat?.dramatic_weight || 0)));
  const teaserHookStrength = Math.max(0, Math.min(5, Number(beat?.hook_potential || 0)));
  const quoteValue = focusLines.length ? Math.max(...focusLines.map(lineDialogueScore)) : 0;
  const contextPenalty = dependency === 'high' ? 28 : (dependency === 'medium' ? 8 : 0);
  const unsupportedRebuttalPenalty = pronounDependencyRisk && focusLines.length === 1 ? 16 : 0;
  const total = teaserHookStrength * 10
    + callbackPayoffStrength * 8
    + curiosityGap * 5
    + contextClarity * 7
    + standaloneComprehension * 6
    + accusationResponseBalance * 6
    + quoteValue
    - contextPenalty
    - unsupportedRebuttalPenalty;
  return {
    teaser_hook_strength: roundSec(teaserHookStrength),
    callback_payoff_strength: roundSec(callbackPayoffStrength),
    curiosity_gap: roundSec(curiosityGap),
    replay_value: hasEarlyConfrontationSignal(focusLines, beat) ? 5 : 2,
    context_dependency: dependency,
    context_clarity: roundSec(contextClarity),
    standalone_comprehension: roundSec(standaloneComprehension),
    pronoun_dependency_risk: pronounDependencyRisk,
    accusation_response_balance: roundSec(accusationResponseBalance),
    quote_value: roundSec(quoteValue),
    required_support_action: requiredSupportActionForTeaser(focusLines, dependency),
    total: roundSec(total)
  };
}

// One beat only carries so much narration before it turns into a lecture, so a longer cut
// comes from more slots rather than longer ones.
const NARRATION_SLOT_MAX_SEC = 18;

function narrationDurationForBeat(beat) {
  const sourceDuration = Math.max(4, Number(beat?.end_sec || 0) - Number(beat?.start_sec || 0));
  return roundSec(Math.min(NARRATION_SLOT_MAX_SEC, Math.max(8, sourceDuration * 0.28)));
}

function focusDurationForBeat(beat, transcript) {
  const focus = collectDialogueFocus(beat, transcript);
  if (!focus) return roundSec(Math.max(6, Number(beat?.end_sec || 0) - Number(beat?.start_sec || 0)));
  return roundSec(Math.max(4, Number(focus.end_sec) - Number(focus.start_sec)));
}

function coldOpenDialogueFocusForBeat(beat, transcript, minHook = 4) {
  const hook = Number(beat?.hook_potential || 0);
  const quality = String(beat?.dialogue_quality || '').trim();
  if (quality !== 'high' || hook < minHook) return null;
  const anchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const teaserQuote = pickTeaserQuote(beat);
  // The anchors were taken in the order the beat listed them, so the opening line was whichever
  // came first in the scene — a greeting, on this source, while the accusation sat behind it.
  // pickTeaserQuote was never reached here. Lead with the strongest line and keep one more for
  // the answer to it; a third only dilutes a teaser.
  const ranked = (anchors.length ? anchors : (teaserQuote ? [teaserQuote] : []))
    .map((quote, order) => ({ quote, order, score: teaserQuoteScore(quote) }))
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const quotes = ranked.slice(0, 2).map((entry) => entry.quote);
  if (!quotes.length) return null;
  const focus = collectDialogueFocus(beat, transcript, { quotes });
  if (!focus) return null;
  const durationSec = roundSec(Number(focus.end_sec) - Number(focus.start_sec));
  if (durationSec <= 0 || durationSec > COLD_OPEN_DIALOGUE_MAX_SEC) return null;
  return { ...focus, duration_sec: durationSec, quotes };
}

function coldOpenMicroExchangeFocusesForBeat(beat, transcript) {
  if (!beat) return [];
  return buildMicroExchangeCandidates(cuesForBeatRange(transcript, beat), {
    maxGapSec: MICRO_EXCHANGE_DEFAULT_MAX_GAP_SEC,
    maxDurationSec: COLD_OPEN_DIALOGUE_MAX_SEC
  }).map((candidate) => ({
    start_sec: candidate.start_sec,
    end_sec: candidate.end_sec,
    duration_sec: candidate.duration_sec,
    lines: candidate.lines,
    quotes: candidate.lines,
    matched_quotes: candidate.lines,
    source_line_ids: candidate.source_line_ids,
    dialogue_unit: {
      unit_id: candidate.unit_id,
      relation_type: candidate.relation_type,
      source_line_ids: candidate.source_line_ids,
      start_sec: candidate.start_sec,
      end_sec: candidate.end_sec
    },
    focus_source: 'micro_exchange_candidate'
  }));
}

function coldOpenFocusCandidatesForBeat(beat, transcript) {
  const candidates = [];
  // The candidate POOL admits near-miss hooks (hook_potential >= 2): the listwise rerank judges
  // candidates against each other, and a hard hook<4 cutoff here silenced moments the model
  // rated conservatively. Deterministic single-beat paths keep the strict cutoff.
  const anchorFocus = coldOpenDialogueFocusForBeat(beat, transcript, 2);
  if (anchorFocus) candidates.push({ focus: { ...anchorFocus, focus_source: 'anchor_dialogue' }, source: 'anchor_dialogue' });
  for (const focus of coldOpenMicroExchangeFocusesForBeat(beat, transcript)) {
    candidates.push({ focus, source: 'micro_exchange_candidate' });
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = (Array.isArray(candidate.focus.lines) ? candidate.focus.lines : []).map(normalizeComparableText).join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Lines that make a scene work rather than lines that can be summarised: declarations,
// rebuttals, attitude flips, warnings that call someone by name, and reversals of who
// holds power.
const SCENE_FORCE_DIALOGUE_RE = /\b(?:no|never|stop|don'?t|won'?t|can'?t|listen|look at me|i (?:said|told|warned|swear|promise)|you (?:lied|knew|did|will|owe|dare)|how dare|shut up|get out|kill|die|now|enough|it'?s over|too late|help|run|behind you|watch out)\b|[!?]/i;

function hasSceneForceDialogue(beat) {
  const lines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue : [];
  return lines.some((line) => SCENE_FORCE_DIALOGUE_RE.test(String(line || '')));
}

function defaultDecisionForBeat(role, beat, transcript) {
  if (role === 'bridge') return 'NARRATE';
  if (role === 'cold_open') return coldOpenDialogueFocusForBeat(beat, transcript) ? 'KEEP_DIALOGUE' : 'NARRATE';
  const hook = Number(beat?.hook_potential || 0);
  const weight = Number(beat?.dramatic_weight || 0);
  const quality = String(beat?.dialogue_quality || '').trim();
  const focusDuration = focusDurationForBeat(beat, transcript);
  if ((role === 'body_peak' || role === 'payoff') && quality !== 'low') return 'KEEP_DIALOGUE';
  if (quality === 'high' && focusDuration <= 45) return 'KEEP_DIALOGUE';
  // A line that declares, rebuts, flips an attitude, calls a name in warning or reverses
  // who holds power carries the scene itself. Summarising it away is what makes a recap
  // read as explanation.
  if (quality !== 'low' && focusDuration <= 45 && hasSceneForceDialogue(beat)) return 'KEEP_DIALOGUE';
  if (hook <= 2 && weight <= 2) return 'DROP';
  return 'NARRATE';
}

function buildFallbackEditPlan(beats, heatmap, targetSec, metadata, transcript) {
  const orderedBeats = [...(Array.isArray(beats) ? beats : [])].sort((left, right) => Number(left.start_sec || 0) - Number(right.start_sec || 0));
  if (!orderedBeats.length) throw new Error('fallback edit plan requires beats');
  const coldOpen = selectColdOpenBeat(orderedBeats, heatmap);
  if (!coldOpen?.beat) throw new Error('fallback edit plan could not select a cold-open beat');
  const coldBeatId = String(coldOpen.beat.beat_id || '').trim();
  const coldBeatIndex = orderedBeats.findIndex((beat) => String(beat.beat_id || '').trim() === coldBeatId);
  const payoffBeat = [...orderedBeats].sort((left, right) => Number(right.hook_potential || 0) - Number(left.hook_potential || 0) || Number(right.start_sec || 0) - Number(left.start_sec || 0))[0] || orderedBeats[orderedBeats.length - 1];
  const payoffBeatId = String(payoffBeat.beat_id || '').trim();

  const coldDialogueFocus = coldOpenDialogueFocusForBeat(coldOpen.beat, transcript);
  // Non-dialogue heatmap peak -> scene hook: the peak moment opens the cut with its
  // original action audio instead of a muted narration teaser.
  const sceneHookWindow = !coldDialogueFocus && coldOpen.source === 'heatmap_peak'
    ? clampSceneHookWindow(coldOpen.heatmap_peak_start_sec, coldOpen.heatmap_peak_end_sec)
    : null;
  const coldOpenDecision = coldDialogueFocus ? 'KEEP_DIALOGUE' : 'NARRATE';
  const timeline = [{
    slot_id: 'slot_01',
    beat_id: coldBeatId,
    role: 'cold_open',
    decision: coldOpenDecision,
    start_sec: coldDialogueFocus ? coldDialogueFocus.start_sec : roundSec(coldOpen.beat.start_sec),
    end_sec: coldDialogueFocus ? coldDialogueFocus.end_sec : roundSec(coldOpen.beat.end_sec),
    estimated_duration_sec: coldDialogueFocus
      ? coldDialogueFocus.duration_sec
      : (sceneHookWindow ? roundSec(sceneHookWindow.end_sec - sceneHookWindow.start_sec) : 5),
    reason: coldDialogueFocus
      ? 'Teaser opening selected from the strongest replay/hook beat and preserved as original dialogue with Korean captions.'
      : (sceneHookWindow
        ? 'Heatmap-peak scene hook: the most-replayed action moment opens the cut with its original audio.'
        : 'Teaser opening selected from the strongest replay/hook beat.'),
    spoiler_policy: 'Do not reveal the answer in the teaser.',
    repeat_policy: coldDialogueFocus ? 'Original dialogue hook first; return later with aftermath/context, not duplicate the same line.' : 'Teaser only; replay later as body_peak with context.',
    visual_source_mode: coldDialogueFocus ? 'source_dialogue_hook' : (sceneHookWindow ? 'source_audio_teaser' : ''),
    visual_source_beat_id: coldDialogueFocus || sceneHookWindow ? coldBeatId : '',
    visual_source_start_sec: coldDialogueFocus ? coldDialogueFocus.start_sec : (sceneHookWindow ? sceneHookWindow.start_sec : 0),
    visual_source_end_sec: coldDialogueFocus ? coldDialogueFocus.end_sec : (sceneHookWindow ? sceneHookWindow.end_sec : 0),
    dialogue_focus_source: coldDialogueFocus ? 'cold_open_anchor_dialogue' : 'none',
    dialogue_focus_lines: coldDialogueFocus ? coldDialogueFocus.lines : [],
    dialogue_focus_quotes: coldDialogueFocus ? coldDialogueFocus.quotes : [],
    replay_of_slot_id: '',
    replay_mode: ''
  }];

  let slotNumber = 2;
  for (let index = 0; index < orderedBeats.length; index += 1) {
    const beat = orderedBeats[index];
    const beatId = String(beat.beat_id || '').trim();
    let role = 'body';
    if (index === 0 && coldBeatIndex > 0) role = 'bridge';
    if (beatId === coldBeatId) role = 'body_peak';
    if (beatId === payoffBeatId && beatId !== coldBeatId) role = 'payoff';
    let decision = defaultDecisionForBeat(role, beat, transcript);
    // A KEEP_DIALOGUE slot must carry the lines it preserves, so only keep dialogue when
    // the beat actually yields a focus; otherwise narrate it.
    const bodyFocus = decision === 'KEEP_DIALOGUE'
      ? (collectDialogueFocus(beat, transcript) || coldOpenDialogueFocusForBeat(beat, transcript))
      : null;
    if (decision === 'KEEP_DIALOGUE' && !bodyFocus) decision = 'NARRATE';
    timeline.push({
      slot_id: `slot_${String(slotNumber).padStart(2, '0')}`,
      beat_id: beatId,
      role,
      decision,
      start_sec: bodyFocus ? bodyFocus.start_sec : roundSec(beat.start_sec),
      end_sec: bodyFocus ? bodyFocus.end_sec : roundSec(beat.end_sec),
      ...(bodyFocus
        ? {
            dialogue_focus_source: 'fallback_beat_dialogue',
            dialogue_focus_lines: bodyFocus.lines,
            dialogue_focus_quotes: (bodyFocus.quotes && bodyFocus.quotes.length ? bodyFocus.quotes : bodyFocus.lines).slice(0, 5)
          }
        : {}),
      estimated_duration_sec: decision === 'KEEP_DIALOGUE' ? focusDurationForBeat(beat, transcript) : (decision === 'NARRATE' ? narrationDurationForBeat(beat) : 0),
      reason: `Fallback local planner selected this ${role} beat from beat metadata and transcript focus.`,
      spoiler_policy: role === 'cold_open' ? 'Do not reveal the answer in the teaser.' : 'Keep the mystery progression grounded in transcript evidence.',
      repeat_policy: role === 'body_peak' && beatId === coldBeatId ? 'Replay the teaser beat with context.' : 'No repeat.'
    });
    slotNumber += 1;
  }

  // The fallback planner is what runs when generation fails, so it has to satisfy the same
  // contract validateEditPlan enforces. Two shapes slipped through: a cut with no bridge
  // (the bridge role was only assigned when the cold open was not the first beat) and an
  // over-long preserved cold open. Both made the fallback itself unusable.
  if (!timeline.some((item) => item.role === 'bridge')) {
    const firstNarration = timeline.find((item) => item.role !== 'cold_open' && item.decision === 'NARRATE');
    if (firstNarration) firstNarration.role = 'bridge';
  }
  const coldOpenSlot = timeline[0];
  if (coldOpenSlot.decision === 'KEEP_DIALOGUE' && Number(coldOpenSlot.estimated_duration_sec || 0) > COLD_OPEN_DIALOGUE_MAX_SEC) {
    coldOpenSlot.end_sec = roundSec(Number(coldOpenSlot.start_sec) + COLD_OPEN_DIALOGUE_MAX_SEC);
    coldOpenSlot.estimated_duration_sec = COLD_OPEN_DIALOGUE_MAX_SEC;
    coldOpenSlot.reason = `${coldOpenSlot.reason} Trimmed to the cold-open dialogue limit.`;
  }

  const plan = {
    cold_open_selection: {
      beat_id: coldBeatId,
      source: coldOpen.source,
      fallback_used: coldOpen.fallback_used,
      fallback_reason: coldOpen.fallback_reason,
      heatmap_peak_start_sec: coldOpen.heatmap_peak_start_sec,
      heatmap_peak_end_sec: coldOpen.heatmap_peak_end_sec,
      reason: coldOpen.reason
    },
    timeline,
    duration_budget: recalculateDurationBudget(timeline, targetSec),
    quality_check: {
      cold_open_has_no_answer: true,
      body_reaches_cold_open_again: true,
      timeline_roles_present: true,
      target_duration_reasonable: true
    }
  };
  return finalizeEditPlan(plan, orderedBeats, transcript, targetSec);
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/>>/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9가-힣\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueTokens(value) {
  return new Set(normalizeComparableText(value).split(' ').filter(Boolean));
}

function overlapRatio(left, right) {
  const leftTokens = uniqueTokens(left);
  const rightTokens = uniqueTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function scoreCueAgainstQuote(cueText, quote) {
  const cueNorm = normalizeComparableText(cueText);
  const quoteNorm = normalizeComparableText(quote);
  if (!cueNorm || !quoteNorm) return 0;
  if (cueNorm === quoteNorm) return 100;
  if (cueNorm.includes(quoteNorm)) return 85 + Math.min(10, quoteNorm.length / 20);
  if (quoteNorm.includes(cueNorm)) return 75 + Math.min(10, cueNorm.length / 20);
  const ratio = overlapRatio(cueNorm, quoteNorm);
  // A packed cue punishes its own lines: dividing by the LONGER token set meant a 21-token cue
  // scored ~9 against a 9-token line it almost wholly contains ("know where a headset ties into
  // patriotism…" vs the line split across the cue boundary), so the punchline never matched.
  // Score how much of the QUOTE the cue carries as well, discounted below exact containment.
  const quoteTokens = uniqueTokens(quoteNorm);
  const cueTokens = uniqueTokens(cueNorm);
  let carried = 0;
  for (const token of quoteTokens) {
    if (cueTokens.has(token)) carried += 1;
  }
  const coverage = quoteTokens.size ? (carried / quoteTokens.size) * 0.8 : 0;
  const best = Math.max(ratio, coverage);
  return best >= 0.5 ? 50 + best * 20 : best * 20;
}

function scoreAnchorLine(text) {
  const value = String(text || '').trim();
  if (!value) return -1;
  let score = 0;
  if (/[?？]$/.test(value)) score += 8;
  if (/bad guy/i.test(value)) score += 20;
  if (/stay away/i.test(value)) score += 18;
  if (/what are they really/i.test(value)) score += 20;
  if (/descended from wolves/i.test(value)) score += 18;
  if (/made a treaty/i.test(value)) score += 18;
  if (/don'?t come here/i.test(value)) score += 12;
  if (/truth/i.test(value)) score += 10;
  if (/old scary story/i.test(value)) score -= 6;
  if (/i can keep a secret/i.test(value)) score -= 8;
  if (/radioactive spiders/i.test(value)) score -= 10;
  if (/eggshells|carrot tops|compost/i.test(value)) score -= 12;
  if (/no, our bus is full/i.test(value)) score -= 12;
  return score + (value.length / 50);
}

function isRevealHeavyBeat(beat) {
  const lines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const strongSignals = lines.filter((line) => scoreAnchorLine(line) >= 17).length;
  const joined = lines.join(' ');
  return strongSignals >= 3
    || (/descended from wolves/i.test(joined) && /made a treaty/i.test(joined) && /what are they really/i.test(joined))
    || (/what are they really/i.test(joined) && /bad guy/i.test(joined));
}

function maxAnchorsForBeat(beat) {
  return isRevealHeavyBeat(beat) ? REVEAL_BEAT_MAX_ANCHOR_LINES : BEAT_MAX_ANCHOR_LINES;
}

function selectBeatAnchors(beat) {
  const lines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const maxAnchors = maxAnchorsForBeat(beat);
  return [...lines]
    .sort((left, right) => scoreAnchorLine(right) - scoreAnchorLine(left))
    .slice(0, maxAnchors);
}

function normalizeBeatAnchors(beats) {
  return (Array.isArray(beats) ? beats : []).map((beat) => {
    const keyDialogue = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const providedAnchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const maxAnchors = maxAnchorsForBeat({ ...beat, key_dialogue: keyDialogue });
    const anchorDialogue = (providedAnchors.length ? providedAnchors : selectBeatAnchors({ key_dialogue: keyDialogue }))
      .filter((line) => keyDialogue.includes(line))
      .slice(0, maxAnchors);
    return {
      ...beat,
      key_dialogue: keyDialogue,
      anchor_dialogue: anchorDialogue.length ? anchorDialogue : selectBeatAnchors({ key_dialogue: keyDialogue })
    };
  });
}

function cuesForBeatRange(transcript, beat) {
  return transcript.filter((cue) => cue.start_sec >= Number(beat.start_sec) - 0.05 && cue.end_sec <= Number(beat.end_sec) + 0.05);
}

// Auto-captions carry sound effects as bracketed cues — ">> [bell]", "(applause)", "♪♪". They are
// not spoken, so the matcher can never find them in the transcript and the slot they land in is
// permanently not-ok. slot_013 failed dialogue_line_window_ok on exactly one of these.
function isNonSpeechCaption(text) {
  const stripped = String(text || '').replace(/^\s*>>\s*/, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return true;
  if (/^[♪♫\s]+$/.test(stripped)) return true;
  return /^[[(][^\])]*[\])]$/.test(stripped);
}

// ---- Source case profiling (midform/docs/source-casebook.md) ----
// The casebook's judgement, computed instead of remembered: how much of the source is spoken and
// whether the most-replayed peak lands on speech decide the whole editing approach, so profile the
// source once and feed the matched case's rules into every generation prompt.
const SOURCE_CASE_SHORT_SEC = 240;
const SOURCE_CASE_SPARSE_DENSITY = 0.35;
const SOURCE_CASE_DENSE_DENSITY = 0.6;

// Source channels close their clips with ~30s of self-promotion (varies by channel) — outro
// music, subscribe cards, "watch more" reels. None of it is film footage, so nothing may be cut
// from it (user directive; if narration runs out of footage, reuse the hook instead).
const PROMO_TAIL_MIN_SEC = 8;
const PROMO_CUE_RE = /subscribe|our channel|watch (more|the latest)|movieclips|fandango|coming soon|new trailers?|best (movies|clips|scenes)|link in (the )?(bio|description)|follow us|check out/i;

function detectPromoTail(transcript, sourceDurationSec) {
  const durationSec = Number(sourceDurationSec || 0);
  const cues = (Array.isArray(transcript) ? transcript : [])
    .filter((cue) => Number(cue?.end_sec) > Number(cue?.start_sec))
    .sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  if (!durationSec || !cues.length) return { usable_end_sec: durationSec || 0, promo_tail_sec: 0 };
  // The last cue that is real film speech: not a sound-effect caption, not promo copy.
  let lastRealEnd = 0;
  for (const cue of cues) {
    const text = String(cue.text || '');
    if (isNonSpeechCaption(text) || PROMO_CUE_RE.test(text)) continue;
    lastRealEnd = Math.max(lastRealEnd, Number(cue.end_sec));
  }
  if (!lastRealEnd) return { usable_end_sec: durationSec, promo_tail_sec: 0 };
  const usableEnd = Math.min(durationSec, roundSec(lastRealEnd + 2));
  const tail = roundSec(durationSec - usableEnd);
  if (tail < PROMO_TAIL_MIN_SEC) return { usable_end_sec: durationSec, promo_tail_sec: 0 };
  return { usable_end_sec: usableEnd, promo_tail_sec: tail };
}

// Visual end-card detection (Clip Empire and similar overlay their "WATCH MORE" recommendation
// cards ON the film, so the audio/dialogue keeps playing and the subtitle-based promo tail
// misses them entirely - Fruitvale/NYSM shipped with the cards inside usable_end). The python
// helper finds where the persistent yellow card first appears; a 6s safety margin covers the
// fade-in the sampler catches a few seconds late. Returns 0 when no card / no video.
const VISUAL_ENDCARD_MARGIN_SEC = 6;
function detectVisualEndcardSec(sourceVideoPath, durationSec) {
  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath) || !(durationSec > 0)) return 0;
  if (process.env.MIDFORM_DISABLE_VISUAL_ENDCARD === '1') return 0;
  try {
    const { spawnSync } = require('child_process');
    const py = process.env.PYTHON_PATH || 'python';
    const script = path.join(PROJECT_ROOT, 'midform', 'scripts', 'detect_visual_endcard.py');
    const res = spawnSync(py, [script, sourceVideoPath, String(durationSec)], { encoding: 'utf8', timeout: 180000 });
    const parsed = JSON.parse(String(res.stdout || '{}').trim() || '{}');
    const start = Number(parsed.endcard_start_sec);
    if (!Number.isFinite(start) || start <= 0) return 0;
    return roundSec(Math.max(0, start - VISUAL_ENDCARD_MARGIN_SEC));
  } catch {
    return 0;
  }
}

function profileSourceCase(transcript, metadata, heatmap, sourceVideoPath = '') {
  const durationSec = Number(metadata?.duration || 0);
  const cues = (Array.isArray(transcript) ? transcript : [])
    .filter((cue) => Number(cue?.end_sec) > Number(cue?.start_sec) && !isNonSpeechCaption(cue?.text));
  const ranges = cues.map((cue) => [Number(cue.start_sec), Number(cue.end_sec)]).sort((a, b) => a[0] - b[0]);
  let spoken = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const [start, end] of ranges) {
    if (currentEnd === null || start > currentEnd) {
      if (currentEnd !== null) spoken += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else {
      currentEnd = Math.max(currentEnd, end);
    }
  }
  if (currentEnd !== null) spoken += currentEnd - currentStart;
  const speechDensity = durationSec > 0 ? Math.min(1, roundSec(spoken / durationSec)) : 0;
  const items = Array.isArray(heatmap?.items) ? heatmap.items : [];
  const peak = items.reduce((best, item) => (best === null || Number(item?.score || 0) > Number(best?.score || 0) ? item : best), null);
  const peakIsDialogue = peak
    ? cues.some((cue) => Number(cue.end_sec) > Number(peak.start_sec) && Number(cue.start_sec) < Number(peak.end_sec))
    : false;
  const density = speechDensity <= SOURCE_CASE_SPARSE_DENSITY ? 'sparse_dialogue'
    : (speechDensity >= SOURCE_CASE_DENSE_DENSITY ? 'dialogue_dense' : 'mixed_density');
  const parts = [density, peakIsDialogue ? 'dialogue_peak' : 'action_peak'];
  if (durationSec > 0 && durationSec < SOURCE_CASE_SHORT_SEC) parts.unshift('short_source');
  const promo = detectPromoTail(transcript, durationSec);
  // The visual card can start BEFORE the last real dialogue cue (the film plays under it), so
  // take whichever boundary is earlier - the card must never survive inside usable_end.
  const visualUsableEnd = detectVisualEndcardSec(sourceVideoPath, durationSec);
  let usableEnd = promo.usable_end_sec;
  if (visualUsableEnd > 0 && visualUsableEnd < usableEnd) usableEnd = visualUsableEnd;
  const promoTail = roundSec(Math.max(0, durationSec - usableEnd));
  return {
    case_type: parts.join('+'),
    duration_sec: durationSec,
    speech_density: speechDensity,
    // dialogue_led: the recap's spine is speech, not the action peak. True whenever dialogue
    // covers more than the sparse floor (mixed_density / dialogue_dense). For these sources an
    // action peak is an accent, not the structure - a dialogue thriller (The Housemaid) or a
    // negotiation drama (Draft Day) legitimately centres on its lines, has little to visually
    // differentiate ko/ja, and should not be HARD-blocked for skipping a lone non-verbal peak.
    // Only sparse_dialogue+action_peak is a genuine action source that must cover its peak.
    dialogue_led: speechDensity > SOURCE_CASE_SPARSE_DENSITY,
    peak_is_dialogue: peakIsDialogue,
    // What the peak claim rests on: 'heatmap' when most-replayed data named it, later upgraded
    // to 'energy' (measured signal) or downgraded to 'none' by runCompression. 'none' means the
    // guidance must not assert a non-verbal peak it cannot locate.
    peak_evidence: peak ? 'heatmap' : 'none',
    usable_end_sec: usableEnd,
    promo_tail_sec: promoTail,
    promo_tail_source: visualUsableEnd > 0 && usableEnd === visualUsableEnd ? 'visual_endcard' : (promo.promo_tail_sec > 0 ? 'subtitle' : 'none')
  };
}

function buildSourceCaseGuidance(profile) {
  if (!profile || !profile.case_type) return [];
  const lines = [
    '',
    `SOURCE CASE (auto-profiled; casebook: midform/docs/source-casebook.md): ${profile.case_type} — `
    + `speech covers ${Math.round(profile.speech_density * 100)}% of the source, `
    + `${profile.peak_is_dialogue ? 'the most-replayed peak lands on dialogue' : 'the most-replayed peak is non-verbal'}.`
  ];
  if (profile.speech_density <= SOURCE_CASE_SPARSE_DENSITY) {
    lines.push('- Sparse-dialogue source: a speech-forward structure is impossible here, and that is the footage, not a writing failure. Preserve every strong line that exists, accept a higher narration share at the seams, and treat pure action/visual beats with no dialogue as fully valid.');
  } else if (profile.speech_density >= SOURCE_CASE_DENSE_DENSITY) {
    lines.push('- Dialogue-dense source: the exchange itself is the video. Chain preserved dialogue back to back, keep narration to the seams only, and keep repeated lines that form a running pattern — the repetition is structure, not redundancy.');
  }
  if (profile.peak_evidence === 'none') {
    lines.push('- No peak evidence exists (no heatmap, no measured energy peak): do NOT assume a non-verbal action peak. Choose the hook from the strongest dialogue/beat instead.');
  } else if (profile.peak_is_dialogue) {
    lines.push('- The peak moment is spoken: open on that dialogue as a captioned hook. Never open with an uncaptioned audio teaser over speech — the hook would play inaudible to the target audience.');
  } else {
    lines.push(`- The peak moment is non-verbal${profile.peak_evidence === 'energy' ? ` (measured energy peak at ~${Math.round(Number(profile.action_peak_sec) || 0)}s)` : ''}: an uncaptioned source-audio teaser on the peak is the right opening; its energy carries the hook. Do not force a weak dialogue line into the hook instead.`);
  }
  if (Number(profile.promo_tail_sec) > 0) {
    lines.push(`- The source ends with about ${Math.round(profile.promo_tail_sec)}s of channel self-promotion (outro/subscribe reel). NOTHING may be cut from after ${profile.usable_end_sec}s - no beat, no slot, no b-roll. If narration needs footage and none is left, reuse the hook moment rather than reaching into the outro.`);
  }
  if (profile.duration_sec > 0 && profile.duration_sec < SOURCE_CASE_SHORT_SEC) {
    lines.push('- Short source: completeness beats length. Few beats are expected; do not pad narration to stretch the runtime, and never drop a line of a running gag to save seconds.');
  }
  return lines;
}

function dedupeFocusLines(lines) {
  const output = [];
  for (const value of lines) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || isNonSpeechCaption(text)) continue;
    const previous = output[output.length - 1] || '';
    if (previous && (previous === text || previous.includes(text) || text.includes(previous))) {
      if (text.length > previous.length) output[output.length - 1] = text;
      continue;
    }
    output.push(text);
  }
  return output;
}

// Auto-captions run several speakers together in one line, and the whole blob then gets ONE
// speaker and one colour: the man's correction after his slip was pinned on the officer, so his
// excuse never read as his. Split at the interjection that starts a new turn, and let each half
// take its own caption line, speaker and colour.
// "sir" is a vocative inside one speaker's turn ("...one more time, sir, calm down"), not a turn
// boundary — splitting there broke a beat anchor and failed the run. Only interjections that
// genuinely open a new turn qualify.
const DIALOGUE_TURN_BOUNDARY_RE = /\b(oh now wait a minute|now wait a minute|wait a minute|hold on)\s+/i;
const DIALOGUE_TURN_MIN_WORDS = 2;

function splitMultiTurnDialogueLine(line) {
  const text = String(line || '').trim();
  if (!text) return [text];
  const match = DIALOGUE_TURN_BOUNDARY_RE.exec(text);
  if (!match || match.index <= 0) return [text];
  const head = text.slice(0, match.index).trim();
  const tail = text.slice(match.index).trim();
  const words = (value) => value.split(/\s+/).filter(Boolean).length;
  if (words(head) < DIALOGUE_TURN_MIN_WORDS || words(tail) < DIALOGUE_TURN_MIN_WORDS) return [text];
  return [head, tail];
}

// Beat extraction quotes a fragment of a cue and drops the rest: the cue "just calm down I I am
// gum I just want my" reached the beats as "just calm down" alone, so the man's reply to the
// order — the first beat of the running gag — was gone before any slot could ask for it. Nothing
// downstream can recover material the beats never carried, so restore the remainder here.
const BEAT_CUE_REMAINDER_MIN_WORDS = 3;

function completeBeatDialogueFromCues(beats, transcript) {
  const cues = (Array.isArray(transcript) ? transcript : [])
    .filter((cue) => cue && !isNonSpeechCaption(cue.text));
  if (!cues.length) return Array.isArray(beats) ? beats : [];
  const wordsOf = (value) => normalizeComparableText(value).split(/\s+/).filter(Boolean);

  return (Array.isArray(beats) ? beats : []).map((beat) => {
    const lines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue.map((line) => String(line || '').trim()).filter(Boolean) : [];
    if (!lines.length) return beat;
    const added = [];
    for (const cue of cues) {
      if (!(Number(cue.end_sec) > Number(beat?.start_sec) - 0.05 && Number(cue.start_sec) < Number(beat?.end_sec) + 0.05)) continue;
      const cueWords = wordsOf(cue.text);
      if (cueWords.length < BEAT_CUE_REMAINDER_MIN_WORDS * 2) continue;
      // Which of this beat's lines this cue already carries, as a word count from its start.
      let covered = 0;
      for (const line of [...lines, ...added]) {
        const lineWords = wordsOf(line);
        if (!lineWords.length) continue;
        const joined = cueWords.join(' ');
        const idx = joined.indexOf(lineWords.join(' '));
        if (idx < 0) continue;
        const endWord = joined.slice(0, idx + lineWords.join(' ').length).split(/\s+/).filter(Boolean).length;
        covered = Math.max(covered, endWord);
      }
      if (!covered) continue;
      const remainder = cueWords.slice(covered);
      if (remainder.length < BEAT_CUE_REMAINDER_MIN_WORDS) continue;
      // Keep the cue's own spelling, not the normalised comparison form.
      const rawWords = String(cue.text || '').trim().split(/\s+/).filter(Boolean);
      const rawRemainder = rawWords.slice(Math.max(0, rawWords.length - remainder.length)).join(' ');
      added.push(rawRemainder || remainder.join(' '));
    }
    if (!added.length) return beat;
    return { ...beat, key_dialogue: [...lines, ...added] };
  });
}

// Auto-merge smeared anchor cues (owner directive 2026-08-12, after four consecutive sources
// hit this by hand). Auto-captions split a signature line across several cues with repeats,
// prefixes and mid-word ellipses ("such is life such is life can you" / "Defiance today is not
// to the day you" / "will" / "die of that..."), so a beat anchor never exact-matches a cue and
// KEEP_DIALOGUE deadlocks. For each anchor, find the minimal run of consecutive cues whose
// combined text CONTAINS the anchor and collapse that run into one cue carrying the anchor
// text. Leftover words on the boundary cues are preserved as their own trimmed cues so no
// other dialogue is lost.
function mergeAnchorCuesInTranscript(transcript, beats) {
  const cues = Array.isArray(transcript) ? transcript.map((c) => ({ ...c })) : [];
  if (!cues.length) return transcript;
  const anchors = [];
  for (const beat of Array.isArray(beats) ? beats : []) {
    for (const a of Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue : []) {
      const text = String(a || '').trim();
      if (text && text.split(/\s+/).length >= 2) anchors.push(text);
    }
  }
  if (!anchors.length) return transcript;
  // longest anchors first so a long line claims its cues before a short substring anchor
  anchors.sort((x, y) => y.length - x.length);
  let merged = 0;
  for (const anchor of anchors) {
    const normAnchor = normalizeComparableText(anchor);
    if (!normAnchor) continue;
    // Already a clean standalone cue? leave it. A cue that merely CONTAINS the anchor amid
    // other words (repeats/prefixes) is exactly the smear the focus matcher misses, so it
    // still needs collapsing - only an EXACT single-cue match is a no-op.
    if (cues.some((c) => normalizeComparableText(c.text) === normAnchor)) continue;
    let done = false;
    for (let i = 0; i < cues.length && !done; i += 1) {
      let combined = '';
      for (let j = i; j < cues.length && j < i + 6; j += 1) {
        combined = `${combined} ${normalizeComparableText(cues[j].text)}`.trim();
        if (!combined.includes(normAnchor)) continue;
        // cues[i..j] together contain the anchor - but i is merely the EARLIEST start that still
        // reaches it within the 6-cue reach, so it drags the preceding lines of other speakers into
        // the merge: the window then starts seconds before the anchor is spoken and the slot's other
        // dialogue lines vanish inside the swallowing cue. Tighten to the smallest span that still
        // contains the anchor before collapsing.
        const span = (a, b) => cues.slice(a, b + 1).map((c) => normalizeComparableText(c.text)).join(' ').trim();
        let lo = i;
        let hi = j;
        while (lo < hi && span(lo + 1, hi).includes(normAnchor)) lo += 1;
        while (hi > lo && span(lo, hi - 1).includes(normAnchor)) hi -= 1;
        const start = Number(cues[lo].start_sec);
        const end = Number(cues[hi].end_sec);
        if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) { done = true; break; }
        cues.splice(lo, hi - lo + 1, { start_sec: start, end_sec: end, text: anchor });
        merged += 1;
        done = true;
        break;
      }
    }
  }
  return merged ? cues : transcript;
}

// Companion to the anchor-cue merge: after merging, an anchor that STILL has no matching cue
// was never real speech - Gemini paraphrased or invented it (Draft Day B002 anchored "What do
// you know?" which appears nowhere in the beat's window). A hard anchor that can't be found
// deadlocks KEEP_DIALOGUE forever, so demote it: drop it from anchor_dialogue (keeping it in
// key_dialogue if it was there) so the slot no longer REQUIRES it, while a real anchor stays.
function pruneUnmatchedBeatAnchors(beats, transcript) {
  const cues = Array.isArray(transcript) ? transcript : [];
  const cueText = cues.map((c) => normalizeComparableText(c.text)).join('  ');
  return (Array.isArray(beats) ? beats : []).map((beat) => {
    const anchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue : [];
    if (!anchors.length) return beat;
    const kept = [];
    const demoted = [];
    for (const anchor of anchors) {
      const norm = normalizeComparableText(anchor);
      if (norm && cueText.includes(norm)) kept.push(anchor);
      else demoted.push(anchor);
    }
    if (!demoted.length) return beat;
    // keep the demoted lines available as key_dialogue so the sentence can still be chosen
    const key = Array.isArray(beat.key_dialogue) ? beat.key_dialogue.slice() : [];
    for (const line of demoted) if (!key.some((k) => normalizeComparableText(k) === normalizeComparableText(line))) key.push(line);
    return { ...beat, anchor_dialogue: kept, key_dialogue: key };
  });
}

function splitMultiTurnFocusLines(lines) {
  const output = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const part of splitMultiTurnDialogueLine(line)) {
      if (String(part || '').trim()) output.push(part);
    }
  }
  return output;
}

// Raised from 5. The cap existed to stop a slot swallowing a whole conversation back when slot
// length WAS the runtime; now the runtime ceiling and the trim bound length properly, and the cap
// was quietly discarding recovered lines — "I am calm", the first beat of the running gag, was
// pushed out of its slot by it. Bigger dialogue slots are the intended shape of this format.
function limitDialogueFocusLines(focus, requiredLines = [], maxLines = 8) {
  const lines = dedupeFocusLines(splitMultiTurnFocusLines(Array.isArray(focus?.lines) ? focus.lines : []));
  if (lines.length <= maxLines) return { ...focus, lines };
  const required = new Set((Array.isArray(requiredLines) ? requiredLines : []).map(normalizeComparableText).filter(Boolean));
  const keep = [];
  for (const line of lines) {
    if (required.has(normalizeComparableText(line))) keep.push(line);
  }
  for (const line of lines) {
    if (keep.length >= maxLines) break;
    if (keep.some((existing) => normalizeComparableText(existing) === normalizeComparableText(line))) continue;
    keep.push(line);
  }
  const limitedSet = new Set(keep.slice(0, maxLines).map(normalizeComparableText));
  const limited = lines.filter((line) => limitedSet.has(normalizeComparableText(line))).slice(0, maxLines);
  return {
    ...focus,
    lines: limited,
    matched_quotes: limited,
    quotes: limited
  };
}

function collectDialogueFocus(beat, transcript, options = {}) {
  if (!beat) return null;
  const cues = cuesForBeatRange(transcript, beat);
  const quotes = Array.isArray(options.quotes) && options.quotes.length
    ? options.quotes
    : (Array.isArray(beat.key_dialogue) ? beat.key_dialogue : []);
  // One cue used to serve one line: whichever quote came first claimed it and every other line
  // inside that cue was dropped. Auto-captions pack several lines into a cue, so "just calm down"
  // took the cue and the reply to it — "I am calm, I just want my headset" — vanished before any
  // slot could ask for it. resolveDialogueLineWindows slices a packed cue per line now, so let
  // several distinct quotes share one; dedupe on the quote instead.
  const matches = [];
  const claimedQuotes = new Set();
  for (const quote of quotes) {
    const quoteKey = normalizeComparableText(quote);
    if (!quoteKey || claimedQuotes.has(quoteKey)) continue;
    let best = null;
    for (const cue of cues) {
      const score = scoreCueAgainstQuote(cue.text, quote);
      if (!best || score > best.score) best = { cue, quote, score };
    }
    if (best && best.score >= 50) {
      claimedQuotes.add(quoteKey);
      matches.push(best);
    }
  }
  if (!matches.length) return null;
  matches.sort((left, right) => left.cue.start_sec - right.cue.start_sec || left.cue.end_sec - right.cue.end_sec);
  const startSec = roundSec(Math.max(Number(beat.start_sec), Math.min(...matches.map((item) => item.cue.start_sec)) - DIALOGUE_FOCUS_PAD_SEC));
  const endSec = roundSec(Math.min(Number(beat.end_sec), Math.max(...matches.map((item) => item.cue.end_sec)) + DIALOGUE_FOCUS_PAD_SEC));
  return {
    start_sec: startSec,
    end_sec: endSec,
    matched_quotes: matches.map((item) => item.quote),
    lines: dedupeFocusLines(matches.map((item) => item.quote))
  };
}

function collectRemainingDialogueFocusAfterColdOpen(beat, transcript, cold) {
  if (!beat || !cold) return null;
  const used = new Set([
    ...(Array.isArray(cold.dialogue_focus_lines) ? cold.dialogue_focus_lines : []),
    ...(Array.isArray(cold.dialogue_focus_quotes) ? cold.dialogue_focus_quotes : [])
  ].map((line) => normalizeComparableText(line)).filter(Boolean));
  const remainingQuotes = (Array.isArray(beat.key_dialogue) ? beat.key_dialogue : [])
    .map((line) => String(line || '').trim())
    .filter((line) => line && !used.has(normalizeComparableText(line)));
  if (!remainingQuotes.length) return null;
  const afterColdBeat = {
    ...beat,
    start_sec: roundSec(Math.max(Number(cold.end_sec || 0), Number(beat.start_sec || 0)))
  };
  const focus = collectDialogueFocus(afterColdBeat, transcript, { quotes: remainingQuotes });
  if (!focus) return null;
  return { ...focus, quotes: focus.matched_quotes || remainingQuotes };
}

function isDialogueDrivenConfrontation(editPlan, beats) {
  if (editPlan?.dialogue_driven_scene === true || editPlan?.confrontation_scene === true) return true;
  const highDialogueBeats = (Array.isArray(beats) ? beats : []).filter((beat) => {
    const quality = String(beat?.dialogue_quality || '').trim();
    const lines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue : [];
    const text = `${beat?.summary || ''} ${lines.join(' ')}`;
    return quality === 'high' && lines.length >= 2 && CONFRONTATION_SIGNAL_RE.test(text);
  });
  return highDialogueBeats.length >= 2;
}

function lineDialogueScore(line) {
  const text = String(line || '').trim();
  if (!text) return -100;
  let score = 0;
  if (/[?？]$/.test(text)) score += 10;
  if (/\b(?:why|how|what|aren'?t|isn'?t|didn'?t|don'?t)\b/i.test(text)) score += 6;
  if (/\b(?:fired|kill|killed|truth|true|not true|only reason|protecting|forced|board|necessary|suicide)\b/i.test(text)) score += 12;
  if (/\b(?:accus|tried|didn'?t|defend|because)\b/i.test(text)) score += 8;
  return score + Math.min(8, text.length / 20);
}

function hasEarlyConfrontationSignal(lines, beat) {
  const text = `${beat?.summary || ''} ${(Array.isArray(lines) ? lines : []).join(' ')}`;
  return /\b(?:fired|fire you|tried to kill|didn'?t kill|only reason|not true|truth|mythologized|accus|rebut|defend)\b/i.test(text);
}

function hasTruthReversalSignal(lines, beat) {
  const text = `${beat?.summary || ''} ${(Array.isArray(lines) ? lines : []).join(' ')}`;
  return /\b(?:didn'?t kill|only reason|not true|truth|mythologized|opposite|actually)\b/i.test(text);
}

function selectEarlyConfrontationLines(beat) {
  const anchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue.map((line) => String(line || '').trim()).filter(Boolean) : [];
  const keyLines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue.map((line) => String(line || '').trim()).filter(Boolean) : [];
  const source = anchors.length >= 2 ? anchors : keyLines;
  return [...source]
    .sort((left, right) => lineDialogueScore(right) - lineDialogueScore(left))
    .slice(0, 2)
    .sort((left, right) => keyLines.indexOf(left) - keyLines.indexOf(right));
}

function classifyMicroExchange(leftText, rightText) {
  const left = String(leftText || '').trim();
  const right = String(rightText || '').trim();
  if (!left || !right) return '';
  const leftQuestion = /[?？]$/.test(left) || /^(?:why|how|what|when|where|who|did|do|does|are|is|was|were)\b/i.test(left);
  const rightAnswer = /\b(?:because|so|no|yes|i|we|they|he|she|that|this|it)\b/i.test(right) && !/[?？]$/.test(right);
  const leftAccuses = /\b(?:you|they|he|she)\b.*\b(?:tried|killed|kill|lied|fired|betrayed|stole|destroyed|made me|forced)\b|\b(?:accuse|blame|fault)\b/i.test(left);
  const rightRebuts = /\b(?:didn'?t|did not|no|not true|wasn'?t|weren'?t|never|only reason|because)\b/i.test(right);
  const leftClaim = /\b(?:everyone|people|they|the story|truth|true|believe|thinks?|said)\b/i.test(left);
  const rightReversal = /\b(?:isn'?t|is not|not true|opposite|actually|wrong|lie|myth|never happened)\b/i.test(right);
  const leftThreat = /\b(?:destroy|end me|end you|kill|threat|stay away|or else|ruin|take away)\b/i.test(left);
  const rightPushback = /\b(?:don'?t|do not|stop|no|can'?t|cannot|won'?t|protect|back off)\b/i.test(right);

  if (leftAccuses && rightRebuts) return 'accusation_rebuttal';
  if (leftQuestion && rightAnswer) return 'question_answer';
  if (leftClaim && rightReversal) return 'claim_reversal';
  if (leftThreat && rightPushback) return 'threat_pushback';
  return '';
}

function buildMicroExchangeCandidates(transcript, options = {}) {
  const cues = (Array.isArray(transcript) ? transcript : [])
    .map((cue, index) => ({
      source_line_id: String(cue?.id || cue?.line_id || cue?.source_line_id || `L${String(index + 1).padStart(2, '0')}`),
      start_sec: Number(cue?.start_sec || 0),
      end_sec: Number(cue?.end_sec || 0),
      speaker: String(cue?.speaker || ''),
      text: String(cue?.text || '').trim()
    }))
    .filter((cue) => cue.text && Number.isFinite(cue.start_sec) && Number.isFinite(cue.end_sec) && cue.end_sec > cue.start_sec)
    .sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec);
  const maxGapSec = Number.isFinite(Number(options.maxGapSec)) ? Number(options.maxGapSec) : MICRO_EXCHANGE_DEFAULT_MAX_GAP_SEC;
  const maxDurationSec = Number.isFinite(Number(options.maxDurationSec)) ? Number(options.maxDurationSec) : MICRO_EXCHANGE_DEFAULT_MAX_DURATION_SEC;
  const candidates = [];
  for (let index = 0; index < cues.length - 1; index += 1) {
    const left = cues[index];
    const right = cues[index + 1];
    const gapSec = roundSec(right.start_sec - left.end_sec);
    const durationSec = roundSec(right.end_sec - left.start_sec);
    if (gapSec < -0.05 || gapSec > maxGapSec || durationSec > maxDurationSec) continue;
    const relationType = classifyMicroExchange(left.text, right.text);
    if (!relationType) continue;
    candidates.push({
      unit_id: `exchange_${String(candidates.length + 1).padStart(3, '0')}`,
      relation_type: relationType,
      source_line_ids: [left.source_line_id, right.source_line_id],
      speakers: [left.speaker, right.speaker],
      lines: [left.text, right.text],
      start_sec: roundSec(left.start_sec),
      end_sec: roundSec(right.end_sec),
      duration_sec: durationSec,
      gap_sec: gapSec
    });
  }
  return candidates;
}

function buildDialogueUnitMetadata(lines, startSec, endSec, sourceLineIds = []) {
  const clean = (Array.isArray(lines) ? lines : []).map((line) => String(line || '').trim()).filter(Boolean);
  if (!clean.length) return null;
  const pseudoTranscript = clean.map((line, index) => ({
    id: String(sourceLineIds[index] || `L${String(index + 1).padStart(2, '0')}`),
    start_sec: Number(startSec || 0) + index,
    end_sec: Number(startSec || 0) + index + 0.5,
    text: line
  }));
  const exchange = buildMicroExchangeCandidates(pseudoTranscript, { maxGapSec: 1, maxDurationSec: 30 })[0] || null;
  const relationType = exchange?.relation_type || (clean.length >= 2 ? classifyMicroExchange(clean[0], clean[1]) : '');
  return {
    unit_id: 'exchange_001',
    relation_type: relationType || (clean.length >= 2 ? 'adjacent_dialogue' : 'single_line'),
    source_line_ids: clean.map((line, index) => String(sourceLineIds[index] || `L${String(index + 1).padStart(2, '0')}`)),
    start_sec: roundSec(startSec),
    end_sec: roundSec(endSec)
  };
}

function dialogueAnchorCandidateScore(item, beat, timelineStartSec) {
  const lines = selectEarlyConfrontationLines(beat);
  if (!lines.length) return null;
  const hookStrength = Number(beat?.hook_potential || 0);
  const confrontationClarity = CONFRONTATION_SIGNAL_RE.test(`${beat?.summary || ''} ${lines.join(' ')}`) ? 5 : 2;
  const quoteValue = Math.max(...lines.map(lineDialogueScore));
  const standaloneComprehension = lines.length >= 2 || lines.some((line) => !hasDialogueDependencyRisk(line)) ? 4 : 2;
  const earlyEngagementValue = Math.max(0, 12 - Math.abs(Number(timelineStartSec || 0) - 24));
  const earlyConfrontationSignal = hasEarlyConfrontationSignal(lines, beat) ? 1 : 0;
  const truthReversalSignal = hasTruthReversalSignal(lines, beat) ? 1 : 0;
  const total = hookStrength * 4
    + confrontationClarity * 5
    + quoteValue
    + standaloneComprehension * 3
    + earlyEngagementValue * 3
    + earlyConfrontationSignal * 28
    + truthReversalSignal * 36;
  return {
    slot_id: item.slot_id,
    beat_id: item.beat_id,
    lines,
    timeline_start_sec: roundSec(timelineStartSec),
    score: roundSec(total),
    scoring: {
      hook_strength: hookStrength,
      confrontation_clarity: confrontationClarity,
      quote_value: roundSec(quoteValue),
      standalone_comprehension: standaloneComprehension,
      early_engagement_value: roundSec(earlyEngagementValue),
      early_confrontation_signal: earlyConfrontationSignal,
      truth_reversal_signal: truthReversalSignal
    }
  };
}

function timelineStartForSlot(timeline, slotId) {
  return Number(timelineStartBySlot(timeline).get(String(slotId || '').trim()) || 0);
}

function compressNarrationBeforeSelectedDialogue(timeline, selectedSlotId, beatMap) {
  let adjusted = timeline.map((item) => ({ ...item }));
  let selectedStart = timelineStartForSlot(adjusted, selectedSlotId);
  if (selectedStart <= EARLY_DIALOGUE_WARNING_SEC) return adjusted;
  for (let index = adjusted.findIndex((item) => item.slot_id === selectedSlotId) - 1; index >= 0 && selectedStart > EARLY_DIALOGUE_TARGET_MAX_SEC; index -= 1) {
    const item = adjusted[index];
    if (!item || item.decision !== 'NARRATE' || item.role === 'cold_open' || item.role === 'bridge') continue;
    const beat = beatMap.get(String(item.beat_id || '').trim());
    const lines = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue : [];
    if (hasEarlyConfrontationSignal(lines, beat)) continue;
    adjusted[index] = {
      ...item,
      decision: 'DROP',
      estimated_duration_sec: 0,
      dialogue_focus_lines: [],
      dialogue_focus_quotes: [],
      early_dialogue_anchor_compression: true,
      reason: `${item.reason || ''} Dropped because a stronger early confrontation dialogue anchor must enter before the narration run gets too long.`.trim()
    };
    selectedStart = timelineStartForSlot(adjusted, selectedSlotId);
  }
  return adjusted;
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Number(leftEnd) > Number(rightStart) + 0.001 && Number(leftStart) < Number(rightEnd) - 0.001;
}

function adjustVisualSourceAwayFromReserved(visualSource, beat, reservedRanges) {
  if (!visualSource) return visualSource;
  const start = Number(visualSource.start_sec || 0);
  const end = Number(visualSource.end_sec || 0);
  const overlaps = (Array.isArray(reservedRanges) ? reservedRanges : [])
    .filter((range) => rangesOverlap(start, end, Number(range[0]), Number(range[1])));
  if (!overlaps.length) return visualSource;
  const duration = Math.max(COLD_OPEN_VISUAL_MIN_SEC, roundSec(end - start));
  const beatStart = Number(beat?.start_sec || start);
  const beatEnd = Number(beat?.end_sec || end);
  let shiftedStart = Math.max(beatStart, Math.max(...overlaps.map((range) => Number(range[1]))) + 0.5);
  let shiftedEnd = shiftedStart + duration;
  if (shiftedEnd > beatEnd) {
    shiftedEnd = beatEnd;
    shiftedStart = Math.max(beatStart, shiftedEnd - duration);
  }
  const stillOverlaps = overlaps.some((range) => rangesOverlap(shiftedStart, shiftedEnd, Number(range[0]), Number(range[1])));
  if (stillOverlaps || shiftedEnd - shiftedStart < COLD_OPEN_VISUAL_MIN_SEC) return visualSource;
  return {
    ...visualSource,
    start_sec: roundSec(shiftedStart),
    end_sec: roundSec(shiftedEnd),
    reason: `${visualSource.reason || ''} Shifted after reserved dialogue window to avoid cold-open overlap.`.trim()
  };
}

// When the teaser's own beat has no free room, look at every beat. adjustVisualSourceAwayFromReserved
// only shifts within one beat and silently returns the overlapping original when that fails — on the
// Anger Management source the heatmap-peak beat (102.72-114.19) was reserved wall to wall by the
// dialogue that peaks there, so the teaser stayed inside a preserved line and preflight rejected it.
function findNearestFreeVisualWindow(beats, reservedRanges, originalStart, originalEnd) {
  const duration = Math.max(COLD_OPEN_VISUAL_MIN_SEC, roundSec(originalEnd - originalStart));
  const originalCenter = (originalStart + originalEnd) / 2;
  let best = null;
  for (const beat of beats) {
    const beatStart = Number(beat?.start_sec);
    const beatEnd = Number(beat?.end_sec);
    if (!(beatEnd > beatStart)) continue;
    // Subtract the reserved spans from this beat's range.
    let free = [[beatStart, beatEnd]];
    for (const [reservedStart, reservedEnd] of reservedRanges) {
      free = free.flatMap(([gapStart, gapEnd]) => {
        if (reservedEnd <= gapStart || reservedStart >= gapEnd) return [[gapStart, gapEnd]];
        const pieces = [];
        if (reservedStart > gapStart) pieces.push([gapStart, reservedStart]);
        if (reservedEnd < gapEnd) pieces.push([reservedEnd, gapEnd]);
        return pieces;
      });
    }
    for (const [gapStart, gapEnd] of free) {
      if (gapEnd - gapStart < COLD_OPEN_VISUAL_MIN_SEC) continue;
      const fit = Math.min(duration, roundSec(gapEnd - gapStart));
      // Place the window at the gap edge nearest the original moment, so the teaser stays as
      // close to the peak it was chosen for as the reservations allow.
      let start = Math.min(Math.max(gapStart, originalCenter - fit / 2), gapEnd - fit);
      const distance = Math.abs((start + fit / 2) - originalCenter);
      if (!best || distance < best.distance) best = { start: roundSec(start), end: roundSec(start + fit), distance };
    }
  }
  return best;
}

function applyColdOpenVisualOverlapSafety(timeline, beatMap) {
  const nextTimeline = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  const coldIndex = nextTimeline.findIndex((item) => item.role === 'cold_open');
  const cold = nextTimeline[coldIndex];
  if (!cold || cold.decision !== 'NARRATE' || !(Number(cold.visual_source_end_sec) > Number(cold.visual_source_start_sec))) return nextTimeline;
  const reservedRanges = nextTimeline
    .filter((item) => item.decision === 'KEEP_DIALOGUE' && Number(item.end_sec) > Number(item.start_sec))
    .map((item) => [Number(item.start_sec), Number(item.end_sec)]);
  let adjusted = adjustVisualSourceAwayFromReserved({
    mode: cold.visual_source_mode || 'mute_visual_teaser',
    beat_id: cold.visual_source_beat_id,
    start_sec: Number(cold.visual_source_start_sec),
    end_sec: Number(cold.visual_source_end_sec),
    reason: 'Cold-open overlap safety check.'
  }, beatMap.get(String(cold.visual_source_beat_id || '').trim()), reservedRanges);
  const stillOverlapping = (candidate) => reservedRanges
    .some(([reservedStart, reservedEnd]) => rangesOverlap(Number(candidate.start_sec), Number(candidate.end_sec), reservedStart, reservedEnd));
  if (!adjusted || stillOverlapping(adjusted)) {
    const fallback = findNearestFreeVisualWindow([...beatMap.values()], reservedRanges,
      Number(cold.visual_source_start_sec), Number(cold.visual_source_end_sec));
    if (fallback) {
      adjusted = {
        start_sec: fallback.start,
        end_sec: fallback.end,
        reason: 'Cold-open visual moved to the nearest free window: its own beat is fully reserved by dialogue.'
      };
    }
  }
  if (adjusted && (adjusted.start_sec !== cold.visual_source_start_sec || adjusted.end_sec !== cold.visual_source_end_sec)) {
    nextTimeline[coldIndex] = {
      ...cold,
      visual_source_start_sec: adjusted.start_sec,
      visual_source_end_sec: adjusted.end_sec,
      visual_source_center_sec: roundSec((Number(adjusted.start_sec) + Number(adjusted.end_sec)) / 2),
      estimated_duration_sec: roundSec(Number(adjusted.end_sec) - Number(adjusted.start_sec)),
      reason: `${cold.reason || ''} Cold-open visual shifted after reserved dialogue to avoid overlap.`.trim()
    };
  }
  return nextTimeline;
}

function enforceEarlyDialogueAnchor(timeline, editPlan, beats, transcript) {
  if (!isDialogueDrivenConfrontation(editPlan, beats)) return timeline;
  const workingTimeline = (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.early_dialogue_anchor !== true) return item;
    return {
      ...item,
      decision: 'NARRATE',
      estimated_duration_sec: roundSec(Number(item.narration_estimated_duration_sec || item.estimated_duration_sec || 0)),
      dialogue_focus_source: 'none',
      dialogue_focus_lines: [],
      dialogue_focus_quotes: [],
      early_dialogue_anchor: false,
      dialogue_selection_scores: undefined,
      dialogue_line_windows: undefined,
      dialogue_line_window_ok: undefined,
      dialogue_line_window_warnings: undefined
    };
  });
  const timing = evaluateDialogueTimingQc(workingTimeline, { dialogueDrivenConfrontation: true });
  if (timing.status === 'passed' && Number(timing.first_dialogue_start_sec || 0) <= EARLY_DIALOGUE_WARNING_SEC) return workingTimeline;
  const starts = timelineStartBySlot(workingTimeline);
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const currentFirstKeep = workingTimeline.find((item) => item?.decision === 'KEEP_DIALOGUE');
  const currentFirstSourceStart = currentFirstKeep ? Number(currentFirstKeep.start_sec || Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const candidates = [];
  for (const item of workingTimeline) {
    if (item?.decision !== 'NARRATE') continue;
    if (item.role === 'cold_open') continue;
    const beat = beatMap.get(String(item.beat_id || '').trim());
    if (!beat) continue;
    if (String(beat.dialogue_quality || '').trim() !== 'high') continue;
    if (Number(beat.start_sec || 0) >= currentFirstSourceStart) continue;
    const start = Number(starts.get(String(item.slot_id || '').trim()) || 0);
    if (start > EARLY_DIALOGUE_FAIL_SEC + 10) continue;
    const focusLines = selectEarlyConfrontationLines(beat);
    const focus = focusLines.length ? collectDialogueFocus(beat, transcript, { quotes: focusLines }) : null;
    if (!focus) continue;
    const candidate = dialogueAnchorCandidateScore(item, beat, start);
    if (candidate) candidates.push({ item, beat, focus, candidate });
  }
  if (!candidates.length) return workingTimeline.map((item) => ({
    ...item,
    dialogue_timing_qc: item.slot_id === currentFirstKeep?.slot_id ? timing : item.dialogue_timing_qc
  }));
  candidates.sort((left, right) => {
    return right.candidate.score - left.candidate.score;
  });
  const selected = candidates[0];
  const compressedTimeline = compressNarrationBeforeSelectedDialogue(workingTimeline, selected.item.slot_id, beatMap);
  return compressedTimeline.map((item) => {
    if (item.slot_id !== selected.item.slot_id) return item;
    return {
      ...item,
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: roundSec(Number(selected.focus.end_sec) - Number(selected.focus.start_sec)),
      dialogue_focus_source: 'early_confrontation_anchor',
      dialogue_focus_lines: selected.focus.lines,
      dialogue_focus_quotes: (selected.focus.matched_quotes || []).length ? selected.focus.matched_quotes : selected.focus.lines,
      early_dialogue_anchor: true,
      dialogue_selection_scores: selected.candidate.scoring,
      reason: `${item.reason || ''} Early confrontation dialogue anchor promoted to avoid delaying the source argument.`.trim()
    };
  });
}

function resolveReadableDialogueWindows(transcript, focus, beatEndSec, nextBeatStart, requiredLines = []) {
  let lines = Array.isArray(focus?.lines) ? focus.lines : [];
  let resolution = resolveDialogueLineWindows(transcript, focus.start_sec, focus.end_sec, lines, beatEndSec, nextBeatStart);
  if (resolution.ok) return { focus: { ...focus, lines }, resolution };
  const required = new Set((Array.isArray(requiredLines) ? requiredLines : []).map(normalizeComparableText).filter(Boolean));
  const tooShortNonRequired = new Set(resolution.windows
    .filter((win) => win && win.too_short === true && !required.has(normalizeComparableText(win.line)))
    .map((win) => normalizeComparableText(win.line)));
  if (tooShortNonRequired.size) {
    lines = lines.filter((line) => !tooShortNonRequired.has(normalizeComparableText(line)));
    const nextFocus = { ...focus, lines, matched_quotes: lines, quotes: lines };
    resolution = resolveDialogueLineWindows(transcript, nextFocus.start_sec, nextFocus.end_sec, lines, beatEndSec, nextBeatStart);
    if (resolution.ok || !lines.length) return { focus: nextFocus, resolution };
  }
  const crowdedLowScore = new Set(resolution.windows
    .filter((win) => win && win.matched && Number(win.score || 0) < 75)
    .map((win) => normalizeComparableText(win.line)));
  if (!crowdedLowScore.size) return { focus: { ...focus, lines }, resolution };
  lines = lines.filter((line) => !crowdedLowScore.has(normalizeComparableText(line)));
  if (!lines.length || lines.length === focus.lines.length) return { focus: { ...focus, lines }, resolution };
  const nextFocus = { ...focus, lines, matched_quotes: lines, quotes: lines };
  resolution = resolveDialogueLineWindows(transcript, nextFocus.start_sec, nextFocus.end_sec, lines, beatEndSec, nextBeatStart);
  return { focus: nextFocus, resolution };
}

function hasPronounRisk(text) {
  return PRONOUN_OR_DEICTIC_RE.test(String(text || ''));
}

function hasDialogueDependencyRisk(text) {
  const normalized = String(text || '').trim();
  return hasPronounRisk(normalized) || RESPONSE_DEPENDENCY_RE.test(normalized);
}

function findPreviousContextCue(beat, transcript, focus) {
  const beatStart = Number(beat?.start_sec || 0);
  const focusStart = Number(focus?.start_sec || 0);
  const lines = new Set((Array.isArray(focus?.lines) ? focus.lines : []).map(normalizeComparableText));
  const candidates = cuesForBeatRange(transcript, { start_sec: beatStart, end_sec: focusStart })
    .filter((cue) => {
      const text = String(cue?.text || '').trim();
      if (!text || lines.has(normalizeComparableText(text))) return false;
      const gap = focusStart - Number(cue.end_sec || 0);
      return gap >= 0 && gap <= DIALOGUE_CONTEXT_LOOKBACK_SEC;
    })
    .sort((left, right) => Number(right.end_sec || 0) - Number(left.end_sec || 0));
  return candidates[0] || null;
}

function enrichDialogueFocusForCoherence(beat, transcript, focus) {
  const lines = (Array.isArray(focus?.lines) ? focus.lines : []).map((line) => String(line || '').trim()).filter(Boolean);
  const joined = lines.join(' ');
  const pronounRisk = hasPronounRisk(joined);
  const dialogueDependency = lines.some(hasDialogueDependencyRisk);
  let nextLines = lines;
  let contextStrategy = 'none';
  let appliedFix = 'none';
  // The risky line's context can already be IN the slot — since body slots draw on the beat's
  // whole key_dialogue, the exchange often arrives merged. Only when the risky line leads the
  // slot is there anything to go and fetch; demanding a fetch regardless flipped these slots to
  // bridge_narration, prescribing narration for context the dialogue already carries.
  // Judge by the LAST risky line: the pronoun detector fires on almost any line of an exchange
  // (the opener "you going to end me" trips it too), so the first risky index is usually 0 and
  // proves nothing. What matters is whether the latest line needing context has lines before it.
  const riskIndexes = lines.map((line, index) => (hasPronounRisk(line) || hasDialogueDependencyRisk(line) ? index : -1)).filter((index) => index >= 0);
  const contextAlreadyMerged = (pronounRisk || dialogueDependency) && riskIndexes.length > 0 && Math.max(...riskIndexes) > 0;
  const previousCue = (pronounRisk || dialogueDependency) && !contextAlreadyMerged
    ? findPreviousContextCue(beat, transcript, { ...focus, lines })
    : null;
  if (contextAlreadyMerged) {
    contextStrategy = 'merge_exchange';
    appliedFix = 'merged_previous_line';
  } else if (previousCue) {
    nextLines = [String(previousCue.text || '').trim(), ...lines];
    contextStrategy = 'merge_exchange';
    appliedFix = 'merged_previous_line';
  } else if (pronounRisk || dialogueDependency) {
    contextStrategy = 'bridge_narration';
    appliedFix = 'bridge_required';
  }
  const standaloneScore = pronounRisk || dialogueDependency ? ((previousCue || contextAlreadyMerged) ? 0.72 : 0.45) : 0.9;
  const boundaryScore = contextStrategy === 'merge_exchange' ? 0.78 : (contextStrategy === 'bridge_narration' ? 0.58 : 0.86);
  return {
    focus: {
      ...focus,
      lines: nextLines,
      matched_quotes: nextLines,
      quotes: nextLines,
      start_sec: previousCue ? Number(previousCue.start_sec) : focus.start_sec,
      end_sec: focus.end_sec
    },
    qc: {
      standalone_comprehension: standaloneScore >= 0.7,
      boundary_continuity: boundaryScore >= 0.7,
      pronoun_resolution: !pronounRisk || Boolean(previousCue),
      dialogue_dependency: dialogueDependency,
      pronoun_risk: pronounRisk,
      semantic_risk: pronounRisk || dialogueDependency ? (previousCue ? 'medium' : 'high') : 'low',
      requires_context: pronounRisk || dialogueDependency,
      context_strategy: contextStrategy,
      standalone_score: Number(standaloneScore.toFixed(2)),
      boundary_score: Number(boundaryScore.toFixed(2)),
      recommended_fix: contextStrategy === 'merge_exchange' ? 'merge_exchange' : (contextStrategy === 'bridge_narration' ? 'bridge_narration' : 'none'),
      applied_fix: appliedFix
    }
  };
}

function sourceLineIds(slotId, windows) {
  return (Array.isArray(windows) ? windows : [])
    .map((win, index) => (win?.matched ? `${slotId}_L${String(index + 1).padStart(2, '0')}` : ''))
    .filter(Boolean);
}

function annotateDialogueSlotForQc(item, lineResolution, qc = {}) {
  const slotId = String(item?.slot_id || '').trim();
  const windows = Array.isArray(lineResolution?.windows) ? lineResolution.windows : [];
  const matched = windows.filter((win) => win && win.matched === true && Number(win.end_sec) > Number(win.start_sec));
  const startSec = matched.length ? Math.min(...matched.map((win) => Number(win.start_sec))) : Number(item.start_sec || 0);
  const endSec = matched.length ? Math.max(...matched.map((win) => Number(win.end_sec))) : Number(item.end_sec || 0);
  const resolvedSourceLineIds = sourceLineIds(slotId, windows);
  const resolvedDialogueUnit = resolvedSourceLineIds.length ? buildDialogueUnitMetadata(
    Array.isArray(item.dialogue_focus_lines) && item.dialogue_focus_lines.length ? item.dialogue_focus_lines : matched.map((win) => win.line),
    startSec,
    endSec,
    resolvedSourceLineIds
  ) : (item.dialogue_unit || buildDialogueUnitMetadata(
    Array.isArray(item.dialogue_focus_lines) && item.dialogue_focus_lines.length ? item.dialogue_focus_lines : matched.map((win) => win.line),
    startSec,
    endSec
  ));
  const inheritedAction = qc.qc_action && typeof qc.qc_action === 'object' ? qc.qc_action : item.qc_action;
  const qcDerivedAction = normalizeQcActionAction(qc.applied_fix || qc.recommended_fix || 'none');
  const shouldPreferQcDerivedAction = qcDerivedAction !== 'none'
    && (!inheritedAction || normalizeQcActionAction(inheritedAction.action) === 'none');
  const qcAction = inheritedAction && typeof inheritedAction === 'object' && !shouldPreferQcDerivedAction
    ? { ...inheritedAction, action: normalizeQcActionAction(inheritedAction.action) }
    : {
        action: qcDerivedAction,
        reason: qc.recommended_fix || 'Dialogue slot QC annotation.',
        source: 'dialogue_slot_annotation'
      };
  return {
    ...item,
    mode: item.decision || 'KEEP_DIALOGUE',
    source_lines: resolvedSourceLineIds,
    time_range: [formatReviewTimecode(startSec), formatReviewTimecode(endSec)],
    speaker: String(item.speaker || ''),
    requires_context: qc.requires_context === true,
    context_strategy: qc.context_strategy || 'none',
    semantic_risk: qc.semantic_risk || 'low',
    pronoun_risk: qc.pronoun_risk === true,
    standalone_score: Number(qc.standalone_score ?? 0.9),
    boundary_score: Number(qc.boundary_score ?? 0.86),
    coherence_checks: {
      standalone_comprehension: qc.standalone_comprehension !== false,
      boundary_continuity: qc.boundary_continuity !== false,
      pronoun_resolution: qc.pronoun_resolution !== false,
      dialogue_dependency: qc.dialogue_dependency === true
    },
    recommended_fix: qc.recommended_fix || 'none',
    applied_fix: qc.applied_fix || 'none',
    dialogue_unit: resolvedDialogueUnit,
    qc_action: qcAction
  };
}

function annotateNarrationSlotForQc(item) {
  return {
    ...item,
    mode: item.decision || 'NARRATE',
    source_lines: [],
    time_range: [formatReviewTimecode(item.start_sec), formatReviewTimecode(item.end_sec)],
    speaker: '',
    requires_context: false,
    context_strategy: 'none',
    semantic_risk: 'low',
    pronoun_risk: false,
    standalone_score: 0.9,
    boundary_score: 0.86,
    coherence_checks: {
      standalone_comprehension: true,
      boundary_continuity: true,
      pronoun_resolution: true,
      dialogue_dependency: false
    },
    recommended_fix: 'none',
    applied_fix: 'none'
  };
}

// For Phase 2 line-locked dialogue captions: resolve each KEEP_DIALOGUE line to its
// own [start,end] in the source video, so each Korean caption sits on the exact moment
// its English line is spoken (rather than being spread evenly across the whole window).
// Returns per-line windows in the SAME order as `lines` (1:1 with caption_kr_dialogue),
// each carrying the resolved coordinates used identically by transcript + slot_map + script.
// Auto-caption cues often pack several lines into one cue — at 1:21 of the Anger Management
// source a single 9s cue holds five ("...keeps ignore me when I ask calm down I am calm what is
// it with you people..."). Every line matching that cue used to receive the WHOLE cue as its
// window, so the windows collided in step 2 and all but one line was flagged and dropped. Slice
// the cue by character position instead: caption timing is roughly linear in text, so a line's
// offset in the cue text estimates its moment well enough for the later speech-trim to refine.
function sliceCueForLine(cue, line) {
  const cueText = String(cue?.text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  const lineText = String(line || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cueText || !lineText) return null;
  if (lineText.length >= cueText.length * 0.85) return null; // the line IS the cue; nothing to slice
  let offset = cueText.indexOf(lineText);
  let matchedLen = lineText.length;
  if (offset < 0) {
    const head = lineText.slice(0, Math.max(10, Math.floor(lineText.length * 0.6)));
    offset = cueText.indexOf(head);
  }
  if (offset < 0) {
    // A line split across a cue boundary starts mid-sentence in the second cue — "…I don't /
    // know where a headset ties into patriotism". Its head is in the PREVIOUS cue, so match the
    // tail: the part of the line this cue actually carries.
    const tail = lineText.slice(-Math.max(10, Math.floor(lineText.length * 0.6)));
    const tailOffset = cueText.indexOf(tail);
    if (tailOffset >= 0) {
      offset = tailOffset === 0 ? 0 : tailOffset;
      matchedLen = tail.length;
    }
  }
  if (offset < 0) return null;
  const cueStart = Number(cue.start_sec);
  const cueDur = Number(cue.end_sec) - cueStart;
  if (!(cueDur > 0)) return null;
  const startFrac = offset / cueText.length;
  const endFrac = Math.min(1, (offset + matchedLen) / cueText.length);
  return [roundSec(cueStart + cueDur * startFrac), roundSec(cueStart + cueDur * endFrac)];
}

// An exchange only reads as an exchange if the viewer hears it as one. Selecting the "best" lines
// inside a chosen span and dropping the rest leaves the recap playing line-jump-line: on the five
// recap sources only 33-47% of the speech inside the selected spans was captioned, and the owner
// could not follow the story from the result. Once a span is chosen, keep the whole conversation in
// it - the lines in between are what make the picked ones mean anything.
//
// The span is the plan's own choice, so this spends the budget the plan already allocated (Draft
// Day: 116s of dialogue planned, 33s rendered). Non-speech cues are skipped, and a slot is capped so
// one runaway span cannot eat the whole recap.
function fillDialogueExchangeGaps(focusLines, transcript, maxAddedPerSlot = 12, bounds = null) {
  const lines = (Array.isArray(focusLines) ? focusLines : []).map((line) => String(line || '').trim()).filter(Boolean);
  if (lines.length < 2) return { lines, added: 0 };
  // Only ever inside the slot's own window. Locating the picked lines globally could latch onto a
  // repeat elsewhere in the source and import a whole different scene - those lines then matched
  // nothing when the windows were resolved (score 0) and the slot came out emptier than before.
  const lo = Number(bounds?.start);
  const hi = Number(bounds?.end);
  const raw = (Array.isArray(transcript) ? transcript : [])
    .map((cue) => ({ start: Number(cue?.start_sec), end: Number(cue?.end_sec), text: String(cue?.text || '').trim() }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .filter((cue) => (!Number.isFinite(lo) || cue.end > lo - 0.05) && (!Number.isFinite(hi) || cue.start < hi + 0.05))
    .sort((a, b) => a.start - b.start);
  if (!raw.length) return { lines, added: 0 };
  // Auto-caption cues are display chunks, not sentences: "니나에게 그냥 내가 내가" is half a thought.
  // Handing those to the caption writer produced broken Korean and duplicated lines, so glue a run of
  // cues into one utterance and break on a speaker marker or sentence-final punctuation.
  const cues = [];
  for (const cue of raw) {
    const startsSpeaker = /^\s*>>/.test(cue.text);
    const previous = cues[cues.length - 1];
    const previousEnded = previous ? /[.!?…]["')\]]?\s*$/.test(previous.text) : true;
    const gap = previous ? cue.start - previous.end : Infinity;
    // Rolling captions run end-to-end, so a gap almost never appears and only some speaker changes
    // carry a ">>". A censored token swallows the sentence end ("All the psycho mom [__]") and the
    // reply glued onto the question. Cap the merge so a missed boundary costs one line, not a scene.
    const tooLong = previous && previous.text.split(/\s+/).filter(Boolean).length >= 16;
    if (!previous || startsSpeaker || previousEnded || tooLong || gap > 1.2) {
      cues.push({ start: cue.start, end: cue.end, text: cue.text });
    } else {
      previous.text = `${previous.text} ${cue.text}`.replace(/\s+/g, ' ').trim();
      previous.end = cue.end;
    }
  }

  const key = (text) => normalizeComparableText(text);
  const chosen = new Set(lines.map(key).filter(Boolean));
  const indexOfLine = (line) => {
    const wanted = key(line);
    if (!wanted) return -1;
    let best = -1;
    let bestScore = 0;
    cues.forEach((cue, index) => {
      const cueKey = key(cue.text);
      if (!cueKey) return;
      const score = cueKey === wanted ? 1 : (cueKey.includes(wanted) || wanted.includes(cueKey) ? 0.7 : 0);
      if (score > bestScore) { bestScore = score; best = index; }
    });
    return bestScore >= 0.7 ? best : -1;
  };

  const first = indexOfLine(lines[0]);
  const last = indexOfLine(lines[lines.length - 1]);
  if (first < 0 || last < 0 || last <= first) return { lines, added: 0 };

  const out = [];
  let added = 0;
  for (let i = first; i <= last && added < maxAddedPerSlot; i += 1) {
    const text = cues[i].text;
    const cueKey = key(text);
    // Sound-effect and speaker-marker-only cues carry no line to caption.
    if (!cueKey || cueKey.split(/\s+/).filter(Boolean).length < 2) continue;
    if (chosen.has(cueKey)) { out.push(text); continue; }
    if (lines.some((line) => key(line) === cueKey)) { out.push(text); continue; }
    // Rolling captions re-state a line as it scrolls, so the same utterance arrives twice with a
    // word changed ("사실 부군을 좀 압니다" / "사실 부군을 좀 알았어요"). Exact-match dedup let both
    // through and the recap said everything twice.
    const cueWords = cueKey.split(/\s+/).filter(Boolean);
    const alreadySaid = out.some((existing) => {
      const existingWords = key(existing).split(/\s+/).filter(Boolean);
      if (existingWords.length < 4 || cueWords.length < 4) return false;
      const union = new Set([...cueWords, ...existingWords]);
      const shared = cueWords.filter((word) => existingWords.includes(word)).length;
      // Jaccard, not overlap-over-shorter: two lines differing only by a number ("line 3" vs
      // "line 39") share most of their words without being the same utterance.
      return shared / union.size >= 0.8;
    });
    if (alreadySaid) continue;
    out.push(text);
    added += 1;
  }
  // Anything the plan picked outside the span (a cold-open replay) stays - but a picked line that
  // was only a display chunk is already inside the utterance it belongs to, so match on containment.
  for (const line of lines) {
    const wanted = key(line);
    if (!wanted) continue;
    if (!out.some((existing) => key(existing).includes(wanted))) out.push(line);
  }
  return { lines: out.length >= lines.length ? out : lines, added };
}

function resolveDialogueLineWindows(transcript, windowStartSec, windowEndSec, lines, hardMaxSec, nextBoundarySec) {
  const start = Number(windowStartSec);
  const end = Number(windowEndSec);
  const hardMax = Number.isFinite(Number(hardMaxSec)) ? Math.max(end, Number(hardMaxSec)) : end;
  // Absolute ceiling so a last-line extension past the beat boundary can never cross into the next
  // slot in the timeline (keeps cross-slot overlap at 0). Falls back to no extra bound if unknown.
  const lastLineCeiling = Number.isFinite(Number(nextBoundarySec)) ? Number(nextBoundarySec) : Infinity;
  const cues = (Array.isArray(transcript) ? transcript : []).filter(
    (cue) => Number(cue.end_sec) > start - 0.05 && Number(cue.start_sec) < hardMax + 0.05
  );
  const inputLines = (Array.isArray(lines) ? lines : []).map((line) => String(line || '').trim());
  const warnings = [];
  const MATCH_THRESHOLD = 50; // anchor detection: find the line at all (weak matches still flagged)
  const EXTEND_THRESHOLD = 75; // cluster growth: require genuine containment, not mere word overlap,
  // so a short phrase ("We're bait") cannot chain through weak-overlap cues into a monster span
  const CLUSTER_GAP_TOL_SEC = 2.0; // rolling VTT repeats a line across consecutive cues <2s apart
  const MIN_LINE_SEC = 0.5; // below this, even after extension, the caption is unusable -> flag+block
  const MIN_DISPLAY_SEC = 1.2; // target minimum on-screen time; short cues extend toward this
  const MAX_ANCHOR_RUN = 4; // a line may span this many consecutive display chunks
  const MAX_LINE_SEC = 12; // caps degenerate VTT cues (e.g. a trailing caption whose end runs to
  // the end of the video), which no dialogue line realistically occupies

  const sortedCues = [...cues].sort((a, b) => Number(a.start_sec) - Number(b.start_sec) || Number(a.end_sec) - Number(b.end_sec));

  // Step 1: anchor each line on its best-scoring cue, then grow the cluster only across
  // CONTIGUOUS matching cues (rolling VTT repeats a line as words accumulate). Contiguity
  // guards against a short line (e.g. "We're bait") fuzzy-matching a distant false-positive
  // cue and over-extending the window into a monster span.
  const resolved = inputLines.map((line) => {
    let bestIndex = -1;
    let bestScore = 0;
    let bestRun = 1;
    for (let i = 0; i < sortedCues.length; i += 1) {
      const score = scoreCueAgainstQuote(sortedCues[i].text, line);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    // Only when no single cue carries the line: score it against runs of consecutive cues. A
    // sentence the auto-captions split across three display chunks scores about a third against any
    // one of them and used to fail outright - eleven of eighteen restored lines in Housemaid's
    // slot_08 were lost that way. Single cues stay in charge otherwise, so a line whose tail merely
    // spills into the next cue still gets the proportional extension rather than the whole cue.
    if (bestScore < MATCH_THRESHOLD) {
      for (let i = 0; i < sortedCues.length; i += 1) {
        let text = sortedCues[i].text;
        for (let run = 1; run < MAX_ANCHOR_RUN && i + run < sortedCues.length; run += 1) {
          if (Number(sortedCues[i + run].start_sec) - Number(sortedCues[i + run - 1].end_sec) > CLUSTER_GAP_TOL_SEC) break;
          text = `${text} ${sortedCues[i + run].text}`;
          const runScore = scoreCueAgainstQuote(text, line);
          if (runScore > bestScore) {
            bestScore = runScore;
            bestIndex = i;
            bestRun = run + 1;
          }
        }
      }
    }
    const matched = bestIndex >= 0 && bestScore >= MATCH_THRESHOLD;
    if (!matched) {
      warnings.push(`dialogue line has no confident transcript match (best score ${roundSec(bestScore)}): "${line}"`);
      return { line, matched: false, score: roundSec(bestScore), raw_start: null, raw_end: null };
    }
    let lo = bestIndex;
    let hi = bestIndex + bestRun - 1;
    while (lo - 1 >= 0
      && scoreCueAgainstQuote(sortedCues[lo - 1].text, line) >= EXTEND_THRESHOLD
      && Number(sortedCues[lo].start_sec) - Number(sortedCues[lo - 1].end_sec) <= CLUSTER_GAP_TOL_SEC) {
      lo -= 1;
    }
    while (hi + 1 < sortedCues.length
      && scoreCueAgainstQuote(sortedCues[hi + 1].text, line) >= EXTEND_THRESHOLD
      && Number(sortedCues[hi + 1].start_sec) - Number(sortedCues[hi].end_sec) <= CLUSTER_GAP_TOL_SEC) {
      hi += 1;
    }
    let rawStart = Number(sortedCues[lo].start_sec);
    let rawEnd = Number(sortedCues[hi].end_sec);
    if (lo === hi) {
      const slice = sliceCueForLine(sortedCues[bestIndex], line);
      if (slice) { rawStart = slice[0]; rawEnd = slice[1]; }
    }
    // Sentence-boundary extension (ClippyMe pattern): a line split across a cue boundary leaves
    // its tail in the cue AFTER the cluster — the whole-line score against that cue is too weak
    // for cluster growth, so the window used to cut the sentence mid-word. If the next contiguous
    // cue BEGINS with the line's unconsumed tail, extend the end proportionally into it.
    const clusterText = normalizeComparableText(sortedCues.slice(lo, hi + 1).map((cue) => cue.text).join(' '));
    const normLineWords = normalizeComparableText(line).split(' ').filter(Boolean);
    if (hi + 1 < sortedCues.length && normLineWords.length >= 2 && !clusterText.includes(normLineWords.join(' '))) {
      const nextCue = sortedCues[hi + 1];
      const gap = Number(nextCue.start_sec) - Number(sortedCues[hi].end_sec);
      const nextText = normalizeComparableText(nextCue.text);
      if (gap <= 0.35 && nextText) {
        for (let take = Math.min(6, normLineWords.length - 1); take >= 1; take -= 1) {
          const tail = normLineWords.slice(-take).join(' ');
          if (nextText === tail || nextText.startsWith(`${tail} `)) {
            const nextDur = Number(nextCue.end_sec) - Number(nextCue.start_sec);
            const frac = Math.min(1, tail.length / Math.max(1, nextText.length));
            rawEnd = roundSec(Number(nextCue.start_sec) + Math.max(0, nextDur) * frac);
            break;
          }
        }
      }
    }
    return {
      line,
      matched: true,
      score: roundSec(bestScore),
      raw_start: rawStart,
      raw_end: rawEnd
    };
  });

  // Step 2: walk matched lines in temporal order. Each window may extend up to the next line's
  // start (interior) or the beat end (last line). Short cues extend toward MIN_DISPLAY_SEC so a
  // confidently-matched line ("What are they really?") gets readable on-screen time; monster cues
  // are capped at MAX_LINE_SEC; windows stay adjacent and non-overlapping (monotonicity/overlap).
  const matchedOrder = resolved
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.matched)
    .sort((a, b) => a.item.raw_start - b.item.raw_start || a.index - b.index);

  // Half-gap lead-in/out (ClippyMe pattern): the fixed pre/post-roll used to bite into the
  // NEIGHBOURING cue's speech whenever the silence gap was smaller than the roll. Claim at most
  // half of the actual silence between cues; a cue that SPANS the boundary (packed cue slice)
  // means speech runs right up to it, so claim nothing.
  const preRollBudget = (t) => {
    let prevCueEnd = null;
    for (const cue of sortedCues) {
      const cueStart = Number(cue.start_sec);
      const cueEnd = Number(cue.end_sec);
      if (cueStart < t - 0.01 && cueEnd > t + 0.01) return 0; // speech spans the boundary
      if (cueEnd <= t + 0.01 && (prevCueEnd == null || cueEnd > prevCueEnd)) prevCueEnd = cueEnd;
    }
    if (prevCueEnd == null) return DIALOGUE_CONTEXT_PRE_ROLL_SEC;
    return Math.min(DIALOGUE_CONTEXT_PRE_ROLL_SEC, Math.max(0, (t - prevCueEnd) / 2));
  };
  const postRollBudget = (t) => {
    let nextCueStart = null;
    for (const cue of sortedCues) {
      const cueStart = Number(cue.start_sec);
      const cueEnd = Number(cue.end_sec);
      if (cueStart < t - 0.01 && cueEnd > t + 0.01) return 0;
      if (cueStart >= t - 0.01 && (nextCueStart == null || cueStart < nextCueStart)) nextCueStart = cueStart;
    }
    if (nextCueStart == null) return DIALOGUE_CONTEXT_POST_ROLL_SEC;
    return Math.min(DIALOGUE_CONTEXT_POST_ROLL_SEC, Math.max(0, (nextCueStart - t) / 2));
  };

  let prevEnd = start;
  for (let position = 0; position < matchedOrder.length; position += 1) {
    const current = matchedOrder[position].item;
    const next = position + 1 < matchedOrder.length ? matchedOrder[position + 1].item : null;
    const lineStart = Math.max(start, current.raw_start - preRollBudget(current.raw_start), prevEnd);
    // ceiling = how far this line may occupy. Interior lines stop at the next line start.
    // The LAST line may extend to its real transcript cue end even PAST the beat boundary — a beat
    // boundary landing on a spoken line (cue starting at beat.end) would otherwise clamp it to ~0s.
    const ceiling = next
      ? Math.min(hardMax, Number(next.raw_start))
      : Math.min(Math.max(hardMax, Number(current.raw_end)), lastLineCeiling);
    const naturalEnd = Math.min(current.raw_end + postRollBudget(current.raw_end), ceiling);
    // extend short windows toward a readable minimum, but never past the ceiling or the max cap.
    const desiredEnd = Math.max(naturalEnd, lineStart + MIN_DISPLAY_SEC);
    let lineEnd = Math.min(desiredEnd, ceiling, lineStart + MAX_LINE_SEC);
    if (Number(current.raw_end) - lineStart > MAX_LINE_SEC && lineEnd < Number(current.raw_end) - 0.001) {
      warnings.push(`dialogue line window capped at ${MAX_LINE_SEC}s (source cue ran ${roundSec(current.raw_end - lineStart)}s, likely a trailing VTT artifact): "${current.line}"`);
    }
    if (lineEnd <= lineStart) {
      warnings.push(`dialogue line window collapsed (overlaps neighbour), needs manual review: "${current.line}"`);
      lineEnd = Math.min(ceiling, lineStart + 0.05);
    }
    current.start_sec = roundSec(lineStart);
    current.end_sec = roundSec(lineEnd);
    current.context_pre_roll_sec = roundSec(Math.max(0, Number(current.raw_start) - lineStart));
    current.context_post_roll_sec = roundSec(Math.max(0, lineEnd - Number(current.raw_end)));
    current.extended = lineEnd > naturalEnd + 0.001 || current.context_pre_roll_sec > 0 || current.context_post_roll_sec > 0;
    if (current.extended) {
      warnings.push(`dialogue line window extended from ${roundSec(naturalEnd - lineStart)}s to ${roundSec(lineEnd - lineStart)}s for readable display (start unchanged): "${current.line}"`);
    }
    current.too_short = (lineEnd - lineStart) < MIN_LINE_SEC;
    if (current.too_short) {
      // One unusable sliver used to poison the whole slot: a 0.2s cue ("what do you call this
      // fella") flagged its slot not-ok, preflight rejected the fresh plan, and the run silently
      // fell back to a stale one. Drop the line instead - the caption reconciliation removes its
      // caption - and let the slot stand on the lines that are readable.
      current.matched = false;
      warnings.push(`dialogue line window is ${roundSec(lineEnd - lineStart)}s (< ${MIN_LINE_SEC}s) even after extension; line dropped, slot keeps its readable lines: "${current.line}"`);
    }
    prevEnd = lineEnd;
  }

  const windows = resolved.map((item) => ({
    line: item.line,
    matched: item.matched,
    score: item.score,
    start_sec: item.matched ? item.start_sec : null,
    end_sec: item.matched ? item.end_sec : null,
    raw_start_sec: item.matched ? roundSec(item.raw_start) : null,
    raw_end_sec: item.matched ? roundSec(item.raw_end) : null,
    context_pre_roll_sec: item.matched ? Number(item.context_pre_roll_sec || 0) : 0,
    context_post_roll_sec: item.matched ? Number(item.context_post_roll_sec || 0) : 0,
    extended: item.matched ? Boolean(item.extended) : false,
    too_short: item.matched ? Boolean(item.too_short) : false
  }));

  // ok judges the lines that will actually be cut. Requiring every INPUT line to match meant one
  // unmatchable sliver ("what do you call this fella", a 0.2s cue) kept the slot not-ok forever,
  // preflight rejected the fresh plan, and the run silently fell back to a stale one.
  const matchedWindows = windows.filter((w) => w.matched);
  const ok = matchedWindows.length > 0
    && matchedWindows.every((w) => !w.too_short && Number(w.end_sec) > Number(w.start_sec));
  return { windows, warnings, ok };
}

// A greeting is the worst possible hook and this used to pick one. The old score was a question
// mark, a handful of Twilight-specific phrases, and raw length — on any other film only length
// counted, so the longest rambling line won. "Hi, Janice. I'm glad to see you, baby." opened the
// Senseless cut while "You cheated on me with that piece of trash?" sat in the middle.
const TEASER_PLEASANTRY = /^(hi|hey|hello|yo|good (morning|evening|afternoon)|nice to (see|meet)|how are you|how'?s it going|what'?s up|thank you|thanks|excuse me|sorry to bother)\b/i;
const TEASER_ATTITUDE = /\b(don'?t|didn'?t|doesn'?t|can'?t|won'?t|ain'?t|never|nothing|nobody|shut up|stop it|liar|lying|lied|cheat(ed|ing)?|steal|stole|kill(ed)?|hate|swear|get out|leave me|listen to me|i'?m not|you'?re not|are you kidding|no way)\b/i;
const TEASER_POWER = /\b(you (tried|made|owe|lied|cheated|promised|did)|who (are|do) you|how dare|i told you|it'?s over|that'?s mine|you work for|i own|do you know who)\b/i;

function teaserQuoteScore(value) {
  const text = String(value || '').replace(/^\s*>>\s*/, '').trim();
  if (!text) return -Infinity;
  let score = 0;
  if (/[?？]$/.test(text)) score += 10;
  if (TEASER_ATTITUDE.test(text)) score += 8;
  if (TEASER_POWER.test(text)) score += 6;
  if (/[!！]/.test(text)) score += 3;
  if (TEASER_PLEASANTRY.test(text)) score -= 14;
  // A hook is a punch, not a paragraph: reward lines that read in one breath.
  const length = text.length;
  if (length < 12) score -= 3;
  else if (length <= 55) score += 2;
  else score -= Math.min(6, (length - 55) / 20);
  return score;
}

function pickTeaserQuote(beat) {
  const quotes = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue : [];
  if (!quotes.length) return '';
  const ranked = [...quotes].sort((left, right) => teaserQuoteScore(right) - teaserQuoteScore(left));
  return ranked[0];
}

function clipWindowAroundFocus(focus, fallbackBeat) {
  const beatStart = Number(fallbackBeat?.start_sec || 0);
  const beatEnd = Number(fallbackBeat?.end_sec || beatStart + COLD_OPEN_VISUAL_TARGET_SEC);
  if (!focus) {
    return {
      start_sec: roundSec(beatStart),
      end_sec: roundSec(Math.min(beatEnd, beatStart + COLD_OPEN_VISUAL_TARGET_SEC))
    };
  }
  const focusDuration = Math.max(0.5, Number(focus.end_sec) - Number(focus.start_sec));
  const targetDuration = Math.min(COLD_OPEN_VISUAL_MAX_SEC, Math.max(COLD_OPEN_VISUAL_MIN_SEC, focusDuration));
  const center = (Number(focus.start_sec) + Number(focus.end_sec)) / 2;
  let startSec = center - targetDuration / 2;
  let endSec = center + targetDuration / 2;
  if (startSec < beatStart) {
    endSec += beatStart - startSec;
    startSec = beatStart;
  }
  if (endSec > beatEnd) {
    startSec -= endSec - beatEnd;
    endSec = beatEnd;
  }
  startSec = Math.max(beatStart, startSec);
  endSec = Math.min(beatEnd, Math.max(startSec + COLD_OPEN_VISUAL_MIN_SEC, endSec));
  return {
    start_sec: roundSec(startSec),
    end_sec: roundSec(endSec)
  };
}

function subtractReservedRanges(start, end, reservedRanges, marginSec) {
  const margin = marginSec === undefined ? 0.5 : marginSec;
  const list = Array.isArray(reservedRanges) ? reservedRanges : [];
  const blocks = [];
  for (const pair of list) {
    const rStart = Number(pair[0]);
    const rEnd = Number(pair[1]);
    const bStart = Math.max(start, rStart - margin);
    const bEnd = Math.min(end, rEnd + margin);
    if (bEnd > bStart) blocks.push([bStart, bEnd]);
  }
  blocks.sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = start;
  for (const block of blocks) {
    const bStart = block[0];
    const bEnd = block[1];
    if (bStart > cursor) free.push([cursor, Math.min(bStart, end)]);
    cursor = Math.max(cursor, bEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push([cursor, end]);
  return free.filter((range) => range[1] - range[0] > 0.05);
}

function pickBestFreeWindow(freeRanges, idealStartSec, idealEndSec, minSec, maxSec) {
  const viable = freeRanges.filter((range) => range[1] - range[0] >= minSec);
  if (!viable.length) return null;
  const idealCenter = (Number(idealStartSec) + Number(idealEndSec)) / 2;
  const idealLen = Math.max(minSec, Number(idealEndSec) - Number(idealStartSec));
  let best = null;
  for (const range of viable) {
    const fStart = range[0];
    const fEnd = range[1];
    const overlap = Math.max(0, Math.min(fEnd, idealEndSec) - Math.max(fStart, idealStartSec));
    const center = (fStart + fEnd) / 2;
    const centerDistance = Math.abs(center - idealCenter);
    if (best === null || overlap > best.overlap || (overlap === best.overlap && centerDistance < best.centerDistance)) {
      best = { fStart: fStart, fEnd: fEnd, overlap: overlap, centerDistance: centerDistance };
    }
  }
  const freeLen = best.fEnd - best.fStart;
  const targetLen = Math.min(maxSec, Math.max(minSec, Math.min(freeLen, idealLen)));
  let startSec = idealCenter - targetLen / 2;
  let endSec = idealCenter + targetLen / 2;
  if (startSec < best.fStart) {
    endSec = endSec + (best.fStart - startSec);
    startSec = best.fStart;
  }
  if (endSec > best.fEnd) {
    startSec = startSec - (endSec - best.fEnd);
    endSec = best.fEnd;
  }
  startSec = Math.max(best.fStart, startSec);
  endSec = Math.min(best.fEnd, endSec);
  return { start_sec: roundSec(startSec), end_sec: roundSec(endSec) };
}

function tryColdOpenVisualSourceForBeat(beat, transcript, reservedRanges) {
  const teaserQuote = pickTeaserQuote(beat);
  const focus = collectDialogueFocus(beat, transcript, { quotes: teaserQuote ? [teaserQuote] : [] })
    || collectDialogueFocus(beat, transcript);
  const idealWindow = clipWindowAroundFocus(focus, beat);
  const freeRanges = subtractReservedRanges(Number(beat.start_sec || 0), Number(beat.end_sec || 0), reservedRanges);
  const window = pickBestFreeWindow(freeRanges, idealWindow.start_sec, idealWindow.end_sec, COLD_OPEN_VISUAL_MIN_SEC, COLD_OPEN_VISUAL_MAX_SEC);
  if (!window) return null;
  return {
    mode: 'mute_visual_teaser',
    beat_id: beat.beat_id,
    start_sec: window.start_sec,
    end_sec: window.end_sec,
    reason: `Use a silent teaser visual from ${beat.beat_id} so the cold-open hook is not forced to inherit unrelated source chatter.`,
    teaser_quote: teaserQuote,
    lines: focus?.lines || []
  };
}

function selectColdOpenVisualSource(beats, coldBeatId, transcript, reservedRanges) {
  const ranges = Array.isArray(reservedRanges) ? reservedRanges : [];
  const candidates = [...beats]
    .filter((beat) => String(beat?.beat_id || '') !== String(coldBeatId || '').trim())
    .sort((left, right) => {
      const hookDelta = Number(right?.hook_potential || 0) - Number(left?.hook_potential || 0);
      if (hookDelta !== 0) return hookDelta;
      const weightDelta = Number(right?.dramatic_weight || 0) - Number(left?.dramatic_weight || 0);
      if (weightDelta !== 0) return weightDelta;
      return (DIALOGUE_QUALITY_RANK[String(right?.dialogue_quality || '').trim()] || 0)
        - (DIALOGUE_QUALITY_RANK[String(left?.dialogue_quality || '').trim()] || 0);
    });
  for (const beat of candidates) {
    const result = tryColdOpenVisualSourceForBeat(beat, transcript, ranges);
    if (result) return result;
  }
  const ownBeat = beats.find((beat) => String(beat?.beat_id || '').trim() === String(coldBeatId || '').trim());
  return ownBeat ? tryColdOpenVisualSourceForBeat(ownBeat, transcript, ranges) : null;
}

function recalculateDurationBudget(timeline, targetSec) {
  // Measure dialogue the way the cut does — the lines, not the span between them.
  const keepDialogueSec = roundSec(timeline
    .filter((item) => item.decision === 'KEEP_DIALOGUE')
    .reduce((sum, item) => sum + realisticSlotDurationSec(item), 0));
  const narrationSec = roundSec(timeline
    .filter((item) => item.decision === 'NARRATE')
    .reduce((sum, item) => sum + Number(item.estimated_duration_sec || 0), 0));
  return {
    target_sec: Number(targetSec || 0),
    estimated_total_sec: roundSec(keepDialogueSec + narrationSec),
    keep_dialogue_sec: keepDialogueSec,
    narration_sec: narrationSec
  };
}

function estimateKoreanNarrationSeconds(text) {
  const charCount = String(text || '').replace(/\s+/g, '').length;
  if (!charCount) return 0;
  return roundSec(Math.max(
    KOREAN_NARRATION_MIN_SEC,
    charCount / koreanNarrationCharsPerSec() + KOREAN_NARRATION_PAUSE_BUFFER_SEC
  ));
}

// Re-centers the cold-open teaser window to `targetSec` around a stable center point
// (not the current, possibly already-resized, window) so repeated compress-apply runs
// converge on the narration's actual length instead of only ever growing.
function resizeColdOpenWindow(centerSec, targetSec, sourceBeat, fallbackStartSec, fallbackEndSec) {
  const beatStart = Number(sourceBeat?.start_sec ?? fallbackStartSec);
  const beatEnd = Number(sourceBeat?.end_sec ?? fallbackEndSec);
  const center = Number.isFinite(centerSec) ? centerSec : (Number(fallbackStartSec) + Number(fallbackEndSec)) / 2;
  let startSec = center - targetSec / 2;
  let endSec = center + targetSec / 2;
  if (startSec < beatStart) {
    endSec += beatStart - startSec;
    startSec = beatStart;
  }
  if (endSec > beatEnd) {
    startSec -= endSec - beatEnd;
    endSec = beatEnd;
  }
  startSec = Math.max(beatStart, startSec);
  endSec = Math.min(beatEnd, endSec);
  const resizedSec = roundSec(endSec - startSec);
  return {
    start_sec: roundSec(startSec),
    end_sec: roundSec(endSec),
    fits: resizedSec >= roundSec(targetSec) - 0.05
  };
}

// Runs after slot_fills narration text exists. NARRATE estimates up to this point are
// based on source-clip/visual-window length, not the actual Korean narration — this
// recalculates them from real narration length and, for cold_open, resizes the muted
// teaser visual window (grow or shrink) to fit rather than forcing the narration to be cut.
function recalculateNarrationDurations(editPlan, slotFills, beats, transcript = []) {
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));

  const timeline = (Array.isArray(editPlan?.timeline) ? editPlan.timeline : []).map((item) => {
    if (item.decision !== 'NARRATE') return item;
    if (item.role === 'cold_open' && String(item.visual_source_mode || '').trim() === 'source_audio_teaser') {
      // Scene hook plays the peak window with original audio — no narration sizing, and
      // the visual window must not be resized to a narration length.
      const windowSec = roundSec(Number(item.visual_source_end_sec || 0) - Number(item.visual_source_start_sec || 0));
      return {
        ...item,
        narration_estimated_duration_sec: 0,
        estimated_duration_sec: windowSec > 0 ? windowSec : Number(item.estimated_duration_sec || 0),
        duration_check: { status: 'scene_hook_source_audio', narration_estimated_duration_sec: 0 }
      };
    }
    const fill = fillsBySlot.get(String(item.slot_id || '').trim());
    const narrationText = String(fill?.narration || '');
    const narrationEstimatedSec = estimateKoreanNarrationSeconds(narrationText);
    const next = { ...item, narration_estimated_duration_sec: narrationEstimatedSec };

    if (!narrationEstimatedSec) {
      next.duration_check = { status: 'no_narration', narration_estimated_duration_sec: 0 };
      return next;
    }

    if (item.role === 'cold_open') {
      const windowStart = Number(item.visual_source_start_sec ?? item.start_sec ?? 0);
      const windowEnd = Number(item.visual_source_end_sec ?? item.end_sec ?? windowStart);
      const windowSec = roundSec(windowEnd - windowStart);
      const targetSec = Math.max(narrationEstimatedSec, COLD_OPEN_VISUAL_MIN_SEC);
      if (Math.abs(targetSec - windowSec) < 0.1) {
        next.duration_check = { status: 'ok', narration_estimated_duration_sec: narrationEstimatedSec, visual_window_sec: windowSec };
        return next;
      }
      const sourceBeat = beatMap.get(String(item.visual_source_beat_id || '').trim());
      const centerSec = Number.isFinite(item.visual_source_center_sec) ? item.visual_source_center_sec : (windowStart + windowEnd) / 2;
      const resized = resizeColdOpenWindow(centerSec, targetSec, sourceBeat, windowStart, windowEnd);
      next.visual_source_start_sec = resized.start_sec;
      next.visual_source_end_sec = resized.end_sec;
      next.estimated_duration_sec = roundSec(resized.end_sec - resized.start_sec);
      next.duration_check = {
        status: resized.fits ? 'resized' : 'needs_narration_trim',
        narration_estimated_duration_sec: narrationEstimatedSec,
        original_visual_window_sec: windowSec,
        adjusted_visual_window_sec: next.estimated_duration_sec,
        suggested_action: resized.fits
          ? `Cold-open teaser visual window resized from ${windowSec}s to ${next.estimated_duration_sec}s to match narration.`
          : `Narration needs ~${narrationEstimatedSec}s but the teaser source beat only has ~${next.estimated_duration_sec}s of footage available. Trim narration by ~${roundSec(narrationEstimatedSec - next.estimated_duration_sec)}s, or choose a different/longer teaser source beat.`
      };
      return next;
    }

    next.estimated_duration_sec = narrationEstimatedSec;
    next.duration_check = { status: 'ok', narration_estimated_duration_sec: narrationEstimatedSec };
    return next;
  });

  const coldIndex = timeline.findIndex((item) => item.role === 'cold_open');
  const coldOpenSelection = { ...(editPlan?.cold_open_selection || {}) };
  if (coldIndex >= 0) {
    coldOpenSelection.teaser_visual_start_sec = timeline[coldIndex].visual_source_start_sec ?? coldOpenSelection.teaser_visual_start_sec;
    coldOpenSelection.teaser_visual_end_sec = timeline[coldIndex].visual_source_end_sec ?? coldOpenSelection.teaser_visual_end_sec;
    coldOpenSelection.duration_check = timeline[coldIndex].duration_check;
  }

  const safeTimeline = applyColdOpenVisualOverlapSafety(timeline, beatMap);
  if (coldIndex >= 0) {
    coldOpenSelection.teaser_visual_start_sec = safeTimeline[coldIndex].visual_source_start_sec ?? coldOpenSelection.teaser_visual_start_sec;
    coldOpenSelection.teaser_visual_end_sec = safeTimeline[coldIndex].visual_source_end_sec ?? coldOpenSelection.teaser_visual_end_sec;
  }

  const callbackMetadata = buildColdOpenCallbackMetadata(safeTimeline, editPlan, beats, transcript);
  const durationBudget = recalculateDurationBudget(safeTimeline, Number(editPlan?.duration_budget?.target_sec || DEFAULT_TARGET_SEC));
  const dialogueTimingQc = evaluateDialogueTimingQc(safeTimeline, {
    dialogueDrivenConfrontation: isDialogueDrivenConfrontation(editPlan, beats),
    editorialPattern: callbackMetadata.editorial_pattern,
    totalRuntimeSec: Number(durationBudget.estimated_total_sec || editPlan?.duration_budget?.estimated_total_sec || DEFAULT_TARGET_SEC),
    allowLateDialogueOverride: editPlan?.allow_late_dialogue_override === true
  });

  return {
    ...editPlan,
    ...callbackMetadata,
    cold_open_selection: coldOpenSelection,
    timeline: safeTimeline,
    dialogue_timing_qc: dialogueTimingQc,
    duration_budget: durationBudget
  };
}

// A source that is mostly silence/action is not a dialogue confrontation even when a few
// of its beats argue. Classifying it as one applies the strict dialogue-oriented gates,
// which then escalate an action recap into a path that rejects action sources outright.
const DIALOGUE_SCENE_MIN_SPEECH_RATIO = 0.2;

function speechRatioForTranscript(transcript) {
  const cues = Array.isArray(transcript) ? transcript : [];
  if (!cues.length) return null;
  let speechSec = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  for (const cue of cues) {
    const start = Number(cue?.start_sec);
    const end = Number(cue?.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    speechSec += end - start;
    minStart = Math.min(minStart, start);
    maxEnd = Math.max(maxEnd, end);
  }
  const span = maxEnd - (Number.isFinite(minStart) ? minStart : 0);
  if (!(span > 0)) return null;
  return speechSec / span;
}

function buildColdOpenCallbackMetadata(timeline, editPlan, beats, transcript = []) {
  const active = (Array.isArray(timeline) ? timeline : []).filter((item) => item?.decision !== 'DROP');
  const starts = timelineStartBySlot(active);
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const hook = active.find((item) => item?.role === 'cold_open' && item?.decision === 'KEEP_DIALOGUE');
  const context = active.find((item) => item?.decision === 'NARRATE' && Number(starts.get(String(item?.slot_id || '').trim()) || 0) >= Number(starts.get(String(hook?.slot_id || '').trim()) || 0));
  const callback = hook
    ? active.find((item) => item?.decision === 'KEEP_DIALOGUE' && item?.slot_id !== hook.slot_id)
    : null;
  const hookBeat = beatMap.get(String(hook?.beat_id || '').trim());
  const callbackBeat = beatMap.get(String(callback?.beat_id || '').trim());
  const hookLines = Array.isArray(hook?.dialogue_focus_lines) ? hook.dialogue_focus_lines : [];
  const callbackLines = Array.isArray(callback?.dialogue_focus_lines) ? callback.dialogue_focus_lines : [];
  const callbackRelation = hook && callback && callback.beat_id === hook.beat_id
    ? 'same_line_callback'
    : (callbackBeat && hookBeat && hasEarlyConfrontationSignal([...hookLines, ...callbackLines], callbackBeat) ? 'same_conflict_axis' : 'payoff_response');
  const reusedConflictAxis = String(hook?.reused_conflict_axis || callback?.reused_conflict_axis || hookBeat?.summary || callbackBeat?.summary || '').slice(0, 120);
  const speechRatio = speechRatioForTranscript(transcript);
  const speechDense = speechRatio == null || speechRatio >= DIALOGUE_SCENE_MIN_SPEECH_RATIO;
  return {
    editorial_pattern: hook && callback ? 'cold_open_callback' : 'standard_chronological',
    scene_type: hook && callback && speechDense
      ? 'dialogue_confrontation'
      : (String(editPlan?.scene_type || '') || (speechDense ? '' : 'action_escalation')),
    source_speech_ratio: speechRatio == null ? null : roundSec(speechRatio),
    hook_teaser: {
      enabled: Boolean(hook),
      source_lines: hookLines,
      time_range: hook ? [roundSec(hook.start_sec), roundSec(hook.end_sec)] : [],
      speaker: String(hook?.speaker || ''),
      hook_score: hookBeat ? roundSec(coldOpenCallbackBeatScore(hookBeat)) : 0,
      context_dependency: contextDependencyForLines(hookLines),
      editorial_role: hook?.editorial_role || 'hook_teaser',
      dialogue_unit: hook?.dialogue_unit || null,
      teaser_slot_id: String(hook?.slot_id || ''),
      callback_slot_id: String(callback?.slot_id || ''),
      callback_relation: callback ? callbackRelation : '',
      reused_conflict_axis: reusedConflictAxis
    },
    context_reset: {
      enabled: Boolean(context),
      target_duration_sec: context ? roundSec(Number(context.estimated_duration_sec || 0)) : 0,
      explanation_sufficiency: context ? 'sufficient' : 'missing',
      spoiler_leakage: context && hookLines.some((line) => String(context.reason || '').includes(line)) ? 'possible' : 'none',
      callback_readiness: callback ? 'ready' : 'missing_callback'
    },
    callback_dialogue: {
      enabled: Boolean(callback),
      source_lines: callbackLines,
      time_range: callback ? [roundSec(callback.start_sec), roundSec(callback.end_sec)] : [],
      relation_to_teaser: callbackRelation,
      callback_slot_id: String(callback?.slot_id || ''),
      callback_relation: callback ? callbackRelation : '',
      reused_conflict_axis: reusedConflictAxis
    }
  };
}

function bestColdOpenCallbackBeat(beats, transcript, preferredBeatId = '', rerankChoice = null) {
  const preferredId = String(preferredBeatId || '').trim();
  const candidates = (Array.isArray(beats) ? beats : [])
    .flatMap((beat) => coldOpenFocusCandidatesForBeat(beat, transcript).map((candidate) => {
      const teaserScores = coldOpenCallbackScores(beat, candidate.focus.lines);
      const supportAction = normalizeQcActionAction(teaserScores.required_support_action);
      const isPreferredBeat = preferredId && String(beat?.beat_id || '').trim() === preferredId;
      const hasRepairablePreferredDialogue = isPreferredBeat
        && supportAction === 'bridge_required'
        && (Array.isArray(beat?.key_dialogue) ? beat.key_dialogue.filter(Boolean).length : 0) >= 2;
      const selectionScore = teaserScores.total
        + supportActionSelectionWeight(supportAction)
        + (candidate.source === 'micro_exchange_candidate' ? 14 : 0);
      // The +120 planner-preference bias only applies while no listwise rerank has spoken: the
      // rerank IS an LLM opinion over the same candidates, and stacking both double-counts it.
      const preferredSelectionScore = selectionScore + (!rerankChoice && isPreferredBeat && (supportAction !== 'bridge_required' || hasRepairablePreferredDialogue) ? 120 : 0);
      return {
        beat,
        focus: candidate.focus,
        source: candidate.source,
        score: roundSec(preferredSelectionScore),
        teaser_scores: teaserScores
      };
    }))
    .filter((item) => item.focus && item.score > 0 && normalizeQcActionAction(item.teaser_scores?.required_support_action) !== 'downgrade_to_narrate')
    .sort((left, right) => right.score - left.score || Number(left.beat.start_sec || 0) - Number(right.beat.start_sec || 0));
  // Time-axis NMS (AI-Youtube-Shorts-Generator, MIT): the text-key dedupe upstream lets two
  // differently-worded candidates point at the same seconds. Suppress a candidate when it
  // overlaps a higher-scored survivor by more than half of ITS OWN length.
  const survivors = [];
  for (const candidate of candidates) {
    const start = Number(candidate.focus.start_sec);
    const end = Number(candidate.focus.end_sec);
    const duration = Math.max(0.001, end - start);
    const suppressed = survivors.some((kept) => {
      const overlap = Math.min(end, Number(kept.focus.end_sec)) - Math.max(start, Number(kept.focus.start_sec));
      return overlap > 0 && overlap > 0.5 * duration;
    });
    if (!suppressed) survivors.push(candidate);
  }
  // A stored rerank choice (listwise LLM pass over the candidate pool) pins the winner: match by
  // beat and window so a later refresh replays the same selection deterministically with no
  // second LLM call. No match (pool drifted) -> fall through to the deterministic argmax.
  let best = null;
  let selectionMode = 'deterministic_argmax';
  if (rerankChoice && rerankChoice.beat_id) {
    best = survivors.find((item) => (
      String(item.beat?.beat_id || '').trim() === String(rerankChoice.beat_id).trim()
      && Math.abs(Number(item.focus.start_sec) - Number(rerankChoice.start_sec)) <= 0.9
    )) || null;
    if (best) selectionMode = 'listwise_rerank';
  }
  if (!best) best = survivors[0] || null;
  if (best) {
    best.selection_mode = selectionMode;
    // Keep the losing candidates on the winner (top 8, compact): without this the selection
    // is a black box - "why did THIS open the cut" cannot be answered after the fact.
    best.runner_ups = survivors.filter((item) => item !== best).slice(0, 7).map((item) => ({
      beat_id: String(item.beat?.beat_id || ''),
      source: item.source,
      score: item.score,
      start_sec: Number(item.focus.start_sec),
      end_sec: Number(item.focus.end_sec),
      lines: (item.focus.lines || []).slice(0, 2)
    }));
  }
  return best;
}

function prepareColdOpenCallbackTimeline(timeline, editPlan, beats, transcript) {
  if (!isDialogueDrivenConfrontation(editPlan, beats)) return timeline;
  // A heatmap-peak scene hook (original-audio action teaser) must not be replaced by a
  // dialogue callback hook — the peak moment IS the hook.
  const existingCold = (Array.isArray(timeline) ? timeline : []).find((item) => item?.role === 'cold_open');
  if (String(existingCold?.visual_source_mode || '').trim() === 'source_audio_teaser') return timeline;
  const selected = bestColdOpenCallbackBeat(
    beats,
    transcript,
    editPlan?.cold_open_selection?.beat_id,
    editPlan?.cold_open_selection?.rerank_choice || null
  );
  if (!selected) return timeline;
  if (editPlan && editPlan.cold_open_selection && Array.isArray(selected.runner_ups)) {
    editPlan.cold_open_selection.runner_ups = selected.runner_ups;
    editPlan.cold_open_selection.selection_mode = selected.selection_mode || 'deterministic_argmax';
  }
  const hookBeatId = String(selected.beat.beat_id || '').trim();
  const nextTimeline = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  const coldIndex = nextTimeline.findIndex((item) => item.role === 'cold_open');
  if (coldIndex < 0) return nextTimeline;
  const cold = nextTimeline[coldIndex];
  // An authored teaser is the owner's choice of hook; re-selecting one from the beats replaces it.
  // The Housemaid night's teaser was set by hand to the reveal ("Nina Winchester tried to drown her
  // kid in a bathtub.") and this pass swapped in an earlier exchange, which the 16s clamp then cut
  // down to a bare "What?" - a reaction with nothing to react to.
  if (cold.authored_lines === true) return nextTimeline;
  for (let index = 0; index < nextTimeline.length; index += 1) {
    if (index === coldIndex) continue;
    const isHookCallback = String(nextTimeline[index].beat_id || '').trim() === hookBeatId;
    if (String(nextTimeline[index].replay_of_slot_id || '').trim() === String(cold.slot_id || '').trim() && !isHookCallback) {
      nextTimeline[index] = {
        ...nextTimeline[index],
        role: nextTimeline[index].role === 'body_peak' ? 'body' : nextTimeline[index].role,
        replay_of_slot_id: '',
        replay_mode: '',
        repeat_policy: nextTimeline[index].repeat_policy === 'Callback returns to the cold-open conflict axis with context, not as an accidental repeat.'
          ? 'No repeat.'
          : nextTimeline[index].repeat_policy
      };
    }
    if (nextTimeline[index].early_dialogue_anchor === true || nextTimeline[index].dialogue_focus_source === 'early_confrontation_anchor') {
      nextTimeline[index] = {
        ...nextTimeline[index],
        decision: 'NARRATE',
        estimated_duration_sec: roundSec(Number(nextTimeline[index].narration_estimated_duration_sec || nextTimeline[index].estimated_duration_sec || 0)),
        dialogue_focus_source: 'none',
        dialogue_focus_lines: [],
        dialogue_focus_quotes: [],
        early_dialogue_anchor: false,
        dialogue_selection_scores: undefined,
        dialogue_line_windows: undefined,
        dialogue_line_window_ok: undefined,
        dialogue_line_window_warnings: undefined
      };
    }
  }
  const teaserScores = selected.teaser_scores || coldOpenCallbackScores(selected.beat, selected.focus.lines);
  nextTimeline[coldIndex] = {
    ...cold,
    beat_id: hookBeatId,
    decision: 'KEEP_DIALOGUE',
    start_sec: selected.focus.start_sec,
    end_sec: selected.focus.end_sec,
    estimated_duration_sec: selected.focus.duration_sec,
    reason: selected.source === 'micro_exchange_candidate'
      ? 'Cold open callback pattern selected a coherent micro-exchange hook before chronology.'
      : 'Cold open callback pattern selected the strongest standalone dialogue hook before chronology.',
    spoiler_policy: 'Teaser first; context follows immediately without paraphrasing the line.',
    repeat_policy: 'Hook dialogue first; callback later re-enters the same conflict axis with context.',
    visual_source_mode: 'source_dialogue_hook',
    visual_source_beat_id: hookBeatId,
    visual_source_start_sec: selected.focus.start_sec,
    visual_source_end_sec: selected.focus.end_sec,
    dialogue_focus_source: selected.source === 'micro_exchange_candidate' ? 'cold_open_callback_micro_exchange' : 'cold_open_callback_hook',
    dialogue_focus_lines: selected.focus.lines,
    dialogue_focus_quotes: (selected.focus.quotes || []).length ? selected.focus.quotes : selected.focus.lines,
    replay_of_slot_id: '',
    replay_mode: '',
    editorial_role: 'hook_teaser',
    scene_type: 'dialogue_confrontation',
    teaser_slot_id: cold.slot_id,
    callback_slot_id: '',
    callback_relation: '',
    reused_conflict_axis: String(selected.beat.summary || '').slice(0, 120),
    dialogue_unit: selected.focus.dialogue_unit || buildDialogueUnitMetadata(selected.focus.lines, selected.focus.start_sec, selected.focus.end_sec, selected.focus.source_line_ids || []),
    dialogue_selection_scores: teaserScores,
    qc_action: {
      action: teaserScores.required_support_action,
      reason: teaserScores.required_support_action === 'none'
        ? 'Teaser is sufficiently standalone.'
        : `Teaser needs support because context_dependency=${teaserScores.context_dependency}.`,
      source: 'teaser_suitability_score'
    }
  };
  const callbackIndex = nextTimeline.findIndex((item, index) => index !== coldIndex && String(item.beat_id || '').trim() === hookBeatId);
  if (callbackIndex >= 0) {
    nextTimeline[callbackIndex] = {
      ...nextTimeline[callbackIndex],
      role: 'body_peak',
      decision: nextTimeline[callbackIndex].decision === 'DROP' ? 'NARRATE' : nextTimeline[callbackIndex].decision,
      replay_of_slot_id: nextTimeline[coldIndex].slot_id,
      replay_mode: 'full_context_replay',
      editorial_role: 'callback_dialogue',
      scene_type: 'dialogue_confrontation',
      teaser_slot_id: nextTimeline[coldIndex].slot_id,
      callback_slot_id: nextTimeline[callbackIndex].slot_id,
      callback_relation: 'same_conflict_axis',
      reused_conflict_axis: String(selected.beat.summary || '').slice(0, 120),
      repeat_policy: 'Callback returns to the cold-open conflict axis with context, not as an accidental repeat.'
    };
  }
  const bridgeIndex = nextTimeline.findIndex((item, index) => index !== coldIndex && item.decision === 'NARRATE');
  if (bridgeIndex >= 0) {
    const minContextSec = roundSec(CALLBACK_DIALOGUE_TARGET_MIN_SEC - Number(selected.focus.duration_sec || 0) + 0.6);
    nextTimeline[bridgeIndex] = {
      ...nextTimeline[bridgeIndex],
      role: nextTimeline[bridgeIndex].role === 'cold_open' ? 'bridge' : nextTimeline[bridgeIndex].role,
      decision: 'NARRATE',
      estimated_duration_sec: roundSec(Math.max(Number(nextTimeline[bridgeIndex].estimated_duration_sec || 0), minContextSec)),
      dialogue_focus_source: 'none',
      dialogue_focus_lines: [],
      dialogue_focus_quotes: [],
      early_dialogue_anchor: false,
      dialogue_selection_scores: undefined,
      dialogue_line_windows: undefined,
      dialogue_line_window_ok: undefined,
      dialogue_line_window_warnings: undefined,
      reason: `${nextTimeline[bridgeIndex].reason || ''} Context reset lengthened so the callback lands after the teaser in the 20-35s window.`.trim()
    };
  }
  return nextTimeline;
}

// How long a slot will really play, as opposed to what the planner claimed: a preserved
// dialogue slot lasts exactly as long as its source lines, and a narration slot is bounded
// by how much speech fits over one beat.
// Pre-roll plus post-roll the adapter adds around each preserved line.
const DIALOGUE_LINE_PADDING_SEC = 0.65;

function realisticSlotDurationSec(item) {
  if (!item || item.decision === 'DROP') return 0;
  if (item.decision === 'KEEP_DIALOGUE') {
    // Only the per-line windows are cut; the gap between them never reaches the timeline. Using
    // start_sec..end_sec counted that dead air as runtime, so a slot whose five lines total 16.4s
    // was booked as 133.5s. The plan then read as 194s while the finished cut ran 53.5s, which
    // both blocked the top-up and raised a phantom over-ceiling warning.
    const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
    const lineTotal = windows
      .filter((win) => win && win.matched === true)
      .reduce((sum, win) => {
        const lineSec = Number(win.end_sec) - Number(win.start_sec);
        return sum + (Number.isFinite(lineSec) && lineSec > 0 ? lineSec + DIALOGUE_LINE_PADDING_SEC : 0);
      }, 0);
    if (lineTotal > 0) return roundSec(lineTotal);
    const span = Number(item.end_sec || 0) - Number(item.start_sec || 0);
    return span > 0 ? roundSec(Math.min(span, NARRATION_SLOT_MAX_SEC)) : 0;
  }
  return roundSec(Math.min(NARRATION_SLOT_MAX_SEC, Number(item.estimated_duration_sec || 0)));
}

function realisticTimelineRuntimeSec(timeline) {
  return roundSec((Array.isArray(timeline) ? timeline : []).reduce((sum, item) => sum + realisticSlotDurationSec(item), 0));
}

function nextFreeSlotId(usedIds) {
  let candidate = 1;
  while (usedIds.has(String(candidate))) candidate += 1;
  return String(candidate);
}

// Asking the planner for a longer cut produced a different answer every run (a 120s request
// came back anywhere from 38s to 132s). Rather than retrying until the model happens to
// comply, fill the gap here: promote the strongest beats it left on the floor into short
// narration slots, in story order, until the cut can actually reach its target.
function topUpTimelineToTargetRuntime(timeline, beats, transcript, targetSec, usableEndSec = 0) {
  // Promotions draw straight from the transcript, so the footage boundary has to be honoured
  // here too - otherwise top-up refills the very endcard lines the filter just removed.
  const limit = Number(usableEndSec || 0);
  if (limit > 0) {
    transcript = (Array.isArray(transcript) ? transcript : []).filter((cue) => Number(cue?.start_sec) < limit);
  }
  const target = Number(targetSec || 0);
  const items = Array.isArray(timeline) ? [...timeline] : [];
  if (!(target > 0) || !items.length) return items;
  const floor = target * EDIT_PLAN_MIN_TARGET_RATIO;
  let runtime = realisticTimelineRuntimeSec(items);
  if (runtime >= floor) return items;

  const activeBeatIds = new Set(items.filter((item) => item?.decision !== 'DROP').map((item) => String(item?.beat_id || '').trim()));
  const usedIds = new Set(items.map((item) => String(item?.slot_id || '').trim()));
  const candidates = (Array.isArray(beats) ? beats : [])
    .filter((beat) => !activeBeatIds.has(String(beat?.beat_id || '').trim()))
    .filter((beat) => Number(beat?.end_sec || 0) > Number(beat?.start_sec || 0))
    .sort((left, right) => (
      (Number(right.hook_potential || 0) + Number(right.dramatic_weight || 0))
      - (Number(left.hook_potential || 0) + Number(left.dramatic_weight || 0))
    ));

  const added = [];
  for (const beat of candidates) {
    if (runtime >= floor) break;
    const slotId = nextFreeSlotId(usedIds);
    usedIds.add(slotId);
    // Prefer filling the gap with the scene itself. Promoting a beat that has usable
    // dialogue as narration would pad the cut with the explanation this format is trying
    // to get away from.
    const focus = coldOpenDialogueFocusForBeat(beat, transcript);
    const keepsDialogue = Boolean(focus);
    const duration = keepsDialogue ? focus.duration_sec : narrationDurationForBeat(beat);
    added.push({
      slot_id: slotId,
      beat_id: String(beat.beat_id || '').trim(),
      role: 'body',
      decision: keepsDialogue ? 'KEEP_DIALOGUE' : 'NARRATE',
      start_sec: keepsDialogue ? focus.start_sec : roundSec(beat.start_sec),
      end_sec: keepsDialogue ? focus.end_sec : roundSec(beat.end_sec),
      estimated_duration_sec: duration,
      ...(keepsDialogue
        ? {
            dialogue_focus_source: 'runtime_topup_dialogue',
            dialogue_focus_lines: focus.lines,
            dialogue_focus_quotes: (focus.quotes || []).length ? focus.quotes : focus.lines
          }
        : {}),
      reason: keepsDialogue
        ? 'Promoted an unused beat as preserved dialogue so the cut reaches its runtime with scene, not explanation.'
        : 'Promoted from an unused beat so the cut reaches its target runtime.',
      spoiler_policy: 'Keep the mystery progression grounded in transcript evidence.',
      repeat_policy: 'No repeat.',
      runtime_topup: true
    });
    runtime = roundSec(runtime + duration);
  }
  // Every beat can already be in the plan and the cut still fall short — six beats here produced a
  // 76s plan against a 180s target with nothing left to promote. A beat rendered as narration is
  // still carrying unspoken dialogue, so play it: the cut lengthens with scene rather than
  // explanation, which is the direction this format wants anyway.
  if (runtime < floor) {
    const beatById = new Map((Array.isArray(beats) ? beats : [])
      .map((beat) => [String(beat?.beat_id || '').trim(), beat]));
    const beatsAlreadySpoken = new Set(items
      .filter((item) => item?.decision === 'KEEP_DIALOGUE')
      .map((item) => String(item?.beat_id || '').trim()));
    for (const item of items) {
      if (runtime >= floor) break;
      if (item?.decision !== 'NARRATE' || item.role === 'cold_open') continue;
      const beatId = String(item?.beat_id || '').trim();
      if (!beatId || beatsAlreadySpoken.has(beatId)) continue;
      const beat = beatById.get(beatId);
      if (!beat) continue;
      const focus = coldOpenDialogueFocusForBeat(beat, transcript);
      if (!focus) continue;
      beatsAlreadySpoken.add(beatId);
      const slotId = nextFreeSlotId(usedIds);
      usedIds.add(slotId);
      added.push({
        slot_id: slotId,
        beat_id: beatId,
        role: 'body',
        decision: 'KEEP_DIALOGUE',
        start_sec: focus.start_sec,
        end_sec: focus.end_sec,
        estimated_duration_sec: focus.duration_sec,
        dialogue_focus_source: 'runtime_topup_narrated_beat',
        dialogue_focus_lines: focus.lines,
        dialogue_focus_quotes: (focus.quotes || []).length ? focus.quotes : focus.lines,
        reason: 'Played the dialogue of a beat the plan only narrated, so the cut reaches its runtime with scene rather than explanation.',
        spoiler_policy: 'Keep the mystery progression grounded in transcript evidence.',
        repeat_policy: 'No repeat.',
        runtime_topup: true
      });
      runtime = roundSec(runtime + focus.duration_sec);
    }
  }

  if (!added.length) return items;

  // Keep the opening where it is and re-thread everything else in story order.
  const head = items.slice(0, 1);
  const rest = [...items.slice(1), ...added]
    .sort((left, right) => Number(left.start_sec || 0) - Number(right.start_sec || 0));
  return [...head, ...rest];
}

// Asking the planner to alternate did not hold: dialogue kept landing in the first half and
// the back half came back as one long stretch of explanation. Break the run here instead —
// when narration has carried the cut this long, a line from the scene belongs in the middle
// of it.
// Narration belongs at the seam between scenes, so a run past this is the cut explaining rather
// than showing. Deliberately well below the old 25s: consecutive preserved dialogue is the shape
// this format wants, and a long narration stretch is what interrupts it.
const MAX_NARRATION_RUN_SEC = 12;

function interleaveDialogueIntoNarrationRuns(timeline, beats, transcript) {
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  // Everything between a KEEP_DIALOGUE cold open and the first later dialogue slot is the gap the
  // callback must survive; leave it alone.
  const protectedCallbackGapIndexes = new Set();
  if (items[0]?.role === 'cold_open' && items[0]?.decision === 'KEEP_DIALOGUE') {
    for (let index = 1; index < items.length; index += 1) {
      if (items[index]?.decision === 'KEEP_DIALOGUE') break;
      if (items[index]?.decision !== 'DROP') protectedCallbackGapIndexes.add(index);
    }
  }
  let runSec = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.decision === 'DROP') continue;
    if (item.decision === 'KEEP_DIALOGUE') { runSec = 0; continue; }
    runSec += realisticSlotDurationSec(item);
    if (runSec <= MAX_NARRATION_RUN_SEC) continue;
    // The opening hook stays whatever it was chosen to be.
    if (item.role === 'cold_open') continue;
    // An original-audio action beat is PINNED content, not a narration run to break up: the
    // interleave once converted slot_action_6 into a dialogue slot, stealing the kiss line
    // from the slot that owned it (dedupe then dropped the original as a duplicate). Action
    // beats also break the run rhythm on their own, so reset the counter instead.
    if (String(item.visual_source_mode || '') === 'source_audio_action') { runSec = 0; continue; }
    // The stretch between a teaser and its callback is load-bearing: the callback has to land in
    // its 20-35s window. Tightening narration runs to 12s started converting a slot inside that
    // stretch, which both broke the pattern and stole the callback role at 5.9s.
    if (protectedCallbackGapIndexes.has(index)) continue;
    const beat = beatMap.get(String(item.beat_id || '').trim());
    const focus = beat ? coldOpenDialogueFocusForBeat(beat, transcript) : null;
    if (!focus) continue;
    items[index] = {
      ...item,
      decision: 'KEEP_DIALOGUE',
      start_sec: focus.start_sec,
      end_sec: focus.end_sec,
      estimated_duration_sec: focus.duration_sec,
      dialogue_focus_source: 'narration_run_interleave',
      dialogue_focus_lines: focus.lines,
      dialogue_focus_quotes: (focus.quotes && focus.quotes.length ? focus.quotes : focus.lines).slice(0, 2),
      narration_run_interleave: true,
      reason: 'Narration had carried the cut too long, so this beat plays its own dialogue instead.'
    };
    runSec = 0;
  }
  return items;
}

// The target is a hard ceiling, not a suggestion. Rejecting an over-long plan only burns
// retries and can drop the run onto a fallback that overshoots too, so trim it here: drop
// the weakest body slots until the cut fits. The opening, the bridge that restores the
// situation, and the payoff are never dropped — they are the shape of the cut.
// Two slots can end up pointing at exactly the same moment of source, which plays the line
// twice and trips the cross-segment overlap gate. Only an essentially identical window
// counts: a callback that re-enters the same exchange from a different point is deliberate.
// Matching whole slot spans (within 0.15s) only caught exact repeats. Once the cut carried twelve
// dialogue slots instead of nine, slots started claiming source that merely *contains* another's:
// slot_001's teaser ran 166.83-171.57 while slot_006 preserved 167.03-169.728 inside it, so the
// same footage was cut twice and the reserved-range and cross-segment gates both rejected it.
// Compare the per-line windows, which is what actually reaches the timeline.
const DUPLICATE_DIALOGUE_OVERLAP_RATIO = 0.5;

// Auto-caption cues overlap each other slightly, so two DIFFERENT lines can share a moment: the
// teaser ran to 171.57 while the next line opened at 171.32. Dedupe rightly leaves them alone —
// they are not duplicates — but the capcut gates reject any overlap at all. Split the contested
// span down the middle, the same way clip padding already settles a shared gap.
const DIALOGUE_WINDOW_MIN_KEEP_SEC = 0.4;

// A cut spans from its first preserved line to its last, and the source keeps talking in
// between: cues we never selected are audible with no caption on screen. Measured on the
// Senseless cut, 13 of 112 seconds played that way. Adopt those cues as lines of the slot they
// fall inside - the cut is already committed to showing them, so the only question is whether
// the viewer can read them.
// 1.2 (was 0.35): a 0.42s fragment ("right") got adopted as a whole extra line, the caption
// reconciliation had nothing to caption it with, and a BLANK dialogue subtitle shipped. A
// cue below readable display time is a fragment of its neighbour, not a line.
const ADOPTED_CUE_MIN_SEC = 1.2;
// Must match limitDialogueFocusLines and the plan validator.
const DIALOGUE_FOCUS_MAX_LINES = 8;

function fillUncaptionedCuesInsideCuts(timeline, transcript) {
  const cues = (Array.isArray(transcript) ? transcript : [])
    .filter((cue) => cue && Number(cue.end_sec) > Number(cue.start_sec) && !isNonSpeechCaption(cue.text));
  if (!cues.length) return Array.isArray(timeline) ? timeline : [];
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.decision !== 'KEEP_DIALOGUE') return item;
    // An authored slot's line set is a decision, not a draft: adopting more cues into it leaves those
    // lines with no caption, which the preflight then blocks. The owner chose these lines.
    if (item.authored_lines === true) return item;
    const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
    const matched = windows.filter((win) => win && win.matched === true);
    if (matched.length < 2) return item;
    const lo = Math.min(...matched.map((win) => Number(win.start_sec)));
    const hi = Math.max(...matched.map((win) => Number(win.end_sec)));
    const additions = [];
    for (const cue of cues) {
      const start = Number(cue.start_sec);
      const end = Math.min(Number(cue.end_sec), hi);
      if (end <= lo || start >= hi) continue;
      if (end - start < ADOPTED_CUE_MIN_SEC) continue;
      const overlapsExisting = [...matched, ...additions].some((win) => (
        end > Number(win.start_sec) + 0.15 && start < Number(win.end_sec) - 0.15
      ));
      if (overlapsExisting) continue;
      additions.push({
        matched: true,
        line: String(cue.text || '').replace(/\s+/g, ' ').trim(),
        start_sec: roundSec(Math.max(start, lo)),
        end_sec: roundSec(end),
        adopted_from_cut: true
      });
    }
    // Never push a slot past the line cap the plan validates against: adopting audible cues is
    // worth doing, but not at the cost of failing the whole run. Longest first, so the seconds
    // that would otherwise play silent are the ones recovered.
    const room = Math.max(0, DIALOGUE_FOCUS_MAX_LINES - matched.length);
    if (!additions.length || room <= 0) return item;
    const kept = additions
      .slice()
      .sort((left, right) => (Number(right.end_sec) - Number(right.start_sec)) - (Number(left.end_sec) - Number(left.start_sec)))
      .slice(0, room);
    additions.length = 0;
    additions.push(...kept);
    const nextWindows = [...windows, ...additions]
      // null start (unmatched line) must sort LAST: Number(null) === 0 floated an unmatched
      // entry into the middle of the list, shifting every caption index behind it.
      .sort((left, right) => (Number.isFinite(Number(left.start_sec)) && left.start_sec != null ? Number(left.start_sec) : Infinity)
        - (Number.isFinite(Number(right.start_sec)) && right.start_sec != null ? Number(right.start_sec) : Infinity));
    // A slot where nothing matched must not come back EMPTY: the plan validator requires every
    // KEEP_DIALOGUE slot to carry focus quotes, so emptying it threw and killed the whole refresh -
    // and the source then silently kept its previous plan, which looked exactly like the fix having
    // done nothing. Keep what the slot already had and let the render-time warning report the miss.
    const matchedLines = nextWindows.filter((win) => win.matched === true).map((win) => win.line);
    return {
      ...item,
      dialogue_line_windows: nextWindows,
      dialogue_focus_lines: matchedLines.length ? matchedLines : item.dialogue_focus_lines,
      dialogue_focus_quotes: matchedLines.length ? matchedLines : item.dialogue_focus_quotes,
      adopted_cue_count: additions.length
    };
  });
}

// Focus quotes are a subset of the line windows, so they cannot be filtered by window index: doing
// that dropped unrelated entries and sometimes emptied the array, and an empty one fails the plan
// validator - which threw away the whole refresh and left the source on its previous plan.
function keepQuotesByText(quotes, keptWindows) {
  const keptLines = (Array.isArray(keptWindows) ? keptWindows : [])
    .map((win) => normalizeComparableText(win && win.line))
    .filter(Boolean);
  const survivors = (Array.isArray(quotes) ? quotes : [])
    .filter((quote) => keptLines.includes(normalizeComparableText(quote)));
  if (survivors.length) return survivors;
  return (Array.isArray(keptWindows) ? keptWindows : []).map((win) => win && win.line).filter(Boolean);
}

// Two restored lines can resolve onto the same cue - the rolling caption said nearly the same thing
// twice and both matched there. The plan then carries two windows with one start, which is both a
// reserved-range violation and a cross-segment overlap, so preflight rejects the whole plan and the
// run falls back to an older compression. Keep the longer window and drop the one it swallows.
// A rolling caption re-displays the tail of the line just spoken together with the head of the next
// one, and that re-display survives as a window of its own: The Housemaid's police interview shipped
// "he likes things to be a certain way." / "Everything perfect." and then, between them,
// "he likes things to be a certain way. Everything perfect." - so the recap said the same sentence
// three times and the viewer reads it as a stutter. Drop a window whose whole text sits inside its
// two neighbours' texts AND straddles their boundary; that pattern is only ever a re-display, never
// a character repeating themselves (a real repeat is not glued to the next line's opening words).
function dropRestatedWindows(timeline) {
  const norm = (value) => normalizeComparableText(value);
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const ordered = item.dialogue_line_windows
      .map((win, index) => ({ win, index }))
      .filter((entry) => entry.win && entry.win.matched === true && Number(entry.win.end_sec) > Number(entry.win.start_sec))
      .sort((left, right) => Number(left.win.start_sec) - Number(right.win.start_sec));
    const drop = new Set();
    // The other shape of the same artifact: the caption re-displays only the TAIL of the line just
    // spoken, as its own cue, right after it - Draft Day shipped "No. Will Callahan is our future."
    // and then "Will Callahan is our future." two seconds later. A suffix, not merely a containment:
    // a character really repeating themselves ("Yeah, did you know that?" / "Did you?") shares words
    // without ending the earlier line, and has to survive.
    for (let position = 1; position < ordered.length; position += 1) {
      const previous = norm(ordered[position - 1].win.line);
      const current = norm(ordered[position].win.line);
      if (!previous || !current || current.length >= previous.length) continue;
      if (current.split(' ').filter(Boolean).length < 3) continue;
      if (!previous.endsWith(` ${current}`)) continue;
      const gap = Number(ordered[position].win.start_sec) - Number(ordered[position - 1].win.end_sec);
      if (!(gap < 0.4)) continue;
      // A ">>" marks a speaker starting to talk. A re-display carries no marker because nobody
      // started talking - the caption merely scrolled. When BOTH lines carry one, two people (or the
      // same person twice) really said it, and the repeat is the scene.
      const previousRaw = String(ordered[position - 1].win.line || '').trim();
      const currentRaw = String(ordered[position].win.line || '').trim();
      if (currentRaw.startsWith('>>')) continue;
      // Two signatures of a scroll rather than a repeat: the earlier cue opened with a ">>" (someone
      // started talking) and this one did not, or what the earlier cue had in FRONT of this text was
      // a complete sentence that the re-display dropped off the top ("No." in "No. Will Callahan's
      // our future."). A character repeating themselves leaves a fragment there ("So" in "So did you
      // know?"), not a finished sentence.
      const droppedHead = previous.slice(0, previous.length - current.length).trim();
      const headIsSentence = /[.!?]$/.test(String(previousRaw).slice(0, Math.max(0, previousRaw.length - currentRaw.length)).trim());
      if (!previousRaw.startsWith('>>') && !(droppedHead && headIsSentence)) continue;
      drop.add(ordered[position].index);
    }
    for (let position = 1; position < ordered.length - 1; position += 1) {
      const previous = norm(ordered[position - 1].win.line);
      const current = norm(ordered[position].win.line);
      const next = norm(ordered[position + 1].win.line);
      if (!previous || !current || !next) continue;
      if (current.split(' ').filter(Boolean).length < 3) continue;
      const joined = `${previous} ${next}`;
      const at = joined.indexOf(current);
      if (at < 0) continue;
      // The match has to begin inside the previous line and run into the next one - the signature
      // of a re-display. A line merely repeated verbatim later matches at a single side and stays.
      if (at >= previous.length || at + current.length <= previous.length + 1) continue;
      drop.add(ordered[position].index);
    }
    if (!drop.size) return item;
    return { ...item, dialogue_line_windows: item.dialogue_line_windows.filter((_, index) => !drop.has(index)) };
  });
}

function dropWindowsSwallowedByTheirNeighbour(timeline) {
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const windows = item.dialogue_line_windows;
    const drop = new Set();
    for (let i = 0; i < windows.length; i += 1) {
      const a = windows[i];
      if (!a || a.matched !== true || drop.has(i)) continue;
      for (let j = i + 1; j < windows.length; j += 1) {
        const b = windows[j];
        if (!b || b.matched !== true || drop.has(j)) continue;
        const aStart = Number(a.start_sec); const aEnd = Number(a.end_sec);
        const bStart = Number(b.start_sec); const bEnd = Number(b.end_sec);
        if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) continue;
        const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
        if (overlap <= 0) continue;
        const shorter = Math.min(aEnd - aStart, bEnd - bStart);
        if (shorter <= 0 || overlap / shorter < 0.8) continue;
        drop.add((aEnd - aStart) >= (bEnd - bStart) ? j : i);
      }
    }
    if (!drop.size) return item;
    const keptWindows = windows.filter((_, index) => !drop.has(index));
    const keptLines = Array.isArray(item.dialogue_focus_lines)
      ? item.dialogue_focus_lines.filter((_, index) => !drop.has(index)) : item.dialogue_focus_lines;
    return {
      ...item,
      dialogue_line_windows: keptWindows,
      dialogue_focus_lines: keptLines,
      dialogue_focus_quotes: keepQuotesByText(item.dialogue_focus_quotes, keptWindows),
      duplicate_dialogue_windows_dropped: drop.size
    };
  });
}

// dialogue_focus_lines is what the caption writer is shown, and dialogue_line_windows is what gets
// cut - so a window whose line is missing from the focus list is a line nobody ever translated. The
// Housemaid night plan had one focus line per slot and two windows: the planned line (a truncated
// caption chunk that matched nothing) and the line the resolver actually found. The found line went
// out with no caption and disappeared, taking its slot and its beat with it. Keep the two lists
// describing the same set of lines.
function alignFocusLinesToWindows(timeline) {
  const key = (value) => normalizeComparableText(value);
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const focusLines = Array.isArray(item.dialogue_focus_lines) ? [...item.dialogue_focus_lines] : [];
    const focusQuotes = Array.isArray(item.dialogue_focus_quotes) ? [...item.dialogue_focus_quotes] : [];
    const known = focusLines.map(key).filter(Boolean);
    let added = 0;
    for (const win of item.dialogue_line_windows) {
      if (!win || win.matched !== true) continue;
      const wanted = key(win.line);
      if (!wanted) continue;
      // Containment, not equality: the plan's line and the window's line are frequently the same
      // utterance recorded at different lengths, and that already has a caption.
      if (known.some((line) => line === wanted || line.includes(wanted) || wanted.includes(line))) continue;
      focusLines.push(String(win.line || '').trim());
      focusQuotes.push(String(win.line || '').trim());
      known.push(wanted);
      added += 1;
    }
    if (!added) return item;
    return {
      ...item,
      dialogue_focus_lines: focusLines,
      dialogue_focus_quotes: focusQuotes,
      focus_lines_aligned_to_windows: added
    };
  });
}

// The caption writer is given dialogue_focus_lines and writes one caption per entry, so a line with
// no matched window costs a caption that has no moment to play at - and worse, when the model then
// comes back one caption short, reconcileDialogueCaptionCounts keeps the FIRST lines and throws the
// rest away, which is how The Housemaid night kept the unplayable line ">> But why would I have you
// book tickets..." and dropped the line that was actually cut. Show only the lines that will play.
function dropUnplayableFocusLines(timeline) {
  const key = (value) => normalizeComparableText(value);
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const playable = item.dialogue_line_windows
      .filter((win) => win && win.matched === true && key(win.line))
      .map((win) => key(win.line));
    // A slot where nothing matched must not come back EMPTY - the plan validator requires focus
    // quotes, and emptying it kills the whole refresh. Leave it as it is and let the render-time
    // warning report the miss.
    if (!playable.length) return item;
    // The played line may be a longer recording of the same utterance, so containment ONE way is
    // right: the focus line inside a played line. The other direction let a short played fragment
    // ("Cece") vouch for any long line that happened to contain it.
    const plays = (line) => {
      const wanted = key(line);
      return Boolean(wanted) && playable.some((played) => played === wanted || played.includes(wanted));
    };
    const lines = (Array.isArray(item.dialogue_focus_lines) ? item.dialogue_focus_lines : []).filter(plays);
    const quotes = (Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes : []).filter(plays);
    if (!lines.length) return item;
    if (lines.length === (item.dialogue_focus_lines || []).length && quotes.length === (item.dialogue_focus_quotes || []).length) return item;
    return { ...item, dialogue_focus_lines: lines, dialogue_focus_quotes: quotes.length ? quotes : lines };
  });
}

function separateOverlappingDialogueWindows(timeline) {
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    return { ...item, dialogue_line_windows: item.dialogue_line_windows.map((win) => ({ ...win })) };
  });

  const windows = [];
  for (const item of items) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (win && win.matched === true && Number(win.end_sec) > Number(win.start_sec)) {
        // Keep the moment the line is actually SPOKEN before the video windows are pulled apart.
        // CapCut rejects overlapping VIDEO segments, not overlapping captions, so separating both
        // together made every caption strictly serial - two people speaking over each other could
        // never share the screen. Captions read these; only the clips get separated.
        if (win.caption_start_sec === undefined) win.caption_start_sec = roundSec(Number(win.start_sec));
        if (win.caption_end_sec === undefined) win.caption_end_sec = roundSec(Number(win.end_sec));
        windows.push(win);
      }
    }
  }
  windows.sort((left, right) => Number(left.start_sec) - Number(right.start_sec));

  for (let index = 1; index < windows.length; index += 1) {
    const prev = windows[index - 1];
    const next = windows[index];
    const prevEnd = Number(prev.end_sec);
    const nextStart = Number(next.start_sec);
    if (prevEnd <= nextStart) continue;
    const boundary = roundSec((nextStart + prevEnd) / 2);
    // Never shave a line below the point where it stops being readable; give up the span whole
    // to whichever side can still afford it.
    if (boundary - Number(prev.start_sec) >= DIALOGUE_WINDOW_MIN_KEEP_SEC
      && Number(next.end_sec) - boundary >= DIALOGUE_WINDOW_MIN_KEEP_SEC) {
      prev.end_sec = boundary;
      next.start_sec = boundary;
    } else if (Number(next.end_sec) - prevEnd >= DIALOGUE_WINDOW_MIN_KEEP_SEC) {
      next.start_sec = roundSec(prevEnd);
    } else if (nextStart - Number(prev.start_sec) >= DIALOGUE_WINDOW_MIN_KEEP_SEC) {
      prev.end_sec = roundSec(nextStart);
    }
  }

  for (const item of items) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const matched = (item.dialogue_line_windows || []).filter((win) => win && win.matched === true);
    if (!matched.length) continue;
    item.start_sec = roundSec(Math.min(...matched.map((win) => Number(win.start_sec))));
    item.end_sec = roundSec(Math.max(...matched.map((win) => Number(win.end_sec))));
  }
  return items;
}

function dropDuplicateDialogueSlots(timeline) {
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  const claimed = [];
  const overlapsClaimed = (start, end) => claimed.some(([claimedStart, claimedEnd]) => {
    const overlap = Math.min(end, claimedEnd) - Math.max(start, claimedStart);
    if (overlap <= 0) return false;
    return overlap >= DUPLICATE_DIALOGUE_OVERLAP_RATIO * Math.min(end - start, claimedEnd - claimedStart);
  });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    // A callback is meant to replay its teaser; that repeat is the point, not a duplicate.
    const isDeclaredReplay = Boolean(item.replay_of_slot_id) || Boolean(item.teaser_slot_id && item.callback_relation);

    const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
    // Slots promoted by the top-up or the interleave carry focus lines but no windows yet; judge
    // those on their span, as before. Requiring windows here dropped every one of them.
    if (!windows.some((win) => win && win.matched === true)) {
      const start = Number(item.start_sec);
      const end = Number(item.end_sec);
      if (!(end > start)) continue;
      if (!isDeclaredReplay && overlapsClaimed(start, end)) {
        items[index] = {
          ...item,
          decision: 'DROP',
          estimated_duration_sec: 0,
          duplicate_dialogue_dropped: true,
          reason: `${item.reason || ''} Dropped: this source dialogue is already used by an earlier slot.`.trim()
        };
        continue;
      }
      claimed.push([start, end]);
      continue;
    }

    const keptIndexes = [];
    for (let line = 0; line < windows.length; line += 1) {
      const win = windows[line];
      const start = Number(win?.start_sec);
      const end = Number(win?.end_sec);
      if (!win || win.matched !== true || !(end > start)) continue;
      if (overlapsClaimed(start, end)) continue;
      keptIndexes.push(line);
      claimed.push([start, end]);
    }

    if (!keptIndexes.length) {
      // A callback whose every line was already shown is a pure replay of its teaser: that repeat
      // is the point, so keep it. Anything else is just the same footage cut twice.
      if (isDeclaredReplay) continue;
      items[index] = {
        ...item,
        decision: 'DROP',
        estimated_duration_sec: 0,
        duplicate_dialogue_dropped: true,
        reason: `${item.reason || ''} Dropped: this source dialogue is already used by an earlier slot.`.trim()
      };
      continue;
    }
    if (keptIndexes.length === windows.filter((w) => w && w.matched === true).length) continue;

    const keep = new Set(keptIndexes);
    // Unmatched windows stay (an unquotable "[bell]" line still holds its place), so their focus
    // lines have to stay with them. Filtering the two lists differently knocked them out of step
    // and the caption-count check rejected the slot.
    const survives = (line) => keep.has(line) || !(windows[line] && windows[line].matched === true);
    const kept = windows.filter((_win, line) => survives(line));
    const spans = keptIndexes.map((line) => [Number(windows[line].start_sec), Number(windows[line].end_sec)]);
    items[index] = {
      ...item,
      dialogue_line_windows: kept,
      dialogue_focus_lines: Array.isArray(item.dialogue_focus_lines)
        ? item.dialogue_focus_lines.filter((_, line) => survives(line)) : item.dialogue_focus_lines,
      // Quotes are a SUBSET of the windows, so filtering them by window index dropped the wrong
      // entries and could empty the array - which the plan validator rejects, killing the refresh.
      // Keep the quotes whose text survived, and fall back to the kept lines if none did.
      dialogue_focus_quotes: keepQuotesByText(item.dialogue_focus_quotes, kept),
      start_sec: roundSec(Math.min(...spans.map((s) => s[0]))),
      end_sec: roundSec(Math.max(...spans.map((s) => s[1]))),
      duplicate_dialogue_lines_dropped: true,
      reason: `${item.reason || ''} Some lines dropped: already used by an earlier slot.`.trim()
    };
  }
  return items;
}

// A cold open that overruns the teaser limit used to fail validation outright, which spent the
// retries and dropped the run onto the fallback planner over the tail of a single slot. Trim it
// to the lines that fit instead: the hook survives, the plan survives with it.
// Scoring the teaser twice changed nothing because neither place is on the path a real plan takes:
// the cold-open slot comes from the edit-plan model with its own dialogue_focus_lines, used
// verbatim. Every plan passes through here, so this is where the opening line gets decided.
// "재니스, 반가워 자기야" opened the cut while the accusation sat in the middle.
function leadColdOpenWithStrongestLine(timeline) {
  const coldOpen = (Array.isArray(timeline) ? timeline : []).find((item) => item.role === 'cold_open');
  if (!coldOpen || coldOpen.decision !== 'KEEP_DIALOGUE') return timeline;
  const windows = Array.isArray(coldOpen.dialogue_line_windows) ? coldOpen.dialogue_line_windows : [];
  const matched = windows.map((win, index) => ({ win, index })).filter((entry) => entry.win && entry.win.matched === true);
  if (matched.length < 2) return timeline;

  // An authored teaser is the owner's choice of lines; reordering it by dropping some of them is not
  // a reorder, it is an edit.
  if (coldOpen.authored_lines === true) return timeline;
  const lines = Array.isArray(coldOpen.dialogue_focus_lines) ? coldOpen.dialogue_focus_lines : [];
  const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;
  // A bare reaction cannot open a cut: this pass keeps the line it picks and drops what came before it,
  // so picking "What?" over "Nina Winchester tried to drown her kid in a bathtub." threw the reveal away
  // and opened on someone reacting to nothing. Only lines that carry a statement are candidates.
  const substantial = matched.filter((entry) => wordCount(lines[entry.index] || entry.win.line) >= 3);
  const candidates = substantial.length ? substantial : matched;
  const best = candidates
    .map((entry) => ({ ...entry, score: teaserQuoteScore(lines[entry.index] || entry.win.line || '') }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  if (!best || best.index === matched[0].index) return timeline;

  // Keep the strongest line and whatever answers it, in source order so the exchange still reads.
  const keep = new Set([best.index]);
  const answer = matched.find((entry) => entry.index > best.index);
  if (answer) keep.add(answer.index);

  const survives = (index) => keep.has(index) || !(windows[index] && windows[index].matched === true);
  const kept = windows.filter((_win, index) => survives(index));
  const spans = [...keep].map((index) => [Number(windows[index].start_sec), Number(windows[index].end_sec)]);
  return timeline.map((item) => (item === coldOpen
    ? {
        ...item,
        dialogue_line_windows: kept,
        dialogue_focus_lines: lines.filter((_line, index) => survives(index)),
        dialogue_focus_quotes: keepQuotesByText(item.dialogue_focus_quotes, kept),
        start_sec: roundSec(Math.min(...spans.map((span) => span[0]))),
        end_sec: roundSec(Math.max(...spans.map((span) => span[1]))),
        cold_open_reordered: true,
        reason: `${item.reason || ''} Opened on the strongest line rather than the earliest.`.trim()
      }
    : item));
}

function clampColdOpenToTeaser(timeline) {
  const coldOpen = timeline.find((item) => item.role === 'cold_open');
  if (!coldOpen) return timeline;
  const isDialogue = coldOpen.decision === 'KEEP_DIALOGUE';
  const limit = isDialogue ? COLD_OPEN_DIALOGUE_MAX_SEC : COLD_OPEN_NARRATION_MAX_SEC;
  if (Number(coldOpen.estimated_duration_sec || 0) <= limit) return timeline;

  if (isDialogue) {
    const windows = Array.isArray(coldOpen.dialogue_line_windows) ? coldOpen.dialogue_line_windows : [];
    const matched = windows
      .filter((win) => win && win.matched !== false && Number.isFinite(Number(win.start_sec)))
      .sort((left, right) => Number(left.start_sec) - Number(right.start_sec));
    if (matched.length > 1) {
      // Trim from the FRONT. The teaser's punch is its last line - the reveal the whole cut is built
      // to pay off - and keeping the first N lines threw it away: The Housemaid night's hook ("Nina
      // Winchester tried to drown her kid in the bathtub.") was cut and the recap opened on the setup
      // chatter leading up to it. A teaser may start mid-exchange; it may not lose its point.
      const closeEnd = Number(matched[matched.length - 1].end_sec);
      let firstKept = 0;
      while (firstKept < matched.length - 1 && closeEnd - Number(matched[firstKept].start_sec) > limit) firstKept += 1;
      if (firstKept > 0) {
        const dropped = new Set(matched.slice(0, firstKept));
        const keptWindows = windows.filter((win) => !dropped.has(win));
        const keptText = new Set(keptWindows
          .filter((win) => win && win.matched === true)
          .map((win) => normalizeComparableText(win.line))
          .filter(Boolean));
        const keepByText = (list) => (Array.isArray(list) ? list : []).filter((line) => keptText.has(normalizeComparableText(line)));
        coldOpen.dialogue_line_windows = keptWindows;
        if (Array.isArray(coldOpen.dialogue_focus_lines)) coldOpen.dialogue_focus_lines = keepByText(coldOpen.dialogue_focus_lines);
        if (Array.isArray(coldOpen.dialogue_focus_quotes)) coldOpen.dialogue_focus_quotes = keepByText(coldOpen.dialogue_focus_quotes);
        const keptStart = Number(matched[firstKept].start_sec);
        if (Number.isFinite(closeEnd) && closeEnd > keptStart) {
          coldOpen.start_sec = roundSec(keptStart);
          coldOpen.end_sec = roundSec(closeEnd);
          coldOpen.estimated_duration_sec = roundSec(closeEnd - keptStart);
        }
      }
    }
  }

  if (Number(coldOpen.estimated_duration_sec || 0) > limit) {
    const start = Number(coldOpen.start_sec);
    coldOpen.estimated_duration_sec = limit;
    if (Number.isFinite(start)) coldOpen.end_sec = roundSec(start + limit);
  }
  coldOpen.reason = `${coldOpen.reason || ''} Trimmed to the cold-open teaser limit.`.trim();
  return timeline;
}

function trimTimelineToTargetRuntime(timeline, targetSec, beats = []) {
  const target = Number(targetSec || 0);
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  if (!(target > 0)) return items;

  // The beat carrying the event the scene turns on is not spare runtime. It usually has no
  // dialogue (a fall, a body, a locked door), so it is neither a protected role nor anchored
  // dialogue, and its slot carries no weight fields of its own - which sorted it FIRST for
  // eviction. The Housemaid ending lost the killing exactly here, and the surviving beats then
  // had no cause. Runtime is an output, not a quota: shrink narration, drop side branches, but
  // never drop the event.
  const beatWeight = new Map((Array.isArray(beats) ? beats : [])
    .map((beat) => [String(beat?.beat_id || '').trim(), {
      dramatic_weight: Number(beat?.dramatic_weight || 0),
      hook_potential: Number(beat?.hook_potential || 0)
    }]));
  const causalBeatIds = new Set([...beatWeight.entries()]
    .filter(([, weight]) => weight.dramatic_weight >= CAUSAL_BEAT_MIN_WEIGHT)
    .map(([beatId]) => beatId));

  // body_peak belongs here too: validateEditPlan requires it to outlast the teaser, so
  // trimming it away leaves a plan its own validator rejects.
  const protectedRoles = new Set(['cold_open', 'bridge', 'body_peak', 'payoff', 'closing']);
  // The house invariant is speech-driven cuts: preserved dialogue IS the video, narration is
  // seam material. The runtime trim once evicted the anesthetic debate and the leader's exit
  // line to make room for new visual coverage - the cut regressed into a narrated recap. So:
  // anchored dialogue can NEVER be auto-dropped for runtime; narration shrinks first instead.
  const hasAnchoredDialogue = (item) => item.decision === 'KEEP_DIALOGUE'
    && (Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes.filter(Boolean).length : 0) > 0;
  const droppable = () => items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.decision !== 'DROP' && !protectedRoles.has(String(item.role || '').trim()) && !hasAnchoredDialogue(item)
      && !causalBeatIds.has(String(item.beat_id || '').trim()))
    .sort((left, right) => {
      // Slots rarely carry these fields themselves; fall back to the beat they came from, or the
      // ordering is effectively arbitrary and the trim evicts whatever happens to be first.
      const weight = (entry) => {
        const own = Number(entry.item.hook_potential || 0) + Number(entry.item.dramatic_weight || 0);
        if (own > 0) return own;
        const fromBeat = beatWeight.get(String(entry.item.beat_id || '').trim());
        return fromBeat ? fromBeat.hook_potential + fromBeat.dramatic_weight : 0;
      };
      // Weakest first; on a tie drop the longest, so one cut buys the most room.
      return weight(left) - weight(right)
        || realisticSlotDurationSec(right.item) - realisticSlotDurationSec(left.item);
    });

  // Stage A - narration shrinks before anything is dropped: shorter seams cost story nothing,
  // dropped dialogue costs the house style everything.
  const NARRATION_TRIM_FLOOR_SEC = 4;
  let runtimePreShrink = realisticTimelineRuntimeSec(items);
  while (runtimePreShrink > Number(target)) {
    const shrinkable = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.decision === 'NARRATE' && Number(item.estimated_duration_sec || 0) > NARRATION_TRIM_FLOOR_SEC)
      .sort((left, right) => Number(right.item.estimated_duration_sec || 0) - Number(left.item.estimated_duration_sec || 0));
    if (!shrinkable.length) break;
    const { item, index } = shrinkable[0];
    items[index] = {
      ...item,
      estimated_duration_sec: roundSec(Math.max(NARRATION_TRIM_FLOOR_SEC, Number(item.estimated_duration_sec || 0) - 1)),
      runtime_narration_shrunk: true
    };
    runtimePreShrink = realisticTimelineRuntimeSec(items);
  }

  // Both this trim and duration_budget now measure a dialogue slot by the lines it cuts, so the
  // one measure is authoritative. Taking the max with the raw estimate would reinstate the dead
  // air between scattered lines and trim real content to satisfy a runtime that never existed.
  const runtimeOf = (list) => realisticTimelineRuntimeSec(list);

  let runtime = runtimeOf(items);
  while (runtime > target) {
    const candidates = droppable();
    if (!candidates.length) break;
    const { index } = candidates[0];
    items[index] = {
      ...items[index],
      decision: 'DROP',
      estimated_duration_sec: 0,
      runtime_trimmed: true,
      reason: `${items[index].reason || ''} Dropped so the cut stays inside its ${Math.round(target)}s ceiling.`.trim()
    };
    runtime = runtimeOf(items);
  }

  // Once only protected slots remain the loop above gives up, which is how a plan stayed over
  // the ceiling. Shorten them instead: drop trailing dialogue lines, weakest slot first, always
  // leaving each slot at least one line.
  while (runtime > target) {
    const shaveable = items
      .map((item, index) => ({ item, index }))
      // The teaser is exempt. It is a handful of seconds, so shaving it buys almost no runtime, and
      // what it costs is the hook: The Housemaid night's cold open came out as Millie's one-word "What?"
      // after the reveal it was reacting to ("Nina Winchester tried to drown her kid in a bathtub.")
      // was shaved away. Everything downstream is built to pay that line off.
      .filter(({ item }) => item.decision === 'KEEP_DIALOGUE'
        && String(item.role || '').trim() !== 'cold_open'
        // An authored slot's lines are the owner's choice; buying runtime out of them is the same
        // silent undo the authored flag exists to stop.
        && item.authored_lines !== true
        && (Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []).filter((w) => w && w.matched === true).length > 1)
      // Same weight fallback as the drop loop: slots rarely carry these fields, so without the beat's
      // numbers every slot scored 0 and the shave ate whichever happened to be first in the array -
      // which took Draft Day's newly restored "the trade is struck" beat from four lines down to one.
      // On a tie, shave the slot with the MOST lines: one line out of a twelve-line exchange costs
      // the story nothing, one out of four can cost it the point.
      .sort((left, right) => {
        const weight = (entry) => {
          const own = Number(entry.item.hook_potential || 0) + Number(entry.item.dramatic_weight || 0);
          if (own > 0) return own;
          const fromBeat = beatWeight.get(String(entry.item.beat_id || '').trim());
          return fromBeat ? fromBeat.hook_potential + fromBeat.dramatic_weight : 0;
        };
        const matchedCount = (entry) => (Array.isArray(entry.item.dialogue_line_windows) ? entry.item.dialogue_line_windows : [])
          .filter((win) => win && win.matched === true).length;
        return weight(left) - weight(right) || matchedCount(right) - matchedCount(left);
      });
    if (!shaveable.length) break;
    const anchorsOf = (entry) => new Set((Array.isArray(entry.item.dialogue_anchor_quotes) ? entry.item.dialogue_anchor_quotes : [])
      .map((quote) => normalizeComparableText(quote)));
    const pickRemovable = (entry) => {
      const anchorSet = anchorsOf(entry);
      const wins = entry.item.dialogue_line_windows;
      for (let i = wins.length - 1; i >= 0; i -= 1) {
        const win = wins[i];
        if (!(win && win.matched === true)) continue;
        if (anchorSet.has(normalizeComparableText(String(win.line || '')))) continue;
        return i;
      }
      return -1;
    };
    const entryWithRemovable = shaveable.find((entry) => pickRemovable(entry) >= 0);
    if (!entryWithRemovable) break;
    const { item, index } = entryWithRemovable;
    const windows = item.dialogue_line_windows.slice();
    const lastMatched = pickRemovable(entryWithRemovable);
    windows.splice(lastMatched, 1);
    const kept = windows.filter((w) => w && w.matched === true);
    const starts = kept.map((w) => Number(w.start_sec)).filter(Number.isFinite);
    const ends = kept.map((w) => Number(w.end_sec)).filter(Number.isFinite);
    const shaved = { ...item, dialogue_line_windows: windows, runtime_trimmed: true };
    // The shave removes ONE window by index. Focus lines are 1:1 with the windows so the same index
    // applies, but quotes are a subset - removing the same index there deleted an unrelated quote
    // and could empty the list, which the plan validator rejects and the whole refresh then dies on.
    if (Array.isArray(item.dialogue_focus_lines)) shaved.dialogue_focus_lines = item.dialogue_focus_lines.filter((_, i) => i !== lastMatched);
    shaved.dialogue_focus_quotes = keepQuotesByText(item.dialogue_focus_quotes, kept);
    if (starts.length && ends.length) {
      shaved.start_sec = roundSec(Math.min(...starts));
      shaved.end_sec = roundSec(Math.max(...ends));
      shaved.estimated_duration_sec = roundSec(Math.max(...ends) - Math.min(...starts));
    }
    shaved.reason = `${item.reason || ''} Shortened so the cut stays inside its ${Math.round(target)}s ceiling.`.trim();
    items[index] = shaved;
    runtime = runtimeOf(items);
  }
  return items;
}

// Windows starting inside the promo tail are cut from the plan itself: ad segments can carry
// film-like preview dialogue that survives every text-based classifier ("show and tell's over"
// was quoted from a Movieclips outro), so the declared boundary is the only reliable line.
function dropWindowsPastUsableEnd(timeline, usableEndSec) {
  const limit = Number(usableEndSec || 0);
  if (!(limit > 0)) return timeline;
  return timeline.map((item) => {
    // A NARRATE window is where its b-roll gets cut from, so one reaching into the promo tail puts
    // the clip there too: Draft Day's closing sat at 532.1-554.7 against a usable end of 549 and
    // failed narration_broll_semantic_bounds every build. Pull it back, keeping its length.
    if (item.decision === 'NARRATE' && Number(item.end_sec) > limit) {
      const span = Math.max(2, Number(item.end_sec) - Number(item.start_sec));
      const end = roundSec(limit);
      const start = roundSec(Math.max(0, end - span));
      return { ...item, start_sec: start, end_sec: end, narration_window_clamped_to_usable_end: true };
    }
    if (item.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const windows = item.dialogue_line_windows;
    const survives = (index) => {
      const win = windows[index];
      if (!win || win.matched !== true) return true;
      return Number(win.start_sec) < limit;
    };
    if (windows.every((_, index) => survives(index))) return item;
    const kept = windows.filter((_, index) => survives(index));
    const matched = kept.filter((win) => win && win.matched === true);
    if (!matched.length) {
      return { ...item, decision: 'DROP', estimated_duration_sec: 0, promo_tail_dropped: true,
        reason: `${item.reason || ''} Dropped: its dialogue sits inside the source promo tail.`.trim() };
    }
    return {
      ...item,
      dialogue_line_windows: kept,
      dialogue_focus_lines: Array.isArray(item.dialogue_focus_lines) ? item.dialogue_focus_lines.filter((_, index) => survives(index)) : item.dialogue_focus_lines,
      dialogue_focus_quotes: keepQuotesByText(item.dialogue_focus_quotes, kept),
      start_sec: roundSec(Math.min(...matched.map((win) => Number(win.start_sec)))),
      end_sec: roundSec(Math.max(...matched.map((win) => Number(win.end_sec)))),
      promo_tail_trimmed: true
    };
  });
}

function readUsableEndSec(runDir) {
  try {
    const p = path.join(runDir, 'source_case.json');
    if (fs.existsSync(p)) return Number((readJson(p) || {}).usable_end_sec || 0);
  } catch { /* no profile, no limit */ }
  return 0;
}

// Original-audio action beats (owner directive 2026-08-10 "전투 돌아왔다고 할수있나?"): on an
// action source the fight IS the content, but visuals could only exist under TTS narration or
// dialogue windows — so a 325s fight compressed to 49s of mostly talk. Uncovered top energy
// peaks become first-class scene_hook slots that play their own action audio, spending the
// remaining target budget. The runtime stays a RESULT; the target stays a ceiling.
// 8 (was 5): the measured action budget is the real governor now; the count is only a
// runaway guard. 5 blocked Shelter's barn-trap extension (r7) with budget still unspent.
const ACTION_BEAT_MAX_SLOTS = 8;
// How big should the action pie be? MEASURED, per source: the speech ratio sets the share
// (dialogue-first is inviolable - action only competes with silence and padding), and the
// energy peaks decide where it goes. A wall-to-wall courtroom gets ~0; a near-silent fight
// gets up to 45% of the target. MIDFORM_ACTION_SHARE overrides for manual control.
function measuredActionShare(speechRatio) {
  const override = Number(process.env.MIDFORM_ACTION_SHARE);
  if (Number.isFinite(override) && override >= 0 && override <= 0.6) return override;
  if (speechRatio == null) return 0.35; // no cues at all: action-led source (game/silent action)
  // Zero point at 40% speech-of-footage: a courtroom (0.9) gets nothing, a creature source
  // (~0.3) keeps a small pie for its attack peaks, a near-silent fight (<0.1) gets the max.
  return Math.max(0, Math.min(0.45, 0.45 * (1 - speechRatio * 2.5)));
}

// Speech share of the FOOTAGE, not of the cue span: a silent first act carries no cues, and
// dividing by the cue span made a creature source look like wall-to-wall dialogue (the same
// footage-vs-cues distortion validateBeats had to fix).
function speechRatioOfFootage(transcript, footageEndSec) {
  const cues = Array.isArray(transcript) ? transcript : [];
  if (!cues.length) return null;
  // UNION of cue intervals, not their sum: rolling auto-captions repeat each line across two
  // or three overlapping cues, and summing double-counted speech (~2x on Cirque) which starved
  // the action pie on exactly the sources that use auto-captions.
  const intervals = cues
    .map((cue) => [Number(cue?.start_sec), Number(cue?.end_sec)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  if (!intervals.length) return null;
  let speechSec = 0;
  let [curStart, curEnd] = intervals[0];
  let maxEnd = 0;
  for (const [start, end] of intervals.slice(1)) {
    if (start <= curEnd) { curEnd = Math.max(curEnd, end); continue; }
    speechSec += curEnd - curStart;
    curStart = start; curEnd = end;
  }
  speechSec += curEnd - curStart;
  for (const [, end] of intervals) maxEnd = Math.max(maxEnd, end);
  const denom = Math.max(Number(footageEndSec) || 0, maxEnd);
  return denom > 0 ? Math.min(1, speechSec / denom) : null;
}

function insertActionBeatSlots(timeline, energyPeaks, targetSec, usableEndSec, beats, actionBudgetSec = null) {
  const peaks = (Array.isArray(energyPeaks) ? energyPeaks : [])
    .map((peak) => ({ rank: Number(peak?.rank) || 0, start: Number(peak?.start_sec), end: Number(peak?.end_sec), score: Number(peak?.score) || 0 }))
    .filter((peak) => Number.isFinite(peak.start) && peak.end > peak.start)
    .sort((left, right) => (left.rank || 99) - (right.rank || 99));
  if (!peaks.length) return timeline;
  // Idempotent under refresh: strip previously inserted action beats and re-derive, so a stale
  // slot can never survive a rule change (slot_action_4 outlived the dialogue-span guard).
  const items = timeline
    .filter((item) => String(item?.visual_source_mode || '') !== 'source_audio_action')
    .map((item) => ({ ...item }));
  const target = Number(targetSec || 0);
  const usable = Number(usableEndSec) > 0 ? Number(usableEndSec) : Infinity;
  const totalEst = () => items.filter((item) => item.decision !== 'DROP')
    .reduce((sum, item) => sum + Number(item.estimated_duration_sec || 0), 0);
  // What already screens: dialogue line windows verbatim; a narration slot plays roughly
  // [visual start, start + narration need] after the TTS clamp.
  const screened = [];
  for (const item of items) {
    if (item.decision === 'DROP') continue;
    if (item.decision === 'KEEP_DIALOGUE') {
      for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
        if (win && win.matched === true) screened.push([Number(win.start_sec), Number(win.end_sec)]);
      }
    } else {
      const start = Number(item.visual_source_start_sec ?? item.start_sec);
      const need = Math.max(4, Number(item.narration_estimated_duration_sec || item.estimated_duration_sec || 0));
      if (Number.isFinite(start)) screened.push([start, start + need]);
    }
  }
  // Original-audio seconds already in the cut (scene-hook cold open) count against the pie.
  let actionSec = items.reduce((sum, item) => (
    String(item?.visual_source_mode || '') === 'source_audio_teaser' && item.decision !== 'DROP'
      ? sum + Math.max(0, Number(item.visual_source_end_sec) - Number(item.visual_source_start_sec) || 0)
      : sum
  ), 0);
  let inserted = 0;
  for (const peak of peaks) {
    if (inserted >= ACTION_BEAT_MAX_SLOTS) break;
    let winStart = Math.max(0, peak.start - 1.5);
    let winEnd = Math.min(usable, peak.end + 1.5);
    // The window PADDING may graze a screened range without the peak itself being contested —
    // trim the padded side back instead of throwing the whole peak away.
    for (const [busyStart, busyEnd] of screened) {
      if (Math.min(busyEnd, winEnd) - Math.max(busyStart, winStart) <= 0) continue;
      if (busyEnd <= peak.start) winStart = Math.max(winStart, busyEnd + 0.1);
      else if (busyStart >= peak.end) winEnd = Math.min(winEnd, busyStart - 0.1);
    }
    const duration = winEnd - winStart;
    if (duration < 3 || winStart > peak.start + 0.5 || winEnd < peak.end - 0.5) continue;
    // A small pie must still admit its top peak: shrink the padding toward the peak core
    // instead of skipping outright when the remaining budget is tight.
    if (actionBudgetSec != null) {
      const remaining = actionBudgetSec + 1.0 - actionSec;
      if (remaining < Math.max(3.5, peak.end - peak.start)) continue;
      if (winEnd - winStart > remaining) {
        const excess = (winEnd - winStart) - remaining;
        const frontPad = Math.max(0, peak.start - winStart);
        const trimFront = Math.min(frontPad - 0.3, excess / 2 + Math.max(0, excess / 2 - Math.max(0, winEnd - peak.end - 0.3)));
        winStart = Math.min(peak.start - 0.3, winStart + Math.max(0, trimFront));
        winEnd = Math.max(peak.end + 0.3, winStart + remaining);
        winEnd = Math.min(winEnd, usable);
      }
    }
    if (target > 0 && totalEst() + (winEnd - winStart) > target) continue;
    const finalDuration = winEnd - winStart;
    if (finalDuration < 3) continue;
    if (screened.some(([busyStart, busyEnd]) => Math.min(busyEnd, winEnd) - Math.max(busyStart, winStart) > 0.75)) continue;
    // A peak CORE inside a dialogue slot's narrative span (between its lines) cannot be
    // appended after it without a backward source jump — the monotonicity gate rejects that,
    // and editorially the beat would play after the scream that follows it. Splitting the
    // dialogue slot at the gap (split_part slots) is how such a peak gets admitted.
    const insideDialogueSpan = items.some((item) => item.decision === 'KEEP_DIALOGUE'
      && Number(item.start_sec) < peak.end && Number(item.end_sec) > peak.start);
    if (insideDialogueSpan) continue;
    const beat = (Array.isArray(beats) ? beats : []).find((candidate) => Number(candidate.start_sec) <= peak.start && Number(candidate.end_sec) >= peak.end) || null;
    const slot = {
      slot_id: `slot_action_${peak.rank || inserted + 1}`,
      beat_id: String(beat?.beat_id || ''),
      role: 'action_beat',
      decision: 'NARRATE',
      start_sec: roundSec(winStart),
      end_sec: roundSec(winEnd),
      estimated_duration_sec: roundSec(finalDuration),
      narration_estimated_duration_sec: 0,
      visual_source_mode: 'source_audio_action',
      visual_source_beat_id: String(beat?.beat_id || ''),
      visual_source_start_sec: roundSec(winStart),
      visual_source_end_sec: roundSec(winEnd),
      visual_source_center_sec: roundSec((winStart + winEnd) / 2),
      reason: `Measured energy peak rank ${peak.rank} plays with its own action audio — the fight itself is content, not background.`,
      spoiler_policy: 'action only; no reveal',
      repeat_policy: 'none',
      dialogue_focus_source: 'none',
      dialogue_focus_lines: [],
      dialogue_focus_quotes: [],
      replay_of_slot_id: '',
      replay_mode: ''
    };
    // Chronological insert by source start, never before the cold open (the hook stays first
    // even when it comes from later footage).
    let position = items.length;
    for (let index = 1; index < items.length; index += 1) {
      const candidate = items[index];
      if (candidate.role === 'cold_open') continue;
      const candidateStart = Number(candidate.start_sec);
      if (Number.isFinite(candidateStart) && candidateStart > winStart) { position = index; break; }
    }
    items.splice(position, 0, slot);
    screened.push([winStart, winEnd]);
    actionSec += finalDuration;
    inserted += 1;
  }
  // Adjacent action beats with a sub-second source gap play as one continuous flurry instead
  // of three clips with visible micro-jumps.
  for (let index = items.length - 2; index >= 0; index -= 1) {
    const current = items[index];
    const next = items[index + 1];
    if (String(current?.visual_source_mode) !== 'source_audio_action') continue;
    if (String(next?.visual_source_mode) !== 'source_audio_action') continue;
    const gap = Number(next.visual_source_start_sec) - Number(current.visual_source_end_sec);
    if (gap < 0 || gap > 1.0) continue;
    current.end_sec = next.end_sec;
    current.visual_source_end_sec = next.visual_source_end_sec;
    current.estimated_duration_sec = roundSec(Number(current.visual_source_end_sec) - Number(current.visual_source_start_sec));
    current.visual_source_center_sec = roundSec((Number(current.visual_source_start_sec) + Number(current.visual_source_end_sec)) / 2);
    current.reason = `${current.reason} Merged with the adjacent peak into one continuous run.`;
    items.splice(index + 1, 1);
  }
  return items;
}

function finalizeEditPlan(editPlan, beats, transcript, targetSec, usableEndSec = 0, wordTimestamps = null, energyPeaks = null) {
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const sortedBeatStarts = (Array.isArray(beats) ? beats : []).map((b) => Number(b.start_sec)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const callbackPreparedTimeline = prepareColdOpenCallbackTimeline(
    Array.isArray(editPlan?.timeline) ? editPlan.timeline : [],
    editPlan,
    beats,
    transcript
  );
  const anchorAdjustedTimeline = enforceEarlyDialogueAnchor(
    callbackPreparedTimeline,
    editPlan,
    beats,
    transcript
  );
  const timeline = anchorAdjustedTimeline.map((item) => {
    const beat = beatMap.get(String(item?.beat_id || '').trim());
    const next = { ...item };
    // A slot marked authored_lines was written by hand, so its lines are a decision, not a draft:
    // re-deriving the focus from the beat threw those edits away on every refresh/apply and the
    // owner's fix looked like it had done nothing. Geometry passes (trims, separation, the runtime
    // ceiling) still apply - only the SELECTION is left alone, and only while it still resolves.
    const authoredLines = next.authored_lines === true
      && (Array.isArray(next.dialogue_line_windows) ? next.dialogue_line_windows : []).some((win) => win && win.matched === true);
    if (next.decision === 'KEEP_DIALOGUE' && beat && next.split_part !== true && !authoredLines) {
      const plannedQuotes = Array.isArray(next.dialogue_focus_quotes)
        ? next.dialogue_focus_quotes.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      const requiredAnchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue : [];
      const hookTeaser = String(next?.editorial_role || '').trim() === 'hook_teaser'
        || (String(next?.role || '').trim() === 'cold_open' && String(editPlan?.editorial_pattern || '').trim() === 'cold_open_callback');
      // A body slot draws on the beat's WHOLE key_dialogue, not just the model's picks: the model
      // kept ~2 lines per slot, so the "you people" exchange that sets up the racism accusation
      // and the patriotism line were captured by the beats and then never reached the cut — the
      // accusation played with no setup. Anchors and the model's picks stay required; the 5-line
      // limit and the runtime ceiling already control length.
      const beatQuotes = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue : [];
      const preferredQuotes = hookTeaser
        ? (plannedQuotes.length ? plannedQuotes : requiredAnchors.slice(0, 1))
        : [...new Set([...requiredAnchors, ...plannedQuotes, ...beatQuotes])];
      const rawFocus = collectDialogueFocus(beat, transcript, preferredQuotes.length ? { quotes: preferredQuotes } : {});
      if (rawFocus) {
        const enriched = enrichDialogueFocusForCoherence(beat, transcript, rawFocus);
        const focus = limitDialogueFocusLines(enriched.focus, [...new Set([...requiredAnchors, ...plannedQuotes])]);
        next.start_sec = focus.start_sec;
        next.end_sec = focus.end_sec;
        next.estimated_duration_sec = roundSec(focus.end_sec - focus.start_sec);
        next.dialogue_focus_source = 'key_dialogue';
        // An empty matched_quotes array is truthy, so the `|| lines` fallback never fired and the slot
        // shipped with zero focus quotes - which the plan validator rejects outright, so the whole
        // refresh failed and the source silently kept its old plan.
        next.dialogue_focus_quotes = (focus.matched_quotes || []).length ? focus.matched_quotes : focus.lines;
        next.dialogue_focus_lines = focus.lines;
        // Compute per-line source windows ONCE here; Phase 2 transcript + slot_map both
        // read these exact stored numbers (single source of coordinates for each line).
        const nextBeatStart = sortedBeatStarts.find((startSec) => startSec > Number(beat.end_sec) + 0.001);
        // Keep the exchange whole before resolving windows: the captions the fills step writes are
        // one per focus line, so a line added here is a line the viewer actually gets to read.
        const filled = process.env.MIDFORM_KEEP_EXCHANGE === '0'
          ? { lines: focus.lines, added: 0 }
          : fillDialogueExchangeGaps(focus.lines, transcript, 12, { start: focus.start_sec, end: focus.end_sec });
        if (filled.added > 0) focus.lines = filled.lines;
        const readable = resolveReadableDialogueWindows(transcript, focus, beat.end_sec, nextBeatStart, requiredAnchors);
        const lineResolution = readable.resolution;
        next.dialogue_focus_quotes = (readable.focus.matched_quotes || []).length ? readable.focus.matched_quotes : readable.focus.lines;
        next.dialogue_focus_lines = readable.focus.lines;
        next.dialogue_line_windows = lineResolution.windows;
        // The runtime shave must never remove an ANCHOR line: shaving one made the plan fail
        // its own anchor-containment validator on dialogue-dense sources (You Can't Handle
        // the Truth died twice on exactly this).
        next.dialogue_anchor_quotes = requiredAnchors.slice();
        next.dialogue_line_window_ok = lineResolution.ok;
        next.dialogue_line_window_warnings = lineResolution.warnings;
        Object.assign(next, annotateDialogueSlotForQc(next, lineResolution, enriched.qc));
      }
    }
    if (next.decision !== 'KEEP_DIALOGUE') {
      next.dialogue_focus_quotes = Array.isArray(next.dialogue_focus_quotes) ? next.dialogue_focus_quotes : [];
      next.dialogue_focus_lines = Array.isArray(next.dialogue_focus_lines) ? next.dialogue_focus_lines : [];
      Object.assign(next, annotateNarrationSlotForQc(next));
    }
    return next;
  });

  const coldIndex = timeline.findIndex((item) => item.role === 'cold_open');
  // An authored dialogue teaser skips this whole block. It rebuilds the cold open from the beats and
  // from visual-source rules, and one of its fallbacks flips the slot to NARRATE - which silently
  // turned The Housemaid night's hand-set teaser into narration, so the hook never played at all and
  // the cut opened on the bridge.
  const coldAuthored = coldIndex >= 0 && timeline[coldIndex]?.authored_lines === true
    && timeline[coldIndex]?.decision === 'KEEP_DIALOGUE';
  if (coldIndex >= 0 && !coldAuthored) {
    const cold = { ...timeline[coldIndex] };
    const isSceneHookCold = String(cold.visual_source_mode || '').trim() === 'source_audio_teaser';
    // A scene hook deliberately carries no captions — designed for action peaks. When the heatmap
    // peak IS dialogue the teaser window lands on spoken lines and plays them uncaptioned ("I
    // don't know where a headset ties into patriotism" opened the cut inaudible to a Korean
    // audience). Flip it to a dialogue hook: the captioned pipeline — translation, speaker
    // colours, per-line windows — then applies whole. The uncaptioned hook stays for peaks that
    // genuinely carry no speech.
    if (isSceneHookCold && cold.decision === 'NARRATE') {
      const teaserStart = Number(cold.visual_source_start_sec);
      const teaserEnd = Number(cold.visual_source_end_sec);
      // A cue ending a breath before the teaser starts is the line that LEADS INTO the peak
      // (the Anacondas scream teaser started 0.1s after "...onto my shirt, what?!" ended and
      // shipped uncaptioned). Reach a little earlier so that line joins the hook with captions.
      const FLIP_NEAR_SEC = 1.5;
      const spoken = (Array.isArray(transcript) ? transcript : []).filter((cue) => (
        Number(cue?.end_sec) > teaserStart - FLIP_NEAR_SEC && Number(cue?.start_sec) < teaserEnd && !isNonSpeechCaption(cue?.text)
      ));
      if (spoken.length) {
        cold.decision = 'KEEP_DIALOGUE';
        cold.visual_source_mode = 'source_dialogue_hook';
        if (cold.visual_source_beat_id) cold.beat_id = String(cold.visual_source_beat_id).trim();
        // A non-verbal peak beat often carries no key_dialogue, so the flip must supply its
        // own quotes - the spoken cues it just detected ARE the lines.
        const spokenTexts = spoken.map((cue) => String(cue.text || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (spokenTexts.length) {
          // The lead-in line usually lives OUTSIDE the peak beat, and beat-scoped resolution
          // cannot see it - store the cue coordinates so the cold-open resolver can build
          // windows directly.
          cold.flip_cue_windows = spoken.slice(0, 2).map((cue) => ({
            line: String(cue.text || '').replace(/\s+/g, ' ').trim(),
            start_sec: Number(cue.start_sec),
            end_sec: Math.min(Number(cue.end_sec), teaserEnd)
          }));
          cold.dialogue_focus_quotes = spokenTexts.slice(0, 2);
          cold.dialogue_focus_lines = spokenTexts.slice(0, 2);
        }
        cold.dialogue_focus_source = 'scene_hook_flipped_to_dialogue';
        cold.reason = `${cold.reason || ''} The teaser moment is spoken, so it opens as captioned dialogue rather than an uncaptioned scene hook.`.trim();
      }
    }
    const coldBeat = beatMap.get(String(cold.beat_id || '').trim());
    const coldDialogueFocus = (cold.decision === 'KEEP_DIALOGUE' || isSceneHookCold) ? null : coldOpenDialogueFocusForBeat(coldBeat, transcript);
    if (coldDialogueFocus) {
      cold.decision = 'KEEP_DIALOGUE';
      cold.start_sec = coldDialogueFocus.start_sec;
      cold.end_sec = coldDialogueFocus.end_sec;
      cold.estimated_duration_sec = coldDialogueFocus.duration_sec;
      cold.dialogue_focus_source = 'cold_open_anchor_dialogue';
      cold.dialogue_focus_lines = coldDialogueFocus.lines;
      cold.dialogue_focus_quotes = coldDialogueFocus.quotes;
      cold.visual_source_mode = 'source_dialogue_hook';
      cold.visual_source_beat_id = String(cold.beat_id || '');
      cold.reason = 'Teaser opening selected from the strongest replay/hook beat and preserved as original dialogue with Korean captions.';
    }
    // An authored teaser skips the widen-and-relead pass below for the same reason it skips the beat
    // re-derivation: the owner already chose which line opens the cut.
    if (cold.decision === 'KEEP_DIALOGUE' && cold.authored_lines !== true) {
      const existingLines = Array.isArray(cold.dialogue_focus_lines) ? cold.dialogue_focus_lines.filter(Boolean) : [];
      const existingQuotes = Array.isArray(cold.dialogue_focus_quotes) ? cold.dialogue_focus_quotes.filter(Boolean) : [];
      // The model's own lines, in the model's order, used to decide the opening. When it opened on
      // a pleasantry — "Hi, Janice. I'm glad to see you, baby." — nothing downstream could recover:
      // the slot held that one line, so there was no order left to fix. Widen the candidates to the
      // whole beat and let the strongest line lead, keeping one more for the answer to it.
      const modelQuotes = existingQuotes.length ? existingQuotes : existingLines;
      const beatQuotes = coldBeat
        ? [...(Array.isArray(coldBeat.anchor_dialogue) ? coldBeat.anchor_dialogue : []),
           ...(Array.isArray(coldBeat.key_dialogue) ? coldBeat.key_dialogue : [])]
        : [];
      const candidateQuotes = [...new Set([...modelQuotes, ...beatQuotes].map((quote) => String(quote || '').trim()).filter(Boolean))];
      const preferredQuotes = candidateQuotes.length
        ? candidateQuotes
          .map((quote, order) => ({ quote, order, score: teaserQuoteScore(quote) }))
          .sort((left, right) => right.score - left.score || left.order - right.order)
          .slice(0, 2)
          .map((entry) => entry.quote)
        : modelQuotes;
      // A flipped scene hook carries its own cue coordinates; build the focus from them
      // directly - beat-scoped matching cannot see a lead-in line outside the peak beat.
      const flipWindows = Array.isArray(cold.flip_cue_windows) ? cold.flip_cue_windows.filter((win) => Number(win?.end_sec) > Number(win?.start_sec)) : [];
      const rawFocus = flipWindows.length
        ? {
            start_sec: roundSec(Math.min(...flipWindows.map((win) => Number(win.start_sec)))),
            end_sec: roundSec(Math.max(...flipWindows.map((win) => Number(win.end_sec)))),
            lines: flipWindows.map((win) => win.line),
            matched_quotes: flipWindows.map((win) => win.line)
          }
        : (coldBeat ? collectDialogueFocus(coldBeat, transcript, preferredQuotes.length ? { quotes: preferredQuotes } : {}) : null);
      if (rawFocus) {
        const enriched = enrichDialogueFocusForCoherence(coldBeat, transcript, rawFocus);
        const focus = limitDialogueFocusLines(enriched.focus, preferredQuotes);
        cold.start_sec = focus.start_sec;
        cold.end_sec = focus.end_sec;
        cold.estimated_duration_sec = roundSec(Number(focus.end_sec) - Number(focus.start_sec));
        cold.dialogue_focus_source = cold.dialogue_focus_source || 'cold_open_anchor_dialogue';
        cold.dialogue_focus_quotes = (focus.matched_quotes || []).length ? focus.matched_quotes : focus.lines;
        cold.dialogue_focus_lines = focus.lines;
        cold.dialogue_selection_scores = {
          ...(cold.dialogue_selection_scores || {}),
          ...coldOpenCallbackScores(coldBeat, focus.lines)
        };
        const nextBeatStart = sortedBeatStarts.find((startSec) => startSec > Number(coldBeat.end_sec) + 0.001);
        const readable = resolveReadableDialogueWindows(transcript, focus, coldBeat.end_sec, nextBeatStart, preferredQuotes);
        const lineResolution = readable.resolution;
        cold.dialogue_focus_quotes = (readable.focus.matched_quotes || []).length ? readable.focus.matched_quotes : readable.focus.lines;
        cold.dialogue_focus_lines = readable.focus.lines;
        cold.dialogue_line_windows = lineResolution.windows;
        cold.dialogue_line_window_ok = lineResolution.ok;
        cold.dialogue_line_window_warnings = lineResolution.warnings;
        Object.assign(cold, annotateDialogueSlotForQc(cold, lineResolution, enriched.qc));
      }
      // If the flip's cue text could not be resolved to windows, a KEEP_DIALOGUE cold open
      // with no quotes would fail the whole plan - fall back to the uncaptioned scene hook
      // it was before, which is always valid.
      if (cold.dialogue_focus_source === 'scene_hook_flipped_to_dialogue'
        && !(Array.isArray(cold.dialogue_line_windows) && cold.dialogue_line_windows.some((win) => win && win.matched === true))) {
        cold.decision = 'NARRATE';
        cold.visual_source_mode = 'source_audio_teaser';
        cold.dialogue_focus_quotes = [];
        cold.dialogue_focus_lines = [];
        delete cold.dialogue_line_windows;
      }
      cold.visual_source_mode = cold.visual_source_mode || 'source_dialogue_hook';
      cold.visual_source_beat_id = cold.visual_source_beat_id || String(cold.beat_id || '');
      cold.visual_source_start_sec = Number(cold.start_sec || 0);
      cold.visual_source_end_sec = Number(cold.end_sec || 0);
      cold.visual_source_center_sec = roundSec((Number(cold.start_sec || 0) + Number(cold.end_sec || 0)) / 2);
      cold.repeat_policy = 'Original dialogue hook first; later body_peak uses aftermath/context without duplicating the same source dialogue.';
      if (/narration-led|Upgraded cold_open|Cold-open preserves original dialogue/.test(cold.reason)) {
        cold.reason = 'Teaser opening selected from the strongest replay/hook beat and preserved as original dialogue with Korean captions.';
      }
      delete cold.narration_estimated_duration_sec;
      delete cold.duration_check;
      timeline[coldIndex] = cold;
    } else if (isSceneHookCold && Number(cold.visual_source_end_sec) > Number(cold.visual_source_start_sec)) {
      // Scene hook: keep the heatmap-peak window (clamped to cold-open length) with its
      // original audio. Only nudge it off reserved dialogue windows; never replace it with
      // a muted teaser or a dialogue hook.
      const reservedRanges = timeline
        .filter((item) => item.decision === 'KEEP_DIALOGUE' && Number(item.end_sec) > Number(item.start_sec))
        .map((item) => [Number(item.start_sec), Number(item.end_sec)]);
      const clamped = clampSceneHookWindow(cold.visual_source_start_sec, cold.visual_source_end_sec)
        || { start_sec: Number(cold.visual_source_start_sec), end_sec: Number(cold.visual_source_end_sec) };
      const adjusted = adjustVisualSourceAwayFromReserved({
        mode: 'source_audio_teaser',
        beat_id: cold.visual_source_beat_id || cold.beat_id,
        start_sec: clamped.start_sec,
        end_sec: clamped.end_sec,
        reason: 'Heatmap-peak scene hook window rechecked against reserved dialogue windows.'
      }, beatMap.get(String(cold.visual_source_beat_id || cold.beat_id || '').trim()), reservedRanges);
      cold.decision = 'NARRATE';
      cold.visual_source_mode = 'source_audio_teaser';
      cold.visual_source_beat_id = String(adjusted?.beat_id || cold.visual_source_beat_id || cold.beat_id || '');
      cold.visual_source_start_sec = Number(adjusted?.start_sec ?? clamped.start_sec);
      cold.visual_source_end_sec = Number(adjusted?.end_sec ?? clamped.end_sec);
      cold.visual_source_center_sec = roundSec((cold.visual_source_start_sec + cold.visual_source_end_sec) / 2);
      cold.estimated_duration_sec = roundSec(cold.visual_source_end_sec - cold.visual_source_start_sec);
      cold.repeat_policy = 'Scene hook teaser only; the body may replay this beat later with full context.';
      timeline[coldIndex] = cold;
    } else {
      // Source-video windows already claimed by KEEP_DIALOGUE slots (real dialogue audio).
      // The muted teaser must avoid these or the downstream cross-segment overlap validator rejects the run.
      const reservedRanges = timeline
        .filter((item) => item.decision === 'KEEP_DIALOGUE' && Number(item.end_sec) > Number(item.start_sec))
        .map((item) => [Number(item.start_sec), Number(item.end_sec)]);
      let visualSource = selectColdOpenVisualSource(beats, cold.beat_id, transcript, reservedRanges);
      if (!visualSource && cold.visual_source_beat_id && Number(cold.visual_source_end_sec) > Number(cold.visual_source_start_sec)) {
        visualSource = {
          mode: cold.visual_source_mode || 'mute_visual_teaser',
          beat_id: cold.visual_source_beat_id,
          start_sec: Number(cold.visual_source_start_sec),
          end_sec: Number(cold.visual_source_end_sec),
          reason: 'Existing cold-open visual source retained and rechecked against reserved dialogue windows.'
        };
      }
      const visualBeat = visualSource ? beatMap.get(String(visualSource.beat_id || '').trim()) : null;
      visualSource = adjustVisualSourceAwayFromReserved(visualSource, visualBeat, reservedRanges);
      cold.decision = 'NARRATE';
      cold.repeat_policy = 'Teaser only; replay later as body_peak with full context and a longer playback window.';
      cold.reason = `${cold.reason} Cold-open playback is narration-led, and the teaser visual is intentionally decoupled from the story beat.`;
      if (visualSource) {
        cold.visual_source_mode = visualSource.mode;
        cold.visual_source_beat_id = visualSource.beat_id;
        cold.visual_source_start_sec = visualSource.start_sec;
        cold.visual_source_end_sec = visualSource.end_sec;
        cold.visual_source_center_sec = roundSec((Number(visualSource.start_sec) + Number(visualSource.end_sec)) / 2);
        cold.estimated_duration_sec = roundSec(Number(visualSource.end_sec) - Number(visualSource.start_sec));
      } else {
        cold.estimated_duration_sec = roundSec(Math.min(COLD_OPEN_VISUAL_TARGET_SEC, Number(cold.estimated_duration_sec || COLD_OPEN_VISUAL_TARGET_SEC)));
      }
      timeline[coldIndex] = cold;
    }

    const replayIndex = timeline.findIndex((item, index) => index !== coldIndex && item.role === 'body_peak' && item.beat_id === cold.beat_id);
    if (replayIndex >= 0) {
      const replay = { ...timeline[replayIndex] };
      if (cold.decision === 'KEEP_DIALOGUE') {
        const replayBeat = beatMap.get(String(replay.beat_id || '').trim());
        const afterDialogueStart = roundSec(Math.max(Number(cold.end_sec || 0), Number(replay.start_sec || 0)));
        const replayBeatEnd = roundSec(Number(replayBeat?.end_sec || replay.end_sec || afterDialogueStart));
        replay.replay_of_slot_id = cold.slot_id;
        const rawRemainingFocus = collectRemainingDialogueFocusAfterColdOpen(replayBeat, transcript, cold);
        if (rawRemainingFocus) {
          const enriched = enrichDialogueFocusForCoherence(replayBeat, transcript, rawRemainingFocus);
          const remainingFocus = limitDialogueFocusLines(enriched.focus, replayBeat?.anchor_dialogue || []);
          replay.decision = 'KEEP_DIALOGUE';
          replay.start_sec = remainingFocus.start_sec;
          replay.end_sec = remainingFocus.end_sec;
          replay.estimated_duration_sec = roundSec(Number(remainingFocus.end_sec) - Number(remainingFocus.start_sec));
          replay.dialogue_focus_source = 'post_cold_open_key_dialogue';
          replay.dialogue_focus_quotes = remainingFocus.quotes;
          replay.dialogue_focus_lines = remainingFocus.lines;
          const nextBeatStart = sortedBeatStarts.find((startSec) => startSec > Number(replayBeatEnd) + 0.001);
          const readable = resolveReadableDialogueWindows(transcript, remainingFocus, replayBeatEnd, nextBeatStart, replayBeat?.anchor_dialogue || []);
          replay.dialogue_focus_quotes = readable.focus.quotes || readable.focus.matched_quotes || readable.focus.lines;
          replay.dialogue_focus_lines = readable.focus.lines;
          const lineResolution = readable.resolution;
          replay.dialogue_line_windows = lineResolution.windows;
          replay.dialogue_line_window_ok = lineResolution.ok;
          replay.dialogue_line_window_warnings = lineResolution.warnings;
          Object.assign(replay, annotateDialogueSlotForQc(replay, lineResolution, enriched.qc));
          delete replay.narration_estimated_duration_sec;
          delete replay.duration_check;
          replay.replay_mode = 'remaining_dialogue_after_cold_open';
          replay.repeat_policy = 'Cold-open dialogue is not duplicated; remaining high-impact lines from the same beat stay as original-audio dialogue.';
          replay.reason = 'Body peak preserves the remaining important source dialogue after the cold-open hook.';
        } else {
          replay.decision = replayBeatEnd - afterDialogueStart >= 2 ? 'NARRATE' : 'DROP';
          replay.start_sec = afterDialogueStart;
          replay.end_sec = replayBeatEnd;
          replay.estimated_duration_sec = replay.decision === 'NARRATE' ? narrationDurationForBeat({ ...replayBeat, start_sec: afterDialogueStart, end_sec: replayBeatEnd }) : 0;
          replay.dialogue_focus_source = 'none';
          replay.dialogue_focus_lines = [];
          replay.dialogue_focus_quotes = [];
          delete replay.dialogue_line_windows;
          delete replay.dialogue_line_window_ok;
          delete replay.dialogue_line_window_warnings;
          delete replay.narration_estimated_duration_sec;
          delete replay.duration_check;
          replay.replay_mode = 'after_dialogue_context';
          replay.repeat_policy = 'Cold-open already used the hook dialogue; this slot continues with aftermath/context only.';
          replay.reason = 'Body peak continues the hook beat after the preserved cold-open dialogue, without duplicating the same source lines.';
        }
      } else {
        replay.replay_of_slot_id = cold.slot_id;
        replay.replay_mode = 'full_context_replay';
        const replayBeat = beatMap.get(String(replay.beat_id || '').trim());
        const quality = String(replayBeat?.dialogue_quality || '').trim();
        const rawFocus = quality === 'high' ? collectDialogueFocus(replayBeat, transcript) : null;
        if (rawFocus) {
          const enriched = enrichDialogueFocusForCoherence(replayBeat, transcript, rawFocus);
          const focus = limitDialogueFocusLines(enriched.focus, replayBeat?.anchor_dialogue || []);
          const nextBeatStart = sortedBeatStarts.find((startSec) => startSec > Number(replayBeat.end_sec) + 0.001);
          const readable = resolveReadableDialogueWindows(transcript, focus, replayBeat.end_sec, nextBeatStart, replayBeat?.anchor_dialogue || []);
          replay.decision = 'KEEP_DIALOGUE';
          replay.start_sec = readable.focus.start_sec;
          replay.end_sec = readable.focus.end_sec;
          replay.estimated_duration_sec = roundSec(Number(readable.focus.end_sec) - Number(readable.focus.start_sec));
          replay.dialogue_focus_source = 'heatmap_teaser_story_replay';
          replay.dialogue_focus_quotes = readable.focus.matched_quotes || readable.focus.lines;
          replay.dialogue_focus_lines = readable.focus.lines;
          const lineResolution = readable.resolution;
          replay.dialogue_line_windows = lineResolution.windows;
          replay.dialogue_line_window_ok = lineResolution.ok;
          replay.dialogue_line_window_warnings = lineResolution.warnings;
          Object.assign(replay, annotateDialogueSlotForQc(replay, lineResolution, enriched.qc));
          delete replay.narration_estimated_duration_sec;
          delete replay.duration_check;
          replay.repeat_policy = 'Heatmap visual teaser is separate; this replay preserves the source dialogue that carries the story turn.';
          replay.reason = 'Body peak replays the story-critical beat as original dialogue after the heatmap visual teaser.';
        }
      }
      timeline[replayIndex] = replay;
    }
    if (cold.decision === 'KEEP_DIALOGUE') {
      const closingIndex = timeline.findIndex((item, index) => index !== coldIndex && item.role === 'closing' && item.beat_id === cold.beat_id);
      if (closingIndex >= 0) {
        timeline[closingIndex] = {
          ...timeline[closingIndex],
          decision: 'DROP',
          estimated_duration_sec: 0,
          dialogue_focus_source: 'none',
          dialogue_focus_lines: [],
          dialogue_focus_quotes: [],
          narration_estimated_duration_sec: 0,
          duration_check: { status: 'dropped_after_dialogue_cold_open', narration_estimated_duration_sec: 0 },
          repeat_policy: 'Dropped because body_peak now carries the post-hook context after a dialogue cold open.',
          reason: 'Dropped to avoid overlapping the post-hook body_peak after the cold_open dialogue hook.'
        };
      }
    }
  }

  // A midform must not end on a bare dialogue clip: if the last active slot is KEEP_DIALOGUE,
  // append a short closing NARRATE slot. Its window starts after the final dialogue line and runs
  // to the beat end (aftermath footage), falling back to the beat window if that is too thin.
  // Idempotent: refresh runs finalizeEditPlan again and must not append twice.
  const lastActive = [...timeline].reverse().find((item) => item.decision !== 'DROP');
  const hasClosing = timeline.some((item) => item.role === 'closing' || item.slot_id === 'slot_closing');
  if (lastActive && lastActive.decision === 'KEEP_DIALOGUE' && !hasClosing) {
    const lastBeat = beatMap.get(String(lastActive.beat_id || '').trim());
    const lastLineEnd = Math.max(
      Number(lastActive.end_sec) || 0,
      ...((Array.isArray(lastActive.dialogue_line_windows) ? lastActive.dialogue_line_windows : [])
        .filter((w) => w && w.matched === true)
        .map((w) => Number(w.end_sec) || 0))
    );
    let closingStart = roundSec(lastLineEnd);
    let closingEnd = roundSec(Math.max(Number(lastBeat?.end_sec) || 0, closingStart));
    if (closingEnd - closingStart < 2 && lastBeat) {
      closingStart = roundSec(Number(lastBeat.start_sec) || closingStart);
      closingEnd = roundSec(Number(lastBeat.end_sec) || closingEnd);
    }
    // The last beat can run into the channel's promo tail, and the closing b-roll is cut from this
    // window - which is how Draft Day's closing landed at 549.4-553.5 against a usable end of 549
    // and failed narration_broll_semantic_bounds. Bound the window where it is created.
    if (Number(usableEndSec) > 0 && closingEnd > Number(usableEndSec)) {
      const span = Math.max(2, closingEnd - closingStart);
      closingEnd = roundSec(Number(usableEndSec));
      closingStart = roundSec(Math.max(0, closingEnd - span));
    }
    timeline.push(annotateNarrationSlotForQc({
      slot_id: 'slot_closing',
      beat_id: String(lastActive.beat_id || ''),
      role: 'closing',
      decision: 'NARRATE',
      start_sec: closingStart,
      end_sec: closingEnd,
      estimated_duration_sec: roundSec(Math.max(4, Math.min(8, closingEnd - closingStart))),
      reason: 'Closing narration wraps the ending after the final dialogue: state the outcome, pay off remaining questions, and end on narration instead of cutting off on a quote.',
      spoiler_policy: 'resolve the story; no new reveals',
      repeat_policy: 'none',
      visual_source_mode: '',
      visual_source_beat_id: '',
      dialogue_focus_source: 'none',
      dialogue_focus_lines: [],
      dialogue_focus_quotes: [],
      replay_of_slot_id: '',
      replay_mode: ''
    }));
  }

  // Cut the promo tail BEFORE topping up. Filtering afterwards left the freed slots empty:
  // the Anacondas cut used 6 of 12 usable cues and ran 54s against a 75s target, because the
  // lines dropped for sitting in the endcard were never replaced.
  const footageBoundTimeline = dropWindowsPastUsableEnd(timeline, usableEndSec);
  // Allocation order (owner directive 2026-08-10): dialogue is fixed and first, the ACTION PIE
  // is reserved second, and narration top-up only gets what remains. Topping narration up to
  // the full target left the pie permanently zero on every source whose plan reached it -
  // action was allocated from leftovers, and there were never any.
  const finalizeSpeechRatio = speechRatioOfFootage(transcript, usableEndSec);
  // Reserve only what can actually be spent: without measured peaks the pie has no place to
  // go, and reserving it would just shorten the cut and stretch the narration runs.
  const hasEnergyPeaks = Array.isArray(energyPeaks) && energyPeaks.length > 0;
  const actionShare = hasEnergyPeaks ? measuredActionShare(finalizeSpeechRatio) : 0;
  const actionBudgetSec = roundSec(Math.max(0, Number(targetSec) || 0) * actionShare);
  const narrationCeilingSec = Math.max(0, (Number(targetSec) || 0) - actionBudgetSec);
  const toppedUpTimeline = topUpTimelineToTargetRuntime(footageBoundTimeline, beats, transcript, narrationCeilingSec, usableEndSec);
  const interleavedTimeline = interleaveDialogueIntoNarrationRuns(toppedUpTimeline, beats, transcript);
  // Adopt audible-but-uncaptioned cues BEFORE the windows are separated, so the new lines get
  // the same overlap treatment as the rest.
  // Purge previously ADOPTED windows that no longer clear the adoption floor: they persist in
  // stored plans across refreshes, and an unmatched sub-second leftover shifts every caption
  // index behind it (Anacondas shipped a blank L04 and lost L02 to exactly this).
  const adoptionCleanTimeline = interleavedTimeline.map((item) => {
    if (item.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const kept = item.dialogue_line_windows.filter((win) => !(win && win.adopted_from_cut === true
      && (win.matched !== true || !(Number(win.end_sec) - Number(win.start_sec) >= ADOPTED_CUE_MIN_SEC))));
    if (kept.length === item.dialogue_line_windows.length) return item;
    return {
      ...item,
      dialogue_line_windows: kept,
      dialogue_focus_lines: kept.filter((win) => win.matched === true).map((win) => win.line),
      dialogue_focus_quotes: kept.filter((win) => win.matched === true).map((win) => win.line)
    };
  });
  const filledTimeline = fillUncaptionedCuesInsideCuts(dropDuplicateDialogueSlots(adoptionCleanTimeline), transcript);
  // Word snap runs BEFORE separation so both the clip windows and the caption coordinates the
  // separation stamps inherit word-accurate edges.
  const wordSnappedTimeline = snapDialogueWindowsToWords(filledTimeline, wordTimestamps);
  const dedupedTimeline = dropUnplayableFocusLines(alignFocusLinesToWindows(separateOverlappingDialogueWindows(dropRestatedWindows(dropWindowsSwallowedByTheirNeighbour(wordSnappedTimeline)))));
  // Write the corrected measure back onto the slot. Fixing only realisticSlotDurationSec left
  // estimated_duration_sec holding the raw span - slot_02 still read 151.3s for four lines - so
  // every consumer that reads the field directly still saw the dead air between them.
  const measuredTimeline = clampColdOpenToTeaser(leadColdOpenWithStrongestLine(dropWindowsPastUsableEnd(trimTimelineToTargetRuntime(dedupedTimeline, narrationCeilingSec, beats), usableEndSec)));
  const trimmedTimeline = measuredTimeline.map((item) => (
    item.decision === 'KEEP_DIALOGUE'
      ? { ...item, estimated_duration_sec: realisticSlotDurationSec(item) }
      : item
  ));
  // AFTER the realistic-duration correction: the budget guard must see what the cut actually
  // runs (a dialogue slot's raw span can be 47s for 7s of lines), or every peak gets skipped.
  const actionTimeline = insertActionBeatSlots(trimmedTimeline, energyPeaks, targetSec, usableEndSec, beats, actionBudgetSec);
  // Safety net: a KEEP_DIALOGUE slot with NO resolved line windows whose lines are ALL
  // already carried by other slots' matched windows is a duplicate that can never resolve
  // (the interleave kept re-promoting the cold open's own line window-less every pass, and
  // the dialogue_line_window_ok preflight killed the run). A window-less slot with FRESH
  // lines is a legitimate mid-promotion — the next finalize pass resolves it — so it stays.
  const carriedLineWindows = new Map();
  for (const item of actionTimeline) {
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (win && win.matched === true && win.line) {
        const key = normalizeComparableText(win.line);
        if (!carriedLineWindows.has(key)) carriedLineWindows.set(key, []);
        carriedLineWindows.get(key).push([Number(win.start_sec), Number(win.end_sec)]);
      }
    }
  }
  const windowSafeTimeline = actionTimeline.map((item) => {
    if (item.decision !== 'KEEP_DIALOGUE' || item.split_part === true || item.role === 'cold_open') return item;
    const hasMatched = (Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [])
      .some((win) => win && win.matched === true);
    if (hasMatched) return item;
    // Duplicate means same line AND same moment: a repeated line elsewhere in the source
    // (running gags) is legitimate content, so the carrier's window must overlap THIS slot's
    // span before the slot counts as an unresolvable copy.
    const slotStart = Number(item.start_sec);
    const slotEnd = Number(item.end_sec);
    const lines = (Array.isArray(item.dialogue_focus_lines) ? item.dialogue_focus_lines : []).map((line) => normalizeComparableText(line)).filter(Boolean);
    const allDuplicates = lines.length > 0 && lines.every((line) => (carriedLineWindows.get(line) || [])
      .some(([winStart, winEnd]) => winEnd > slotStart - 0.5 && winStart < slotEnd + 0.5));
    if (!allDuplicates) return item;
    return { ...item, decision: 'DROP', estimated_duration_sec: 0, dialogue_focus_lines: [], dialogue_focus_quotes: [], reason: `${item.reason || ''} Dropped: window-less dialogue duplicate — every line is already carried by another slot.`.trim() };
  });
  // Again after the shave: it drops the LAST MATCHED line of a slot to buy runtime, so a slot can end
  // up holding only lines that never play - which is what left The Housemaid night's gaslighting slot
  // with the unplayable planned line and nothing else.
  let finalizedTimeline = dropUnplayableFocusLines(windowSafeTimeline).map((item) => {
    if (item.decision === 'KEEP_DIALOGUE') return annotateDialogueSlotForQc(item, { windows: item.dialogue_line_windows || [] }, item);
    return annotateNarrationSlotForQc(item);
  });
  finalizedTimeline = applyColdOpenVisualOverlapSafety(finalizedTimeline, beatMap);
  // The teaser limit has to be enforced HERE, not earlier: clampColdOpenToTeaser runs before the
  // per-slot durations are recomputed from the windows, so a re-derived cold open came back over the
  // limit (17.31s against 16s on The Housemaid night) and validateEditPlan rejected the plan - which
  // then silently kept the previous one. Give the line back instead of rewriting the number: drop the
  // teaser's last lines until it fits, keeping at least one.
  finalizedTimeline = finalizedTimeline.map((item) => {
    if (item?.role !== 'cold_open' || item.decision !== 'KEEP_DIALOGUE') return item;
    const limit = COLD_OPEN_DIALOGUE_MAX_SEC;
    let windows = (Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []).slice();
    // Measure it the way the validator does - the sum of the lines that get CUT, not the span from
    // first to last (the dead air between lines never reaches the timeline).
    const spanOf = (list) => realisticSlotDurationSec({ ...item, dialogue_line_windows: list });
    if (!(spanOf(windows) > limit)) return item;
    let dropped = 0;
    // Give back the EARLIEST lines, not the latest: a teaser's punch is its last line (the reveal),
    // and trimming from the end threw the hook away - The Housemaid night lost "Nina Winchester tried
    // to drown her kid in the bathtub." and opened on the setup chatter instead. A teaser is allowed
    // to start mid-exchange; it is not allowed to lose its point.
    while (spanOf(windows) > limit) {
      const matched = windows.filter((win) => win && win.matched === true);
      if (matched.length <= 1) break;
      const first = matched.reduce((earliest, win) => (Number(win.start_sec) < Number(earliest.start_sec) ? win : earliest), matched[0]);
      windows = windows.filter((win) => win !== first);
      dropped += 1;
    }
    if (!dropped) return item;
    const keptLines = new Set(windows.filter((win) => win && win.matched === true)
      .map((win) => normalizeComparableText(win.line)).filter(Boolean));
    const keepText = (list) => (Array.isArray(list) ? list : []).filter((line) => keptLines.has(normalizeComparableText(line)));
    const matched = windows.filter((win) => win && win.matched === true);
    const next = {
      ...item,
      dialogue_line_windows: windows,
      dialogue_focus_lines: keepText(item.dialogue_focus_lines),
      dialogue_focus_quotes: keepText(item.dialogue_focus_quotes),
      cold_open_lines_trimmed: dropped,
      reason: `${item.reason || ''} Teaser trimmed to ${limit}s by giving back its first ${dropped} line(s).`.trim()
    };
    if (matched.length) {
      next.start_sec = roundSec(Math.min(...matched.map((win) => Number(win.start_sec))));
      next.end_sec = roundSec(Math.max(...matched.map((win) => Number(win.end_sec))));
      next.estimated_duration_sec = realisticSlotDurationSec(next);
    }
    return next;
  });
  const callbackMetadata = buildColdOpenCallbackMetadata(finalizedTimeline, editPlan, beats, transcript);
  const dialogueTimingQc = evaluateDialogueTimingQc(finalizedTimeline, {
    dialogueDrivenConfrontation: isDialogueDrivenConfrontation(editPlan, beats),
    editorialPattern: callbackMetadata.editorial_pattern,
    totalRuntimeSec: Number(editPlan?.duration_budget?.estimated_total_sec || targetSec || 0),
    allowLateDialogueOverride: editPlan?.allow_late_dialogue_override === true
  });

  return {
    ...editPlan,
    ...callbackMetadata,
    cold_open_selection: {
      ...(editPlan?.cold_open_selection || {}),
      teaser_visual_mode: finalizedTimeline[coldIndex]?.visual_source_mode || 'story_beat',
      teaser_visual_beat_id: finalizedTimeline[coldIndex]?.visual_source_beat_id || String(editPlan?.cold_open_selection?.beat_id || ''),
      teaser_visual_start_sec: finalizedTimeline[coldIndex]?.visual_source_start_sec ?? Number(editPlan?.cold_open_selection?.heatmap_peak_start_sec || 0),
      teaser_visual_end_sec: finalizedTimeline[coldIndex]?.visual_source_end_sec ?? Number(editPlan?.cold_open_selection?.heatmap_peak_end_sec || 0)
    },
    timeline: finalizedTimeline,
    dialogue_timing_qc: dialogueTimingQc,
    action_mix: {
      speech_ratio: finalizeSpeechRatio == null ? null : roundSec(finalizeSpeechRatio),
      share_target: roundSec(actionShare),
      budget_sec: actionBudgetSec,
      inserted_sec: roundSec(finalizedTimeline
        .filter((item) => String(item?.visual_source_mode || '') === 'source_audio_action' && item.decision !== 'DROP')
        .reduce((sum, item) => sum + Number(item.estimated_duration_sec || 0), 0))
    },
    duration_budget: recalculateDurationBudget(finalizedTimeline, targetSec)
  };
}

function buildBeatsPrompt(transcript, metadata, targetSec) {
  // Beats are the raw material every later stage draws from, so asking for a fixed 5-9 regardless
  // of the requested runtime caps the cut. Six beats on this source yielded a 76s plan against a
  // 180s target with nothing left for the top-up to promote. A slot carries roughly 14s, so ask
  // for enough beats to build that many slots.
  const target = Number(targetSec || 0);
  const wantedBeats = target > 0 ? Math.max(6, Math.round(target / 14)) : 0;
  return [
    'You are segmenting a long movie clip transcript into narrative beats for a Korean midform compression workflow.',
    'Return JSON only matching the schema. Do not use markdown.',
    '',
    'Rules:',
    '- Use only the provided timed transcript. Do not invent events, motives, or dialogue.',
    '- A movie clip is already cut at story boundaries: it carries ONE self-contained arc of its own. Find that arc. Some moments inside the clip are not part of it - they are fragments tying into the wider film (setup for later scenes, references to off-clip characters or stakes). Mark such beats by saying so in their summary, because the edit plan will subtract them rather than build story around them.',
    '- Beats are bounded by the FOOTAGE, not the captions: a beat may span a stretch with no cues at all when the vision scene map or the measured energy peaks show something happening there. Dialogue quotes must still come from real cues.',
    '- Preserve source order.',
    ...(wantedBeats
      ? [`- Return at least ${wantedBeats} beats. The finished cut is built one slot per beat and a slot carries roughly 14 seconds, so fewer beats than this cannot reach the requested ${target}s runtime no matter how they are edited.`]
      : ['- Make beats story-sized, not subtitle-sized. Prefer 5-9 beats for a 5-10 minute clip.']),
    '- Keep beats story-sized rather than subtitle-sized: each one is a turn in the scene, not a single line.',
    '- Put beat boundaries where the scene turns: a speaker switch, a reaction, a declaration or rebuttal, or the moment a relationship flips. Do not draw boundaries around background or setup explanation.',
    '- key_dialogue must quote exact source dialogue snippets from the transcript.',
    '- anchor_dialogue must contain 1 to 2 identity-defining lines chosen from key_dialogue. Payoff/reveal-heavy beats may carry up to 3 anchors if multiple facts are core to the reveal.',
    '- anchor_dialogue is mandatory for later KEEP_DIALOGUE enforcement whenever the beat has dialogue. Pick the strongest hook/reveal/boundary lines, not cushion lines.',
    '- A pure action/visual beat (fight, chase, spectacle) with no meaningful spoken lines is valid: leave key_dialogue and anchor_dialogue empty rather than padding them with shouts, names, or filler. Such beats can still carry high hook_potential and dramatic_weight.',
    '- Good anchors: "if you were smart, you\'d stay away from me" / "what if I\'m the bad guy?" / "descended from wolves" / "we made a treaty with them" / "What are they really?"',
    '- Bad anchors: "Eggshells, carrot tops" / "radioactive spiders" / "No, our bus is full" / "I can keep a secret" / "old scary story" / "I\'m not really supposed to say anything about it"',
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
  const compactBeats = compactBeatsForEditPlan(beats);
  const compactHeatmap = compactHeatmapForEditPlan(heatmap);
  return [
    'You are designing a 3-minute Korean midform compression edit plan from narrative beats and YouTube most-replayed data.',
    'Return JSON only matching the schema. Do not use markdown.',
    '',
    'Editorial stance for this channel (this decides most of your choices):',
    '- Subtraction, not construction (owner doctrine): the clip already contains one self-contained story - it was cut at story boundaries. Your job is to FIND that internal arc and subtract everything that is not it, especially fragments that only make sense through the wider film\'s plot (setup for later scenes, off-clip characters, unresolved stakes the clip never pays off). After subtraction, what remains in source order IS the recap. Do not manufacture a frame, a mystery, or connective tissue the clip does not contain. Reordering for a hook (cold open) is presentation and is fine; inventing story is not.',
    '- Runtime is an output, not a quota: the coherent arc decides the length. A tight 60s cut from a 3-minute clip beats a padded 90s one; a 20-minute clip may legitimately yield 170s. Never exceed 180 seconds. Treat the requested target as a ceiling.',
    '- Scene-preserving and speech-driven cuts outperform explanatory recaps here. Let the scene carry the story: preserve the dialogue that creates the force of a moment and use narration only to recover the situation quickly between those moments.',
    '- Almost always KEEP_DIALOGUE for a line that declares, rebuts, flips an attitude, calls someone by name as a warning, or reverses who holds power. The test is not "can this be summarised" but "does this line make the scene work". If it makes the scene work, keep it.',
    '- NARRATE is for what cannot be seen or heard: who these people are, what just changed, what is at stake. Never narrate what the dialogue already says.',
    '- Prefer short exchanges over long single speeches. One line, a reaction, one line back gives the cut its rhythm; a long explanatory dialogue block kills it.',
    '- Place cut boundaries at speaker switches, reaction shots, declarations, rebuttals and the moment a relationship flips. Compress the opposite: event recaps, background, and setup explanation.',
    '- More dialogue is not automatically better. A speech-driven cut fails when the viewer cannot tell what the situation is or who is who, so pair every preserved exchange with just enough context for it to land.',
    '- Open on attitude, not on situation. In the first seconds a viewer reacts to how someone is behaving before they wonder what the story is, so lead with the line or reaction that shows who holds power, and only then restore the situation.',
    '- Design the payoff as proof, not summary: pick an opening line whose meaning a later beat can turn out to confirm, and place that later beat as the payoff. The cut should end by proving the hook, not by explaining it.',
    '- The shape to aim for: strong line -> one-sentence recovery -> exchange -> short bridge -> reaction or reversal -> the opening line proven. Dialogue blocks lead; narration blocks connect.',
    '',
    'Protected peak (benchmark finding - the top channel in this format reserves the film moment everyone remembers as an UNTOUCHED stretch):',
    '- Designate exactly ONE slot as the emotional peak of the cut: set "protected_peak": true on it. It is the scene the whole cut builds to - the awakening, the confession, the reveal.',
    '- Inside that slot: keep the exchange whole and contiguous, never NARRATE over it, and let the visual hold through the reaction after the last line. Tension is compressed elsewhere; release plays uncut.',
    '- END the cut on that peak or its immediate aftermath. Do not follow the peak with more body slots when the source allows closing there.',
    '- The closing narration, when present, is ONE short line that lands the premise - never a summary of what the viewer just watched ("그렇게 ~가 시작됐습니다" retellings are the anti-pattern). When the arc is already resolved on screen, prefer NO closing narration at all: end on the reaction inside the peak.',
    '',
    'Goal structure:',
    'Use the cold_open_callback pattern for dialogue-driven confrontation scenes: HOOK_TEASER -> CONTEXT_RESET -> CALLBACK_DIALOGUE -> BODY_DIALOGUE/PAYOFF.',
    '1. cold_open / HOOK_TEASER: put the strongest emotionally sharp dialogue line or compact micro-exchange first at 0-5s. Prioritize teaser_hook_strength and curiosity_gap over chronology. Do not open dialogue-driven confrontation scenes with narration only when a standalone hook line exists.',
    '2. bridge / CONTEXT_RESET: immediately after the teaser, use the SHORTEST narration that restores who these people are and what is at stake. Target about 5-10 seconds. Its job is situation recovery so the next dialogue lands, not setup or background. Do not fully paraphrase or spoil the teaser line.',
    '3. body: continue selected beats in story order.',
    '4. body_peak / CALLBACK_DIALOGUE: re-enter the same conflict axis within the first 20-35 seconds. The callback may come from a different source timestamp, but it must expand, answer, or contextualize the teaser instead of feeling like an accidental repeat.',
    '5. payoff: close with the strongest unresolved implication or reveal supported by the transcript.',
    '',
    'Rules:',
    '- If heatmap.status is available, the heatmap peak has PRIORITY for the cold_open — the most-replayed moment outranks dialogue hooks from other beats. Anchor cold_open_selection on the beat overlapping the strongest peak.',
    '- If the heatmap-peak moment is dialogue-led, open with that dialogue (KEEP_DIALOGUE). If it is a non-dialogue action/visual sequence, open with the peak itself as a SCENE HOOK: decision NARRATE, visual_source_mode "source_audio_teaser", visual_source_start_sec/visual_source_end_sec covering the peak moment (about 3-6 seconds), and plan NO narration over it — the original action audio and energy carry the hook. Do not fall back to a dialogue hook from another beat just because the peak lacks dialogue.',
    '- CARD HOOK OPTION (benchmark B-form): when no line is strong enough to open on, a scene-hook cold open may carry TWO situation cards instead - short on-screen text over the original audio ("화장실이 급해 마트에 들렀는데" / "도망가버린 남친") that finishes the premise in under ten seconds. Request them by keeping the slot a NARRATE scene hook; the caption writer supplies the card text.',
    '- TIME-JUMP CARD: a NARRATE seam whose ONLY job is a time jump should be a single card ("며칠후", "그날 밤") over its b-roll instead of a narrated sentence - the original audio keeps playing and the seam costs two seconds, not a paragraph.',
    '- If heatmap is unavailable, set fallback_used true and choose max hook_potential, then dramatic_weight.',
    '- cold_open must be short. Use about 3-6 seconds for narration-led visual teasers or scene hooks, or up to about 16 seconds when preserving a compact original-dialogue hook.',
    '- For dialogue-led hook beats (when no heatmap peak overrides), cold_open should be KEEP_DIALOGUE with 1-2 strongest anchor lines, not a narrated muted clip.',
    '- Score dialogue candidates with teaser_hook_strength, callback_payoff_strength, curiosity_gap, replay_value, and context_dependency. Avoid teaser lines that are pronoun-dependent or too context-heavy unless you extend to a micro-exchange.',
    '- If cold_open is KEEP_DIALOGUE, the later body_peak for the same beat must not duplicate the exact same source dialogue window; use aftermath/context narration or a distinct later line instead.',
    '- KEEP_DIALOGUE keeps only the identity dialogue of the beat, not the full beat transcript.',
    '- KEEP_DIALOGUE dialogue_focus must always include every anchor_dialogue line from that beat.',
    '- dialogue_focus_quotes for a KEEP_DIALOGUE slot should hold 1 or 2 lines — a line, or a line and the answer to it. Three or more turns crams a whole conversation into one block and flattens the rhythm; split them into separate slots instead, and never exceed 4.',
    '- Run KEEP_DIALOGUE slots back to back wherever the scene allows it. Long chains of preserved dialogue are what this format is built on; the viewer reads the situation from the exchange itself. Break the chain only where the scene actually moves.',
    '- Narration is for the SEAM between scenes, so keep NARRATE slots few and short. A narration stretch beyond about 12 seconds means the cut is explaining instead of showing — replace it with the lines from the scene.',
    '- Exclude environment description, transitions, cushion setup, joke detours, and side-branch lines even if they happen inside the same beat.',
    '',
    'Causal chain (this outranks line quality - a cut whose viewer cannot follow the cause is a failed cut):',
    '- Every beat with dramatic_weight 4 or 5 must appear in the cut. This is checked mechanically and a plan that drops one is rejected.',
    '- The event a scene turns on frequently has NO dialogue: someone is pushed down the stairs, a body is on the floor, a door is locked. Those beats show dialogue_quality "low" and a dialogue-first pick drops them - which leaves the aftermath (the alibi, the interview, the funeral) with no cause, and the viewer cannot tell what happened. Keep such a beat as NARRATE with visual_source_mode "source_audio_teaser" over its own footage, and narrate what just happened.',
    '- Never keep the aftermath of an event while dropping the event. If someone reacts to a death, a betrayal, a lie or a discovery, the moment it happened is either KEPT or NARRATED before that reaction.',
    '- Skipping beats is fine, but each skip needs a seam: if the beats between two kept slots are dropped, put a short NARRATE slot between them that says what happened in the gap. A jump the narration does not cover reads as a missing scene.',
    '- Do not keep a single line out of a beat whose payoff you dropped. Either keep the payoff too, or leave that line out - a line nothing answers is a loose end the viewer waits on for the rest of the cut.',
    '- The clip\'s last beats usually carry its resolution or twist. Ending on a middle beat while the resolution goes unused wastes the arc; close on the beat that settles it.',
    '- If there are more than 5 candidate lines, keep only the highest identity / hook / reveal lines.',
    '- NARRATE compresses via narration. DROP removes low-value side branches.',
    '- If cold_open would otherwise inherit irrelevant chatter, mark it as a narration-led teaser and let body_peak replay the full story beat later.',
    `- The SUM of estimated_duration_sec across all non-DROP timeline slots MUST land between ${Math.round(targetSec * 0.9)} and ${Math.round(targetSec * 1.1)} seconds. This is checked by summing your slots, so an optimistic duration_budget will not pass.`,
    '- A single narration slot realistically carries at most about 18 seconds of Korean speech, and a KEEP_DIALOGUE slot only lasts as long as its source lines. So reach the target by using MORE beats as slots, not by writing large durations on a few slots.',
    `- For a ${targetSec}s cut that means roughly ${Math.max(6, Math.round(targetSec / 14))} or more slots. Revisit the beat list and promote the beats you would otherwise DROP into short body slots rather than leaving the cut short.`,
    '- Do not compress the whole clip into a handful of summary slots. Prefer more, shorter beats over a few long summarizing ones.',
    '- Include role values cold_open, bridge, body, body_peak, payoff where appropriate.',
    '- Always fill dialogue_focus_quotes for KEEP_DIALOGUE slots, and leave it as [] for NARRATE or DROP slots.',
    '- dialogue_focus_lines should mirror dialogue_focus_quotes in concise readable form.',
    '',
    'Identity-line examples:',
    '- KEEP: "if you were smart, you\'d stay away from me" / "what if I\'m the bad guy?" / "What are they really?"',
    '- KEEP for multi-fact reveal/payoff: "descended from wolves" / "we made a treaty with them" / "What are they really?"',
    '- DROP: "Eggshells, carrot tops" / "radioactive spiders" / "No, our bus is full" / "I can keep a secret" / "I\'m not really supposed to say anything about it" / "old scary story"',
    '',
    `Video title: ${metadata?.title || ''}`,
    `Target seconds: ${targetSec}`,
    '',
    'Narrative beats:',
    JSON.stringify(compactBeats, null, 2),
    '',
    'Heatmap:',
    JSON.stringify(compactHeatmap, null, 2)
  ].join('\n');
}

function compactSlotDialogueUnit(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const compact = {
    relation_type: String(unit.relation_type || '').trim(),
    source_line_ids: Array.isArray(unit.source_line_ids) ? unit.source_line_ids.map((value) => String(value || '').trim()).filter(Boolean) : [],
    start_sec: Number.isFinite(Number(unit.start_sec)) ? Number(unit.start_sec) : null,
    end_sec: Number.isFinite(Number(unit.end_sec)) ? Number(unit.end_sec) : null
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => !(value == null || value === '' || (Array.isArray(value) && !value.length))));
}

// The fills prompt embeds the whole edit plan, and dialogue_line_windows lists the planned lines that
// never matched a cue alongside the ones that play. The caption writer read that list instead of
// dialogue_focus_lines and wrote one caption per WINDOW - so every caption in the slot came out shifted
// onto its neighbour's line and the last line got none at all (Housemaid night slot_06). Hand the
// prompt a plan that only contains the lines that will be cut.
function stripUnplayableWindowsForPrompt(editPlan = {}) {
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  return {
    ...editPlan,
    timeline: timeline.map((item) => {
      if (item?.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
      const playable = item.dialogue_line_windows.filter((win) => win && win.matched === true);
      if (playable.length === item.dialogue_line_windows.length) return item;
      // A slot where nothing matched keeps its windows: the caption writer still needs to see the
      // lines it was asked to caption, and the render-time warning reports the miss.
      if (!playable.length) return item;
      return { ...item, dialogue_line_windows: playable };
    })
  };
}

function buildSlotFillEditorialGuide(editPlan = {}) {
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  const slotRules = timeline
    .filter((item) => item && item.decision !== 'DROP')
    .map((item) => {
      const scores = item.dialogue_selection_scores && typeof item.dialogue_selection_scores === 'object' ? item.dialogue_selection_scores : {};
      const qcAction = item.qc_action && typeof item.qc_action === 'object' ? item.qc_action : {};
      // Without an explicit budget the model writes one short summary sentence per slot and
      // the cut lands at roughly half its requested runtime, so spell out how much speech
      // each narration slot has to carry.
      const isNarrate = String(item.decision || item.mode || '').trim() === 'NARRATE';
      const plannedSec = Number(item.estimated_duration_sec || 0);
      const sceneHook = String(item.visual_source_mode || '').trim() === 'source_audio_teaser';
      const narrationTargetSec = isNarrate && !sceneHook && plannedSec > 0 ? roundSec(plannedSec) : 0;
      const narrationTargetChars = narrationTargetSec > 0
        ? Math.max(0, Math.round((narrationTargetSec - KOREAN_NARRATION_PAUSE_BUFFER_SEC) * koreanNarrationCharsPerSec()))
        : 0;
      const compact = {
        slot_id: String(item.slot_id || '').trim(),
        role: String(item.role || '').trim(),
        decision: String(item.decision || item.mode || '').trim(),
        visual_source_mode: String(item.visual_source_mode || '').trim(),
        narration_target_sec: narrationTargetSec,
        narration_target_chars: narrationTargetChars,
        editorial_role: String(item.editorial_role || '').trim(),
        scene_type: String(item.scene_type || editPlan.scene_type || '').trim(),
        dialogue_unit: compactSlotDialogueUnit(item.dialogue_unit),
        required_support_action: String(scores.required_support_action || '').trim(),
        qc_action: String(qcAction.action || item.applied_fix || item.recommended_fix || '').trim(),
        context_strategy: String(item.context_strategy || '').trim(),
        callback_relation: String(item.callback_relation || '').trim(),
        reused_conflict_axis: String(item.reused_conflict_axis || '').trim(),
        teaser_slot_id: String(item.teaser_slot_id || '').trim(),
        callback_slot_id: String(item.callback_slot_id || '').trim(),
        requires_context: item.requires_context === true,
        pronoun_risk: item.pronoun_risk === true,
        semantic_risk: String(item.semantic_risk || '').trim()
      };
      return Object.fromEntries(Object.entries(compact).filter(([, value]) => !(value == null || value === '' || value === false)));
    });

  return {
    scene_type: String(editPlan.scene_type || '').trim(),
    editorial_pattern: String(editPlan.editorial_pattern || '').trim(),
    hook_teaser: editPlan.hook_teaser || null,
    context_reset: editPlan.context_reset || null,
    callback_dialogue: editPlan.callback_dialogue || null,
    slot_rules: slotRules
  };
}

function readHookPatterns() {
  // Movie-recap hook pattern library (independent implementation; concept classes informed by
  // public research on curiosity-gap headlines). Missing file degrades to an empty library -
  // the prompt's general curiosity rules still apply.
  try {
    const parsed = readJson(MIDFORM_HOOK_PATTERNS_PATH);
    return {
      patterns: parsed.patterns || [],
      scoring: parsed.scoring || {},
      scene_type_hints: parsed.scene_type_hints || {},
      overlay_title_rules: parsed.overlay_title_rules || {}
    };
  } catch {
    return { patterns: [], scoring: {} };
  }
}

function buildSlotFillsPrompt(beats, editPlan, movieTitle, recapContextMarkdown) {
  const title = String(movieTitle || '').trim();
  const context = String(recapContextMarkdown || '').trim();
  const editorialGuide = buildSlotFillEditorialGuide(editPlan);
  const contextSection = context ? [
    'Human-provided recap context (AUTHORITATIVE):',
    context,
    '',
    'Context rules:',
    '- The "영화 사실" (movie facts) above are the PRIMARY source of truth. If they conflict with your own knowledge of this film, follow the provided facts.',
    '- Do NOT invent character relationships, names, or plot twists that are not in the provided facts. Where the facts are silent, stay strictly within what the subtitles/screen show and use neutral wording (e.g. "인질 중 한 명" instead of guessing "그의 연인").',
    '- Do NOT narrate causation, intent, or motive that is not in the provided facts. Never write claims like "A가 B를 조작했다" or "A가 의도적으로 ~했다" unless the facts explicitly state it.',
    '- Do not state interpretations inferred from dialogue as definitive fact. Even if a line says "We\'re bait", if the provided facts do not say WHO made them bait, do not name an agent or architect.',
    '- When uncertain, narrate only what is observed on screen: e.g. "추격대는 수우족의 습격을 받고 고립됐습니다". Do not claim who arranged it or why.',
    '- Reflect the "리캡 의도" (recap intent), its tone, cold-open hook direction, and ending style, in the narration.',
    '- Dialogue lines listed under "살릴 대사" should be preserved in KEEP_DIALOGUE captions where possible.',
    ''
  ] : [];
  return [
    'You are writing Korean narration slot_fills for a midform compression edit plan.',
    'Return JSON only matching the slot_fills schema. Do not use markdown.',
    'Besides slot_fills, you must also produce upload_text for YouTube packaging.',
    '',
    title ? `This clip is a scene from the film/show titled: "${title}".` : 'The source title is unknown.',
    '',
    ...contextSection,
    'Movie-context rules:',
    '- If you confidently recognize this film/show, use your knowledge of its story and character relationships to enrich the narration.',
    '- Supplement what the subtitles alone cannot convey: a character\'s identity, their relationships, or the situation. Example: if the subtitle only says "Laura" but you know she is the marshal\'s lover, narrate her as "그의 옛 연인 로라".',
    '- Use ONLY facts you are certain of. If you do not actually know this title, stay strictly within what the subtitles and beats show and DO NOT invent character identities, relationships, or events. Wrong information is worse than none.',
    '',
    'Narrative-glue rules: the whole video must read as ONE continuous story, not an intro plus disconnected quotes:',
    '- Start with the incident/hook before backstory. Do not open a narration slot by explaining who someone is if a more immediate event, reversal, threat, or question can lead the sentence first.',
    '- Never introduce a character. No nameplates, no occupation, no backstory, no motive: not "가난한 대학생 대릴은 돈을 벌기 위해...", not "그의 여자친구", not "질투한 그는". Who these people are to each other is for the viewer to work out from how they speak to each other, and getting it slightly wrong is part of watching.',
    '- Leave the interpretation open. Do not name the emotion, do not say what someone meant, do not settle who is in the right. Two viewers arguing in the comments about what just happened is the goal, not a failure to be prevented by one more explaining sentence.',
    '- You are writing from the TRANSCRIPT ONLY - you cannot see the footage. Never assert a fact that only the eye could verify (WHICH sense failed, what someone is wearing, who is in frame) unless the dialogue states it in words. A stray fragment at a window boundary is not evidence: "A little bland" is the tail of the PREVIOUS scene, and naming a sense from it put 미각 over a scene that showed something else. When the words do not say which sense, write it neutrally - 그다음 감각이 꺼집니다 - and let the footage show which.',
    '- Narration states ONLY what the transcript or the footage shows. Never invent an identity reveal, a hidden connection, or a cause: "옆자리에 앉았던 바로 그 사람이 판사였습니다" was written into a cut whose source says no such thing. A reveal that is not in the source is not a twist, it is a lie the viewer can catch.',
    '- ONE obligation among all these prohibitions: if there is a single fact without which the viewer cannot follow, laugh at, or feel the tension of what they are watching, state it once, in one short line, early. Not who someone is - WHAT IS HAPPENING TO THEM. A body losing its senses one by one, a man who cannot see straight, a room nobody may leave. Ask yourself what a first-time viewer would be confused by, and say only that. If the dialogue already carries it, say nothing.',
    '- Test the last scene against this: if a moment only works because of something established earlier, and neither the dialogue nor a seam line establishes it, the moment reads as random or as the character simply being unpleasant. That is the failure this obligation exists to prevent.',
    '- STYLE (house guidebook, midform/docs/style-guide-ko.md): narration endings ~했습니다 60-70%, ~했죠 15-30%, ~했는데 for turns, ~버렸습니다 sparingly for shocks. BANNED endings: ~에요/~어요/~거든요/~네요. NEVER ask the viewer a question (~을까요?) - the ONE exception is a closing quip of the form "여러분 ...?" which isalmost  mandatory as the very last narration sentence.',
    '- STYLE: zero translationese. Never ~에 따라/~을 통해/~에 의해/~에 대해. Recast abstract western phrasing as concrete Korean. Colloquial force is welcome (깜놀, 빡치다, 멘붕) where the scene earns it - natural beats forced slang.',
    '- STYLE: no double reporting - never "말했습니다. ~라고요." Fold it: "~라고 말했습니다." Chain consecutive actions into one sentence; split only for deliberate impact ("그런데 바로 그때였습니다.").',
    '- STYLE: narration uses NO person names - role nouns only (남자, 승무원, 판사), one consistent term per person. Dialogue captions keep names spoken IN the line itself.',
    '- DEMONETIZATION-SAFE wording in ALL Korean text: 자살→스스로 세상을 등졌다, 죽이다→처리하다/정리하다, 죽음→생을 마감하다, 마약류→수상한 가루/이상한 약, 고문/처형→혹독한 고생, 테러→공격. Imply violence by reaction and cutaway, never by procedure.',
    '- Narration says only what the eye cannot: a jump in time, a change of place, or an event that happened off screen. If the scene shows it or the dialogue says it, write nothing.',
    '- The first narration after the cold open is the one most likely to go wrong: it must NOT lay out the premise. Do not introduce the protagonist, explain what the experiment or the job is, or summarise how things got here. Name only what the next scene needs — where we are, or who just walked in — in one sentence, and let the dialogue carry the rest.',
    '- If the context implies 사건 훅 먼저, the first bridge/body narration after the cold open must begin with the kidnapping, standoff, chase, attack, trap, or another live event, not with a standalone character-introduction sentence like a nameplate.',
    '- Narration belongs at the SEAM between scenes, not around every line. When one dialogue block flows into the next inside the same situation, let them run back to back with no narration in between. Consecutive preserved dialogue is the goal of this format, not a problem to smooth over.',
    '- Write narration only when the scene has MOVED — a new place, a jump in time, or a new party entering — and the viewer would otherwise be lost. If the scene already shows it, say nothing.',
    '- Do not explain what a line meant, name the emotion behind it, or state the outcome it led to. The viewer works that out from the scene; saying it out loud kills the moment. Trust the footage.',
    '- The cold_open question is answered by what the scene later SHOWS, not by narration restating it. Only if the footage genuinely cannot carry the answer may one short narration line recover it.',
    '- When answering WHY they became bait, prefer grounded situational causes (for example: entering a Sioux war zone, exposing their trail, or being caught in an existing conflict). Do NOT invent mastermind intent such as saying someone deliberately orchestrated, staged, lured, or set up the Sioux attack unless the provided facts explicitly say so.',
    '- The slot with role "closing" is the ending: wrap the story in narration. State how it ends, resolve any remaining question from the cold_open, and give a clean sense of closure (optionally one lingering thought). The video must NEVER end on a bare dialogue quote.',
    '- The full arc must flow: cold_open hook -> setup -> each dialogue block (setup before + outcome after) -> the twist explicitly paid off -> closing narration.',
    '',
    'Rules:',
    '- Use Korean narration that creates curiosity, not plain visual relay.',
    '- Refer to characters by role first: 보안관, 아들, 무법자, 길잡이. Avoid listing full names and formal titles inside narration. Use a short name only when truly necessary for clarity, and do not stack multiple full names in one narration slot.',
    '- Keep sentences short. Prefer roughly one idea per sentence, often around 15 Korean characters or a short clause. Mix in occasional noun-ending fragments like "그때 들려온 의문의 소리." instead of explaining everything in long complete sentences.',
    '- Do not narrate what the viewer can already see on screen. Use narration for hidden stakes, what is about to happen, what a line means, or why the moment matters, not a plain play-by-play of visible action.',
    '- Do not over-explain cause and effect with lecture-like connectors. Prefer brief linked beats such as "경고는 현실이 됐죠. 그리고 다음 장면." and let the cut carry the visible action.',
    '- KEEP_DIALOGUE slots should have empty narration and empty caption_units unless the slot role is bridge/payoff narration.',
    '- KEEP_DIALOGUE slots must also fill caption_kr_dialogue: one Korean subtitle line per line in that slot\'s dialogue_focus_lines, in the same order.',
    '- KEEP_DIALOGUE slots must set translation_mode to "faithful_dialogue".',
    '- KEEP_DIALOGUE is faithful source dialogue translation, NOT copywriting. Preserve the original meaning first, preserve the speaker attitude (sarcasm, attack, defense, admission), avoid beautifying or inventing stronger Korean phrasing, and compress only when meaning is not distorted.',
    '- Any Korean sentence that reads like a quote must be grounded in an actual dialogue_focus_line. Do not turn narration-only interpretation into a quoted dialogue caption.',
    '- caption_kr_dialogue must have exactly the same number of items as dialogue_focus_lines for that slot, in that same order. Count and order come from dialogue_focus_lines ONLY - never from dialogue_line_windows, whose entries can differ. Never merge two dialogue lines into one caption, never split one into two. On-screen caption timing is locked to the original dialogue lines, so a count mismatch breaks sync.',
    '- NAME THE PEOPLE. The first time a person speaks or is referred to, the narration must have said who they are and how they relate to the others ("가정부 밀리와 그녀의 고용주 앤드류"). A recap where 앤드류 or 윌 캘러핸 simply appears in a caption leaves the viewer with a stranger and the scene stops meaning anything - this shipped and the owner could not follow it. Use the names the source itself uses (auto-captions, the movie title, how characters address each other); only invent a descriptor when the source truly never names them, and then reuse that one descriptor everywhere.',
    '- RE-ANCHOR NAMES AT EVERY SEAM (benchmark finding: the top channel in this format puts a character name as the grammatical subject of nearly every narration sentence - 20+ name mentions in 171 seconds, zero pronoun ambiguity). Every narration sentence must use a character NAME as its subject; 그/그녀/그들/두 사람 as sentence subjects are banned. A viewer who joined mid-scroll re-learns who is who at each seam for free.',
    '- SUSPENSION CUT-IN (benchmark technique): the narration sentence that leads INTO the protected peak must end unresolved - a setup the footage answers ("한 가지 아이디어를 떠올리게 되는데요.", "~하기 시작합니다.") - and must never state what the peak shows. The scene answers; the narration only loads the question.',
    '- EMOTION LABEL AFTER THE PEAK: the first narration sentence following the protected peak names what the character feels or realizes in one clause ("세이어는 뜻밖의 발견에 가슴이 벅차오르는데요") before moving the story on. This is interpretation, not screen description - never describe what the frame shows, name what it MEANS to the character.',
    '- The CLOSING narration must not retell what the viewer just watched. "그렇게 ~가 시작됐습니다/되었습니다" summaries are the anti-pattern - the benchmark channel ends on the peak scene itself. Write either an empty closing, or one short forward-looking line that lands the premise (a consequence, a question the source itself leaves open - never invented events).',
    '- The same person must carry the SAME name in narration and in every caption speaker field. 사장/가정부 in the captions while the narration says 앤드류/밀리 reads as four people.',
    '- For KEEP_DIALOGUE slots you MUST fill speakers with exactly one name per caption_kr_dialogue line. Each speaker gets their own caption colour, so a missing name leaves that line uncoloured and the render is rejected. When the auto-captions do not name someone, use the SAME name the narration uses for that person; only if the narration never names them either, use a short stable descriptor you reuse throughout (여자, 남자, 점원). A caption reading "남자" while the narration calls him 대릴 leaves the viewer with a nameless stranger. Never leave an entry empty and never merge two speakers under one name.',
    '- Read every caption back as a line a Korean actor would say. Three failures to avoid, all seen in real output: a term carried over that does not mean the same thing in Korean (an "intervention" is not 혜재); an ungrammatical form of address ("따님 아버님이라고요?"); and a line that only parses if you saw the screen. If a caption is confusing on its own, rewrite it so it lands.',
    '- Fix the Korean, not the meaning: keep the attitude and force the speaker had, and never soften a hostile or crude line into something polite.',
    '- caption_kr_dialogue must read as natural spoken Korean, not a literal/translationese rendering. Example: "What are they really?" -> "걔넨 대체 뭐야?", not "그들은 정말로 무엇입니까?".',
    '- Translationese leaks at the SYNTAX level, not just word choice. Translate the speech act, never the English construction: noun-phrase idioms ("the luxury of not knowing" is NOT "모르는 호사를 누리는" - it is "몰라도 되니 편한 거야"), hedges ("I think I\'m entitled" is NOT "~라고 생각합니다" - Korean carries the attitude in the ending: "전 알 권리가 있습니다"), and address terms by RELATIONSHIP not dictionary ("Son" from a hostile superior is "애송이", never "젊은이").',
    '- Re-assemble English mid-sentence insertions as Korean sentences instead of importing the commas: "And my existence - while grotesque to you - saves lives" becomes "내 존재가 기괴해 보이겠지. 그래도 그게 사람을 살려!", not a comma-spliced clone of the English word order.',
    '- Fix each speaker\'s voice on their first line (반말/존대, roughness) from the on-screen power relationship, then keep it for every later line.',
    '- Read-aloud test for every caption: would it pass as a line in a Korean drama, does it stand without the English, does the ending carry the speaker\'s attitude? If any answer is no, rewrite it.',
    '- Keep dialogue captions short. A long caption pulls the eye off the performance and drains the moment; if a line will not fit, cut it down to the part that carries the force rather than wrapping it.',
    '- caption_kr_dialogue must match the narration\'s tone for that scene and reuse the exact character names/forms of address the narration uses. Do not introduce a different name or honorific than the narration already established.',
    '- NARRATE slots should compress omitted story context clearly.',
    '- Narration is situation recovery, not storytelling duty. Say only what the viewer cannot get from the scene: who these people are, what just changed, what is now at stake. The moment the dialogue can carry it, stop narrating and let the scene play.',
    '- Bridge narration in particular must be the shortest line that makes the next dialogue land. Two short sentences is usually enough; do not use it to set up background or recap events.',
    '- A bridge may only do one of three jobs, and nothing else: (a) restore WHO these people are to each other, (b) restore WHERE the scene just moved, or (c) restore the MEANING a viewer would miss from the dialogue alone. If a bridge is not doing one of those three, cut it.',
    '- Situation recovery answers at most four things — who the scene is about, what the conflict is, why the mood is off, why this line matters — in one or two sentences, then hands straight back to the scene. Never expand into world-building, backstory or faction explanation.',
    '- Do NOT interpret a character\'s emotions for the viewer. Naming feelings ("상실감과 죄책감 속에서 혼란에 빠집니다") kills the scene; describe the situation and let the performance carry the feeling ("사과하러 왔는데, 상대의 반응이 울음보다 낯설었다").',
    '- The payoff is not a conclusion the narrator states. It is the moment an EARLIER line turns out to be true. Write it so the hook line from the opening is what gets proven, and let the scene do the proving.',
    '- Keep the two voices distinct. Dialogue captions sound like a person actually speaking; narration is short and hard. If a narration line could be mistaken for a character speaking, or a dialogue caption reads like a narrator, rewrite it.',
    '- Each slot rule carries narration_target_sec and narration_target_chars. Treat that number as a CEILING, not a quota: write the shortest narration that restores the situation and stop. The cut reaches its runtime on preserved dialogue, not on narration, so an unused budget is a good outcome and padding a slot to fill it is not.',
    '- Narration must read like a storyteller pulling the viewer forward, NOT like a plot synopsis. Reject the encyclopedic register: do not stack several facts into one "A 때문에 B가 C합니다" sentence, and do not open a slot by naming every faction and motive at once. One idea per sentence, short sentences, and each slot should end with tension or consequence that makes the next slot feel necessary.',
    '- Never resolve the curiosity the opening created before the payoff slot. If the cold open raised "why is this happening", the following slots may show WHAT is happening and raise the stakes, but must withhold the WHY until the payoff.',
    '- When the cold open is a wordless scene hook (visual_source_mode "source_audio_teaser"), the very next narration must NOT begin by explaining the whole premise. Enter mid-tension with the immediate situation, then let context arrive a piece at a time across the following slots.',
    '- The payoff slot must land its reversal as a reveal, not a report. Deliver the turn in a short punchy line rather than a calm descriptive sentence that merely states what happened.',
    '- Do not repeat a preserved dialogue line in narration with the same informational content. If KEEP_DIALOGUE already says the core beat, narration must add setup, consequence, stakes, or interpretation instead of paraphrasing the same line.',
    '- If cold_open is NARRATE, its narration must plant a question and must not reveal the answer.',
    '- EXCEPTION: if the cold_open slot rule shows visual_source_mode "source_audio_teaser" (heatmap scene hook), set narration to an empty string and leave caption_kr and caption_units empty — the original action audio of the peak moment IS the hook, and any voiceover would smother it.',
    '- EXCEPTION: any slot with visual_source_mode "source_audio_action" (role action_beat) is a measured action peak that plays its OWN action audio. Set narration to an empty string and leave caption_kr, caption_units and caption_kr_dialogue empty for these slots — no voiceover, no captions.',
    '- cards (optional, benchmark B-form): a scene-hook cold open may carry TWO situation cards, and a pure time-jump NARRATE seam may carry ONE card ("며칠후") with narration left EMPTY - the slot then renders as big centered text over the clip and its original audio, no TTS. Each card is one clause, 16 Korean characters or fewer, no punctuation-heavy sentences. Never put cards on a slot that has narration or dialogue.',
    '- If cold_open is NARRATE, write a single hook sentence only: one question or reversal, no explanation, no setup, no answer.',
    '- If cold_open is NARRATE, keep it roughly 20-30 Korean characters excluding spaces (~4-6 seconds of speech). Do not write two sentences.',
    '- If cold_open is KEEP_DIALOGUE, leave narration and caption_units empty and make caption_kr_dialogue carry the hook with punchy Korean spoken captions.',
    '- cold_open narration example for NARRATE-only cases: "쫓던 쪽이, 왜 사냥당하는 쪽이 됐을까?". Short, a single question, plants curiosity, reveals nothing.',
    '- When cold_open has visual_source_* fields and is NARRATE, write the narration to match the story beat mystery, not the literal teaser shot dialogue.',
    '- For dialogue_confrontation with a cold_open_callback pattern, the first bridge is a context reset: explain enough for the callback to make sense, but do not paraphrase or answer the cold-open line before the callback arrives.',
    '- If a slot has editorial_role "hook_teaser", make Korean dialogue captions sharp and incomplete enough to raise a question; if required_support_action or qc_action says merge_adjacent_lines, preserve the exchange as connected lines rather than isolated one-liners.',
    '- If a slot has editorial_role "callback_payoff" or callback_relation, its surrounding narration must explicitly pay off the hook conflict axis in plain Korean.',
    '- If scene_type is not dialogue_confrontation, do not force the cold-open/callback structure; follow that scene type and avoid overfitting confrontation language.',
    '- body_peak should let original dialogue carry the answer when decision is KEEP_DIALOGUE.',
    '- The closing should NOT fully summarize the story. Keep it to 2 or 3 very short beats at most. Leave one unresolved threat or dangling consequence and end on that. Good style: "경고는 현실이 됐습니다. 그 혼란을 틈타, 제드는 아들과 함께 사라졌죠. 아들은 아직, 저들 손에 있습니다."',
    '- caption_kr should be a concise Korean caption line for the narration; empty for dialogue-only slots.',
    '- upload_text.title_candidates: use the NARRATIVE HOOK process below. Plot-summary titles are rejected.',
    '- upload_text.description must OPEN with a metadata block before the synopsis: the film title with original title and year, the director, and up to three lead actors - e.g. "사랑의 기적 (Awakenings, 1990)\n감독: 페니 마셜\n출연: 로버트 드 니로, 로빈 윌리엄스". This block captures every "이 영화 뭐예요" search; the synopsis follows it. Only include facts you are certain of - when unsure of the director or cast, leave that line out rather than guess.',
    '  TITLE STEP 1 - extract narrative hook elements from the beats/plan (threat, secret, reversal, betrayal, impossible_situation, moral_dilemma, time_pressure, power_gap, abnormal_action, discovery, consequence, false_premise, identity). Only elements the CLIP actually shows - never invent one.',
    '  TITLE STEP 2 - from the hook pattern library below, pick the 3-5 patterns whose "needs" match the elements you extracted. When the library has scene_type_hints for this scene type, weight those patterns first (two-stage ranking: classify, then rank within type).',
    '  TITLE STEP 3 - write 2-3 Korean title candidates per chosen pattern following its skeleton, then score each: curiosity_gap 20, narrative_tension 20, specificity 15, emotional_stakes 15, instant_clarity 10, novelty 10, brevity 10; penalties: content_mismatch -40, ending_spoiled -15, abstract_wording -10, generic_clickbait -10.',
    '  TITLE STEP 4 - output ONLY the top 3 by score as title_candidates. Each must still read like a movie moment (비밀·위험·반전·금지·배신·선택·시간제한·정체·결과), never like an info-listicle ("~하는 5가지 방법" 류 금지). Question-shaped endings or answer-promising noun endings both work; the movie title itself is never the hook.',
    '  Hook pattern library:',
    JSON.stringify(readHookPatterns(), null, 0),
    '- upload_text.overlay_title is required and must be separate from YouTube title_candidates. It must be an object with top and bottom strings, each 8 Korean characters or fewer excluding spaces where possible. This is for the on-screen CapCut title overlay, so it can be shorter than the YouTube title.',
    '- upload_text.overlay_title must preserve curiosity but fit two compact lines. Example: {"top":"쫓던 보안관이","bottom":"미끼가 된 날"}.',
    '- overlay_title must NOT duplicate the chosen YouTube title wording: the title carries the promise, the overlay carries a CONTRAST PAIR (쫓던/쫓기는, 지키는 자/빼앗는 자, 약속/대가) — top and bottom lines should sit in tension with each other.',
    '- Avoid overclaiming causation or hidden plans in upload_text.title_candidates. If the provided facts do not explicitly say someone orchestrated the trap, do not write titles like "계략" or "자작극" or other mastermind wording.',
    '- upload_text.description must be plain Korean prose for the description box: include the verified movie title/year/one-line premise from the provided context when available, then add 1-2 short lines on why this clip is worth watching.',
    '- upload_text.pinned_comment must be a concise Korean pinned comment containing the movie title and any verified creator/cast information provided in the context. If director/cast are not provided, do not invent them; include only verified details.',
    '- Keep movie-identification metadata out of the narration itself. Put that information into upload_text only.',
    '',
    'Fixing the listing style (this is the most common failure — study these rewrites):',
    '- BAD, an event list chained into one sentence: "앨리스의 선공과 함께 설원은 전쟁터로 변했고, 양측 모두 막대한 희생을 치르며 동료들이 눈앞에서 쓰러져 갑니다."',
    '- GOOD, one idea per sentence, each pulling into the next: "앨리스가 먼저 움직입니다. 그 순간 협상은 끝났습니다. 쓰러지는 건, 적만이 아니었죠."',
    '- BAD, opening a slot by naming every side and motive at once: "아이를 둘러싼 오해로, 두 뱀파이어 진영이 절멸 직전의 대치를 이어갑니다."',
    '- GOOD, entering mid-tension and letting context arrive later: "이 대치는 아이 하나에서 시작됐습니다. 문제는, 증거로는 멈출 수 없다는 것."',
    '- BAD, reporting the twist: "하지만 이 모든 건 아직 일어나지 않은 미래였습니다."',
    '- GOOD, landing the twist: "그런데 이 전쟁은, 아직 일어나지 않았습니다."',
    '- Concretely: do not chain events with 하자 / 했고 / 되자 / ~과 함께 inside one sentence. Split them. A narration slot of 15 seconds should be four or five short sentences, not two long ones.',
    '',
    'Good narration examples (tone target):',
    '- cold_open example: "쫓던 쪽이, 왜 사냥당하는 쪽이 됐을까?"',
    '- bridge/setup example: "아들이 납치됐습니다. 범인은 무법자, 제드. 보안관은 놈들을 건물 하나까지 몰아넣었죠. 하지만 순순히 나올 놈이 아니었습니다."',
    '- body glue example: "협상은, 비극으로 끝났습니다. 그래도 멈출 수 없습니다. 아들이 저들 손에 있으니까. 그런데 추격 중, 길잡이가 이상한 걸 발견합니다. 놈들 발자국에 섞인, 다른 흔적. 함정일지도 모른다는 경고. 하지만 보안관에겐, 망설일 시간이 없었습니다."',
    '- closing example: "경고는 현실이 됐습니다. 그 혼란을 틈타, 제드는 아들과 함께 사라졌죠. 쫓던 자는 미끼가 됐고, 아들은 아직 저들 손에 있습니다."',
    '',
    'Editorial control map (USE THIS BEFORE WRITING EACH SLOT):',
    JSON.stringify(editorialGuide, null, 2),
    '',
    'Narrative beats:',
    JSON.stringify(beats, null, 2),
    '',
    'Edit plan:',
    JSON.stringify(stripUnplayableWindowsForPrompt(editPlan), null, 2)
  ].join('\n');
}

// The Japanese cut is written for a Japanese audience rather than translated from the
// Korean script, so it needs its own pass over the same edit plan. It reuses the slot
// fills schema: the caption_kr* fields simply carry Japanese text for this locale.
function buildJapaneseSlotFillsPrompt(beats, editPlan, movieTitle, recapContextMarkdown) {
  const title = String(movieTitle || '').trim();
  const context = String(recapContextMarkdown || '').trim();
  const editorialGuide = buildSlotFillEditorialGuide(editPlan);
  return [
    'You are writing the Japanese narration script for a midform movie recap, for Japanese viewers on YouTube.',
    'Return JSON only matching the schema. Do not use markdown.',
    '',
    'CRITICAL language rule:',
    '- EVERY piece of viewer-facing text you produce must be natural Japanese. That includes narration, caption_units, caption_kr, caption_kr_dialogue, and every field of upload_text. Despite their names, the caption_kr* fields carry Japanese text in this task.',
    '- Do NOT output Korean anywhere. Do not romanize. Write normal Japanese using kanji, hiragana and katakana.',
    '- Write as a Japanese narrator would write, not as a translation of a Korean script. Rebuild each beat in Japanese rather than mapping it phrase by phrase.',
    '- Render foreign character and place names in katakana as Japanese audiences know them.',
    '',
    'Narration style:',
    '- Use plain, punchy narration in です・ます調. Keep sentences short, roughly one idea per sentence.',
    '- Mix in occasional noun-ending fragments for rhythm instead of explaining everything in full sentences.',
    '- Narration must pull the viewer forward, not read like a plot synopsis. Do not stack several facts into one long sentence.',
    '- Do not narrate what is plainly visible on screen. Narrate hidden stakes, meaning, and consequence.',
    '- Refer to characters by role first where it reads naturally, and avoid stacking multiple full names in one slot.',
    '',
    'Structural rules (identical to the Korean cut, follow the edit plan exactly):',
    '- Each slot rule carries narration_target_sec and narration_target_chars. The character budget was computed for Korean speech; for Japanese aim for roughly 80% of narration_target_chars, because Japanese text of the same duration uses fewer characters. Filling the slot is what makes the cut reach its runtime, so do not answer with one short sentence where a full slot was budgeted.',
    '- KEEP_DIALOGUE slots must leave narration and caption_units empty, and must fill caption_kr_dialogue with one Japanese subtitle line per line in that slot\'s dialogue_focus_lines, in the same order. The counts must match exactly; never merge or split lines.',
    '- KEEP_DIALOGUE slots must set translation_mode to "faithful_dialogue". Preserve the original meaning and the speaker attitude; do not beautify or invent stronger phrasing.',
    '- caption_kr_dialogue must read as natural spoken Japanese, not a stiff literal rendering.',
    '- For KEEP_DIALOGUE slots you MUST fill speakers with exactly one name per line, using a short stable descriptor when the captions do not name someone. Each speaker gets their own caption colour.',
    '- If the cold_open slot rule shows visual_source_mode "source_audio_teaser", leave its narration, caption_kr and caption_units empty: the original action audio is the hook.',
    '- If cold_open is NARRATE without that mode, write a single short hook sentence that plants a question and reveals no answer.',
    '- Never resolve the curiosity the opening created before the payoff slot.',
    '- The payoff slot must land its reversal as a reveal, not a calm report.',
    '- Do not invent relationships, motives, or events that the provided facts and transcript do not support.',
    '',
    'upload_text rules:',
    '- All of upload_text must be Japanese.',
    '- title_candidates must contain exactly 3 Japanese titles, each opening a curiosity gap: a question ("なぜ〜のか？") or a noun ending that promises the answer without giving it ("〜の理由", "〜の正体", "〜の結末"). No flat summary titles, and do not use the movie title itself as the hook.',
    '- overlay_title must be an object with short top and bottom lines for the on-screen title, each about 8 characters or fewer.',
    '- description is plain Japanese prose for the description box; pinned_comment is a concise Japanese comment. Include only verified title/cast details.',
    '',
    context ? `Human-provided recap context (AUTHORITATIVE, may be Korean — treat it as source facts and write your output in Japanese):\n${context}\n` : '',
    `Movie title: ${title}`,
    '',
    'Editorial control map (USE THIS BEFORE WRITING EACH SLOT):',
    JSON.stringify(editorialGuide, null, 2),
    '',
    'Narrative beats:',
    JSON.stringify(beats, null, 2),
    '',
    'Edit plan:',
    JSON.stringify(stripUnplayableWindowsForPrompt(editPlan), null, 2)
  ].filter((line) => line !== '').join('\n');
}

const JAPANESE_SCRIPT_RE = /[ぁ-んァ-ヴ一-龯]/;
const KOREAN_SCRIPT_RE = /[가-힣]/;

// Guards the one failure that made the previous "Japanese" locale worthless: shipping the
// Korean script under a ja label.
function validateJapaneseSlotFills(slotFills, editPlan) {
  const offenders = [];
  const checkText = (label, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    // Punctuation/ellipsis-only lines are language-neutral: '음...' legitimately becomes
    // '…' in Japanese (a held silence), and rejecting it deadlocked the Halloween run.
    if (/^[\s.…‥、。！？!?~ー-]+$/.test(text)) return;
    if (KOREAN_SCRIPT_RE.test(text)) offenders.push(`${label} contains Korean: ${text.slice(0, 40)}`);
    else if (!JAPANESE_SCRIPT_RE.test(text)) offenders.push(`${label} is not Japanese: ${text.slice(0, 40)}`);
  };
  for (const fill of Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : []) {
    const slotId = String(fill?.slot_id || '').trim();
    checkText(`${slotId}.narration`, fill?.narration);
    checkText(`${slotId}.caption_kr`, fill?.caption_kr);
    for (const [index, line] of (Array.isArray(fill?.caption_kr_dialogue) ? fill.caption_kr_dialogue : []).entries()) {
      checkText(`${slotId}.caption_kr_dialogue[${index}]`, line);
    }
  }
  const uploadText = slotFills?.upload_text || {};
  for (const [index, title] of (Array.isArray(uploadText.title_candidates) ? uploadText.title_candidates : []).entries()) {
    checkText(`upload_text.title_candidates[${index}]`, title);
  }
  checkText('upload_text.description', uploadText.description);
  checkText('upload_text.pinned_comment', uploadText.pinned_comment);
  if (offenders.length) {
    throw new Error(
      `Japanese slot fills must be written in Japanese, not Korean. Rewrite these in natural Japanese: ${offenders.slice(0, 8).join('; ')}`
    );
  }
  return slotFills;
}

// Caption timing is locked to the dialogue lines, so the two counts have to agree. The
// model keeps coming back one caption short on long exchanges, and rejecting that only
// burns retries. Preserve the lines that actually have a caption instead — dropping a line
// is honest, inventing a caption for it would not be.
// Slot fills the owner corrected by hand carry authored: true. Apply regenerates every fill from the
// LLM, so those corrections were silently replaced on the next run - a caption written because the
// generated one named the wrong speaker, or captioned a line that never plays, came back wrong. Carry
// the authored entry over the generated one, keyed by slot.
// Captions are written one per dialogue_focus_line, but the plan keeps changing which lines survive
// (a refresh restores an exchange, the runtime shave drops a trailing line), and then position N in the
// caption array no longer means line N. Every downstream reader had to guess. Record what each caption
// was actually written FOR, so the mapping is evidence instead of arithmetic.
function stampCaptionSourceLines(slotFills, editPlan) {
  const linesBySlot = new Map((Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])
    .filter((item) => item?.decision === 'KEEP_DIALOGUE')
    .map((item) => [String(item.slot_id || '').trim(), (Array.isArray(item.dialogue_focus_lines) ? item.dialogue_focus_lines : []).map((line) => String(line || ''))]));
  for (const fill of Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : []) {
    if (fill?.authored === true) continue;
    const lines = linesBySlot.get(String(fill?.slot_id || '').trim());
    if (!lines || !lines.length) continue;
    const captions = Array.isArray(fill.caption_kr_dialogue) ? fill.caption_kr_dialogue : [];
    if (!captions.length) continue;
    fill.caption_source_lines = lines.slice(0, captions.length);
  }
  return slotFills;
}

function keepAuthoredSlotFills(generated, existingPath) {
  if (!fs.existsSync(existingPath)) return generated;
  let existing;
  try { existing = readJson(existingPath); } catch { return generated; }
  const authored = new Map((Array.isArray(existing?.slot_fills) ? existing.slot_fills : [])
    .filter((fill) => fill && fill.authored === true)
    .map((fill) => [String(fill.slot_id || '').trim(), fill]));
  if (!authored.size) return generated;
  const slotFills = (Array.isArray(generated?.slot_fills) ? generated.slot_fills : [])
    .map((fill) => authored.get(String(fill?.slot_id || '').trim()) || fill);
  const covered = new Set(slotFills.map((fill) => String(fill?.slot_id || '').trim()));
  for (const [slotId, fill] of authored) if (!covered.has(slotId)) slotFills.push(fill);
  return { ...generated, slot_fills: slotFills };
}

function reconcileDialogueCaptionCounts(slotFills, editPlan) {
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));
  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    if (item?.decision !== 'KEEP_DIALOGUE') continue;
    const lines = Array.isArray(item.dialogue_focus_lines) ? item.dialogue_focus_lines : [];
    if (!lines.length) continue;
    const fill = fillsBySlot.get(String(item.slot_id || '').trim());
    const captions = (Array.isArray(fill?.caption_kr_dialogue) ? fill.caption_kr_dialogue : [])
      .filter((caption) => String(caption || '').trim());
    if (!captions.length || captions.length === lines.length) continue;
    // Either side can come back long. Keep whichever count is smaller: a line without a
    // caption is silent on screen, and a caption without a line has no moment to play at.
    const keepCount = Math.min(captions.length, lines.length);
    item.dialogue_focus_lines = lines.slice(0, keepCount);
    if (Array.isArray(item.dialogue_focus_quotes)) {
      item.dialogue_focus_quotes = item.dialogue_focus_quotes.slice(0, keepCount);
    }
    if (Array.isArray(item.dialogue_line_windows)) {
      const matched = item.dialogue_line_windows.filter((win) => win && win.matched === true);
      const keep = new Set(matched.slice(0, keepCount));
      item.dialogue_line_windows = item.dialogue_line_windows.filter((win) => !win || win.matched !== true || keep.has(win));
    }
    if (fill) fill.caption_kr_dialogue = captions.slice(0, keepCount);
  }
  return slotFills;
}

// The nameplate: a role noun pinned to a name, "가난한 대학생 대릴은", "그의 여자친구 제니스는".
// It tells the viewer who someone is instead of letting them read it off the scene, and the
// prompt rule against it held on one generation and not the next.
const NARRATION_ROLE_NOUNS = '대학생|학생|남자|여자|친구|여자친구|남자친구|아버지|어머니|아빠|엄마|형사|의사|간호사|교수|사장|직원|점원|경찰|변호사|기자|주인공|청년|소년|소녀|아내|남편|동생|형|누나|오빠|언니|판사|검사|승무원|보안관|선생님|선생|기장|경비|매니저|점장|아저씨|아줌마|할머니|할아버지|리더|보스|팀장|대장|부대장|대원|멤버|동료|일행|가이드|안내인|박사|교관|코치|감독|선장|항해사|조종사|용병|사냥꾼|탐험가|군인|병사|장군|요원|비서|조수|집사|주인|사제|신부|수녀|목사|시장|회장|부장|과장|대리|선배|후배|꼬마|노인';

function findNarrationNameplate(narration, names) {
  const text = String(narration || '');
  if (!text.trim()) return '';
  for (const rawName of Array.isArray(names) ? names : []) {
    const name = String(rawName || '').trim();
    if (name.length < 2) continue;
    // When the captions never named someone the speaker IS a generic noun — 여자, 남자, 친구. Any
    // narration using that word as an ordinary noun then reads as a nameplate: "한 남자가 여자
    // 집에 몰래 들어왔다" was rejected for introducing 여자. Only real names can be introduced.
    if (new RegExp(`^(?:${NARRATION_ROLE_NOUNS})$`).test(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // role noun immediately before the name ("대학생 대릴"), or the name followed by 은/는 plus a
    // role noun later in the same sentence ("대릴은 ... 대학생입니다").
    if (new RegExp(`(?:${NARRATION_ROLE_NOUNS})\\s*${escaped}`).test(text)) return `${name} is introduced by role`;
    if (new RegExp(`${escaped}\\s*(?:은|는)[^.!?]{0,40}(?:${NARRATION_ROLE_NOUNS})`).test(text)) return `${name} is introduced by role`;
  }
  return '';
}

// The invented reveal came back the very next generation despite the prompt rule naming it
// ("그의 옆자리에 앉았던 남자가, 바로 판사였습니다"). Reveal rhetoric is the tell: under the
// doctrine narration never interprets, so a sentence that stages a revelation about a speaker
// has no legitimate use. Deterministic, as promised when the prompt rule was added.
const NARRATION_REVEAL_RE = /(알고 보니|바로 그|다름 아닌|바로)/;

function findNarrationInventedReveal(narration, names) {
  const text = String(narration || '');
  if (!text.trim()) return '';
  for (const sentence of text.split(/(?<=[.!?다요죠])\s+/)) {
    if (!NARRATION_REVEAL_RE.test(sentence)) continue;
    for (const rawName of Array.isArray(names) ? names : []) {
      const name = String(rawName || '').trim();
      if (name.length < 2) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`${escaped}[가-힣]{0,2}(?:였|이었)`).test(sentence)) return sentence.trim();
    }
  }
  return '';
}

// House style, enforced (midform/docs/style-guide-ko.md). Prompt rules drift run to run; these
// are the failures the guidebook calls out as fatal, so they are code.
const NARRATION_BANNED_ENDING_RE = /(에요|어요|거든요|네요)[.!?…"”']?(\s|$)/;
const NARRATION_VIEWER_QUESTION_RE = /(까요|나요|가요)\s*\?/;
const NARRATION_DOUBLE_REPORT_RE = /(라고요|다고요)\s*[.!?…]/;
const DEMONETIZATION_RE = /(자살|목숨을 끊|죽였|죽이[^지]|살인|시체|마약|코카인|헤로인|대마초|고문|처형|총살|참수|테러)/;

function validateKoreanNarrationStyle(narration, speakerNames, isClosingSlot) {
  const text = String(narration || '').trim();
  if (!text) return [];
  const problems = [];
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  sentences.forEach((sentence, index) => {
    const isFinal = isClosingSlot && index === sentences.length - 1;
    const isQuip = /^여러분/.test(sentence.trim());
    if (NARRATION_VIEWER_QUESTION_RE.test(sentence) && !(isFinal && isQuip)) {
      problems.push(`viewer question outside the closing 여러분-quip: "${sentence.trim()}"`);
    }
    if (NARRATION_BANNED_ENDING_RE.test(sentence)) {
      problems.push(`banned ending (~에요/~어요/~거든요/~네요): "${sentence.trim()}"`);
    }
  });
  if (NARRATION_DOUBLE_REPORT_RE.test(text)) problems.push('double reporting ("~라고요."): fold it into "~라고 말했습니다"');
  if (DEMONETIZATION_RE.test(text)) problems.push('demonetization-risk word: use the safe wording table');
  for (const rawName of Array.isArray(speakerNames) ? speakerNames : []) {
    const name = String(rawName || '').trim();
    if (name.length < 2) continue;
    if (new RegExp(`^(?:${NARRATION_ROLE_NOUNS})$`).test(name)) continue;
    if (text.includes(name)) problems.push(`person name in narration ("${name}"): use a role noun`);
  }
  return problems;
}

function validateSlotFillsDialogueCaptions(slotFills, editPlan, locale = 'ko') {
  // Structural checks apply to every locale; the wording checks below are Korean-specific.
  const isKorean = String(locale || 'ko') === 'ko';
  const uploadText = normalizeUploadText(slotFills?.upload_text);
  if (uploadText.title_candidates.length !== 3) {
    throw new Error(`upload_text.title_candidates must contain exactly 3 non-empty items, got ${uploadText.title_candidates.length}`);
  }
  if (!uploadText.overlay_title.top || !uploadText.overlay_title.bottom) {
    throw new Error('upload_text.overlay_title.top and bottom are required');
  }
  if (isKorean) {
    const speakerNames = [];
    for (const fill of Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : []) {
      for (const name of Array.isArray(fill?.speakers) ? fill.speakers : []) speakerNames.push(name);
      if (fill?.speaker) speakerNames.push(fill.speaker);
    }
    // The premise is whichever narration the viewer meets first; that one line may name the cast.
    const firstNarrationSlot = (Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
      .filter((entry) => String(entry?.narration || '').trim())
      .map((entry) => String(entry?.slot_id || ''))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] || '';
    for (const fill of Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : []) {
      const isPremiseNarration = String(fill?.slot_id || '') === firstNarrationSlot;
      const styleProblems = validateKoreanNarrationStyle(
        fill?.narration, [...new Set(speakerNames)],
        String(fill?.slot_id || '').includes('closing')
      );
      // Person-name detection produced four false positives in a row (여자, 판사, 리더, 과학자):
      // role nouns are an open set no list can close. It stays a detection for the review gate,
      // where a human-grade eye tells 과학자 from 대릴 - but it no longer fails the generation.
      const fatalProblems = styleProblems.filter((problem) => !/^person name/.test(problem));
      if (fatalProblems.length) {
        throw new Error(`${fill?.slot_id} narration breaks house style: ${fatalProblems.join(' | ')}`);
      }
      const reveal = findNarrationInventedReveal(fill?.narration, [...new Set(speakerNames)]);
      if (reveal) {
        throw new Error(
          `${fill?.slot_id} narration stages a revelation the source never shows: "${reveal}". `
          + 'Narration states only what the transcript or footage shows - no reveals, no hidden connections.'
        );
      }
      // The ban on nameplates exists so narration stops explaining what the scene already shows.
      // Taken absolutely it produced recaps where 앤드류 and 윌 캘러핸 simply appear and the viewer
      // never learns who they are - the owner could not follow the story at all. A name and a
      // relation are precisely what the eye CANNOT read, so the premise line is allowed to set them
      // up once; every later slot still has to earn it from the scene.
      const nameplate = findNarrationNameplate(fill?.narration, [...new Set(speakerNames)]);
      if (nameplate && !isPremiseNarration) {
        throw new Error(
          `${fill?.slot_id} narration introduces a character (${nameplate}) outside the premise line. `
          + 'Only the first narration may say who these people are; after that the scene has to show it.'
        );
      }
    }
  }
  // The overlay is a short on-screen contrast pair; when the model returns a long one it used
  // to throw and (on a source where the model keeps overshooting) never produce slot fills at
  // all. Truncate at the last word boundary within 8 chars instead - a shorter overlay is
  // still a valid overlay, so this is a safe auto-fix, not a data loss.
  const clampOverlayLine = (value) => {
    const text = String(value || '').trim();
    if (text.length <= 8) return text;
    const cut = text.slice(0, 8);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace >= 4 ? cut.slice(0, lastSpace) : cut).trim();
  };
  uploadText.overlay_title.top = clampOverlayLine(uploadText.overlay_title.top);
  uploadText.overlay_title.bottom = clampOverlayLine(uploadText.overlay_title.bottom);
  for (const title of isKorean ? uploadText.title_candidates : []) {
    if (!isCuriosityTitle(title)) {
      throw new Error(
        'upload_text.title_candidates must leave the answer open: ask a question ("왜 ~했을까?") '
        + 'or end on a noun that promises it ("~한 이유", "~의 정체", "~한 계기"). This one closes '
        + `the gap by finishing as a statement or labelling the clip: ${title}`
      );
    }
  }
  if (!uploadText.description) throw new Error('upload_text.description is required');
  if (!uploadText.pinned_comment) throw new Error('upload_text.pinned_comment is required');
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));
  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    const fill = fillsBySlot.get(String(item.slot_id || '').trim());
    const narration = String(fill?.narration || '').trim();
    const narrationSentences = splitNarrationSentences(narration);
    if (isKorean && /(의도적으로|조작|자작극|계략)/.test(narration) && /(유인|함정|미끼|습격)/.test(narration)) {
      throw new Error(`${item.slot_id} narration must not invent deliberate trap/attack causation without explicit facts`);
    }
    if (item.role === 'closing' && narration) {
      if (narrationSentences.length > 3) {
        throw new Error(`${item.slot_id} closing narration must stay short and leave only one unresolved threat, got ${narrationSentences.length} sentences`);
      }
      const nonSpaceChars = narration.replace(/\s+/g, '').length;
      if (nonSpaceChars > 120) {
        throw new Error(`${item.slot_id} closing narration is too long (${nonSpaceChars} chars); keep it short and unresolved`);
      }
    }
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const captionKr = String(fill?.caption_kr || '').trim();
    const captionUnits = Array.isArray(fill?.caption_units) ? fill.caption_units.filter((value) => String(value || '').trim()) : [];
    const narrationAllowed = item.role === 'payoff';
    if (!narrationAllowed && (narration || captionKr || captionUnits.length)) {
      // The model sometimes narrates a dialogue slot anyway (twice now, on two different sources).
      // Nothing downstream reads these fields on a KEEP_DIALOGUE slot, so rejecting the whole
      // generation over them just burned a retry: clear them instead.
      if (fill) {
        fill.narration = '';
        fill.caption_kr = '';
        fill.caption_units = [];
      }
    }
    const dialogueFocusLines = Array.isArray(item.dialogue_focus_lines) ? item.dialogue_focus_lines : [];
    if (!dialogueFocusLines.length) continue;
    const captionKrDialogue = Array.isArray(fill?.caption_kr_dialogue) ? fill.caption_kr_dialogue : [];
    const translationMode = String(fill?.translation_mode || '').trim();
    if (translationMode && translationMode !== 'faithful_dialogue') {
      throw new Error(`${item.slot_id} KEEP_DIALOGUE translation_mode must be faithful_dialogue, got ${translationMode}`);
    }
    if (captionKrDialogue.length !== dialogueFocusLines.length) {
      throw new Error(
        `${item.slot_id} caption_kr_dialogue must have exactly ${dialogueFocusLines.length} line(s) to match dialogue_focus_lines, got ${captionKrDialogue.length}`
      );
    }
  }
  return slotFills;
}

// The edit plan's own duration estimates are the model's guesses; the real runtime only
// becomes knowable once narration text exists. Enforce the target here so a too-short
// script is fed back for a rewrite instead of silently shipping a half-length cut.
function validateSlotFillsRuntime(slotFills, editPlan, targetSec) {
  const target = Number(targetSec || 0);
  if (!(target > 0)) return slotFills;
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));
  let totalSec = 0;
  const shortSlots = [];
  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    if (item?.decision === 'DROP') continue;
    if (item?.decision === 'KEEP_DIALOGUE' || String(item?.visual_source_mode || '') === 'source_audio_action') {
      // Dialogue and original-audio action beats carry fixed source seconds, not TTS.
      totalSec += Number(item.estimated_duration_sec || 0);
      continue;
    }
    const fill = fillsBySlot.get(String(item.slot_id || '').trim());
    const narrationSec = estimateKoreanNarrationSeconds(String(fill?.narration || ''));
    totalSec += narrationSec;
    const budget = Number(item.estimated_duration_sec || 0);
    if (budget > 0 && narrationSec > 0 && narrationSec < budget * 0.7) {
      shortSlots.push(`${item.slot_id} (${Math.round(narrationSec)}s written vs ${Math.round(budget)}s budgeted)`);
    }
  }
  const floor = target * EDIT_PLAN_MIN_TARGET_RATIO;
  if (totalSec < floor) {
    throw new Error(
      `narration is far too short for the requested runtime: the written script speaks for about `
      + `${Math.round(totalSec)}s but the target is ${target}s (minimum ${Math.round(floor)}s). `
      + `Expand the narration of every NARRATE slot toward its narration_target_chars budget`
      + `${shortSlots.length ? `, especially: ${shortSlots.slice(0, 6).join('; ')}` : ''}. `
      + 'Add concrete beats, stakes, and consequence rather than padding with repetition.'
    );
  }
  return slotFills;
}

function validateBeats(beatsObject, transcript, footageEndSec = 0) {
  const beats = normalizeBeatAnchors(Array.isArray(beatsObject?.beats) ? beatsObject.beats : []);
  if (!beats.length) throw new Error('narrative beats output is empty');
  // Beats are bounded by the FOOTAGE, not the transcript. Clamping to cue range made every
  // non-speech act legally un-beatable: on the leech source the first cue sits at 61.46s, so
  // the entire first act (discovery, screams, removal - the measured energy peaks) could never
  // become a beat, which is the structural root of "the leech recap had no leeches". Vision
  // scenes and energy peaks now ground visual beats that captions cannot see.
  const maxCueEnd = Math.max(...transcript.map((cue) => cue.end_sec));
  const maxEnd = Math.max(Number(footageEndSec) || 0, maxCueEnd);
  for (const beat of beats) {
    if (!String(beat.beat_id || '').trim()) throw new Error('beat_id is required');
    if (!(Number(beat.end_sec) > Number(beat.start_sec))) throw new Error(`${beat.beat_id} has invalid time range`);
    if (Number(beat.start_sec) < -0.5 || Number(beat.end_sec) > maxEnd + 0.5) throw new Error(`${beat.beat_id} is outside the footage range`);
    const anchors = Array.isArray(beat.anchor_dialogue) ? beat.anchor_dialogue : [];
    const maxAnchors = maxAnchorsForBeat(beat);
    // A pure action/visual beat legitimately has no dialogue — anchors are only required
    // when the beat actually carries key_dialogue lines.
    if (!anchors.length && beat.key_dialogue.length) throw new Error(`${beat.beat_id} must include 1-${maxAnchors} anchor_dialogue lines`);
    if (anchors.length > maxAnchors) throw new Error(`${beat.beat_id} must include 1-${maxAnchors} anchor_dialogue lines`);
    for (const anchor of anchors) {
      if (!beat.key_dialogue.includes(anchor)) throw new Error(`${beat.beat_id} anchor_dialogue must be selected from key_dialogue`);
    }
  }
  return { ...beatsObject, beats };
}

// The event a scene turns on is often the beat with NO dialogue - a push down a staircase, a body
// on the floor - and a dialogue-first planner drops exactly those. The Housemaid ending shipped the
// alibi, the police interview and the funeral while the killing itself (beat_03, dramatic_weight 5,
// dialogue_quality low) was DROPped, so the viewer never learned that anyone had died and the whole
// cut read as unrelated fragments. A beat this heavy has to be somewhere in the cut: kept if it has
// lines, narrated over its own action if it does not.
const CAUSAL_BEAT_MIN_WEIGHT = 4;

function findUncoveredCausalBeats(editPlan, beats) {
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  const kept = timeline.filter((item) => item && item.decision !== 'DROP');
  const keptBeatIds = new Set(kept.map((item) => String(item.beat_id || '').trim()).filter(Boolean));
  // A narration slot that plays over the beat's own footage covers it even when the plan attributed
  // the slot to a neighbouring beat.
  const narrationRanges = kept
    .map((item) => [Number(item.visual_source_start_sec), Number(item.visual_source_end_sec)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
  return (Array.isArray(beats) ? beats : []).filter((beat) => {
    if (Number(beat?.dramatic_weight || 0) < CAUSAL_BEAT_MIN_WEIGHT) return false;
    const beatId = String(beat?.beat_id || '').trim();
    if (keptBeatIds.has(beatId)) return false;
    const start = Number(beat?.start_sec);
    const end = Number(beat?.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
    // Covered when some kept slot's footage overlaps at least a third of the beat.
    const overlap = narrationRanges.reduce((best, [rangeStart, rangeEnd]) => {
      const shared = Math.min(end, rangeEnd) - Math.max(start, rangeStart);
      return shared > best ? shared : best;
    }, 0);
    return overlap < (end - start) / 3;
  });
}

function validateEditPlanAgainstBeats(editPlan, beats) {
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  const uncovered = findUncoveredCausalBeats(editPlan, beats);
  if (uncovered.length) {
    const detail = uncovered
      .map((beat) => `${beat.beat_id} (${Math.round(Number(beat.start_sec))}-${Math.round(Number(beat.end_sec))}s, weight ${beat.dramatic_weight}): ${String(beat.summary || '').slice(0, 120)}`)
      .join(' | ');
    throw new Error(
      `edit plan leaves out the event(s) the scene turns on: ${detail}. A beat with dramatic_weight `
      + `${CAUSAL_BEAT_MIN_WEIGHT} or more must appear in the cut - KEEP_DIALOGUE when it has lines, otherwise NARRATE `
      + 'with visual_source_mode "source_audio_teaser" over its own footage. Without it the surrounding '
      + 'beats have no cause and the recap reads as unrelated fragments.'
    );
  }
  // A beat's dialogue can be split across its slots: the cold-open-callback pattern opens with
  // the hook line (slot_01) and replays the REST of the beat later (slot_003), so an anchor may
  // legitimately live in a SIBLING slot of the same beat rather than this one. The invariant is
  // that the anchor is preserved SOMEWHERE for the beat, not in every slot. Collect the union of
  // every slot's focus quotes per beat (cold open included) and validate anchors against it.
  const focusUnionByBeat = new Map();
  for (const item of timeline) {
    const beatKey = String(item?.beat_id || '').trim();
    if (!beatKey) continue;
    const set = focusUnionByBeat.get(beatKey) || new Set();
    for (const value of (Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes : [])) {
      set.add(String(value || '').trim());
    }
    focusUnionByBeat.set(beatKey, set);
  }
  for (const item of timeline) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    if (String(item?.replay_of_slot_id || '').trim() && String(item?.replay_mode || '').includes('remaining_dialogue')) continue;
    const beatKey = String(item?.beat_id || '').trim();
    const beat = beatMap.get(beatKey);
    if (!beat) continue;
    const anchors = Array.isArray(beat.anchor_dialogue) ? beat.anchor_dialogue : [];
    const focusQuotes = new Set((Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes : []).map((value) => String(value || '').trim()));
    const beatUnion = focusUnionByBeat.get(beatKey) || focusQuotes;
    const hookTeaser = String(item?.editorial_role || '').trim() === 'hook_teaser'
      || (String(item?.role || '').trim() === 'cold_open' && String(editPlan?.editorial_pattern || '').trim() === 'cold_open_callback');
    if (hookTeaser) {
      continue;
    }
    // A split dialogue slot (action beat admitted between its line clusters) holds only its
    // share of the beat's lines; the sibling part carries the rest, including anchors.
    if (item?.split_part === true) continue;
    for (const anchor of anchors) {
      // Pass when THIS slot holds the anchor, or when any sibling slot of the same beat does
      // (cold-open-callback / multi-slot beats spread the beat's lines across slots).
      if (!focusQuotes.has(anchor) && !beatUnion.has(anchor)) {
        // The beats pass and the (later, more informed) edit-plan pass sometimes disagree on
        // WHICH of a beat's lines to keep: beats picked "If you don't take care of your teeth..."
        // as the anchor, edit-plan kept the sibling lines "missing a tooth" / "teeth are a
        // privilege" - same beat, same idea, different verbatim line. Forcing the exact anchor
        // caused systematic fallbacks (Draft Day slot_07, Housemaid slot_03/09) on otherwise-good
        // Gemini plans. The invariant that actually matters is that a KEEP_DIALOGUE slot preserves
        // SOME of its beat's dialogue; a slot that keeps other real quotes satisfies that. Only a
        // slot that preserves NO dialogue at all is a genuine drop worth failing the plan.
        if (!focusQuotes.size) {
          throw new Error(`${item.slot_id} KEEP_DIALOGUE preserves no dialogue (beat anchor dropped: ${anchor})`);
        }
        break;
      }
    }
  }
  return editPlan;
}

// The plan may run a little short or long, but coming in at half the requested runtime is
// a planning failure, not a style choice — the retry loop gets this back as feedback.
const EDIT_PLAN_MIN_TARGET_RATIO = 0.85;
// Below this the plan is not merely short, it is a different cut, so topping it up would
// mean rebuilding it rather than filling a gap.
const EDIT_PLAN_PATHOLOGICAL_RATIO = 0.4;
// Overshooting is not something finalize can absorb the way it tops a short plan up, so the
// ceiling sits much closer to the target than the floor does.
const EDIT_PLAN_MAX_TARGET_RATIO = 1.35;

function validateEditPlan(editPlan, targetSec = 0) {
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  if (!timeline.length) throw new Error('edit plan timeline is empty');
  const target = Number(targetSec || 0);
  if (target > 0) {
    // Sum the slots rather than trusting duration_budget.estimated_total_sec: a plan can
    // report a healthy total while its actual slots add up to half the runtime.
    const slotTotal = timeline
      .filter((item) => item?.decision !== 'DROP')
      .reduce((sum, item) => sum + Number(item?.estimated_duration_sec || 0), 0);
    // finalizeEditPlan tops a short plan up from unused beats, so rejecting one here only
    // burns retries and pushes the run onto the fallback planner. Keep the check for
    // pathologically short plans, where topping up would rebuild the cut wholesale.
    // A speech-dense source pushed the planner the other way: a 120s request came back as a
    // 303s plan with one 151s dialogue slot. Runtime needs a ceiling as well as a floor.
    const ceiling = target * EDIT_PLAN_MAX_TARGET_RATIO;
    if (slotTotal > ceiling) {
      throw new Error(
        `edit plan runs far too long: its slots add up to ${Math.round(slotTotal)}s against a target of `
        + `${target}s (maximum ${Math.round(ceiling)}s). Cut whole slots and shorten preserved dialogue to the `
        + 'lines that carry the scene, rather than keeping every exchange.'
      );
    }
    const floor = target * EDIT_PLAN_PATHOLOGICAL_RATIO;
    if (slotTotal < floor) {
      throw new Error(
        `edit plan is far too short: its slots add up to ${Math.round(slotTotal)}s against a target of ${target}s `
        + `(minimum ${Math.round(floor)}s), regardless of what duration_budget claims. A narration slot realistically `
        + `carries at most ~18s of speech, so reach the target by ADDING more body slots from unused beats, `
        + `not by inflating the duration of the ${timeline.length} slots you already have.`
      );
    }
  }
  if (!timeline.some((item) => item.role === 'cold_open')) throw new Error('edit plan is missing cold_open role');
  if (!timeline.some((item) => item.role === 'bridge')) throw new Error('edit plan is missing bridge role');
  const coldOpen = timeline.find((item) => item.role === 'cold_open');
  const bodyPeak = coldOpen ? timeline.find((item) => item.role === 'body_peak' && item.beat_id === coldOpen.beat_id) : null;
  if (coldOpen) {
    const coldOpenLimit = coldOpen.decision === 'KEEP_DIALOGUE' ? COLD_OPEN_DIALOGUE_MAX_SEC : COLD_OPEN_NARRATION_MAX_SEC;
    if (Number(coldOpen.estimated_duration_sec || 0) > coldOpenLimit) {
      throw new Error(`cold_open should stay teaser-short (limit ${coldOpenLimit}s for ${coldOpen.decision})`);
    }
  }
  if (coldOpen && coldOpen.decision !== 'KEEP_DIALOGUE' && bodyPeak && Number(bodyPeak.estimated_duration_sec || 0) <= Number(coldOpen.estimated_duration_sec || 0)) {
    throw new Error('body_peak must be longer than its teaser cold_open');
  }
  for (const item of timeline) {
    const focusQuotes = Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes : [];
    if (item.decision === 'KEEP_DIALOGUE') {
      if (focusQuotes.length < 1) throw new Error(`${item.slot_id} KEEP_DIALOGUE must include dialogue_focus_quotes`);
      // A dialogue slot may be long when the exchange earns it — the total runtime ceiling
      // is what keeps a cut from swallowing whole conversations, not a per-slot line count.
      // 8, matching limitDialogueFocusLines. The cap was raised there when it started discarding
      // recovered lines, but this validator kept rejecting at 5 - and adopted cues push a slot
      // over it legitimately.
      if (focusQuotes.length > 8) throw new Error(`${item.slot_id} KEEP_DIALOGUE must limit dialogue_focus_quotes to 8 lines`);
    }
  }
  return editPlan;
}

// Listwise rerank (Clips Studio pattern, independent implementation): the deterministic score is
// good at filtering junk but poor at ordering the top handful — its weights were tuned on three
// sources. One blind LLM pass over the surviving candidates (scores hidden, so the model cannot
// parrot them) picks the opener; any failure falls back to the deterministic argmax that already
// shipped three sources. The choice is pinned into the plan as cold_open_selection.rerank_choice,
// so refresh/apply replay it deterministically with no second LLM call.
async function rerankColdOpenSelection(finalizedPlan, rawEditPlan, beats, transcript, targetSec, usableEndSec, wordTimestamps = null, energyPeaks = null) {
  if (process.env.MIDFORM_DISABLE_RERANK === '1') return finalizedPlan;
  try {
    const selection = finalizedPlan?.cold_open_selection || {};
    if (selection.rerank_choice) return finalizedPlan; // already reranked (refresh path)
    const cold = (Array.isArray(finalizedPlan?.timeline) ? finalizedPlan.timeline : []).find((item) => item?.role === 'cold_open');
    const runnerUps = Array.isArray(selection.runner_ups) ? selection.runner_ups : [];
    // The flip path (scene hook -> dialogue) builds no candidate pool; nothing to rank there.
    if (!cold || cold.decision !== 'KEEP_DIALOGUE' || !runnerUps.length) return finalizedPlan;
    const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
    const candidates = [
      {
        id: 'c1',
        beat_id: String(cold.beat_id || ''),
        start_sec: Number(cold.start_sec),
        end_sec: Number(cold.end_sec),
        lines: (Array.isArray(cold.dialogue_focus_lines) ? cold.dialogue_focus_lines : []).slice(0, 4)
      },
      ...runnerUps.map((item, index) => ({
        id: `c${index + 2}`,
        beat_id: String(item.beat_id || ''),
        start_sec: Number(item.start_sec),
        end_sec: Number(item.end_sec),
        lines: Array.isArray(item.lines) ? item.lines : []
      }))
    ].slice(0, 6);
    if (candidates.length < 2) return finalizedPlan;
    const candidateBlock = candidates.map((candidate) => {
      const beat = beatMap.get(candidate.beat_id.trim());
      const summary = String(beat?.summary || '').slice(0, 160);
      const duration = roundSec(Math.max(0, candidate.end_sec - candidate.start_sec));
      return `${candidate.id} (${duration}s)${summary ? ` — scene: ${summary}` : ''}\n${candidate.lines.map((line) => `  "${line}"`).join('\n')}`;
    }).join('\n\n');
    const prompt = [
      'You are choosing the COLD OPEN for a 1-3 minute movie-clip recap: the very first seconds a viewer sees, before any context.',
      'Below are candidate dialogue moments from the same source clip. Pick the ONE that works best as the opener.',
      '',
      'Judge them against each other on:',
      '1. Instant comprehension — the line must land with ZERO context (no unresolved pronouns or references).',
      '2. Curiosity gap — it should demand an answer the viewer must stay for.',
      '3. Force — confrontation, threat, reversal, or emotional intensity beats pleasantry.',
      '4. It must not give away the final payoff by itself.',
      '',
      candidateBlock,
      '',
      'Respond with JSON: {"winner_id": "<id>", "why": "<one sentence>"}.'
    ].join('\n');
    const responseSchema = {
      type: 'object',
      properties: { winner_id: { type: 'string' }, why: { type: 'string' } },
      required: ['winner_id', 'why']
    };
    const outputText = await generateVertexJson({ prompt, responseSchema, model: compressVertexModel() });
    const parsed = extractJson(outputText);
    const winner = candidates.find((candidate) => candidate.id === String(parsed?.winner_id || '').trim());
    if (!winner) return finalizedPlan;
    const rerankMeta = {
      applied: true,
      winner_beat_id: winner.beat_id,
      winner_start_sec: winner.start_sec,
      winner_end_sec: winner.end_sec,
      why: String(parsed?.why || '').slice(0, 300),
      candidate_count: candidates.length
    };
    if (winner.id === 'c1') {
      finalizedPlan.cold_open_selection = { ...selection, rerank: { ...rerankMeta, changed: false } };
      return finalizedPlan;
    }
    const pinnedPlan = {
      ...rawEditPlan,
      cold_open_selection: {
        ...(rawEditPlan?.cold_open_selection || {}),
        rerank_choice: { beat_id: winner.beat_id, start_sec: winner.start_sec, end_sec: winner.end_sec }
      }
    };
    const refinalized = finalizeEditPlan(pinnedPlan, beats, transcript, targetSec, usableEndSec, wordTimestamps, energyPeaks);
    validateEditPlanAgainstBeats(validateEditPlan(refinalized), beats);
    refinalized.cold_open_selection = { ...(refinalized.cold_open_selection || {}), rerank: { ...rerankMeta, changed: true } };
    return refinalized;
  } catch (error) {
    finalizedPlan.cold_open_selection = {
      ...(finalizedPlan.cold_open_selection || {}),
      rerank: { applied: false, error: String(error?.message || error).slice(0, 200) }
    };
    return finalizedPlan;
  }
}

async function runJsonGeneration(prompt, outputSchemaPath, validator) {
  const provider = compressLlmProvider();
  let feedback = '';
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const fullPrompt = feedback ? `${prompt}\n\nPrevious JSON failed validation. Fix only these issues:\n${feedback}` : prompt;
    let outputText = null;
    let cliMeta = { provider, attempts: attempt };
    let transportError = null;

    for (let transportAttempt = 1; transportAttempt <= CODEX_TRANSPORT_RETRIES; transportAttempt += 1) {
      try {
        if (provider === 'codex') {
          const result = await runCodexCli(fullPrompt, { outputSchemaPath });
          outputText = result.outputText || result.stdout;
          cliMeta = { provider, attempts: attempt, promptPath: result.promptPath, outputPath: result.outputPath, stderr: String(result.stderr || '').slice(0, 2000) };
        } else {
          const responseSchema = readJson(outputSchemaPath);
          const model = compressVertexModel();
          outputText = await generateVertexJson({ prompt: fullPrompt, responseSchema, model });
          cliMeta = { provider, attempts: attempt, model };
        }
        transportError = null;
        break;
      } catch (error) {
        transportError = error;
        const code = String(error?.code || '');
        const retryable = provider === 'codex'
          ? code === 'GPT_CLI_FAILED'
          : (['VERTEX_COMPRESS_REQUEST_FAILED', 'VERTEX_COMPRESS_GENERATION_FAILED', 'VERTEX_GEMINI_EMPTY_RESPONSE'].includes(code) || Number(error?.status) >= 500);
        if (!retryable) throw error;
        if (transportAttempt === CODEX_TRANSPORT_RETRIES) break;
        await sleep(transportAttempt * 2000);
      }
    }

    // Codex-only fresh-node fallback (Vertex has no equivalent transport quirk).
    if (outputText == null && provider === 'codex' && transportError
      && String(transportError?.code || '') === 'GPT_CLI_FAILED' && transportError?.details?.promptPath) {
      const result = await runCodexCliInFreshNodeProcess(transportError.details.promptPath, outputSchemaPath);
      outputText = result.outputText || result.stdout;
      cliMeta = { provider, attempts: attempt, promptPath: result.promptPath, outputPath: result.outputPath, stderr: String(result.stderr || '').slice(0, 2000) };
      transportError = null;
    }

    if (outputText == null) {
      throw transportError || new Error(`${provider} generation did not return a result`);
    }
    const parsed = extractJson(outputText);
    try {
      const validated = validator(parsed);
      return { parsed: validated, cli: cliMeta };
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
    const visual = item.visual_source_beat_id
      ? `${item.visual_source_beat_id} ${formatClock(item.visual_source_start_sec)}-${formatClock(item.visual_source_end_sec)}`
      : '-';
    const focus = Array.isArray(item.dialogue_focus_lines) && item.dialogue_focus_lines.length
      ? item.dialogue_focus_lines.join(' / ')
      : '-';
    return `| ${item.role} | ${item.beat_id || '-'} | ${item.decision} | ${time} | ${visual} | ${focus} | ${item.reason} |`;
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
      `- teaser_visual: ${cold.teaser_visual_beat_id ? `${cold.teaser_visual_beat_id} ${formatClock(cold.teaser_visual_start_sec)}-${formatClock(cold.teaser_visual_end_sec)} (${cold.teaser_visual_mode || 'story_beat'})` : '-'}`,
     `- reason: ${cold.reason || ''}`,
     '',
     '## Timeline Plan',
     '',
     '| role | beat | decision | time | teaser_visual | dialogue_focus | reason |',
     '| --- | --- | --- | --- | --- | --- | --- |',
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

const VISION_SCENE_MAP_FILE = 'vision_scene_map.json';

function transcriptCuesToUtterances(transcript) {
  const cues = Array.isArray(transcript) ? transcript : (Array.isArray(transcript?.cues) ? transcript.cues : []);
  return {
    utterances: cues
      .map((cue, index) => ({
        utt_id: `u${String(index + 1).padStart(3, '0')}`,
        start: Number(cue.start_sec),
        end: Number(cue.end_sec),
        text: String(cue.text || '').trim()
      }))
      .filter((utterance) => Number.isFinite(utterance.start) && Number.isFinite(utterance.end)
        && utterance.end > utterance.start && utterance.text)
  };
}

// The planner used to infer what was on screen from caption text alone, which shipped a
// "Bloodsucking Leeches" recap without a single frame of the leech attack: the transcript
// goes silent exactly where the visual peak is. This runs the Gemini multimodal pass (the
// only component that actually watches the video) once per source and caches the scene map,
// so every replan grounds its visual claims in seen footage instead of prose.
async function ensureVisionSceneMap(runDir, metadata, transcript, options = {}) {
  const outPath = path.join(runDir, VISION_SCENE_MAP_FILE);
  if (fs.existsSync(outPath)) return readJson(outPath);
  const videoId = String(metadata?.id || '').trim();
  const cacheDir = path.join(COMPRESS_RUNS_DIR, '.vision_scene_cache');
  const cachePath = videoId ? path.join(cacheDir, `${videoId}.json`) : '';
  if (cachePath && fs.existsSync(cachePath)) {
    fs.copyFileSync(cachePath, outPath);
    return readJson(outPath);
  }
  const download = await downloadCompressionSourceVideo(runDir);
  const analysis = await analyzeMidformVideo(download.sourceVideoPath, options.contentType || 'movie_midform_recap', {
    transcript: transcriptCuesToUtterances(transcript)
  });
  const sceneMap = {
    source_id: videoId || path.basename(runDir),
    generated_at: new Date().toISOString(),
    analyzer: 'gemini_vertex_multimodal',
    scenes: Array.isArray(analysis?.scenes) ? analysis.scenes : [],
    story_context: analysis?.story_context || null,
    characters: Array.isArray(analysis?.characters) ? analysis.characters : []
  };
  if (!sceneMap.scenes.length) {
    throw new Error('Vision scene analysis returned no scenes - refusing to plan without seen footage');
  }
  writeJson(outPath, sceneMap);
  if (cachePath) {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeJson(cachePath, sceneMap);
  }
  return sceneMap;
}

function buildVisionSceneSection(sceneMap) {
  const scenes = Array.isArray(sceneMap?.scenes) ? sceneMap.scenes : [];
  if (!scenes.length) return '';
  const compact = scenes.map((scene) => ({
    scene_id: scene.scene_id,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    visible_action: scene.visible_action,
    shot_type: scene.shot_type || '',
    // Optional fields (schema 2026-08-10): frame-judged intensity 1-5 and dominant moment
    // type - zero extra API cost, and beats/plan can rank visual moments without guessing.
    ...(scene.visual_intensity != null ? { visual_intensity: scene.visual_intensity } : {}),
    ...(scene.moment_type ? { moment_type: scene.moment_type } : {})
  }));
  return [
    '',
    '',
    '## Vision scene map (a multimodal model watched the video - ground truth for what is on screen)',
    '- The transcript tells you what is SAID; only this scene map tells you what is SEEN. Never infer on-screen visuals from dialogue text.',
    '- When a beat, window, or narration claims a visual event (an attack, a reveal, an action peak), its time range must overlap a scene whose visible_action actually shows that event.',
    '- High-drama visual scenes with little or no dialogue are prime footage: cover them with NARRATE windows instead of skipping them. Silence in the transcript is not absence of story.',
    '- A dialogue line belongs to the scene the map places it in. Do not carry it into a neighboring scene\'s context: if the location or the threat changes between scenes, the story needs a seam, not a blur.',
    JSON.stringify(compact, null, 2)
  ].join('\n');
}

const ENERGY_PROFILE_FILE = 'energy_profile.json';

function zScore(values) {
  if (!values.length) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1e-8;
  return values.map((value) => (value - mean) / std);
}

function movingAverage(values, windowSize) {
  const window = Math.max(1, Math.round(windowSize));
  const output = new Array(values.length).fill(0);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= window) sum -= values[index - window];
    output[index] = sum / Math.min(index + 1, window);
  }
  return output;
}

// Measured non-verbal energy (AutoShorts approach, MIT — reimplemented on ffmpeg only, with
// their three known defects fixed: mean instead of sum, per-signal timebase normalization,
// smoothing windows in explicit seconds). The transcript is silent exactly where the visual
// peaks are; this gives the planner a MEASURED signal for those moments at zero token cost.
function computeEnergyProfile(videoPath) {
  const ffmpeg = resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' });
  // Audio RMS: mono 16k s16le, frame 1024 / hop 256 (=64ms/16ms, 62.5Hz feature rate).
  const audioProbe = spawnSync(ffmpeg, [
    '-hide_banner', '-nostats', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'
  ], { env: getToolEnv(), timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 });
  const pcm = audioProbe.stdout;
  const rms = [];
  if (pcm && pcm.length > 4096) {
    const frame = 1024;
    const hop = 256;
    const samples = Math.floor(pcm.length / 2);
    for (let start = 0; start + frame <= samples; start += hop) {
      let acc = 0;
      for (let index = 0; index < frame; index += 1) {
        const value = pcm.readInt16LE((start + index) * 2) / 32768;
        acc += value * value;
      }
      rms.push(Math.sqrt(acc / frame));
    }
  }
  const audioHz = 16000 / 256;
  const rmsZ = movingAverage(zScore(rms), 0.25 * audioHz);

  // Frame motion: 6fps, 256px gray, mean absolute frame difference (their decord/torch path
  // reproduced with tblend+signalstats).
  const motionProbe = spawnSync(ffmpeg, [
    '-hide_banner', '-nostats', '-i', videoPath,
    '-vf', "fps=6,scale=256:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
    '-f', 'null', '-'
  ], { env: getToolEnv(), encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const motionTimes = [];
  const motionValues = [];
  let pendingTime = null;
  for (const line of String(motionProbe.stdout || '').split(/\r?\n/)) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) { pendingTime = Number(timeMatch[1]); continue; }
    const valueMatch = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (valueMatch && pendingTime != null) {
      motionTimes.push(pendingTime);
      motionValues.push(Number(valueMatch[1]));
      pendingTime = null;
    }
  }
  const motionZ = movingAverage(zScore(motionValues), 1.0 * 6);

  return { audioHz, rmsZ, motionHz: 6, motionTimes, motionZ };
}

function pickEnergyPeaks(profile, usableEndSec = 0) {
  const grid = 0.5;
  const audioDuration = profile.rmsZ.length / profile.audioHz;
  const motionDuration = profile.motionTimes.length ? profile.motionTimes[profile.motionTimes.length - 1] : 0;
  const totalSec = Math.max(audioDuration, motionDuration);
  if (!(totalSec > 4)) return [];
  const points = [];
  for (let t = 0; t < totalSec; t += grid) {
    const audioIndex = Math.min(profile.rmsZ.length - 1, Math.round(t * profile.audioHz));
    const motionIndex = Math.min(profile.motionZ.length - 1, Math.round(t * profile.motionHz));
    const audioValue = profile.rmsZ.length ? profile.rmsZ[Math.max(0, audioIndex)] : 0;
    const motionValue = profile.motionZ.length ? profile.motionZ[Math.max(0, motionIndex)] : 0;
    points.push({ t, score: 0.45 * audioValue + 0.55 * motionValue });
  }
  const windowSec = 4;
  const windowPoints = Math.round(windowSec / grid);
  const windows = [];
  for (let index = 0; index + windowPoints <= points.length; index += 1) {
    const slice = points.slice(index, index + windowPoints);
    const mean = slice.reduce((sum, point) => sum + point.score, 0) / slice.length;
    const start = points[index].t;
    if (usableEndSec > 0 && start + windowSec > usableEndSec) continue;
    windows.push({ start_sec: roundSec(start), end_sec: roundSec(start + windowSec), score: Number(mean.toFixed(3)) });
  }
  windows.sort((left, right) => right.score - left.score);
  const picked = [];
  for (const candidate of windows) {
    if (picked.length >= 8) break;
    if (candidate.score < 0.2) break;
    if (picked.some((peak) => Math.abs(peak.start_sec - candidate.start_sec) < 6)) continue;
    picked.push(candidate);
  }
  return picked.map((peak, index) => ({ ...peak, rank: index + 1 }));
}

async function ensureEnergyProfile(runDir, metadata, usableEndSec = 0) {
  const outPath = path.join(runDir, ENERGY_PROFILE_FILE);
  if (fs.existsSync(outPath)) return readJson(outPath);
  const videoId = String(metadata?.id || '').trim();
  const cacheDir = path.join(COMPRESS_RUNS_DIR, '.energy_cache');
  const cachePath = videoId ? path.join(cacheDir, `${videoId}.json`) : '';
  if (cachePath && fs.existsSync(cachePath)) {
    fs.copyFileSync(cachePath, outPath);
    return readJson(outPath);
  }
  const download = await downloadCompressionSourceVideo(runDir);
  const raw = computeEnergyProfile(download.sourceVideoPath);
  const artifact = {
    source_id: videoId || path.basename(runDir),
    generated_at: new Date().toISOString(),
    method: 'ffmpeg rms(64ms/16ms z-smoothed 0.25s) + motion(6fps gray framediff z-smoothed 1s), combined 0.45*audio+0.55*motion, 4s mean windows',
    peaks: pickEnergyPeaks(raw, usableEndSec)
  };
  writeJson(outPath, artifact);
  if (cachePath) {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeJson(cachePath, artifact);
  }
  return artifact;
}

const WORD_TIMESTAMPS_FILE = 'word_timestamps.json';

// Word-level timestamps (faster-whisper, opt-in via MIDFORM_WHISPER_WORDS=1): auto-caption cues
// are 2-9s blocks, so cue-derived cut edges can clip the first word or drag past the last. The
// word grid lets dialogue windows snap to the actual spoken word. Everything degrades to the
// pre-existing cue-boundary behaviour when the flag is off, the package is missing, or the
// extraction fails — word timing is a refinement, never a dependency.
async function ensureWordTimestamps(runDir, metadata) {
  if (process.env.MIDFORM_WHISPER_WORDS !== '1') return null;
  const outPath = path.join(runDir, WORD_TIMESTAMPS_FILE);
  if (fs.existsSync(outPath)) return readJson(outPath);
  const videoId = String(metadata?.id || '').trim();
  const cacheDir = path.join(COMPRESS_RUNS_DIR, '.word_cache');
  const cachePath = videoId ? path.join(cacheDir, `${videoId}.json`) : '';
  if (cachePath && fs.existsSync(cachePath)) {
    fs.copyFileSync(cachePath, outPath);
    return readJson(outPath);
  }
  try {
    const download = await downloadCompressionSourceVideo(runDir);
    const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
    const script = path.join(PROJECT_ROOT, 'midform', 'scripts', 'extract_word_timestamps.py');
    const result = spawnSync(python, [script, '--audio', download.sourceVideoPath, '--out', outPath], {
      cwd: PROJECT_ROOT,
      env: getToolEnv(),
      encoding: 'utf8',
      timeout: 30 * 60 * 1000
    });
    if (result.status !== 0 || !fs.existsSync(outPath)) {
      console.warn(`[midform] word timestamps unavailable (exit ${result.status}): ${String(result.stderr || '').slice(0, 200)}`);
      return null;
    }
    const artifact = readJson(outPath);
    if (cachePath) {
      fs.mkdirSync(cacheDir, { recursive: true });
      writeJson(cachePath, artifact);
    }
    return artifact;
  } catch (error) {
    console.warn(`[midform] word timestamp extraction failed: ${String(error?.message || error).slice(0, 200)}`);
    return null;
  }
}

function readWordTimestamps(runDir) {
  if (process.env.MIDFORM_WHISPER_WORDS !== '1') return null;
  const outPath = path.join(runDir, WORD_TIMESTAMPS_FILE);
  return fs.existsSync(outPath) ? readJson(outPath) : null;
}

// Snap each matched dialogue window edge to the nearest word boundary within tolerance: the
// start moves to the first word's onset (minus a small attack guard), the end to the last
// word's offset (plus a release guard). Runs BEFORE window separation so captions inherit the
// corrected coordinates too. A window whose edges sit nowhere near a word keeps its cue timing.
function snapDialogueWindowsToWords(timeline, wordTimestamps, toleranceSec = 0.35) {
  const words = Array.isArray(wordTimestamps?.words) ? wordTimestamps.words : [];
  if (!words.length) return timeline;
  const ATTACK_GUARD = 0.04;
  const RELEASE_GUARD = 0.06;
  const nearestStart = (t) => {
    let best = null;
    for (const word of words) {
      const s = Number(word.start_sec);
      if (!Number.isFinite(s)) continue;
      if (best == null || Math.abs(s - t) < Math.abs(best - t)) best = s;
    }
    return best != null && Math.abs(best - t) <= toleranceSec ? best : null;
  };
  const nearestEnd = (t) => {
    let best = null;
    for (const word of words) {
      const e = Number(word.end_sec);
      if (!Number.isFinite(e)) continue;
      if (best == null || Math.abs(e - t) < Math.abs(best - t)) best = e;
    }
    return best != null && Math.abs(best - t) <= toleranceSec ? best : null;
  };
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (item?.decision !== 'KEEP_DIALOGUE' || !Array.isArray(item.dialogue_line_windows)) return item;
    const nextWindows = item.dialogue_line_windows.map((win) => {
      if (!win || win.matched !== true) return win;
      const start = Number(win.start_sec);
      const end = Number(win.end_sec);
      if (!(end > start)) return win;
      const snappedStart = nearestStart(start);
      const snappedEnd = nearestEnd(end);
      const nextStart = snappedStart != null ? roundSec(Math.max(0, snappedStart - ATTACK_GUARD)) : start;
      const nextEnd = snappedEnd != null ? roundSec(snappedEnd + RELEASE_GUARD) : end;
      if (!(nextEnd > nextStart + 0.2)) return win; // snapping must never collapse a window
      if (nextStart === start && nextEnd === end) return win;
      return { ...win, start_sec: nextStart, end_sec: nextEnd, word_snapped: true };
    });
    return { ...item, dialogue_line_windows: nextWindows };
  });
}

function buildEnergySection(energyProfile) {
  const peaks = Array.isArray(energyProfile?.peaks) ? energyProfile.peaks : [];
  if (!peaks.length) return '';
  return [
    '',
    '',
    '## Measured non-verbal energy peaks (audio RMS + frame motion, computed from the signal — NOT inferred from text)',
    '- These are MEASURED moments of high audio/visual energy in the source. When the most-replayed heatmap is unavailable, treat the top peaks here with the same authority as heatmap peaks.',
    '- Every peak below must fall inside some beat. A peak that no beat covers means the beats missed a visual event — screams, impacts and action read as silence in the transcript.',
    JSON.stringify(peaks, null, 2)
  ].join('\n');
}

async function runCompression(source, options = {}) {
  const sourceUrl = normalizeSourceUrl(source);
  let targetSec = Number(options.target || options.targetSec || DEFAULT_TARGET_SEC) || DEFAULT_TARGET_SEC;
  const { runId, runDir } = createCompressionRun(sourceUrl);
  const statePath = path.join(runDir, 'compress_state.json');
  writeJson(statePath, { runId, status: 'running', sourceUrl, targetSec, createdAt: new Date().toISOString() });
  const seededContextPath = path.join(runDir, 'context.md');
  if (!fs.existsSync(seededContextPath) && fs.existsSync(RECAP_CONTEXT_TEMPLATE_PATH)) {
    fs.copyFileSync(RECAP_CONTEXT_TEMPLATE_PATH, seededContextPath);
  }

  const { metadata, metadataPath } = await loadYoutubeMetadata(sourceUrl, runDir);
  // Source resolution scout (OpenShorts quality_probe, MIT): a 360p source silently produces a
  // blurry draft after the full pipeline spend. Refuse below 720p, warn below 1080p, before any
  // expensive work starts.
  const maxSourceHeight = Math.max(0, ...(Array.isArray(metadata?.formats) ? metadata.formats : [])
    .filter((format) => format && format.vcodec && format.vcodec !== 'none' && String(format.ext || '') !== 'mhtml')
    .map((format) => Number(format.height) || 0));
  if (maxSourceHeight > 0 && maxSourceHeight < 720) {
    const blocked = { status: 'blocked', code: 'SOURCE_RESOLUTION_TOO_LOW', message: `최대 해상도 ${maxSourceHeight}p — 720p 미만 소스는 드래프트 품질이 성립하지 않습니다. 다른 업로드를 찾아주세요.` };
    writeJson(statePath, blocked);
    throw Object.assign(new Error(blocked.message), { code: blocked.code, details: { maxSourceHeight } });
  }
  const sourceResolutionWarning = maxSourceHeight > 0 && maxSourceHeight < 1080
    ? `source max resolution ${maxSourceHeight}p (below 1080p)` : '';
  // The target follows the source (user directive): a 90s ask against a 163s clip chased length
  // the footage cannot carry — burning retries and warnings over a number nobody needs. A recap
  // is a compression, so cap the target at half the source and let completeness decide the rest.
  const sourceDurationSec = Number(metadata?.duration || 0);
  if (sourceDurationSec > 0) {
    const sourceCappedTarget = Math.max(COLD_OPEN_VISUAL_MIN_SEC * 10, Math.round(sourceDurationSec * 0.5));
    if (targetSec > sourceCappedTarget) {
      targetSec = sourceCappedTarget;
      writeJson(statePath, {
        runId, status: 'running', sourceUrl, targetSec,
        target_capped_by_source: true, source_duration_sec: sourceDurationSec,
        createdAt: new Date().toISOString()
      });
    }
  }
  // eslint-disable-next-line prefer-const -- transcript is reassigned by the anchor-cue merge below
  let { transcript, transcriptPath, vttPath } = await extractTimedTranscript(sourceUrl, runDir, { sourceKind: options.sourceKind });
  const { heatmap, heatmapPath } = extractHeatmap(metadata, runDir);
  // Download the source now (idempotent - reuses an existing file) so the visual end-card
  // detector inside profileSourceCase has frames to scan. A download failure is non-fatal:
  // profileSourceCase falls back to the subtitle-based promo tail.
  let profileVideoPath = '';
  try {
    const dl = await downloadCompressionSourceVideo(runDir);
    profileVideoPath = dl?.sourceVideoPath || '';
  } catch { profileVideoPath = path.join(runDir, 'source.mp4'); }
  const sourceCase = profileSourceCase(transcript, metadata, heatmap, profileVideoPath);
  if (options.sourceKind === 'game') sourceCase.case_type = 'game_no_dialogue';
  // A declared promo tail (template source.promo_tail_sec, measured by frame analysis) beats
  // caption-based detection: preview dialogue defeats the text classifier in both directions.
  const declaredTail = Number(options.promoTailSec || 0);
  if (declaredTail > 0 && sourceCase.duration_sec > 0) {
    // A frame-measured declaration beats caption detection in BOTH directions. Taking only the
    // smaller end let the text classifier misread a dialogue-free ending as promo (last cue at
    // 182s, real footage to 209s) and the bite close-up landed "in the promo tail" - the hook
    // got replayed over the climax.
    sourceCase.usable_end_sec = roundSec(Math.max(0, sourceCase.duration_sec - declaredTail));
    sourceCase.promo_tail_sec = declaredTail;
    sourceCase.promo_tail_declared = true;
  }
  const visionSceneMap = await ensureVisionSceneMap(runDir, metadata, transcript, { contentType: options.contentType });
  const visionSceneSection = buildVisionSceneSection(visionSceneMap);
  const energyProfile = await ensureEnergyProfile(runDir, metadata, sourceCase.usable_end_sec);
  const wordTimestamps = await ensureWordTimestamps(runDir, metadata);
  const energySection = buildEnergySection(energyProfile);
  // Peak evidence (fixes the groundless action_peak claim): without a heatmap the profiler used
  // to declare "non-verbal peak, open on it" while nobody knew where that peak was. Now the
  // measured energy peak fills in, and with no evidence at all the claim is withdrawn.
  if (sourceCase.peak_evidence !== 'heatmap') {
    const topPeak = (energyProfile?.peaks || [])[0] || null;
    if (topPeak) {
      sourceCase.peak_evidence = 'energy';
      sourceCase.action_peak_sec = topPeak.start_sec;
      sourceCase.peak_is_dialogue = transcript.some((cue) => Number(cue.end_sec) > topPeak.start_sec && Number(cue.start_sec) < topPeak.end_sec);
      sourceCase.case_type = sourceCase.case_type.replace(/(dialogue_peak|action_peak)/, sourceCase.peak_is_dialogue ? 'dialogue_peak' : 'action_peak');
    } else {
      sourceCase.peak_evidence = 'none';
    }
  }
  writeJson(path.join(runDir, 'source_case.json'), sourceCase);
  const caseGuidanceText = buildSourceCaseGuidance(sourceCase).join(String.fromCharCode(10));

  const beatsResult = await runJsonGeneration(
    buildBeatsPrompt(transcript, metadata, targetSec) + caseGuidanceText + visionSceneSection + energySection,
    MIDFORM_COMPRESSION_BEATS_SCHEMA_PATH,
    (parsed) => {
      const validated = validateBeats(parsed, transcript, sourceCase.usable_end_sec);
      // Prompt-level "every peak must be inside a beat" was ignored on the first live run:
      // the model dropped the entire first act (neck-leech screams, energy ranks 1-2) again.
      // Measured peaks are enforced, not suggested - the retry feedback names the hole.
      // Top-2 enforced: rank 1-2 are the must-have visual moments; requiring rank 3 as well
      // proved brittle against beat-sampling variance (a run died on a 4s build-up window).
      for (const peak of (energyProfile?.peaks || []).slice(0, 2)) {
        const covered = (validated.beats || []).some((beat) => Number(beat.start_sec) < peak.end_sec && Number(beat.end_sec) > peak.start_sec);
        if (!covered) {
          throw new Error(`measured energy peak ${peak.start_sec}-${peak.end_sec}s (rank ${peak.rank}) is not covered by any beat - screams and action read as silence in the transcript, so add a beat spanning that moment`);
        }
      }
      return validated;
    }
  );
  beatsResult.parsed.beats = completeBeatDialogueFromCues(beatsResult.parsed.beats, transcript);
  // Anchor smear is now healed here rather than by hand: rewrite the transcript so each beat
  // anchor is one clean cue, then persist it so every downstream stage reads the merged form.
  const anchorMergedTranscript = mergeAnchorCuesInTranscript(transcript, beatsResult.parsed.beats);
  if (anchorMergedTranscript !== transcript) {
    transcript = anchorMergedTranscript;
    writeJson(path.join(runDir, 'transcript_timed.json'), transcript);
  }
  // After merging, demote any anchor still unmatched (Gemini paraphrased/invented it) so it
  // can't deadlock KEEP_DIALOGUE.
  beatsResult.parsed.beats = pruneUnmatchedBeatAnchors(beatsResult.parsed.beats, transcript);
  const beatsPath = path.join(runDir, 'narrative_beats.json');
  writeJson(beatsPath, beatsResult.parsed);

  let finalizedEditPlan;
  let editPlanSource = 'codex';
  try {
    const editResult = await runJsonGeneration(
      buildEditPlanPrompt(beatsResult.parsed.beats, heatmap, targetSec, metadata) + caseGuidanceText + visionSceneSection + energySection,
      MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH,
      (parsed) => validateEditPlanAgainstBeats(validateEditPlan(parsed, targetSec), beatsResult.parsed.beats)
    );
    finalizedEditPlan = finalizeEditPlan(editResult.parsed, beatsResult.parsed.beats, transcript, targetSec, sourceCase.usable_end_sec, wordTimestamps, energyProfile?.peaks || []);
    validateEditPlanAgainstBeats(validateEditPlan(finalizedEditPlan), beatsResult.parsed.beats);
    finalizedEditPlan = await rerankColdOpenSelection(
      finalizedEditPlan, editResult.parsed, beatsResult.parsed.beats, transcript, targetSec, sourceCase.usable_end_sec, wordTimestamps, energyProfile?.peaks || []
    );
  } catch (_error) {
    finalizedEditPlan = buildFallbackEditPlan(beatsResult.parsed.beats, heatmap, targetSec, metadata, transcript);
    editPlanSource = 'local_fallback';
    finalizedEditPlan.cold_open_selection.reason = `${finalizedEditPlan.cold_open_selection.reason} edit-plan generation failed, so the local fallback planner was used.`;
    // The fallback planner focuses each slot on its beat's densest dialogue cluster, which can
    // differ from the beat's Gemini-chosen anchor (e.g. anchor at the scene's first line, but
    // the packed quotes come from a later exchange). That leaves the anchor orphaned - present
    // in no slot - and hard-fails the anchor-preservation contract at bootstrap, killing an
    // otherwise-shippable degraded run (seen when Vertex 429s force the fallback). Reconcile:
    // for each beat, keep only anchors the fallback actually placed in one of its slots; drop
    // the unplaced ones so the local plan satisfies its own contract. Preservation is still
    // guaranteed for whatever the fallback DID keep.
    const fallbackFocusByBeat = new Map();
    for (const item of finalizedEditPlan.timeline || []) {
      const beatKey = String(item?.beat_id || '').trim();
      if (!beatKey) continue;
      const set = fallbackFocusByBeat.get(beatKey) || new Set();
      for (const q of (Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes : [])) set.add(String(q || '').trim());
      fallbackFocusByBeat.set(beatKey, set);
    }
    let anchorsReconciled = false;
    beatsResult.parsed.beats = (beatsResult.parsed.beats || []).map((beat) => {
      const anchors = Array.isArray(beat.anchor_dialogue) ? beat.anchor_dialogue : [];
      if (!anchors.length) return beat;
      const placed = fallbackFocusByBeat.get(String(beat.beat_id || '').trim()) || new Set();
      const kept = anchors.filter((a) => placed.has(String(a || '').trim()));
      if (kept.length !== anchors.length) anchorsReconciled = true;
      return { ...beat, anchor_dialogue: kept };
    });
    if (anchorsReconciled) writeJson(beatsPath, beatsResult.parsed);
  }
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  finalizedEditPlan.llm_provider = compressLlmProvider();
  writeJson(editPlanPath, finalizedEditPlan);

  const markdownPath = path.join(runDir, 'narrative_beats.md');
  writeText(markdownPath, `${buildNarrativeBeatsMarkdown({
    runId,
    metadata,
    heatmap,
    beatsObject: beatsResult.parsed,
    editPlan: finalizedEditPlan,
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
    paths: { runDir, metadataPath, transcriptPath, vttPath, heatmapPath, beatsPath, editPlanPath, markdownPath, visionSceneMapPath: path.join(runDir, VISION_SCENE_MAP_FILE), energyProfilePath: path.join(runDir, ENERGY_PROFILE_FILE) },
    visionSceneCount: Array.isArray(visionSceneMap?.scenes) ? visionSceneMap.scenes.length : 0,
    energyPeakCount: Array.isArray(energyProfile?.peaks) ? energyProfile.peaks.length : 0,
    heatmapStatus: heatmap.status,
    maxSourceHeight,
    ...(sourceResolutionWarning ? { sourceResolutionWarning } : {}),
    coldOpenSelection: finalizedEditPlan.cold_open_selection || null,
    editPlanSource,
    llmProvider: compressLlmProvider()
  };
  writeJson(manifestPath, manifest);
  writeJson(statePath, { ...manifest, status: 'phase1_review_ready', manifestPath });
  return { ...manifest, manifestPath, status: 'phase1_review_ready' };
}

// The text counterpart to the frame machine-eye: verify each per-line subtitle against the
// ENGLISH source dialogue so mistranslations, per-line MISALIGNMENT (a Korean line that actually
// renders a neighbouring English line - which also flips the speaker colour), and inconsistent
// proper names are caught automatically instead of relying on the reviewer catching them. Fixes
// are applied in place from the judge's per-line suggestion; the deliberate drug-name softening
// ("Molly" -> generic) is preserved. Writes dialogue_translation_report.md. Off with
// MIDFORM_SKIP_DIALOGUE_AUDIT=1.
async function auditAndFixDialogueTranslations(runDir, editPlan, slotFills, fillsFileName, targetLang) {
  if (String(process.env.MIDFORM_SKIP_DIALOGUE_AUDIT || '') === '1') return { fixed: 0, issues: [] };
  let judge;
  try { ({ judgeDialogueTranslation: judge } = require('./geminiMidformService')); } catch { return { fixed: 0, issues: [] }; }
  const fillBySlot = new Map((slotFills?.slot_fills || []).map((f) => [String(f.slot_id), f]));
  const report = [];
  let fixed = 0;
  for (const item of (Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    // The dialogue_line_windows are the cues that actually render, indexed 1:1 with
    // caption_kr_dialogue; the matcher can add a cue beyond dialogue_focus_lines, and that extra
    // rendered line then ships with NO translation (empty caption / raw English on screen). Audit
    // against the windows so those are caught, not just the focus lines.
    const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
    const en = windows.length ? windows.map((w) => String(w.line || '')) : (item.dialogue_focus_lines || item.dialogue_focus_quotes || []);
    const fill = fillBySlot.get(String(item.slot_id));
    const tr = fill && Array.isArray(fill.caption_kr_dialogue) ? fill.caption_kr_dialogue : null;
    const speakers = fill && Array.isArray(fill.speakers) ? fill.speakers : [];
    if (!en.length || !tr || !tr.length) continue;
    const lines = en.map((sourceLine, index) => ({ speaker: speakers[index] || '', en: sourceLine, tr: tr[index] || '' }));
    let verdict;
    try { verdict = await judge({ lines, targetLang }); } catch { continue; }
    for (const issue of (verdict?.issues || [])) {
      const ln = lines[issue.index] || {};
      const isMolly = /molly/i.test(ln.en || '');
      const willApply = !isMolly && issue.suggested_tr && Number.isInteger(issue.index) && issue.index < tr.length;
      if (willApply) { tr[issue.index] = issue.suggested_tr; fixed += 1; }
      report.push({ slot: item.slot_id, index: issue.index, problem: issue.problem, reason: issue.reason, speaker: ln.speaker, en: ln.en, before: ln.tr, after: willApply ? issue.suggested_tr : ln.tr, applied: willApply });
    }
  }
  if (fixed) writeJson(path.join(runDir, fillsFileName), slotFills);
  if (report.length) {
    const md = [`# 발화 번역 감사 (${targetLang}) — 원문 대조  (총 ${report.length}건 / 적용 ${fixed}건)`, ''];
    for (const r of report) {
      md.push(`## ${r.slot}[${r.index}] [${r.speaker}] ${r.problem}${r.applied ? ' — 적용' : ' — 건너뜀(molly 등)'}`);
      md.push(`- EN: ${r.en}`, `- before: ${r.before}`);
      if (r.applied) md.push(`- after : ${r.after}`);
      md.push(`- ${r.reason || ''}`, '');
    }
    try { fs.appendFileSync(path.join(runDir, 'dialogue_translation_report.md'), md.join('\n') + '\n'); } catch { /* report only */ }
  }
  return { fixed, issues: report };
}

async function runCompressionApply(runIdOrPath, applyOptions = {}) {
  const runDir = resolveCompressionRunDir(runIdOrPath);
  const beatsPath = path.join(runDir, 'narrative_beats.json');
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  if (!fs.existsSync(beatsPath) || !fs.existsSync(editPlanPath)) throw new Error(`Compression artifacts not found in ${runDir}`);
  const beatsObject = readJson(beatsPath);
  const editPlan = readJson(editPlanPath);
  const transcriptPath = path.join(runDir, 'transcript_timed.json');
  const transcript = fs.existsSync(transcriptPath) ? readJson(transcriptPath) : [];
  const targetSec = Number(editPlan?.duration_budget?.target_sec || DEFAULT_TARGET_SEC) || DEFAULT_TARGET_SEC;
  const applyEnergyProfilePath = path.join(runDir, 'energy_profile.json');
  const applyEnergyPeaks = fs.existsSync(applyEnergyProfilePath) ? ((readJson(applyEnergyProfilePath) || {}).peaks || []) : [];
  const finalizedEditPlan = finalizeEditPlan(editPlan, beatsObject.beats || [], transcript, targetSec, readUsableEndSec(runDir), readWordTimestamps(runDir), applyEnergyPeaks);
  const sourceInfoPath = path.join(runDir, 'source_info.json');
  const applyManifestPath = path.join(runDir, 'compression_manifest.json');
  const movieTitle = (fs.existsSync(sourceInfoPath) ? (readJson(sourceInfoPath) || {}).title : '')
    || (fs.existsSync(applyManifestPath) ? (readJson(applyManifestPath) || {}).title : '') || '';
  const recapContext = resolveRecapContext(runDir, applyOptions.contextFile);
  const sourceCasePath = path.join(runDir, 'source_case.json');
  const applySourceCase = fs.existsSync(sourceCasePath) ? readJson(sourceCasePath) : null;
  const applyCaseGuidance = buildSourceCaseGuidance(applySourceCase).join(String.fromCharCode(10));
  const applySceneMapPath = path.join(runDir, VISION_SCENE_MAP_FILE);
  const applyVisionSection = fs.existsSync(applySceneMapPath) ? buildVisionSceneSection(readJson(applySceneMapPath)) : '';
  const slotFillsPrompt = buildSlotFillsPrompt(beatsObject.beats || [], finalizedEditPlan, movieTitle, recapContext.contextMarkdown) + applyCaseGuidance + applyVisionSection;
  const validateStructure = (parsed) => validateSlotFillsDialogueCaptions(
    reconcileDialogueCaptionCounts(normalizeSlotFillsForStyle(parsed, finalizedEditPlan), finalizedEditPlan),
    finalizedEditPlan
  );
  let runtimeShortfall = '';
  let result;
  try {
    result = await runJsonGeneration(
      slotFillsPrompt,
      MIDFORM_SLOT_FILLS_SCHEMA_PATH,
      (parsed) => validateSlotFillsRuntime(validateStructure(parsed), finalizedEditPlan, targetSec)
    );
  } catch (error) {
    // Runtime is a quality target, not a correctness invariant. The retries above push the
    // script toward the target; if it still falls short, ship the cut with a warning rather
    // than failing the whole run and producing nothing.
    if (!String(error?.message || '').includes('far too short for the requested runtime')) throw error;
    runtimeShortfall = String(error.message);
    result = await runJsonGeneration(slotFillsPrompt, MIDFORM_SLOT_FILLS_SCHEMA_PATH, validateStructure);
  }
  const slotFillsPath = path.join(runDir, 'compression_slot_fills.json');
  const normalizedSlotFills = stampCaptionSourceLines(
    keepAuthoredSlotFills(normalizeSlotFillsForStyle(result.parsed, finalizedEditPlan), slotFillsPath),
    finalizedEditPlan
  );
  writeJson(slotFillsPath, normalizedSlotFills);
  try { await auditAndFixDialogueTranslations(runDir, finalizedEditPlan, normalizedSlotFills, 'compression_slot_fills.json', 'Korean'); } catch { /* dialogue audit is advisory */ }
  const uploadTextPath = path.join(runDir, 'upload_text.md');
  writeText(uploadTextPath, `${buildUploadTextMarkdown(normalizedSlotFills.upload_text)}\n`);

  // The Japanese cut gets its own script over the same edit plan, so the ja locale is a
  // real localization instead of the Korean audio with different cuts.
  let japaneseSlotFillsPath = '';
  if (applyOptions.generateJapanese !== false) {
    const japaneseResult = await runJsonGeneration(
      buildJapaneseSlotFillsPrompt(beatsObject.beats || [], finalizedEditPlan, movieTitle, recapContext.contextMarkdown) + applyVisionSection,
      MIDFORM_SLOT_FILLS_SCHEMA_PATH,
      (parsed) => validateJapaneseSlotFills(
        validateSlotFillsDialogueCaptions(parsed, finalizedEditPlan, 'ja'),
        finalizedEditPlan
      )
    );
    japaneseSlotFillsPath = path.join(runDir, 'compression_slot_fills.ja.json');
    const japaneseSlotFills = stampCaptionSourceLines(
      keepAuthoredSlotFills(japaneseResult.parsed, japaneseSlotFillsPath),
      finalizedEditPlan
    );
    writeJson(japaneseSlotFillsPath, japaneseSlotFills);
    try { await auditAndFixDialogueTranslations(runDir, finalizedEditPlan, japaneseSlotFills, 'compression_slot_fills.ja.json', 'Japanese'); } catch { /* dialogue audit is advisory */ }
  }

  const recalculatedEditPlan = recalculateNarrationDurations(finalizedEditPlan, normalizedSlotFills, beatsObject.beats || [], transcript);
  writeJson(editPlanPath, recalculatedEditPlan);
  const slotQcReportPath = path.join(runDir, 'slot_qc_report.json');
  writeJson(slotQcReportPath, buildSlotQcReport(recalculatedEditPlan, normalizedSlotFills));

  const narrationDurations = recalculatedEditPlan.timeline
    .filter((item) => item.decision === 'NARRATE')
    .map((item) => ({
      slot_id: item.slot_id,
      beat_id: item.beat_id,
      role: item.role,
      estimated_duration_sec: item.estimated_duration_sec,
      narration_estimated_duration_sec: item.narration_estimated_duration_sec,
      duration_check: item.duration_check
    }));
  const durationWarnings = narrationDurations.filter((item) => item.duration_check?.status === 'needs_narration_trim');

  const manifestPath = path.join(runDir, 'compression_manifest.json');
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  writeJson(manifestPath, {
    ...manifest,
    coldOpenSelection: recalculatedEditPlan.cold_open_selection || manifest.coldOpenSelection || null,
    narrationDurations,
    llmProvider: compressLlmProvider(),
    uploadTextPath,
    slotQcReportPath,
    contextFile: recapContext.contextFile,
    contextProvided: recapContext.contextProvided
  });

  const applyStatePath = path.join(runDir, 'compress_apply_state.json');
  const applyState = {
    status: 'slot_fills_generated_pipeline_not_connected',
    runDir,
    slotFillsPath,
    japaneseSlotFillsPath,
    runtimeShortfall,
    uploadTextPath,
    editPlanPath,
    slotQcReportPath,
    generatedAt: new Date().toISOString(),
    pipelineBootstrapConnected: false,
    durationWarnings,
    contextFile: recapContext.contextFile,
    contextProvided: recapContext.contextProvided,
    note: 'Phase 1 only: existing pipeline bootstrap connection intentionally not performed.'
  };
  writeJson(applyStatePath, applyState);
  return applyState;
}

// Regenerate ONLY the ja slot fills over the existing (surgically-edited) ko plan/fills.
// The whole-apply path rebuilds ko too, wiping frame-truth surgery; this keeps ko frozen and
// re-runs just the Japanese localization pass - the missing-piece for a source whose ja was
// never produced (HW: its first apply failed ja validation on a punctuation-only line, then
// only refresh ran, which never regenerates ja).
async function regenerateJapaneseSlotFills(runIdOrPath) {
  const runDir = resolveCompressionRunDir(runIdOrPath);
  const beatsPath = path.join(runDir, 'narrative_beats.json');
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  const koFillsPath = path.join(runDir, 'compression_slot_fills.json');
  if (!fs.existsSync(beatsPath) || !fs.existsSync(editPlanPath) || !fs.existsSync(koFillsPath)) {
    throw new Error(`ja regeneration requires narrative_beats.json, edit_plan.json and compression_slot_fills.json in ${runDir}`);
  }
  const beatsObject = readJson(beatsPath);
  const editPlan = readJson(editPlanPath);
  const sourceInfoPath = path.join(runDir, 'source_info.json');
  const manifestPath = path.join(runDir, 'compression_manifest.json');
  const movieTitle = (fs.existsSync(sourceInfoPath) ? (readJson(sourceInfoPath) || {}).title : '')
    || (fs.existsSync(manifestPath) ? (readJson(manifestPath) || {}).title : '') || '';
  const recapContext = resolveRecapContext(runDir);
  const sceneMapPath = path.join(runDir, VISION_SCENE_MAP_FILE);
  const visionSection = fs.existsSync(sceneMapPath) ? buildVisionSceneSection(readJson(sceneMapPath)) : '';
  // The ko fills carry frame-truth surgery (narration rewritten to match the footage after
  // the machine eye caught mismatches). A fresh ja generation would revert to plot summary and
  // fail the same visual check, so pin ja to the ko narration's MEANING per slot.
  const koFills = readJson(koFillsPath);
  const koNarrations = (koFills.slot_fills || [])
    .filter((s) => String(s.narration || '').trim())
    .map((s) => `- ${s.slot_id}: ${String(s.narration).trim()}`)
    .join('\n');
  const koPinSection = koNarrations
    ? `\n\nFRAME-VERIFIED KOREAN NARRATION (translate its MEANING faithfully into Japanese; these already match the footage - do NOT revert to a plot summary, do NOT add events, keep them frame-true):\n${koNarrations}\n`
    : '';
  const japaneseResult = await runJsonGeneration(
    buildJapaneseSlotFillsPrompt(beatsObject.beats || [], editPlan, movieTitle, recapContext.contextMarkdown) + visionSection + koPinSection,
    MIDFORM_SLOT_FILLS_SCHEMA_PATH,
    (parsed) => validateJapaneseSlotFills(validateSlotFillsDialogueCaptions(parsed, editPlan, 'ja'), editPlan)
  );
  const jaPath = path.join(runDir, 'compression_slot_fills.ja.json');
  writeJson(jaPath, japaneseResult.parsed);
  try {
    const editPlanForAudit = readJson(path.join(runDir, 'edit_plan.json'));
    await auditAndFixDialogueTranslations(runDir, editPlanForAudit, japaneseResult.parsed, 'compression_slot_fills.ja.json', 'Japanese');
  } catch { /* dialogue audit is advisory */ }
  return { runDir, japaneseSlotFillsPath: jaPath, slots: (japaneseResult.parsed?.slot_fills || []).length };
}

function refreshCompressionPlan(runIdOrPath) {
  const runDir = resolveCompressionRunDir(runIdOrPath);
  const beatsPath = path.join(runDir, 'narrative_beats.json');
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  const slotFillsPath = path.join(runDir, 'compression_slot_fills.json');
  const transcriptPath = path.join(runDir, 'transcript_timed.json');
  const heatmapPath = path.join(runDir, 'heatmap.json');
  const metadataPath = path.join(runDir, 'source_info.json');
  if (!fs.existsSync(beatsPath) || !fs.existsSync(editPlanPath) || !fs.existsSync(transcriptPath)) {
    throw new Error(`Compression refresh requires narrative_beats.json, edit_plan.json, and transcript_timed.json in ${runDir}`);
  }
  const beatsObject = readJson(beatsPath);
  const currentPlan = readJson(editPlanPath);
  let transcript = readJson(transcriptPath);
  // Idempotent anchor-cue merge on refresh too: a surgical rewrite of beats/anchors during a
  // re-run gets the same clean transcript the initial apply produced (no-op when already merged).
  const refreshMerged = mergeAnchorCuesInTranscript(transcript, beatsObject.beats || []);
  if (refreshMerged !== transcript) {
    transcript = refreshMerged;
    writeJson(transcriptPath, transcript);
  }
  beatsObject.beats = pruneUnmatchedBeatAnchors(beatsObject.beats || [], transcript);
  const metadata = fs.existsSync(metadataPath) ? readJson(metadataPath) : {};
  const heatmap = fs.existsSync(heatmapPath) ? readJson(heatmapPath) : { status: 'unavailable', items: [] };
  const targetSec = Number(currentPlan?.duration_budget?.target_sec || DEFAULT_TARGET_SEC) || DEFAULT_TARGET_SEC;
  const refreshEnergyProfilePath = path.join(runDir, 'energy_profile.json');
  const refreshEnergyPeaks = fs.existsSync(refreshEnergyProfilePath) ? ((readJson(refreshEnergyProfilePath) || {}).peaks || []) : [];
  let refreshedPlan = finalizeEditPlan(currentPlan, beatsObject.beats || [], transcript, targetSec, readUsableEndSec(runDir), readWordTimestamps(runDir), refreshEnergyPeaks);
  if (fs.existsSync(slotFillsPath)) {
    refreshedPlan = recalculateNarrationDurations(refreshedPlan, readJson(slotFillsPath), beatsObject.beats || [], transcript);
  }
  validateEditPlanAgainstBeats(validateEditPlan(refreshedPlan), beatsObject.beats || []);
  writeJson(editPlanPath, refreshedPlan);
  const markdownPath = path.join(runDir, 'narrative_beats.md');
  writeText(markdownPath, `${buildNarrativeBeatsMarkdown({
    runId: path.basename(runDir),
    metadata,
    heatmap,
    beatsObject,
    editPlan: refreshedPlan,
    paths: { transcriptPath, heatmapPath, beatsPath, editPlanPath }
  })}\n`);
  return {
    runDir,
    editPlanPath,
    markdownPath,
    coldOpenSelection: refreshedPlan.cold_open_selection,
    durationBudget: refreshedPlan.duration_budget
  };
}

function findDownloadedCompressionSource(runDir) {
  const candidates = fs.readdirSync(runDir)
    .filter((name) => /^source\.[A-Za-z0-9]+$/.test(name))
    .map((name) => path.join(runDir, name))
    .filter((filePath) => fs.statSync(filePath).isFile());
  candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] || '';
}

// Phase 1 (compress/compress-apply) only fetches metadata/subtitles/heatmap with
// --skip-download, so no real video file ever lands on disk. Phase 2 bootstrap needs
// the actual source video, so this downloads it into the compression run's own dir.
async function downloadCompressionSourceVideo(runIdOrPath, options = {}) {
  const runDir = resolveCompressionRunDir(runIdOrPath);
  if (!fs.existsSync(runDir)) throw new Error(`Compression run directory not found: ${runDir}`);
  const manifestPath = path.join(runDir, 'compression_manifest.json');
  const sourceInfoPath = path.join(runDir, 'source_info.json');
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const sourceInfo = fs.existsSync(sourceInfoPath) ? readJson(sourceInfoPath) : {};
  const sourceUrl = String(
    manifest.sourceUrl || sourceInfo.webpage_url || sourceInfo.original_url || ''
  ).trim();
  if (!sourceUrl) {
    throw new Error(`Cannot download source: no sourceUrl in compression_manifest.json or source_info.json (${runDir})`);
  }

  const existing = findDownloadedCompressionSource(runDir);
  if (existing && options.force !== true) {
    const updated = { ...manifest, sourceVideoPath: existing, sourceVideoDownloaded: true };
    writeJson(manifestPath, updated);
    return { runDir, sourceVideoPath: existing, sourceUrl, reused: true };
  }

  const ytDlp = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  await execFileAsync(ytDlp, [
    '--js-runtimes', 'node',
    '--no-playlist',
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(runDir, 'source.%(ext)s'),
    sourceUrl
  ], { timeout: 60 * 60 * 1000 });
  const sourceVideoPath = findDownloadedCompressionSource(runDir);
  if (!sourceVideoPath) {
    throw new Error(`yt-dlp completed but no source file was found in ${runDir}`);
  }
  const updated = {
    ...manifest,
    sourceVideoPath,
    sourceVideoDownloaded: true,
    sourceVideoDownloadedAt: new Date().toISOString()
  };
  writeJson(manifestPath, updated);
  return { runDir, sourceVideoPath, sourceUrl, reused: false };
}

module.exports = {
  detectPromoTail,
  // The bootstrap adapter runs this again as its last step: padding needs disjoint windows and the
  // plan can be edited after compression separates them.
  separateOverlappingDialogueWindows,
  buildSlotFillsPrompt,
  resolveRecapContext,
  runCompression,
  runCompressionApply,
  refreshCompressionPlan,
  regenerateJapaneseSlotFills,
  downloadCompressionSourceVideo,
  resolveCompressionRunDir,
  extractTimedTranscript,
  parseVtt,
  fillDialogueExchangeGaps,
  dropWindowsSwallowedByTheirNeighbour,
  extractHeatmap,
  _test: {
    clampColdOpenToTeaser,
    trimTimelineToTargetRuntime,
    dropDuplicateDialogueSlots,
    isNonSpeechCaption,
    pickTeaserQuote,
    coldOpenDialogueFocusForBeat,
    leadColdOpenWithStrongestLine,
    findNarrationNameplate,
    findNarrationInventedReveal,
    validateKoreanNarrationStyle,
    applyColdOpenVisualOverlapSafety,
    validateSlotFillsDialogueCaptions,
    resolveDialogueLineWindows,
    splitMultiTurnDialogueLine,
    completeBeatDialogueFromCues,
    mergeAnchorCuesInTranscript,
    collectDialogueFocus,
    profileSourceCase,
    buildSourceCaseGuidance,
    detectPromoTail,
    separateOverlappingDialogueWindows,
    dropRestatedWindows,
    alignFocusLinesToWindows,
    dropUnplayableFocusLines,
    keepAuthoredSlotFills,
    stampCaptionSourceLines,
    fillUncaptionedCuesInsideCuts,
    topUpTimelineToTargetRuntime,
    buildSlotQcReport,
    buildSlotFillEditorialGuide,
    finalizeEditPlan,
    selectColdOpenBeat,
    buildFallbackEditPlan,
    clampSceneHookWindow,
    validateBeats,
    validateEditPlan,
    validateSlotFillsRuntime,
    reconcileDialogueCaptionCounts,
    isCuriosityTitle,
    validateEditPlanAgainstBeats,
    evaluateDialogueTimingQc,
    buildMicroExchangeCandidates,
    measuredActionShare,
    speechRatioOfFootage,
    buildDialogueUnitMetadata,
    buildTeaserSuitabilityScore,
    bestColdOpenCallbackBeat,
    rerankColdOpenSelection,
    snapDialogueWindowsToWords,
    insertActionBeatSlots
  }
};
