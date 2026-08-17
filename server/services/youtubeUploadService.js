const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const { maskSecret } = require('./envService');
const { PROJECT_ROOT, readJsonIfExists } = require('./pipelinePaths');
const { normalizeUploadLoudness } = require('./uploadLoudnessService');

const QUEUE_CONFIG_PATH = path.join(PROJECT_ROOT, 'queue', 'process', 'queue_config.json');
const JOBS_DIR = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_jobs');
const IMPORTS_DIR = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_imports');
const PROFILES_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const HISTORY_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_history.json');
const PENDING_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_pending.json');
const CARDS_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_cards.json');
const DELETED_CARDS_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'youtube_upload_deleted_cards.json');

const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
// youtube.upload can put a video up but can never touch it again, and readonly
// only reads - so a title that shipped wrong stayed wrong, and a video that
// should not have gone out could not be unlisted (2026-08-16: eight Korean Fulls
// all titled "제조 공정의 결정적 순간", and seventeen duplicates of three
// sources, none of them fixable through the API). videos.update needs the
// manage scope.
const YOUTUBE_MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const YOUTUBE_OAUTH_SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE, YOUTUBE_MANAGE_SCOPE];
const DEFAULT_REDIRECT_URI = 'http://localhost:3001/api/youtube-upload/oauth/callback';
const PROFILE_PURPOSE_TO_VARIANT = {
  jp_full: 'full',
  jp_highlight: 'highlight',
  jp_midform: 'midform',
  ko_full: 'ko_full',
  ko_highlight: 'ko_highlight'
};

const activeJobs = new Map();
const cancelRequests = new Set();

function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function ensureImportsDir() {
  if (!fs.existsSync(IMPORTS_DIR)) fs.mkdirSync(IMPORTS_DIR, { recursive: true });
}

function ensureDataDir() {
  ensureJobsDir();
  ensureImportsDir();
  const dir = path.dirname(PROFILES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readListFile(filePath) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeListFile(filePath, rows) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

function normalizeUploadProfileId(item = {}) {
  return String(item.uploadProfileId || item.profileId || '').trim();
}

function itemDedupeKey(item = {}) {
  const profileId = normalizeUploadProfileId(item) || 'legacy_default';
  const itemKey = String(item.finalMp4Path || item.filePath || item.id || '').toLowerCase();
  if (!itemKey) return '';
  return `${profileId}::${itemKey}`;
}

function cardIdFor(item = {}) {
  const baseId = String(item.cardId || item.id || hashPath(item.finalMp4Path || item.filePath || item.originalName || Date.now()));
  const profileId = normalizeUploadProfileId(item);
  if (!profileId || baseId.endsWith(`::${profileId}`)) return baseId;
  return `${baseId}::${profileId}`;
}

function dateKeyFromFilename(value = '') {
  const match = String(value || '').match(/(20\d{2})(\d{2})(\d{2})(?:[_\-\s]|$)/);
  if (!match) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateKeyFromValue(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function uploadDateKeyForItem(item = {}) {
  const filePath = item.finalMp4Path || item.filePath || '';
  const nameKey = dateKeyFromFilename(item.originalName || path.basename(filePath));
  if (nameKey) return nameKey;
  return item.uploadDateKey
    || item.dateKey
    || dateKeyFromValue(item.uploadedAt)
    || dateKeyFromValue(item.publishAt)
    || dateKeyFromValue(item.modifiedAt)
    || dateKeyFromValue(item.updatedAt)
    || dateKeyFromValue(item.createdAt);
}

function makeUploadCard(item = {}, patch = {}) {
  const filePath = item.finalMp4Path || item.filePath || patch.filePath || '';
  const now = new Date().toISOString();
  const uploadDateKey = patch.uploadDateKey || uploadDateKeyForItem(item) || dateKeyFromValue(now);
  const description = sanitizePublicUploadDescription(item.description || patch.description || '');
  return {
    cardId: cardIdFor(item),
    id: cardIdFor(item),
    status: patch.status || item.cardStatus || item.status || 'matched',
    source: item.source || patch.source || 'youtube_upload_card',
    title: item.title || '',
    description,
    tags: Array.isArray(item.tags) ? item.tags : [],
    privacyStatus: item.privacyStatus || 'private',
    publishAt: item.publishAt || '',
    madeForKids: Boolean(item.madeForKids),
    categoryId: item.categoryId || '28',
    filePath,
    finalMp4Path: filePath,
    originalName: item.originalName || path.basename(filePath),
    variant: normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || filePath)),
    target_locale: item.target_locale || item.targetLocale || (normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || filePath)) === 'ko_highlight' ? 'ko-KR' : 'ja-JP'),
    metadataTextPath: item.metadataTextPath || '',
    metadataOriginalName: item.metadataOriginalName || '',
    review: item.review || null,
    uploadProfileId: item.uploadProfileId || item.profileId || '',
    youtubeVideoId: item.youtubeVideoId || patch.youtubeVideoId || '',
    youtubeUrl: item.youtubeUrl || patch.youtubeUrl || '',
    uploadedAt: item.uploadedAt || patch.uploadedAt || '',
    pendingReason: patch.pendingReason || item.pendingReason || '',
    pendingReasonCode: patch.pendingReasonCode || item.pendingReasonCode || '',
    jobId: patch.jobId || item.jobId || '',
    order: patch.order || item.order || 0,
    uploadHistory: Array.isArray(item.uploadHistory) ? item.uploadHistory : [],
    uploadDateKey,
    createdAt: item.createdAt || now,
    updatedAt: now,
    ...patch,
    description,
    variant: normalizeUploadVariant(patch.variant || item.variant || detectUploadVariant(item.originalName || filePath)),
    target_locale: patch.target_locale || patch.targetLocale || item.target_locale || item.targetLocale || (normalizeUploadVariant(patch.variant || item.variant || detectUploadVariant(item.originalName || filePath)) === 'ko_highlight' ? 'ko-KR' : 'ja-JP')
  };
}

function readUploadCards() {
  return readListFile(CARDS_PATH);
}

function writeUploadCards(cards) {
  writeListFile(CARDS_PATH, cards);
}

function isDeletedCard(item = {}) {
  const deleted = readListFile(DELETED_CARDS_PATH);
  const id = String(item.cardId || item.id || '');
  const key = itemDedupeKey(item);
  return deleted.some((row) => row.cardId === id || (key && row.key === key));
}

function rememberDeletedCard(item = {}) {
  const deleted = readListFile(DELETED_CARDS_PATH);
  const record = {
    cardId: String(item.cardId || item.id || ''),
    key: itemDedupeKey(item),
    deletedAt: new Date().toISOString()
  };
  const next = deleted.filter((row) => row.cardId !== record.cardId && row.key !== record.key);
  next.unshift(record);
  writeListFile(DELETED_CARDS_PATH, next.slice(0, 2000));
}

function upsertUploadCard(item = {}, patch = {}) {
  if (isDeletedCard(item)) return null;
  const cards = readUploadCards();
  const nextCard = makeUploadCard(item, patch);
  const key = itemDedupeKey(nextCard);
  const next = cards.filter((card) => card.cardId !== nextCard.cardId && itemDedupeKey(card) !== key);
  next.unshift(nextCard);
  writeUploadCards(next.slice(0, 2000));
  return nextCard;
}

function cardToCandidate(card = {}) {
  const filePath = card.finalMp4Path || card.filePath || '';
  const stat = filePath && fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  return {
    id: card.cardId || card.id,
    cardId: card.cardId || card.id,
    source: 'youtube_upload_card',
    batchId: card.jobId || '',
    itemId: card.id || card.cardId || '',
    originalName: card.originalName || path.basename(filePath),
    filePath,
    finalMp4Path: filePath,
    folderName: card.originalName || path.basename(filePath),
    variant: card.variant || detectUploadVariant(card.originalName || filePath),
    title: card.title || path.parse(filePath).name,
    description: sanitizePublicUploadDescription(card.description || ''),
    tags: Array.isArray(card.tags) ? card.tags : [],
    review: card.review || null,
    metadataTextPath: card.metadataTextPath || '',
    metadataOriginalName: card.metadataOriginalName || '',
    previewUrl: toUploadPreviewUrl(filePath),
    privacyStatus: card.privacyStatus || 'private',
    publishAt: '',
    madeForKids: Boolean(card.madeForKids),
    categoryId: card.categoryId || '28',
    sizeBytes: stat?.size || 0,
    modifiedAt: stat?.mtime?.toISOString?.() || card.updatedAt || card.createdAt || '',
    uploadDateKey: uploadDateKeyForItem(card) || dateKeyFromValue(stat?.mtime?.toISOString?.()) || '',
    cardStatus: card.status || '',
    uploadProfileId: card.uploadProfileId || card.profileId || '',
    profileId: card.uploadProfileId || card.profileId || ''
  };
}

function listUploadCards() {
  let cards = readUploadCards();
  if (!cards.length) {
    const migrated = [];
    for (const row of readListFile(HISTORY_PATH)) {
      if (isDeletedCard(row)) continue;
      migrated.push(makeUploadCard(row, {
        status: 'uploaded',
        youtubeVideoId: row.youtubeVideoId || '',
        youtubeUrl: row.youtubeUrl || '',
        uploadedAt: row.uploadedAt || ''
      }));
    }
    for (const row of readListFile(PENDING_PATH)) {
      if (isDeletedCard(row)) continue;
      migrated.push(makeUploadCard(row, {
        status: 'pending',
        pendingReasonCode: row.reasonCode || '',
        pendingReason: row.reason || ''
      }));
    }
    if (migrated.length) {
      writeUploadCards(migrated);
      cards = migrated;
    }
  }
  return { cards };
}

function restoreUploadCards(ids = []) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  const cards = readUploadCards();
  const selected = wanted.size
    ? cards.filter((card) => wanted.has(String(card.cardId || card.id)))
    : cards;
  return {
    candidates: selected.map(cardToCandidate),
    restoredCount: selected.length
  };
}

function deleteUploadCard(cardId) {
  const id = String(cardId || '');
  const cards = readUploadCards();
  const target = cards.find((card) => String(card.cardId || card.id) === id);
  const nextCards = cards.filter((card) => String(card.cardId || card.id) !== id);
  writeUploadCards(nextCards);
  if (target) rememberDeletedCard(target);

  const pending = readListFile(PENDING_PATH);
  const nextPending = pending.filter((row) => String(row.cardId || row.id) !== id && (!target || itemDedupeKey(row) !== itemDedupeKey(target)));
  if (nextPending.length !== pending.length) writeListFile(PENDING_PATH, nextPending);

  const history = readListFile(HISTORY_PATH);
  const nextHistory = history.filter((row) => String(row.cardId || row.id) !== id && (!target || itemDedupeKey(row) !== itemDedupeKey(target)));
  if (nextHistory.length !== history.length) writeListFile(HISTORY_PATH, nextHistory);

  return {
    deleted: cards.length !== nextCards.length,
    cardId: id,
    cards: nextCards,
    pending: nextPending,
    history: nextHistory
  };
}

function readStoredProfilesFile() {
  ensureDataDir();
  if (!fs.existsSync(PROFILES_PATH)) return { profiles: [], activeProfileId: '' };
  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    return {
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      activeProfileId: data.activeProfileId || ''
    };
  } catch {
    return { profiles: [], activeProfileId: '' };
  }
}

