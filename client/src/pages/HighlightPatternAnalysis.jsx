import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import JsonViewer from '../components/JsonViewer';

const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'analyzing']);

const STATUS_BADGE = {
  queued: 'border-white/15 bg-white/10 text-slate-200',
  downloading: 'border-sky-400/50 bg-sky-500/15 text-sky-100',
  analyzing: 'border-amber-400/50 bg-amber-500/15 text-amber-100',
  success: 'border-[#c8ff00]/60 bg-[#c8ff00]/15 text-[#dfff58]',
  failed: 'border-rose-400/60 bg-rose-500/15 text-rose-100',
  skipped: 'border-white/10 bg-white/5 text-slate-500'
};

const STATUS_LABEL = {
  queued: '대기중',
  downloading: '다운로드중',
  analyzing: '분석중',
  success: '완료',
  failed: '실패',
  skipped: '건너뜀(MID/PENDING)'
};

const LABEL_BADGE = {
  EXPLODED: 'border-[#c8ff00]/60 bg-[#c8ff00]/15 text-[#dfff58]',
  BURIED: 'border-rose-400/60 bg-rose-500/15 text-rose-100',
  MID: 'border-white/15 bg-white/10 text-slate-300',
  PENDING: 'border-amber-400/40 bg-amber-500/10 text-amber-200'
};

const LABEL_TEXT = {
  EXPLODED: 'EXPLODED',
  BURIED: 'BURIED',
  MID: 'MID',
  PENDING: 'PENDING(성숙 대기)'
};

function formatNumber(value) {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString();
}

function formatMultiple(value) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}x`;
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}s`;
}

function formatBool(value, labelTrue, labelFalse = '') {
  if (value === null || value === undefined) return labelFalse;
  return value ? labelTrue : labelFalse;
}

