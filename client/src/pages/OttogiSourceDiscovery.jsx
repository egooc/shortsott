import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePipelineStore } from '../store/pipelineStore';
import { compactNumber, prettyDate, safeNum, safeText } from '../services/virloDataService';

const PERIODS = [
  { value: 'older_6m', label: '6개월 이상' },
  { value: 'older_1y', label: '1년 이상' },
  { value: 'older_2y', label: '2년 이상' },
  { value: 'older_3m', label: '3개월 이상' },
  { value: 'all', label: '전체 기간' },
  { value: '30d', label: '최근 30일' },
  { value: '7d', label: '최근 7일' }
];

const SORTS = [
  { value: 'views', label: '조회수순' },
  { value: 'views_per_hour', label: '시간당 조회수순' },
  { value: 'date', label: '최신순' }
];

const SOURCE_MODES = [
  {
    value: 'shortform',
    label: '숏폼 소스',
    hint: '1분 미만 Shorts 후보를 바로 배치로 보냅니다.'
  },
  {
    value: 'longform',
    label: '롱폼 소스',
    hint: '90초 이상 영상을 찾아 Phase2에서 숏폼화 구간을 뽑습니다.'
  },
  {
    value: 'auto',
    label: '자동 분류',
    hint: '검색 결과를 가져온 뒤 길이 기준으로 자동 분류합니다.'
  }
];

const FAVORITES_KEY = 'ottogi.youtubeScoutFavorites.v1';
const SCOUT_SESSION_KEY = 'ottogi.youtubeScoutSession.v1';

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage can fail in private mode. The page can still work.
  }
}

function buildTabTitle(params) {
  const mode = SOURCE_MODES.find((item) => item.value === params.sourceMode)?.label || '소스';
  const period = PERIODS.find((item) => item.value === params.period)?.label || params.period;
  return `${mode} · ${params.hashtag || '#shorts'} · ${period}`;
}

function getAgeMonths(publishedAt) {
  const ms = new Date(publishedAt || 0).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24 * 30)));
}

