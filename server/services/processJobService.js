const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT, readJsonIfExists, writeJsonWithBackup } = require('./pipelinePaths');
const {
  QUEUE_ROOT,
  listQueue,
  getQueueItemSourceInfo,
  downloadQueueItemSourceFromUrl,
  applyOttogiGuideToItem,
  generateQueue
} = require('./processQueueService');
const {
  analyzeOttogiProcessMetadata,
  assertOttogiGuideLanguage,
  isVertexAdcMode,
  isYouTubeUrl,
  selectKoreanFullHookType
} = require('./processMetadataService');
const { requireApiKey } = require('../middleware/auth');
const {
  DB_PATH,
  upsertJob,
  getJob: getDbJob,
  listJobs: listDbJobs,
  migrateJsonJobsToDb
} = require('./processJobDbService');

const JOBS_ROOT = path.join(PROJECT_ROOT, 'server', 'data', 'process_jobs');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'server', 'workers', 'processJobWorker.js');
const activeJobs = new Map();
const TERMINAL_JOB_STATUSES = new Set(['success', 'completed_with_warnings', 'partial_success', 'failed', 'cancelled']);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const VALID_JOB_STATUSES = new Set([...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES]);
const DEFAULT_PROCESS_JOB_CHUNK_SIZE = 5;
const APPEND_LOG_ROOT_PATCH_KEYS = new Set([
  'status',
  'stage',
  'totals',
  'result',
  'error',
  'job_summary',
  'finished_at',
  'started_at',
  'metadataAnalysis'
]);

function ensureJobsRoot() {
  fs.mkdirSync(JOBS_ROOT, { recursive: true });
  migrateJsonJobsToDb(JOBS_ROOT);
}

function nowIso() {
  return new Date().toISOString();
}

function safeId(value, fallback = '') {
  const cleaned = String(value || fallback || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  return cleaned || fallback;
}

function createJobId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `job_${stamp}_${Math.random().toString(16).slice(2, 8)}`;
}


function normalizeDraftVariantMode(value = 'all') {
  const mode = String(value || 'all').trim();
  return ['all', 'full_highlight_only', 'full_only', 'highlight_only', 'midform_only'].includes(mode) ? mode : 'all';
}

function isLongformQueueItemConfig(itemConfig = {}) {
  return itemConfig.source_workflow_mode === 'longform_to_shorts'
    || itemConfig.source_type === 'longform';
}

function effectiveVariantModeForItem(mode = 'all', itemConfig = {}) {
  const normalized = normalizeDraftVariantMode(mode);
  if (normalized === 'highlight_only' && isLongformQueueItemConfig(itemConfig)) {
    return 'full_highlight_only';
  }
  return normalized;
}

function variantsForMode(mode = 'all') {
  const normalized = normalizeDraftVariantMode(mode);
  if (normalized === 'full_highlight_only') return ['full', 'highlight'];
  if (normalized === 'full_only') return ['full'];
  if (normalized === 'highlight_only') return ['highlight'];
  if (normalized === 'midform_only') return ['midform'];
  return ['full', 'highlight', 'midform'];
}

function filterVariantStateMapByMode(variantStates = {}, mode = 'all') {
  const wanted = new Set(variantsForMode(mode));
  return Object.fromEntries(
    Object.entries(variantStates || {}).filter(([variant]) => wanted.has(variant))
  );
}

function chunkArray(items = [], size = DEFAULT_PROCESS_JOB_CHUNK_SIZE) {
  const chunkSize = Math.max(1, Number(size) || DEFAULT_PROCESS_JOB_CHUNK_SIZE);
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [[]];
}

function stageSetForJob(stages = []) {
  return new Set(Array.isArray(stages) ? stages : []);
}

function getJobLaneFromStages(stages = []) {
  const stageNames = stageSetForJob(stages);
  if (stageNames.size === 1 && stageNames.has('draft')) return 'draft';
  return 'metadata';
}

function queueItemsById(queue = {}) {
  return new Map((queue.queueItems || []).map((item) => [item.item_id, item]));
}

function splitRequestedIdsByLongform(requestedIds = [], queue = {}) {
  const itemMap = queueItemsById(queue);
  const shortformIds = [];
  const longformIds = [];
  for (const itemId of requestedIds) {
    const item = itemMap.get(itemId);
    if (isLongformQueueItemConfig(item?.item_config || {})) {
      longformIds.push(itemId);
    } else {
      shortformIds.push(itemId);
    }
  }
  return {
    shortformIds,
    longformIds,
    hasMixedTypes: shortformIds.length > 0 && longformIds.length > 0,
    hasLongform: longformIds.length > 0
  };
}

function buildSafeJobChunks({ requestedIds = [], queue = {}, stages = [], enqueueBatches = false, chunkSize = DEFAULT_PROCESS_JOB_CHUNK_SIZE }) {
  const stageNames = stageSetForJob(stages);
  const includesMetadata = stageNames.has('metadata');
  const split = splitRequestedIdsByLongform(requestedIds, queue);
  const shouldSeparateLongform = includesMetadata && split.hasMixedTypes;
  if (!shouldSeparateLongform && enqueueBatches !== true) {
    return {
      chunks: [requestedIds],
      split
    };
  }

  const effectiveChunkSize = enqueueBatches === true
    ? Math.max(1, Number(chunkSize) || DEFAULT_PROCESS_JOB_CHUNK_SIZE)
    : Number.MAX_SAFE_INTEGER;
  const groups = [];
  if (split.shortformIds.length) groups.push(...chunkArray(split.shortformIds, effectiveChunkSize));
  if (split.longformIds.length) groups.push(...chunkArray(split.longformIds, effectiveChunkSize));
  return {
    chunks: groups.length ? groups : [requestedIds],
    split
  };
}

function getJobDir(jobId) {
  return path.join(JOBS_ROOT, safeId(jobId));
}

function getJobPath(jobId) {
  return path.join(getJobDir(jobId), 'job.json');
}

function getWorkerLogPath(jobId) {
  return path.join(getJobDir(jobId), 'worker.log');
}

function getJobEventLogPath(jobId) {
  return path.join(getJobDir(jobId), 'events.jsonl');
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function getJobRuntimeInfo(job = {}) {
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const lastLog = logs.length ? logs[logs.length - 1] : null;
  const lastLogAt = lastLog?.time || job.updated_at || '';
  const lastLogMs = lastLogAt ? Date.parse(lastLogAt) : NaN;
  const lastLogAgeSec = Number.isFinite(lastLogMs)
    ? Math.max(0, Math.round((Date.now() - lastLogMs) / 1000))
    : null;
  const workerAlive = isProcessAlive(job.worker_pid);
  const isActive = ACTIVE_JOB_STATUSES.has(String(job.status || ''));
  const lastLogMessage = String(lastLog?.message || '');
  const longGeminiCallActive = /Gemini .*요청 시작|Gemini .*분석|longform_|metadata/i.test(lastLogMessage);
  const stallThresholdSec = longGeminiCallActive ? 600 : 180;
  const stalled = !!(
    isActive
    && (
      !workerAlive
      || (Number.isFinite(lastLogAgeSec) && lastLogAgeSec > stallThresholdSec)
    )
  );

  return {
    worker_alive: workerAlive,
    last_log_at: lastLogAt,
    last_log_age_sec: lastLogAgeSec,
    last_log_message: lastLog?.message || '',
    stall_threshold_sec: stallThresholdSec,
    stalled,
    heartbeat_status: stalled ? 'stalled' : isActive ? 'active' : 'finished'
  };
}

function isDeferredQueuedJob(job = {}) {
  return job?.status === 'queued' && job.deferred === true;
}

function isRunnableActiveJob(job = {}, lane = '') {
  if (!job || job.cancel_requested) return false;
  if (lane && String(job.lane || getJobLaneFromStages(job.stages || [])) !== lane) return false;
  if (job.status === 'running') return true;
  if (job.status === 'queued' && !isDeferredQueuedJob(job)) return true;
  return false;
}

function findRunnableActiveJob(lane = '') {
  return listJobs().jobs.find((job) => isRunnableActiveJob(job, lane)) || null;
}

function findNextDeferredJob(excludeJobId = '', lane = '') {
  return listJobs().jobs
    .filter((job) => isDeferredQueuedJob(job) && !job.cancel_requested && job.job_id !== excludeJobId)
    .filter((job) => !lane || String(job.lane || getJobLaneFromStages(job.stages || [])) === lane)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0] || null;
}

