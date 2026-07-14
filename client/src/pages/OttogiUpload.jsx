import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';

const API = '/api/youtube-upload';
const UPLOAD_WORKSPACE_KEY = 'ottogi.youtubeUpload.workspace.v2';
const DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI = 'http://localhost:3001/api/youtube-upload/oauth/callback';

const CHANNEL_PURPOSES = [
  { value: 'jp_full', label: 'JP Full' },
  { value: 'jp_highlight', label: 'JP Highlight' },
  { value: 'jp_midform', label: 'JP Midform' },
  { value: 'ko_full', label: 'KR Full' },
  { value: 'ko_highlight', label: 'KR Highlight' }
];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '-';
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(value / 1024))}KB`;
}

function formatDate(value) {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return value;
  }
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

function uploadDateKey(item = {}) {
  return item.uploadDateKey
    || item.dateKey
    || dateKeyFromFilename(item.originalName || item.filePath || item.finalMp4Path)
    || dateKeyFromValue(item.uploadedAt)
    || dateKeyFromValue(item.publishAt)
    || dateKeyFromValue(item.modifiedAt)
    || dateKeyFromValue(item.updatedAt)
    || dateKeyFromValue(item.createdAt)
    || 'unknown';
}

function formatDateGroupLabel(dateKey) {
  if (!dateKey || dateKey === 'unknown') return '날짜 없음';
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short'
    }).format(new Date(`${dateKey}T00:00:00`));
  } catch {
    return dateKey;
  }
}

function groupByUploadDate(items = []) {
  const map = new Map();
  for (const item of items || []) {
    const key = uploadDateKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return b.localeCompare(a);
    })
    .map(([dateKey, rows]) => ({ dateKey, label: formatDateGroupLabel(dateKey), items: rows }));
}

const VARIANT_ORDER = ['full', 'highlight', 'ko_full', 'ko_highlight', 'midform', 'unknown'];

function variantCountsForItems(items = []) {
  return (items || []).reduce((acc, item) => {
    const variant = candidateVariant(item);
    acc[variant] = (acc[variant] || 0) + 1;
    return acc;
  }, {});
}

function VariantCountChips({ items }) {
  const counts = variantCountsForItems(items || []);
  return (
    <div className="flex flex-wrap gap-1">
      {VARIANT_ORDER.filter((variant) => counts[variant]).map((variant) => (
        <span key={variant} className={`rounded-full border px-2 py-1 text-[10px] font-black ${variantBadgeClass(variant)}`}>
          {variantLabel(variant)} {counts[variant]}
        </span>
      ))}
    </div>
  );
}

function pendingFileDateKey(file) {
  return dateKeyFromFilename(file?.name || '')
    || dateKeyFromValue(file?.lastModified)
    || 'unknown';
}

function groupPendingFilesByDate(items = []) {
  const map = new Map();
  for (const file of items || []) {
    const key = pendingFileDateKey(file);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(file);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return b.localeCompare(a);
    })
    .map(([dateKey, rows]) => {
      const videoCount = rows.filter(isVideoFile).length;
      const txtCount = rows.filter(isTxtFile).length;
      const variantCounts = rows.filter(isVideoFile).reduce((acc, file) => {
        const variant = detectUploadVariantFromName(file.name);
        acc[variant] = (acc[variant] || 0) + 1;
        return acc;
      }, {});
      return {
        dateKey,
        label: formatDateGroupLabel(dateKey),
        items: rows,
        videoCount,
        txtCount,
        variantCounts,
        sizeBytes: rows.reduce((sum, file) => sum + Number(file.size || 0), 0)
      };
    });
}

function toTagText(tags) {
  return Array.isArray(tags) ? tags.map((tag) => `#${String(tag).replace(/^#/, '')}`).join(' ') : String(tags || '');
}

function stripLeadingUploadTitleMarker(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*•]\s*)?(?:\d{1,2}|[０-９]{1,2})\s*[.)．、:-]\s*/u, '')
    .replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '')
    .trim();
}

function stripReviewOnlySections(value) {
  const text = String(value || '');
  const patterns = [
    /^\s*<!--\s*REVIEW_VARIANT:/im,
    /^\s*#{1,6}\s*Korean\s*review.*$/im,
    /^\s*#{1,6}\s*한국어\s*(?:검수|검토|리뷰|번역|보기|확인|참고).*$/im
  ];
  const indexes = patterns
    .map((pattern) => {
      const match = text.match(pattern);
      return typeof match?.index === 'number' ? match.index : -1;
    })
    .filter((index) => index >= 0);
  const cutAt = indexes.length ? Math.min(...indexes) : -1;
  return (cutAt >= 0 ? text.slice(0, cutAt) : text).trim();
}

function fromTagText(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#/, '').trim())
    .filter(Boolean);
}