function writeStoredProfilesFile(data) {
  ensureDataDir();
  fs.writeFileSync(PROFILES_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function makeProfileId(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || `profile_${crypto.randomBytes(4).toString('hex')}`;
}

function looksCorruptedText(value) {
  const raw = String(value || '');
  if (raw.includes(String.fromCharCode(0xfffd)) || /[?]{2,}/.test(raw)) return true;
  return Array.from(raw).some((char) => {
    const code = char.codePointAt(0);
    return (
      (code >= 0xf900 && code <= 0xfaff) ||
      [0x8e42, 0x907a, 0x9858, 0x5a9b, 0x91c9].includes(code)
    );
  });
}

function cleanProfileName(profile) {
  const name = String(profile?.name || '').trim();
  if (name && !looksCorruptedText(name)) return name;
  return String(profile?.channelTitle || profile?.id || 'YouTube 채널').trim();
}

function uniqueProfileId(baseId, profiles, preferredId = '') {
  const preferred = makeProfileId(preferredId || '');
  if (preferred && !profiles.some((profile) => profile.id === preferred)) return preferred;

  const base = makeProfileId(baseId || `profile_${crypto.randomBytes(4).toString('hex')}`);
  if (!profiles.some((profile) => profile.id === base)) return base;

  let index = 2;
  while (profiles.some((profile) => profile.id === `${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: cleanProfileName(profile),
    channelTitle: profile.channelTitle || '',
    channelId: profile.channelId || '',
    email: profile.email || '',
    purpose: profile.purpose || '',
    hasOAuthClient: Boolean(profile.oauthClientId && profile.oauthClientSecret && profile.oauthRedirectUri),
    hasRefreshToken: Boolean(profile.refreshToken),
    oauthClientId: profile.oauthClientId || '',
    oauthClientIdHint: profile.oauthClientId ? `${String(profile.oauthClientId).slice(0, 12)}...` : '',
    oauthRedirectUri: profile.oauthRedirectUri || DEFAULT_REDIRECT_URI,
    maskedRefreshToken: maskSecret(profile.refreshToken || ''),
    maskedOAuthClientSecret: maskSecret(profile.oauthClientSecret || ''),
    retired: profile.retired === true,
    createdAt: profile.createdAt || '',
    updatedAt: profile.updatedAt || ''
  };
}

function deleteUploadCardsByDate(dateKey) {
  const targetDateKey = String(dateKey || '').trim();
  if (!targetDateKey) {
    const error = new Error('Upload date key is required');
    error.code = 'UPLOAD_DATE_KEY_REQUIRED';
    error.status = 400;
    throw error;
  }

  const cards = readUploadCards();
  const targets = cards.filter((card) => uploadDateKeyForItem(card) === targetDateKey);
  const targetIds = new Set(targets.map((card) => String(card.cardId || card.id || '')));
  const targetKeys = new Set(targets.map(itemDedupeKey).filter(Boolean));

  for (const target of targets) rememberDeletedCard(target);

  const nextCards = cards.filter((card) => !targetIds.has(String(card.cardId || card.id || '')) && !targetKeys.has(itemDedupeKey(card)));
  writeUploadCards(nextCards);

  const pending = readListFile(PENDING_PATH);
  const nextPending = pending.filter((row) => uploadDateKeyForItem(row) !== targetDateKey && !targetIds.has(String(row.cardId || row.id || '')) && !targetKeys.has(itemDedupeKey(row)));
  if (nextPending.length !== pending.length) writeListFile(PENDING_PATH, nextPending);

  const history = readListFile(HISTORY_PATH);
  const nextHistory = history.filter((row) => uploadDateKeyForItem(row) !== targetDateKey && !targetIds.has(String(row.cardId || row.id || '')) && !targetKeys.has(itemDedupeKey(row)));
  if (nextHistory.length !== history.length) writeListFile(HISTORY_PATH, nextHistory);

  return {
    deletedCount: targets.length,
    dateKey: targetDateKey,
    cards: nextCards,
    pending: nextPending,
    history: nextHistory
  };
}

function listYouTubeUploadProfiles() {
  const stored = readStoredProfilesFile();
  const profiles = stored.profiles.filter((profile) => profile?.id);
  const activeProfileId = profiles.some((profile) => profile.id === stored.activeProfileId)
    ? stored.activeProfileId
    : (profiles[0]?.id || '');

  return {
    activeProfileId,
    profiles: profiles.map(publicProfile)
  };
}

function getStoredProfile(profileId) {
  const stored = readStoredProfilesFile();
  return stored.profiles.find((profile) => profile.id === profileId) || null;
}

function getDefaultStoredProfile(stored = readStoredProfilesFile()) {
  const profiles = stored.profiles.filter((profile) => profile?.id);
  if (!profiles.length) return null;
  return profiles.find((profile) => profile.id === stored.activeProfileId) || profiles[0] || null;
}

function getDefaultUploadProfileId() {
  const profile = getDefaultStoredProfile();
  return profile?.id || '';
}

function resolveUploadProfileId(profileId = '') {
  const requested = String(profileId || '').trim();
  return requested || getDefaultUploadProfileId();
}

function resolveStoredProfile(profileId = '') {
  const stored = readStoredProfilesFile();
  const requested = String(profileId || '').trim();
  if (requested) {
    return stored.profiles.find((item) => item.id === requested) || null;
  }
  return getDefaultStoredProfile(stored);
}

function createProfileOAuthClientMissingError(profile = {}, missingFields = []) {
  const label = cleanProfileName(profile) || profile.id || '이 채널';
  const error = new Error(`채널 ${label}의 OAuth 클라이언트가 설정되지 않았습니다. 설정에서 새 OAuth 클라이언트를 등록하세요.`);
  error.code = 'YOUTUBE_PROFILE_OAUTH_CLIENT_MISSING';
  error.status = 400;
  error.details = {
    profileId: profile.id || '',
    profileName: cleanProfileName(profile),
    channelTitle: profile.channelTitle || '',
    channelId: profile.channelId || '',
    missingFields
  };
  return error;
}

function createProfileRefreshTokenMissingError(profile = {}) {
  const label = cleanProfileName(profile) || profile.id || '이 채널';
  const error = new Error(`채널 ${label}이 아직 연결되지 않았습니다. 이 채널 카드에서 재연결을 완료하세요.`);
  error.code = 'YOUTUBE_PROFILE_REFRESH_TOKEN_MISSING';
  error.status = 400;
  error.details = {
    profileId: profile.id || '',
    profileName: cleanProfileName(profile),
    channelTitle: profile.channelTitle || '',
    channelId: profile.channelId || ''
  };
  return error;
}

function assertProfileOAuthClientConfigured(profile = {}) {
  const missingFields = [];
  if (!String(profile.oauthClientId || '').trim()) missingFields.push('oauthClientId');
  if (!String(profile.oauthClientSecret || '').trim()) missingFields.push('oauthClientSecret');
  if (!String(profile.oauthRedirectUri || '').trim()) missingFields.push('oauthRedirectUri');
  if (missingFields.length) throw createProfileOAuthClientMissingError(profile, missingFields);
}

function normalizeProfileOauthInput(patch = {}, previousProfile = {}) {
  const next = {};

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    next.name = String(patch.name || '').trim() || previousProfile.name || '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'purpose')) {
    next.purpose = typeof patch.purpose === 'string' ? patch.purpose : (previousProfile.purpose || '');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'channelTitle')) {
    next.channelTitle = String(patch.channelTitle || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'channelId')) {
    next.channelId = String(patch.channelId || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'oauthClientId')) {
    next.oauthClientId = String(patch.oauthClientId || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'oauthClientSecret')) {
    const secret = String(patch.oauthClientSecret || '').trim();
    if (secret) next.oauthClientSecret = secret;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'oauthRedirectUri')) {
    next.oauthRedirectUri = String(patch.oauthRedirectUri || '').trim() || DEFAULT_REDIRECT_URI;
  }
  // Retiring a profile is how a channel is switched: the replacement is
  // authorized as its own profile and the old one is stood down rather than
  // overwritten, since a profile's refresh token is not recoverable once lost.
  // Without this the flag was silently dropped and the uploader kept choosing the
  // retired channel (2026-08-18).
  if (Object.prototype.hasOwnProperty.call(patch, 'retired')) {
    next.retired = patch.retired === true;
  }

  return next;
}

function validateProfileOAuthClientForCreate(profile = {}) {
  const missingFields = [];
  if (!String(profile.name || profile.channelTitle || '').trim()) missingFields.push('name');
  if (!String(profile.oauthClientId || '').trim()) missingFields.push('oauthClientId');
  if (!String(profile.oauthClientSecret || '').trim()) missingFields.push('oauthClientSecret');
  if (!String(profile.oauthRedirectUri || '').trim()) missingFields.push('oauthRedirectUri');
  if (!missingFields.length) return;
  const error = new Error('새 업로드 채널을 추가하려면 관리 이름, OAuth Client ID, Client Secret, Redirect URI를 모두 입력하세요.');
  error.code = 'YOUTUBE_UPLOAD_PROFILE_CREATE_FIELDS_MISSING';
  error.status = 400;
  error.details = { missingFields };
  throw error;
}

function createYouTubeUploadProfile(profile = {}) {
  const payload = normalizeProfileOauthInput({
    ...profile,
    oauthRedirectUri: profile.oauthRedirectUri || DEFAULT_REDIRECT_URI
  });
  validateProfileOAuthClientForCreate(payload);
  return saveYouTubeUploadProfile({
    name: payload.name,
    purpose: payload.purpose || '',
    channelTitle: payload.channelTitle || '',
    channelId: payload.channelId || '',
    oauthClientId: payload.oauthClientId,
    oauthClientSecret: payload.oauthClientSecret,
    oauthRedirectUri: payload.oauthRedirectUri
  });
}

function saveYouTubeUploadProfile(profile) {
  const stored = readStoredProfilesFile();
  const now = new Date().toISOString();
  const requestedId = makeProfileId(profile.id || '');
  const sameChannelProfile = profile.channelId
    ? stored.profiles.find((item) => item.channelId === profile.channelId)
    : null;
  const requestedProfile = requestedId
    ? stored.profiles.find((item) => item.id === requestedId)
    : null;
  const id = sameChannelProfile?.id
    || requestedProfile?.id
    || uniqueProfileId(
      profile.channelId ? `channel_${profile.channelId}` : (profile.name || profile.channelTitle || now),
      stored.profiles,
      requestedId
    );
  const previousProfile = stored.profiles.find((item) => item.id === id) || {};
  const nextProfile = {
    ...previousProfile,
    ...profile,
    id,
    name: profile.name || profile.channelTitle || previousProfile.name || id,
    purpose: typeof profile.purpose === 'string' ? profile.purpose : (previousProfile.purpose || ''),
    createdAt: previousProfile.createdAt || profile.createdAt || now,
    updatedAt: now
  };
  const profiles = stored.profiles.filter((item) => item.id !== id);
  profiles.push(nextProfile);
  writeStoredProfilesFile({ profiles, activeProfileId: id });
  return publicProfile(nextProfile);
}

function updateYouTubeUploadProfile(profileId, patch = {}) {
  const stored = readStoredProfilesFile();
  const now = new Date().toISOString();
  let found = false;
  const profiles = stored.profiles.map((profile) => {
    if (profile.id !== profileId) return profile;
    found = true;
    const normalized = normalizeProfileOauthInput(patch, profile);
    return {
      ...profile,
      ...normalized,
      name: String(normalized.name || profile.name || '').trim() || profile.name,
      purpose: typeof normalized.purpose === 'string' ? normalized.purpose : (profile.purpose || ''),
      updatedAt: now
    };
  });
  if (!found) {
    const error = new Error('YouTube upload profile not found');
    error.code = 'YOUTUBE_UPLOAD_PROFILE_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  writeStoredProfilesFile({ ...stored, profiles });
  return listYouTubeUploadProfiles();
}

function deleteYouTubeUploadProfile(profileId) {
  const stored = readStoredProfilesFile();
  const profiles = stored.profiles.filter((profile) => profile.id !== profileId);
  if (profiles.length === stored.profiles.length) {
    const error = new Error('YouTube upload profile not found');
    error.code = 'YOUTUBE_UPLOAD_PROFILE_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  const activeProfileId = stored.activeProfileId === profileId ? (profiles[0]?.id || '') : stored.activeProfileId;
  writeStoredProfilesFile({ profiles, activeProfileId });
  return listYouTubeUploadProfiles();
}

function setActiveYouTubeUploadProfile(profileId) {
  const stored = readStoredProfilesFile();
  const validProfileId = stored.profiles.some((profile) => profile.id === profileId) ? profileId : (stored.profiles[0]?.id || '');
  writeStoredProfilesFile({ ...stored, activeProfileId: validProfileId });
  return listYouTubeUploadProfiles();
}

function getOAuthSettings(profileId) {
  const profile = resolveStoredProfile(profileId);
  if (!profile) {
    const error = new Error('YouTube upload profile not found');
    error.code = 'YOUTUBE_UPLOAD_PROFILE_NOT_FOUND';
    error.status = 404;
    error.details = { profileId: String(profileId || '').trim() };
    throw error;
  }

  assertProfileOAuthClientConfigured(profile);
  return {
    clientId: String(profile.oauthClientId || '').trim(),
    clientSecret: String(profile.oauthClientSecret || '').trim(),
    redirectUri: String(profile.oauthRedirectUri || '').trim() || DEFAULT_REDIRECT_URI,
    refreshToken: String(profile.refreshToken || '').trim(),
    profile
  };
}

function getOAuthClient({ requireRefreshToken = false, profileId = '' } = {}) {
  const settings = getOAuthSettings(profileId);

  if (requireRefreshToken && !settings.refreshToken) {
    throw createProfileRefreshTokenMissingError(settings.profile);
  }

  const client = new OAuth2Client(settings.clientId, settings.clientSecret, settings.redirectUri);
  if (settings.refreshToken) {
    client.setCredentials({ refresh_token: settings.refreshToken });
  }
  return { client, settings };
}

function encodeOAuthState(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeOAuthState(value) {
  try {
    if (!value) return {};
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function getAuthorizationUrl({ profileId = '', profileName = '' } = {}) {
  const resolvedProfileId = resolveUploadProfileId(profileId || '');
  if (!resolvedProfileId) {
    const error = new Error('OAuth를 연결할 채널 프로필을 먼저 선택하거나 생성하세요.');
    error.code = 'YOUTUBE_UPLOAD_PROFILE_REQUIRED';
    error.status = 400;
    throw error;
  }
  const { client, settings } = getOAuthClient({ profileId: resolvedProfileId });
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: YOUTUBE_OAUTH_SCOPES,
    state: encodeOAuthState({
      profileId: resolvedProfileId,
      profileName: profileName || settings.profile?.name || settings.profile?.channelTitle || 'YouTube 채널'
    })
  });

  return {
    authUrl,
    redirectUri: settings.redirectUri,
    scopes: YOUTUBE_OAUTH_SCOPES
  };
}

async function getChannelInfoWithClient(client) {
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) return { channelTitle: '', channelId: '' };
  const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  return {
    channelTitle: data?.items?.[0]?.snippet?.title || '',
    channelId: data?.items?.[0]?.id || ''
  };
}

async function exchangeOAuthCode(code, state = '') {
  const stateData = decodeOAuthState(state);
  const profileId = String(stateData.profileId || '').trim();
  if (!profileId) {
    const error = new Error('OAuth callback state is missing profile information');
    error.code = 'YOUTUBE_OAUTH_STATE_PROFILE_MISSING';
    error.status = 400;
    throw error;
  }

  const existingProfile = getStoredProfile(profileId);
  if (!existingProfile) {
    const error = new Error('YouTube upload profile not found');
    error.code = 'YOUTUBE_UPLOAD_PROFILE_NOT_FOUND';
    error.status = 404;
    error.details = { profileId };
    throw error;
  }

  const { client, settings } = getOAuthClient({ profileId });
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    const error = new Error('Google did not return a refresh token. Reconnect with prompt=consent or remove the app access from Google Account first.');
    error.code = 'YOUTUBE_REFRESH_TOKEN_NOT_RETURNED';
    throw error;
  }

  client.setCredentials(tokens);
  const channel = await getChannelInfoWithClient(client).catch(() => ({ channelTitle: '', channelId: '' }));
  const savedProfile = saveYouTubeUploadProfile({
    ...existingProfile,
    id: profileId,
    name: existingProfile.name || stateData.profileName || channel.channelTitle || 'YouTube 채널',
    purpose: existingProfile.purpose || '',
    refreshToken: tokens.refresh_token,
    oauthClientId: settings.clientId,
    oauthClientSecret: settings.clientSecret,
    oauthRedirectUri: settings.redirectUri,
    channelTitle: channel.channelTitle,
    channelId: channel.channelId
  });

  return {
    ok: true,
    maskedRefreshToken: maskSecret(tokens.refresh_token),
    expiryDate: tokens.expiry_date || null,
    profile: savedProfile
  };
}

async function getAccessToken(profileId = '') {
  const { client, settings } = getOAuthClient({ requireRefreshToken: true, profileId });
  try {
    const tokenResult = await client.getAccessToken();
    const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
    if (!token) {
      const error = new Error('Failed to refresh YouTube access token');
      error.code = 'YOUTUBE_ACCESS_TOKEN_FAILED';
      throw error;
    }
    return token;
  } catch (error) {
    const oauthCode = error?.response?.data?.error || error?.error || error?.message || '';
    const oauthMessage = error?.response?.data?.error_description || error?.response?.data?.message || error?.message || '';
    const reconnectRequired = ['unauthorized_client', 'invalid_grant', 'invalid_client'].includes(String(oauthCode));
    const nextError = new Error(
      reconnectRequired
        ? 'YouTube OAuth reconnect required for this channel profile'
        : (oauthMessage || 'Failed to refresh YouTube access token')
    );
    nextError.code = reconnectRequired ? 'YOUTUBE_OAUTH_RECONNECT_REQUIRED' : 'YOUTUBE_ACCESS_TOKEN_FAILED';
    nextError.status = 401;
    nextError.details = {
      oauthError: oauthCode,
      oauthMessage,
      profileId: settings.profile?.id || profileId || '',
      profileName: settings.profile?.name || '',
      channelTitle: settings.profile?.channelTitle || '',
      channelId: settings.profile?.channelId || ''
    };
    throw nextError;
  }
}

async function testYouTubeUploadAuth(profileId = '') {
  const accessToken = await getAccessToken(profileId);
  const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('YouTube OAuth test failed');
    error.code = 'YOUTUBE_OAUTH_TEST_FAILED';
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return {
    status: 'ok',
    info: 'YouTube upload OAuth connected',
    channelTitle: data?.items?.[0]?.snippet?.title || '',
    channelId: data?.items?.[0]?.id || ''
  };
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getConfiguredCapCutDraftRoot() {
  const queueConfig = readJsonIfExists(QUEUE_CONFIG_PATH) || {};
  return (
    queueConfig?.output?.output_root ||
    path.join(PROJECT_ROOT, 'server', 'output', 'process_batches')
  );
}

function hashPath(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function stripLeadingTitleMarker(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*•]\s*)?(?:\d{1,2}|[０-９]{1,2})\s*[.)．、:-]\s*/u, '')
    .replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '')
    .trim();
}

function cleanTitle(value, fallback) {
  const text = stripLeadingTitleMarker(String(value || fallback || ''))
    .replace(/\s+#\S+/g, '')
    .replace(/#/g, '')
    .trim();
  return text.slice(0, 100) || 'Untitled process video';
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(raw.map((tag) => String(tag || '').replace(/^#/, '').trim()).filter(Boolean))].slice(0, 30);
}

function normalizeUploadVariant(value = '') {
  const raw = String(value || '').toLowerCase().trim();
  if (['ko_highlight', 'kr_highlight', 'korean_highlight', 'kh'].includes(raw)) return 'ko_highlight';
  if (['ko_full', 'kr_full', 'korean_full', 'kf'].includes(raw)) return 'ko_full';
  if (['jp_midform', 'ja_midform', 'midform', 'm'].includes(raw)) return 'midform';
  if (['jp_highlight', 'ja_highlight', 'highlight', 'h', 'hl'].includes(raw)) return 'highlight';
  if (['jp_full', 'ja_full', 'full', 'f'].includes(raw)) return 'full';
  return raw || 'unknown';
}

function baseUploadVariant(value = '') {
  const variant = normalizeUploadVariant(value);
  if (variant === 'ko_highlight') return 'highlight';
  if (variant === 'ko_full') return 'full';
  return variant;
}

function normalizeProfilePurpose(value = '') {
  const raw = String(value || '').trim();
  if (raw === 'highlight') return 'jp_highlight';
  if (raw === 'midform') return 'jp_midform';
  if (raw === 'full_draft' || raw === 'full') return 'jp_full';
  if (raw === 'ko_full_draft' || raw === 'kr_full' || raw === 'korean_full') return 'ko_full';
  if (raw === 'ko_highlight_draft' || raw === 'kr_highlight' || raw === 'korean_highlight') return 'ko_highlight';
  if (raw === 'legacy_env') return 'archive';
  return raw;
}

function variantForProfilePurpose(value = '') {
  return PROFILE_PURPOSE_TO_VARIANT[normalizeProfilePurpose(value)] || '';
}

function assertUploadItemsMatchProfiles(items = []) {
  const errors = [];
  const profileCache = new Map();

  for (const item of items) {
    const profileId = resolveUploadProfileId(item.uploadProfileId || item.profileId || '');
    item.uploadProfileId = profileId;
    if (!profileCache.has(profileId)) profileCache.set(profileId, getStoredProfile(profileId));

    const profile = profileCache.get(profileId);
    const expectedVariant = variantForProfilePurpose(profile?.purpose || '');
    const itemVariant = normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || item.finalMp4Path || item.filePath || ''));

    if (!profile) {
      errors.push({
        title: item.title || item.originalName || item.id || '',
        profileId,
        itemVariant,
        reason: 'YouTube upload profile not found'
      });
      continue;
    }

    if (!expectedVariant) {
      errors.push({
        title: item.title || item.originalName || item.id || '',
        profileId,
        profilePurpose: profile.purpose || '',
        itemVariant,
        reason: 'Upload profile purpose must be jp_full, jp_highlight, jp_midform, ko_full, or ko_highlight'
      });
      continue;
    }

    // Approved 2026-08-11: purposes gate at the CHANNEL LANGUAGE level, not
    // the exact format. The KR channel's diet is switching from highlights to
    // KR Full (Korean TTS) while its stored purpose is still ko_highlight -
    // a ko_full item on a ko_* profile is intentional, never a routing error.
    // Cross-language uploads (ko item to a jp profile or vice versa) remain
    // hard errors.
    const languageOf = (variant) => (String(variant).startsWith('ko') ? 'ko' : 'ja');
    if (languageOf(itemVariant) !== languageOf(expectedVariant)) {
      errors.push({
        title: item.title || item.originalName || item.id || '',
        profileId,
        profilePurpose: profile.purpose || '',
        expectedVariant,
        itemVariant,
        reason: `Profile purpose ${profile.purpose} only accepts ${languageOf(expectedVariant)} uploads`
      });
    }
  }

  if (errors.length) {
    const error = new Error('선택 채널 용도와 업로드 카드 포맷이 일치하지 않습니다.');
    error.code = 'UPLOAD_PROFILE_VARIANT_MISMATCH';
    error.details = { errors };
    throw error;
  }
}

function isKoreanUploadVariant(value = '') {
  const variant = normalizeUploadVariant(value);
  return variant === 'ko_highlight' || variant === 'ko_full';
}

function isCompatibleMetadataVariant(videoVariant, metadataVariant) {
  const video = normalizeUploadVariant(videoVariant);
  const metadata = normalizeUploadVariant(metadataVariant);
  if (!video || video === 'unknown' || video === 'exported') return true;
  if (!metadata || metadata === 'unknown' || metadata === 'exported') return true;
  return video === metadata;
}

function detectVariant(folderName, manifest = {}) {
  const manifestVariant = normalizeUploadVariant(manifest?.draft_variant || manifest?.variant || '');
  if (manifestVariant !== 'unknown') return manifestVariant;
  return detectUploadVariant(folderName);
}

function readMetadataPackage(draftDir) {
  const txtCandidates = fs.existsSync(draftDir)
    ? fs.readdirSync(draftDir)
      .filter((name) => /\.txt$/i.test(name))
      .map((name) => path.join(draftDir, name))
    : [];
  const preferred = txtCandidates.find((filePath) => path.basename(filePath) !== 'ottogi_metadata_package.txt') ||
    path.join(draftDir, 'ottogi_metadata_package.txt');
  if (!fs.existsSync(preferred)) return '';
  try {
    return fs.readFileSync(preferred, 'utf8').slice(0, 4500);
  } catch {
    return '';
  }
}

function normalizeDraftUploadCandidate(draftDir) {
  const finalMp4Path = path.join(draftDir, 'final.mp4');
  if (!fs.existsSync(finalMp4Path)) return null;

  const stat = fs.statSync(finalMp4Path);
  const folderName = path.basename(draftDir);
  const manifest = safeReadJson(path.join(draftDir, 'edit_manifest.json')) || {};
  const packageText = readMetadataPackage(draftDir);
  const variant = detectVariant(folderName, manifest);
  const parsedPackage = packageText ? parseMetadataText(packageText, folderName.replace(/^\d{8}_\d{6}-\d{3}-[FH]-/i, ''), variant) : null;
  const manifestTitle = manifest.upload_title || manifest.metadata?.upload_title || manifest.title || '';
  const targetLocale = manifest.target_locale || manifest.targetLocale || (variant === 'ko_highlight' ? 'ko-KR' : 'ja-JP');
  const uploadTitle = cleanTitle(parsedPackage?.title || manifestTitle, folderName.replace(/^\d{8}_\d{6}-\d{3}-[FH]-/i, ''));
  const hashtags = normalizeTags(parsedPackage?.tags || manifest.upload_hashtags || manifest.metadata?.upload_hashtags || ['worker', 'process']);
  const description = sanitizePublicUploadDescription(parsedPackage?.description || manifest.upload_description || manifest.metadata?.upload_description || packageText || '');

  return {
    id: hashPath(draftDir),
    draftFolder: draftDir,
    finalMp4Path,
    folderName,
    variant,
    target_locale: targetLocale,
    title: uploadTitle,
    description,
    tags: hashtags,
    review: parsedPackage?.review || null,
    privacyStatus: 'private',
    publishAt: '',
    madeForKids: false,
    categoryId: '28',
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    uploadDateKey: uploadDateKeyForItem({ originalName: folderName, filePath: finalMp4Path, modifiedAt: stat.mtime.toISOString() }),
    manifestSummary: {
      itemId: manifest.item_id || manifest.itemId || '',
      sourceVideo: manifest.source_video_path || manifest.sourceVideo || '',
      targetLocale,
      totalDurationSec: manifest.total_duration_sec || manifest.totalDurationSec || null
    }
  };
}

function repairOriginalName(name) {
  const raw = String(name || 'uploaded_file');
  if (!raw) return 'uploaded_file';

  const hasReadableUnicode = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(raw);
  const looksMojibake = /[\u00c3\u00c2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff\ufffd]/.test(raw);
  if (hasReadableUnicode && !looksMojibake) return raw.normalize('NFC');

  try {
    const repaired = Buffer.from(raw, 'latin1').toString('utf8');
    const repairedReadableUnicode = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(repaired);
    if (repairedReadableUnicode && !/[?]/.test(repaired)) return repaired.normalize('NFC');
  } catch {
    // Keep the original name.
  }

  return raw.normalize('NFC');
}

function containsHangul(value = '') {
  return /[\p{Script=Hangul}]/u.test(String(value || ''));
}

function sanitizePublicUploadDescription(value = '') {
  return stripReviewSections(String(value || '')).slice(0, 5000);
}

function safeFileName(name) {
  const parsed = path.parse(repairOriginalName(name));
  const base = parsed.name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'upload';
  return `${base}${String(parsed.ext || '').toLowerCase()}`;
}

function normalizeBaseName(name) {
  return path.parse(repairOriginalName(name)).name
    .normalize('NFKC')
    .replace(/_ko$/i, '')
    .replace(/\(\d+\)$/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_\-()[\]{}]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeUploadTitleKey(name) {
  return path.parse(repairOriginalName(name)).name
    .replace(/^upload_\d+_/i, '')
    .replace(/^meta_[a-f0-9]+_/i, '')
    .replace(/_ko$/i, '')
    .replace(/\(\d+\)$/g, '')
    .replace(/^\d{8}_\d{6}-\d{3}-[a-z]+-/i, '')
    .replace(/^\d{8}-[a-z][a-z0-9]{0,2}-\d{6}-/i, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_\-()[\]{}]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeDraftVariantCode(code, suffixIsKorean) {
  let normalizedCode = String(code || '').toLowerCase();
  if (suffixIsKorean && (normalizedCode === 'h' || normalizedCode === 'hl')) normalizedCode = 'kh';
  if (suffixIsKorean && normalizedCode === 'f') normalizedCode = 'kf';
  if (normalizedCode === 'krh' || normalizedCode === 'koh') normalizedCode = 'kh';
  if (normalizedCode === 'krf' || normalizedCode === 'kof') normalizedCode = 'kf';
  return normalizedCode;
}

// Draft folder naming has two generations:
//  - legacy:  YYYYMMDD_HHMMSS-NNN-CODE-title      (NNN = batch item number)
//  - current: YYYYMMDD-CODE-HHMMSS-title [Hnn]    (Hnn = highlight cut ordinal)
// stampKey identifies the draft generation run (no variant code), prefixKey adds
// the normalized variant code, and ordinal separates sibling highlight cuts that
// share one draft folder.
function parseDraftNameParts(name) {
  const stem = path.parse(repairOriginalName(name)).name
    .replace(/^upload_\d+_/i, '')
    .replace(/^meta_[a-f0-9]+_/i, '')
    .replace(/\(\d+\)$/g, '')
    .normalize('NFKC');
  const suffixIsKorean = /_ko$/i.test(stem);
  const legacy = stem.match(/^(\d{8}_\d{6}-\d{3})-([A-Za-z]+)/);
  if (legacy) {
    return {
      stampKey: legacy[1].toLowerCase(),
      prefixKey: `${legacy[1]}-${normalizeDraftVariantCode(legacy[2], suffixIsKorean)}`.toLowerCase(),
      ordinal: ''
    };
  }
  const current = stem.match(/^(\d{8})-([A-Za-z][A-Za-z0-9]{0,2})-(\d{6})-/);
  if (!current) return { stampKey: '', prefixKey: '', ordinal: '' };
  const ordinalMatch = stem.replace(/_ko$/i, '').match(/[\s_-]([A-Za-z]\d{1,3})$/);
  const stampKey = `${current[1]}_${current[3]}`.toLowerCase();
  return {
    stampKey,
    prefixKey: `${stampKey}-${normalizeDraftVariantCode(current[2], suffixIsKorean)}`,
    ordinal: ordinalMatch ? ordinalMatch[1].toLowerCase() : ''
  };
}

function extractDraftStampKey(name) {
  return parseDraftNameParts(name).stampKey;
}

function extractDraftMatchKey(name) {
  const { prefixKey, ordinal } = parseDraftNameParts(name);
  if (!prefixKey) return '';
  return ordinal ? `${prefixKey}-${ordinal}` : prefixKey;
}

function toUploadPreviewUrl(filePath) {
  const absolute = path.resolve(filePath || '');
  const importsRoot = path.resolve(IMPORTS_DIR);
  if (!absolute.startsWith(importsRoot)) return '';
  const relative = path.relative(importsRoot, absolute).split(path.sep).map(encodeURIComponent).join('/');
  return `/api/youtube-upload/preview/${relative}`;
}

function findMatchingMetadata(originalName, metadataByBase, importedMetadata, usedMetadataPaths) {
  const videoVariant = detectUploadVariant(originalName);
  const isUsable = (metadata) => Boolean(
    metadata?.path
    && !usedMetadataPaths.has(metadata.path)
    && isCompatibleMetadataVariant(videoVariant, metadata.variant)
  );

  const baseKey = normalizeBaseName(originalName);
  const exactCandidates = (metadataByBase.get(baseKey) || []).filter(isUsable);
  if (exactCandidates.length === 1) return exactCandidates[0];

  const draftMatchKey = extractDraftMatchKey(originalName);
  if (draftMatchKey) {
    const draftKeyCandidates = importedMetadata.filter((metadata) => (
      isUsable(metadata)
      && extractDraftMatchKey(metadata.originalName || '') === draftMatchKey
    ));
    if (draftKeyCandidates.length === 1) return draftKeyCandidates[0];
  }

  const titleKey = normalizeUploadTitleKey(originalName);
  if (!titleKey) return null;

  const videoStampKey = extractDraftStampKey(originalName);
  const candidates = importedMetadata.filter((metadata) => {
    if (!isUsable(metadata)) return false;
    // A generic title (e.g. 鍛造工程ができるまで H01) recurs across draft folders;
    // when both names carry a draft stamp, disagreeing stamps mean different
    // source videos, so a title match alone must not pair them.
    const metadataStampKey = extractDraftStampKey(metadata.originalName || '');
    if (videoStampKey && metadataStampKey && metadataStampKey !== videoStampKey) return false;
    const metadataTitleKey = normalizeUploadTitleKey(metadata.originalName || '');
    if (!metadataTitleKey) return false;
    if (metadataTitleKey === titleKey) return true;
    const shorterLength = Math.min(metadataTitleKey.length, titleKey.length);
    return shorterLength >= 8 && (metadataTitleKey.startsWith(titleKey) || titleKey.startsWith(metadataTitleKey));
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text))) {
    const value = String(match[1] || '').trim();
    if (value) blocks.push(value);
  }
  return blocks;
}

function firstMeaningfulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^[-=#*_]+$/.test(line)) || '';
}

function cleanMetadataTitle(value, fallback) {
  return cleanTitle(String(value || '').replace(/\r?\n/g, ' '), fallback);
}

function detectUploadVariant(name = '', manifest = {}) {
  const manifestVariant = normalizeUploadVariant(manifest?.draft_variant || manifest?.variant || '');
  if (manifestVariant !== 'unknown') return manifestVariant;
  const raw = String(name || '');
  const value = raw.toLowerCase();
  const koreanSuffix = /_ko(?:\.[^.]+)?$/i.test(raw);
  const koreanText = containsHangul(raw);
  if (/-kh-/i.test(raw) || /(^|[_\s-])kh($|[_\s-])/i.test(raw) || /ko[_\s-]*highlight|kr[_\s-]*highlight|korean[_\s-]*highlight/.test(value)) return 'ko_highlight';
  if (/-kf-/i.test(raw) || /(^|[_\s-])kf($|[_\s-])/i.test(raw) || /ko[_\s-]*full|kr[_\s-]*full|korean[_\s-]*full/.test(value)) return 'ko_full';
  if (/-m-/i.test(raw) || /(^|[_\s-])m($|[_\s-])/i.test(raw) || /midform|middle|2min|(?:^|[_\s-])120(?:$|[_\s-])/.test(value)) return 'midform';
  if (koreanSuffix && (/-h-/i.test(raw) || /-hl-/i.test(raw) || /(^|[_\s-])h($|[_\s-])/i.test(raw) || /(^|[_\s-])hl($|[_\s-])/i.test(raw))) return 'ko_highlight';
  if (koreanSuffix && (/-f-/i.test(raw) || /(^|[_\s-])f($|[_\s-])/i.test(raw))) return 'ko_full';
  if (koreanText && (/-h-/i.test(raw) || /-hl-/i.test(raw) || /(^|[_\s-])h($|[_\s-])/i.test(raw) || /(^|[_\s-])hl($|[_\s-])/i.test(raw))) return 'ko_highlight';
  if (koreanText && (/-f-/i.test(raw) || /(^|[_\s-])f($|[_\s-])/i.test(raw))) return 'ko_full';
  if (/-h-/i.test(raw) || /-hl-/i.test(raw) || /(^|[_\s-])h($|[_\s-])/i.test(raw) || /(^|[_\s-])hl($|[_\s-])/i.test(raw) || /highlight|hi-lite|hook/.test(value)) return 'highlight';
  if (/-f-/i.test(raw) || /(^|[_\s-])f($|[_\s-])/i.test(raw) || /full|process|draft/.test(value)) return 'full';
  return 'exported';
}

function findReviewStartIndex(text) {
  const value = String(text || '');
  const patterns = [
    /^\s*<!--\s*REVIEW_VARIANT:/im,
    /^\s*#{1,6}\s*Korean\s*review.*$/im,
    /^\s*#{1,6}\s*한국어\s*(?:검수|검토|리뷰|번역|보기|확인|참고).*$/im
  ];

  return patterns.reduce((best, pattern) => {
    const match = value.match(pattern);
    if (!match || typeof match.index !== 'number') return best;
    if (best < 0) return match.index;
    return Math.min(best, match.index);
  }, -1);
}

function stripReviewSections(text) {
  const value = String(text || '');
  const reviewStart = findReviewStartIndex(value);
  return (reviewStart >= 0 ? value.slice(0, reviewStart) : value).trim();
}

function extractReviewText(text, variant = '') {
  const value = String(text || '');
  if (variant) {
    const marker = new RegExp('<!--\\s*REVIEW_VARIANT:\\s*' + variant + '\\s*-->([\\s\\S]*?)(?=<!--\\s*(?:REVIEW_VARIANT|METADATA_VARIANT):|$)', 'i');
    const match = value.match(marker);
    if (match) return String(match[1] || '').trim();
  }
  const reviewStart = findReviewStartIndex(value);
  return reviewStart >= 0 ? value.slice(reviewStart).trim() : '';
}

function extractVariantMetadataSection(text, variant = '') {
  const value = String(text || '');
  const normalizedVariant = normalizeUploadVariant(variant);
  const baseVariant = baseUploadVariant(normalizedVariant);
  if (!baseVariant || !['highlight', 'full', 'midform'].includes(baseVariant)) return stripReviewSections(value);

  const markerVariants = isKoreanUploadVariant(normalizedVariant)
    ? [normalizedVariant, `kr_${baseVariant}`, `korean_${baseVariant}`, baseVariant]
    : [baseVariant, `jp_${baseVariant}`, `ja_${baseVariant}`];
  for (const markerVariant of markerVariants) {
    const marker = new RegExp('<!--\\s*METADATA_VARIANT:\\s*' + markerVariant + '\\s*-->([\\s\\S]*?)(?=<!--\\s*(?:METADATA_VARIANT|REVIEW_VARIANT):|$)', 'i');
    const markerMatch = value.match(marker);
    if (markerMatch) return String(markerMatch[1] || '').trim();
  }

  const koreanHeadingPattern = baseVariant === 'highlight' ? /KOREAN_HIGHLIGHT_METADATA/i : /KOREAN_FULL_DRAFT_METADATA/i;
  const koreanHeadingSection = extractMarkdownSection(value, koreanHeadingPattern);
  if (isKoreanUploadVariant(normalizedVariant) && koreanHeadingSection) return koreanHeadingSection;

  const headingPattern = baseVariant === 'highlight' ? /HIGHLIGHT_METADATA/i : (baseVariant === 'midform' ? /MIDFORM_METADATA/i : /FULL_DRAFT_METADATA/i);
  const headingSection = extractMarkdownSection(value, headingPattern);
  if (headingSection && !/KOREAN_/i.test(headingSection)) return headingSection;

  return isKoreanUploadVariant(normalizedVariant)
    ? (koreanHeadingSection || '')
    : (headingSection || stripReviewSections(value));
}

function extractMarkdownSection(text, headingPattern, options = {}) {
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*(#{1,6})\s*(.*?)\s*$/);
    if (match && headingPattern.test(match[2])) {
      start = i + 1;
      startLevel = match[1].length;
      break;
    }
  }
  if (start < 0) return '';

  const collected = [];
  for (let i = start; i < lines.length; i += 1) {
    const heading = lines[i].match(/^\s*(#{1,6})\s+(.*?)\s*$/);
    if (heading && heading[1].length <= startLevel) {
      const headingText = String(heading[2] || '').trim();
      if (options.allowNumberedSubheadings && /^\d+\./.test(headingText)) {
        collected.push(lines[i]);
        continue;
      }
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

function extractTitleCandidates(text) {
  const mainText = stripReviewSections(text);
  const titleSection = extractMarkdownSection(mainText, /(TITLE_CANDIDATES|タイトル|title)/i);
  const source = titleSection || mainText;
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\s*#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^\d+\s*[.)?-]\s*/, '').trim())
    .filter((line) => line.length >= 6 && line.length <= 180 && /#/.test(line));
}

function stripHashtags(value) {
  return String(value || '')
    .replace(/[#\uFF03][\p{L}\p{N}_-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferTitleFromMetadata(text, fallback) {
  const titleCandidates = extractTitleCandidates(text);
  if (titleCandidates.length) {
    return cleanMetadataTitle(stripHashtags(titleCandidates[0]), fallback);
  }

  const lines = stripReviewSections(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^\s*#{1,6}\s+/.test(line));
  const titleLabel = /^(title)\s*[:?]/i;
  const explicit = lines.find((line) => titleLabel.test(line));
  if (explicit) return cleanMetadataTitle(stripHashtags(explicit.replace(titleLabel, '').trim()), fallback);

  const blocks = extractCodeBlocks(stripReviewSections(text));
  const titleBlock = blocks.find((block) => {
    const line = firstMeaningfulLine(block);
    return line.length >= 6 && line.length <= 120 && /#/.test(line);
  }) || blocks.find((block) => {
    const line = firstMeaningfulLine(block);
    return line.length >= 6 && line.length <= 100;
  });
  if (titleBlock) return cleanMetadataTitle(stripHashtags(firstMeaningfulLine(titleBlock)), fallback);

  const hashtagLine = lines.find((line) => line.length <= 160 && /#/.test(line));
  return cleanMetadataTitle(stripHashtags(hashtagLine || lines[0] || fallback), fallback);
}

function inferDescriptionFromMetadata(text) {
  const raw = stripReviewSections(text);
  const reportSection = extractMarkdownSection(raw, /(REPORT_DESCRIPTION|レポート|説明文|report)/i, { allowNumberedSubheadings: true });
  if (reportSection) return reportSection.slice(0, 5000);

  const captionSection = extractMarkdownSection(raw, /(SCREEN_CAPTION|画面\s*字幕|字幕|caption|subtitle)/i);
  if (captionSection) return captionSection.slice(0, 5000);

  const lines = raw.split(/\r?\n/);
  const descriptionLabel = /^(description)\s*[:?]/i;
  const descLine = lines.find((line) => descriptionLabel.test(line.trim()));
  if (descLine) return descLine.replace(descriptionLabel, '').trim().slice(0, 5000);

  const blocks = extractCodeBlocks(raw);
  const longBlock = blocks.find((block) => block.length > 80);
  if (longBlock) return longBlock.slice(0, 5000);

  return raw.slice(0, 5000);
}

function inferTagsFromMetadata(text) {
  const titleCandidates = extractTitleCandidates(text);
  const source = titleCandidates[0] || stripReviewSections(text);
  const tags = [];
  const regex = /[#\uFF03]([\p{L}\p{N}_-]+)/gu;
  let match;
  while ((match = regex.exec(String(source || '')))) tags.push(match[1]);
  return normalizeTags(tags.length ? tags : ['worker', 'process']);
}

function inferReviewFromMetadata(text, variant = '') {
  const reviewText = extractReviewText(text, variant);
  if (!reviewText) {
    return { rawText: '', caption: '', titles: '', reportDescription: '' };
  }

  return {
    rawText: reviewText,
    caption: extractMarkdownSection(reviewText, /(SCREEN_CAPTION_KO|화면\s*자막|자막\s*번역|caption|subtitle)/i),
    titles: extractMarkdownSection(reviewText, /(TITLE_CANDIDATES_KO|제목|타이틀|title)/i),
    reportDescription: extractMarkdownSection(reviewText, /(REPORT_DESCRIPTION_KO|리포트|설명문|상세\s*설명|report)/i, { allowNumberedSubheadings: true })
  };
}

function reviewFromKoreanMetadata(metadata) {
  if (!metadata?.rawText) return null;
  const selectedText = extractVariantMetadataSection(metadata.rawText, metadata.variant || 'ko_highlight');
  const review = {
    rawText: selectedText || metadata.rawText,
    caption: extractMarkdownSection(selectedText, /(SCREEN_CAPTION|SCREEN_CAPTION_KO|화면\s*자막|자막\s*번역|caption|subtitle)/i),
    titles: extractMarkdownSection(selectedText, /(TITLE_CANDIDATES|TITLE_CANDIDATES_KO|제목|타이틀|title)/i),
    reportDescription: extractMarkdownSection(selectedText, /(REPORT_DESCRIPTION|REPORT_DESCRIPTION_KO|리포트|설명문|상세\s*설명|report)/i, { allowNumberedSubheadings: true })
  };
  return review.rawText ? review : null;
}

function expectedKoreanReviewVariant(videoVariant) {
  const normalizedVariant = normalizeUploadVariant(videoVariant);
  if (isKoreanUploadVariant(normalizedVariant)) return '';
  const baseVariant = baseUploadVariant(normalizedVariant);
  if (baseVariant === 'highlight') return 'highlight';
  if (baseVariant === 'full') return 'full';
  if (baseVariant === 'midform') return 'midform';
  return '';
}

function expectedKoreanDraftKey(draftKey, videoVariant) {
  if (!draftKey) return '';
  const reviewVariant = expectedKoreanReviewVariant(videoVariant);
  if (reviewVariant === 'highlight') return draftKey.replace(/-(h|hl)$/i, '-h');
  if (reviewVariant === 'full') return draftKey.replace(/-f$/i, '-f');
  if (reviewVariant === 'midform') return draftKey.replace(/-m$/i, '-m');
  return '';
}

function findKoreanReviewMetadata(originalName, videoVariant, importedMetadata) {
  const reviewVariant = expectedKoreanReviewVariant(videoVariant);
  if (!reviewVariant) return null;

  const baseKey = normalizeBaseName(originalName);
  const draftKey = extractDraftMatchKey(originalName);
  const koreanDraftKey = expectedKoreanDraftKey(draftKey, videoVariant);
  const titleKey = normalizeUploadTitleKey(originalName);
  const videoStampKey = extractDraftStampKey(originalName);

  const candidates = importedMetadata.filter((metadata) => {
    if (!metadata?.path || normalizeUploadVariant(metadata.variant) !== reviewVariant) return false;
    if (metadata.baseKey === baseKey && /_ko(?:\.[^.]+)?$/i.test(metadata.originalName || '')) return true;
    if (koreanDraftKey && extractDraftMatchKey(metadata.originalName || '') === koreanDraftKey) return true;

    const metadataStampKey = extractDraftStampKey(metadata.originalName || '');
    if (videoStampKey && metadataStampKey && metadataStampKey !== videoStampKey) return false;
    const metadataTitleKey = normalizeUploadTitleKey(metadata.originalName || '');
    return Boolean(
      titleKey
      && metadataTitleKey
      && (metadataTitleKey === titleKey || metadataTitleKey.includes(titleKey) || titleKey.includes(metadataTitleKey))
    );
  });

  return candidates.find((metadata) => /_ko(?:\.[^.]+)?$/i.test(metadata.originalName || '')) || candidates[0] || null;
}

function parseMetadataText(text, fallbackTitle, variant = '') {
  const selectedText = extractVariantMetadataSection(text, variant);
  return {
    title: inferTitleFromMetadata(selectedText, fallbackTitle),
    description: inferDescriptionFromMetadata(selectedText),
    tags: inferTagsFromMetadata(selectedText),
    review: inferReviewFromMetadata(text, variant) || null,
    variant: variant || 'unknown',
    rawText: String(text || '')
  };
}
function importUploadFiles({ videoFiles = [], metadataFiles = [] }) {
  ensureImportsDir();
  const batchId = `upload_import_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
  const batchDir = path.join(IMPORTS_DIR, batchId);
  fs.mkdirSync(batchDir, { recursive: true });

  const metadataByBase = new Map();
  const importedMetadata = [];
  for (const file of metadataFiles) {
    const originalName = repairOriginalName(file.originalname);
    const targetName = safeFileName(originalName);
    const targetPath = path.join(batchDir, `meta_${crypto.randomBytes(3).toString('hex')}_${targetName}`);
    fs.copyFileSync(file.path, targetPath);
    const text = fs.readFileSync(targetPath, 'utf8');
    const variant = detectUploadVariant(originalName);
    const parsed = parseMetadataText(text, path.parse(originalName).name, variant);
    const record = {
      originalName,
      path: targetPath,
      baseKey: normalizeBaseName(originalName),
      variant,
      parsed,
      rawText: text
    };
    importedMetadata.push(record);
    const rows = metadataByBase.get(record.baseKey) || [];
    rows.push(record);
    metadataByBase.set(record.baseKey, rows);
  }

  const candidates = [];
  const warnings = [];
  const usedMetadataPaths = new Set();
  for (const file of videoFiles) {
    const originalName = repairOriginalName(file.originalname);
    const targetName = safeFileName(originalName);
    const itemId = `upload_${String(candidates.length + 1).padStart(3, '0')}`;
    const targetPath = path.join(batchDir, `${itemId}_${targetName}`);
    fs.copyFileSync(file.path, targetPath);
    const stat = fs.statSync(targetPath);
    const metadata = findMatchingMetadata(originalName, metadataByBase, importedMetadata, usedMetadataPaths);
    if (metadata?.path) usedMetadataPaths.add(metadata.path);
    if (!metadata) warnings.push(`TXT metadata not matched for ${originalName}; title fallback was used.`);
    const variant = detectUploadVariant(originalName);
    const parsed = metadata?.rawText
      ? parseMetadataText(metadata.rawText, path.parse(originalName).name, variant)
      : parseMetadataText('', path.parse(originalName).name, variant);
    const reviewMetadata = findKoreanReviewMetadata(originalName, variant, importedMetadata);
    const companionReview = reviewFromKoreanMetadata(reviewMetadata);
    const review = parsed.review?.rawText ? parsed.review : companionReview;
    const candidate = {
      id: hashPath(`${targetPath}-${Date.now()}`),
      source: 'manual_export_upload',
      batchId,
      itemId,
      originalName,
      filePath: targetPath,
      finalMp4Path: targetPath,
      folderName: originalName,
      variant,
      target_locale: variant === 'ko_highlight' ? 'ko-KR' : 'ja-JP',
      title: parsed.title,
      description: sanitizePublicUploadDescription(parsed.description || ''),
      tags: parsed.tags,
      review: review || null,
      metadataTextPath: metadata?.path || '',
      metadataOriginalName: metadata?.originalName || '',
      reviewMetadataTextPath: reviewMetadata?.path || '',
      reviewMetadataOriginalName: reviewMetadata?.originalName || '',
      previewUrl: toUploadPreviewUrl(targetPath),
      privacyStatus: 'private',
      publishAt: '',
      madeForKids: false,
      categoryId: '28',
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      uploadDateKey: uploadDateKeyForItem({ originalName, filePath: targetPath, modifiedAt: stat.mtime.toISOString() })
    };
    candidates.push(candidate);
    upsertUploadCard(candidate, { status: 'matched', source: 'manual_export_upload' });
  }

  const manifest = { batchId, createdAt: new Date().toISOString(), candidates, metadataFiles: importedMetadata, warnings };
  fs.writeFileSync(path.join(batchDir, 'upload_import_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { batchId, importDir: batchDir, candidates, warnings };
}

function listDraftUploadCandidates() {
  const draftRoot = getConfiguredCapCutDraftRoot();
  const candidates = [];
  const warnings = [];

  if (!draftRoot || !fs.existsSync(draftRoot)) {
    return { draftRoot, candidates, warnings: [`CapCut draft folder not found: ${draftRoot || '(empty)'}`] };
  }

  const dirs = fs.readdirSync(draftRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  dirs.forEach((entry) => {
    const candidate = normalizeDraftUploadCandidate(path.join(draftRoot, entry.name));
    if (candidate) candidates.push(candidate);
  });

  candidates.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return { draftRoot, candidates, warnings };
}

function parsePublishAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid publishAt value');
    error.code = 'INVALID_PUBLISH_AT';
    error.details = { publishAt: value };
    throw error;
  }
  return date.toISOString();
}

function buildVideoResource(item) {
  const publishAt = parsePublishAt(item.publishAt);
  const privacyStatus = publishAt ? 'private' : (item.privacyStatus || 'private');
  const publicDescription = sanitizePublicUploadDescription(item.description || '');
  return {
    snippet: {
      title: cleanTitle(item.title, 'Untitled process video'),
      description: publicDescription,
      tags: normalizeTags(item.tags),
      categoryId: String(item.categoryId || '28')
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: Boolean(item.madeForKids)
    }
  };
}

function applySchedule(resource, item) {
  const publishAt = parsePublishAt(item.publishAt);
  if (publishAt) {
    resource.status.privacyStatus = 'private';
    resource.status.publishAt = publishAt;
  }
  return resource;
}

async function uploadVideoToYouTube(item, onProgress = () => {}) {
  const filePath = item.finalMp4Path || item.filePath;
  if (!filePath || !fs.existsSync(filePath)) {
    const error = new Error('Upload video file not found');
    error.code = 'UPLOAD_FILE_NOT_FOUND';
    error.details = { filePath };
    throw error;
  }

  // CapCut exports run ~-7 LUFS with clipping-range true peaks; normalize the
  // audio to the platform reference before upload. Fail-open: any error keeps
  // the original file, this must never block an upload.
  onProgress({ message: 'Checking audio loudness before upload' });
  const loudness = await normalizeUploadLoudness(filePath, (message) => onProgress({ message }));
  const uploadFilePath = loudness.path;
  try {

  const size = fs.statSync(uploadFilePath).size;
  const uploadProfileId = resolveUploadProfileId(item.uploadProfileId || item.profileId || '');
  item.uploadProfileId = uploadProfileId;
  const accessToken = await getAccessToken(uploadProfileId);
  const resource = applySchedule(buildVideoResource(item), item);
  onProgress({ message: 'YouTube upload session is being created' });

  const initResponse = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4'
    },
    body: JSON.stringify(resource)
  });

  const initText = await initResponse.text();
  if (!initResponse.ok) {
    const error = new Error(`YouTube upload session failed: ${initResponse.status}`);
    error.code = 'YOUTUBE_UPLOAD_SESSION_FAILED';
    error.status = initResponse.status;
    error.details = tryParseJson(initText) || { raw: initText };
    throw error;
  }

  const uploadUrl = initResponse.headers.get('location');
  if (!uploadUrl) {
    const error = new Error('YouTube did not return a resumable upload URL');
    error.code = 'YOUTUBE_UPLOAD_LOCATION_MISSING';
    throw error;
  }

  onProgress({ message: 'Video file is being uploaded to YouTube', sizeBytes: size });
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Length': String(size),
      'Content-Type': 'video/mp4'
    },
    body: fs.readFileSync(uploadFilePath)
  });

  const uploadText = await uploadResponse.text();
  const uploadData = tryParseJson(uploadText) || { raw: uploadText };
  if (!uploadResponse.ok) {
    const error = new Error(`YouTube video upload failed: ${uploadResponse.status}`);
    error.code = 'YOUTUBE_VIDEO_UPLOAD_FAILED';
    error.status = uploadResponse.status;
    error.details = uploadData;
    throw error;
  }

  return {
    videoId: uploadData.id || '',
    url: uploadData.id ? `https://www.youtube.com/watch?v=${uploadData.id}` : '',
    response: uploadData,
    resource,
    loudness: {
      applied: loudness.applied,
      measured: loudness.measured || null,
      error: loudness.error || null
    }
  };

  } finally {
    loudness.cleanup();
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getYouTubeErrorReason(details = {}) {
  return (
    details?.error?.errors?.[0]?.reason ||
    details?.error?.reason ||
    details?.errors?.[0]?.reason ||
    ''
  );
}

function getYouTubeErrorMessage(details = {}) {
  return (
    details?.error?.message ||
    details?.errors?.[0]?.message ||
    details?.message ||
    ''
  );
}

function isUploadLimitExceeded(error) {
  return getYouTubeErrorReason(error?.details) === 'uploadLimitExceeded';
}

function friendlyUploadError(error) {
  if (error?.code === 'YOUTUBE_OAUTH_RECONNECT_REQUIRED' || error?.code === 'YOUTUBE_ACCESS_TOKEN_FAILED') {
    return {
      code: error.code,
      message: error.message || 'YouTube OAuth reconnect required for this channel profile'
    };
  }

  if (isUploadLimitExceeded(error)) {
    return {
      code: 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED',
      message: 'YouTube upload limit exceeded for this channel. Retry the remaining videos later or use another upload channel.'
    };
  }

  const youtubeMessage = getYouTubeErrorMessage(error?.details);
  if (youtubeMessage) {
    return {
      code: error.code || 'UPLOAD_FAILED',
      message: `${error.message}: ${youtubeMessage}`
    };
  }

  return {
    code: error.code || 'UPLOAD_FAILED',
    message: error.message
  };
}

function markRemainingItemsUploadLimitExceeded(job, failedItem) {
  const message = 'YouTube upload limit exceeded for this channel. This remaining item was not attempted.';
  const blocked = [];

  for (const item of job.items || []) {
    if ((item.order || 0) <= (failedItem.order || 0)) continue;
    if (item.status === 'success' || item.status === 'failed') continue;

    item.status = 'failed';
    item.progress = 100;
    item.error = message;
    item.errorCode = 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED';
    item.errorDetails = failedItem.errorDetails || {};
    blocked.push(item);
  }

  for (const item of blocked) {
    addPendingUpload(job, item, {
      code: 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED',
      message
    });
    appendJobLog(job, `[${item.order}/${job.total}] Upload skipped: ${message}`, item.id);
  }

  if (blocked.length) {
    job.blockedReason = 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED';
    appendJobLog(job, `Stopped remaining uploads because YouTube returned uploadLimitExceeded after item ${failedItem.order}.`);
  }
}

function makeHistoryRecord(job, item, result = {}) {
  return {
    cardId: cardIdFor(item),
    id: item.id,
    jobId: job.jobId,
    order: item.order,
    title: item.title || '',
    description: sanitizePublicUploadDescription(item.description || ''),
    tags: Array.isArray(item.tags) ? item.tags : [],
    privacyStatus: item.privacyStatus || '',
    publishAt: item.publishAt || '',
    filePath: item.finalMp4Path || item.filePath || '',
    originalName: item.originalName || '',
    variant: normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || item.finalMp4Path || item.filePath || '')),
    target_locale: item.target_locale || item.targetLocale || (normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || item.finalMp4Path || item.filePath || '')) === 'ko_highlight' ? 'ko-KR' : 'ja-JP'),
    metadataTextPath: item.metadataTextPath || '',
    metadataOriginalName: item.metadataOriginalName || '',
    review: item.review || null,
    uploadProfileId: resolveUploadProfileId(item.uploadProfileId || item.profileId || ''),
    youtubeVideoId: result.videoId || item.youtubeVideoId || '',
    youtubeUrl: result.url || item.youtubeUrl || '',
    uploadedAt: item.uploadedAt || new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

