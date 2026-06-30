import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import JsonViewer from '../components/JsonViewer';
import { api } from '../lib/api';
import { usePipelineStore } from '../store/pipelineStore';

function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function defaultClaudeReviewDraft(selectedTemplate = '') {
  return {
    selected_template: selectedTemplate || '',
    reviewer_notes: '',
    checks: {
      grounded_in_gemini: false,
      timecodes_valid: false,
      source_clips_valid: false,
      story_recreated_enough: false,
      script_narration_ok: false,
      caption_unit_ready: false,
      risks_reviewed: false,
      ready_for_tts: false
    },
    blockingIssuesText: '',
    warningsText: ''
  };
}

export default function Phase3Script() {
  const navigate = useNavigate();
  const geminiAnalysis = usePipelineStore((s) => s.phase2.geminiAnalysis);
  const geminiReview = usePipelineStore((s) => s.phase2.geminiReview);
  const setPhase3 = usePipelineStore((s) => s.setPhase3);
  const phase3Store = usePipelineStore((s) => s.phase3);

  const [storyAngle, setStoryAngle] = useState('');
  const [targetDuration, setTargetDuration] = useState(90);
  const [tone, setTone] = useState('perspective');

  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState(phase3Store.claudeScript || null);
  const [summary, setSummary] = useState(null);
  const [savedPath, setSavedPath] = useState(phase3Store.claudeScriptPath || '');
  const [error, setError] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);

  const [reviewStatus, setReviewStatus] = useState('not_found');
  const [reviewSavedPath, setReviewSavedPath] = useState('');
  const [reviewBackupPath, setReviewBackupPath] = useState('');
  const [reviewDraft, setReviewDraft] = useState(defaultClaudeReviewDraft(geminiReview?.selected_claude_template || 'movie_recap'));
  const [reviewLoading, setReviewLoading] = useState(false);
  const [templateChecklist, setTemplateChecklist] = useState('');

  const angles = useMemo(() => geminiAnalysis?.recommended_story_angles || [], [geminiAnalysis]);
  const rawJson = useMemo(() => (script ? JSON.stringify(script, null, 2) : ''), [script]);
  const allReviewChecksTrue = useMemo(() => Object.values(reviewDraft.checks || {}).every((v) => v === true), [reviewDraft.checks]);
  const canProceedPhase4 = reviewStatus === 'approved' && reviewDraft.checks?.ready_for_tts === true;

  const scriptStats = useMemo(() => {
    const segments = Array.isArray(script?.segments) ? script.segments : [];
    const sourceClipCount = segments.reduce((sum, seg) => sum + (Array.isArray(seg.source_clips) ? seg.source_clips.length : 0), 0);
    return {
      segmentCount: segments.length,
      sourceClipCount
    };
  }, [script]);

  useEffect(() => {
    loadClaudeReview();
  }, []);

  useEffect(() => {
    const templateId = reviewDraft.selected_template || geminiReview?.selected_claude_template || '';
    if (templateId) loadTemplateChecklist(templateId);
  }, [reviewDraft.selected_template, geminiReview?.selected_claude_template]);

  async function loadTemplateChecklist(templateId) {
    try {
      const res = await api.get(`/claude/templates/${encodeURIComponent(templateId)}`);
      setTemplateChecklist(res.data?.review_checklist || '');
    } catch {
      setTemplateChecklist('');
    }
  }

  async function loadClaudeReview() {
    try {
      const res = await api.get('/claude/review');
      const review = res.data?.review || {};
      setReviewStatus(review.status || 'unknown');
      setReviewSavedPath(res.data?.savedPath || '');
      setReviewDraft({
        ...defaultClaudeReviewDraft(review.selected_template || geminiReview?.selected_claude_template || ''),
        selected_template: review.selected_template || geminiReview?.selected_claude_template || '',
        reviewer_notes: review.reviewer_notes || '',
        checks: { ...defaultClaudeReviewDraft().checks, ...(review.checks || {}) },
        blockingIssuesText: Array.isArray(review.blocking_issues) ? review.blocking_issues.join('\n') : '',
        warningsText: Array.isArray(review.warnings) ? review.warnings.join('\n') : ''
      });
      setPhase3({
        claudeReview: review,
        claudeReviewPath: res.data?.savedPath || null
      });
    } catch (err) {
      if (err.response?.status === 404) {
        setReviewStatus('not_found');
        return;
      }
      setError(err.response?.data?.message || err.message);
    }
  }

  const onGenerate = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/claude/generate-script', {
        geminiAnalysis: geminiAnalysis || undefined,
        storyAngle: storyAngle || angles[0]?.angle_id || 'A-01',
        targetDuration: Number(targetDuration),
        tone,
        contentType: geminiAnalysis?.source?.content_type || 'movie_recap'
      });

      const generatedScript = res.data.script;
      const selectedTemplate = res.data?.selectedTemplate?.template_id || geminiReview?.selected_claude_template || '';

      setScript(generatedScript);
      setSummary(res.data.summary || null);
      setSavedPath(res.data.savedPath || 'script/claude_midform_story.json');
      setShowRawJson(false);
      setReviewStatus('not_reviewed');
      setReviewDraft(defaultClaudeReviewDraft(selectedTemplate));
      setReviewSavedPath('');
      setReviewBackupPath('');

      setPhase3({
        selectedAngle: storyAngle || angles[0]?.angle_id || 'A-01',
        claudeScript: generatedScript,
        claudeScriptPath: res.data.savedPath || null,
        claudeReview: null,
        claudeReviewPath: null
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  const onSaveClaudeReview = async (targetStatus = null) => {
    setReviewLoading(true);
    setError('');
    try {
      const payload = {
        status: targetStatus || (allReviewChecksTrue ? 'approved' : 'needs_revision'),
        selected_template: reviewDraft.selected_template || geminiReview?.selected_claude_template || '',
        reviewer_notes: reviewDraft.reviewer_notes,
        checks: reviewDraft.checks,
        blocking_issues: splitLines(reviewDraft.blockingIssuesText),
        warnings: splitLines(reviewDraft.warningsText)
      };
      const res = await api.post('/claude/review', payload);
      const review = res.data?.review || {};
      setReviewStatus(review.status || 'unknown');
      setReviewSavedPath(res.data?.savedPath || '');
      setReviewBackupPath(res.data?.backupPath || '');
      setReviewDraft((prev) => ({
        ...prev,
        selected_template: review.selected_template || prev.selected_template,
        reviewer_notes: review.reviewer_notes || '',
        checks: { ...prev.checks, ...(review.checks || {}) },
        blockingIssuesText: Array.isArray(review.blocking_issues) ? review.blocking_issues.join('\n') : '',
        warningsText: Array.isArray(review.warnings) ? review.warnings.join('\n') : ''
      }));
      setPhase3({
        claudeReview: review,
        claudeReviewPath: res.data?.savedPath || null
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setReviewLoading(false);
    }
  };

  const copyJson = async () => {
    if (!rawJson) return;
    await navigator.clipboard.writeText(rawJson);
  };

  const selectedTemplate = reviewDraft.selected_template || geminiReview?.selected_claude_template || summary?.selected_template || '-';

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Phase 3: Claude Script Generation + Review Gate</h1>

      <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
        Gemini input: {geminiAnalysis ? 'Loaded from Phase 2 state' : 'Not loaded in UI state (server can read analysis/gemini_analysis.json)'}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold">Story Angle</p>
        {angles.length > 0 ? (
          angles.map((angle) => (
            <label className="block rounded-md border border-slate-200 p-3 text-sm" key={angle.angle_id}>
              <input
                type="radio"
                className="mr-2"
                checked={(storyAngle || angles[0]?.angle_id) === angle.angle_id}
                onChange={() => setStoryAngle(angle.angle_id)}
              />
              {angle.angle_id}: {angle.title || angle.core_argument}
            </label>
          ))
        ) : (
          <p className="text-sm text-slate-500">No recommended story angles in current analysis. Default will be used.</p>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          Target Duration (sec)
          <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" value={targetDuration} onChange={(e) => setTargetDuration(e.target.value)} />
        </label>
        <label className="text-sm">
          Tone
          <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" value={tone} onChange={(e) => setTone(e.target.value)} />
        </label>
      </div>

      <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white" onClick={onGenerate} disabled={loading}>
        {loading ? 'Generating...' : 'Generate Script'}
      </button>

      {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      {script ? (
        <>
          <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm">
            <p className="font-semibold text-emerald-800">Claude Generation Summary</p>
            <p>selected_template: {selectedTemplate || '-'}</p>
            <p>story.title: {script?.story?.title || '-'}</p>
            <p>core_argument: {script?.story?.core_argument || '-'}</p>
            <p>creator_point_of_view: {script?.story?.creator_point_of_view || '-'}</p>
            <p>target_duration_sec: {summary?.target_duration_sec ?? script?.project?.target_duration_sec ?? '-'}</p>
            <p>segments count: {scriptStats.segmentCount}</p>
            <p>estimated_total_duration_sec: {summary?.estimated_total_duration_sec ?? script?.quality_check?.estimated_total_duration_sec ?? '-'}</p>
            <p>source_clips count: {scriptStats.sourceClipCount}</p>
            <p>
              title_candidates:{' '}
              {(summary?.title_candidates || script?.metadata?.title_candidates || []).length
                ? (summary?.title_candidates || script?.metadata?.title_candidates || [])
                  .map((item) => item?.title || '(untitled)')
                  .join(' | ')
                : '-'}
            </p>
            <p>risk_notes: {(summary?.risk_notes || script?.metadata?.risk_notes || []).length ? (summary?.risk_notes || script?.metadata?.risk_notes || []).join(' | ') : '-'}</p>
            <p>saved_path: {savedPath || 'script/claude_midform_story.json'}</p>
          </div>

          <div className="flex gap-2">
            <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={copyJson}>
              Copy JSON
            </button>
            <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={() => setShowRawJson((prev) => !prev)}>
              {showRawJson ? 'Hide JSON' : 'View JSON'}
            </button>
          </div>

          {showRawJson ? <JsonViewer title="Claude Script JSON" data={script} /> : null}

          <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
            <h2 className="text-sm font-semibold">Phase3.5 Claude Result Review</h2>
            <p className="text-xs text-slate-600">
              Validate Claude output before TTS generation.
            </p>
            <p className="text-xs text-slate-600">
              current review status: <span className="font-semibold">{reviewStatus}</span>
            </p>
            {reviewSavedPath ? <p className="text-xs text-slate-500">review path: {reviewSavedPath}</p> : null}
            {reviewBackupPath ? <p className="text-xs text-slate-500">review backup: {reviewBackupPath}</p> : null}

            <div className="space-y-1">
              <label className="block text-xs font-medium">selected_template</label>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={reviewDraft.selected_template || ''}
                onChange={(e) => setReviewDraft((prev) => ({ ...prev, selected_template: e.target.value }))}
              />
            </div>

            {templateChecklist ? (
              <details className="rounded-md border border-slate-200 bg-slate-50 p-2">
                <summary className="cursor-pointer text-xs font-medium text-slate-700">Template review checklist reference</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{templateChecklist}</pre>
              </details>
            ) : null}

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
                className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                onClick={() => onSaveClaudeReview(null)}
                disabled={reviewLoading}
              >
                {reviewLoading ? 'Saving...' : 'Approve Claude Result'}
              </button>
              <button
                className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800"
                onClick={() => onSaveClaudeReview('needs_revision')}
                disabled={reviewLoading}
              >
                Needs Revision
              </button>
              <button className="rounded-md border border-slate-300 px-4 py-2 text-sm" onClick={loadClaudeReview} disabled={reviewLoading}>
                Load Saved Review
              </button>
            </div>

            {!canProceedPhase4 ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Claude result must be reviewed and approved before TTS generation.
              </p>
            ) : null}
          </div>

          <button
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            onClick={() => navigate('/phase-4')}
            disabled={!canProceedPhase4}
          >
            Go to Phase 4
          </button>
        </>
      ) : null}
    </div>
  );
}
