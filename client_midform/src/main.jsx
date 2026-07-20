import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'paused_review', 'blocked_preflight']);

const STATUS_LABELS = {
  queued: '대기',
  running: '실행 중',
  paused_review: '검수 대기 중',
  blocked_preflight: 'preflight 경고',
  completed: '완료',
  completed_with_warnings: '완료 (경고)',
  failed: '실패',
  pending: '대기',
  processing: '처리 중',
  skipped: '건너뜀',
  fresh: 'fresh',
  done: 'done',
  rejected: 'rejected'
};

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || `Request failed: ${response.status}`;
    const error = new Error(message);
    error.details = data.details || {};
    error.code = data.code || 'REQUEST_FAILED';
    throw error;
  }
  return data;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('ko-KR').format(number) : '—';
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function shortPath(value) {
  if (!value) return '—';
  const text = String(value);
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join('/');
}

function humanizeRunError(error) {
  if (!error) return '';
  if (Array.isArray(error.details?.errors) && error.details.errors.length) {
    return error.details.errors.join(' / ');
  }
  if (error.code === 'MIDFORM_REVIEW_NOT_PAUSED') return '이미 진행이 끝난 실행이거나 검수 대기 상태가 아닙니다.';
  if (error.code === 'MIDFORM_PREFLIGHT_NOT_BLOCKED') return '이 실행은 preflight 경고 대기 상태가 아닙니다.';
  if (error.code === 'MIDFORM_PREFLIGHT_OVERRIDE_FORBIDDEN') return '자동 실행 경로에서는 preflight 오버라이드를 사용할 수 없습니다.';
  if (error.code === 'MIDFORM_PIPELINE_BUSY') return '다른 실행이 아직 진행 중입니다. 잠시 후 다시 시도해 주세요.';
  if (error.code === 'MIDFORM_REVIEW_ARTIFACTS_NOT_FOUND') return '검수용 파일이 아직 준비되지 않았습니다.';
  return error.message || '요청 처리 중 오류가 발생했습니다.';
}

function splitNarrationSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function estimateSpeechSeconds(text) {
  const visible = String(text || '').replace(/\s+/g, '').length;
  return Number((visible / 5.5).toFixed(2));
}

function isBlackTransitionScene(scene) {
  const text = [scene?.visible_action, scene?.translated_caption_ko, scene?.vertical_crop_note]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /검은색|검은 화면|black/.test(text);
}