function makePendingRecord(job, item, reason = {}) {
  return {
    cardId: cardIdFor(item),
    id: item.id,
    jobId: job.jobId,
    order: item.order,
    status: 'pending',
    reasonCode: reason.code || item.errorCode || 'UPLOAD_PENDING',
    reason: reason.message || item.error || '',
    title: item.title || '',
    description: sanitizePublicUploadDescription(item.description || ''),
    tags: Array.isArray(item.tags) ? item.tags : [],
    privacyStatus: item.privacyStatus || '',
    publishAt: item.publishAt || '',
    filePath: item.finalMp4Path || item.filePath || '',
    finalMp4Path: item.finalMp4Path || item.filePath || '',
    originalName: item.originalName || '',
    variant: normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || item.finalMp4Path || item.filePath || '')),
    target_locale: item.target_locale || item.targetLocale || (normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || item.finalMp4Path || item.filePath || '')) === 'ko_highlight' ? 'ko-KR' : 'ja-JP'),
    metadataTextPath: item.metadataTextPath || '',
    metadataOriginalName: item.metadataOriginalName || '',
    review: item.review || null,
    uploadProfileId: resolveUploadProfileId(item.uploadProfileId || item.profileId || ''),
    errorDetails: item.errorDetails || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function addUploadHistory(job, item, result = {}) {
  const history = readListFile(HISTORY_PATH);
  const record = makeHistoryRecord(job, item, result);
  const key = itemDedupeKey(record);
  const next = history.filter((row) => itemDedupeKey(row) !== key && row.youtubeVideoId !== record.youtubeVideoId);
  next.unshift(record);
  writeListFile(HISTORY_PATH, next.slice(0, 1000));
  removePendingUpload(item);
  upsertUploadCard(item, {
    status: 'uploaded',
    jobId: job.jobId,
    order: item.order,
    youtubeVideoId: result.videoId || item.youtubeVideoId || '',
    youtubeUrl: result.url || item.youtubeUrl || '',
    uploadedAt: item.uploadedAt || new Date().toISOString(),
    uploadHistory: [
      {
        jobId: job.jobId,
        youtubeVideoId: result.videoId || item.youtubeVideoId || '',
        youtubeUrl: result.url || item.youtubeUrl || '',
        uploadedAt: item.uploadedAt || new Date().toISOString()
      }
    ]
  });
  return record;
}