function sanitizeJobPatch(patch = {}) {
  if (!patch || typeof patch !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!APPEND_LOG_ROOT_PATCH_KEYS.has(key)) continue;
    if (key === 'status') {
      const status = String(value || '');
      if (!VALID_JOB_STATUSES.has(status)) continue;
      clean.status = status;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function normalizeJobStatus(job = null) {
  if (!job || typeof job !== 'object') return job;
  if (VALID_JOB_STATUSES.has(String(job.status || ''))) return job;
  return {
    ...job,
    status: job.finished_at ? 'completed_with_warnings' : 'running'
  };
}

function readJob(jobId) {
  ensureJobsRoot();
  const job = normalizeJobStatus(getDbJob(jobId) || readJsonIfExists(getJobPath(jobId)));
  if (!job) {
    const error = new Error('process job not found');
    error.status = 404;
    throw error;
  }
  if (!getDbJob(jobId)) upsertJob(job);
  return job;
}

function writeJob(job) {
  ensureJobsRoot();
  const jobDir = getJobDir(job.job_id);
  fs.mkdirSync(jobDir, { recursive: true });
  const next = {
    ...job,
    updated_at: nowIso()
  };
  fs.writeFileSync(getJobPath(job.job_id), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  upsertJob(next);
  return next;
}

function patchJob(jobId, patch) {
  const current = readJob(jobId);
  return writeJob({
    ...current,
    ...patch
  });
}

function appendJobLog(jobId, message, level = 'info', itemId = '', patch = {}) {
  const job = readJob(jobId);
  const cleanPatch = sanitizeJobPatch(patch);
  const entry = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    time: nowIso(),
    level,
    item_id: itemId || '',
    message
  };
  try {
    fs.mkdirSync(getJobDir(jobId), { recursive: true });
    fs.appendFileSync(getJobEventLogPath(jobId), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // The DB/job JSON remains the source of truth if the append-only log cannot be written.
  }
  const logs = [...(Array.isArray(job.logs) ? job.logs : []), entry].slice(-500);
  return writeJob({
    ...job,
    ...cleanPatch,
    logs
  });
}

function updateItemStatus(jobId, itemId, patch) {
  const job = readJob(jobId);
  const current = job.item_statuses?.[itemId] || { item_id: itemId };
  return writeJob({
    ...job,
    item_statuses: {
      ...(job.item_statuses || {}),
      [itemId]: {
        ...current,
        ...patch,
        updated_at: nowIso()
      }
    }
  });
}

function spawnJobWorker(jobId, reason = 'start') {
  ensureJobsRoot();
  const current = readJob(jobId);
  if (TERMINAL_JOB_STATUSES.has(current.status)) {
    return current;
  }
  if (isProcessAlive(current.worker_pid)) {
    return current;
  }

  fs.mkdirSync(getJobDir(jobId), { recursive: true });
  const logPath = getWorkerLogPath(jobId);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [WORKER_SCRIPT, jobId], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      PROCESS_JOB_ID: jobId
    },
    windowsHide: true
  });
  child.unref();
  fs.closeSync(out);

  const next = patchJob(jobId, {
    worker_pid: child.pid,
    worker_log_path: logPath,
    worker_started_at: nowIso(),
    worker_spawn_reason: reason
  });
  appendJobLog(jobId, `Background worker started (pid ${child.pid}, reason: ${reason})`, 'info');
  activeJobs.set(jobId, child.pid);
  return next;
}

function getItemsForJob(itemIds = []) {
  const queue = listQueue();
  const itemMap = new Map(queue.queueItems.map((item) => [item.item_id, item]));
  if (Array.isArray(itemIds) && itemIds.length) {
    return itemIds.map((id) => itemMap.get(String(id))).filter(Boolean);
  }
  return queue.queueItems;
}

function hasMetadataReady(itemConfig = {}) {
  return !!(
    itemConfig.ottogi_guide_output
    && (
      Array.isArray(itemConfig.gemini_scene_transitions)
      || Array.isArray(itemConfig.ottogi_guide_output?.scene_transitions)
    )
  );
}

function isInvalidOttogiMetadataError(error = {}) {
  const code = error.code || error.errorCode || '';
  const message = String(error.message || '');
  return code === 'OTTOGI_METADATA_LANGUAGE_VALIDATION_FAILED'
    || message.includes('Stored Gemini metadata contains invalid Japanese/Korean captions');
}

function isInvalidOttogiMetadataRow(row = {}) {
  const code = row.error_code || row.code || '';
  const message = String(row.error || row.message || '');
  return code === 'OTTOGI_METADATA_LANGUAGE_VALIDATION_FAILED'
    || message.includes('Stored Gemini metadata contains invalid Japanese/Korean captions');
}

function hasReusableMetadataReady(itemConfig = {}) {
  if (!hasMetadataReady(itemConfig)) return false;
  try {
    assertOttogiGuideLanguage(itemConfig.ottogi_guide_output, {
      includeFull: true,
      includeHighlight: true,
      includeScenes: true,
      strictHighlightMetadata: true,
      includeJapanese: true,
      includeKorean: false
    });
    return true;
  } catch (error) {
    if (isInvalidOttogiMetadataError(error)) return false;
    throw error;
  }
}

function getGeminiApiKeyForCurrentMode() {
  if (isVertexAdcMode()) return '';
  return requireApiKey('GEMINI_API_KEY');
}

function getAnalysisSourceInfo(itemId, itemConfig = {}) {
  try {
    return getQueueItemSourceInfo(itemId);
  } catch (error) {
    const sourceUrl = String(itemConfig.source_url || '').trim();
    if (isYouTubeUrl(sourceUrl)) {
      return {
        item_id: itemId,
        sourcePath: '',
        filename: sourceUrl
      };
    }
    throw error;
  }
}

