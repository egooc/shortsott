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
      speaker: String(segment.speaker || ''),
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
    if (!segment.speaker) continue;
    if (!evidence[segment.speaker]) evidence[segment.speaker] = new Set();
    if (segment.caption_color) evidence[segment.speaker].add(segment.caption_color);
  }
  return Object.fromEntries(Object.entries(evidence).map(([speaker, colors]) => [speaker, [...colors].sort()]));
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

function extractSubtitleTextMaterials(draftContent) {
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
    .filter((material) => material.type === 'subtitle' && material.text);
}

function validateManifestMaterialColors(manifest, draftContent) {
  const materials = extractSubtitleTextMaterials(draftContent);
  const coloredCaptions = (Array.isArray(manifest?.caption_units) ? manifest.caption_units : [])
    .filter((caption) => ['dialogue_quote', 'dialogue'].includes(String(caption?.segment_type || '')))
    .filter((caption) => String(caption?.caption_color || '').trim());
  const results = coloredCaptions.map((caption) => {
    const text = String(caption?.text || '').trim();
    const expected = String(caption?.caption_color || '').trim();
    const matches = materials.filter((material) => material.text === text);
    const material = matches.find((candidate) => rgbFloatMatchesHex(candidate.fill_rgb, expected)) || matches[0] || null;
    const fillMatches = material ? rgbFloatMatchesHex(material.fill_rgb, expected) : false;
    const textColorMatches = material ? String(material.text_color || '').toLowerCase() === expected.toLowerCase() : false;
    const letterColorEnabled = material?.useLetterColor === true;
    const effectDefaultDisabled = material?.use_effect_default_color === false;
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
  rgbFloatMatchesHex,
  assertCleanViewerSubtitleText
};