function getVideoUrl(video) {
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
    const url = safeText(value);
    if (/^https?:\/\//i.test(url)) return url;
  }

  const rawId = raw.id && typeof raw.id === 'object' ? raw.id.videoId : raw.id;
  const id = safeText(video?.id || video?.video_id || video?.videoId || rawId || raw.video_id || raw.videoId);
  if (id && /^[a-zA-Z0-9_-]{8,}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return '';
}

function viewLevel(views) {
  const n = safeNum(views);
  if (n >= 100000000) return { label: '1억+', className: 'border-rose-400/70 bg-rose-500/15 text-rose-100' };
  if (n >= 10000000) return { label: '1000만+', className: 'border-amber-400/70 bg-amber-500/15 text-amber-100' };
  if (n >= 1000000) return { label: '100만+', className: 'border-[#c8ff00]/70 bg-[#c8ff00]/15 text-[#dfff58]' };
  return { label: compactNumber(n), className: 'border-white/15 bg-white/10 text-slate-200' };
}

function sourceBadge(video) {
  const type = video.sourceTypeGuess || video.source_type || video.sourceClassification?.source_type || 'unknown';
  if (type === 'longform') return { label: '롱폼', className: 'bg-sky-400/15 text-sky-100 border-sky-300/30' };
  if (type === 'shortform') return { label: '숏폼', className: 'bg-[#c8ff00]/15 text-[#dfff58] border-[#c8ff00]/30' };
  return { label: '자동', className: 'bg-white/10 text-slate-200 border-white/15' };
}

export default function OttogiSourceDiscovery() {
  const navigate = useNavigate();
  const phase5 = usePipelineStore((s) => s.phase5);
  const setPhase1 = usePipelineStore((s) => s.setPhase1);
  const setPhase5 = usePipelineStore((s) => s.setPhase5);
  const setCurrentPhase = usePipelineStore((s) => s.setCurrentPhase);
  const initialSession = useMemo(() => readJsonStorage(SCOUT_SESSION_KEY, {}), []);

  const [sourceMode, setSourceMode] = useState(initialSession.form?.sourceMode || 'shortform');
  const [hashtag, setHashtag] = useState(initialSession.form?.hashtag || '#shorts');
  const [period, setPeriod] = useState(initialSession.form?.period || 'older_6m');
  const [sort, setSort] = useState(initialSession.form?.sort || 'views');
  const [minViews, setMinViews] = useState(Number(initialSession.form?.minViews || 1000000));
  const [limit, setLimit] = useState(Number(initialSession.form?.limit || 25));
  const [showExcluded, setShowExcluded] = useState(Boolean(initialSession.form?.showExcluded));
  const [videos, setVideos] = useState(Array.isArray(initialSession.videos) ? initialSession.videos : []);
  const [tabs, setTabs] = useState(Array.isArray(initialSession.tabs) ? initialSession.tabs : []);
  const [activeTabId, setActiveTabId] = useState(initialSession.activeTabId || '');
  const [rawResponse, setRawResponse] = useState(initialSession.rawResponse || null);
  const [sourceLibrarySummary, setSourceLibrarySummary] = useState(initialSession.sourceLibrary || null);
  const [hiddenExcludedCount, setHiddenExcludedCount] = useState(Number(initialSession.hiddenExcludedCount || 0));
  const [favorites, setFavorites] = useState(() => readJsonStorage(FAVORITES_KEY, []));
  const [detailVideo, setDetailVideo] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sendingToBatch, setSendingToBatch] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const pendingSourceVideos = Array.isArray(phase5.pendingSourceVideos) ? phase5.pendingSourceVideos : [];
  const activeTab = useMemo(() => tabs.find((item) => item.id === activeTabId) || null, [tabs, activeTabId]);
  const visibleVideos = activeTab?.videos || videos;
  const sortedVideos = useMemo(() => [...visibleVideos].sort((a, b) => safeNum(b.views) - safeNum(a.views)), [visibleVideos]);

  const summary = useMemo(() => {
    const totalViews = visibleVideos.reduce((sum, item) => sum + safeNum(item.views), 0);
    return {
      total: visibleVideos.length,
      totalViews,
      millionPlus: visibleVideos.filter((item) => safeNum(item.views) >= 1000000).length,
      longform: visibleVideos.filter((item) => item.sourceTypeGuess === 'longform').length,
      shortform: visibleVideos.filter((item) => item.sourceTypeGuess === 'shortform').length
    };
  }, [visibleVideos]);

  useEffect(() => {
    writeJsonStorage(SCOUT_SESSION_KEY, {
      form: { sourceMode, hashtag, period, sort, minViews: Number(minViews || 0), limit: Number(limit || 25), showExcluded },
      videos,
      tabs: tabs.slice(0, 12),
      activeTabId,
      rawResponse,
      hiddenExcludedCount,
      sourceLibrary: sourceLibrarySummary,
      savedAt: new Date().toISOString()
    });
  }, [activeTabId, hashtag, hiddenExcludedCount, limit, minViews, period, rawResponse, showExcluded, sort, sourceLibrarySummary, sourceMode, tabs, videos]);

  async function runScout(overrides = {}) {
    const params = {
      sourceMode: overrides.sourceMode || sourceMode,
      hashtag: overrides.hashtag || hashtag,
      period: overrides.period || period,
      sort: overrides.sort || sort,
      minViews: Number(overrides.minViews ?? minViews ?? 1000000),
      limit: Number(overrides.limit ?? limit ?? 25),
      includeExcluded: Boolean(overrides.showExcluded ?? showExcluded)
    };

    setSourceMode(params.sourceMode);
    setHashtag(params.hashtag);
    setPeriod(params.period);
    setSort(params.sort);
    setMinViews(params.minViews);
    setLimit(params.limit);
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const res = await api.get('/youtube/scout', { params });
      const rows = Array.isArray(res.data?.videos) ? res.data.videos : [];
      const nextTab = {
        id: `tab_${Date.now()}`,
        title: buildTabTitle(params),
        params,
        videos: rows,
        createdAt: new Date().toISOString()
      };
      setVideos(rows);
      setRawResponse(res.data);
      setHiddenExcludedCount(Number(res.data?.hiddenExcludedCount || 0));
      setSourceLibrarySummary(res.data?.sourceLibrary || null);
      setTabs((prev) => [nextTab, ...prev].slice(0, 12));
      setActiveTabId(nextTab.id);
      setNotice(`${rows.length}개 후보를 불러왔습니다.`);
      setSearchOpen(false);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'YouTube 검색에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  function saveFavorite() {
    const params = { sourceMode, hashtag, period, sort, minViews: Number(minViews || 0), limit: Number(limit || 25) };
    const item = {
      id: `${sourceMode}_${safeText(hashtag)}_${period}_${sort}_${params.minViews}`,
      title: buildTabTitle(params),
      params,
      savedAt: new Date().toISOString()
    };
    setFavorites((prev) => {
      const next = [item, ...prev.filter((fav) => fav.id !== item.id)].slice(0, 20);
      writeJsonStorage(FAVORITES_KEY, next);
      return next;
    });
    setNotice('검색 조건을 저장했습니다.');
  }

  function removeFavorite(id) {
    setFavorites((prev) => {
      const next = prev.filter((item) => item.id !== id);
      writeJsonStorage(FAVORITES_KEY, next);
      return next;
    });
  }

  function isVideoQueued(video) {
    const url = getVideoUrl(video);
    return Boolean(url && pendingSourceVideos.some((item) => safeText(item.url) === url));
  }

  function buildPendingSourceVideo(video) {
    const url = getVideoUrl(video);
    return {
      id: safeText(video.id || video.videoId || video.video_id || url),
      url,
      title: safeText(video.title || video.description || 'YouTube source'),
      description: safeText(video.description || ''),
      thumbnail: safeText(video.thumbnail || ''),
      creator: safeText(video.creator || video.channelTitle || ''),
      handle: safeText(video.handle || ''),
      platform: 'youtube',
      views: safeNum(video.views || video.viewCount),
      publishedAt: safeText(video.publishedAt || video.published_at || ''),
      hashtags: Array.isArray(video.hashtags) ? video.hashtags : [],
      durationSec: safeNum(video.durationSec || video.duration_sec),
      sourceMode: video.sourceMode || video.source_mode || sourceMode,
      sourceTypeGuess: video.sourceTypeGuess || video.source_type || 'unknown',
      sourceWorkflowMode: video.sourceWorkflowMode || video.source_workflow_mode || 'unknown',
      sourceClassification: video.sourceClassification || video.source_classification || null,
      addedAt: video.addedAt || video.added_at || new Date().toISOString()
    };
  }

  useEffect(() => {
    let cancelled = false;
    async function loadSourceBasket() {
      try {
        const res = await api.get('/youtube/source-basket');
        if (cancelled) return;
        const basketVideos = Array.isArray(res.data?.videos) ? res.data.videos : [];
        if (!basketVideos.length) return;
        const merged = [
          ...basketVideos.map(buildPendingSourceVideo),
          ...pendingSourceVideos
        ].filter((item) => item.url);
        const unique = [];
        const seen = new Set();
        merged.forEach((item) => {
          if (seen.has(item.url)) return;
          seen.add(item.url);
          unique.push(item);
        });
        setPhase5({ pendingSourceVideos: unique.slice(0, 100) });
      } catch {
        // The Phase1 page still works without the local extension basket API.
      }
    }
    loadSourceBasket();
    return () => {
      cancelled = true;
    };
  }, []);

  async function excludeVideo(video) {
    const url = getVideoUrl(video);
    if (!url) {
      setError('URL이 없는 소재는 제외할 수 없습니다.');
      return;
    }
    try {
      await api.post('/youtube/source-library/exclude', {
        url,
        video,
        reason: 'manual_exclude'
      });
      const removeUrl = (item) => getVideoUrl(item) !== url;
      if (!showExcluded) {
        setVideos((prev) => prev.filter(removeUrl));
        setTabs((prev) => prev.map((tab) => ({
          ...tab,
          videos: Array.isArray(tab.videos) ? tab.videos.filter(removeUrl) : []
        })));
      }
      if (detailVideo && getVideoUrl(detailVideo) === url) setDetailVideo(null);
      setHiddenExcludedCount((prev) => prev + 1);
      setSourceLibrarySummary((prev) => ({
        ...(prev || {}),
        excludedCount: Number(prev?.excludedCount || 0) + 1
      }));
      setNotice('해당 소재를 제외했습니다.');
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || err.message || '소재 제외에 실패했습니다.');
    }
  }

  async function addUrlToBatch(video) {
    const url = getVideoUrl(video);
    if (!url) {
      setError('담을 수 있는 URL이 없습니다.');
      return;
    }

    const pendingVideo = buildPendingSourceVideo(video);

    const alreadyQueued = pendingSourceVideos.some((item) => safeText(item.url) === url);
    try {
      await api.post('/youtube/source-basket', { video: pendingVideo });
    } catch {
      // Keep the browser basket usable even if the extension/server basket write fails.
    }
    setPhase1({ selectedVideo: video });
    setPhase5({
      pendingSourceVideos: [
        pendingVideo,
        ...pendingSourceVideos.filter((item) => safeText(item.url) !== url)
      ].slice(0, 100)
    });
    setNotice(alreadyQueued ? '이미 담긴 URL을 목록 맨 앞으로 옮겼습니다.' : 'URL을 배치 바구니에 담았습니다.');
    setError('');
  }

  async function removeQueuedUrl(url) {
    setPhase5({ pendingSourceVideos: pendingSourceVideos.filter((item) => safeText(item.url) !== safeText(url)) });
    try {
      await api.post('/youtube/source-basket/remove', { url });
    } catch {
      // Local UI removal already succeeded.
    }
  }

  async function clearQueuedUrls() {
    setPhase5({ pendingSourceVideos: [] });
    try {
      await api.post('/youtube/source-basket/clear');
    } catch {
      // Local UI clearing already succeeded.
    }
    setNotice('URL 바구니를 비웠습니다.');
  }

  async function goToBatchDraft() {
    if (pendingSourceVideos.length === 0) {
      setError('먼저 소재 URL을 담아주세요.');
      return;
    }
    setSendingToBatch(true);
    setError('');
    setNotice('');
    try {
      const videos = pendingSourceVideos.map((video) => ({
        ...video,
        url: getVideoUrl(video)
      }));
      const res = await api.post('/process-queue/import-source-urls', { videos });
      const importedCount = Number(res.data?.importedCount || 0);
      const skippedCount = Number(res.data?.skippedCount || 0);
      const failedCount = Number(res.data?.failedCount || 0);

      if (failedCount > 0 && importedCount + skippedCount === 0) {
        setError(res.data?.failed?.[0]?.message || '선택한 URL을 배치 큐에 추가하지 못했습니다.');
        return;
      }

      setPhase5({ pendingSourceVideos: [] });
      try {
        await api.post('/youtube/source-basket/clear');
      } catch {
        // Phase2 import already succeeded, so do not block navigation.
      }
      setNotice(`Phase2 배치 큐에 ${importedCount}개를 추가했습니다.${skippedCount ? ` 이미 있던 ${skippedCount}개는 건너뛰었습니다.` : ''}`);
      setCurrentPhase(2);
      navigate('/phase-5');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Phase2 배치 큐로 보내지 못했습니다.');
    } finally {
      setSendingToBatch(false);
    }
  }

  function renderVideoCard(video, index) {
    const level = viewLevel(video.views);
    const badge = sourceBadge(video);
    const ageMonths = getAgeMonths(video.publishedAt);
    const queued = isVideoQueued(video);
    const url = getVideoUrl(video);
    const title = video.title || video.description || '제목 없음';
    const produced = Boolean(video.sourceStatus?.produced);
    const excluded = Boolean(video.sourceStatus?.excluded);

    return (
      <article
        key={`${video.id || index}-${url}`}
        className={`group overflow-hidden rounded-[28px] border bg-white/[0.045] shadow-2xl shadow-black/20 ring-1 ${level.className}`}
      >
        <button type="button" onClick={() => setDetailVideo(video)} className="block w-full text-left">
          <div className="relative aspect-[9/16] overflow-hidden bg-slate-900">
            {video.thumbnail ? (
              <img src={video.thumbnail} alt={title} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
            ) : (
              <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 text-xs text-slate-500">썸네일 없음</div>
            )}
            <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-black backdrop-blur ${badge.className}`}>{badge.label}</span>
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-black backdrop-blur ${level.className}`}>{level.label}</span>
            </div>
            <div className="absolute left-3 top-11 flex flex-col gap-1">
              {produced ? <span className="rounded-full bg-emerald-400 px-2.5 py-1 text-[10px] font-black text-black shadow-lg">제작 완료</span> : null}
              {excluded ? <span className="rounded-full bg-rose-500 px-2.5 py-1 text-[10px] font-black text-white shadow-lg">제외됨</span> : null}
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/72 to-transparent p-3">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {ageMonths ? <span className="rounded-full bg-white/15 px-2 py-1 text-[10px] font-bold text-white">{ageMonths}개월 전</span> : null}
                <span className="rounded-full bg-[#c8ff00]/18 px-2 py-1 text-[10px] font-bold text-[#dfff58]">조회 {compactNumber(video.views)}</span>
                <span className="rounded-full bg-white/15 px-2 py-1 text-[10px] font-bold text-white">{Math.round(video.durationSec || 0)}초</span>
              </div>
              <p className="line-clamp-2 text-sm font-black leading-tight text-white">{title}</p>
            </div>
          </div>
        </button>
        <div className="space-y-3 p-4">
          <div>
            <p className="truncate text-sm font-bold text-slate-100">{video.creator || video.handle || 'Unknown Creator'}</p>
            <p className="text-xs text-slate-400">{prettyDate(video.publishedAt)} · {video.sourceWorkflowMode || '분류 대기'}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-[11px] text-slate-300">
            <div className="rounded-2xl bg-white/[0.055] px-2 py-2"><b className="block text-white">{compactNumber(video.views)}</b>views</div>
            <div className="rounded-2xl bg-white/[0.055] px-2 py-2"><b className="block text-white">{compactNumber(video.likes)}</b>likes</div>
            <div className="rounded-2xl bg-white/[0.055] px-2 py-2"><b className="block text-white">{compactNumber(video.comments)}</b>comments</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!url}
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
              className="rounded-2xl border border-white/12 bg-white/[0.06] px-3 py-2 text-xs font-bold text-slate-100 disabled:opacity-35"
            >
              원본 열기
            </button>
            <button
              type="button"
              onClick={() => addUrlToBatch(video)}
              className={`rounded-2xl px-3 py-2 text-xs font-black ${queued ? 'bg-emerald-500 text-black' : 'ottogi-primary'}`}
            >
              {queued ? '담김' : 'URL 담기'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => excludeVideo(video)}
            className="w-full rounded-2xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-100 hover:bg-rose-500/18"
          >
            이 소재 제외
          </button>
        </div>
      </article>
    );
  }

  return (
    <div className="ottogi-studio space-y-6">
      <section className="relative overflow-hidden rounded-[32px] border border-white/10 bg-[#0b0f14] p-6 shadow-2xl shadow-black/30 md:p-8">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#c8ff00]/12 blur-3xl" />
        <div className="absolute -bottom-24 left-20 h-60 w-60 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.28em] text-[#c8ff00]">3분 오뚝이영상 · Phase 1</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight text-white md:text-5xl">소재 발굴 스튜디오</h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300 md:text-base">
              YouTube API로 숏폼과 롱폼 후보를 찾고, 마음에 드는 URL을 여러 개 담아 Phase2 배치 드래프트 생성으로 보냅니다.
            </p>
          </div>
          <div className="rounded-full border border-[#c8ff00]/25 bg-[#c8ff00]/12 px-4 py-2 text-xs font-black text-[#c8ff00]">
            기본 모드: {SOURCE_MODES.find((item) => item.value === sourceMode)?.label}
          </div>
        </div>
        <div className="relative mt-7 grid gap-3 md:grid-cols-5">
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <div className="text-xs font-bold text-slate-400">검색 모드</div>
            <div className="mt-2 text-lg font-black text-white">{SOURCE_MODES.find((item) => item.value === sourceMode)?.label}</div>
            <div className="mt-1 text-xs text-slate-400">{hashtag || '#shorts'}</div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <div className="text-xs font-bold text-slate-400">검색 결과</div>
            <div className="mt-2 text-lg font-black text-white">{summary.total}개</div>
            <div className="mt-1 text-xs text-slate-400">총 조회 {compactNumber(summary.totalViews)}</div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <div className="text-xs font-bold text-slate-400">숏폼 / 롱폼</div>
            <div className="mt-2 text-lg font-black text-white">{summary.shortform} / {summary.longform}</div>
            <div className="mt-1 text-xs text-slate-400">Phase2에서 최종 판정</div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
            <div className="text-xs font-bold text-slate-400">100만+</div>
            <div className="mt-2 text-lg font-black text-white">{summary.millionPlus}개</div>
            <div className="mt-1 text-xs text-slate-400">{PERIODS.find((item) => item.value === period)?.label}</div>
          </div>
          <div className="rounded-3xl border border-[#c8ff00]/20 bg-[#c8ff00]/10 p-4">
            <div className="text-xs font-bold text-[#dfff58]">URL 바구니</div>
            <div className="mt-2 text-lg font-black text-white">{pendingSourceVideos.length}개</div>
            <button type="button" onClick={goToBatchDraft} disabled={!pendingSourceVideos.length || sendingToBatch} className="mt-3 rounded-2xl bg-[#c8ff00] px-3 py-2 text-xs font-black text-black disabled:opacity-35">
              {sendingToBatch ? '보내는 중...' : 'Phase2로 이동'}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-white/10 bg-white/[0.035] p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black text-white">검색 조건</h2>
            <p className="text-sm text-slate-400">롱폼 모드는 90초 이상 후보를 찾고, Phase2에서 숏폼화 구간과 하이라이트 구간을 자동 추출합니다.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSearchOpen((value) => !value)} className="ottogi-secondary rounded-2xl border px-4 py-3 text-sm font-bold">
              {searchOpen ? '검색 조건 닫기' : '검색 조건 열기'}
            </button>
            <button type="button" onClick={clearQueuedUrls} disabled={!pendingSourceVideos.length} className="rounded-2xl border border-white/12 bg-white/[0.06] px-4 py-3 text-sm font-bold text-slate-100 disabled:opacity-35">
              바구니 비우기
            </button>
            <button type="button" onClick={goToBatchDraft} disabled={!pendingSourceVideos.length || sendingToBatch} className="ottogi-primary rounded-2xl px-5 py-3 text-sm font-black disabled:opacity-35">
              {sendingToBatch ? 'Phase2로 보내는 중...' : 'Phase2로 보내기'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {SOURCE_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => setSourceMode(mode.value)}
              className={`rounded-3xl border p-4 text-left transition ${sourceMode === mode.value ? 'border-[#c8ff00]/70 bg-[#c8ff00]/15' : 'border-white/10 bg-white/[0.04] hover:border-white/25'}`}
            >
              <div className="text-base font-black text-white">{mode.label}</div>
              <div className="mt-1 text-xs leading-5 text-slate-400">{mode.hint}</div>
            </button>
          ))}
        </div>

        {pendingSourceVideos.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {pendingSourceVideos.slice(0, 20).map((item) => (
              <span key={item.url} className="inline-flex max-w-full items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] text-xs text-slate-100">
                <span className="max-w-[260px] truncate px-3 py-2">{item.title || item.url}</span>
                <button type="button" onClick={() => removeQueuedUrl(item.url)} className="border-l border-white/10 px-2 py-2 text-slate-400 hover:text-white">×</button>
              </span>
            ))}
            {pendingSourceVideos.length > 20 ? <span className="rounded-full bg-[#c8ff00]/15 px-3 py-2 text-xs font-bold text-[#dfff58]">+{pendingSourceVideos.length - 20}</span> : null}
          </div>
        ) : null}
      </section>

      {searchOpen ? (
        <section className="rounded-[28px] border border-[#c8ff00]/20 bg-[#c8ff00]/[0.055] p-4 md:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-white">검색 입력</h2>
              <p className="text-sm text-slate-400">6개월 이상, 100만 조회수 이상을 기본값으로 둡니다. 필요하면 해시태그별로 즐겨찾기에 저장하세요.</p>
            </div>
            <button type="button" onClick={saveFavorite} className="ottogi-secondary rounded-2xl border px-4 py-3 text-sm font-bold">조건 저장</button>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_1fr_0.8fr_0.7fr_auto]">
            <label className="text-sm font-bold text-slate-200">
              해시태그 / 키워드
              <input className="mt-1 w-full rounded-2xl border px-4 py-3" value={hashtag} onChange={(e) => setHashtag(e.target.value)} placeholder="#shorts" />
            </label>
            <label className="text-sm font-bold text-slate-200">
              업로드 기간
              <select className="mt-1 w-full rounded-2xl border px-4 py-3" value={period} onChange={(e) => setPeriod(e.target.value)}>
                {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold text-slate-200">
              정렬
              <select className="mt-1 w-full rounded-2xl border px-4 py-3" value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold text-slate-200">
              최소 조회수
              <input className="mt-1 w-full rounded-2xl border px-4 py-3" type="number" value={minViews} onChange={(e) => setMinViews(e.target.value)} />
            </label>
            <label className="text-sm font-bold text-slate-200">
              개수
              <input className="mt-1 w-full rounded-2xl border px-4 py-3" type="number" min="1" max="50" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={() => runScout()} disabled={loading} className="ottogi-primary h-[50px] rounded-2xl px-5 text-sm font-black disabled:opacity-50">
                {loading ? '검색 중...' : '검색 실행'}
              </button>
            </div>
          </div>

          <label className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm font-bold text-slate-100">
            <input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} />
            제외한 소재도 표시
          </label>

          <div className="mt-4 flex flex-wrap gap-2">
            {favorites.length === 0 ? (
              <span className="text-xs text-slate-500">저장된 검색 조건이 없습니다.</span>
            ) : favorites.map((item) => (
              <span key={item.id} className="inline-flex overflow-hidden rounded-full border border-white/10 bg-white/[0.06] text-xs">
                <button type="button" onClick={() => runScout(item.params)} className="px-3 py-2 text-slate-100">{item.title}</button>
                <button type="button" onClick={() => removeFavorite(item.id)} className="border-l border-white/10 px-2 py-2 text-slate-400">×</button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {(hiddenExcludedCount || sourceLibrarySummary?.producedCount || sourceLibrarySummary?.excludedCount) ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-300">
          <span className="font-bold text-[#dfff58]">소재 기록</span>
          <span className="ml-3">제작 완료 {sourceLibrarySummary?.producedCount || 0}개</span>
          <span className="ml-3">제외 {sourceLibrarySummary?.excludedCount || 0}개</span>
          {hiddenExcludedCount ? <span className="ml-3 text-rose-200">이번 검색에서 {hiddenExcludedCount}개 숨김</span> : null}
        </div>
      ) : null}

      {error ? <div className="rounded-2xl border border-rose-400/30 bg-rose-500/12 px-4 py-3 text-sm font-bold text-rose-100">{error}</div> : null}
      {notice ? <div className="rounded-2xl border border-[#c8ff00]/25 bg-[#c8ff00]/10 px-4 py-3 text-sm font-bold text-[#dfff58]">{notice}</div> : null}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <div className="rounded-[28px] border border-white/10 bg-white/[0.035] p-4 md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.22em] text-[#c8ff00]">Most Viral</p>
                <h2 className="mt-1 text-2xl font-black text-white">영상 후보 카드</h2>
                <p className="mt-1 text-sm text-slate-400">카드에서 영상 길이와 소스 타입을 확인하고 여러 개를 골라 담으세요.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTabId(tab.id)}
                    className={`rounded-full border px-3 py-2 text-xs font-bold ${activeTabId === tab.id ? 'border-[#c8ff00]/70 bg-[#c8ff00] text-black' : 'border-white/12 bg-white/[0.055] text-slate-300'}`}
                  >
                    {tab.title} · {tab.videos.length}
                  </button>
                ))}
              </div>
            </div>

            {sortedVideos.length === 0 ? (
              <div className="mt-5 rounded-3xl border border-dashed border-white/12 bg-white/[0.03] p-8 text-sm text-slate-400">
                <p className="font-bold text-slate-200">표시할 영상 후보가 없습니다.</p>
                <p className="mt-2">검색 조건을 열고 숏폼 또는 롱폼 모드로 후보를 불러오세요.</p>
              </div>
            ) : (
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {sortedVideos.map((video, index) => renderVideoCard(video, index))}
              </div>
            )}
          </div>

          {rawResponse ? (
            <details className="rounded-[28px] border border-white/10 bg-white/[0.035] p-4 md:p-5">
              <summary className="cursor-pointer text-sm font-black text-slate-200">Raw Response 보기</summary>
              <pre className="mt-4 max-h-[360px] overflow-auto rounded-2xl bg-black/55 p-4 text-xs text-slate-200">{JSON.stringify(rawResponse, null, 2)}</pre>
            </details>
          ) : null}
        </div>

        <aside className="sticky top-5 h-fit rounded-[28px] border border-white/10 bg-white/[0.045] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-[#c8ff00]">Detail</p>
              <h3 className="mt-1 text-xl font-black text-white">영상 상세</h3>
            </div>
            {detailVideo ? (
              <button type="button" onClick={() => setDetailVideo(null)} className="rounded-full border border-white/12 px-3 py-1 text-xs text-slate-300">닫기</button>
            ) : null}
          </div>

          {detailVideo ? (
            <div className="mt-4 space-y-4">
              <div className="aspect-[9/16] overflow-hidden rounded-3xl bg-slate-900">
                {detailVideo.thumbnail ? (
                  <img src={detailVideo.thumbnail} alt={detailVideo.title || 'video'} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-500">썸네일 없음</div>
                )}
              </div>
              <div>
                <p className="text-lg font-black leading-snug text-white">{detailVideo.title || detailVideo.description || '제목 없음'}</p>
                <p className="mt-2 text-sm text-slate-400">{detailVideo.creator || detailVideo.handle || '-'} · {prettyDate(detailVideo.publishedAt)}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-2xl bg-white/[0.06] p-3"><b className="block text-white">{compactNumber(detailVideo.views)}</b>조회</div>
                <div className="rounded-2xl bg-white/[0.06] p-3"><b className="block text-white">{compactNumber(detailVideo.likes)}</b>좋아요</div>
                <div className="rounded-2xl bg-white/[0.06] p-3"><b className="block text-white">{compactNumber(detailVideo.comments)}</b>댓글</div>
              </div>
              <p className="rounded-2xl bg-white/[0.04] p-3 text-sm leading-6 text-slate-300">{detailVideo.description || '설명 없음'}</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" disabled={!getVideoUrl(detailVideo)} onClick={() => window.open(getVideoUrl(detailVideo), '_blank', 'noopener,noreferrer')} className="ottogi-secondary rounded-2xl border px-4 py-3 text-sm font-bold disabled:opacity-35">
                  원본 열기
                </button>
                <button type="button" onClick={() => addUrlToBatch(detailVideo)} className="ottogi-primary rounded-2xl px-4 py-3 text-sm font-black">
                  {isVideoQueued(detailVideo) ? '담김' : 'URL 담기'}
                </button>
              </div>
              <button
                type="button"
                onClick={() => excludeVideo(detailVideo)}
                className="w-full rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm font-bold text-rose-100 hover:bg-rose-500/18"
              >
                상세에서 이 소재 제외
              </button>
            </div>
          ) : (
            <div className="mt-5 rounded-3xl border border-dashed border-white/12 bg-white/[0.03] p-5 text-sm text-slate-400">
              영상 카드를 클릭하면 썸네일과 상세 정보가 여기에 표시됩니다.
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
