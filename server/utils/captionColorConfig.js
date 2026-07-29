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

function resolveSpeakerColorKey(speakerAlias, config = readCaptionColorConfig()) {
  const alias = normalizeText(speakerAlias);
  if (!alias || !config || typeof config !== 'object') return '';
  const speakers = config.speakers && typeof config.speakers === 'object' ? config.speakers : {};
  const roles = config.roles && typeof config.roles === 'object' ? config.roles : {};
  const mapped = normalizeText(speakers[alias]);
  if (mapped && !mapped.startsWith('#')) return mapped;
  if (roles[alias]) return alias;
  return '';
}

function resolveCaptionColor({ speakerAlias = '', speakerColorKey = '' } = {}, config = readCaptionColorConfig()) {
  if (!config || typeof config !== 'object') return '';
  const roles = config.roles && typeof config.roles === 'object' ? config.roles : {};
  const speakers = config.speakers && typeof config.speakers === 'object' ? config.speakers : {};
  const key = normalizeText(speakerColorKey);
  if (key && String(roles[key] || '').startsWith('#')) return roles[key];
  if (key.startsWith('#')) return key;
  const alias = normalizeText(speakerAlias);
  const mapped = normalizeText(speakers[alias]);
  if (mapped.startsWith('#')) return mapped;
  if (mapped && String(roles[mapped] || '').startsWith('#')) return roles[mapped];
  if (String(roles[alias] || '').startsWith('#')) return roles[alias];
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
  buildSpeakerMetadata,
  normalizeSpeakerId,
  readCaptionColorConfig,
  resolveCaptionColor,
  resolveSpeakerColorKey
};
