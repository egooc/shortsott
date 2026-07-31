import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { usePipelineStore } from '../store/pipelineStore';

const emptyBlock = (index) => ({
  block_id: `exp_${String(index + 1).padStart(3, '0')}`,
  text: '',
  start_sec: index * 5,
  end_sec: index * 5 + 5,
  style_role: 'main_explainer',
  anchor_zone: 'lower_third',
  animation: 'slide_up'
});

const STATUS_LABELS = {
  idle: '\uB300\uAE30',
  processing: '\uC0DD\uC131 \uC911',
  saving: '\uC800\uC7A5 \uC911',
  saved: '\uC800\uC7A5 \uC644\uB8CC',
  done: '\uC644\uB8CC',
  failed: '\uC2E4\uD328',
  adding: '\uD56D\uBAA9 \uCD94\uAC00 \uC911',
  uploading: '\uC5C5\uB85C\uB4DC \uC911',
  uploaded: '\uC5C5\uB85C\uB4DC \uC644\uB8CC',
  uploading_bgm: 'BGM \uC5C5\uB85C\uB4DC \uC911',
  bgm_uploaded: 'BGM \uC5C5\uB85C\uB4DC \uC644\uB8CC',
  downloading_youtube: 'YouTube \uB2E4\uC6B4\uB85C\uB4DC \uC911',
  youtube_downloaded: 'YouTube \uB2E4\uC6B4\uB85C\uB4DC \uC644\uB8CC',
  analyzing_gemini: 'Gemini \uBD84\uC11D \uC911',
  metadata_applied: 'Gemini \uC790\uB3D9\uC785\uB825 \uC644\uB8CC',
  duplicating: '\uBCF5\uC81C \uC911',
  removing: '\uC0AD\uC81C \uC911',
  'validating-output': '\uD3F4\uB354 \uD655\uC778 \uC911',
  pending: '\uB300\uAE30',
  success: '\uC131\uACF5',
  queued: '\uB300\uAE30 \uC911',
  running: '\uC9C4\uD589 \uC911',
  partial_success: '\uC77C\uBD80 \uC131\uACF5',
  completed_with_warnings: '\uACBD\uACE0\uC640 \uD568\uAED8 \uC644\uB8CC',
  metadata_partial_failed: '\uBD84\uC11D \uC77C\uBD80 \uC2E4\uD328',
  draft_success: '\uB4DC\uB798\uD504\uD2B8 \uC131\uACF5',
  failed_validation: '\uAC80\uC99D \uC2E4\uD328',
  failed_parse: 'JSON \uD30C\uC2F1 \uC2E4\uD328',
  cancelled: '\uCDE8\uC18C\uB428',
  server_job_running: '\uC11C\uBC84 \uC791\uC5C5 \uC9C4\uD589 \uC911'
};

const TERMINAL_SERVER_JOB_STATUSES = new Set(['success', 'completed_with_warnings', 'partial_success', 'failed', 'cancelled']);

function isActiveServerJob(job = {}) {
  if (!job?.job_id) return false;
  if (TERMINAL_SERVER_JOB_STATUSES.has(String(job.status || ''))) return false;
  if (job.finished_at) return false;
  return ['queued', 'running'].includes(String(job.status || ''))
    || job.worker_alive === true
    || !!job.worker_pid
    || ['download', 'metadata', 'draft'].includes(String(job.stage || ''));
}

function isFailedStageStatus(value) {
  return String(value || '').startsWith('failed');
}

function isMetadataFailureItem(item = {}) {
  return isFailedStageStatus(item.metadata_status) || isFailedStageStatus(item.analysis_status);
}

const PROCESS_VARIANT_MODES = {
  full: 'full_only',
  highlight: 'highlight_only',
  midform: 'midform_only'
};
const STANDARD_BATCH_VARIANT_MODE = 'full_highlight_only';
const LOCALE_6_6_BATCH_MODE = 'locale_6_6';
const LOCALE_OPTIONS = [
  { value: 'ja-JP', label: '일본어', shortLabel: 'JP' },
  { value: 'ko-KR', label: '한국어', shortLabel: 'KO' }
];

function normalizeTargetLocale(value) {
  return value === 'ko-KR' ? 'ko-KR' : 'ja-JP';
}