function resolveAnalysisDurationSec(itemConfig = {}, refreshedItem = {}) {
  const candidates = [
    itemConfig.source_classification?.duration_sec,
    refreshedItem.source_classification?.duration_sec,
    itemConfig.video_metadata?.source_duration_sec,
    itemConfig.video_metadata?.original_duration_sec,
    itemConfig.video_metadata?.duration_sec,
    refreshedItem.video_metadata?.source_duration_sec,
    refreshedItem.video_metadata?.original_duration_sec,
    refreshedItem.video_metadata?.duration_sec,
    itemConfig.target_duration_sec
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function metadataFailureStatus(error = {}) {
  const code = error.code || error.errorCode || '';
  if (isMetadataValidationFailureCode(code)) return 'failed_validation';
  if (code === 'OTTOGI_METADATA_JSON_PARSE_ERROR') return 'failed_parse';
  return 'failed';
}

function isMetadataValidationFailureCode(code = '') {
  const value = String(code || '');
  return value === 'OTTOGI_LONGFORM_VALIDATION_FAILED'
    || value === 'OTTOGI_METADATA_VALIDATION_FAILED'
    || value === 'OTTOGI_METADATA_SCHEMA_VALIDATION_FAILED'
    || value === 'OTTOGI_METADATA_LANGUAGE_VALIDATION_FAILED'
    || value === 'OTTOGI_LONGFORM_TIME_BASIS_INVALID'
    || value === 'OTTOGI_LONGFORM_WINDOW_INVALID'
    || value === 'OTTOGI_LONGFORM_WINDOW_OUT_OF_RANGE'
    || value === 'OTTOGI_LONGFORM_CANDIDATE_VALIDATION_FAILED'
    || value === 'OTTOGI_LONGFORM_STORY_EQUALS_HOOK';
}

function summarizeMetadataFailure(error = {}) {
  const code = error.code || error.errorCode || '';
  const details = error.details || error.data || {};
  const missing = Array.isArray(details?.missing) ? details.missing : [];
  const issues = Array.isArray(details?.issues) ? details.issues : [];
  const statusCode = Number(error.status || error.statusCode || details.statusCode || 0);

  if (code === 'OTTOGI_METADATA_JSON_PARSE_ERROR') {
    return {
      category: 'json_parse',
      title: 'Gemini 응답 JSON 파싱 실패',
      user_message: 'Gemini가 JSON이 아닌 문장/마크다운/깨진 JSON을 반환했습니다.',
      recommended_action: '재분석 후 드래프트 생성',
      retry_stage: 'metadata_then_draft',
      can_regenerate_draft_only: false,
      detail_lines: [
        '원인: JSON 형식 오류',
        '선택: Gemini 재분석부터 다시 실행'
      ]
    };
  }

  if (isMetadataValidationFailureCode(code)) {
    return {
      category: 'validation',
      title: 'Gemini 결과 검증 실패',
      user_message: 'JSON은 받았지만 필수 구간, 자막, 언어, 길이 조건 중 일부가 규칙을 통과하지 못했습니다.',
      recommended_action: '재분석 후 드래프트 생성',
      retry_stage: 'metadata_then_draft',
      can_regenerate_draft_only: false,
      detail_lines: [
        missing.length ? `누락 필드: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` 외 ${missing.length - 8}개` : ''}` : '',
        issues.length ? `검증 이슈: ${issues.slice(0, 3).map((issue) => issue.reason || issue.field || 'issue').join(' / ')}${issues.length > 3 ? ` 외 ${issues.length - 3}개` : ''}` : '',
        error.message ? `오류: ${error.message}` : '',
        code ? `오류 코드: ${code}` : '',
        '선택: Gemini 재분석부터 다시 실행'
      ].filter(Boolean)
    };
  }

  if (missing.length) {
    return {
      category: 'missing_fields',
      title: 'Gemini 필수 필드 누락',
      user_message: 'Gemini가 필요한 항목을 일부 빼고 응답했습니다.',
      recommended_action: '재분석 후 드래프트 생성',
      retry_stage: 'metadata_then_draft',
      can_regenerate_draft_only: false,
      detail_lines: [
        `누락 필드: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` 외 ${missing.length - 10}개` : ''}`,
        '선택: Gemini 재분석부터 다시 실행'
      ]
    };
  }

  if ([429, 500, 502, 503, 504].includes(statusCode)) {
    return {
      category: 'temporary_api_error',
      title: 'Gemini 일시 오류',
      user_message: `${statusCode} 응답 또는 일시적인 API 오류입니다.`,
      recommended_action: '잠시 후 재분석 후 드래프트 생성',
      retry_stage: 'metadata_then_draft',
      can_regenerate_draft_only: false,
      detail_lines: [
        `상태 코드: ${statusCode}`,
        '선택: 잠시 후 Gemini 재분석부터 다시 실행'
      ]
    };
  }

  return {
    category: 'metadata_unknown',
    title: 'Gemini 분석 실패',
    user_message: error.message || 'Gemini metadata analysis failed',
    recommended_action: '재분석 후 드래프트 생성',
    retry_stage: 'metadata_then_draft',
    can_regenerate_draft_only: false,
    detail_lines: [
      code ? `오류 코드: ${code}` : '',
      '선택: Gemini 재분석부터 다시 실행'
    ].filter(Boolean)
  };
}

function isFailedStageStatus(value) {
  return String(value || '').startsWith('failed');
}

function isMetadataFailureItem(item = {}) {
  return isFailedStageStatus(item.metadata_status) || isFailedStageStatus(item.analysis_status);
}

function isMidformPartialFailureItem(item = {}) {
  return item.midform_status === 'failed'
    || item.metadata_status === 'partial_success'
    || item.status === 'partial_success';
}

function isDraftSuccess(item = {}) {
  return item.draft_status === 'success';
}

function isHardFailureItem(item = {}) {
  return (
    item.source_download_status === 'failed'
    || item.draft_status === 'failed'
    || (item.status === 'failed' && !isDraftSuccess(item))
  );
}

function isWarningItem(item = {}) {
  return (
    (isMetadataFailureItem(item) && isDraftSuccess(item))
    || isMidformPartialFailureItem(item)
    || (item.highlight_status === 'failed' && isDraftSuccess(item))
  );
}

function summarizeJobOutcome(job = {}, totals = {}) {
  const itemStatuses = Object.values(job.item_statuses || {});
  const hardFailures = itemStatuses.filter(isHardFailureItem);
  const warningItems = itemStatuses.filter(isWarningItem);
  const metadataFailures = itemStatuses.filter(isMetadataFailureItem);
  const draftSuccesses = itemStatuses.filter(isDraftSuccess);
  const anySuccess = draftSuccesses.length > 0
    || Number(totals.download?.success || 0) > 0
    || Number(totals.metadata?.success || 0) > 0
    || Number(totals.draft?.success || 0) > 0;
  let status = 'success';

  if (hardFailures.length > 0) {
    status = anySuccess ? 'completed_with_warnings' : 'failed';
  } else if (metadataFailures.length > 0) {
    const draftStageRan = Array.isArray(job.stages) && job.stages.includes('draft');
    status = draftStageRan && draftSuccesses.length > 0
      ? 'completed_with_warnings'
      : anySuccess
        ? 'completed_with_warnings'
        : 'failed';
  } else if (warningItems.length > 0) {
    status = 'completed_with_warnings';
  }

  const blockingFailures = status === 'failed' && hardFailures.length === 0
    ? metadataFailures
    : hardFailures;
  const warningMap = new Map();
  if (status !== 'failed') {
    [...warningItems, ...metadataFailures].forEach((item) => {
      if (item?.item_id) warningMap.set(item.item_id, item);
    });
  } else {
    warningItems.forEach((item) => {
      if (item?.item_id) warningMap.set(item.item_id, item);
    });
  }
  blockingFailures.forEach((item) => {
    if (item?.item_id) warningMap.delete(item.item_id);
  });
  const warningList = Array.from(warningMap.values());

  return {
    status,
    draft_success_count: draftSuccesses.length,
    hard_failed_count: blockingFailures.length,
    warning_count: warningList.length,
    metadata_failed_count: metadataFailures.length,
    hard_failed_item_ids: blockingFailures.map((item) => item.item_id).filter(Boolean),
    warning_item_ids: warningList.map((item) => item.item_id).filter(Boolean),
    metadata_failed_item_ids: metadataFailures.map((item) => item.item_id).filter(Boolean)
  };
}

function recordMetadataAnalysisFailure(itemId, itemConfig = {}, error = {}) {
  const configPath = path.join(QUEUE_ROOT, safeId(itemId), 'item_config.json');
  const current = readJsonIfExists(configPath) || itemConfig || {};
  const details = error.details || error.data || null;
  const status = metadataFailureStatus(error);
  const summary = summarizeMetadataFailure(error);
  const failure = {
    status,
    stage: 'gemini_metadata',
    code: error.code || error.errorCode || '',
    statusCode: error.status || error.statusCode || null,
    message: error.message || 'Gemini metadata analysis failed',
    user_message: summary.user_message,
    title: summary.title,
    category: summary.category,
    recommended_action: summary.recommended_action,
    retry_stage: summary.retry_stage,
    can_regenerate_draft_only: summary.can_regenerate_draft_only,
    detail_lines: summary.detail_lines,
    details,
    raw_response_path: details?.raw_response_path || '',
    cleaned_response_path: details?.cleaned_response_path || '',
    missing: Array.isArray(details?.missing) ? details.missing : [],
    failed_at: nowIso()
  };

  const next = {
    ...current,
    analysis_status: status,
    metadata_status: status,
    metadata_stale: true,
    metadata_failure: failure,
    metadata_failure_history: [
      ...(Array.isArray(current.metadata_failure_history) ? current.metadata_failure_history.slice(-9) : []),
      failure
    ]
  };

  writeJsonWithBackup(configPath, next);
  return { configPath, status, failure };
}

const METADATA_DRAFT_READY_STATUSES = new Set(['analyzed', 'skipped']);

function isMetadataEntryReadyForDraft(entry = {}, draftVariantMode = 'all') {
  const status = String(entry.status || '');
  if (METADATA_DRAFT_READY_STATUSES.has(status)) return true;
  if (status !== 'partial_success') return false;
  const failedVariants = Array.isArray(entry.failed_variants) ? entry.failed_variants : [];
  const requestedVariants = variantsForMode(draftVariantMode);
  if (requestedVariants.length === 1) return !failedVariants.includes(requestedVariants[0]);
  // In multi-variant mode, send the item to draft generation if at least one
  // requested variant is usable. The generator skips failed variants per-format.
  return requestedVariants.some((variant) => !failedVariants.includes(variant));
}

function getMetadataReadyItemIds(metadataResult = {}, draftVariantMode = 'all') {
  return new Set(
    (metadataResult.metadataAnalysis || [])
      .filter((entry) => isMetadataEntryReadyForDraft(entry, draftVariantMode))
      .map((entry) => entry.item_id)
      .filter(Boolean)
  );
}

function shouldFallbackToAvailableVariantDraftMode(mode = 'all') {
  const normalized = normalizeDraftVariantMode(mode);
  return normalized === 'all';
}

function selectDraftItemsAfterMetadata(jobId, items = [], metadataResult = {}, options = {}) {
  const readyItemIds = getMetadataReadyItemIds(metadataResult, options.draft_variant_mode || 'all');
  const draftItems = [];
  const blockedItems = [];

  for (const item of items) {
    if (readyItemIds.has(item.item_id)) {
      draftItems.push(item);
    } else {
      blockedItems.push(item);
    }
  }

  if (blockedItems.length && options.silent_blocked !== true) {
    for (const item of blockedItems) {
      const itemIndex = items.findIndex((candidate) => candidate.item_id === item.item_id);
      const label = itemIndex >= 0 ? `${itemIndex + 1}/${items.length}` : item.item_id;
      updateItemStatus(jobId, item.item_id, {
        stage: 'metadata',
        draft_status: 'blocked_metadata_failed',
        can_regenerate_draft_only: false,
        failure_retry_stage: 'metadata_then_draft',
        failure_recommended_action: '재분석 후 드래프트 생성'
      });
      appendJobLog(
        jobId,
        `${label} Gemini 분석 실패로 드래프트 생성을 건너뜁니다. 재분석 후 드래프트 생성을 실행하세요.`,
        'warning',
        item.item_id,
        {
          stage: 'draft',
          blocked_by: 'metadata_failed',
          continued_from_metadata: options.continued_from_metadata === true
        }
      );
    }
    appendJobLog(
      jobId,
      `Gemini 분석 실패로 드래프트 생성 제외: ${blockedItems.length}개`,
      'warning',
      '',
      {
        stage: 'draft',
        blocked_item_ids: blockedItems.map((item) => item.item_id),
        continued_from_metadata: options.continued_from_metadata === true
      }
    );
  }

  return draftItems;
}

function shouldCancel(jobId) {
  const job = readJob(jobId);
  return job.cancel_requested === true;
}

function assertNotCancelled(jobId) {
  if (!shouldCancel(jobId)) return;
  const error = new Error('process job was cancelled');
  error.code = 'JOB_CANCELLED';
  throw error;
}

async function runDownloadStage(jobId, items) {
  appendJobLog(jobId, `1\uB2E8\uACC4: \uB204\uB77D\uB41C \uC18C\uC2A4 \uC601\uC0C1\uC744 \uB2E4\uC6B4\uB85C\uB4DC\uD569\uB2C8\uB2E4. \uB300\uC0C1 ${items.length}\uAC1C`, 'info', '', {
    stage: 'download',
    status: 'running'
  });

  let success = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    assertNotCancelled(jobId);
    const item = items[index];
    const itemConfig = item.item_config || {};
    const label = String(index + 1) + '/' + String(items.length);
    updateItemStatus(jobId, item.item_id, {
      stage: 'download',
      source_download_status: 'running',
      download_progress: 0,
      download_speed: '',
      download_eta: '',
      download_method: '',
      download_error_type: ''
    });

    try {
      const source = getQueueItemSourceInfo(item.item_id);
      if (source.sourcePath && fs.existsSync(source.sourcePath)) {
        success += 1;
        updateItemStatus(jobId, item.item_id, {
          stage: 'download',
          source_download_status: 'skipped',
          source_path: source.sourcePath,
          download_progress: 100
        });
        appendJobLog(jobId, `${label} \uC774\uBBF8 \uC18C\uC2A4 \uC601\uC0C1\uC774 \uC788\uC5B4 \uAC74\uB108\uB701\uB2C8\uB2E4.`, 'info', item.item_id);
        continue;
      }
    } catch {
      // Missing source is expected for URL-imported items.
    }

    const sourceUrl = String(itemConfig.source_url || '').trim();
    if (!sourceUrl) {
      failed += 1;
      updateItemStatus(jobId, item.item_id, {
        stage: 'download',
        source_download_status: 'failed',
        error: 'source_url is empty',
        download_error_type: 'missing_source_url'
      });
      appendJobLog(jobId, `${label} \uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328: source_url\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.`, 'error', item.item_id);
      continue;
    }

    appendJobLog(jobId, `${label} \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791`, 'warning', item.item_id);
    try {
      let lastLoggedBucket = -1;
      let lastLoggedAt = 0;
      const downloaded = await downloadQueueItemSourceFromUrl(item.item_id, sourceUrl, {
        onProgress: (progress = {}) => {
          const percent = Number(progress.percent);
          const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
          const bucket = Math.floor(safePercent / 10);
          updateItemStatus(jobId, item.item_id, {
            stage: 'download',
            source_download_status: 'running',
            download_progress: Number(safePercent.toFixed(1)),
            download_speed: progress.speed || '',
            download_eta: progress.eta || '',
            download_size: progress.size || '',
            download_method: progress.method || '',
            download_phase: progress.phase || 'downloading'
          });

          const now = Date.now();
          const shouldLog = bucket > lastLoggedBucket || safePercent >= 100 || now - lastLoggedAt > 30000;
          if (shouldLog) {
            lastLoggedBucket = bucket;
            lastLoggedAt = now;
            const detail = [
              safePercent.toFixed(1) + '%',
              progress.speed ? `\uC18D\uB3C4 ${progress.speed}` : '',
              progress.eta ? `\uB0A8\uC740 \uC2DC\uAC04 ${progress.eta}` : '',
              progress.method ? `\uBC29\uC2DD ${progress.method}` : ''
            ].filter(Boolean).join(' | ');
            appendJobLog(jobId, `${label} \uB2E4\uC6B4\uB85C\uB4DC \uC9C4\uD589: ${detail}`, 'warning', item.item_id);
          }
        }
      });
      success += 1;
      updateItemStatus(jobId, item.item_id, {
        stage: 'download',
        source_download_status: 'success',
        source_path: downloaded.download?.outputPath || '',
        source_filename: downloaded.download?.filename || '',
        download_progress: 100,
        download_method: downloaded.download?.method || ''
      });
      appendJobLog(jobId, `${label} \uB2E4\uC6B4\uB85C\uB4DC \uC644\uB8CC: ${downloaded.download?.filename || 'source_clean.mp4'}`, 'success', item.item_id);
    } catch (error) {
      failed += 1;
      const errorType = error.details?.errorType || error.code || 'unknown';
      updateItemStatus(jobId, item.item_id, {
        stage: 'download',
        source_download_status: 'failed',
        error: error.message,
        download_error_type: errorType,
        download_attempts: error.details?.attempts || []
      });
      appendJobLog(jobId, `${label} \uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328: ${error.message} (${errorType})`, 'error', item.item_id);
    }
  }

  appendJobLog(jobId, `\uC18C\uC2A4 \uB2E4\uC6B4\uB85C\uB4DC \uC885\uB8CC: \uC131\uACF5/\uAC74\uB108\uB700 ${success}\uAC1C, \uC2E4\uD328 ${failed}\uAC1C`, failed ? 'warning' : 'success');
  return { success, failed };
}

async function runMetadataStage(jobId, items, options = {}) {
  const force = options.force === true;
  const metadataVariantMode = normalizeDraftVariantMode(options.metadata_variant_mode || 'all');
  appendJobLog(jobId, `2\uB2E8\uACC4: Gemini \uBD84\uC11D\uC744 \uC2E4\uD589\uD569\uB2C8\uB2E4. \uB300\uC0C1 ${items.length}\uAC1C`, 'info', '', {
    stage: 'metadata',
    status: 'running'
  });

  const apiKey = getGeminiApiKeyForCurrentMode();
  let success = 0;
  let failed = 0;
  const metadataAnalysis = [];

  for (let index = 0; index < items.length; index += 1) {
    assertNotCancelled(jobId);
    const refreshed = getItemsForJob([items[index].item_id])[0] || items[index];
    const itemConfig = refreshed.item_config || {};
    const label = String(index + 1) + '/' + String(items.length);
    updateItemStatus(jobId, refreshed.item_id, { stage: 'metadata', metadata_status: 'running' });

    if (!force && hasReusableMetadataReady(itemConfig)) {
      success += 1;
      metadataAnalysis.push({
        item_id: refreshed.item_id,
        status: 'skipped',
        reason: 'metadata_already_exists',
        failed_variants: Array.isArray(itemConfig.ottogi_guide_output?.failed_variants) ? itemConfig.ottogi_guide_output.failed_variants : []
      });
      updateItemStatus(jobId, refreshed.item_id, { stage: 'metadata', metadata_status: 'skipped' });
      appendJobLog(jobId, `${label} \uAE30\uC874 Gemini \uBD84\uC11D \uACB0\uACFC\uB97C \uC7AC\uC0AC\uC6A9\uD569\uB2C8\uB2E4.`, 'info', refreshed.item_id);
      continue;
    }

    if (!force && hasMetadataReady(itemConfig)) {
      appendJobLog(jobId, `${label} \uAE30\uC874 Gemini \uBD84\uC11D \uACB0\uACFC\uAC00 \uD604\uC7AC \uC790\uB9C9 \uAC80\uC99D \uADDC\uCE59\uC744 \uD1B5\uACFC\uD558\uC9C0 \uBABB\uD574 \uC7AC\uBD84\uC11D\uD569\uB2C8\uB2E4.`, 'warning', refreshed.item_id);
    }

    appendJobLog(jobId, `${label}${force ? ' Gemini \uAC15\uC81C \uC7AC\uBD84\uC11D \uC2DC\uC791' : ' Gemini \uBD84\uC11D \uC2DC\uC791'}`, 'warning', refreshed.item_id);
    try {
      const sourceUrl = String(itemConfig.source_url || '').trim();
      const sourceInfo = getAnalysisSourceInfo(refreshed.item_id, itemConfig);
      const durationSec = resolveAnalysisDurationSec(itemConfig, refreshed);
      const sourceType = itemConfig.source_type || 'unknown';
      const sourceWorkflowMode = itemConfig.source_workflow_mode || 'unknown';
      const itemMetadataVariantMode = effectiveVariantModeForItem(metadataVariantMode, itemConfig);
      const sourceReason = itemConfig.source_classification?.reason || '';
      const assignedHookType = selectKoreanFullHookType({
        seed: `${jobId}:${refreshed.item_id}`,
        jobId,
        itemId: refreshed.item_id,
        sourceUrl,
        filename: sourceInfo.filename,
        sourceType,
        sourceWorkflowMode,
        detectedSubject: itemConfig.ottogi_guide_output?.detected_subject || itemConfig.upload_title || '',
        sourceText: JSON.stringify({
          title: itemConfig.upload_title || '',
          description: itemConfig.upload_description || '',
          classification: itemConfig.source_classification || null,
          previous_subject: itemConfig.ottogi_guide_output?.detected_subject || ''
        })
      });
      appendJobLog(
        jobId,
        `${label} \uC18C\uC2A4 \uBD84\uB958: ${sourceType} / ${sourceWorkflowMode}${sourceReason ? ` (${sourceReason})` : ''}`,
        'info',
        refreshed.item_id,
        {
          source_type: sourceType,
          source_workflow_mode: sourceWorkflowMode,
          duration_sec: durationSec,
          source_classification: itemConfig.source_classification || null
        }
      );
      const guide = await analyzeOttogiProcessMetadata({
        filePath: sourceInfo.sourcePath,
        sourceUrl,
        apiKey,
        durationSec,
        originalFilename: sourceInfo.filename,
        sourceType,
        sourceWorkflowMode,
        metadataVariantMode: itemMetadataVariantMode,
        existingGuide: force ? null : (itemConfig.ottogi_guide_output || null),
        assignedHookType,
        fullDraftStagesDir: path.join(QUEUE_ROOT, refreshed.item_id, 'full_draft_stages'),
        throwIfCancelled: () => assertNotCancelled(jobId),
        onProgress: (message, data = {}) => {
          appendJobLog(jobId, label + ' ' + message, 'info', refreshed.item_id, data);
        }
      });
      const applied = applyOttogiGuideToItem(refreshed.item_id, guide, sourceUrl);
      const title = applied.item_config?.upload_title || '';
      const guideOutput = applied.item_config?.ottogi_guide_output || {};
      const variantStates = {
        full: {
          status: guideOutput.full_generation_status === 'failed' ? 'failed' : 'ready',
          error: guideOutput.full_generation_error || '',
          details: guideOutput.full_generation_details || null
        },
        highlight: {
          status: guideOutput.highlight_generation_status === 'failed' ? 'failed' : 'ready',
          error: guideOutput.highlight_generation_error || '',
          details: guideOutput.highlight_generation_details || null
        },
        midform: {
          status: guideOutput.midform_generation_status === 'failed' ? 'failed' : 'ready',
          error: guideOutput.midform_generation_error || '',
          details: guideOutput.midform_generation_details || null
        }
      };
      const scopedVariantStates = filterVariantStateMapByMode(variantStates, itemMetadataVariantMode);
      const failedVariants = Object.entries(scopedVariantStates)
        .filter(([, state]) => state.status === 'failed')
        .map(([variant]) => variant);
      const partialFailure = failedVariants.length > 0;
      const jobVariantState = (variant) => scopedVariantStates[variant] || {
        status: 'not_requested',
        error: '',
        details: null
      };
      success += 1;
      metadataAnalysis.push({
        item_id: refreshed.item_id,
        status: partialFailure ? 'partial_success' : 'analyzed',
        savedPath: applied.savedPath,
        packagePath: applied.item_config?.ottogi_metadata_files?.package || '',
        title,
        caption: applied.item_config?.explainer_blocks?.[0]?.text || '',
        variant_statuses: scopedVariantStates,
        all_variant_statuses: variantStates,
        failed_variants: failedVariants,
        full_status: jobVariantState('full').status,
        full_error: jobVariantState('full').error,
        highlight_status: jobVariantState('highlight').status,
        highlight_error: jobVariantState('highlight').error,
        midform_status: jobVariantState('midform').status,
        midform_error: jobVariantState('midform').error
      });
      updateItemStatus(jobId, refreshed.item_id, {
        stage: 'metadata',
        metadata_status: partialFailure ? 'partial_success' : 'success',
        upload_title: title,
        variant_statuses: scopedVariantStates,
        all_variant_statuses: variantStates,
        failed_variants: failedVariants,
        full_status: jobVariantState('full').status,
        full_error: jobVariantState('full').error,
        highlight_status: jobVariantState('highlight').status,
        highlight_error: jobVariantState('highlight').error,
        midform_status: jobVariantState('midform').status,
        midform_error: jobVariantState('midform').error
      });
      appendJobLog(jobId, `${label} Gemini 분석 완료: ${title || '-'}`, 'success', refreshed.item_id);
      failedVariants.forEach((variant) => {
        const state = variantStates[variant] || {};
        appendJobLog(jobId, `${label} ${variant} 포맷 실패: ${state.error || '검증 실패'} / 성공한 포맷은 보존합니다.`, 'warning', refreshed.item_id, {
          variant,
          details: state.details || null
        });
      });
    } catch (error) {
      if (error.code === 'JOB_CANCELLED') {
        throw error;
      }
      failed += 1;
      const failureRecord = recordMetadataAnalysisFailure(refreshed.item_id, itemConfig, error);
      metadataAnalysis.push({
        item_id: refreshed.item_id,
        status: failureRecord.status,
        stage: 'gemini_metadata',
        code: error.code || error.errorCode || '',
        statusCode: error.status || error.statusCode || null,
        message: error.message,
        details: error.details || error.data || null,
        savedPath: failureRecord.configPath
      });
      updateItemStatus(jobId, refreshed.item_id, {
        stage: 'metadata',
        metadata_status: failureRecord.status,
        analysis_status: failureRecord.status,
        error: error.message,
        failure_title: failureRecord.failure.title,
        failure_category: failureRecord.failure.category,
        failure_user_message: failureRecord.failure.user_message,
        failure_recommended_action: failureRecord.failure.recommended_action,
        failure_retry_stage: failureRecord.failure.retry_stage,
        failure_detail_lines: failureRecord.failure.detail_lines,
        can_regenerate_draft_only: failureRecord.failure.can_regenerate_draft_only,
        raw_response_path: failureRecord.failure.raw_response_path,
        cleaned_response_path: failureRecord.failure.cleaned_response_path
      });
      appendJobLog(jobId, `${label} Gemini 분석 실패: ${failureRecord.failure.title} / 권장: ${failureRecord.failure.recommended_action}`, 'error', refreshed.item_id, {
        analysis_status: failureRecord.status,
        failure_category: failureRecord.failure.category,
        recommended_action: failureRecord.failure.recommended_action,
        detail_lines: failureRecord.failure.detail_lines,
        raw_response_path: failureRecord.failure.raw_response_path,
        cleaned_response_path: failureRecord.failure.cleaned_response_path,
        missing: failureRecord.failure.missing
      });
    }
  }

  appendJobLog(jobId, `Gemini \uBD84\uC11D \uC885\uB8CC: \uC131\uACF5/\uC7AC\uC0AC\uC6A9 ${success}\uAC1C, \uC2E4\uD328 ${failed}\uAC1C`, failed ? 'warning' : 'success', '', {
    metadataAnalysis
  });
  return { success, failed, metadataAnalysis };
}

async function runDraftStage(jobId, items, options = {}) {
  appendJobLog(jobId, '3\uB2E8\uACC4: CapCut \uB4DC\uB798\uD504\uD2B8\uB97C \uC0DD\uC131\uD569\uB2C8\uB2E4. \uB300\uC0C1 ' + items.length + '\uAC1C', 'info', '', {
    stage: 'draft',
    status: 'running'
  });

  let success = 0;
  let failed = 0;
  const batchReports = [];
  const aggregateItems = [];
  let lastResponse = null;
  const baseBatchName = String(options.batch_name || 'process_batch_001');

  for (let index = 0; index < items.length; index += 1) {
    assertNotCancelled(jobId);
    const item = getItemsForJob([items[index].item_id])[0] || items[index];
    const label = `${index + 1}/${items.length}`;
    updateItemStatus(jobId, item.item_id, { stage: 'draft', draft_status: 'running' });
    appendJobLog(jobId, `${label} \uB4DC\uB798\uD504\uD2B8 \uC0DD\uC131 \uC2DC\uC791`, 'warning', item.item_id);
    let heartbeat = null;

    try {
      const startedAt = Date.now();
      heartbeat = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        appendJobLog(jobId, `${label} \uB4DC\uB798\uD504\uD2B8 \uC0DD\uC131 \uC9C4\uD589 \uC911... ${seconds}\uCD08 \uACBD\uACFC`, 'warning', item.item_id);
      }, 30000);

      let result = await generateQueue({
        batch_name: `${baseBatchName}_${item.item_id}`,
        item_ids: [item.item_id],
        stop_on_error: false,
        draft_variant_mode: options.draft_variant_mode || 'all'
      });
      let row = (result.report?.items || [])[0] || { item_id: item.item_id, status: 'unknown' };
      if (row.status !== 'success' && isInvalidOttogiMetadataRow(row)) {
        appendJobLog(jobId, `${label} \uC800\uC7A5\uB41C Gemini \uBD84\uC11D\uC774 \uD604\uC7AC \uC790\uB9C9 \uAC80\uC99D \uADDC\uCE59\uC5D0 \uB9DE\uC9C0 \uC54A\uC544 \uAC15\uC81C \uC7AC\uBD84\uC11D \uD6C4 \uB4DC\uB798\uD504\uD2B8\uB97C \uB2E4\uC2DC \uC2DC\uB3C4\uD569\uB2C8\uB2E4.`, 'warning', item.item_id);
        const metadataRetry = await runMetadataStage(jobId, [item], {
          force: true,
          metadata_variant_mode: options.draft_variant_mode || 'all'
        });
        if (Number(metadataRetry.failed || 0) > 0) {
          row.metadata_retry_failed = true;
          row.metadata_retry_result = metadataRetry;
        } else {
          result = await generateQueue({
            batch_name: `${baseBatchName}_${item.item_id}_retry`,
            item_ids: [item.item_id],
            stop_on_error: false,
            draft_variant_mode: options.draft_variant_mode || 'all'
          });
          row = (result.report?.items || [])[0] || { item_id: item.item_id, status: 'unknown' };
          row.metadata_reanalyzed_after_invalid = true;
        }
      }
      clearInterval(heartbeat);
      heartbeat = null;

      lastResponse = result;
      batchReports.push({
        item_id: item.item_id,
        batchId: result.batchId,
        reportPath: result.reportPath,
        notesPath: result.notesPath
      });

      aggregateItems.push(row);
      if (row.status === 'success') {
        success += 1;
        updateItemStatus(jobId, item.item_id, {
          stage: 'draft',
          draft_status: 'success',
          output_folder: row.output_folder || '',
          output_mode: row.output_mode || '',
          skip_full_draft: row.skip_full_draft === true,
          skip_full_draft_reason: row.skip_full_draft_reason || '',
          full_status: row.full_status || (row.output_folder ? 'success' : (row.skip_full_draft ? 'skipped' : 'failed')),
          full_error: row.full_error || '',
          highlight_status: row.highlight_status || 'disabled',
          highlight_output_folder: row.highlight_output_folder || '',
          highlight_error: row.highlight_error || '',
          midform_status: row.midform_status || 'disabled',
          midform_output_folder: row.midform_output_folder || '',
          midform_error: row.midform_error || row.midform_skip_reason || ''
        });
        if (row.output_folder) {
          appendJobLog(jobId, `${label} Full 드래프트 생성 완료: ${row.output_folder}`, 'success', item.item_id);
        } else if (row.full_status === 'failed' || row.full_error) {
          appendJobLog(jobId, `${label} Full 드래프트 생성 실패: ${row.full_error || 'Full Gemini 분석 실패 또는 생성 결과 없음'} / 성공한 다른 포맷은 보존합니다.`, 'warning', item.item_id);
        } else {
          appendJobLog(jobId, `${label} Full 드래프트 생성 건너뜀: ${row.skip_full_draft_reason || row.output_mode || 'Full 분석 결과 없음'}`, 'warning', item.item_id);
        }
        if (row.highlight_status === 'success') {
          appendJobLog(jobId, `${label} Highlight 드래프트 생성 완료: ${row.highlight_output_folder || '-'}`, 'success', item.item_id);
        } else if (row.highlight_status === 'failed') {
          appendJobLog(jobId, `${label} Highlight 드래프트 생성 실패: ${row.highlight_error || 'unknown error'}`, 'warning', item.item_id);
        }
        if (row.midform_status === 'success') {
          appendJobLog(jobId, `${label} Midform 드래프트 생성 완료: ${row.midform_output_folder || '-'}`, 'success', item.item_id);
        } else if (row.midform_status === 'failed') {
          appendJobLog(jobId, `${label} Midform 드래프트 생성 실패: ${row.midform_error || 'unknown error'} / Full·Highlight 결과는 보존합니다.`, 'warning', item.item_id);
        } else if (row.midform_status === 'skipped') {
          appendJobLog(jobId, `${label} Midform 드래프트 생성 건너뜀: ${row.midform_skip_reason || 'Midform 분석 결과 없음'}`, 'warning', item.item_id);
        }
      } else {
        failed += 1;
        updateItemStatus(jobId, item.item_id, {
          stage: 'draft',
          draft_status: 'failed',
          output_folder: row.output_folder || '',
          error: row.error || 'unknown error',
          failure_title: '드래프트 생성 실패',
          failure_category: 'draft_generation',
          failure_user_message: row.error || 'CapCut 드래프트 생성 단계에서 실패했습니다.',
          failure_recommended_action: '드래프트만 재생성',
          failure_retry_stage: 'draft_only',
          failure_detail_lines: [
            'Gemini 분석 결과가 이미 있다면 재분석 없이 드래프트 단계만 다시 실행할 수 있습니다.',
            '템플릿, BGM, 로고, 캡컷 드래프트 폴더 설정을 확인하세요.'
          ],
          can_regenerate_draft_only: true
        });
        appendJobLog(jobId, `${label} 드래프트 생성 실패: ${row.error || 'unknown error'} / 권장: 드래프트만 재생성`, 'error', item.item_id);
      }
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      failed += 1;
      aggregateItems.push({ item_id: item.item_id, status: 'failed', error: error.message });
      updateItemStatus(jobId, item.item_id, {
        stage: 'draft',
        draft_status: 'failed',
        error: error.message,
        failure_title: '드래프트 생성 실패',
        failure_category: 'draft_generation_exception',
        failure_user_message: error.message || 'CapCut 드래프트 생성 중 예외가 발생했습니다.',
        failure_recommended_action: '드래프트만 재생성',
        failure_retry_stage: 'draft_only',
        failure_detail_lines: [
          'Gemini 분석 결과가 이미 있다면 재분석 없이 드래프트 단계만 다시 실행할 수 있습니다.',
          '반복 실패하면 템플릿, BGM, 로고, 캡컷 드래프트 폴더 설정을 확인하세요.'
        ],
        can_regenerate_draft_only: true
      });
      appendJobLog(jobId, `${label} 드래프트 생성 실패: ${error.message} / 권장: 드래프트만 재생성`, 'error', item.item_id);
    }
  }

  const aggregateResult = {
    batchId: `${baseBatchName}_server_job_${jobId}`,
    batchReports,
    reportPath: lastResponse?.reportPath || '',
    notesPath: lastResponse?.notesPath || '',
    capcutDraftRoot: lastResponse?.capcutDraftRoot || lastResponse?.report?.capcut_draft_root || '',
    report: {
      batch_id: `${baseBatchName}_server_job_${jobId}`,
      total_items: aggregateItems.length,
      success_count: success,
      failed_count: failed,
      capcut_draft_root: lastResponse?.report?.capcut_draft_root || '',
      output_root: lastResponse?.report?.output_root || '',
      items: aggregateItems
    }
  };

  appendJobLog(jobId, `\uB4DC\uB798\uD504\uD2B8 \uC0DD\uC131 \uC885\uB8CC: \uC131\uACF5 ${success}\uAC1C, \uC2E4\uD328 ${failed}\uAC1C`, failed ? 'warning' : 'success', '', {
    result: aggregateResult
  });
  return { success, failed, result: aggregateResult };
}