function computePreviewBudget(slot, allSlots, geminiAnalysis, sourceDurationSec, tailAllowanceSec = 7) {
  const sourceRange = Array.isArray(slot?.source_range) ? slot.source_range : [0, 0];
  const startSec = Number(sourceRange[0] || 0);
  const endSec = Number(sourceRange[1] || 0);
  const narrationSlots = (allSlots || []).filter((item) => item?.type === 'narration');
  const isLastNarration = narrationSlots.length && narrationSlots[narrationSlots.length - 1]?.slot_id === slot?.slot_id;
  if (!isLastNarration) {
    return { gapSec: Math.max(0, endSec - startSec), visibleGapSec: Math.max(0, endSec - startSec), lastVisibleEndSec: endSec, tailAllowanceSec: 0, isLastNarration: false };
  }
  const sceneMap = new Map((geminiAnalysis?.scenes || []).map((scene) => [scene.scene_id, scene]));
  const visibleEnds = (slot?.scene_ids || [])
    .map((sceneId) => sceneMap.get(sceneId))
    .filter(Boolean)
    .filter((scene) => !isBlackTransitionScene(scene))
    .map((scene) => Number(scene.end_sec || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const lastVisibleEndSec = visibleEnds.length ? Math.max(...visibleEnds) : Math.min(endSec, Number(sourceDurationSec || endSec));
  const visibleGapSec = Math.max(0, lastVisibleEndSec - startSec);
  return {
    gapSec: visibleGapSec + tailAllowanceSec,
    visibleGapSec,
    lastVisibleEndSec,
    tailAllowanceSec,
    isLastNarration: true
  };
}

function buildReviewModel(reviewPayload) {
  const previewData = reviewPayload?.previewData || {};
  const slotFills = reviewPayload?.slotFills || { slot_fills: [] };
  const segments = Array.isArray(previewData.segments) ? previewData.segments : [];
  const slots = Array.isArray(previewData.slotMap?.slots) ? previewData.slotMap.slots : [];
  const fillsById = new Map((slotFills.slot_fills || []).map((fill) => [fill.slot_id, fill]));
  const ttsUnitsBySegment = new Map();
  for (const unit of previewData.ttsUnits || []) {
    const segmentId = String(unit.segment_id || '');
    if (!segmentId) continue;
    const bucket = ttsUnitsBySegment.get(segmentId) || [];
    bucket.push(unit);
    ttsUnitsBySegment.set(segmentId, bucket);
  }
  const sourceDurationSec = Number(previewData.slotMap?.source_duration_sec || 0);
  const reviewSlots = slots.map((slot) => {
    const slotId = String(slot.slot_id || '');
    const segment = segments.find((item) => String(item.segment_id || '') === slotId) || {};
    const fill = fillsById.get(slotId) || {};
    const unitRows = (ttsUnitsBySegment.get(slotId) || []).map((unit) => ({ id: unit.caption_id, text: String(unit.text || '') }));
    const initialSentences = unitRows.length
      ? unitRows
      : splitNarrationSentences(fill.narration || segment.narration || '').map((text, index) => ({ id: `${slotId}_sent_${String(index + 1).padStart(3, '0')}`, text }));
    const budget = computePreviewBudget(slot, slots, previewData.geminiAnalysis || {}, sourceDurationSec, 7);
    return {
      slotId,
      type: String(slot.type || ''),
      sourceRange: Array.isArray(slot.source_range) ? slot.source_range : [0, 0],
      role: segment.storytelling_role || slot.dialogue_heavy_role || '',
      dialogueText: segment.dialogue_original || slot.caption_source_text || '',
      lipSyncRisk: slot.lip_sync_risk === true,
      sentences: initialSentences,
      initialSentences,
      budget
    };
  });
  return { ...reviewPayload, reviewSlots };
}

function StatusPill({ status }) {
  return <span className={`status-pill status-${status || 'pending'}`}>{STATUS_LABELS[status] || status || '대기'}</span>;
}

function TabBar({ activeTab, onChange }) {
  const tabs = [
    ['runner', '러너'],
    ['channels', '채널'],
    ['materials', '소재']
  ];
  return (
    <nav className="tab-bar">
      {tabs.map(([id, label]) => (
        <button key={id} className={activeTab === id ? 'tab-button active' : 'tab-button'} onClick={() => onChange(id)}>{label}</button>
      ))}
    </nav>
  );
}

function RunForm({ onRunStarted, draft, onDraftChange }) {
  const [sourceVideoPath, setSourceVideoPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const state = await requestJson('/api/midform/pipeline/run', {
        method: 'POST',
        body: JSON.stringify({ sourceUrl: draft.sourceUrl, sourceVideoPath, movieTitle: draft.movieTitle, pauseBeforeTts: draft.pauseBeforeTts === true, interactiveMode: true })
      });
      onRunStarted(state.runId);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel launch-panel">
      <div className="section-kicker">새 실행</div>
      <h2>소스 하나를 봉인된 미드폼 파이프라인에 투입합니다.</h2>
      <form onSubmit={handleSubmit}>
        <label>
          영상 URL
          <input value={draft.sourceUrl} onChange={(event) => onDraftChange({ ...draft, sourceUrl: event.target.value })} placeholder="https://..." />
        </label>
        <div className="or-rule"><span>또는</span></div>
        <label>
          로컬 source video path
          <input value={sourceVideoPath} onChange={(event) => setSourceVideoPath(event.target.value)} placeholder="input/source_clean.mp4" />
        </label>
        <label>
          영화 제목 보정값
          <input value={draft.movieTitle} onChange={(event) => onDraftChange({ ...draft, movieTitle: event.target.value })} placeholder="예: Fantastic Four" />
        </label>
        <label className="check-label launch-check">
          <input type="checkbox" checked={draft.pauseBeforeTts === true} onChange={(event) => onDraftChange({ ...draft, pauseBeforeTts: event.target.checked })} />
          TTS 생성 전에 대본 검수하기
        </label>
        {error ? <p className="error-box">{error.code}: {error.message}</p> : null}
        <button disabled={submitting || (!draft.sourceUrl.trim() && !sourceVideoPath.trim())}>
          {submitting ? '런 생성 중…' : '파이프라인 실행'}
        </button>
      </form>
    </section>
  );
}

function Timeline({ steps = [] }) {
  return (
    <section className="panel timeline-panel">
      <div className="section-kicker">단계 타임라인</div>
      <div className="timeline">
        {steps.map((step, index) => (
          <article key={step.id} className={`step-card step-${step.status}`} style={{ '--delay': `${index * 60}ms` }}>
            <div className="step-index">{String(index + 1).padStart(2, '0')}</div>
            <div>
              <h3>{step.label}</h3>
              <StatusPill status={step.status} />
              <p>{step.summary || step.error?.message || '아직 실행되지 않았습니다.'}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ResumeSummary({ summary }) {
  if (!summary) return null;
  return (
    <div className="resume-summary">
      <div><span>reused</span><strong>{formatNumber(summary.reused_count)}</strong></div>
      <div><span>regenerated</span><strong>{formatNumber(summary.regenerated_count)}</strong></div>
      <div><span>changed slots</span><strong>{summary.changed_segment_ids?.join(', ') || '없음'}</strong></div>
    </div>
  );
}

function QualityWarningsPanel({ warnings = [] }) {
  if (!Array.isArray(warnings) || !warnings.length) return null;
  return (
    <section className="panel preflight-panel">
      <div className="review-header">
        <div>
          <div className="section-kicker">quality warnings</div>
          <h2>초안은 생성됐지만 사람이 손봐야 하는 슬롯이 남아 있습니다.</h2>
        </div>
        <span className="budget-pill warning">{warnings.length}건</span>
      </div>
      <div className="preflight-grid">
        {warnings.map((warning, index) => (
          <article key={`${warning.slot_id || 'global'}-${warning.rule_code}-${index}`} className="review-slot">
            <div className="review-slot-header">
              <strong>{warning.slot_id || 'global'} · {warning.rule_code}</strong>
              <span className="budget-pill warning">{warning.actual != null && warning.threshold != null ? `${warning.actual} / ${warning.threshold}` : '경고'}</span>
            </div>
            <p className="dialogue-context">{warning.message}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function PreflightPanel({ run, onRunUpdated, onNotice }) {
  const [overriding, setOverriding] = useState(false);
  const preflightGate = run.preflightGate || {};
  const rejectReasons = Array.isArray(preflightGate.rejectReasons) ? preflightGate.rejectReasons : [];
  if (!run || !rejectReasons.length) return null;

  async function handleOverride() {
    if (!run?.runId) return;
    setOverriding(true);
    try {
      const nextRun = await requestJson(`/api/midform/pipeline/run/${run.runId}/override-preflight`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      onRunUpdated(nextRun);
      onNotice('preflight 경고를 확인한 뒤 계속 진행했습니다.');
    } catch (error) {
      onNotice(humanizeRunError(error));
    } finally {
      setOverriding(false);
    }
  }

  return (
    <section className="panel preflight-panel">
      <div className="review-header">
        <div>
          <div className="section-kicker">preflight material gate</div>
          <h2>자동 경고를 확인하고 계속 진행할지 결정하세요.</h2>
          <p className="muted">{run.status === 'blocked_preflight' ? '사람이 직접 고른 소재이므로 여기서는 하드 차단 대신 경고 후 수동 오버라이드를 허용합니다.' : '이 실행은 preflight에서 거부된 과거 기록입니다. 아래 값으로 오탐 여부를 판단할 수 있습니다.'}</p>
        </div>
        <StatusPill status={run.status} />
      </div>
      <div className="preflight-grid">
        {rejectReasons.map((reason) => (
          <article key={reason.code} className="review-slot">
            <div className="review-slot-header">
              <strong>{reason.code}</strong>
              <span className="budget-pill warning">{reason.actual != null && reason.threshold != null ? `${reason.actual} / ${reason.threshold}` : '경고'}</span>
            </div>
            <p className="dialogue-context">{reason.message}</p>
            {reason.context ? (
              <div className="review-meta muted">
                utterances {reason.context.utterance_count ?? '—'} / min {reason.context.min_utterances ?? '—'} · speech {reason.context.total_speech_sec ?? '—'}s / source {reason.context.source_duration_sec ?? '—'}s
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {run.status === 'blocked_preflight' ? (
        <div className="review-actions">
          <button disabled={overriding} onClick={handleOverride}>{overriding ? '계속 진행 중…' : '그래도 진행'}</button>
        </div>
      ) : null}
    </section>
  );
}

function ReviewPanel({ run, onRunUpdated, onNotice }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState(null);
  const [saveNotice, setSaveNotice] = useState('');
  const [reviewModel, setReviewModel] = useState(null);

  const loadReview = useCallback(async () => {
    if (!run?.runId || run.status !== 'paused_review') return;
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson(`/api/midform/pipeline/run/${run.runId}/review`);
      setReviewModel(buildReviewModel(payload));
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoading(false);
    }
  }, [run?.runId, run?.status]);

  useEffect(() => {
    setSaveNotice('');
    setReviewModel(null);
    loadReview().catch(() => {});
  }, [loadReview]);

  const modifiedCount = useMemo(() => {
    if (!reviewModel) return 0;
    return reviewModel.reviewSlots.reduce((count, slot) => {
      if (slot.type !== 'narration') return count;
      const current = slot.sentences.map((item) => item.text.trim()).filter(Boolean);
      const original = slot.initialSentences.map((item) => item.text.trim()).filter(Boolean);
      return count + (JSON.stringify(current) === JSON.stringify(original) ? 0 : 1);
    }, 0);
  }, [reviewModel]);

  const updatedSlots = useMemo(() => {
    if (!reviewModel) return [];
    return reviewModel.reviewSlots.map((slot) => {
      if (slot.type !== 'narration') return { ...slot, narrationText: '', estimatedSpeechSec: 0, overBudget: false };
      const narrationText = slot.sentences.map((item) => item.text.trim()).filter(Boolean).join(' ').trim();
      const estimatedSpeechSec = estimateSpeechSeconds(narrationText);
      const overBudget = estimatedSpeechSec > Number(slot.budget?.gapSec || 0) + 0.05;
      return { ...slot, narrationText, estimatedSpeechSec, overBudget };
    });
  }, [reviewModel]);

  function updateSentence(slotId, sentenceId, value) {
    setReviewModel((current) => {
      if (!current) return current;
      return {
        ...current,
        reviewSlots: current.reviewSlots.map((slot) => slot.slotId !== slotId
          ? slot
          : {
            ...slot,
            sentences: slot.sentences.map((sentence) => sentence.id === sentenceId ? { ...sentence, text: value } : sentence)
          })
      };
    });
  }

  function deleteSentence(slotId, sentenceId) {
    setReviewModel((current) => {
      if (!current) return current;
      return {
        ...current,
        reviewSlots: current.reviewSlots.map((slot) => slot.slotId !== slotId
          ? slot
          : {
            ...slot,
            sentences: slot.sentences.filter((sentence) => sentence.id !== sentenceId)
          })
      };
    });
  }

  async function saveSlotFills() {
    if (!reviewModel) return;
    setSaving(true);
    setError(null);
    try {
      const nextSlotFills = {
        ...reviewModel.slotFills,
        slot_fills: (reviewModel.slotFills.slot_fills || []).map((fill) => {
          const slot = updatedSlots.find((item) => item.slotId === fill.slot_id);
          if (!slot || slot.type !== 'narration') return fill;
          const captionUnits = slot.sentences.map((item) => item.text.trim()).filter(Boolean);
          const narration = captionUnits.join(' ').trim();
          return {
            ...fill,
            narration,
            caption_units: captionUnits,
            caption_kr: narration
          };
        })
      };
      await requestJson(`/api/midform/pipeline/run/${run.runId}/review/slot-fills`, {
        method: 'PUT',
        body: JSON.stringify(nextSlotFills)
      });
      setReviewModel((current) => current ? { ...current, slotFills: nextSlotFills, reviewSlots: updatedSlots.map((slot) => ({ ...slot, initialSentences: slot.sentences })) } : current);
      setSaveNotice(`${modifiedCount}개 문장을 저장했습니다. 이 문장들만 재합성 대상으로 계산됩니다.`);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setSaving(false);
    }
  }

  async function resumeRun() {
    if (!run?.runId) return;
    setResuming(true);
    setError(null);
    setSaveNotice('재검증 → 재합성 → 조립을 진행 중입니다…');
    try {
      const resumed = await requestJson(`/api/midform/pipeline/run/${run.runId}/resume`, { method: 'POST', body: JSON.stringify({}) });
      onRunUpdated(resumed);
      setSaveNotice('검수 통과 후 조립까지 완료했습니다. 재사용/재합성 요약을 확인하세요.');
    } catch (requestError) {
      setError(requestError);
      setSaveNotice('');
      onNotice(humanizeRunError(requestError));
      const refreshed = await requestJson(`/api/midform/pipeline/run/${run.runId}`);
      onRunUpdated(refreshed);
      await loadReview();
    } finally {
      setResuming(false);
    }
  }

  if (run.status !== 'paused_review') return null;

  return (
    <section className="panel review-panel">
      <div className="review-header">
        <div>
          <div className="section-kicker">검수 체크포인트</div>
          <h2>문장 수정/삭제 후 resume 하세요.</h2>
          <p className="muted">dialogue는 읽기 전용입니다. narration만 수정할 수 있고, 저장된 문장 수만 재합성 대상으로 안내됩니다.</p>
        </div>
        <StatusPill status={run.status} />
      </div>
      {loading ? <div className="notice compact">검수 데이터를 불러오는 중…</div> : null}
      {saveNotice ? <div className="notice compact">{saveNotice}</div> : null}
      {error ? <div className="error-box">{humanizeRunError(error)}</div> : null}
      {reviewModel ? <ResumeSummary summary={run.artifacts?.ttsReuseSummary} /> : null}
      <div className="review-toolbar">
        <div className="muted">{modifiedCount}개 문장이 변경되었습니다.</div>
        <div className="review-actions">
          <button className="mini-button" disabled={saving || resuming || !modifiedCount} onClick={saveSlotFills}>{saving ? '저장 중…' : 'slot_fills 저장'}</button>
          <button disabled={resuming} onClick={resumeRun}>{resuming ? '계속 진행 중…' : '검수 완료, 계속 진행'}</button>
        </div>
      </div>
      <div className="review-list">
        {updatedSlots.map((slot) => (
          <article key={slot.slotId} className={slot.type === 'dialogue' ? 'review-slot dialogue' : 'review-slot'}>
            <div className="review-slot-header">
              <strong>{slot.type === 'dialogue' ? `[dialogue ${slot.slotId}]` : `[narration ${slot.slotId}] ${slot.role || ''}`}</strong>
              {slot.type === 'narration' ? <span className={slot.overBudget ? 'budget-pill warning' : 'budget-pill'}>{slot.estimatedSpeechSec.toFixed(2)}s / {Number(slot.budget?.gapSec || 0).toFixed(2)}s{slot.overBudget ? ' ⚠' : ''}</span> : <span className="budget-pill muted">context only</span>}
            </div>
            <div className="review-meta muted">
              source {Number(slot.sourceRange?.[0] || 0).toFixed(2)}–{Number(slot.sourceRange?.[1] || 0).toFixed(2)}
              {slot.type === 'narration' && slot.budget?.isLastNarration ? ` · last visible ${Number(slot.budget.lastVisibleEndSec || 0).toFixed(2)}s` : ''}
            </div>
            {slot.type === 'dialogue' ? <p className="dialogue-context">{slot.dialogueText || '원문 없음'}</p> : (
              <div className="sentence-list">
                {slot.sentences.map((sentence) => (
                  <div key={sentence.id} className="sentence-row">
                    <span className="sentence-id">{sentence.id}</span>
                    <input value={sentence.text} onChange={(event) => updateSentence(slot.slotId, sentence.id, event.target.value)} />
                    <button type="button" className="mini-button danger" onClick={() => deleteSentence(slot.slotId, sentence.id)}>삭제</button>
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="review-summary-grid">
        <div><span>payoff</span><strong>{(reviewModel.previewData?.slotMap?.slots || []).filter((slot) => slot.type === 'narration').slice(-1).map((slot) => slot.slot_id).join(', ') || '—'}</strong></div>
        <div><span>time coordinates</span><strong>source / timeline 분리 표기</strong></div>
        <div><span>resume target</span><strong>{modifiedCount ? `${modifiedCount}개 슬롯 변경` : '변경 없음'}</strong></div>
      </div>
    </section>
  );
}

function ArtifactGrid({ run }) {
  const artifacts = run?.artifacts || {};
  const draft = artifacts.draft || {};
  const canDownloadSrt = Boolean(artifacts.srtPath);
  const canDownloadDraft = Boolean(artifacts.draftZipPath);
  const reuseSummary = artifacts.ttsReuseSummary || null;
  return (
    <section className="panel artifact-panel">
      <div className="section-kicker">결과 검토</div>
      <div className="artifact-grid">
        <div><span>Transcript</span><strong>{shortPath(artifacts.transcriptPath)}</strong></div>
        <div><span>Slot map</span><strong>{shortPath(artifacts.slotMapPath)}</strong></div>
        <div><span>Script</span><strong>{shortPath(artifacts.scriptPath)}</strong></div>
        <div><span>Draft duration</span><strong>{draft.totalDurationSec ? `${draft.totalDurationSec.toFixed(1)}s` : '—'}</strong></div>
      </div>
      <div className="download-row">
        <a className={canDownloadSrt ? 'download-link' : 'download-link disabled'} href={canDownloadSrt ? apiUrl(`/api/midform/pipeline/run/${run.runId}/srt`) : undefined}>SRT 다운로드</a>
        <a className={canDownloadDraft ? 'download-link primary' : 'download-link primary disabled'} href={canDownloadDraft ? apiUrl(`/api/midform/pipeline/run/${run.runId}/draft.zip`) : undefined}>CapCut ZIP 다운로드</a>
        <a className="download-link" href={apiUrl(`/api/midform/pipeline/run/${run.runId}/artifacts.zip`)}>실행 폴더 ZIP</a>
      </div>
      {reuseSummary ? <ResumeSummary summary={reuseSummary} /> : null}
    </section>
  );
}

function CurrentRun({ run, onRunUpdated, onNotice }) {
  if (!run) {
    return (
      <section className="panel empty-run">
        <div className="radar" />
        <h2>아직 선택된 런이 없습니다.</h2>
        <p>소재 탭에서 [실행]을 누르거나 URL을 직접 입력하면 단계 상태가 여기에 고정됩니다.</p>
      </section>
    );
  }
  return (
    <div className="run-stack">
      <section className="panel run-header">
        <div>
          <div className="section-kicker">현재 런</div>
          <h2>{run.input?.movieTitle || run.input?.sourceUrl || run.runId}</h2>
          <p>{run.runId}</p>
        </div>
        <StatusPill status={run.status} />
      </section>
      {run.error ? <div className="error-box large">{humanizeRunError(run.error)}</div> : null}
      <PreflightPanel run={run} onRunUpdated={onRunUpdated} onNotice={onNotice} />
      <QualityWarningsPanel warnings={run.qualityWarnings} />
      <ReviewPanel run={run} onRunUpdated={onRunUpdated} onNotice={onNotice} />
      <Timeline steps={run.steps} />
      <ArtifactGrid run={run} />
    </div>
  );
}

function History({ runs, selectedRunId, onSelect }) {
  return (
    <section className="panel history-panel">
      <div className="section-kicker">실행 이력</div>
      <div className="history-list">
        {runs.length ? runs.map((run) => (
          <button key={run.runId} className={run.runId === selectedRunId ? 'history-item selected' : 'history-item'} onClick={() => onSelect(run.runId)}>
            <span>{run.input?.movieTitle || run.input?.sourceUrl || run.runId}</span>
            <small>{formatDate(run.createdAt)} · {STATUS_LABELS[run.status] || run.status}</small>
          </button>
        )) : <p className="muted">저장된 실행 이력이 없습니다.</p>}
      </div>
    </section>
  );
}

function RunnerTab({ runs, selectedRunId, setSelectedRunId, currentRun, runDraft, setRunDraft, onRunStarted, onRunUpdated, onNotice }) {
  return (
    <div className="workspace-grid">
      <aside>
        <RunForm onRunStarted={onRunStarted} draft={runDraft} onDraftChange={setRunDraft} />
        <History runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
      </aside>
      <CurrentRun run={currentRun} onRunUpdated={onRunUpdated} onNotice={onNotice} />
    </div>
  );
}

function ChannelsTab({ onPickChannel }) {
  const [channels, setChannels] = useState([]);
  const [counts, setCounts] = useState(null);
  const [gradeFilter, setGradeFilter] = useState('all');
  const [sort, setSort] = useState('grade');
  const [scanning, setScanning] = useState('');
  const [selectedHandles, setSelectedHandles] = useState(() => new Set());
  const [message, setMessage] = useState('');

  const loadChannels = useCallback(async () => {
    const data = await requestJson('/api/midform/channels');
    setChannels(data.channels || []);
    setCounts(data.counts || null);
  }, []);

  useEffect(() => { loadChannels().catch((error) => setMessage(`${error.code}: ${error.message}`)); }, [loadChannels]);

  const filtered = useMemo(() => {
    const gradeRank = { S: 0, A: 1, B: 2, X: 3, 미분석: 4 };
    let rows = channels;
    if (gradeFilter === 'unanalyzed') rows = rows.filter((row) => row.grade === '미분석');
    else if (gradeFilter === 'scanned') rows = rows.filter((row) => row.analyzed);
    else if (gradeFilter !== 'all') rows = rows.filter((row) => row.grade === gradeFilter);
    return [...rows].sort((a, b) => {
      if (sort === 'median') return Number(b.medianViews || 0) - Number(a.medianViews || 0);
      return (gradeRank[a.grade] ?? 9) - (gradeRank[b.grade] ?? 9) || Number(b.medianViews || 0) - Number(a.medianViews || 0);
    });
  }, [channels, gradeFilter, sort]);

  async function scanChannel(handle) {
    setScanning(handle);
    setMessage('yt-dlp metadata scan queued. 다운로드 없이 최신/인기 메타만 수집합니다.');
    try {
      const result = await requestJson(`/api/midform/channels/${encodeURIComponent(handle)}/scan`, { method: 'POST', body: JSON.stringify({}) });
      setMessage(result.cached ? `${handle}: 24시간 캐시 사용` : `${handle}: 소재 ${result.added}개 병합`);
      await loadChannels();
      onPickChannel(handle);
    } catch (error) {
      setMessage(`${error.code}: ${error.message}`);
    } finally {
      setScanning('');
    }
  }

  async function scanSelected() {
    const handles = Array.from(selectedHandles);
    for (let index = 0; index < handles.length; index += 1) {
      setMessage(`일괄 스캔 ${index + 1}/${handles.length}: ${handles[index]}`);
      await scanChannel(handles[index]);
    }
    setSelectedHandles(new Set());
    setMessage(`일괄 스캔 완료: ${handles.length}개 채널 처리`);
  }

  function toggleHandle(handle) {
    setSelectedHandles((current) => {
      const next = new Set(current);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  }

  return (
    <section className="panel browser-panel">
      <div className="browser-header">
        <div>
          <div className="section-kicker">채널 레지스트리</div>
          <h2>411개 핸들을 등급 데이터와 조인합니다.</h2>
          <p className="muted">등급 조인 {counts?.graded ?? '—'}개 · 미분석 {counts?.unanalyzed ?? '—'}개</p>
        </div>
        <div className="filter-row">
          <select value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)}>
            <option value="all">전체</option>
            <option value="S">S</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="X">X</option>
            <option value="unanalyzed">미분석만</option>
            <option value="scanned">스캔 완료만</option>
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="grade">등급순</option>
            <option value="median">조회수 중앙값순</option>
          </select>
          <button className="mini-button" disabled={!selectedHandles.size || Boolean(scanning)} onClick={scanSelected}>선택 {selectedHandles.size}개 스캔</button>
        </div>
      </div>
      {message ? <div className="notice compact">{message}</div> : null}
      <div className="data-table channel-table">
        <div className="table-row table-head"><span>선택</span><span>채널 핸들</span><span>등급</span><span>영상 수</span><span>미드폼 비율</span><span>조회수 중앙값</span><span>마지막 스캔</span><span>액션</span></div>
        {filtered.map((channel) => (
          <div className="table-row" key={channel.handle}>
            <span><input className="row-check" type="checkbox" checked={selectedHandles.has(channel.handle)} onChange={() => toggleHandle(channel.handle)} /></span>
            <span>{channel.handle}</span>
            <span><b className={`grade grade-${channel.grade}`}>{channel.grade}</b></span>
            <span>{formatNumber(channel.videoCount)}</span>
            <span>{channel.analyzed ? `${Math.round(channel.midformRatio * 100)}%` : '—'}</span>
            <span>{formatNumber(channel.medianViews)}</span>
            <span>{channel.lastScannedAt || '—'}</span>
            <span><button className="mini-button" disabled={Boolean(scanning)} onClick={() => scanChannel(channel.handle)}>{scanning === channel.handle ? '수집 중…' : '영상 불러오기'}</button></span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MaterialsTab({ focusHandle, onRunMaterial }) {
  const [materials, setMaterials] = useState([]);
  const [counts, setCounts] = useState(null);
  const [sort, setSort] = useState('views');
  const [sourceTag, setSourceTag] = useState('');
  const [grade, setGrade] = useState('');
  const [durationDefault, setDurationDefault] = useState(true);
  const [freshDefault, setFreshDefault] = useState(true);
  const [message, setMessage] = useState('');

  const loadMaterials = useCallback(async () => {
    const params = new URLSearchParams({ sort, durationDefault: String(durationDefault), freshDefault: String(freshDefault) });
    if (sourceTag) params.set('source_tag', sourceTag);
    if (grade) params.set('grade', grade);
    if (focusHandle) params.set('handle', focusHandle);
    const data = await requestJson(`/api/midform/materials?${params.toString()}`);
    setMaterials(data.materials || []);
    setCounts(data.counts || null);
  }, [sort, sourceTag, grade, durationDefault, freshDefault, focusHandle]);

  useEffect(() => { loadMaterials().catch((error) => setMessage(`${error.code}: ${error.message}`)); }, [loadMaterials]);

  async function reload() {
    await requestJson('/api/midform/materials/reload', { method: 'POST', body: JSON.stringify({}) });
    await loadMaterials();
    setMessage('CSV와 scanned 소재 풀을 다시 로드했습니다.');
  }

  return (
    <section className="panel browser-panel">
      <div className="browser-header">
        <div>
          <div className="section-kicker">소재 풀</div>
          <h2>legend + seed + scanned 영상을 URL 기준으로 병합합니다.</h2>
          <p className="muted">legend {counts?.legendRows ?? '—'}개 · seed {counts?.seedRows ?? '—'}개 · 현재 표시 {materials.length}개</p>
        </div>
        <button className="mini-button" onClick={reload}>CSV 재로드</button>
      </div>
      <div className="filter-row wide">
        <label className="check-label"><input type="checkbox" checked={durationDefault} onChange={(event) => setDurationDefault(event.target.checked)} /> 길이 90~240초</label>
        <label className="check-label"><input type="checkbox" checked={freshDefault} onChange={(event) => setFreshDefault(event.target.checked)} /> fresh만</label>
        <select value={sourceTag} onChange={(event) => setSourceTag(event.target.value)}><option value="">source 전체</option><option value="legend">legend</option><option value="seed">seed</option><option value="scanned">scanned</option></select>
        <select value={grade} onChange={(event) => setGrade(event.target.value)}><option value="">등급 전체</option><option value="S,A">S/A</option><option value="S">S</option><option value="A">A</option></select>
        <select value={sort} onChange={(event) => setSort(event.target.value)}><option value="views">조회수</option><option value="multiplier">배수</option><option value="upload_date">업로드일</option><option value="duration">길이</option></select>
      </div>
      {message ? <div className="notice compact">{message}</div> : null}
      <div className="material-list">
        {materials.map((material) => (
          <article key={material.url} className={material.durationOk ? 'material-card' : 'material-card muted-row'}>
            <img src={material.thumbnailUrl || ''} alt="" loading="lazy" />
            <div className="material-main">
              <h3>{material.title || material.url}</h3>
              <p>{material.channelHandle || material.channelName || 'unknown'} · {formatDuration(material.durationSec)} · {formatNumber(material.viewCount)} views</p>
              <div className="badge-row">
                <span className="source-badge">{material.sourceTag}</span>
                <StatusPill status={material.status} />
                {material.channelGrade ? <span className={`grade grade-${material.channelGrade}`}>{material.channelGrade}</span> : null}
                {material.viewsVsChannelMedian ? <span className="source-badge">x{Number(material.viewsVsChannelMedian).toFixed(1)}</span> : null}
                {material.suitabilityBadges?.map((badge) => <span className="fit-badge" key={badge}>{badge}</span>)}
              </div>
            </div>
            <div className="material-actions">
              <span>{material.uploadDate || '—'}</span>
              {material.runId ? <small>{material.runId}</small> : null}
              <button className="mini-button" onClick={() => onRunMaterial(material)}>실행</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('runner');
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [currentRun, setCurrentRun] = useState(null);
  const [notice, setNotice] = useState('');
  const [runDraft, setRunDraft] = useState({ sourceUrl: '', movieTitle: '', pauseBeforeTts: false });
  const [focusHandle, setFocusHandle] = useState('');

  const refreshRuns = useCallback(async () => {
    const data = await requestJson('/api/midform/pipeline/runs');
    setRuns(data.runs || []);
    if (!selectedRunId && data.runs?.[0]?.runId) setSelectedRunId(data.runs[0].runId);
  }, [selectedRunId]);

  const refreshCurrentRun = useCallback(async () => {
    if (!selectedRunId) return;
    const data = await requestJson(`/api/midform/pipeline/run/${selectedRunId}`);
    setCurrentRun(data);
  }, [selectedRunId]);

  useEffect(() => { refreshRuns().catch((error) => setNotice(`${error.code}: ${error.message}`)); }, [refreshRuns]);
  useEffect(() => { refreshCurrentRun().catch((error) => setNotice(`${error.code}: ${error.message}`)); }, [refreshCurrentRun]);
  useEffect(() => {
    if (!currentRun || TERMINAL_STATUSES.has(currentRun.status)) return undefined;
    const timer = window.setInterval(() => {
      refreshCurrentRun().catch((error) => setNotice(`${error.code}: ${error.message}`));
      refreshRuns().catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [currentRun, refreshCurrentRun, refreshRuns]);

  const activeCount = useMemo(() => runs.filter((run) => run.status === 'running' || run.status === 'queued').length, [runs]);

  const handleRunUpdated = useCallback((nextRun) => {
    setCurrentRun(nextRun);
    refreshRuns().catch(() => {});
  }, [refreshRuns]);

  function handleRunStarted(runId) {
    setSelectedRunId(runId);
    setActiveTab('runner');
    setNotice('런이 생성되었습니다. Vertex quota 보호를 위해 동시 실행은 1개로 제한됩니다.');
    refreshRuns().catch(() => {});
  }

  function handlePickChannel(handle) {
    setFocusHandle(handle);
    setActiveTab('materials');
  }

  function handleRunMaterial(material) {
    setRunDraft((current) => ({ ...current, sourceUrl: material.url || '', movieTitle: material.movieTitleGuess || '' }));
    setActiveTab('runner');
    setNotice(`${material.channelHandle || '소재'} URL을 러너에 채웠습니다.`);
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">MIDFORM CONTROL ROOM</p>
          <h1>채널에서 소재를 고르고, 봉인된 파이프라인으로 넘깁니다.</h1>
          <p className="hero-copy">411개 채널 레지스트리, 등급 분석, 영상 풀, 실행 이력을 한 화면에 묶어 fresh 소재만 빠르게 선별합니다.</p>
        </div>
        <div className="hero-meter"><span>ACTIVE RUNS</span><strong>{activeCount}</strong></div>
      </header>
      <TabBar activeTab={activeTab} onChange={setActiveTab} />
      {notice ? <div className="notice">{notice}</div> : null}
      {activeTab === 'runner' ? <RunnerTab runs={runs} selectedRunId={selectedRunId} setSelectedRunId={setSelectedRunId} currentRun={currentRun} runDraft={runDraft} setRunDraft={setRunDraft} onRunStarted={handleRunStarted} onRunUpdated={handleRunUpdated} onNotice={setNotice} /> : null}
      {activeTab === 'channels' ? <ChannelsTab onPickChannel={handlePickChannel} /> : null}
      {activeTab === 'materials' ? <MaterialsTab focusHandle={focusHandle} onRunMaterial={handleRunMaterial} /> : null}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
