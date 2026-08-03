const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('../services/pipelinePaths');

const CAPTION_COLORS_CONFIG_PATH = path.join(PROJECT_ROOT, 'midform', 'config', 'caption_colors.json');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSpeakerId(value) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || '';
}

function readCaptionColorConfig() {
  if (!fs.existsSync(CAPTION_COLORS_CONFIG_PATH)) return { roles: {}, speakers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CAPTION_COLORS_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : { roles: {}, speakers: {} };
  } catch {
    return { roles: {}, speakers: {} };
  }
}

// Deterministic per-alias fallback so an unlisted speaker still gets a stable, visible
// color instead of failing the speaker-metadata gates on every new film. fallback_roles
// colors are distinct from the main role colors, so unknowns never collapse into a known
// speaker's color.
function fallbackSpeakerColorKey(speakerAlias, config) {
  const fallbackRoles = config?.fallback_roles && typeof config.fallback_roles === 'object' ? Object.keys(config.fallback_roles) : [];
  if (!fallbackRoles.length) return '';
  const id = normalizeSpeakerId(speakerAlias);
  if (!id) return '';
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = ((hash * 31) + id.charCodeAt(index)) >>> 0;
  return fallbackRoles[hash % fallbackRoles.length];
}

// Hashing each alias independently gives no guarantee that two speakers in the same scene differ,
// which is exactly what the collapse gate checks: "대릴" and "여자" both hashed to 기타1 and a
// two-hander played out in one colour. Walk the aliases in order of appearance instead, so unknown
// speakers take distinct fallback roles until the palette runs out.
// Accepts a flat list of aliases in order of appearance, or a list of per-scene groups. Grouping
// matters once there are more speakers than colours: six speakers against a four-colour palette
// wrapped around and put Darryl and Mr. Tyson on 기타2, and they share two scenes.
function assignFallbackSpeakerColorKeys(speakerAliases, config = readCaptionColorConfig()) {
  const assignment = new Map();
  const fallbackRoles = config?.fallback_roles && typeof config.fallback_roles === 'object' ? Object.keys(config.fallback_roles) : [];
  if (!fallbackRoles.length) return assignment;

  const input = Array.isArray(speakerAliases) ? speakerAliases : [];
  const groups = input.length && Array.isArray(input[0]) ? input : [input];
  const normalizedGroups = groups.map((group) => (Array.isArray(group) ? group : [])
    .map((alias) => normalizeText(alias))
    .filter((alias) => alias && !resolveSpeakerColorKeyFromConfig(alias, config)));

  // Who shares a scene with whom. A colour may repeat across the cut, never inside one scene.
  const coOccurring = new Map();
  for (const group of normalizedGroups) {
    const distinct = [...new Set(group)];
    for (const alias of distinct) {
      if (!coOccurring.has(alias)) coOccurring.set(alias, new Set());
      for (const other of distinct) if (other !== alias) coOccurring.get(alias).add(other);
    }
  }

  let next = 0;
  for (const group of normalizedGroups) {
    for (const alias of group) {
      if (assignment.has(alias)) continue;
      const taken = new Set([...(coOccurring.get(alias) || [])]
        .map((other) => assignment.get(other))
        .filter(Boolean));
      let chosen = '';
      for (let offset = 0; offset < fallbackRoles.length; offset += 1) {
        const candidate = fallbackRoles[(next + offset) % fallbackRoles.length];
        if (!taken.has(candidate)) { chosen = candidate; break; }
      }
      // More speakers in one scene than the palette can colour: take the next key rather than
      // leaving the speaker with none, and let the caller's gate report the collapse.
      assignment.set(alias, chosen || fallbackRoles[next % fallbackRoles.length]);
      next += 1;
    }
  }
  return assignment;
}

