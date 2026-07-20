#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function textLength(value) {
  return String(value || '').trim().length;
}

function approxEqual(a, b, tolerance = 0.1) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function walk(value, visitor, currentPath = '') {
  visitor(value, currentPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${currentPath}[${index}]`));
  } else if (isObject(value)) {
    Object.entries(value).forEach(([key, child]) => walk(child, visitor, currentPath ? `${currentPath}.${key}` : key));
  }
}

const GENRES = new Set(['action', 'thriller', 'romance', 'comedy', 'drama', 'horror', 'sci_fi', 'fantasy', 'animation', 'unknown']);
const CONFIDENCE = new Set(['high', 'medium', 'low', 'source_unconfirmed']);
const SHOT_TYPES = new Set(['close_up', 'medium', 'wide', 'action', 'dialogue', 'insert', 'establishing', 'unknown']);
const SAFETY_KEYS = ['violence', 'sexual', 'gore', 'minor_safety', 'sensitive_topic'];
const DEPRECATED_KEYS = new Set(['dopamine_anchors', 'story_structure', 'recommended_story_angles', 'villain_candidates', 'midpoint_hook', 'turning_point', 'clips', 'intensity', 'dopamine_strength', 'story_importance', 'visual_strength']);
const KOREAN_SURNAMES = '김이박최정강조윤장임한오서신권황안송류홍전고문양손배백허유남심노하곽성차주우구민진엄채원천방공현함변염여추도소석선설마길위연표명기반왕금옥육인맹제모탁국어은편구용';

function looksLikeRealName(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  if (new RegExp(`^[${KOREAN_SURNAMES}]\\s?[?-?]{2,4}$`).test(value)) return true;
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(value)) return true;
  return false;
}

function findEmptyRequiredLikeValues(analysis) {
  const empty = [];
  walk(analysis, (value, currentPath) => {
    if (!currentPath) return;
    if (value === null) empty.push(currentPath);
    if (typeof value === 'string' && value.trim() === '') empty.push(currentPath);
    if (isObject(value) && Object.keys(value).length === 0) empty.push(currentPath);
  });
  return empty;
}

function findDeprecatedFields(analysis) {
  const found = [];
  walk(analysis, (_value, currentPath) => {
    if (!currentPath) return;
    const key = currentPath.replace(/\[\d+\]/g, '').split('.').pop();
    if (DEPRECATED_KEYS.has(key)) found.push(currentPath);
  });
  return found;
}

function validate(runDir) {
  const analysis = readJson(path.join(runDir, 'gemini_analysis.json'));
  const source = analysis.source || {};
  const context = analysis.story_context || {};
  const scenes = Array.isArray(analysis.scenes) ? analysis.scenes : [];
  const scenesByStart = [...scenes].sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  const characters = Array.isArray(analysis.characters) ? analysis.characters : [];
  const characterNames = new Set(characters.map((item) => item && item.safe_display_name).filter(Boolean));

  const emptyValues = findEmptyRequiredLikeValues(analysis);
  const deprecatedFields = findDeprecatedFields(analysis);

  const sourceResult = {
    pass: isObject(source)
      && Number(source.duration_sec) > 0
      && hasText(source.source_id)
      && hasText(source.aspect_ratio)
      && source.content_type === 'movie_midform_recap',
    duration_sec: source.duration_sec ?? null,
    aspect_ratio: source.aspect_ratio ?? null,
    source_id_present: hasText(source.source_id),
    content_type: source.content_type ?? null
  };

  const storyContextResult = {
    pass: hasText(context.content_guess)
      && CONFIDENCE.has(String(context.content_confidence || ''))
      && textLength(context.plot_summary_neutral) >= 20
      && GENRES.has(String(context.genre || ''))
      && hasText(context.language_of_dialogue),
    content_guess: context.content_guess ?? null,
    content_confidence: context.content_confidence ?? null,
    content_confidence_valid: CONFIDENCE.has(String(context.content_confidence || '')),
    plot_summary_length: textLength(context.plot_summary_neutral),
    genre: context.genre ?? null,
    genre_valid: GENRES.has(String(context.genre || '')),
    language_present: hasText(context.language_of_dialogue)
  };

  const sceneIssues = [];
  let dialogueCount = 0;
  let sceneDurationSum = 0;
  let continuityGapAbsSum = 0;
  let maxAdjacencyGap = 0;
  const continuityViolations = [];
  for (let index = 0; index < scenesByStart.length; index += 1) {
    const scene = scenesByStart[index];
    const id = scene.scene_id || '?';
    const start = Number(scene.start_sec);
    const end = Number(scene.end_sec);
    const duration = Number(scene.duration_sec);
    const missing = [];
    if (!hasText(scene.scene_id)) missing.push('scene_id');
    if (!Number.isFinite(start)) missing.push('start_sec');
    if (!Number.isFinite(end)) missing.push('end_sec');
    if (!Number.isFinite(duration)) missing.push('duration_sec');
    if (textLength(scene.visible_action) < 15) missing.push('visible_action');
    if (!hasText(scene.dialogue_or_caption)) missing.push('dialogue_or_caption');
    if (!SHOT_TYPES.has(String(scene.shot_type || ''))) missing.push('shot_type');
    if (!Array.isArray(scene.characters_visible)) missing.push('characters_visible');
    if (!hasText(scene.vertical_crop_note)) missing.push('vertical_crop_note');

    if (hasText(scene.dialogue_or_caption) && String(scene.dialogue_or_caption).trim().toLowerCase() !== 'none') dialogueCount += 1;
    if (Number.isFinite(duration)) sceneDurationSum += duration;
    if (index > 0) {
      const prevEnd = Number(scenesByStart[index - 1].end_sec);
      const prevId = scenesByStart[index - 1].scene_id || '?';
      if (Number.isFinite(prevEnd) && Number.isFinite(start)) {
        const gap = Math.abs(start - prevEnd);
        continuityGapAbsSum += gap;
        maxAdjacencyGap = Math.max(maxAdjacencyGap, gap);
        if (gap > 5) {
          continuityViolations.push({
            scene_id: id,
            previous_scene_id: prevId,
            gap_seconds: Number(gap.toFixed(3)),
            within_5_seconds: false
          });
        }
      } else {
        continuityViolations.push({
          scene_id: id,
          previous_scene_id: prevId,
          gap_seconds: null,
          within_5_seconds: false
        });
      }
    }

    const badCharacterRefs = Array.isArray(scene.characters_visible)
      ? scene.characters_visible.filter((name) => !characterNames.has(name))
      : [];
    const durationMismatch = Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(duration)
      ? !approxEqual(duration, end - start)
      : true;
    const outsideSource = Number.isFinite(start) && Number.isFinite(end) && Number(source.duration_sec) > 0
      ? start < -0.001 || end > Number(source.duration_sec) + 0.1 || end <= start
      : true;

    if (missing.length || badCharacterRefs.length || durationMismatch || outsideSource) {
      sceneIssues.push({ scene_id: id, missing, bad_character_refs: badCharacterRefs, duration_mismatch: durationMismatch, outside_source: outsideSource });
    }
  }
  const sourceDuration = Number(source.duration_sec);
  const coverageDeltaSec = Number.isFinite(sourceDuration) ? Math.abs(sceneDurationSum - sourceDuration) : null;
  const coverageRatio = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sceneDurationSum / sourceDuration : null;
  const scenesResult = {
    pass: scenes.length >= 3
      && scenes.length <= 20
      && sceneIssues.length === 0
      && continuityViolations.length === 0
      && coverageRatio !== null
      && coverageRatio >= 0.8,
    count: scenes.length,
    duration_sum_sec: Number(sceneDurationSum.toFixed(3)),
    source_duration_sec: source.duration_sec ?? null,
    coverage_delta_sec: coverageDeltaSec === null ? null : Number(coverageDeltaSec.toFixed(3)),
    coverage_ratio: coverageRatio === null ? null : Number(coverageRatio.toFixed(3)),
    continuity_gap_abs_sum_sec: Number(continuityGapAbsSum.toFixed(3)),
    continuity_gap_max_sec: Number(maxAdjacencyGap.toFixed(3)),
    continuity_violations: continuityViolations,
    dialogue_or_caption_count: dialogueCount,
    issues: sceneIssues
  };

  const characterIssues = characters
    .filter((item) => !hasText(item.safe_display_name) || !hasText(item.role) || !Number.isFinite(Number(item.first_seen_sec)))
    .map((item) => item.safe_display_name || '?');
  const realNameWarnings = characters.filter((item) => looksLikeRealName(item.safe_display_name)).map((item) => item.safe_display_name);
  const charactersResult = {
    pass: characters.length >= 1 && characterIssues.length === 0,
    count: characters.length,
    incomplete: characterIssues,
    real_name_warnings: realNameWarnings
  };

  const safetyMissing = [];
  const safetyIncomplete = [];
  for (const key of SAFETY_KEYS) {
    const item = analysis.safety_scan && analysis.safety_scan[key];
    if (!isObject(item)) {
      safetyMissing.push(key);
      safetyIncomplete.push(key);
    } else if (typeof item.present !== 'boolean' || !Array.isArray(item.timecodes)) {
      safetyIncomplete.push(key);
    }
  }
  const safetyResult = {
    pass: safetyMissing.length === 0 && safetyIncomplete.length === 0,
    missing: safetyMissing,
    incomplete: safetyIncomplete
  };

  const integrity = analysis.integrity_check || {};
  const integrityResult = {
    pass: Number(integrity.total_scenes_count) === scenes.length
      && Number.isFinite(Number(integrity.total_duration_sec))
      && typeof integrity.all_scene_times_within_source === 'boolean'
      && typeof integrity.no_empty_required_fields === 'boolean',
    total_scenes_count: integrity.total_scenes_count ?? null,
    actual_scenes_count: scenes.length,
    total_duration_sec: integrity.total_duration_sec ?? null,
    all_scene_times_within_source: integrity.all_scene_times_within_source ?? null,
    no_empty_required_fields: integrity.no_empty_required_fields ?? null
  };

  const emptyFieldResult = {
    pass: emptyValues.length === 0,
    empty_paths: emptyValues
  };

  const deprecatedResult = {
    pass: deprecatedFields.length === 0,
    present_paths: deprecatedFields
  };

  const dialogueResult = {
    pass: dialogueCount >= 1,
    dialogue_or_caption_count: dialogueCount,
    sample: scenes.map((scene) => scene.dialogue_or_caption).filter((value) => hasText(value) && String(value).trim().toLowerCase() !== 'none').slice(0, 3)
  };

  return {
    empty_fields: emptyFieldResult,
    deprecated_fields: deprecatedResult,
    source: sourceResult,
    story_context: storyContextResult,
    scenes: scenesResult,
    dialogue_or_caption: dialogueResult,
    characters: charactersResult,
    safety_scan: safetyResult,
    integrity_check: integrityResult
  };
}

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: node midform/scripts/validate_phase_d.js <run_dir>');
  process.exit(2);
}

const result = validate(runDir);
const outPath = path.join(runDir, 'analysis_validation.json');
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));

const failed = Object.values(result).some((section) => section && section.pass === false);
process.exit(failed ? 1 : 0);
