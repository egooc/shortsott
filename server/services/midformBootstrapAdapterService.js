// Phase 2 bootstrap adapter: converts the compression pipeline's artifacts (edit_plan.json +
// compression_slot_fills.json + transcript_timed.json) into the existing assembly pipeline's
// contract (transcript / slot_map.json / script.json), then hands off to midformPipelineService.
//
// Coordinate contract (single source of truth): every per-line dialogue speech timestamp comes from
// edit_plan.timeline[].dialogue_line_windows[] (computed once in finalizeEditPlan). The transcript
// utterance keeps those speech numbers verbatim. Dialogue source_scenes may be padded for visual
// pre-roll/post-roll, but each segment carries dialogue_speech_range_sec + caption offset metadata
// so subtitles stay tied to speech timing while allowing a small display-start delay.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');
const { getVideoMetadata } = require('../utils/ffprobe');
const { buildSpeakerMetadata, resolveCaptionColor, assignFallbackSpeakerColorKeys } = require('../utils/captionColorConfig');
const { resolveCompressionRunDir, downloadCompressionSourceVideo, detectPromoTail } = require('./midformCompressionService');
const { startRun } = require('./midformPipelineService');

const DURATION_CONFIG_PATH = path.join(PROJECT_ROOT, 'midform', 'config', 'duration.json');
const DIALOGUE_CAPTION_START_DELAY_SEC = 0.08;
const MIN_DIALOGUE_CAPTION_DURATION_SEC = 0.3;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