async function runJob(jobId) {
  try {
    let job = patchJob(jobId, {
      status: 'running',
      started_at: nowIso(),
      stage: 'starting',
      error: ''
    });
    appendJobLog(jobId, `\uC11C\uBC84 \uC791\uC5C5 \uC2DC\uC791: ${job.item_ids.length}\uAC1C \uD56D\uBAA9`, 'info');

    const items = getItemsForJob(job.item_ids);
    if (!items.length) {
      throw new Error('no queue items selected');
    }

    const totals = {
      download: { success: 0, failed: 0 },
      metadata: { success: 0, failed: 0 },
      draft: { success: 0, failed: 0 }
    };

    if (job.stages.includes('download')) {
      totals.download = await runDownloadStage(jobId, items);
    }
    if (job.stages.includes('metadata')) {
      totals.metadata = await runMetadataStage(jobId, items, {
        force: job.force_metadata === true,
        metadata_variant_mode: job.metadata_variant_mode || 'all'
      });
      if (job.continue_to_draft_after_metadata === true && !job.stages.includes('draft')) {
        const requestedDraftVariantMode = job.draft_variant_mode || job.metadata_variant_mode || 'all';
        let effectiveDraftVariantMode = requestedDraftVariantMode;
        const canFallbackToAvailableVariants = shouldFallbackToAvailableVariantDraftMode(requestedDraftVariantMode);
        let draftItems = selectDraftItemsAfterMetadata(jobId, items, totals.metadata, {
          continued_from_metadata: true,
          draft_variant_mode: effectiveDraftVariantMode,
          silent_blocked: canFallbackToAvailableVariants
        });
        if (!draftItems.length && canFallbackToAvailableVariants) {
          const availableDraftItems = selectDraftItemsAfterMetadata(jobId, items, totals.metadata, {
            continued_from_metadata: true,
            draft_variant_mode: 'all'
          });
          if (availableDraftItems.length) {
            effectiveDraftVariantMode = 'all';
            draftItems = availableDraftItems;
            appendJobLog(
              jobId,
              `요청 포맷(${requestedDraftVariantMode})은 실패했지만, 성공한 다른 포맷 ${draftItems.length}개 항목을 드래프트 생성으로 이어갑니다.`,
              'warning',
              '',
              {
                stage: 'draft',
                continued_from_metadata: true,
                requested_draft_variant_mode: requestedDraftVariantMode,
                effective_draft_variant_mode: effectiveDraftVariantMode,
                item_ids: draftItems.map((item) => item.item_id)
              }
            );
          }
        }
        if (draftItems.length) {
          appendJobLog(
            jobId,
            `Gemini 재분석 성공 ${draftItems.length}개 항목을 이어서 드래프트 생성합니다.`,
            'info',
            '',
            {
              stage: 'draft',
              continued_from_metadata: true,
              item_ids: draftItems.map((item) => item.item_id)
            }
          );
          totals.draft = await runDraftStage(jobId, draftItems, {
            batch_name: job.batch_name,
            draft_variant_mode: effectiveDraftVariantMode
          });
        } else {
          appendJobLog(
            jobId,
            'Gemini 재분석 성공 항목이 없어 드래프트 생성을 건너뜁니다.',
            'warning',
            '',
            {
              stage: 'draft',
              continued_from_metadata: true
            }
          );
        }
      }
    }
    if (job.stages.includes('draft')) {
      const draftItems = job.stages.includes('metadata')
        ? selectDraftItemsAfterMetadata(jobId, items, totals.metadata, {
          continued_from_metadata: false,
          draft_variant_mode: job.draft_variant_mode || 'all'
        })
        : items;
      if (draftItems.length) {
        totals.draft = await runDraftStage(jobId, draftItems, {
          batch_name: job.batch_name,
          draft_variant_mode: job.draft_variant_mode || 'all'
        });
      } else {
        totals.draft = {
          success: 0,
          failed: 0,
          skipped_due_to_metadata_failed: true
        };
        appendJobLog(
          jobId,
          'Gemini 분석을 통과한 항목이 없어 드래프트 생성을 실행하지 않았습니다.',
          'warning',
          '',
          { stage: 'draft', blocked_by: 'metadata_failed' }
        );
      }
    }

    const latestJob = readJob(jobId);
    const summary = summarizeJobOutcome(latestJob, totals);
    patchJob(jobId, {
      status: summary.status,
      stage: 'finished',
      finished_at: nowIso(),
      totals,
      job_summary: summary,
      queue: listQueue()
    });
    appendJobLog(
      jobId,
      `서버 작업 종료: 드래프트 성공 ${summary.draft_success_count}개, 경고 ${summary.warning_count}개, 실패 ${summary.hard_failed_count}개`,
      summary.status === 'success' ? 'success' : summary.status === 'failed' ? 'error' : 'warning',
      '',
      { job_summary: summary }
    );
  } catch (error) {
    const status = error.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed';
    patchJob(jobId, {
      status,
      stage: status,
      finished_at: nowIso(),
      error: error.message,
      queue: listQueue()
    });
    appendJobLog(jobId, status === 'cancelled' ? '\uC11C\uBC84 \uC791\uC5C5\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.' : '\uC11C\uBC84 \uC791\uC5C5 \uC2E4\uD328: ' + error.message, status === 'cancelled' ? 'warning' : 'error');
  } finally {
    const latest = readJob(jobId);
    const lane = String(latest.lane || getJobLaneFromStages(latest.stages || []));
    activeJobs.delete(jobId);
    startNextDeferredProcessJob(jobId, lane);
  }
}