function addPendingUpload(job, item, reason = {}) {
  const pending = readListFile(PENDING_PATH);
  const record = makePendingRecord(job, item, reason);
  const key = itemDedupeKey(record);
  const next = pending.filter((row) => itemDedupeKey(row) !== key && row.id !== record.id);
  next.unshift(record);
  writeListFile(PENDING_PATH, next.slice(0, 1000));
  upsertUploadCard(item, {
    status: 'pending',
    jobId: job.jobId,
    order: item.order,
    pendingReasonCode: reason.code || item.errorCode || 'UPLOAD_PENDING',
    pendingReason: reason.message || item.error || ''
  });
  return record;
}

function saveManualPendingUploads(items = []) {
  if (!Array.isArray(items) || !items.length) {
    const error = new Error('No pending upload items selected');
    error.code = 'NO_PENDING_UPLOAD_ITEMS';
    throw error;
  }

  const job = {
    jobId: `manual_pending_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    total: items.length
  };

  const saved = items.map((item, index) => addPendingUpload(job, {
    ...item,
    id: item.id || hashPath(`${item.finalMp4Path || item.filePath || index}-${Date.now()}`),
    order: index + 1,
    finalMp4Path: item.finalMp4Path || item.filePath,
    status: 'pending'
  }, {
    code: 'MANUAL_PENDING',
    message: 'Saved manually for later upload'
  }));

  return {
    savedCount: saved.length,
    pending: readListFile(PENDING_PATH)
  };
}

function saveManualCompletedUploads(items = []) {
  if (!Array.isArray(items) || !items.length) {
    const error = new Error('No completed upload items selected');
    error.code = 'NO_COMPLETED_UPLOAD_ITEMS';
    throw error;
  }

  const job = {
    jobId: `manual_completed_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    total: items.length
  };

  const saved = items.map((item, index) => addUploadHistory(job, {
    ...item,
    id: item.id || hashPath(`${item.finalMp4Path || item.filePath || index}-${Date.now()}`),
    order: index + 1,
    finalMp4Path: item.finalMp4Path || item.filePath,
    status: 'success'
  }, {
    videoId: item.youtubeVideoId || '',
    url: item.youtubeUrl || ''
  }));

  return {
    savedCount: saved.length,
    history: readListFile(HISTORY_PATH),
    cards: readUploadCards()
  };
}