function plusMinutesLocal(base, minutes) {
  const date = new Date(base);
  date.setMinutes(date.getMinutes() + Number(minutes || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultScheduleBaseLocal() {
  return plusMinutesLocal(new Date(), 60);
}

function isVideoFile(file) {
  return file?.type?.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file?.name || '');
}

function isTxtFile(file) {
  return /\.txt$/i.test(file?.name || '') || file?.type === 'text/plain';
}

function detectUploadVariantFromName(name = '') {
  const raw = String(name || '');
  const value = raw.toLowerCase();
  const koreanSuffix = /_ko(?:\.[^.]+)?$/i.test(raw);
  const koreanText = /[\p{Script=Hangul}]/u.test(raw);
  if (/-m-/i.test(raw) || /(^|[_\s-])m($|[_\s-])/i.test(raw) || /midform|middle|2min|120/.test(value)) return 'midform';
  if (/-kh-/i.test(raw) || /(^|[_\s-])kh($|[_\s-])/i.test(raw) || /ko[_\s-]*highlight|kr[_\s-]*highlight|korean[_\s-]*highlight/.test(value)) return 'ko_highlight';
  if (/-kf-/i.test(raw) || /(^|[_\s-])kf($|[_\s-])/i.test(raw) || /ko[_\s-]*full|kr[_\s-]*full|korean[_\s-]*full/.test(value)) return 'ko_full';
  if (koreanSuffix && (/-h-/i.test(raw) || /(^|[_\s-])h($|[_\s-])/i.test(raw) || /highlight|hi-lite|hook|hl/.test(value))) return 'ko_highlight';
  if (koreanSuffix && (/-f-/i.test(raw) || /(^|[_\s-])f($|[_\s-])/i.test(raw) || /full|process|draft/.test(value))) return 'ko_full';
  if (koreanText && (/-h-/i.test(raw) || /(^|[_\s-])h($|[_\s-])/i.test(raw) || /highlight|hi-lite|hook|hl/.test(value))) return 'ko_highlight';
  if (koreanText && (/-f-/i.test(raw) || /(^|[_\s-])f($|[_\s-])/i.test(raw) || /full|process|draft/.test(value))) return 'ko_full';
  if (/-h-/i.test(raw) || /(^|[_\s-])h($|[_\s-])/i.test(raw) || /highlight|hi-lite|hook|hl/.test(value)) return 'highlight';
  if (/-f-/i.test(raw) || /(^|[_\s-])f($|[_\s-])/i.test(raw) || /full|process|draft/.test(value)) return 'full';
  return 'unknown';
}

function variantLabel(variant) {
  if (variant === 'ko_full') return 'KR Full';
  if (variant === 'ko_highlight') return 'KR Highlight';
  if (variant === 'midform') return 'JP Midform';
  if (variant === 'full') return 'JP Full';
  if (variant === 'highlight') return 'JP Highlight';
  return 'Unknown';
}

function variantBadgeClass(variant) {
  if (variant === 'ko_full') return 'border-emerald-300/35 bg-emerald-300/10 text-emerald-100';
  if (variant === 'ko_highlight') return 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100';
  if (variant === 'midform') return 'border-blue-300/35 bg-blue-300/10 text-blue-100';
  if (variant === 'full') return 'border-lime-300/35 bg-lime-300/10 text-lime-100';
  if (variant === 'highlight') return 'border-sky-300/35 bg-sky-300/10 text-sky-100';
  return 'border-amber-300/35 bg-amber-300/10 text-amber-100';
}

function normalizeCardKey(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase().trim();
}

function uploadCardKeys(item = {}) {
  return [
    item.cardId,
    item.id,
    item.finalMp4Path,
    item.filePath,
    item.originalName
  ].map(normalizeCardKey).filter(Boolean);
}

function uploadProfileKey(itemOrId = {}) {
  if (typeof itemOrId === 'string') return itemOrId.trim();
  return String(itemOrId.uploadProfileId || itemOrId.profileId || '').trim();
}

function matchesUploadProfile(item = {}, selectedProfileId = '') {
  const selected = uploadProfileKey(selectedProfileId);
  const itemProfile = uploadProfileKey(item);
  if (!selected) return false;
  if (selected === 'legacy_default') return !itemProfile || itemProfile === 'legacy_default';
  return itemProfile === selected;
}

function uploadStatusLabel(status) {
  if (status === 'uploaded' || status === 'success') return '완료';
  if (status === 'pending') return '보류';
  if (status === 'queued') return '대기';
  if (status === 'uploading') return '업로드 중';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '취소됨';
  return '매칭됨';
}

function uploadStatusClass(status) {
  if (status === 'uploaded' || status === 'success') return 'border-[#c8ff00]/45 bg-[#c8ff00]/15 text-[#c8ff00]';
  if (status === 'pending') return 'border-amber-300/45 bg-amber-300/15 text-amber-100';
  if (status === 'queued' || status === 'uploading') return 'border-sky-300/45 bg-sky-300/15 text-sky-100';
  if (status === 'failed' || status === 'cancelled') return 'border-red-300/45 bg-red-300/15 text-red-100';
  return 'border-white/15 bg-white/8 text-slate-200';
}

function isActiveUploadJob(status) {
  return ['queued', 'running', 'cancelling'].includes(String(status || ''));
}

function fileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function loadUploadWorkspace() {
  try {
    const raw = window.localStorage.getItem(UPLOAD_WORKSPACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveUploadWorkspace(data) {
  try {
    window.localStorage.setItem(UPLOAD_WORKSPACE_KEY, JSON.stringify(data));
  } catch {
    // Browser storage can be unavailable. The upload flow still works in memory.
  }
}

function clearUploadWorkspace() {
  try {
    window.localStorage.removeItem(UPLOAD_WORKSPACE_KEY);
  } catch {
    // Ignore storage cleanup errors.
  }
}

function humanizeWarning(warning) {
  const text = String(warning || '');
  const match = text.match(/TXT metadata not matched for (.*?);/i);
  if (match) return `TXT\uAC00 \uB9E4\uCE6D\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${match[1]} - \uD30C\uC77C\uBA85 \uAE30\uBC18 \uC81C\uBAA9\uB9CC \uC784\uC2DC\uB85C \uCC44\uC6E0\uC2B5\uB2C8\uB2E4.`;
  if (/No video files uploaded/i.test(text)) return '\uC601\uC0C1 \uD30C\uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. MP4/MOV/WEBM \uD30C\uC77C\uC744 \uCD94\uAC00\uD574\uC8FC\uC138\uC694.';
  return text;
}

function getEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function collectEntryFiles(entry) {
  if (!entry) return [];
  if (entry.isFile) return [await getEntryFile(entry)];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const allEntries = [];
  let batch = [];
  do {
    batch = await readDirectoryEntries(reader);
    allEntries.push(...batch);
  } while (batch.length > 0);
  const nested = await Promise.all(allEntries.map(collectEntryFiles));
  return nested.flat();
}

async function getDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    const nested = await Promise.all(entries.map(collectEntryFiles));
    return nested.flat();
  }
  return Array.from(dataTransfer?.files || []);
}

function purposeLabel(value) {
  const normalized = normalizePurpose(value);
  return CHANNEL_PURPOSES.find((purpose) => purpose.value === normalized)?.label || normalized || '\uBBF8\uC9C0\uC815';
}

function normalizePurpose(value) {
  const raw = String(value || '');
  if (raw === 'highlight') return 'jp_highlight';
  if (raw === 'midform') return 'jp_midform';
  if (raw === 'full_draft' || raw === 'full') return 'jp_full';
  if (raw === 'ko_full_draft' || raw === 'kr_full' || raw === 'korean_full') return 'ko_full';
  if (raw === 'ko_highlight_draft' || raw === 'kr_highlight' || raw === 'korean_highlight') return 'ko_highlight';
  if (raw === 'legacy_env' || raw === 'archive') return '';
  return raw;
}

function variantForPurpose(value) {
  const purpose = normalizePurpose(value);
  if (purpose === 'jp_full') return 'full';
  if (purpose === 'jp_highlight') return 'highlight';
  if (purpose === 'jp_midform') return 'midform';
  if (purpose === 'ko_full') return 'ko_full';
  if (purpose === 'ko_highlight') return 'ko_highlight';
  return '';
}

function candidateVariant(candidate = {}) {
  return candidate.variant || detectUploadVariantFromName(candidate.originalName || candidate.finalMp4Path || candidate.filePath);
}

function ReviewBlock({ review }) {
  if (!review?.rawText) return null;
  return (
    <details className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-50">
      <summary className="cursor-pointer text-sm font-black text-amber-200">
        {'\uD55C\uAD6D\uC5B4 \uAC80\uC218\uC6A9 \uBCF4\uAE30'}
        <span className="ml-2 text-[11px] font-medium text-amber-100/70">{'\uC5C5\uB85C\uB4DC \uC124\uBA85\uC5D0\uB294 \uD3EC\uD568\uB418\uC9C0 \uC54A\uC74C'}</span>
      </summary>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {review.caption ? (
          <div className="rounded-xl bg-black/25 p-3">
            <div className="mb-1 text-xs font-black text-amber-200">{'\uD654\uBA74 \uC790\uB9C9 \uBC88\uC5ED'}</div>
            <div className="max-h-32 overflow-auto whitespace-pre-wrap leading-5">{review.caption}</div>
          </div>
        ) : null}
        {review.titles ? (
          <div className="rounded-xl bg-black/25 p-3">
            <div className="mb-1 text-xs font-black text-amber-200">{'\uC81C\uBAA9 \uBC88\uC5ED'}</div>
            <div className="max-h-32 overflow-auto whitespace-pre-wrap leading-5">{review.titles}</div>
          </div>
        ) : null}
        {review.reportDescription ? (
          <div className="rounded-xl bg-black/25 p-3">
            <div className="mb-1 text-xs font-black text-amber-200">{'\uB9AC\uD3EC\uD2B8 \uC124\uBA85 \uBC88\uC5ED'}</div>
            <div className="max-h-32 overflow-auto whitespace-pre-wrap leading-5">{review.reportDescription}</div>
          </div>
        ) : null}
      </div>
      {!review.caption && !review.titles && !review.reportDescription ? (
        <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-xl bg-black/25 p-3 text-xs leading-5">
          {review.rawText}
        </pre>
      ) : null}
    </details>
  );
}

function ProfileCard({
  profile,
  active,
  draftName,
  draftPurpose,
  draftClientId,
  draftClientSecret,
  draftRedirectUri,
  onSelect,
  onSave,
  onDelete,
  onNameChange,
  onPurposeChange,
  onClientIdChange,
  onClientSecretChange,
  onRedirectUriChange,
  onReconnect
}) {
  const clientConfigured = Boolean(
    (draftClientId || profile.oauthClientId)
    && (draftClientSecret || profile.maskedOAuthClientSecret)
    && (draftRedirectUri || profile.oauthRedirectUri)
  );

  return (
    <article className={`rounded-2xl border p-4 transition ${active ? 'border-[#c8ff00]/70 bg-[#c8ff00]/10 shadow-[0_0_30px_rgba(200,255,0,0.12)]' : 'border-white/10 bg-white/[0.04] hover:border-white/20'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-[10px] font-black ${active ? 'bg-[#c8ff00] text-black' : 'bg-white/10 text-slate-200'}`}>
              {active ? '선택됨' : '채널'}
            </span>
            <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-300">{purposeLabel(profile.purpose)}</span>
          </div>
          <div className="mt-2 truncate text-base font-black text-white">{profile.channelTitle || '채널 확인 전'}</div>
          <div className="mt-1 break-all text-xs text-slate-500">{profile.channelId || profile.id}</div>
        </div>
        <button type="button" className="rounded-xl border border-[#c8ff00]/40 px-3 py-2 text-xs font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => onSelect(profile.id)}>
          선택
        </button>
      </div>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-bold text-slate-300">관리 이름</span>
        <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={draftName} placeholder="예: 일본어 하이라이트 채널" onChange={(event) => onNameChange(profile.id, event.target.value)} />
      </label>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-bold text-slate-300">채널 용도</span>
        <select className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={normalizePurpose(draftPurpose || profile.purpose || '')} onChange={(event) => onPurposeChange(profile.id, event.target.value)}>
          <option value="">미지정</option>
          {CHANNEL_PURPOSES.map((purpose) => (<option key={purpose.value} value={purpose.value}>{purpose.label}</option>))}
        </select>
      </label>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-bold text-slate-300">OAuth Client ID</span>
        <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={draftClientId} placeholder="1234567890-xxxx.apps.googleusercontent.com" onChange={(event) => onClientIdChange(profile.id, event.target.value)} />
      </label>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-bold text-slate-300">OAuth Client Secret</span>
        <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={draftClientSecret} placeholder={profile.maskedOAuthClientSecret ? `${profile.maskedOAuthClientSecret} (변경 없으면 비워둠)` : 'GOCSPX-...'} onChange={(event) => onClientSecretChange(profile.id, event.target.value)} />
      </label>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-bold text-slate-300">Redirect URI</span>
        <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={draftRedirectUri} placeholder={DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI} onChange={(event) => onRedirectUriChange(profile.id, event.target.value)} />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className="rounded-xl border border-white/15 px-3 py-2 text-xs font-bold text-white hover:bg-white/10" onClick={() => onSave(profile.id)}>저장</button>
        <button type="button" className="rounded-xl border border-red-400/35 px-3 py-2 text-xs font-bold text-red-200 hover:bg-red-500/10" onClick={() => onDelete(profile.id)}>제거</button>
      </div>

      <button type="button" className="mt-2 w-full rounded-xl border border-[#c8ff00]/35 px-3 py-2 text-xs font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => onReconnect(profile.id)}>
        재연결
      </button>

      <div className="mt-3 space-y-1 text-xs text-slate-400">
        <div>표시 이름: {profile.name || '-'}</div>
        <div>클라이언트: {profile.oauthClientIdHint || (draftClientId ? `${draftClientId.slice(0, 12)}...` : '-')}</div>
        <div>토큰: {profile.maskedRefreshToken || '미연결'}</div>
        <div className={clientConfigured ? 'text-slate-400' : 'text-amber-200'}>{clientConfigured ? 'OAuth 클라이언트 설정됨' : 'OAuth 클라이언트 설정 필요'}</div>
        <div>수정: {formatDate(profile.updatedAt)}</div>
      </div>
    </article>
  );
}

function SmallCardList({ title, subtitle, count, items, emptyText, accent = 'lime', onRestore, onDelete, onDeleteDate, onRefresh, onOpen }) {
  const palette = accent === 'amber'
    ? 'border-amber-300/25 bg-amber-300/8 text-amber-100'
    : 'border-lime-300/20 bg-lime-300/8 text-lime-100';
  const dateGroups = groupByUploadDate(items || []);
  return (
    <div className={`rounded-[26px] border p-5 ${palette}`}>
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-black text-white">{title}</h2><p className="mt-1 text-xs leading-5 opacity-80">{subtitle}</p></div>
        {onRefresh ? <button type="button" className="rounded-xl border border-white/15 px-3 py-2 text-xs font-black text-white hover:bg-white/10" onClick={onRefresh}>{'\uC0C8\uB85C\uACE0\uCE68'}</button> : null}
      </div>
      <div className="mt-3 text-3xl font-black text-[#c8ff00]">{count}</div>
      {items?.length && onRestore ? <button type="button" className="mt-3 w-full rounded-xl bg-[#c8ff00] px-3 py-2 text-xs font-black text-black hover:brightness-110" onClick={() => onRestore(items.map((item) => item.cardId || item.id))}>{'\uC804\uCCB4 \uBD88\uB7EC\uC624\uAE30'}</button> : null}
      <div className="mt-3 max-h-[320px] space-y-3 overflow-auto pr-1">
        {dateGroups.length ? dateGroups.map((group) => (
          <section key={group.dateKey} className="rounded-2xl border border-white/10 bg-black/20 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-black text-white">{group.label} <span className="text-[#c8ff00]">{group.items.length}</span></div>
                <div className="mt-1"><VariantCountChips items={group.items} /></div>
              </div>
              <div className="flex flex-wrap gap-1">
                {onRestore ? (
                  <button type="button" className="rounded-lg border border-[#c8ff00]/30 px-2 py-1 text-[11px] font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => onRestore(group.items.map((item) => item.cardId || item.id))}>
                    날짜 불러오기
                  </button>
                ) : null}
                {onDeleteDate ? (
                  <button type="button" className="rounded-lg border border-red-300/30 px-2 py-1 text-[11px] font-black text-red-100 hover:bg-red-500/10" onClick={() => onDeleteDate(group.dateKey)}>
                    날짜 삭제
                  </button>
                ) : null}
              </div>
            </div>
            <div className="space-y-2">
              {group.items.slice(0, 20).map((item) => (
                <div key={`${item.cardId || item.id}-${item.youtubeVideoId || ''}`} className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs">
                  <button type="button" className="block w-full text-left" onClick={() => onOpen?.(item)}>
                    <div className="line-clamp-2 font-black text-white">{item.title || item.originalName || item.id}</div>
                    <div className="mt-1 text-slate-400">{formatDate(item.uploadedAt || item.updatedAt || item.modifiedAt)} {' · '} {'예약'} {item.publishAt || '-'}</div>
                    {item.youtubeUrl ? <div className="mt-1 text-[#c8ff00]">{item.youtubeUrl}</div> : null}
                    {item.pendingReason || item.reason ? <div className="mt-1 text-amber-100/80">{item.pendingReason || item.reason}</div> : null}
                  </button>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {onRestore ? <button type="button" className="rounded-lg border border-[#c8ff00]/30 px-2 py-1 font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => onRestore([item.cardId || item.id])}>{'\uD6C4\uBCF4\uB85C \uBD88\uB7EC\uC624\uAE30'}</button> : null}
                    {onDelete ? <button type="button" className="rounded-lg border border-red-300/30 px-2 py-1 font-black text-red-100 hover:bg-red-500/10" onClick={() => onDelete(item.cardId || item.id)}>기록 삭제</button> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )) : <div className="rounded-xl border border-white/10 bg-black/25 p-3 text-xs text-slate-400">{emptyText}</div>}
      </div>
    </div>
  );
}

export default function OttogiUpload() {
  const fileInputRef = useRef(null);
  const videoFolderInputRef = useRef(null);
  const metadataFolderInputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [formMap, setFormMap] = useState({});
  const [status, setStatus] = useState('대기 중');
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [job, setJob] = useState(null);
  const [authInfo, setAuthInfo] = useState(null);
  const [oauthUrl, setOauthUrl] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [profileDraftNames, setProfileDraftNames] = useState({});
  const [profileDraftPurposes, setProfileDraftPurposes] = useState({});
  const [profileDraftClientIds, setProfileDraftClientIds] = useState({});
  const [profileDraftClientSecrets, setProfileDraftClientSecrets] = useState({});
  const [profileDraftRedirectUris, setProfileDraftRedirectUris] = useState({});
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [newProfileName, setNewProfileName] = useState('새 업로드 채널');
  const [newProfilePurpose, setNewProfilePurpose] = useState('');
  const [newProfileClientId, setNewProfileClientId] = useState('');
  const [newProfileClientSecret, setNewProfileClientSecret] = useState('');
  const [newProfileRedirectUri, setNewProfileRedirectUri] = useState(DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI);
  const [scheduleBase, setScheduleBase] = useState('');
  const [scheduleInterval, setScheduleInterval] = useState(120);
  const [matchingFiles, setMatchingFiles] = useState(false);
  const [matchProgress, setMatchProgress] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [previewCandidate, setPreviewCandidate] = useState(null);
  const [variantFilter, setVariantFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [uploadHistory, setUploadHistory] = useState([]);
  const [pendingUploads, setPendingUploads] = useState([]);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [uploadCards, setUploadCards] = useState([]);
  const workspaceRestoredRef = useRef(false);

  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.id)),
    [candidates, selected]
  );

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const selectedProfilePurpose = normalizePurpose(selectedProfile?.purpose || profileDraftPurposes[selectedProfileId] || '');
  const selectedProfileVariant = variantForPurpose(selectedProfilePurpose);
  const uploadBusy = isActiveUploadJob(job?.status);

  const pendingVariantCounts = useMemo(() => files.filter(isVideoFile).reduce((acc, file) => {
    const variant = detectUploadVariantFromName(file.name);
    acc[variant] = (acc[variant] || 0) + 1;
    return acc;
  }, { full: 0, highlight: 0, midform: 0, ko_full: 0, ko_highlight: 0, unknown: 0 }), [files]);

  const pendingDateGroups = useMemo(() => groupPendingFilesByDate(files), [files]);

  const candidateVariantCounts = useMemo(() => candidates.reduce((acc, candidate) => {
    const variant = candidate.variant || detectUploadVariantFromName(candidate.originalName);
    acc[variant] = (acc[variant] || 0) + 1;
    return acc;
  }, { full: 0, highlight: 0, midform: 0, ko_full: 0, ko_highlight: 0, unknown: 0 }), [candidates]);

  const candidateDateGroups = useMemo(() => groupByUploadDate(candidates), [candidates]);

  const visibleCandidates = useMemo(() => {
    return candidates.filter((candidate) => {
      if (variantFilter !== 'all' && candidateVariant(candidate) !== variantFilter) return false;
      if (dateFilter !== 'all' && uploadDateKey(candidate) !== dateFilter) return false;
      return true;
    });
  }, [candidates, variantFilter, dateFilter]);

  const visibleCandidateDateGroups = useMemo(() => groupByUploadDate(visibleCandidates), [visibleCandidates]);

  const selectedVariantMismatches = useMemo(() => {
    if (!selectedProfileVariant) return [];
    return selectedCandidates.filter((candidate) => candidateVariant(candidate) !== selectedProfileVariant);
  }, [selectedCandidates, selectedProfileVariant]);

  const uploadBlockedReason = useMemo(() => {
    if (!selectedCandidates.length) return '업로드할 영상을 선택해주세요.';
    if (!selectedProfileId) return '업로드할 YouTube 채널 프로필을 먼저 선택해주세요.';
    if (!selectedProfileVariant) return '선택한 채널 프로필의 용도를 JP Full / JP Highlight / JP Midform / KR Full / KR Highlight 중 하나로 지정해주세요.';
    if (selectedVariantMismatches.length) {
      return `선택 채널은 ${variantLabel(selectedProfileVariant)} 전용입니다. 맞지 않는 카드 ${selectedVariantMismatches.length}개를 해제해주세요.`;
    }
    return '';
  }, [selectedCandidates.length, selectedProfileId, selectedProfileVariant, selectedVariantMismatches.length]);

  const uploadCardByKey = useMemo(() => {
    const map = new Map();
    uploadCards.filter((card) => matchesUploadProfile(card, selectedProfileId)).forEach((card) => {
      uploadCardKeys(card).forEach((key) => map.set(key, card));
    });
    return map;
  }, [uploadCards, selectedProfileId]);

  const jobItemByKey = useMemo(() => {
    const map = new Map();
    (job?.items || []).filter((item) => matchesUploadProfile(item, selectedProfileId)).forEach((item) => {
      uploadCardKeys(item).forEach((key) => map.set(key, item));
    });
    return map;
  }, [job, selectedProfileId]);

  const visiblePendingUploads = useMemo(
    () => pendingUploads.filter((item) => matchesUploadProfile(item, selectedProfileId)),
    [pendingUploads, selectedProfileId]
  );

  const visibleUploadHistory = useMemo(
    () => uploadHistory.filter((item) => matchesUploadProfile(item, selectedProfileId)),
    [uploadHistory, selectedProfileId]
  );

  function getUploadCardForCandidate(candidate) {
    return uploadCardKeys(candidate).map((key) => uploadCardByKey.get(key)).find(Boolean) || null;
  }

  function getJobItemForCandidate(candidate) {
    return uploadCardKeys(candidate).map((key) => jobItemByKey.get(key)).find(Boolean) || null;
  }

  function getCandidateUploadState(candidate) {
    const jobItem = getJobItemForCandidate(candidate);
    const card = getUploadCardForCandidate(candidate);
    const status = jobItem?.status === 'success'
      ? 'uploaded'
      : (jobItem?.status || card?.status || candidate.cardStatus || 'matched');
    return { status, card, jobItem };
  }

  function setCandidateForms(nextCandidates, scheduleStart = '', intervalMinutes = scheduleInterval) {
    const nextForms = {};
    nextCandidates.forEach((candidate, index) => {
      const autoPublishAt = scheduleStart
        ? plusMinutesLocal(scheduleStart, index * Number(intervalMinutes || 0))
        : '';
      const publishAt = candidate.publishAt || autoPublishAt;
      nextForms[candidate.id] = {
        title: stripLeadingUploadTitleMarker(candidate.title || ''),
        description: stripReviewOnlySections(candidate.description || ''),
        tagsText: toTagText(candidate.tags),
        privacyStatus: publishAt ? 'private' : (candidate.privacyStatus || 'private'),
        publishAt,
        madeForKids: Boolean(candidate.madeForKids),
        categoryId: candidate.categoryId || '28'
      };
    });
    setFormMap(nextForms);
    setSelected(new Set(nextCandidates.map((candidate) => candidate.id)));
  }

  function pickUploadFiles(fileList) {
    const selectedFiles = Array.from(fileList || []);
    const accepted = selectedFiles.filter((file) => isVideoFile(file) || isTxtFile(file));
    const skipped = selectedFiles.length - accepted.length;
    setMessage(skipped > 0 ? `지원하지 않는 파일 ${skipped}개를 제외했습니다. 영상과 TXT만 추가해주세요.` : '');
    return accepted;
  }

  function appendPendingFiles(nextFiles) {
    const accepted = pickUploadFiles(nextFiles);
    if (!accepted.length) return;
    setFiles((prev) => {
      const map = new Map(prev.map((file) => [fileKey(file), file]));
      accepted.forEach((file) => map.set(fileKey(file), file));
      const merged = [...map.values()];
      setStatus(`매칭 대기 파일 ${merged.length}개`);
      return merged;
    });
  }

  function removePendingFile(key) {
    setFiles((prev) => prev.filter((file) => fileKey(file) !== key));
  }

  function removePendingFileGroup(dateKey) {
    const targets = files.filter((file) => pendingFileDateKey(file) === dateKey);
    if (!targets.length) {
      setMessage('제거할 대기 파일 묶음이 없습니다.');
      return;
    }
    const targetKeys = new Set(targets.map(fileKey));
    setFiles((prev) => prev.filter((file) => !targetKeys.has(fileKey(file))));
    setStatus(`${formatDateGroupLabel(dateKey)} 대기 파일 ${targets.length}개를 제거했습니다.`);
    setMessage('필요하면 같은 날짜 폴더를 다시 추가할 수 있습니다.');
  }

  function clearPendingFiles() {
    setFiles([]);
    setStatus('매칭 대기 목록을 비웠습니다.');
  }

  function clearUploadCandidates() {
    setCandidates([]);
    setSelected(new Set());
    setFormMap({});
    setWarnings([]);
    setPreviewCandidate(null);
    clearUploadWorkspace();
    setStatus('업로드 후보 목록을 비웠습니다.');
    setMessage('');
  }

  function onFileChange(event) {
    appendPendingFiles(event.target.files || []);
    event.target.value = '';
  }

  function onVideoFolderChange(event) {
    const videoFiles = Array.from(event.target.files || []).filter(isVideoFile);
    if (!videoFiles.length) {
      setMessage('선택한 폴더에서 영상 파일을 찾지 못했습니다.');
      event.target.value = '';
      return;
    }
    appendPendingFiles(videoFiles);
    setStatus(`영상 폴더에서 ${videoFiles.length}개 파일을 추가했습니다.`);
    event.target.value = '';
  }

  function onMetadataFolderChange(event) {
    const txtFiles = Array.from(event.target.files || []).filter(isTxtFile);
    if (!txtFiles.length) {
      setMessage('선택한 폴더에서 TXT 파일을 찾지 못했습니다.');
      event.target.value = '';
      return;
    }
    appendPendingFiles(txtFiles);
    setStatus(`TXT 폴더에서 ${txtFiles.length}개 파일을 추가했습니다.`);
    event.target.value = '';
  }

  async function importFiles(sourceFiles = files) {
    const uploadFiles = Array.from(sourceFiles || []);
    const videoCount = uploadFiles.filter(isVideoFile).length;
    const txtCount = uploadFiles.filter(isTxtFile).length;
    if (!videoCount) {
      setMessage('영상 파일을 하나 이상 추가한 뒤 매칭 실행을 눌러주세요.');
      return;
    }
    if (!txtCount) {
      setMessage('TXT 파일이 없습니다. 파일명 기반 임시 제목만 만들 수 있으니 TXT도 함께 추가해주세요.');
    }

    const formData = new FormData();
    uploadFiles.forEach((file) => formData.append('files', file, file.name));

    let failed = false;
    setMatchingFiles(true);
    setCandidates([]);
    setSelected(new Set());
    setFormMap({});
    setWarnings([]);
    setPreviewCandidate(null);
    clearUploadWorkspace();
    setMatchProgress({ phase: 'uploading', percent: 0, videoCount, txtCount, totalCount: uploadFiles.length });
    setStatus(`매칭 준비: 영상 ${videoCount}개 / TXT ${txtCount}개를 서버에 업로드 중`);
    if (txtCount) setMessage('');

    try {
      const res = await axios.post(`${API}/import-files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 0,
        onUploadProgress: (event) => {
          if (!event.total) {
            setMatchProgress({ phase: 'uploading', percent: null, videoCount, txtCount, totalCount: uploadFiles.length });
            setStatus(`매칭 업로드 중: 영상 ${videoCount}개 / TXT ${txtCount}개`);
            return;
          }
          const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
          setMatchProgress({ phase: 'uploading', percent, videoCount, txtCount, totalCount: uploadFiles.length });
          setStatus(`매칭 업로드 중: ${percent}% · 영상 ${videoCount}개 / TXT ${txtCount}개`);
        }
      });

      setMatchProgress({ phase: 'matching', percent: 100, videoCount, txtCount, totalCount: uploadFiles.length });
      const nextCandidates = res.data.candidates || [];
      const defaultScheduleStart = defaultScheduleBaseLocal();
      setCandidates(nextCandidates);
      setScheduleBase(defaultScheduleStart);
      setCandidateForms(nextCandidates, defaultScheduleStart, scheduleInterval);
      setWarnings(res.data.warnings || []);
      await loadUploadLists();

      const matchedCount = nextCandidates.filter((candidate) => candidate.metadataOriginalName).length;
      const unmatchedCount = Math.max(0, nextCandidates.length - matchedCount);
      setStatus(`매칭 완료: 후보 ${nextCandidates.length}개 · TXT 매칭 ${matchedCount}개 · 미매칭 ${unmatchedCount}개`);
      if (!nextCandidates.length) {
        setMessage('서버 요청은 끝났지만 업로드 후보가 생성되지 않았습니다. 영상 파일 형식과 서버 로그를 확인해야 합니다.');
      } else if (matchedCount === 0) {
        setMessage('TXT가 하나도 매칭되지 않았습니다. 파일명을 확인하거나 설명을 직접 입력해주세요.');
      } else if (unmatchedCount > 0) {
        setMessage(`TXT가 매칭되지 않은 영상 ${unmatchedCount}개가 있습니다. 경고 목록에서 파일명을 확인해주세요.`);
      } else {
        setMessage(`모든 영상과 TXT가 매칭되었습니다. import: ${res.data.batchId || '-'}`);
      }
    } catch (error) {
      failed = true;
      const statusCode = error.response?.status;
      const serverCode = error.response?.data?.code;
      const serverMessage = error.response?.data?.message || error.response?.data?.error || '';
      setMatchProgress({ phase: 'failed', percent: 100, videoCount, txtCount, totalCount: uploadFiles.length });
      setStatus(`파일 매칭 실패${statusCode ? ` (${statusCode})` : ''}`);
      if (serverCode === 'UPLOAD_FILE_COUNT_LIMIT') {
        setMessage(serverMessage || '한 번에 업로드할 수 있는 파일 수를 초과했습니다. 파일 수를 줄이거나 제한 값을 조정해야 합니다.');
      } else {
        setMessage(serverMessage || error.message || '알 수 없는 매칭 오류가 발생했습니다.');
      }
    } finally {
      setMatchingFiles(false);
      if (!failed) {
        setMatchProgress((prev) => prev ? { ...prev, phase: 'done', percent: 100 } : null);
      }
    }
  }

  function onDragEnter(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function onDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function onDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setDragActive(false);
  }

  async function onDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    appendPendingFiles(await getDroppedFiles(event.dataTransfer));
  }

  async function loadProfiles() {
    try {
      const res = await axios.get(`${API}/profiles`);
      const nextProfiles = res.data.profiles || [];
      setProfiles(nextProfiles);
      setProfileDraftNames((prev) => {
        const next = { ...prev };
        nextProfiles.forEach((profile) => {
          if (!Object.prototype.hasOwnProperty.call(next, profile.id)) next[profile.id] = profile.name || '';
        });
        return next;
      });
      setProfileDraftPurposes((prev) => {
        const next = { ...prev };
        nextProfiles.forEach((profile) => {
          if (!Object.prototype.hasOwnProperty.call(next, profile.id)) next[profile.id] = normalizePurpose(profile.purpose || '');
        });
        return next;
      });
      setProfileDraftClientIds((prev) => {
        const next = { ...prev };
        nextProfiles.forEach((profile) => {
          next[profile.id] = prev[profile.id] ?? profile.oauthClientId ?? '';
        });
        return next;
      });
      setProfileDraftClientSecrets((prev) => {
        const next = { ...prev };
        nextProfiles.forEach((profile) => {
          next[profile.id] = prev[profile.id] ?? '';
        });
        return next;
      });
      setProfileDraftRedirectUris((prev) => {
        const next = { ...prev };
        nextProfiles.forEach((profile) => {
          next[profile.id] = prev[profile.id] ?? profile.oauthRedirectUri ?? DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI;
        });
        return next;
      });
      setSelectedProfileId((prev) => (
        nextProfiles.some((profile) => profile.id === prev)
          ? prev
          : (res.data.activeProfileId || nextProfiles[0]?.id || '')
      ));
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function loadUploadLists() {
    try {
      const [historyRes, pendingRes, cardsRes] = await Promise.all([
        axios.get(`${API}/history`),
        axios.get(`${API}/pending`),
        axios.get(`${API}/cards`)
      ]);
      const cards = cardsRes.data.cards || [];
      setUploadCards(cards);
      const cardPending = cards.filter((card) => card.status === 'pending');
      const cardUploaded = cards.filter((card) => card.status === 'uploaded');
      setUploadHistory(cardUploaded.length ? cardUploaded : (historyRes.data.history || []));
      setPendingUploads(cardPending.length ? cardPending : (pendingRes.data.pending || []));
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function restorePendingUploads(ids = []) {
    try {
      const res = await axios.post(`${API}/pending/restore`, { ids });
      const restored = res.data.candidates || [];
      if (!restored.length) {
        setMessage('복원할 보류 항목이 없습니다.');
        return;
      }
      const defaultScheduleStart = defaultScheduleBaseLocal();
      setCandidates(restored);
      setScheduleBase(defaultScheduleStart);
      setCandidateForms(restored, defaultScheduleStart, scheduleInterval);
      setWarnings([]);
      setVariantFilter('all');
      setStatus(`보류 항목 ${restored.length}개를 업로드 후보로 불러왔습니다.`);
      setMessage('채널 프로필과 예약 시간을 확인한 뒤 다시 업로드하세요.');
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function restoreUploadCards(ids = []) {
    try {
      const res = await axios.post(`${API}/cards/restore`, { ids });
      const restored = res.data.candidates || [];
      if (!restored.length) {
        setMessage('불러올 카드가 없습니다.');
        return;
      }
      const defaultScheduleStart = defaultScheduleBaseLocal();
      setCandidates(restored);
      setScheduleBase(defaultScheduleStart);
      setCandidateForms(restored, defaultScheduleStart, scheduleInterval);
      setWarnings([]);
      setVariantFilter('all');
      setDateFilter('all');
      setHistoryDetail(null);
      setStatus(`업로드 카드 ${restored.length}개를 후보로 불러왔습니다.`);
      setMessage('카드 메타데이터를 수정한 뒤 다시 업로드할 수 있습니다.');
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function deleteUploadCard(cardId) {
    if (!cardId) return;
    try {
      await axios.delete(`${API}/cards/${encodeURIComponent(cardId)}`);
      await loadUploadLists();
      setHistoryDetail(null);
      setStatus('업로드 카드를 삭제했습니다.');
      setMessage('보류 목록에 있던 카드라면 보류 목록에서도 제거됩니다.');
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  function toUploadItem(candidate) {
      const form = formMap[candidate.id] || {};
      return {
        id: candidate.id,
        cardId: candidate.cardId || candidate.id,
        filePath: candidate.filePath,
        finalMp4Path: candidate.finalMp4Path || candidate.filePath,
        originalName: candidate.originalName,
        title: stripLeadingUploadTitleMarker(form.title || candidate.title),
        description: stripReviewOnlySections(form.description || candidate.description),
        tags: fromTagText(form.tagsText || toTagText(candidate.tags)),
        privacyStatus: form.publishAt ? 'private' : (form.privacyStatus || candidate.privacyStatus || 'private'),
        publishAt: form.publishAt || '',
        madeForKids: false,
        categoryId: form.categoryId || candidate.categoryId || '28',
        uploadProfileId: selectedProfileId,
        metadataTextPath: candidate.metadataTextPath || '',
        metadataOriginalName: candidate.metadataOriginalName || '',
        variant: candidateVariant(candidate),
        review: candidate.review || null
      };
  }

  function candidatesByIds(ids = []) {
    const wanted = new Set(ids);
    return candidates.filter((candidate) => wanted.has(candidate.id));
  }

  async function saveCandidatesToPending(ids = []) {
    const targetCandidates = candidatesByIds(ids);
    if (!targetCandidates.length) {
      setMessage('저장할 영상을 선택해주세요.');
      return;
    }
    const items = targetCandidates.map(toUploadItem);

    try {
      const res = await axios.post(`${API}/pending`, { items });
      setPendingUploads(res.data.pending || []);
      await loadUploadLists();
      setStatus(`선택 항목 ${res.data.savedCount || items.length}개를 저장했습니다.`);
      setMessage('나중에 저장 목록에서 다시 업로드 후보로 불러올 수 있습니다.');
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function saveSelectedToPending() {
    await saveCandidatesToPending([...selected]);
  }

  async function removeCandidate(candidate) {
    if (!candidate?.id) return;
    setCandidates((prev) => prev.filter((item) => item.id !== candidate.id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(candidate.id);
      return next;
    });
    setFormMap((prev) => {
      const next = { ...prev };
      delete next[candidate.id];
      return next;
    });
    setWarnings((prev) => prev.filter((warning) => !String(warning || '').includes(candidate.originalName || candidate.id)));
    setStatus('카드를 현재 후보 목록에서 제거했습니다.');
    setMessage('완료/보류 히스토리는 삭제하지 않고 유지됩니다.');
  }

  async function markCandidatesCompleted(ids = []) {
    const targetCandidates = candidatesByIds(ids);
    if (!targetCandidates.length) {
      setMessage('완료 처리할 영상을 선택해주세요.');
      return;
    }
    const items = targetCandidates.map((candidate) => {
      const state = getCandidateUploadState(candidate);
      return {
        ...toUploadItem(candidate),
        youtubeUrl: state.card?.youtubeUrl || '',
        youtubeVideoId: state.card?.youtubeVideoId || ''
      };
    });

    try {
      setStatus('완료 목록 저장 중');
      setMessage('');
      const res = await axios.post(`${API}/cards/complete`, { items });
      setUploadHistory(res.data.history || []);
      await loadUploadLists();
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setStatus(`선택 항목 ${res.data.savedCount || items.length}개를 완료 목록에 저장했습니다.`);
      setMessage('실제 YouTube 업로드가 이미 끝난 항목을 완료 카드로 보관했습니다.');
    } catch (error) {
      setStatus('완료 처리 실패');
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function selectProfile(profileId) {
    const profile = profiles.find((item) => item.id === profileId);
    const expectedVariant = variantForPurpose(profile?.purpose || profileDraftPurposes[profileId] || '');
    setSelectedProfileId(profileId);
    if (expectedVariant) {
      setVariantFilter(expectedVariant);
      setSelected((prev) => {
        const next = new Set();
        prev.forEach((id) => {
          const candidate = candidates.find((item) => item.id === id);
          if (candidate && candidateVariant(candidate) === expectedVariant) next.add(id);
        });
        return next;
      });
    }
    setJob(null);
    setAuthInfo(null);
    setStatus('업로드 채널 변경 중');
    setMessage('선택한 채널 기준으로 업로드 상태를 새로고침합니다.');
    try {
      await axios.post(`${API}/profiles/active`, { profileId });
      await loadProfiles();
      await loadUploadLists();
      setStatus('채널 선택 완료');
      setMessage('업로드 채널 프로필을 선택했습니다. 이 채널 기준으로 완료/보류 상태를 다시 불러왔습니다.');
    } catch (error) {
      setStatus('채널 선택 실패');
      setMessage(error.response?.data?.message || error.message);
    }
  }

  function updateProfileDraftName(profileId, name) {
    setProfileDraftNames((prev) => ({ ...prev, [profileId]: name }));
  }

  function updateProfileDraftPurpose(profileId, purpose) {
    setProfileDraftPurposes((prev) => ({ ...prev, [profileId]: purpose }));
  }

  function updateProfileDraftClientId(profileId, value) {
    setProfileDraftClientIds((prev) => ({ ...prev, [profileId]: value }));
  }

  function updateProfileDraftClientSecret(profileId, value) {
    setProfileDraftClientSecrets((prev) => ({ ...prev, [profileId]: value }));
  }

  function updateProfileDraftRedirectUri(profileId, value) {
    setProfileDraftRedirectUris((prev) => ({ ...prev, [profileId]: value }));
  }

  async function saveProfile(profileId) {
    try {
      const payload = {
        name: profileDraftNames[profileId] || '',
        purpose: profileDraftPurposes[profileId] || '',
        oauthClientId: profileDraftClientIds[profileId] || '',
        oauthRedirectUri: profileDraftRedirectUris[profileId] || DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI
      };
      if (profileDraftClientSecrets[profileId]?.trim()) {
        payload.oauthClientSecret = profileDraftClientSecrets[profileId].trim();
      }
      await axios.patch(`${API}/profiles/${encodeURIComponent(profileId)}`, payload);
      setMessage('채널 프로필 정보를 저장했습니다.');
      setProfileDraftClientSecrets((prev) => ({ ...prev, [profileId]: '' }));
      await loadProfiles();
      return true;
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
      return false;
    }
  }

  async function deleteProfile(profileId) {
    const profile = profiles.find((item) => item.id === profileId);
    const label = profile?.channelTitle || profile?.name || profileId;
    if (!window.confirm(`${label} 채널 프로필을 제거할까요? 저장된 OAuth 토큰도 이 앱에서 제거됩니다.`)) return;
    try {
      await axios.delete(`${API}/profiles/${encodeURIComponent(profileId)}`);
      setMessage('채널 프로필을 제거했습니다.');
      if (selectedProfileId === profileId) setSelectedProfileId('');
      await loadProfiles();
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function createOAuthUrl(profileId) {
    setMessage('');
    setOauthUrl('');
    try {
      const res = await axios.get(`${API}/oauth-url`, {
        params: {
          profileId,
          profileName: profiles.find((item) => item.id === profileId)?.name || newProfileName || '새 업로드 채널'
        }
      });
      setAuthInfo(res.data);
      setOauthUrl(res.data.authUrl);
      const popup = window.open(res.data.authUrl, '_blank', 'noopener,noreferrer');
      if (popup) {
        popup.focus();
        setMessage('Google 권한 승인 창을 새 창으로 열었습니다. 승인 후 프로필 목록을 새로고침해주세요.');
      } else {
        setMessage('브라우저가 새 창을 차단했습니다. 아래 OAuth 링크를 직접 열어주세요.');
      }
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function testAuth() {
    setMessage('');
    try {
      const res = await axios.post(`${API}/test-auth`, { profileId: selectedProfileId });
      setAuthInfo(res.data);
      setMessage(`YouTube OAuth 연결됨${res.data.channelTitle ? `: ${res.data.channelTitle}` : ''}`);
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  function updateForm(id, patch) {
    const normalizedPatch = patch && Object.prototype.hasOwnProperty.call(patch, 'title')
      ? { ...patch, title: stripLeadingUploadTitleMarker(patch.title) }
      : patch;
    setFormMap((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...normalizedPatch } }));
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function getVisibleCandidatesSnapshot() {
    return candidates.filter((candidate) => {
      if (variantFilter !== 'all' && candidateVariant(candidate) !== variantFilter) return false;
      if (dateFilter !== 'all' && uploadDateKey(candidate) !== dateFilter) return false;
      return true;
    });
  }

  function getCandidateIdsForVariant(variant) {
    return candidates
      .filter((candidate) => {
        if (variant !== 'all' && candidateVariant(candidate) !== variant) return false;
        if (dateFilter !== 'all' && uploadDateKey(candidate) !== dateFilter) return false;
        return true;
      })
      .map((candidate) => candidate.id);
  }

  function selectDateCategory(nextDateFilter) {
    setDateFilter(nextDateFilter);
    const ids = candidates
      .filter((candidate) => {
        if (variantFilter !== 'all' && candidateVariant(candidate) !== variantFilter) return false;
        if (nextDateFilter !== 'all' && uploadDateKey(candidate) !== nextDateFilter) return false;
        return true;
      })
      .map((candidate) => candidate.id);
    setSelected(new Set(ids));
    setStatus(nextDateFilter === 'all' ? '전체 날짜 카드를 선택했습니다.' : `${formatDateGroupLabel(nextDateFilter)} 카드만 선택했습니다.`);
    setMessage(`현재 날짜 범위 후보 ${ids.length}개를 선택했습니다.`);
  }

  function getVisibleCandidateIds() {
    return getVisibleCandidatesSnapshot().map((candidate) => candidate.id);
  }

  function selectVariantCategory(variant) {
    const ids = getCandidateIdsForVariant(variant);
    setVariantFilter(variant);
    setSelected(new Set(ids));
    setStatus(variant === 'all' ? '전체 카드를 선택했습니다.' : `${variantLabel(variant)} 카드만 선택했습니다.`);
    setMessage(variant === 'all'
      ? `전체 후보 ${ids.length}개를 선택했습니다.`
      : `${variantLabel(variant)} 후보 ${ids.length}개만 선택하고 다른 카테고리는 해제했습니다.`);
  }

  function selectAll() {
    const ids = getVisibleCandidateIds();
    if (!ids.length) {
      setMessage('선택할 카드가 없습니다.');
      return;
    }
    setSelected(new Set(ids));
    setStatus(variantFilter === 'all' ? '전체 카드를 선택했습니다.' : `${variantLabel(variantFilter)} 카드를 선택했습니다.`);
    setMessage(variantFilter === 'all'
      ? `전체 후보 ${ids.length}개를 선택했습니다.`
      : `${variantLabel(variantFilter)} 후보 ${ids.length}개만 선택하고 다른 카테고리는 해제했습니다.`);
  }

  function clearSelected() {
    const ids = new Set(getVisibleCandidateIds());
    if (!ids.size) {
      setMessage('선택 해제할 카드가 없습니다.');
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    setStatus(variantFilter === 'all' ? '전체 카드 선택을 해제했습니다.' : `${variantLabel(variantFilter)} 카드 선택을 해제했습니다.`);
    setMessage(variantFilter === 'all'
      ? '전체 후보 선택을 해제했습니다.'
      : `${variantLabel(variantFilter)} 후보 선택을 해제했습니다.`);
  }

  async function saveVisibleToPending() {
    const ids = getVisibleCandidateIds();
    if (!ids.length) {
      setMessage('저장할 카드가 없습니다.');
      return;
    }
    await saveCandidatesToPending(ids);
  }

  async function markVisibleCompleted() {
    const ids = getVisibleCandidateIds();
    if (!ids.length) {
      setMessage('완료 처리할 카드가 없습니다.');
      return;
    }
    await markCandidatesCompleted(ids);
  }

  async function removeVisibleCandidates() {
    const targets = getVisibleCandidatesSnapshot();
    if (!targets.length) {
      setMessage('목록에서 제거할 카드가 없습니다.');
      return;
    }
    const targetIds = new Set(targets.map((candidate) => candidate.id));

    setCandidates((prev) => prev.filter((candidate) => !targetIds.has(candidate.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      targetIds.forEach((id) => next.delete(id));
      return next;
    });
    setFormMap((prev) => {
      const next = { ...prev };
      targetIds.forEach((id) => delete next[id]);
      return next;
    });
    setWarnings((prev) => prev.filter((warning) => !targets.some((candidate) => String(warning || '').includes(candidate.originalName || candidate.id))));
    setStatus(`${targets.length}개 카드를 현재 후보 목록에서 제거했습니다.`);
    setMessage('완료/보류 히스토리는 삭제하지 않고 유지됩니다.');
  }

  async function removeCandidatesByDate(dateKey) {
    const targets = candidates.filter((candidate) => uploadDateKey(candidate) === dateKey);
    if (!targets.length) {
      setMessage('해당 날짜에 제거할 카드가 없습니다.');
      return;
    }
    const targetIds = new Set(targets.map((candidate) => candidate.id));
    setCandidates((prev) => prev.filter((candidate) => !targetIds.has(candidate.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      targetIds.forEach((id) => next.delete(id));
      return next;
    });
    setFormMap((prev) => {
      const next = { ...prev };
      targetIds.forEach((id) => delete next[id]);
      return next;
    });
    setWarnings((prev) => prev.filter((warning) => !targets.some((candidate) => String(warning || '').includes(candidate.originalName || candidate.id))));
    if (dateFilter === dateKey) setDateFilter('all');
    setStatus(`${formatDateGroupLabel(dateKey)} 후보 ${targets.length}개를 현재 목록에서 제거했습니다.`);
    setMessage('보류/완료 카드 보관함까지 지우려면 보류/완료 목록의 날짜 삭제 버튼을 사용하세요.');
  }

  async function deleteUploadCardsForDate(dateKey) {
    if (!dateKey) return;
    try {
      const res = await axios.post(`${API}/cards/delete-by-date`, { dateKey });
      await loadUploadLists();
      setHistoryDetail(null);
      setStatus(`${formatDateGroupLabel(dateKey)} 카드 ${res.data.deletedCount || 0}개를 삭제했습니다.`);
      setMessage('보류/완료 보관함과 서버 업로드 카드 목록에서 같은 날짜 카드가 제거되었습니다.');
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function reconnectProfile(profileId) {
    if (!profileId) {
      setMessage('재연결할 채널 프로필을 먼저 선택하세요.');
      return;
    }
    const saved = await saveProfile(profileId);
    if (!saved) return;
    await createOAuthUrl(profileId);
  }

  async function createProfileAndConnect() {
    try {
      const res = await axios.post(`${API}/profiles`, {
        name: newProfileName || '새 업로드 채널',
        purpose: newProfilePurpose || '',
        oauthClientId: newProfileClientId || '',
        oauthClientSecret: newProfileClientSecret || '',
        oauthRedirectUri: newProfileRedirectUri || DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI
      });
      const profileId = res.data?.id;
      if (!profileId) throw new Error('생성된 프로필 ID를 찾지 못했습니다.');
      setSelectedProfileId(profileId);
      setNewProfileClientSecret('');
      await loadProfiles();
      await createOAuthUrl(profileId);
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  function applyScheduleToSelected() {
    if (!scheduleBase) {
      setMessage('예약 시작 시간을 먼저 입력해주세요.');
      return;
    }
    const ids = [...selected];
    if (!ids.length) {
      setMessage('예약을 적용할 영상을 선택해주세요.');
      return;
    }
    setFormMap((prev) => {
      const next = { ...prev };
      ids.forEach((id, index) => {
        next[id] = {
          ...(next[id] || {}),
          privacyStatus: 'private',
          publishAt: plusMinutesLocal(scheduleBase, index * Number(scheduleInterval || 0))
        };
      });
      return next;
    });
    setMessage(`선택 ${ids.length}개에 예약 시간을 적용했습니다.`);
  }

  async function startUpload() {
    if (uploadBusy) {
      setMessage('이미 서버 업로드 작업이 진행 중입니다. 현재 작업 로그가 끝난 뒤 다시 시도해주세요.');
      return;
    }
    if (!selectedCandidates.length) {
      setMessage('업로드할 영상을 선택해주세요.');
      return;
    }
    if (!selectedProfileId) {
      setMessage('업로드할 YouTube 채널 프로필을 먼저 선택해주세요.');
      return;
    }
    if (!selectedProfileVariant) {
      setMessage('선택한 채널 프로필의 용도를 JP Full / JP Highlight / JP Midform / KR Full / KR Highlight 중 하나로 지정해주세요.');
      return;
    }
    if (selectedVariantMismatches.length) {
      setMessage(`선택 채널은 ${variantLabel(selectedProfileVariant)} 전용입니다. 맞지 않는 카드 ${selectedVariantMismatches.length}개를 해제해주세요.`);
      return;
    }

    const items = selectedCandidates.map(toUploadItem);

    setStatus('업로드 작업 생성 중');
    setMessage('');
    try {
      const createRes = await axios.post(`${API}/jobs`, { items });
      const startRes = await axios.post(`${API}/jobs/${createRes.data.jobId}/start`);
      setJob(startRes.data);
      await loadUploadLists();
      setStatus(isActiveUploadJob(startRes.data.status) ? '서버 업로드 작업 진행 중' : `서버 업로드 작업: ${startRes.data.status}`);
    } catch (error) {
      setStatus('업로드 시작 실패');
      setMessage(error.response?.data?.message || error.message);
    }
  }

  async function cancelJob() {
    if (!job?.jobId) return;
    try {
      const res = await axios.post(`${API}/jobs/${job.jobId}/cancel`);
      setJob(res.data);
      setStatus('취소 요청됨');
    } catch (error) {
      setMessage(error.response?.data?.message || error.message);
    }
  }

  useEffect(() => {
    if (!workspaceRestoredRef.current) {
      const saved = loadUploadWorkspace();
      if (saved) {
        const restoredCandidates = Array.isArray(saved.candidates) ? saved.candidates : [];
        const restoredFormMap = saved.formMap && typeof saved.formMap === 'object'
          ? Object.fromEntries(Object.entries(saved.formMap).map(([key, form]) => [
            key,
            {
              ...form,
              description: stripReviewOnlySections(form?.description || '')
            }
          ]))
          : {};
        setCandidates(restoredCandidates);
        setSelected(new Set(Array.isArray(saved.selectedIds) ? saved.selectedIds : []));
        setFormMap(restoredFormMap);
        setWarnings(Array.isArray(saved.warnings) ? saved.warnings : []);
        setScheduleBase(saved.scheduleBase || '');
        setScheduleInterval(saved.scheduleInterval || 120);
        setVariantFilter(saved.variantFilter || 'all');
        setDateFilter(saved.dateFilter || 'all');
        if (restoredCandidates.length) {
          setStatus(`저장된 업로드 매칭 ${restoredCandidates.length}개를 복원했습니다.`);
        }
      }
      workspaceRestoredRef.current = true;
    }
    loadProfiles();
    loadUploadLists();
  }, []);

  useEffect(() => {
    if (!workspaceRestoredRef.current) return;
    if (!candidates.length) {
      clearUploadWorkspace();
      return;
    }
    saveUploadWorkspace({
      savedAt: new Date().toISOString(),
      candidates,
      selectedIds: [...selected],
      formMap,
      warnings,
      scheduleBase,
      scheduleInterval,
      variantFilter,
      dateFilter
    });
  }, [candidates, selected, formMap, warnings, scheduleBase, scheduleInterval, variantFilter, dateFilter]);

  useEffect(() => {
    if (!job?.jobId) return undefined;
    const timer = setInterval(async () => {
      try {
        const res = await axios.get(`${API}/jobs/${job.jobId}`);
        setJob(res.data);
        setStatus(`업로드 작업: ${res.data.status}`);
        if (['completed', 'partial_success', 'failed', 'cancelled'].includes(res.data.status)) {
          loadUploadLists();
        }
      } catch (error) {
        setMessage(error.response?.data?.message || error.message);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [job?.jobId]);

  const videoFileCount = files.filter(isVideoFile).length;
  const txtFileCount = files.filter(isTxtFile).length;

  return (
    <div className="space-y-5">
      <section className="rounded-[28px] border border-white/10 bg-gradient-to-br from-[#101820] to-[#08110e] p-7 shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.38em] text-[#c8ff00]">3분 오뚝이영상 · Phase 3</div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-white">YouTube 자동 업로드</h1>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-300">
              캡컷에서 내보낸 완성 영상과 메타데이터 TXT를 함께 올리고, 매칭 결과를 확인한 뒤 선택한 YouTube 채널로 예약 업로드합니다.
            </p>
          </div>
          <div className="rounded-2xl border border-[#c8ff00]/30 bg-[#c8ff00]/10 px-4 py-3 text-xs font-bold text-[#c8ff00]">
            예약 발행은 비공개 업로드 후 지정 시간에 공개됩니다.
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
        <main className="space-y-4">
          <div className="rounded-[26px] border border-[#c8ff00]/20 bg-[#c8ff00]/8 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-white">1. 영상 + TXT 추가</h2>
                <p className="mt-1 text-sm text-lime-100/80">
                  파일은 여러 번 나눠 추가해도 됩니다. 영상과 TXT를 모두 모은 뒤 매칭 실행을 눌러주세요.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-2xl border border-[#c8ff00]/35 px-4 py-3 text-sm font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => fileInputRef.current?.click()}>
                  파일 추가
                </button>
                <button type="button" className="rounded-2xl border border-white/15 px-4 py-3 text-sm font-bold text-slate-200 hover:bg-white/10" onClick={() => videoFolderInputRef.current?.click()}>
                  영상 폴더
                </button>
                <button type="button" className="rounded-2xl border border-white/15 px-4 py-3 text-sm font-bold text-slate-200 hover:bg-white/10" onClick={() => metadataFolderInputRef.current?.click()}>
                  TXT 폴더
                </button>
                <button type="button" className="rounded-2xl border border-white/15 px-4 py-3 text-sm font-bold text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={!files.length || matchingFiles} onClick={clearPendingFiles}>
                  대기 목록 비우기
                </button>
                <button type="button" className="rounded-2xl border border-red-400/30 px-4 py-3 text-sm font-bold text-red-100 hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={!candidates.length || matchingFiles} onClick={clearUploadCandidates}>
                  후보 목록 비우기
                </button>
                <button type="button" className="rounded-2xl bg-[#c8ff00] px-4 py-3 text-sm font-black text-black hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" disabled={!videoFileCount || matchingFiles} onClick={() => importFiles()}>
                  {matchingFiles ? '매칭 중...' : '매칭 실행'}
                </button>
              </div>
            </div>

            <input ref={fileInputRef} type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.txt,text/plain" className="hidden" onChange={onFileChange} />
            <input ref={videoFolderInputRef} type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" webkitdirectory="true" directory="true" onChange={onVideoFolderChange} />
            <input ref={metadataFolderInputRef} type="file" multiple accept=".txt,text/plain" className="hidden" webkitdirectory="true" directory="true" onChange={onMetadataFolderChange} />

            <div
              className={`mt-5 rounded-[24px] border-2 border-dashed p-8 text-center transition ${
                dragActive
                  ? 'border-[#c8ff00] bg-[#c8ff00]/15 shadow-[0_0_40px_rgba(200,255,0,0.18)]'
                  : 'border-white/15 bg-black/25 hover:border-[#c8ff00]/50 hover:bg-black/35'
              }`}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click();
              }}
            >
              <div className="text-3xl font-black text-[#c8ff00]">+</div>
              <div className="mt-2 text-lg font-black text-white">
                {dragActive ? '여기에 놓으면 대기 목록에 추가됩니다' : '완성 영상과 TXT를 여기에 끌어다 놓으세요'}
              </div>
              <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-lime-100/70">
                같은 파일명의 영상과 TXT를 우선 매칭하고, 이름이 조금 잘린 경우에는 드래프트 번호와 제목 기준으로 보조 매칭합니다.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs font-bold text-lime-100/70">
                {['MP4', 'MOV', 'WEBM', 'TXT', '폴더 선택'].map((label) => (
                  <span key={label} className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{label}</span>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl bg-black/35 p-4">
                <div className="text-xs text-lime-100/70">매칭 대기 파일</div>
                <div className="mt-1 text-2xl font-black text-white">{files.length}</div>
              </div>
              <div className="rounded-2xl bg-black/35 p-4">
                <div className="text-xs text-lime-100/70">영상</div>
                <div className="mt-1 text-2xl font-black text-[#c8ff00]">{videoFileCount}</div>
              </div>
              <div className="rounded-2xl bg-black/35 p-4">
                <div className="text-xs text-lime-100/70">TXT</div>
                <div className="mt-1 text-2xl font-black text-[#c8ff00]">{txtFileCount}</div>
              </div>
            </div>

            {videoFileCount ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
                {Object.entries(pendingVariantCounts).filter(([, count]) => count).map(([variant, count]) => (
                  <span key={variant} className={`rounded-full border px-3 py-1 ${variantBadgeClass(variant)}`}>
                    {variantLabel(variant)} {count}
                  </span>
                ))}
              </div>
            ) : null}

            {files.length ? (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-black text-white">날짜별 대기 파일</div>
                    <div className="mt-1 text-xs text-lime-100/60">파일명 앞 날짜 기준으로 묶었습니다. 날짜별로 매칭하거나 한 번에 제거할 수 있습니다.</div>
                  </div>
                  <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold text-slate-300">
                    {pendingDateGroups.length}개 날짜 그룹
                  </div>
                </div>
                <div className="max-h-[360px] space-y-3 overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3">
                  {pendingDateGroups.map((group) => (
                    <details key={group.dateKey} className="rounded-2xl border border-white/10 bg-white/[0.03]" open>
                      <summary className="cursor-pointer list-none p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-[#c8ff00] px-3 py-1 text-xs font-black text-black">날짜</span>
                              <span className="font-black text-white">{group.label}</span>
                              <span className="text-xs font-bold text-slate-400">{group.items.length}개 · 영상 {group.videoCount}개 · TXT {group.txtCount}개 · {formatBytes(group.sizeBytes)}</span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-black">
                              {Object.entries(group.variantCounts).filter(([, count]) => count).map(([variant, count]) => (
                                <span key={variant} className={`rounded-full border px-2 py-1 ${variantBadgeClass(variant)}`}>
                                  {variantLabel(variant)} {count}
                                </span>
                              ))}
                              {!Object.values(group.variantCounts).some(Boolean) ? (
                                <span className="rounded-full border border-amber-300/35 bg-amber-300/10 px-2 py-1 text-amber-100">영상 없음</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <button type="button" className="rounded-xl border border-[#c8ff00]/35 px-3 py-2 text-xs font-black text-[#c8ff00] hover:bg-[#c8ff00]/10 disabled:opacity-40" disabled={!group.videoCount || matchingFiles} onClick={(event) => { event.preventDefault(); event.stopPropagation(); importFiles(group.items); }}>
                              이 날짜만 매칭
                            </button>
                            <button type="button" className="rounded-xl border border-red-400/35 px-3 py-2 text-xs font-black text-red-200 hover:bg-red-500/10 disabled:opacity-40" disabled={matchingFiles} onClick={(event) => { event.preventDefault(); event.stopPropagation(); removePendingFileGroup(group.dateKey); }}>
                              그룹 제거
                            </button>
                          </div>
                        </div>
                      </summary>
                      <div className="border-t border-white/10 px-3 pb-3">
                        {group.items.map((file) => (
                          <div key={fileKey(file)} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-white/5 py-2 text-xs text-slate-300 last:border-none">
                            <span className="truncate">{file.name}</span>
                            <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${isVideoFile(file) ? variantBadgeClass(detectUploadVariantFromName(file.name)) : 'border-white/15 bg-white/5 text-slate-200'}`}>
                              {isVideoFile(file) ? variantLabel(detectUploadVariantFromName(file.name)) : 'TXT'}
                            </span>
                            <span className="shrink-0 text-slate-500">{formatBytes(file.size)}</span>
                            <button type="button" className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[11px] font-bold text-slate-300 hover:bg-white/10" onClick={(event) => { event.stopPropagation(); removePendingFile(fileKey(file)); }}>
                              제거
                            </button>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-[26px] border border-white/10 bg-white/[0.04] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-white">2. 메타데이터 확인</h2>
                <p className="mt-1 text-sm text-slate-400">
                  영상 미리보기로 실제 파일을 확인하고, 업로드 제목/설명/태그를 최종 검수하세요.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border border-white/15 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/10" onClick={(event) => { event.preventDefault(); selectAll(); }}>
                  {variantFilter === 'all' ? '전체 선택' : '현재 카테고리 선택'}
                </button>
                <button type="button" className="rounded-xl border border-white/15 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/10" onClick={(event) => { event.preventDefault(); clearSelected(); }}>
                  {variantFilter === 'all' ? '선택 해제' : '현재 카테고리 해제'}
                </button>
              </div>
            </div>

            {warnings.length ? (
              <div className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                {warnings.map((warning) => <div key={warning}>{humanizeWarning(warning)}</div>)}
              </div>
            ) : null}

            {matchProgress ? (
              <div className={`mt-4 rounded-2xl px-4 py-3 text-sm ${matchProgress.phase === 'failed' ? 'border border-red-400/35 bg-red-400/10 text-red-100' : 'border border-[#c8ff00]/25 bg-[#c8ff00]/10 text-lime-100'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-black">
                    {matchProgress.phase === 'uploading'
                      ? '서버 업로드 중'
                      : matchProgress.phase === 'matching'
                        ? '서버 매칭 처리 중'
                        : matchProgress.phase === 'failed'
                          ? '매칭 실패'
                          : '최근 매칭 결과'}
                  </span>
                  <span className="text-xs opacity-75">
                    영상 {matchProgress.videoCount || 0}개 · TXT {matchProgress.txtCount || 0}개
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/45">
                  <div
                    className={`h-full rounded-full transition-all ${matchProgress.phase === 'failed' ? 'bg-red-400' : 'bg-[#c8ff00]'}`}
                    style={{ width: `${matchProgress.percent == null ? 35 : Math.max(4, matchProgress.percent)}%` }}
                  />
                </div>
                <div className="mt-2 text-xs opacity-75">
                  {matchProgress.phase === 'failed'
                    ? '매칭이 실패했습니다. 아래 상태 메시지를 확인한 뒤 다시 실행해주세요.'
                    : matchProgress.percent == null
                      ? '업로드 크기를 계산 중입니다.'
                      : `${matchProgress.percent}%`}
                </div>
              </div>
            ) : null}

            {job ? (
              <div className="sticky top-3 z-20 mt-4 rounded-2xl border border-sky-300/25 bg-[#07131a]/95 p-4 text-sm shadow-2xl backdrop-blur">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.2em] text-sky-200">Upload Job</div>
                    <div className="mt-1 text-base font-black text-white">서버 업로드 작업: {job.status}</div>
                    <div className="mt-1 text-xs text-slate-400">{job.jobId}</div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-xl bg-[#c8ff00]/15 px-3 py-2 font-black text-[#c8ff00]">성공 {job.successCount || 0}</span>
                    <span className="rounded-xl bg-red-400/15 px-3 py-2 font-black text-red-200">실패 {job.failedCount || 0}</span>
                    <span className="rounded-xl bg-white/10 px-3 py-2 font-black text-white">전체 {job.total || 0}</span>
                    {job?.jobId ? (
                      <button type="button" className="rounded-xl border border-red-400/40 px-3 py-2 font-black text-red-200 hover:bg-red-500/10" onClick={cancelJob}>
                        취소
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 max-h-36 space-y-2 overflow-auto rounded-xl bg-black/35 p-3 text-xs text-slate-300">
                  {(job.logs || []).slice().reverse().slice(0, 12).map((log, index) => (
                    <div key={`${log.time}-${index}`} className="rounded-lg bg-white/5 px-3 py-2">
                      <span className="text-slate-500">{formatDate(log.time)}</span> {log.itemId ? `[${log.itemId}] ` : ''}{log.message}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {candidates.length ? (
              <>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs font-black">
                  {[
                    ['all', `전체 ${candidates.length}`],
                    ['full', `Full ${candidateVariantCounts.full || 0}`],
                    ['highlight', `Highlight ${candidateVariantCounts.highlight || 0}`],
                    ['ko_full', `한국어 Full ${candidateVariantCounts.ko_full || 0}`],
                    ['ko_highlight', `한국어 Highlight ${candidateVariantCounts.ko_highlight || 0}`],
                    ['midform', `Midform ${candidateVariantCounts.midform || 0}`],
                    ['unknown', `Unknown ${candidateVariantCounts.unknown || 0}`]
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`rounded-full border px-3 py-1 transition ${variantFilter === value ? 'border-[#c8ff00] bg-[#c8ff00] text-black' : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'}`}
                      onClick={() => selectVariantCategory(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-[#c8ff00]/15 bg-[#c8ff00]/5 p-3 text-xs font-black">
                  <span className="text-lime-100">날짜별 보기</span>
                  <button
                    type="button"
                    className={`rounded-full border px-3 py-1 transition ${dateFilter === 'all' ? 'border-[#c8ff00] bg-[#c8ff00] text-black' : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'}`}
                    onClick={() => selectDateCategory('all')}
                  >
                    전체 날짜 {candidates.length}
                  </button>
                  {candidateDateGroups.map((group) => (
                    <button
                      key={group.dateKey}
                      type="button"
                      className={`rounded-full border px-3 py-1 transition ${dateFilter === group.dateKey ? 'border-[#c8ff00] bg-[#c8ff00] text-black' : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'}`}
                      onClick={() => selectDateCategory(group.dateKey)}
                    >
                      {group.label} · {group.items.length}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs">
                  <span className="font-black text-slate-300">
                    현재 범위: {variantFilter === 'all' ? '전체 포맷' : variantLabel(variantFilter)} · {dateFilter === 'all' ? '전체 날짜' : formatDateGroupLabel(dateFilter)} · {visibleCandidates.length}개
                  </span>
                  <button type="button" className="rounded-xl border border-amber-300/35 px-3 py-2 font-black text-amber-100 hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={!visibleCandidates.length} onClick={(event) => { event.preventDefault(); saveVisibleToPending(); }}>
                    {variantFilter === 'all' ? '전체 저장' : '현재 카테고리 저장'}
                  </button>
                  <button type="button" className="rounded-xl border border-[#c8ff00]/35 px-3 py-2 font-black text-[#c8ff00] hover:bg-[#c8ff00]/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={!visibleCandidates.length} onClick={(event) => { event.preventDefault(); markVisibleCompleted(); }}>
                    {variantFilter === 'all' ? '전체 완료 처리' : '현재 카테고리 완료 처리'}
                  </button>
                  <button type="button" className="rounded-xl border border-red-400/35 px-3 py-2 font-black text-red-200 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={!visibleCandidates.length} onClick={(event) => { event.preventDefault(); removeVisibleCandidates(); }}>
                    {variantFilter === 'all' ? '전체 목록 제거' : '현재 카테고리 목록 제거'}
                  </button>
                </div>
              </>
            ) : null}

            <div className="mt-5 grid gap-4 2xl:grid-cols-2">
              {candidates.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-slate-400 2xl:col-span-2">
                  아직 업로드 후보가 없습니다. 영상과 TXT를 대기 목록에 모은 뒤 매칭 실행을 눌러주세요.
                </div>
              ) : null}

              {visibleCandidateDateGroups.map((group) => (
                <section key={group.dateKey} className="rounded-[24px] border border-[#c8ff00]/15 bg-[#c8ff00]/5 p-3 2xl:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-black text-white">{group.label}</h3>
                      <p className="mt-1 text-xs text-lime-100/75">이 날짜 후보 {group.items.length}개</p>
                      <div className="mt-2"><VariantCountChips items={group.items} /></div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-black">
                      <button type="button" className="rounded-xl border border-[#c8ff00]/35 px-3 py-2 text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => selectDateCategory(group.dateKey)}>
                        이 날짜 선택
                      </button>
                      <button type="button" className="rounded-xl border border-red-400/35 px-3 py-2 text-red-200 hover:bg-red-500/10" onClick={() => removeCandidatesByDate(group.dateKey)}>
                        이 날짜 후보 제거
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-4 2xl:grid-cols-2">
              {group.items.map((candidate, index) => {
                const form = formMap[candidate.id] || {};
                const checked = selected.has(candidate.id);
                const variant = candidateVariant(candidate);
                const profileMismatch = Boolean(selectedProfileVariant && variant !== selectedProfileVariant);
                const uploadState = getCandidateUploadState(candidate);
                const uploadCard = uploadState.card;
                const uploadJobItem = uploadState.jobItem;
                const currentStatus = uploadState.status;
                return (
                  <article key={candidate.id} className={`rounded-2xl border p-3 transition ${checked ? 'border-[#c8ff00]/60 bg-[#c8ff00]/8' : 'border-white/10 bg-black/25 hover:border-white/20'}`}>
                    <div className="grid grid-cols-[24px_96px_minmax(0,1fr)] gap-3">
                      <input type="checkbox" className="mt-2 h-4 w-4 accent-[#c8ff00]" checked={checked} onChange={() => toggle(candidate.id)} />
                      <button
                        type="button"
                        className="group block overflow-hidden rounded-xl border border-white/10 bg-black/35 text-left hover:border-[#c8ff00]/50"
                        onClick={() => setPreviewCandidate(candidate)}
                      >
                        <div className="h-36 w-full bg-black">
                          {candidate.previewUrl ? (
                            <video src={candidate.previewUrl} className="h-full w-full object-cover opacity-80 group-hover:opacity-100" muted preload="metadata" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[11px] text-slate-500">미리보기 없음</div>
                          )}
                        </div>
                        <div className="p-2">
                          <div className="text-[11px] font-black text-white">재생/확인</div>
                          <div className="mt-1 text-[11px] text-[#c8ff00]">{formatBytes(candidate.sizeBytes)}</div>
                        </div>
                      </button>

                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          <span className="rounded-full bg-white/8 px-2 py-1 font-black text-white">#{index + 1}</span>
                          <span className={`rounded-full border px-2 py-1 font-bold ${variantBadgeClass(variant)}`}>{variantLabel(variant)}</span>
                          {candidate.metadataOriginalName ? (
                            <span className="rounded-full bg-lime-400/10 px-2 py-1 font-bold text-lime-200">TXT 매칭</span>
                          ) : (
                            <span className="rounded-full bg-amber-400/10 px-2 py-1 font-bold text-amber-200">TXT 없음</span>
                          )}
                          <span className={`rounded-full border px-2 py-1 font-black ${uploadStatusClass(currentStatus)}`}>{uploadStatusLabel(currentStatus)}</span>
                        </div>
                        <div className="truncate text-xs text-slate-400">{candidate.originalName}</div>
                        {uploadCard?.youtubeUrl ? (
                          <a href={uploadCard.youtubeUrl} target="_blank" rel="noreferrer" className="block truncate rounded-lg border border-[#c8ff00]/20 bg-[#c8ff00]/10 px-3 py-2 text-xs font-bold text-[#c8ff00] hover:bg-[#c8ff00]/15">
                            YouTube 열기: {uploadCard.youtubeUrl}
                          </a>
                        ) : null}
                        {uploadCard?.pendingReason ? (
                          <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
                            보류 사유: {uploadCard.pendingReason}
                          </div>
                        ) : null}
                        {profileMismatch ? (
                          <div className="rounded-lg border border-red-300/25 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-100">
                            현재 선택 채널은 {variantLabel(selectedProfileVariant)} 전용입니다. 이 카드는 {variantLabel(variant)}라서 업로드할 수 없습니다.
                          </div>
                        ) : null}
                        {uploadJobItem?.progress ? (
                          <div className="rounded-lg border border-sky-300/20 bg-sky-300/10 px-3 py-2 text-xs text-sky-100">
                            업로드 진행률: {uploadJobItem.progress}%
                          </div>
                        ) : null}
                        <label className="block space-y-1">
                          <span className="text-xs font-bold text-slate-300">업로드 제목</span>
                          <input className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={stripLeadingUploadTitleMarker(form.title || '')} maxLength={100} onChange={(event) => updateForm(candidate.id, { title: event.target.value })} />
                        </label>
                        <div className="grid gap-2 md:grid-cols-[1fr_170px]">
                          <label className="block space-y-1">
                            <span className="text-xs font-bold text-slate-300">태그</span>
                            <input className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-[#c8ff00]/60" value={form.tagsText || ''} onChange={(event) => updateForm(candidate.id, { tagsText: event.target.value })} />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-xs font-bold text-slate-300">예약</span>
                            <input type="datetime-local" className="w-full rounded-lg border border-white/10 bg-black/35 px-2 py-2 text-xs text-white outline-none focus:border-[#c8ff00]/60" value={form.publishAt || ''} onChange={(event) => updateForm(candidate.id, { publishAt: event.target.value, privacyStatus: event.target.value ? 'private' : form.privacyStatus })} />
                          </label>
                        </div>
                        <details className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                          <summary className="cursor-pointer text-xs font-black text-slate-200">설명/검수 상세 열기</summary>
                          <div className="mt-3 space-y-3">
                            <label className="block space-y-1">
                              <span className="text-xs font-bold text-slate-300">업로드 설명</span>
                              <textarea className="min-h-[96px] w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-[#c8ff00]/60" value={form.description || ''} placeholder={candidate.metadataOriginalName ? '' : 'TXT가 없어 설명을 자동으로 채우지 못했습니다.'} onChange={(event) => updateForm(candidate.id, { description: event.target.value })} />
                            </label>
                            <ReviewBlock review={candidate.review} />
                          </div>
                        </details>
                        <div className="grid gap-2 md:grid-cols-2">
                          <label className="space-y-1">
                            <span className="text-xs font-bold text-slate-300">공개 상태</span>
                            <select className="w-full rounded-lg border border-white/10 bg-black/35 px-2 py-2 text-xs text-white outline-none focus:border-[#c8ff00]/60" value={form.publishAt ? 'private' : (form.privacyStatus || 'private')} disabled={Boolean(form.publishAt)} onChange={(event) => updateForm(candidate.id, { privacyStatus: event.target.value })}>
                              <option value="private">비공개</option>
                              <option value="unlisted">일부 공개</option>
                              <option value="public">공개</option>
                            </select>
                          </label>
                          <button type="button" className="mt-5 rounded-lg border border-[#c8ff00]/35 px-3 py-2 text-xs font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => markCandidatesCompleted([candidate.id])}>
                            완료 처리
                          </button>
                        </div>
                        <div className="grid gap-2 md:grid-cols-4">
                          <button type="button" className="rounded-lg border border-amber-300/35 px-3 py-2 text-xs font-black text-amber-100 hover:bg-amber-300/10" onClick={() => saveCandidatesToPending([candidate.id])}>
                            저장하기
                          </button>
                          {uploadCard ? (
                            <button type="button" className="rounded-lg border border-white/15 px-3 py-2 text-xs font-black text-slate-200 hover:bg-white/10" onClick={loadUploadLists}>
                              상태 새로고침
                            </button>
                          ) : (
                            <span className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-500">저장 전</span>
                          )}
                          <button type="button" className="rounded-lg border border-red-400/35 px-3 py-2 text-xs font-black text-red-200 hover:bg-red-500/10" onClick={() => removeCandidate(candidate)}>
                            목록에서 제거
                          </button>
                          {uploadCard?.youtubeUrl ? (
                            <a href={uploadCard.youtubeUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-sky-300/35 px-3 py-2 text-center text-xs font-black text-sky-100 hover:bg-sky-300/10">
                              업로드 보기
                            </a>
                          ) : (
                            <span className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-500">썸네일로 확인</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </main>

        <aside className="space-y-4">
          <div className="rounded-[26px] border border-white/10 bg-white/[0.04] p-5">
            <h2 className="text-lg font-black text-white">YouTube 채널 프로필</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              업로드할 채널을 카드로 관리합니다. 여러 채널을 연결한 뒤, 선택된 채널로만 업로드됩니다.
            </p>
            <div className="mt-4 space-y-3">
              {profiles.length ? profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  active={profile.id === selectedProfileId}
                  draftName={profileDraftNames[profile.id] ?? profile.name ?? ''}
                  draftPurpose={profileDraftPurposes[profile.id] ?? profile.purpose ?? ''}
                  draftClientId={profileDraftClientIds[profile.id] ?? profile.oauthClientId ?? ''}
                  draftClientSecret={profileDraftClientSecrets[profile.id] ?? ''}
                  draftRedirectUri={profileDraftRedirectUris[profile.id] ?? profile.oauthRedirectUri ?? DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI}
                  onSelect={selectProfile}
                  onSave={saveProfile}
                  onDelete={deleteProfile}
                  onNameChange={updateProfileDraftName}
                  onPurposeChange={updateProfileDraftPurpose}
                  onClientIdChange={updateProfileDraftClientId}
                  onClientSecretChange={updateProfileDraftClientSecret}
                  onRedirectUriChange={updateProfileDraftRedirectUri}
                  onReconnect={reconnectProfile}
                />
              )) : (
                <div className="rounded-2xl border border-dashed border-white/15 p-4 text-sm text-slate-400">
                  아직 저장된 채널 프로필이 없습니다.
                </div>
              )}
            </div>

            <label className="mt-4 block space-y-1">
              <span className="text-xs font-bold text-slate-300">새 채널 관리 이름</span>
              <input
                className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60"
                value={newProfileName}
                placeholder="예: 한국어 하이라이트 채널"
                onChange={(event) => setNewProfileName(event.target.value)}
              />
            </label>
            <label className="mt-3 block space-y-1">
              <span className="text-xs font-bold text-slate-300">새 채널 용도</span>
              <select className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={newProfilePurpose} onChange={(event) => setNewProfilePurpose(event.target.value)}>
                <option value="">미지정</option>
                {CHANNEL_PURPOSES.map((purpose) => (<option key={purpose.value} value={purpose.value}>{purpose.label}</option>))}
              </select>
            </label>
            <label className="mt-3 block space-y-1">
              <span className="text-xs font-bold text-slate-300">새 채널 OAuth Client ID</span>
              <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={newProfileClientId} placeholder="1234567890-xxxx.apps.googleusercontent.com" onChange={(event) => setNewProfileClientId(event.target.value)} />
            </label>
            <label className="mt-3 block space-y-1">
              <span className="text-xs font-bold text-slate-300">새 채널 OAuth Client Secret</span>
              <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={newProfileClientSecret} placeholder="GOCSPX-..." onChange={(event) => setNewProfileClientSecret(event.target.value)} />
            </label>
            <label className="mt-3 block space-y-1">
              <span className="text-xs font-bold text-slate-300">새 채널 Redirect URI</span>
              <input className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none focus:border-[#c8ff00]/60" value={newProfileRedirectUri} placeholder={DEFAULT_YOUTUBE_OAUTH_REDIRECT_URI} onChange={(event) => setNewProfileRedirectUri(event.target.value)} />
            </label>
            <div className="mt-4 flex flex-col gap-2">
              <button type="button" className="rounded-2xl bg-[#c8ff00] px-4 py-3 text-sm font-black text-black hover:brightness-110" onClick={createProfileAndConnect}>
                새 채널 추가 + OAuth 연결
              </button>
              <button type="button" className="rounded-2xl border border-[#c8ff00]/35 px-4 py-3 text-sm font-bold text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={() => reconnectProfile(selectedProfileId)}>
                선택 채널 재연결
              </button>
              <button type="button" className="rounded-2xl border border-white/15 px-4 py-3 text-sm font-bold text-white hover:bg-white/10" onClick={testAuth}>
                선택 채널 권한 테스트
              </button>
              <button type="button" className="rounded-2xl border border-white/15 px-4 py-3 text-sm font-bold text-white hover:bg-white/10" onClick={loadProfiles}>
                프로필 목록 새로고침
              </button>
            </div>
            {selectedProfile ? <p className="mt-3 text-sm text-[#c8ff00]">현재 업로드 채널: {selectedProfile.channelTitle || selectedProfile.name}</p> : null}
            {selectedProfile ? (
              <p className={`mt-2 text-xs font-bold ${selectedProfileVariant ? 'text-slate-300' : 'text-amber-200'}`}>
                채널 용도: {purposeLabel(selectedProfilePurpose)} {selectedProfileVariant ? `· 업로드 가능: ${variantLabel(selectedProfileVariant)}` : '· 업로드 전 용도 지정 필요'}
              </p>
            ) : null}
            {authInfo?.channelTitle ? <p className="mt-2 text-sm text-[#c8ff00]">테스트 채널: {authInfo.channelTitle}</p> : null}
            {oauthUrl ? (
              <a href={oauthUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-2xl border border-[#c8ff00]/30 px-4 py-3 text-sm font-bold text-[#c8ff00] hover:bg-[#c8ff00]/10">
                OAuth 링크 새 창에서 열기
              </a>
            ) : null}
          </div>

          <div className="rounded-[26px] border border-[#c8ff00]/20 bg-[#c8ff00]/8 p-5">
            <h2 className="text-lg font-black text-white">예약 발행 일괄 적용</h2>
            <label className="mt-4 block space-y-1">
              <span className="text-xs font-bold text-lime-100">시작 시간</span>
              <input type="datetime-local" className="w-full rounded-xl border border-[#c8ff00]/20 bg-black/45 px-3 py-2 text-sm text-white" value={scheduleBase} onChange={(event) => setScheduleBase(event.target.value)} />
            </label>
            <label className="mt-3 block space-y-1">
              <span className="text-xs font-bold text-lime-100">간격(분)</span>
              <input type="number" min="0" className="w-full rounded-xl border border-[#c8ff00]/20 bg-black/45 px-3 py-2 text-sm text-white" value={scheduleInterval} onChange={(event) => setScheduleInterval(event.target.value)} />
            </label>
            <button type="button" className="mt-4 w-full rounded-2xl border border-[#c8ff00]/40 px-4 py-3 text-sm font-black text-[#c8ff00] hover:bg-[#c8ff00]/10" onClick={applyScheduleToSelected}>
              선택 항목에 예약 적용
            </button>
          </div>

          <div className="rounded-[26px] border border-white/10 bg-white/[0.04] p-5">
            <h2 className="text-lg font-black text-white">3. 업로드</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-2xl bg-black/35 p-3"><div className="text-slate-500">선택</div><div className="text-2xl font-black text-[#c8ff00]">{selectedCandidates.length}</div></div>
              <div className="rounded-2xl bg-black/35 p-3"><div className="text-slate-500">전체</div><div className="text-2xl font-black text-white">{candidates.length}</div></div>
            </div>
            <button type="button" className="mt-4 w-full rounded-2xl bg-[#c8ff00] px-4 py-4 text-sm font-black text-black hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" onClick={startUpload} disabled={Boolean(uploadBlockedReason) || uploadBusy}>
              {uploadBusy ? '업로드 작업 진행 중' : '선택 영상 업로드 시작'}
            </button>
            {uploadBlockedReason && !uploadBusy ? (
              <div className="mt-2 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs font-bold text-amber-100">
                {uploadBlockedReason}
              </div>
            ) : null}
            <button type="button" className="mt-2 w-full rounded-2xl border border-amber-300/40 px-4 py-3 text-sm font-black text-amber-100 hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-40" onClick={saveSelectedToPending} disabled={!selectedCandidates.length}>
              선택 카드 저장
            </button>
            <button type="button" className="mt-2 w-full rounded-2xl border border-[#c8ff00]/40 px-4 py-3 text-sm font-black text-[#c8ff00] hover:bg-[#c8ff00]/10 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => markCandidatesCompleted([...selected])} disabled={!selectedCandidates.length}>
              선택 영상을 완료 목록에 저장
            </button>
            {job?.jobId ? <button type="button" className="mt-2 w-full rounded-2xl border border-red-400/40 px-4 py-3 text-sm font-bold text-red-200 hover:bg-red-500/10" onClick={cancelJob}>업로드 작업 취소</button> : null}
            <div className="mt-4 rounded-2xl bg-black/35 p-3 text-sm text-slate-300">
              <div className="font-bold text-white">상태: {status}</div>
              {message ? <div className="mt-2 text-amber-200">{message}</div> : null}
            </div>
          </div>

          <SmallCardList
            title="업로드 보류 목록"
            subtitle="나중에 다시 올릴 후보 카드입니다."
            count={visiblePendingUploads.length}
            items={visiblePendingUploads}
            emptyText="현재 보류된 업로드가 없습니다."
            accent="amber"
            onRefresh={loadUploadLists}
            onRestore={restoreUploadCards}
            onDelete={deleteUploadCard}
            onDeleteDate={deleteUploadCardsForDate}
          />

          <SmallCardList
            title="업로드 완료 히스토리"
            subtitle="완료된 업로드 URL과 카드를 보관합니다."
            count={visibleUploadHistory.length}
            items={visibleUploadHistory}
            emptyText="아직 완료 히스토리가 없습니다."
            onRefresh={loadUploadLists}
            onRestore={restoreUploadCards}
            onDelete={deleteUploadCard}
            onDeleteDate={deleteUploadCardsForDate}
            onOpen={setHistoryDetail}
          />

        </aside>
      </section>

      {previewCandidate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => setPreviewCandidate(null)}>
          <div className="w-full max-w-4xl rounded-[28px] border border-white/10 bg-[#080d0b] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-white">영상 미리보기</h2>
                <p className="mt-1 max-w-2xl break-all text-xs text-slate-400">{previewCandidate.originalName}</p>
              </div>
              <button type="button" className="rounded-xl border border-white/15 px-3 py-2 text-sm font-bold text-white hover:bg-white/10" onClick={() => setPreviewCandidate(null)}>
                닫기
              </button>
            </div>
            {previewCandidate.previewUrl ? (
              <video className="mt-4 max-h-[70vh] w-full rounded-2xl bg-black object-contain" src={previewCandidate.previewUrl} controls autoPlay />
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-white/15 p-10 text-center text-slate-400">미리보기 영상을 찾을 수 없습니다.</div>
            )}
          </div>
        </div>
      ) : null}

      {historyDetail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => setHistoryDetail(null)}>
          <div className="w-full max-w-2xl rounded-[28px] border border-white/10 bg-[#080d0b] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-white">업로드 카드 상세</h2>
                <p className="mt-1 text-sm text-slate-400">{historyDetail.title || historyDetail.originalName}</p>
              </div>
              <button type="button" className="rounded-xl border border-white/15 px-3 py-2 text-sm font-bold text-white hover:bg-white/10" onClick={() => setHistoryDetail(null)}>
                닫기
              </button>
            </div>
            <div className="mt-4 space-y-3 text-sm text-slate-300">
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-xs font-black text-slate-500">YouTube URL</div>
                {historyDetail.youtubeUrl ? (
                  <a href={historyDetail.youtubeUrl} target="_blank" rel="noreferrer" className="break-all text-[#c8ff00] hover:underline">{historyDetail.youtubeUrl}</a>
                ) : <span>-</span>}
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-xs font-black text-slate-500">설명</div>
                <div className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap">{historyDetail.description || '-'}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl bg-[#c8ff00] px-4 py-2 text-xs font-black text-black" onClick={() => restoreUploadCards([historyDetail.cardId || historyDetail.id])}>
                  후보로 불러와 수정/재업로드
                </button>
                <button type="button" className="rounded-xl border border-red-400/35 px-4 py-2 text-xs font-black text-red-200" onClick={() => deleteUploadCard(historyDetail.cardId || historyDetail.id)}>
                  카드 삭제
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
