import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SegmentEditor from '../components/SegmentEditor';
import VoiceSelector from '../components/VoiceSelector';
import AudioPlayer from '../components/AudioPlayer';
import { api } from '../lib/api';
import { usePipelineStore } from '../store/pipelineStore';

export default function Phase4TTS() {
  const navigate = useNavigate();
  const claudeScript = usePipelineStore((s) => s.phase3.claudeScript);
  const phase3 = usePipelineStore((s) => s.phase3);
  const setPhase3 = usePipelineStore((s) => s.setPhase3);
  const phase4 = usePipelineStore((s) => s.phase4);
  const setPhase4 = usePipelineStore((s) => s.setPhase4);

  const [segments, setSegments] = useState([]);
  const [voices, setVoices] = useState([]);
  const [voicesError, setVoicesError] = useState('');
  const [voiceId, setVoiceId] = useState(phase4.selectedVoice || '');
  const [modelId, setModelId] = useState('eleven_v3');
  const [previewText, setPreviewText] = useState('이 영화의 마지막 장면을 본 관객 99%가 얼어붙었습니다.');
  const [previewSrc, setPreviewSrc] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [claudeReviewStatus, setClaudeReviewStatus] = useState('unknown');

  const updateTimerRef = useRef(null);
  const blobUrlRef = useRef('');

  useEffect(() => {
    if (claudeScript?.segments?.length) {
      const nextSegments = claudeScript.segments.map((s) => ({ ...s }));
      setSegments(nextSegments);
      setPhase4({ editedSegments: nextSegments });
      return;
    }

    if (phase4.editedSegments?.length) {
      setSegments(phase4.editedSegments.map((s) => ({ ...s })));
    }
  }, [claudeScript, phase4.editedSegments, setPhase4]);

  useEffect(() => {
    api
      .get('/claude/review')
      .then((res) => {
        const review = res.data?.review || null;
        setPhase3({
          claudeReview: review,
          claudeReviewPath: res.data?.savedPath || null
        });
        setClaudeReviewStatus(review?.status || 'unknown');
      })
      .catch((err) => {
        if (err.response?.status === 404) {
          setClaudeReviewStatus('not_found');
          setPhase3({
            claudeReview: null,
            claudeReviewPath: null
          });
          return;
        }
        setClaudeReviewStatus('error');
      });
  }, [setPhase3]);

  useEffect(() => {
    api
      .get('/elevenlabs/voices')
      .then((res) => {
        setVoices(res.data.voices || []);
        setVoicesError('');
      })
      .catch(() => {
        setVoices([]);
        setVoicesError('ElevenLabs 보이스 목록을 불러오지 못했습니다. API Key를 확인해주세요.');
      });
  }, []);

  useEffect(
    () => () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = '';
      }
    },
    []
  );

  const editableSegments = useMemo(
    () =>
      segments.map((s) => ({
        segment_id: s.segment_id,
        argument_part: s.argument_part,
        narration: s.narration || ''
      })),
    [segments]
  );

  const selectedVoice = useMemo(() => voices.find((v) => v.voice_id === voiceId), [voices, voiceId]);
  const canGenerateTts =
    phase3.claudeReview?.status === 'approved'
    && phase3.claudeReview?.checks?.ready_for_tts === true;

  const updatePreviewSrc = (nextSrc, isBlob = false) => {
    if (blobUrlRef.current && blobUrlRef.current !== nextSrc) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = '';
    }
    if (isBlob) {
      blobUrlRef.current = nextSrc;
    }
    setPreviewSrc(nextSrc);
  };

  const onChangeSegment = (segmentId, nextText) => {
    setSegments((prev) => {
      const nextSegments = prev.map((s) => (s.segment_id === segmentId ? { ...s, narration: nextText } : s));

      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }

      updateTimerRef.current = setTimeout(() => {
        setPhase4({ editedSegments: nextSegments });
      }, 300);

      return nextSegments;
    });
  };

  const onPreview = async () => {
    if (!voiceId) {
      setError('보이스를 먼저 선택해주세요.');
      return;
    }
    setError('');
    try {
      const res = await api.post('/elevenlabs/preview', { text: previewText, voiceId, modelId }, { responseType: 'blob' });
      const src = URL.createObjectURL(res.data);
      updatePreviewSrc(src, true);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const onPlayVoiceSample = () => {
    if (!selectedVoice?.preview_url) {
      setError('선택한 보이스의 기본 샘플 URL이 없습니다.');
      return;
    }
    setError('');
    updatePreviewSrc(selectedVoice.preview_url, false);
  };

  const onGenerate = async () => {
    if (!canGenerateTts) {
      setError('Claude 결과를 검증 승인한 뒤에만 TTS 생성을 진행할 수 있습니다.');
      return;
    }
    if (!voiceId) {
      setError('보이스를 먼저 선택해주세요.');
      return;
    }
    setStatus('generating');
    setError('');
    setPhase4({ failedSegments: [], ttsWarnings: [], ttsStatus: 'generating' });

    try {
      const payload = {
        voiceId,
        modelId,
        segments: segments.map((s) => ({ segment_id: s.segment_id, text: s.narration || '' }))
      };
      const res = await api.post('/elevenlabs/generate', payload);
      const nextStatus = res.data.status || 'success';
      setStatus(nextStatus);
      setPhase4({
        editedSegments: segments,
        selectedVoice: voiceId,
        ttsFiles: res.data.files || [],
        captionUnits: res.data.caption_units || [],
        segmentToCaptionMap: res.data.segment_to_caption_map || {},
        maxCaptionChars: res.data.max_caption_chars || 42,
        srtFile: res.data.srt_filename,
        batchId: res.data.batchId,
        ttsStatus: nextStatus,
        failedSegments: res.data.failed_segments || [],
        ttsWarnings: res.data.warnings || []
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setStatus('failed');
      setPhase4({ ttsStatus: 'failed' });
    }
  };

  const onLoadSavedClaudeJson = async () => {
    setError('');
    try {
      const res = await api.get('/claude/latest-script');
      const script = res.data?.script;
      if (!script?.segments?.length) {
        setError('저장된 Claude JSON에 segments가 없습니다.');
        return;
      }

      setPhase3({
        claudeScript: script,
        claudeScriptPath: res.data?.savedPath || null
      });

      const nextSegments = script.segments.map((s) => ({ ...s }));
      setSegments(nextSegments);
      setPhase4({ editedSegments: nextSegments });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  if (!claudeScript) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Phase 3 결과가 필요합니다.</p>
        <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onLoadSavedClaudeJson}>
          저장된 Claude JSON 불러오기
        </button>
        {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Phase 4: 자막 + TTS</h1>

      <SegmentEditor segments={editableSegments} onChangeSegment={onChangeSegment} />

      <div className="grid gap-3 md:grid-cols-2">
        <VoiceSelector voices={voices} value={voiceId} onChange={setVoiceId} />
        <select className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={modelId} onChange={(e) => setModelId(e.target.value)}>
          <option value="eleven_v3">eleven_v3</option>
          <option value="eleven_multilingual_v2">eleven_multilingual_v2</option>
        </select>
      </div>

      {voicesError ? <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{voicesError}</div> : null}

      <div>
        <button
          className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onPlayVoiceSample}
          disabled={!selectedVoice?.preview_url}
        >
          기본 샘플 듣기
        </button>
      </div>

      <textarea className="h-20 w-full rounded-md border border-slate-300 p-2 text-sm" value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
      <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onPreview}>
        미리듣기
      </button>
      <AudioPlayer src={previewSrc} />

      <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={onGenerate} disabled={!canGenerateTts}>
        전체 TTS 생성
      </button>
      {!canGenerateTts ? (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Claude 결과를 검증 승인해야 TTS 생성을 진행할 수 있습니다.
        </div>
      ) : null}
      <div className="rounded-md bg-slate-100 px-3 py-2 text-sm">Status: {status}</div>
      {phase4.captionUnits?.length > 0 ? (
        <div className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">문장 단위로 {phase4.captionUnits.length}개 TTS/자막이 생성됐습니다.</div>
      ) : null}
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        Policy: success / partial_success {'->'} Phase5 allowed, failed {'->'} Phase5 blocked
      </div>

      {phase4.ttsStatus === 'partial_success' ? (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">일부 세그먼트 TTS 실패. 실패 목록을 확인하고 필요하면 다시 생성하세요.</div>
      ) : null}

      {(phase4.ttsWarnings || []).length > 0 ? (
        <div className="rounded-md bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
          {(phase4.ttsWarnings || []).map((w, i) => (
            <div key={`${w.caption_id || w.segment_id || 'warn'}_${i}`}>
              [{w.caption_id || w.segment_id}] {w.message}
            </div>
          ))}
        </div>
      ) : null}

      {(phase4.failedSegments || []).length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="mb-2 font-semibold">Failed Segments</div>
          {(phase4.failedSegments || []).map((f) => (
            <div key={f.caption_id || f.segment_id} className="mb-1">
              {f.caption_id || f.segment_id} | reason: {f.reason} | attempts: {f.attempts} | {f.message}
            </div>
          ))}
        </div>
      ) : null}

      {(phase4.ttsFiles || []).length > 0 ? (
        <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
          {(phase4.ttsFiles || []).map((f) => (
            <div key={f.caption_id || f.segment_id} className="flex items-center justify-between">
              <span>
                {f.caption_id || f.segment_id}: {f.duration_sec}s
              </span>
              <a className="text-blue-600" href={`/api/elevenlabs/download/${f.filename}`} target="_blank" rel="noreferrer">
                다운로드
              </a>
            </div>
          ))}

          {phase4.captionUnits?.length > 0 ? (
            <details className="rounded-md border border-slate-200 bg-slate-50 p-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-700">caption unit 미리보기 ({phase4.captionUnits.length}개)</summary>
              <div className="mt-2 max-h-48 space-y-1 overflow-auto text-xs text-slate-700">
                {phase4.captionUnits.map((unit) => (
                  <div key={unit.caption_id}>
                    [{unit.caption_id}] {unit.text}
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          <div className="pt-2">
            <a className="text-green-700" href={`/api/elevenlabs/download-all?batchId=${phase4.batchId}`} target="_blank" rel="noreferrer">
              전체 TTS ZIP 다운로드
            </a>
          </div>
          <div className="pt-1">
            <a className="text-indigo-700" href={`/api/elevenlabs/download-srt?batchId=${phase4.batchId}`} target="_blank" rel="noreferrer">
              SRT 다운로드
            </a>
          </div>
          <button className="mt-2 rounded-md bg-green-600 px-4 py-2 text-sm text-white" onClick={() => navigate('/phase-5')}>
            Phase 5 CapCut 드래프트
          </button>
        </div>
      ) : null}

      {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
    </div>
  );
}