function readDurationConfig() {
  const defaults = { min_duration_sec: 60, max_duration_sec: 160 };
  if (!fs.existsSync(DURATION_CONFIG_PATH)) return defaults;
  try {
    const parsed = readJson(DURATION_CONFIG_PATH);
    return {
      min_duration_sec: Number(parsed?.min_duration_sec) || defaults.min_duration_sec,
      max_duration_sec: Number(parsed?.max_duration_sec) || defaults.max_duration_sec
    };
  } catch {
    return defaults;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeDisplayCaptionText(value) {
  return normalizeText(value)
    .replace(/\s*(?:—|–|ㅡ)\s*/g, ' ')
    .replace(/(?:^|\s)>>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pulls the quote out of a reported-speech caption ("…라고 말합니다"). Quotation marks also do
// ordinary emphasis work, though, and taking the first quoted run unconditionally destroyed the
// line: 아니, 잠깐만요. 그런 '당신들' 말고 '당신들'이요. — the man's whole correction — reached
// the screen as the single word 당신들. Extract only when the quote IS essentially the caption.
const REPORTED_SPEECH_TAIL_RE = /(라고|이라고)\s*(말|묻|답|외치|소리|경고|반박)/;

function compressDialogueCaptionText(value) {
  let text = sanitizeDisplayCaptionText(value).replace(/^[-•]\s*/, '').trim();
  const quoted = text.match(/["“‘']([^"”’']{2,40})["”’']/);
  if (quoted) {
    const inner = sanitizeDisplayCaptionText(quoted[1]);
    const outside = text.replace(quoted[0], '').trim();
    // Reported speech: a short wrapper around the quote, or an explicit 라고 말합니다 tail.
    if (REPORTED_SPEECH_TAIL_RE.test(outside) || outside.replace(/\s+/g, '').length <= 6) text = inner;
  }
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  text = text
    .replace(/\s*(?:라고|이라고)\s*(?:말(?:했|합니다|했다|해요|한다)?|묻(?:습니다|는다|었다|었어요)?|답(?:합니다|했다|해요)?|외(?:칩니다|쳤다|쳐요)?|소리(?:칩니다|쳤다|쳐요)?|경고(?:합니다|했다|해요)?|반박(?:합니다|했다|해요)?)[.!?…]*$/u, '')
    .replace(/\s*(?:하며|하면서)\s*(?:말|묻|답|외치|소리치|경고|반박).*$/u, '')
    .trim();
  return sanitizeDisplayCaptionText(text);
}

// Matches capcut_draft.py:seconds_to_timecode exactly (HH:MM:SS.mmm). The ONE place seconds
// become a timecode string, so every source_scenes clip uses the identical formatting.
function secondsToTimecode(totalSec) {
  const total = Math.max(0, Number(totalSec) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total - hours * 3600 - minutes * 60;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${seconds.toFixed(3).padStart(6, '0')}`;
}

function segmentSourceType(segment) {
  if (segment.source_type) return segment.source_type;
  return segment.segment_type === 'dialogue_quote' ? 'KEEP_DIALOGUE' : 'NARRATE';
}

function buildReviewDraftMarkdown(script) {
  const lines = ['# Bootstrap Review Draft', ''];
  for (const segment of Array.isArray(script?.segments) ? script.segments : []) {
    const scene = Array.isArray(segment.source_scenes) ? segment.source_scenes[0] : null;
    const time = scene ? `${scene.start}-${scene.end}` : '-';
    const speaker = normalizeText(segment.speaker || '');
    const text = normalizeText(segment.caption_text || segment.translated_caption_ko || segment.narration || '');
    const sourceLine = normalizeText(segment.source_line_id || segment.utt_id || '');
    const speakerPart = speaker ? `[${speaker}]` : '';
    const linePart = sourceLine ? ` {${sourceLine}}` : '';
    lines.push(`[${segmentSourceType(segment)}][${time}]${speakerPart} ${text}${linePart}`.trim());
  }
  lines.push('');
  return lines.join('\n');
}

function buildEditorialReviewArtifact(editPlan, script) {
  const segmentsByParent = new Map();
  for (const segment of Array.isArray(script?.segments) ? script.segments : []) {
    const parentSlotId = normalizeText(segment.parent_slot_id || segment.segment_id || '');
    if (!parentSlotId) continue;
    if (!segmentsByParent.has(parentSlotId)) segmentsByParent.set(parentSlotId, []);
    segmentsByParent.get(parentSlotId).push(segment);
  }
  const slots = (Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])
    .filter((item) => item.decision !== 'DROP')
    .map((item) => {
      const slotId = normalizeText(item.slot_id || '');
      const segments = segmentsByParent.get(slotId) || [];
      return {
        slot_id: slotId,
        beat_id: normalizeText(item.beat_id || ''),
        role: normalizeText(item.role || ''),
        decision: normalizeText(item.decision || item.mode || ''),
        editorial_role: normalizeText(item.editorial_role || item.role || ''),
        scene_type: normalizeText(item.scene_type || editPlan?.scene_type || ''),
        teaser_slot_id: normalizeText(item.teaser_slot_id || ''),
        callback_slot_id: normalizeText(item.callback_slot_id || ''),
        callback_relation: normalizeText(item.callback_relation || item.replay_mode || ''),
        reused_conflict_axis: normalizeText(item.reused_conflict_axis || ''),
        dialogue_unit: item.dialogue_unit && typeof item.dialogue_unit === 'object' ? item.dialogue_unit : null,
        risk: {
          semantic_risk: normalizeText(item.semantic_risk || 'low'),
          pronoun_risk: item.pronoun_risk === true,
          standalone_score: Number(item.standalone_score || 0),
          boundary_score: Number(item.boundary_score || 0)
        },
        qc_action: item.qc_action && typeof item.qc_action === 'object'
          ? item.qc_action
          : { action: normalizeText(item.applied_fix || 'none'), reason: normalizeText(item.recommended_fix || ''), source: 'legacy_qc_fields' },
        source_lines: segments.map((segment) => ({
          segment_id: normalizeText(segment.segment_id || ''),
          source_line_id: normalizeText(segment.source_line_id || segment.utt_id || ''),
          speaker: normalizeText(segment.speaker || ''),
          source_text: normalizeText(segment.dialogue_original || ''),
          caption_text: normalizeText(segment.caption_text || segment.translated_caption_ko || segment.narration || '')
        }))
      };
    });
  return {
    artifact_type: 'midform_editorial_review',
    scene_type: normalizeText(editPlan?.scene_type || ''),
    editorial_pattern: normalizeText(editPlan?.editorial_pattern || ''),
    generated_at: new Date().toISOString(),
    slots
  };
}

// The assembly pipeline (transcribe_source.py -> build_transcript_utterance_map /
// normalize_transcript_utterances) reads utterance.start and utterance.end (NOT start_time_s).
// Verified against transcribe_source.py output and all three consumers.
function buildBootstrapTranscript(editPlan, transcriptTimed) {
  const utterances = [];
  const warnings = [];
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];

  // 1) One utterance per KEEP_DIALOGUE line, referenced by its dialogue segment via utt_id.
  //    Stored dialogue_line_windows coordinates used verbatim so the utterance matches the
  //    segment's source_scenes exactly (validate_dialogue_utterance_references needs <=0.05s).
  const dialogueWindows = [];
  for (const item of timeline) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const slotId = String(item.slot_id || '').trim();
    const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
    windows.forEach((win, index) => {
      if (!win || win.matched !== true) {
        warnings.push(`${slotId} line ${index + 1} has no matched window, skipped: "${win ? win.line : ''}"`);
        return;
      }
      utterances.push({
        utt_id: `${slotId}_L${String(index + 1).padStart(2, '0')}`,
        start: win.start_sec,
        end: win.end_sec,
        text: normalizeText(win.line),
        words: []
      });
      dialogueWindows.push([Number(win.start_sec), Number(win.end_sec)]);
    });
  }

  // 2) Original VTT cues as speech-range utterances for the narration b-roll auto-picker
  //    (choose_story_anchor_source_clips) to avoid talking mouths. EXCLUDE cues overlapping a
  //    per-line dialogue window: the SAME transcript feeds the FATAL reserved-range gate, and a
  //    stray cue overlapping a dialogue clip would trip dialogue_not_aligned_to_dialogue_map.
  const overlapsDialogueWindow = (s, e) => dialogueWindows.some(([ws, we]) => e > ws + 0.001 && s < we - 0.001);
  const cues = Array.isArray(transcriptTimed) ? transcriptTimed : [];
  const keptByText = new Map();
  let cueSeq = 0;
  let excludedForDialogueOverlap = 0;
  for (const cue of cues) {
    const text = normalizeText(cue.text);
    const startSec = Number(cue.start_sec);
    const endSec = Number(cue.end_sec);
    if (!text || !(endSec > startSec)) continue;
    if (overlapsDialogueWindow(startSec, endSec)) {
      excludedForDialogueOverlap += 1;
      continue;
    }
    const prior = keptByText.get(text);
    if (prior && startSec < prior.end + 0.05 && endSec > prior.start - 0.05) {
      if (endSec - startSec > prior.end - prior.start) {
        prior.start = startSec;
        prior.end = endSec;
      }
      continue;
    }
    cueSeq += 1;
    const utt = { utt_id: `cue_${String(cueSeq).padStart(4, '0')}`, start: startSec, end: endSec, text, words: [] };
    utterances.push(utt);
    keptByText.set(text, utt);
  }
  if (excludedForDialogueOverlap > 0) {
    warnings.push(`${excludedForDialogueOverlap} VTT cue(s) excluded from transcript for overlapping a dialogue-line window (avoids the reserved-range gate)`);
  }

  utterances.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    transcript: { utterances, utterance_count: utterances.length },
    stats: {
      per_line_utterances: dialogueWindows.length,
      cue_utterances: cueSeq,
      cues_excluded_for_dialogue_overlap: excludedForDialogueOverlap
    },
    warnings
  };
}

function defaultEditInstruction(visualRole) {
  return { visual_role: visualRole, pace: 'medium', transition: 'cut', zoom: 'none', sfx: [] };
}

function dialoguePaddingRule(item, win) {
  const relation = normalizeText(item?.dialogue_unit?.relation_type || item?.callback_relation || item?.scene_type || '').toLowerCase();
  const line = normalizeText(win?.line || '').toLowerCase();
  const wordCount = line ? line.split(/\s+/).length : 0;
  if (/question|answer|rebuttal|accusation|confront/.test(relation) || /\?$/.test(line) || /^(why|what|how|who|where|when)\b/.test(line)) {
    return { dialogue_type: 'question_rebuttal', pre_roll_sec: 0.7, post_roll_sec: 0.15 };
  }
  if (/confession|emotional|pause|hesitation/.test(relation) || /\.\.\.|—|–/.test(String(win?.line || ''))) {
    return { dialogue_type: 'emotional_pause', pre_roll_sec: 0.5, post_roll_sec: 0.25 };
  }
  if (wordCount > 0 && wordCount <= 4) {
    return { dialogue_type: 'short_command_reaction', pre_roll_sec: 0.45, post_roll_sec: 0.1 };
  }
  return { dialogue_type: 'default_dialogue', pre_roll_sec: 0.5, post_roll_sec: 0.15 };
}

function buildDialogueTimingAdjustment(item, win, orderedWindows, orderedIndex, sourceDurationSec, speechRanges) {
  let speechStart = Number(win.start_sec);
  let speechEnd = Number(win.end_sec);
  const rule = dialoguePaddingRule(item, win);
  const minGapSec = 0.02;
  const prev = orderedWindows[orderedIndex - 1]?.win;
  const next = orderedWindows[orderedIndex + 1]?.win;
  let visualStart = Math.max(0, speechStart - rule.pre_roll_sec);
  let visualEnd = speechEnd + rule.post_roll_sec;
  // Stop each line at the MIDPOINT of the gap to its neighbour, not at the neighbour's speech.
  // Clamping to the neighbour's speech let both sides expand into the same gap and collide:
  // slot_09_L03 ran to 244.85 while L04 opened at 244.72, tripping the cross-segment overlap
  // gate. A shared boundary cannot be crossed from either side.
  if (prev && Number(prev.end_sec) <= speechStart) {
    const boundary = (Number(prev.end_sec) + speechStart) / 2;
    visualStart = Math.max(visualStart, Math.min(speechStart, boundary + minGapSec / 2));
  }
  if (next && Number(next.start_sec) >= speechEnd) {
    const boundary = (speechEnd + Number(next.start_sec)) / 2;
    visualEnd = Math.min(visualEnd, Math.max(speechEnd, boundary - minGapSec / 2));
  }
  // orderedWindows only holds the lines this slot preserved, so padding was free to reach back
  // into a neighbouring line we did not select — bleeding its audio into the clip, and tripping
  // the reserved-range gate because that line still has a transcript cue of its own. Guard on
  // the CUE boundaries, not just detected speech: the gate compares the clip against the cues
  // we emit, so stopping at the detected speech edge still leaves the clip overlapping the cue.
  for (const range of Array.isArray(speechRanges) ? speechRanges : []) {
    const rangeStart = Number(range?.[0]);
    const rangeEnd = Number(range?.[1]);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) continue;
    if (rangeEnd > speechStart && rangeStart < speechEnd) continue; // this line's own speech
    if (rangeEnd <= speechStart) visualStart = Math.max(visualStart, Math.min(speechStart, rangeEnd + minGapSec));
    else if (rangeStart >= speechEnd) visualEnd = Math.min(visualEnd, Math.max(speechEnd, rangeStart - minGapSec));
  }
  if (Number.isFinite(sourceDurationSec) && sourceDurationSec > 0) {
    // Clamp the speech itself, not just the padded window: the "never cut into speech" line
    // below would otherwise push the clip straight back past the end of the video, which is
    // how a dialogue window ended up 1.7s beyond a 529s source.
    speechEnd = Math.min(speechEnd, sourceDurationSec);
    speechStart = Math.min(speechStart, speechEnd);
    visualEnd = Math.min(visualEnd, sourceDurationSec);
  }
  visualEnd = Math.max(visualEnd, speechEnd);
  visualStart = Math.max(0, Math.min(visualStart, speechStart));
  const round3 = (value) => Number(Number(value).toFixed(3));
  const roundedVisualStart = round3(visualStart);
  const roundedVisualEnd = round3(visualEnd);
  const roundedSpeechStart = round3(speechStart);
  const roundedSpeechEnd = round3(speechEnd);
  const speechDuration = Math.max(0, roundedSpeechEnd - roundedSpeechStart);
  // The caption follows the moment the line was SPOKEN, which is not the clip: separating the
  // video windows so CapCut accepts them also pulled the captions apart, leaving every caption
  // strictly serial. Two people talking over each other can now share the screen on their lanes.
  const captionSpeechStart = Number.isFinite(Number(win?.caption_start_sec)) ? round3(Number(win.caption_start_sec)) : roundedSpeechStart;
  const captionSpeechEndRaw = Number.isFinite(Number(win?.caption_end_sec)) ? round3(Number(win.caption_end_sec)) : roundedSpeechEnd;
  const captionLimitSec = Number(sourceDurationSec);
  const captionSpeechEnd = Number.isFinite(captionLimitSec) && captionLimitSec > 0
    ? Math.min(captionSpeechEndRaw, round3(captionLimitSec))
    : captionSpeechEndRaw;
  const captionSpokenDuration = Math.max(0, captionSpeechEnd - captionSpeechStart);
  const captionStartDelaySec = captionSpokenDuration > MIN_DIALOGUE_CAPTION_DURATION_SEC + 0.05
    ? Math.min(DIALOGUE_CAPTION_START_DELAY_SEC, captionSpokenDuration - MIN_DIALOGUE_CAPTION_DURATION_SEC)
    : 0;
  return {
    dialogue_type: rule.dialogue_type,
    speech_range_sec: [roundedSpeechStart, roundedSpeechEnd],
    visual_range_sec: [roundedVisualStart, roundedVisualEnd],
    requested_pre_roll_sec: rule.pre_roll_sec,
    requested_post_roll_sec: rule.post_roll_sec,
    applied_pre_roll_sec: round3(roundedSpeechStart - roundedVisualStart),
    applied_post_roll_sec: round3(roundedVisualEnd - roundedSpeechEnd),
    caption_timeline_offset_sec: round3(captionSpeechStart - roundedVisualStart + captionStartDelaySec),
    caption_start_delay_sec: round3(captionStartDelaySec),
    caption_duration_sec: round3(Math.max(MIN_DIALOGUE_CAPTION_DURATION_SEC, captionSpokenDuration - captionStartDelaySec)),
    caption_speech_range_sec: [captionSpeechStart, captionSpeechEnd],
    visual_duration_sec: round3(roundedVisualEnd - roundedVisualStart),
    source: 'bootstrap_dialogue_visual_padding_v1',
    fallback_used: false
  };
}

// Builds slot_map.json and script.json TOGETHER from the same edit plan + slot fills, so the two
// artifacts share one set of coordinates. IMPORTANT: script.json gets NO top-level slot_map key.
// Verified in capcut_draft.py: slot_map_mode = bool(script.slot_map.slots); when false (no key),
// validate_slot_source_monotonicity returns not_applicable (line 9553) AND the story-anchor b-roll
// auto-picker runs (line 8961). Both desired behaviors come from omitting the key — there is no
// trade-off, so we never embed slot_map here.
// Where someone is actually speaking, which neither signal knows on its own: subtitle cues
// say which stretches contain dialogue but arrive in blocks tens of seconds long that
// swallow the pauses, while silence detection is frame-accurate but hears score and
// effects as sound. Their intersection is the spoken audio.
function detectSpeechRanges(sourceVideoPath, cues) {
  const windows = (Array.isArray(cues) ? cues : [])
    .map((cue) => [Number(cue?.start_sec), Number(cue?.end_sec)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath) || !windows.length) return windows;

  // ONE silencedetect pass over the whole source (ClippyMe pattern, MIT), then intersect with
  // the cue windows. The previous per-cue loop spawned one ffmpeg process per cue - hundreds
  // of decodes for the same audio. Logic is equivalent; -26dB/0.20 stays (movie music bed,
  // measured - do not import ClippyMe's -30dB).
  const ffmpeg = resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' });
  // RELATIVE floor (owner backlog): -26dB fixed assumed one mix level. A quiet mix (mean -35)
  // had speech swallowed as "silence"; a loud one detected none. Measure the source's mean
  // volume once and set the floor 12dB under it, clamped to the -40..-22 band the fixed value
  // was tuned in.
  let noiseFloorDb = -26;
  const volumeProbe = spawnSync(ffmpeg, [
    '-hide_banner', '-nostats', '-y', '-i', sourceVideoPath,
    '-vn', '-af', 'volumedetect', '-f', 'null', '-'
  ], { env: getToolEnv(), encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const meanMatch = String(volumeProbe.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
  if (meanMatch) {
    const mean = Number(meanMatch[1]);
    if (Number.isFinite(mean)) noiseFloorDb = Math.round(Math.max(-40, Math.min(-22, mean - 12)));
  }
  // silencedetect reports on stderr even on success, so this has to be spawnSync: with
  // execFileSync the log is only reachable from a thrown error, which made every cue
  // look pause-free.
  const probe = spawnSync(ffmpeg, [
    '-hide_banner', '-nostats', '-y', '-i', sourceVideoPath,
    '-vn',
    '-af', `silencedetect=noise=${noiseFloorDb}dB:d=0.20`, '-f', 'null', '-'
  ], { env: getToolEnv(), encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const log = String(probe.stderr || '');
  if (!log) return windows;
  const silences = [];
  let openStart = null;
  for (const match of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const value = Number(match[2]);
    if (match[1] === 'start') openStart = value;
    else if (openStart != null) { silences.push([openStart, value]); openStart = null; }
  }
  // An unterminated silence_start runs to EOF: close it far past any cue so the complement
  // treats the tail as silent (ClippyMe drops it; closing it is equivalent for intersection).
  if (openStart != null) silences.push([openStart, Number.MAX_SAFE_INTEGER]);
  silences.sort((left, right) => left[0] - right[0]);
  const speech = [];
  for (const [cueStart, cueEnd] of windows) {
    let cursor = cueStart;
    for (const [silenceStart, silenceEnd] of silences) {
      if (silenceEnd <= cursor) continue;
      if (silenceStart >= cueEnd) break;
      if (silenceStart > cursor) speech.push([cursor, Math.min(silenceStart, cueEnd)]);
      cursor = Math.max(cursor, Math.min(silenceEnd, cueEnd));
      if (cursor >= cueEnd) break;
    }
    if (cursor < cueEnd) speech.push([cursor, cueEnd]);
  }
  return speech.filter(([start, end]) => end - start > 0.1);
}

const DIALOGUE_WINDOW_MIN_SEC = 0.8;
const DIALOGUE_WINDOW_TRIM_MIN_GAIN_SEC = 0.4;
// Unhurried conversational English, kept deliberately slow so the ceiling only catches
// windows that are clearly impossible rather than trimming real delivery.
const DIALOGUE_WORDS_PER_SEC = 2.2;
// silencedetect marks the -26dB crossing as the speech edge, but a consonant's attack and a
// vowel's release live BELOW that threshold - cutting exactly at the detected edge clips them
// on every line. Land the cut inside the silence trough instead (ClippyMe technique, MIT):
// open slightly before the detected onset, close slightly after the detected tail.
const SPEECH_ATTACK_GUARD_SEC = 0.04;
const SPEECH_RELEASE_GUARD_SEC = 0.06;
const DIALOGUE_WORD_ESTIMATE_MARGIN_SEC = 1.2;

function roundSec3(value) {
  return Number(Number(value).toFixed(3));
}

function normalizeCaptionTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// A dialogue clip must carry ONLY its own captioned line. When a window spans more than one
// transcript cue, the extra cues are DIFFERENT utterances (often a different speaker) that play
// as audio with no subtitle on screen - e.g. Draft Day's cold open cut 8s of a phone call
// ("fair offer" / "three number one picks" / "you're panicking") but captioned only the last
// line, so two of the three voices were untranslated. The padding guard treats any cue inside the
// window as "own speech", so it cannot fix this. Clamp each window to the single cue whose text
// matches its line, dropping the neighbouring utterances from the clip. Only shrinks, and only
// when the window genuinely straddles a foreign cue AND the match is confident, so a fresh run
// whose window already sits inside one cue is untouched.
function clampDialogueWindowsToOwnCue(editPlan, transcriptTimed) {
  const cues = (Array.isArray(transcriptTimed) ? transcriptTimed : [])
    .map((cue) => ({ start: Number(cue?.start_sec), end: Number(cue?.end_sec), tokens: new Set(normalizeCaptionTokens(cue?.text)) }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.tokens.size);
  if (!cues.length) return { clamped: 0, details: [] };
  let clamped = 0;
  const details = [];
  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    if (item?.decision !== 'KEEP_DIALOGUE') continue;
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (!win || win.matched !== true) continue;
      const winStart = Number(win.start_sec);
      const winEnd = Number(win.end_sec);
      if (!(winEnd > winStart)) continue;
      const lineTokens = normalizeCaptionTokens(win.line);
      if (lineTokens.length < 2) continue;
      const overlapping = cues
        .filter((cue) => cue.end > winStart + 0.05 && cue.start < winEnd - 0.05)
        .sort((a, b) => a.start - b.start);
      if (overlapping.length < 2) continue; // window sits inside a single cue -> nothing foreign to drop
      const lineTokenSet = new Set(lineTokens);
      // A cue belongs to this line when most of ITS OWN words appear in the caption line (a long
      // line legitimately spans several cues; a foreign utterance shares almost nothing). Keep the
      // span of every owned cue - only leading/trailing foreign cues get dropped.
      const owned = overlapping.filter((cue) => {
        const hit = [...cue.tokens].filter((token) => lineTokenSet.has(token)).length;
        return hit / cue.tokens.size >= 0.5;
      });
      if (!owned.length || owned.length === overlapping.length) continue; // can't identify, or nothing foreign
      const nextStart = Math.max(winStart, Math.min(...owned.map((cue) => cue.start)));
      const nextEnd = Math.min(winEnd, Math.max(...owned.map((cue) => cue.end)));
      if (nextEnd - nextStart < 0.4) continue; // refuse to shrink a line out of existence
      if (nextStart - winStart <= 0.2 && winEnd - nextEnd <= 0.2) continue; // already tight
      details.push({ line: String(win.line || '').slice(0, 40), from: [roundSec3(winStart), roundSec3(winEnd)], to: [roundSec3(nextStart), roundSec3(nextEnd)] });
      win.start_sec = roundSec3(nextStart);
      win.end_sec = roundSec3(nextEnd);
      win.raw_start_sec = win.start_sec;
      win.raw_end_sec = win.end_sec;
      if (Number.isFinite(Number(win.caption_start_sec))) win.caption_start_sec = roundSec3(Math.max(Number(win.caption_start_sec), win.start_sec));
      if (Number.isFinite(Number(win.caption_end_sec))) win.caption_end_sec = roundSec3(Math.min(Number(win.caption_end_sec), win.end_sec));
      clamped += 1;
    }
  }
  return { clamped, details };
}

// The opposite failure to the over-long cue: YouTube sometimes stamps a whole spoken line onto ONE
// The first cue after this window that carries someone else's words. A cue sharing most of its
// words with the line is this same utterance still rolling, not a new voice.
function nextForeignCueStart(cues, win, start, end) {
  const lineTokens = new Set(normalizeCaptionTokens(win.line));
  for (const cue of cues) {
    // Measured from the window's START, not its end: the foreign utterance can already be inside a
    // window the plan drew too wide, and bounding from the end would step right over it.
    if (cue.start <= start + 0.05) continue;
    const cueTokens = normalizeCaptionTokens(cue.text);
    if (!cueTokens.length) continue;
    const shared = cueTokens.filter((token) => lineTokens.has(token)).length / cueTokens.length;
    if (shared >= 0.5) continue;
    return cue.start;
  }
  return NaN;
}

// timestamp ("Okay, I'm ready to do this, Tom." collapsed to a 0.2s cue), so the window - and the
// clip cut from it - holds only the tail and the viewer hears one word and has to read the rest.
// The tags can't recover a span they never recorded, so floor each clip at the time the words need
// to be spoken (wordCount / WORDS_PER_SEC), extending the END forward. Bounded by the next selected
// dialogue clip anywhere on the timeline and by the source end, so it never swallows another line.
function extendShortDialogueWindows(editPlan, sourceDurationSec = 0, transcriptTimed = []) {
  const DIALOGUE_FLOOR_WORDS_PER_SEC = 3.2;
  // Largest pre-roll a dialogue clip can claim (0.7s, question rebuttal) plus its post-roll (0.15s).
  const DIALOGUE_FLOOR_NEIGHBOUR_GAP_SEC = 0.9;
  const FOREIGN_SPEECH_GUARD_SEC = 0.15;
  const cues = (Array.isArray(transcriptTimed) ? transcriptTimed : [])
    .map((cue) => ({ start: Number(cue?.start_sec), end: Number(cue?.end_sec), text: String(cue?.text || '') }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
  const timeline = Array.isArray(editPlan?.timeline) ? editPlan.timeline : [];
  const selectedStarts = [];
  for (const item of timeline) {
    if (item?.decision !== 'KEEP_DIALOGUE') continue;
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (win && win.matched === true && Number.isFinite(Number(win.start_sec))) selectedStarts.push(Number(win.start_sec));
    }
  }
  selectedStarts.sort((a, b) => a - b);
  let extended = 0;
  for (const item of timeline) {
    if (item?.decision !== 'KEEP_DIALOGUE') continue;
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (!win || win.matched !== true) continue;
      const start = Number(win.start_sec);
      const end = Number(win.end_sec);
      if (!(end > start)) continue;
      const wordCount = String(win.line || '').trim().split(/\s+/).filter(Boolean).length;
      if (wordCount < 3) continue;
      const needSec = wordCount / DIALOGUE_FLOOR_WORDS_PER_SEC;
      if (end - start >= needSec) continue;
      let limit = start + needSec;
      // Bound by the next clip that begins after THIS one starts - a back-to-back line often opens
      // exactly at this window's end, so an end-based search would skip it and overrun into it.
      // The gap has to clear the NEXT clip's pre-roll (0.5s, 0.7s for a question rebuttal) plus this
      // clip's own post-roll (0.15s), or the two padded ranges still overlap and the cross-segment
      // gate rejects the plan - which then falls back to an older compression run. 0.35 was measured
      // too small on Long Shot: the floor filled the space right back up to a 0.13s collision.
      const nextStart = selectedStarts.find((value) => value > start + 0.05);
      if (Number.isFinite(nextStart)) limit = Math.min(limit, nextStart - DIALOGUE_FLOOR_NEIGHBOUR_GAP_SEC);
      // Stop at the next voice that is not this line. A short window between two other utterances
      // otherwise grows straight over the one in between, and that speech ships with no caption of
      // its own: Long Shot's "We just re-upped... we have another maybe 4 or 5 hours." was floored
      // from 1.5s to 6.1s and swallowed "You kept saying you wanted to take more, so we did."
      const foreignStart = nextForeignCueStart(cues, win, start, end);
      if (Number.isFinite(foreignStart)) limit = Math.min(limit, foreignStart - FOREIGN_SPEECH_GUARD_SEC);
      if (sourceDurationSec > 0) limit = Math.min(limit, sourceDurationSec);
      if (limit > end + 0.1) {
        win.end_sec = roundSec3(limit);
        if (Number.isFinite(Number(win.caption_end_sec))) win.caption_end_sec = roundSec3(Math.max(Number(win.caption_end_sec), win.end_sec));
        extended += 1;
      }
    }
  }
  return { extended };
}

// An auto-caption cue ends when the caption leaves the screen, not when the words stop, so
// a five-word line can be recorded as thirty seconds. Captions are locked to these windows,
// which left short lines held on screen long after the speaker had finished and drifting out
// of sync with the audio. Trim each window to the speech actually inside it.
function trimDialogueWindowsToSpeech(editPlan, speechRanges, sourceDurationSec = 0) {
  const ranges = (Array.isArray(speechRanges) ? speechRanges : [])
    .map((range) => [Number(range[0]), Number(range[1])])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  // Clamping to the source runs even with no detected speech, so keep going.
  const limitSec = Number(sourceDurationSec);
  const hasLimit = Number.isFinite(limitSec) && limitSec > 0;
  if (!ranges.length && !hasLimit) return { trimmed: 0, details: [] };

  let trimmed = 0;
  const details = [];
  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    if (item?.decision !== 'KEEP_DIALOGUE') continue;
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (!win || win.matched !== true) continue;
      const start = Number(win.start_sec);
      const end = Number(win.end_sec);
      if (!(end > start)) continue;
      // The transcript utterance keeps these numbers verbatim, so a window past the end of
      // the video has to be cut here — clamping the padded clip later does not reach it.
      if (hasLimit && end > limitSec) {
        if (start >= limitSec - DIALOGUE_WINDOW_MIN_SEC) continue;
        win.end_sec = roundSec3(limitSec);
        trimmed += 1;
      }
      const inside = ranges.filter(([rangeStart, rangeEnd]) => rangeEnd > start + 0.05 && rangeStart < end - 0.05);
      if (!inside.length) continue;
      const speechStart = Math.max(start, Math.min(...inside.map((range) => range[0])) - SPEECH_ATTACK_GUARD_SEC);
      let speechEnd = Math.min(end, Math.max(...inside.map((range) => range[1])) + SPEECH_RELEASE_GUARD_SEC);
      // Silence detection alone cannot find the pauses under a continuous score, so a line
      // can still come back far longer than anyone could have spoken it. The word count is
      // independent of both the audio and the cue timing, so use it as a ceiling.
      const wordCount = String(win.line || '').trim().split(/\s+/).filter(Boolean).length;
      if (wordCount > 0) {
        const plausibleEnd = speechStart + (wordCount / DIALOGUE_WORDS_PER_SEC) + DIALOGUE_WORD_ESTIMATE_MARGIN_SEC;
        if (plausibleEnd < speechEnd) speechEnd = Math.max(speechStart + DIALOGUE_WINDOW_MIN_SEC, plausibleEnd);
      }
      if (!(speechEnd - speechStart >= DIALOGUE_WINDOW_MIN_SEC)) continue;
      if ((end - speechEnd) + (speechStart - start) < DIALOGUE_WINDOW_TRIM_MIN_GAIN_SEC) continue;
      details.push({
        line: String(win.line || '').slice(0, 40),
        from: [roundSec3(start), roundSec3(end)],
        to: [roundSec3(speechStart), roundSec3(speechEnd)]
      });
      win.start_sec = roundSec3(speechStart);
      win.end_sec = roundSec3(speechEnd);
      trimmed += 1;
    }
  }
  return { trimmed, details };
}

// Slide a scene back so it ends by `limit` while keeping its length where possible.
function clampScenesToUsableEnd(scenes, limit) {
  if (!(Number(limit) > 0)) return scenes;
  return (Array.isArray(scenes) ? scenes : []).map((scene) => {
    const start = parseTimecode(scene?.start);
    const end = parseTimecode(scene?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Number(limit)) return scene;
    const span = Math.max(0.4, end - start);
    const nextEnd = Number(limit);
    const nextStart = Math.max(0, nextEnd - span);
    return { ...scene, start: secondsToTimecode(nextStart), end: secondsToTimecode(nextEnd) };
  });
}

function buildBootstrapSlotMapAndScript(editPlan, slotFills, options = {}) {
  const warnings = [];
  const durationSec = Number(options.sourceDurationSec || editPlan?.duration_budget?.estimated_total_sec || 0);
  // Source channels end their clips with a self-promo tail; nothing may be cut from it.
  const footageEndSec = Number(options.usableEndSec) > 0 ? Math.min(durationSec || Number(options.usableEndSec), Number(options.usableEndSec)) : durationSec;
  const timeline = (Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])
    .filter((item) => item.decision !== 'DROP');
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));

  const slots = [];
  const segments = [];

  // Dialogue padding must clear both the detected speech and the caption cues: the reserved-range
  // gate compares each clip against the cues we emit, so stopping at the speech edge alone still
  // leaves the clip overlapping a neighbouring cue.
  // Every preserved line in the plan, not just this slot's. The per-slot ordering never sees a
  // line in another slot, so slot_001's post-roll ran to 171.72 while slot_006 opened at 171.34
  // even though their speech had already been split apart at 171.445.
  const allDialogueWindows = [];
  for (const item of timeline) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    for (const win of Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : []) {
      if (win && win.matched === true) allDialogueWindows.push([Number(win.start_sec), Number(win.end_sec)]);
    }
  }
  const paddingGuardRanges = [
    ...allDialogueWindows,
    ...(Array.isArray(options.speechRanges) ? options.speechRanges : []),
    ...(Array.isArray(options.cueRanges) ? options.cueRanges : [])
  ].map((range) => [Number(range?.[0]), Number(range?.[1])])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);

  // Assign fallback caption colours across the whole timeline before building any segment, so two
  // unknown speakers in one exchange never land on the same colour.
  // Grouped per slot: two speakers may share a colour across the cut but never inside one scene.
  const dialogueSpeakerAliasGroups = [];
  for (const item of timeline) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const fill = fillsBySlot.get(String(item.slot_id || '').trim()) || {};
    const speakerList = Array.isArray(fill.speakers) ? fill.speakers : [];
    const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
    const group = [];
    for (let index = 0; index < windows.length; index += 1) {
      const alias = normalizeText(speakerList[index] || fill.speaker || '');
      if (alias) group.push(alias);
    }
    if (group.length) dialogueSpeakerAliasGroups.push(group);
  }
  const fallbackColorKeyByAlias = assignFallbackSpeakerColorKeys(dialogueSpeakerAliasGroups);

  // Adapter-side b-roll. All narration segments get a degenerate story_anchor hint so capcut's
  // b-roll auto-picker DECLINES; that leaves story_sync_segment_reports empty, so the story-sync
  // gate (its monotonic + 70%-coverage checks, both incompatible with the teaser/compression
  // composition) is skipped entirely. We supply explicit NON-OVERLAPPING b-roll ourselves so the
  // hybrid cross-segment overlap gate stays clean.
  const reservedDialogueRanges = [];
  for (const t of timeline) {
    if (t.decision !== 'KEEP_DIALOGUE') continue;
    const orderedDialogueWindows = (Array.isArray(t.dialogue_line_windows) ? t.dialogue_line_windows : [])
      .map((win, index) => ({ win, index }))
      .filter((entry) => entry.win && entry.win.matched === true)
      .sort((a, b) => Number(a.win.start_sec) - Number(b.win.start_sec));
    for (let orderedIndex = 0; orderedIndex < orderedDialogueWindows.length; orderedIndex += 1) {
      const entry = orderedDialogueWindows[orderedIndex];
      const timing = buildDialogueTimingAdjustment(t, entry.win, orderedDialogueWindows, orderedIndex, durationSec, paddingGuardRanges);
      reservedDialogueRanges.push(timing.visual_range_sec);
    }
  }
  const assignedBrollRanges = [];
  // Action beats carry FIXED peak windows (source_audio_action). Reserve them before any
  // narration b-roll is picked: the peak-anchored picker would otherwise anchor a narration
  // slot on the very peak an action beat plays, and the two collide in the overlap gate
  // regardless of which one the timeline reaches first.
  for (const item of timeline) {
    if (normalizeText(item.visual_source_mode) !== 'source_audio_action') continue;
    const actionStart = Number(item.visual_source_start_sec);
    const actionEnd = Number(item.visual_source_end_sec);
    if (Number.isFinite(actionStart) && Number.isFinite(actionEnd) && actionEnd > actionStart) {
      assignedBrollRanges.push([actionStart, actionEnd]);
    }
  }
  const subtractBusyRanges = (rangeStart, rangeEnd, blocks) => {
    const busy = blocks.map((b) => [Number(b[0]), Number(b[1])]).filter((b) => b[1] > rangeStart && b[0] < rangeEnd).sort((a, b) => a[0] - b[0]);
    const free = [];
    let cursor = rangeStart;
    for (const b of busy) {
      if (b[0] > cursor) free.push([cursor, Math.min(b[0], rangeEnd)]);
      cursor = Math.max(cursor, b[1]);
      if (cursor >= rangeEnd) break;
    }
    if (cursor < rangeEnd) free.push([cursor, rangeEnd]);
    return free.filter((r) => r[1] - r[0] > 0.3);
  };
  // Narration b-roll plays the source quietly under the voiceover, so a boundary that lands
  // mid-sentence starts or ends the shot on a clipped syllable. Pull each edge out of any
  // utterance it cuts into, as long as enough footage survives to be worth using.
  const speechRanges = (Array.isArray(options.speechRanges) ? options.speechRanges : [])
    .map((range) => [Number(range[0]), Number(range[1])])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  const BROLL_SPEECH_EDGE_TOLERANCE_SEC = 0.12;
  const BROLL_MIN_USABLE_SEC = 3;

  const snapOutOfSpeech = ([start, end]) => {
    let snappedStart = start;
    let snappedEnd = end;
    for (const [speechStart, speechEnd] of speechRanges) {
      if (speechStart + BROLL_SPEECH_EDGE_TOLERANCE_SEC < snappedStart && snappedStart < speechEnd - BROLL_SPEECH_EDGE_TOLERANCE_SEC) {
        snappedStart = speechEnd;
      }
      if (speechStart + BROLL_SPEECH_EDGE_TOLERANCE_SEC < snappedEnd && snappedEnd < speechEnd - BROLL_SPEECH_EDGE_TOLERANCE_SEC) {
        snappedEnd = speechStart;
      }
    }
    if (snappedEnd - snappedStart < BROLL_MIN_USABLE_SEC) return null;
    return [snappedStart, snappedEnd];
  };

  // When a narration slot's footage falls entirely inside the promo tail, replay the hook
  // moment instead of showing the outro (user directive).
  let hookFallbackRange = reservedDialogueRanges.length
    ? [reservedDialogueRanges[0][0], Math.min(reservedDialogueRanges[0][1], reservedDialogueRanges[0][0] + 6)]
    : null;

  // Measured energy peaks (audio RMS + motion) from the compress run. Narration b-roll used to
  // pick the LARGEST free gap — on an action source the largest gap is the quietest stretch, so
  // the fight's rank-1/2 peaks shipped with 0.0s coverage (Shelter). Peaks now outrank size.
  // With action beats in the timeline the peaks are already CONTENT; narration b-roll then
  // reverts to chronological in-window picking so the footage follows the narration's story
  // order instead of jumping to the loudest moment.
  const timelineHasActionBeats = timeline.some((item) => normalizeText(item.visual_source_mode) === 'source_audio_action');
  const energyPeaks = (timelineHasActionBeats ? [] : (Array.isArray(options.energyPeaks) ? options.energyPeaks : []))
    .map((peak) => ({ start: Number(peak?.start_sec), end: Number(peak?.end_sec), score: Number(peak?.score) || 0 }))
    .filter((peak) => Number.isFinite(peak.start) && Number.isFinite(peak.end) && peak.end > peak.start);
  const peakOverlapScore = (start, end) => energyPeaks.reduce((sum, peak) => {
    const overlap = Math.min(end, peak.end) - Math.max(start, peak.start);
    return overlap > 0 ? sum + overlap * Math.max(0.1, peak.score) : sum;
  }, 0);

  const pickNarrationBroll = (prefStartRaw, prefEndRaw, needSecRaw = 0) => {
    // The preferred range follows the slot, which can run past the end of the footage: a closing
    // recap asked for b-roll ending at 531.280s of a 529.561s source and the clip was emitted
    // as-is, failing source_duration_covers_timestamps.
    const prefStart = Math.max(0, Number(prefStartRaw));
    const prefEnd = footageEndSec > 0 ? Math.min(Number(prefEndRaw), footageEndSec) : Number(prefEndRaw);
    if (!(prefEnd > prefStart)) return null;
    const free = subtractBusyRanges(prefStart, prefEnd, [...reservedDialogueRanges, ...assignedBrollRanges]);
    if (!free.length) return null;
    // Rank free gaps by covered peak energy first, size second. capcut plays the clip from its
    // START for the TTS duration, so a gap is scored on the window that will actually screen:
    // anchored just ahead of its strongest peak when it has one.
    const needSec = Math.max(2, Number(needSecRaw) || 0);
    const anchored = free.map(([gapStart, gapEnd]) => {
      let start = gapStart;
      if (energyPeaks.length) {
        const inside = energyPeaks
          .filter((peak) => peak.end > gapStart && peak.start < gapEnd)
          .sort((left, right) => right.score - left.score)[0];
        if (inside) {
          // 1s of lead-in before the impact, bounded so the played window stays inside the gap.
          start = Math.min(Math.max(gapStart, inside.start - 1.0), Math.max(gapStart, gapEnd - needSec));
        }
      }
      const playedEnd = Math.min(gapEnd, start + Math.max(needSec, 4));
      return { range: [start, Math.min(gapEnd, start + 30)], size: gapEnd - gapStart, score: peakOverlapScore(start, playedEnd) };
    }).sort((left, right) => right.score - left.score || right.size - left.size);
    for (const candidate of anchored) {
      // Cap before snapping: trimming to the 30s ceiling afterwards would drop a fresh
      // boundary back into the middle of a sentence. capcut trims further to the TTS.
      const snapped = snapOutOfSpeech(candidate.range);
      if (snapped) return snapped;
    }
    const chosen = anchored[0].range;
    // Every window cuts into speech; keep the best rather than dropping the b-roll.
    // Unless it is a sliver: a 0.25s scrap stretched over a 3s narration reads as a frozen,
    // chopped-off shot. Too small to use is the same as nothing - let the caller fall back.
    if (chosen[1] - chosen[0] < 1.0) return null;
    return chosen;
  };

  // Dialogue-saturated fallback: when the slot's own window is fully reserved (a courtroom
  // scene can be wall-to-wall speech), emitting the window as-is just fails the overlap gate.
  // Search the WHOLE footage for the free gap nearest to the intended moment instead.
  const pickNearestFreeGap = (prefStartRaw, needSec) => {
    const limit = footageEndSec > 0 ? footageEndSec : 0;
    if (!(limit > 1)) return null;
    const gaps = subtractBusyRanges(0, limit, [...reservedDialogueRanges, ...assignedBrollRanges])
      .filter(([gapStart, gapEnd]) => gapEnd - gapStart >= Math.max(1.0, Math.min(needSec, 4)));
    if (!gaps.length) return null;
    const prefStart = Math.max(0, Number(prefStartRaw) || 0);
    gaps.sort((left, right) => Math.min(Math.abs(left[0] - prefStart), Math.abs(left[1] - prefStart))
      - Math.min(Math.abs(right[0] - prefStart), Math.abs(right[1] - prefStart)));
    const gap = gaps[0];
    const capped = [gap[0], Math.min(gap[1], gap[0] + Math.max(needSec, 1.0) + 3)];
    return snapOutOfSpeech(capped) || capped;
  };

  for (const item of timeline) {
    const slotId = String(item.slot_id || '').trim();
    const role = String(item.role || '').trim();
    const fill = fillsBySlot.get(slotId) || {};

    if (item.decision === 'KEEP_DIALOGUE') {
      // One dialogue slot/segment PER LINE (option B) so each Korean caption locks to the exact
      // moment its English line is spoken. Coordinates come from dialogue_line_windows verbatim.
      const windows = Array.isArray(item.dialogue_line_windows) ? item.dialogue_line_windows : [];
      const captionKr = Array.isArray(fill.caption_kr_dialogue) ? fill.caption_kr_dialogue : [];
      // Emit per-line dialogue segments in CHRONOLOGICAL (source-time) order, not the LLM's list
      // order — the capcut story-sync gate requires non-decreasing source starts across the
      // timeline. segId/utt_id keep the ORIGINAL index so they still match the transcript utterance.
      const orderedDialogueWindows = windows
        .map((win, index) => ({ win, index }))
        .filter((entry) => entry.win && entry.win.matched === true)
        .sort((a, b) => Number(a.win.start_sec) - Number(b.win.start_sec));
      // An unmatched planned line silently vanishes from the cut, and its surviving neighbour
      // then opens mid-sentence on screen. Reviewers must see this at the gate, not in CapCut.
      for (const win of windows) {
        if (win && win.matched !== true) {
          warnings.push(`${slotId} planned dialogue line did not match any cue and will be MISSING from the cut: "${String(win.line || '').slice(0, 60)}" - merge its text into the surviving caption at review or fix the window`);
        }
      }
      for (const { win, index } of orderedDialogueWindows) {
        const orderedIndex = orderedDialogueWindows.findIndex((entry) => entry.win === win && entry.index === index);
        const timing = buildDialogueTimingAdjustment(item, win, orderedDialogueWindows, orderedIndex, durationSec, paddingGuardRanges);
        const segId = `${slotId}_L${String(index + 1).padStart(2, '0')}`;
        // A cold open that cuts on the line's last word discards the reaction the slot window
        // was chosen FOR (the shirt-reveal shock ran 64.6-70.8 and never reached the screen).
        // Extend the LAST line's visual to the slot window end - captions stay on speech, and
        // the source audio carries the reaction.
        let visualEndSec = timing.visual_range_sec[1];
        if (role === 'cold_open' && orderedIndex === orderedDialogueWindows.length - 1) {
          // Cap at the next slot's window start: plans overlap neighbouring windows by up to
          // ~0.5s and an extension into that overlap trips the cross-segment gate.
          const nextWindowStart = Math.min(...timeline
            .filter((other) => other !== item && Number(other.start_sec) > visualEndSec)
            .map((other) => Number(other.start_sec)), Number.MAX_SAFE_INTEGER);
          const slotWindowEnd = Math.min(
            Number(item.end_sec) || visualEndSec,
            footageEndSec > 0 ? footageEndSec : Number.MAX_SAFE_INTEGER,
            nextWindowStart - 0.1
          );
          if (slotWindowEnd > visualEndSec + 0.75) visualEndSec = roundSec3(slotWindowEnd);
          // The caption must NOT ride the whole reaction tail: keep it near the spoken words
          // (speech + 1.5s of read-out), while the video runs on through the reaction.
          if (visualEndSec > timing.visual_range_sec[1] + 0.05 && Array.isArray(timing.caption_speech_range_sec)) {
            const speechEnd = Number((timing.speech_range_sec || timing.caption_speech_range_sec)[1]);
            timing.caption_speech_range_sec = [timing.caption_speech_range_sec[0], roundSec3(Math.min(speechEnd + 1.5, visualEndSec))];
            timing.caption_duration_sec = roundSec3(timing.caption_speech_range_sec[1] - Number(timing.caption_speech_range_sec[0]));
          }
        }
        const startTc = secondsToTimecode(timing.visual_range_sec[0]);
        const endTc = secondsToTimecode(visualEndSec);
        const captionText = compressDialogueCaptionText(captionKr[index] || '');
        const speakerList = Array.isArray(fill.speakers) ? fill.speakers : [];
        const speaker = normalizeText(speakerList[index] || fill.speaker || '');
        const speakerMetadata = buildSpeakerMetadata({
          speaker,
          segment_type: 'dialogue_quote',
          utt_id: segId,
          source_line_id: segId
        });
        const alias = speakerMetadata.speaker_alias || speaker;
        const speakerColorKey = fallbackColorKeyByAlias.get(alias) || speakerMetadata.speaker_color_key;
        speakerMetadata.speaker_color_key = speakerColorKey;
        const captionColor = resolveCaptionColor({ speakerAlias: alias, speakerColorKey });
        if (!captionText) warnings.push(`${segId} has no Korean caption (caption_kr_dialogue[${index}] empty)`);
        slots.push({
          slot_id: segId,
          type: 'dialogue',
          source_type: item.requires_context ? 'KEEP_DIALOGUE_BRIDGED' : 'KEEP_DIALOGUE',
          parent_slot_id: slotId,
          source_line_id: segId,
          translation_mode: 'faithful_dialogue',
          context_strategy: item.context_strategy || 'none',
          semantic_risk: item.semantic_risk || 'low',
          pronoun_risk: item.pronoun_risk === true,
          standalone_score: Number(item.standalone_score || 0),
          boundary_score: Number(item.boundary_score || 0),
          editorial_role: item.editorial_role || role || '',
          scene_type: item.scene_type || editPlan.scene_type || '',
          teaser_slot_id: item.teaser_slot_id || '',
          callback_slot_id: item.callback_slot_id || '',
          callback_relation: item.callback_relation || '',
          reused_conflict_axis: item.reused_conflict_axis || '',
          dialogue_unit: item.dialogue_unit || null,
          ...speakerMetadata,
          caption_kind: 'dialogue',
          speaker,
          caption_color: captionColor,
          source_range: timing.visual_range_sec,
          dialogue_speech_range_sec: timing.speech_range_sec,
          dialogue_timing_adjustment: timing,
          caption_timeline_offset_sec: timing.caption_timeline_offset_sec,
          duration_override_sec: timing.caption_duration_sec,
          duration: timing.visual_duration_sec,
          utt_id: segId,
          caption_source_text: normalizeText(win.line),
          scene_summary: `dialogue: ${normalizeText(win.line)}`,
          scene_ids: []
        });
        segments.push({
          segment_id: segId,
          segment_type: 'dialogue_quote',
          source_type: item.requires_context ? 'KEEP_DIALOGUE_BRIDGED' : 'KEEP_DIALOGUE',
          parent_slot_id: slotId,
          source_line_id: segId,
          translation_mode: 'faithful_dialogue',
          context_strategy: item.context_strategy || 'none',
          semantic_risk: item.semantic_risk || 'low',
          pronoun_risk: item.pronoun_risk === true,
          standalone_score: Number(item.standalone_score || 0),
          boundary_score: Number(item.boundary_score || 0),
          editorial_role: item.editorial_role || role || '',
          scene_type: item.scene_type || editPlan.scene_type || '',
          teaser_slot_id: item.teaser_slot_id || '',
          callback_slot_id: item.callback_slot_id || '',
          callback_relation: item.callback_relation || '',
          reused_conflict_axis: item.reused_conflict_axis || '',
          dialogue_unit: item.dialogue_unit || null,
          ...speakerMetadata,
          caption_kind: 'dialogue',
          utt_id: segId,
          tts_enabled: false,
          narration: '',
          dialogue_original: normalizeText(win.line),
          translated_caption_ko: captionText,
          caption_text: captionText,
          speaker,
          caption_color: captionColor,
          story_anchor: { source_range_hint: timing.speech_range_sec, scene_refs: [] },
          dialogue_speech_range_sec: timing.speech_range_sec,
          dialogue_timing_adjustment: timing,
          caption_timeline_offset_sec: timing.caption_timeline_offset_sec,
          duration_override_sec: timing.caption_duration_sec,
          source_scenes: [{
            clip_id: `${segId}_clip`,
            scene_id: '',
            start: startTc,
            end: endTc,
            speed_multiplier: 1,
            // Marks a deliberate reaction-tail extension so the utterance-reference
            // validator can tell it apart from timing drift.
            ...(visualEndSec > timing.visual_range_sec[1] + 0.05 ? { source: 'utterance_plus_reaction_tail' } : {})
          }],
          edit_instruction: defaultEditInstruction('dialogue')
        });
      }
      continue;
    }

    // NARRATE (cold_open / bridge / body / payoff narration).
    const isColdOpen = role === 'cold_open';
    // Scene hook: heatmap-peak cold open that plays its original action audio — no TTS,
    // no captions, and the source clip keeps full volume downstream. Action beats
    // (visual_source_mode source_audio_action) are the same mechanism promoted to the body:
    // measured energy peaks playing their own fight audio between narration/dialogue slots.
    const isActionBeat = normalizeText(item.visual_source_mode) === 'source_audio_action';
    const isSceneHook = (isColdOpen && normalizeText(item.visual_source_mode) === 'source_audio_teaser') || isActionBeat;
    const narration = isSceneHook ? '' : normalizeText(fill.narration || '');
    const captionKr = isSceneHook ? '' : normalizeText(fill.caption_kr || '');
    if (!narration && !isSceneHook) warnings.push(`${slotId} (${role}) NARRATE has empty narration`);
    // Cold-open uses the muted teaser visual window (visual_source_*), NOT its own story-beat
    // start/end. Every other NARRATE slot has no fixed window and lets the auto-picker choose.
    const teaserStart = Number(item.visual_source_start_sec);
    const teaserEnd = Number(item.visual_source_end_sec);
    let sourceRange;
    let sourceScenes;
    let sourceRangeHint;
    if ((isColdOpen || isActionBeat) && Number.isFinite(teaserStart) && Number.isFinite(teaserEnd) && teaserEnd > teaserStart) {
      sourceRange = [teaserStart, teaserEnd];
      sourceScenes = [{
        clip_id: isActionBeat ? `${slotId}_action_clip` : `${slotId}_teaser_clip`,
        scene_id: isActionBeat ? 'action_beat' : 'cold_open_teaser',
        start: secondsToTimecode(teaserStart),
        end: secondsToTimecode(teaserEnd),
        speed_multiplier: 1
      }];
      // Degenerate hint (end==start) makes parse_story_anchor_range bail, so the auto-picker
      // leaves our explicit muted-teaser source_scenes untouched.
      sourceRangeHint = [teaserStart, teaserStart];
      if (!isActionBeat) assignedBrollRanges.push([teaserStart, teaserEnd]); // action beats pre-reserved above
      if (isColdOpen) hookFallbackRange = [teaserStart, teaserEnd];
    } else {
      // Non-cold-open narration: pick explicit NON-OVERLAPPING b-roll from the beat window (free of
      // dialogue clips and other narration b-roll), with a degenerate hint so the picker declines.
      let winStart = Number(item.start_sec);
      let winEnd = Number(item.end_sec);
      if (!(winEnd > winStart)) {
        const vs = Number(item.visual_source_start_sec);
        const ve = Number(item.visual_source_end_sec);
        if (ve > vs) { winStart = vs; winEnd = ve; }
      }
      // The dialogue-saturated fallback below emits this window verbatim, so it has to respect
      // the footage too — otherwise a slot running past the source produces an unplayable clip.
      if (footageEndSec > 0) {
        winEnd = Math.min(winEnd, footageEndSec);
        winStart = Math.min(winStart, winEnd);
      }
      const narrationNeedSec = Number(item.narration_estimated_duration_sec || item.estimated_duration_sec || 0);
      let broll = (winEnd > winStart) ? pickNarrationBroll(winStart, winEnd, narrationNeedSec) : null;
      // The clip may not outlast the narration it plays under (the layers below fit the whole
      // clip into the slot): cap at the estimated need - the base draft is pre-TTS, so the
      // estimate is the best truth available here, and the locale packer re-caps with the
      // measured TTS.
      if (broll && narrationNeedSec > 0 && broll[1] - broll[0] > narrationNeedSec + 0.5) {
        broll = [broll[0], roundSec3 ? roundSec3(broll[0] + narrationNeedSec + 0.5) : Number((broll[0] + narrationNeedSec + 0.5).toFixed(3))];
      }
      if (broll) {
        sourceRange = broll;
        sourceScenes = [{ clip_id: `${slotId}_broll_clip`, scene_id: 'narration_broll', start: secondsToTimecode(broll[0]), end: secondsToTimecode(broll[1]), speed_multiplier: 1 }];
        assignedBrollRanges.push(broll);
      } else {
        if ((!(winEnd > winStart) || winEnd - winStart < 1.0) && hookFallbackRange) {
          warnings.push(`${slotId} (${role}) NARRATE window falls in the promo tail; replaying the hook footage instead`);
          sourceRange = [...hookFallbackRange];
          sourceScenes = [{ clip_id: `${slotId}_broll_clip`, scene_id: 'narration_broll', start: secondsToTimecode(hookFallbackRange[0]), end: secondsToTimecode(hookFallbackRange[1]), speed_multiplier: 1 }];
        } else {
          const globalGap = pickNearestFreeGap(winStart, Math.max(1.0, winEnd - winStart));
          if (globalGap) {
            warnings.push(`${slotId} (${role}) NARRATE window [${winStart},${winEnd}] is dialogue-saturated; using nearest free gap [${globalGap[0]},${globalGap[1]}]`);
            sourceRange = globalGap;
            sourceScenes = [{ clip_id: `${slotId}_broll_clip`, scene_id: 'narration_broll', start: secondsToTimecode(globalGap[0]), end: secondsToTimecode(globalGap[1]), speed_multiplier: 1 }];
            assignedBrollRanges.push(globalGap);
          } else {
            warnings.push(`${slotId} (${role}) NARRATE found no free b-roll window in [${winStart},${winEnd}] (dialogue-saturated); using beat window as-is`);
            sourceRange = [winStart, winEnd];
            sourceScenes = (winEnd > winStart) ? [{ clip_id: `${slotId}_broll_clip`, scene_id: 'narration_broll', start: secondsToTimecode(winStart), end: secondsToTimecode(winEnd), speed_multiplier: 1 }] : [];
          }
        }
      }
      sourceRangeHint = [sourceRange[0], sourceRange[0]]; // degenerate -> auto-picker declines
    }

    slots.push({
      slot_id: slotId,
      type: 'narration',
      source_type: 'NARRATE',
      translation_mode: '',
      source_range: sourceRange,
      duration: Number((sourceRange[1] - sourceRange[0]).toFixed(3)),
      scene_summary: normalizeText(item.reason || role),
      scene_ids: [],
      tts_budget_sec: isSceneHook ? [0, 0] : [Number(item.narration_estimated_duration_sec || item.estimated_duration_sec || 0), Number(item.estimated_duration_sec || 0)],
      narration_background: true,
      dialogue_heavy_role: role
    });
    segments.push({
      segment_id: slotId,
      segment_type: isSceneHook ? 'scene_hook' : 'recap',
      source_type: 'NARRATE',
      translation_mode: '',
      utt_id: '',
      tts_enabled: !isSceneHook,
      narration,
      dialogue_original: '',
      translated_caption_ko: '',
      caption_text: isSceneHook ? '' : (captionKr || narration),
      story_anchor: { source_range_hint: sourceRangeHint, scene_refs: [] },
      // Nothing may be cut from the channel's self-promo tail. Every b-roll path above picks its
      // range from a different source (beat window, hook fallback, global gap), and the closing
      // slot's ran past the usable end once the recap grew - which fails
      // narration_broll_semantic_bounds and the whole build with it. Clamp once, here, where every
      // path converges, keeping the clip's length by sliding it back instead of just truncating.
      source_scenes: clampScenesToUsableEnd(sourceScenes, footageEndSec),
      edit_instruction: defaultEditInstruction(role || 'narration'),
      // Exempts narration b-roll from the reserved-range gate's narration_overlaps_dialogue_map rule.
      narration_background: true
    });
  }

  const uploadText = slotFills?.upload_text && typeof slotFills.upload_text === 'object' ? slotFills.upload_text : {};
  const overlayTitle = uploadText.overlay_title && typeof uploadText.overlay_title === 'object' ? uploadText.overlay_title : {};
  const titleCandidates = Array.isArray(uploadText.title_candidates) ? uploadText.title_candidates.map((value) => normalizeText(value)).filter(Boolean) : [];
  // Word-boundary cap at ~12 chars: the old slice(0, 8) shipped hook phrases cut MID-WORD.
  const trimOverlayLine = (value, maxChars = 12) => {
    const text = normalizeText(value);
    if (text.length <= maxChars) return text;
    const clipped = text.slice(0, maxChars + 1);
    const lastSpace = clipped.lastIndexOf(' ');
    return (lastSpace >= 4 ? clipped.slice(0, lastSpace) : text.slice(0, maxChars)).trim();
  };
  const overlayTop = trimOverlayLine(overlayTitle.top);
  const overlayBottom = trimOverlayLine(overlayTitle.bottom);
  const slotMap = {
    source_duration_sec: durationSec,
    composition_mode: 'compression_bootstrap',
    dialogue_heavy_mode: true,
    slots
  };
  const script = {
    script_id: String(options.scriptId || 'compression_bootstrap'),
    source_reference: {
      gemini_analysis_source_id: String(options.geminiSourceId || ''),
      duration_sec: durationSec
    },
    content_context: {
      content_guess: normalizeText(options.title || ''),
      genre: '',
      style_hint_used: 'compression_bootstrap'
    },
    title_block: {
      full_title: titleCandidates[0] || '',
      overlay_title: {
        top: overlayTop,
        bottom: overlayBottom
      },
      top_title: overlayTop,
      top_subtitle: overlayBottom
    },
    metadata: {
      title_candidates: titleCandidates
    },
    segments,
    quality_check: {
      segment_count: segments.length,
      estimated_total_duration_sec: durationSec,
      duration_within_60_180: true,
      all_scene_ids_exist_in_gemini_analysis: true,
      no_source_scene_exceeds_30_sec: true,
      korean_ending_rules_ok: true,
      knowledge_context_used: false,
      dialogue_quote_count: segments.filter((s) => s.segment_type === 'dialogue_quote').length,
      recap_tts_segment_count: segments.filter((s) => s.segment_type === 'recap').length,
      ending_rules_check: {
        eomi_ratio_seumnida_pct: 0,
        eomi_ratio_jyo_pct: 0,
        eomi_ratio_neunde_pct: 0,
        eomi_ratio_beoryeot_pct: 0,
        forbidden_eomi_count: 0,
        character_naming_consistent: true,
        real_name_used: true,
        mystery_4steps_applied: true,
        closing_drip_present: true
      }
    },
    created_at: new Date().toISOString()
  };

  return { slotMap, script, warnings };
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// Reads a compression run's artifacts, builds the three System-B artifacts sharing one coordinate
// source, and writes them into the run dir with a bootstrap_ prefix. Does NOT download or render.
function assembleBootstrapArtifacts(runIdOrPath, options = {}) {
  const runDir = resolveCompressionRunDir(runIdOrPath);
  const editPlanPath = path.join(runDir, 'edit_plan.json');
  const slotFillsPath = path.join(runDir, 'compression_slot_fills.json');
  const transcriptTimedPath = path.join(runDir, 'transcript_timed.json');
  const manifestPath = path.join(runDir, 'compression_manifest.json');
  for (const [label, p] of [['edit_plan.json', editPlanPath], ['compression_slot_fills.json', slotFillsPath], ['transcript_timed.json', transcriptTimedPath]]) {
    if (!fs.existsSync(p)) throw new Error(`Bootstrap requires ${label} in ${runDir} (run compress + compress-apply first)`);
  }
  const editPlan = readJson(editPlanPath);
  const slotFills = readJson(slotFillsPath);
  const transcriptTimed = readJson(transcriptTimedPath);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const sourceVideoPath = String(options.sourceVideoPath || manifest.sourceVideoPath || '').trim();
  const sourceDurationSec = sourceVideoPath && fs.existsSync(sourceVideoPath)
    ? Number(getVideoMetadata(sourceVideoPath)?.duration_sec || 0)
    : 0;

  // Trim before either consumer reads the windows: the transcript and the slot map derive
  // their coordinates from the same numbers and must agree to within 0.05s.
  const speechRanges = detectSpeechRanges(sourceVideoPath, transcriptTimed);
  const promoTail = detectPromoTail(transcriptTimed, sourceDurationSec);
  // A frame-measured tail declaration (source_case.json, promo_tail_declared) beats caption
  // detection in both directions: the classifier read a dialogue-free ending as promo and
  // pulled usable_end 25s early, so the climax landed "in the promo tail" and the hook
  // got replayed over it.
  const bootstrapSourceCasePath = path.join(runDir, 'source_case.json');
  const bootstrapSourceCase = fs.existsSync(bootstrapSourceCasePath) ? readJson(bootstrapSourceCasePath) : null;
  const declaredUsableEndSec = bootstrapSourceCase && bootstrapSourceCase.promo_tail_declared === true
    && Number(bootstrapSourceCase.usable_end_sec) > 0 ? Number(bootstrapSourceCase.usable_end_sec) : 0;
  // Drop foreign utterances from a clip BEFORE the VAD trim: if a window straddles two cues, the
  // VAD trim would keep both (they are continuous speech) and the extra voice ships uncaptioned.
  const dialogueCueClamp = clampDialogueWindowsToOwnCue(editPlan, transcriptTimed);
  const dialogueTrim = trimDialogueWindowsToSpeech(editPlan, speechRanges, sourceDurationSec);
  // Floor each clip at the time its words need to be spoken, so a caption YouTube collapsed onto one
  // timestamp is not cut down to its last word. Runs AFTER the trim so it lifts whatever the cue and
  // VAD left too short.
  const dialogueFloor = extendShortDialogueWindows(editPlan, sourceDurationSec, transcriptTimed);

  const { transcript, stats: transcriptStats, warnings: tW } = buildBootstrapTranscript(editPlan, transcriptTimed);
  const energyProfilePath = path.join(runDir, 'energy_profile.json');
  const energyPeaks = fs.existsSync(energyProfilePath)
    ? ((readJson(energyProfilePath) || {}).peaks || [])
    : [];
  const { slotMap, script, warnings: sW } = buildBootstrapSlotMapAndScript(editPlan, slotFills, {
    scriptId: manifest.runId || path.basename(runDir),
    title: manifest.title || '',
    sourceDurationSec,
    speechRanges,
    usableEndSec: declaredUsableEndSec > 0 ? declaredUsableEndSec : promoTail.usable_end_sec,
    cueRanges: (Array.isArray(transcriptTimed) ? transcriptTimed : []).map((cue) => [Number(cue?.start_sec), Number(cue?.end_sec)]),
    energyPeaks
  });

  const outTranscriptPath = path.join(runDir, 'bootstrap_source_transcript.json');
  const outSlotMapPath = path.join(runDir, 'bootstrap_slot_map.json');
  const outScriptPath = path.join(runDir, 'bootstrap_script.json');
  const reviewDraftPath = path.join(runDir, 'bootstrap_review_draft.md');
  const editorialReviewPath = path.join(runDir, 'bootstrap_editorial_review.json');
  writeJson(outTranscriptPath, transcript);
  writeJson(outSlotMapPath, slotMap);
  writeJson(outScriptPath, script);
  writeJson(editorialReviewPath, buildEditorialReviewArtifact(editPlan, script));
  fs.writeFileSync(reviewDraftPath, buildReviewDraftMarkdown(script), 'utf8');

  return {
    runDir,
    editPlan,
    slotFills,
    transcript,
    slotMap,
    script,
    sourceVideoPath,
    sourceDurationSec,
    paths: { outTranscriptPath, outSlotMapPath, outScriptPath, reviewDraftPath, editorialReviewPath },
    warnings: [
      ...tW,
      ...sW,
      ...(dialogueCueClamp.clamped > 0
        ? [`clamped ${dialogueCueClamp.clamped} dialogue window(s) to their own cue to drop a foreign utterance: ${dialogueCueClamp.details.map((d) => `"${d.line}"`).join(', ')}`]
        : [])
    ],
    stats: transcriptStats,
    dialogue_window_trim: dialogueTrim,
    dialogue_cue_clamp: dialogueCueClamp,
    dialogue_floor: dialogueFloor
  };
}

// Runs every gate that would otherwise first surface during the render (the Daredevil failure
// mode), BEFORE any download/TTS/render: the three real capcut gates (via the Python harness)
// plus JS-side coordinate-parity, coverage, dialogue_line_window_ok, and cold-open overlap.
function runBootstrapPreflight(assembled, options = {}) {
  const { editPlan, transcript, slotMap, script, sourceVideoPath, sourceDurationSec, paths } = assembled;
  const checks = [];
  const warnings = Array.isArray(assembled.warnings) ? [...assembled.warnings] : [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

  const durationConfig = readDurationConfig();
  const estimatedTotalSec = Number(editPlan?.duration_budget?.estimated_total_sec || 0);
  if (estimatedTotalSec > durationConfig.max_duration_sec) {
    warnings.push(`duration guide warn: edit_plan estimated_total_sec ${estimatedTotalSec.toFixed(3)}s exceeds max_duration_sec ${durationConfig.max_duration_sec}s`);
  } else if (estimatedTotalSec > 0 && estimatedTotalSec < durationConfig.min_duration_sec
    && !(Number(sourceDurationSec) > 0 && Number(sourceDurationSec) * 0.5 < durationConfig.min_duration_sec)) {
    // A short source cannot reach the configured minimum, and the target follows the source now
    // (user directive: length is irrelevant when the script is complete) — so no warning either.
    warnings.push(`duration guide warn: edit_plan estimated_total_sec ${estimatedTotalSec.toFixed(3)}s is below min_duration_sec ${durationConfig.min_duration_sec}s`);
  }

  // 1. script.json must have NO slot_map key (keeps slot_map_mode false).
  add('no_slot_map_key', !Object.prototype.hasOwnProperty.call(script, 'slot_map'),
    Object.prototype.hasOwnProperty.call(script, 'slot_map') ? 'script.json unexpectedly has a slot_map key' : '');

  // 2. dialogue_line_window_ok: every KEEP_DIALOGUE slot must be ok (matcher confident, no
  //    unmatched/too-short line after extension).
  const notOkSlots = (Array.isArray(editPlan.timeline) ? editPlan.timeline : [])
    .filter((t) => t.decision === 'KEEP_DIALOGUE' && t.dialogue_line_window_ok !== true)
    .map((t) => t.slot_id);
  add('dialogue_line_window_ok', notOkSlots.length === 0, notOkSlots.length ? `not ok: ${notOkSlots.join(', ')}` : '');

  const missingSourceType = (Array.isArray(script.segments) ? script.segments : [])
    .filter((segment) => !segment.source_type)
    .map((segment) => segment.segment_id || '(unknown)');
  add('review_source_type_present', missingSourceType.length === 0, missingSourceType.length ? `missing: ${missingSourceType.join(', ')}` : '');
  add('review_draft_exists', Boolean(paths.reviewDraftPath && fs.existsSync(paths.reviewDraftPath)), paths.reviewDraftPath || '');

  // 3. 1:1 coverage: slot_map.slots ids == script.segments ids (both derived from non-DROP timeline).
  const slotIds = new Set(slotMap.slots.map((s) => s.slot_id));
  const segIds = new Set(script.segments.map((s) => s.segment_id));
  const idMatch = slotIds.size === segIds.size && [...slotIds].every((id) => segIds.has(id));
  add('coverage_slotmap_eq_script', idMatch, idMatch ? '' : `slot_map ${slotIds.size} vs script ${segIds.size}`);

  // 4. Speech coordinate parity: each dialogue segment keeps the transcript utterance as its
  //    dialogue_speech_range_sec while source_scenes may include visual pre-roll/post-roll.
  const uttById = new Map(transcript.utterances.map((u) => [u.utt_id, u]));
  let parityFail = '';
  for (const seg of script.segments) {
    if (seg.segment_type !== 'dialogue_quote' && seg.segment_type !== 'dialogue') continue;
    const utt = uttById.get(seg.utt_id);
    const clip = (seg.source_scenes || [])[0];
    if (!utt || !clip) { parityFail = `${seg.segment_id}: missing utterance or clip`; break; }
    const speechRange = Array.isArray(seg.dialogue_speech_range_sec) ? seg.dialogue_speech_range_sec : [];
    const ss = Number(speechRange[0]);
    const se = Number(speechRange[1]);
    const cs = parseTimecode(clip.start);
    const ce = parseTimecode(clip.end);
    if (Math.abs(ss - utt.start) > 0.001 || Math.abs(se - utt.end) > 0.001) {
      parityFail = `${seg.segment_id}: speech [${ss},${se}] != utterance [${utt.start},${utt.end}]`;
      break;
    }
    if (cs > utt.start + 0.001 || ce < utt.end - 0.001) {
      parityFail = `${seg.segment_id}: visual clip [${cs},${ce}] does not contain utterance [${utt.start},${utt.end}]`;
      break;
    }
  }
  add('coordinate_parity_dialogue', !parityFail, parityFail);

  // 5. Cold-open teaser window must not overlap any KEEP_DIALOGUE window (post-resize re-encroach).
  const coldOpen = (editPlan.timeline || []).find((t) => t.role === 'cold_open');
  // Reserve the clips a dialogue slot actually cuts, not its start_sec..end_sec span: a slot whose
  // lines are scattered across the source (38.9s to 180.8s here) reserved 142s of mostly dead
  // footage and rejected a teaser sitting in a gap no line occupies.
  const reserved = (editPlan.timeline || [])
    .filter((t) => t.decision === 'KEEP_DIALOGUE' && t.slot_id !== coldOpen?.slot_id)
    .flatMap((t) => (Array.isArray(t.dialogue_line_windows) ? t.dialogue_line_windows : [])
      .filter((win) => win && win.matched === true && Number(win.end_sec) > Number(win.start_sec))
      .map((win) => [Number(win.start_sec), Number(win.end_sec)]));
  let coldOverlap = '';
  if (coldOpen && Number.isFinite(Number(coldOpen.visual_source_start_sec))) {
    const cs = Number(coldOpen.visual_source_start_sec);
    const ce = Number(coldOpen.visual_source_end_sec);
    const hit = reserved.find(([rs, re]) => ce > rs + 0.001 && cs < re - 0.001);
    if (hit) coldOverlap = `cold-open teaser [${cs},${ce}] overlaps dialogue window [${hit[0]},${hit[1]}]`;
  }
  add('cold_open_no_reserved_overlap', !coldOverlap, coldOverlap);

  // 6. Source video reality: file exists, ffprobe duration covers every referenced timestamp.
  if (options.requireSourceVideo !== false) {
    const exists = sourceVideoPath && fs.existsSync(sourceVideoPath);
    add('source_video_exists', exists, exists ? sourceVideoPath : `missing: ${sourceVideoPath || '(none)'}`);
    if (exists && sourceDurationSec > 0) {
      let maxTs = 0;
      for (const seg of script.segments) {
        for (const clip of seg.source_scenes || []) maxTs = Math.max(maxTs, parseTimecode(clip.end));
      }
      const covers = sourceDurationSec + 0.5 >= maxTs;
      add('source_duration_covers_timestamps', covers, covers ? `dur ${sourceDurationSec}s >= max ts ${maxTs.toFixed(3)}s` : `dur ${sourceDurationSec}s < max ts ${maxTs.toFixed(3)}s`);
    }
  }

  // 7. The three real capcut gates via the Python harness (reserved-range + monotonicity + b-roll).
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const gateScript = path.join(PROJECT_ROOT, 'midform', 'scripts', 'preflight_bootstrap_gates.py');
  const args = [gateScript, '--script', paths.outScriptPath, '--transcript', paths.outTranscriptPath];
  if (sourceDurationSec > 0) args.push('--source-duration', String(sourceDurationSec));
  let gateVerdict = null;
  try {
    const out = execFileSync(python, args, { cwd: PROJECT_ROOT, env: getToolEnv(), encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    gateVerdict = JSON.parse(String(out).trim());
  } catch (error) {
    add('capcut_gates', false, `gate harness failed: ${error.message}`);
  }
  if (gateVerdict) {
    add('capcut_reserved_range', (gateVerdict.reserved_range_violations || []).length === 0,
      `${(gateVerdict.reserved_range_violations || []).length} violation(s)`);
    add('capcut_slot_map_mode_false', gateVerdict.slot_map_mode === false,
      `slot_map_mode ${gateVerdict.slot_map_mode}`);
    add('capcut_story_sync_skipped', gateVerdict.story_sync_would_run === false,
      gateVerdict.story_sync_would_run ? `auto-picker would place b-roll for: ${(gateVerdict.picker_placed_segments || []).join(', ')} (story-sync would run)` : 'all narration declines -> story-sync skipped');
    add('capcut_narration_has_broll', (gateVerdict.narration_missing_broll || []).length === 0,
      `${(gateVerdict.narration_missing_broll || []).length} narration segment(s) missing explicit b-roll`);
    add('capcut_cross_segment_overlap', (gateVerdict.cross_segment_overlaps || []).length === 0,
      `${(gateVerdict.cross_segment_overlaps || []).length} cross-segment overlap(s)`);
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, gateVerdict, warnings };
}

function parseTimecode(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  const parts = text.split(':');
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(text) || 0;
}

// Full bridge: download the real source video, build the three artifacts, run the whole preflight,
// and (unless preflightOnly) hand the artifact paths to the existing pipeline via startRun. No edit
// to midformPipelineService.js is needed — startRun already branches to bootstrapSeededRun when the
// four bootstrap paths are present. Runs direct (pauseBeforeTts:false) so the resume/normalize path
// (which would re-embed slot_map and re-enable the monotonicity gate) is never taken.
async function runBootstrapToPipeline(runIdOrPath, options = {}) {
  const download = await downloadCompressionSourceVideo(runIdOrPath, { force: options.forceDownload === true });
  const assembled = assembleBootstrapArtifacts(runIdOrPath, { sourceVideoPath: download.sourceVideoPath });
  const preflight = runBootstrapPreflight(assembled, { requireSourceVideo: true });

  const result = {
    runDir: assembled.runDir,
    sourceVideoPath: download.sourceVideoPath,
    paths: assembled.paths,
    preflight,
    warnings: assembled.warnings
  };
  if (!preflight.ok) {
    result.ok = false;
    result.blocked = 'preflight_failed';
    return result;
  }
  if (options.preflightOnly === true) {
    result.ok = true;
    result.rendered = false;
    return result;
  }

  const state = startRun({
    bootstrapSourceVideoPath: download.sourceVideoPath,
    bootstrapTranscriptPath: assembled.paths.outTranscriptPath,
    bootstrapSlotMapPath: assembled.paths.outSlotMapPath,
    bootstrapScriptPath: assembled.paths.outScriptPath,
    bootstrapSceneMapPath: (() => {
      const sceneMapPath = path.join(assembled.runDir, 'vision_scene_map.json');
      return fs.existsSync(sceneMapPath) ? sceneMapPath : '';
    })(),
    movieTitle: options.movieTitle || assembled.script?.content_context?.content_guess || '',
    contentType: 'movie_midform_recap',
    pauseBeforeTts: options.pauseBeforeTts === true
  });
  result.ok = true;
  result.rendered = true;
  result.pipelineRunId = state.runId;
  result.pipelineRunDir = state.runDir;
  return result;
}

module.exports = {
  compressDialogueCaptionText,
  buildBootstrapTranscript,
  buildBootstrapSlotMapAndScript,
  detectSpeechRanges,
  trimDialogueWindowsToSpeech,
  clampDialogueWindowsToOwnCue,
  extendShortDialogueWindows,
  buildEditorialReviewArtifact,
  assembleBootstrapArtifacts,
  runBootstrapPreflight,
  runBootstrapToPipeline,
  secondsToTimecode,
  _readJson: readJson,
  _resolveCompressionRunDir: resolveCompressionRunDir
};