// The config-only half of resolveSpeakerColorKey: returns '' when the alias is not named, so the
// caller can decide how to pick a fallback rather than always getting the hashed one.
function resolveSpeakerColorKeyFromConfig(speakerAlias, config = readCaptionColorConfig()) {
  const alias = normalizeText(speakerAlias);
  if (!alias || !config || typeof config !== 'object') return '';
  const speakers = config.speakers && typeof config.speakers === 'object' ? config.speakers : {};
  const roles = config.roles && typeof config.roles === 'object' ? config.roles : {};
  const mapped = normalizeText(speakers[alias]);
  if (mapped && !mapped.startsWith('#')) return mapped;
  if (roles[alias]) return alias;
  return '';
}

function resolveSpeakerColorKey(speakerAlias, config = readCaptionColorConfig()) {
  const alias = normalizeText(speakerAlias);
  if (!alias || !config || typeof config !== 'object') return '';
  const speakers = config.speakers && typeof config.speakers === 'object' ? config.speakers : {};
  const roles = config.roles && typeof config.roles === 'object' ? config.roles : {};
  const mapped = normalizeText(speakers[alias]);
  if (mapped && !mapped.startsWith('#')) return mapped;
  if (roles[alias]) return alias;
  return fallbackSpeakerColorKey(alias, config);
}

function resolveCaptionColor({ speakerAlias = '', speakerColorKey = '' } = {}, config = readCaptionColorConfig()) {
  if (!config || typeof config !== 'object') return '';
  const roles = config.roles && typeof config.roles === 'object' ? config.roles : {};
  const fallbackRoles = config.fallback_roles && typeof config.fallback_roles === 'object' ? config.fallback_roles : {};
  const speakers = config.speakers && typeof config.speakers === 'object' ? config.speakers : {};
  const key = normalizeText(speakerColorKey);
  if (key && String(roles[key] || '').startsWith('#')) return roles[key];
  if (key && String(fallbackRoles[key] || '').startsWith('#')) return fallbackRoles[key];
  if (key.startsWith('#')) return key;
  const alias = normalizeText(speakerAlias);
  const mapped = normalizeText(speakers[alias]);
  if (mapped.startsWith('#')) return mapped;
  if (mapped && String(roles[mapped] || '').startsWith('#')) return roles[mapped];
  if (String(roles[alias] || '').startsWith('#')) return roles[alias];
  const fallbackKey = fallbackSpeakerColorKey(alias, config);
  if (fallbackKey && String(fallbackRoles[fallbackKey] || '').startsWith('#')) return fallbackRoles[fallbackKey];
  return '';
}

function buildSpeakerMetadata(source = {}, fallback = {}) {
  const captionKind = normalizeText(source.caption_kind || fallback.caption_kind || (
    ['dialogue_quote', 'dialogue'].includes(String(source.segment_type || source.segmentType || fallback.segment_type || fallback.segmentType || ''))
      ? 'dialogue'
      : 'narration'
  ));
  const speakerAlias = normalizeText(source.speaker_alias || source.speaker || fallback.speaker_alias || fallback.speaker || '');
  const speakerId = normalizeText(source.speaker_id || fallback.speaker_id || normalizeSpeakerId(speakerAlias));
  const speakerColorKey = normalizeText(source.speaker_color_key || fallback.speaker_color_key || resolveSpeakerColorKey(speakerAlias));
  const sourceUtteranceId = normalizeText(source.source_utterance_id || source.utt_id || source.source_line_id || fallback.source_utterance_id || fallback.utt_id || fallback.source_line_id || '');
  const metadata = { caption_kind: captionKind || 'narration' };
  if (speakerId) metadata.speaker_id = speakerId;
  if (speakerAlias) metadata.speaker_alias = speakerAlias;
  if (speakerColorKey) metadata.speaker_color_key = speakerColorKey;
  if (sourceUtteranceId) metadata.source_utterance_id = sourceUtteranceId;
  return metadata;
}

module.exports = {
  CAPTION_COLORS_CONFIG_PATH,
  assignFallbackSpeakerColorKeys,
  buildSpeakerMetadata,
  normalizeSpeakerId,
  readCaptionColorConfig,
  resolveCaptionColor,
  resolveSpeakerColorKey
};
