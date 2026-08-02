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
const { generateVertexJson } = require('./geminiMidformService');

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
      top: String(overlayTitle.top || '').trim().slice(0, 8),
      bottom: String(overlayTitle.bottom || '').trim().slice(0, 8)
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
  return dedupeRollingCues(cues);
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

async function extractTimedTranscript(sourceUrl, runDir) {
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

function coldOpenDialogueFocusForBeat(beat, transcript) {
  const hook = Number(beat?.hook_potential || 0);
  const quality = String(beat?.dialogue_quality || '').trim();
  if (quality !== 'high' || hook < 4) return null;
  const anchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const teaserQuote = pickTeaserQuote(beat);
  const quotes = anchors.length ? anchors : (teaserQuote ? [teaserQuote] : []);
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
  const anchorFocus = coldOpenDialogueFocusForBeat(beat, transcript);
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
  return ratio >= 0.5 ? 50 + ratio * 20 : ratio * 20;
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

function dedupeFocusLines(lines) {
  const output = [];
  for (const value of lines) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const previous = output[output.length - 1] || '';
    if (previous && (previous === text || previous.includes(text) || text.includes(previous))) {
      if (text.length > previous.length) output[output.length - 1] = text;
      continue;
    }
    output.push(text);
  }
  return output;
}

function limitDialogueFocusLines(focus, requiredLines = [], maxLines = 5) {
  const lines = dedupeFocusLines(Array.isArray(focus?.lines) ? focus.lines : []);
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
  const matches = [];
  for (const quote of quotes) {
    let best = null;
    for (const cue of cues) {
      const duplicate = matches.some((item) => item.cue.start_sec === cue.start_sec && item.cue.end_sec === cue.end_sec);
      if (duplicate) continue;
      const score = scoreCueAgainstQuote(cue.text, quote);
      if (!best || score > best.score) best = { cue, quote, score };
    }
    if (best && best.score >= 50) matches.push(best);
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

function applyColdOpenVisualOverlapSafety(timeline, beatMap) {
  const nextTimeline = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  const coldIndex = nextTimeline.findIndex((item) => item.role === 'cold_open');
  const cold = nextTimeline[coldIndex];
  if (!cold || cold.decision !== 'NARRATE' || !(Number(cold.visual_source_end_sec) > Number(cold.visual_source_start_sec))) return nextTimeline;
  const reservedRanges = nextTimeline
    .filter((item) => item.decision === 'KEEP_DIALOGUE' && Number(item.end_sec) > Number(item.start_sec))
    .map((item) => [Number(item.start_sec), Number(item.end_sec)]);
  const adjusted = adjustVisualSourceAwayFromReserved({
    mode: cold.visual_source_mode || 'mute_visual_teaser',
    beat_id: cold.visual_source_beat_id,
    start_sec: Number(cold.visual_source_start_sec),
    end_sec: Number(cold.visual_source_end_sec),
    reason: 'Cold-open overlap safety check.'
  }, beatMap.get(String(cold.visual_source_beat_id || '').trim()), reservedRanges);
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
      dialogue_focus_quotes: selected.focus.matched_quotes || selected.focus.lines,
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
  const previousCue = (pronounRisk || dialogueDependency) ? findPreviousContextCue(beat, transcript, { ...focus, lines }) : null;
  if (previousCue) {
    nextLines = [String(previousCue.text || '').trim(), ...lines];
    contextStrategy = 'merge_exchange';
    appliedFix = 'merged_previous_line';
  } else if (pronounRisk || dialogueDependency) {
    contextStrategy = 'bridge_narration';
    appliedFix = 'bridge_required';
  }
  const standaloneScore = pronounRisk || dialogueDependency ? (previousCue ? 0.72 : 0.45) : 0.9;
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
    for (let i = 0; i < sortedCues.length; i += 1) {
      const score = scoreCueAgainstQuote(sortedCues[i].text, line);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const matched = bestIndex >= 0 && bestScore >= MATCH_THRESHOLD;
    if (!matched) {
      warnings.push(`dialogue line has no confident transcript match (best score ${roundSec(bestScore)}): "${line}"`);
      return { line, matched: false, score: roundSec(bestScore), raw_start: null, raw_end: null };
    }
    let lo = bestIndex;
    let hi = bestIndex;
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
    return {
      line,
      matched: true,
      score: roundSec(bestScore),
      raw_start: Number(sortedCues[lo].start_sec),
      raw_end: Number(sortedCues[hi].end_sec)
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

  let prevEnd = start;
  for (let position = 0; position < matchedOrder.length; position += 1) {
    const current = matchedOrder[position].item;
    const next = position + 1 < matchedOrder.length ? matchedOrder[position + 1].item : null;
    const lineStart = Math.max(start, current.raw_start - DIALOGUE_CONTEXT_PRE_ROLL_SEC, prevEnd);
    // ceiling = how far this line may occupy. Interior lines stop at the next line start.
    // The LAST line may extend to its real transcript cue end even PAST the beat boundary — a beat
    // boundary landing on a spoken line (cue starting at beat.end) would otherwise clamp it to ~0s.
    const ceiling = next
      ? Math.min(hardMax, Number(next.raw_start))
      : Math.min(Math.max(hardMax, Number(current.raw_end)), lastLineCeiling);
    const naturalEnd = Math.min(current.raw_end + DIALOGUE_CONTEXT_POST_ROLL_SEC, ceiling);
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
      warnings.push(`dialogue line window is ${roundSec(lineEnd - lineStart)}s (< ${MIN_LINE_SEC}s) even after extension, no room before the next line: "${current.line}"`);
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

  const ok = windows.every((w) => w.matched && !w.too_short && Number(w.end_sec) > Number(w.start_sec));
  return { windows, warnings, ok };
}

function pickTeaserQuote(beat) {
  const quotes = Array.isArray(beat?.key_dialogue) ? beat.key_dialogue : [];
  if (!quotes.length) return '';
  const ranked = [...quotes].sort((left, right) => {
    const leftScore = (/[?？]$/.test(String(left).trim()) ? 10 : 0)
      + (/bad guy|truth|stay away|what are they really|don'?t come here/i.test(String(left)) ? 8 : 0)
      + String(left).length / 40;
    const rightScore = (/[?？]$/.test(String(right).trim()) ? 10 : 0)
      + (/bad guy|truth|stay away|what are they really|don'?t come here/i.test(String(right)) ? 8 : 0)
      + String(right).length / 40;
    return rightScore - leftScore;
  });
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
  const keepDialogueSec = roundSec(timeline
    .filter((item) => item.decision === 'KEEP_DIALOGUE')
    .reduce((sum, item) => sum + Number(item.estimated_duration_sec || 0), 0));
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

function bestColdOpenCallbackBeat(beats, transcript, preferredBeatId = '') {
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
      const preferredSelectionScore = selectionScore + (isPreferredBeat && (supportAction !== 'bridge_required' || hasRepairablePreferredDialogue) ? 120 : 0);
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
  return candidates[0] || null;
}

function prepareColdOpenCallbackTimeline(timeline, editPlan, beats, transcript) {
  if (!isDialogueDrivenConfrontation(editPlan, beats)) return timeline;
  // A heatmap-peak scene hook (original-audio action teaser) must not be replaced by a
  // dialogue callback hook — the peak moment IS the hook.
  const existingCold = (Array.isArray(timeline) ? timeline : []).find((item) => item?.role === 'cold_open');
  if (String(existingCold?.visual_source_mode || '').trim() === 'source_audio_teaser') return timeline;
  const selected = bestColdOpenCallbackBeat(beats, transcript, editPlan?.cold_open_selection?.beat_id);
  if (!selected) return timeline;
  const hookBeatId = String(selected.beat.beat_id || '').trim();
  const nextTimeline = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  const coldIndex = nextTimeline.findIndex((item) => item.role === 'cold_open');
  if (coldIndex < 0) return nextTimeline;
  const cold = nextTimeline[coldIndex];
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
    dialogue_focus_quotes: selected.focus.quotes,
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
function realisticSlotDurationSec(item) {
  if (!item || item.decision === 'DROP') return 0;
  if (item.decision === 'KEEP_DIALOGUE') {
    const span = Number(item.end_sec || 0) - Number(item.start_sec || 0);
    return span > 0 ? roundSec(span) : 0;
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
function topUpTimelineToTargetRuntime(timeline, beats, transcript, targetSec) {
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
            dialogue_focus_quotes: focus.quotes
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
const MAX_NARRATION_RUN_SEC = 25;

function interleaveDialogueIntoNarrationRuns(timeline, beats, transcript) {
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  let runSec = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.decision === 'DROP') continue;
    if (item.decision === 'KEEP_DIALOGUE') { runSec = 0; continue; }
    runSec += realisticSlotDurationSec(item);
    if (runSec <= MAX_NARRATION_RUN_SEC) continue;
    // The opening hook stays whatever it was chosen to be.
    if (item.role === 'cold_open') continue;
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
function dropDuplicateDialogueSlots(timeline) {
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  const claimed = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const start = Number(item.start_sec);
    const end = Number(item.end_sec);
    if (!(end > start)) continue;
    const clash = claimed.find(([claimedStart, claimedEnd]) => (
      Math.abs(start - claimedStart) <= 0.15 && Math.abs(end - claimedEnd) <= 0.15
    ));
    if (clash) {
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
  }
  return items;
}

// A cold open that overruns the teaser limit used to fail validation outright, which spent the
// retries and dropped the run onto the fallback planner over the tail of a single slot. Trim it
// to the lines that fit instead: the hook survives, the plan survives with it.
function clampColdOpenToTeaser(timeline) {
  const coldOpen = timeline.find((item) => item.role === 'cold_open');
  if (!coldOpen) return timeline;
  const isDialogue = coldOpen.decision === 'KEEP_DIALOGUE';
  const limit = isDialogue ? COLD_OPEN_DIALOGUE_MAX_SEC : COLD_OPEN_NARRATION_MAX_SEC;
  if (Number(coldOpen.estimated_duration_sec || 0) <= limit) return timeline;

  if (isDialogue) {
    const windows = Array.isArray(coldOpen.dialogue_line_windows) ? coldOpen.dialogue_line_windows : [];
    const matched = windows.filter((win) => win && win.matched !== false && Number.isFinite(Number(win.start_sec)));
    if (matched.length > 1) {
      const openStart = Number(matched[0].start_sec);
      let keep = 1;
      while (keep < matched.length && Number(matched[keep].end_sec) - openStart <= limit) keep += 1;
      if (keep < matched.length) {
        const dropped = new Set(matched.slice(keep));
        coldOpen.dialogue_line_windows = windows.filter((win) => !dropped.has(win));
        if (Array.isArray(coldOpen.dialogue_focus_lines)) coldOpen.dialogue_focus_lines = coldOpen.dialogue_focus_lines.slice(0, keep);
        if (Array.isArray(coldOpen.dialogue_focus_quotes)) coldOpen.dialogue_focus_quotes = coldOpen.dialogue_focus_quotes.slice(0, keep);
        const keptEnd = Number(matched[keep - 1].end_sec);
        if (Number.isFinite(keptEnd) && keptEnd > openStart) {
          coldOpen.start_sec = roundSec(openStart);
          coldOpen.end_sec = roundSec(keptEnd);
          coldOpen.estimated_duration_sec = roundSec(keptEnd - openStart);
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

function trimTimelineToTargetRuntime(timeline, targetSec) {
  const target = Number(targetSec || 0);
  const items = (Array.isArray(timeline) ? timeline : []).map((item) => ({ ...item }));
  if (!(target > 0)) return items;

  // body_peak belongs here too: validateEditPlan requires it to outlast the teaser, so
  // trimming it away leaves a plan its own validator rejects.
  const protectedRoles = new Set(['cold_open', 'bridge', 'body_peak', 'payoff', 'closing']);
  const droppable = () => items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.decision !== 'DROP' && !protectedRoles.has(String(item.role || '').trim()))
    .sort((left, right) => {
      const weight = (entry) => Number(entry.item.hook_potential || 0) + Number(entry.item.dramatic_weight || 0);
      // Weakest first; on a tie drop the longest, so one cut buys the most room.
      return weight(left) - weight(right)
        || realisticSlotDurationSec(right.item) - realisticSlotDurationSec(left.item);
    });

  // Two runtime measures disagreed: this trim used the realistic one while duration_budget sums
  // the raw estimates, so a plan the trim called finished still reported 194s against a 180s
  // ceiling. Enforce the ceiling on whichever measure is larger.
  const runtimeOf = (list) => Math.max(
    realisticTimelineRuntimeSec(list),
    list.filter((item) => item.decision !== 'DROP')
      .reduce((sum, item) => sum + Number(item.estimated_duration_sec || 0), 0)
  );

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
      .filter(({ item }) => item.decision === 'KEEP_DIALOGUE'
        && (Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []).filter((w) => w && w.matched === true).length > 1)
      .sort((left, right) => (Number(left.item.hook_potential || 0) + Number(left.item.dramatic_weight || 0))
        - (Number(right.item.hook_potential || 0) + Number(right.item.dramatic_weight || 0)));
    if (!shaveable.length) break;
    const { item, index } = shaveable[0];
    const windows = item.dialogue_line_windows.slice();
    let lastMatched = windows.length - 1;
    while (lastMatched >= 0 && !(windows[lastMatched] && windows[lastMatched].matched === true)) lastMatched -= 1;
    windows.splice(lastMatched, 1);
    const kept = windows.filter((w) => w && w.matched === true);
    const starts = kept.map((w) => Number(w.start_sec)).filter(Number.isFinite);
    const ends = kept.map((w) => Number(w.end_sec)).filter(Number.isFinite);
    const shaved = { ...item, dialogue_line_windows: windows, runtime_trimmed: true };
    if (Array.isArray(item.dialogue_focus_lines)) shaved.dialogue_focus_lines = item.dialogue_focus_lines.filter((_, i) => i !== lastMatched);
    if (Array.isArray(item.dialogue_focus_quotes)) shaved.dialogue_focus_quotes = item.dialogue_focus_quotes.filter((_, i) => i !== lastMatched);
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

function finalizeEditPlan(editPlan, beats, transcript, targetSec) {
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
    if (next.decision === 'KEEP_DIALOGUE' && beat) {
      const plannedQuotes = Array.isArray(next.dialogue_focus_quotes)
        ? next.dialogue_focus_quotes.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      const requiredAnchors = Array.isArray(beat?.anchor_dialogue) ? beat.anchor_dialogue : [];
      const hookTeaser = String(next?.editorial_role || '').trim() === 'hook_teaser'
        || (String(next?.role || '').trim() === 'cold_open' && String(editPlan?.editorial_pattern || '').trim() === 'cold_open_callback');
      const preferredQuotes = hookTeaser
        ? (plannedQuotes.length ? plannedQuotes : requiredAnchors.slice(0, 1))
        : (plannedQuotes.length ? [...new Set([...requiredAnchors, ...plannedQuotes])] : requiredAnchors);
      const rawFocus = collectDialogueFocus(beat, transcript, preferredQuotes.length ? { quotes: preferredQuotes } : {});
      if (rawFocus) {
        const enriched = enrichDialogueFocusForCoherence(beat, transcript, rawFocus);
        const focus = limitDialogueFocusLines(enriched.focus, requiredAnchors);
        next.start_sec = focus.start_sec;
        next.end_sec = focus.end_sec;
        next.estimated_duration_sec = roundSec(focus.end_sec - focus.start_sec);
        next.dialogue_focus_source = 'key_dialogue';
        next.dialogue_focus_quotes = focus.matched_quotes || focus.lines;
        next.dialogue_focus_lines = focus.lines;
        // Compute per-line source windows ONCE here; Phase 2 transcript + slot_map both
        // read these exact stored numbers (single source of coordinates for each line).
        const nextBeatStart = sortedBeatStarts.find((startSec) => startSec > Number(beat.end_sec) + 0.001);
        const readable = resolveReadableDialogueWindows(transcript, focus, beat.end_sec, nextBeatStart, requiredAnchors);
        const lineResolution = readable.resolution;
        next.dialogue_focus_quotes = readable.focus.matched_quotes || readable.focus.lines;
        next.dialogue_focus_lines = readable.focus.lines;
        next.dialogue_line_windows = lineResolution.windows;
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
  if (coldIndex >= 0) {
    const cold = { ...timeline[coldIndex] };
    const coldBeat = beatMap.get(String(cold.beat_id || '').trim());
    const isSceneHookCold = String(cold.visual_source_mode || '').trim() === 'source_audio_teaser';
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
    if (cold.decision === 'KEEP_DIALOGUE') {
      const existingLines = Array.isArray(cold.dialogue_focus_lines) ? cold.dialogue_focus_lines.filter(Boolean) : [];
      const existingQuotes = Array.isArray(cold.dialogue_focus_quotes) ? cold.dialogue_focus_quotes.filter(Boolean) : [];
      const preferredQuotes = existingQuotes.length ? existingQuotes : existingLines;
      const rawFocus = coldBeat ? collectDialogueFocus(coldBeat, transcript, preferredQuotes.length ? { quotes: preferredQuotes } : {}) : null;
      if (rawFocus) {
        const enriched = enrichDialogueFocusForCoherence(coldBeat, transcript, rawFocus);
        const focus = limitDialogueFocusLines(enriched.focus, preferredQuotes);
        cold.start_sec = focus.start_sec;
        cold.end_sec = focus.end_sec;
        cold.estimated_duration_sec = roundSec(Number(focus.end_sec) - Number(focus.start_sec));
        cold.dialogue_focus_source = cold.dialogue_focus_source || 'cold_open_anchor_dialogue';
        cold.dialogue_focus_quotes = focus.matched_quotes || focus.lines;
        cold.dialogue_focus_lines = focus.lines;
        cold.dialogue_selection_scores = {
          ...(cold.dialogue_selection_scores || {}),
          ...coldOpenCallbackScores(coldBeat, focus.lines)
        };
        const nextBeatStart = sortedBeatStarts.find((startSec) => startSec > Number(coldBeat.end_sec) + 0.001);
        const readable = resolveReadableDialogueWindows(transcript, focus, coldBeat.end_sec, nextBeatStart, preferredQuotes);
        const lineResolution = readable.resolution;
        cold.dialogue_focus_quotes = readable.focus.matched_quotes || readable.focus.lines;
        cold.dialogue_focus_lines = readable.focus.lines;
        cold.dialogue_line_windows = lineResolution.windows;
        cold.dialogue_line_window_ok = lineResolution.ok;
        cold.dialogue_line_window_warnings = lineResolution.warnings;
        Object.assign(cold, annotateDialogueSlotForQc(cold, lineResolution, enriched.qc));
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

  const toppedUpTimeline = topUpTimelineToTargetRuntime(timeline, beats, transcript, targetSec);
  const interleavedTimeline = interleaveDialogueIntoNarrationRuns(toppedUpTimeline, beats, transcript);
  const dedupedTimeline = dropDuplicateDialogueSlots(interleavedTimeline);
  const trimmedTimeline = clampColdOpenToTeaser(trimTimelineToTargetRuntime(dedupedTimeline, targetSec));
  let finalizedTimeline = trimmedTimeline.map((item) => {
    if (item.decision === 'KEEP_DIALOGUE') return annotateDialogueSlotForQc(item, { windows: item.dialogue_line_windows || [] }, item);
    return annotateNarrationSlotForQc(item);
  });
  finalizedTimeline = applyColdOpenVisualOverlapSafety(finalizedTimeline, beatMap);
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
    duration_budget: recalculateDurationBudget(finalizedTimeline, targetSec)
  };
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
    '- If heatmap is unavailable, set fallback_used true and choose max hook_potential, then dramatic_weight.',
    '- cold_open must be short. Use about 3-6 seconds for narration-led visual teasers or scene hooks, or up to about 16 seconds when preserving a compact original-dialogue hook.',
    '- For dialogue-led hook beats (when no heatmap peak overrides), cold_open should be KEEP_DIALOGUE with 1-2 strongest anchor lines, not a narrated muted clip.',
    '- Score dialogue candidates with teaser_hook_strength, callback_payoff_strength, curiosity_gap, replay_value, and context_dependency. Avoid teaser lines that are pronoun-dependent or too context-heavy unless you extend to a micro-exchange.',
    '- If cold_open is KEEP_DIALOGUE, the later body_peak for the same beat must not duplicate the exact same source dialogue window; use aftermath/context narration or a distinct later line instead.',
    '- KEEP_DIALOGUE keeps only the identity dialogue of the beat, not the full beat transcript.',
    '- KEEP_DIALOGUE dialogue_focus must always include every anchor_dialogue line from that beat.',
    '- dialogue_focus_quotes for a KEEP_DIALOGUE slot should hold 1 or 2 lines — a line, or a line and the answer to it. Three or more turns crams a whole conversation into one block and flattens the rhythm; split them into separate slots instead, and never exceed 4.',
    '- Spread the dialogue through the cut rather than stacking it. Two KEEP_DIALOGUE slots in a row are fine when they are a call and its answer, but a run of dialogue followed by a long stretch of pure narration is the shape to avoid. Aim for dialogue -> short recovery -> dialogue -> reaction -> short recovery -> dialogue -> payoff.',
    '- Never let narration run for more than about 25 seconds without preserved dialogue between. If a stretch needs that much explaining, a line from the scene belongs in the middle of it.',
    '- Exclude environment description, transitions, cushion setup, joke detours, and side-branch lines even if they happen inside the same beat.',
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
    '- If the context implies 사건 훅 먼저, the first bridge/body narration after the cold open must begin with the kidnapping, standoff, chase, attack, trap, or another live event, not with a standalone character-introduction sentence like a nameplate.',
    '- The NARRATE/bridge slot immediately BEFORE a KEEP_DIALOGUE slot must set up that dialogue: who is speaking, and why this line happens now (use the movie context above).',
    '- The NARRATE slot immediately AFTER a KEEP_DIALOGUE slot should resolve or interpret what that dialogue meant or led to.',
    '- Narration is the connective tissue between dialogue moments. A viewer must never reach a dialogue line without the surrounding narration having given its context.',
    '- After EVERY KEEP_DIALOGUE block, the very next NARRATE must state the OUTCOME, what that dialogue led to, before moving on. Example: after a hostage-bargain dialogue, say how the exchange ended and how the victim came to die; after a "we were bait" line, explain WHY they were bait and what the trap actually was. Never jump to the next scene leaving the result untold.',
    '- The cold_open question MUST be explicitly answered by narration in the body (at or right after body_peak). Do not leave the answer to the dialogue alone. The narration itself must resolve the hook in plain words.',
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
    '- caption_kr_dialogue must have exactly the same number of items as dialogue_focus_lines for that slot. Never merge two dialogue lines into one caption, never split one into two. On-screen caption timing is locked to the original dialogue lines, so a count mismatch breaks sync.',
    '- For KEEP_DIALOGUE slots, optionally fill speakers as one speaker name per caption_kr_dialogue line when the speaker is clear. Use speaker for a single-speaker slot or speakers for per-line speakers. Leave unknown speakers empty.',
    '- caption_kr_dialogue must read as natural spoken Korean, not a literal/translationese rendering. Example: "What are they really?" -> "걔넨 대체 뭐야?", not "그들은 정말로 무엇입니까?".',
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
    '- Each slot rule carries narration_target_sec and narration_target_chars. Write that slot\'s narration to approximately that many Korean characters excluding spaces (within about 15%). These budgets are what makes the cut reach its requested runtime — a one-line summary where 120 characters were budgeted leaves the finished video roughly half its intended length. Use the extra room for beats and consequence, never for filler or repetition.',
    '- Narration must read like a storyteller pulling the viewer forward, NOT like a plot synopsis. Reject the encyclopedic register: do not stack several facts into one "A 때문에 B가 C합니다" sentence, and do not open a slot by naming every faction and motive at once. One idea per sentence, short sentences, and each slot should end with tension or consequence that makes the next slot feel necessary.',
    '- Never resolve the curiosity the opening created before the payoff slot. If the cold open raised "why is this happening", the following slots may show WHAT is happening and raise the stakes, but must withhold the WHY until the payoff.',
    '- When the cold open is a wordless scene hook (visual_source_mode "source_audio_teaser"), the very next narration must NOT begin by explaining the whole premise. Enter mid-tension with the immediate situation, then let context arrive a piece at a time across the following slots.',
    '- The payoff slot must land its reversal as a reveal, not a report. Deliver the turn in a short punchy line rather than a calm descriptive sentence that merely states what happened.',
    '- Do not repeat a preserved dialogue line in narration with the same informational content. If KEEP_DIALOGUE already says the core beat, narration must add setup, consequence, stakes, or interpretation instead of paraphrasing the same line.',
    '- If cold_open is NARRATE, its narration must plant a question and must not reveal the answer.',
    '- EXCEPTION: if the cold_open slot rule shows visual_source_mode "source_audio_teaser" (heatmap scene hook), set narration to an empty string and leave caption_kr and caption_units empty — the original action audio of the peak moment IS the hook, and any voiceover would smother it.',
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
    '- upload_text.title_candidates must contain exactly 3 Korean title options. Every title must open a curiosity gap, either question-shaped ("~일까?", "왜 ~했을까?", "어쩌다 ~됐을까?") or ending on a noun that promises the answer without giving it ("~한 이유", "~의 정체", "~의 비밀", "~의 결말", "~한 순간"). A flat declarative summary is rejected. Do not use the movie title itself as the hook.',
    '- upload_text.overlay_title is required and must be separate from YouTube title_candidates. It must be an object with top and bottom strings, each 8 Korean characters or fewer excluding spaces where possible. This is for the on-screen CapCut title overlay, so it can be shorter than the YouTube title.',
    '- upload_text.overlay_title must preserve curiosity but fit two compact lines. Example: {"top":"쫓던 보안관이","bottom":"미끼가 된 날"}.',
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
    JSON.stringify(editPlan, null, 2)
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
    '- For KEEP_DIALOGUE slots, optionally fill speakers with one speaker name per line when the speaker is clear.',
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
    JSON.stringify(editPlan, null, 2)
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
  if (uploadText.overlay_title.top.length > 8 || uploadText.overlay_title.bottom.length > 8) {
    throw new Error(`upload_text.overlay_title top/bottom must be <= 8 chars, got: ${uploadText.overlay_title.top} / ${uploadText.overlay_title.bottom}`);
  }
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
      throw new Error(`${item.slot_id} KEEP_DIALOGUE (${item.role}) must keep narration, caption_kr, and caption_units empty to avoid repeating preserved dialogue`);
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
    if (item?.decision === 'KEEP_DIALOGUE') {
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

function validateBeats(beatsObject, transcript) {
  const beats = normalizeBeatAnchors(Array.isArray(beatsObject?.beats) ? beatsObject.beats : []);
  if (!beats.length) throw new Error('narrative beats output is empty');
  const minStart = Math.min(...transcript.map((cue) => cue.start_sec));
  const maxEnd = Math.max(...transcript.map((cue) => cue.end_sec));
  for (const beat of beats) {
    if (!String(beat.beat_id || '').trim()) throw new Error('beat_id is required');
    if (!(Number(beat.end_sec) > Number(beat.start_sec))) throw new Error(`${beat.beat_id} has invalid time range`);
    if (Number(beat.start_sec) < minStart - 0.5 || Number(beat.end_sec) > maxEnd + 0.5) throw new Error(`${beat.beat_id} is outside transcript range`);
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

function validateEditPlanAgainstBeats(editPlan, beats) {
  const beatMap = new Map((Array.isArray(beats) ? beats : []).map((beat) => [String(beat?.beat_id || '').trim(), beat]));
  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    if (String(item?.replay_of_slot_id || '').trim() && String(item?.replay_mode || '').includes('remaining_dialogue')) continue;
    const beat = beatMap.get(String(item?.beat_id || '').trim());
    if (!beat) continue;
    const anchors = Array.isArray(beat.anchor_dialogue) ? beat.anchor_dialogue : [];
    const focusQuotes = new Set((Array.isArray(item.dialogue_focus_quotes) ? item.dialogue_focus_quotes : []).map((value) => String(value || '').trim()));
    const hookTeaser = String(item?.editorial_role || '').trim() === 'hook_teaser'
      || (String(item?.role || '').trim() === 'cold_open' && String(editPlan?.editorial_pattern || '').trim() === 'cold_open_callback');
    if (hookTeaser) {
      continue;
    }
    for (const anchor of anchors) {
      if (!focusQuotes.has(anchor)) {
        throw new Error(`${item.slot_id} KEEP_DIALOGUE must include beat anchor: ${anchor}`);
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
      if (focusQuotes.length > 5) throw new Error(`${item.slot_id} KEEP_DIALOGUE must limit dialogue_focus_quotes to 5 lines`);
    }
  }
  return editPlan;
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

async function runCompression(source, options = {}) {
  const sourceUrl = normalizeSourceUrl(source);
  const targetSec = Number(options.target || options.targetSec || DEFAULT_TARGET_SEC) || DEFAULT_TARGET_SEC;
  const { runId, runDir } = createCompressionRun(sourceUrl);
  const statePath = path.join(runDir, 'compress_state.json');
  writeJson(statePath, { runId, status: 'running', sourceUrl, targetSec, createdAt: new Date().toISOString() });
  const seededContextPath = path.join(runDir, 'context.md');
  if (!fs.existsSync(seededContextPath) && fs.existsSync(RECAP_CONTEXT_TEMPLATE_PATH)) {
    fs.copyFileSync(RECAP_CONTEXT_TEMPLATE_PATH, seededContextPath);
  }

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

  let finalizedEditPlan;
  let editPlanSource = 'codex';
  try {
    const editResult = await runJsonGeneration(
      buildEditPlanPrompt(beatsResult.parsed.beats, heatmap, targetSec, metadata),
      MIDFORM_COMPRESSION_EDIT_PLAN_SCHEMA_PATH,
      (parsed) => validateEditPlanAgainstBeats(validateEditPlan(parsed, targetSec), beatsResult.parsed.beats)
    );
    finalizedEditPlan = finalizeEditPlan(editResult.parsed, beatsResult.parsed.beats, transcript, targetSec);
    validateEditPlanAgainstBeats(validateEditPlan(finalizedEditPlan), beatsResult.parsed.beats);
  } catch (_error) {
    finalizedEditPlan = buildFallbackEditPlan(beatsResult.parsed.beats, heatmap, targetSec, metadata, transcript);
    editPlanSource = 'local_fallback';
    finalizedEditPlan.cold_open_selection.reason = `${finalizedEditPlan.cold_open_selection.reason} edit-plan generation failed, so the local fallback planner was used.`;
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
    paths: { runDir, metadataPath, transcriptPath, vttPath, heatmapPath, beatsPath, editPlanPath, markdownPath },
    heatmapStatus: heatmap.status,
    coldOpenSelection: finalizedEditPlan.cold_open_selection || null,
    editPlanSource,
    llmProvider: compressLlmProvider()
  };
  writeJson(manifestPath, manifest);
  writeJson(statePath, { ...manifest, status: 'phase1_review_ready', manifestPath });
  return { ...manifest, manifestPath, status: 'phase1_review_ready' };
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
  const finalizedEditPlan = finalizeEditPlan(editPlan, beatsObject.beats || [], transcript, targetSec);
  const sourceInfoPath = path.join(runDir, 'source_info.json');
  const applyManifestPath = path.join(runDir, 'compression_manifest.json');
  const movieTitle = (fs.existsSync(sourceInfoPath) ? (readJson(sourceInfoPath) || {}).title : '')
    || (fs.existsSync(applyManifestPath) ? (readJson(applyManifestPath) || {}).title : '') || '';
  const recapContext = resolveRecapContext(runDir, applyOptions.contextFile);
  const slotFillsPrompt = buildSlotFillsPrompt(beatsObject.beats || [], finalizedEditPlan, movieTitle, recapContext.contextMarkdown);
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
  const normalizedSlotFills = normalizeSlotFillsForStyle(result.parsed, finalizedEditPlan);
  writeJson(slotFillsPath, normalizedSlotFills);
  const uploadTextPath = path.join(runDir, 'upload_text.md');
  writeText(uploadTextPath, `${buildUploadTextMarkdown(normalizedSlotFills.upload_text)}\n`);

  // The Japanese cut gets its own script over the same edit plan, so the ja locale is a
  // real localization instead of the Korean audio with different cuts.
  let japaneseSlotFillsPath = '';
  if (applyOptions.generateJapanese !== false) {
    const japaneseResult = await runJsonGeneration(
      buildJapaneseSlotFillsPrompt(beatsObject.beats || [], finalizedEditPlan, movieTitle, recapContext.contextMarkdown),
      MIDFORM_SLOT_FILLS_SCHEMA_PATH,
      (parsed) => validateJapaneseSlotFills(
        validateSlotFillsDialogueCaptions(parsed, finalizedEditPlan, 'ja'),
        finalizedEditPlan
      )
    );
    japaneseSlotFillsPath = path.join(runDir, 'compression_slot_fills.ja.json');
    writeJson(japaneseSlotFillsPath, japaneseResult.parsed);
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
  const transcript = readJson(transcriptPath);
  const metadata = fs.existsSync(metadataPath) ? readJson(metadataPath) : {};
  const heatmap = fs.existsSync(heatmapPath) ? readJson(heatmapPath) : { status: 'unavailable', items: [] };
  const targetSec = Number(currentPlan?.duration_budget?.target_sec || DEFAULT_TARGET_SEC) || DEFAULT_TARGET_SEC;
  let refreshedPlan = finalizeEditPlan(currentPlan, beatsObject.beats || [], transcript, targetSec);
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
  buildSlotFillsPrompt,
  resolveRecapContext,
  runCompression,
  runCompressionApply,
  refreshCompressionPlan,
  downloadCompressionSourceVideo,
  resolveCompressionRunDir,
  extractTimedTranscript,
  parseVtt,
  extractHeatmap,
  _test: {
    clampColdOpenToTeaser,
    trimTimelineToTargetRuntime,
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
    buildDialogueUnitMetadata,
    buildTeaserSuitabilityScore
  }
};
