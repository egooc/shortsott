import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import JsonViewer from '../components/JsonViewer';
import { api } from '../lib/api';
import { usePipelineStore } from '../store/pipelineStore';

function compact(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function boolLabel(value) {
  return value ? 'Yes' : 'No';
}

function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function defaultReviewDraft() {
  return {
    selected_claude_template: 'movie_recap',
    template_selection_reason: '',
    reviewer_notes: '',
    checks: {
      timecodes_ok: false,
      key_scenes_ok: false,
      dopamine_anchors_ok: false,
      risks_reviewed: false,
      cleanup_reviewed: false,
      story_angles_ok: false,
      ready_for_claude: false
    },
    blockingIssuesText: '',
    warningsText: ''
  };
}

export default function Phase2Analysis() {
  const navigate = useNavigate();
  const selectedVideo = usePipelineStore((s) => s.phase1.selectedVideo);
  const setPhase2 = usePipelineStore((s) => s.setPhase2);
  const savedSelectedTemplate = usePipelineStore((s) => s.phase2.selectedClaudeTemplate);

  const [file, setFile] = useState(null);
  const [contentType, setContentType] = useState('movie_recap');
  const [status, setStatus] = useState('idle');
  const [analysisId, setAnalysisId] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [savedPath, setSavedPath] = useState('');
  const [error, setError] = useState('');

  const [reviewStatus, setReviewStatus] = useState('not_found');
  const [reviewSavedPath, setReviewSavedPath] = useState('');
  const [reviewBackupPath, setReviewBackupPath] = useState('');
  const [reviewDraft, setReviewDraft] = useState({
    ...defaultReviewDraft(),
    selected_claude_template: savedSelectedTemplate || 'movie_recap'
  });
  const [savingReview, setSavingReview] = useState(false);
  const [activeTab, setActiveTab] = useState('Source Info');

  const [templates, setTemplates] = useState([]);
  const [templatesError, setTemplatesError] = useState('');

  const tabs = useMemo(() => {
    if (!analysis) return [];
    return [
      { label: 'Source Info', data: analysis.source },
      { label: 'Safety Scan', data: analysis.safety_scan },
      { label: 'Story Structure', data: analysis.story_structure },
      { label: 'Clips', data: analysis.clips },
      { label: 'Dopamine Anchors', data: analysis.dopamine_anchors },
      { label: 'Story Angles', data: analysis.recommended_story_angles }
    ];
  }, [analysis]);

  const selectedTemplateMeta = useMemo(
    () => templates.find((t) => t.template_id === reviewDraft.selected_claude_template) || null,
    [templates, reviewDraft.selected_claude_template]
  );

  const summary = useMemo(() => {
    const source = analysis?.source || {};
    const cleanup = analysis?.source_cleanup_scan || {};
    const safety = analysis?.safety_scan || {};
    const clips = Array.isArray(analysis?.clips) ? analysis.clips : [];
    const anchors = Array.isArray(analysis?.dopamine_anchors) ? analysis.dopamine_anchors : [];
    const angles = Array.isArray(analysis?.recommended_story_angles) ? analysis.recommended_story_angles : [];
    return {
      duration: source.duration_timecode || source.duration_sec || '-',
      aspect_ratio: source.aspect_ratio || '-',
      content_type: source.content_type || contentType,
      overall_summary: source.overall_summary || '-',
      has_burned_subtitles: boolLabel(source.has_burned_subtitles),
      subtitle_position: source.subtitle_position || 'none',
      has_watermark: boolLabel(source.has_watermark),
      watermark_position: source.watermark_position || 'none',
      has_top_title_overlay: boolLabel(source.has_top_title_overlay),
      cleanup_required: boolLabel(cleanup.cleanup_required),
      monetization_risk: safety.monetization_risk || '-',
      clips_count: clips.length,
      anchors_count: anchors.length,
      angles_count: angles.length
    };
  }, [analysis, contentType]);

  const allChecksTrue = useMemo(
    () => Object.values(reviewDraft.checks || {}).every((v) => v === true),
    [reviewDraft.checks]
  );

  const canProceedPhase3 =
    reviewStatus === 'approved'
    && reviewDraft.checks?.ready_for_claude === true
    && Boolean(reviewDraft.selected_claude_template);

  useEffect(() => {
    loadTemplates();
    loadExistingReview();
  }, []);

  async function loadTemplates() {
    try {
      const res = await api.get('/claude/templates');
      const nextTemplates = Array.isArray(res.data?.templates) ? res.data.templates : [];
      setTemplates(nextTemplates);
      setTemplatesError('');
      if (nextTemplates.length > 0) {
        setReviewDraft((prev) => {
          if (nextTemplates.some((t) => t.template_id === prev.selected_claude_template)) {
            return prev;
          }
          return { ...prev, selected_claude_template: nextTemplates[0].template_id };
        });
      }
    } catch (err) {
      setTemplates([]);
      setTemplatesError(err.response?.data?.message || err.message);
    }
  }

  async function loadExistingReview() {
    try {
      const res = await api.get('/gemini/review');
      const review = res.data?.review || {};
      setReviewStatus(review.status || 'unknown');
      setReviewSavedPath(res.data?.savedPath || '');
      setReviewDraft({
        ...defaultReviewDraft(),
        reviewer_notes: review.reviewer_notes || '',
        selected_claude_template: review.selected_claude_template || savedSelectedTemplate || 'movie_recap',
        template_selection_reason: review.template_selection_reason || '',
        checks: {
          ...defaultReviewDraft().checks,
          ...(review.checks || {})
        },
        blockingIssuesText: Array.isArray(review.blocking_issues) ? review.blocking_issues.join('\n') : '',
        warningsText: Array.isArray(review.warnings) ? review.warnings.join('\n') : ''
      });
      setPhase2({
        geminiReview: review,
        geminiReviewPath: res.data?.savedPath || null,
        selectedClaudeTemplate: review.selected_claude_template || savedSelectedTemplate || 'movie_recap'
      });
    } catch (err) {
      if (err.response?.status === 404) {
        setReviewStatus('not_found');
        return;
      }
      setError(err.response?.data?.message || err.message);
    }
  }

  async function onAnalyze() {
    if (!file) return;
    setStatus('uploading');
    setError('');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('contentType', contentType);
    if (selectedVideo) {
      formData.append(
        'selectedSource',
        JSON.stringify({
          platform: selectedVideo.platform,
          url: selectedVideo.url,
          creator: selectedVideo.creator,
          handle: selectedVideo.handle,
          views: selectedVideo.views,
          viralityScore: selectedVideo.viralityScore,
          publishedAt: selectedVideo.publishedAt,
          comet_id: selectedVideo.comet_id || selectedVideo.cometId || '',
          comet_name: selectedVideo.comet_name || selectedVideo.cometName || ''
        })
      );
    }

    try {
      const res = await api.post('/gemini/analyze', formData);
      const nextAnalysisId = res.data.analysisId;
      setSavedPath(res.data.plannedSavePath || '');
      setAnalysisId(nextAnalysisId);
      setPhase2({
        analysisId: nextAnalysisId,
        uploadedFileName: file.name,
        geminiAnalysisPath: res.data.plannedSavePath || null
      });
      setStatus('processing');

      const timer = setInterval(async () => {
        const jobRes = await api.get(`/gemini/analyze/${nextAnalysisId}`);
        const job = jobRes.data;
        setStatus(job.status);

        if (job.status === 'completed') {
          setAnalysis(job.result);
          setSavedPath(job.savedPath || res.data.plannedSavePath || '');
          setPhase2({
            geminiAnalysis: job.result,
            geminiAnalysisPath: job.savedPath || res.data.plannedSavePath || null
          });
          clearInterval(timer);
          setReviewStatus('not_reviewed');
          setReviewDraft((prev) => ({
            ...defaultReviewDraft(),
            selected_claude_template: prev.selected_claude_template || 'movie_recap'
          }));
        }

        if (job.status === 'failed') {
          setError(job.error?.message || 'analysis failed');
          clearInterval(timer);
        }
      }, 5000);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setStatus('failed');
    }
  }

  async function saveReview(targetStatus = null) {
    setSavingReview(true);
    setError('');
    try {
      const payload = {
        status: targetStatus || (allChecksTrue ? 'approved' : 'needs_revision'),
        selected_claude_template: reviewDraft.selected_claude_template,
        template_selection_reason: reviewDraft.template_selection_reason,
        reviewer_notes: reviewDraft.reviewer_notes,
        checks: reviewDraft.checks,
        blocking_issues: splitLines(reviewDraft.blockingIssuesText),
        warnings: splitLines(reviewDraft.warningsText)
      };
      const res = await api.post('/gemini/review', payload);
      const review = res.data?.review || {};
      setReviewStatus(review.status || 'unknown');
      setReviewSavedPath(res.data?.savedPath || '');
      setReviewBackupPath(res.data?.backupPath || '');
      setReviewDraft((prev) => ({
        ...prev,
        selected_claude_template: review.selected_claude_template || prev.selected_claude_template,
        template_selection_reason: review.template_selection_reason || prev.template_selection_reason,
        reviewer_notes: review.reviewer_notes || '',
        checks: { ...prev.checks, ...(review.checks || {}) },
        blockingIssuesText: Array.isArray(review.blocking_issues) ? review.blocking_issues.join('\n') : '',
        warningsText: Array.isArray(review.warnings) ? review.warnings.join('\n') : ''
      }));
      setPhase2({
        geminiReview: review,
        geminiReviewPath: res.data?.savedPath || null,
        selectedClaudeTemplate: review.selected_claude_template || reviewDraft.selected_claude_template
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setSavingReview(false);
    }
  }

  const copyJson = async () => {
    if (!analysis) return;
    await navigator.clipboard.writeText(JSON.stringify(analysis, null, 2));
  };

  const openOriginal = () => {
    if (!selectedVideo?.url) return;
    window.open(selectedVideo.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Phase 2: Gemini Video Analysis</h1>

      {selectedVideo ? (
        <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700">
          <p className="font-semibold">{selectedVideo.title || selectedVideo.description || '-'}</p>
          <p className="text-xs text-slate-500">
            {selectedVideo.platform || '-'} / {selectedVideo.creator || '-'} {selectedVideo.handle ? `(${selectedVideo.handle})` : ''}
          </p>
          <p className="text-xs text-slate-500">
            views {compact(selectedVideo.views)} / virality {selectedVideo.viralityScore ?? '-'} / published {selectedVideo.publishedAt || '-'}
          </p>
          <div className="mt-2">
            <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs" onClick={openOriginal} disabled={!selectedVideo.url}>
              Open Original
            </button>
          </div>
        </div>
      ) : null}

      <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
        <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <select className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={contentType} onChange={(e) => setContentType(e.target.value)}>
          <option value="movie_recap">Movie Recap</option>
          <option value="pet_compilation">Pet Compilation</option>
          <option value="general">General</option>
        </select>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white" onClick={onAnalyze} disabled={!file}>
          Start Gemini Analysis
        </button>
      </div>

      <div className="rounded-md bg-slate-100 px-3 py-2 text-sm">
        Status: {status} {analysisId ? `(${analysisId})` : ''}
      </div>
      {savedPath ? <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Saved path: {savedPath}</div> : null}
      {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      {analysis ? (
        <>
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <h2 className="mb-2 text-sm font-semibold">Gemini Analysis Summary</h2>
            <div className="grid gap-2 text-xs md:grid-cols-2 xl:grid-cols-3">
              <p>duration: {summary.duration}</p>
              <p>aspect_ratio: {summary.aspect_ratio}</p>
              <p>content_type: {summary.content_type}</p>
              <p>has_burned_subtitles: {summary.has_burned_subtitles}</p>
              <p>subtitle_position: {summary.subtitle_position}</p>
              <p>has_watermark: {summary.has_watermark}</p>
              <p>watermark_position: {summary.watermark_position}</p>
              <p>has_top_title_overlay: {summary.has_top_title_overlay}</p>
              <p>cleanup_required: {summary.cleanup_required}</p>
              <p>monetization_risk: {summary.monetization_risk}</p>
              <p>clips_count: {summary.clips_count}</p>
              <p>dopamine_anchors_count: {summary.anchors_count}</p>
              <p>story_angles_count: {summary.angles_count}</p>
            </div>
            <p className="mt-2 text-xs text-slate-600">overall_summary: {summary.overall_summary}</p>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap gap-2">
              {tabs.map((t) => (
                <button
                  key={t.label}
                  className={`rounded-md border px-2 py-1 text-xs ${activeTab === t.label ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'}`}
                  onClick={() => setActiveTab(t.label)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <JsonViewer title={activeTab} data={tabs.find((t) => t.label === activeTab)?.data || {}} />
            <div className="mt-2 flex gap-2">
              <button className="rounded-md border border-slate-300 px-3 py-2 text-xs" onClick={() => setActiveTab('Source Info')}>
                View JSON
              </button>
              <button className="rounded-md border border-slate-300 px-3 py-2 text-xs" onClick={copyJson}>
                Copy JSON
              </button>
            </div>
          </div>
        </>
      ) : null}

      <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
        <h2 className="text-sm font-semibold">Phase2.5 Gemini Review + Claude Template</h2>
        <p className="text-xs text-slate-600">
          You must approve Gemini review and choose a Claude template before Phase3 script generation.
        </p>
        <p className="text-xs text-slate-600">
          current review status: <span className="font-semibold">{reviewStatus}</span>
        </p>
        {reviewSavedPath ? <p className="text-xs text-slate-500">review path: {reviewSavedPath}</p> : null}
        {reviewBackupPath ? <p className="text-xs text-slate-500">review backup: {reviewBackupPath}</p> : null}

        <div className="space-y-1">
          <label className="block text-xs font-medium">Claude template</label>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={reviewDraft.selected_claude_template}
            onChange={(e) =>
              setReviewDraft((prev) => ({
                ...prev,
                selected_claude_template: e.target.value
              }))
            }
          >
            {templates.map((t) => (
              <option key={t.template_id} value={t.template_id} disabled={t.enabled === false}>
                {t.template_name || t.template_id} ({t.template_id}) {t.enabled === false ? '- disabled' : ''}
              </option>
            ))}
          </select>
          {selectedTemplateMeta?.description ? <p className="text-xs text-slate-500">{selectedTemplateMeta.description}</p> : null}
          {templatesError ? <p className="text-xs text-red-600">{templatesError}</p> : null}
        </div>

        <label className="block text-xs">
          template_selection_reason
          <textarea
            rows={2}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={reviewDraft.template_selection_reason}
            onChange={(e) =>
              setReviewDraft((prev) => ({
                ...prev,
                template_selection_reason: e.target.value
              }))
            }
          />
        </label>

        <div className="grid gap-2 text-sm md:grid-cols-2">
          {Object.entries(reviewDraft.checks).map(([key, value]) => (
            <label key={key} className="rounded-md border border-slate-200 px-3 py-2 text-xs">
              <input
                type="checkbox"
                className="mr-2"
                checked={Boolean(value)}
                onChange={(e) =>
                  setReviewDraft((prev) => ({
                    ...prev,
                    checks: { ...prev.checks, [key]: e.target.checked }
                  }))
                }
              />
              {key}
            </label>
          ))}
        </div>

        <label className="block text-xs">
          reviewer_notes
          <textarea
            rows={3}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={reviewDraft.reviewer_notes}
            onChange={(e) => setReviewDraft((prev) => ({ ...prev, reviewer_notes: e.target.value }))}
          />
        </label>

        <div className="grid gap-2 md:grid-cols-2">
          <label className="text-xs">
            blocking_issues (one per line)
            <textarea
              rows={3}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={reviewDraft.blockingIssuesText}
              onChange={(e) => setReviewDraft((prev) => ({ ...prev, blockingIssuesText: e.target.value }))}
            />
          </label>
          <label className="text-xs">
            warnings (one per line)
            <textarea
              rows={3}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={reviewDraft.warningsText}
              onChange={(e) => setReviewDraft((prev) => ({ ...prev, warningsText: e.target.value }))}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => saveReview(null)}
            disabled={savingReview}
          >
            {savingReview ? 'Saving...' : 'Approve Gemini Review'}
          </button>
          <button
            type="button"
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800"
            onClick={() => saveReview('needs_revision')}
            disabled={savingReview}
          >
            Needs Revision
          </button>
          <button type="button" className="rounded-md border border-slate-300 px-4 py-2 text-sm" onClick={loadExistingReview} disabled={savingReview}>
            Load Saved Review
          </button>
        </div>

        {!canProceedPhase3 ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Gemini review approval + ready_for_claude + selected_claude_template are required before Phase3.
          </p>
        ) : null}
      </div>

      <button
        className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
        onClick={() => navigate('/phase-3')}
        disabled={!canProceedPhase3}
      >
        Go to Phase 3
      </button>
    </div>
  );
}