function createProcessJobRecord({
  requestedIds,
  selectedStages,
  batchName,
  forceMetadata,
  normalizedDraftVariantMode,
  normalizedMetadataVariantMode,
  continueToDraftAfterMetadata,
  lane,
  deferred = false,
  queuedPosition = 0,
  batchGroup = null,
  queueReason = ''
}) {
  const queue = listQueue();
  const jobId = createJobId();
  const job = writeJob({
    job_id: jobId,
    status: 'queued',
    stage: 'queued',
    created_at: nowIso(),
    updated_at: nowIso(),
    started_at: '',
    finished_at: '',
    item_ids: requestedIds,
    stages: selectedStages,
    batch_name: safeId(batchName || queue.queueConfig?.batch_name || 'process_batch_001'),
    force_metadata: forceMetadata === true,
    draft_variant_mode: normalizedDraftVariantMode,
    metadata_variant_mode: normalizedMetadataVariantMode,
    continue_to_draft_after_metadata: continueToDraftAfterMetadata === true,
    lane: lane || getJobLaneFromStages(selectedStages),
    deferred: deferred === true,
    queued_position: Number(queuedPosition || 0),
    batch_group: batchGroup && typeof batchGroup === 'object' ? batchGroup : null,
    queue_reason: queueReason || '',
    cancel_requested: false,
    logs: [],
    item_statuses: {},
    result: null,
    totals: null,
    error: '',
    queue
  });
  if (deferred) {
    appendJobLog(
      jobId,
      `대기 작업으로 등록됨: ${requestedIds.length}개 항목 / 순번 ${queuedPosition}${queueReason ? ` / ${queueReason}` : ''}`,
      'info'
    );
  }
  return readJob(jobId);
}

