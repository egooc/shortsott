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

// Every character gets a colour of their own (user directive). The curated palette runs out at
// four, so beyond it colours are generated rather than reused. Walking the hue circle by the
// golden angle spreads them further apart than random picks would, and picking randomly is what
// would eventually put two characters on near-identical colours — the thing the directive is
// trying to avoid. Saturation and lightness are fixed at values that stay readable over video
// with the black outline the captions already carry.
const GENERATED_HUE_STEP_DEG = 137.508;
const GENERATED_HUE_MIN_SEPARATION_DEG = 24;
const GENERATED_SATURATION = 0.95;
const GENERATED_LIGHTNESS = 0.66;

function hslToHex(hueDeg, saturation, lightness) {
  const hue = ((hueDeg % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
      : hue < 180 ? [0, chroma, secondary]
        : hue < 240 ? [0, secondary, chroma]
          : hue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const channel = (value) => Math.round((value + match) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function hexToHueDeg(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null; // grey has no hue to collide with
  const delta = max - min;
  const hue = max === r ? 60 * (((g - b) / delta) % 6)
    : max === g ? 60 * ((b - r) / delta + 2)
      : 60 * ((r - g) / delta + 4);
  return ((hue % 360) + 360) % 360;
}

function hueDistanceDeg(left, right) {
  const diff = Math.abs(left - right) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Returns a hex colour far enough from every hue already in play. resolveCaptionColor accepts a
// hex as the colour key directly, so a generated colour needs no config entry.
function generateDistinctCaptionColor(usedHues, sequence) {
  let hue = (sequence * GENERATED_HUE_STEP_DEG) % 360;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (usedHues.every((used) => hueDistanceDeg(hue, used) >= GENERATED_HUE_MIN_SEPARATION_DEG)) break;
    hue = (hue + GENERATED_HUE_MIN_SEPARATION_DEG / 2) % 360;
  }
  usedHues.push(hue);
  return hslToHex(hue, GENERATED_SATURATION, GENERATED_LIGHTNESS);
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

  // Hues already spoken for: the named cast roles and the curated fallback palette. A generated
  // colour has to stay clear of these as well as of the ones generated before it.
  const usedHues = [
    ...Object.values(config?.roles && typeof config.roles === 'object' ? config.roles : {}),
    ...Object.values(config?.fallback_roles && typeof config.fallback_roles === 'object' ? config.fallback_roles : {})
  ].map(hexToHueDeg).filter((hue) => hue !== null);

  let next = 0;
  for (const group of normalizedGroups) {
    for (const alias of group) {
      if (assignment.has(alias)) continue;
      // Curated colours first, then generated ones — one per character, never reused.
      assignment.set(alias, next < fallbackRoles.length
        ? fallbackRoles[next]
        : generateDistinctCaptionColor(usedHues, next - fallbackRoles.length + 1));
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
  // A speaker mapped to a fallback-palette role (우두머리 -> 기타1) resolves through
  // fallback_roles; keeping 기타N out of `roles` avoids colliding with generated colors.
  if (mapped && String(fallbackRoles[mapped] || '').startsWith('#')) return fallbackRoles[mapped];
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