function removePendingUpload(item = {}) {
  const key = itemDedupeKey(item);
  if (!key && !item.id) return;
  const pending = readListFile(PENDING_PATH);
  const next = pending.filter((row) => itemDedupeKey(row) !== key && row.id !== item.id);
  if (next.length !== pending.length) writeListFile(PENDING_PATH, next);
}

function syncUploadHistoryFromJobs() {
  const history = readListFile(HISTORY_PATH);
  const seen = new Set(history.map((row) => `${itemDedupeKey(row)}::${row.youtubeVideoId || ''}`));
  const additions = [];
  for (const job of listUploadJobs()) {
    for (const item of job.items || []) {
      if (item.status !== 'success') continue;
      const record = makeHistoryRecord(job, item, {
        videoId: item.youtubeVideoId || '',
        url: item.youtubeUrl || ''
      });
      const key = `${itemDedupeKey(record)}::${record.youtubeVideoId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(record);
    }
  }
  if (additions.length) writeListFile(HISTORY_PATH, [...additions, ...history].slice(0, 1000));
}

function syncPendingUploadsFromJobs() {
  const pending = readListFile(PENDING_PATH);
  const seen = new Set(pending.map((row) => itemDedupeKey(row) || row.id));
  const additions = [];
  for (const job of listUploadJobs()) {
    for (const item of job.items || []) {
      const limitExceeded = item.errorCode === 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED' || getYouTubeErrorReason(item.errorDetails) === 'uploadLimitExceeded';
      if (item.status !== 'failed' || !limitExceeded) continue;
      const record = makePendingRecord(job, item, {
        code: 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED',
        message: getYouTubeErrorMessage(item.errorDetails) || item.error || 'YouTube upload limit exceeded'
      });
      const key = itemDedupeKey(record) || record.id;
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(record);
    }
  }
  if (additions.length) writeListFile(PENDING_PATH, [...additions, ...pending].slice(0, 1000));
}

function listUploadHistory() {
  syncUploadHistoryFromJobs();
  return { history: readListFile(HISTORY_PATH).filter((row) => !isDeletedCard(row)) };
}

function listPendingUploads() {
  syncPendingUploadsFromJobs();
  return { pending: readListFile(PENDING_PATH).filter((row) => !isDeletedCard(row)) };
}

function pendingToCandidate(item = {}) {
  const filePath = item.finalMp4Path || item.filePath || '';
  const stat = filePath && fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  return {
    id: item.id || hashPath(`${filePath}-${item.title || ''}`),
    source: 'youtube_upload_pending',
    batchId: item.jobId || '',
    itemId: item.id || '',
    originalName: item.originalName || path.basename(filePath),
    filePath,
    finalMp4Path: filePath,
    folderName: item.originalName || path.basename(filePath),
    variant: normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || filePath)),
    title: item.title || path.parse(filePath).name,
    description: sanitizePublicUploadDescription(item.description || ''),
    tags: Array.isArray(item.tags) ? item.tags : [],
    review: item.review || null,
    metadataTextPath: item.metadataTextPath || '',
    metadataOriginalName: item.metadataOriginalName || '',
    previewUrl: toUploadPreviewUrl(filePath),
    privacyStatus: item.privacyStatus || 'private',
    publishAt: '',
    madeForKids: Boolean(item.madeForKids),
    categoryId: item.categoryId || '28',
    sizeBytes: stat?.size || 0,
    modifiedAt: stat?.mtime?.toISOString?.() || item.updatedAt || item.createdAt || '',
    uploadDateKey: uploadDateKeyForItem(item) || dateKeyFromValue(stat?.mtime?.toISOString?.()) || ''
  };
}

function restorePendingUploads(ids = []) {
  syncPendingUploadsFromJobs();
  const pending = readListFile(PENDING_PATH);
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  const selected = wanted.size ? pending.filter((item) => wanted.has(String(item.id))) : pending;
  return {
    candidates: selected.map(pendingToCandidate),
    restoredCount: selected.length,
    pendingCount: pending.length
  };
}

function jobPath(jobId) {
  ensureJobsDir();
  return path.join(JOBS_DIR, `${jobId}.json`);
}

function saveJob(job) {
  ensureJobsDir();
  fs.writeFileSync(jobPath(job.jobId), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  return job;
}

function loadJob(jobId) {
  finalizeStaleUploadJobs();
  const filePath = jobPath(jobId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listUploadJobs() {
  ensureJobsDir();
  finalizeStaleUploadJobs();
  return fs.readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => safeReadJson(path.join(JOBS_DIR, name)))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function isActiveUploadStatus(status) {
  return ['queued', 'running', 'cancelling'].includes(String(status || ''));
}

function uploadJobFingerprint(items = []) {
  const normalized = (items || [])
    .map((item) => ({
      file: itemDedupeKey(item),
      title: String(item.title || '').trim(),
      profile: String(item.uploadProfileId || item.profileId || '').trim(),
      publishAt: String(item.publishAt || '').trim()
    }))
    .sort((a, b) => `${a.file}|${a.title}|${a.profile}|${a.publishAt}`.localeCompare(`${b.file}|${b.title}|${b.profile}|${b.publishAt}`));
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
}

function findReusableUploadJob(fingerprint) {
  if (!fingerprint) return null;
  return listUploadJobs().find((job) => job.fingerprint === fingerprint && isActiveUploadStatus(job.status)) || null;
}

function failUnfinishedJobItems(job, reason) {
  const failedItems = [];
  for (const item of job.items || []) {
    if (item.status === 'success' || item.status === 'failed') continue;
    item.status = 'failed';
    item.progress = 100;
    item.error = reason.message;
    item.errorCode = reason.code;
    item.errorDetails = reason.details || {};
    failedItems.push(item);
  }
  for (const item of failedItems) {
    addPendingUpload(job, item, reason);
    appendJobLog(job, `[${item.order}/${job.total}] Upload moved to pending: ${reason.message}`, item.id);
  }
  job.successCount = (job.items || []).filter((item) => item.status === 'success').length;
  job.failedCount = (job.items || []).filter((item) => item.status === 'failed').length;
  return failedItems;
}

function finalizeStaleUploadJobs() {
  ensureJobsDir();
  const now = Date.now();
  const staleMs = 15 * 60 * 1000;
  for (const name of fs.readdirSync(JOBS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(JOBS_DIR, name);
    const job = safeReadJson(filePath);
    if (!job || !isActiveUploadStatus(job.status)) continue;
    if (activeJobs.has(job.jobId)) continue;
    const updatedAt = new Date(job.updatedAt || job.createdAt || 0).getTime();
    if (!updatedAt || now - updatedAt < staleMs) continue;

    const reason = {
      code: 'UPLOAD_JOB_INTERRUPTED',
      message: 'Upload job was interrupted or stalled. Restore the pending cards and retry them.'
    };
    failUnfinishedJobItems(job, reason);
    job.status = job.successCount > 0 ? 'partial_success' : 'failed';
    job.updatedAt = new Date().toISOString();
    appendJobLog(job, `Upload job marked ${job.status}: ${reason.message}`);
    saveJob(job);
  }
}

function appendJobLog(job, message, itemId = '') {
  job.logs = job.logs || [];
  job.logs.push({ time: new Date().toISOString(), itemId, message });
  if (job.logs.length > 500) job.logs = job.logs.slice(-500);
}

function createUploadJob(items) {
  if (!Array.isArray(items) || !items.length) {
    const error = new Error('No upload items selected');
    error.code = 'NO_UPLOAD_ITEMS';
    throw error;
  }

  finalizeStaleUploadJobs();
  const normalizedItems = items.map((item) => ({
    ...item,
    uploadProfileId: resolveUploadProfileId(item.uploadProfileId || item.profileId || ''),
    variant: normalizeUploadVariant(item.variant || detectUploadVariant(item.originalName || item.finalMp4Path || item.filePath || '')),
    description: sanitizePublicUploadDescription(item.description || '')
  }));
  assertUploadItemsMatchProfiles(normalizedItems);
  const fingerprint = uploadJobFingerprint(normalizedItems);
  const reusableJob = findReusableUploadJob(fingerprint);
  if (reusableJob) {
    appendJobLog(reusableJob, 'Duplicate upload request ignored; existing active job was reused.');
    reusableJob.updatedAt = new Date().toISOString();
    return saveJob(reusableJob);
  }

  const jobId = `yt_upload_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const job = {
    jobId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    total: items.length,
    fingerprint,
    successCount: 0,
    failedCount: 0,
    items: normalizedItems.map((item, index) => ({
      id: item.id || hashPath(`${item.finalMp4Path || item.filePath || index}-${Date.now()}`),
      order: index + 1,
      status: 'queued',
      progress: 0,
      ...item
    })),
    logs: []
  };
  appendJobLog(job, `Upload job created with ${items.length} item(s)`);
  job.items.forEach((item) => upsertUploadCard(item, {
    status: 'queued',
    jobId,
    order: item.order,
    pendingReason: ''
  }));
  return saveJob(job);
}

function startUploadJob(jobId) {
  finalizeStaleUploadJobs();
  const job = loadJob(jobId);
  if (!job) {
    const error = new Error('Upload job not found');
    error.code = 'UPLOAD_JOB_NOT_FOUND';
    throw error;
  }
  if (activeJobs.has(jobId)) return job;
  if (job.status !== 'queued') return job;

  activeJobs.set(jobId, true);
  setImmediate(() => runUploadJob(jobId).catch((error) => {
    const failedJob = loadJob(jobId) || job;
    failedJob.status = 'failed';
    failedJob.error = error.message;
    appendJobLog(failedJob, `Upload job crashed: ${error.message}`);
    failedJob.updatedAt = new Date().toISOString();
    saveJob(failedJob);
    activeJobs.delete(jobId);
  }));
  return job;
}

function requestCancelUploadJob(jobId) {
  cancelRequests.add(jobId);
  const job = loadJob(jobId);
  if (job) {
    job.status = 'cancelling';
    appendJobLog(job, 'Cancel requested');
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  }
  return job;
}

async function runUploadJob(jobId) {
  let job = loadJob(jobId);
  if (!job) return;

  job.status = 'running';
  appendJobLog(job, 'Upload job started');
  job.updatedAt = new Date().toISOString();
  saveJob(job);

  try {
    await preflightUploadJobAuth(job);
  } catch (error) {
    const friendly = friendlyUploadError(error);
    failUnfinishedJobItems(job, {
      ...friendly,
      details: error.details || {}
    });
    job.status = 'failed';
    job.updatedAt = new Date().toISOString();
    appendJobLog(job, `Upload job blocked before start: ${friendly.message}`);
    saveJob(job);
    activeJobs.delete(jobId);
    cancelRequests.delete(jobId);
    return;
  }

  for (const item of job.items) {
    if (cancelRequests.has(jobId)) {
      job.status = 'cancelled';
      appendJobLog(job, 'Upload job cancelled before remaining items');
      break;
    }
    if (item.status === 'success') continue;

    item.status = 'uploading';
    item.progress = 10;
    appendJobLog(job, `[${item.order}/${job.total}] Upload started: ${item.title}`, item.id);
    job.updatedAt = new Date().toISOString();
    saveJob(job);

    try {
      const result = await uploadVideoToYouTube(item, (progress) => {
        const freshJob = loadJob(jobId) || job;
        const freshItem = freshJob.items.find((candidate) => candidate.id === item.id);
        if (freshItem) {
          freshItem.progress = progress.sizeBytes ? 55 : 25;
        }
        appendJobLog(freshJob, progress.message, item.id);
        freshJob.updatedAt = new Date().toISOString();
        saveJob(freshJob);
        job = freshJob;
      });

      const freshItem = job.items.find((candidate) => candidate.id === item.id) || item;
      freshItem.status = 'success';
      freshItem.progress = 100;
      freshItem.youtubeVideoId = result.videoId;
      freshItem.youtubeUrl = result.url;
      freshItem.uploadedAt = new Date().toISOString();
      addUploadHistory(job, freshItem, result);
      job.successCount = job.items.filter((candidate) => candidate.status === 'success').length;
      job.failedCount = job.items.filter((candidate) => candidate.status === 'failed').length;
      appendJobLog(job, `[${item.order}/${job.total}] Upload completed: ${result.url || result.videoId}`, item.id);
    } catch (error) {
      const freshItem = job.items.find((candidate) => candidate.id === item.id) || item;
      const friendly = friendlyUploadError(error);
      freshItem.status = 'failed';
      freshItem.progress = 100;
      freshItem.error = friendly.message;
      freshItem.errorCode = friendly.code;
      freshItem.errorDetails = error.details || {};
      if (friendly.code === 'YOUTUBE_UPLOAD_LIMIT_EXCEEDED') {
        addPendingUpload(job, freshItem, friendly);
      }
      job.failedCount = job.items.filter((candidate) => candidate.status === 'failed').length;
      appendJobLog(job, `[${item.order}/${job.total}] Upload failed: ${friendly.message}`, item.id);

      if (isUploadLimitExceeded(error)) {
        markRemainingItemsUploadLimitExceeded(job, freshItem);
        job.failedCount = job.items.filter((candidate) => candidate.status === 'failed').length;
        break;
      }
    }

    job.updatedAt = new Date().toISOString();
    saveJob(job);
  }

  if (!cancelRequests.has(jobId)) {
    job.status = job.failedCount > 0 ? (job.successCount > 0 ? 'partial_success' : 'failed') : 'completed';
  }
  job.updatedAt = new Date().toISOString();
  appendJobLog(job, `Upload job finished: ${job.status}`);
  saveJob(job);
  activeJobs.delete(jobId);
  cancelRequests.delete(jobId);
}

async function preflightUploadJobAuth(job) {
  const profileIds = [...new Set((job.items || [])
    .filter((item) => item.status !== 'success')
    .map((item) => {
      const profileId = resolveUploadProfileId(item.uploadProfileId || item.profileId || '');
      item.uploadProfileId = profileId;
      return profileId;
    }))];

  for (const profileId of profileIds) {
    await getAccessToken(profileId);
  }
  saveJob(job);
}

module.exports = {
  getAuthorizationUrl,
  exchangeOAuthCode,
  testYouTubeUploadAuth,
  createYouTubeUploadProfile,
  listYouTubeUploadProfiles,
  setActiveYouTubeUploadProfile,
  updateYouTubeUploadProfile,
  deleteYouTubeUploadProfile,
  listDraftUploadCandidates,
  importUploadFiles,
  listUploadHistory,
  listPendingUploads,
  restorePendingUploads,
  saveManualPendingUploads,
  saveManualCompletedUploads,
  listUploadCards,
  restoreUploadCards,
  deleteUploadCard,
  deleteUploadCardsByDate,
  listUploadJobs,
  loadJob,
  createUploadJob,
  startUploadJob,
  requestCancelUploadJob,
  __test: {
    assertUploadItemsMatchProfiles,
    detectUploadVariant,
    extractDraftMatchKey,
    extractDraftStampKey,
    extractVariantMetadataSection,
    findMatchingMetadata,
    normalizeBaseName,
    normalizeUploadTitleKey,
    normalizeUploadVariant,
    parseMetadataText
  }
};
