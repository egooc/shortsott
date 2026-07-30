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

function normalizeMatchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractSubtitleTextMaterials(draftContent) {
  const activeMaterialIds = [];
  const trackMetadataByMaterialId = new Map();
  for (const track of Array.isArray(draftContent?.tracks) ? draftContent.tracks : []) {
    if (!track || track.type !== 'text' || (track.name && track.name !== 'subtitle')) continue;
    for (const [index, segment] of (Array.isArray(track.segments) ? track.segments : []).entries()) {
      const materialId = String(segment?.material_id || segment?.materialId || '').trim();
      if (materialId) {
        activeMaterialIds.push(materialId);
        trackMetadataByMaterialId.set(materialId, {
          subtitle_order: index,
          caption_id: String(segment?.caption_id || segment?.captionId || ''),
          segment_id: String(segment?.segment_id || segment?.segmentId || ''),
          source_utterance_id: String(segment?.source_utterance_id || segment?.utt_id || '')
        });
      }
    }
  }
  const activeMaterialIdSet = new Set(activeMaterialIds);
  const materials = Array.isArray(draftContent?.materials?.texts) ? draftContent.materials.texts : [];
  return materials
    .map((material) => {
      const parsedContent = parseTextMaterialContent(material);
      const styles = Array.isArray(parsedContent?.styles) ? parsedContent.styles : [];
      const style = styles[0] || {};
      const fillColor = style?.fill?.content?.solid?.color || null;
      const id = String(material?.id || '');
      const trackMetadata = trackMetadataByMaterialId.get(id) || {};
      return {
        id,
        type: String(material?.type || ''),
        text: textFromMaterial(material, parsedContent),
        caption_id: String(material?.caption_id || material?.captionId || parsedContent?.caption_id || trackMetadata.caption_id || ''),
        segment_id: String(material?.segment_id || material?.segmentId || parsedContent?.segment_id || trackMetadata.segment_id || ''),
        source_utterance_id: String(material?.source_utterance_id || material?.utt_id || parsedContent?.source_utterance_id || trackMetadata.source_utterance_id || ''),
        subtitle_order: Number.isInteger(trackMetadata.subtitle_order) ? trackMetadata.subtitle_order : -1,
        text_color: String(material?.text_color || ''),
        use_effect_default_color: material?.use_effect_default_color,
        useLetterColor: style?.useLetterColor,
        fill_rgb: fillColor,
        parsed: Boolean(parsedContent)
      };
    })
    .filter((material) => material.type === 'subtitle' && material.text)
    .filter((material) => activeMaterialIdSet.size === 0 || activeMaterialIdSet.has(material.id))
    .sort((left, right) => {
      const leftOrder = left.subtitle_order >= 0 ? left.subtitle_order : Number.MAX_SAFE_INTEGER;
      const rightOrder = right.subtitle_order >= 0 ? right.subtitle_order : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });
}

function findMaterialForCaption(caption, materials, usedMaterialIds) {
  const unused = materials.filter((material) => !usedMaterialIds.has(material.id));
  const captionId = String(caption?.caption_id || '').trim();
  const segmentId = String(caption?.segment_id || '').trim();
  const sourceUtteranceId = String(caption?.source_utterance_id || '').trim();
  const subtitleOrder = Number(caption?._subtitle_order);
  const text = normalizeMatchText(caption?.text || '');
  const tiers = [
    captionId ? unused.filter((material) => material.caption_id === captionId) : [],
    segmentId ? unused.filter((material) => material.segment_id === segmentId) : [],
    sourceUtteranceId ? unused.filter((material) => material.source_utterance_id === sourceUtteranceId) : [],
    Number.isInteger(subtitleOrder) && subtitleOrder >= 0 ? unused.filter((material) => material.subtitle_order === subtitleOrder) : [],
    text ? unused.filter((material) => normalizeMatchText(material.text) === text) : []
  ];
  const expected = String(caption?.caption_color || '').trim();
  for (const candidates of tiers) {
    if (!candidates.length) continue;
    return candidates.find((candidate) => rgbFloatMatchesHex(candidate.fill_rgb, expected)) || candidates[0];
  }
  return null;
}

function validateManifestMaterialColors(manifest, draftContent) {
  const materials = extractSubtitleTextMaterials(draftContent);
  const allCaptions = Array.isArray(manifest?.caption_units) ? manifest.caption_units : [];
  const coloredCaptions = allCaptions
    .map((caption, subtitleOrder) => ({ ...caption, _subtitle_order: subtitleOrder }))
    .filter((caption) => ['dialogue_quote', 'dialogue'].includes(String(caption?.segment_type || '')))
    .filter((caption) => String(caption?.caption_color || '').trim());
  const usedMaterialIds = new Set();
  const results = coloredCaptions.map((caption) => {
    const text = String(caption?.text || '').trim();
    const expected = String(caption?.caption_color || '').trim();
    const material = findMaterialForCaption(caption, materials, usedMaterialIds);
    if (material?.id) usedMaterialIds.add(material.id);
    const fillMatches = material ? rgbFloatMatchesHex(material.fill_rgb, expected) : false;
    const textColorMatches = material ? String(material.text_color || '').toLowerCase() === expected.toLowerCase() : false;
    const letterColorEnabled = material?.useLetterColor === true;
    const effectDefaultDisabled = material?.use_effect_default_color === false;
    return {
      caption_id: String(caption?.caption_id || ''),
      segment_id: String(caption?.segment_id || ''),
      speaker: String(caption?.speaker || ''),
      source_utterance_id: String(caption?.source_utterance_id || ''),
      text,
      expected_color: expected,
      material_id: material?.id || '',
      material_caption_id: material?.caption_id || '',
      material_segment_id: material?.segment_id || '',
      material_source_utterance_id: material?.source_utterance_id || '',
      material_subtitle_order: material?.subtitle_order ?? -1,
      caption_subtitle_order: Number.isInteger(caption._subtitle_order) ? caption._subtitle_order : -1,
      fill_rgb: material?.fill_rgb || null,
      fill_matches: fillMatches,
      text_color_matches: textColorMatches,
      use_letter_color: letterColorEnabled,
      effect_default_disabled: effectDefaultDisabled,
      passed: Boolean(material && fillMatches && textColorMatches && letterColorEnabled && effectDefaultDisabled)
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