function extractYouTubeId(value = '') {
  const text = String(value || '').trim();
  const direct = text.match(/^[a-zA-Z0-9_-]{11}$/);
  if (direct) return direct[0];
  const match = text.match(/(?:v=|shorts\/|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : '';
}

function canonicalSourceKey(value = '') {
  const id = extractYouTubeId(value);
  return id ? `youtube:${id}` : String(value || '').trim().toLowerCase();
}

function isVariantAnalysisFailed(item = {}, variant = '') {
  const failedVariants = Array.isArray(item.failed_variants) ? item.failed_variants : [];
  return item[`${variant}_status`] === 'failed' || failedVariants.includes(variant);
}

function getFailedAnalysisVariants(item = {}) {
  return ['full', 'highlight', 'midform'].filter((variant) => isVariantAnalysisFailed(item, variant));
}

function isMidformPartialFailureItem(item = {}) {
  return getFailedAnalysisVariants(item).length > 0
    || item.metadata_status === 'partial_success'
    || item.status === 'partial_success';
}

function isDraftSuccessItem(item = {}) {
  return item.draft_status === 'success';
}

function isHardFailedServerItem(item = {}) {
  return (
    item.source_download_status === 'failed'
    || item.draft_status === 'failed'
    || (item.status === 'failed' && !isDraftSuccessItem(item))
  );
}

function isWarningServerItem(item = {}) {
  return (
    (isMetadataFailureItem(item) && isDraftSuccessItem(item))
    || isMidformPartialFailureItem(item)
    || (item.highlight_status === 'failed' && isDraftSuccessItem(item))
  );
}

function getServerItemDisplayStatus(item = {}) {
  if (isHardFailedServerItem(item)) return 'failed';
  if (isWarningServerItem(item)) return 'metadata_partial_failed';
  if (isDraftSuccessItem(item)) return 'draft_success';
  return item.metadata_status || item.source_download_status || item.status || 'unknown';
}

function getFailureDecision(item = {}) {
  if (isMidformPartialFailureItem(item) && !isMetadataFailureItem(item)) {
    const failedVariants = getFailedAnalysisVariants(item);
    const detailLines = failedVariants.map((variant) => `${variant}: ${item[`${variant}_error`] || '원고/메타데이터 검증 실패'}`);
    return {
      title: '포맷 일부 분석 실패',
      message: failedVariants.length
        ? `${failedVariants.join(', ')} 포맷만 실패했습니다. 성공한 포맷은 보존됩니다.`
        : '성공한 포맷은 보존하고 실패한 포맷만 다시 실행할 수 있습니다.',
      action: '실패한 포맷만 재시도',
      tone: 'amber',
      details: detailLines,
      rawPath: item.raw_response_path || '',
      cleanedPath: item.cleaned_response_path || ''
    };
  }
  if (isMetadataFailureItem(item)) {
    return {
      title: item.failure_title || '\u0047\u0065\u006d\u0069\u006e\u0069 \ubd84\uc11d \uc2e4\ud328',
      message: item.failure_user_message || item.error || '\u0047\u0065\u006d\u0069\u006e\u0069 \ubd84\uc11d \uacb0\uacfc\uac00 \ud604\uc7ac \uac80\uc99d \uaddc\uce59\uc744 \ud1b5\uacfc\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4.',
      action: item.failure_recommended_action || '\uc7ac\ubd84\uc11d \ud6c4 \ub4dc\ub798\ud504\ud2b8 \uc0dd\uc131',
      tone: 'amber',
      details: Array.isArray(item.failure_detail_lines) ? item.failure_detail_lines.filter(Boolean) : [],
      rawPath: item.raw_response_path || '',
      cleanedPath: item.cleaned_response_path || ''
    };
  }
  if (item.draft_status === 'failed') {
    return {
      title: '\ub4dc\ub798\ud504\ud2b8 \uc0dd\uc131 \uc2e4\ud328',
      message: item.error || item.highlight_error || '\u0047\u0065\u006d\u0069\u006e\u0069 \ubd84\uc11d\uc740 \uc788\uc9c0\ub9cc \u0043\u0061\u0070\u0043\u0075\u0074 \ub4dc\ub798\ud504\ud2b8 \uc0dd\uc131 \ub2e8\uacc4\uc5d0\uc11c \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.',
      action: '\ub4dc\ub798\ud504\ud2b8\ub9cc \uc7ac\uc0dd\uc131',
      tone: 'red',
      details: [
        '\u0047\u0065\u006d\u0069\u006e\u0069 \uacb0\uacfc\uac00 \uc815\uc0c1\uc774\uba74 \uc7ac\ubd84\uc11d \uc5c6\uc774 \ub4dc\ub798\ud504\ud2b8 \ub2e8\uacc4\ub9cc \ub2e4\uc2dc \uc2e4\ud589\ud569\ub2c8\ub2e4.',
        '\uc0d8\ud50c \ub4dc\ub798\ud504\ud2b8, \u0042\u0047\u004d, \ub85c\uace0, \ucea1\ucef7 \ub4dc\ub798\ud504\ud2b8 \ud3f4\ub354 \uc124\uc815\uc744 \ud655\uc778\ud558\uc138\uc694.'
      ],
      rawPath: '',
      cleanedPath: ''
    };
  }
  if (item.source_download_status === 'failed') {
    return {
      title: '\uc18c\uc2a4 \ub2e4\uc6b4\ub85c\ub4dc \uc2e4\ud328',
      message: item.error || '\u0059\u006f\u0075\u0054\u0075\u0062\u0065 \u0055\u0052\u004c \ub610\ub294 \uc6d0\ubcf8 \uc18c\uc2a4 \ub2e4\uc6b4\ub85c\ub4dc\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.',
      action: '\uc2e4\ud328 \ud56d\ubaa9\ub9cc \uc7ac\uc2dc\ub3c4',
      tone: 'red',
      details: [
        '\uc18c\uc2a4 \uc601\uc0c1\uc774 \uc5c6\uc73c\uba74 \u0047\u0065\u006d\u0069\u006e\u0069 \ubd84\uc11d\uacfc \ub4dc\ub798\ud504\ud2b8 \uc0dd\uc131\uc73c\ub85c \ub118\uc5b4\uac08 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.',
        '\u0055\u0052\u004c \uc811\uadfc \uac00\ub2a5 \uc5ec\ubd80\ub97c \ud655\uc778\ud558\uac70\ub098 \uc18c\uc2a4 \uc601\uc0c1\uc744 \uc218\ub3d9\uc73c\ub85c \uad50\uccb4\ud558\uc138\uc694.'
      ],
      rawPath: '',
      cleanedPath: ''
    };
  }
  if (item.highlight_status === 'failed') {
    return {
      title: '\ud558\uc774\ub77c\uc774\ud2b8 \uc0dd\uc131 \uc2e4\ud328',
      message: item.highlight_error || item.error || '\u0046\u0075\u006c\u006c \ub4dc\ub798\ud504\ud2b8\ub294 \uc0dd\uc131\ub410\uc9c0\ub9cc \ud558\uc774\ub77c\uc774\ud2b8 \uc0dd\uc131 \uc77c\ubd80\uac00 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.',
      action: '\ub4dc\ub798\ud504\ud2b8\ub9cc \uc7ac\uc0dd\uc131',
      tone: 'amber',
      details: ['\u0047\u0065\u006d\u0069\u006e\u0069 \ubd84\uc11d\uc774 \uc815\uc0c1\uc774\uba74 \ub4dc\ub798\ud504\ud2b8 \ub2e8\uacc4\ub9cc \ub2e4\uc2dc \uc2e4\ud589\ud569\ub2c8\ub2e4.'],
      rawPath: '',
      cleanedPath: ''
    };
  }
  return {
    title: '\uc2e4\ud328 \uc6d0\uc778 \ud655\uc778 \ud544\uc694',
    message: item.error || item.highlight_error || '\uc2e4\ud328 \uc6d0\uc778\uc774 \uae30\ub85d\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.',
    action: '\uc0c1\ud0dc \ub85c\uadf8 \ud655\uc778 \ud6c4 \uc7ac\uc2dc\ub3c4',
    tone: 'red',
    details: [],
    rawPath: item.raw_response_path || '',
    cleanedPath: item.cleaned_response_path || ''
  };
}

function FailureDecisionCard({ item, warning = false }) {
  const decision = getFailureDecision(item);
  const palette = warning || decision.tone === 'amber'
    ? 'border-amber-300/25 bg-amber-300/10 text-amber-50'
    : 'border-red-300/25 bg-red-500/10 text-red-50';
  const labelColor = warning || decision.tone === 'amber' ? 'text-amber-100' : 'text-red-100';

  return (
    <div className={`rounded-xl border px-3 py-2 ${palette}`}>
      <div className={`font-black ${labelColor}`}>{item.item_id}</div>
      <div className="mt-1 text-sm font-black">{decision.title}</div>
      <div className="mt-1 text-xs leading-5 opacity-90">{decision.message}</div>
      <div className="mt-2 inline-flex rounded-full border border-white/15 bg-black/20 px-3 py-1 text-[11px] font-black">
        권장 선택: {decision.action}
      </div>
      <div className="mt-2 text-xs opacity-70">
        download {item.source_download_status || '-'} / Gemini {item.metadata_status || '-'} / draft {item.draft_status || '-'} / highlight {item.highlight_status || '-'}
      </div>
      {decision.details.length ? (
        <ul className="mt-2 space-y-1 text-xs leading-5 opacity-85">
          {decision.details.map((line, index) => <li key={`${item.item_id}-detail-${index}`}>- {line}</li>)}
        </ul>
      ) : null}
      {decision.rawPath || decision.cleanedPath ? (
        <div className="mt-2 break-all text-[11px] opacity-60">
          raw {decision.rawPath || '-'} / cleaned {decision.cleanedPath || '-'}
        </div>
      ) : null}
    </div>
  );
}

function hasBrokenDisplayText(value) {
  const raw = String(value || '');
  if (!raw) return false;
  if (raw.includes(String.fromCharCode(0xfffd)) || /[?]{2,}/.test(raw)) return true;
  return Array.from(raw).some((char) => {
    const code = char.codePointAt(0);
    return (
      (code >= 0xf900 && code <= 0xfaff) ||
      [0x8e42, 0x907a, 0x9858, 0x5a9b, 0x91c9, 0x7b4c, 0x7640].includes(code)
    );
  });
}

function repairDisplayText(value, fallback = '\uC774\uC804 \uBB38\uC790\uC5F4\uC774 \uAE68\uC838 \uD45C\uC2DC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.') {
  const raw = String(value || '');
  if (!raw) return '';
  return hasBrokenDisplayText(raw) ? fallback : raw;
}

function sanitizeProgressEntry(entry = {}) {
  return {
    ...entry,
    message: repairDisplayText(entry.message),
    itemId: repairDisplayText(entry.itemId || '', '')
  };
}

function sanitizeServerJob(job) {
  if (!job || typeof job !== 'object') return job;
  const itemStatuses = job.item_statuses && typeof job.item_statuses === 'object'
    ? Object.fromEntries(Object.entries(job.item_statuses).map(([key, value]) => [
        key,
        value && typeof value === 'object'
          ? {
              ...value,
              error: repairDisplayText(value.error || '', ''),
              highlight_error: repairDisplayText(value.highlight_error || '', '')
            }
          : value
      ]))
    : job.item_statuses;
  return {
    ...job,
    error: repairDisplayText(job.error || '', ''),
    last_log_message: repairDisplayText(job.last_log_message || '', ''),
    logs: Array.isArray(job.logs) ? job.logs.map(sanitizeProgressEntry) : job.logs,
    item_statuses: itemStatuses
  };
}

function formatStatus(status) {
  return STATUS_LABELS[status] || repairDisplayText(status || '-', '\uC0C1\uD0DC \uD655\uC778 \uD544\uC694');
}

function getJobLaneLabel(job = {}) {
  return job?.lane === 'draft' ? '드래프트 생성 라인' : 'Gemini 분석 라인';
}

function getJobQueueReason(job = {}) {
  return repairDisplayText(job?.queue_reason || '', '');
}

function getPendingSourceUrl(video) {
  const raw = video?.raw && typeof video.raw === 'object' ? video.raw : {};
  const values = [
    video?.url,
    video?.watchUrl,
    video?.videoUrl,
    video?.source_url,
    video?.sourceUrl,
    raw.url,
    raw.watchUrl,
    raw.videoUrl,
    raw.source_url,
    raw.sourceUrl
  ];
  for (const value of values) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  const rawId = raw.id && typeof raw.id === 'object' ? raw.id.videoId : raw.id;
  const id = String(video?.id || video?.video_id || video?.videoId || rawId || raw.video_id || raw.videoId || '').trim();
  if (id && /^[a-zA-Z0-9_-]{8,}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return '';
}

const PROCESS_QUEUE_SESSION_KEY = 'ottogi.processQueueSession.v1';
const ACTIVE_QUEUE_STATUSES = new Set([
  'adding',
  'uploading',
  'uploading_bgm',
  'downloading_youtube',
  'analyzing_gemini',
  'processing',
  'server_job_running',
  'saving',
  'duplicating',
  'removing',
  'validating-output'
]);

function readProcessQueueSession() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROCESS_QUEUE_SESSION_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeProcessQueueSession(session) {
  try {
    window.localStorage.setItem(PROCESS_QUEUE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // localStorage can fail in private contexts. The in-memory state still works.
  }
}

export default function Phase5Draft() {
  const phase3 = usePipelineStore((s) => s.phase3);
  const phase4 = usePipelineStore((s) => s.phase4);
  const phase5 = usePipelineStore((s) => s.phase5);
  const setPhase5 = usePipelineStore((s) => s.setPhase5);
  const initialQueueSessionRef = useRef(null);
  if (!initialQueueSessionRef.current) {
    initialQueueSessionRef.current = readProcessQueueSession();
  }
  const initialQueueSession = initialQueueSessionRef.current;

  const [activeTab] = useState('process');
  const [resolution, setResolution] = useState('1080x1920');
  const [fps, setFps] = useState(30);
  const [useCapcutTemplate, setUseCapcutTemplate] = useState(true);
  const [templateStatus, setTemplateStatus] = useState(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [settingAlert, setSettingAlert] = useState(null);

  const [processConfig, setProcessConfig] = useState(null);
  const [processPresets, setProcessPresets] = useState(null);
  const [processStatus, setProcessStatus] = useState('idle');
  const [processError, setProcessError] = useState('');
  const [processResult, setProcessResult] = useState(null);
  const [processSubTab] = useState('batch');
  const [processQueue, setProcessQueue] = useState(initialQueueSession.processQueue || null);
  const [queueStatus, setQueueStatus] = useState(initialQueueSession.queueStatus || 'idle');
  const [queueError, setQueueError] = useState(repairDisplayText(initialQueueSession.queueError || '', ''));
  const [queueResult, setQueueResult] = useState(initialQueueSession.queueResult || null);
  const [queueProgress, setQueueProgress] = useState(Array.isArray(initialQueueSession.queueProgress) ? initialQueueSession.queueProgress.map(sanitizeProgressEntry) : []);
  const [serverQueueJob, setServerQueueJob] = useState(sanitizeServerJob(initialQueueSession.serverQueueJob || null));
  const [uploadSummary, setUploadSummary] = useState(initialQueueSession.uploadSummary || null);
  const [outputRootStatus, setOutputRootStatus] = useState(initialQueueSession.outputRootStatus || null);
  const [selectedQueueItemIds, setSelectedQueueItemIds] = useState(Array.isArray(initialQueueSession.selectedQueueItemIds) ? initialQueueSession.selectedQueueItemIds : []);
  const [expandedQueueItemId, setExpandedQueueItemId] = useState(initialQueueSession.expandedQueueItemId || '');
  const [metadataGeneratingId, setMetadataGeneratingId] = useState('');
  const [sourceDownloadingId, setSourceDownloadingId] = useState('');
  const [ocrDetectingId, setOcrDetectingId] = useState('');
  const [ocrReviewLoadingId, setOcrReviewLoadingId] = useState('');
  const [ocrReviewSavingId, setOcrReviewSavingId] = useState('');
  const [ocrReviewDrafts, setOcrReviewDrafts] = useState({});
  const [showYoutubeImport, setShowYoutubeImport] = useState(false);
  const [showManualAssetActions, setShowManualAssetActions] = useState(false);
  const [youtubeImportText, setYoutubeImportText] = useState('');
  const [youtubeImporting, setYoutubeImporting] = useState(false);
  const [captionTemplateSync, setCaptionTemplateSync] = useState(null);
  const [captionTemplateSyncing, setCaptionTemplateSyncing] = useState(false);
  const [showBatchAdvancedActions, setShowBatchAdvancedActions] = useState(false);
  const fileInputRef = useRef(null);
  const bgmInputRef = useRef(null);
  const highlightBgmInputRef = useRef(null);
  const channelAssetInputRef = useRef(null);
  const highlightChannelAssetInputRef = useRef(null);
  const itemSourceInputRefs = useRef({});
  const pendingSourceImportRef = useRef(false);

  const queueSessionRef = useRef(initialQueueSession || {});

  const persistQueueSessionPatch = (patch) => {
    const next = {
      ...(queueSessionRef.current || {}),
      ...patch,
      savedAt: new Date().toISOString()
    };
    queueSessionRef.current = next;
    writeProcessQueueSession(next);
  };

  const updateProcessQueueState = (nextValue) => {
    const current = queueSessionRef.current?.processQueue || processQueue;
    const resolved = typeof nextValue === 'function' ? nextValue(current) : nextValue;
    setProcessQueue(resolved);
    persistQueueSessionPatch({ processQueue: resolved });
  };

  const updateQueueStatusState = (nextStatus) => {
    setQueueStatus(nextStatus);
    persistQueueSessionPatch({ queueStatus: nextStatus });
  };

  const updateQueueErrorState = (nextError) => {
    const safeError = repairDisplayText(nextError || '', '');
    setQueueError(safeError);
    persistQueueSessionPatch({ queueError: safeError });
  };

  const updateQueueResultState = (nextResult) => {
    setQueueResult(nextResult);
    persistQueueSessionPatch({ queueResult: nextResult });
  };

  const updateServerQueueJobState = (nextJob) => {
    const safeJob = sanitizeServerJob(nextJob);
    setServerQueueJob(safeJob);
    persistQueueSessionPatch({ serverQueueJob: safeJob });
  };

  useEffect(() => {
    let mounted = true;
    const loadTemplateStatus = async () => {
      setTemplateLoading(true);
      try {
        const res = await api.get('/capcut/template-status');
        if (!mounted) return;
        setTemplateStatus(res.data);
      } catch {
        if (!mounted) return;
        setTemplateStatus({
          found: false,
          message: '템플릿 상태를 불러오지 못했습니다.'
        });
      } finally {
        if (mounted) setTemplateLoading(false);
      }
    };

    const loadProcessConfig = async () => {
      try {
        const [configRes, presetRes, queueRes] = await Promise.all([
          api.get('/process-edit/config'),
          api.get('/process-edit/presets'),
          api.get('/process-queue')
        ]);
        if (!mounted) return;
        setProcessConfig(configRes.data.config);
        setProcessPresets(presetRes.data);
        updateProcessQueueState(queueRes.data);
        if (!initialQueueSessionRef.current?.serverQueueJob?.job_id) {
          api.get('/process-queue/jobs')
            .then((jobsRes) => {
              const jobs = jobsRes.data?.jobs || [];
              const latestJob = jobs.find((job) => job.status === 'running')
                || jobs.find((job) => ['queued', 'running'].includes(job.status) && job.deferred !== true)
                || jobs.find((job) => ['queued', 'running'].includes(job.status))
                || jobs.find((job) => TERMINAL_SERVER_JOB_STATUSES.has(job.status));
              if (latestJob) syncServerQueueJob(latestJob);
            })
            .catch(() => {});
        }
      } catch (err) {
        if (!mounted) return;
        setProcessError(err.response?.data?.message || err.message);
      }
    };

    loadTemplateStatus();
    loadProcessConfig();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    writeProcessQueueSession({
      processQueue,
      queueStatus,
      queueError,
      queueResult,
      queueProgress: queueProgress.slice(0, 250),
      serverQueueJob,
      uploadSummary,
      outputRootStatus,
      selectedQueueItemIds,
      expandedQueueItemId,
      savedAt: new Date().toISOString()
    });
  }, [
    expandedQueueItemId,
    outputRootStatus,
    processQueue,
    queueError,
    queueProgress,
    queueResult,
    queueStatus,
    selectedQueueItemIds,
    serverQueueJob,
    uploadSummary
  ]);

  useEffect(() => {
    if (!ACTIVE_QUEUE_STATUSES.has(queueStatus)) return undefined;
    const timer = window.setInterval(() => {
      const session = readProcessQueueSession();
      if (!session || !session.savedAt) return;
      if (session.queueStatus && session.queueStatus !== queueStatus) updateQueueStatusState(session.queueStatus);
      if (typeof session.queueError === 'string' && session.queueError !== queueError) updateQueueErrorState(session.queueError);
      if (Array.isArray(session.queueProgress) && session.queueProgress.length !== queueProgress.length) {
        setQueueProgress(session.queueProgress);
      }
      if (session.queueResult && JSON.stringify(session.queueResult) !== JSON.stringify(queueResult)) {
        updateQueueResultState(session.queueResult);
      }
      if (session.processQueue && JSON.stringify(session.processQueue) !== JSON.stringify(processQueue)) {
        updateProcessQueueState(session.processQueue);
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [processQueue, queueError, queueProgress.length, queueResult, queueStatus]);

  useEffect(() => {
    const jobId = serverQueueJob?.job_id;
    if (!jobId) return undefined;
    let cancelled = false;
    const refreshLatestJob = async () => {
      try {
        const res = await api.get(`/process-queue/jobs/${jobId}`);
        if (!cancelled) syncServerQueueJob(res.data.job, res.data.queue);
      } catch (err) {
        if (!cancelled) updateQueueErrorState(err.response?.data?.message || err.message);
      }
    };
    refreshLatestJob();
    return () => {
      cancelled = true;
    };
  }, [serverQueueJob?.job_id]);

  useEffect(() => {
    const jobId = serverQueueJob?.job_id;
    if (!jobId || !isActiveServerJob(serverQueueJob)) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await api.get(`/process-queue/jobs/${jobId}/progress?limit=220`);
        if (cancelled) return;
        syncServerQueueJob(res.data.job, res.data.queue);
        if (TERMINAL_SERVER_JOB_STATUSES.has(res.data.job?.status)) {
          const latestJob = await fetchServerQueueJob(jobId);
          await followNextBatchGroupJob(latestJob);
        }
      } catch (err) {
        if (!cancelled) updateQueueErrorState(err.response?.data?.message || err.message);
      }
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [serverQueueJob?.job_id, serverQueueJob?.status]);

  useEffect(() => {
    if (!serverQueueJob?.job_id || !TERMINAL_SERVER_JOB_STATUSES.has(serverQueueJob?.status)) return undefined;
    let cancelled = false;
    const follow = async () => {
      try {
        if (!cancelled) await followNextBatchGroupJob(serverQueueJob);
      } catch {
        // Staying on the completed chunk is still safe; the next regular refresh can recover.
      }
    };
    follow();
    return () => {
      cancelled = true;
    };
  }, [serverQueueJob?.job_id, serverQueueJob?.status, serverQueueJob?.batch_group?.group_id, serverQueueJob?.batch_group?.chunk_index]);

  useEffect(() => {
    const ids = new Set((processQueue?.queueItems || []).map((item) => item.item_id));
    setSelectedQueueItemIds((prev) => prev.filter((id) => ids.has(id)));
    if (expandedQueueItemId && !ids.has(expandedQueueItemId)) {
      setExpandedQueueItemId('');
    }
  }, [processQueue?.queueItems, expandedQueueItemId]);

  const onGenerateStoryDraft = async () => {
    setStatus('processing');
    setError('');

    const [width, height] = resolution.split('x').map(Number);

    try {
      const res = await api.post('/capcut/generate-draft', {
        segments: phase3.claudeScript?.segments || [],
        claudeScript: phase3.claudeScript || {},
        ttsFiles: phase4.ttsFiles || [],
        captionUnits: phase4.captionUnits || [],
        captionWarnings: phase4.ttsWarnings || [],
        srtFile: phase4.srtFile,
        resolution: { width, height },
        fps: Number(fps),
        useCapcutTemplate
      });

      setPhase5({
        draftZip: res.data.zipFile,
        draftPath: res.data.draftPath,
        recommendedZip: res.data.recommendedZip || res.data.zipFile,
        zipVariants: res.data.zipVariants || null,
        capcutTemplateUsed: !!res.data.capcutTemplateUsed,
        templatePath: res.data.templatePath || '',
        templateLoadStatus: res.data.templateLoadStatus || '',
        templateCloneMode: !!res.data.templateCloneMode,
        templateMarkersFound: res.data.templateMarkersFound || [],
        missingTemplateMarkers: res.data.missingTemplateMarkers || []
      });
      setStatus('done');
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setStatus('failed');
    }
  };

  const patchProcessConfig = (patch) => {
    setProcessConfig((prev) => ({ ...(prev || {}), ...patch }));
  };

  const updateBlock = (index, patch) => {
    setProcessConfig((prev) => {
      const next = { ...(prev || {}) };
      const blocks = [...(next.explainer_blocks || [])];
      blocks[index] = { ...(blocks[index] || emptyBlock(index)), ...patch };
      next.explainer_blocks = blocks;
      return next;
    });
  };

  const addBlock = () => {
    setProcessConfig((prev) => {
      const blocks = [...(prev?.explainer_blocks || [])];
      blocks.push(emptyBlock(blocks.length));
      return { ...(prev || {}), explainer_blocks: blocks };
    });
  };

  const removeBlock = (index) => {
    setProcessConfig((prev) => ({
      ...(prev || {}),
      explainer_blocks: (prev?.explainer_blocks || []).filter((_, i) => i !== index)
    }));
  };

  const saveProcessConfig = async () => {
    setProcessStatus('saving');
    setProcessError('');
    try {
      const res = await api.post('/process-edit/config', { config: processConfig });
      setProcessConfig(res.data.config);
      setProcessStatus('saved');
    } catch (err) {
      setProcessError(err.response?.data?.message || err.message);
      setProcessStatus('failed');
    }
  };

  const generateProcessDraft = async () => {
    setProcessStatus('processing');
    setProcessError('');
    setProcessResult(null);
    try {
      const res = await api.post('/process-edit/generate-draft', {
        config: processConfig,
        useExistingConfig: false
      });
      setProcessResult(res.data);
      setPhase5({
        draftZip: res.data.zipFile,
        draftPath: res.data.draftPath,
        recommendedZip: res.data.recommendedZip || res.data.zipFile,
        capcutTemplateUsed: !!res.data.capcutTemplateUsed,
        templatePath: res.data.templatePath || '',
        templateCloneMode: !!res.data.templateCloneMode,
        templateMarkersFound: res.data.templateMarkersFound || [],
        missingTemplateMarkers: res.data.missingTemplateMarkers || []
      });
      setProcessStatus('done');
    } catch (err) {
      setProcessError(err.response?.data?.message || err.message);
      setProcessStatus('failed');
    }
  };

  const reloadProcessQueue = async () => {
    const res = await api.get('/process-queue');
    updateProcessQueueState(res.data);
    return res.data;
  };

  const syncCaptionTemplateSettings = async () => {
    setCaptionTemplateSyncing(true);
    updateQueueErrorState('');
    try {
      const res = await api.post('/process-queue/caption-template-sync');
      setCaptionTemplateSync(res.data);
      if (res.data?.queue) updateProcessQueueState(res.data.queue);
      updateQueueStatusState('saved');
      setTimeout(() => updateQueueStatusState('idle'), 900);
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message || '샘플 자막 설정을 읽지 못했습니다.');
      updateQueueStatusState('failed');
    } finally {
      setCaptionTemplateSyncing(false);
    }
  };

  const patchQueueConfig = (patch) => {
    updateProcessQueueState((prev) => ({
      ...(prev || {}),
      queueConfig: { ...(prev?.queueConfig || {}), ...patch }
    }));
  };

  const patchQueueOutput = (patch) => {
    updateProcessQueueState((prev) => ({
      ...(prev || {}),
      queueConfig: {
        ...(prev?.queueConfig || {}),
        output: {
          ...(prev?.queueConfig?.output || {}),
          ...patch
        }
      }
    }));
  };

  const updateQueueItem = (index, patch) => {
    updateProcessQueueState((prev) => {
      const next = { ...(prev || {}) };
      const items = [...(next.queueItems || [])];
      const current = items[index] || {};
      const itemConfig = { ...(current.item_config || {}), ...patch };
      items[index] = {
        ...current,
        ...patch,
        item_config: itemConfig,
        explainer_preview: itemConfig.explainer_blocks?.[0]?.text || current.explainer_preview || '',
        explainer_blocks_count: itemConfig.explainer_blocks?.length || current.explainer_blocks_count || 0
      };
      next.queueItems = items;
      return next;
    });
  };

  const applyRandomVideoPresetsToQueue = async () => {
    const presets = (processPresets?.videoTransformPresets || [])
      .map((preset) => preset.preset_id)
      .filter(Boolean);
    const items = processQueue?.queueItems || [];
    if (!presets.length || !items.length) return;

    updateQueueStatusState('saving');
    updateQueueErrorState('');
    try {
      const randomizedQueue = {
        ...(processQueue || {}),
        queueItems: items.map((item) => {
          const presetId = presets[Math.floor(Math.random() * presets.length)];
          const itemBlocks = Array.isArray(item.item_config?.explainer_blocks) && item.item_config.explainer_blocks.length
            ? item.item_config.explainer_blocks
            : [emptyBlock(0)];
          const explainerBlocks = itemBlocks.map((block) => ({
            ...block
          }));
          const itemConfig = {
            ...(item.item_config || {}),
            video_transform_preset: presetId,
            explainer_blocks: explainerBlocks
          };
          return {
            ...item,
            video_transform_preset: presetId,
            item_config: itemConfig,
            explainer_preview: explainerBlocks[0]?.text || item.explainer_preview || '',
            explainer_blocks_count: explainerBlocks.length
          };
        })
      };
      updateProcessQueueState(randomizedQueue);
      await persistQueueSnapshot(randomizedQueue);
      updateQueueStatusState('saved');
      setTimeout(() => updateQueueStatusState('idle'), 700);
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const getQueueSavePayload = (queue = processQueue) => ({
    queue_config: queue?.queueConfig || {},
    queue_items: (queue?.queueItems || []).map((item) => item.item_config || item)
  });

  const persistQueueSnapshot = async (queue = processQueue) => {
    if (!queue) return null;
    const res = await api.post('/process-queue/save', getQueueSavePayload(queue));
    return res.data;
  };

  const syncServerQueueJob = (job, queue = null) => {
    if (!job) return;
    const safeJob = sanitizeServerJob(job);
    updateServerQueueJobState(safeJob);
    if (queue) updateProcessQueueState(queue);
    const progress = Array.isArray(job.logs)
      ? safeJob.logs.map((entry) => ({
          id: entry.id,
          time: entry.time ? new Date(entry.time).toLocaleTimeString('ko-KR') : '',
          message: repairDisplayText(entry.message),
          level: entry.level || 'info',
          itemId: repairDisplayText(entry.item_id || entry.itemId || '', '')
        }))
      : [];
    if (progress.length) {
      setQueueProgress(progress);
      persistQueueSessionPatch({ queueProgress: progress });
    }
    if (isActiveServerJob(job)) {
      updateQueueStatusState('server_job_running');
    } else {
      updateQueueStatusState(job.status || 'idle');
    }
    if (job.error) updateQueueErrorState(job.error);
    if (job.result) updateQueueResultState(job.result);
    else if (TERMINAL_SERVER_JOB_STATUSES.has(job.status)) {
      const itemStatuses = Object.values(job.item_statuses || {});
      const hasSuccessStatus = (item) => (
        item.source_download_status === 'success'
        || item.source_download_status === 'skipped'
        || item.metadata_status === 'success'
        || item.draft_status === 'success'
        || item.highlight_status === 'success'
        || item.status === 'success'
      );
      const failedItems = itemStatuses.filter((item) => (
        isHardFailedServerItem(item)
        || (job.status === 'failed' && isMetadataFailureItem(item) && !isDraftSuccessItem(item))
      ));
      const warningItems = itemStatuses.filter((item) => isWarningServerItem(item) && !failedItems.includes(item));
      const successfulItems = itemStatuses.filter((item) => hasSuccessStatus(item) && !isHardFailedServerItem(item));
      const result = {
        batchId: job.batch_name || job.job_id,
        report: {
          total_items: job.item_ids?.length || 0,
          success_count: successfulItems.length,
          failed_count: failedItems.length,
          warning_count: warningItems.length,
          items: itemStatuses.map((item) => ({
            item_id: item.item_id,
            status: failedItems.includes(item) ? 'failed' : getServerItemDisplayStatus(item),
            output_folder: item.output_folder || '',
            highlight_status: item.highlight_status || 'disabled',
            highlight_output_folder: item.highlight_output_folder || '',
            highlight_error: item.highlight_error || '',
            error: item.error || ''
          }))
        }
      };
      updateQueueResultState(result);
    }
  };

  const fetchServerQueueJob = async (jobId) => {
    const res = await api.get(`/process-queue/jobs/${jobId}`);
    syncServerQueueJob(res.data.job, res.data.queue);
    return res.data.job;
  };

  const followNextBatchGroupJob = async (currentJob = serverQueueJob) => {
    const groupId = currentJob?.batch_group?.group_id || '';
    const currentChunkIndex = Number(currentJob?.batch_group?.chunk_index || 0);
    if (!groupId || !TERMINAL_SERVER_JOB_STATUSES.has(currentJob?.status)) return null;
    const res = await api.get('/process-queue/jobs');
    const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
    const nextJob = jobs
      .filter((job) => (
        job?.batch_group?.group_id === groupId
        && Number(job?.batch_group?.chunk_index || 0) > currentChunkIndex
        && ['queued', 'running'].includes(job.status)
      ))
      .sort((a, b) => {
        const aActive = a.status === 'running' ? 0 : 1;
        const bActive = b.status === 'running' ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return Number(a?.batch_group?.chunk_index || 0) - Number(b?.batch_group?.chunk_index || 0);
      })[0];
    if (!nextJob) return null;
    syncServerQueueJob(nextJob);
    addQueueProgress(`다음 5개 묶음으로 이동: ${nextJob.batch_group?.chunk_index || '?'} / ${nextJob.batch_group?.chunk_total || '?'}`, 'info');
    return nextJob;
  };

  const startServerQueueJob = async (itemIds = null, stages = ['download', 'metadata', 'draft'], options = {}) => {
    const normalizedStages = Array.isArray(stages) ? stages : [];
    const continueToDraftAfterMetadata = options.continueToDraftAfterMetadata === true;
    const batchMode = options.batchMode || '';
    if (batchMode === LOCALE_6_6_BATCH_MODE) {
      const localeIssue = validateLocale66QueueSelection(getTargetItemsForAction(itemIds));
      if (localeIssue) {
        updateQueueErrorState(localeIssue);
        addQueueProgress(`locale_6_6 실행 차단: ${localeIssue}`, 'error');
        return;
      }
    }
    const action = options.validationAction || (continueToDraftAfterMetadata
      ? 'server:all'
      : normalizedStages.length === 1
      ? `server:${normalizedStages[0]}`
      : 'server:all');
    const actionLabel = continueToDraftAfterMetadata
      ? '서버 Gemini 재분석 후 드래프트'
      : normalizedStages.length === 1
      ? `\uC11C\uBC84 ${normalizedStages[0] === 'metadata' ? 'Gemini' : normalizedStages[0] === 'draft' ? '\uB4DC\uB798\uD504\uD2B8' : '\uB2E4\uC6B4\uB85C\uB4DC'}`
      : '\uC804\uCCB4 \uC11C\uBC84 \uC2E4\uD589';
    if (!validateRequiredSettings(action, itemIds, actionLabel)) return;
    setQueueProgress([]);
    updateQueueStatusState('server_job_running');
    updateQueueErrorState('');
    updateQueueResultState(null);
    try {
      const payload = {
        queue: getQueueSavePayload(processQueue),
        item_ids: Array.isArray(itemIds) && itemIds.length ? itemIds : null,
        stages,
        batch_name: processQueue?.queueConfig?.batch_name || 'process_batch_001',
        force_metadata: options.forceMetadata === true,
        draft_variant_mode: options.draftVariantMode || STANDARD_BATCH_VARIANT_MODE,
        metadata_variant_mode: options.metadataVariantMode || options.draftVariantMode || STANDARD_BATCH_VARIANT_MODE,
        batch_mode: batchMode,
        continue_to_draft_after_metadata: continueToDraftAfterMetadata,
        enqueue_if_active: true,
        enqueue_batches: batchMode === LOCALE_6_6_BATCH_MODE ? false : true,
        chunk_size: batchMode === LOCALE_6_6_BATCH_MODE ? 12 : 5
      };
      const res = await api.post('/process-queue/jobs/start', payload);
      const visibleJob = res.data.activeJob || res.data.job;
      syncServerQueueJob(visibleJob);
      if (visibleJob?.lane) {
        addQueueProgress(`${getJobLaneLabel(visibleJob)} 시작/등록: ${visibleJob.stages?.join(' -> ') || '작업 대기'}`, 'info');
      }
      if (visibleJob?.queue_reason) {
        addQueueProgress(visibleJob.queue_reason, 'warning');
      }
      if (res.data.queuedJobs?.length) {
        addQueueProgress(`5개 세트 대기큐 등록: ${res.data.queuedJobs.length}개 작업`, 'info');
        res.data.queuedJobs.forEach((queuedJob) => {
          if (queuedJob?.queue_reason) addQueueProgress(`${getJobLaneLabel(queuedJob)}: ${queuedJob.queue_reason}`, 'warning');
        });
      }
      await fetchServerQueueJob(visibleJob.job_id);
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      updateQueueErrorState(message);
      updateQueueStatusState('failed');
      addQueueProgress(`\uC11C\uBC84 \uC791\uC5C5 \uC2DC\uC791 \uC2E4\uD328: ${message}`, 'error');
    }
  };

  const cancelServerQueueJob = async () => {
    if (!serverQueueJob?.job_id) return;
    try {
      const res = await api.post(`/process-queue/jobs/${serverQueueJob.job_id}/cancel`);
      syncServerQueueJob(res.data.job);
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
    }
  };

  const retryFailedServerQueueJob = async () => {
    if (!serverQueueJob?.job_id) return;
    setQueueProgress([]);
    updateQueueStatusState('server_job_running');
    updateQueueErrorState('');
    try {
      const res = await api.post(`/process-queue/jobs/${serverQueueJob.job_id}/retry-failed`, {
        continue_to_draft_after_metadata: true
      });
      syncServerQueueJob(res.data.job);
      await fetchServerQueueJob(res.data.job.job_id);
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const retryMetadataWarningItems = async () => {
    const itemIds = Object.values(serverQueueJob?.item_statuses || {})
      .filter((item) => isMetadataFailureItem(item) || isMidformPartialFailureItem(item))
      .map((item) => item.item_id)
      .filter(Boolean);
    if (!itemIds.length) return;
    await startServerQueueJob(itemIds, ['metadata'], {
      forceMetadata: true,
      continueToDraftAfterMetadata: true
    });
  };

  const runVariantMetadataAndDraft = async (variant) => {
    const mode = PROCESS_VARIANT_MODES[variant] || 'all';
    await startServerQueueJob(selectedOrAllItemIds, ['download', 'metadata'], {
      forceMetadata: true,
      metadataVariantMode: mode,
      draftVariantMode: mode,
      continueToDraftAfterMetadata: true,
      validationAction: `server:${variant}:pipeline`
    });
  };

  const runVariantMetadataOnly = async (variant) => {
    const mode = PROCESS_VARIANT_MODES[variant] || 'all';
    await startServerQueueJob(selectedOrAllItemIds, ['download', 'metadata'], {
      forceMetadata: true,
      metadataVariantMode: mode,
      draftVariantMode: mode,
      continueToDraftAfterMetadata: false,
      validationAction: `server:${variant}:pipeline`
    });
  };

  const runVariantDraftOnly = async (variant) => {
    const mode = PROCESS_VARIANT_MODES[variant] || 'all';
    await startServerQueueJob(selectedOrAllItemIds, ['draft'], {
      draftVariantMode: mode,
      validationAction: `server:${variant}:draft`
    });
  };

  const runSmartSelectedWorkflow = async () => {
    const targetItemIds = selectedOrAllItemIds;
    const targetItems = getTargetItemsForAction(targetItemIds);
    if (!validateRequiredSettings('server:all', targetItemIds, '자동 분류 실행')) return;

    const pipelineItems = [];
    const draftReadyItems = [];
    targetItems.forEach((item) => {
      const itemConfig = item.item_config || {};
      if (item.source_exists && hasMetadataReady(itemConfig)) {
        draftReadyItems.push(item.item_id);
      } else {
        pipelineItems.push(item.item_id);
      }
    });

    setQueueProgress([]);
    updateQueueStatusState('server_job_running');
    updateQueueErrorState('');
    updateQueueResultState(null);

    const mixedLongform = targetItems.some(isLongformQueueItem) && targetItems.some((item) => !isLongformQueueItem(item));
    const longformCount = targetItems.filter(isLongformQueueItem).length;
    const shortformCount = targetItems.length - longformCount;

    try {
      let visibleJob = null;
      addQueueProgress(
        `자동 분류 실행: 선택 ${targetItems.length}개 중 숏폼 ${shortformCount}개, 롱폼 ${longformCount}개를 확인했습니다.${mixedLongform ? ' 숏폼 Gemini 분석을 먼저 처리하고 롱폼은 뒤로 대기시킵니다.' : ''}`,
        'info'
      );

      if (pipelineItems.length) {
        const res = await api.post('/process-queue/jobs/start', {
          queue: getQueueSavePayload(processQueue),
          item_ids: pipelineItems,
          stages: ['download', 'metadata'],
          batch_name: processQueue?.queueConfig?.batch_name || 'process_batch_001',
          draft_variant_mode: STANDARD_BATCH_VARIANT_MODE,
          metadata_variant_mode: STANDARD_BATCH_VARIANT_MODE,
          continue_to_draft_after_metadata: true,
          enqueue_if_active: true,
          enqueue_batches: true,
          chunk_size: 5
        });
        visibleJob = visibleJob || res.data.activeJob || res.data.job;
        const queuedCount = res.data.queuedJobs?.length || 0;
        addQueueProgress(`분석이 필요한 ${pipelineItems.length}개 항목을 자동 실행에 등록했습니다.${queuedCount ? ` / 대기 ${queuedCount}개` : ''}`, 'info');
      }

      if (draftReadyItems.length) {
        const res = await api.post('/process-queue/jobs/start', {
          queue: getQueueSavePayload(processQueue),
          item_ids: draftReadyItems,
          stages: ['draft'],
          batch_name: processQueue?.queueConfig?.batch_name || 'process_batch_001',
          draft_variant_mode: STANDARD_BATCH_VARIANT_MODE,
          enqueue_if_active: true,
          enqueue_batches: true,
          chunk_size: 5
        });
        visibleJob = visibleJob || res.data.activeJob || res.data.job;
        const queuedCount = res.data.queuedJobs?.length || 0;
        addQueueProgress(`기존 Gemini 결과를 재사용하는 ${draftReadyItems.length}개 항목은 드래프트 생성 라인에 등록했습니다.${queuedCount ? ` / 대기 ${queuedCount}개` : ''}`, 'info');
      }

      if (visibleJob) {
        syncServerQueueJob(visibleJob);
        await fetchServerQueueJob(visibleJob.job_id);
      }
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      updateQueueErrorState(message);
      updateQueueStatusState('failed');
      addQueueProgress(`자동 분류 실행 시작 실패: ${message}`, 'error');
    }
  };

  const runLocale66Workflow = async () => {
    await startServerQueueJob(selectedOrAllItemIds, ['download', 'metadata'], {
      metadataVariantMode: PROCESS_VARIANT_MODES.highlight,
      draftVariantMode: PROCESS_VARIANT_MODES.highlight,
      continueToDraftAfterMetadata: true,
      validationAction: 'server:highlight:pipeline',
      batchMode: LOCALE_6_6_BATCH_MODE
    });
  };

  const runFailedVariantMetadataAndDraftForVariant = async (variant) => {
    const failures = getFailedVariantItemIdsByVariant();
    const itemIds = failures[variant] || [];
    if (!itemIds.length) {
      addQueueProgress(`${variant} 재시도 대상이 없습니다.`, 'info');
      return;
    }
    const mode = PROCESS_VARIANT_MODES[variant] || 'all';
    await startServerQueueJob(itemIds, ['metadata'], {
      forceMetadata: true,
      metadataVariantMode: mode,
      draftVariantMode: mode,
      continueToDraftAfterMetadata: true,
      validationAction: `server:${variant}:pipeline`
    });
  };

  const getFailedVariantItemIdsByVariant = () => {
    const targetIds = selectedQueueItemIds.length ? new Set(selectedQueueItemIds) : null;
    const failures = {
      full: new Set(),
      highlight: new Set(),
      midform: new Set()
    };
    const addFailure = (itemId, variant) => {
      if (!itemId || !failures[variant]) return;
      if (targetIds && !targetIds.has(itemId)) return;
      failures[variant].add(itemId);
    };

    Object.values(serverQueueJob?.item_statuses || {}).forEach((item) => {
      ['full', 'highlight', 'midform'].forEach((variant) => {
        if (isVariantAnalysisFailed(item, variant)) {
          addFailure(item.item_id, variant);
        }
      });
    });

    (processQueue?.queueItems || []).forEach((item) => {
      const itemId = item.item_id || item.item_config?.item_id;
      const guide = item.item_config?.ottogi_guide_output || {};
      const failedVariants = Array.isArray(guide.failed_variants) ? guide.failed_variants : [];
      ['full', 'highlight', 'midform'].forEach((variant) => {
        if (guide[`${variant}_generation_status`] === 'failed' || failedVariants.includes(variant)) {
          addFailure(itemId, variant);
        }
      });
    });

    return Object.fromEntries(
      Object.entries(failures).map(([variant, ids]) => [variant, [...ids]])
    );
  };

  const getDraftOnlyFailedItemIds = (variantFailures = null) => {
    const targetIds = selectedQueueItemIds.length ? new Set(selectedQueueItemIds) : null;
    const failures = variantFailures || getFailedVariantItemIdsByVariant();
    const metadataFailedItemIds = new Set([
      ...(failures.full || []),
      ...(failures.highlight || []),
      ...(failures.midform || [])
    ]);
    return Object.values(serverQueueJob?.item_statuses || {})
      .filter((item) => {
        const itemId = item.item_id;
        if (!itemId) return false;
        if (targetIds && !targetIds.has(itemId)) return false;
        if (metadataFailedItemIds.has(itemId)) return false;
        return item.draft_status === 'failed';
      })
      .map((item) => item.item_id)
      .filter(Boolean);
  };

  const runFailedVariantMetadataAndDraft = async () => {
    const failures = getFailedVariantItemIdsByVariant();
    const variantRuns = ['full', 'highlight']
      .map((variant) => ({
        variant,
        mode: PROCESS_VARIANT_MODES[variant],
        itemIds: failures[variant] || []
      }))
      .filter((run) => run.itemIds.length);
    const draftOnlyFailedItemIds = getDraftOnlyFailedItemIds(failures);

    if (!variantRuns.length && !draftOnlyFailedItemIds.length) {
      addQueueProgress('재시도할 실패 포맷이나 드래프트 실패 항목이 없습니다.', 'info');
      return;
    }
    if (!validateRequiredSettings('server:all', selectedOrAllItemIds, '실패 포맷 재분석 후 드래프트')) return;

    setQueueProgress([]);
    updateQueueStatusState('server_job_running');
    updateQueueErrorState('');
    updateQueueResultState(null);

    try {
      let visibleJob = null;
      for (const run of variantRuns) {
        const res = await api.post('/process-queue/jobs/start', {
          queue: getQueueSavePayload(processQueue),
          item_ids: run.itemIds,
          stages: ['metadata'],
          batch_name: processQueue?.queueConfig?.batch_name || 'process_batch_001',
          force_metadata: true,
          draft_variant_mode: run.mode,
          metadata_variant_mode: run.mode,
          continue_to_draft_after_metadata: true,
          enqueue_if_active: true,
          enqueue_batches: true,
          chunk_size: 5
        });
        visibleJob = visibleJob || res.data.activeJob || res.data.job;
        const queuedCount = res.data.queuedJobs?.length || 0;
        addQueueProgress(`${run.variant} 실패 포맷 재분석+생성 등록: ${run.itemIds.length}개${queuedCount ? ` / 대기 ${queuedCount}개` : ''}`, 'info');
      }
      if (draftOnlyFailedItemIds.length) {
        const res = await api.post('/process-queue/jobs/start', {
          queue: getQueueSavePayload(processQueue),
          item_ids: draftOnlyFailedItemIds,
          stages: ['draft'],
          batch_name: processQueue?.queueConfig?.batch_name || 'process_batch_001',
          draft_variant_mode: STANDARD_BATCH_VARIANT_MODE,
          enqueue_if_active: true,
          enqueue_batches: true,
          chunk_size: 5
        });
        visibleJob = visibleJob || res.data.activeJob || res.data.job;
        const queuedCount = res.data.queuedJobs?.length || 0;
        addQueueProgress(`드래프트만 실패 항목 재생성 등록: ${draftOnlyFailedItemIds.length}개${queuedCount ? ` / 대기 ${queuedCount}개` : ''}`, 'info');
      }
      if (visibleJob) {
        syncServerQueueJob(visibleJob);
        await fetchServerQueueJob(visibleJob.job_id);
      }
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      updateQueueErrorState(message);
      updateQueueStatusState('failed');
      addQueueProgress(`실패 포맷 재시도 시작 실패: ${message}`, 'error');
    }
  };

  const regenerateFailedDraftItems = async () => {
    const itemIds = Object.values(serverQueueJob?.item_statuses || {})
      .filter((item) => item.draft_status === 'failed')
      .map((item) => item.item_id)
      .filter(Boolean);
    if (!itemIds.length) return;
    await startServerQueueJob(itemIds, ['draft']);
  };

  useEffect(() => {
    const pendingVideos = Array.isArray(phase5.pendingSourceVideos) ? phase5.pendingSourceVideos : [];
    if (!processQueue || pendingVideos.length === 0 || pendingSourceImportRef.current) return;

    pendingSourceImportRef.current = true;
    let cancelled = false;

    const importPendingVideos = async () => {
      updateQueueStatusState('adding');
      updateQueueErrorState('');
      try {
        await persistQueueSnapshot();
        const existingUrls = new Set(
          (processQueue.queueItems || [])
            .map((item) => String(item.item_config?.source_url || '').trim())
            .filter(Boolean)
        );
        const existingItemIds = new Set((processQueue.queueItems || []).map((item) => item.item_id));
        let nextItemIndex = 1;
        const nextItemId = () => {
          let itemId = `item_${String(nextItemIndex).padStart(3, '0')}`;
          while (existingItemIds.has(itemId)) {
            nextItemIndex += 1;
            itemId = `item_${String(nextItemIndex).padStart(3, '0')}`;
          }
          existingItemIds.add(itemId);
          nextItemIndex += 1;
          return itemId;
        };
        let addedCount = 0;

        for (const video of pendingVideos) {
          const url = getPendingSourceUrl(video);
          if (!url || existingUrls.has(url)) continue;
          const itemId = nextItemId();

          await api.post('/process-queue/item', {
            item_id: itemId,
            item_config: {
              item_id: itemId,
              source_url: url,
              target_locale: normalizeTargetLocale(video.target_locale || video.targetLocale),
              source_video: 'source_clean.mp4',
              source_file_original_name: video.title || video.id || 'youtube_source',
              upload_title: video.title || '유튜브 소재',
              upload_description: video.description || '',
              upload_hashtags: Array.isArray(video.hashtags) ? video.hashtags : ['#shorts'],
              target_duration_sec: 30,
              source_platform: video.platform || 'youtube',
              source_creator: video.creator || '',
              source_handle: video.handle || '',
              source_thumbnail: video.thumbnail || '',
              source_views: video.views || 0,
              source_published_at: video.publishedAt || '',
              explainer_blocks: [
                {
                  ...emptyBlock(0),
                  text: video.title || ''
                }
              ]
            }
          });
          existingUrls.add(url);
          addedCount += 1;
        }

        if (!cancelled) {
          await reloadProcessQueue();
          setPhase5({ pendingSourceVideos: [] });
          setUploadSummary({
            addedCount,
            filenames: pendingVideos.map((video) => video.title || video.url).filter(Boolean)
          });
          updateQueueStatusState('idle');
        }
      } catch (err) {
        if (!cancelled) {
          updateQueueErrorState(err.response?.data?.message || err.message);
          updateQueueStatusState('failed');
        }
      } finally {
        pendingSourceImportRef.current = false;
      }
    };

    importPendingVideos();
    return () => {
      cancelled = true;
    };
  }, [phase5.pendingSourceVideos, processQueue, setPhase5]);

  const addQueueItem = async () => {
    updateQueueStatusState('adding');
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      const nextNumber = (processQueue?.queueItems?.length || 0) + 1;
      const itemId = `item_${String(nextNumber).padStart(3, '0')}`;
      await api.post('/process-queue/item', {
        item_id: itemId,
          item_config: {
            item_id: itemId,
            target_locale: 'ja-JP',
            source_video: 'source_clean.mp4',
          upload_title: '',
          upload_description: '',
          upload_hashtags: [],
          target_duration_sec: 30,
          explainer_blocks: [emptyBlock(0)]
        }
      });
      await reloadProcessQueue();
      updateQueueStatusState('idle');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const uploadQueueFiles = async (files) => {
    const selectedFiles = Array.from(files || []);
    if (!selectedFiles.length) return;
    updateQueueStatusState('uploading');
    updateQueueErrorState('');
    setUploadSummary(null);
    try {
      await persistQueueSnapshot();
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      const res = await api.post('/process-queue/upload-items', formData);
      updateProcessQueueState(res.data.queue);
      setUploadSummary({
        addedCount: res.data.addedCount || 0,
        filenames: (res.data.uploadedItems || []).map((item) => item.source_file_original_name || item.item_id)
      });
      updateQueueStatusState('uploaded');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const downloadQueueAuxSource = async (itemId, auxUrl) => {
    const url = String(auxUrl || '').trim();
    if (!itemId || !url) return;
    updateQueueStatusState('downloading_youtube');
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      const res = await api.post(`/process-queue/item/${itemId}/youtube-source`, {
        url,
        sourceRole: 'aux'
      });
      updateProcessQueueState(res.data.queue);
      addQueueProgress(`${itemId} Full aux 소스 다운로드 완료`, 'success', itemId);
      updateQueueStatusState('youtube_downloaded');
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      updateQueueErrorState(message);
      addQueueProgress(`${itemId} Full aux 소스 다운로드 실패: ${message}`, 'error', itemId);
      updateQueueStatusState('failed');
    }
  };

  const uploadQueueBgm = async (files, target = 'default') => {
    const selectedFile = Array.from(files || [])[0];
    if (!selectedFile) return;
    updateQueueStatusState('uploading_bgm');
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('target', target);
      const res = await api.post(`/process-queue/upload-bgm?target=${encodeURIComponent(target)}`, formData);
      updateProcessQueueState(res.data.queue);
      updateQueueStatusState('bgm_uploaded');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      if (target === 'highlight') {
        if (highlightBgmInputRef.current) highlightBgmInputRef.current.value = '';
      } else if (target === 'midform') {
        if (midformBgmInputRef.current) midformBgmInputRef.current.value = '';
      } else if (bgmInputRef.current) {
        bgmInputRef.current.value = '';
      }
    }
  };

  const uploadQueueChannelAsset = async (files, target = 'default') => {
    const selectedFile = Array.from(files || [])[0];
    if (!selectedFile) return;
    updateQueueStatusState('uploading');
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('target', target);
      const res = await api.post(`/process-queue/upload-channel-asset?target=${encodeURIComponent(target)}`, formData);
      updateProcessQueueState(res.data.queue);
      updateQueueStatusState('uploaded');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      if (target === 'highlight') {
        if (highlightChannelAssetInputRef.current) highlightChannelAssetInputRef.current.value = '';
      } else if (target === 'midform') {
        if (midformChannelAssetInputRef.current) midformChannelAssetInputRef.current.value = '';
      } else if (channelAssetInputRef.current) {
        channelAssetInputRef.current.value = '';
      }
    }
  };

  const importYoutubeUrls = async () => {
    const text = youtubeImportText.trim();
    if (!text) {
      updateQueueErrorState('\uC774 \uD56D\uBAA9\uC5D0\uB294 \uC5F4 \uC218 \uC788\uB294 \uC6D0\uBCF8 YouTube URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.');
      return;
    }
    setYoutubeImporting(true);
    updateQueueStatusState('downloading_youtube');
    updateQueueErrorState('');
    setUploadSummary(null);
    try {
      await persistQueueSnapshot();
      const res = await api.post('/process-queue/import-youtube', { text });
      updateProcessQueueState(res.data.queue);
      setUploadSummary({
        addedCount: res.data.importedCount || 0,
        filenames: [
          ...(res.data.imported || []).map((item) => `${item.item_id}: ${item.filename}`),
          ...(res.data.failed || []).map((item) => `${item.item_id}: 실패`)
        ]
      });
      updateQueueStatusState(res.data.failedCount ? 'failed' : 'youtube_downloaded');
      if (res.data.failedCount) {
        updateQueueErrorState(`${res.data.failedCount}개 URL 다운로드 실패. 실패 항목은 큐에 남겨뒀습니다.`);
      } else {
        setYoutubeImportText('');
        setShowYoutubeImport(false);
      }
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      setYoutubeImporting(false);
    }
  };

  const replaceQueueItemSource = async (itemId, files) => {
    const selectedFile = Array.from(files || [])[0];
    if (!itemId || !selectedFile) return;
    updateQueueStatusState('uploading');
    updateQueueErrorState('');
    setUploadSummary(null);
    try {
      await persistQueueSnapshot();
      const formData = new FormData();
      formData.append('file', selectedFile);
      const res = await api.post(`/process-queue/item/${itemId}/source`, formData);
      updateProcessQueueState(res.data.queue);
      setUploadSummary({
        addedCount: 1,
        filenames: [`${itemId}: ${selectedFile.name}`]
      });
      updateQueueStatusState('uploaded');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      if (itemSourceInputRefs.current[itemId]) itemSourceInputRefs.current[itemId].value = '';
    }
  };

  const openQueueItemOriginal = (item) => {
    const itemConfig = item?.item_config || {};
    const url = String(itemConfig.source_url || item?.source_url || '').trim();
    if (!url) {
      updateQueueErrorState('\uC774 \uD56D\uBAA9\uC5D0\uB294 \uC5F4 \uC218 \uC788\uB294 \uC6D0\uBCF8 YouTube URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const downloadQueueItemSourceFromUrl = async (index, itemId) => {
    const current = processQueue?.queueItems?.[index] || {};
    const itemConfig = current.item_config || {};
    const url = String(itemConfig.source_url || '').trim();
    if (!itemId || !url) {
      updateQueueErrorState('\uC774 \uD56D\uBAA9\uC5D0\uB294 \uC5F4 \uC218 \uC788\uB294 \uC6D0\uBCF8 YouTube URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.');
      return;
    }
    setSourceDownloadingId(itemId);
    updateQueueStatusState('downloading_youtube');
    updateQueueErrorState('');
    setUploadSummary(null);
    try {
      await persistQueueSnapshot();
      const res = await api.post(`/process-queue/item/${itemId}/youtube-source`, { url });
      updateProcessQueueState(res.data.queue);
      setUploadSummary({
        addedCount: 1,
        filenames: [`${itemId}: ${res.data.download?.filename || 'source_clean.mp4'}`]
      });
      updateQueueStatusState('youtube_downloaded');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      setSourceDownloadingId('');
    }
  };

  const generateGeminiMetadataForItem = async (index, itemId) => {
    const current = processQueue?.queueItems?.[index] || {};
    const itemConfig = current.item_config || {};
    setMetadataGeneratingId(itemId);
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      const res = await api.post(`/process-queue/item/${itemId}/gemini-metadata`, {
        sourceUrl: itemConfig.source_url || '',
        durationSec: itemConfig.video_metadata?.duration_sec || current.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0
      });
      updateProcessQueueState(res.data.queue);
      updateQueueStatusState('metadata_applied');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      setMetadataGeneratingId('');
    }
  };

  const detectOcrTextForItem = async (itemId) => {
    if (!itemId) return;
    setOcrDetectingId(itemId);
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      const res = await api.post(`/process-queue/item/${itemId}/ocr-text`, {
        intervalSec: 2,
        maxFrames: 12
      });
      updateProcessQueueState(res.data.queue);
      updateQueueStatusState('ocr_detected');
      setUploadSummary({
        addedCount: 1,
        filenames: [`${itemId}: OCR 후보 ${res.data.detection?.regions_count || 0}개 감지`]
      });
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    } finally {
      setOcrDetectingId('');
    }
  };

  const flattenOcrRegions = (report) => {
    const rows = [];
    (report?.frames || []).forEach((frame, frameIndex) => {
      (frame.regions || []).forEach((region, regionIndex) => {
        rows.push({
          ...region,
          region_id: region.region_id || `frame_${String(frameIndex + 1).padStart(3, '0')}_region_${String(regionIndex + 1).padStart(3, '0')}`,
          frame_id: frame.frame_id || `frame_${String(frameIndex + 1).padStart(3, '0')}`,
          time_sec: frame.time_sec,
          frame_regions_count: frame.regions_count
        });
      });
    });
    return rows;
  };

  const loadOcrReviewForItem = async (itemId) => {
    if (!itemId) return;
    setOcrReviewLoadingId(itemId);
    updateQueueErrorState('');
    try {
      const res = await api.get(`/process-queue/item/${itemId}/ocr-review`);
      const regions = flattenOcrRegions(res.data.report);
      const reviewedApproved = new Set(res.data.review?.approved_region_ids || []);
      const hasReview = !!res.data.review;
      setOcrReviewDrafts((prev) => ({
        ...prev,
        [itemId]: {
          ...res.data,
          regions: regions.map((region) => ({
            ...region,
            approved: hasReview ? reviewedApproved.has(region.region_id) : true
          })),
          reviewer_notes: res.data.review?.reviewer_notes || ''
        }
      }));
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      setSettingAlert({
        id: `${Date.now()}_ocr`,
        actionLabel: 'OCR 마스크 검수',
        issues: [err.response?.data?.message || err.message],
        total: 1
      });
    } finally {
      setOcrReviewLoadingId('');
    }
  };

  const updateOcrRegionApproval = (itemId, regionId, approved) => {
    setOcrReviewDrafts((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      return {
        ...prev,
        [itemId]: {
          ...current,
          regions: (current.regions || []).map((region) => (
            region.region_id === regionId ? { ...region, approved } : region
          ))
        }
      };
    });
  };

  const setAllOcrRegionApproval = (itemId, approved) => {
    setOcrReviewDrafts((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      return {
        ...prev,
        [itemId]: {
          ...current,
          regions: (current.regions || []).map((region) => ({ ...region, approved }))
        }
      };
    });
  };

  const saveOcrReviewForItem = async (itemId) => {
    const draft = ocrReviewDrafts[itemId];
    if (!itemId || !draft) return;
    setOcrReviewSavingId(itemId);
    updateQueueErrorState('');
    try {
      const approved = (draft.regions || []).filter((region) => region.approved).map((region) => region.region_id);
      const rejected = (draft.regions || []).filter((region) => !region.approved).map((region) => region.region_id);
      const res = await api.post(`/process-queue/item/${itemId}/ocr-review`, {
        status: 'approved',
        approved_region_ids: approved,
        rejected_region_ids: rejected,
        reviewer_notes: draft.reviewer_notes || ''
      });
      updateProcessQueueState(res.data.queue);
      setOcrReviewDrafts((prev) => ({
        ...prev,
        [itemId]: {
          ...(prev[itemId] || {}),
          review: res.data.review,
          approved_report: res.data.approved_report
        }
      }));
      addQueueProgress(`${itemId} OCR 마스크 검수 저장: 승인 ${approved.length}개, 제외 ${rejected.length}개`, 'success', itemId);
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
    } finally {
      setOcrReviewSavingId('');
    }
  };

  const saveProcessQueue = async () => {
    updateQueueStatusState('saving');
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      await reloadProcessQueue();
      updateQueueStatusState('saved');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const addQueueProgress = (message, level = 'info', itemId = '') => {
    const currentProgress = Array.isArray(queueSessionRef.current?.queueProgress)
      ? queueSessionRef.current.queueProgress
      : queueProgress;
    const next = [
      ...currentProgress,
      {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        time: new Date().toLocaleTimeString('ko-KR'),
        message: repairDisplayText(message),
        level,
        itemId
      }
    ].slice(-80);
    setQueueProgress(next);
    persistQueueSessionPatch({ queueProgress: next });
  };

  const getItemsForGenerate = (itemIds) => {
    const items = processQueue?.queueItems || [];
    if (Array.isArray(itemIds) && itemIds.length) {
      const selected = new Set(itemIds);
      return items.filter((item) => selected.has(item.item_id));
    }
    return items;
  };

  const hasMetadataReady = (itemConfig = {}) => (
    itemConfig.ottogi_guide_output
    && (
      Array.isArray(itemConfig.gemini_scene_transitions)
      || Array.isArray(itemConfig.ottogi_guide_output?.scene_transitions)
    )
  );

  const getSelectedOrAllItemIds = () => (selectedQueueItemIds.length ? selectedQueueItemIds : null);

  const getTargetItemsForAction = (itemIds) => getItemsForGenerate(itemIds);

  const hasExplainerText = (itemConfig = {}) => (
    Array.isArray(itemConfig.explainer_blocks)
    && itemConfig.explainer_blocks.some((block) => String(block?.text || '').trim())
  );

  const hasLocalOrRemoteSource = (item = {}) => {
    const itemConfig = item.item_config || {};
    return Boolean(item.source_exists || String(itemConfig.source_url || '').trim());
  };

  const getServerVariantAction = (action = '') => {
    const match = String(action || '').match(/^server:(highlight|full|midform)(?::(pipeline|draft))?$/);
    if (!match) return null;
    return {
      variant: match[1],
      stage: match[2] || 'pipeline'
    };
  };

  const filterAssetIssuesForVariant = (issues = [], variant = '') => {
    if (!variant) return issues;
    const normalizedVariant = String(variant || '').toLowerCase();
    return issues.filter((issue) => {
      const text = String(issue?.message || issue || '').toLowerCase();
      const mentionsHighlight = text.includes('하이라이트') || text.includes('highlight');
      const mentionsMidform = text.includes('미드폼') || text.includes('midform');
      const mentionsFull = text.includes('풀 드래프트') || text.includes('full');

      if (normalizedVariant === 'highlight') return mentionsHighlight;
      if (normalizedVariant === 'midform') return mentionsMidform;
      if (normalizedVariant === 'full') return mentionsFull || (!mentionsHighlight && !mentionsMidform);
      if (normalizedVariant === 'standard') return !mentionsMidform;
      return true;
    });
  };

  const getRequiredSettingIssues = (action, itemIds = null) => {
    const issues = [];
    const targetItems = getTargetItemsForAction(itemIds);
    const queueConfig = processQueue?.queueConfig || {};
    const outputRoot = String(queueConfig.output?.output_root || '').trim();
    const serverBusy = ['queued', 'running'].includes(serverQueueJob?.status);
    const serverVariantAction = getServerVariantAction(action);
    const serverVariant = serverVariantAction?.variant || '';
    const isVariantPipeline = Boolean(serverVariantAction && serverVariantAction.stage === 'pipeline');
    const isVariantDraft = Boolean(serverVariantAction && serverVariantAction.stage === 'draft');

    if (serverBusy && action.startsWith('server:')) {
      issues.push('A server job is already running. Run this again after the current job finishes.');
    }

    if (!targetItems.length) {
      issues.push('Add batch items first.');
      return issues;
    }

    if (action === 'selected:draft' && !selectedQueueItemIds.length) {
      issues.push('Select the items to generate first.');
    }

    const needsOutputRoot = ['draft', 'selected:draft', 'server:draft', 'server:all'].includes(action) || Boolean(serverVariantAction);
    if (needsOutputRoot) {
      if (!outputRoot) {
        issues.push('캡컷 드래프트 폴더를 입력하세요.');
      } else if (outputRootStatus && outputRootStatus.writable === false) {
        issues.push('캡컷 드래프트 폴더에 쓸 수 없습니다. 폴더 확인을 다시 실행하세요.');
      }

      if (
        String(queueConfig.capcut_template_source || 'capcut_draft_root') === 'capcut_draft_root'
        && !String(queueConfig.capcut_template_draft_name || '').trim()
      ) {
        issues.push('Enter the CapCut preset draft name.');
      }

      if (Array.isArray(processQueue?.queueAssetIssues) && processQueue.queueAssetIssues.length) {
        issues.push(...filterAssetIssuesForVariant(processQueue.queueAssetIssues, serverVariant || 'standard'));
      }
    }

    targetItems.forEach((item) => {
      const itemConfig = item.item_config || {};
      const label = item.item_id || 'item';
      const hasSourceUrl = Boolean(String(itemConfig.source_url || '').trim());

      if (action === 'download' || action === 'server:download') {
        if (!item.source_exists && !hasSourceUrl) {
          issues.push(label + ': Source video and YouTube URL are both missing.');
        }
      }

      if (action === 'metadata' || action === 'server:metadata' || action === 'server:all' || isVariantPipeline) {
        if (!hasLocalOrRemoteSource(item)) {
          issues.push(label + ': Source video or YouTube URL is required for Gemini analysis.');
        }
      }

      if (action === 'draft' || action === 'selected:draft' || action === 'server:draft' || isVariantDraft) {
        if (!item.source_exists) {
          issues.push(label + ': Prepare the source video before generating a draft.');
        }
        if (!hasMetadataReady(itemConfig) && !hasExplainerText(itemConfig)) {
          issues.push(label + ': Caption text or Gemini analysis result is missing.');
        }
      }

      if (action === 'server:all') {
        if (!hasLocalOrRemoteSource(item)) {
          issues.push(label + ': Source video or YouTube URL is required for the full run.');
        }
      }
    });

    return Array.from(new Set(issues));
  };
  const showRequiredSettingsAlert = (actionLabel, issues) => {
    const nextAlert = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      actionLabel,
      issues: issues.slice(0, 6),
      total: issues.length
    };
    setSettingAlert(nextAlert);
    updateQueueErrorState(`${actionLabel} cannot run. Check ${issues.length} required setting(s).`);
    addQueueProgress(`${actionLabel} blocked: ${issues[0] || 'Required setting missing'}`, 'warning');
  };
  const validateRequiredSettings = (action, itemIds, actionLabel) => {
    const issues = getRequiredSettingIssues(action, itemIds);
    if (issues.length) {
      showRequiredSettingsAlert(actionLabel, issues);
      return false;
    }
    setSettingAlert(null);
    return true;
  };

  const toggleQueueItemSelection = (itemId) => {
    setSelectedQueueItemIds((prev) => (
      prev.includes(itemId)
        ? prev.filter((id) => id !== itemId)
        : [...prev, itemId]
    ));
  };

  const toggleAllQueueItems = () => {
    const ids = (processQueue?.queueItems || []).map((item) => item.item_id);
    setSelectedQueueItemIds((prev) => (prev.length === ids.length ? [] : ids));
  };

  const getSceneTransitionsFromItemConfig = (itemConfig = {}) => {
    const candidates = [
      itemConfig.gemini_scene_transitions,
      itemConfig.ottogi_guide_output?.scene_transitions,
      itemConfig.source_preprocess?.scene_detection?.gemini_scene_transitions
    ];
    const found = candidates.find((value) => Array.isArray(value) && value.length);
    return Array.isArray(found) ? found : [];
  };

  const getCaptionTextFromScene = (scene, fallback = '') => (
    String(
      scene?.caption_text
      || scene?.caption_ja
      || scene?.visual_summary
      || scene?.focus_target
      || scene?.description
      || fallback
      || ''
    ).trim()
  );

  const buildManualExplainerBlocksFromScenes = (itemConfig = {}) => {
    const existingAnimation = itemConfig.explainer_blocks?.[0]?.animation || 'slide_up';
    const scenes = getSceneTransitionsFromItemConfig(itemConfig);
    if (scenes.length) {
      return scenes.map((scene, index) => {
        const start = Number(scene.start_sec ?? scene.start ?? scene.time_start_sec ?? index * 3);
        const rawEnd = Number(scene.end_sec ?? scene.end ?? scene.time_end_sec ?? (start + 3));
        const end = rawEnd > start ? rawEnd : start + 3;
        return {
          block_id: scene.scene_id || `scene_cap_${String(index + 1).padStart(3, '0')}`,
          scene_id: scene.scene_id || `scene_${String(index + 1).padStart(3, '0')}`,
          text: getCaptionTextFromScene(scene, itemConfig.explainer_blocks?.[index]?.text || itemConfig.explainer_blocks?.[0]?.text || ''),
          start_sec: Number.isFinite(start) ? Number(start.toFixed(3)) : index * 3,
          end_sec: Number.isFinite(end) ? Number(end.toFixed(3)) : index * 3 + 3,
          style_role: 'main_explainer',
          style_profile: 'full_cut_caption',
          anchor_zone: 'lower_third',
          animation: itemConfig.explainer_blocks?.[index]?.animation || existingAnimation
        };
      });
    }

    const blocks = Array.isArray(itemConfig.explainer_blocks) && itemConfig.explainer_blocks.length
      ? itemConfig.explainer_blocks
      : [emptyBlock(0)];
    return blocks.map((block, index) => ({
      ...emptyBlock(index),
      ...block,
      block_id: block.block_id || `scene_cap_${String(index + 1).padStart(3, '0')}`,
      style_role: block.style_role || 'main_explainer',
      style_profile: block.style_profile || 'full_cut_caption',
      animation: block.animation || existingAnimation
    }));
  };

  const enableManualExplainerBlocks = (index) => {
    const item = processQueue?.queueItems?.[index] || {};
    const itemConfig = item.item_config || {};
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: true,
      explainer_blocks: buildManualExplainerBlocksFromScenes(itemConfig)
    });
  };

  const disableManualExplainerBlocks = (index) => {
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: false
    });
  };

  const updateQueueExplainerBlock = (index, blockIndex, patch) => {
    const item = processQueue?.queueItems?.[index] || {};
    const itemConfig = item.item_config || {};
    const blocks = buildManualExplainerBlocksFromScenes(itemConfig);
    blocks[blockIndex] = {
      ...(blocks[blockIndex] || emptyBlock(blockIndex)),
      ...patch,
      style_profile: patch.style_profile || blocks[blockIndex]?.style_profile || 'full_cut_caption'
    };
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: true,
      explainer_blocks: blocks
    });
  };

  const addQueueExplainerBlock = (index) => {
    const item = processQueue?.queueItems?.[index] || {};
    const blocks = buildManualExplainerBlocksFromScenes(item.item_config || {});
    const previous = blocks[blocks.length - 1] || emptyBlock(0);
    const start = Number(previous.end_sec || 0);
    blocks.push({
      ...emptyBlock(blocks.length),
      block_id: `scene_cap_${String(blocks.length + 1).padStart(3, '0')}`,
      text: '',
      start_sec: start,
      end_sec: start + 3,
      style_profile: 'full_cut_caption',
      animation: previous.animation || 'slide_up'
    });
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: true,
      explainer_blocks: blocks
    });
  };

  const removeQueueExplainerBlock = (index, blockIndex) => {
    const item = processQueue?.queueItems?.[index] || {};
    const blocks = buildManualExplainerBlocksFromScenes(item.item_config || {}).filter((_, i) => i !== blockIndex);
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: true,
      explainer_blocks: blocks.length ? blocks : [emptyBlock(0)]
    });
  };

  const updateQueueHashtags = (index, value) => {
    updateQueueItem(index, {
      upload_hashtags: value
        .split(/[,\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    });
  };

  const updateQueueExplainerText = (index, value) => {
    const current = processQueue?.queueItems?.[index] || {};
    const itemConfig = current.item_config || {};
    const blocks = buildManualExplainerBlocksFromScenes(itemConfig);
    const firstBlock = blocks[0] || emptyBlock(0);
    blocks[0] = { ...firstBlock, text: value, style_profile: firstBlock.style_profile || 'full_cut_caption' };
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: true,
      explainer_blocks: blocks
    });
  };

  const updateQueueExplainerAnimation = (index, value) => {
    const current = processQueue?.queueItems?.[index] || {};
    const itemConfig = current.item_config || {};
    const blocks = buildManualExplainerBlocksFromScenes(itemConfig)
      .map((block) => ({ ...block, animation: value }));
    updateQueueItem(index, {
      manual_explainer_blocks_enabled: true,
      explainer_blocks: blocks
    });
  };

  const validateQueueOutputRoot = async () => {
    updateQueueStatusState('validating-output');
    updateQueueErrorState('');
    try {
      const res = await api.post('/process-queue/validate-output-root', {
        output_root: processQueue?.queueConfig?.output?.output_root || ''
      });
      setOutputRootStatus(res.data);
      updateQueueStatusState('idle');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const duplicateQueueItem = async (itemId) => {
    updateQueueStatusState('duplicating');
    updateQueueErrorState('');
    try {
      await persistQueueSnapshot();
      await api.post(`/process-queue/item/${itemId}/duplicate`);
      await reloadProcessQueue();
      updateQueueStatusState('idle');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const removeQueueItem = async (itemId) => {
    if (!itemId) return;
    updateQueueStatusState('removing');
    updateQueueErrorState('');
    try {
      const res = await api.delete(`/process-queue/item/${itemId}`);
      updateProcessQueueState(res.data.queue);
      setSelectedQueueItemIds((prev) => prev.filter((id) => id !== itemId));
      setExpandedQueueItemId((prev) => (prev === itemId ? '' : prev));
      addQueueProgress(`${itemId} 항목을 삭제했습니다.`, 'success', itemId);
      updateQueueStatusState('idle');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const removeSelectedQueueItems = async () => {
    if (!selectedQueueItemIds.length) {
      updateQueueErrorState('삭제할 항목을 먼저 선택하세요.');
      return;
    }
    updateQueueStatusState('removing');
    updateQueueErrorState('');
    try {
      const res = await api.post('/process-queue/items/delete', {
        item_ids: selectedQueueItemIds
      });
      updateProcessQueueState(res.data.queue);
      addQueueProgress(`선택 항목 ${res.data.removedCount || selectedQueueItemIds.length}개를 삭제했습니다.`, 'success');
      setSelectedQueueItemIds([]);
      setExpandedQueueItemId('');
      updateQueueStatusState('idle');
    } catch (err) {
      updateQueueErrorState(err.response?.data?.message || err.message);
      updateQueueStatusState('failed');
    }
  };

  const renderDownload = (zipFile, label = 'ZIP 다운로드') => {
    if (!zipFile) return null;
    return (
      <a
        className="ottogi-primary inline-block rounded-2xl px-5 py-3 text-sm font-black"
        href={`/api/capcut/download/${zipFile}`}
        target="_blank"
        rel="noreferrer"
      >
        {label}
      </a>
    );
  };

  const config = processConfig || {};
  const blocks = config.explainer_blocks || [];
  const queueItems = processQueue?.queueItems || [];
  const queueResultMap = new Map((queueResult?.report?.items || []).map((item) => [item.item_id, item]));
  const allQueueItemsSelected = queueItems.length > 0 && selectedQueueItemIds.length === queueItems.length;
  const selectedOrAllItemIds = getSelectedOrAllItemIds();
  const selectedOrAllQueueItems = selectedQueueItemIds.length
    ? queueItems.filter((item) => selectedQueueItemIds.includes(item.item_id))
    : queueItems;
  const localeBatchCounts = selectedOrAllQueueItems.reduce((counts, item) => {
    const locale = normalizeTargetLocale(item.item_config?.target_locale || item.target_locale);
    if (locale === 'ko-KR') counts.ko += 1;
    else counts.ja += 1;
    counts.total += 1;
    return counts;
  }, { ja: 0, ko: 0, total: 0 });
  const validateLocale66QueueSelection = (items = selectedOrAllQueueItems) => {
    const counts = { ja: 0, ko: 0, total: items.length };
    const seen = new Set();
    for (const item of items) {
      const itemConfig = item.item_config || {};
      const locale = normalizeTargetLocale(itemConfig.target_locale || item.target_locale);
      if (locale === 'ko-KR') counts.ko += 1;
      else counts.ja += 1;
      const key = canonicalSourceKey(itemConfig.source_url || item.source_url || itemConfig.source_discovery?.url || item.item_id);
      if (key && seen.has(key)) return '동일한 YouTube 영상이 중복 선택되어 있습니다.';
      if (key) seen.add(key);
    }
    if (counts.total !== 12 || counts.ja !== 6 || counts.ko !== 6) return '일본어와 한국어 소스를 각각 6개씩 선택해 주세요.';
    return '';
  };
  const localeBatchIssue = validateLocale66QueueSelection();
  const isLongformQueueItem = (item = {}) => {
    const itemConfig = item.item_config || {};
    return item.source_type === 'longform'
      || item.source_workflow_mode === 'longform_to_shorts'
      || itemConfig.source_type === 'longform'
      || itemConfig.source_workflow_mode === 'longform_to_shorts';
  };
  const getVisibleHighlightCandidatesForItem = (item = {}) => (
    Array.isArray(item.highlight_candidate_windows) ? item.highlight_candidate_windows.slice(0, 8) : []
  );
  const getSelectedHighlightCandidateCountForItem = (item = {}) => {
    if (!isLongformQueueItem(item)) return item?.source_exists === false ? 0 : 1;
    const itemConfig = item.item_config || {};
    const visibleCandidates = getVisibleHighlightCandidatesForItem(item);
    const hasExplicitHighlightSelection = itemConfig.selected_highlight_candidates_explicit === true
      || Array.isArray(itemConfig.selected_highlight_candidate_ids);
    if (!hasExplicitHighlightSelection) return visibleCandidates.length;
    return Array.isArray(itemConfig.selected_highlight_candidate_ids)
      ? itemConfig.selected_highlight_candidate_ids.length
      : 0;
  };
  const highlightDraftEstimate = selectedOrAllQueueItems.reduce(
    (sum, item) => sum + (isLongformQueueItem(item) ? 1 : getSelectedHighlightCandidateCountForItem(item)),
    0
  );
  const longformFullMaterialEstimate = selectedOrAllQueueItems.reduce(
    (sum, item) => sum + (isLongformQueueItem(item) ? getSelectedHighlightCandidateCountForItem(item) : 0),
    0
  );
  const longformHighlightItemCount = selectedOrAllQueueItems.filter(isLongformQueueItem).length;
  const shortformHighlightItemCount = selectedOrAllQueueItems.length - longformHighlightItemCount;
  const serverQueueBusy = ['queued', 'running'].includes(serverQueueJob?.status);
  const requiredSettingIssues = {
    serverMetadata: getRequiredSettingIssues('server:metadata', selectedOrAllItemIds),
    serverDraft: getRequiredSettingIssues('server:draft', selectedOrAllItemIds),
    serverAll: getRequiredSettingIssues('server:all', null),
    highlightPipeline: getRequiredSettingIssues('server:highlight:pipeline', selectedOrAllItemIds),
    highlightDraft: getRequiredSettingIssues('server:highlight:draft', selectedOrAllItemIds),
    fullPipeline: getRequiredSettingIssues('server:full:pipeline', selectedOrAllItemIds),
    fullDraft: getRequiredSettingIssues('server:full:draft', selectedOrAllItemIds),
    midformPipeline: getRequiredSettingIssues('server:midform:pipeline', selectedOrAllItemIds),
    midformDraft: getRequiredSettingIssues('server:midform:draft', selectedOrAllItemIds)
  };
  const validationOverviewIssues = Array.from(new Set([
    ...requiredSettingIssues.serverAll
  ]));
  const missingSettingsCount = Math.max(
    requiredSettingIssues.serverMetadata.length,
    requiredSettingIssues.serverDraft.length,
    requiredSettingIssues.serverAll.length
  );
  const videoTransformPresets = processPresets?.videoTransformPresets || [];
  const textAnimationPresets = processPresets?.textAnimationPresets || [
    { animation_id: 'template_default', name: '\uD15C\uD50C\uB9BF \uAE30\uBCF8' },
    { animation_id: 'slide_up', name: '\uC2AC\uB77C\uC774\uB4DC \uC5C5' },
    { animation_id: 'fade_in', name: '\uD398\uC774\uB4DC \uC778' },
    { animation_id: 'pop_in', name: '\uD31D\uC5C5 \uAC15\uC870' },
    { animation_id: 'type_on', name: '\uD0C0\uC774\uD551 \uD6A8\uACFC' }
  ];
  const selectedVideoTransformPreset = (processPresets?.videoTransformPresets || [])
    .find((preset) => preset.preset_id === (config.video_transform_preset || 'steady_zoom_process'));

  const filenameFromPath = (value = '') => String(value || '').split(/[\\/]/).filter(Boolean).pop() || '-';
  const looksMojibake = (value = '') => hasBrokenDisplayText(value);
  const displayAssetName = (originalName = '', filePath = '') => {
    const original = String(originalName || '').trim();
    if (original && !looksMojibake(original)) return original;
    const fallback = filenameFromPath(filePath);
    return fallback && fallback !== '-' ? fallback : '미설정';
  };
  const formatDuration = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)}\uCD08` : '-';
  };
  const getSourceTypeBadge = (item = {}, itemConfig = {}) => {
    const sourceType = item.source_type || itemConfig.source_type || 'unknown';
    const workflowMode = item.source_workflow_mode || itemConfig.source_workflow_mode || 'unknown';
    if (sourceType === 'longform' || workflowMode === 'longform_to_shorts') {
      return {
        label: '롱폼 숏폼화',
        className: 'border-sky-300/35 bg-sky-300/10 text-sky-100'
      };
    }
    if (sourceType === 'shortform' || workflowMode === 'shortform_direct') {
      return {
        label: '숏폼 직접',
        className: 'border-[#c8ff00]/35 bg-[#c8ff00]/10 text-[#c8ff00]'
      };
    }
    return {
      label: '소스 미확인',
      className: 'border-white/10 bg-white/5 text-slate-300'
    };
  };
  const formatHashtags = (value) => Array.isArray(value)
    ? value.join(' ')
    : String(value || '');
  const getQueueItemResult = (itemId) => queueResultMap.get(itemId) || {};
  const getVideoTransformPreset = (presetId) => videoTransformPresets
    .find((preset) => preset.preset_id === presetId);
  const summarizeTransformOrder = (preset) => {
    if (!preset) return '';
    if (Array.isArray(preset.process_order) && preset.process_order.length) {
      return preset.process_order.join(' \u2192 ');
    }
    if (preset.description) return preset.description;
    return '';
  };
  const queueConfig = processQueue?.queueConfig || {};
  const assetSummaries = [
    {
      label: '기본 풀 BGM',
      name: displayAssetName(queueConfig.custom_bgm_original_name, queueConfig.custom_bgm_path),
      path: queueConfig.custom_bgm_path,
      active: !!queueConfig.custom_bgm_path,
      onClick: () => bgmInputRef.current?.click()
    },
    {
      label: '하이라이트 BGM',
      name: displayAssetName(queueConfig.highlight_custom_bgm_original_name, queueConfig.highlight_custom_bgm_path),
      path: queueConfig.highlight_custom_bgm_path,
      active: !!queueConfig.highlight_custom_bgm_path,
      onClick: () => highlightBgmInputRef.current?.click()
    },
    {
      label: '기본 풀 로고',
      name: displayAssetName(queueConfig.channel_asset?.original_name, queueConfig.channel_asset?.path),
      path: queueConfig.channel_asset?.path,
      active: !!queueConfig.channel_asset?.path,
      onClick: () => channelAssetInputRef.current?.click()
    },
    {
      label: '하이라이트 로고',
      name: displayAssetName(queueConfig.highlight_channel_asset?.original_name, queueConfig.highlight_channel_asset?.path),
      path: queueConfig.highlight_channel_asset?.path,
      active: !!queueConfig.highlight_channel_asset?.path,
      onClick: () => highlightChannelAssetInputRef.current?.click()
    }
  ];
  const activeCaptionTemplateSync = captionTemplateSync || (queueConfig.caption_template_sync ? {
    synced_at: queueConfig.caption_template_sync.synced_at,
    samples: null
  } : null);
  const captionTemplateRequiredMarkers = (label = '', sample = null) => {
    if (Array.isArray(sample?.expected_markers) && sample.expected_markers.length) {
      return sample.expected_markers;
    }
    return String(label).toLowerCase().includes('highlight')
      ? ['TEMPLATE_HIGHLIGHT_EXPLAINER']
      : ['TEMPLATE_FULL_CAPTION'];
  };
  const formatTemplateColor = (style = {}) => style.text_color || (Array.isArray(style.fill_rgb) ? `rgb(${style.fill_rgb.map((v) => Math.round(Number(v || 0) * 255)).join(', ')})` : '-');
  const renderTemplateStyleChip = (style = null, label = '') => {
    if (!style) {
      return (
        <div className="rounded-2xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-100">
          <div className="font-black">{label}</div>
          <div className="mt-1">마커 없음</div>
        </div>
      );
    }
    const color = formatTemplateColor(style);
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs text-slate-300">
        <div className="flex items-center justify-between gap-2">
          <div className="font-black text-white">{label}</div>
          <span className="rounded-full border border-[#c8ff00]/25 bg-[#c8ff00]/10 px-2 py-0.5 text-[11px] font-black text-[#c8ff00]">읽음</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: style.text_color || '#ffffff' }} />
          <span>{color}</span>
        </div>
        <div className="mt-1">폰트: {style.font_name || style.font_title || filenameFromPath(style.font_path) || style.font_id || '-'}</div>
        <div className="mt-1">크기: {style.font_size || '-'} · 위치: {style.position?.x ?? '-'}, {style.position?.y ?? '-'}</div>
        <div className="mt-1">박스: {style.fixed_width ?? '-'} / {style.fixed_height ?? '-'}</div>
        <div className="mt-1">
          애니메이션: {style.animation?.has_animation ? `${style.animation.refs_count}개` : '없음'}
        </div>
        {style.animation?.has_animation ? (
          <div className="mt-1 line-clamp-2 text-[11px] text-slate-500" title={style.animation.animations?.flatMap((item) => item.items || []).map((item) => `${item.id || item.name || item.type} ${item.duration_sec || 0}s`).join(', ')}>
            {style.animation.animations?.flatMap((item) => item.items || []).map((item) => `${item.id || item.name || item.type} ${item.duration_sec || 0}s`).join(', ')}
          </div>
        ) : null}
      </div>
    );
  };
  const renderCaptionTemplateSyncPanel = () => {
    const samples = captionTemplateSync?.samples || null;
    const lastSynced = captionTemplateSync?.synced_at || queueConfig.caption_template_sync?.synced_at || '';
    return (
      <div className="mt-4 rounded-3xl border border-[#c8ff00]/20 bg-[#c8ff00]/8 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.18em] text-[#c8ff00]">샘플 자막 설정</div>
            <p className="mt-1 text-xs leading-5 text-slate-300">
              CapCut에서 sample draft 자막을 수정한 뒤 누르면 JP Full/Highlight/Midform 마커 값을 다시 읽습니다. 다음 드래프트 생성은 이 샘플 값을 기준으로 적용됩니다.
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              JP Full: {queueConfig.jp_full_capcut_template_draft_name || queueConfig.capcut_template_draft_name || 'sample draft jp full'} ·
              JP Highlight: {queueConfig.jp_highlight_capcut_template_draft_name || 'sample draft jp highlight'} ·
              JP Midform: {queueConfig.jp_midform_capcut_template_draft_name || 'sample draft jp midform'}
            </p>
          </div>
          <button
            className="rounded-2xl bg-[#c8ff00] px-4 py-3 text-sm font-black text-black disabled:opacity-50"
            disabled={captionTemplateSyncing}
            onClick={syncCaptionTemplateSettings}
          >
            {captionTemplateSyncing ? '읽는 중...' : '샘플 자막 설정 반영'}
          </button>
        </div>
        {lastSynced ? <div className="mt-3 text-xs text-slate-400">마지막 반영: {new Date(lastSynced).toLocaleString('ko-KR')}</div> : null}
        {samples ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {[
              ['JP Full', samples.jp_full || samples.jp],
              ['JP Highlight', samples.jp_highlight],
              ['JP Midform', samples.jp_midform]
            ].map(([label, sample]) => (
              <div key={label} className="rounded-3xl border border-white/10 bg-black/20 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm font-black text-white">{label}</div>
                  <span className={sample?.missing_markers?.length ? 'rounded-full bg-amber-300/15 px-2 py-0.5 text-[11px] font-black text-amber-100' : 'rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-black text-emerald-100'}>
                    {sample?.missing_markers?.length ? '마커 확인 필요' : '마커 정상'}
                  </span>
                </div>
                <div className="mb-2 truncate text-[11px] text-slate-500" title={sample?.draft_content_path || ''}>{sample?.draft_name || '-'} · {sample?.message || ''}</div>
                <div className="grid gap-2 md:grid-cols-2">
                  {captionTemplateRequiredMarkers(label, sample).map((marker) => (
                    <div key={marker}>
                      {renderTemplateStyleChip(
                        sample?.markers?.[marker],
                        marker === 'TEMPLATE_HIGHLIGHT_EXPLAINER' ? 'Highlight 자막' : 'Full 자막'
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : activeCaptionTemplateSync ? (
          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-400">
            저장된 동기화 기록이 있습니다. 최신 색상/폰트 값을 보려면 버튼을 다시 눌러 샘플 드래프트를 읽어주세요.
          </div>
        ) : null}
      </div>
    );
  };

  const queueProgressStats = queueProgress.reduce((stats, entry) => {
    const level = entry?.level || 'info';
    stats[level] = (stats[level] || 0) + 1;
    return stats;
  }, { info: 0, warning: 0, success: 0, error: 0 });
  const latestProgress = queueProgress[queueProgress.length - 1] || null;
  const targetCount = serverQueueJob?.item_ids?.length || queueItems.length || 0;
  const batchGroup = serverQueueJob?.batch_group && typeof serverQueueJob.batch_group === 'object'
    ? serverQueueJob.batch_group
    : null;
  const batchChunkIndex = Number(batchGroup?.chunk_index || 0);
  const batchChunkTotal = Number(batchGroup?.chunk_total || 0);
  const batchTotalItemCount = Number(batchGroup?.total_item_count || 0);
  const batchChunkItemCount = Number(batchGroup?.chunk_item_count || targetCount || 0);
  const batchChunkStartIndex = Number(batchGroup?.chunk_start_index || 0);
  const batchChunkEndIndex = Number(batchGroup?.chunk_end_index || 0);
  const hasBatchGroup = batchChunkTotal > 1 && batchTotalItemCount > 0;
  const batchRemainingChunks = hasBatchGroup ? Math.max(0, batchChunkTotal - batchChunkIndex) : 0;
  const batchRemainingItems = hasBatchGroup && batchChunkEndIndex
    ? Math.max(0, batchTotalItemCount - batchChunkEndIndex)
    : 0;
  const serverTotals = serverQueueJob?.totals || {};
  const completedStageUnits = ['download', 'metadata', 'draft'].reduce((sum, key) => {
    const stage = serverTotals[key] || {};
    return sum + Number(stage.success || 0) + Number(stage.failed || 0);
  }, 0);
  const downloadStatusRows = Object.values(serverQueueJob?.item_statuses || {})
    .filter((item) => item?.source_download_status || item?.stage === 'download')
    .sort((a, b) => String(a.item_id || '').localeCompare(String(b.item_id || '')));
  const serverJobItems = Object.values(serverQueueJob?.item_statuses || {})
    .sort((a, b) => String(a.item_id || '').localeCompare(String(b.item_id || '')));
  const failedServerJobItems = serverJobItems.filter((item) => (
    isHardFailedServerItem(item)
    || (serverQueueJob?.status === 'failed' && isMetadataFailureItem(item) && !isDraftSuccessItem(item))
  ));
  const warningServerJobItems = serverJobItems.filter((item) => isWarningServerItem(item) && !failedServerJobItems.includes(item));
  const metadataFailedServerJobItems = serverJobItems.filter((item) => isMetadataFailureItem(item));
  const failedVariantItemIds = getFailedVariantItemIdsByVariant();
  const draftOnlyFailedItemIds = getDraftOnlyFailedItemIds(failedVariantItemIds);
  const retryableFailedCount = (failedVariantItemIds.full?.length || 0)
    + (failedVariantItemIds.highlight?.length || 0)
    + draftOnlyFailedItemIds.length;
  const terminalServerJob = TERMINAL_SERVER_JOB_STATUSES.has(serverQueueJob?.status);
  const serverJobFinishedAt = serverQueueJob?.finished_at
    ? new Date(serverQueueJob.finished_at).toLocaleString('ko-KR')
    : '';
  const lastLogAgeSec = Number.isFinite(Number(serverQueueJob?.last_log_age_sec))
    ? Number(serverQueueJob.last_log_age_sec)
    : null;
  const lastLogAgeLabel = lastLogAgeSec == null
    ? '기록 없음'
    : lastLogAgeSec < 60
      ? String(lastLogAgeSec) + '초 전'
      : String(Math.floor(lastLogAgeSec / 60)) + '분 ' + String(lastLogAgeSec % 60) + '초 전';
  const workerAlive = serverQueueJob?.worker_alive === true;
  const jobStalled = serverQueueJob?.stalled === true;
  const stallThresholdSec = Number(serverQueueJob?.stall_threshold_sec || 180);
  const stallThresholdLabel = stallThresholdSec >= 60
    ? String(Math.round(stallThresholdSec / 60)) + '분'
    : String(stallThresholdSec) + '초';
  const workerHealthLabel = jobStalled
    ? '정지 의심'
    : workerAlive
      ? '작업자 실행 중'
      : terminalServerJob
        ? '작업 종료'
        : '작업자 확인 필요';
  const totalStageUnits = targetCount ? targetCount * 3 : 0;
  const progressPercent = terminalServerJob || queueStatus === 'done'
    ? 100
    : totalStageUnits
      ? Math.min(100, Math.round((completedStageUnits / totalStageUnits) * 100))
      : 0;
  const activeWorkflowStep = (() => {
    const stage = serverQueueJob?.stage || '';
    if (stage === 'download' || queueStatus === 'downloading_youtube') return 'download';
    if (stage === 'metadata' || queueStatus === 'analyzing_gemini') return 'gemini';
    if (stage === 'draft' || queueStatus === 'processing' || queueStatus === 'server_job_running') return 'draft';
    if (queueStatus === 'done' || ['success', 'completed_with_warnings', 'partial_success'].includes(serverQueueJob?.status)) return 'done';
    if (queueStatus === 'failed') return 'failed';
    return 'setup';
  })();
  const workflowSteps = [
    {
      id: 'setup',
      title: '1. \uC18C\uC2A4 \uC900\uBE44',
      body: 'YouTube URL \uB610\uB294 mp4/mov \uD30C\uC77C\uC744 \uBC30\uCE58\uC5D0 \uB123\uACE0, \uD544\uC694\uD55C \uACBD\uC6B0 BGM\uACFC \uB85C\uACE0/GIF/MP4\uB97C \uC9C0\uC815\uD569\uB2C8\uB2E4.'
    },
    {
      id: 'download',
      title: '2. \uC18C\uC2A4 \uB2E4\uC6B4\uB85C\uB4DC',
      body: 'URL \uD56D\uBAA9\uC740 \uC18C\uC2A4 \uC601\uC0C1\uC744 \uB0B4\uB824\uBC1B\uACE0, \uC774\uBBF8 \uC18C\uC2A4\uAC00 \uC788\uB294 \uD56D\uBAA9\uC740 \uAC74\uB108\uB701\uB2C8\uB2E4.'
    },
    {
      id: 'gemini',
      title: '3. 장면 분석',
      body: '장면 전환, 컷 후보, 화면 자막, 업로드 메타데이터를 분석합니다.'
    },
    {
      id: 'draft',
      title: '4. 편집본 생성',
      body: '컷 분할, 영상 변형, OCR 마스크 후보, BGM, 로고, 자막을 적용한 CapCut 편집본을 만듭니다.'
    },
    {
      id: 'done',
      title: '5. \uACB0\uACFC \uD655\uC778',
      body: '\uCEA1\uCEF7 \uB4DC\uB798\uD504\uD2B8 \uD3F4\uB354\uC5D0\uC11C \uD480 \uB4DC\uB798\uD504\uD2B8\uC640 10\uCD08 \uD558\uC774\uB77C\uC774\uD2B8\uB97C \uD655\uC778\uD558\uACE0 \uD544\uC694\uD55C \uBD80\uBD84\uB9CC \uC218\uB3D9 \uBCF4\uC815\uD569\uB2C8\uB2E4.'
    }
  ];
const renderWorkflowGuide = () => (
    <div className="rounded-[24px] border border-[#c8ff00]/20 bg-[#11170f] p-4 shadow-xl shadow-black/25">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.22em] text-[#c8ff00]">Workflow</div>
          <h3 className="mt-1 text-lg font-black text-white" title="소스 추가 → 다운로드 → 장면 분석 → 편집본 생성 순서로 진행합니다.">오뚝이 제작 흐름</h3>
        </div>
        <div className="rounded-full border border-[#c8ff00]/30 bg-[#c8ff00]/10 px-4 py-2 text-xs font-black text-[#c8ff00]">
          {formatStatus(queueStatus)} / {progressPercent}%
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-5">
        {workflowSteps.map((step) => (
          <div
            key={step.id}
            title={step.body}
            className={activeWorkflowStep === step.id ? 'rounded-2xl border border-[#c8ff00]/40 bg-[#c8ff00]/15 px-3 py-2 text-[#f2ffd2]' : 'rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-300'}
          >
            <div className="truncate text-sm font-black">{step.title}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="ottogi-studio space-y-6">
      <div className="ottogi-hero rounded-[32px] border border-white/10 bg-[#0d1210] p-7 shadow-2xl shadow-black/30">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.28em] text-[#c8ff00]">3분 오뚝이영상 · Phase 2</div>
            <h1 className="mt-2 text-3xl font-black text-white">캡컷 배치 드래프트 스튜디오</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300" title="소스 영상, BGM, 로고, Gemini 분석 데이터를 기반으로 채널별 CapCut 드래프트를 생성합니다.">영상 · BGM · 로고 · Gemini 분석 기반 배치 제작</p>
          </div>
          <div className="rounded-full border border-[#c8ff00]/25 bg-[#c8ff00]/12 px-4 py-2 text-xs font-black text-[#c8ff00]">
            기본 모드: ultra_efficiency_process
          </div>
        </div>
      </div>

      {renderWorkflowGuide()}

      <input ref={fileInputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" multiple className="hidden" onChange={(event) => uploadQueueFiles(event.target.files)} />
      <input ref={bgmInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a" className="hidden" onChange={(event) => uploadQueueBgm(event.target.files, 'default')} />
      <input ref={highlightBgmInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a" className="hidden" onChange={(event) => uploadQueueBgm(event.target.files, 'highlight')} />
      <input ref={channelAssetInputRef} type="file" accept="image/*,video/*,.gif,.png,.jpg,.jpeg,.mp4,.mov" className="hidden" onChange={(event) => uploadQueueChannelAsset(event.target.files, 'default')} />
      <input ref={highlightChannelAssetInputRef} type="file" accept="image/*,video/*,.gif,.png,.jpg,.jpeg,.mp4,.mov" className="hidden" onChange={(event) => uploadQueueChannelAsset(event.target.files, 'highlight')} />

      <div className="rounded-[28px] border border-[#c8ff00]/20 bg-[#10140f] p-5 shadow-xl shadow-black/20">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-white">배치 큐</h2>
            <p className="mt-1 text-sm text-slate-400" title="소스 추가, BGM/로고 업로드, Gemini 분석, 드래프트 생성을 한 곳에서 관리합니다.">필요한 작업만 빠르게 실행하세요.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              title="Phase1을 거치지 않고 로컬 영상, YouTube URL, BGM, 로고 파일을 직접 추가할 때만 엽니다."
              className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-black text-slate-200"
              onClick={() => setShowManualAssetActions((value) => !value)}
            >
              {showManualAssetActions ? '수동 추가 닫기' : '수동 추가'}
            </button>
            <button
              title="현재 큐 설정과 항목을 저장합니다."
              className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-black text-slate-200"
              onClick={saveProcessQueue}
            >
              큐 저장
            </button>
            <div className="rounded-full bg-[#c8ff00]/15 px-3 py-1 text-xs font-black text-[#c8ff00]">
              전체 {queueItems.length}개 · 선택 {selectedQueueItemIds.length}개
            </div>
            <div className={localeBatchIssue ? 'rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-black text-amber-100' : 'rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-xs font-black text-emerald-100'}>
              JP {localeBatchCounts.ja}/6 · KO {localeBatchCounts.ko}/6 · 총 {localeBatchCounts.total}/12
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {showManualAssetActions ? (
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 text-xs font-black uppercase tracking-[0.2em] text-[#c8ff00]">수동 소스/자산 추가</div>
            <div className="flex flex-wrap gap-2">
              <button title="로컬 MP4/MOV 파일을 배치 항목으로 추가합니다." className="rounded-2xl bg-[#c8ff00] px-4 py-3 text-sm font-black text-black" onClick={() => fileInputRef.current?.click()}>소스 영상</button>
              <button title="YouTube URL을 여러 개 붙여넣어 배치 항목으로 추가합니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white" onClick={() => setShowYoutubeImport((value) => !value)}>YouTube URL</button>
              <button title="Full 드래프트 기본 BGM을 교체합니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white" onClick={() => bgmInputRef.current?.click()}>Full BGM</button>
              <button title="Highlight 드래프트 BGM을 교체합니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white" onClick={() => highlightBgmInputRef.current?.click()}>HL BGM</button>
              <button title="Full 드래프트 로고/GIF/MP4를 교체합니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white" onClick={() => channelAssetInputRef.current?.click()}>Full Logo</button>
              <button title="Highlight 드래프트 로고/GIF/MP4를 교체합니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white" onClick={() => highlightChannelAssetInputRef.current?.click()}>HL Logo</button>
            </div>
            {showYoutubeImport ? (
              <div className="mt-4 space-y-2">
                <textarea className="min-h-[90px] w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white placeholder:text-slate-500" value={youtubeImportText} onChange={(event) => setYoutubeImportText(event.target.value)} placeholder="YouTube URL을 한 줄에 하나씩 입력하세요" />
                <button className="rounded-2xl bg-[#c8ff00] px-4 py-2 text-sm font-black text-black disabled:opacity-50" disabled={youtubeImporting} onClick={importYoutubeUrls}>{youtubeImporting ? '추가 중...' : 'URL 추가'}</button>
              </div>
            ) : null}
          </div>
          ) : null}

          <div className="rounded-3xl border border-[#c8ff00]/25 bg-[#c8ff00]/10 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.2em] text-[#c8ff00]">2. 포맷별 제작</div>
                <div className="mt-1 text-xs text-slate-300">선택 목록을 보고 자동으로 분류해 숏폼 Gemini 분석 → 롱폼 대기 → 드래프트 생성 순으로 등록합니다.</div>
              </div>
              <button title="전체 실행, 전체 재분석, 실패 포맷 재시도 같은 고급 일괄 작업을 엽니다." className="rounded-full border border-white/15 bg-black/20 px-3 py-1 text-xs font-black text-slate-200" onClick={() => setShowBatchAdvancedActions((value) => !value)}>
                {showBatchAdvancedActions ? '일괄 작업 숨김' : '일괄 작업'}
              </button>
            </div>
            <div className="mb-3 rounded-2xl border border-[#c8ff00]/25 bg-[#c8ff00]/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-black text-[#f2ffd2]">자동 분류 실행</div>
                  <div className="mt-1 text-xs text-[#eaff9a]">선택 항목에서 이미 Gemini가 끝난 건 드래프트 라인으로, 아직 분석이 필요한 건 Gemini 분석 라인으로 자동 분류합니다.</div>
                </div>
                <button title="선택 목록을 검사해 이미 분석된 항목은 드래프트만, 미분석 항목은 다운로드+Gemini 분석 후 드래프트 생성으로 자동 분류합니다. 숏폼이 섞여 있으면 숏폼 Gemini 분석이 먼저 처리됩니다." className="rounded-2xl bg-[#c8ff00] px-4 py-3 text-sm font-black text-black disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.serverAll.length > 0} onClick={runSmartSelectedWorkflow}>선택 목록 자동 실행</button>
              </div>
            </div>
            <div className="mb-3 rounded-2xl border border-fuchsia-300/30 bg-fuchsia-300/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-black text-fuchsia-100">JP 6 + KO 6 하이라이트 일괄 실행</div>
                  <div className="mt-1 text-xs text-fuchsia-100/80">선택 항목이 없으면 전체 큐를 기준으로 검사합니다. 동일 YouTube 소스 중복 없이 일본어 6개, 한국어 6개일 때만 Highlight-only 배치를 시작합니다.</div>
                  <div className={localeBatchIssue ? 'mt-2 text-xs font-bold text-amber-100' : 'mt-2 text-xs font-bold text-emerald-100'}>{localeBatchIssue || 'locale_6_6 실행 가능'}</div>
                </div>
                <button title="12개 소스를 하나의 locale_6_6 서버 작업으로 실행합니다. Full/Midform은 생성하지 않습니다." className="rounded-2xl bg-fuchsia-300 px-4 py-3 text-sm font-black text-black disabled:opacity-50" disabled={serverQueueBusy || !!localeBatchIssue || requiredSettingIssues.highlightPipeline.length > 0} onClick={runLocale66Workflow}>12개 JP/KO HL 생성</button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-3xl border border-amber-300/30 bg-amber-300/10 p-3" title="10초 전후 시각적 후킹 중심 드래프트를 생성합니다. 긴 하단 설명형 자막을 사용합니다.">
                <div className="text-sm font-black text-amber-100">Highlight</div>
                <div className="mt-2 rounded-xl border border-[#c8ff00]/25 bg-[#c8ff00]/10 px-3 py-2 text-xs font-black text-[#c8ff00]" title="롱폼은 후보를 여러 개 분석하지만 최종 Highlight는 후킹 점수 최상위 후보만 생성합니다.">
                  예상 {highlightDraftEstimate}개
                  <span className="ml-2 font-bold text-amber-50/60">롱폼 {longformHighlightItemCount} · 숏폼 {shortformHighlightItemCount}</span>
                </div>
                {longformHighlightItemCount > 0 ? (
                  <div className="mt-3 grid gap-2">
                    <button title="롱폼 소스는 후보 분석 후 최고점 구간 1개를 바로 Highlight 드래프트로 생성합니다." className="w-full rounded-2xl bg-amber-300 px-4 py-3 text-sm font-black text-black disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.highlightPipeline.length > 0} onClick={() => runVariantMetadataAndDraft('highlight')}>후보 분석+HL 생성</button>
                  </div>
                ) : (
                  <button title="Gemini 분석부터 Highlight 드래프트 생성까지 실행합니다." className="mt-3 w-full rounded-2xl bg-amber-300 px-4 py-3 text-sm font-black text-black disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.highlightPipeline.length > 0} onClick={() => runVariantMetadataAndDraft('highlight')}>하이라이트 제작</button>
                )}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button title="기존 Gemini 분석 결과를 사용해 Highlight 드래프트만 다시 만듭니다." className="rounded-xl border border-amber-300/30 bg-black/20 px-3 py-2 text-xs font-bold text-amber-100 disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.highlightDraft.length > 0} onClick={() => runVariantDraftOnly('highlight')}>드래프트만</button>
                  <button title="실패한 Highlight 포맷만 다시 분석/생성합니다." className="rounded-xl border border-rose-300/40 bg-rose-400/10 px-3 py-2 text-xs font-bold text-rose-100 disabled:opacity-50" disabled={serverQueueBusy || !failedVariantItemIds.highlight?.length || requiredSettingIssues.highlightPipeline.length > 0} onClick={() => runFailedVariantMetadataAndDraftForVariant('highlight')}>재시도 {failedVariantItemIds.highlight?.length || 0}</button>
                </div>
              </div>
              <div className="rounded-3xl border border-lime-300/30 bg-lime-300/10 p-3" title="60초 전후 공정 요약 Full 드래프트를 생성합니다. 컷별 짧은 자막을 사용합니다.">
                <div className="text-sm font-black text-lime-100">Full</div>
                <button title="Gemini 분석부터 Full 드래프트 생성까지 실행합니다." className="mt-3 w-full rounded-2xl bg-lime-300 px-4 py-3 text-sm font-black text-black disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.fullPipeline.length > 0} onClick={() => runVariantMetadataAndDraft('full')}>풀 드래프트 제작</button>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button title="기존 Gemini 분석 결과를 사용해 Full 드래프트만 다시 만듭니다." className="rounded-xl border border-lime-300/30 bg-black/20 px-3 py-2 text-xs font-bold text-lime-100 disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.fullDraft.length > 0} onClick={() => runVariantDraftOnly('full')}>드래프트만</button>
                  <button title="실패한 Full 포맷만 다시 분석/생성합니다." className="rounded-xl border border-rose-300/40 bg-rose-400/10 px-3 py-2 text-xs font-bold text-rose-100 disabled:opacity-50" disabled={serverQueueBusy || !failedVariantItemIds.full?.length || requiredSettingIssues.fullPipeline.length > 0} onClick={() => runFailedVariantMetadataAndDraftForVariant('full')}>재시도 {failedVariantItemIds.full?.length || 0}</button>
                </div>
              </div>
              <div className="rounded-3xl border border-cyan-300/30 bg-cyan-300/10 p-3" title="120초 전후 Midform 드래프트를 생성합니다. 전체 공정 흐름과 전용 로고/BGM을 사용합니다.">
                <div className="text-sm font-black text-cyan-100">Midform</div>
                <button title="Gemini 분석부터 Midform 드래프트 생성까지 실행합니다." className="mt-3 w-full rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-black text-black disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.midformPipeline.length > 0} onClick={() => runVariantMetadataAndDraft('midform')}>미드폼 제작</button>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button title="기존 Gemini 분석 결과를 사용해 Midform 드래프트만 다시 만듭니다." className="rounded-xl border border-cyan-300/30 bg-black/20 px-3 py-2 text-xs font-bold text-cyan-100 disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.midformDraft.length > 0} onClick={() => runVariantDraftOnly('midform')}>드래프트만</button>
                  <button title="실패한 Midform 포맷만 다시 분석/생성합니다." className="rounded-xl border border-rose-300/40 bg-rose-400/10 px-3 py-2 text-xs font-bold text-rose-100 disabled:opacity-50" disabled={serverQueueBusy || !failedVariantItemIds.midform?.length || requiredSettingIssues.midformPipeline.length > 0} onClick={() => runFailedVariantMetadataAndDraftForVariant('midform')}>재시도 {failedVariantItemIds.midform?.length || 0}</button>
                </div>
              </div>
            </div>
            {showBatchAdvancedActions ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
                <div className="flex flex-wrap gap-2">
                  <button title="선택 항목 또는 전체 항목을 하나의 일반 배치로 다운로드, Gemini 분석, Full/Highlight 드래프트 생성까지 실행합니다. 자동 분류 실행보다 덜 똑똑한 수동 일괄 옵션입니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.serverAll.length > 0} onClick={() => startServerQueueJob(selectedOrAllItemIds, ['download', 'metadata', 'draft'])}>일반 전체 실행</button>
                  <button title="기존 Gemini 결과를 무시하고 Full/Highlight만 다시 분석한 뒤 드래프트를 생성합니다. Midform은 제외됩니다." className="rounded-2xl border border-[#c8ff00]/40 bg-black/20 px-4 py-3 text-sm font-bold text-[#c8ff00] disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.serverMetadata.length > 0} onClick={() => startServerQueueJob(selectedOrAllItemIds, ['download', 'metadata'], { forceMetadata: true, continueToDraftAfterMetadata: true })}>재분석+생성</button>
                  <button title="실패한 Full/Highlight 분석은 포맷별로 재분석+생성하고, 드래프트만 실패한 항목은 드래프트만 다시 생성합니다. Midform은 제외됩니다." className="rounded-2xl border border-rose-300/50 bg-rose-400/10 px-4 py-3 text-sm font-black text-rose-100 disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.serverMetadata.length > 0 || requiredSettingIssues.serverDraft.length > 0 || retryableFailedCount === 0} onClick={runFailedVariantMetadataAndDraft}>실패 자동 분류 재시도 {retryableFailedCount}</button>
                  <button title="기존 Gemini 분석 결과를 사용해 Full/Highlight 드래프트만 다시 생성합니다. Midform은 제외됩니다." className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-bold text-white disabled:opacity-50" disabled={serverQueueBusy || requiredSettingIssues.serverDraft.length > 0} onClick={() => startServerQueueJob(selectedOrAllItemIds, ['draft'])}>드래프트만</button>
                </div>
              </div>
            ) : null}
            <button title="현재 서버 배치 작업을 중지합니다." className="mt-3 w-full rounded-2xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-100 disabled:opacity-50" disabled={!serverQueueBusy} onClick={cancelServerQueueJob}>작업 중지</button>
            {validationOverviewIssues.length ? (
              <div className="mt-3 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-100">
                <div className="font-black">필수 설정 누락</div>
                {validationOverviewIssues.slice(0, 4).map((issue, index) => <div key={index}>- {issue.message || issue}</div>)}
              </div>
            ) : null}
          </div>

        </div>

        {uploadSummary ? (
          <div className="mt-4 rounded-2xl border border-sky-300/25 bg-sky-400/10 px-4 py-3 text-sm text-sky-100">업로드 완료: {uploadSummary.addedCount || 0}개 항목 추가됨</div>
        ) : null}

        <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-black uppercase tracking-[0.2em] text-[#c8ff00]">현재 적용 파일</div>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
            {assetSummaries.map((asset) => (
              <div key={asset.label} className="rounded-2xl border border-white/10 bg-white/[0.04] p-3" title={`${asset.label}\n${asset.name || '파일 없음'}\n${asset.path || ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-xs font-black text-slate-300">{asset.label}</div>
                  <span className={asset.active ? 'rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-black text-emerald-200' : 'rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-black text-slate-400'}>
                    {asset.active ? '적용됨' : '미설정'}
                  </span>
                </div>
                <div className="mt-2 truncate text-sm font-bold text-white" title={asset.name}>{asset.name}</div>
                <button title={`${asset.label} 파일을 교체합니다.`} className="mt-3 rounded-xl border border-[#c8ff00]/35 bg-[#c8ff00]/10 px-3 py-2 text-xs font-black text-[#c8ff00]" onClick={asset.onClick}>
                  교체
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-white/10 bg-[#10140f] p-5 shadow-xl shadow-black/20">
        <div className="mb-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <label className="block text-sm font-bold text-slate-200">
            캡컷 드래프트 폴더
            <input className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white" value={processQueue?.queueConfig?.output?.capcut_draft_root || processQueue?.queueConfig?.output?.output_root || ''} onChange={(event) => patchQueueOutput({ capcut_draft_root: event.target.value, output_root: event.target.value })} />
          </label>
          <label className="block text-sm font-bold text-slate-200">
            기본 영상 변형 프리셋
            <select className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white" value={processQueue?.queueConfig?.video_transform_preset || 'steady_zoom_process'} onChange={(event) => patchQueueConfig({ video_transform_preset: event.target.value })}>
              {videoTransformPresets.map((preset) => <option key={preset.preset_id} value={preset.preset_id}>{preset.name || preset.preset_id}</option>)}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button className="rounded-xl border border-white/15 bg-white/8 px-4 py-2 text-sm font-bold text-white" onClick={validateQueueOutputRoot}>폴더 확인</button>
            <button className="rounded-xl border border-[#c8ff00]/40 bg-[#c8ff00]/10 px-4 py-2 text-sm font-bold text-[#c8ff00]" onClick={applyRandomVideoPresetsToQueue}>프리셋 랜덤 적용</button>
          </div>
        </div>
        {outputRootStatus ? <div className="mb-3 rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-slate-300">폴더 상태: {outputRootStatus.ok ? "사용 가능" : "확인 필요"} {outputRootStatus.message || ""}</div> : null}
        {renderCaptionTemplateSyncPanel()}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
          <div>
            <div className="text-sm font-black text-white">배치 항목</div>
            <div className="text-xs text-slate-400">전체 {queueItems.length}개 · 선택 {selectedQueueItemIds.length}개</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button title="현재 목록의 모든 항목을 선택합니다." className="rounded-xl border border-white/15 bg-white/8 px-3 py-2 text-xs font-bold text-white" onClick={() => setSelectedQueueItemIds(queueItems.map((item) => item.item_id))}>전체 선택</button>
            <button title="선택을 모두 해제합니다." className="rounded-xl border border-white/15 bg-white/8 px-3 py-2 text-xs font-bold text-white" onClick={() => setSelectedQueueItemIds([])}>선택 해제</button>
            <button title="체크한 배치 항목을 삭제합니다." className="rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-100 disabled:opacity-50" disabled={!selectedQueueItemIds.length} onClick={removeSelectedQueueItems}>선택 삭제</button>
            <button title="서버의 최신 배치 큐 상태를 다시 불러옵니다." className="rounded-xl border border-white/15 bg-white/8 px-3 py-2 text-xs font-bold text-white" onClick={reloadProcessQueue}>새로고침</button>
            <button title="빈 배치 항목을 하나 추가합니다. 보통은 Phase1에서 담아오거나 수동 추가를 사용하세요." className="rounded-xl border border-white/15 bg-white/8 px-3 py-2 text-xs font-bold text-white" onClick={addQueueItem}>항목 추가</button>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10">
          <table className="min-w-full divide-y divide-white/10 text-sm">
            <thead className="bg-white/[0.04] text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-3 text-left"><input type="checkbox" checked={allQueueItemsSelected} onChange={toggleAllQueueItems} /></th>
                <th className="px-3 py-3 text-left">항목</th>
                <th className="px-3 py-3 text-left">소스</th>
                <th className="px-3 py-3 text-left">화면 자막</th>
                <th className="px-3 py-3 text-left">영상 변형</th>
                <th className="px-3 py-3 text-left">상태</th>
                <th className="px-3 py-3 text-left">작업</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {queueItems.length ? queueItems.map((item, index) => {
                const itemConfig = item.item_config || {};
                const firstBlock = itemConfig.explainer_blocks?.[0] || {};
                const result = getQueueItemResult(item.item_id);
                const metadata = item.metadata || itemConfig.source_metadata || {};
                const originalUrl = String(itemConfig.source_url || item.source_url || '').trim();
                const auxSourceUrl = String(itemConfig.aux_source_url || '').trim();
                const highlightCandidates = Array.isArray(item.highlight_candidate_windows) ? item.highlight_candidate_windows : [];
                const visibleHighlightCandidates = highlightCandidates.slice(0, 8);
                const sortedHighlightCandidates = [...visibleHighlightCandidates].sort((a, b) => Number(b.hook_score || b.score || 0) - Number(a.hook_score || a.score || 0));
                const bestHighlightCandidateId = sortedHighlightCandidates[0]?.candidate_id || (sortedHighlightCandidates[0] ? 'highlight_1' : '');
                const isLongformSource = item.source_type === 'longform'
                  || item.source_workflow_mode === 'longform_to_shorts'
                  || itemConfig.source_type === 'longform'
                  || itemConfig.source_workflow_mode === 'longform_to_shorts';
                const localeLocked = serverQueueBusy
                  || ['success', 'done', 'draft_success', 'running', 'queued'].includes(String(item.status || result.status || '').toLowerCase())
                  || ['success', 'running', 'queued'].includes(String(item.draft_status || result.draft_status || '').toLowerCase())
                  || ['success', 'running', 'queued'].includes(String(item.highlight_status || result.highlight_status || '').toLowerCase());
                return (
                  <tr key={item.item_id} className="align-top text-slate-200">
                    <td className="px-3 py-4"><input type="checkbox" checked={selectedQueueItemIds.includes(item.item_id)} onChange={() => toggleQueueItemSelection(item.item_id)} /></td>
                    <td className="px-3 py-4">
                      <div className="font-black text-white">{index + 1}</div>
                      <div className="text-xs text-slate-500">{item.item_id}</div>
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => openQueueItemOriginal(item)}
                          disabled={!originalUrl}
                          className="h-24 w-16 shrink-0 overflow-hidden rounded-xl bg-black/40 text-left ring-1 ring-white/10 transition hover:ring-[#c8ff00]/70 disabled:cursor-not-allowed disabled:hover:ring-white/10"
                          title={originalUrl ? '\uC6D0\uBCF8 YouTube \uB9C1\uD06C \uC5F4\uAE30' : '\uC6D0\uBCF8 URL \uC5C6\uC74C'}
                        >
                          {item.source_thumbnail || itemConfig.source_thumbnail ? <img className="h-full w-full object-cover" src={item.source_thumbnail || itemConfig.source_thumbnail} alt="source" /> : <div className="flex h-full items-center justify-center text-center text-xs text-slate-500">{'\uC18C\uC2A4 \uC5C6\uC74C'}</div>}
                        </button>
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => openQueueItemOriginal(item)}
                            disabled={!originalUrl}
                            className="block max-w-[170px] truncate text-left font-bold text-white hover:text-[#c8ff00] disabled:cursor-not-allowed disabled:hover:text-white"
                            title={originalUrl || item.source_file_original_name || itemConfig.source_file_original_name || ''}
                          >
                            {item.source_file_original_name || itemConfig.source_file_original_name || itemConfig.source_url || '-'}
                          </button>
                          <div className={item.source_exists ? 'mt-1 text-xs font-bold text-emerald-300' : 'mt-1 text-xs font-bold text-red-300'}>{item.source_exists ? '\uC18C\uC2A4 \uC788\uC74C' : '\uC18C\uC2A4 \uC5C6\uC74C'}</div>
                          <div className="text-xs text-slate-500">{formatDuration(metadata.duration_sec || itemConfig.target_duration_sec)}</div>
                          <label className="mt-2 block max-w-[170px] text-[11px] font-black text-slate-300">
                            출력 언어
                            <select
                              className="mt-1 w-full rounded-xl border border-white/10 bg-black/35 px-2 py-1.5 text-xs font-black text-[#c8ff00]"
                              value={normalizeTargetLocale(itemConfig.target_locale || item.target_locale)}
                              disabled={localeLocked}
                              onChange={(event) => updateQueueItem(index, { target_locale: normalizeTargetLocale(event.target.value) })}
                            >
                              {LOCALE_OPTIONS.map((locale) => <option key={locale.value} value={locale.value}>{locale.shortLabel} · {locale.label}</option>)}
                            </select>
                            {localeLocked ? <span className="mt-1 block text-[10px] font-bold text-slate-500">작업 중/완료 항목은 잠금</span> : null}
                          </label>
                          {(() => {
                            const badge = getSourceTypeBadge(item, itemConfig);
                            const reason = item.source_classification?.reason || itemConfig.source_classification?.reason || '';
                            return (
                              <div className="mt-2">
                                <div className={`inline-flex rounded-full border px-2 py-1 text-xs font-black ${badge.className}`}>{badge.label}</div>
                                {reason ? <div className="mt-1 max-w-[170px] text-[11px] leading-4 text-slate-500">{reason}</div> : null}
                              </div>
                            );
                          })()}
                          <button
                            type="button"
                            onClick={() => openQueueItemOriginal(item)}
                            disabled={!originalUrl}
                            className="mt-2 rounded-lg border border-[#c8ff00]/35 bg-[#c8ff00]/10 px-2 py-1 text-xs font-black text-[#c8ff00] disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-500"
                          >
                            {'\uC6D0\uBCF8 \uC5F4\uAE30'}
                          </button>
                          {(itemConfig.output_mode || item.output_mode) ? <div className={itemConfig.skip_full_draft || item.skip_full_draft ? 'mt-2 rounded-full bg-amber-300/15 px-2 py-1 text-xs font-black text-amber-100' : 'mt-2 rounded-full bg-emerald-300/10 px-2 py-1 text-xs font-black text-emerald-100'}>{itemConfig.output_mode || item.output_mode}</div> : null}
                          {(itemConfig.skip_full_draft_reason || item.skip_full_draft_reason) ? <div className="mt-1 max-w-[170px] text-xs leading-4 text-amber-200">{itemConfig.skip_full_draft_reason || item.skip_full_draft_reason}</div> : null}
                          {isLongformSource && highlightCandidates.length ? (
                            <div className="mt-3 max-w-[190px] rounded-2xl border border-amber-300/20 bg-amber-300/10 p-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] font-black text-amber-100">내부 후보 {visibleHighlightCandidates.length}개</div>
                                <div className="rounded-lg border border-[#c8ff00]/30 px-2 py-1 text-[10px] font-black text-[#c8ff00]">자동 사용</div>
                              </div>
                              <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
                                {visibleHighlightCandidates.map((candidate, candidateIndex) => {
                                  const candidateId = candidate.candidate_id || `highlight_${candidateIndex + 1}`;
                                  const isBest = candidateId === bestHighlightCandidateId || candidate === sortedHighlightCandidates[0];
                                  return (
                                    <div
                                      key={candidateId}
                                      className={isBest
                                        ? 'block w-full rounded-xl border border-[#c8ff00]/70 bg-[#c8ff00]/15 px-2 py-1 text-left text-[11px] leading-4 text-[#c8ff00]'
                                        : 'block w-full rounded-xl border border-white/5 bg-black/25 px-2 py-1 text-left text-[11px] leading-4 text-amber-50/80 hover:border-amber-300/45 hover:bg-amber-300/10'}
                                    >
                                      <span className="font-black text-amber-200">#{candidateIndex + 1}</span>
                                      <span className="ml-1">{candidate.start_sec}s~{candidate.end_sec}s</span>
                                      {isBest ? <span className="ml-1 font-black">HL</span> : <span className="ml-1 font-black text-amber-100/80">Full 재료</span>}
                                      {candidate.reason ? <span className="ml-1 text-amber-100/50">{candidate.reason}</span> : null}
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="mt-2 text-[11px] font-black text-[#c8ff00]">최고점 1개는 Highlight, 나머지 후보는 Full Draft 재료로 자동 사용합니다.</div>
                              {highlightCandidates.length > 8 ? <div className="mt-1 text-[11px] text-amber-100/60">+{highlightCandidates.length - 8}개 더 있음</div> : null}
                            </div>
                          ) : null}
                          {!isLongformSource ? <div className="mt-2 max-w-[190px] rounded-2xl border border-emerald-300/15 bg-emerald-300/10 px-2 py-2 text-[11px] leading-4 text-emerald-100/75">숏폼 소스는 후보 선택 없이 자동으로 하이라이트 1개를 추출합니다.</div> : null}
                          <div className="mt-3 max-w-[220px] rounded-2xl border border-lime-300/20 bg-lime-300/10 p-2">
                            <div className="text-[11px] font-black text-lime-100">Full aux 소스</div>
                            <input
                              className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-2 py-1 text-[11px] text-white placeholder:text-slate-500"
                              value={auxSourceUrl}
                              onChange={(event) => updateQueueItem(index, { aux_source_url: event.target.value, aux_source_video: 'source_aux.mp4' })}
                              placeholder="Full 교차편집용 YouTube URL"
                            />
                            <div className="mt-1 text-[10px] leading-4 text-lime-100/70">저장 후 Full Draft에만 사용됩니다. Highlight는 기존 소스를 유지합니다.</div>
                            <button
                              type="button"
                              disabled={!auxSourceUrl || serverQueueBusy}
                              onClick={() => downloadQueueAuxSource(item.item_id, auxSourceUrl)}
                              className="mt-2 rounded-lg border border-lime-300/35 bg-lime-300/10 px-2 py-1 text-[11px] font-black text-lime-100 disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-500"
                            >
                              aux 다운로드
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-4">
                      <textarea className="min-h-[72px] w-full min-w-[280px] rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white" value={firstBlock.text || itemConfig.explainer_text || ''} onChange={(event) => updateQueueExplainerText(index, event.target.value)} />
                      {itemConfig.korean_review?.explainer_text ? <div className="mt-2 rounded-xl bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">{itemConfig.korean_review.explainer_text}</div> : null}
                    </td>
                    <td className="px-3 py-4">
                      <select className="w-full min-w-[180px] rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white" value={itemConfig.video_transform_preset || processQueue?.queueConfig?.video_transform_preset || 'steady_zoom_process'} onChange={(event) => updateQueueItem(index, { video_transform_preset: event.target.value })}>
                        {videoTransformPresets.map((preset) => <option key={preset.preset_id} value={preset.preset_id}>{preset.name || preset.preset_id}</option>)}
                      </select>
                      <div className="mt-2 line-clamp-3 text-xs text-slate-500">{summarizeTransformOrder(getVideoTransformPreset(itemConfig.video_transform_preset || processQueue?.queueConfig?.video_transform_preset))}</div>
                    </td>
                    <td className="px-3 py-4">
                      <div className={item.status === 'failed' || result.status === 'failed' ? 'font-bold text-red-300' : item.status === 'success' || result.status === 'success' ? 'font-bold text-emerald-300' : 'font-bold text-slate-300'}>{formatStatus(result.status || item.status || 'pending')}</div>
                      {item.metadata_status ? <div className="mt-1 text-xs text-slate-500">Gemini: {item.metadata_status}</div> : null}
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex flex-col gap-2">
                        <input ref={(node) => { if (node) itemSourceInputRefs.current[item.item_id] = node; }} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" className="hidden" onChange={(event) => replaceQueueItemSource(item.item_id, event.target.files)} />
                        <button className="rounded-lg border border-white/15 bg-white/8 px-3 py-2 text-xs font-bold text-white" onClick={() => itemSourceInputRefs.current[item.item_id]?.click()}>소스 교체</button>
                        <button className="rounded-lg border border-white/15 bg-white/8 px-3 py-2 text-xs font-bold text-white" onClick={() => duplicateQueueItem(item.item_id)}>복제</button>
                        <button className="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-100" onClick={() => removeQueueItem(item.item_id)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">아직 항목이 없습니다. 소스 영상이나 YouTube URL을 추가하세요.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-[28px] border border-white/10 bg-[#0f1413] p-5 shadow-xl shadow-black/20">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.22em] text-[#c8ff00]">PROGRESS DETAILS</div>
            <h3 className="mt-1 text-xl font-black text-white">작업 진행 로그</h3>
            <p className="mt-1 text-sm text-slate-400">Gemini 분석 라인과 드래프트 생성 라인을 분리해, 롱폼 분석이 길어져도 드래프트만 재생성하는 작업은 별도 라인에서 진행할 수 있습니다.</p>
          </div>
          <div className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-black text-slate-200">
            {queueProgress.length ? queueProgress.length + '개 로그' : '대기 중'}
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-black text-white">{formatStatus(queueStatus)}</div>
                <div className="mt-1 text-xs text-slate-400">
                  {getJobLaneLabel(serverQueueJob)} / 단계: {serverQueueJob?.stage || activeWorkflowStep} / 현재 묶음 {targetCount || 0}개{hasBatchGroup ? ` / 전체 요청 ${batchTotalItemCount}개` : ''}{serverQueueJob?.draft_variant_mode === 'highlight_only' ? ' / 하이라이트만' : serverQueueJob?.draft_variant_mode === 'full_only' ? ' / 풀만' : serverQueueJob?.draft_variant_mode === 'midform_only' ? ' / 미드폼만' : serverQueueJob?.draft_variant_mode === STANDARD_BATCH_VARIANT_MODE ? ' / 풀+하이라이트' : ''}
                </div>
              </div>
              <div className="text-2xl font-black text-[#c8ff00]">{progressPercent}%</div>
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-[#c8ff00]" style={{ width: progressPercent + '%' }} /></div>
            {hasBatchGroup ? (
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
                <div className="rounded-xl border border-[#c8ff00]/25 bg-[#c8ff00]/10 px-3 py-2 text-[#eaff9a]">
                  <div className="font-black">묶음 {batchChunkIndex}/{batchChunkTotal}</div>
                  <div className="mt-1 opacity-80">현재 {batchChunkItemCount}개 처리</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-slate-300">
                  <div className="font-black">전체 요청</div>
                  <div className="mt-1">{batchTotalItemCount}개</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-slate-300">
                  <div className="font-black">현재 범위</div>
                  <div className="mt-1">{batchChunkStartIndex || '-'}~{batchChunkEndIndex || '-'}번째</div>
                </div>
                <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-amber-100">
                  <div className="font-black">남은 대기</div>
                  <div className="mt-1">{batchRemainingChunks}묶음 · {batchRemainingItems}개</div>
                </div>
              </div>
            ) : null}
            {serverQueueJob?.job_id ? (
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="break-all rounded-xl bg-black/20 px-3 py-2 text-slate-300">서버 작업: {serverQueueJob.job_id}</div>
                <div className={jobStalled ? 'rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-red-100' : 'rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-emerald-100'}>{workerHealthLabel} / 최신 로그 {lastLogAgeLabel}</div>
              </div>
            ) : null}
            {serverQueueJob?.last_log_message ? <div className="mt-3 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-slate-300">최신 로그: {serverQueueJob.last_log_message}</div> : null}
            {getJobQueueReason(serverQueueJob) ? <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">대기 이유: {getJobQueueReason(serverQueueJob)}</div> : null}
            {jobStalled ? <div className="mt-3 rounded-2xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{stallThresholdLabel} 이상 새 로그가 없거나 작업자 프로세스가 보이지 않습니다. 작업 중지 후 실패 항목만 다시 실행할 수 있습니다.</div> : null}
            {terminalServerJob ? (
              <div className={failedServerJobItems.length || warningServerJobItems.length ? 'mt-3 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-50' : 'mt-3 rounded-2xl border border-emerald-300/25 bg-emerald-300/10 p-3 text-sm text-emerald-50'}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-black">작업 종료: {formatStatus(serverQueueJob.status)}{serverJobFinishedAt ? <span className="ml-2 text-xs font-medium opacity-70">{serverJobFinishedAt}</span> : null}</div>
                  <div className="text-xs font-bold opacity-80">드래프트 성공 {serverQueueJob?.job_summary?.draft_success_count ?? Math.max(0, serverJobItems.length - failedServerJobItems.length)}개 / 경고 {warningServerJobItems.length}개 / 실패 {failedServerJobItems.length}개</div>
                </div>
                {warningServerJobItems.length ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-black uppercase tracking-[0.16em] text-amber-100">분석 일부 실패 / 드래프트 보존</div>
                    {warningServerJobItems.map((item) => (
                      <FailureDecisionCard key={item.item_id} item={item} warning />
                    ))}
                  </div>
                ) : null}
                {failedServerJobItems.length ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-black uppercase tracking-[0.16em] text-red-100">실패 항목</div>
                    {failedServerJobItems.map((item) => <FailureDecisionCard key={item.item_id} item={item} />)}
                  </div>
                ) : null}
              </div>
            ) : null}
            {serverQueueBusy ? <button className="mt-3 w-full rounded-xl border border-red-400/40 bg-red-500/15 px-4 py-2 text-sm font-black text-red-100" onClick={cancelServerQueueJob}>현재 서버 작업 중지</button> : null}
            {serverQueueBusy ? <div className="mt-2 text-xs text-amber-100">현재 처리 중인 항목이 끝난 뒤 안전하게 중단됩니다.</div> : null}
            {!serverQueueBusy && (failedServerJobItems.length || warningServerJobItems.length) ? (
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {retryableFailedCount ? <button className="rounded-xl border border-rose-300/50 bg-rose-300/15 px-4 py-2 text-sm font-black text-rose-50 hover:brightness-110" onClick={runFailedVariantMetadataAndDraft}>실패 자동 분류 재시도 {retryableFailedCount}</button> : null}
                {failedVariantItemIds.highlight?.length ? <button className="rounded-xl border border-amber-300/40 bg-amber-300/15 px-4 py-2 text-sm font-black text-amber-50 hover:brightness-110" onClick={() => runFailedVariantMetadataAndDraftForVariant('highlight')}>Highlight 실패 재시도 {failedVariantItemIds.highlight.length}</button> : null}
                {failedVariantItemIds.full?.length ? <button className="rounded-xl border border-lime-300/40 bg-lime-300/15 px-4 py-2 text-sm font-black text-lime-50 hover:brightness-110" onClick={() => runFailedVariantMetadataAndDraftForVariant('full')}>Full 실패 재시도 {failedVariantItemIds.full.length}</button> : null}
                {failedVariantItemIds.midform?.length ? <button className="rounded-xl border border-cyan-300/40 bg-cyan-300/15 px-4 py-2 text-sm font-black text-cyan-50 hover:brightness-110" onClick={() => runFailedVariantMetadataAndDraftForVariant('midform')}>Midform 실패 재시도 {failedVariantItemIds.midform.length}</button> : null}
                {metadataFailedServerJobItems.length ? <button className="rounded-xl border border-rose-300/40 bg-rose-300/10 px-4 py-2 text-sm font-black text-rose-50 hover:brightness-110" onClick={retryMetadataWarningItems}>남은 분석 실패 전체 재시도</button> : null}
                {failedServerJobItems.some((item) => item.draft_status === 'failed') ? <button className="rounded-xl border border-white/15 bg-white/8 px-4 py-2 text-sm font-black text-white hover:border-[#c8ff00]/50" onClick={regenerateFailedDraftItems}>드래프트 실패만 재생성</button> : null}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3"><div className="text-xs text-emerald-100">성공 로그</div><div className="mt-1 text-xl font-black text-emerald-200">{queueProgressStats.success || 0}</div></div>
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3"><div className="text-xs text-amber-100">경고 로그</div><div className="mt-1 text-xl font-black text-amber-200">{queueProgressStats.warning || 0}</div></div>
            <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-3"><div className="text-xs text-red-100">오류 로그</div><div className="mt-1 text-xl font-black text-red-200">{queueProgressStats.error || 0}</div></div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3"><div className="text-xs text-slate-300">선택 항목</div><div className="mt-1 text-xl font-black text-slate-100">{selectedQueueItemIds.length}</div></div>
          </div>
        </div>
        {serverQueueJob?.totals ? <div className="mt-4 grid gap-2 text-xs md:grid-cols-3"><div className="rounded-xl bg-white/[0.04] px-3 py-2 text-slate-300">다운로드: 성공 {serverQueueJob.totals.download?.success || 0} / 실패 {serverQueueJob.totals.download?.failed || 0}</div><div className="rounded-xl bg-white/[0.04] px-3 py-2 text-slate-300">Gemini: 성공 {serverQueueJob.totals.metadata?.success || 0} / 실패 {serverQueueJob.totals.metadata?.failed || 0}</div><div className="rounded-xl bg-white/[0.04] px-3 py-2 text-slate-300">드래프트: 성공 {serverQueueJob.totals.draft?.success || 0} / 실패 {serverQueueJob.totals.draft?.failed || 0}</div></div> : null}
        {queueProgress.length ? <div className="mt-4 max-h-72 space-y-2 overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3">{queueProgress.map((entry) => <div key={entry.id} className={entry.level === 'error' ? 'rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-red-100' : entry.level === 'warning' ? 'rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-amber-100' : entry.level === 'success' ? 'rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-emerald-100' : 'rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-300'}><span className="mr-2 font-mono text-xs text-slate-500">{entry.time}</span>{entry.itemId ? <span className="mr-2 font-semibold text-[#c8ff00]">[{entry.itemId}]</span> : null}<span>{entry.message}</span></div>)}</div> : null}
        {queueError ? <div className="mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">{queueError}</div> : null}
        {queueResult ? (
          <div className="mt-4 rounded-2xl border border-[#c8ff00]/30 bg-[#101807] p-4 text-sm text-slate-100 shadow-[0_0_0_1px_rgba(200,255,0,0.08),0_18px_60px_rgba(0,0,0,0.35)]">
            <div className="font-black text-[#c8ff00]">{"\uC0DD\uC131 \uACB0\uACFC"}: {queueResult.batchId}</div>
            <div className="mt-1 text-slate-200">성공: {queueResult.report?.success_count || 0} / 경고: {queueResult.report?.warning_count || 0} / 실패: {queueResult.report?.failed_count || 0}</div>
            <div className="mt-2 break-all text-slate-300">{"\uCEA1\uCEF7 \uB4DC\uB798\uD504\uD2B8 \uD3F4\uB354"}: {queueResult.report?.capcut_draft_root || queueResult.report?.output_root || queueResult.capcutDraftRoot || '-'}</div>
            <div className="break-all text-slate-400">{"\uB9AC\uD3EC\uD2B8"}: {queueResult.reportPath || '-'}</div>
            <div className="mt-4 space-y-2">{(queueResult.report?.items || []).map((item) => {
              const highlightOutputs = Array.isArray(item.highlight_outputs) && item.highlight_outputs.length
                ? item.highlight_outputs
                : (item.highlight_output_folder ? [{ highlight_index: 1, output_folder: item.highlight_output_folder, source_window: item.highlight_source_window }] : []);
              return (
                <div key={item.item_id} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2"><span className="font-bold text-white">{item.item_id}</span><span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-slate-200">{formatStatus(item.status)}</span></div>
                  {item.skip_full_draft ? <div className="break-all text-amber-100"><span className="mr-2 font-bold text-amber-200">full skipped</span>{item.skip_full_draft_reason || item.output_mode || 'highlight_only'}</div> : null}
                  {item.output_folder ? <div className="break-all text-lime-100"><span className="mr-2 font-bold text-[#c8ff00]">full</span>{item.output_folder}</div> : null}
                  {highlightOutputs.map((highlight) => (
                    <div key={`${item.item_id}-highlight-${highlight.highlight_index || highlight.output_folder}`} className="break-all text-amber-100">
                      <span className="mr-2 font-bold text-amber-200">highlight {highlight.highlight_index || 1}</span>
                      {highlight.output_folder}
                      {highlight.source_window ? <span className="ml-2 text-xs text-amber-100/70">({highlight.source_window.start_sec}s~{highlight.source_window.end_sec}s)</span> : null}
                    </div>
                  ))}
                  {item.midform_output_folder ? <div className="break-all text-cyan-100"><span className="mr-2 font-bold text-cyan-200">midform</span>{item.midform_output_folder}</div> : null}
                  {item.midform_status === 'skipped' ? <div className="break-all text-slate-300"><span className="mr-2 font-bold text-slate-200">midform skipped</span>{item.midform_skip_reason || 'midform was skipped'}</div> : null}
                  {item.final_mp4_path ? <div className="break-all text-sky-100"><span className="mr-2 font-bold text-sky-200">final.mp4</span>{item.final_mp4_path}</div> : null}
                </div>
              );
            })}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
