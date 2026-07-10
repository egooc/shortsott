const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  PROJECT_ROOT,
  ensureProjectFolders,
  readJsonIfExists,
  writeJsonWithBackup
} = require('./pipelinePaths');
const { defaultConfig, normalizeConfig, createProcessDraft } = require('./processEditService');
const { assertOttogiGuideLanguage } = require('./processMetadataService');
const { getVideoMetadata } = require('../utils/ffprobe');
const { classifySourceVideo, normalizeSourceMode } = require('../utils/sourceClassifier');
const { computeCutSelectionTier, cutSelectionTierRank } = require('../utils/cutSelectionTier');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');
const { downloadYoutubeVideo } = require('./youtubeDownloadService');
const {
  getUploadExt,
  getUploadOriginalName,
  normalizePossiblyMojibakeFilename
} = require('../utils/uploadFilename');
const { markSourceProduced } = require('./sourceDiscoveryLibrary');

const QUEUE_ROOT = path.join(PROJECT_ROOT, 'queue', 'process');
const QUEUE_BGM_ROOT = path.join(QUEUE_ROOT, 'bgm');
const QUEUE_HIGHLIGHT_BGM_ROOT = path.join(QUEUE_ROOT, 'highlight_bgm');
const QUEUE_MIDFORM_BGM_ROOT = path.join(QUEUE_ROOT, 'midform_bgm');
const QUEUE_KOREAN_BGM_ROOT = path.join(QUEUE_ROOT, 'korean_bgm');
const QUEUE_KOREAN_HIGHLIGHT_BGM_ROOT = path.join(QUEUE_ROOT, 'korean_highlight_bgm');
const QUEUE_CHANNEL_ASSET_ROOT = path.join(QUEUE_ROOT, 'channel_asset');
const QUEUE_HIGHLIGHT_CHANNEL_ASSET_ROOT = path.join(QUEUE_ROOT, 'highlight_channel_asset');
const QUEUE_MIDFORM_CHANNEL_ASSET_ROOT = path.join(QUEUE_ROOT, 'midform_channel_asset');
const QUEUE_KOREAN_CHANNEL_ASSET_ROOT = path.join(QUEUE_ROOT, 'korean_channel_asset');
const QUEUE_KOREAN_HIGHLIGHT_CHANNEL_ASSET_ROOT = path.join(QUEUE_ROOT, 'korean_highlight_channel_asset');
const QUEUE_CONFIG_PATH = path.join(QUEUE_ROOT, 'queue_config.json');
const BATCH_OUTPUT_ROOT = path.join(PROJECT_ROOT, 'server', 'output', 'process_batches');
const QUEUE_RESERVED_DIRS = new Set([
  'bgm',
  'highlight_bgm',
  'midform_bgm',
  'korean_bgm',
  'korean_highlight_bgm',
  'channel_asset',
  'highlight_channel_asset',
  'midform_channel_asset',
  'korean_channel_asset',
  'korean_highlight_channel_asset',
  // Legacy frame asset folders are ignored so old uploads never appear as queue items.
  'channel_frame_asset',
  'highlight_channel_frame_asset',
  'korean_channel_frame_asset',
  'korean_highlight_channel_frame_asset'
]);
const MAX_YOUTUBE_IMPORT_URLS = 20;
const YOUTUBE_IMPORT_DELAY_MIN_MS = 15_000;
const YOUTUBE_IMPORT_DELAY_MAX_MS = 35_000;
const MAX_LONGFORM_HIGHLIGHT_CANDIDATES = 8;
const SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC = 10;
const LONGFORM_HIGHLIGHT_MAX_DURATION_SEC = 24;
const LONGFORM_HIGHLIGHT_DEFAULT_DURATION_SEC = 16;
const TEXT_DETECT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'detect_text_regions.py');
const FULL_DRAFT_MIN_RESULT_SEC = 10;
const MIDFORM_DRAFT_MIN_RESULT_SEC = 60;
const FULL_DRAFT_MIN_SOURCE_SEC = FULL_DRAFT_MIN_RESULT_SEC;
const FULL_DRAFT_REVIEW_MIN_SOURCE_SEC = 20;
const FULL_CAPTION_SAFE_MAX_CHARS = {
  ja: 10,
  ko: 12
};
const OCR_FAST_SCAN = {
  fullIntervalSec: 3,
  fullMaxFrames: 6,
  variantIntervalSec: 2,
  variantMaxFrames: 4
};
const FIXED_BLUR_MASK = Object.freeze({
  x: 0,
  y: 0.74,
  width: 0.62,
  height: 0.09
});
const VARIANT_TEMPLATE_DRAFT_NAMES = {
  jp_full: 'sample draft jp full',
  jp_highlight: 'sample draft jp highlight',
  jp_midform: 'sample draft jp midform',
  kr_full: 'sample draft kr full',
  kr_highlight: 'sample draft kr highlight'
};

function ensureQueueFolders() {
  ensureProjectFolders();
  fs.mkdirSync(QUEUE_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_BGM_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_HIGHLIGHT_BGM_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_MIDFORM_BGM_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_KOREAN_BGM_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_KOREAN_HIGHLIGHT_BGM_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_CHANNEL_ASSET_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_HIGHLIGHT_CHANNEL_ASSET_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_MIDFORM_CHANNEL_ASSET_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_KOREAN_CHANNEL_ASSET_ROOT, { recursive: true });
  fs.mkdirSync(QUEUE_KOREAN_HIGHLIGHT_CHANNEL_ASSET_ROOT, { recursive: true });
  fs.mkdirSync(BATCH_OUTPUT_ROOT, { recursive: true });
}

function safeId(value, fallback = '') {
  const cleaned = String(value || fallback || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  return cleaned || fallback;
}

function resolveOutputRoot(outputRoot) {
  const configured = String(outputRoot || '').trim();
  if (!configured) return BATCH_OUTPUT_ROOT;
  return path.resolve(configured);
}

function validateOutputRoot(outputRoot) {
  ensureQueueFolders();
  const resolvedPath = resolveOutputRoot(outputRoot);
  const exists = fs.existsSync(resolvedPath);
  let canCreate = exists;
  let writable = false;
  let message = exists ? 'output root exists' : 'output root does not exist but can be created';

  try {
    fs.mkdirSync(resolvedPath, { recursive: true });
    canCreate = true;
    const probePath = path.join(resolvedPath, `.write_test_${Date.now()}`);
    fs.writeFileSync(probePath, 'ok', 'utf8');
    if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
    writable = true;
  } catch (error) {
    writable = false;
    message = error.message;
  }

  return {
    output_root: outputRoot || '',
    resolvedPath,
    exists,
    canCreate,
    writable,
    message
  };
}


function normalizeDraftVariantMode(value = 'all') {
  const mode = String(value || 'all').trim();
  return ['all', 'full_highlight_only', 'full_only', 'highlight_only', 'midform_only'].includes(mode) ? mode : 'all';
}

function effectiveDraftVariantModeForItem(draftVariantMode = 'all', itemConfig = {}) {
  const normalized = normalizeDraftVariantMode(draftVariantMode);
  if (normalized === 'highlight_only' && isLongformHighlightSource(itemConfig)) {
    return 'full_highlight_only';
  }
  return normalized;
}

function highlightMaxDurationForItem(itemConfig = {}, requestedDurationSec = 0) {
  const requested = Number(requestedDurationSec || 0);
  if (isLongformHighlightSource(itemConfig)) {
    return Math.min(
      LONGFORM_HIGHLIGHT_MAX_DURATION_SEC,
      Math.max(LONGFORM_HIGHLIGHT_DEFAULT_DURATION_SEC, requested || LONGFORM_HIGHLIGHT_DEFAULT_DURATION_SEC)
    );
  }
  return Math.min(SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC, Math.max(1, requested || SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC));
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function defaultQueueConfig() {
  const base = defaultConfig();
  return {
    mode: 'ultra_efficiency_process_batch',
    batch_name: 'process_batch_001',
    channel_tag: base.channel_tag,
    channel_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'top_left',
      scale: 0.34,
      opacity: 1,
      replace_channel_tag_text: false
    },
    highlight_channel_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'top_right',
      scale: 0.34,
      opacity: 1,
      replace_channel_tag_text: false
    },
    midform_channel_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'top_right',
      scale: 0.34,
      opacity: 1,
      replace_channel_tag_text: false
    },
    korean_channel_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'top_right',
      scale: 0.34,
      opacity: 1,
      replace_channel_tag_text: false
    },
    korean_highlight_channel_asset: {
      enabled: false,
      path: '',
      original_name: '',
      position: 'top_right',
      scale: 0.34,
      opacity: 1,
      replace_channel_tag_text: false
    },
    capcut_template_id: base.capcut_template_id,
    capcut_template_source: base.capcut_template_source,
    capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.jp_full,
    jp_full_capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.jp_full,
    jp_highlight_capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.jp_highlight,
    jp_midform_capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.jp_midform,
    korean_capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.kr_full,
    kr_full_capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.kr_full,
    kr_highlight_capcut_template_draft_name: VARIANT_TEMPLATE_DRAFT_NAMES.kr_highlight,
    capcut_template_search_root: base.capcut_template_search_root,
    video_transform_preset: base.video_transform_preset,
    source_preprocess: base.source_preprocess,
    use_bgm: false,
    bgm_preset: base.bgm_preset,
    custom_bgm_path: '',
    custom_bgm_original_name: '',
    highlight_bgm_preset: base.bgm_preset,
    highlight_custom_bgm_path: '',
    highlight_custom_bgm_original_name: '',
    highlight_bgm_volume: base.bgm_volume,
    midform_bgm_preset: base.bgm_preset,
    midform_custom_bgm_path: '',
    midform_custom_bgm_original_name: '',
    midform_bgm_volume: base.bgm_volume,
    korean_custom_bgm_path: '',
    korean_custom_bgm_original_name: '',
    korean_highlight_custom_bgm_path: '',
    korean_highlight_custom_bgm_original_name: '',
    korean_bgm_volume: base.bgm_volume,
    korean_highlight_bgm_volume: base.bgm_volume,
    bgm_volume: base.bgm_volume,
    use_tts: false,
    output: {
      mode: 'capcut_draft_root',
      output_root: '',
      create_zip: false,
      create_individual_zips: false,
      create_batch_report: true
    },
    create_highlight_draft: false,
    create_midform_draft: true,
    create_korean_drafts: false,
    highlight_duration_sec: 10,
    midform_duration_sec: 120,
    full_preroll_hook: {
      enabled: true,
      duration_sec: 2.2,
      max_source_duration_sec: 3.0,
      zoom_scale: 1.58,
      pan_x: 0,
      pan_y: -0.03,
      rotation: -2.4,
      speed: 0.92,
      mirror: true,
      caption_ja: 'これ何だろう',
      caption_ko: '이게 뭔지 아세요?'
    }
  };
}

function findStoredQueueAsset(assetRoot, prefix) {
  if (!assetRoot || !fs.existsSync(assetRoot)) return '';
  const files = fs.readdirSync(assetRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'));
  if (!files.length) return '';

  const preferred = files.find((name) => path.parse(name).name === prefix)
    || files.find((name) => name.startsWith(prefix))
    || files[0];
  return preferred ? path.join(assetRoot, preferred) : '';
}

function normalizeQueueAssetConfig(rawConfig = {}, defaults = {}, assetRoot = '', prefix = 'channel_asset') {
  const raw = rawConfig || {};
  const configuredPath = String(raw.path || '').trim();
  const configuredExists = configuredPath && fs.existsSync(configuredPath);
  const storedPath = configuredExists ? configuredPath : findStoredQueueAsset(assetRoot, prefix);
  const originalName = normalizePossiblyMojibakeFilename(raw.original_name || (storedPath ? path.basename(storedPath) : ''));
  const wanted = raw.enabled === true || Boolean(configuredPath) || Boolean(originalName) || Boolean(storedPath);
  const missing = wanted && !storedPath;

  return {
    ...defaults,
    ...raw,
    enabled: wanted ? raw.enabled === true || Boolean(storedPath) : false,
    path: storedPath || '',
    original_name: originalName,
    position: String(raw.position || defaults.position || 'top_left'),
    scale: Number(raw.scale) > 0 ? Number(raw.scale) : (defaults.scale || 0.34),
    opacity: Number(raw.opacity) >= 0 ? Number(raw.opacity) : (defaults.opacity ?? 1),
    replace_channel_tag_text: raw.replace_channel_tag_text === true,
    exists: Boolean(storedPath),
    missing,
    missing_path: missing ? configuredPath : ''
  };
}

function getQueueAssetReadinessIssues(queueConfig = {}, draftVariantMode = 'all') {
  const issues = [];
  const normalizedDraftVariantMode = normalizeDraftVariantMode(draftVariantMode);
  const wantsFullAssets = ['all', 'full_highlight_only', 'full_only'].includes(normalizedDraftVariantMode);
  const wantsHighlightAssets = ['all', 'full_highlight_only', 'highlight_only'].includes(normalizedDraftVariantMode);
  const wantsMidformAssets = ['all', 'midform_only'].includes(normalizedDraftVariantMode);
  const channelAsset = queueConfig.channel_asset || {};
  const highlightAsset = queueConfig.highlight_channel_asset || {};
  const midformAsset = queueConfig.midform_channel_asset || {};
  const koreanAsset = queueConfig.korean_channel_asset || {};
  const koreanHighlightAsset = queueConfig.korean_highlight_channel_asset || {};

  if (wantsFullAssets && (channelAsset.enabled || channelAsset.original_name || channelAsset.missing_path) && !channelAsset.path) {
    issues.push(
      `풀 드래프트 로고 파일을 찾을 수 없습니다. 로고/GIF/MP4를 다시 업로드하세요.`
        + (channelAsset.missing_path ? ` 기존 경로: ${channelAsset.missing_path}` : '')
    );
  }

  if (
    wantsHighlightAssets
    && queueConfig.create_highlight_draft === true
    && (highlightAsset.enabled || highlightAsset.original_name || highlightAsset.missing_path)
    && !highlightAsset.path
    && !channelAsset.path
  ) {
    issues.push(
      `하이라이트 로고 파일을 찾을 수 없습니다. 하이라이트 로고/GIF/MP4를 다시 업로드하거나 풀 드래프트 로고를 먼저 업로드하세요.`
        + (highlightAsset.missing_path ? ` 기존 경로: ${highlightAsset.missing_path}` : '')
    );
  }

  if (
    wantsMidformAssets
    && queueConfig.create_midform_draft !== false
    && !midformAsset.path
  ) {
    issues.push(
      `미드폼 로고가 필요합니다. 미드폼은 별도 채널 자산을 사용하므로 미드폼 로고/GIF/MP4를 업로드해야 합니다.`
        + (midformAsset.missing_path ? ` 기존 경로: ${midformAsset.missing_path}` : '')
    );
  }

  if (wantsMidformAssets && queueConfig.create_midform_draft !== false && !queueConfig.midform_custom_bgm_path) {
    issues.push('미드폼 BGM이 필요합니다. 미드폼은 별도 채널 자산을 사용하므로 미드폼 BGM 파일을 업로드해야 합니다.');
  }

  if (
    wantsFullAssets
    && queueConfig.create_korean_drafts === true
    && (koreanAsset.enabled || koreanAsset.original_name || koreanAsset.missing_path)
    && !koreanAsset.path
    && !channelAsset.path
  ) {
    issues.push(
      `한국어 풀 드래프트 로고 파일을 찾을 수 없습니다. 한국어 로고/GIF/MP4를 다시 업로드하거나 기본 풀 로고를 먼저 업로드하세요.`
        + (koreanAsset.missing_path ? ` 기존 경로: ${koreanAsset.missing_path}` : '')
    );
  }

  if (
    wantsHighlightAssets
    && queueConfig.create_highlight_draft === true
    && queueConfig.create_korean_drafts === true
    && (koreanHighlightAsset.enabled || koreanHighlightAsset.original_name || koreanHighlightAsset.missing_path)
    && !koreanHighlightAsset.path
    && !koreanAsset.path
    && !highlightAsset.path
    && !channelAsset.path
  ) {
    issues.push(
      `한국어 하이라이트 로고 파일을 찾을 수 없습니다. 한국어 하이라이트 로고/GIF/MP4를 다시 업로드하거나 다른 로고를 먼저 업로드하세요.`
        + (koreanHighlightAsset.missing_path ? ` 기존 경로: ${koreanHighlightAsset.missing_path}` : '')
    );
  }

  return issues;
}

function normalizeFullPrerollHookConfig(rawConfig = {}, defaults = {}) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const enabled = raw.enabled !== false;
  return {
    ...defaults,
    ...raw,
    enabled,
    duration_sec: Number(raw.duration_sec) > 0
      ? Math.min(4, Math.max(0.8, Number(raw.duration_sec)))
      : defaults.duration_sec,
    max_source_duration_sec: Number(raw.max_source_duration_sec) > 0
      ? Math.min(6, Math.max(0.8, Number(raw.max_source_duration_sec)))
      : defaults.max_source_duration_sec,
    zoom_scale: Number(raw.zoom_scale) > 0
      ? Math.min(1.9, Math.max(1.2, Number(raw.zoom_scale)))
      : defaults.zoom_scale,
    pan_x: Number.isFinite(Number(raw.pan_x)) ? Math.min(0.16, Math.max(-0.16, Number(raw.pan_x))) : defaults.pan_x,
    pan_y: Number.isFinite(Number(raw.pan_y)) ? Math.min(0.16, Math.max(-0.16, Number(raw.pan_y))) : defaults.pan_y,
    rotation: Number.isFinite(Number(raw.rotation)) ? Math.min(3, Math.max(-3, Number(raw.rotation))) : defaults.rotation,
    speed: Number(raw.speed) > 0 ? Math.min(1.55, Math.max(0.65, Number(raw.speed))) : defaults.speed,
    mirror: raw.mirror !== false,
    caption_ja: String(raw.caption_ja || defaults.caption_ja || 'これ何だろう').trim(),
    caption_ko: String(raw.caption_ko || defaults.caption_ko || '이게 뭔지 아세요?').trim()
  };
}

function forceQueueAssetTopRight(asset = {}) {
  return {
    ...(asset || {}),
    position: 'top_right'
  };
}

function assertQueueAssetsReady(queueConfig = {}, draftVariantMode = 'all') {
  const issues = getQueueAssetReadinessIssues(queueConfig, draftVariantMode);
  if (!issues.length) return;
  const error = new Error(issues.join('\n'));
  error.status = 400;
  error.code = 'QUEUE_ASSET_MISSING';
  error.details = { issues };
  throw error;
}

function normalizeQueueConfig(config = {}) {
  const defaults = defaultQueueConfig();
  const normalizedVideoPreset = normalizeConfig({
    video_transform_preset: config.video_transform_preset || defaults.video_transform_preset
  }).video_transform_preset;
  const normalizedSourcePreprocess = normalizeConfig({
    source_preprocess: config.source_preprocess || defaults.source_preprocess
  }).source_preprocess;
  const normalizedChannelAsset = normalizeQueueAssetConfig(
    config.channel_asset || {},
    defaults.channel_asset,
    QUEUE_CHANNEL_ASSET_ROOT,
    'channel_asset'
  );
  const normalizedHighlightChannelAsset = normalizeQueueAssetConfig(
    config.highlight_channel_asset || {},
    defaults.highlight_channel_asset,
    QUEUE_HIGHLIGHT_CHANNEL_ASSET_ROOT,
    'highlight_channel_asset'
  );
  const normalizedMidformChannelAsset = normalizeQueueAssetConfig(
    config.midform_channel_asset || {},
    defaults.midform_channel_asset,
    QUEUE_MIDFORM_CHANNEL_ASSET_ROOT,
    'midform_channel_asset'
  );
  const normalizedKoreanChannelAsset = normalizeQueueAssetConfig(
    config.korean_channel_asset || {},
    defaults.korean_channel_asset,
    QUEUE_KOREAN_CHANNEL_ASSET_ROOT,
    'korean_channel_asset'
  );
  const normalizedKoreanHighlightChannelAsset = normalizeQueueAssetConfig(
    config.korean_highlight_channel_asset || {},
    defaults.korean_highlight_channel_asset,
    QUEUE_KOREAN_HIGHLIGHT_CHANNEL_ASSET_ROOT,
    'korean_highlight_channel_asset'
  );
  return {
    ...defaults,
    ...config,
    mode: 'ultra_efficiency_process_batch',
    video_transform_preset: normalizedVideoPreset,
    source_preprocess: normalizedSourcePreprocess,
    channel_asset: normalizedChannelAsset,
    highlight_channel_asset: normalizedHighlightChannelAsset,
    midform_channel_asset: forceQueueAssetTopRight(normalizedMidformChannelAsset),
    korean_channel_asset: forceQueueAssetTopRight(normalizedKoreanChannelAsset),
    korean_highlight_channel_asset: forceQueueAssetTopRight(normalizedKoreanHighlightChannelAsset),
    channel_frame_asset: undefined,
    highlight_channel_frame_asset: undefined,
    korean_channel_frame_asset: undefined,
    korean_highlight_channel_frame_asset: undefined,
    custom_bgm_path: String(config.custom_bgm_path || defaults.custom_bgm_path || ''),
    custom_bgm_original_name: normalizePossiblyMojibakeFilename(config.custom_bgm_original_name || defaults.custom_bgm_original_name || ''),
    capcut_template_source: String(config.capcut_template_source || defaults.capcut_template_source || 'capcut_draft_root'),
    capcut_template_draft_name: String(config.capcut_template_draft_name || config.jp_full_capcut_template_draft_name || defaults.capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.jp_full),
    jp_full_capcut_template_draft_name: String(config.jp_full_capcut_template_draft_name || config.capcut_template_draft_name || defaults.jp_full_capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.jp_full),
    jp_highlight_capcut_template_draft_name: String(config.jp_highlight_capcut_template_draft_name || defaults.jp_highlight_capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.jp_highlight),
    jp_midform_capcut_template_draft_name: String(config.jp_midform_capcut_template_draft_name || defaults.jp_midform_capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.jp_midform),
    korean_capcut_template_draft_name: String(config.korean_capcut_template_draft_name || config.kr_full_capcut_template_draft_name || defaults.korean_capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.kr_full),
    kr_full_capcut_template_draft_name: String(config.kr_full_capcut_template_draft_name || config.korean_capcut_template_draft_name || defaults.kr_full_capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.kr_full),
    kr_highlight_capcut_template_draft_name: String(config.kr_highlight_capcut_template_draft_name || defaults.kr_highlight_capcut_template_draft_name || VARIANT_TEMPLATE_DRAFT_NAMES.kr_highlight),
    capcut_template_search_root: String(config.capcut_template_search_root || defaults.capcut_template_search_root || ''),
    highlight_bgm_preset: String(config.highlight_bgm_preset || defaults.highlight_bgm_preset || ''),
    highlight_custom_bgm_path: String(config.highlight_custom_bgm_path || defaults.highlight_custom_bgm_path || ''),
    highlight_custom_bgm_original_name: normalizePossiblyMojibakeFilename(config.highlight_custom_bgm_original_name || defaults.highlight_custom_bgm_original_name || ''),
    highlight_bgm_volume: Number(config.highlight_bgm_volume) >= 0 ? Number(config.highlight_bgm_volume) : defaults.highlight_bgm_volume,
    midform_bgm_preset: String(config.midform_bgm_preset || defaults.midform_bgm_preset || ''),
    midform_custom_bgm_path: String(config.midform_custom_bgm_path || defaults.midform_custom_bgm_path || ''),
    midform_custom_bgm_original_name: normalizePossiblyMojibakeFilename(config.midform_custom_bgm_original_name || defaults.midform_custom_bgm_original_name || ''),
    midform_bgm_volume: Number(config.midform_bgm_volume) >= 0 ? Number(config.midform_bgm_volume) : defaults.midform_bgm_volume,
    korean_custom_bgm_path: String(config.korean_custom_bgm_path || defaults.korean_custom_bgm_path || ''),
    korean_custom_bgm_original_name: normalizePossiblyMojibakeFilename(config.korean_custom_bgm_original_name || defaults.korean_custom_bgm_original_name || ''),
    korean_highlight_custom_bgm_path: String(config.korean_highlight_custom_bgm_path || defaults.korean_highlight_custom_bgm_path || ''),
    korean_highlight_custom_bgm_original_name: normalizePossiblyMojibakeFilename(config.korean_highlight_custom_bgm_original_name || defaults.korean_highlight_custom_bgm_original_name || ''),
    korean_bgm_volume: Number(config.korean_bgm_volume) >= 0 ? Number(config.korean_bgm_volume) : defaults.korean_bgm_volume,
    korean_highlight_bgm_volume: Number(config.korean_highlight_bgm_volume) >= 0 ? Number(config.korean_highlight_bgm_volume) : defaults.korean_highlight_bgm_volume,
    use_bgm: !!String(config.custom_bgm_path || defaults.custom_bgm_path || ''),
    create_highlight_draft: config.create_highlight_draft === true,
    create_midform_draft: config.create_midform_draft !== false,
    create_korean_drafts: false,
    highlight_duration_sec: Number(config.highlight_duration_sec) > 0
      ? Math.min(LONGFORM_HIGHLIGHT_MAX_DURATION_SEC, Number(config.highlight_duration_sec))
      : defaults.highlight_duration_sec,
    midform_duration_sec: Number(config.midform_duration_sec) > 0
      ? Math.min(130, Math.max(90, Number(config.midform_duration_sec)))
      : defaults.midform_duration_sec,
    full_preroll_hook: normalizeFullPrerollHookConfig(config.full_preroll_hook, defaults.full_preroll_hook),
    output: {
      ...defaults.output,
      ...(config.output || {}),
      mode: (config.output || {}).mode || 'capcut_draft_root',
      create_zip: (config.output || {}).create_zip === true
    }
  };
}

function defaultItemConfig(itemId) {
  return {
    item_id: itemId,
    source_video: 'source_clean.mp4',
    target_duration_sec: 30,
    upload_title: '',
    upload_description: '',
    upload_hashtags: [],
    source_type: 'unknown',
    source_type_origin: 'default',
    source_workflow_mode: 'unknown',
    source_classification: {
      duration_sec: 0,
      width: 0,
      height: 0,
      orientation: 'unknown',
      requested_mode: 'auto',
      reason: 'source has not been analyzed yet',
      confidence: 'low',
      classified_at: ''
    },
    output_language: 'ja',
    review_language: 'ko',
    korean_review: {
      short_description: '',
      explainer_text: '',
      recommended_titles: [],
      report_description: ''
    },
    explainer_blocks: [
      {
        block_id: 'exp_001',
        text: 'この工程で重要な変化が始まる場面です。',
        start_sec: 0,
        end_sec: 30,
        style_role: 'main_explainer',
        anchor_zone: 'lower_third',
        animation: 'pop_in'
      }
    ]
  };
}

function getItemDir(itemId) {
  return path.join(QUEUE_ROOT, safeId(itemId, 'item_001'));
}

function getItemConfigPath(itemId) {
  return path.join(getItemDir(itemId), 'item_config.json');
}

function getItemOcrReportPath(itemId) {
  return path.join(getItemDir(itemId), 'ocr_text_regions.json');
}

function getItemOcrPreviewPath(itemId) {
  return path.join(getItemDir(itemId), 'ocr_preview.jpg');
}

function getItemVariantOcrReportPath(itemId, variant) {
  return path.join(getItemDir(itemId), `${safeId(variant, 'variant')}_ocr_text_regions.json`);
}

function getItemVariantOcrPreviewPath(itemId, variant) {
  return path.join(getItemDir(itemId), `${safeId(variant, 'variant')}_ocr_preview.jpg`);
}

function getItemOcrReviewPath(itemId) {
  return path.join(getItemDir(itemId), 'ocr_mask_review.json');
}

function getItemOcrApprovedReportPath(itemId) {
  return path.join(getItemDir(itemId), 'ocr_text_regions.approved.json');
}

function nextItemId(existingIds = []) {
  const used = new Set(existingIds);
  let index = 1;
  while (used.has(`item_${String(index).padStart(3, '0')}`)) {
    index += 1;
  }
  return `item_${String(index).padStart(3, '0')}`;
}

function titleFromFilename(filename = '') {
  const parsed = path.parse(filename);
  return parsed.name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromUrl(url = '') {
  try {
    const parsed = new URL(String(url || '').trim());
    const videoId = parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop() || '';
    return videoId ? `youtube_${videoId}` : 'youtube_source';
  } catch {
    return 'youtube_source';
  }
}

function draftFolderNameFromTitle(title, fallback) {
  const cleaned = String(title || fallback || '')
    .trim()
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return cleaned || safeId(fallback, `draft_${Date.now()}`);
}

function metadataPackageFileNameFromTitle(title, fallback) {
  return `${draftFolderNameFromTitle(stripHashtagsFromTitle(title, fallback), fallback)}.txt`;
}

function stripHashtagsFromTitle(title, fallback = '') {
  return String(title || fallback || '')
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDraftStartStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function formatDraftDateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('');
}

function draftFolderNameForBatchItem({ startedAtStamp, itemNumber, variant, title, fallback }) {
  const variantPart = String(variant || 'F').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'F';
  const stamp = String(startedAtStamp || formatDraftStartStamp()).trim();
  const [datePartRaw, timePartRaw] = stamp.split('_');
  const datePart = String(datePartRaw || formatDraftDateStamp()).replace(/[^0-9]/g, '').slice(0, 8) || formatDraftDateStamp();
  const timePart = String(timePartRaw || '').replace(/[^0-9]/g, '').slice(0, 6) || stamp.replace(/[^0-9]/g, '').slice(8, 14) || '000000';
  const prefix = `${datePart}-${variantPart}-${timePart}`;
  const cleanTitle = draftFolderNameFromTitle(stripHashtagsFromTitle(title, fallback), fallback);
  const maxTitleLength = Math.max(12, 110 - prefix.length - 1);
  const titlePart = cleanTitle.slice(0, maxTitleLength).replace(/[. _-]+$/g, '');
  return `${prefix}-${titlePart || safeId(fallback, `draft_${Date.now()}`)}`.slice(0, 120);
}

function draftFolderNameWithSuffix(title, suffix, fallback) {
  const safeSuffix = String(suffix || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '');
  const suffixPart = safeSuffix ? `_${safeSuffix}` : '';
  const maxBaseLength = Math.max(12, 80 - suffixPart.length);
  const base = draftFolderNameFromTitle(title, fallback).slice(0, maxBaseLength).replace(/[. _-]+$/g, '');
  return `${base || safeId(fallback, `draft_${Date.now()}`)}${suffixPart}`;
}

function draftFolderNameWithPrefix(prefix, title, fallback) {
  const safePrefix = String(prefix || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, '_').replace(/[. _-]+$/g, '');
  const prefixPart = safePrefix ? `${safePrefix}_` : '';
  const maxTitleLength = Math.max(12, 80 - prefixPart.length);
  const titlePart = draftFolderNameFromTitle(title, fallback).slice(0, maxTitleLength).replace(/[. _-]+$/g, '');
  return `${prefixPart}${titlePart || safeId(fallback, `draft_${Date.now()}`)}`.slice(0, 80);
}

function loadQueueConfig() {
  ensureQueueFolders();
  const saved = readJsonIfExists(QUEUE_CONFIG_PATH);
  return normalizeQueueConfig(saved || {});
}

function saveQueueConfig(config) {
  ensureQueueFolders();
  const merged = normalizeQueueConfig(config || {});
  return writeJsonWithBackup(QUEUE_CONFIG_PATH, merged);
}

function parseCapcutTextContent(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  if (typeof content !== 'string') return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getCapcutMaterialText(material = {}) {
  const content = parseCapcutTextContent(material.content);
  return String(content?.text || material.text || material.content || '').trim();
}

function detectCapcutTemplateMarker(text) {
  const value = String(text || '');
  const markers = [
    'TEMPLATE_FULL_CAPTION',
    'TEMPLATE_HIGHLIGHT_EXPLAINER',
    'TEMPLATE_EXPLAINER'
  ];
  return markers.find((marker) => value.includes(marker)) || '';
}

function expectedCaptionTemplateMarkersForVariant(variant) {
  const key = String(variant || '').toLowerCase();
  if (key.includes('highlight')) return ['TEMPLATE_HIGHLIGHT_EXPLAINER'];
  return ['TEMPLATE_FULL_CAPTION'];
}

function findDraftContentPathInFolder(folderPath, maxDepth = 2) {
  const root = String(folderPath || '').trim();
  if (!root || !fs.existsSync(root)) return '';
  const direct = path.join(root, 'draft_content.json');
  if (fs.existsSync(direct)) return direct;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childDir = path.join(dir, entry.name);
      const childDraft = path.join(childDir, 'draft_content.json');
      if (fs.existsSync(childDraft)) return childDraft;
      queue.push({ dir: childDir, depth: depth + 1 });
    }
  }
  return '';
}

function summarizeTemplateAnimations(segment = {}, materialIndex = new Map()) {
  const refs = Array.isArray(segment.extra_material_refs) ? segment.extra_material_refs : [];
  const animations = [];
  for (const refId of refs) {
    const material = materialIndex.get(refId);
    if (!material) continue;
    const animationItems = Array.isArray(material.animations) ? material.animations : [];
    if (!animationItems.length && material.type !== 'sticker_animation') continue;
    animations.push({
      ref_id: refId,
      type: material.type || '',
      count: animationItems.length,
      items: animationItems.map((item) => ({
        id: item?.id || '',
        type: item?.type || '',
        name: item?.name || '',
        duration_sec: Number(item?.duration || 0) ? Number((Number(item.duration) / 1_000_000).toFixed(3)) : 0,
        resource_id: item?.resource_id || '',
        path: item?.path || ''
      }))
    });
  }
  return {
    has_animation: animations.length > 0,
    refs_count: animations.length,
    animations
  };
}

function summarizeTemplateTextStyle(material = {}, segment = {}, marker = '', materialIndex = new Map()) {
  const content = parseCapcutTextContent(material.content) || {};
  const firstStyle = Array.isArray(content.styles) && content.styles.length ? content.styles[0] : {};
  const contentFont = firstStyle?.font && typeof firstStyle.font === 'object' ? firstStyle.font : {};
  const fillSolid = firstStyle?.fill?.content?.solid || {};
  const firstStroke = Array.isArray(firstStyle?.strokes) && firstStyle.strokes.length ? firstStyle.strokes[0] : {};
  const strokeSolid = firstStroke?.content?.solid || {};
  const clip = segment.clip && typeof segment.clip === 'object' ? segment.clip : {};
  const transform = clip.transform && typeof clip.transform === 'object' ? clip.transform : {};
  const scale = clip.scale && typeof clip.scale === 'object' ? clip.scale : {};
  const resolvedFontPath = contentFont.path || material.font_path || '';
  const resolvedFontName = contentFont.name || contentFont.title || '';
  const fontFileName = resolvedFontPath ? path.basename(resolvedFontPath) : '';
  return {
    marker,
    material_id: material.id || '',
    segment_id: segment.id || '',
    text_color: material.text_color || '',
    fill_rgb: Array.isArray(fillSolid.color) ? fillSolid.color : null,
    font_size: Number(firstStyle.size || material.font_size || 0) || 0,
    font_name: resolvedFontName || material.font_name || material.font_title || '',
    font_title: contentFont.title || contentFont.name || material.font_title || material.font_name || '',
    font_display_name: resolvedFontName || fontFileName || material.font_name || material.font_title || '',
    font_file_name: fontFileName,
    font_id: contentFont.id || material.font_id || '',
    font_path: resolvedFontPath,
    border_color: material.border_color || '',
    border_width: Number(firstStroke.width || material.border_width || 0) || 0,
    stroke_rgb: Array.isArray(strokeSolid.color) ? strokeSolid.color : null,
    background_color: material.background_color || '',
    background_alpha: Number(material.background_alpha || 0) || 0,
    background_round_radius: Number(material.background_round_radius || 0) || 0,
    border_alpha: Number(material.border_alpha || firstStroke.alpha || 0) || 0,
    shadow_color: material.shadow_color || '',
    shadow_alpha: Number(material.shadow_alpha || 0) || 0,
    shadow_distance: Number(material.shadow_distance || 0) || 0,
    shadow_smoothing: Number(material.shadow_smoothing || 0) || 0,
    fixed_width: Number(material.fixed_width || 0),
    fixed_height: Number(material.fixed_height || 0),
    line_max_width: Number(material.line_max_width || 0),
    line_spacing: Number(material.line_spacing || 0),
    line_feed: material.line_feed ?? null,
    force_apply_line_max_width: material.force_apply_line_max_width ?? null,
    oneline_cutoff: material.oneline_cutoff ?? null,
    alignment: material.alignment ?? null,
    typesetting: material.typesetting ?? null,
    position: {
      x: Number(transform.x || 0),
      y: Number(transform.y || 0)
    },
    scale: {
      x: Number(scale.x || 1),
      y: Number(scale.y || 1)
    },
    animation: summarizeTemplateAnimations(segment, materialIndex)
  };
}

function scanCaptionTemplateDraft(draftRoot, draftName, options = {}) {
  const name = String(draftName || '').trim();
  const root = String(draftRoot || '').trim();
  const draftFolderPath = name && root ? path.join(root, name) : '';
  const draftPath = findDraftContentPathInFolder(draftFolderPath, 2);
  const expectedMarkers = Array.isArray(options.expectedMarkers) && options.expectedMarkers.length
    ? options.expectedMarkers
    : expectedCaptionTemplateMarkersForVariant(options.variant);
  const result = {
    variant: String(options.variant || '').trim(),
    draft_name: name,
    draft_root: root,
    draft_content_path: draftPath,
    found: false,
    expected_markers: expectedMarkers,
    missing_markers: expectedMarkers,
    duplicate_markers: {},
    markers: {},
    message: ''
  };
  if (!draftPath || !fs.existsSync(draftPath)) {
    result.message = 'sample draft_content.json not found';
    return result;
  }

  const doc = readJsonIfExists(draftPath);
  if (!doc) {
    result.message = 'sample draft_content.json could not be parsed';
    return result;
  }
  const materialIndex = new Map();
  for (const categoryItems of Object.values(doc.materials || {})) {
    if (!Array.isArray(categoryItems)) continue;
    for (const material of categoryItems) {
      if (material?.id) materialIndex.set(material.id, material);
    }
  }
  for (const track of doc.tracks || []) {
    if (!track || track.type !== 'text') continue;
    for (const segment of track.segments || []) {
      if (!segment || !segment.material_id) continue;
      const material = materialIndex.get(segment.material_id);
      if (!material) continue;
      const marker = detectCapcutTemplateMarker(getCapcutMaterialText(material));
      if (!marker) continue;
      if (expectedMarkers.length && !expectedMarkers.includes(marker)) continue;
      result.duplicate_markers[marker] = Number(result.duplicate_markers[marker] || 0) + 1;
      const currentStart = Number(segment?.target_timerange?.start || 0);
      const previousStart = Number(result.markers[marker]?.target_start_us ?? -1);
      if (result.markers[marker] && currentStart < previousStart) continue;
      result.markers[marker] = {
        ...summarizeTemplateTextStyle(material, segment, marker, materialIndex),
        target_start_us: currentStart,
        track_name: track.name || '',
        track_id: track.id || ''
      };
    }
  }
  result.found = true;
  result.missing_markers = expectedMarkers.filter((marker) => !result.markers[marker]);
  const duplicateSummary = Object.entries(result.duplicate_markers)
    .filter(([, count]) => Number(count) > 1)
    .map(([marker, count]) => `${marker} x${count}`);
  result.message = result.missing_markers.length
    ? `missing marker(s): ${result.missing_markers.join(', ')}`
    : duplicateSummary.length
      ? `caption template markers loaded; duplicate marker(s), using latest: ${duplicateSummary.join(', ')}`
      : 'caption template markers loaded';
  return result;
}

function syncCaptionTemplateSettings() {
  ensureQueueFolders();
  const queueConfig = loadQueueConfig();
  const outputRoot = String(
    queueConfig.capcut_template_search_root
      || queueConfig.output?.capcut_draft_root
      || queueConfig.output?.output_root
      || ''
  ).trim();
  const syncedAt = nowIso();
  const samples = {
    jp_full: scanCaptionTemplateDraft(outputRoot, selectVariantCapcutTemplateDraftName(queueConfig, 'jp_full'), {
      variant: 'jp_full',
      expectedMarkers: expectedCaptionTemplateMarkersForVariant('jp_full')
    }),
    jp_highlight: scanCaptionTemplateDraft(outputRoot, selectVariantCapcutTemplateDraftName(queueConfig, 'jp_highlight'), {
      variant: 'jp_highlight',
      expectedMarkers: expectedCaptionTemplateMarkersForVariant('jp_highlight')
    }),
    jp_midform: scanCaptionTemplateDraft(outputRoot, selectVariantCapcutTemplateDraftName(queueConfig, 'jp_midform'), {
      variant: 'jp_midform',
      expectedMarkers: expectedCaptionTemplateMarkersForVariant('jp_midform')
    }),
    kr_full: scanCaptionTemplateDraft(outputRoot, selectVariantCapcutTemplateDraftName(queueConfig, 'kr_full'), {
      variant: 'kr_full',
      expectedMarkers: expectedCaptionTemplateMarkersForVariant('kr_full')
    }),
    kr_highlight: scanCaptionTemplateDraft(outputRoot, selectVariantCapcutTemplateDraftName(queueConfig, 'kr_highlight'), {
      variant: 'kr_highlight',
      expectedMarkers: expectedCaptionTemplateMarkersForVariant('kr_highlight')
    })
  };
  samples.jp = samples.jp_full;
  samples.ko = samples.kr_full;
  const nextConfig = saveQueueConfig({
    ...queueConfig,
    caption_template_sync: {
      synced_at: syncedAt,
      draft_root: outputRoot,
      jp_full_draft_name: samples.jp_full.draft_name,
      jp_highlight_draft_name: samples.jp_highlight.draft_name,
      jp_midform_draft_name: samples.jp_midform.draft_name,
      kr_full_draft_name: samples.kr_full.draft_name,
      kr_highlight_draft_name: samples.kr_highlight.draft_name,
      jp_draft_name: samples.jp_full.draft_name,
      ko_draft_name: samples.kr_full.draft_name,
      jp_full_missing_markers: samples.jp_full.missing_markers,
      jp_highlight_missing_markers: samples.jp_highlight.missing_markers,
      jp_midform_missing_markers: samples.jp_midform.missing_markers,
      kr_full_missing_markers: samples.kr_full.missing_markers,
      kr_highlight_missing_markers: samples.kr_highlight.missing_markers,
      jp_missing_markers: samples.jp_full.missing_markers,
      ko_missing_markers: samples.kr_full.missing_markers,
      jp_full_markers_found: Object.keys(samples.jp_full.markers || {}),
      jp_highlight_markers_found: Object.keys(samples.jp_highlight.markers || {}),
      jp_midform_markers_found: Object.keys(samples.jp_midform.markers || {}),
      kr_full_markers_found: Object.keys(samples.kr_full.markers || {}),
      kr_highlight_markers_found: Object.keys(samples.kr_highlight.markers || {}),
      jp_markers_found: Object.keys(samples.jp_full.markers || {}),
      ko_markers_found: Object.keys(samples.kr_full.markers || {})
    }
  });
  return {
    status: 'success',
    synced_at: syncedAt,
    samples,
    queueConfig: nextConfig,
    queue: listQueue()
  };
}

function normalizeItemConfig(itemConfig, itemId) {
  const id = safeId(itemConfig?.item_id || itemId, itemId || `item_${Date.now()}`);
  const normalizedVideoPreset = itemConfig?.video_transform_preset
    ? normalizeConfig({ video_transform_preset: itemConfig.video_transform_preset }).video_transform_preset
    : '';
  const base = {
    ...defaultItemConfig(id),
    ...(itemConfig || {}),
    item_id: id,
    ...(normalizedVideoPreset ? { video_transform_preset: normalizedVideoPreset } : {})
  };
  const blocks = Array.isArray(base.explainer_blocks) && base.explainer_blocks.length
    ? base.explainer_blocks
    : defaultItemConfig(id).explainer_blocks;
  const existingClassification = base.source_classification && typeof base.source_classification === 'object'
    ? base.source_classification
    : {};
  const sourceType = ['shortform', 'longform', 'unknown'].includes(String(base.source_type || '').trim())
    ? String(base.source_type || '').trim()
    : 'unknown';
  const sourceWorkflowMode = ['shortform_direct', 'longform_to_shorts', 'unknown'].includes(String(base.source_workflow_mode || '').trim())
    ? String(base.source_workflow_mode || '').trim()
    : (sourceType === 'shortform' ? 'shortform_direct' : sourceType === 'longform' ? 'longform_to_shorts' : 'unknown');
  return {
    ...base,
    source_type: sourceType,
    source_type_origin: base.source_type_origin || 'default',
    source_workflow_mode: sourceWorkflowMode,
    source_classification: {
      duration_sec: Number(existingClassification.duration_sec || base.video_metadata?.duration_sec || 0),
      width: Number(existingClassification.width || base.video_metadata?.width || 0),
      height: Number(existingClassification.height || base.video_metadata?.height || 0),
      orientation: existingClassification.orientation || 'unknown',
      requested_mode: normalizeSourceMode(existingClassification.requested_mode || base.source_mode || 'auto'),
      reason: existingClassification.reason || '',
      confidence: existingClassification.confidence || 'low',
      classified_at: existingClassification.classified_at || ''
    },
    source_file_original_name: normalizePossiblyMojibakeFilename(base.source_file_original_name || ''),
    upload_hashtags: Array.isArray(base.upload_hashtags)
      ? base.upload_hashtags
      : String(base.upload_hashtags || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
    explainer_blocks: blocks
  };
}

function classifyItemSource({ metadata = {}, requestedMode = 'auto', origin = 'ffprobe' } = {}) {
  return classifySourceVideo({
    durationSec: metadata.duration_sec || metadata.durationSec || 0,
    width: metadata.width || 0,
    height: metadata.height || 0,
    requestedMode,
    origin
  });
}

function mergeSourceClassification(config = {}, classification = {}) {
  return {
    ...config,
    source_type: classification.source_type || config.source_type || 'unknown',
    source_type_origin: classification.source_type_origin || config.source_type_origin || 'auto',
    source_workflow_mode: classification.source_workflow_mode || config.source_workflow_mode || 'unknown',
    source_classification: {
      ...(config.source_classification || {}),
      ...(classification.source_classification || {})
    }
  };
}

function normalizeHashtags(tags = []) {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
  const normalized = [];
  for (const tag of values) {
    const raw = String(tag || '').trim();
    if (!raw) continue;
    const value = raw.startsWith('#') ? raw : `#${raw}`;
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function hasJapaneseText(value = '') {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(value || ''));
}

function isMostlyLatinText(value = '') {
  const text = String(value || '');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/gu) || []).length;
  return latin >= 12 && latin > japanese * 2;
}

function stripEmoji(value = '') {
  return String(value || '').replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '').trim();
}

function cleanJapaneseCaptionCandidate(value = '') {
  const text = stripEmoji(value);
  if (!text) return '';
  if (!hasJapaneseText(text) || isMostlyLatinText(text)) return '';
  return text;
}

function normalizeSceneTransitions(transitions = [], durationSec = 0) {
  if (!Array.isArray(transitions)) return [];
  const maxDuration = Number(durationSec) > 0 ? Number(durationSec) : 0;
  const validFocusZones = new Set([
    'center',
    'left',
    'right',
    'top',
    'bottom',
    'center_left',
    'center_right',
    'upper_left',
    'upper_right',
    'lower_left',
    'lower_right'
  ]);
  const validMoves = new Set([
    'static',
    'slow_zoom_in',
    'punch_zoom',
    'zoom_out',
    'scan_left',
    'scan_right',
    'tilt_up',
    'tilt_down',
    'speed_up',
    'slow_motion'
  ]);
  const validIntensities = new Set(['low', 'medium', 'high']);
  return transitions
    .map((item, index) => {
      const start = Number(item?.start_sec);
      const end = Number(item?.end_sec);
      const transition = Number(item?.transition_at_sec ?? item?.end_sec);
      if (!Number.isFinite(transition) || transition <= 0) return null;
      const clampedTransition = maxDuration > 0 ? Math.min(transition, maxDuration) : transition;
      const clampedStart = Number.isFinite(start) ? Math.max(0, maxDuration > 0 ? Math.min(start, maxDuration) : start) : 0;
      const clampedEnd = Number.isFinite(end) ? Math.max(clampedStart, maxDuration > 0 ? Math.min(end, maxDuration) : end) : clampedTransition;
      const screenCaptionsJa = Array.isArray(item?.screen_captions_ja)
        ? item.screen_captions_ja.map(cleanJapaneseCaptionCandidate).filter(Boolean)
        : [];
      const captionTextFull = cleanJapaneseCaptionCandidate(item?.caption_text) ||
        cleanJapaneseCaptionCandidate(item?.caption_text_full) ||
        screenCaptionsJa[0] ||
        '';
      return {
        scene_id: String(item?.scene_id || `scene_${String(index + 1).padStart(3, '0')}`),
        start_sec: Number(clampedStart.toFixed(3)),
        end_sec: Number(clampedEnd.toFixed(3)),
        transition_at_sec: Number(clampedTransition.toFixed(3)),
        visual_summary: String(item?.visual_summary || '').trim(),
        caption_text_full: captionTextFull,
        text: captionTextFull,
        caption_text_ko: clampCaptionLine(item?.caption_text_ko || ''),
        screen_captions_ja: screenCaptionsJa.length ? screenCaptionsJa : [captionTextFull].filter(Boolean),
        screen_captions_ko: Array.isArray(item?.screen_captions_ko)
          ? item.screen_captions_ko.map((text) => String(text || '').trim()).filter(Boolean)
          : [],
        change_type: String(item?.change_type || 'scene_change'),
        confidence: String(item?.confidence || 'medium'),
        focus_target: String(item?.focus_target || item?.visual_summary || '').trim(),
        focus_zone: validFocusZones.has(String(item?.focus_zone || '').trim())
          ? String(item.focus_zone).trim()
          : 'center',
        recommended_camera_move: validMoves.has(String(item?.recommended_camera_move || '').trim())
          ? String(item.recommended_camera_move).trim()
          : 'slow_zoom_in',
        motion_intensity: validIntensities.has(String(item?.motion_intensity || '').trim())
          ? String(item.motion_intensity).trim()
          : 'medium',
        visual_hook_score: Math.round(clampScore(item?.visual_hook_score, 1, 10, 1)),
        visual_hook_type: String(item?.visual_hook_type || '').trim(),
        curiosity_reason: String(item?.curiosity_reason || '').trim(),
        repetition_potential: Math.round(clampScore(item?.repetition_potential, 1, 10, 1)),
        mechanical_rhythm: String(item?.mechanical_rhythm || '').trim(),
        human_presence: item?.human_presence === true,
        process_focus_priority: String(item?.process_focus_priority || '').trim(),
        // Cut-quality fields must survive this whitelist or the tier logic
        // downstream (scoreSceneForHighlight, computeCutSelectionTier) sees
        // nothing and silently degrades every scene to T3.
        cycle_time_sec: Number.isFinite(Number(item?.cycle_time_sec)) ? Number(item.cycle_time_sec) : undefined,
        appears_sped_up: typeof item?.appears_sped_up === 'boolean' ? item.appears_sped_up : undefined,
        human_visibility: ['FULL_PERSON', 'HANDS_ONLY', 'NONE'].includes(String(item?.human_visibility || '').trim())
          ? String(item.human_visibility).trim()
          : undefined
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.transition_at_sec - b.transition_at_sec);
}

function getGuideBoolean(guide = {}, keys = []) {
  for (const key of keys) {
    if (typeof guide?.[key] === 'boolean') return guide[key];
  }
  return null;
}

function getCandidateDurationSec(window, fallbackDurationSec = 0) {
  const duration = Number(window?.duration_sec || window?.duration || 0);
  if (duration > 0) return Number(duration.toFixed(3));
  const start = Number(window?.start_sec || window?.start || 0);
  const end = Number(window?.end_sec || window?.end || 0);
  if (end > start) return Number((end - start).toFixed(3));
  const fallback = Number(fallbackDurationSec || 0);
  return fallback > 0 ? Number(fallback.toFixed(3)) : 0;
}

function getSourceDurationSec(itemConfig = {}) {
  const duration = Number(
    itemConfig.video_metadata?.duration_sec
    || itemConfig.source_metadata?.duration_sec
    || itemConfig.source_classification?.duration_sec
    || 0
  );
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function decideOutputModeForItem(itemConfig = {}, options = {}) {
  const item = normalizeItemConfig(itemConfig, itemConfig?.item_id);
  const sourceDuration = getSourceDurationSec(item);
  const guide = item.ottogi_guide_output && typeof item.ottogi_guide_output === 'object'
    ? item.ottogi_guide_output
    : {};
  const scenes = normalizeSceneTransitions(
    getItemSceneTransitions(item),
    sourceDuration || item.target_duration_sec || 0
  );
  const sceneCount = scenes.length;
  const processCoverage = String(
    guide.process_coverage
    || guide.processCoverage
    || guide.process_flow_coverage
    || ''
  ).toLowerCase();
  const hasCompleteProcessFlow = getGuideBoolean(guide, [
    'has_complete_process_flow',
    'complete_process_flow',
    'hasCompleteProcessFlow'
  ]);
  const sourceIsShort = sourceDuration > 0 && sourceDuration < FULL_DRAFT_MIN_SOURCE_SEC;
  const sourceNeedsReview = sourceDuration > 0 && sourceDuration < FULL_DRAFT_REVIEW_MIN_SOURCE_SEC;
  const weakProcessCoverage = processCoverage === 'low'
    || hasCompleteProcessFlow === false
    || sceneCount <= 2;
  const fullWindow = pickFullDraftWindow(item);
  const fullCandidateDuration = fullWindow
    ? getCandidateDurationSec(fullWindow, sourceDuration)
    : sourceDuration;
  const fullCandidateTooShort = fullCandidateDuration > 0 && fullCandidateDuration < FULL_DRAFT_MIN_RESULT_SEC;
  const midformWindow = pickMidformDraftWindow(item);
  const midformCandidateDuration = midformWindow
    ? getCandidateDurationSec(midformWindow, sourceDuration)
    : sourceDuration;
  const isLongformSource = item.source_workflow_mode === 'longform_to_shorts' || item.source_type === 'longform';
  const shortSourceEqualsHighlight = !isLongformSource
    && sourceDuration >= 6
    && sourceDuration <= LONGFORM_HIGHLIGHT_MAX_DURATION_SEC;
  let skipMidformDraft = false;
  let skipMidformReason = '';
  if (!isLongformSource) {
    skipMidformDraft = true;
    skipMidformReason = 'midform skipped: source is not longform; use full/highlight drafts only';
  } else if (!midformWindow) {
    skipMidformDraft = true;
    skipMidformReason = `midform skipped: no usable ${MIDFORM_DRAFT_MIN_RESULT_SEC}s+ window was found; use full draft only`;
  } else if (midformCandidateDuration > 0 && midformCandidateDuration < MIDFORM_DRAFT_MIN_RESULT_SEC) {
    skipMidformDraft = true;
    skipMidformReason = `midform candidate duration ${midformCandidateDuration.toFixed(2)}s is under ${MIDFORM_DRAFT_MIN_RESULT_SEC}s; use full draft only`;
  }

  let outputMode = 'full_and_highlight';
  let skipFullDraft = false;
  const reasons = [];

  if (shortSourceEqualsHighlight) {
    outputMode = 'highlight_only';
    skipFullDraft = true;
    reasons.push(`source duration ${sourceDuration.toFixed(2)}s is within 6-${LONGFORM_HIGHLIGHT_MAX_DURATION_SEC}s, so full draft would duplicate highlight`);
  } else if (fullCandidateTooShort) {
    outputMode = 'highlight_only';
    skipFullDraft = true;
    reasons.push(`full draft candidate duration ${fullCandidateDuration.toFixed(2)}s is under ${FULL_DRAFT_MIN_RESULT_SEC}s`);
  } else if (sourceIsShort) {
    outputMode = 'highlight_only';
    skipFullDraft = true;
    reasons.push(`source duration ${sourceDuration.toFixed(2)}s is under ${FULL_DRAFT_MIN_SOURCE_SEC}s`);
  } else if (sourceNeedsReview && weakProcessCoverage) {
    outputMode = 'highlight_only';
    skipFullDraft = true;
    reasons.push(`source duration ${sourceDuration.toFixed(2)}s is short and process coverage is weak`);
  } else if (sceneCount <= 1 && sourceDuration > 0 && sourceDuration < 25) {
    outputMode = 'highlight_only';
    skipFullDraft = true;
    reasons.push('too few process scenes for a meaningful full draft');
  } else if (options.createHighlightDraft === false) {
    outputMode = 'full_only';
    reasons.push('highlight draft is disabled in queue settings');
  } else {
    reasons.push('source is long enough for full draft');
  }

  return {
    output_mode: outputMode,
    skip_full_draft: skipFullDraft,
    skip_reason: skipFullDraft ? reasons.join('; ') : '',
    skip_midform_draft: skipMidformDraft,
    skip_midform_reason: skipMidformReason,
    source_duration_sec: Number.isFinite(sourceDuration) ? Number(sourceDuration.toFixed(3)) : 0,
    full_candidate_duration_sec: Number.isFinite(fullCandidateDuration) ? Number(fullCandidateDuration.toFixed(3)) : 0,
    midform_candidate_duration_sec: Number.isFinite(midformCandidateDuration) ? Number(midformCandidateDuration.toFixed(3)) : 0,
    full_candidate_window: fullWindow || null,
    midform_candidate_window: midformWindow || null,
    source_type: item.source_type || 'unknown',
    source_workflow_mode: item.source_workflow_mode || 'unknown',
    source_classification: item.source_classification || null,
    scene_count: sceneCount,
    process_coverage: processCoverage || 'unknown',
    has_complete_process_flow: hasCompleteProcessFlow,
    decision_rules: {
      full_draft_min_result_sec: FULL_DRAFT_MIN_RESULT_SEC,
      midform_draft_min_result_sec: MIDFORM_DRAFT_MIN_RESULT_SEC,
      full_draft_min_source_sec: FULL_DRAFT_MIN_SOURCE_SEC,
      full_draft_review_min_source_sec: FULL_DRAFT_REVIEW_MIN_SOURCE_SEC,
      short_source_highlight_only_max_sec: LONGFORM_HIGHLIGHT_MAX_DURATION_SEC
    }
  };
}

function saveOutputDecisionToItem(itemId, itemConfig, decision) {
  const configPath = getItemConfigPath(itemId);
  if (!fs.existsSync(configPath)) return itemConfig;
  const next = normalizeItemConfig({
    ...itemConfig,
    output_mode: decision.output_mode,
    skip_full_draft: decision.skip_full_draft,
    skip_full_draft_reason: decision.skip_reason,
    skip_midform_draft: decision.skip_midform_draft,
    skip_midform_reason: decision.skip_midform_reason,
    output_mode_decision: decision
  }, itemId);
  writeJsonWithBackup(configPath, next);
  return next;
}

function clampCaptionLine(value = '', maxChars = 34) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const punctuationCut = Math.max(
    text.lastIndexOf('、', maxChars),
    text.lastIndexOf(',', maxChars),
    text.lastIndexOf(' ', maxChars)
  );
  if (punctuationCut >= 14) return text.slice(0, punctuationCut).trim();
  return `${text.slice(0, Math.max(12, maxChars - 1)).trim()}…`;
}

function splitBySafeCaptionLength(value = '', {
  maxChars = 10,
  minChars = 3,
  maxUnits = 12,
  language = 'ja'
} = {}) {
  const text = String(value || '').replace(/\s+/g, language === 'ko' ? ' ' : '').trim();
  if (!text) return [];
  if ([...text].length <= maxChars) return [text];

  const markers = language === 'ko'
    ? ['습니다', '합니다', '됩니다', '입니다', '어요', '아요', '고', '며', '서', '을 ', '를 ', '이 ', '가 ', '은 ', '는 ', '에 ', '로 ', ' ']
    : ['ます', 'です', 'ました', 'ています', 'して', 'から', 'まで', 'へ', 'に', 'で', 'を', 'が', 'は', 'と'];
  const chars = [...text];
  const units = [];
  let cursor = 0;

  while (cursor < chars.length && units.length < maxUnits) {
    const remaining = chars.length - cursor;
    if (remaining <= maxChars) {
      units.push(chars.slice(cursor).join('').trim());
      break;
    }

    const windowEnd = Math.min(chars.length, cursor + maxChars);
    const windowText = chars.slice(cursor, windowEnd).join('');
    let cut = windowEnd;
    for (const marker of markers) {
      const idx = windowText.lastIndexOf(marker);
      if (idx >= minChars) {
        cut = cursor + [...windowText.slice(0, idx + marker.length)].length;
        break;
      }
    }
    if (cut <= cursor + Math.max(1, minChars - 1)) cut = windowEnd;
    units.push(chars.slice(cursor, cut).join('').trim());
    cursor = cut;
  }

  if (cursor < chars.length) {
    const tail = chars.slice(cursor).join('').trim();
    if (tail) units.push(tail);
  }

  const rawUnits = units
    .map((unit) => unit.trim())
    .filter(Boolean)
    .flatMap((unit) => {
      const unitChars = [...unit];
      if (unitChars.length <= maxChars) return [unit];
      const parts = [];
      for (let index = 0; index < unitChars.length; index += maxChars) {
        parts.push(unitChars.slice(index, index + maxChars).join('').trim());
      }
      return parts.filter(Boolean);
    });
  return language === 'ja'
    ? sanitizeJapaneseCaptionUnits(rawUnits, { maxChars, minChars, maxUnits })
    : rawUnits;
}

function visibleCaptionLength(value = '') {
  return [...String(value || '').replace(/\s+/g, '')].length;
}

function normalizeJapaneseCaptionUnit(value = '') {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^[、。！？!?.,\s]+|[、。！？!?.,\s]+$/g, '')
    .trim();
}

function softenJapaneseFullCaptionForScreen(value = '') {
  let text = normalizeJapaneseCaptionUnit(value);
  if (!text) return '';

  const exactMap = new Map([
    ['これ、何だと思いますか', 'これ何だろう'],
    ['これ、何だと思います', 'これ何だろう'],
    ['これ何だと思いますか', 'これ何だろう'],
    ['これ何だと思います', 'これ何だろう'],
    ['矯正されます', 'まっすぐ整う'],
    ['供給されます', '供給が続く'],
    ['固定します', 'しっかり固定'],
    ['完成します', '完成の瞬間'],
    ['整えます', '表面を整える'],
    ['確認します', '流れを確認'],
    ['支えています', '支える力'],
    ['進みます', '次の工程へ'],
    ['動きます', '動きが続く'],
    ['見えてきます', '見えてくる'],
    ['まとまります', 'まとまる流れ'],
    ['変わります', '変化の瞬間'],
    ['合わせます', 'ぴたりと合わせる'],
    ['作ります', '形づくり'],
    ['運びます', '正確に運ぶ']
  ]);
  if (exactMap.has(text)) return exactMap.get(text);

  text = text
    .replace(/これ、?何だと思いますか?$/u, 'これ何だろう')
    .replace(/高速で供給されます$/u, '高速で供給')
    .replace(/真っ直ぐに矯正されます$/u, 'まっすぐ整う')
    .replace(/矯正されます$/u, 'まっすぐ整う')
    .replace(/供給されます$/u, '供給が続く')
    .replace(/固定されます$/u, 'しっかり固定')
    .replace(/固定します$/u, 'しっかり固定')
    .replace(/完成します$/u, '完成の瞬間')
    .replace(/整えます$/u, '表面を整える')
    .replace(/確認します$/u, '流れを確認')
    .replace(/支えています$/u, '支える力')
    .replace(/近づいていきます$/u, '完成へ近づく')
    .replace(/見えてきます$/u, '見えてくる')
    .replace(/まとまります$/u, 'まとまる流れ')
    .replace(/進みます$/u, '次の工程へ')
    .replace(/変わります$/u, '変化の瞬間')
    .replace(/合わせます$/u, 'ぴたりと合わせる')
    .replace(/運びます$/u, '正確に運ぶ')
    .replace(/作ります$/u, '形づくり')
    .replace(/になります$/u, 'になる')
    .replace(/されます$/u, 'される')
    .replace(/しています$/u, 'している')
    .replace(/します$/u, 'する')
    .replace(/です$/u, '')
    .replace(/ます$/u, '');

  text = normalizeJapaneseCaptionUnit(text);
  if (visibleCaptionLength(text) > 5 && /で$/u.test(text)) {
    text = normalizeJapaneseCaptionUnit(text.replace(/で$/u, ''));
  }
  if (isWeakJapaneseCaptionFragment(text)) return '';
  return text;
}

function softenKoreanFullCaptionForScreen(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/입니다$/u, '')
    .replace(/됩니다$/u, '돼요')
    .replace(/집니다$/u, '져요')
    .replace(/합니다$/u, '해요')
    .replace(/습니다$/u, '어요')
    .trim();
}

function isWeakJapaneseCaptionFragment(value = '') {
  const text = normalizeJapaneseCaptionUnit(value);
  if (!text) return true;
  if (/^(.)\1+$/u.test(text)) return true;
  if (/^(.{1,2})\1+$/u.test(text)) return true;
  if (visibleCaptionLength(text) <= 2) return true;
  if (['か', 'す', 'し', 'ます', 'です', 'する', '部', 'み'].includes(text)) return true;
  return false;
}

function compactJapaneseCaptionForScreen(value = '', maxChars = FULL_CAPTION_SAFE_MAX_CHARS.ja) {
  let text = normalizeJapaneseCaptionUnit(value);
  if (!text) return '';
  if (visibleCaptionLength(text) <= maxChars) return text;
  const chars = [...text];
  const cut = chars.slice(0, maxChars).join('');
  return normalizeJapaneseCaptionUnit(cut);
}

function sanitizeJapaneseCaptionUnits(units = [], {
  maxChars = FULL_CAPTION_SAFE_MAX_CHARS.ja,
  minChars = 4,
  maxUnits = 12
} = {}) {
  const normalized = [];
  for (const rawUnit of units) {
    const unit = normalizeJapaneseCaptionUnit(rawUnit);
    if (!unit) continue;

    if (isWeakJapaneseCaptionFragment(unit)) {
      const last = normalized[normalized.length - 1];
      const joined = last ? `${last}${unit}` : unit;
      if (last && visibleCaptionLength(joined) <= maxChars + 1) {
        normalized[normalized.length - 1] = compactJapaneseCaptionForScreen(joined, maxChars);
      }
      continue;
    }

    normalized.push(compactJapaneseCaptionForScreen(unit, maxChars));
  }

  const deduped = [];
  for (const unit of normalized) {
    if (!unit || isWeakJapaneseCaptionFragment(unit)) continue;
    if (deduped[deduped.length - 1] === unit) continue;
    deduped.push(unit);
  }

  const repaired = [];
  for (const unit of deduped) {
    const last = repaired[repaired.length - 1];
    if (visibleCaptionLength(unit) < minChars && last && visibleCaptionLength(`${last}${unit}`) <= maxChars + 1) {
      repaired[repaired.length - 1] = compactJapaneseCaptionForScreen(`${last}${unit}`, maxChars);
      continue;
    }
    if (visibleCaptionLength(unit) >= minChars) repaired.push(unit);
  }
  return repaired.slice(0, maxUnits);
}

function splitJapaneseCaptionUnits(value = '', {
  maxChars = 7,
  minChars = 3,
  maxUnits = 8
} = {}) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[。！？!?]+$/g, '')
    .trim();
  if (!text) return [];
  if ([...text].length <= maxChars) return sanitizeJapaneseCaptionUnits([text], { maxChars, minChars, maxUnits });
  if (maxChars <= 10) {
    return splitBySafeCaptionLength(text, {
      maxChars,
      minChars,
      maxUnits,
      language: 'ja'
    });
  }

  const chunks = [];
  const softMax = Math.max(maxChars + 5, maxChars);
  const primaryParts = text
    .split(/(?<=[、。！？!?])/u)
    .map((part) => part.replace(/[、。！？!?]+$/g, '').trim())
    .filter(Boolean);
  const sourceParts = primaryParts.length ? primaryParts : [text];

  const pushChunk = (chunk) => {
    const cleaned = String(chunk || '')
      .replace(/^[、。！？!?\s]+|[、。！？!?\s]+$/g, '')
      .trim();
    if (cleaned) chunks.push(cleaned);
  };

  const isJapaneseWordChar = (char = '') => /[\u3040-\u30ffー々\u4e00-\u9fff]/u.test(char);
  const avoidJapaneseWordSplit = (source, rawCut) => {
    let cut = rawCut;
    if (cut <= 0 || cut >= source.length) return cut;
    if (isJapaneseWordChar(source[cut - 1]) && isJapaneseWordChar(source[cut])) {
      let back = cut - 1;
      while (back > 0 && isJapaneseWordChar(source[back - 1])) back -= 1;
      let forward = cut + 1;
      while (forward < source.length && isJapaneseWordChar(source[forward])) forward += 1;
      if (back >= minChars) return back;
      if (forward <= softMax) return forward;
    }
    return cut;
  };

  for (const sourcePart of sourceParts) {
    let remaining = sourcePart;
    while (remaining.length > maxChars) {
      const window = remaining.slice(0, softMax);
      const breakCandidates = [];
      for (const marker of ['までの', 'まで', 'から', 'として', 'によって', 'ことで', 'ます', 'です', 'し', 'て']) {
        const index = window.lastIndexOf(marker, maxChars + 1);
        if (index >= minChars) breakCandidates.push(index + marker.length);
      }
      for (const marker of ['の', 'が', 'を', 'に', 'で', 'と', 'へ', 'は', 'も', ' ']) {
        const index = window.lastIndexOf(marker, maxChars + 1);
        if (index >= minChars) breakCandidates.push(index + marker.length);
      }
      const validCandidates = breakCandidates
        .map((index) => avoidJapaneseWordSplit(remaining, index))
        .filter((index) => index >= minChars && (remaining.length - index >= minChars || remaining.length - index <= softMax));
      const cutAt = validCandidates.length
        ? Math.max(...validCandidates)
        : avoidJapaneseWordSplit(remaining, Math.min(maxChars, remaining.length));
      pushChunk(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).trim();
    }
    pushChunk(remaining);
  }

  for (let index = 0; index < chunks.length - 1; index += 1) {
    const current = chunks[index] || '';
    const next = chunks[index + 1] || '';
    const trailingKatakana = current.match(/([\u30a0-\u30ffー]{1,2})$/u);
    if (trailingKatakana && /^[\u30a0-\u30ffー]/u.test(next) && current.length > trailingKatakana[1].length + minChars) {
      chunks[index] = current.slice(0, -trailingKatakana[1].length).trim();
      chunks[index + 1] = `${trailingKatakana[1]}${next}`.trim();
      continue;
    }
    const trailingCjk = current.match(/([\u4e00-\u9fff])$/u);
    if (trailingCjk && /^[\u3040-\u30ffー々]/u.test(next) && current.length > minChars + 1) {
      chunks[index] = current.slice(0, -1).trim();
      chunks[index + 1] = `${trailingCjk[1]}${next}`.trim();
      continue;
    }
    if (trailingCjk && /^[\u4e00-\u9fff]/u.test(next) && current.length > minChars + 1) {
      chunks[index] = current.slice(0, -1).trim();
      chunks[index + 1] = `${trailingCjk[1]}${next}`.trim();
    }
  }

  const merged = [];
  for (const chunk of chunks.filter(Boolean)) {
    const last = merged[merged.length - 1];
    if (last && (chunk.length < minChars || `${last}${chunk}`.length <= maxChars + 2)) {
      merged[merged.length - 1] = `${last}${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  while (merged.length > maxUnits) {
    let bestIndex = 0;
    let bestLength = Infinity;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const length = merged[index].length + merged[index + 1].length;
      if (length < bestLength) {
        bestLength = length;
        bestIndex = index;
      }
    }
    merged.splice(bestIndex, 2, `${merged[bestIndex]}${merged[bestIndex + 1]}`);
  }

  while (merged.length < maxUnits) {
    let longestIndex = -1;
    let longestLength = maxChars + 2;
    for (let index = 0; index < merged.length; index += 1) {
      if (merged[index].length > longestLength) {
        longestIndex = index;
        longestLength = merged[index].length;
      }
    }
    if (longestIndex < 0) break;
    const chunk = merged[longestIndex];
    const rawCutAt = Math.max(minChars, Math.min(chunk.length - minChars, Math.ceil(chunk.length / 2)));
    const cutAt = avoidJapaneseWordSplit(chunk, rawCutAt);
    merged.splice(longestIndex, 1, chunk.slice(0, cutAt), chunk.slice(cutAt));
  }

  for (let index = 0; index < merged.length - 1; index += 1) {
    const current = merged[index] || '';
    const next = merged[index + 1] || '';
    const trailingKana = current.match(/([\u3040-\u30ffー々]{1,4})$/u);
    if (trailingKana && /^[\u3040-\u30ffー々]/u.test(next) && current.length > trailingKana[1].length + minChars) {
      merged[index] = current.slice(0, -trailingKana[1].length).trim();
      merged[index + 1] = `${trailingKana[1]}${next}`.trim();
      continue;
    }
    const trailingCjk = current.match(/([\u4e00-\u9fff])$/u);
    if (trailingCjk && /^[\u3040-\u30ffー々]/u.test(next) && current.length > minChars + 1) {
      merged[index] = current.slice(0, -1).trim();
      merged[index + 1] = `${trailingCjk[1]}${next}`.trim();
      continue;
    }
    if (trailingCjk && /^[\u4e00-\u9fff]/u.test(next) && current.length > minChars + 1) {
      merged[index] = current.slice(0, -1).trim();
      merged[index + 1] = `${trailingCjk[1]}${next}`.trim();
    }
  }

  return sanitizeJapaneseCaptionUnits(merged, { maxChars, minChars, maxUnits });
}

function compactJapaneseCaptionUnit(value = '', maxChars = 10) {
  const text = String(value || '')
    .replace(/[。！？!?、,\s]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(3, maxChars));
}

function processRhythmCaptionSeeds(scene = {}) {
  const raw = [
    scene.caption_text_full,
    scene.caption_text,
    scene.visual_summary,
    scene.focus_target,
    scene.change_type
  ].filter(Boolean).join(' ');
  const seeds = [];
  const add = (...items) => {
    for (const item of items) {
      const text = compactJapaneseCaptionUnit(item, 11);
      if (text && !seeds.includes(text)) seeds.push(text);
    }
  };

  if (/ヌードル|押し出|麺|線状|細長/u.test(raw)) {
    add('同じ太さで続く', '流れが止まらない', '線が積み上がる', '機械が押し出す');
  }
  if (/石鹸|せっけん|ソープ|soap/i.test(raw)) {
    add('ピンクが目を引く', '形がそろっていく', '表面が整う', '素材が変わる');
  }
  if (/機械|マシン|プレス|押出|切断|カッター/u.test(raw)) {
    add('機械が一定に動く', 'リズムよく進む', '圧力で形が変わる', '次の工程へ進む');
  }
  if (/作業員|手|職人|worker|手元/i.test(raw)) {
    add('手元が素早く動く', '職人が整える', '作業が続く', '細部を確認する');
  }
  if (/山積み|積み|溜ま|集ま/u.test(raw)) {
    add('山のように積もる', '量が一気に増える', '次々に集まる');
  }
  if (/近接|クローズ|アップ|close/i.test(raw)) {
    add('細部がよく見える', '動きが強調される', '質感が見える');
  }
  add('工程が進む', '動きが続く', '変化が見える', '流れが生まれる');
  return seeds;
}

function expandCaptionUnitsForRhythm(captionUnits = [], scene = {}, desiredUnits = 1) {
  const normalized = captionUnits
    .map((text) => compactJapaneseCaptionUnit(text, 11))
    .filter(Boolean);
  const target = Math.max(1, Number(desiredUnits) || 1);
  if (normalized.length >= target) return normalized.slice(0, target);

  const expanded = [...normalized];
  const seeds = processRhythmCaptionSeeds(scene);
  let cursor = 0;
  while (expanded.length < target && seeds.length) {
    const next = seeds[cursor % seeds.length];
    cursor += 1;
    // Avoid exact repeats when possible, but allow repeats if the cut is long.
    if (expanded.includes(next) && expanded.length + 1 < target && cursor < seeds.length * 2) {
      continue;
    }
    expanded.push(next);
  }
  while (expanded.length < target && expanded.length) {
    expanded.push(expanded[expanded.length - 1]);
  }
  return expanded.filter(Boolean).slice(0, target);
}

function buildSceneExplainerBlocks(sceneTransitions = [], {
  fallbackText = '',
  fallbackDurationSec = 30,
  animation = 'slide_up',
  styleProfile = 'full_cut_caption',
  blockPrefix = 'scene_cap'
} = {}) {
  const durationSec = Number(fallbackDurationSec) > 0 ? Number(fallbackDurationSec) : 30;
  const scenes = normalizeSceneTransitions(sceneTransitions, durationSec);
  const blocks = scenes
    .flatMap((scene, index) => {
      const startSec = Math.max(0, Number(scene.start_sec || 0));
      const rawEndSec = Number(scene.end_sec || scene.transition_at_sec || startSec + 2);
      if (!Number.isFinite(rawEndSec) || rawEndSec <= startSec + 0.1) return [];
      const endSec = Math.max(startSec + 0.2, Math.min(durationSec, rawEndSec));
      const explicitScreenCaptions = Array.isArray(scene.screen_captions_ja)
        ? scene.screen_captions_ja.map(cleanJapaneseCaptionCandidate).filter(Boolean)
        : [];
      const rawText = cleanJapaneseCaptionCandidate(scene.caption_text_full) ||
        cleanJapaneseCaptionCandidate(scene.caption_text) ||
        '';
      const sceneDuration = Math.max(0.2, endSec - startSec);
      const maxUnitsForDuration = Math.max(1, Math.min(8, Math.floor(sceneDuration / 0.3) || 1));
      const desiredUnitsForRhythm = Math.max(1, Math.min(maxUnitsForDuration, Math.ceil(sceneDuration / 0.58)));
      const explicitCaptionUnits = explicitScreenCaptions.flatMap((text) => splitJapaneseCaptionUnits(text, {
        maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ja,
        minChars: 3,
        maxUnits: maxUnitsForDuration
      }));
      const baseCaptionUnits = explicitCaptionUnits.length
        ? explicitCaptionUnits.slice(0, maxUnitsForDuration)
        : splitJapaneseCaptionUnits(rawText, {
            maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ja,
            minChars: 3,
            maxUnits: maxUnitsForDuration
          });
      const captionUnits = explicitCaptionUnits.length
        ? baseCaptionUnits
        : expandCaptionUnitsForRhythm(baseCaptionUnits, scene, desiredUnitsForRhythm);
      if (!captionUnits.length) return [];
      return captionUnits.map((text, partIndex) => {
        const partStart = startSec + (sceneDuration * partIndex / captionUnits.length);
        const partEnd = startSec + (sceneDuration * (partIndex + 1) / captionUnits.length);
        return {
          block_id: `${blockPrefix}_${String(index + 1).padStart(3, '0')}_p${String(partIndex + 1).padStart(2, '0')}`,
          scene_id: scene.scene_id,
          parent_scene_id: scene.scene_id,
          source_scene_index: index,
          caption_part_index: partIndex,
          caption_parts_count: captionUnits.length,
          text,
          full_scene_caption_text: rawText,
          start_sec: Number(partStart.toFixed(3)),
          end_sec: Number(partEnd.toFixed(3)),
          style_role: 'main_explainer',
          style_profile: styleProfile,
          anchor_zone: 'lower_third',
          animation,
          caption_unit_mode: explicitScreenCaptions.length
            ? 'gemini_screen_caption'
            : (partIndex >= baseCaptionUnits.length ? 'rhythm_fill' : 'phrase'),
          output_language: 'ja',
          language: 'ja',
          caption_density_target_count: desiredUnitsForRhythm
        };
      });
    })
    .filter(Boolean);

  if (blocks.length) return blocks;
  return [
    {
      block_id: `${blockPrefix}_001`,
      text: clampCaptionLine(fallbackText || '工程の重要な場面です。'),
      start_sec: 0,
      end_sec: durationSec,
      style_role: 'main_explainer',
      style_profile: styleProfile,
      anchor_zone: 'lower_third',
      animation,
      output_language: 'ja',
      language: 'ja'
    }
  ];
}

function splitKoreanCaptionUnits(value = '', {
  maxChars = 16,
  minChars = 6,
  maxUnits = 5
} = {}) {
  const text = stripEmoji(String(value || '')
    .replace(/[。]+/g, '.')
    .replace(/\s+/g, ' ')
    .trim());
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  if (maxChars <= 12) {
    return splitBySafeCaptionLength(text, {
      maxChars,
      minChars: Math.min(minChars, 4),
      maxUnits,
      language: 'ko'
    });
  }

  const chunks = [];
  const softMax = Math.max(maxChars + 5, maxChars);
  const pushChunk = (chunk) => {
    const cleaned = String(chunk || '')
      .replace(/^[,.;:!?、。！？\s]+|[,.;:!?、。！？\s]+$/g, '')
      .trim();
    if (cleaned) chunks.push(cleaned);
  };

  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((item) => item.replace(/[.!?]+$/g, '').trim())
    .filter(Boolean);
  const sourceSentences = sentences.length ? sentences : [text];

  for (const sentence of sourceSentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (!words.length) {
      let remaining = sentence;
      while (remaining.length > maxChars) {
        pushChunk(remaining.slice(0, maxChars));
        remaining = remaining.slice(maxChars).trim();
      }
      pushChunk(remaining);
      continue;
    }

    let current = '';
    for (const word of words) {
      const candidate = `${current} ${word}`.trim();
      if (current && candidate.length > maxChars) {
        if (current.length < minChars && candidate.length <= softMax) {
          current = candidate;
        } else {
          pushChunk(current);
          current = word;
        }
      } else {
        current = candidate;
      }
    }
    pushChunk(current);
  }

  const merged = [];
  for (const chunk of chunks) {
    if (!merged.length) {
      merged.push(chunk);
      continue;
    }
    const last = merged[merged.length - 1];
    if (chunk.length < minChars || last.length < minChars) {
      const candidate = `${last} ${chunk}`.trim();
      if (candidate.length <= softMax) {
        merged[merged.length - 1] = candidate;
        continue;
      }
    }
    merged.push(chunk);
  }

  while (merged.length > maxUnits) {
    let bestIndex = 0;
    let bestLength = Infinity;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const length = merged[index].length + merged[index + 1].length;
      if (length < bestLength) {
        bestLength = length;
        bestIndex = index;
      }
    }
    merged.splice(bestIndex, 2, `${merged[bestIndex]} ${merged[bestIndex + 1]}`.trim());
  }

  return merged.filter(Boolean);
}

function splitKoreanSentences(value = '') {
  return stripEmoji(String(value || ''))
    .replace(/。/g, '.')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/u)
    .map((item) => item.replace(/[.!?]+$/g, '').trim())
    .filter((item) => item.length >= 6);
}

function buildNarrativeFullDraftBlocks({
  text = '',
  language = 'ja',
  durationSec = 30,
  sceneCount = 1,
  animation = 'slide_up',
  blockPrefix = 'full_narrative'
} = {}) {
  const safeDuration = Number(durationSec) > 0 ? Number(durationSec) : 30;
  const maxUnits = Math.max(4, Math.min(36, Math.ceil(safeDuration / 1.75)));
  const units = language === 'ko'
    ? splitKoreanCaptionUnits(text, {
        maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ko,
        minChars: 8,
        maxUnits
      })
    : splitJapaneseCaptionUnits(text, {
        maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ja,
        minChars: 7,
        maxUnits
      });
  const cleanedUnits = units
    .map((unit) => stripEmoji(unit).replace(/\s+/g, language === 'ko' ? ' ' : '').trim())
    .filter(Boolean);
  if (!cleanedUnits.length) {
    const fallback = language === 'ko'
      ? '이 공정은 여러 단계를 거쳐 완성됩니다.'
      : 'この工程は複数の段階を経て完成します。';
    cleanedUnits.push(fallback);
  }
  const effectiveSceneCount = Math.max(1, Number(sceneCount) || 1);
  return cleanedUnits.map((unit, index) => {
    const startSec = safeDuration * index / cleanedUnits.length;
    const endSec = safeDuration * (index + 1) / cleanedUnits.length;
    return {
      block_id: `${blockPrefix}_${String(index + 1).padStart(3, '0')}`,
      narrative_timeline_index: index,
      caption_part_index: index,
      caption_parts_count: cleanedUnits.length,
      caption_unit_mode: language === 'ko' ? 'korean_full_narrative' : 'japanese_full_narrative',
      text: unit,
      full_scene_caption_text: text,
      start_sec: Number(startSec.toFixed(3)),
      end_sec: Number(endSec.toFixed(3)),
      style_role: 'main_explainer',
      style_profile: 'full_cut_caption',
      anchor_zone: 'lower_third',
      animation,
      output_language: language,
      language
    };
  });
}

function isUsableKoreanCaption(value = '') {
  const text = stripEmoji(String(value || '').replace(/。/g, '.').replace(/\s+/g, ' ').trim());
  if (!text) return false;
  if (!/[\uac00-\ud7a3]/u.test(text)) return false;
  if (/[\u3040-\u30ff]/u.test(text)) return false;
  if (/[A-Za-z]{8,}/.test(text)) return false;
  if (/[은는이가을를에의와과로으로하고하며에서]$/u.test(text)) return false;
  if (text.length < 4) return false;
  return true;
}

function buildKoreanSceneExplainerBlocks(sceneTransitions = [], {
  fallbackText = '',
  fallbackDurationSec = 30,
  animation = 'slide_up',
  styleProfile = 'full_cut_caption',
  blockPrefix = 'ko_scene_cap',
  fallbackSceneTexts = []
} = {}) {
  const durationSec = Number(fallbackDurationSec) > 0 ? Number(fallbackDurationSec) : 30;
  const scenes = normalizeSceneTransitions(sceneTransitions, durationSec);
  const blocks = scenes
    .flatMap((scene, index) => {
      const startSec = Math.max(0, Number(scene.start_sec || 0));
      const rawEndSec = Number(scene.end_sec || scene.transition_at_sec || startSec + 2);
      if (!Number.isFinite(rawEndSec) || rawEndSec <= startSec + 0.1) return [];
      const endSec = Math.max(startSec + 0.2, Math.min(durationSec, rawEndSec));
      const explicitScreenCaptions = Array.isArray(scene.screen_captions_ko)
        ? scene.screen_captions_ko.map((text) => stripEmoji(text)).filter(isUsableKoreanCaption)
        : [];
      const fallbackSceneText = Array.isArray(fallbackSceneTexts) ? fallbackSceneTexts[index] : '';
      const candidateText = isUsableKoreanCaption(scene.caption_text_ko) ? scene.caption_text_ko : '';
      const rawText = stripEmoji(candidateText || fallbackSceneText || fallbackText || '');
      const sceneDuration = Math.max(0.2, endSec - startSec);
      const maxUnitsForDuration = Math.max(1, Math.min(5, Math.floor(sceneDuration / 0.75) || 1));
      const explicitCaptionUnits = explicitScreenCaptions.flatMap((text) => splitKoreanCaptionUnits(text, {
        maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ko,
        minChars: 6,
        maxUnits: maxUnitsForDuration
      }));
      const captionUnits = explicitCaptionUnits.length
        ? explicitCaptionUnits.slice(0, maxUnitsForDuration)
        : splitKoreanCaptionUnits(rawText, {
            maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ko,
            minChars: 6,
            maxUnits: maxUnitsForDuration
          });
      if (!captionUnits.length) return [];
      return captionUnits.map((text, partIndex) => {
        const partStart = startSec + (sceneDuration * partIndex / captionUnits.length);
        const partEnd = startSec + (sceneDuration * (partIndex + 1) / captionUnits.length);
        return {
          block_id: `${blockPrefix}_${String(index + 1).padStart(3, '0')}_p${String(partIndex + 1).padStart(2, '0')}`,
          scene_id: scene.scene_id,
          parent_scene_id: scene.scene_id,
          source_scene_index: index,
          caption_part_index: partIndex,
          caption_parts_count: captionUnits.length,
          text,
          full_scene_caption_text: rawText,
          start_sec: Number(partStart.toFixed(3)),
          end_sec: Number(partEnd.toFixed(3)),
          style_role: 'main_explainer',
          style_profile: styleProfile,
          anchor_zone: 'lower_third',
          animation,
          caption_unit_mode: explicitCaptionUnits.length ? 'gemini_screen_caption_ko' : 'korean_phrase',
          output_language: 'ko',
          language: 'ko',
          caption_density_target_count: captionUnits.length
        };
      });
    })
    .filter(Boolean);

  if (blocks.length) return blocks;
  return [
    {
      block_id: `${blockPrefix}_001`,
      text: clampCaptionLine(fallbackText || '공정의 핵심 장면입니다.', FULL_CAPTION_SAFE_MAX_CHARS.ko),
      start_sec: 0,
      end_sec: durationSec,
      style_role: 'main_explainer',
      style_profile: styleProfile,
      anchor_zone: 'lower_third',
      animation,
      output_language: 'ko',
      language: 'ko'
    }
  ];
}

function buildFullCaptionScriptBlocks(fullCaptionScript = [], sceneTransitions = [], {
  fallbackDurationSec = 30,
  animation = 'pop_in',
  styleProfile = 'full_cut_caption',
  blockPrefix = 'full_script_cap',
  language = 'ja'
} = {}) {
  const durationSec = Number(fallbackDurationSec) > 0 ? Number(fallbackDurationSec) : 30;
  const scenes = normalizeSceneTransitions(sceneTransitions, durationSec);
  const script = Array.isArray(fullCaptionScript) ? fullCaptionScript : [];
  if (!script.length) return [];

  const splitKoreanFullScriptUnits = (value = '', maxChars = FULL_CAPTION_SAFE_MAX_CHARS.ko) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (text.length <= maxChars) return [text];
    const sentences = text
      .split(/(?<=[.!?。！？]|입니다|합니다|됩니다|되죠|하죠|가죠|죠|요|다)\s*/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const units = [];
    const pushUnit = (unit) => {
      const cleaned = String(unit || '')
        .replace(/^[.!?。！？,，、\s]+|[.!?。！？,，、\s]+$/g, '')
        .trim();
      if (!cleaned || /^[.!?。！？,，、]+$/.test(cleaned)) return;
      if (cleaned) units.push(cleaned);
    };
    for (const sentence of (sentences.length ? sentences : [text])) {
      const words = sentence.split(/\s+/).filter(Boolean);
      let current = '';
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxChars && current.length >= 6) {
          pushUnit(current);
          current = word;
        } else {
          current = next;
        }
      }
      pushUnit(current);
    }
    const merged = [];
    for (const unit of units.filter(Boolean)) {
      const last = merged[merged.length - 1];
      if (unit.length <= 2 && last && `${last} ${unit}`.length <= maxChars + 4) {
        merged[merged.length - 1] = `${last} ${unit}`.trim();
        continue;
      }
      if (last && last.length <= 2 && `${last} ${unit}`.length <= maxChars + 4) {
        merged[merged.length - 1] = `${last} ${unit}`.trim();
        continue;
      }
      merged.push(unit);
    }
    return merged.filter(Boolean);
  };

  const splitFullScriptUnits = (value = '') => {
    if (language === 'ko') {
      return splitKoreanFullScriptUnits(value, FULL_CAPTION_SAFE_MAX_CHARS.ko).slice(0, 6);
    }
    const units = splitJapaneseCaptionUnits(value, {
      maxChars: FULL_CAPTION_SAFE_MAX_CHARS.ja,
      minChars: 4,
      maxUnits: 6
    });
    return units.length ? units : [compactJapaneseCaptionForScreen(value, FULL_CAPTION_SAFE_MAX_CHARS.ja)].filter(Boolean);
  };

  const orderedItems = [];
  script.forEach((item, index) => {
    const itemObject = item && typeof item === 'object' ? item : { text: item };
    const sceneId = String(itemObject.scene_id || `script_${String(index + 1).padStart(3, '0')}`).trim();
    const rawText = stripEmoji(String(itemObject.text || itemObject.caption || itemObject.subtitle || '').replace(/\s+/g, language === 'ko' ? ' ' : '').trim());
    const text = language === 'ko'
      ? softenKoreanFullCaptionForScreen(rawText)
      : softenJapaneseFullCaptionForScreen(rawText);
    if (!sceneId || !text) return;
    orderedItems.push({
      ...itemObject,
      scene_id: sceneId,
      text,
      source_script_index: index
    });
  });

  const scriptUnits = orderedItems.flatMap((scriptItem, itemIndex) => {
    const rawText = stripEmoji(String(scriptItem?.text || '').replace(/\s+/g, language === 'ko' ? ' ' : '').trim());
    const text = language === 'ko'
      ? softenKoreanFullCaptionForScreen(rawText)
      : softenJapaneseFullCaptionForScreen(rawText);
    const units = splitFullScriptUnits(text);
    return (units.length ? units : [text]).map((unit, unitIndex) => ({
      ...scriptItem,
      text: unit,
      parent_script_text: text,
      source_script_index: scriptItem.source_script_index ?? itemIndex,
      caption_part_index: unitIndex,
      caption_parts_count: units.length || 1
    }));
  }).filter((item) => {
    const text = String(item.text || '').trim();
    if (!text) return false;
    return language !== 'ja' || !isWeakJapaneseCaptionFragment(text);
  });

  if (!scriptUnits.length) return [];

  const sceneForRatio = (ratio = 0) => {
    if (!scenes.length) return null;
    const midpoint = ratio * durationSec;
    return scenes.find((scene) => {
      const startSec = Math.max(0, Number(scene.start_sec || 0));
      const endSec = Math.max(startSec, Number(scene.end_sec || scene.transition_at_sec || startSec));
      return midpoint >= startSec && midpoint <= endSec;
    }) || scenes[Math.min(scenes.length - 1, Math.floor(ratio * scenes.length))];
  };

  const unitDuration = durationSec / scriptUnits.length;
  return scriptUnits.map((scriptItem, index) => {
    const startSec = Math.max(0, unitDuration * index);
    const endSec = index === scriptUnits.length - 1
      ? durationSec
      : Math.min(durationSec, unitDuration * (index + 1));
    const ratio = scriptUnits.length <= 1 ? 0 : index / Math.max(1, scriptUnits.length - 1);
    const scene = sceneForRatio(ratio);
    return {
        block_id: `${blockPrefix}_${String(index + 1).padStart(3, '0')}`,
        scene_id: scriptItem.scene_id || `script_${String(index + 1).padStart(3, '0')}`,
        parent_scene_id: scene?.scene_id || '',
        source_scene_index: scene ? scenes.indexOf(scene) : -1,
        caption_part_index: scriptItem.caption_part_index || 0,
        caption_parts_count: scriptItem.caption_parts_count || 1,
        text: scriptItem.text,
        full_scene_caption_text: scriptItem.parent_script_text || scriptItem.text,
        full_caption_role: String(scriptItem?.role || '').trim() || 'scene_observation',
        full_caption_source_basis: String(scriptItem?.source_basis || scene?.visual_summary || '').trim(),
        start_sec: Number(startSec.toFixed(3)),
        end_sec: Number(Math.max(startSec + 0.12, endSec).toFixed(3)),
        style_role: 'main_explainer',
        style_profile: styleProfile,
        anchor_zone: 'lower_third',
        animation,
        caption_unit_mode: language === 'ko' ? 'korean_full_technical_script' : 'japanese_full_technical_script',
        output_language: language,
        language,
        caption_density_target_count: scriptUnits.length
      };
  }).filter(Boolean);
}

function getVariantMetadata(guide = {}, variant = 'full') {
  if (variant === 'highlight' && guide.highlight_metadata) return guide.highlight_metadata;
  if (variant === 'midform' && guide.midform_metadata) return guide.midform_metadata;
  if (variant === 'full' && guide.full_metadata) return guide.full_metadata;
  if (variant === 'highlight') {
    return {
      short_description: guide.highlight_explainer_text || guide.short_description_200 || guide.explainer_text || '',
      summary_caption: guide.highlight_explainer_text || guide.short_description_200 || guide.explainer_text || '',
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_subtitles: [],
      onscreen_caption_block: guide.highlight_onscreen_caption_block_ja || guide.highlight_explainer_text || guide.short_description_200 || '',
      recommended_titles: Array.isArray(guide.highlight_recommended_titles) ? guide.highlight_recommended_titles : (Array.isArray(guide.recommended_titles) ? guide.recommended_titles : []),
      report_description: guide.highlight_report_description || guide.report_description || '',
      upload_title: guide.highlight_upload_title || guide.upload_title || '',
      hashtags: guide.highlight_hashtags || guide.upload_hashtags || []
    };
  }
  if (variant === 'midform') {
    return {
      short_description: guide.midform_short_description || guide.short_description_200 || guide.explainer_text || '',
      summary_caption: guide.midform_summary_caption || guide.short_description_200 || guide.explainer_text || '',
      variant_type: 'midform',
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: Array.isArray(guide.midform_onscreen_subtitles_ja)
        ? guide.midform_onscreen_subtitles_ja
        : (Array.isArray(guide.full_onscreen_subtitles_ja) ? guide.full_onscreen_subtitles_ja : []),
      onscreen_caption_block: '',
      recommended_titles: Array.isArray(guide.midform_recommended_titles) ? guide.midform_recommended_titles : (Array.isArray(guide.recommended_titles) ? guide.recommended_titles : []),
      report_description: guide.midform_report_description || guide.report_description || '',
      upload_title: guide.midform_upload_title || guide.upload_title || '',
      hashtags: guide.midform_hashtags || guide.upload_hashtags || []
    };
  }
  return {
    short_description: guide.short_description_200 || guide.explainer_text || '',
    summary_caption: guide.short_description_200 || guide.explainer_text || '',
    variant_type: 'full',
    caption_mode: 'scene_based_short_subtitles',
    onscreen_subtitles: Array.isArray(guide.full_onscreen_subtitles_ja) ? guide.full_onscreen_subtitles_ja : [],
    onscreen_caption_block: '',
    recommended_titles: Array.isArray(guide.recommended_titles) ? guide.recommended_titles : [],
    report_description: guide.report_description || '',
    upload_title: guide.upload_title || '',
    hashtags: guide.upload_hashtags || []
  };
}

function getVariantReviewMetadata(guide = {}, variant = 'full') {
  if (variant === 'highlight' && guide.highlight_metadata_ko) return guide.highlight_metadata_ko;
  if (variant === 'midform' && guide.midform_metadata_ko) return guide.midform_metadata_ko;
  if (variant === 'full' && guide.full_metadata_ko) return guide.full_metadata_ko;
  if (variant === 'highlight') {
    return {
      short_description: guide.highlight_explainer_text_ko || guide.short_description_ko || guide.explainer_text_ko || '',
      summary_caption: guide.highlight_explainer_text_ko || guide.short_description_ko || guide.explainer_text_ko || '',
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_subtitles: [],
      onscreen_caption_block: guide.highlight_onscreen_caption_block_ko || guide.highlight_explainer_text_ko || guide.short_description_ko || '',
      recommended_titles: Array.isArray(guide.highlight_recommended_titles_ko) ? guide.highlight_recommended_titles_ko : (Array.isArray(guide.recommended_titles_ko) ? guide.recommended_titles_ko : []),
      report_description: guide.highlight_report_description_ko || guide.report_description_ko || '',
      upload_title: guide.highlight_upload_title_ko || '',
      hashtags: guide.highlight_hashtags_ko || []
    };
  }
  if (variant === 'midform') {
    return {
      short_description: guide.midform_short_description_ko || guide.short_description_ko || guide.explainer_text_ko || '',
      summary_caption: guide.midform_summary_caption_ko || guide.short_description_ko || guide.explainer_text_ko || '',
      variant_type: 'midform',
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: Array.isArray(guide.midform_onscreen_subtitles_ko)
        ? guide.midform_onscreen_subtitles_ko
        : (Array.isArray(guide.full_onscreen_subtitles_ko) ? guide.full_onscreen_subtitles_ko : []),
      onscreen_caption_block: '',
      recommended_titles: Array.isArray(guide.midform_recommended_titles_ko) ? guide.midform_recommended_titles_ko : (Array.isArray(guide.recommended_titles_ko) ? guide.recommended_titles_ko : []),
      report_description: guide.midform_report_description_ko || guide.report_description_ko || '',
      upload_title: '',
      hashtags: []
    };
  }
  return {
    short_description: guide.short_description_ko || guide.explainer_text_ko || '',
    summary_caption: guide.short_description_ko || guide.explainer_text_ko || '',
    variant_type: 'full',
    caption_mode: 'scene_based_short_subtitles',
    onscreen_subtitles: Array.isArray(guide.full_onscreen_subtitles_ko) ? guide.full_onscreen_subtitles_ko : [],
    onscreen_caption_block: '',
    recommended_titles: Array.isArray(guide.recommended_titles_ko) ? guide.recommended_titles_ko : [],
    report_description: guide.report_description_ko || '',
    upload_title: '',
    hashtags: []
  };
}

function selectGuideTitle(guide = {}, variant = 'full') {
  const metadata = getVariantMetadata(guide, variant);
  const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
  return titles.find((item) => ['concise', 'hook'].includes(String(item.category || '').trim().toLowerCase())) || titles[0] || null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function charLength(value = '') {
  return [...String(value || '')].length;
}

function truncateChars(value = '', maxLength = 120) {
  const chars = [...String(value || '').trim()];
  if (chars.length <= maxLength) return chars.join('');
  return chars.slice(0, Math.max(0, maxLength - 1)).join('').replace(/[、,。\s]+$/u, '') + '…';
}

function stripHighlightScreenInternalNotes(value = '') {
  return stripEmoji(String(value || ''))
    .replace(/\b(?:user_selected_highlight_window|gemini_recommended_highlight_window|scene_ranked_highlight_candidate)\b/gi, '')
    .replace(/\s*(?:選定区間|H\d{2})は\d+(?:\.\d+)?〜\d+(?:\.\d+)?秒(?:の見どころ|区間の見どころ|の核心場面|区間の核心場面)?です。?/g, '')
    .replace(/\s*(?:선정 구간|H\d{2})은\s*\d+(?:\.\d+)?[~〜]\d+(?:\.\d+)?초\s*구간(?:의 핵심 장면|의 하이라이트|의 볼거리)?입니다\.?/g, '')
    .replace(/\s*(?:抽出区間|추출 구간)\s*[:：]\s*\d+(?:\.\d+)?[~〜]\d+(?:\.\d+)?(?:秒|초)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatHighlightWindowRange(window = {}) {
  const start = Number(window.start_sec ?? window.start ?? 0);
  const end = Number(window.end_sec ?? window.end ?? start);
  const cleanNumber = (value) => {
    if (!Number.isFinite(value)) return '0';
    return Number(value.toFixed(value % 1 === 0 ? 0 : 1)).toString();
  };
  return `${cleanNumber(start)}〜${cleanNumber(end)}秒`;
}

function buildCandidateFocusText(window = {}, label = 'H01', korean = false) {
  const range = formatHighlightWindowRange(window);
  const rawReason = stripEmoji(String(
    window.reason
      || window.selection_reason
      || window.selection_strategy
      || window.longform_highlight_rule
      || ''
  ).replace(/\s+/g, ' ').trim());
  if (korean) {
    const reason = rawReason || '반복되는 움직임과 변화가 잘 보이는 구간입니다';
    return `${label}은 ${range} 구간의 핵심 장면입니다. ${reason}`;
  }
  const reason = rawReason || '動きの変化と反復が見えやすい見どころです';
  return `${label}は${range}の見どころです。${reason}`;
}

function buildCandidateHighlightBlock(baseText = '', focusText = '', minLength = 150, maxLength = 235) {
  const cleanBase = stripHighlightScreenInternalNotes(baseText);
  const cleanFocus = stripHighlightScreenInternalNotes(focusText);
  if (cleanBase) return truncateChars(cleanBase, maxLength);
  if (cleanFocus) return truncateChars(cleanFocus, maxLength);
  return 'この工程で最も目を引く瞬間を切り出したハイライトです。素材の形が変わる動き、機械や手作業のリズム、完成へ近づく気持ちよさが短い時間に詰まっています。';
}

function withCandidateTitleSuffix(title = '', label = 'H01') {
  const cleanTitle = stripHashtagsFromTitle(title, '').replace(/\s+/g, ' ').trim();
  if (!cleanTitle) return label;
  if (new RegExp(`\\b${label}\\b`, 'i').test(cleanTitle)) return cleanTitle;
  return `${cleanTitle} ${label}`.trim();
}

function buildHighlightCandidateGuide(baseGuide = {}, window = {}, highlightOrdinal = 1, totalHighlights = 1, highlightTitle = '') {
  const guide = cloneJson(baseGuide);
  const label = `H${String(Math.max(1, Number(highlightOrdinal) || 1)).padStart(2, '0')}`;
  const candidateCount = Math.max(1, Number(totalHighlights) || 1);
  const publicLabelJa = candidateCount > 1 ? label : '選定区間';
  const publicLabelKo = candidateCount > 1 ? label : '선정 구간';
  const baseMetadata = getVariantMetadata(baseGuide, 'highlight');
  const baseReview = getVariantReviewMetadata(baseGuide, 'highlight');
  const rawTitle = highlightTitle || baseMetadata.upload_title || selectGuideTitle(baseGuide, 'highlight')?.title || '';
  const title = candidateCount > 1 ? withCandidateTitleSuffix(rawTitle, label) : stripHashtagsFromTitle(rawTitle, '').trim();
  const focusJa = buildCandidateFocusText(window, publicLabelJa, false);
  const focusKo = buildCandidateFocusText(window, publicLabelKo, true);
  const baseBlockJa = baseMetadata.onscreen_caption_block || baseGuide.highlight_onscreen_caption_block_ja || baseGuide.highlight_explainer_text || baseMetadata.short_description || '';
  const baseBlockKo = baseReview.onscreen_caption_block || baseGuide.highlight_onscreen_caption_block_ko || baseGuide.highlight_explainer_text_ko || baseReview.short_description || '';
  const blockJa = buildCandidateHighlightBlock(baseBlockJa, focusJa);
  const blockKo = buildCandidateHighlightBlock(baseBlockKo, focusKo);
  const hashtags = normalizeHashtags(baseMetadata.hashtags || baseGuide.highlight_hashtags || baseGuide.upload_hashtags || []);

  const recommendedTitles = Array.isArray(baseMetadata.recommended_titles) && baseMetadata.recommended_titles.length
    ? baseMetadata.recommended_titles
    : [{ category: 'hook', title: title, hashtags }];
  const recommendedTitlesKo = Array.isArray(baseReview.recommended_titles) && baseReview.recommended_titles.length
    ? baseReview.recommended_titles
    : [];

  guide.highlight_metadata = {
    ...baseMetadata,
    variant_type: 'highlight',
    caption_mode: 'long_bottom_explainer',
    upload_title: title,
    summary_caption: blockJa,
    short_description: blockJa,
    onscreen_caption_block: blockJa,
    onscreen_subtitles: [],
    report_description: [
      baseMetadata.report_description || baseMetadata.short_description || blockJa,
      '',
      `候補: ${label}/${candidateCount}`,
      `抽出区間: ${formatHighlightWindowRange(window)}`,
      `選定理由: ${stripEmoji(String(window.reason || window.selection_strategy || focusJa).replace(/\s+/g, ' ').trim())}`
    ].filter(Boolean).join('\n'),
    recommended_titles: recommendedTitles.map((item, index) => ({
      ...item,
      title: index === 0 ? title : (candidateCount > 1 ? withCandidateTitleSuffix(item.title || title, label) : stripHashtagsFromTitle(item.title || title, '').trim()),
      hashtags: normalizeHashtags(item.hashtags || hashtags)
    })),
    hashtags,
    source_window: window,
    highlight_candidate_label: label,
    highlight_candidate_index: highlightOrdinal,
    highlight_candidate_total: candidateCount
  };
  guide.highlight_metadata_ko = {
    ...baseReview,
    variant_type: 'highlight',
    caption_mode: 'long_bottom_explainer',
    upload_title: '',
    summary_caption: blockKo,
    short_description: blockKo,
    onscreen_caption_block: blockKo,
    onscreen_subtitles: [],
    report_description: [
      baseReview.report_description || baseReview.short_description || blockKo,
      '',
      `검수 후보: ${label}/${candidateCount}`,
      `추출 구간: ${formatHighlightWindowRange(window)}`,
      `선정 이유: ${stripEmoji(String(window.reason || window.selection_strategy || focusKo).replace(/\s+/g, ' ').trim())}`
    ].filter(Boolean).join('\n'),
    recommended_titles: recommendedTitlesKo.map((item) => ({
      ...item,
      title: candidateCount > 1 ? withCandidateTitleSuffix(item.title || '', label) : String(item.title || '').trim()
    })),
    hashtags: []
  };
  guide.highlight_upload_title = title;
  guide.highlight_explainer_text = blockJa;
  guide.highlight_explainer_text_ko = blockKo;
  guide.highlight_onscreen_caption_block_ja = blockJa;
  guide.highlight_onscreen_caption_block_ko = blockKo;
  guide.highlight_recommended_titles = guide.highlight_metadata.recommended_titles;
  guide.highlight_hashtags = hashtags;
  guide.highlight_candidate_label = label;
  guide.highlight_candidate_source_window = window;
  return guide;
}

function selectKoreanTitle(itemConfig = {}, variant = 'full') {
  const review = itemConfig.korean_review && typeof itemConfig.korean_review === 'object'
    ? itemConfig.korean_review
    : {};
  const titles = Array.isArray(review.recommended_titles) ? review.recommended_titles : [];
  const normalizedVariant = variant === 'highlight' ? 'highlight' : 'full';
  const picked = normalizedVariant === 'highlight'
    ? (
        titles.find((item) => /후킹|궁금|하이라이트|충격|반전|몰입/.test(String(item.category || item.title || '')))
        || titles.find((item) => /!|\?/.test(String(item.title || '')))
        || titles[1]
        || titles[0]
      )
    : titles[0];
  const fallbackTitle = normalizedVariant === 'highlight'
    ? (itemConfig.highlight_upload_title || itemConfig.upload_title || itemConfig.item_id || '')
    : (itemConfig.full_upload_title || itemConfig.upload_title || itemConfig.item_id || '');
  const title = String(picked?.title || fallbackTitle || '').trim();
  const hashtags = normalizeHashtags(picked?.hashtags || itemConfig.upload_hashtags || []);
  return {
    title,
    hashtags,
    category: String(picked?.category || '').trim()
  };
}

function formatTitleLine(titleItem = {}, index = 0) {
  const rawTitle = String(titleItem.title || '').trim();
  const tags = normalizeHashtags(titleItem.hashtags || []);
  const titleWithoutTags = rawTitle.replace(/#[\w\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af-]+/g, '').replace(/\s+/g, ' ').trim();
  const title = titleWithoutTags || rawTitle || 'Title ' + (index + 1);
  return [title, tags.join(' ')].filter(Boolean).join(' ').trim();
}

function formatOnscreenSubtitleLines(lines = [], fallback = '') {
  const source = Array.isArray(lines) ? lines : [];
  const normalized = source
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (normalized.length) return normalized.join('\n');
  return String(fallback || '').trim();
}

function collectGuideOnscreenSubtitles(guide = {}, variant = 'full', korean = false) {
  const topLevelKey = korean
    ? (variant === 'highlight' ? 'highlight_onscreen_subtitles_ko' : 'full_onscreen_subtitles_ko')
    : (variant === 'highlight' ? 'highlight_onscreen_subtitles_ja' : 'full_onscreen_subtitles_ja');
  if (Array.isArray(guide[topLevelKey]) && guide[topLevelKey].length) {
    return guide[topLevelKey].map((line) => String(line || '').trim()).filter(Boolean);
  }

  const scenes = Array.isArray(guide.scene_transitions) ? [...guide.scene_transitions] : [];
  if (variant === 'highlight') {
    scenes.sort((a, b) => {
      const bScore = Number(b?.visual_hook_score || 0) + Number(b?.repetition_potential || 0);
      const aScore = Number(a?.visual_hook_score || 0) + Number(a?.repetition_potential || 0);
      return bScore - aScore;
    });
  }

  const lines = [];
  scenes.slice(0, variant === 'highlight' ? 6 : scenes.length).forEach((scene) => {
    const captions = korean ? scene?.screen_captions_ko : scene?.screen_captions_ja;
    if (Array.isArray(captions)) lines.push(...captions);
    else if (typeof captions === 'string') lines.push(captions);
    lines.push(korean ? scene?.caption_text_ko : scene?.caption_text);
  });

  const seen = new Set();
  return lines
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => {
      if (line.length > 18) return false;
      if (/[。.!?！？].*[。.!?！？]/u.test(line)) return false;
      if (/[、,].*[。.!?！？]/u.test(line)) return false;
      if (/ご覧ください|様子をご覧|과정입니다|공정입니다|모습을 보여/u.test(line)) return false;
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, variant === 'highlight' ? 6 : 10);
}

function formatMetadataReportDescription(value = '', korean = false) {
  let text = String(value || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const headings = korean
    ? [
        ['1', '작업\\s*개요'],
        ['2', '사용\\s*재료\\s*및\\s*장비'],
        ['3', '시공\\s*절차'],
        ['4', '작업의\\s*중요성'],
        ['5', '가이드라인\\s*준수\\s*및\\s*교육적\\s*목적']
      ]
    : [
        ['1', '作業\\s*概要'],
        ['2', '使用\\s*材料\\s*と\\s*設備'],
        ['3', '(?:工程\\s*手順|作業\\s*手順)'],
        ['4', '作業\\s*の\\s*重要性'],
        ['5', 'ガイドライン\\s*遵守\\s*と\\s*教育\\s*目的']
      ];

  headings.forEach(([number, label], index) => {
    const pattern = new RegExp(`\\s*(?:#{1,6}\\s*)?(${number}\\.\\s*${label})\\s*`, 'u');
    text = text.replace(pattern, `${index === 0 ? '' : '\n\n'}## $1\n`);
  });

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatMetadataVariantSection(guide = {}, variant = 'full') {
  const isHighlight = variant === 'highlight';
  const metadata = getVariantMetadata(guide, variant);
  const koreanMetadata = getVariantReviewMetadata(guide, variant);
  const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
  const titlesKo = Array.isArray(koreanMetadata.recommended_titles) ? koreanMetadata.recommended_titles : [];
  const shortDescription = String(metadata.short_description || '').trim();
  const shortDescriptionKo = String(koreanMetadata.short_description || '').trim();
  const summaryCaption = String(metadata.summary_caption || shortDescription).trim();
  const summaryCaptionKo = String(koreanMetadata.summary_caption || shortDescriptionKo).trim();
  const onscreenSubtitleText = isHighlight
    ? String(metadata.onscreen_caption_block || shortDescription || summaryCaption).trim()
    : formatOnscreenSubtitleLines(
        Array.isArray(metadata.onscreen_subtitles) && metadata.onscreen_subtitles.length
          ? metadata.onscreen_subtitles
          : collectGuideOnscreenSubtitles(guide, variant, false),
        shortDescription
      );
  const onscreenSubtitleTextKo = isHighlight
    ? String(koreanMetadata.onscreen_caption_block || shortDescriptionKo || summaryCaptionKo).trim()
    : formatOnscreenSubtitleLines(
        Array.isArray(koreanMetadata.onscreen_subtitles) && koreanMetadata.onscreen_subtitles.length
          ? koreanMetadata.onscreen_subtitles
          : collectGuideOnscreenSubtitles(guide, variant, true),
        shortDescriptionKo
      );
  const reportDescription = formatMetadataReportDescription(metadata.report_description || '', false);
  const reportDescriptionKo = formatMetadataReportDescription(koreanMetadata.report_description || '', true);
  const titleLines = titles.map(formatTitleLine);
  const titleLinesKo = titlesKo.map(formatTitleLine);
  const heading = variant === 'highlight' ? 'HIGHLIGHT_METADATA' : (variant === 'midform' ? 'MIDFORM_METADATA' : 'FULL_DRAFT_METADATA');
  const reviewHeading = variant === 'highlight' ? 'HIGHLIGHT_REVIEW' : (variant === 'midform' ? 'MIDFORM_REVIEW' : 'FULL_DRAFT_REVIEW');
  const japaneseCaptionSection = isHighlight
    ? [
        '### SCREEN_CAPTION',
        onscreenSubtitleText,
        '',
        '### SCREEN_CAPTION_BLOCK',
        onscreenSubtitleText
      ]
    : [
        '### SCREEN_CAPTION',
        onscreenSubtitleText,
        '',
        '### SCREEN_SUBTITLES',
        onscreenSubtitleText
      ];
  const koreanCaptionSection = isHighlight
    ? [
        '### SCREEN_CAPTION',
        onscreenSubtitleTextKo,
        '',
        '### SCREEN_CAPTION_BLOCK',
        onscreenSubtitleTextKo
      ]
    : [
        '### SCREEN_CAPTION',
        onscreenSubtitleTextKo,
        '',
        '### SCREEN_SUBTITLES',
        onscreenSubtitleTextKo
      ];
  const reviewCaptionSection = isHighlight
    ? [
        '### SCREEN_CAPTION_KO',
        onscreenSubtitleTextKo,
        '',
        '### SCREEN_CAPTION_BLOCK_KO',
        onscreenSubtitleTextKo
      ]
    : [
        '### SCREEN_CAPTION_KO',
        onscreenSubtitleTextKo,
        '',
        '### SCREEN_SUBTITLES_KO',
        onscreenSubtitleTextKo
      ];
  const japaneseSectionText = [
    '<!-- METADATA_VARIANT: ' + variant + ' -->',
    '<!-- METADATA_LANGUAGE: ja -->',
    '## ' + heading,
    '',
    ...japaneseCaptionSection,
    '',
    '### SUMMARY_CAPTION',
    summaryCaption,
    '',
    '### TITLE_CANDIDATES',
    titleLines.map((line, index) => (index + 1) + '. ' + line).join('\n'),
    '',
    '### REPORT_DESCRIPTION',
    reportDescription
  ].join('\n');
  const koreanSectionText = '';

  return {
    shortDescription,
    shortDescriptionKo,
    titlesText: titleLines.map((line, index) => {
      const category = titles[index]?.category || 'Title ' + (index + 1);
      return '[' + category + ' ' + (index + 1) + ']\n' + line;
    }).join('\n\n'),
    titlesTextKo: titleLinesKo.map((line, index) => {
      const category = titlesKo[index]?.category || 'Review title ' + (index + 1);
      return '[' + category + ' ' + (index + 1) + ']\n' + line;
    }).join('\n\n'),
    reportDescription,
    reportDescriptionKo,
    japaneseSectionText,
    koreanSectionText,
    sectionText: [
      japaneseSectionText,
      '',
      '<!-- REVIEW_VARIANT: ' + variant + ' -->',
      '## ' + reviewHeading,
      '',
      ...reviewCaptionSection,
      '',
      '### SUMMARY_CAPTION_KO',
      summaryCaptionKo,
      '',
      '### TITLE_CANDIDATES_KO',
      titleLinesKo.map((line, index) => (index + 1) + '. ' + line).join('\n'),
      '',
      '### REPORT_DESCRIPTION_KO',
      reportDescriptionKo
    ].join('\n')
  };
}

function formatOttogiMetadataTexts(guide = {}) {
  const full = formatMetadataVariantSection(guide, 'full');
  const highlight = formatMetadataVariantSection(guide, 'highlight');
  const midform = formatMetadataVariantSection(guide, 'midform');
  return {
    ...full,
    full,
    highlight,
    midform,
    jaFullText: [
      '# OTTOGI_METADATA_PACKAGE',
      '',
      full.japaneseSectionText
    ].join('\n'),
    jaHighlightText: [
      '# OTTOGI_METADATA_PACKAGE',
      '',
      highlight.japaneseSectionText
    ].join('\n'),
    jaMidformText: [
      '# OTTOGI_METADATA_PACKAGE',
      '',
      midform.japaneseSectionText
    ].join('\n'),
    combinedText: [
      '# OTTOGI_METADATA_PACKAGE',
      '',
      full.sectionText,
      '',
      highlight.sectionText,
      '',
      midform.sectionText
    ].join('\n')
  };
}

function metadataLanguageSuffix(language = 'ja') {
  return String(language || '').toLowerCase() === 'ko' ? '_ko' : '';
}

function writeMetadataTextFile(dir, baseName, language, text) {
  const ext = path.extname(baseName) || '.txt';
  const stem = path.basename(baseName, ext).replace(/_ko$/i, '');
  const fileName = `${stem}${metadataLanguageSuffix(language)}${ext}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${String(text || '').trim()}\n`, 'utf8');
  return filePath;
}

function writeMetadataTargetName(targetBaseName, fallback, isKorean = false) {
  const baseName = metadataPackageFileNameFromTitle(targetBaseName, fallback);
  if (!isKorean) return baseName;
  const ext = path.extname(baseName) || '.txt';
  const stem = path.basename(baseName, ext).replace(/_ko$/i, '');
  return `${stem}_ko${ext}`;
}

function detectMetadataVariantFromName(name = '') {
  const value = String(name || '').toLowerCase();
  if (/-m-/i.test(name) || /(^|[_\s-])m($|[_\s-])/i.test(name) || /midform|middle|2min|120/.test(value)) return 'midform';
  if (/-h-/i.test(name) || /-hl-/i.test(name) || /(^|[_\s-])h($|[_\s-])/i.test(name) || /highlight|hook/.test(value)) return 'highlight';
  return 'full';
}

function extractMetadataVariantText(text = '', variant = 'full', language = 'ja') {
  const normalizedVariant = variant === 'highlight' ? 'highlight' : (variant === 'midform' ? 'midform' : 'full');
  const normalizedLanguage = language === 'ko' ? 'ko' : 'ja';
  const markerVariant = normalizedVariant;
  const marker = new RegExp(
    '<!--\\s*METADATA_VARIANT:\\s*' + markerVariant + '\\s*-->([\\s\\S]*?)(?=<!--\\s*(?:METADATA_VARIANT|REVIEW_VARIANT):|$)',
    'i'
  );
  const match = String(text || '').match(marker);
  if (match) {
    return [
      '# OTTOGI_METADATA_PACKAGE',
      '',
      '<!-- METADATA_VARIANT: ' + markerVariant + ' -->',
      String(match[1] || '').trim()
    ].join('\n');
  }

  const fallbackMarker = new RegExp(
    '<!--\\s*METADATA_VARIANT:\\s*' + normalizedVariant + '\\s*-->([\\s\\S]*?)(?=<!--\\s*(?:METADATA_VARIANT|REVIEW_VARIANT):|$)',
    'i'
  );
  const fallbackMatch = String(text || '').match(fallbackMarker);
  if (normalizedLanguage === 'ja' && fallbackMatch) {
    return [
      '# OTTOGI_METADATA_PACKAGE',
      '',
      '<!-- METADATA_VARIANT: ' + normalizedVariant + ' -->',
      String(fallbackMatch[1] || '').trim()
    ].join('\n');
  }
  return '';
}

function writeOttogiMetadataFiles(itemId, guide = {}) {
  const dir = getItemDir(itemId);
  fs.mkdirSync(dir, { recursive: true });
  const texts = formatOttogiMetadataTexts(guide);
  const fullMetadata = getVariantMetadata(guide, 'full');
  const selectedTitle = selectGuideTitle(guide, 'full');
  const uploadTitle = String(selectedTitle?.title || fullMetadata.recommended_titles?.[0]?.title || fullMetadata.upload_title || itemId || '').trim();
  const packageFileName = metadataPackageFileNameFromTitle(uploadTitle, itemId);
  const packagePath = path.join(dir, packageFileName);
  fs.writeFileSync(packagePath, `${texts.combinedText}\n`, 'utf8');
  const legacyPath = path.join(dir, 'ottogi_metadata_package.txt');
  if (legacyPath !== packagePath && fs.existsSync(legacyPath)) {
    fs.rmSync(legacyPath, { force: true });
  }
  return {
    package: packagePath,
    packageFileName
  };
}

function copyOttogiMetadataFiles(itemId, targetDir, targetBaseName = '', variant = '', language = 'ja', guide = null) {
  const sourceDir = getItemDir(itemId);
  const copied = [];
  const normalizedVariant = variant || detectMetadataVariantFromName(targetBaseName || '');
  const generatedTexts = guide && typeof guide === 'object'
    ? formatMetadataVariantSection(guide, normalizedVariant)
    : null;
  const candidates = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir)
      .filter((name) => /\.txt$/i.test(name) && name !== 'item_config.json')
      .map((name) => path.join(sourceDir, name))
    : [];
  const legacyPath = path.join(sourceDir, 'ottogi_metadata_package.txt');
  const sourcePath = candidates.find((candidate) => path.basename(candidate) !== 'ottogi_metadata_package.txt' && !/_ko\.txt$/i.test(path.basename(candidate))) ||
    candidates.find((candidate) => path.basename(candidate) !== 'ottogi_metadata_package.txt') ||
    (fs.existsSync(legacyPath) ? legacyPath : '');
  const sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  const texts = {
    ja: generatedTexts?.sectionText
      ? ['# OTTOGI_METADATA_PACKAGE', '', generatedTexts.sectionText].join('\n')
      : extractMetadataVariantText(sourceText, normalizedVariant, 'ja'),
    ko: ''
  };
  const preferredName = targetBaseName
    ? metadataPackageFileNameFromTitle(targetBaseName, itemId)
    : (sourcePath ? path.basename(sourcePath) : metadataPackageFileNameFromTitle(itemId, itemId));
  const targetPath = path.join(targetDir, preferredName);
  const primaryText = language === 'ko'
    ? (texts.ko || texts.ja || sourceText)
    : (texts.ja || sourceText);
  if (!primaryText) return copied;
  fs.writeFileSync(targetPath, `${primaryText}`.trim() + '\n', 'utf8');
  copied.push(targetPath);
  return copied;
}

function exportOttogiMetadataFiles(metadataFiles = [], exportDir, targetBaseName = '') {
  fs.mkdirSync(exportDir, { recursive: true });
  const copied = [];
  for (const sourcePath of metadataFiles || []) {
    if (!sourcePath || !fs.existsSync(sourcePath)) continue;
    const isKorean = /_ko\.txt$/i.test(path.basename(sourcePath));
    const fileName = targetBaseName
      ? path.basename(writeMetadataTargetName(targetBaseName, path.basename(sourcePath, path.extname(sourcePath)), isKorean))
      : path.basename(sourcePath);
    const targetPath = path.join(exportDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);
    copied.push(targetPath);
  }
  return copied;
}

function applyOttogiGuideToItem(itemId, guide = {}, sourceUrl = '') {
  ensureQueueFolders();
  const id = safeId(itemId);
  const configPath = getItemConfigPath(id);
  const existing = readJsonIfExists(configPath);
  if (!existing) {
    const error = new Error('queue item not found');
    error.status = 404;
    throw error;
  }

  const item = normalizeItemConfig(existing, id);
  const fullMetadata = getVariantMetadata(guide, 'full');
  const highlightMetadata = getVariantMetadata(guide, 'highlight');
  const fullReviewMetadata = getVariantReviewMetadata(guide, 'full');
  const selectedTitle = selectGuideTitle(guide, 'full');
  const highlightTitle = selectGuideTitle(guide, 'highlight');
  const uploadTitle = String(selectedTitle?.title || fullMetadata.recommended_titles?.[0]?.title || fullMetadata.upload_title || item.upload_title || '').trim();
  const hashtags = normalizeHashtags(selectedTitle?.hashtags || fullMetadata.hashtags || guide.upload_hashtags || item.upload_hashtags || []);
  const shortDescription = String(fullMetadata.short_description || guide.short_description_200 || '').trim();
  const shortDescriptionKo = String(fullReviewMetadata.short_description || guide.short_description_ko || guide.explainer_text_ko || '').trim();
  const reportDescription = String(fullMetadata.report_description || guide.report_description || '').trim();
  const reportDescriptionKo = String(fullReviewMetadata.report_description || guide.report_description_ko || '').trim();
  const explainerText = String(shortDescription || guide.explainer_text || item.explainer_blocks?.[0]?.text || '').trim();
  const explainerTextKo = String(guide.explainer_text_ko || shortDescriptionKo || '').trim();
  const firstBlock = item.explainer_blocks?.[0] || defaultItemConfig(id).explainer_blocks[0];
  const metadataFiles = writeOttogiMetadataFiles(id, guide);
  const sceneTransitions = normalizeSceneTransitions(
    guide.scene_transitions,
    item.video_metadata?.duration_sec || item.target_duration_sec || 0
  );
  const sceneCaptionBlocksFromScript = buildFullCaptionScriptBlocks(guide.full_caption_script_ja, sceneTransitions, {
    fallbackDurationSec: item.video_metadata?.duration_sec || item.target_duration_sec || 30,
    animation: 'pop_in',
    styleProfile: 'full_cut_caption',
    blockPrefix: 'full_script_ja',
    language: 'ja'
  });
  const sceneCaptionBlocks = sceneCaptionBlocksFromScript.length ? sceneCaptionBlocksFromScript : buildSceneExplainerBlocks(sceneTransitions, {
    fallbackText: explainerText,
    fallbackDurationSec: item.video_metadata?.duration_sec || item.target_duration_sec || 30,
    animation: 'pop_in',
    blockPrefix: 'scene_cap'
  });
  const existingSourcePreprocess = item.source_preprocess && typeof item.source_preprocess === 'object'
    ? item.source_preprocess
    : {};
  const existingSceneDetection = existingSourcePreprocess.scene_detection && typeof existingSourcePreprocess.scene_detection === 'object'
    ? existingSourcePreprocess.scene_detection
    : {};

  const next = normalizeItemConfig({
    ...item,
    source_url: sourceUrl || guide.source_url || item.source_url || '',
    upload_title: uploadTitle || item.upload_title,
    upload_description: reportDescription || item.upload_description || shortDescription,
    upload_hashtags: hashtags.length ? hashtags : item.upload_hashtags,
    full_upload_title: uploadTitle || item.upload_title,
    full_upload_description: reportDescription || shortDescription,
    full_upload_hashtags: hashtags,
    highlight_upload_title: String(highlightTitle?.title || highlightMetadata.upload_title || uploadTitle || '').trim(),
    highlight_upload_description: String(highlightMetadata.report_description || highlightMetadata.short_description || '').trim(),
    highlight_upload_hashtags: normalizeHashtags(highlightTitle?.hashtags || highlightMetadata.hashtags || hashtags),
    output_language: 'ja',
    review_language: 'ko',
    korean_review: {
      short_description: shortDescriptionKo,
      explainer_text: explainerTextKo,
      recommended_titles: Array.isArray(guide.recommended_titles_ko) ? guide.recommended_titles_ko : [],
      report_description: reportDescriptionKo
    },
    explainer_blocks: sceneCaptionBlocks,
    explainer_mode: sceneCaptionBlocks.length > 1 ? 'scene_caption_units' : 'single_explainer_fallback',
    source_preprocess: {
      ...existingSourcePreprocess,
      scene_tail_trim_sec: 1,
      scene_detection: {
        ...existingSceneDetection,
        enabled: true,
        gemini_scene_transitions: sceneTransitions,
        gemini_scene_change_times: sceneTransitions.map((scene) => scene.transition_at_sec)
      }
    },
    gemini_scene_transitions: sceneTransitions,
    ottogi_guide_output: guide,
    ottogi_metadata_files: metadataFiles,
    metadata_generated_at: nowIso(),
    metadata_status: 'success',
    analysis_status: 'success',
    metadata_error: '',
    error: '',
    failure_title: '',
    failure_category: '',
    failure_user_message: '',
    failure_recommended_action: '',
    failure_retry_stage: '',
    failure_detail_lines: [],
    can_regenerate_draft_only: false
  }, id);
  const outputDecision = decideOutputModeForItem(next, { createHighlightDraft: true });
  const nextWithOutputDecision = normalizeItemConfig({
    ...next,
    output_mode: outputDecision.output_mode,
    skip_full_draft: outputDecision.skip_full_draft,
    skip_full_draft_reason: outputDecision.skip_reason,
    output_mode_decision: outputDecision
  }, id);

  const saved = writeJsonWithBackup(configPath, nextWithOutputDecision);
  return {
    item: summarizeItem(nextWithOutputDecision),
    item_config: nextWithOutputDecision,
    savedPath: saved.targetPath,
    backupPath: saved.backupPath || null
  };
}

function resolveItemSourcePath(item) {
  const itemDir = getItemDir(item.item_id);
  const configured = String(item.source_video || 'source_clean.mp4');
  const sourcePath = path.isAbsolute(configured)
    ? configured
    : path.join(itemDir, configured);
  return path.resolve(sourcePath);
}

function getQueueItemSourceInfo(itemId) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const itemConfig = readJsonIfExists(getItemConfigPath(id));
  if (!itemConfig) {
    const error = new Error('queue item not found');
    error.status = 404;
    throw error;
  }

  const item = normalizeItemConfig(itemConfig, id);
  const sourcePath = resolveItemSourcePath(item);
  if (!fs.existsSync(sourcePath)) {
    const error = new Error('source video not found');
    error.status = 404;
    throw error;
  }

  return {
    item_id: id,
    sourcePath,
    filename: item.source_file_original_name || path.basename(sourcePath)
  };
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function detectQueueItemTextRegions(itemId, options = {}) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const source = getQueueItemSourceInfo(id);
  const sourcePath = options.sourcePath || options.videoPath || source.sourcePath;
  const outputJson = options.outputJson || options.outputPath || getItemOcrReportPath(id);
  const previewPath = options.previewPath || getItemOcrPreviewPath(id);
  const intervalSec = Number(options.interval_sec || options.intervalSec || 2);
  const maxFrames = Number(options.max_frames || options.maxFrames || 12);

  try {
    const { stdout } = await runExecFile(resolveTool('python', { envKey: 'PYTHON_PATH' }), [
      TEXT_DETECT_SCRIPT,
      '--video',
      sourcePath,
      '--output-json',
      outputJson,
      '--preview',
      previewPath,
      '--interval-sec',
      String(intervalSec),
      '--max-frames',
      String(maxFrames)
    ], {
      cwd: PROJECT_ROOT,
      env: getToolEnv(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    });

    const parsed = readJsonIfExists(outputJson) || JSON.parse(String(stdout || '{}'));
    return {
      item_id: id,
      status: parsed.status || 'success',
      regions_count: parsed.regions_count || 0,
      zone_counts: parsed.zone_counts || {},
      report_path: outputJson,
      preview_path: fs.existsSync(previewPath) ? previewPath : '',
      source_path: sourcePath,
      detection: parsed
    };
  } catch (error) {
    const failure = {
      status: 'failed',
      item_id: id,
      generated_at: nowIso(),
      reason: error.code || 'detect_text_regions_failed',
      message: error.message,
      stdout: String(error.stdout || '').slice(0, 4000),
      stderr: String(error.stderr || '').slice(0, 4000),
      source_video: source.sourcePath
    };
    fs.writeFileSync(outputJson, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    const wrapped = new Error(`OCR text-region detection failed: ${error.message}`);
    wrapped.status = error.status || 500;
    wrapped.details = failure;
    throw wrapped;
  }
}

function withOcrRegionIds(report = {}) {
  const next = {
    ...report,
    frames: Array.isArray(report.frames)
      ? report.frames.map((frame, frameIndex) => ({
          ...frame,
          frame_id: frame.frame_id || `frame_${String(frameIndex + 1).padStart(3, '0')}`,
          regions: Array.isArray(frame.regions)
            ? frame.regions.map((region, regionIndex) => ({
                ...region,
                region_id: region.region_id || `frame_${String(frameIndex + 1).padStart(3, '0')}_region_${String(regionIndex + 1).padStart(3, '0')}`
              }))
            : []
        }))
      : []
  };
  next.regions_count = next.frames.reduce((sum, frame) => sum + (Array.isArray(frame.regions) ? frame.regions.length : 0), 0);
  return next;
}

function summarizeOcrZones(report = {}) {
  const zoneCounts = { top: 0, middle: 0, bottom: 0, unknown: 0 };
  for (const frame of report.frames || []) {
    for (const region of frame.regions || []) {
      const zone = region.zone || 'unknown';
      zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
    }
  }
  return zoneCounts;
}

function filterOcrReportByApprovedRegions(report = {}, approvedRegionIds = []) {
  const approved = new Set(approvedRegionIds);
  const withIds = withOcrRegionIds(report);
  const frames = (withIds.frames || []).map((frame) => {
    const regions = (frame.regions || []).filter((region) => approved.has(region.region_id));
    return {
      ...frame,
      regions,
      regions_count: regions.length
    };
  });
  const filtered = {
    ...withIds,
    frames,
    regions_count: frames.reduce((sum, frame) => sum + frame.regions_count, 0),
    zone_counts: summarizeOcrZones({ frames }),
    review_filter_applied: true,
    approved_region_ids: Array.from(approved)
  };
  return filtered;
}

function getOcrMaskReview(itemId) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const reportPath = getItemOcrReportPath(id);
  const previewPath = getItemOcrPreviewPath(id);
  const reviewPath = getItemOcrReviewPath(id);
  const approvedReportPath = getItemOcrApprovedReportPath(id);
  const report = readJsonIfExists(reportPath);
  const review = readJsonIfExists(reviewPath);

  return {
    item_id: id,
    report_path: reportPath,
    preview_path: fs.existsSync(previewPath) ? previewPath : '',
    preview_url: fs.existsSync(previewPath) ? `/api/process-queue/item/${id}/ocr-preview` : '',
    review_path: reviewPath,
    approved_report_path: fs.existsSync(approvedReportPath) ? approvedReportPath : '',
    report: report ? withOcrRegionIds(report) : null,
    review: review || null
  };
}

function saveOcrMaskReview(itemId, payload = {}) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const reportPath = getItemOcrReportPath(id);
  const report = readJsonIfExists(reportPath);
  if (!report) {
    const error = new Error('OCR report not found. Run OCR text detection first.');
    error.status = 404;
    throw error;
  }

  const reportWithIds = withOcrRegionIds(report);
  const regionRows = Array.isArray(payload.regions) ? payload.regions : [];
  const approvedRegionIds = Array.isArray(payload.approved_region_ids)
    ? payload.approved_region_ids.map(String)
    : regionRows.filter((row) => row && row.approved !== false).map((row) => String(row.region_id || ''));
  const rejectedRegionIds = Array.isArray(payload.rejected_region_ids)
    ? payload.rejected_region_ids.map(String)
    : regionRows.filter((row) => row && row.approved === false).map((row) => String(row.region_id || ''));

  const validRegionIds = new Set();
  for (const frame of reportWithIds.frames || []) {
    for (const region of frame.regions || []) validRegionIds.add(region.region_id);
  }
  const cleanApprovedIds = Array.from(new Set(approvedRegionIds.filter((idValue) => validRegionIds.has(idValue))));
  const cleanRejectedIds = Array.from(new Set(rejectedRegionIds.filter((idValue) => validRegionIds.has(idValue))));
  const approvedReport = filterOcrReportByApprovedRegions(reportWithIds, cleanApprovedIds);
  const approvedReportPath = getItemOcrApprovedReportPath(id);
  fs.writeFileSync(approvedReportPath, `${JSON.stringify(approvedReport, null, 2)}\n`, 'utf8');

  const review = {
    item_id: id,
    status: String(payload.status || 'approved'),
    generated_at: nowIso(),
    reviewer_notes: String(payload.reviewer_notes || ''),
    approved_region_ids: cleanApprovedIds,
    rejected_region_ids: cleanRejectedIds,
    approved_regions_count: cleanApprovedIds.length,
    rejected_regions_count: cleanRejectedIds.length,
    source_report_path: reportPath,
    approved_report_path: approvedReportPath,
    preview_path: fs.existsSync(getItemOcrPreviewPath(id)) ? getItemOcrPreviewPath(id) : ''
  };
  fs.writeFileSync(getItemOcrReviewPath(id), `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  return {
    item_id: id,
    review,
    approved_report: approvedReport,
    queue: listQueue()
  };
}

function summarizeItem(itemConfig) {
  const item = normalizeItemConfig(itemConfig, itemConfig?.item_id);
  const sourcePath = resolveItemSourcePath(item);
  const sourceExists = fs.existsSync(sourcePath);
  const ocrReport = readJsonIfExists(getItemOcrReportPath(item.item_id));
  const ocrReview = readJsonIfExists(getItemOcrReviewPath(item.item_id));
  const outputDecision = item.output_mode_decision || decideOutputModeForItem(item, { createHighlightDraft: true });
  const highlightCandidates = sourceExists
    ? getDefaultLongformHighlightWindows(item, highlightMaxDurationForItem(item, item.highlight_duration_sec), MAX_LONGFORM_HIGHLIGHT_CANDIDATES)
      .map((candidate, index) => ({
        candidate_id: `highlight_${String(index + 1).padStart(2, '0')}`,
        start_sec: candidate.start_sec,
        end_sec: candidate.end_sec,
        duration_sec: candidate.duration_sec,
        score: candidate.score || 0,
        reason: candidate.reason || '',
        selection_strategy: candidate.selection_strategy || '',
        selected_scene_ids: candidate.selected_scene_ids || [],
        single_process_only: candidate.single_process_only === true,
        longform_highlight_rule: candidate.longform_highlight_rule || ''
      }))
    : [];
  return {
    item_id: item.item_id,
    source_exists: sourceExists,
    source_path: sourcePath,
    upload_title: item.upload_title || '',
    upload_description: item.upload_description || '',
    upload_hashtags: item.upload_hashtags || [],
    source_file_original_name: item.source_file_original_name || '',
    video_metadata: item.video_metadata || null,
    source_type: item.source_type || 'unknown',
    source_type_origin: item.source_type_origin || '',
    source_workflow_mode: item.source_workflow_mode || 'unknown',
    source_classification: item.source_classification || null,
    target_duration_sec: item.target_duration_sec,
    output_mode: item.output_mode || outputDecision.output_mode || '',
    skip_full_draft: item.skip_full_draft === true || outputDecision.skip_full_draft === true,
    skip_full_draft_reason: item.skip_full_draft_reason || outputDecision.skip_reason || '',
    output_mode_decision: outputDecision || null,
    highlight_candidate_windows: highlightCandidates,
    explainer_blocks_count: Array.isArray(item.explainer_blocks) ? item.explainer_blocks.length : 0,
    explainer_preview: item.explainer_blocks?.[0]?.text || '',
    ocr_text_detection: ocrReport
      ? {
          status: ocrReport.status || '',
          regions_count: ocrReport.regions_count || 0,
          zone_counts: ocrReport.zone_counts || {},
          report_path: getItemOcrReportPath(item.item_id),
          preview_path: fs.existsSync(getItemOcrPreviewPath(item.item_id)) ? getItemOcrPreviewPath(item.item_id) : '',
          preview_url: fs.existsSync(getItemOcrPreviewPath(item.item_id)) ? `/api/process-queue/item/${item.item_id}/ocr-preview` : '',
          review: ocrReview || null
        }
      : null,
    status: 'pending',
    item_config: item
  };
}

function listQueue() {
  ensureQueueFolders();
  const queueConfig = loadQueueConfig();
  const queueItems = [];
  const entries = fs.existsSync(QUEUE_ROOT)
    ? fs.readdirSync(QUEUE_ROOT, { withFileTypes: true })
    : [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (QUEUE_RESERVED_DIRS.has(entry.name)) continue;
    const configPath = path.join(QUEUE_ROOT, entry.name, 'item_config.json');
    if (!fs.existsSync(configPath) && !/^item_\d+$/i.test(entry.name)) continue;
    const itemConfig = readJsonIfExists(configPath) || defaultItemConfig(entry.name);
    queueItems.push(summarizeItem({ ...itemConfig, item_id: itemConfig.item_id || entry.name }));
  }

  queueItems.sort((a, b) => a.item_id.localeCompare(b.item_id));
  return {
    queueRoot: QUEUE_ROOT,
    queueConfigPath: QUEUE_CONFIG_PATH,
    queueConfig,
    queueAssetIssues: getQueueAssetReadinessIssues(queueConfig),
    queueItems
  };
}

function addQueueItem({ item_id, source_path, item_config } = {}) {
  ensureQueueFolders();
  const id = safeId(item_id || item_config?.item_id || `item_${Date.now()}`);
  const itemDir = getItemDir(id);
  fs.mkdirSync(itemDir, { recursive: true });

  const normalized = normalizeItemConfig({ ...(item_config || {}), item_id: id }, id);
  const sourcePath = String(source_path || '').trim();
  if (sourcePath && fs.existsSync(sourcePath)) {
    const target = path.join(itemDir, 'source_clean.mp4');
    if (path.resolve(sourcePath) !== path.resolve(target)) {
      fs.copyFileSync(sourcePath, target);
    }
    normalized.source_video = 'source_clean.mp4';
  }

  writeJsonWithBackup(getItemConfigPath(id), normalized);
  return summarizeItem(normalized);
}

function uploadQueueItems(files = []) {
  ensureQueueFolders();
  const uploaded = [];
  const existingIds = new Set(listQueue().queueItems.map((item) => item.item_id));

  for (const file of files) {
    const itemId = nextItemId([...existingIds]);
    existingIds.add(itemId);

    const itemDir = getItemDir(itemId);
    fs.mkdirSync(itemDir, { recursive: true });
    const targetPath = path.join(itemDir, 'source_clean.mp4');
    try {
      fs.renameSync(file.path, targetPath);
    } catch {
      fs.copyFileSync(file.path, targetPath);
      fs.rmSync(file.path, { force: true });
    }

    const originalName = getUploadOriginalName(file, file.originalname || `${itemId}.mp4`);
    const metadata = getVideoMetadata(targetPath);
    const sourceClassification = classifyItemSource({
      metadata,
      requestedMode: 'auto',
      origin: 'ffprobe'
    });
    const durationSec = metadata.duration_sec || 30;
    const title = titleFromFilename(originalName) || itemId;
    const itemConfig = normalizeItemConfig(mergeSourceClassification({
      item_id: itemId,
      source_video: 'source_clean.mp4',
      target_duration_sec: Number(durationSec.toFixed ? durationSec.toFixed(3) : durationSec),
      upload_title: title,
      upload_description: '',
      upload_hashtags: ['#shorts'],
      source_file_original_name: originalName,
      video_metadata: metadata,
      explainer_blocks: [
        {
          block_id: 'exp_001',
          text: '',
          start_sec: 0,
          end_sec: Number(durationSec.toFixed ? durationSec.toFixed(3) : durationSec),
          style_role: 'main_explainer',
          anchor_zone: 'lower_third',
          animation: 'pop_in'
        }
      ]
    }, sourceClassification), itemId);

    writeJsonWithBackup(getItemConfigPath(itemId), itemConfig);
    uploaded.push(summarizeItem(itemConfig));
  }

  return {
    addedCount: uploaded.length,
    uploadedItems: uploaded,
    queue: listQueue()
  };
}

function replaceQueueItemSource(itemId, file) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const configPath = getItemConfigPath(id);
  const existingConfig = readJsonIfExists(configPath);
  if (!existingConfig) {
    const error = new Error('queue item not found');
    error.status = 404;
    throw error;
  }
  if (!file || !file.path) {
    const error = new Error('source video file is required');
    error.status = 400;
    throw error;
  }

  const itemDir = getItemDir(id);
  fs.mkdirSync(itemDir, { recursive: true });
  const targetPath = path.join(itemDir, 'source_clean.mp4');
  try {
    fs.renameSync(file.path, targetPath);
  } catch {
    fs.copyFileSync(file.path, targetPath);
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }

  const originalName = getUploadOriginalName(file, file.originalname || `${id}.mp4`);
  const metadata = getVideoMetadata(targetPath);
  const sourceClassification = classifyItemSource({
    metadata,
    requestedMode: existingConfig.source_classification?.requested_mode || existingConfig.source_type || 'auto',
    origin: 'ffprobe'
  });
  const durationSec = metadata.duration_sec || existingConfig.target_duration_sec || 30;
  const normalizedDuration = Number(durationSec.toFixed ? durationSec.toFixed(3) : durationSec);
  const blocks = Array.isArray(existingConfig.explainer_blocks) && existingConfig.explainer_blocks.length
    ? existingConfig.explainer_blocks.map((block, index) => ({
        ...block,
        start_sec: index === 0 ? 0 : block.start_sec,
        end_sec: index === 0 ? normalizedDuration : block.end_sec
      }))
    : [
        {
          block_id: 'exp_001',
          text: '',
          start_sec: 0,
          end_sec: normalizedDuration,
          style_role: 'main_explainer',
          anchor_zone: 'lower_third',
          animation: 'pop_in'
        }
      ];

  const updatedConfig = normalizeItemConfig(mergeSourceClassification({
    ...existingConfig,
    item_id: id,
    source_video: 'source_clean.mp4',
    target_duration_sec: normalizedDuration,
    upload_title: existingConfig.upload_title || titleFromFilename(originalName) || id,
    source_file_original_name: originalName,
    video_metadata: metadata,
    explainer_blocks: blocks
  }, sourceClassification), id);

  writeJsonWithBackup(configPath, updatedConfig);
  return {
    item: summarizeItem(updatedConfig),
    queue: listQueue()
  };
}

async function downloadQueueItemSourceFromUrl(itemId, url, options = {}) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const configPath = getItemConfigPath(id);
  const existingConfig = readJsonIfExists(configPath);
  if (!existingConfig) {
    const error = new Error('queue item not found');
    error.status = 404;
    throw error;
  }

  const itemDir = getItemDir(id);
  fs.mkdirSync(itemDir, { recursive: true });
  const targetPath = path.join(itemDir, 'source_clean.mp4');
  const download = await downloadYoutubeVideo({
    url,
    targetPath,
    onProgress: options.onProgress
  });
  const metadata = getVideoMetadata(download.outputPath);
  const sourceClassification = classifyItemSource({
    metadata,
    requestedMode: existingConfig.source_classification?.requested_mode || existingConfig.source_type || 'auto',
    origin: 'ffprobe'
  });
  const durationSec = metadata.duration_sec || existingConfig.target_duration_sec || 30;
  const normalizedDuration = Number(durationSec.toFixed ? durationSec.toFixed(3) : durationSec);
  const item = normalizeItemConfig(existingConfig, id);
  const blocks = Array.isArray(item.explainer_blocks) && item.explainer_blocks.length
    ? item.explainer_blocks.map((block, index) => ({
        ...block,
        start_sec: index === 0 ? 0 : block.start_sec,
        end_sec: index === 0 ? normalizedDuration : block.end_sec
      }))
    : [
        {
          block_id: 'exp_001',
          text: '',
          start_sec: 0,
          end_sec: normalizedDuration,
          style_role: 'main_explainer',
          anchor_zone: 'lower_third',
          animation: 'pop_in'
        }
      ];

  const updatedConfig = normalizeItemConfig(mergeSourceClassification({
    ...item,
    item_id: id,
    source_video: 'source_clean.mp4',
    source_url: download.url,
    target_duration_sec: normalizedDuration,
    upload_title: item.upload_title || titleFromFilename(download.filename) || id,
    source_file_original_name: download.filename,
    video_metadata: metadata,
    explainer_blocks: blocks
  }, sourceClassification), id);

  writeJsonWithBackup(configPath, updatedConfig);
  return {
    status: 'success',
    download: {
      url: download.url,
      outputPath: download.outputPath,
      filename: download.filename
    },
    item: summarizeItem(updatedConfig),
    queue: listQueue()
  };
}

function parseYoutubeUrls(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(/[\n,\s]+/);
  const urls = [];
  for (const value of values) {
    const url = String(value || '').trim();
    if (!url) continue;
    if (!/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function getYoutubeUrlFromSourceCandidate(candidate = {}) {
  const raw = candidate && typeof candidate === 'object' ? candidate : {};
  const nestedRaw = raw.raw && typeof raw.raw === 'object' ? raw.raw : {};
  const candidates = [
    raw.url,
    raw.watchUrl,
    raw.videoUrl,
    raw.source_url,
    raw.sourceUrl,
    nestedRaw.url,
    nestedRaw.watchUrl,
    nestedRaw.videoUrl,
    nestedRaw.source_url,
    nestedRaw.sourceUrl
  ];

  for (const value of candidates) {
    const url = String(value || '').trim();
    if (/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) return url;
  }

  const id = String(raw.id || raw.video_id || raw.videoId || nestedRaw.id || nestedRaw.video_id || nestedRaw.videoId || '').trim();
  if (id && /^[a-zA-Z0-9_-]{8,}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return '';
}

function importYoutubeSourceQueueItems({ videos, urls, text } = {}) {
  ensureQueueFolders();
  const sourceRows = Array.isArray(videos) && videos.length
    ? videos
    : parseYoutubeUrls(Array.isArray(urls) && urls.length ? urls : text).map((url) => ({ url }));

  if (!sourceRows.length) {
    const error = new Error('YouTube URL is required');
    error.status = 400;
    throw error;
  }
  if (sourceRows.length > MAX_YOUTUBE_IMPORT_URLS) {
    const error = new Error(`YouTube URL import is limited to ${MAX_YOUTUBE_IMPORT_URLS} items per batch`);
    error.status = 400;
    throw error;
  }

  const queue = listQueue();
  const existingIds = new Set(queue.queueItems.map((item) => item.item_id));
  const existingUrls = new Set(
    queue.queueItems
      .map((item) => String(item.item_config?.source_url || '').trim())
      .filter(Boolean)
  );
  const imported = [];
  const skipped = [];
  const failed = [];

  for (const row of sourceRows) {
    const url = getYoutubeUrlFromSourceCandidate(row);
    if (!url) {
      failed.push({
        status: 'failed',
        message: 'YouTube URL is missing',
        title: row?.title || row?.description || ''
      });
      continue;
    }
    if (existingUrls.has(url)) {
      skipped.push({
        url,
        status: 'skipped',
        reason: 'already_exists'
      });
      continue;
    }

    const itemId = nextItemId([...existingIds]);
    existingIds.add(itemId);
    existingUrls.add(url);
    const title = String(row?.title || row?.description || row?.source_file_original_name || titleFromUrl(url) || itemId).trim();
    const hashtags = normalizeHashtags(Array.isArray(row?.hashtags) && row.hashtags.length ? row.hashtags : ['#shorts']);
    const requestedMode = row?.sourceMode || row?.source_mode || row?.sourceTypeGuess || row?.source_type || 'auto';
    const phase1Classification = classifySourceVideo({
      durationSec: row?.durationSec || row?.duration_sec || row?.sourceClassification?.duration_sec || 0,
      width: row?.sourceClassification?.width || 0,
      height: row?.sourceClassification?.height || 0,
      requestedMode,
      origin: 'phase1_search'
    });
    const itemConfig = normalizeItemConfig(mergeSourceClassification({
      item_id: itemId,
      source_video: 'source_clean.mp4',
      source_url: url,
      target_duration_sec: 30,
      upload_title: title,
      upload_description: String(row?.description || ''),
      upload_hashtags: hashtags,
      source_file_original_name: title,
      youtube_download_status: 'pending',
      source_platform: row?.platform || 'youtube',
      source_creator: row?.creator || '',
      source_handle: row?.handle || '',
      source_thumbnail: row?.thumbnail || '',
      source_views: row?.views || 0,
      source_published_at: row?.publishedAt || row?.published_at || '',
      source_mode: normalizeSourceMode(row?.sourceMode || row?.source_mode || 'auto'),
      source_discovery: {
        id: row?.id || '',
        url,
        title,
        creator: row?.creator || '',
        handle: row?.handle || '',
        views: row?.views || 0,
        publishedAt: row?.publishedAt || row?.published_at || '',
        thumbnail: row?.thumbnail || '',
        durationSec: row?.durationSec || row?.duration_sec || 0,
        sourceMode: row?.sourceMode || row?.source_mode || 'auto',
        sourceTypeGuess: row?.sourceTypeGuess || row?.source_type || phase1Classification.source_type,
        sourceClassification: row?.sourceClassification || phase1Classification.source_classification
      },
      explainer_blocks: [
        {
          block_id: 'exp_001',
          text: title,
          start_sec: 0,
          end_sec: 30,
          style_role: 'main_explainer',
          anchor_zone: 'lower_third',
          animation: 'pop_in'
        }
      ]
    }, phase1Classification), itemId);

    const itemDir = getItemDir(itemId);
    fs.mkdirSync(itemDir, { recursive: true });
    writeJsonWithBackup(getItemConfigPath(itemId), itemConfig);
    imported.push({
      item_id: itemId,
      url,
      status: 'queued',
      title,
      source_type: itemConfig.source_type,
      source_workflow_mode: itemConfig.source_workflow_mode
    });
  }

  return {
    status: failed.length ? (imported.length || skipped.length ? 'partial_success' : 'failed') : 'success',
    requestedCount: sourceRows.length,
    importedCount: imported.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    imported,
    skipped,
    failed,
    queue: listQueue()
  };
}

async function importYoutubeQueueItems({ urls, text } = {}) {
  ensureQueueFolders();
  const parsedUrls = parseYoutubeUrls(Array.isArray(urls) && urls.length ? urls : text);
  if (!parsedUrls.length) {
    const error = new Error('YouTube URL is required');
    error.status = 400;
    throw error;
  }
  if (parsedUrls.length > MAX_YOUTUBE_IMPORT_URLS) {
    const error = new Error(`YouTube URL import is limited to ${MAX_YOUTUBE_IMPORT_URLS} items per batch`);
    error.status = 400;
    throw error;
  }

  const imported = [];
  const failed = [];
  const existingIds = new Set(listQueue().queueItems.map((item) => item.item_id));

  for (let urlIndex = 0; urlIndex < parsedUrls.length; urlIndex += 1) {
    const url = parsedUrls[urlIndex];
    const itemId = nextItemId([...existingIds]);
    existingIds.add(itemId);
    const itemDir = getItemDir(itemId);
    fs.mkdirSync(itemDir, { recursive: true });
    const initialConfig = normalizeItemConfig({
      item_id: itemId,
      source_video: 'source_clean.mp4',
      source_url: url,
      target_duration_sec: 30,
      upload_title: titleFromUrl(url),
      upload_description: '',
      upload_hashtags: ['#shorts'],
      source_file_original_name: titleFromUrl(url),
      youtube_download_status: 'pending',
      explainer_blocks: [
        {
          block_id: 'exp_001',
          text: '',
          start_sec: 0,
          end_sec: 30,
          style_role: 'main_explainer',
          anchor_zone: 'lower_third',
          animation: 'pop_in'
        }
      ]
    }, itemId);
    writeJsonWithBackup(getItemConfigPath(itemId), initialConfig);

    try {
      const downloaded = await downloadQueueItemSourceFromUrl(itemId, url);
      const finalConfig = {
        ...(downloaded.item?.item_config || readJsonIfExists(getItemConfigPath(itemId)) || {}),
        youtube_download_status: 'success',
        youtube_downloaded_at: nowIso()
      };
      writeJsonWithBackup(getItemConfigPath(itemId), normalizeItemConfig(finalConfig, itemId));
      imported.push({
        item_id: itemId,
        url,
        status: 'success',
        filename: downloaded.download?.filename || 'source_clean.mp4'
      });
    } catch (error) {
      const failedConfig = {
        ...(readJsonIfExists(getItemConfigPath(itemId)) || initialConfig),
        youtube_download_status: 'failed',
        youtube_download_error: error.message,
        youtube_downloaded_at: nowIso()
      };
      writeJsonWithBackup(getItemConfigPath(itemId), normalizeItemConfig(failedConfig, itemId));
      failed.push({
        item_id: itemId,
        url,
        status: 'failed',
        message: error.message
      });
    }

    if (urlIndex < parsedUrls.length - 1) {
      const delayMs = randomInt(YOUTUBE_IMPORT_DELAY_MIN_MS, YOUTUBE_IMPORT_DELAY_MAX_MS);
      await sleep(delayMs);
    }
  }

  return {
    status: failed.length ? (imported.length ? 'partial_success' : 'failed') : 'success',
    maxItems: MAX_YOUTUBE_IMPORT_URLS,
    requestedCount: parsedUrls.length,
    importedCount: imported.length,
    failedCount: failed.length,
    throttle: {
      sequential: true,
      delayMinMs: YOUTUBE_IMPORT_DELAY_MIN_MS,
      delayMaxMs: YOUTUBE_IMPORT_DELAY_MAX_MS,
      ytDlpSleepRequests: true
    },
    imported,
    failed,
    queue: listQueue()
  };
}

function removeQueueItem(itemId) {
  ensureQueueFolders();
  const id = safeId(itemId);
  const itemDir = getItemDir(id);
  if (fs.existsSync(itemDir)) {
    fs.rmSync(itemDir, { recursive: true, force: true });
  }
  return {
    removed: true,
    item_id: id,
    queue: listQueue()
  };
}

function removeQueueItems(itemIds = []) {
  ensureQueueFolders();
  const uniqueIds = Array.from(new Set(
    (Array.isArray(itemIds) ? itemIds : [])
      .map((id) => safeId(id))
      .filter(Boolean)
  ));

  const removed = uniqueIds.map((id) => {
    const itemDir = getItemDir(id);
    const existed = fs.existsSync(itemDir);
    if (existed) {
      fs.rmSync(itemDir, { recursive: true, force: true });
    }
    return { item_id: id, removed: existed };
  });

  return {
    removed: true,
    removedCount: removed.filter((item) => item.removed).length,
    requestedCount: uniqueIds.length,
    items: removed,
    queue: listQueue()
  };
}

function duplicateQueueItem(itemId) {
  ensureQueueFolders();
  const sourceId = safeId(itemId);
  const sourceConfig = readJsonIfExists(getItemConfigPath(sourceId));
  if (!sourceConfig) {
    const error = new Error('queue item not found');
    error.status = 404;
    throw error;
  }

  const existing = new Set(listQueue().queueItems.map((item) => item.item_id));
  let copyIndex = 1;
  let targetId = `${sourceId}_copy`;
  while (existing.has(targetId)) {
    copyIndex += 1;
    targetId = `${sourceId}_copy_${copyIndex}`;
  }

  const sourceDir = getItemDir(sourceId);
  const targetDir = getItemDir(targetId);
  fs.mkdirSync(targetDir, { recursive: true });
  const sourceVideo = path.join(sourceDir, 'source_clean.mp4');
  if (fs.existsSync(sourceVideo)) {
    fs.copyFileSync(sourceVideo, path.join(targetDir, 'source_clean.mp4'));
  }

  const duplicated = normalizeItemConfig({
    ...sourceConfig,
    item_id: targetId,
    upload_title: sourceConfig.upload_title ? `${sourceConfig.upload_title} copy` : ''
  }, targetId);
  writeJsonWithBackup(getItemConfigPath(targetId), duplicated);
  return summarizeItem(duplicated);
}

function saveQueue({ queue_config, queue_items } = {}) {
  const configResult = saveQueueConfig(queue_config || {});
  const items = [];
  if (Array.isArray(queue_items)) {
    for (const item of queue_items) {
      items.push(addQueueItem({ item_id: item.item_id, item_config: item.item_config || item }));
    }
  }
  return {
    savedPath: configResult.targetPath,
    backupPath: configResult.backupPath,
    queue: listQueue(),
    savedItems: items
  };
}

const FULL_DRAFT_TRANSFORM_TERM_GROUPS = {
  impact: [
    'press', 'pressed', 'pressing', 'stamp', 'stamping', 'punch', 'impact', 'cut', 'cutting',
    'crush', 'squeeze', 'compress', 'mold', 'shape',
    '\u30d7\u30ec\u30b9', '\u5727\u7e2e', '\u6210\u5f62', '\u5207\u65ad', '\u62bc\u3057',
    '\uc555\ucc29', '\uc808\ub2e8', '\uc131\ud615'
  ],
  flow: [
    'pour', 'flow', 'stream', 'extrude', 'extruder', 'noodle', 'liquid', 'conveyor',
    'fill', 'feed', 'drip', 'pipe', 'roll',
    '\u6d41', '\u6ce8\u304e', '\u62bc\u3057\u51fa', '\u62bc\u51fa', '\u30cc\u30fc\u30c9\u30eb', '\u30b3\u30f3\u30d9\u30a2',
    '\ud750\ub984', '\uc555\ucd9c', '\ucee8\ubca0\uc774\uc5b4'
  ],
  human: [
    'hand', 'hands', 'worker', 'manual', 'artisan', 'craft', 'trim', 'arrange', 'operator',
    'finger', 'arm', 'hold', 'placing',
    '\u624b\u5143', '\u4f5c\u696d\u54e1', '\u8077\u4eba', '\u624b\u4f5c\u696d', '\u624b\u3067',
    '\uc190', '\uc7a5\uc778', '\uc218\uc791\uc5c5'
  ],
  reveal: [
    'transform', 'reveal', 'unexpected', 'mystery', 'change', 'before', 'after', 'becomes',
    'finished', 'result', 'package', 'final',
    '\u5909\u5316', '\u5909\u8eab', '\u9a5a\u304d', '\u79d8\u5bc6', '\u5b8c\u6210', '\u6700\u7d42',
    '\ubcc0\uc2e0', '\ubcc0\ud654', '\uc644\uc131', '\uacb0\uacfc'
  ]
};

function classifyFullDraftTransform(itemConfig = {}, sceneTransitions = [], language = 'ja') {
  const scenes = normalizeSceneTransitions(
    sceneTransitions,
    itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0
  );
  const sourceWidth = Number(itemConfig.video_metadata?.width || itemConfig.source_metadata?.width || 0);
  const sourceHeight = Number(itemConfig.video_metadata?.height || itemConfig.source_metadata?.height || 0);
  const isLongformSource = itemConfig.source_workflow_mode === 'longform_to_shorts' || itemConfig.source_type === 'longform';
  const isWideLongformSource = isLongformSource && sourceWidth > 0 && sourceHeight > 0 && sourceWidth > sourceHeight * 1.2;
  const guide = itemConfig.ottogi_guide_output || {};
  const texts = [
    ...scenes.map(getSceneHighlightText),
    guide.process_summary,
    guide.process_flow_summary,
    guide.explainer_text,
    guide.explainer_text_ko,
    itemConfig.upload_title,
    itemConfig.upload_description
  ].map((value) => String(value || '').toLowerCase()).filter(Boolean);
  const countGroup = (group) => countTermHits(texts, FULL_DRAFT_TRANSFORM_TERM_GROUPS[group]);
  const cameraMoves = scenes.map((scene) => String(scene.recommended_camera_move || '').toLowerCase()).filter(Boolean);
  const sceneCount = scenes.length;
  const scores = {
    human: countGroup('human') + scenes.filter((scene) => scene.human_presence === true).length,
    impact: countGroup('impact') + cameraMoves.filter((move) => move === 'punch_zoom').length,
    flow: countGroup('flow') + cameraMoves.filter((move) => move === 'scan_left' || move === 'scan_right' || move === 'speed_up').length,
    reveal: countGroup('reveal'),
    repetition: countTermHits(texts, HIGHLIGHT_REPETITION_TERMS)
  };
  const highMotionScenes = scenes.filter((scene) => scene.motion_intensity === 'high').length;
  const actionChangeScenes = scenes.filter((scene) => scene.change_type === 'action_change').length;
  const avgVisualHook = sceneCount
    ? scenes.reduce((sum, scene) => sum + clampScore(scene.visual_hook_score, 1, 10, 1), 0) / sceneCount
    : 0;
  const avgRepetition = sceneCount
    ? scenes.reduce((sum, scene) => sum + clampScore(scene.repetition_potential, 1, 10, 1), 0) / sceneCount
    : 0;

  let presetId = '';
  let reason = 'base_preset_kept';
  const humanThreshold = Math.max(2, Math.ceil(sceneCount * 0.22));
  const rhythmThreshold = Math.max(2, Math.ceil(sceneCount * 0.28));

  if (isWideLongformSource) {
    presetId = 'full_longform_core_crop';
    reason = 'wide_longform_full_requires_core_process_vertical_crop';
  } else if (scores.human >= humanThreshold) {
    presetId = 'full_process_hand_focus';
    reason = 'hands_or_workers_dominate_full_draft';
  } else if (scores.impact >= 2 || highMotionScenes >= rhythmThreshold || cameraMoves.includes('punch_zoom')) {
    presetId = 'full_process_punch_detail';
    reason = 'press_cut_or_high_motion_process';
  } else if (scores.flow >= 2) {
    presetId = 'full_process_flow_follow';
    reason = 'flow_extrusion_or_conveyor_process';
  } else if (scores.repetition >= 2 || avgRepetition >= 7 || actionChangeScenes >= rhythmThreshold) {
    presetId = 'full_process_rhythm_scan';
    reason = 'repetitive_machine_or_action_change_rhythm';
  } else if (scores.reveal >= 2 || avgVisualHook >= 7.5) {
    presetId = 'full_process_reveal_context';
    reason = 'transformation_or_reveal_process';
  }

  return {
    selected_preset_id: presetId,
    reason,
    language,
    scores,
    scene_count: sceneCount,
    high_motion_scenes: highMotionScenes,
    action_change_scenes: actionChangeScenes,
    average_visual_hook_score: Number(avgVisualHook.toFixed(2)),
    average_repetition_potential: Number(avgRepetition.toFixed(2)),
    wide_longform_core_crop: isWideLongformSource,
    source_dimensions: sourceWidth && sourceHeight ? { width: sourceWidth, height: sourceHeight } : null,
    camera_moves: cameraMoves.slice(0, 30),
    selected_scene_ids: scenes.map((scene) => scene.scene_id).filter(Boolean).slice(0, 60)
  };
}

function selectFullDraftVideoTransformPreset(basePresetId, itemConfig = {}, sceneTransitions = [], language = 'ja') {
  const baseId = String(basePresetId || 'steady_zoom_process').trim();
  const analysis = classifyFullDraftTransform(itemConfig, sceneTransitions, language);
  const isLongformSource = itemConfig.source_workflow_mode === 'longform_to_shorts'
    || itemConfig.source_type === 'longform';
  const requiresLongformCoreCrop = itemConfig.source_window_strategy === 'longform_full_from_highlight_candidates'
    || itemConfig.source_window_full?.mode === 'longform_full_from_highlight_candidates';
  if (requiresLongformCoreCrop) {
    return {
      presetId: 'full_longform_core_crop',
      analysis: {
        ...analysis,
        reason: 'longform_full_candidate_bundle_requires_core_process_vertical_crop',
        base_preset_id: baseId,
        selected_preset_id: 'full_longform_core_crop',
        auto_selected: true,
        forced_by_source_window_strategy: true,
        source_window_strategy: itemConfig.source_window_strategy || itemConfig.source_window_full?.mode || ''
      }
    };
  }
  const selectedPresetId = analysis.selected_preset_id || baseId;
  if (!isLongformSource) {
    const safePreset = buildShortformFullTemplateSafePreset(selectedPresetId);
    return {
      presetId: safePreset,
      analysis: {
        ...analysis,
        base_preset_id: baseId,
        selected_preset_id: safePreset.preset_id,
        source_auto_selected_preset_id: selectedPresetId,
        auto_selected: true,
        forced_by_source_type: 'shortform_full_template_safe_zoom',
        max_zoom_scale: safePreset.max_zoom_scale,
        reason: 'shortform_full_uses_capcut_template_so_zoom_is_capped_under_50_percent'
      }
    };
  }
  return {
    presetId: selectedPresetId,
    analysis: {
      ...analysis,
      base_preset_id: baseId,
      selected_preset_id: selectedPresetId,
      auto_selected: Boolean(analysis.selected_preset_id)
    }
  };
}

function mergeBatchConfig(queueConfig, itemConfig) {
  const item = normalizeItemConfig(itemConfig, itemConfig?.item_id);
  const itemSourcePath = resolveItemSourcePath(item);
  const actualSourceDuration = getSourceVideoDurationSec(itemSourcePath, item);
  const sourceDuration = actualSourceDuration || item.video_metadata?.duration_sec || item.target_duration_sec || 30;
  const sceneTransitions = normalizeSceneTransitions(getItemSceneTransitions(item), sourceDuration);
  const guide = item.ottogi_guide_output || {};
  const fullMetadata = getVariantMetadata(guide, 'full');
  const firstBlock = Array.isArray(item.explainer_blocks) && item.explainer_blocks.length
    ? item.explainer_blocks[0]
    : defaultItemConfig(item.item_id).explainer_blocks[0];
  const manualExplainerBlocksEnabled = item.manual_explainer_blocks_enabled === true;
  const narrativeText = String(
    fullMetadata.summary_caption
      || fullMetadata.short_description
      || guide.explainer_text
      || firstBlock?.text
      || ''
  ).trim();
  const fullScriptBlocks = buildFullCaptionScriptBlocks(guide.full_caption_script_ja, sceneTransitions, {
    fallbackDurationSec: sourceDuration,
    animation: 'pop_in',
    styleProfile: 'full_cut_caption',
    blockPrefix: 'full_script_ja',
    language: 'ja'
  });
  const storedSceneBlocks = item.explainer_mode === 'scene_caption_units' && Array.isArray(item.explainer_blocks)
    ? item.explainer_blocks
    : [];
  const sceneCaptionBlocks = fullScriptBlocks.length
    ? fullScriptBlocks
    : (storedSceneBlocks.length
      ? storedSceneBlocks
      : buildSceneExplainerBlocks(sceneTransitions, {
        fallbackText: narrativeText,
        fallbackDurationSec: sourceDuration,
        animation: 'pop_in',
        styleProfile: 'full_cut_caption',
        blockPrefix: 'scene_cap'
      }));
  const explainerBlocks = manualExplainerBlocksEnabled && Array.isArray(item.explainer_blocks) && item.explainer_blocks.length
    ? item.explainer_blocks
    : (sceneCaptionBlocks.length
      ? sceneCaptionBlocks
      : buildNarrativeFullDraftBlocks({
        text: narrativeText,
        language: 'ja',
        durationSec: sourceDuration,
        sceneCount: sceneTransitions.length || 1,
        animation: 'pop_in',
        blockPrefix: 'full_narrative_ja'
      }))
    || item.explainer_blocks;
  const fullDraftExplainerBlocks = Array.isArray(explainerBlocks)
    ? explainerBlocks.map((block) => ({
        ...block,
        style_profile: block.style_profile || 'full_cut_caption'
      }))
    : explainerBlocks;
  const fullDraftWithHook = applyFullPrerollHookToBlocks(fullDraftExplainerBlocks, item, queueConfig, 'ja');
  const fullDraftTargetDuration = Number(
    (sourceDuration + fullDraftWithHook.hookDurationSec).toFixed(3)
  );
  const fullTransform = selectFullDraftVideoTransformPreset(
    item.video_transform_preset || queueConfig.video_transform_preset,
    item,
    sceneTransitions,
    'ja'
  );

  const config = normalizeConfig({
    mode: 'ultra_efficiency_process',
    source_video: itemSourcePath,
    target_duration_sec: fullDraftTargetDuration,
    upload_title: item.upload_title,
    upload_description: item.upload_description,
    upload_hashtags: item.upload_hashtags,
    explainer_blocks: fullDraftWithHook.blocks,
    channel_tag: item.channel_tag || queueConfig.channel_tag,
    channel_asset: item.channel_asset || queueConfig.channel_asset,
    channel_frame_asset: disabledChannelFrameAsset(),
    capcut_template_id: item.capcut_template_id || queueConfig.capcut_template_id,
    capcut_template_source: item.capcut_template_source || queueConfig.capcut_template_source,
    capcut_template_draft_name: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_full'),
    variant_policy_id: 'jp_full',
    caption_mode: 'scene_based_short_subtitles',
    visual_template: 'jp_full',
    capcut_template_search_root: item.capcut_template_search_root || queueConfig.capcut_template_search_root || queueConfig.output?.output_root || '',
    output_root: queueConfig.output?.output_root || '',
    video_transform_preset: fullTransform.presetId,
    source_preprocess: item.source_preprocess || queueConfig.source_preprocess,
    use_bgm: (item.custom_bgm_path || queueConfig.custom_bgm_path) ? true : (item.use_bgm ?? queueConfig.use_bgm),
    bgm_preset: item.bgm_preset || queueConfig.bgm_preset,
    custom_bgm_path: item.custom_bgm_path || queueConfig.custom_bgm_path,
    bgm_volume: item.bgm_volume ?? queueConfig.bgm_volume,
    use_tts: item.use_tts ?? queueConfig.use_tts
  });
  config.full_draft_video_transform_analysis = fullTransform.analysis;
  return config;
}

function uploadQueueBgm(file, options = {}) {
  ensureQueueFolders();
  if (!file) {
    const error = new Error('audio file is required');
    error.status = 400;
    throw error;
  }
  const rawTarget = String(options.target || options.mode || '').toLowerCase();
  const target = ['highlight', 'midform'].includes(rawTarget) ? rawTarget : 'default';
  const targetMap = {
    default: {
      root: QUEUE_BGM_ROOT,
      prefix: 'batch_bgm',
      patch: (current, targetPath, originalName, filename) => ({
        ...current,
        use_bgm: true,
        custom_bgm_path: targetPath,
        custom_bgm_original_name: originalName || filename
      })
    },
    highlight: {
      root: QUEUE_HIGHLIGHT_BGM_ROOT,
      prefix: 'highlight_bgm',
      patch: (current, targetPath, originalName, filename) => ({
        ...current,
        create_highlight_draft: true,
        highlight_custom_bgm_path: targetPath,
        highlight_custom_bgm_original_name: originalName || filename
      })
    },
    midform: {
      root: QUEUE_MIDFORM_BGM_ROOT,
      prefix: 'midform_bgm',
      patch: (current, targetPath, originalName, filename) => ({
        ...current,
        create_midform_draft: true,
        midform_custom_bgm_path: targetPath,
        midform_custom_bgm_original_name: originalName || filename
      })
    }
  };
  const targetConfig = targetMap[target];
  const bgmRoot = targetConfig.root;
  const prefix = targetConfig.prefix;
  const originalName = getUploadOriginalName(file, file.originalname || '');
  const ext = getUploadExt(file, '.mp3');
  const filename = `${prefix}${ext}`;
  const targetPath = path.join(bgmRoot, filename);
  for (const entry of fs.readdirSync(bgmRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      fs.rmSync(path.join(bgmRoot, entry.name), { force: true });
    }
  }
  fs.copyFileSync(file.path, targetPath);
  if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

  const current = loadQueueConfig();
  const saved = saveQueueConfig(targetConfig.patch(current, targetPath, originalName, filename));

  return {
    status: 'success',
    target,
    custom_bgm_path: targetPath,
    custom_bgm_original_name: originalName || filename,
    savedPath: saved.targetPath,
    backupPath: saved.backupPath || null,
    queue: listQueue()
  };
}

function uploadQueueChannelAsset(file, options = {}) {
  ensureQueueFolders();
  if (!file) {
    const error = new Error('channel asset file is required');
    error.status = 400;
    throw error;
  }
  const rawTarget = String(options.target || options.mode || '').toLowerCase();
  const target = ['highlight', 'midform'].includes(rawTarget) ? rawTarget : 'default';
  const targetMap = {
    default: {
      root: QUEUE_CHANNEL_ASSET_ROOT,
      prefix: 'channel_asset',
      key: 'channel_asset',
      defaultPosition: 'top_left',
      extraPatch: {}
    },
    highlight: {
      root: QUEUE_HIGHLIGHT_CHANNEL_ASSET_ROOT,
      prefix: 'highlight_channel_asset',
      key: 'highlight_channel_asset',
      defaultPosition: 'top_right',
      extraPatch: { create_highlight_draft: true }
    },
    midform: {
      root: QUEUE_MIDFORM_CHANNEL_ASSET_ROOT,
      prefix: 'midform_channel_asset',
      key: 'midform_channel_asset',
      defaultPosition: 'top_right',
      extraPatch: { create_midform_draft: true }
    }
  };
  const targetConfig = targetMap[target];
  const assetRoot = targetConfig.root;
  const prefix = targetConfig.prefix;
  const originalName = getUploadOriginalName(file, file.originalname || '');
  const ext = getUploadExt(file, '.mp4');
  const filename = `${prefix}${ext}`;
  const targetPath = path.join(assetRoot, filename);
  for (const entry of fs.readdirSync(assetRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      fs.rmSync(path.join(assetRoot, entry.name), { force: true });
    }
  }
  fs.copyFileSync(file.path, targetPath);
  if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

  const current = loadQueueConfig();
  const key = targetConfig.key;
  const existing = current[key] || {};
  const saved = saveQueueConfig({
    ...current,
    ...targetConfig.extraPatch,
    [key]: {
      ...existing,
      enabled: true,
      path: targetPath,
      original_name: originalName || filename,
      position: existing.position || targetConfig.defaultPosition,
      scale: existing.scale || 0.34,
      opacity: existing.opacity ?? 1,
      replace_channel_tag_text: existing.replace_channel_tag_text === true
    }
  });

  return {
    status: 'success',
    target,
    channel_asset_path: targetPath,
    channel_asset_original_name: originalName || filename,
    savedPath: saved.targetPath,
    backupPath: saved.backupPath || null,
    queue: listQueue()
  };
}

function buildShortformFullTemplateSafePreset(basePresetId = 'steady_zoom_process') {
  const baseId = String(basePresetId || 'steady_zoom_process').trim();
  return {
    preset_id: 'full_shortform_template_safe_zoom',
    name: 'Full Shortform Template Safe Zoom',
    display_name: 'Full Shortform Template Safe Zoom',
    description: 'Shortform Full Draft preset: keep visual zoom at 1.50x or lower because the CapCut template supplies the stronger motion layer.',
    source_base_preset_id: baseId,
    segment_unit_sec: 2.4,
    mirror_policy: 'global_once_only',
    global_transform: { mirror: true, scale: 1.18 },
    segment_transform_rules: { segment_mirror_allowed: false },
    pan_limit_x: 0.12,
    pan_limit_y: 0.10,
    max_zoom_scale: 1.50,
    crop_mode: 'vertical_fill',
    crop_zoom: true,
    crop_intent: 'shortform_full_template_safe_under_50_percent_zoom',
    pattern: [
      { scale: 1.18, pan_x: 0.00, pan_y: 0.00, rotation: -0.6, speed: 1.00, label: 'template_safe_entry' },
      { scale: 1.32, pan_x: -0.06, pan_y: 0.02, rotation: 0.9, speed: 1.04, label: 'template_safe_detail' },
      { scale: 1.48, pan_x: 0.06, pan_y: -0.02, rotation: -1.0, speed: 0.96, label: 'template_safe_push' },
      { scale: 1.26, pan_x: 0.04, pan_y: 0.04, rotation: 0.7, speed: 1.08, label: 'template_safe_reset' },
      { scale: 1.42, pan_x: -0.04, pan_y: -0.03, rotation: -0.8, speed: 1.00, label: 'template_safe_finish' }
    ],
    process_order: [
      'Use shortform source as the main image and let the CapCut template add the stronger movement',
      'Never exceed 1.50x zoom for shortform Full Drafts',
      'Keep pan and rotation modest so captions and template effects stay readable'
    ],
    mirror: true,
    speed_variation: true,
    speed: { enabled: true, mode: 'sequence', value: 1.0 },
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'soft_rotation', max_degrees: 1.0 },
    sharpen: true,
    cut_trim: true,
    reorder: false
  };
}

function copyIfExists(sourcePath, targetPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function attachJsonFilePatch(filePath, patch) {
  const current = readJsonIfExists(filePath);
  if (!current) return false;
  fs.writeFileSync(filePath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
  return true;
}

function buildVariantStrategyManifestPatch(itemConfig = {}, variantKey = 'jp_full') {
  const guide = itemConfig.ottogi_guide_output && typeof itemConfig.ottogi_guide_output === 'object'
    ? itemConfig.ottogi_guide_output
    : {};
  const regionalEditingStrategy = guide.regional_editing_strategy && typeof guide.regional_editing_strategy === 'object'
    ? guide.regional_editing_strategy
    : null;
  const variantStrategy = guide.variant_strategy && typeof guide.variant_strategy === 'object'
    ? guide.variant_strategy
    : null;
  const variantInfo = variantStrategy && variantStrategy[variantKey] && typeof variantStrategy[variantKey] === 'object'
    ? variantStrategy[variantKey]
    : {};
  const isHighlight = String(variantKey || '').includes('highlight');

  return {
    regional_editing_strategy: regionalEditingStrategy,
    variant_strategy: variantStrategy,
    variant_strategy_phase: 'phase1_shared_cut_plan',
    variant_strategy_key: variantKey,
    variant_cut_plan_source: variantInfo.cut_plan_source || (isHighlight ? 'highlight_cut_plan_base' : 'full_cut_plan_base'),
    variant_caption_goal: variantInfo.caption_goal || '',
    variant_metadata_goal: variantInfo.metadata_goal || '',
    phase2_cut_plan_differentiation: {
      planned: true,
      requires_extra_gemini_call: true,
      status: 'not_implemented_in_phase1'
    }
  };
}

function buildVariantStrategyNoteLines(itemConfig = {}, variantKey = 'jp_full') {
  const patch = buildVariantStrategyManifestPatch(itemConfig, variantKey);
  const regionalKeys = patch.regional_editing_strategy
    ? Object.keys(patch.regional_editing_strategy).join(', ')
    : 'none';
  return [
    '',
    '## Regional Variant Strategy',
    `- Variant Key: ${patch.variant_strategy_key}`,
    `- Phase: ${patch.variant_strategy_phase}`,
    `- Cut Plan Source: ${patch.variant_cut_plan_source}`,
    `- Caption Goal: ${patch.variant_caption_goal || 'not recorded'}`,
    `- Metadata Goal: ${patch.variant_metadata_goal || 'not recorded'}`,
    `- Regional Strategy Keys: ${regionalKeys}`,
    '- Phase 2 Plan: add one extra Gemini call for cut-plan differentiation when needed',
    ''
  ];
}

function removeDirRecursive(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      removeDirRecursive(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  }
  fs.rmdirSync(targetDir);
}

function cleanDirForCopy(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.name === '.locked') continue;
    try {
      if (entry.isDirectory()) {
        removeDirRecursive(entryPath);
      } else {
        fs.unlinkSync(entryPath);
      }
    } catch (error) {
      // CapCut may keep draft internals locked while the project is open.
      // Preserve locked files and continue copying new draft files around them.
      if (error && ['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) continue;
      throw error;
    }
  }
}

function copyDirRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function copyDirContents(sourceDir, targetDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return false;
  if (fs.existsSync(targetDir)) {
    cleanDirForCopy(targetDir);
  }
  copyDirRecursive(sourceDir, targetDir);
  return true;
}

function getGeneratingDraftFolderPath(finalDir) {
  const parentDir = path.dirname(finalDir);
  const finalName = path.basename(finalDir);
  return path.join(parentDir, `생성중__${finalName}`);
}

function prepareGeneratingDraftFolder(finalDir) {
  const generatingDir = getGeneratingDraftFolderPath(finalDir);
  if (fs.existsSync(generatingDir)) {
    cleanDirForCopy(generatingDir);
  } else {
    fs.mkdirSync(generatingDir, { recursive: true });
  }
  return generatingDir;
}

function finalizeGeneratingDraftFolder(generatingDir, finalDir) {
  if (!generatingDir || !fs.existsSync(generatingDir)) {
    throw new Error(`generating draft folder not found: ${generatingDir}`);
  }
  if (fs.existsSync(finalDir)) {
    cleanDirForCopy(finalDir);
    copyDirContents(generatingDir, finalDir);
    fs.rmSync(generatingDir, { recursive: true, force: true });
    return { method: 'copied_over_existing' };
  }
  fs.renameSync(generatingDir, finalDir);
  return { method: 'renamed' };
}

function copyDraftToGeneratingFolder(sourceDir, finalDir) {
  const generatingDir = prepareGeneratingDraftFolder(finalDir);
  copyDirContents(sourceDir, generatingDir);
  return generatingDir;
}

function normalizeFinalDraftCaptions(draftDir) {
  const draftContentPath = path.join(draftDir, 'draft_content.json');
  const draftContent = readJsonIfExists(draftContentPath);
  if (!draftContent) {
    return { applied: false, reason: 'draft_content.json not found' };
  }

  const textTrack = (draftContent.tracks || []).find((track) => (
    track && track.type === 'text' && track.name === 'process_explainer'
  ));
  if (!textTrack || !Array.isArray(textTrack.segments)) {
    return { applied: false, reason: 'process_explainer track not found' };
  }

  const textMaterials = Array.isArray(draftContent.materials?.texts)
    ? draftContent.materials.texts
    : [];
  const materialById = new Map(textMaterials.map((material) => [material.id, material]));
  textTrack.visible = true;

  const visibleSegments = textTrack.segments
    .filter((segment) => segment && !segment.__hidden)
    .sort((a, b) => Number(a.target_timerange?.start || 0) - Number(b.target_timerange?.start || 0));

  visibleSegments.forEach((segment, index) => {
    const target = segment.target_timerange || {};
    const duration = Number(target.duration || segment.render_timerange?.duration || 0);
    segment.visible = true;
    segment.render_index = 15000 + index;
    segment.track_render_index = 0;
    segment.clip = {
      ...(segment.clip || {}),
      alpha: 1
    };
    if (duration > 0) {
      segment.render_timerange = { start: 0, duration };
      if (segment.source_timerange && typeof segment.source_timerange === 'object') {
        segment.source_timerange = { start: 0, duration };
      }
    }

    const material = materialById.get(segment.material_id || segment.materialId);
    if (!material) return;
    material.visible = true;
    material.global_alpha = 1;
    material.text_alpha = 1;
    material.render_index = 15000 + index;
    material.track_render_index = 0;
    material.animations = [];
    material.extra_material_refs = [];

    try {
      const content = JSON.parse(material.content || '{}');
      const text = String(content.text || '');
      content.styles = Array.isArray(content.styles) && content.styles.length ? content.styles : [{}];
      content.styles = content.styles.map((style) => ({
        ...style,
        range: [0, [...text].length],
        fill: {
          ...(style.fill || {}),
          alpha: 1,
          content: {
            ...((style.fill || {}).content || {}),
            render_type: 'solid',
            solid: {
              ...(((style.fill || {}).content || {}).solid || {}),
              alpha: 1
            }
          }
        },
        strokes: Array.isArray(style.strokes)
          ? style.strokes.map((stroke) => ({
              ...stroke,
              alpha: 1,
              content: {
                ...((stroke || {}).content || {}),
                render_type: 'solid',
                solid: {
                  ...(((stroke || {}).content || {}).solid || {}),
                  alpha: 1
                }
              }
            }))
          : style.strokes
      }));
      material.content = JSON.stringify(content);
    } catch (_error) {
      // Keep the material usable even if CapCut changes the content schema.
    }
  });

  fs.writeFileSync(draftContentPath, `${JSON.stringify(draftContent, null, 2)}\n`, 'utf8');
  return {
    applied: true,
    track_name: 'process_explainer',
    segments_checked: visibleSegments.length,
    reason: 'final CapCut draft folder captions normalized'
  };
}

function getItemSceneTransitions(itemConfig = {}) {
  const direct = Array.isArray(itemConfig.gemini_scene_transitions)
    ? itemConfig.gemini_scene_transitions
    : [];
  const fromGuide = Array.isArray(itemConfig.ottogi_guide_output?.scene_transitions)
    ? itemConfig.ottogi_guide_output.scene_transitions
    : [];
  const fromPreprocess = Array.isArray(itemConfig.source_preprocess?.scene_detection?.gemini_scene_transitions)
    ? itemConfig.source_preprocess.scene_detection.gemini_scene_transitions
    : [];
  return direct.length ? direct : (fromGuide.length ? fromGuide : fromPreprocess);
}

function getSceneHighlightText(scene = {}) {
  return [
    scene.visual_summary,
    scene.focus_target,
    scene.change_type,
    scene.recommended_camera_move,
    scene.caption_text,
    scene.caption_text_ko,
    scene.visual_hook_type,
    scene.curiosity_reason,
    scene.mechanical_rhythm,
    scene.process_focus_priority
  ].map((value) => String(value || '').toLowerCase()).join(' ');
}

const HIGHLIGHT_MECHANICAL_TERMS = [
  'press', 'pressed', 'pressing', 'stamp', 'mold', 'mould', 'shape', 'forming', 'form', 'punch',
  'cut', 'cutter', 'slice', 'wire', 'extrude', 'extruder', 'noodle', 'pellet', 'pour', 'feed',
  'machine', 'robot', 'mechanical',
  '\u30d7\u30ec\u30b9', '\u6210\u5f62', '\u578b', '\u62bc\u3057\u51fa', '\u62bc\u51fa',
  '\u5207\u65ad', '\u30ab\u30c3\u30bf\u30fc', '\u30ef\u30a4\u30e4\u30fc', '\u6a5f\u68b0',
  '\u6295\u5165', '\u4f9b\u7d66', '\u30cc\u30fc\u30c9\u30eb', '\u30da\u30ec\u30c3\u30c8',
  '\u68d2\u72b6', '\u624b\u5143', '\u5727'
];

const HIGHLIGHT_REPETITION_TERMS = [
  'repeat', 'repeated', 'cycle', 'continuous', 'continues', 'rhythm', 'loop',
  '\u9023\u7d9a', '\u7e70\u308a\u8fd4', '\u6b21\u3005', '\u30ea\u30ba\u30e0', '\u4f55\u5ea6\u3082'
];

const HIGHLIGHT_CLOSEUP_TERMS = [
  'close-up', 'closeup', 'close up', 'hands', 'worker hand',
  '\u30af\u30ed\u30fc\u30ba\u30a2\u30c3\u30d7', '\u624b\u5143', '\u4f5c\u696d\u54e1\u306e\u624b'
];

const HIGHLIGHT_SUMMARY_TERMS = [
  'final', 'complete', 'completed', 'finish', 'finished', 'result', 'reveal', 'overview',
  'package', 'packaging', 'wrapped', 'box', 'crate', 'stack',
  '\u5b8c\u6210', '\u5305\u88c5', '\u7bb1', '\u7a4d\u307f\u91cd\u306d', '\u6700\u7d42', '\u7d50\u679c', '\u5168\u4f53'
];

function clampScore(value, min = 1, max = 10, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function includesAnyTerm(text, terms = []) {
  const haystack = String(text || '').toLowerCase();
  return terms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function countTermHits(texts = [], terms = []) {
  return texts.filter((text) => includesAnyTerm(text, terms)).length;
}

function scoreSceneForHighlight(scene = {}) {
  const text = getSceneHighlightText(scene);
  const visualHookScore = clampScore(scene.visual_hook_score, 1, 10, 1);
  const repetitionPotential = clampScore(scene.repetition_potential, 1, 10, 1);
  let score = 1;
  score += visualHookScore * 4;
  score += repetitionPotential * 3;
  if (scene.curiosity_reason) score += 4;
  if (scene.mechanical_rhythm) score += 4;
  if (scene.human_presence === true) score += 1.5;
  if (scene.motion_intensity === 'high') score += 5;
  if (scene.motion_intensity === 'medium') score += 2.5;
  if (scene.change_type === 'action_change') score += 2;
  if (['punch_zoom', 'speed_up', 'slow_zoom_in', 'static'].includes(scene.recommended_camera_move)) score += 1.5;
  if (includesAnyTerm(text, HIGHLIGHT_MECHANICAL_TERMS)) score += 6;
  if (includesAnyTerm(text, HIGHLIGHT_REPETITION_TERMS)) score += 5;
  if (includesAnyTerm(text, HIGHLIGHT_CLOSEUP_TERMS)) score += 2.5;
  if (includesAnyTerm(text, HIGHLIGHT_SUMMARY_TERMS)) score -= 3;
  // Cut-quality signals (see computeCutSelectionTier above for the data basis).
  const cycleTime = Number(scene.cycle_time_sec);
  if (Number.isFinite(cycleTime) && cycleTime > 0 && cycleTime <= 5) score += 10;
  if (scene.appears_sped_up === true) score -= 10;
  if (scene.human_visibility === 'FULL_PERSON') score += 5;
  return score;
}

function getSceneDurationSec(scene = {}) {
  const start = Number(scene.start_sec || 0);
  const end = Number(scene.end_sec || scene.transition_at_sec || start);
  return Math.max(0, end - start);
}

function isLongformHighlightSource(itemConfig = {}) {
  return itemConfig.source_workflow_mode === 'longform_to_shorts'
    || itemConfig.source_type === 'longform'
    || Number(itemConfig.video_metadata?.duration_sec || itemConfig.source_classification?.duration_sec || 0) >= 90;
}

function clampWindowStartSec(startSec, durationSec, sourceDurationSec = 0) {
  const start = Math.max(0, Number(startSec || 0));
  const duration = Math.max(0.8, Number(durationSec || 0.8));
  const sourceDuration = Number(sourceDurationSec || 0);
  if (sourceDuration > 0) {
    return Math.min(start, Math.max(0, sourceDuration - duration));
  }
  return start;
}

function singleProcessSceneIds(scene = {}) {
  return scene?.scene_id ? [scene.scene_id] : [];
}

function scoreNaturalRepetitionWindow(selected = []) {
  if (!selected.length) return 0;
  const actionScenes = selected.filter((scene) => scene.change_type === 'action_change').length;
  const highMotionScenes = selected.filter((scene) => scene.motion_intensity === 'high').length;
  const mediumMotionScenes = selected.filter((scene) => scene.motion_intensity === 'medium').length;
  const durations = selected.map(getSceneDurationSec).filter((value) => value > 0);
  const shortCutCount = durations.filter((value) => value <= 2.8).length;
  const texts = selected.map(getSceneHighlightText);
  const mechanicalHits = countTermHits(texts, HIGHLIGHT_MECHANICAL_TERMS);
  const finalOrPackagingHits = countTermHits(texts, HIGHLIGHT_SUMMARY_TERMS);
  const visualHookSum = selected.reduce((sum, scene) => sum + clampScore(scene.visual_hook_score, 1, 10, 1), 0);
  const repetitionSum = selected.reduce((sum, scene) => sum + clampScore(scene.repetition_potential, 1, 10, 1), 0);
  const curiosityCount = selected.filter((scene) => scene.curiosity_reason).length;
  const focusTokens = selected
    .map((scene) => String(scene.focus_target || scene.visual_summary || '').toLowerCase())
    .join(' ')
    .split(/[\s,./()|\u30fb\u3001\u3002:?-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/scene|worker/.test(token));
  const tokenCounts = new Map();
  focusTokens.forEach((token) => tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1));
  const repeatedTokenCount = [...tokenCounts.values()].filter((count) => count >= 2).length;

  return (visualHookSum * 2.2)
    + (repetitionSum * 1.8)
    + (curiosityCount * 3)
    + (actionScenes * 2.5)
    + (highMotionScenes * 3)
    + (mediumMotionScenes * 1.2)
    + (shortCutCount * 1.8)
    + (mechanicalHits * 3.5)
    + (repeatedTokenCount * 2)
    - (finalOrPackagingHits * 3);
}

function pickHighlightWindow(itemConfig = {}, maxDurationSec = 10) {
  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const isLongformSource = isLongformHighlightSource(itemConfig);
  const safeMax = Math.max(1, Math.min(
    isLongformSource ? LONGFORM_HIGHLIGHT_MAX_DURATION_SEC : SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC,
    Number(maxDurationSec) || (isLongformSource ? LONGFORM_HIGHLIGHT_DEFAULT_DURATION_SEC : SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC)
  ));
  const duration = sourceDuration > 0 ? Math.min(safeMax, sourceDuration) : safeMax;
  const guide = itemConfig.ottogi_guide_output || {};
  const guideWindow = isLongformSource
    ? normalizeGuideWindow(guide.recommended_highlight_window, sourceDuration || itemConfig.target_duration_sec || 0)
    : null;
  if (guideWindow) {
    const start = Math.max(0, Number(guideWindow.start_sec || 0));
    const clippedDuration = Math.min(duration, Math.max(1, Number(guideWindow.duration_sec || guideWindow.end_sec - start || duration)));
    const safeStart = sourceDuration > 0 ? Math.min(start, Math.max(0, sourceDuration - clippedDuration)) : start;
    const selectedSceneIds = Array.isArray(guideWindow.selected_scene_ids)
      ? guideWindow.selected_scene_ids.filter(Boolean).slice(0, 1)
      : [];
    return {
      start_sec: Number(safeStart.toFixed(3)),
      duration_sec: Number(clippedDuration.toFixed(3)),
      end_sec: Number((safeStart + clippedDuration).toFixed(3)),
      score: Number(guideWindow.score || 0),
      reason: guideWindow.reason || 'gemini_recommended_longform_highlight_window',
      selection_strategy: 'gemini_single_process_visual_hook_window',
      selected_scene_ids: selectedSceneIds,
      single_process_only: true,
      longform_highlight_rule: 'one_continuous_core_process_natural_end'
    };
  }
  // Highlight drafts should feel like a complete short hook, not a tiny teaser.
  // Pick the strongest window at the requested duration instead of letting
  // density scoring collapse the result down to a 3 second segment.
  const candidateDurations = [Number(duration.toFixed(3))];
  const transitions = normalizeSceneTransitions(getItemSceneTransitions(itemConfig), sourceDuration || itemConfig.target_duration_sec || 0);
  if (!transitions.length) {
    return {
      start_sec: 0,
      duration_sec: duration,
      end_sec: duration,
      reason: isLongformSource ? 'no_scene_transitions_fallback_first_single_process_window' : 'no_scene_transitions_fallback_first_10s',
      selection_strategy: isLongformSource ? 'single_process_longform_no_scene_fallback' : 'natural_source_repetition_no_artificial_loop',
      selected_scene_ids: [],
      single_process_only: isLongformSource,
      longform_highlight_rule: isLongformSource ? 'one_continuous_core_process_natural_end' : undefined
    };
  }

  if (isLongformSource) {
    const bestScene = [...transitions].sort((a, b) => (
      scoreSceneForHighlight(b) - scoreSceneForHighlight(a)
      || Number(a.start_sec || 0) - Number(b.start_sec || 0)
    ))[0];
    const sceneStart = Number(bestScene.start_sec || 0);
    const sceneEnd = Number(bestScene.end_sec || bestScene.transition_at_sec || sceneStart + duration);
    const boundedSceneEnd = Math.max(sceneStart + 0.8, sceneEnd);
    const peak = Number(bestScene.transition_at_sec || 0) > sceneStart && Number(bestScene.transition_at_sec || 0) < boundedSceneEnd
      ? Number(bestScene.transition_at_sec)
      : (sceneStart + boundedSceneEnd) / 2;
    const start = clampWindowStartSec(peak - duration * 0.45, duration, sourceDuration);
    return {
      start_sec: Number(start.toFixed(3)),
      duration_sec: Number(duration.toFixed(3)),
      end_sec: Number((start + duration).toFixed(3)),
      score: Number(scoreSceneForHighlight(bestScene).toFixed(3)),
      reason: 'single_core_process_visual_hook_window',
      selection_strategy: 'single_process_longform_core_hook',
      selected_scene_ids: singleProcessSceneIds(bestScene),
      single_process_only: true,
      longform_highlight_rule: 'one_continuous_core_process_natural_end'
    };
  }

  const candidates = transitions.flatMap((scene, index) => {
    const sceneStart = Number(scene.start_sec || 0);
    const sceneEnd = Number(scene.end_sec || scene.transition_at_sec || sceneStart + duration);
    const center = Math.max(sceneStart, Math.min(sceneEnd, (sceneStart + sceneEnd) / 2));
    return candidateDurations.flatMap((candidateDuration) => {
      const starts = [
        sceneStart,
        Math.max(0, center - candidateDuration / 2),
        Math.max(0, sceneEnd - candidateDuration),
        Math.max(0, sceneStart - 0.25)
      ];
      return starts.map((rawStart) => {
        let start = Math.max(0, rawStart);
        if (sourceDuration > 0) start = Math.min(start, Math.max(0, sourceDuration - candidateDuration));
        const end = start + candidateDuration;
        const selected = transitions.filter((item) => {
          const itemStart = Number(item.start_sec || 0);
          const itemEnd = Number(item.end_sec || item.transition_at_sec || itemStart);
          return itemEnd > start && itemStart < end;
        });
        const rawScore = selected.reduce((sum, item) => sum + scoreSceneForHighlight(item), 0)
          + scoreSceneForHighlight(scene)
          + scoreNaturalRepetitionWindow(selected)
          + (index === 0 ? 0.5 : 0);
        const overPackedPenalty = Math.max(0, selected.length - 4) * 32;
        const durationPenalty = Math.max(0, candidateDuration - 5) * 4;
        const densityBonus = (rawScore / Math.max(1, candidateDuration)) * 4;
        const focusedWindowBonus = selected.length >= 2 && selected.length <= 4 ? 18 : 0;
        const score = rawScore + densityBonus + focusedWindowBonus - overPackedPenalty - durationPenalty;
        return { start_sec: start, end_sec: end, duration_sec: candidateDuration, score, selected };
      });
    });
  });

  candidates.sort((a, b) => b.score - a.score || a.start_sec - b.start_sec);
  const best = candidates[0];
  // Best tier among the scenes inside the picked window -- recorded on the
  // window (and thus in the batch report / job payload) so published results
  // can later be checked against the tier the cut actually carried.
  const bestSceneTierRank = best.selected.length
    ? Math.min(...best.selected.map((scene) => cutSelectionTierRank(scene)))
    : 2;
  return {
    start_sec: Number(best.start_sec.toFixed(3)),
    duration_sec: Number(best.duration_sec.toFixed(3)),
    end_sec: Number(best.end_sec.toFixed(3)),
    score: Number(best.score.toFixed(3)),
    reason: 'natural_repetitive_mechanical_hook_window',
    selection_strategy: 'natural_source_repetition_no_artificial_loop',
    selected_scene_ids: best.selected.map((scene) => scene.scene_id).filter(Boolean),
    cut_selection_tier: ['T1', 'T2', 'T3'][bestSceneTierRank]
  };
}

function windowsOverlapSeconds(a = {}, b = {}) {
  const aStart = Number(a.start_sec || 0);
  const aEnd = Number(a.end_sec || (aStart + Number(a.duration_sec || 0)));
  const bStart = Number(b.start_sec || 0);
  const bEnd = Number(b.end_sec || (bStart + Number(b.duration_sec || 0)));
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function normalizeHighlightCandidateWindow(raw, itemConfig = {}, maxDurationSec = 10, reason = 'highlight_candidate_window') {
  if (!raw || typeof raw !== 'object') return null;
  // A window with no positional data at all is not a window. Without this
  // check, an absent selected_highlight_window (undefined, or {} persisted by
  // the UI) silently normalized into a phantom 0-start window labeled
  // 'user_selected_highlight_window', which then outranked pickHighlightWindow
  // entirely -- every item without a real manual selection was cutting the
  // first 10 seconds instead of the scene-scored strongest moment.
  const hasWindowData = ['start_sec', 'start', 'end_sec', 'end', 'duration_sec', 'duration']
    .some((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== '');
  if (!hasWindowData) return null;
  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const longformSource = isLongformHighlightSource(itemConfig);
  const normalized = normalizeGuideWindow(raw, sourceDuration || itemConfig.target_duration_sec || 0);
  if (!normalized) return null;
  const rawStart = Number(normalized.start_sec || 0);
  const rawEnd = Number(normalized.end_sec || (rawStart + Number(normalized.duration_sec || 0)));
  if (
    sourceDuration > 0 &&
    longformSource &&
    (rawStart >= sourceDuration + 0.25 || rawEnd <= -0.25)
  ) {
    return null;
  }
  const durationCap = longformSource ? LONGFORM_HIGHLIGHT_MAX_DURATION_SEC : SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC;
  const safeMax = Math.max(1, Math.min(durationCap, Number(maxDurationSec) || durationCap));
  const safeMin = Math.min(safeMax, Math.max(1, Math.min(6, sourceDuration || safeMax)));
  const start = Math.max(0, rawStart);
  const rawDuration = Number(normalized.duration_sec || normalized.end_sec - start || safeMax);
  const duration = Math.min(safeMax, Math.max(safeMin, rawDuration));
  const rawCenter = start + Math.max(0.1, rawDuration) / 2;
  const expandedStart = rawDuration < duration ? rawCenter - duration / 2 : start;
  const safeStart = sourceDuration > 0 ? clampWindowStartSec(expandedStart, duration, sourceDuration) : Math.max(0, expandedStart);
  return {
    ...normalized,
    start_sec: Number(safeStart.toFixed(3)),
    duration_sec: Number(duration.toFixed(3)),
    end_sec: Number((safeStart + duration).toFixed(3)),
    reason: normalized.reason || reason,
    selection_strategy: normalized.selection_strategy || reason,
    selected_scene_ids: Array.isArray(normalized.selected_scene_ids) ? normalized.selected_scene_ids.filter(Boolean).slice(0, 1) : [],
    single_process_only: true,
    longform_highlight_rule: longformSource ? 'one_continuous_core_process_natural_end' : undefined
  };
}

function collectHighlightCandidateWindows(itemConfig = {}, maxDurationSec = 10) {
  const guide = itemConfig.ottogi_guide_output || {};
  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const windows = [];
  const pushWindow = (raw, reason) => {
    const window = normalizeHighlightCandidateWindow(raw, itemConfig, maxDurationSec, reason);
    if (window) windows.push(window);
  };

  pushWindow(guide.recommended_highlight_window, 'gemini_recommended_highlight_window');
  pushWindow(guide.hook_clip_10s, 'gemini_hook_clip_10s');

  const candidates = [
    ...(Array.isArray(guide.shortform_candidate_windows) ? guide.shortform_candidate_windows : []),
    ...(Array.isArray(guide.hook_candidates) ? guide.hook_candidates : []),
    ...(Array.isArray(guide.highlight_candidates) ? guide.highlight_candidates : [])
  ];
  candidates
    .map((candidate, index) => ({ candidate, index, tierRank: cutSelectionTierRank(candidate) }))
    .sort((a, b) => {
      const scoreA = Number(a.candidate.hook_score || a.candidate.visual_hook_score || a.candidate.score || 0);
      const scoreB = Number(b.candidate.hook_score || b.candidate.visual_hook_score || b.candidate.score || 0);
      // Tier before score (see computeCutSelectionTier): a T1 window with a
      // modest hook_score beats a flashy T3 one. Ordering only -- every
      // hook-like candidate is still pushed, whatever its tier.
      return a.tierRank - b.tierRank || scoreB - scoreA || a.index - b.index;
    })
    .forEach(({ candidate }, index) => {
      const purpose = String(candidate.purpose || candidate.process_coverage || candidate.visual_hook || '').toLowerCase();
      const isHookLike = !purpose || /hook|visual|repeat|rhythm|press|cut|pour|flow|transform|impact|핵심|반복|압착|절단|흐름|変化|反復|切断|押|注/.test(purpose);
      if (isHookLike) {
        pushWindow(
          { ...candidate, cut_selection_tier: computeCutSelectionTier(candidate) },
          `gemini_highlight_candidate_${index + 1}`
        );
      }
    });

  const transitions = normalizeSceneTransitions(getItemSceneTransitions(itemConfig), sourceDuration || itemConfig.target_duration_sec || 0);
  transitions
    .map((scene, index) => ({ scene, index, score: scoreSceneForHighlight(scene), tierRank: cutSelectionTierRank(scene) }))
    .sort((a, b) => a.tierRank - b.tierRank || b.score - a.score || Number(a.scene.start_sec || 0) - Number(b.scene.start_sec || 0))
    .forEach(({ scene, score }) => {
      const sceneStart = Number(scene.start_sec || 0);
      const sceneEnd = Number(scene.end_sec || scene.transition_at_sec || sceneStart + maxDurationSec);
      const safeMax = Math.max(1, Math.min(isLongformHighlightSource(itemConfig) ? LONGFORM_HIGHLIGHT_MAX_DURATION_SEC : SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC, Number(maxDurationSec) || maxDurationSec || 10));
      const safeMin = Math.min(safeMax, Math.max(1, Math.min(6, sourceDuration || safeMax)));
      const duration = Math.min(Math.max(safeMin, Math.min(safeMax, sceneEnd - sceneStart || safeMax)), safeMax);
      const peak = Number(scene.transition_at_sec || 0) > sceneStart && Number(scene.transition_at_sec || 0) < sceneEnd
        ? Number(scene.transition_at_sec)
        : (sceneStart + sceneEnd) / 2;
      const start = clampWindowStartSec(peak - duration * 0.45, duration, sourceDuration);
      windows.push({
        start_sec: Number(start.toFixed(3)),
        duration_sec: Number(duration.toFixed(3)),
        end_sec: Number((start + duration).toFixed(3)),
        score: Number(score.toFixed(3)),
        reason: 'scene_ranked_highlight_candidate',
        selection_strategy: 'scene_ranked_highlight_candidate',
        selected_scene_ids: singleProcessSceneIds(scene),
        single_process_only: true,
        cut_selection_tier: computeCutSelectionTier(scene),
        cycle_time_sec: Number.isFinite(Number(scene.cycle_time_sec)) ? Number(scene.cycle_time_sec) : undefined,
        appears_sped_up: typeof scene.appears_sped_up === 'boolean' ? scene.appears_sped_up : undefined,
        human_visibility: scene.human_visibility || undefined,
        longform_highlight_rule: isLongformHighlightSource(itemConfig) ? 'one_continuous_core_process_natural_end' : undefined
      });
    });

  return windows;
}

function pickHighlightWindows(itemConfig = {}, maxDurationSec = 10, count = 1) {
  const requestedCount = Math.min(5, Math.max(1, Math.round(Number(count) || 1)));
  const primary = pickHighlightWindow(itemConfig, maxDurationSec);
  const candidates = [primary, ...collectHighlightCandidateWindows(itemConfig, maxDurationSec)];
  const picked = [];
  const seenKeys = new Set();
  const minGapSec = Math.max(4, Number(maxDurationSec || 10) * 0.8);

  for (const candidate of candidates) {
    const start = Number(candidate.start_sec || 0);
    const end = Number(candidate.end_sec || (start + Number(candidate.duration_sec || 0)));
    const key = `${start.toFixed(1)}-${end.toFixed(1)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const tooClose = picked.some((window) => {
      const overlap = windowsOverlapSeconds(window, candidate);
      const gap = Math.max(0, Math.max(Number(window.start_sec || 0), start) - Math.min(Number(window.end_sec || 0), end));
      return overlap > 0.25 || gap < minGapSec;
    });
    if (tooClose) continue;
    picked.push({
      ...candidate,
      highlight_index: picked.length + 1,
      highlight_total: requestedCount
    });
    if (picked.length >= requestedCount) break;
  }

  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const safeMax = Math.max(1, Math.min(isLongformHighlightSource(itemConfig) ? LONGFORM_HIGHLIGHT_MAX_DURATION_SEC : SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC, Number(maxDurationSec) || maxDurationSec || 10));
  const safeMin = Math.min(safeMax, Math.max(1, Math.min(6, sourceDuration || safeMax)));
  const duration = Math.min(Math.max(safeMin, safeMax), sourceDuration || safeMax);
  let cursor = 0;
  while (picked.length < requestedCount && sourceDuration > duration) {
    const start = clampWindowStartSec(cursor, duration, sourceDuration);
    const candidate = {
      start_sec: Number(start.toFixed(3)),
      duration_sec: Number(duration.toFixed(3)),
      end_sec: Number((start + duration).toFixed(3)),
      score: 0,
      reason: 'fallback_evenly_spaced_highlight_window',
      selection_strategy: 'fallback_evenly_spaced_highlight_window',
      selected_scene_ids: [],
      single_process_only: isLongformHighlightSource(itemConfig),
      longform_highlight_rule: isLongformHighlightSource(itemConfig) ? 'one_continuous_core_process_natural_end' : undefined,
      highlight_index: picked.length + 1,
      highlight_total: requestedCount
    };
    const tooClose = picked.some((window) => windowsOverlapSeconds(window, candidate) > 0.25);
    if (!tooClose) picked.push(candidate);
    cursor += duration + minGapSec;
    if (cursor >= sourceDuration) cursor = Math.max(0, sourceDuration - duration - (requestedCount - picked.length) * (duration + minGapSec));
    if (cursor < 0 || picked.length >= requestedCount || seenKeys.size > requestedCount + 30) break;
    seenKeys.add(`fallback-${cursor.toFixed(1)}`);
  }

  return picked.length ? picked : [primary];
}

function getDefaultLongformHighlightWindows(itemConfig = {}, maxDurationSec = 10, limit = MAX_LONGFORM_HIGHLIGHT_CANDIDATES) {
  const maxItems = Math.max(1, Math.min(MAX_LONGFORM_HIGHLIGHT_CANDIDATES, Math.round(Number(limit) || MAX_LONGFORM_HIGHLIGHT_CANDIDATES)));
  const picked = [];
  const seenKeys = new Set();

  for (const candidate of collectHighlightCandidateWindows(itemConfig, maxDurationSec)) {
    if (!candidate) continue;
    const start = Number(candidate.start_sec || 0);
    const end = Number(candidate.end_sec || (start + Number(candidate.duration_sec || 0)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const key = `${start.toFixed(1)}-${end.toFixed(1)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    picked.push({
      ...candidate,
      highlight_index: picked.length + 1,
      highlight_total: 0
    });
    if (picked.length >= maxItems) break;
  }

  return picked.map((candidate) => ({
    ...candidate,
    highlight_total: picked.length
  }));
}

function scoreHighlightWindow(window = {}) {
  return Number(
    window.hook_score
      || window.visual_hook_score
      || window.score
      || window.tension_score
      || window.transformation_score
      || 0
  );
}

function selectBestHighlightWindow(windows = [], itemConfig = {}, maxDurationSec = 10) {
  const normalized = (Array.isArray(windows) ? windows : [])
    .map((window) => normalizeHighlightCandidateWindow(window, itemConfig, maxDurationSec, 'selected_longform_highlight_window'))
    .filter(Boolean);
  const candidates = normalized.length
    ? normalized
    : getDefaultLongformHighlightWindows(itemConfig, maxDurationSec, MAX_LONGFORM_HIGHLIGHT_CANDIDATES);
  const picked = [...candidates].sort((a, b) => scoreHighlightWindow(b) - scoreHighlightWindow(a) || Number(a.start_sec || 0) - Number(b.start_sec || 0))[0];
  return picked || pickHighlightWindow(itemConfig, maxDurationSec);
}

function getLongformFullCandidateWindows(itemConfig = {}, targetDurationSec = 60, maxSegmentSec = 10) {
  if (!isLongformHighlightSource(itemConfig)) return [];
  const sourceDuration = getSourceDurationSec(itemConfig);
  const baseWindows = getDefaultLongformHighlightWindows(itemConfig, maxSegmentSec, MAX_LONGFORM_HIGHLIGHT_CANDIDATES);
  const highlightWindow = selectBestHighlightWindow(baseWindows, itemConfig, maxSegmentSec);
  const normalized = baseWindows
    .map((window) => normalizeHighlightCandidateWindow(window, itemConfig, maxSegmentSec, 'longform_full_from_highlight_candidate'))
    .filter(Boolean)
    .filter((window) => {
      if (!highlightWindow || baseWindows.length <= 1) return true;
      return windowsOverlapSeconds(window, highlightWindow) <= 0.25;
    })
    .sort((a, b) => Number(a.start_sec || 0) - Number(b.start_sec || 0));
  const picked = [];
  let total = 0;
  for (const window of normalized) {
    const duration = Math.min(maxSegmentSec, Math.max(1, Number(window.duration_sec || 0)));
    if (total + duration > targetDurationSec + 0.25) break;
    picked.push({
      ...window,
      duration_sec: Number(duration.toFixed(3)),
      end_sec: Number((Number(window.start_sec || 0) + duration).toFixed(3)),
      selection_strategy: window.selection_strategy || 'longform_full_from_highlight_candidates'
    });
    total += duration;
  }
  if (!picked.length && sourceDuration > 0) {
    const best = selectBestHighlightWindow([], itemConfig, maxSegmentSec);
    const expanded = expandQueueWindowAround(best, Math.min(targetDurationSec, sourceDuration), sourceDuration);
    return [expanded];
  }
  return picked;
}

function mapWindowScenesToConcatenatedTimeline(itemConfig = {}, windows = []) {
  const shifted = [];
  let offset = 0;
  windows.forEach((window, windowIndex) => {
    const scenes = shiftHighlightSceneTransitions(itemConfig, window);
    const duration = Number(window.duration_sec || Math.max(0, Number(window.end_sec || 0) - Number(window.start_sec || 0)));
    if (scenes.length) {
      scenes.forEach((scene, sceneIndex) => {
        shifted.push({
          ...scene,
          scene_id: scene.scene_id || `longform_full_h${String(windowIndex + 1).padStart(2, '0')}_${String(sceneIndex + 1).padStart(2, '0')}`,
          source_window_index: windowIndex + 1,
          source_window: window,
          start_sec: Number((offset + Number(scene.start_sec || 0)).toFixed(3)),
          end_sec: Number((offset + Math.min(duration, Number(scene.end_sec || duration))).toFixed(3)),
          transition_at_sec: Number((offset + Math.min(duration, Number(scene.transition_at_sec || scene.end_sec || duration))).toFixed(3))
        });
      });
    } else {
      shifted.push({
        scene_id: `longform_full_h${String(windowIndex + 1).padStart(2, '0')}`,
        source_window_index: windowIndex + 1,
        source_window: window,
        start_sec: Number(offset.toFixed(3)),
        end_sec: Number((offset + duration).toFixed(3)),
        transition_at_sec: Number((offset + duration).toFixed(3)),
        visual_summary: String(window.reason || window.selection_strategy || 'highlight candidate segment'),
        caption_text: String(window.reason || ''),
        confidence: 'medium'
      });
    }
    offset += duration;
  });
  return shifted.filter((scene) => Number(scene.end_sec || 0) > Number(scene.start_sec || 0));
}

function runFfmpegConcatWindows({ sourcePath, targetPath, windows = [] }) {
  return new Promise(async (resolve, reject) => {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const workDir = path.join(path.dirname(targetPath), `concat_${Date.now()}`);
      fs.mkdirSync(workDir, { recursive: true });
      const segmentPaths = [];
      for (const [index, window] of windows.entries()) {
        const segmentPath = path.join(workDir, `segment_${String(index + 1).padStart(2, '0')}.mp4`);
        await runFfmpegTrim({
          sourcePath,
          targetPath: segmentPath,
          startSec: window.start_sec,
          durationSec: window.duration_sec
        });
        if (hasUsableVideoStream(segmentPath)) segmentPaths.push(segmentPath);
      }
      if (!segmentPaths.length) {
        throw new Error('no usable longform full candidate segments were created');
      }
      const listPath = path.join(workDir, 'concat_list.txt');
      const listText = segmentPaths
        .map((segmentPath) => `file '${segmentPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n');
      fs.writeFileSync(listPath, `${listText}\n`, 'utf8');
      execFile(resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' }), [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        targetPath
      ], {
        cwd: PROJECT_ROOT,
        env: getToolEnv(),
        maxBuffer: 20 * 1024 * 1024,
        timeout: 5 * 60 * 1000
      }, (error, stdout, stderr) => {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch (_cleanupError) {
          // Best-effort cleanup only.
        }
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    } catch (error) {
      reject(error);
    }
  });
}

function buildFullPrerollHookBlock(itemConfig = {}, queueConfig = {}, language = 'ja') {
  const hookConfig = normalizeFullPrerollHookConfig(
    queueConfig.full_preroll_hook,
    defaultQueueConfig().full_preroll_hook
  );
  if (!hookConfig.enabled) return null;

  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 1) return null;
  const isLongformSource = itemConfig.source_workflow_mode === 'longform_to_shorts'
    || itemConfig.source_type === 'longform';
  const hookZoomScale = isLongformSource
    ? Math.max(2.08, Number(hookConfig.zoom_scale || 0))
    : Math.min(1.50, Number(hookConfig.zoom_scale || 1.50));
  const requestedDuration = Math.min(
    hookConfig.duration_sec,
    hookConfig.max_source_duration_sec,
    Math.max(0.8, sourceDuration)
  );
  const window = pickHighlightWindow(itemConfig, requestedDuration);
  const durationSec = Math.min(
    requestedDuration,
    Number(window.duration_sec || requestedDuration),
    Math.max(0.8, sourceDuration)
  );
  const startSec = Math.max(0, Math.min(Number(window.start_sec || 0), Math.max(0, sourceDuration - durationSec)));
  const endSec = Math.min(sourceDuration, startSec + durationSec);
  const rawText = language === 'ko'
    ? hookConfig.caption_ko
    : hookConfig.caption_ja;
  const text = language === 'ko'
    ? clampCaptionLine(rawText, FULL_CAPTION_SAFE_MAX_CHARS.ko)
    : compactJapaneseCaptionForScreen(rawText, FULL_CAPTION_SAFE_MAX_CHARS.ja);

  return {
    block_id: language === 'ko' ? 'ko_full_preroll_hook' : 'full_preroll_hook',
    scene_id: language === 'ko' ? 'ko_full_preroll_hook' : 'full_preroll_hook',
    parent_scene_id: language === 'ko' ? 'ko_full_preroll_hook' : 'full_preroll_hook',
    source_scene_index: -1,
    caption_part_index: 0,
    caption_parts_count: 1,
    caption_unit_mode: language === 'ko' ? 'korean_preroll_hook' : 'japanese_preroll_hook',
    text,
    full_scene_caption_text: text,
    start_sec: 0,
    end_sec: Number(Math.max(0.8, endSec - startSec).toFixed(3)),
    style_role: 'main_explainer',
    style_profile: 'full_cut_caption',
    anchor_zone: 'lower_third',
    animation: 'pop_in',
    is_preroll_hook: true,
    output_language: language,
    language,
    source_start_sec: Number(startSec.toFixed(3)),
    source_end_sec: Number(endSec.toFixed(3)),
    source_window: {
      ...window,
      start_sec: Number(startSec.toFixed(3)),
      end_sec: Number(endSec.toFixed(3)),
      duration_sec: Number(Math.max(0.8, endSec - startSec).toFixed(3))
    },
    video_transform_override: {
      scale: hookZoomScale,
      zoom_scale: hookZoomScale,
      pan_x: hookConfig.pan_x,
      pan_y: hookConfig.pan_y,
      rotation: hookConfig.rotation,
      speed: hookConfig.speed,
      mirror: hookConfig.mirror,
      label: isLongformSource
        ? 'full_longform_preroll_core_crop_zoom'
        : 'full_preroll_hook_template_safe_zoom'
    }
  };
}

function comparableFullCaptionText(text = '') {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\s"'“”‘’.,!?！？。、，・:：;；\-—–~〜…]+/gu, '')
    .trim()
    .toLowerCase();
}

function isFullDraftHookCaption(text = '', language = 'ja') {
  const key = comparableFullCaptionText(text);
  if (!key) return false;
  if (language === 'ko') {
    return key.includes('이게뭔지아세요') || key.includes('뭔지아세요') || key.includes('무슨공정인지아세요');
  }
  return (key.includes('これ') || key.includes('何'))
    && (key.includes('何') || key.includes('なん'))
    && (key.includes('だろう') || key.includes('思います') || key.includes('わかります') || key.includes('分かります'));
}

function applyFullPrerollHookToBlocks(blocks = [], itemConfig = {}, queueConfig = {}, language = 'ja') {
  const hookBlock = buildFullPrerollHookBlock(itemConfig, queueConfig, language);
  const normalizedBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!hookBlock) {
    return {
      blocks: normalizedBlocks,
      hookDurationSec: 0,
      hookBlock: null
    };
  }

  const hookDurationSec = Number(hookBlock.end_sec || 0);
  const firstText = String(normalizedBlocks[0]?.text || normalizedBlocks[0]?.full_scene_caption_text || '').trim();
  const hookTextKey = comparableFullCaptionText(hookBlock.text);
  const firstTextKey = comparableFullCaptionText(firstText);
  const firstBlockIsSameHook = hookTextKey && firstTextKey && firstTextKey === hookTextKey;
  const firstBlockIsEquivalentHook = firstText
    && isFullDraftHookCaption(firstText, language)
    && isFullDraftHookCaption(hookBlock.text, language);
  const shouldConsumeFirstHookBlock = normalizedBlocks.length > 0 && (firstBlockIsSameHook || firstBlockIsEquivalentHook);
  if (shouldConsumeFirstHookBlock && firstText) {
    hookBlock.text = firstText;
    hookBlock.full_scene_caption_text = firstText;
    hookBlock.consumed_existing_script_hook = true;
  }
  const contentBlocks = shouldConsumeFirstHookBlock
    ? normalizedBlocks.slice(1)
    : normalizedBlocks;

  const firstContentStartSec = contentBlocks.length
    ? Math.max(0, Number(contentBlocks[0]?.start_sec || 0))
    : 0;
  const shiftedBlocks = contentBlocks.map((block) => ({
    ...block,
    start_sec: Number((Math.max(0, Number(block.start_sec || 0) - firstContentStartSec) + hookDurationSec).toFixed(3)),
    end_sec: Number((Math.max(0, Number(block.end_sec || 0) - firstContentStartSec) + hookDurationSec).toFixed(3))
  }));
  return {
    blocks: [hookBlock, ...shiftedBlocks],
    hookDurationSec,
    hookBlock
  };
}

function shiftHighlightSceneTransitions(itemConfig = {}, window = {}) {
  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const transitions = normalizeSceneTransitions(getItemSceneTransitions(itemConfig), sourceDuration || itemConfig.target_duration_sec || 0);
  const start = Number(window.start_sec || 0);
  const end = Number(window.end_sec || start + Number(window.duration_sec || 10));
  const selectedIds = new Set(Array.isArray(window.selected_scene_ids) ? window.selected_scene_ids.filter(Boolean) : []);
  let scenes = transitions.filter((scene) => Number(scene.end_sec || scene.transition_at_sec || 0) > start && Number(scene.start_sec || 0) < end);
  if (window.single_process_only) {
    const selectedScenes = selectedIds.size
      ? transitions.filter((scene) => selectedIds.has(scene.scene_id))
      : [];
    scenes = (selectedScenes.length ? selectedScenes : scenes)
      .sort((a, b) => scoreSceneForHighlight(b) - scoreSceneForHighlight(a))
      .slice(0, 1);
  }
  return scenes
    .map((scene, index) => ({
      ...scene,
      scene_id: scene.scene_id || `highlight_scene_${String(index + 1).padStart(3, '0')}`,
      start_sec: Number(Math.max(0, Number(scene.start_sec || 0) - start).toFixed(3)),
      end_sec: Number(Math.max(0.2, Math.min(Number(window.duration_sec || 10), Number(scene.end_sec || scene.transition_at_sec || 0) - start)).toFixed(3)),
      transition_at_sec: Number(Math.max(0.2, Math.min(Number(window.duration_sec || 10), Number(scene.transition_at_sec || scene.end_sec || 0) - start)).toFixed(3))
    }))
    .filter((scene) => scene.transition_at_sec > 0 && scene.start_sec < Number(window.duration_sec || 10));
}

function normalizeGuideWindow(window = {}, sourceDuration = 0, fallbackDuration = 30) {
  const start = Math.max(0, Number(window.start_sec || window.start || 0));
  const rawEnd = Number(window.end_sec || window.end || 0);
  const rawDuration = Number(window.duration_sec || window.duration || 0);
  const maxSource = Number(sourceDuration || 0);
  const fallback = Math.max(1, Number(fallbackDuration || 30));
  const endFromDuration = start + (rawDuration > 0 ? rawDuration : fallback);
  const end = rawEnd > start ? rawEnd : endFromDuration;
  const boundedEnd = maxSource > 0 ? Math.min(maxSource, end) : end;
  const duration = Math.max(0.8, boundedEnd - start);
  return {
    ...window,
    start_sec: Number(start.toFixed(3)),
    end_sec: Number((start + duration).toFixed(3)),
    duration_sec: Number(duration.toFixed(3))
  };
}

function expandQueueWindowAround(window = {}, targetDurationSec = 60, sourceDuration = 0) {
  const normalized = normalizeGuideWindow(window, sourceDuration, targetDurationSec);
  const target = Math.max(0.8, Number(targetDurationSec || 60));
  const currentDuration = Number(normalized.duration_sec || 0);
  const maxSource = Number(sourceDuration || 0);
  if (currentDuration >= target || (maxSource > 0 && maxSource <= currentDuration)) {
    return normalized;
  }
  if (maxSource > 0 && maxSource <= target) {
    return {
      ...normalized,
      start_sec: 0,
      end_sec: Number(maxSource.toFixed(3)),
      duration_sec: Number(maxSource.toFixed(3)),
      expanded_to_target_duration: true
    };
  }
  const center = (Number(normalized.start_sec || 0) + Number(normalized.end_sec || 0)) / 2;
  let start = center - (target / 2);
  let end = center + (target / 2);
  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (maxSource > 0 && end > maxSource) {
    start = Math.max(0, start - (end - maxSource));
    end = maxSource;
  }
  return {
    ...normalized,
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(end.toFixed(3)),
    duration_sec: Number(Math.max(0.8, end - start).toFixed(3)),
    expanded_to_target_duration: true,
    requested_target_duration_sec: target
  };
}

function pickFullDraftWindow(itemConfig = {}) {
  const sourceDuration = getSourceDurationSec(itemConfig);
  const guide = itemConfig.ottogi_guide_output || {};
  const explicit = guide.recommended_full_window && typeof guide.recommended_full_window === 'object'
    ? guide.recommended_full_window
    : null;
  const candidates = Array.isArray(guide.shortform_candidate_windows)
    ? guide.shortform_candidate_windows
    : [];
  const processCandidate = candidates
    .filter((candidate) => {
      const purpose = String(candidate.purpose || '').toLowerCase();
      return purpose.includes('full') || purpose.includes('process') || purpose.includes('summary');
    })
    .sort((a, b) => Number(b.process_coverage === 'high') - Number(a.process_coverage === 'high') || Number(b.hook_score || 0) - Number(a.hook_score || 0))[0];
  const selected = explicit || processCandidate;
  if (!selected) return null;
  const fallbackDuration = sourceDuration > 65 ? 60 : Math.min(60, Math.max(10, Number(itemConfig.target_duration_sec || 30)));
  const normalizedBase = normalizeGuideWindow(selected, sourceDuration, fallbackDuration);
  const normalized = sourceDuration >= 65 && normalizedBase.duration_sec < 55
    ? expandQueueWindowAround(normalizedBase, 60, sourceDuration)
    : normalizedBase;
  if (normalized.duration_sec <= 0 || (sourceDuration > 0 && normalized.start_sec >= sourceDuration)) return null;
  return {
    ...normalized,
    selection_strategy: explicit ? 'gemini_recommended_full_window' : 'gemini_candidate_full_window'
  };
}

function pickMidformDraftWindow(itemConfig = {}) {
  const sourceDuration = getSourceDurationSec(itemConfig);
  if (sourceDuration > 0 && sourceDuration < MIDFORM_DRAFT_MIN_RESULT_SEC) return null;
  const guide = itemConfig.ottogi_guide_output || {};
  const explicit = guide.recommended_midform_window && typeof guide.recommended_midform_window === 'object'
    ? guide.recommended_midform_window
    : (guide.midform_clip_120s && typeof guide.midform_clip_120s === 'object' ? guide.midform_clip_120s : null);
  const candidates = Array.isArray(guide.shortform_candidate_windows)
    ? guide.shortform_candidate_windows
    : [];
  const midformCandidate = candidates
    .filter((candidate) => {
      const purpose = String(candidate.purpose || candidate.process_coverage || '').toLowerCase();
      return purpose.includes('midform') || purpose.includes('120') || purpose.includes('overall') || purpose.includes('complete');
    })
    .sort((a, b) => Number(b.duration_sec || 0) - Number(a.duration_sec || 0))[0];
  const selected = explicit || midformCandidate;
  if (!selected) return null;
  const normalized = normalizeGuideWindow(selected, sourceDuration, 120);
  if (normalized.duration_sec < MIDFORM_DRAFT_MIN_RESULT_SEC || (sourceDuration > 0 && normalized.start_sec >= sourceDuration)) return null;
  return {
    ...normalized,
    selection_strategy: explicit ? 'gemini_recommended_midform_window' : 'gemini_candidate_midform_window'
  };
}

async function prepareLongformFullDraftItemConfig({ itemId, itemConfig, sourceVideoPath }) {
  const item = normalizeItemConfig(itemConfig, itemId);
  if (item.source_workflow_mode !== 'longform_to_shorts' && item.source_type !== 'longform') {
    return {
      itemConfig: item,
      sourceWindow: null,
      warnings: []
    };
  }
  const candidateWindows = getLongformFullCandidateWindows(item, 60, highlightMaxDurationForItem(item, item.highlight_duration_sec));
  if (candidateWindows.length) {
    const itemDir = getItemDir(itemId);
    const fullSourcePath = path.join(itemDir, 'full_source_highlight_candidates.mp4');
    await runFfmpegConcatWindows({
      sourcePath: sourceVideoPath,
      targetPath: fullSourcePath,
      windows: candidateWindows
    });
    const metadata = getVideoMetadata(fullSourcePath);
    const shiftedScenes = mapWindowScenesToConcatenatedTimeline(item, candidateWindows);
    const sourcePreprocess = {
      ...(item.source_preprocess || {}),
      scene_tail_trim_sec: Number(item.source_preprocess?.scene_tail_trim_sec ?? 1),
      scene_detection: {
        ...(item.source_preprocess?.scene_detection || {}),
        enabled: true,
        gemini_scene_transitions: shiftedScenes.length ? shiftedScenes : item.gemini_scene_transitions
      }
    };
    return {
      itemConfig: normalizeItemConfig({
        ...item,
        source_video: fullSourcePath,
        target_duration_sec: Number((metadata.duration_sec || Math.min(60, candidateWindows.reduce((sum, window) => sum + Number(window.duration_sec || 0), 0))).toFixed(3)),
        video_metadata: metadata,
        gemini_scene_transitions: shiftedScenes.length ? shiftedScenes : item.gemini_scene_transitions,
        source_preprocess: sourcePreprocess,
        source_window_full: {
          mode: 'longform_full_from_highlight_candidates',
          duration_sec: Number((metadata.duration_sec || 0).toFixed(3)),
          windows: candidateWindows
        },
        source_window_strategy: 'longform_full_from_highlight_candidates'
      }, itemId),
      sourceWindow: {
        mode: 'longform_full_from_highlight_candidates',
        duration_sec: Number((metadata.duration_sec || 0).toFixed(3)),
        windows: candidateWindows
      },
      warnings: [`longform full draft uses ${candidateWindows.length} highlight candidate segment(s), total ${Number((metadata.duration_sec || 0).toFixed(3))}s`]
    };
  }
  const window = pickFullDraftWindow(item);
  if (!window) {
    return {
      itemConfig: item,
      sourceWindow: null,
      warnings: ['longform source detected but Gemini did not provide a usable full draft window; using existing full-draft behavior']
    };
  }
  const itemDir = getItemDir(itemId);
  const fullSourcePath = path.join(itemDir, 'full_source_window.mp4');
  await runFfmpegTrim({
    sourcePath: sourceVideoPath,
    targetPath: fullSourcePath,
    startSec: window.start_sec,
    durationSec: window.duration_sec
  });
  const metadata = getVideoMetadata(fullSourcePath);
  const shiftedScenes = shiftHighlightSceneTransitions(item, window);
  const sourcePreprocess = {
    ...(item.source_preprocess || {}),
    scene_tail_trim_sec: Number(item.source_preprocess?.scene_tail_trim_sec ?? 1),
    scene_detection: {
      ...(item.source_preprocess?.scene_detection || {}),
      enabled: true,
      gemini_scene_transitions: shiftedScenes.length ? shiftedScenes : item.gemini_scene_transitions
    }
  };
  return {
    itemConfig: normalizeItemConfig({
      ...item,
      source_video: fullSourcePath,
      target_duration_sec: Number((metadata.duration_sec || window.duration_sec).toFixed(3)),
      video_metadata: metadata,
      gemini_scene_transitions: shiftedScenes.length ? shiftedScenes : item.gemini_scene_transitions,
      source_preprocess: sourcePreprocess,
      source_window_full: window,
      source_window_strategy: window.selection_strategy
    }, itemId),
    sourceWindow: window,
    warnings: [`longform full draft uses source window ${window.start_sec}s-${window.end_sec}s`]
  };
}

async function prepareLongformMidformDraftItemConfig({ itemId, itemConfig, sourceVideoPath }) {
  const item = normalizeItemConfig(itemConfig, itemId);
  if (item.source_workflow_mode !== 'longform_to_shorts' && item.source_type !== 'longform') {
    return {
      itemConfig: item,
      sourceWindow: null,
      warnings: ['midform skipped: source is not classified as longform']
    };
  }
  const window = pickMidformDraftWindow(item);
  if (!window) {
    return {
      itemConfig: item,
      sourceWindow: null,
      warnings: [`midform skipped: source is under ${MIDFORM_DRAFT_MIN_RESULT_SEC}s or Gemini did not provide a usable midform window`]
    };
  }
  const itemDir = getItemDir(itemId);
  const midformSourcePath = path.join(itemDir, 'midform_source_window.mp4');
  await runFfmpegTrim({
    sourcePath: sourceVideoPath,
    targetPath: midformSourcePath,
    startSec: window.start_sec,
    durationSec: window.duration_sec
  });
  const metadata = getVideoMetadata(midformSourcePath);
  const shiftedScenes = shiftHighlightSceneTransitions(item, window);
  return {
    itemConfig: normalizeItemConfig({
      ...item,
      source_video: midformSourcePath,
      target_duration_sec: Number((metadata.duration_sec || window.duration_sec).toFixed(3)),
      video_metadata: metadata,
      gemini_scene_transitions: shiftedScenes.length ? shiftedScenes : item.gemini_scene_transitions,
      source_window_midform: window,
      source_window_strategy: window.selection_strategy
    }, itemId),
    sourceWindow: window,
    warnings: [`longform midform draft uses source window ${window.start_sec}s-${window.end_sec}s`]
  };
}

function runFfmpegTrim({ sourcePath, targetPath, startSec, durationSec }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    execFile(resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' }), [
      '-y',
      '-ss', String(Math.max(0, startSec)),
      '-t', String(Math.max(0.2, durationSec)),
      '-i', sourcePath,
      '-map', '0:v:0',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      targetPath
    ], {
      cwd: PROJECT_ROOT,
      env: getToolEnv(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function hasUsableVideoStream(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1024) return false;
    const metadata = getVideoMetadata(filePath);
    return Boolean(
      Number(metadata.duration_sec || 0) > 0 &&
      Number(metadata.width || 0) > 0 &&
      Number(metadata.height || 0) > 0
    );
  } catch (_error) {
    return false;
  }
}

function getSourceVideoDurationSec(sourceVideoPath, itemConfig = {}) {
  const metadata = sourceVideoPath && fs.existsSync(sourceVideoPath)
    ? getVideoMetadata(sourceVideoPath)
    : {};
  const duration = Number(metadata.duration_sec || 0);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const itemDuration = Number(itemConfig.video_metadata?.duration_sec || 0);
  if (Number.isFinite(itemDuration) && itemDuration > 0) return itemDuration;
  const classifiedDuration = Number(itemConfig.source_classification?.duration_sec || 0);
  if (Number.isFinite(classifiedDuration) && classifiedDuration > 0) return classifiedDuration;
  return 0;
}

function getDeclaredLongformDurationSec(itemConfig = {}) {
  const candidates = [
    itemConfig.source_classification?.original_duration_sec,
    itemConfig.source_classification?.source_duration_sec,
    itemConfig.source_classification?.duration_sec,
    itemConfig.video_metadata?.original_duration_sec,
    itemConfig.video_metadata?.source_duration_sec,
    itemConfig.video_metadata?.duration_sec
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function detectLongformLocalSourceMismatch(itemConfig = {}, actualSourceDurationSec = 0) {
  const actualDuration = Number(actualSourceDurationSec || 0);
  const declaredDuration = getDeclaredLongformDurationSec(itemConfig);
  const requestedLongform = itemConfig.source_workflow_mode === 'longform_to_shorts'
    || itemConfig.source_type === 'longform'
    || declaredDuration >= 90;
  if (!requestedLongform || !Number.isFinite(actualDuration) || actualDuration <= 0 || declaredDuration < 90) {
    return null;
  }
  if (actualDuration >= 90 || actualDuration >= declaredDuration * 0.5) {
    return null;
  }
  return {
    actual_source_duration_sec: Number(actualDuration.toFixed(3)),
    declared_source_duration_sec: Number(declaredDuration.toFixed(3)),
    source_workflow_mode: itemConfig.source_workflow_mode || '',
    source_type: itemConfig.source_type || '',
    reason: 'local source video is too short for the longform analysis timestamps'
  };
}

function clampHighlightWindowToSource(window = {}, sourceDurationSec = 0, maxDurationSec = 10) {
  const sourceDuration = Number(sourceDurationSec || 0);
  const maxDuration = Math.max(0.2, Number(maxDurationSec) || SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    const fallbackDuration = Math.max(0.2, Number(window.duration_sec || maxDuration) || maxDuration);
    const fallbackStart = Math.max(0, Number(window.start_sec || 0));
    return {
      ...window,
      start_sec: Number(fallbackStart.toFixed(3)),
      duration_sec: Number(fallbackDuration.toFixed(3)),
      end_sec: Number((fallbackStart + fallbackDuration).toFixed(3))
    };
  }

  const duration = Math.max(
    0.2,
    Math.min(
      maxDuration,
      sourceDuration,
      Number(window.duration_sec || 0) || maxDuration
    )
  );
  const requestedStart = Number(window.start_sec || 0);
  const start = Math.max(0, Math.min(
    Number.isFinite(requestedStart) ? requestedStart : 0,
    Math.max(0, sourceDuration - duration)
  ));
  const end = Math.min(sourceDuration, start + duration);
  return {
    ...window,
    start_sec: Number(start.toFixed(3)),
    duration_sec: Number(Math.max(0.2, end - start).toFixed(3)),
    end_sec: Number(end.toFixed(3))
  };
}

async function runSafeHighlightTrim({ sourcePath, targetPath, window, sourceDurationSec, maxDurationSec }) {
  const warnings = [];
  const safeWindow = clampHighlightWindowToSource(window, sourceDurationSec, maxDurationSec);
  await runFfmpegTrim({
    sourcePath,
    targetPath,
    startSec: safeWindow.start_sec,
    durationSec: safeWindow.duration_sec
  });
  if (hasUsableVideoStream(targetPath)) {
    return { window: safeWindow, warnings };
  }

  warnings.push('highlight trim produced an invalid video stream; retrying from safe source start');
  const fallbackDuration = sourceDurationSec > 0
    ? Math.min(Math.max(0.2, sourceDurationSec), Math.max(0.2, Number(maxDurationSec) || SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC))
    : Math.max(0.2, Number(maxDurationSec) || SHORTFORM_HIGHLIGHT_MAX_DURATION_SEC);
  const fallbackWindow = {
    ...safeWindow,
    start_sec: 0,
    duration_sec: Number(fallbackDuration.toFixed(3)),
    end_sec: Number(fallbackDuration.toFixed(3)),
    reason: `${safeWindow.reason || 'highlight_window'}; fallback_start_after_invalid_trim`
  };
  await runFfmpegTrim({
    sourcePath,
    targetPath,
    startSec: fallbackWindow.start_sec,
    durationSec: fallbackWindow.duration_sec
  });
  if (hasUsableVideoStream(targetPath)) {
    return { window: fallbackWindow, warnings };
  }

  const sourceValid = hasUsableVideoStream(sourcePath);
  if (sourceValid && sourceDurationSec > 0 && sourceDurationSec <= (Number(maxDurationSec) || 10) + 0.25) {
    fs.copyFileSync(sourcePath, targetPath);
    if (hasUsableVideoStream(targetPath)) {
      warnings.push('highlight trim fallback copied short source video because trim output remained invalid');
      return {
        window: {
          ...fallbackWindow,
          start_sec: 0,
          duration_sec: Number(sourceDurationSec.toFixed(3)),
          end_sec: Number(sourceDurationSec.toFixed(3)),
          reason: `${fallbackWindow.reason}; copied_short_source_fallback`
        },
        warnings
      };
    }
  }

  throw new Error(`highlight source trim failed: output has no usable video stream (${targetPath})`);
}

const HIGHLIGHT_HOOK_TERM_GROUPS = {
  impact: [
    'press', 'pressed', 'pressing', 'stamp', 'punch', 'hit', 'impact', 'crush', 'squeeze', 'compress',
    '\u30d7\u30ec\u30b9', '\u5727\u7e2e', '\u6210\u5f62', '\u6253\u3061\u629c', '\u62bc\u3057', '\u6f70',
    '\uc555\ucc29', '\ub204\ub974', '\uc131\ud615'
  ],
  flow: [
    'pour', 'flow', 'stream', 'extrude', 'extruder', 'noodle', 'liquid', 'conveyor', 'fill', 'feed',
    '\u6d41', '\u6ce8\u304e', '\u62bc\u3057\u51fa', '\u62bc\u51fa', '\u30cc\u30fc\u30c9\u30eb', '\u30b3\u30f3\u30d9\u30a2',
    '\ud750\ub984', '\uc555\ucd9c', '\ucee8\ubca0\uc774\uc5b4'
  ],
  human: [
    'hand', 'hands', 'worker', 'manual', 'artisan', 'craft', 'trim', 'arrange',
    '\u624b\u5143', '\u4f5c\u696d\u54e1', '\u8077\u4eba', '\u624b\u4f5c\u696d', '\u624b\u3067',
    '\uc190', '\uc7a5\uc778', '\uc218\uc791\uc5c5'
  ],
  mystery: [
    'transform', 'reveal', 'unexpected', 'mystery', 'change', 'before', 'after', 'shape', 'becomes',
    '\u5909\u5316', '\u5909\u8eab', '\u9a5a\u304d', '\u79d8\u5bc6', '\u59ff', '\u5f62',
    '\ubcc0\uc2e0', '\ubcc0\ud654', '\ube44\ubc00', '\uad81\uae08'
  ]
};

function getHighlightScenesForWindow(itemConfig = {}, window = {}) {
  const sourceDuration = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const transitions = normalizeSceneTransitions(getItemSceneTransitions(itemConfig), sourceDuration || itemConfig.target_duration_sec || 0);
  const start = Number(window.start_sec || 0);
  const end = Number(window.end_sec || start + Number(window.duration_sec || 10));
  const selectedIds = new Set(Array.isArray(window.selected_scene_ids) ? window.selected_scene_ids.filter(Boolean) : []);
  const overlapScenes = transitions.filter((scene) => {
    const sceneStart = Number(scene.start_sec || 0);
    const sceneEnd = Number(scene.end_sec || scene.transition_at_sec || sceneStart);
    return sceneEnd > start && sceneStart < end;
  });
  const idScenes = selectedIds.size
    ? transitions.filter((scene) => selectedIds.has(scene.scene_id))
    : [];
  if (window.single_process_only) {
    const singleProcessScenes = (idScenes.length ? idScenes : overlapScenes)
      .sort((a, b) => scoreSceneForHighlight(b) - scoreSceneForHighlight(a))
      .slice(0, 1);
    return singleProcessScenes;
  }
  const seen = new Set();
  return [...overlapScenes, ...idScenes].filter((scene) => {
    const key = scene.scene_id || JSON.stringify([scene.start_sec, scene.end_sec, scene.visual_summary]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyHighlightHook(itemConfig = {}, window = {}) {
  const scenes = getHighlightScenesForWindow(itemConfig, window);
  const guide = itemConfig.ottogi_guide_output || {};
  const guideWindow = guide.recommended_highlight_window && typeof guide.recommended_highlight_window === 'object'
    ? guide.recommended_highlight_window
    : {};
  const texts = [
    ...scenes.map(getSceneHighlightText),
    guideWindow.visual_hook_type,
    guideWindow.reason,
    guideWindow.curiosity_reason,
    guide.highlight_visual_hook_type,
    guide.highlight_selection_reason,
    guide.highlight_explainer_text,
    guide.highlight_explainer_text_ko
  ].map((value) => String(value || '').toLowerCase()).filter(Boolean);
  const countGroup = (group) => countTermHits(texts, HIGHLIGHT_HOOK_TERM_GROUPS[group]);
  const scores = {
    impact: countGroup('impact'),
    flow: countGroup('flow'),
    human: countGroup('human'),
    mystery: countGroup('mystery'),
    repetition: countTermHits(texts, HIGHLIGHT_REPETITION_TERMS)
  };
  const highMotion = scenes.filter((scene) => scene.motion_intensity === 'high').length;
  const actionChanges = scenes.filter((scene) => scene.change_type === 'action_change').length;
  const avgRepetition = scenes.length
    ? scenes.reduce((sum, scene) => sum + clampScore(scene.repetition_potential, 1, 10, 1), 0) / scenes.length
    : 0;
  const cameraMoves = scenes.map((scene) => String(scene.recommended_camera_move || '').toLowerCase()).filter(Boolean);
  const metadataWidth = Number(itemConfig.video_metadata?.width || itemConfig.source_classification?.width || 0);
  const metadataHeight = Number(itemConfig.video_metadata?.height || itemConfig.source_classification?.height || 0);
  const sourceAspect = metadataWidth > 0 && metadataHeight > 0 ? metadataWidth / metadataHeight : 0;
  const isLongformSource = itemConfig.source_workflow_mode === 'longform_to_shorts'
    || itemConfig.source_type === 'longform'
    || Number(itemConfig.video_metadata?.duration_sec || itemConfig.source_classification?.duration_sec || 0) >= 90;
  const isWideLongform = isLongformSource && (!sourceAspect || sourceAspect > 1.25);

  let presetId = 'highlight_hook_zoom_out';
  if (scores.impact >= 1 || cameraMoves.includes('punch_zoom') || highMotion >= 2) {
    presetId = 'highlight_impact_punch_cut';
  } else if (scores.repetition >= 2 || avgRepetition >= 7 || actionChanges >= 2) {
    presetId = 'highlight_micro_loop_pulse';
  } else if (scores.flow >= 1 || cameraMoves.includes('speed_up')) {
    presetId = 'highlight_flow_tracking';
  } else if (scores.human >= 1) {
    presetId = 'highlight_human_hand_focus';
  } else if (scores.mystery >= 1) {
    presetId = 'highlight_mystery_reveal_zoom';
  }
  const shortformPresetId = presetId;
  if (isWideLongform) {
    presetId = 'highlight_longform_core_crop';
  }

  return {
    preset_id: presetId,
    shortform_preset_id: shortformPresetId,
    scores,
    high_motion_scenes: highMotion,
    action_change_scenes: actionChanges,
    average_repetition_potential: Number(avgRepetition.toFixed(2)),
    selected_scene_ids: scenes.map((scene) => scene.scene_id).filter(Boolean),
    scene_count: scenes.length,
    camera_moves: cameraMoves,
    source_type: itemConfig.source_type || 'unknown',
    source_workflow_mode: itemConfig.source_workflow_mode || 'unknown',
    source_aspect_ratio: sourceAspect ? Number(sourceAspect.toFixed(3)) : null,
    wide_longform_core_crop: isWideLongform,
    reason: presetId === 'highlight_hook_zoom_out'
      ? 'fallback_extreme_close_to_context_reveal'
      : presetId === 'highlight_longform_core_crop'
        ? 'wide_longform_requires_core_process_crop_for_9_16_highlight'
      : 'auto_selected_from_gemini_visual_hook_cues'
  };
}

function mergeHighlightPresetBase(basePreset = {}, preset = {}) {
  return {
    ...(basePreset || {}),
    ...preset,
    global_transform: {
      ...((basePreset || {}).global_transform || {}),
      ...(preset.global_transform || {})
    },
    color_adjustment: preset.color_adjustment || (basePreset || {}).color_adjustment || { enabled: true, style: 'clean_hdr' },
    crop_mode: preset.crop_mode || 'vertical_fill',
    crop_zoom: true,
    mirror: true,
    speed_variation: true,
    sharpen: true
  };
}

function buildHighlightPresetById(presetId, basePreset = {}, analysis = {}) {
  const presets = {
    highlight_hook_zoom_out: {
      preset_id: 'highlight_hook_zoom_out',
      name: 'Highlight Hook Zoom Out',
      display_name: 'Highlight Hook Zoom Out',
      description: 'Starts with a strong close-up hook, then zooms out to reveal the process context.',
      segment_unit_sec: 2,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 1.68 },
      pan_limit_x: 0.22,
      pan_limit_y: 0.18,
      max_zoom_scale: 2.35,
      focus_tracking: { enabled: true, mode: 'scene_focus_zone', strength: 'high' },
      pattern: [
        { scale: 2.08, pan_x: 0.00, pan_y: -0.08, rotation: -2.6, speed: 0.86, duration_sec: 1.5, label: 'extreme_close_hook' },
        { scale: 1.86, pan_x: -0.14, pan_y: -0.04, rotation: 2.0, speed: 1.14, duration_sec: 1.7, label: 'motion_focus_left' },
        { scale: 1.66, pan_x: 0.16, pan_y: 0.03, rotation: -1.8, speed: 1.24, duration_sec: 1.7, label: 'motion_focus_right' },
        { scale: 1.34, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.02, duration_sec: 2.1, label: 'context_zoom_out' }
      ],
      process_order: ['Start at 2.08 close-up on the core action', 'Use left/right focus pans and speed contrast', 'End with 1.34 context reveal']
    },
    highlight_longform_core_crop: {
      preset_id: 'highlight_longform_core_crop',
      name: 'Highlight Longform Core Crop',
      display_name: 'Highlight Longform Core Crop',
      description: 'For 16:9 longform sources: crop into the core work area instead of showing the whole horizontal frame.',
      segment_unit_sec: 1.15,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 2.28 },
      pan_limit_x: 0.33,
      pan_limit_y: 0.24,
      max_zoom_scale: 3.05,
      focus_tracking: { enabled: true, mode: 'wide_longform_core_crop', strength: 'high' },
      crop_intent: 'core_process_close_crop_from_wide_longform',
      pattern: [
        { scale: 2.58, pan_x: 0.00, pan_y: -0.05, rotation: -1.4, speed: 1.10, duration_sec: 1.0, label: 'wide_core_entry' },
        { scale: 2.94, pan_x: -0.24, pan_y: -0.02, rotation: 1.8, speed: 0.84, duration_sec: 1.0, label: 'left_core_detail_hold' },
        { scale: 2.48, pan_x: 0.26, pan_y: 0.03, rotation: -2.0, speed: 1.28, duration_sec: 1.0, label: 'right_process_motion' },
        { scale: 2.82, pan_x: 0.06, pan_y: 0.00, rotation: 1.4, speed: 0.90, duration_sec: 1.1, label: 'tool_or_material_focus' },
        { scale: 2.22, pan_x: 0.00, pan_y: -0.01, rotation: 0.0, speed: 1.08, duration_sec: 1.4, label: 'tight_context_return' }
      ],
      process_order: [
        'Treat 16:9 longform as source material, not as a full-frame vertical video',
        'Crop into the core tool/material interaction at 2.1x to 2.7x',
        'Use horizontal pan to choose the work area inside the wide frame',
        'Avoid showing unnecessary empty side context from the original longform'
      ]
    },
    highlight_micro_loop_pulse: {
      preset_id: 'highlight_micro_loop_pulse',
      name: 'Highlight Micro Loop Pulse',
      display_name: 'Highlight Micro Loop Pulse',
      description: 'Uses fast scale and speed pulses on naturally repetitive machine motion without duplicating source cuts.',
      segment_unit_sec: 1.15,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 1.76 },
      pan_limit_x: 0.24,
      pan_limit_y: 0.20,
      max_zoom_scale: 2.35,
      focus_tracking: { enabled: true, mode: 'repetitive_motion_pulse', strength: 'high' },
      pattern: [
        { scale: 1.82, pan_x: -0.08, pan_y: -0.03, rotation: -1.6, speed: 1.22, duration_sec: 1.0, label: 'pulse_in' },
        { scale: 2.12, pan_x: 0.06, pan_y: 0.02, rotation: 2.0, speed: 0.72, duration_sec: 0.75, label: 'slow_hold_detail' },
        { scale: 1.68, pan_x: 0.14, pan_y: -0.03, rotation: -2.3, speed: 1.42, duration_sec: 0.85, label: 'fast_release' },
        { scale: 2.18, pan_x: -0.12, pan_y: 0.04, rotation: 2.5, speed: 0.82, duration_sec: 0.9, label: 'repeat_detail' },
        { scale: 1.76, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.18, duration_sec: 1.1, label: 'rhythm_reset' }
      ],
      process_order: ['Use naturally repetitive motion only', 'Pulse scale 1.58 to 1.96 every second', 'Alternate slow holds and fast releases for mechanical rhythm']
    },
    highlight_impact_punch_cut: {
      preset_id: 'highlight_impact_punch_cut',
      name: 'Highlight Impact Punch Cut',
      display_name: 'Highlight Impact Punch Cut',
      description: 'Aggressive punch zoom and speed contrast for pressing, stamping, cutting, or impact moments.',
      segment_unit_sec: 0.95,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 1.84 },
      pan_limit_x: 0.24,
      pan_limit_y: 0.20,
      max_zoom_scale: 2.45,
      focus_tracking: { enabled: true, mode: 'impact_focus', strength: 'high' },
      pattern: [
        { scale: 1.88, pan_x: 0.00, pan_y: -0.05, rotation: -2.0, speed: 1.28, duration_sec: 0.65, label: 'anticipation_push' },
        { scale: 2.34, pan_x: -0.08, pan_y: 0.00, rotation: 3.0, speed: 0.65, duration_sec: 0.6, label: 'impact_hold' },
        { scale: 1.64, pan_x: 0.16, pan_y: 0.03, rotation: -3.0, speed: 1.50, duration_sec: 0.75, label: 'snap_release' },
        { scale: 2.12, pan_x: -0.14, pan_y: -0.03, rotation: 2.6, speed: 0.82, duration_sec: 0.8, label: 'second_punch' },
        { scale: 1.48, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.14, duration_sec: 1.1, label: 'context_return' }
      ],
      process_order: ['Cut around impact moments', 'Use 2.08 punch zoom with slow hold', 'Snap back fast so the hit feels stronger']
    },
    highlight_mystery_reveal_zoom: {
      preset_id: 'highlight_mystery_reveal_zoom',
      name: 'Highlight Mystery Reveal Zoom',
      display_name: 'Highlight Mystery Reveal Zoom',
      description: 'Starts extremely close on an unclear object, then gradually reveals what the process is doing.',
      segment_unit_sec: 1.6,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 1.78 },
      pan_limit_x: 0.22,
      pan_limit_y: 0.18,
      max_zoom_scale: 2.40,
      focus_tracking: { enabled: true, mode: 'mystery_reveal_focus', strength: 'high' },
      pattern: [
        { scale: 2.30, pan_x: -0.06, pan_y: -0.04, rotation: -1.4, speed: 0.82, duration_sec: 1.2, label: 'unknown_closeup' },
        { scale: 2.02, pan_x: 0.10, pan_y: -0.02, rotation: 1.6, speed: 0.94, duration_sec: 1.3, label: 'partial_reveal' },
        { scale: 1.72, pan_x: -0.14, pan_y: 0.03, rotation: -2.0, speed: 1.18, duration_sec: 1.4, label: 'motion_reveal' },
        { scale: 1.36, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.06, duration_sec: 2.0, label: 'process_answer' }
      ],
      process_order: ['Open as an unclear extreme close-up', 'Reveal movement before full context', 'End with enough context to answer the curiosity']
    },
    highlight_flow_tracking: {
      preset_id: 'highlight_flow_tracking',
      name: 'Highlight Flow Tracking',
      display_name: 'Highlight Flow Tracking',
      description: 'Tracks pouring, extrusion, conveyor, or continuous material flow with directional pan and speed.',
      segment_unit_sec: 1.4,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 1.72 },
      pan_limit_x: 0.26,
      pan_limit_y: 0.20,
      max_zoom_scale: 2.25,
      focus_tracking: { enabled: true, mode: 'material_flow_follow', strength: 'high' },
      pattern: [
        { scale: 1.86, pan_x: -0.20, pan_y: -0.07, rotation: -1.4, speed: 1.12, duration_sec: 1.1, label: 'flow_entry' },
        { scale: 2.04, pan_x: -0.06, pan_y: 0.00, rotation: 1.4, speed: 1.24, duration_sec: 1.2, label: 'track_center' },
        { scale: 1.82, pan_x: 0.20, pan_y: 0.05, rotation: -1.6, speed: 1.32, duration_sec: 1.2, label: 'flow_exit' },
        { scale: 1.50, pan_x: 0.00, pan_y: 0.00, rotation: 0.0, speed: 1.08, duration_sec: 1.6, label: 'process_context' }
      ],
      process_order: ['Pan along the material flow direction', 'Keep the moving material large in frame', 'Use slight speed-up to make flow feel satisfying']
    },
    highlight_human_hand_focus: {
      preset_id: 'highlight_human_hand_focus',
      name: 'Highlight Human Hand Focus',
      display_name: 'Highlight Human Hand Focus',
      description: 'Zooms heavily into hand-work so the viewer watches the exact manual action, not the surrounding body.',
      segment_unit_sec: 1.3,
      mirror_policy: 'global_once_only',
      global_transform: { mirror: true, scale: 1.82 },
      pan_limit_x: 0.24,
      pan_limit_y: 0.22,
      max_zoom_scale: 2.45,
      focus_tracking: { enabled: true, mode: 'hand_material_contact', strength: 'high' },
      pattern: [
        { scale: 2.02, pan_x: -0.12, pan_y: 0.10, rotation: -1.6, speed: 1.04, duration_sec: 1.1, label: 'hand_entry' },
        { scale: 2.30, pan_x: 0.10, pan_y: 0.05, rotation: 1.8, speed: 0.80, duration_sec: 1.0, label: 'manual_detail_hold' },
        { scale: 1.90, pan_x: -0.04, pan_y: -0.06, rotation: -2.0, speed: 1.28, duration_sec: 1.2, label: 'work_motion' },
        { scale: 1.66, pan_x: 0.10, pan_y: 0.03, rotation: 1.4, speed: 1.12, duration_sec: 1.6, label: 'crafted_result' }
      ],
      process_order: ['Crop away unnecessary worker/body area', 'Hold the exact hand action larger than 1.9x', 'Use moderate rhythm so the manual skill stays readable']
    }
  };
  const preset = presets[presetId] || presets.highlight_hook_zoom_out;
  return mergeHighlightPresetBase(basePreset, {
    ...preset,
    auto_highlight_preset: true,
    highlight_hook_analysis: analysis,
    crop_mode: 'vertical_fill',
    color_adjustment: { enabled: true, style: 'clean_hdr' },
    distortion: { enabled: true, type: 'strong_rotation', max_degrees: 3.0 }
  });
}

function buildHighlightHookZoomOutPreset(basePreset = {}, itemConfig = {}, window = {}) {
  const analysis = classifyHighlightHook(itemConfig, window);
  return buildHighlightPresetById(analysis.preset_id, basePreset, analysis);
}

async function createHighlightDraftForItem({
  itemId,
  itemNumber,
  draftStartedAtStamp,
  itemConfig,
  queueConfig,
  baseConfig,
  sourceVideoPath,
  outputRoot,
  baseProjectName,
  createZip,
  highlightWindow = null,
  highlightIndex = 1,
  highlightTotal = 1
}) {
  const sourceDurationSec = getSourceVideoDurationSec(sourceVideoPath, itemConfig);
  const sourceMismatch = detectLongformLocalSourceMismatch(itemConfig, sourceDurationSec);
  if (sourceMismatch) {
    const error = new Error(
      `Longform source mismatch: local source is ${sourceMismatch.actual_source_duration_sec}s, `
        + `but analysis expects ${sourceMismatch.declared_source_duration_sec}s. Re-download the full source or treat this item as shortform.`
    );
    error.code = 'OTTOGI_LONGFORM_SOURCE_MISMATCH';
    error.details = sourceMismatch;
    throw error;
  }
  const itemForHighlight = sourceDurationSec > 0
    ? {
        ...itemConfig,
        target_duration_sec: sourceDurationSec,
        video_metadata: {
          ...(itemConfig.video_metadata || {}),
          duration_sec: sourceDurationSec
        },
        source_classification: {
          ...(itemConfig.source_classification || {}),
          duration_sec: sourceDurationSec
        }
      }
    : itemConfig;
  const maxDurationSec = highlightMaxDurationForItem(itemForHighlight, queueConfig.highlight_duration_sec);
  const selectedOverrideWindow = normalizeHighlightCandidateWindow(
    itemConfig.selected_highlight_window,
    itemForHighlight,
    maxDurationSec,
    'user_selected_highlight_window'
  );
  const pickedWindow = highlightWindow || selectedOverrideWindow || pickHighlightWindow(itemForHighlight, maxDurationSec);
  const itemDir = getItemDir(itemId);
  const highlightOrdinal = Math.max(1, Math.round(Number(highlightIndex) || 1));
  const totalHighlights = Math.max(1, Math.round(Number(highlightTotal) || 1));
  const highlightSourcePath = path.join(itemDir, totalHighlights > 1 ? `highlight_source_${String(highlightOrdinal).padStart(2, '0')}.mp4` : 'highlight_source.mp4');
  const trimResult = await runSafeHighlightTrim({
    sourcePath: sourceVideoPath,
    targetPath: highlightSourcePath,
    window: pickedWindow,
    sourceDurationSec,
    maxDurationSec
  });
  const window = trimResult.window;

  const shiftedScenes = shiftHighlightSceneTransitions(itemConfig, window);
  const firstBlock = Array.isArray(itemConfig.explainer_blocks) && itemConfig.explainer_blocks.length
    ? itemConfig.explainer_blocks[0]
    : defaultItemConfig(itemId).explainer_blocks[0];
  const baseGuide = itemConfig.ottogi_guide_output || {};
  const baseHighlightMetadata = getVariantMetadata(baseGuide, 'highlight');
  const highlightGuideTitle = selectGuideTitle(baseGuide, 'highlight');
  const baseHighlightTitle = String(
    itemConfig.highlight_upload_title ||
      highlightGuideTitle?.title ||
      `${itemConfig.upload_title || baseProjectName} HIGHLIGHT`
  ).trim();
  const highlightTitle = totalHighlights > 1
    ? `${baseHighlightTitle} H${String(highlightOrdinal).padStart(2, '0')}`
    : baseHighlightTitle;
  const candidateGuide = buildHighlightCandidateGuide(baseGuide, window, highlightOrdinal, totalHighlights, highlightTitle);
  const highlightMetadata = getVariantMetadata(candidateGuide, 'highlight');
  const guideText = stripEmoji(String(
    highlightMetadata.onscreen_caption_block
      || candidateGuide.highlight_explainer_text
      || baseHighlightMetadata.onscreen_caption_block
      || baseGuide.highlight_explainer_text
      || (Array.isArray(baseGuide.highlight_hook_captions_ja)
        ? baseGuide.highlight_hook_captions_ja.join(' ')
        : '')
      || baseGuide.short_description_200
      || baseGuide.explainer_text
      || firstBlock?.text
      || '\u3053\u306E\u5DE5\u7A0B\u3067\u6700\u3082\u8996\u899A\u7684\u306B\u5F15\u304D\u8FBC\u307E\u308C\u308B\u77AC\u9593\u3067\u3059\u3002'
  ).replace(/\s+/g, ' '));
  const cleanHighlightGuideText = stripHighlightScreenInternalNotes(guideText);
  const highlightChannelAsset = queueConfig.highlight_channel_asset?.path
    ? queueConfig.highlight_channel_asset
    : baseConfig.channel_asset;
  const highlightOcrWarnings = [];
  const highlightOcrDetection = {
    status: 'disabled_fixed_mask',
    regions_count: 0,
    zone_counts: {},
    report_path: '',
    preview_path: '',
    source_path: highlightSourcePath,
    reason: 'OCR detection disabled; fixed blur mask is used.'
  };
  const highlightConfigInput = applyOcrMaskConfig({
    ...baseConfig,
    source_video: highlightSourcePath,
    target_duration_sec: window.duration_sec,
    upload_title: highlightTitle,
    channel_asset: highlightChannelAsset,
    channel_frame_asset: disabledChannelFrameAsset(),
    use_bgm: queueConfig.highlight_custom_bgm_path ? true : baseConfig.use_bgm,
    bgm_preset: queueConfig.highlight_bgm_preset || baseConfig.bgm_preset,
    custom_bgm_path: queueConfig.highlight_custom_bgm_path || baseConfig.custom_bgm_path || '',
    custom_bgm_original_name: queueConfig.highlight_custom_bgm_original_name || '',
    bgm_volume: queueConfig.highlight_bgm_volume ?? baseConfig.bgm_volume,
    video_transform_preset: buildHighlightHookZoomOutPreset(baseConfig.video_transform_preset, itemConfig, window),
    capcut_template_draft_name: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_highlight'),
    variant_policy_id: 'jp_highlight',
    caption_mode: 'long_bottom_explainer',
    visual_template: 'jp_highlight',
    explainer_blocks: [
      {
        block_id: 'highlight_exp_001',
        text: cleanHighlightGuideText || 'この工程で最も目を引く瞬間を切り出したハイライトです。素材の形が変わる動き、機械や手作業のリズム、完成へ近づく気持ちよさが短い時間に詰まっています。',
        start_sec: 0,
        end_sec: window.duration_sec,
        style_role: 'main_explainer',
        style_profile: 'highlight_explainer',
        anchor_zone: 'lower_third',
        animation: 'echo_slam',
        output_language: 'ja',
        language: 'ja'
      }
    ],
    source_preprocess: {
      ...(baseConfig.source_preprocess || {}),
      scene_tail_trim_sec: 0,
      scene_detection: {
        ...((baseConfig.source_preprocess || {}).scene_detection || {}),
        enabled: true,
        gemini_scene_transitions: shiftedScenes,
        gemini_scene_change_times: shiftedScenes.map((scene) => scene.transition_at_sec)
      }
    }
  }, highlightOcrDetection);
  const highlightConfig = normalizeConfig(highlightConfigInput);

  const result = await createProcessDraft({
    config: highlightConfig,
    useExistingConfig: false,
    createZip
  });
  const highlightProjectName = draftFolderNameForBatchItem({
    startedAtStamp: draftStartedAtStamp,
    itemNumber,
    variant: 'H',
    title: highlightTitle || itemConfig.upload_title || baseProjectName,
    fallback: `${itemId}_highlight`
  });
  const highlightOutDir = path.join(outputRoot, highlightProjectName);
  const highlightWorkingDir = copyDraftToGeneratingFolder(result.draftPath, highlightOutDir);
  const finalCaptionNormalization = normalizeFinalDraftCaptions(highlightWorkingDir);
  attachJsonFilePatch(path.join(highlightWorkingDir, 'edit_manifest.json'), {
    highlight_draft: {
      enabled: true,
      highlight_index: highlightOrdinal,
      highlight_total: totalHighlights,
      max_duration_sec: maxDurationSec,
      source_window: window,
      selection_strategy: window.selection_strategy || 'natural_source_repetition_no_artificial_loop',
      selected_scene_ids: window.selected_scene_ids || [],
      auto_video_transform_preset: highlightConfig.video_transform_preset?.preset_id || '',
      highlight_hook_analysis: highlightConfig.video_transform_preset?.highlight_hook_analysis || null,
      shifted_scene_transitions_count: shiftedScenes.length,
      highlight_caption_mode: 'single_long_explainer_block'
    },
    final_caption_normalization: finalCaptionNormalization,
    highlight_source_trim_warnings: trimResult.warnings,
    ocr_text_detection: {
      status: highlightOcrDetection.status,
      regions_count: highlightOcrDetection.regions_count || 0,
      zone_counts: highlightOcrDetection.zone_counts || {},
      report_path: highlightOcrDetection.report_path || '',
      preview_path: highlightOcrDetection.preview_path || '',
      reason: highlightOcrDetection.reason || '',
      source_stage: 'highlight_source_before_capcut_draft_generation',
      source_video_modified: false
    },
    ...buildVariantStrategyManifestPatch({ ...itemConfig, ottogi_guide_output: candidateGuide }, 'jp_highlight')
  });
  fs.appendFileSync(
    path.join(highlightWorkingDir, 'capcut_notes.md'),
    [
      '',
      '## Highlight Draft',
      '- Enabled: true',
      `- Highlight Index: ${highlightOrdinal}/${totalHighlights}`,
      `- Selection Strategy: ${window.selection_strategy || 'natural_source_repetition_no_artificial_loop'}`,
      `- Single Process Only: ${window.single_process_only ? 'true' : 'false'}`,
      `- Longform Highlight Rule: ${window.longform_highlight_rule || 'none'}`,
      `- Source Window: ${window.start_sec}s - ${window.end_sec}s`,
      `- Duration: ${window.duration_sec}s`,
      `- Selection Reason: ${window.reason}`,
      `- Auto Video Transform Preset: ${highlightConfig.video_transform_preset?.preset_id || 'unknown'}`,
      `- Hook Analysis: ${JSON.stringify(highlightConfig.video_transform_preset?.highlight_hook_analysis || {})}`,
      '- Highlight Caption Mode: single long explainer block',
      `- Highlight BGM: ${queueConfig.highlight_custom_bgm_original_name || queueConfig.highlight_custom_bgm_path || 'default/full BGM'}`,
      `- Selected Scene IDs: ${(window.selected_scene_ids || []).join(', ') || 'none'}`,
      `- OCR Mask Detection: ${highlightOcrDetection.status}`,
      `- OCR Mask Mode: fixed blur mask`,
      `- OCR Mask Report: ${highlightOcrDetection.report_path || 'none'}`,
      `- OCR Mask Preview: ${highlightOcrDetection.preview_path || 'none'}`,
      ...trimResult.warnings.map((warning) => `- Source Trim Warning: ${warning}`),
      ...highlightOcrWarnings.map((warning) => `- OCR Warning: ${warning}`),
      ...buildVariantStrategyNoteLines({ ...itemConfig, ottogi_guide_output: candidateGuide }, 'jp_highlight'),
      ''
    ].join('\n'),
    'utf8'
  );
  const finalizeResult = finalizeGeneratingDraftFolder(highlightWorkingDir, highlightOutDir);
  const metadataFiles = copyOttogiMetadataFiles(itemId, highlightOutDir, highlightProjectName, 'highlight', 'ja', candidateGuide);
  attachJsonFilePatch(path.join(highlightOutDir, 'edit_manifest.json'), {
    draft_folder_finalization: {
      generating_folder: highlightWorkingDir,
      final_folder: highlightOutDir,
      method: finalizeResult.method,
      completed_at: nowIso()
    }
  });

  return {
    status: 'success',
    highlight_index: highlightOrdinal,
    highlight_total: totalHighlights,
    output_folder: highlightOutDir,
    source_path: highlightSourcePath,
    original_draft_path: result.draftPath,
    original_zip_path: result.zipPath,
    final_mp4_path: fs.existsSync(path.join(highlightOutDir, 'final.mp4')) ? path.join(highlightOutDir, 'final.mp4') : '',
    metadata_files: metadataFiles,
    direct_render_status: result.directRender?.status || '',
    source_window: window,
    selected_scene_ids: window.selected_scene_ids || [],
    highlight_bgm_path: queueConfig.highlight_custom_bgm_path || '',
    highlight_bgm_original_name: queueConfig.highlight_custom_bgm_original_name || '',
    warnings: [...(result.warnings || []), ...trimResult.warnings, ...highlightOcrWarnings]
  };
}

async function createMidformDraftForItem({
  itemId,
  itemNumber,
  draftStartedAtStamp,
  itemConfig,
  queueConfig,
  sourceVideoPath,
  outputRoot,
  createZip
}) {
  const preparation = await prepareLongformMidformDraftItemConfig({
    itemId,
    itemConfig,
    sourceVideoPath
  });
  if (!preparation.sourceWindow) {
    return {
      status: 'skipped',
      warnings: preparation.warnings || [],
      source_window: null
    };
  }

  const guide = itemConfig.ottogi_guide_output || {};
  if (!guide.midform_metadata || guide.midform_metadata_source !== 'gemini') {
    const error = new Error('Midform metadata is missing. Re-run Gemini analysis before creating the midform draft.');
    error.status = 500;
    error.code = 'OTTOGI_MIDFORM_METADATA_REQUIRED';
    error.details = {
      item_id: itemId,
      midform_metadata_source: guide.midform_metadata_source || '',
      action: 'rerun_gemini_analysis'
    };
    throw error;
  }
  if (!Array.isArray(guide.midform_caption_script_ja) || !guide.midform_caption_script_ja.length || guide.midform_caption_script_source !== 'gemini') {
    const error = new Error('Midform caption script is missing. Re-run Gemini analysis before creating the midform draft.');
    error.status = 500;
    error.code = 'OTTOGI_MIDFORM_CAPTION_SCRIPT_REQUIRED';
    error.details = {
      item_id: itemId,
      midform_caption_script_source: guide.midform_caption_script_source || '',
      action: 'rerun_gemini_analysis'
    };
    throw error;
  }
  const midformWindowForDensity = guide.recommended_midform_window || guide.midform_clip_120s || {};
  const midformStart = Number(midformWindowForDensity.start_sec || 0);
  const midformEnd = Number(midformWindowForDensity.end_sec || midformWindowForDensity.end || 0);
  const midformDurationForDensity = Number.isFinite(midformEnd - midformStart) && midformEnd > midformStart
    ? midformEnd - midformStart
    : 120;
  const requiredMidformCaptions = Math.max(24, Math.min(30, Math.floor(midformDurationForDensity / 4)));
  if (guide.midform_caption_script_ja.length < requiredMidformCaptions) {
    const error = new Error(`Midform caption script is too sparse (${guide.midform_caption_script_ja.length}/${requiredMidformCaptions}). Re-run Gemini analysis before creating the midform draft.`);
    error.status = 500;
    error.code = 'OTTOGI_MIDFORM_CAPTION_SCRIPT_TOO_SPARSE';
    error.details = {
      item_id: itemId,
      midform_caption_count: guide.midform_caption_script_ja.length,
      required_midform_caption_count: requiredMidformCaptions,
      midform_duration_sec: Number(midformDurationForDensity.toFixed(3)),
      action: 'rerun_gemini_analysis'
    };
    throw error;
  }
  const midformGuideForDraft = {
    ...guide,
    full_metadata: guide.midform_metadata,
    full_metadata_ko: guide.midform_metadata_ko || {},
    full_caption_script_ja: guide.midform_caption_script_ja,
    full_caption_script_ko: Array.isArray(guide.midform_caption_script_ko) && guide.midform_caption_script_ko.length
      ? guide.midform_caption_script_ko
      : [],
    recommended_full_window: guide.recommended_midform_window || guide.midform_clip_120s || guide.recommended_full_window
  };
  const midformItemConfig = normalizeItemConfig({
    ...preparation.itemConfig,
    ottogi_guide_output: midformGuideForDraft,
    upload_title: selectGuideTitle(guide, 'midform')?.title || itemConfig.upload_title
  }, itemId);
  const midformConfig = mergeBatchConfig(queueConfig, midformItemConfig);
  const midformChannelAsset = selectQueueAsset(
    queueConfig.midform_channel_asset
  );
  midformConfig.capcut_template_draft_name = selectVariantCapcutTemplateDraftName(queueConfig, 'jp_midform');
  midformConfig.variant_policy_id = 'jp_midform';
  midformConfig.visual_template = 'jp_midform';
  midformConfig.caption_mode = 'scene_based_short_subtitles';
  midformConfig.channel_asset = midformChannelAsset;
  midformConfig.use_bgm = true;
  midformConfig.custom_bgm_path = queueConfig.midform_custom_bgm_path || '';
  midformConfig.custom_bgm_original_name = queueConfig.midform_custom_bgm_original_name || '';
  midformConfig.bgm_volume = queueConfig.midform_bgm_volume ?? midformConfig.bgm_volume;

  const result = await createProcessDraft({
    config: midformConfig,
    useExistingConfig: false,
    createZip
  });
  const titleInfo = selectGuideTitle(guide, 'midform') || selectGuideTitle(guide, 'full');
  const midformProjectName = draftFolderNameForBatchItem({
    startedAtStamp: draftStartedAtStamp,
    itemNumber,
    variant: 'M',
    title: titleInfo?.title || itemConfig.upload_title || itemId,
    fallback: `${itemId}_midform`
  });
  const midformOutDir = path.join(outputRoot, midformProjectName);
  const midformWorkingDir = copyDraftToGeneratingFolder(result.draftPath, midformOutDir);
  const finalCaptionNormalization = normalizeFinalDraftCaptions(midformWorkingDir);
  attachJsonFilePatch(path.join(midformWorkingDir, 'edit_manifest.json'), {
    midform_draft: {
      enabled: true,
      target_duration_sec: queueConfig.midform_duration_sec || 120,
      source_window: preparation.sourceWindow,
      selection_strategy: preparation.sourceWindow.selection_strategy || 'gemini_recommended_midform_window',
      caption_mode: 'scene_based_short_subtitles'
    },
    final_caption_normalization: finalCaptionNormalization,
    ...buildVariantStrategyManifestPatch(itemConfig, 'jp_midform')
  });
  fs.appendFileSync(
    path.join(midformWorkingDir, 'capcut_notes.md'),
    [
      '',
      '## JP Midform Draft',
      '- Enabled: true',
      `- Source Window: ${preparation.sourceWindow.start_sec}s - ${preparation.sourceWindow.end_sec}s`,
      `- Duration: ${preparation.sourceWindow.duration_sec}s`,
      '- Caption Mode: scene-based Japanese process captions',
      `- Midform BGM: ${queueConfig.midform_custom_bgm_original_name || queueConfig.midform_custom_bgm_path}`,
      `- Midform Logo: ${queueConfig.midform_channel_asset?.original_name || queueConfig.midform_channel_asset?.path}`,
      ...buildVariantStrategyNoteLines(itemConfig, 'jp_midform'),
      ''
    ].join('\n'),
    'utf8'
  );
  const finalizeResult = finalizeGeneratingDraftFolder(midformWorkingDir, midformOutDir);
  const metadataFiles = copyOttogiMetadataFiles(itemId, midformOutDir, midformProjectName, 'midform', 'ja', guide);
  attachJsonFilePatch(path.join(midformOutDir, 'edit_manifest.json'), {
    draft_folder_finalization: {
      generating_folder: midformWorkingDir,
      final_folder: midformOutDir,
      method: finalizeResult.method,
      completed_at: nowIso()
    }
  });

  return {
    status: 'success',
    output_folder: midformOutDir,
    source_path: resolveItemSourcePath(midformItemConfig),
    original_draft_path: result.draftPath,
    original_zip_path: result.zipPath,
    final_mp4_path: fs.existsSync(path.join(midformOutDir, 'final.mp4')) ? path.join(midformOutDir, 'final.mp4') : '',
    metadata_files: metadataFiles,
    direct_render_status: result.directRender?.status || '',
    source_window: preparation.sourceWindow,
    warnings: [...(result.warnings || []), ...(preparation.warnings || [])]
  };
}

function selectQueueAsset(...assets) {
  return assets.find((asset) => asset && asset.path) || assets.find(Boolean) || {};
}

function disabledChannelFrameAsset() {
  return {
    enabled: false,
    path: '',
    original_name: '',
    position: 'manual_capcut_preset',
    scale: 1,
    opacity: 1,
    removed: true
  };
}

async function detectVariantOcrForMask(itemId, variant, sourcePath, warnings = []) {
  try {
    const ocr = await detectQueueItemTextRegions(itemId, {
      sourcePath,
      outputJson: getItemVariantOcrReportPath(itemId, variant),
      previewPath: getItemVariantOcrPreviewPath(itemId, variant),
      intervalSec: OCR_FAST_SCAN.variantIntervalSec,
      maxFrames: OCR_FAST_SCAN.variantMaxFrames
    });
    return {
      status: 'success',
      regions_count: ocr.regions_count || 0,
      zone_counts: ocr.zone_counts || {},
      report_path: ocr.report_path || '',
      preview_path: ocr.preview_path || '',
      source_path: sourcePath
    };
  } catch (error) {
    warnings.push(`${variant} OCR mask detection failed: ${error.message}`);
    return {
      status: 'failed',
      regions_count: 0,
      zone_counts: {},
      report_path: '',
      preview_path: '',
      source_path: sourcePath,
      error: error.message
    };
  }
}

function applyOcrMaskConfig(baseConfig, ocrDetection, overrides = {}) {
  return {
    ...baseConfig,
    source_preprocess: {
      ...(baseConfig.source_preprocess || {}),
      ocr_blur: {
        ...((baseConfig.source_preprocess || {}).ocr_blur || {}),
        enabled: false
      }
    },
    ocr_mask_overlay: {
      ...((baseConfig || {}).ocr_mask_overlay || {}),
      enabled: overrides.enabled !== false,
      mode: 'fixed_template_blur_mask',
      report_path: '',
      preview_path: '',
      detection_status: ocrDetection?.status || 'disabled_fixed_mask',
      detection_reason: ocrDetection?.reason || 'OCR detection disabled; fixed blur mask is used.',
      fixed_mask: { ...FIXED_BLUR_MASK },
      zones: ['bottom'],
      max_regions_per_frame: 4,
      min_confidence: 0.5,
      padding_px: 18,
      opacity: 0.72,
      color: '#151515',
      ...overrides
    }
  };
}

function capcutDraftTemplateExists(searchRoot, draftName) {
  const root = String(searchRoot || '').trim();
  const name = String(draftName || '').trim();
  if (!root || !name) return false;
  return Boolean(findDraftContentPathInFolder(path.join(root, name), 2));
}

function capcutDraftTemplateHasExpectedMarkers(searchRoot, draftName, expectedMarkers = []) {
  const root = String(searchRoot || '').trim();
  const name = String(draftName || '').trim();
  const markers = Array.isArray(expectedMarkers) ? expectedMarkers.filter(Boolean) : [];
  if (!root || !name || !markers.length) return false;
  const draftContentPath = findDraftContentPathInFolder(path.join(root, name), 2);
  if (!draftContentPath) return false;
  try {
    const draft = JSON.parse(fs.readFileSync(draftContentPath, 'utf8'));
    const materials = Array.isArray(draft.materials?.texts) ? draft.materials.texts : [];
    const found = new Set();
    for (const material of materials) {
      const marker = detectCapcutTemplateMarker(getCapcutMaterialText(material));
      if (marker) found.add(marker);
    }
    return markers.every((marker) => found.has(marker));
  } catch {
    return false;
  }
}

function selectVariantCapcutTemplateDraftName(queueConfig = {}, variant = 'jp_full') {
  const variantDefaults = VARIANT_TEMPLATE_DRAFT_NAMES;
  const candidatesByVariant = {
    jp_full: [
      queueConfig.jp_full_capcut_template_draft_name,
      queueConfig.capcut_template_draft_name,
      variantDefaults.jp_full,
      'sample draft'
    ],
    jp_highlight: [
      queueConfig.jp_highlight_capcut_template_draft_name,
      variantDefaults.jp_highlight
    ],
    jp_midform: [
      queueConfig.jp_midform_capcut_template_draft_name,
      variantDefaults.jp_midform
    ],
    kr_full: [
      queueConfig.kr_full_capcut_template_draft_name,
      queueConfig.korean_capcut_template_draft_name,
      queueConfig.capcut_template_draft_name,
      variantDefaults.kr_full,
      'sample draft korean',
      'sample draft'
    ],
    kr_highlight: [
      queueConfig.kr_highlight_capcut_template_draft_name,
      variantDefaults.kr_highlight,
      queueConfig.jp_highlight_capcut_template_draft_name
    ]
  };
  const candidates = (candidatesByVariant[variant] || candidatesByVariant.jp_full)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const roots = [
    queueConfig.capcut_template_search_root,
    queueConfig.output?.capcut_draft_root,
    queueConfig.output?.output_root
  ].filter(Boolean);
  const expectedMarkers = expectedCaptionTemplateMarkersForVariant(variant);
  for (const requested of candidates) {
    for (const root of roots) {
      if (capcutDraftTemplateHasExpectedMarkers(root, requested, expectedMarkers)) return requested;
    }
  }
  for (const requested of candidates) {
    for (const root of roots) {
      if (capcutDraftTemplateExists(root, requested) && requested === variantDefaults[variant]) return requested;
    }
  }
  return variantDefaults[variant] || candidates[0] || variantDefaults.jp_full;
}

function selectKoreanCapcutTemplateDraftName(queueConfig = {}) {
  return selectVariantCapcutTemplateDraftName(queueConfig, 'kr_full');
}

function buildKoreanFullDraftConfig({ itemId, itemConfig, queueConfig, baseConfig }) {
  const actualSourceDuration = getSourceVideoDurationSec(resolveItemSourcePath(itemConfig), itemConfig);
  const sourceDuration = Number(actualSourceDuration || itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || baseConfig.target_duration_sec || 30);
  const titleInfo = selectKoreanTitle(itemConfig, 'full');
  const koreanReview = itemConfig.korean_review || {};
  const koreanFullMetadata = getVariantReviewMetadata(itemConfig.ottogi_guide_output || {}, 'full');
  const sceneTransitions = normalizeSceneTransitions(getItemSceneTransitions(itemConfig), sourceDuration);
  const sceneCount = sceneTransitions.length;
  const narrativeText = String(
    koreanFullMetadata.summary_caption
      || koreanReview.explainer_text
      || koreanFullMetadata.short_description
      || ''
  ).trim();
  const sceneCaptionBlocksFromScript = buildFullCaptionScriptBlocks(itemConfig.ottogi_guide_output?.full_caption_script_ko, sceneTransitions, {
    fallbackDurationSec: sourceDuration,
    animation: 'pop_in',
    styleProfile: 'full_cut_caption',
    blockPrefix: 'ko_full_script',
    language: 'ko'
  });
  const sceneCaptionBlocks = sceneCaptionBlocksFromScript.length ? sceneCaptionBlocksFromScript : buildKoreanSceneExplainerBlocks(sceneTransitions, {
    fallbackText: narrativeText,
    fallbackDurationSec: sourceDuration,
    animation: 'pop_in',
    styleProfile: 'full_cut_caption',
    blockPrefix: 'ko_scene_cap'
  });
  const sceneBlocks = sceneCaptionBlocks.length
    ? sceneCaptionBlocks
    : buildNarrativeFullDraftBlocks({
      text: narrativeText,
      language: 'ko',
      durationSec: sourceDuration,
      sceneCount: sceneCount || 1,
      animation: 'pop_in',
      blockPrefix: 'full_narrative_ko'
    });
  const sceneBlocksWithHook = applyFullPrerollHookToBlocks(sceneBlocks, itemConfig, queueConfig, 'ko');
  const koreanTargetDuration = Number((sourceDuration + sceneBlocksWithHook.hookDurationSec).toFixed(3));
  const channelAsset = selectQueueAsset(
    queueConfig.korean_channel_asset,
    queueConfig.channel_asset,
    baseConfig.channel_asset
  );
  const fullTransform = selectFullDraftVideoTransformPreset(
    baseConfig.video_transform_preset || queueConfig.video_transform_preset,
    itemConfig,
    sceneTransitions,
    'ko'
  );

  const config = normalizeConfig({
    ...baseConfig,
    capcut_template_draft_name: selectVariantCapcutTemplateDraftName(queueConfig, 'kr_full'),
    variant_policy_id: 'kr_full',
    caption_mode: 'scene_based_short_subtitles',
    visual_template: 'kr_full',
    target_duration_sec: koreanTargetDuration,
    upload_title: titleInfo.title || itemConfig.upload_title,
    upload_description: koreanReview.report_description || koreanReview.short_description || itemConfig.upload_description || '',
    upload_hashtags: titleInfo.hashtags.length ? titleInfo.hashtags : normalizeHashtags(itemConfig.upload_hashtags || []),
    output_language: 'ko',
    channel_asset: channelAsset,
    channel_frame_asset: disabledChannelFrameAsset(),
    video_transform_preset: fullTransform.presetId,
    use_bgm: queueConfig.korean_custom_bgm_path ? true : baseConfig.use_bgm,
    custom_bgm_path: queueConfig.korean_custom_bgm_path || baseConfig.custom_bgm_path || '',
    custom_bgm_original_name: queueConfig.korean_custom_bgm_original_name || baseConfig.custom_bgm_original_name || '',
    bgm_volume: queueConfig.korean_bgm_volume ?? baseConfig.bgm_volume,
    explainer_blocks: sceneBlocksWithHook.blocks
  });
  config.full_draft_video_transform_analysis = fullTransform.analysis;
  return config;
}

async function createKoreanFullDraftForItem({
  itemId,
  itemNumber,
  draftStartedAtStamp,
  itemConfig,
  queueConfig,
  baseConfig,
  outputRoot,
  createZip
}) {
  const titleInfo = selectKoreanTitle(itemConfig, 'full');
  const koreanConfig = buildKoreanFullDraftConfig({ itemId, itemConfig, queueConfig, baseConfig });
  const result = await createProcessDraft({
    config: koreanConfig,
    useExistingConfig: false,
    createZip
  });
  const projectName = draftFolderNameForBatchItem({
    startedAtStamp: draftStartedAtStamp,
    itemNumber,
    variant: 'KF',
    title: titleInfo.title || itemConfig.upload_title,
    fallback: `${itemId}_korean_full`
  });
  const outDir = path.join(outputRoot, projectName);
  copyDirContents(result.draftPath, outDir);
  const finalCaptionNormalization = normalizeFinalDraftCaptions(outDir);
  const metadataFiles = copyOttogiMetadataFiles(itemId, outDir, projectName, 'full', 'ko', itemConfig.ottogi_guide_output || {});
  const manifest = readJsonIfExists(path.join(outDir, 'edit_manifest.json')) || {};
  attachJsonFilePatch(path.join(outDir, 'edit_manifest.json'), {
    korean_draft: {
      enabled: true,
      variant: 'full',
      language: 'ko',
      source_item_id: itemId,
      caption_mode: 'korean_scene_caption_units',
      full_draft_video_transform_analysis: koreanConfig.full_draft_video_transform_analysis || null
    },
    final_caption_normalization: finalCaptionNormalization,
    ...buildVariantStrategyManifestPatch(itemConfig, 'kr_full')
  });
  fs.appendFileSync(
    path.join(outDir, 'capcut_notes.md'),
    [
      '',
      '## Korean Full Draft',
      '- Enabled: true',
      '- Language: ko',
      '- Caption Mode: Korean scene captions',
      `- Auto Full Video Transform Preset: ${koreanConfig.full_draft_video_transform_analysis?.selected_preset_id || koreanConfig.video_transform_preset || 'unknown'}`,
      `- Full Transform Reason: ${koreanConfig.full_draft_video_transform_analysis?.reason || 'unknown'}`,
      `- Korean BGM: ${queueConfig.korean_custom_bgm_original_name || queueConfig.korean_custom_bgm_path || 'default/full BGM'}`,
      `- Korean Logo: ${queueConfig.korean_channel_asset?.original_name || queueConfig.korean_channel_asset?.path || 'default logo'}`,
      ...buildVariantStrategyNoteLines(itemConfig, 'kr_full'),
      ''
    ].join('\n'),
    'utf8'
  );
  return {
    status: 'success',
    output_folder: outDir,
    original_draft_path: result.draftPath,
    original_zip_path: result.zipPath,
    final_mp4_path: fs.existsSync(path.join(outDir, 'final.mp4')) ? path.join(outDir, 'final.mp4') : '',
    metadata_files: metadataFiles,
    metadata_export_files: [],
    direct_render_status: result.directRender?.status || '',
    full_preroll_hook: manifest.full_preroll_hook || null,
    warnings: result.warnings || []
  };
}

async function createKoreanHighlightDraftForItem({
  itemId,
  itemNumber,
  draftStartedAtStamp,
  itemConfig,
  queueConfig,
  baseConfig,
  sourceVideoPath,
  outputRoot,
  createZip
}) {
  const maxDurationSec = highlightMaxDurationForItem(itemConfig, queueConfig.highlight_duration_sec);
  const sourceDurationSec = getSourceVideoDurationSec(sourceVideoPath, itemConfig);
  const itemForHighlight = sourceDurationSec > 0
    ? {
        ...itemConfig,
        target_duration_sec: sourceDurationSec,
        video_metadata: {
          ...(itemConfig.video_metadata || {}),
          duration_sec: sourceDurationSec
        },
        source_classification: {
          ...(itemConfig.source_classification || {}),
          duration_sec: sourceDurationSec
        }
      }
    : itemConfig;
  const pickedWindow = pickHighlightWindow(itemForHighlight, maxDurationSec);
  const itemDir = getItemDir(itemId);
  const highlightSourcePath = path.join(itemDir, 'korean_highlight_source.mp4');
  const trimResult = await runSafeHighlightTrim({
    sourcePath: sourceVideoPath,
    targetPath: highlightSourcePath,
    window: pickedWindow,
    sourceDurationSec,
    maxDurationSec
  });
  const window = trimResult.window;

  const shiftedScenes = shiftHighlightSceneTransitions(itemConfig, window);
  const koreanReview = itemConfig.korean_review || {};
  const koreanHighlightMetadata = getVariantReviewMetadata(itemConfig.ottogi_guide_output || {}, 'highlight');
  const titleInfo = selectKoreanTitle(itemConfig, 'highlight');
  const guideText = stripEmoji(String(
    koreanHighlightMetadata.onscreen_caption_block
      || koreanReview.short_description
      || koreanReview.explainer_text
      || itemConfig.ottogi_guide_output?.explainer_text_ko
      || itemConfig.upload_title
      || '이 공정에서 가장 시선을 끄는 핵심 장면입니다.'
  ).replace(/\s+/g, ' '));
  const channelAsset = selectQueueAsset(
    queueConfig.korean_highlight_channel_asset,
    queueConfig.korean_channel_asset,
    queueConfig.highlight_channel_asset,
    queueConfig.channel_asset,
    baseConfig.channel_asset
  );
  const koreanHighlightOcrWarnings = [];
  const koreanHighlightOcrDetection = {
    status: 'disabled_fixed_mask',
    regions_count: 0,
    zone_counts: {},
    report_path: '',
    preview_path: '',
    source_path: highlightSourcePath,
    reason: 'OCR detection disabled; fixed blur mask is used.'
  };
  const koreanHighlightConfigInput = applyOcrMaskConfig({
    ...baseConfig,
    capcut_template_draft_name: selectVariantCapcutTemplateDraftName(queueConfig, 'kr_highlight'),
    variant_policy_id: 'kr_highlight',
    caption_mode: 'long_bottom_explainer',
    visual_template: 'kr_highlight',
    source_video: highlightSourcePath,
    target_duration_sec: window.duration_sec,
    upload_title: titleInfo.title || itemConfig.highlight_upload_title || itemConfig.upload_title,
    upload_description: koreanReview.report_description || koreanReview.short_description || '',
    upload_hashtags: titleInfo.hashtags.length ? titleInfo.hashtags : normalizeHashtags(itemConfig.upload_hashtags || []),
    output_language: 'ko',
    channel_asset: channelAsset,
    channel_frame_asset: disabledChannelFrameAsset(),
    use_bgm: queueConfig.korean_highlight_custom_bgm_path || queueConfig.korean_custom_bgm_path || queueConfig.highlight_custom_bgm_path ? true : baseConfig.use_bgm,
    custom_bgm_path: queueConfig.korean_highlight_custom_bgm_path || queueConfig.korean_custom_bgm_path || queueConfig.highlight_custom_bgm_path || baseConfig.custom_bgm_path || '',
    custom_bgm_original_name: queueConfig.korean_highlight_custom_bgm_original_name || queueConfig.korean_custom_bgm_original_name || queueConfig.highlight_custom_bgm_original_name || baseConfig.custom_bgm_original_name || '',
    bgm_volume: queueConfig.korean_highlight_bgm_volume ?? queueConfig.korean_bgm_volume ?? baseConfig.bgm_volume,
    video_transform_preset: buildHighlightHookZoomOutPreset(baseConfig.video_transform_preset, itemConfig, window),
    explainer_blocks: [
      {
        ...(itemConfig.explainer_blocks?.[0] || defaultItemConfig(itemId).explainer_blocks[0]),
        block_id: 'ko_highlight_exp_001',
        text: guideText,
        start_sec: 0,
        end_sec: window.duration_sec,
        style_role: 'main_explainer',
        style_profile: 'highlight_explainer',
        anchor_zone: 'lower_third',
        animation: 'echo_slam',
        output_language: 'ko',
        language: 'ko'
      }
    ],
    source_preprocess: {
      ...(baseConfig.source_preprocess || {}),
      scene_tail_trim_sec: 0,
      scene_detection: {
        ...((baseConfig.source_preprocess || {}).scene_detection || {}),
        enabled: true,
        gemini_scene_transitions: shiftedScenes,
        gemini_scene_change_times: shiftedScenes.map((scene) => scene.transition_at_sec)
      }
    }
  }, koreanHighlightOcrDetection);
  const koreanHighlightConfig = normalizeConfig(koreanHighlightConfigInput);

  const result = await createProcessDraft({
    config: koreanHighlightConfig,
    useExistingConfig: false,
    createZip
  });
  const projectName = draftFolderNameForBatchItem({
    startedAtStamp: draftStartedAtStamp,
    itemNumber,
    variant: 'KH',
    title: titleInfo.title || itemConfig.upload_title,
    fallback: `${itemId}_korean_highlight`
  });
  const outDir = path.join(outputRoot, projectName);
  copyDirContents(result.draftPath, outDir);
  const finalCaptionNormalization = normalizeFinalDraftCaptions(outDir);
  const metadataFiles = copyOttogiMetadataFiles(itemId, outDir, projectName, 'highlight', 'ko', itemConfig.ottogi_guide_output || {});
  attachJsonFilePatch(path.join(outDir, 'edit_manifest.json'), {
    korean_draft: {
      enabled: true,
      variant: 'highlight',
      language: 'ko',
      source_item_id: itemId,
      source_window: window,
      selection_strategy: window.selection_strategy || 'natural_source_repetition_no_artificial_loop',
      auto_video_transform_preset: koreanHighlightConfig.video_transform_preset?.preset_id || '',
      highlight_hook_analysis: koreanHighlightConfig.video_transform_preset?.highlight_hook_analysis || null,
      caption_mode: 'korean_long_highlight_explainer'
    },
    final_caption_normalization: finalCaptionNormalization,
    highlight_source_trim_warnings: trimResult.warnings,
    ocr_text_detection: {
      status: koreanHighlightOcrDetection.status,
      regions_count: koreanHighlightOcrDetection.regions_count || 0,
      zone_counts: koreanHighlightOcrDetection.zone_counts || {},
      report_path: koreanHighlightOcrDetection.report_path || '',
      preview_path: koreanHighlightOcrDetection.preview_path || '',
      reason: koreanHighlightOcrDetection.reason || '',
      source_stage: 'korean_highlight_source_before_capcut_draft_generation',
      source_video_modified: false
    },
    ...buildVariantStrategyManifestPatch(itemConfig, 'kr_highlight')
  });
  fs.appendFileSync(
    path.join(outDir, 'capcut_notes.md'),
    [
      '',
      '## Korean Highlight Draft',
      '- Enabled: true',
      '- Language: ko',
      `- Source Window: ${window.start_sec}s - ${window.end_sec}s`,
      `- Duration: ${window.duration_sec}s`,
      `- Auto Video Transform Preset: ${koreanHighlightConfig.video_transform_preset?.preset_id || 'unknown'}`,
      `- Hook Analysis: ${JSON.stringify(koreanHighlightConfig.video_transform_preset?.highlight_hook_analysis || {})}`,
      `- Korean Highlight BGM: ${queueConfig.korean_highlight_custom_bgm_original_name || queueConfig.korean_highlight_custom_bgm_path || queueConfig.korean_custom_bgm_original_name || queueConfig.korean_custom_bgm_path || queueConfig.highlight_custom_bgm_original_name || queueConfig.highlight_custom_bgm_path || 'korean/full/highlight/default BGM'}`,
      `- Korean Highlight Logo: ${queueConfig.korean_highlight_channel_asset?.original_name || queueConfig.korean_highlight_channel_asset?.path || 'fallback logo'}`,
      `- OCR Mask Detection: ${koreanHighlightOcrDetection.status}`,
      `- OCR Mask Mode: fixed blur mask`,
      `- OCR Mask Report: ${koreanHighlightOcrDetection.report_path || 'none'}`,
      `- OCR Mask Preview: ${koreanHighlightOcrDetection.preview_path || 'none'}`,
      ...trimResult.warnings.map((warning) => `- Source Trim Warning: ${warning}`),
      ...koreanHighlightOcrWarnings.map((warning) => `- OCR Warning: ${warning}`),
      ...buildVariantStrategyNoteLines(itemConfig, 'kr_highlight'),
      ''
    ].join('\n'),
    'utf8'
  );
  return {
    status: 'success',
    output_folder: outDir,
    source_path: highlightSourcePath,
    original_draft_path: result.draftPath,
    original_zip_path: result.zipPath,
    final_mp4_path: fs.existsSync(path.join(outDir, 'final.mp4')) ? path.join(outDir, 'final.mp4') : '',
    metadata_files: metadataFiles,
    direct_render_status: result.directRender?.status || '',
    source_window: window,
    selected_scene_ids: window.selected_scene_ids || [],
    highlight_bgm_path: queueConfig.korean_highlight_custom_bgm_path || queueConfig.korean_custom_bgm_path || queueConfig.highlight_custom_bgm_path || '',
    highlight_bgm_original_name: queueConfig.korean_highlight_custom_bgm_original_name || queueConfig.korean_custom_bgm_original_name || queueConfig.highlight_custom_bgm_original_name || '',
    warnings: [...(result.warnings || []), ...trimResult.warnings, ...koreanHighlightOcrWarnings]
  };
}

async function generateQueue({ batch_name, item_ids, stop_on_error = false, draft_variant_mode = 'all' } = {}) {
  ensureQueueFolders();
  const queueConfig = loadQueueConfig();
  const normalizedDraftVariantMode = normalizeDraftVariantMode(draft_variant_mode);
  assertQueueAssetsReady(queueConfig, normalizedDraftVariantMode);
  const batchId = safeId(batch_name || queueConfig.batch_name || `process_batch_${Date.now()}`);
  const outputConfig = {
    ...defaultQueueConfig().output,
    ...(queueConfig.output || {})
  };
  const capcutDraftRoot = resolveOutputRoot(outputConfig.output_root);
  const createZip = outputConfig.create_zip === true;
  const draftStartedAt = new Date();
  const draftStartedAtStamp = formatDraftStartStamp(draftStartedAt);
  const metadataExportDate = formatDraftDateStamp(draftStartedAt);
  const outputValidation = validateOutputRoot(capcutDraftRoot);
  if (!outputValidation.writable) {
    const error = new Error(`capcut draft root is not writable: ${outputValidation.message}`);
    error.status = 400;
    throw error;
  }
  const reportDir = path.join(BATCH_OUTPUT_ROOT, batchId);
  fs.mkdirSync(reportDir, { recursive: true });
  const metadataExportDir = path.join(capcutDraftRoot, '_metadata_exports', metadataExportDate);
  fs.mkdirSync(metadataExportDir, { recursive: true });

  const queue = listQueue();
  const queueItemMap = new Map(queue.queueItems.map((item) => [item.item_id, item]));
  const itemsToRun = Array.isArray(item_ids) && item_ids.length
    ? item_ids.map((id) => queueItemMap.get(safeId(id))).filter(Boolean)
    : queue.queueItems;

  const report = {
    batch_id: batchId,
    mode: 'ultra_efficiency_process_batch',
    started_at: draftStartedAt.toISOString(),
    draft_started_at_stamp: draftStartedAtStamp,
    finished_at: '',
    total_items: itemsToRun.length,
    success_count: 0,
    failed_count: 0,
    capcut_draft_root: capcutDraftRoot,
    report_dir: reportDir,
    metadata_export_dir: metadataExportDir,
    metadata_export_date: metadataExportDate,
    output_root: capcutDraftRoot,
    output: {
      mode: 'capcut_draft_root',
      capcut_draft_root: capcutDraftRoot,
      output_root: capcutDraftRoot,
      report_dir: reportDir,
      metadata_export_dir: metadataExportDir,
      metadata_export_date: metadataExportDate,
      create_zip: createZip
    },
    common_config: {
      capcut_template_id: queueConfig.capcut_template_id,
      variant_templates: {
        jp_full: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_full'),
        jp_highlight: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_highlight'),
        jp_midform: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_midform')
      },
      bgm_preset: queueConfig.bgm_preset,
      full_bgm_path: queueConfig.custom_bgm_path || '',
      highlight_bgm_path: queueConfig.highlight_custom_bgm_path || '',
      midform_bgm_path: queueConfig.midform_custom_bgm_path || '',
      full_logo_path: queueConfig.channel_asset?.path || '',
      highlight_logo_path: queueConfig.highlight_channel_asset?.path || '',
      midform_logo_path: queueConfig.midform_channel_asset?.path || '',
      video_transform_preset: queueConfig.video_transform_preset,
      create_highlight_draft: queueConfig.create_highlight_draft === true,
      create_midform_draft: queueConfig.create_midform_draft !== false,
      create_korean_drafts: queueConfig.create_korean_drafts === true,
      highlight_duration_sec: queueConfig.highlight_duration_sec || 10,
      midform_duration_sec: queueConfig.midform_duration_sec || 120,
      draft_variant_mode: normalizedDraftVariantMode
    },
    items: []
  };

  for (const [runIndex, itemSummary] of itemsToRun.entries()) {
    const itemId = itemSummary.item_id;
    const itemNumber = runIndex + 1;
    const itemConfigPath = getItemConfigPath(itemId);
    let itemConfig = normalizeItemConfig(readJsonIfExists(itemConfigPath) || itemSummary.item_config, itemId);
    const titleProjectName = draftFolderNameForBatchItem({
      startedAtStamp: draftStartedAtStamp,
      itemNumber,
      variant: 'F',
      title: itemConfig.upload_title,
      fallback: itemId
    });
    const duplicateTitleCount = report.items.filter((item) => item.draft_project_name === titleProjectName).length;
    const itemProjectName = duplicateTitleCount ? `${titleProjectName}_${itemId}` : titleProjectName;
    const itemOutDir = path.join(capcutDraftRoot, itemProjectName);

    const row = {
      item_id: itemId,
      batch_item_number: itemNumber,
      draft_project_name: itemProjectName,
      status: 'pending',
      source_video: resolveItemSourcePath(itemConfig),
      output_folder: itemOutDir,
      final_mp4_path: '',
      direct_render_status: 'pending',
      zip_file: '',
      zip_path: '',
      upload_title: itemConfig.upload_title || '',
      upload_description: itemConfig.upload_description || '',
      upload_hashtags: itemConfig.upload_hashtags || [],
      source_url: itemConfig.source_url || '',
      source_type: itemConfig.source_type || 'unknown',
      source_type_origin: itemConfig.source_type_origin || '',
      source_workflow_mode: itemConfig.source_workflow_mode || 'unknown',
      source_classification: itemConfig.source_classification || null,
      regional_editing_strategy: itemConfig.ottogi_guide_output?.regional_editing_strategy || null,
      variant_strategy: itemConfig.ottogi_guide_output?.variant_strategy || null,
      variant_strategy_phase: 'phase1_shared_cut_plan',
      metadata_files: [],
      highlight_outputs: [],
      explainer_blocks_count: Array.isArray(itemConfig.explainer_blocks) ? itemConfig.explainer_blocks.length : 0,
      source_download_status: fs.existsSync(resolveItemSourcePath(itemConfig)) ? 'already_exists' : 'pending',
      ocr_text_detection_status: 'pending',
      ocr_text_detection: null,
      korean_full_status: queueConfig.create_korean_drafts === true ? 'pending' : 'disabled',
      korean_highlight_status: queueConfig.create_korean_drafts === true && queueConfig.create_highlight_draft === true ? 'pending' : 'disabled',
      midform_status: queueConfig.create_midform_draft !== false ? 'pending' : 'disabled',
      warnings: []
    };

    try {
      if (!fs.existsSync(row.source_video)) {
        const sourceUrl = String(itemConfig.source_url || '').trim();
        if (!sourceUrl) {
          throw new Error(`source video not found: ${row.source_video}`);
        }
        row.source_download_status = 'downloading';
        const downloaded = await downloadQueueItemSourceFromUrl(itemId, sourceUrl);
        itemConfig = normalizeItemConfig(readJsonIfExists(itemConfigPath) || downloaded.item?.item_config || itemConfig, itemId);
        row.source_video = resolveItemSourcePath(itemConfig);
        row.source_type = itemConfig.source_type || 'unknown';
        row.source_type_origin = itemConfig.source_type_origin || '';
        row.source_workflow_mode = itemConfig.source_workflow_mode || 'unknown';
        row.source_classification = itemConfig.source_classification || null;
        row.source_download_status = 'success';
        row.warnings.push(`source video downloaded from URL: ${sourceUrl}`);
        if (!fs.existsSync(row.source_video)) {
          throw new Error(`source video download finished but file was not found: ${row.source_video}`);
        }
      }

      const itemDraftVariantMode = effectiveDraftVariantModeForItem(normalizedDraftVariantMode, itemConfig);
      const wantsFullDraft = ['all', 'full_highlight_only', 'full_only'].includes(itemDraftVariantMode);
      const wantsHighlightDraft = ['all', 'full_highlight_only'].includes(itemDraftVariantMode)
        ? queueConfig.create_highlight_draft === true
        : itemDraftVariantMode === 'highlight_only';
      const wantsMidformDraft = ['all', 'midform_only'].includes(itemDraftVariantMode);
      const guideOutput = itemConfig.ottogi_guide_output || {};
      const fullAnalysisReady = guideOutput.full_generation_status !== 'failed';
      const highlightAnalysisReady = guideOutput.highlight_generation_status !== 'failed';
      const midformAnalysisReady = guideOutput.midform_generation_status !== 'failed';

      let outputDecision = decideOutputModeForItem(itemConfig, {
        createHighlightDraft: wantsHighlightDraft
      });
      if (itemDraftVariantMode === 'highlight_only' || itemDraftVariantMode === 'midform_only') {
        outputDecision = {
          ...outputDecision,
          output_mode: itemDraftVariantMode,
          skip_full_draft: true,
          skip_reason: itemDraftVariantMode === 'highlight_only'
            ? '\uD558\uC774\uB77C\uC774\uD2B8\uB9CC \uC0DD\uC131\uD558\uB3C4\uB85D \uC120\uD0DD\uD588\uC2B5\uB2C8\uB2E4.'
            : '\u004d\u0069\u0064\u0066\u006f\u0072\u006d\uB9CC \uC0DD\uC131\uD558\uB3C4\uB85D \uC120\uD0DD\uD588\uC2B5\uB2C8\uB2E4.',
          reasons: [
            ...(Array.isArray(outputDecision.reasons) ? outputDecision.reasons : []),
            `${itemDraftVariantMode} generation requested`
          ]
        };
      }
      if (itemConfig.ottogi_guide_output) {
        assertOttogiGuideLanguage(itemConfig.ottogi_guide_output, {
          includeFull: wantsFullDraft && outputDecision.skip_full_draft !== true && fullAnalysisReady,
          includeHighlight: wantsHighlightDraft && highlightAnalysisReady,
          includeMidform: wantsMidformDraft && midformAnalysisReady,
          includeScenes: wantsFullDraft && outputDecision.skip_full_draft !== true && fullAnalysisReady,
          strictHighlightMetadata: wantsHighlightDraft && highlightAnalysisReady,
          includeJapanese: true,
          includeKorean: queueConfig.create_korean_drafts === true
        });
      }
        itemConfig = saveOutputDecisionToItem(itemId, itemConfig, outputDecision);
        row.output_mode = outputDecision.output_mode;
        row.skip_full_draft = outputDecision.skip_full_draft;
        row.skip_full_draft_reason = outputDecision.skip_reason;
        row.skip_midform_draft = outputDecision.skip_midform_draft;
        row.skip_midform_reason = outputDecision.skip_midform_reason;
        row.output_mode_decision = outputDecision;
        const shouldGenerateFullDraft = wantsFullDraft && outputDecision.skip_full_draft !== true && fullAnalysisReady;
        const shouldGenerateHighlightDraft = wantsHighlightDraft && highlightAnalysisReady;
        const fullDraftPreparation = shouldGenerateFullDraft
          ? await prepareLongformFullDraftItemConfig({
              itemId,
              itemConfig,
              sourceVideoPath: row.source_video
            })
          : { itemConfig, sourceWindow: null, warnings: [] };
        if (fullDraftPreparation.warnings?.length) {
          row.warnings.push(...fullDraftPreparation.warnings);
        }
        const fullDraftItemConfig = fullDraftPreparation.itemConfig || itemConfig;
        const mergedConfig = mergeBatchConfig(queueConfig, fullDraftItemConfig);
        let result = null;

        if (!shouldGenerateFullDraft) {
          row.output_folder = '';
          row.full_status = wantsFullDraft && !fullAnalysisReady ? 'failed' : 'skipped';
          row.full_error = wantsFullDraft && !fullAnalysisReady
            ? (guideOutput.full_generation_error || 'Full Gemini analysis failed')
            : '';
          row.direct_render_status = 'skipped';
          row.warnings.push(`full draft skipped: ${fullAnalysisReady ? outputDecision.skip_reason : (guideOutput.full_generation_error || 'Full metadata analysis failed')}`);
        } else {
          row.ocr_text_detection_status = 'disabled_fixed_mask';
          row.ocr_text_detection = {
            regions_count: 0,
            zone_counts: {},
            report_path: '',
            preview_path: '',
            reason: 'OCR detection disabled; fixed blur mask is used.'
          };
          mergedConfig.source_preprocess = {
            ...(mergedConfig.source_preprocess || {}),
            ocr_blur: {
              ...((mergedConfig.source_preprocess || {}).ocr_blur || {}),
              enabled: false
            }
          };
          mergedConfig.ocr_mask_overlay = {
            enabled: true,
            mode: 'fixed_template_blur_mask',
            report_path: '',
            preview_path: '',
            review_path: '',
            review_status: 'disabled_fixed_mask',
            approved_regions_count: null,
            detection_status: 'disabled_fixed_mask',
            detection_reason: 'OCR detection disabled; fixed blur mask is used.',
            fixed_mask: { ...FIXED_BLUR_MASK },
            zones: ['bottom'],
            max_regions_per_frame: 4,
            min_confidence: 0.5,
            padding_px: 18,
            opacity: 0.72,
            color: '#151515'
          };
          result = await createProcessDraft({
            config: mergedConfig,
            useExistingConfig: false,
            createZip
          });

          const itemWorkingDir = copyDraftToGeneratingFolder(result.draftPath, itemOutDir);
          const finalCaptionNormalization = normalizeFinalDraftCaptions(itemWorkingDir);
          const fullManifest = readJsonIfExists(path.join(itemWorkingDir, 'edit_manifest.json')) || {};
          row.full_preroll_hook = fullManifest.full_preroll_hook || null;
          row.full_source_window = fullDraftPreparation.sourceWindow || null;
          attachJsonFilePatch(path.join(itemWorkingDir, 'edit_manifest.json'), {
            final_caption_normalization: finalCaptionNormalization,
            ocr_text_detection: {
              status: row.ocr_text_detection_status,
              regions_count: 0,
              zone_counts: {},
              report_path: '',
              active_report_path: '',
              preview_path: '',
              review_path: '',
              review_status: 'disabled_fixed_mask',
              approved_regions_count: null,
              source_stage: 'before_capcut_draft_generation',
              source_video_modified: false,
              fixed_mask: { ...FIXED_BLUR_MASK },
              reason: row.ocr_text_detection.reason
            },
            source_type: itemConfig.source_type || 'unknown',
            source_workflow_mode: itemConfig.source_workflow_mode || 'unknown',
            full_source_window: fullDraftPreparation.sourceWindow || null,
            full_draft_video_transform_analysis: mergedConfig.full_draft_video_transform_analysis || null,
            ...buildVariantStrategyManifestPatch(itemConfig, 'jp_full')
          });
          fs.appendFileSync(
            path.join(itemWorkingDir, 'capcut_notes.md'),
            [
              '',
              '## OCR Text Detection',
              `- Status: ${row.ocr_text_detection_status}`,
              '- Detection: disabled',
              '- Mask Mode: fixed blur mask',
              `- Fixed Mask: ${JSON.stringify(FIXED_BLUR_MASK)}`,
              '- Report: none',
              '- Preview: none',
              '- Source video modified: false',
              ''
            ].join('\n'),
            'utf8'
          );
      fs.appendFileSync(
        path.join(itemWorkingDir, 'capcut_notes.md'),
        [
          '',
          '## Full Draft Video Transform',
          `- Auto Preset: ${mergedConfig.full_draft_video_transform_analysis?.selected_preset_id || mergedConfig.video_transform_preset || 'unknown'}`,
          `- Reason: ${mergedConfig.full_draft_video_transform_analysis?.reason || 'unknown'}`,
          `- Scores: ${JSON.stringify(mergedConfig.full_draft_video_transform_analysis?.scores || {})}`,
          ...buildVariantStrategyNoteLines(itemConfig, 'jp_full'),
          ''
        ].join('\n'),
        'utf8'
      );
      const finalizeResult = finalizeGeneratingDraftFolder(itemWorkingDir, itemOutDir);
      row.metadata_files = copyOttogiMetadataFiles(itemId, itemOutDir, titleProjectName, 'full', 'ja', itemConfig.ottogi_guide_output || {});
      row.metadata_export_files = exportOttogiMetadataFiles(row.metadata_files, metadataExportDir, titleProjectName);
      attachJsonFilePatch(path.join(itemOutDir, 'edit_manifest.json'), {
        draft_folder_finalization: {
          generating_folder: itemWorkingDir,
          final_folder: itemOutDir,
          method: finalizeResult.method,
          completed_at: nowIso()
        }
      });

      row.status = 'success';
      row.output_folder = itemOutDir;
      row.final_mp4_path = fs.existsSync(path.join(itemOutDir, 'final.mp4')) ? path.join(itemOutDir, 'final.mp4') : '';
      row.direct_render_status = result.directRender?.status || (row.final_mp4_path ? 'success' : 'not_found');
      if (result.directRender?.status === 'failed') {
        row.warnings.push(`direct render failed: ${result.directRender.message}`);
      }
      if (createZip) {
        const itemZipName = `process_${itemId}.zip`;
        const itemZipPath = path.join(itemOutDir, itemZipName);
        copyIfExists(result.zipPath, itemZipPath);
        row.zip_file = itemZipName;
        row.zip_path = itemZipPath;
      }
      row.original_draft_path = result.draftPath;
      row.original_zip_path = result.zipPath;
      row.explainer_blocks_count = result.explainerBlocksCount ?? row.explainer_blocks_count;
        }
      row.highlight_status = shouldGenerateHighlightDraft ? 'pending' : 'disabled';
      if (shouldGenerateHighlightDraft) {
        try {
          const isLongformHighlight = isLongformHighlightSource(itemConfig);
          const highlightWindows = isLongformHighlight
            ? [selectBestHighlightWindow(
                [],
                itemConfig,
                highlightMaxDurationForItem(itemConfig, queueConfig.highlight_duration_sec)
              )]
            : [null];
          if (!highlightWindows.length) {
            row.highlight_status = 'skipped';
            row.highlight_skip_reason = 'all highlight candidates were excluded';
            row.warnings.push(row.highlight_skip_reason);
          } else {
          const highlightResults = [];
          for (const [highlightIndex, highlightWindow] of highlightWindows.entries()) {
            const highlight = await createHighlightDraftForItem({
              itemId,
              itemNumber,
              draftStartedAtStamp,
              itemConfig,
              queueConfig,
              baseConfig: mergedConfig,
              sourceVideoPath: row.source_video,
              outputRoot: capcutDraftRoot,
              baseProjectName: itemProjectName,
              createZip,
              highlightWindow,
              highlightIndex: highlightIndex + 1,
              highlightTotal: highlightWindows.length
            });
            highlightResults.push(highlight);
          }
          const highlight = highlightResults[0] || {};
          row.highlight_status = 'success';
          row.highlight_output_folder = highlight.output_folder;
          row.highlight_final_mp4_path = highlight.final_mp4_path;
          row.highlight_outputs = highlightResults.map((item) => ({
            highlight_index: item.highlight_index,
            highlight_total: item.highlight_total,
            output_folder: item.output_folder,
            final_mp4_path: item.final_mp4_path,
            source_window: item.source_window,
            selected_scene_ids: item.selected_scene_ids || [],
            metadata_files: item.metadata_files || [],
            direct_render_status: item.direct_render_status || ''
          }));
          row.highlight_metadata_export_files = highlightResults.flatMap((item) => exportOttogiMetadataFiles(
            item.metadata_files || [],
            metadataExportDir,
            path.basename(item.output_folder || '')
          ));
          row.highlight_source_window = highlight.source_window;
          row.highlight_selected_scene_ids = highlight.selected_scene_ids;
          row.highlight_direct_render_status = highlight.direct_render_status;
          row.highlight_bgm_path = highlight.highlight_bgm_path || '';
          row.highlight_bgm_original_name = highlight.highlight_bgm_original_name || '';
          if (!shouldGenerateFullDraft && highlight.output_folder) {
            row.draft_project_name = path.basename(highlight.output_folder);
            row.output_folder = '';
          }
          row.warnings = [
            ...row.warnings,
            ...highlightResults.flatMap((item) => item.warnings || [])
          ];
          }
        } catch (highlightError) {
          row.highlight_status = 'failed';
          row.highlight_error = highlightError.message;
          row.warnings.push(`highlight draft failed: ${highlightError.message}`);
        }
      }
      const shouldGenerateMidformDraft = queueConfig.create_midform_draft !== false
        && wantsMidformDraft
        && outputDecision.skip_midform_draft !== true
        && itemConfig.ottogi_guide_output?.midform_generation_status !== 'failed';
      if (!shouldGenerateMidformDraft && queueConfig.create_midform_draft !== false) {
        row.midform_status = wantsMidformDraft ? 'skipped' : 'disabled';
        row.midform_skip_reason = !wantsMidformDraft
          ? `midform not requested: ${itemDraftVariantMode}`
          : itemConfig.ottogi_guide_output?.midform_generation_status === 'failed'
            ? `midform skipped: ${itemConfig.ottogi_guide_output?.midform_generation_error || 'Midform Gemini generation failed'}`
          : (outputDecision.skip_midform_reason || 'midform skipped by output decision');
        if (wantsMidformDraft) row.warnings.push(row.midform_skip_reason);
      }
      if (shouldGenerateMidformDraft) {
        try {
          const midform = await createMidformDraftForItem({
            itemId,
            itemNumber,
            draftStartedAtStamp,
            itemConfig,
            queueConfig,
            sourceVideoPath: row.source_video,
            outputRoot: capcutDraftRoot,
            createZip
          });
          row.midform_status = midform.status || 'success';
          row.midform_output_folder = midform.output_folder || '';
          row.midform_final_mp4_path = midform.final_mp4_path || '';
          row.midform_metadata_export_files = exportOttogiMetadataFiles(
            midform.metadata_files || [],
            metadataExportDir,
            path.basename(midform.output_folder || '')
          );
          row.midform_source_window = midform.source_window || null;
          row.midform_direct_render_status = midform.direct_render_status || '';
          row.warnings = [
            ...row.warnings,
            ...(midform.warnings || [])
          ];
        } catch (midformError) {
          row.midform_status = 'failed';
          row.midform_error = midformError.message;
          row.warnings.push(`midform draft failed: ${midformError.message}`);
        }
      }
      const shouldGenerateKoreanDrafts = queueConfig.create_korean_drafts === true;
      if (shouldGenerateKoreanDrafts && shouldGenerateFullDraft) {
        try {
          const koreanFull = await createKoreanFullDraftForItem({
            itemId,
            itemNumber,
            draftStartedAtStamp,
            itemConfig,
            queueConfig,
            baseConfig: mergedConfig,
            outputRoot: capcutDraftRoot,
            createZip
          });
          row.korean_full_status = 'success';
          row.korean_full_output_folder = koreanFull.output_folder;
          row.korean_full_final_mp4_path = koreanFull.final_mp4_path;
          row.korean_full_metadata_export_files = exportOttogiMetadataFiles(
            koreanFull.metadata_files || [],
            metadataExportDir,
            path.basename(koreanFull.output_folder || '')
          );
          row.korean_full_direct_render_status = koreanFull.direct_render_status;
          row.korean_full_preroll_hook = koreanFull.full_preroll_hook || null;
          row.warnings = [
            ...row.warnings,
            ...(koreanFull.warnings || [])
          ];
        } catch (koreanFullError) {
          row.korean_full_status = 'failed';
          row.korean_full_error = koreanFullError.message;
          row.warnings.push(`Korean full draft failed: ${koreanFullError.message}`);
        }
      } else if (shouldGenerateKoreanDrafts) {
        row.korean_full_status = 'skipped';
      }
      if (shouldGenerateKoreanDrafts && shouldGenerateHighlightDraft) {
        try {
          const koreanHighlight = await createKoreanHighlightDraftForItem({
            itemId,
            itemNumber,
            draftStartedAtStamp,
            itemConfig,
            queueConfig,
            baseConfig: mergedConfig,
            sourceVideoPath: row.source_video,
            outputRoot: capcutDraftRoot,
            createZip
          });
          row.korean_highlight_status = 'success';
          row.korean_highlight_output_folder = koreanHighlight.output_folder;
          row.korean_highlight_final_mp4_path = koreanHighlight.final_mp4_path;
          row.korean_highlight_metadata_export_files = exportOttogiMetadataFiles(
            koreanHighlight.metadata_files || [],
            metadataExportDir,
            path.basename(koreanHighlight.output_folder || '')
          );
          row.korean_highlight_source_window = koreanHighlight.source_window;
          row.korean_highlight_selected_scene_ids = koreanHighlight.selected_scene_ids;
          row.korean_highlight_direct_render_status = koreanHighlight.direct_render_status;
          row.korean_highlight_bgm_path = koreanHighlight.highlight_bgm_path || '';
          row.korean_highlight_bgm_original_name = koreanHighlight.highlight_bgm_original_name || '';
          row.warnings = [
            ...row.warnings,
            ...(koreanHighlight.warnings || [])
          ];
        } catch (koreanHighlightError) {
          row.korean_highlight_status = 'failed';
          row.korean_highlight_error = koreanHighlightError.message;
          row.warnings.push(`Korean highlight draft failed: ${koreanHighlightError.message}`);
        }
      } else if (shouldGenerateKoreanDrafts) {
        row.korean_highlight_status = 'disabled';
      }
      if (!shouldGenerateFullDraft) {
        if (row.highlight_status === 'success' || row.midform_status === 'success' || row.korean_highlight_status === 'success') {
          row.status = 'success';
        } else {
          throw new Error(row.highlight_error || row.midform_error || 'requested item did not produce any draft');
        }
      }
      row.warnings = [
        ...row.warnings,
        ...(result?.warnings || [])
      ].filter((item, index, array) => item && array.indexOf(item) === index);
      if (itemConfig.source_url) {
        markSourceProduced({
          url: itemConfig.source_url,
          itemId,
          outputFolder: row.output_folder,
          highlightOutputFolder: row.highlight_output_folder || '',
          batchId
        });
      }
      report.success_count += 1;
    } catch (error) {
      row.status = 'failed';
      row.error = error.message;
      row.error_code = error.code || error.errorCode || '';
      row.error_details = error.details || error.data || null;
      row.warnings.push(error.message);
      report.failed_count += 1;
      if (stop_on_error) {
        report.items.push(row);
        break;
      }
    }

    report.items.push(row);
  }

  report.finished_at = nowIso();
  const reportPath = path.join(reportDir, 'batch_report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const notesPath = path.join(reportDir, 'batch_notes.md');
  const notes = [
    '# Process Queue Batch Notes',
    '',
    `- Batch ID: ${batchId}`,
    `- CapCut Draft Root: ${capcutDraftRoot}`,
    `- Report Dir: ${reportDir}`,
    `- Started At: ${report.started_at}`,
    `- Finished At: ${report.finished_at}`,
    `- Total Items: ${report.total_items}`,
    `- Success Count: ${report.success_count}`,
    `- Failed Count: ${report.failed_count}`,
    `- Stop On Error: ${String(!!stop_on_error)}`,
    `- Highlight Drafts: ${queueConfig.create_highlight_draft === true ? 'enabled' : 'disabled'}`,
    `- Midform Drafts: ${queueConfig.create_midform_draft !== false ? 'enabled' : 'disabled'}`,
    '- Korean Drafts: disabled (Korean is review-only inside JP metadata TXT)',
    `- Highlight Max Duration Sec: ${queueConfig.highlight_duration_sec || 10}`,
    `- Midform Target Duration Sec: ${queueConfig.midform_duration_sec || 120}`,
    '',
    '## Items',
    ...report.items.map((item) => `- ${item.item_id}: ${item.status}${item.output_mode ? ` mode=${item.output_mode}` : ''}${item.skip_full_draft ? ' full=skipped' : ''}${item.full_preroll_hook?.applied ? ` full_hook=${item.full_preroll_hook.source_start_sec}~${item.full_preroll_hook.source_end_sec}s` : ''}${item.output_folder ? ` (${item.output_folder})` : ''}${item.highlight_status && item.highlight_status !== 'disabled' ? ` highlight=${item.highlight_status}${item.highlight_output_folder ? ` (${item.highlight_output_folder})` : ''}` : ''}${item.midform_status && item.midform_status !== 'disabled' ? ` midform=${item.midform_status}${item.midform_output_folder ? ` (${item.midform_output_folder})` : ''}` : ''}${item.ocr_text_detection_status ? ` OCR=${item.ocr_text_detection_status}${item.ocr_text_detection?.regions_count !== undefined ? `(${item.ocr_text_detection.regions_count})` : ''}` : ''}${item.zip_file ? ` zip=${item.zip_file}` : ''}${item.error ? ` - ${item.error}` : ''}`)
  ].join('\n');
  fs.writeFileSync(notesPath, `${notes}\n`, 'utf8');

  return {
    batchId,
    batchDir: reportDir,
    reportDir,
    capcutDraftRoot,
    reportPath,
    notesPath,
    report
  };
}

function getReport(batchId) {
  const safeBatchId = safeId(batchId);
  const reportPath = path.join(BATCH_OUTPUT_ROOT, safeBatchId, 'batch_report.json');
  const report = readJsonIfExists(reportPath);
  if (!report) {
    const error = new Error('batch report not found');
    error.status = 404;
    throw error;
  }
  return {
    batchId: safeBatchId,
    reportPath,
    report
  };
}

module.exports = {
  QUEUE_ROOT,
  QUEUE_CONFIG_PATH,
  BATCH_OUTPUT_ROOT,
  defaultQueueConfig,
  defaultItemConfig,
  validateOutputRoot,
  getQueueItemSourceInfo,
  detectQueueItemTextRegions,
  getOcrMaskReview,
  saveOcrMaskReview,
  listQueue,
  addQueueItem,
  uploadQueueItems,
  uploadQueueBgm,
  uploadQueueChannelAsset,
  importYoutubeSourceQueueItems,
  importYoutubeQueueItems,
  replaceQueueItemSource,
  downloadQueueItemSourceFromUrl,
  applyOttogiGuideToItem,
  removeQueueItem,
  removeQueueItems,
  duplicateQueueItem,
  saveQueue,
  syncCaptionTemplateSettings,
  generateQueue,
  getReport
};

