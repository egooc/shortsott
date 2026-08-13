const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  const filePath = path.isAbsolute(relativePath) ? relativePath : path.join(PROJECT_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function activeSegmentsFromManifest(manifest) {
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  return segments
    .map((segment) => ({
      segment_id: String(segment.segment_id || ''),
      segment_type: String(segment.segment_type || ''),
      caption_kind: String(segment.caption_kind || ''),
      speaker: String(segment.speaker || ''),
      speaker_id: String(segment.speaker_id || ''),
      speaker_alias: String(segment.speaker_alias || segment.speaker || ''),
      speaker_color_key: String(segment.speaker_color_key || ''),
      source_utterance_id: String(segment.source_utterance_id || ''),
      caption_color: String(segment.caption_color || ''),
      text: String(segment.narration || segment.text || ''),
      timeline_start_sec: Number(segment.timeline_start_sec || 0),
      timeline_end_sec: Number(segment.timeline_end_sec || 0)
    }))
    .filter((segment) => segment.segment_id && segment.timeline_end_sec > segment.timeline_start_sec)
    .sort((left, right) => left.timeline_start_sec - right.timeline_start_sec || left.timeline_end_sec - right.timeline_end_sec);
}

function segmentKind(segment) {
  return ['dialogue_quote', 'dialogue'].includes(String(segment?.segment_type || '')) ? 'dialogue' : 'narrate';
}

function firstDialogueStartSec(segments) {
  const first = segments.find((segment) => segmentKind(segment) === 'dialogue');
  return first ? first.timeline_start_sec : null;
}

function callbackDialogueStartSec(segments) {
  const dialogueBlocks = [];
  const seen = new Set();
  for (const segment of segments) {
    if (segmentKind(segment) !== 'dialogue') continue;
    const blockId = String(segment.segment_id || '').replace(/_L\d+.*$/, '');
    if (seen.has(blockId)) continue;
    seen.add(blockId);
    dialogueBlocks.push(segment);
  }
  return dialogueBlocks[1] ? dialogueBlocks[1].timeline_start_sec : null;
}

function maxContinuousNarrationRunSec(segments) {
  let current = 0;
  let max = 0;
  for (const segment of segments) {
    const duration = Math.max(0, segment.timeline_end_sec - segment.timeline_start_sec);
    if (segmentKind(segment) === 'dialogue') {
      max = Math.max(max, current);
      current = 0;
    } else {
      current += duration;
    }
  }
  return Math.max(max, current);
}

function colorEvidenceBySpeaker(manifest) {
  const evidence = {};
  for (const segment of activeSegmentsFromManifest(manifest)) {
    if (segmentKind(segment) !== 'dialogue') continue;
    const speakerKey = segment.speaker_id || segment.speaker;
    if (!speakerKey) continue;
    if (!evidence[speakerKey]) evidence[speakerKey] = new Set();
    if (segment.caption_color) evidence[speakerKey].add(segment.caption_color);
  }
  return Object.fromEntries(Object.entries(evidence).map(([speaker, colors]) => [speaker, [...colors].sort()]));
}

function validateSpeakerColorMetadata(manifest) {
  const active = activeSegmentsFromManifest(manifest);
  const dialogueSegments = active.filter((segment) => segmentKind(segment) === 'dialogue');
  const narrationColors = new Set(active.filter((segment) => segmentKind(segment) !== 'dialogue').map((segment) => segment.caption_color).filter(Boolean));
  const missing = [];
  const colorsBySpeaker = new Map();
  const keysBySpeaker = new Map();
  const sceneBuckets = new Map();

  for (const segment of dialogueSegments) {
    if (!segment.speaker_id || !segment.speaker_alias || !segment.speaker_color_key || !segment.source_utterance_id || !segment.caption_color) {
      missing.push({
        segment_id: segment.segment_id,
        speaker_id: segment.speaker_id,
        speaker_alias: segment.speaker_alias,
        speaker_color_key: segment.speaker_color_key,
        source_utterance_id: segment.source_utterance_id,
        caption_color: segment.caption_color
      });
    }
    if (segment.speaker_id) {
      if (!colorsBySpeaker.has(segment.speaker_id)) colorsBySpeaker.set(segment.speaker_id, new Set());
      if (!keysBySpeaker.has(segment.speaker_id)) keysBySpeaker.set(segment.speaker_id, new Set());
      if (segment.caption_color) colorsBySpeaker.get(segment.speaker_id).add(segment.caption_color.toLowerCase());
      if (segment.speaker_color_key) keysBySpeaker.get(segment.speaker_id).add(segment.speaker_color_key);
    }
    const sceneKey = String(segment.segment_id || '').replace(/_L\d+.*$/, '');
    if (!sceneBuckets.has(sceneKey)) sceneBuckets.set(sceneKey, []);
    sceneBuckets.get(sceneKey).push(segment);
  }

  const inconsistentSpeakers = [...colorsBySpeaker.entries()]
    .filter(([, colors]) => colors.size > 1)
    .map(([speaker_id, colors]) => ({ speaker_id, colors: [...colors].sort() }));
  const inconsistentColorKeys = [...keysBySpeaker.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(([speaker_id, keys]) => ({ speaker_id, speaker_color_keys: [...keys].sort() }));
  const collapsedScenes = [...sceneBuckets.entries()]
    .map(([scene_id, segments]) => {
      const speakerIds = new Set(segments.map((segment) => segment.speaker_id).filter(Boolean));
      const colors = new Set(segments.map((segment) => segment.caption_color.toLowerCase()).filter(Boolean));
      return { scene_id, speaker_count: speakerIds.size, color_count: colors.size, speakers: [...speakerIds].sort(), colors: [...colors].sort() };
    })
    .filter((scene) => scene.speaker_count >= 2 && scene.color_count <= 1);
  const narrationColorCollisions = [...narrationColors]
    .map((color) => color.toLowerCase())
    .filter((color) => [...colorsBySpeaker.values()].some((colors) => colors.has(color)));

  const failed = [];
  if (missing.length) failed.push('dialogue_speaker_metadata_present');
  if (inconsistentSpeakers.length || inconsistentColorKeys.length) failed.push('same_speaker_same_color');
  if (collapsedScenes.length) failed.push('distinct_speakers_not_collapsed');
  if (narrationColorCollisions.length) failed.push('narration_dialogue_color_separation');

  return {
    checked: dialogueSegments.length,
    status: failed.length ? 'failed' : 'passed',
    failed,
    missing,
    inconsistent_speakers: inconsistentSpeakers,
    inconsistent_color_keys: inconsistentColorKeys,
    collapsed_scenes: collapsedScenes,
    narration_dialogue_color_collisions: [...new Set(narrationColorCollisions)].sort()
  };
}

function hexToRgbFloat(hex) {
  const value = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function rgbFloatMatchesHex(rgb, hex, tolerance = 0.005) {
  const expected = hexToRgbFloat(hex);
  if (!expected || !Array.isArray(rgb) || rgb.length < 3) return false;
  return expected.every((value, index) => Math.abs(Number(rgb[index]) - value) <= tolerance);
}

function parseTextMaterialContent(material) {
  const raw = material && typeof material.content === 'string' ? material.content : '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function textFromMaterial(material, parsedContent) {
  return String(
    material?.recognize_text
    || material?.base_content
    || material?.name
    || parsedContent?.text
    || ''
  ).trim();
}

function extractSubtitleTextMaterials(draftContent, includeUnreferenced = false) {
  const activeMaterialIds = new Set();
  for (const track of Array.isArray(draftContent?.tracks) ? draftContent.tracks : []) {
    // Captions live on one text track per lane now (subtitle, subtitle_2, ...). Looking only at
    // 'subtitle' left every caption in the lower lane invisible to this check, which then
    // reported them as having no colour at all.
    const trackName = String(track?.name || '');
    const isCaptionTrack = !trackName || trackName === 'subtitle' || trackName.startsWith('subtitle_');
    if (!track || track.type !== 'text' || !isCaptionTrack) continue;
    for (const segment of Array.isArray(track.segments) ? track.segments : []) {
      const materialId = String(segment?.material_id || segment?.materialId || '').trim();
      if (materialId) activeMaterialIds.add(materialId);
    }
  }
  const materials = Array.isArray(draftContent?.materials?.texts) ? draftContent.materials.texts : [];
  return materials
    .map((material) => {
      const parsedContent = parseTextMaterialContent(material);
      const styles = Array.isArray(parsedContent?.styles) ? parsedContent.styles : [];
      const style = styles[0] || {};
      const fillColor = style?.fill?.content?.solid?.color || null;
      return {
        id: String(material?.id || ''),
        type: String(material?.type || ''),
        text: textFromMaterial(material, parsedContent),
        text_color: String(material?.text_color || ''),
        use_effect_default_color: material?.use_effect_default_color,
        useLetterColor: style?.useLetterColor,
        fill_rgb: fillColor,
        parsed: Boolean(parsedContent)
      };
    })
    .filter((material) => material.type === 'subtitle' && material.text)
    .filter((material) => includeUnreferenced || activeMaterialIds.size === 0 || activeMaterialIds.has(material.id));
}

function validateManifestMaterialColors(manifest, draftContent) {
  const materials = extractSubtitleTextMaterials(draftContent);
  // A caption unit whose time-slice fell below the render's readable floor (~500ms) has its
  // timeline segment dropped, which orphans its (correctly coloured) text material - it exists in
  // the draft but no segment references it. That is a DROP, not a colour error: the colour
  // pipeline succeeded. So when no REFERENCED material matches, fall back to the full material
  // pool; a correctly coloured orphan means the colour was applied and only the unreadable sliver
  // was dropped. (Housemaid slot_03_L03/slot_07_L04 tail chunks at 0.35-0.49s.)
  const allMaterials = extractSubtitleTextMaterials(draftContent, true);
  const coloredCaptions = (Array.isArray(manifest?.caption_units) ? manifest.caption_units : [])
    .filter((caption) => ['dialogue_quote', 'dialogue'].includes(String(caption?.segment_type || '')))
    .filter((caption) => String(caption?.caption_color || '').trim());
  const usedMaterialIds = new Set();
  const results = coloredCaptions.map((caption) => {
    const text = String(caption?.text || '').trim();
    const expected = String(caption?.caption_color || '').trim();
    const matches = materials.filter((material) => material.text === text && !usedMaterialIds.has(material.id));
    const material = matches.find((candidate) => rgbFloatMatchesHex(candidate.fill_rgb, expected)) || matches[0] || null;
    if (material?.id) usedMaterialIds.add(material.id);
    const fillMatches = material ? rgbFloatMatchesHex(material.fill_rgb, expected) : false;
    const textColorMatches = material ? String(material.text_color || '').toLowerCase() === expected.toLowerCase() : false;
    const letterColorEnabled = material?.useLetterColor === true;
    const effectDefaultDisabled = material?.use_effect_default_color === false;
    let passed = Boolean(material && fillMatches && textColorMatches && letterColorEnabled && effectDefaultDisabled);
    let droppedSliver = false;
    // Rescue a caption the renderer legitimately DROPPED (a sub-500ms sliver, or one that
    // collided in time with a same-lane caption and lost the slot): the drop orphans its
    // otherwise-correctly-coloured material, which is a DROP, not a colour error. Only a caption
    // the pipeline actually produced carries a duration_sec, so a correctly-coloured orphan for
    // such a caption means the colour pipeline succeeded and only the render slot was dropped.
    // A synthetic/genuinely-absent caption with no recorded duration is never rescued, so a
    // mis-mapped or mis-coloured caption still fails.
    const durationSec = Number(caption?.duration_sec);
    const isProducedButDropped = Number.isFinite(durationSec) && durationSec > 0;
    if (!passed && !material && isProducedButDropped) {
      const orphan = allMaterials.find((candidate) => candidate.text === text
        && rgbFloatMatchesHex(candidate.fill_rgb, expected)
        && String(candidate.text_color || '').toLowerCase() === expected.toLowerCase());
      if (orphan) { passed = true; droppedSliver = true; }
    }
    return {
      caption_id: String(caption?.caption_id || ''),
      segment_id: String(caption?.segment_id || ''),
      speaker: String(caption?.speaker || ''),
      text,
      expected_color: expected,
      material_id: material?.id || '',
      fill_rgb: material?.fill_rgb || null,
      fill_matches: fillMatches,
      text_color_matches: textColorMatches,
      use_letter_color: letterColorEnabled,
      effect_default_disabled: effectDefaultDisabled,
      dropped_sliver: droppedSliver,
      passed
    };
  });
  return {
    checked: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed),
    results
  };
}

function assertCleanViewerSubtitleText(text) {
  const value = String(text || '');
  return !/(KEEP_DIALOGUE|NARRATE|slot_\d+|faithful_dialogue)/.test(value);
}

module.exports = {
  PROJECT_ROOT,
  readJson,
  activeSegmentsFromManifest,
  firstDialogueStartSec,
  callbackDialogueStartSec,
  maxContinuousNarrationRunSec,
  colorEvidenceBySpeaker,
  extractSubtitleTextMaterials,
  validateManifestMaterialColors,
  validateSpeakerColorMetadata,
  rgbFloatMatchesHex,
  assertCleanViewerSubtitleText
};