export default function HighlightPatternAnalysis() {
  const [urlsText, setUrlsText] = useState('');
  const [analysisMode, setAnalysisMode] = useState('training');
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const pollTimerRef = useRef(null);

  const [channelHandle, setChannelHandle] = useState('');
  const [channelMaxDuration, setChannelMaxDuration] = useState(10);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);

  const [slicerBusyId, setSlicerBusyId] = useState('');
  const [candidatesByVideoId, setCandidatesByVideoId] = useState({});

  async function fetchItems() {
    const res = await api.get('/highlight-patterns');
    setItems(res.data?.items || []);
    setSummary(res.data?.summary || []);
  }

  useEffect(() => {
    fetchItems().catch(() => {});
  }, []);

  useEffect(() => {
    const hasActive = items.some((item) => ACTIVE_STATUSES.has(item.pipeline_status));
    if (!hasActive) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return undefined;
    }

    if (!pollTimerRef.current) {
      pollTimerRef.current = setInterval(() => {
        fetchItems().catch(() => {});
      }, 3000);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [items]);

  async function handleSubmit() {
    if (!urlsText.trim()) return;
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post('/highlight-patterns', { urls: urlsText, analysisMode });
      const { created = [], skipped = [] } = res.data || {};
      if (created.length) {
        setItems((prev) => [...created, ...prev.filter((item) => !created.some((c) => c.id === item.id))]);
      }
      if (skipped.length) {
        setNotice(`${skipped.length}건은 건너뛰었습니다: ${skipped.map((s) => `${s.url} (${s.reason})`).join(', ')}`);
      }
      setUrlsText('');
    } catch (err) {
      setError(err?.response?.data?.message || err.message || '분석 요청에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleScanChannel() {
    if (!channelHandle.trim()) return;
    setScanning(true);
    setError('');
    setScanResult(null);
    try {
      const res = await api.post('/highlight-patterns/scan-channel', {
        handle: channelHandle.trim(),
        maxDurationSeconds: Number(channelMaxDuration) || 10
      });
      setScanResult(res.data);
      await fetchItems();
    } catch (err) {
      setError(err?.response?.data?.message || err.message || '채널 스캔에 실패했습니다.');
    } finally {
      setScanning(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/highlight-patterns/${id}`);
      setItems((prev) => prev.filter((item) => item.id !== id));
      if (expandedId === id) setExpandedId('');
    } catch (err) {
      setError(err?.response?.data?.message || err.message || '삭제에 실패했습니다.');
    }
  }

  async function handleExtractTimeline(id) {
    setSlicerBusyId(id);
    setError('');
    try {
      await api.post(`/highlight-patterns/${id}/extract-timeline`);
      await fetchItems();
    } catch (err) {
      setError(err?.response?.data?.message || err.message || '타임라인 추출에 실패했습니다.');
    } finally {
      setSlicerBusyId('');
    }
  }

  async function handleSliceCandidates(id) {
    setSlicerBusyId(id);
    setError('');
    try {
      const res = await api.post(`/highlight-patterns/${id}/slice-candidates`);
      setCandidatesByVideoId((prev) => ({ ...prev, [id]: res.data }));
    } catch (err) {
      setError(err?.response?.data?.message || err.message || '후보 추출에 실패했습니다.');
    } finally {
      setSlicerBusyId('');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black text-white">하이라이트 패턴 분석 (3초 루프)</h1>
        <p className="mt-1 text-sm text-slate-400">
          3초 루프 클립을 학습 데이터로 쌓아 (action_phase × loop_seam × moment_type) 조합별 성공률을 계산하고,
          10~20초 하이라이트에서 그 조합에 맞는 3초 후보 구간을 자동으로 뽑습니다.
        </p>
      </div>

      {summary.length ? (
        <div className="overflow-x-auto rounded-3xl border border-white/10 bg-black/40 p-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
            규정표 — action_phase × SSIM 사분위 × moment_type (표본 3건 이상)
          </div>
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 pr-3">action_phase</th>
                <th className="py-1 pr-3">SSIM 사분위</th>
                <th className="py-1 pr-3">moment_type</th>
                <th className="py-1 pr-3">표본</th>
                <th className="py-1 pr-3">평균 성공배수</th>
                <th className="py-1 pr-3">exploded_rate</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={`${row.action_phase}-${row.seam_bucket}-${row.moment_type}`} className="text-slate-200">
                  <td className="py-1 pr-3 font-bold text-[#c8ff00]">{row.action_phase}</td>
                  <td className="py-1 pr-3">{row.seam_bucket}</td>
                  <td className="py-1 pr-3">{row.moment_type}</td>
                  <td className="py-1 pr-3">{row.n}</td>
                  <td className="py-1 pr-3">{formatMultiple(row.avg_success_multiple)}</td>
                  <td className="py-1 pr-3">{Number.isFinite(row.exploded_rate) ? `${Math.round(row.exploded_rate * 100)}%` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-3xl border border-white/10 bg-black/40 p-4 text-xs text-slate-500">
          아직 표본이 부족합니다. EXPLODED/BURIED 학습 클립이 조합당 3건 이상 쌓이면 규정표가 나타납니다.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-3xl border border-white/10 bg-black/40 p-5">
          <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-400">
            URL 등록
          </label>
          <div className="mb-3 flex gap-2 text-xs">
            <button
              type="button"
              className={`rounded-xl px-3 py-1.5 font-bold ${analysisMode === 'training' ? 'bg-[#c8ff00] text-black' : 'border border-white/10 bg-white/5 text-slate-300'}`}
              onClick={() => setAnalysisMode('training')}
            >
              학습 클립 (3초)
            </button>
            <button
              type="button"
              className={`rounded-xl px-3 py-1.5 font-bold ${analysisMode === 'slice_source' ? 'bg-[#c8ff00] text-black' : 'border border-white/10 bg-white/5 text-slate-300'}`}
              onClick={() => setAnalysisMode('slice_source')}
            >
              슬라이스 대상 (10~20초)
            </button>
          </div>
          <textarea
            className="h-24 w-full rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#c8ff00]/60 focus:outline-none"
            placeholder={'https://youtube.com/shorts/aaa\nhttps://youtube.com/shorts/bbb'}
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className="rounded-2xl bg-[#c8ff00] px-4 py-2 text-sm font-bold text-black hover:brightness-95 disabled:opacity-50"
              disabled={submitting || !urlsText.trim()}
              onClick={handleSubmit}
            >
              {submitting ? '등록중...' : '분석 시작'}
            </button>
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-black/40 p-5">
          <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-400">
            벤치마크 채널 일괄 스캔 (EXPLODED/BURIED 자동 라벨링)
          </label>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#c8ff00]/60 focus:outline-none"
              placeholder="@channelhandle 또는 채널 URL"
              value={channelHandle}
              onChange={(e) => setChannelHandle(e.target.value)}
            />
            <input
              type="number"
              className="w-24 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-100 focus:border-[#c8ff00]/60 focus:outline-none"
              value={channelMaxDuration}
              onChange={(e) => setChannelMaxDuration(e.target.value)}
              title="최대 길이(초)"
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className="rounded-2xl bg-[#c8ff00] px-4 py-2 text-sm font-bold text-black hover:brightness-95 disabled:opacity-50"
              disabled={scanning || !channelHandle.trim()}
              onClick={handleScanChannel}
            >
              {scanning ? '스캔중...' : '채널 스캔'}
            </button>
            {scanResult ? (
              <span className="text-xs text-slate-300">
                EXPLODED {scanResult.counts?.EXPLODED ?? 0} · BURIED {scanResult.counts?.BURIED ?? 0} · MID {scanResult.counts?.MID ?? 0} · PENDING {scanResult.counts?.PENDING ?? 0}
                {' '}(MID/PENDING은 Gemini 분석 없이 건너뜀)
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="text-sm text-rose-300">{error}</div> : null}
      {notice ? <div className="text-sm text-amber-200">{notice}</div> : null}

      <div className="overflow-x-auto rounded-3xl border border-white/10 bg-black/40">
        <table className="w-full min-w-[1200px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">제목 / URL</th>
              <th className="px-4 py-3">채널</th>
              <th className="px-4 py-3">조회수 / 라벨</th>
              <th className="px-4 py-3">길이 / 모드</th>
              <th className="px-4 py-3">상태</th>
              <th className="px-4 py-3">action_phase</th>
              <th className="px-4 py-3">moment_type</th>
              <th className="px-4 py-3">loop_seam</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                  아직 등록된 분석이 없습니다.
                </td>
              </tr>
            ) : null}
            {items.map((item) => {
              const isExpanded = expandedId === item.id;
              const isSliceSource = item.analysis_mode === 'slice_source';
              const sliceState = candidatesByVideoId[item.id];
              return (
                <Fragment key={item.id}>
                  <tr
                    className="cursor-pointer border-b border-white/5 text-slate-200 hover:bg-white/5"
                    onClick={() => setExpandedId(isExpanded ? '' : item.id)}
                  >
                    <td className="max-w-[220px] px-4 py-3">
                      <div className="truncate font-semibold text-slate-100">{item.title || item.youtube_url}</div>
                      <a
                        href={item.youtube_url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-xs text-slate-500 hover:text-[#c8ff00]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.youtube_url}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[160px] truncate">{item.channel_title || '-'}</div>
                      <div className="text-xs text-slate-500">구독자 {formatNumber(item.channel_subscriber_count)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{formatNumber(item.views)} <span className="text-slate-500">({formatMultiple(item.success_multiple)})</span></div>
                      {item.label ? (
                        <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${LABEL_BADGE[item.label] || ''}`}>
                          {LABEL_TEXT[item.label] || item.label}
                        </span>
                      ) : null}
                      {item.is_dead ? <span className="ml-2 text-[10px] text-rose-300">시체영상</span> : null}
                    </td>
                    <td className="px-4 py-3">
                      {formatSeconds(item.duration_seconds)}
                      <div className="text-xs text-slate-500">{isSliceSource ? '슬라이스 대상' : '학습 클립'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-1 text-xs font-bold ${STATUS_BADGE[item.pipeline_status] || STATUS_BADGE.queued}`}>
                        {STATUS_LABEL[item.pipeline_status] || item.pipeline_status}
                      </span>
                      {item.pipeline_status === 'failed' && item.error_message ? (
                        <div className="mt-1 max-w-[220px] text-xs text-rose-300">{item.error_message}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">{item.action_phase || '-'}</td>
                    <td className="px-4 py-3">{item.moment_type || '-'}</td>
                    <td className="px-4 py-3">
                      <div>{item.loop_seam_derived || item.loop_seam || '-'}</div>
                      <div className="text-xs text-slate-500">
                        {Number.isFinite(item.loop_seam_similarity) ? `SSIM ${item.loop_seam_similarity}` : ''}
                        {item.action_is_repetitive !== null && item.action_is_repetitive !== undefined
                          ? ` · ${item.action_is_repetitive ? '반복동작' : '1회성'}`
                          : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="rounded-xl border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold text-slate-300 hover:border-rose-400/50 hover:text-rose-200"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(item.id);
                        }}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr className="border-b border-white/5 bg-white/[0.02]">
                      <td colSpan={9} className="px-4 py-4">
                        {isSliceSource ? (
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:border-[#c8ff00]/40 hover:text-[#c8ff00] disabled:opacity-50"
                                disabled={slicerBusyId === item.id || item.pipeline_status !== 'success'}
                                onClick={() => handleExtractTimeline(item.id)}
                              >
                                {slicerBusyId === item.id ? '처리중...' : '타임라인 추출'}
                              </button>
                              <button
                                type="button"
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:border-[#c8ff00]/40 hover:text-[#c8ff00] disabled:opacity-50"
                                disabled={slicerBusyId === item.id || !item.segments?.length}
                                onClick={() => handleSliceCandidates(item.id)}
                              >
                                3초 후보 추출
                              </button>
                            </div>
                            {item.segments?.length ? (
                              <div>
                                <div className="mb-1 text-xs font-bold uppercase text-slate-500">타임라인 이벤트</div>
                                <ul className="space-y-1 text-sm text-slate-300">
                                  {item.segments.map((segment) => (
                                    <li key={segment.id} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                                      <span className="font-bold text-[#c8ff00]">{segment.event_type}</span>
                                      <span className="ml-2 text-xs text-slate-500">{formatSeconds(segment.start_time)}</span>
                                      <div className="text-xs text-slate-400">{segment.description}</div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500">아직 타임라인을 추출하지 않았습니다.</div>
                            )}
                            {sliceState?.message ? (
                              <div className="text-xs text-amber-200">{sliceState.message}</div>
                            ) : null}
                            {sliceState?.candidates?.length ? (
                              <div>
                                <div className="mb-1 text-xs font-bold uppercase text-slate-500">3초 후보 구간</div>
                                <ul className="space-y-1 text-sm text-slate-300">
                                  {sliceState.candidates.map((candidate, idx) => (
                                    <li key={idx} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                                      <span className="font-bold text-[#c8ff00]">
                                        {formatSeconds(candidate.start_sec)} - {formatSeconds(candidate.end_sec)}
                                      </span>
                                      <span className="ml-2 text-xs text-slate-500">
                                        {candidate.pattern.action_phase} / {candidate.pattern.seam_bucket} / {candidate.pattern.moment_type}
                                      </span>
                                      <div className="text-xs text-slate-400">
                                        예상 exploded_rate {Number.isFinite(candidate.predicted_exploded_rate) ? `${Math.round(candidate.predicted_exploded_rate * 100)}%` : '-'}
                                        {' · '}
                                        심 유사도 {Number.isFinite(candidate.seam_similarity) ? candidate.seam_similarity : '-'}
                                        {' · '}
                                        표본 {candidate.sample_size}건
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        ) : item.analysis_id ? (
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 gap-3 text-sm text-slate-300 md:grid-cols-2">
                              <div>
                                <div className="text-xs font-bold uppercase text-slate-500">동작</div>
                                <div>{item.action_described}</div>
                              </div>
                              <div>
                                <div className="text-xs font-bold uppercase text-slate-500">재질 / 도구</div>
                                <div>{item.material} / {item.tool_or_machine}</div>
                              </div>
                              <div>
                                <div className="text-xs font-bold uppercase text-slate-500">첫 프레임</div>
                                <div>{item.first_frame_description}</div>
                              </div>
                              <div>
                                <div className="text-xs font-bold uppercase text-slate-500">마지막 프레임</div>
                                <div>{item.last_frame_description}</div>
                              </div>
                              <div>
                                <div className="text-xs font-bold uppercase text-slate-500">0.5초 내 판독 가능</div>
                                <div>{formatBool(item.readable_in_half_second, '가능', '불가능')}</div>
                              </div>
                              <div>
                                <div className="text-xs font-bold uppercase text-slate-500">카메라 / 스케일 / 방향 / 속도</div>
                                <div>{item.camera} / {item.subject_scale} / {item.motion_direction} / {item.speed_appearance}</div>
                              </div>
                            </div>
                            <div className="rounded-2xl bg-white p-3">
                              <JsonViewer title="원본 분석 JSON" data={item.raw_json} />
                            </div>
                          </div>
                        ) : (
                          <div className="text-sm text-slate-500">아직 분석 결과가 없습니다.</div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