function startNextDeferredProcessJob(previousJobId = '', lane = '') {
  const active = findRunnableActiveJob(lane);
  if (active) return null;
  const next = findNextDeferredJob(previousJobId, lane);
  if (!next) return null;
  patchJob(next.job_id, {
    deferred: false,
    queued_position: 0
  });
  appendJobLog(next.job_id, `이전 ${lane === 'draft' ? '드래프트 생성' : 'Gemini 분석'} 작업이 끝나 자동으로 대기 작업을 시작합니다.`, 'info');
  return spawnJobWorker(next.job_id, 'deferred_queue_auto_start');
}

function startProcessJob({
  item_ids,
  stages,
  batch_name,
  force_metadata = false,
  draft_variant_mode = 'all',
  metadata_variant_mode = '',
  continue_to_draft_after_metadata = false,
  enqueue_if_active = false,
  enqueue_batches = false,
  chunk_size = DEFAULT_PROCESS_JOB_CHUNK_SIZE
} = {}) {
  ensureJobsRoot();
  const validStages = ['download', 'metadata', 'draft'];
  const selectedStages = Array.isArray(stages) && stages.length
    ? stages.filter((stage) => validStages.includes(stage))
    : validStages;
  const lane = getJobLaneFromStages(selectedStages);
  const active = findRunnableActiveJob(lane);
  const normalizedDraftVariantMode = normalizeDraftVariantMode(draft_variant_mode);
  const normalizedMetadataVariantMode = normalizeDraftVariantMode(metadata_variant_mode || draft_variant_mode || 'all');
  const queue = listQueue();
  const requestedIds = Array.isArray(item_ids) && item_ids.length
    ? item_ids.map((id) => safeId(id)).filter(Boolean)
    : queue.queueItems.map((item) => item.item_id);
  const stageNames = stageSetForJob(selectedStages);
  const safeChunkPlan = buildSafeJobChunks({
    requestedIds,
    queue,
    stages: selectedStages,
    enqueueBatches: enqueue_batches === true,
    chunkSize: chunk_size
  });
  const chunks = safeChunkPlan.chunks;
  const containsLongformMetadata = stageNames.has('metadata') && safeChunkPlan.split.hasLongform;
  const shouldForceQueueBehindActive = active && containsLongformMetadata;
  const shouldQueueIfActive = enqueue_if_active === true || shouldForceQueueBehindActive;
  const batchGroupId = chunks.length > 1 ? createJobId().replace(/^job_/, 'group_') : '';
  const makeBatchGroup = (ids, index) => {
    if (chunks.length <= 1) return null;
    const chunkStartIndex = chunks
      .slice(0, index)
      .reduce((sum, chunk) => sum + chunk.length, 0) + 1;
    const chunkEndIndex = chunkStartIndex + ids.length - 1;
    return {
      group_id: batchGroupId,
      chunk_index: index + 1,
      chunk_total: chunks.length,
      chunk_start_index: chunkStartIndex,
      chunk_end_index: chunkEndIndex,
      total_item_count: requestedIds.length,
      chunk_item_count: ids.length
    };
  };

  if (active) {
    if (shouldQueueIfActive) {
      const queuedJobs = chunks.map((ids, index) => createProcessJobRecord({
        requestedIds: ids,
        selectedStages,
        batchName: batch_name,
        forceMetadata: force_metadata,
        normalizedDraftVariantMode,
        normalizedMetadataVariantMode,
        continueToDraftAfterMetadata: continue_to_draft_after_metadata,
        lane,
        deferred: true,
        queuedPosition: index + 1,
        batchGroup: makeBatchGroup(ids, index),
        queueReason: shouldForceQueueBehindActive
          ? '활성 Gemini 분석 작업 뒤에 안전하게 대기합니다.'
          : lane === 'draft'
            ? '드래프트 생성 라인 대기열에 등록되었습니다.'
            : 'Gemini 분석 라인 대기열에 등록되었습니다.'
      }));
      return {
        reused: false,
        queued: true,
        activeJob: active,
        job: queuedJobs[0],
        queuedJobs
      };
    }
    const ensured = spawnJobWorker(active.job_id, 'reuse_active');
    return {
      reused: true,
      job: ensured
    };
  }

  const queuedJobs = chunks.map((ids, index) => createProcessJobRecord({
    requestedIds: ids,
    selectedStages,
    batchName: batch_name,
    forceMetadata: force_metadata,
    normalizedDraftVariantMode,
    normalizedMetadataVariantMode,
    continueToDraftAfterMetadata: continue_to_draft_after_metadata,
    lane,
    deferred: index > 0,
    queuedPosition: index,
    batchGroup: makeBatchGroup(ids, index),
    queueReason: index > 0
      ? lane === 'draft'
        ? '앞선 드래프트 생성 묶음이 끝나면 자동 시작됩니다.'
        : '앞선 Gemini 분석 묶음이 끝나면 자동 시작됩니다.'
      : ''
  }));
  const spawned = spawnJobWorker(queuedJobs[0].job_id, 'start');
  return {
    reused: false,
    queued: queuedJobs.length > 1,
    job: spawned,
    queuedJobs
  };
}

function listJobs() {
  ensureJobsRoot();
  const dbJobs = listDbJobs();
  const jobs = dbJobs.length
    ? dbJobs
    : fs.readdirSync(JOBS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJsonIfExists(path.join(JOBS_ROOT, entry.name, 'job.json')))
      .filter(Boolean)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return {
    jobsRoot: JOBS_ROOT,
    jobsDbPath: DB_PATH,
    jobs
  };
}

function recoverProcessJobsOnStartup() {
  ensureJobsRoot();
  const recovered = [];
  const skipped = [];
  const jobs = listJobs().jobs
    .filter((job) => job && ['queued', 'running'].includes(job.status))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const recoveredActiveLanes = new Set();
  for (const job of jobs) {
    if (!job || !['queued', 'running'].includes(job.status)) continue;
    const lane = String(job.lane || getJobLaneFromStages(job.stages || []));
    if (job.cancel_requested) {
      skipped.push({ job_id: job.job_id, reason: 'cancel_requested' });
      continue;
    }
    if (isProcessAlive(job.worker_pid)) {
      skipped.push({ job_id: job.job_id, reason: `worker_alive_${job.worker_pid}` });
      recoveredActiveLanes.add(lane);
      continue;
    }
    if (recoveredActiveLanes.has(lane)) {
      patchJob(job.job_id, {
        deferred: true
      });
      skipped.push({ job_id: job.job_id, reason: `deferred_waiting_for_active_${lane}_job` });
      continue;
    }
    patchJob(job.job_id, {
      deferred: false,
      queued_position: 0
    });
    const next = spawnJobWorker(job.job_id, 'server_start_recovery');
    recovered.push({ job_id: job.job_id, worker_pid: next.worker_pid });
    recoveredActiveLanes.add(lane);
  }
  return {
    recovered,
    skipped
  };
}

function cancelJob(jobId) {
  const current = readJob(jobId);
  const runtime = getJobRuntimeInfo(current);
  const workerPid = Number(current.worker_pid || 0);
  const shouldForceStop = runtime.stalled === true && workerPid > 0;
  const lane = String(current.lane || getJobLaneFromStages(current.stages || []));

  if (shouldForceStop) {
    let killMessage = '';
    try {
      process.kill(workerPid);
      killMessage = `멈춘 작업자 프로세스를 종료했습니다. pid=${workerPid}`;
    } catch (error) {
      killMessage = `멈춘 작업자 프로세스 종료 시도 실패: ${error.message}`;
    }
    activeJobs.delete(jobId);
    const cancelled = patchJob(jobId, {
      status: 'cancelled',
      stage: 'cancelled',
      cancel_requested: true,
      finished_at: nowIso(),
      error: 'stalled job was force-cancelled',
      worker_pid: null
    });
    appendJobLog(jobId, `${killMessage} 다음 대기 작업을 시작합니다.`, 'warning');
    startNextDeferredProcessJob(jobId, lane);
    return cancelled;
  }

  const job = patchJob(jobId, {
    cancel_requested: true
  });
  appendJobLog(jobId, '취소 요청을 받았습니다. 현재 항목 처리 후 중단합니다.', 'warning');
  return job;
}

function retryFailedJob(jobId, options = {}) {
  const job = readJob(jobId);
  const requestedStages = Array.isArray(options.stages) && options.stages.length
    ? options.stages.filter((stage) => ['download', 'metadata', 'draft'].includes(stage))
    : job.stages;
  const forceMetadata = options.force_metadata === true;
  const failedIds = Object.values(job.item_statuses || {})
    .filter((item) => {
      if (requestedStages.includes('download') && item.source_download_status === 'failed') return true;
      if (requestedStages.includes('metadata') && (isMetadataFailureItem(item) || isMidformPartialFailureItem(item))) return true;
      if (requestedStages.includes('draft') && (item.draft_status === 'failed' || isMidformPartialFailureItem(item))) return true;
      return isHardFailureItem(item);
    })
    .map((item) => item.item_id);
  return startProcessJob({
    item_ids: failedIds.length ? failedIds : job.item_ids,
    stages: requestedStages,
    batch_name: job.batch_name,
    force_metadata: forceMetadata,
    draft_variant_mode: normalizeDraftVariantMode(options.draft_variant_mode || job.draft_variant_mode || 'all'),
    metadata_variant_mode: normalizeDraftVariantMode(options.metadata_variant_mode || job.metadata_variant_mode || options.draft_variant_mode || job.draft_variant_mode || 'all'),
    continue_to_draft_after_metadata: options.continue_to_draft_after_metadata === true
  });
}

module.exports = {
  JOBS_ROOT,
  startProcessJob,
  runJob,
  recoverProcessJobsOnStartup,
  readJob,
  listJobs,
  getJobRuntimeInfo,
  cancelJob,
  retryFailedJob
};
