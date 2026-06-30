import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePipelineStore } from '../store/pipelineStore';
import {
  PLATFORM_LABEL,
  buildCandidatePayload,
  compactNumber,
  extractOrbitId,
  extractVideosWithDebug,
  makeSummary,
  normalizeCometList,
  normalizeOutlierCreators,
  normalizeSounds,
  normalizeVideoResult,
  parseKeywordList,
  prettyDate,
  safeNum,
  safeText
} from '../services/virloDataService';

const PRESETS = [
  {
    id: 'movie_recap',
    name: 'Movie Recap',
    description: 'Overseas movie recap / movie explained short-form candidates',
    keywords: [
      'movie recap',
      'movie recap shorts',
      'film recap',
      'film recap minutes',
      'movie in minutes',
      'movie explained',
      'movie summary',
      'quick movie recaps'
    ],
    excludeKeywords: [
      'movie review',
      'trailer reaction',
      'box office',
      'celebrity gossip',
      'movie news',
      'film festival',
      'casting call',
      'behind the scenes'
    ],
    platforms: ['youtube', 'tiktok', 'instagram'],
    minViews: 50000,
    timePeriod: 'this_month',
    runAnalysis: true
  },
  {
    id: 'movie_plot_twist',
    name: 'Movie Plot Twist',
    description: 'Plot twist / ending reveal focused movie recap',
    keywords: [
      'plot twist movie',
      'movie plot twist',
      'shocking movie ending',
      'unexpected movie ending',
      'movie final reveal',
      'thriller recap',
      'mystery movie recap'
    ],
    excludeKeywords: ['movie review', 'trailer', 'ending explained long', 'interview', 'behind the scenes'],
    platforms: ['youtube', 'tiktok', 'instagram'],
    minViews: 50000,
    timePeriod: 'this_month',
    runAnalysis: true
  },
  {
    id: 'pet_funny',
    name: 'Pet Funny',
    description: 'Funny pet reaction viral candidates',
    keywords: ['funny dog', 'funny cat', 'funny pets', 'pet reaction', 'dog reaction', 'cat reaction', 'cute pets', 'animal funny'],
    excludeKeywords: ['pet food', 'vet advice', 'product review', 'adoption ad'],
    platforms: ['youtube', 'tiktok', 'instagram'],
    minViews: 50000,
    timePeriod: 'this_month',
    runAnalysis: true
  },
  {
    id: 'pet_emotion',
    name: 'Pet Emotion',
    description: 'Emotional pet reunion / rescue stories',
    keywords: ['dog reunion', 'pet reunion', 'loyal dog', 'adopted dog', 'rescue dog', 'stray dog', 'animal rescue', 'dog saved'],
    excludeKeywords: ['pet product', 'dog training', 'veterinary', 'shelter promotion'],
    platforms: ['youtube', 'tiktok', 'instagram'],
    minViews: 30000,
    timePeriod: 'this_month',
    runAnalysis: true
  },
  {
    id: 'animal_rescue',
    name: 'Animal Rescue',
    description: 'Animal rescue / transformation videos',
    keywords: ['animal rescue', 'dog rescue', 'cat rescue', 'stray dog rescue', 'abandoned dog', 'animal transformation', 'rescued puppy'],
    excludeKeywords: ['donation', 'fundraising', 'fake rescue', 'animal abuse graphic'],
    platforms: ['youtube', 'tiktok', 'instagram'],
    minViews: 30000,
    timePeriod: 'this_month',
    runAnalysis: true
  }
];

const TABS = [
  { id: 'youtube-scout', label: '\uC720\uD29C\uBE0C \uC2A4\uCE74\uC6B0\uD2B8', cost: 'YouTube API' }
];

const PAID_CALLS = [
  { key: 'trends', label: 'Trends', endpoint: '/v1/trends', price: '$0.25', route: '/virlo/data/trends?limit=12' },
  { key: 'videos_digest', label: 'Videos Digest', endpoint: '/v1/videos/digest', price: '$0.25', route: '/virlo/data/videos/digest?limit=60' },
  { key: 'sounds_trending', label: 'Sounds Trending', endpoint: '/v1/sounds/trending', price: '$0.25', route: '/virlo/data/sounds/trending?limit=20' },
  { key: 'hashtags', label: 'Hashtags', endpoint: '/v1/hashtags', price: '$0.05', route: '/virlo/data/hashtags?limit=30' }
];

const YOUTUBE_SCOUT_FAVORITES_KEY = 'phase1.youtubeScoutFavorites.v1';
const YOUTUBE_SCOUT_SESSION_KEY = 'phase1.youtubeScoutSession.v1';

function readStoredScoutFavorites() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(YOUTUBE_SCOUT_FAVORITES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredScoutFavorites(items) {
  try {
    window.localStorage.setItem(YOUTUBE_SCOUT_FAVORITES_KEY, JSON.stringify(items));
  } catch {
    // localStorage can fail in private contexts. The in-memory state still works.
  }
}

function readStoredScoutSession() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(YOUTUBE_SCOUT_SESSION_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredScoutSession(session) {
  try {
    window.localStorage.setItem(YOUTUBE_SCOUT_SESSION_KEY, JSON.stringify(session));
  } catch {
    // localStorage can fail in private contexts. The in-memory state still works.
  }
}

function scoutPeriodLabel(period) {
  const labels = {
    '24h': '최근 24시간',
    '3d': '최근 3일',
    '7d': '최근 7일',
    '14d': '최근 14일',
    '30d': '최근 30일',
    older_3m: '3개월 이상',
    older_6m: '6개월 이상',
    older_1y: '1년 이상',
    older_2y: '2년 이상',
    all: '전체 기간'
  };
  return labels[period] || period || '-';
}

function scoutSortLabel(sort) {
  const labels = {
    views: '조회수순',
    date: '최신순',
    views_per_hour: '시간당 조회수순'
  };
  return labels[sort] || sort || '-';
}

function buildScoutTabTitle(params) {
  return `${params.hashtag || '#shorts'} · ${scoutPeriodLabel(params.period)} · ${compactNumber(params.minViews)}+`;
}

function createScoutTab(params, videos = [], raw = null) {
  const now = new Date().toISOString();
  return {
    id: `scout_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: buildScoutTabTitle(params),
    params,
    videos,
    raw,
    createdAt: now,
    updatedAt: now
  };
}

function getViewScaleMeta(views) {
  const millions = Math.max(1, Math.floor(safeNum(views) / 1000000));
  const capped = Math.min(millions, 100);
  const intensity = capped / 100;
  const hue = Math.round(42 - (42 * intensity));
  const saturation = Math.round(78 + (12 * intensity));
  const lightness = Math.round(58 - (18 * intensity));
  const color = `hsl(${hue} ${saturation}% ${lightness}%)`;
  const softColor = `hsl(${hue} ${saturation}% 95%)`;
  return {
    millions,
    label: millions >= 100 ? '1억+' : `${millions}M+`,
    borderStyle: { borderColor: color, boxShadow: `0 0 0 1px ${softColor}` },
    badgeStyle: { backgroundColor: color, color: '#fff' },
    textStyle: { color }
  };
}

function getAgeScaleMeta(publishedAt) {
  const ms = new Date(publishedAt || '').getTime();
  if (!Number.isFinite(ms)) return null;
  const months = Math.max(0, Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24 * 30.4375)));
  if (months < 6) {
    return {
      months,
      label: `${months}개월`,
      className: 'text-[10px] bg-slate-100 text-slate-600 border-slate-200'
    };
  }
  if (months >= 24) return { months, label: `${months}개월 전`, className: 'text-base bg-red-600 text-white border-red-700' };
  if (months >= 18) return { months, label: `${months}개월 전`, className: 'text-sm bg-orange-500 text-white border-orange-600' };
  if (months >= 12) return { months, label: `${months}개월 전`, className: 'text-xs bg-amber-400 text-slate-950 border-amber-500' };
  if (months >= 9) return { months, label: `${months}개월 전`, className: 'text-[11px] bg-yellow-200 text-yellow-950 border-yellow-300' };
  return { months, label: `${months}개월 전`, className: 'text-[10px] bg-lime-100 text-lime-900 border-lime-200' };
}

function badgeColor(cost) {
  if (cost === 'Free') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  return 'bg-amber-100 text-amber-800 border-amber-200';
}

function buildErrorMessage(error, fallback) {
  const status = Number(error?.response?.status || 0);
  const stage = safeText(error?.response?.data?.details?.stage || '');
  const details = error?.response?.data?.details;
  const message = safeText(error?.response?.data?.message || details?.message || error?.message || '');

  if (status === 429) {
    const retryAfter = safeText(details?.retryAfter || details?.retry_after || '');
    return `Rate limited (429)${stage ? ` at ${stage}` : ''}. ${retryAfter ? `Retry after ${retryAfter}s.` : 'Retry after ~5 minutes.'}`;
  }
  if (status === 402) {
    return `Payment/Billing required (402). ${message || 'Check Virlo API usage/balance.'}`;
  }
  return `${fallback}${message ? `: ${message}` : ''}${stage ? ` (stage: ${stage})` : ''}`;
}

function isActiveSearchStatus(status) {
  return ['creating', 'queued', 'polling', 'fetching_videos'].includes(status);
}

function toPlatformState(platforms = []) {
  const set = new Set(platforms.map((p) => String(p).toLowerCase()));
  return {
    youtube: set.has('youtube'),
    tiktok: set.has('tiktok'),
    instagram: set.has('instagram')
  };
}

function uniqueByVideoKey(videos) {
  const seen = new Set();
  const out = [];
  for (const video of videos) {
    const key = video.url || `${video.platform}:${video.creator}:${video.publishedAt}:${video.title}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(video);
  }
  return out;
}

function normalizeTrackingVideo(item, idx) {
  return normalizeVideoResult(item, idx, { sourceQuery: 'tracking:videos' });
}

function normalizeCometStatus(status) {
  const s = safeText(status).toLowerCase();
  if (!s) return 'unknown';
  if (s === 'active' || s === 'running' || s === 'enabled') return 'active';
  if (s === 'paused' || s === 'pause') return 'paused';
  if (s === 'inactive' || s === 'disabled' || s === 'archived') return 'inactive';
  return 'unknown';
}

function cometStatusBadgeClass(status) {
  if (status === 'active') return 'border-emerald-200 bg-emerald-100 text-emerald-700';
  if (status === 'paused') return 'border-amber-200 bg-amber-100 text-amber-800';
  if (status === 'inactive') return 'border-rose-200 bg-rose-100 text-rose-700';
  return 'border-slate-200 bg-slate-100 text-slate-600';
}

export default function Phase1Search() {
  const navigate = useNavigate();
  const phase1 = usePipelineStore((s) => s.phase1);
  const phase5 = usePipelineStore((s) => s.phase5);
  const setPhase1 = usePipelineStore((s) => s.setPhase1);
  const setPhase5 = usePipelineStore((s) => s.setPhase5);
  const setCurrentPhase = usePipelineStore((s) => s.setCurrentPhase);
  const initialYoutubeScoutSession = useMemo(() => readStoredScoutSession(), []);

  const defaultPreset = PRESETS[0];

  const [activeTab, setActiveTab] = useState('youtube-scout');
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPreset.id);
  const [showSearchPanel, setShowSearchPanel] = useState(false);

  const [keywordsText, setKeywordsText] = useState(defaultPreset.keywords.join('\n'));
  const [excludeKeywordsText, setExcludeKeywordsText] = useState(defaultPreset.excludeKeywords.join('\n'));
  const [platforms, setPlatforms] = useState(toPlatformState(defaultPreset.platforms));
  const [minViews, setMinViews] = useState(defaultPreset.minViews);
  const [timePeriod, setTimePeriod] = useState(defaultPreset.timePeriod);
  const [runAnalysis, setRunAnalysis] = useState(defaultPreset.runAnalysis);

  const [status, setStatus] = useState('idle');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [rawResponse, setRawResponse] = useState(initialYoutubeScoutSession.rawResponse || null);
  const [showRaw, setShowRaw] = useState(false);

  const [comets, setComets] = useState([]);
  const [includeInactiveComets, setIncludeInactiveComets] = useState(true);
  const [selectedCometId, setSelectedCometId] = useState('');
  const [selectedCometMeta, setSelectedCometMeta] = useState(null);
  const [cometVideos, setCometVideos] = useState([]);
  const [cometOutliers, setCometOutliers] = useState([]);
  const [cometSounds, setCometSounds] = useState([]);
  const [cometVideoDebug, setCometVideoDebug] = useState({ selectedPath: null, candidates: [] });

  const [trackingVideos, setTrackingVideos] = useState([]);
  const [trackingCreators, setTrackingCreators] = useState([]);

  const [youtubeHashtag, setYoutubeHashtag] = useState(initialYoutubeScoutSession.form?.hashtag || '#shorts');
  const [youtubePeriod, setYoutubePeriod] = useState(initialYoutubeScoutSession.form?.period || 'older_6m');
  const [youtubeSort, setYoutubeSort] = useState(initialYoutubeScoutSession.form?.sort || 'views');
  const [youtubeMinViews, setYoutubeMinViews] = useState(Number(initialYoutubeScoutSession.form?.minViews || 1000000));
  const [youtubeVideos, setYoutubeVideos] = useState(Array.isArray(initialYoutubeScoutSession.videos) ? initialYoutubeScoutSession.videos : []);
  const [youtubeScoutTabs, setYoutubeScoutTabs] = useState(Array.isArray(initialYoutubeScoutSession.tabs) ? initialYoutubeScoutSession.tabs : []);
  const [activeYoutubeScoutTabId, setActiveYoutubeScoutTabId] = useState(initialYoutubeScoutSession.activeTabId || '');
  const [youtubeScoutFavorites, setYoutubeScoutFavorites] = useState(readStoredScoutFavorites);

  const [orbitLookupId, setOrbitLookupId] = useState('');
  const [orbitVideos, setOrbitVideos] = useState([]);
  const [orbitVideoDebug, setOrbitVideoDebug] = useState({ selectedPath: null, candidates: [] });
  const [recentSearchVideos, setRecentSearchVideos] = useState([]);
  const [orbitId, setOrbitId] = useState(phase1.orbitId || '');

  const [savedCandidates, setSavedCandidates] = useState([]);
  const [detailVideo, setDetailVideo] = useState(null);

  const [videoQuery, setVideoQuery] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [sortMode, setSortMode] = useState('most_views');
  const [savedOnly, setSavedOnly] = useState(false);

  const [loading, setLoading] = useState({
    initial: false,
    cometVideos: false,
    orbitVideos: false,
    orbitCreate: false,
    paid: false,
    youtubeScout: false
  });

  const [paidResults, setPaidResults] = useState({});

  const selectedPreset = useMemo(() => PRESETS.find((item) => item.id === selectedPresetId) || defaultPreset, [selectedPresetId]);
  const queryKeywords = useMemo(() => parseKeywordList(keywordsText), [keywordsText]);
  const queryExcludeKeywords = useMemo(() => parseKeywordList(excludeKeywordsText), [excludeKeywordsText]);
  const queryPlatforms = useMemo(() => Object.entries(platforms).filter(([, on]) => on).map(([key]) => key), [platforms]);
  const activeYoutubeScoutTab = useMemo(() => (
    youtubeScoutTabs.find((item) => item.id === activeYoutubeScoutTabId) || null
  ), [youtubeScoutTabs, activeYoutubeScoutTabId]);

  useEffect(() => {
    writeStoredScoutSession({
      form: {
        hashtag: youtubeHashtag,
        period: youtubePeriod,
        sort: youtubeSort,
        minViews: Number(youtubeMinViews || 0)
      },
      videos: youtubeVideos,
      tabs: youtubeScoutTabs.slice(0, 12),
      activeTabId: activeYoutubeScoutTabId,
      rawResponse: rawResponse?.youtubeScout ? { youtubeScout: rawResponse.youtubeScout } : null,
      savedAt: new Date().toISOString()
    });
  }, [activeYoutubeScoutTabId, rawResponse, youtubeHashtag, youtubeMinViews, youtubePeriod, youtubeScoutTabs, youtubeSort, youtubeVideos]);

  const allVideos = useMemo(() => {
    if (activeTab === 'youtube-scout') return activeYoutubeScoutTab?.videos || youtubeVideos;
    if (activeTab === 'comet') return cometVideos;
    if (activeTab === 'tracking') return trackingVideos;
    if (activeTab === 'saved') {
      return savedCandidates.map((item, idx) => normalizeVideoResult(item, idx, {
        sourceQuery: item.source_query || 'saved:candidates',
        presetId: item.source_preset_id,
        presetName: item.source_preset_name,
        keywords: item.source_keywords,
        excludeKeywords: item.source_exclude_keywords
      }));
    }
    if (activeTab === 'orbit-read') return orbitVideos;
    if (activeTab === 'orbit-create') return recentSearchVideos;
    return [];
  }, [activeTab, activeYoutubeScoutTab, cometVideos, orbitVideos, recentSearchVideos, savedCandidates, trackingVideos, youtubeVideos]);

  const filteredVideos = useMemo(() => {
    let rows = [...allVideos];

    if (savedOnly) {
      rows = rows.filter((video) => isSavedVideo(video));
    }

    if (platformFilter !== 'all') {
      rows = rows.filter((video) => safeText(video.platform).toLowerCase() === platformFilter);
    }

    if (videoQuery.trim()) {
      const q = videoQuery.trim().toLowerCase();
      rows = rows.filter((video) => {
        const hay = [
          video.title,
          video.description,
          video.creator,
          video.handle,
          ...(video.hashtags || [])
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    if (sortMode === 'most_recent') {
      rows.sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
    } else if (sortMode === 'virality') {
      rows.sort((a, b) => safeNum(b.viralityScore) - safeNum(a.viralityScore));
    } else {
      rows.sort((a, b) => safeNum(b.views) - safeNum(a.views));
    }

    return uniqueByVideoKey(rows);
  }, [allVideos, platformFilter, sortMode, videoQuery, savedOnly]);

  const mostViralVideos = useMemo(() => {
    return [...filteredVideos]
      .sort((a, b) => {
        const left = Math.max(safeNum(a.viralityScore) * 1000, safeNum(a.views));
        const right = Math.max(safeNum(b.viralityScore) * 1000, safeNum(b.views));
        return right - left;
      })
      .slice(0, 12);
  }, [filteredVideos]);

  const hashtags = useMemo(() => {
    const map = new Map();
    for (const video of filteredVideos) {
      for (const tag of video.hashtags || []) {
        map.set(tag, (map.get(tag) || 0) + 1);
      }
    }
    return [...map.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  }, [filteredVideos]);

  const summary = useMemo(() => makeSummary(filteredVideos, {
    period: timePeriod,
    preset: selectedPreset.name,
    keywords: queryKeywords
  }), [filteredVideos, queryKeywords, selectedPreset.name, timePeriod]);

  const selectedSourceDebug = useMemo(() => {
    if (activeTab === 'comet') return cometVideoDebug;
    if (activeTab === 'orbit-read') return orbitVideoDebug;
    return { selectedPath: null, candidates: [] };
  }, [activeTab, cometVideoDebug, orbitVideoDebug]);

  const selectedCometStatus = useMemo(() => {
    const fromList = comets.find((item) => item.id === selectedCometId)?.status;
    const fromDetail = selectedCometMeta?.status;
    return normalizeCometStatus(fromList || fromDetail);
  }, [comets, selectedCometId, selectedCometMeta]);

  useEffect(() => {
    loadSavedCandidates();
  }, []);

  useEffect(() => {
    if (!selectedCometId) return;
    loadCometBundle(selectedCometId);
  }, [selectedCometId]);

  function isSavedVideo(video) {
    const url = safeText(video.url);
    if (url) {
      return savedCandidates.some((item) => safeText(item.url) === url);
    }
    return savedCandidates.some((item) => (
      safeText(item.platform).toLowerCase() === safeText(video.platform).toLowerCase()
      && safeText(item.creator).toLowerCase() === safeText(video.creator).toLowerCase()
      && safeText(item.publishedAt || item.published_at) === safeText(video.publishedAt)
    ));
  }

  function findSavedCandidate(video) {
    const url = safeText(video.url);
    if (url) {
      return savedCandidates.find((item) => safeText(item.url) === url) || null;
    }
    return savedCandidates.find((item) => (
      safeText(item.platform).toLowerCase() === safeText(video.platform).toLowerCase()
      && safeText(item.creator).toLowerCase() === safeText(video.creator).toLowerCase()
      && safeText(item.publishedAt || item.published_at) === safeText(video.publishedAt)
    )) || null;
  }

  async function loadInitialFreeData() {
    setLoading((prev) => ({ ...prev, initial: true }));
    setError('');
    setNotice('Loading free Virlo data (Comet / Tracking)...');

    try {
      const cometsUrl = includeInactiveComets
        ? '/virlo/data/comets?include_inactive=true'
        : '/virlo/data/comets';
      const [cometsRes, trackingVideosRes, trackingCreatorsRes, candidatesRes] = await Promise.allSettled([
        api.get(cometsUrl),
        api.get('/virlo/data/tracking/videos?limit=80'),
        api.get('/virlo/data/tracking/creators?limit=40'),
        api.get('/virlo/candidates')
      ]);

      const nextRaw = {};

      if (cometsRes.status === 'fulfilled') {
        nextRaw.comets = cometsRes.value.data;
        const rows = normalizeCometList(cometsRes.value.data);
        setComets(rows);
        if (rows.length > 0) {
          setSelectedCometId((prev) => (rows.some((row) => row.id === prev) ? prev : rows[0].id));
        } else {
          setSelectedCometId('');
        }
      }

      if (trackingVideosRes.status === 'fulfilled') {
        nextRaw.trackingVideos = trackingVideosRes.value.data;
        const extracted = extractVideosWithDebug(trackingVideosRes.value.data);
        const rows = extracted.videos.map((row, idx) => normalizeTrackingVideo(row, idx));
        setTrackingVideos(rows);
      }

      if (trackingCreatorsRes.status === 'fulfilled') {
        nextRaw.trackingCreators = trackingCreatorsRes.value.data;
        const rows = trackingCreatorsRes.value.data?.data || trackingCreatorsRes.value.data?.items || trackingCreatorsRes.value.data?.creators || [];
        setTrackingCreators(Array.isArray(rows) ? rows : []);
      }

      if (candidatesRes.status === 'fulfilled') {
        nextRaw.candidates = candidatesRes.value.data;
        setSavedCandidates(Array.isArray(candidatesRes.value.data?.items) ? candidatesRes.value.data.items : []);
      }

      setRawResponse(nextRaw);
      setNotice('Free endpoints loaded. Select a Comet to view refreshed niche videos.');
    } catch (loadError) {
      setError(buildErrorMessage(loadError, 'Failed to load initial free data'));
      setNotice('');
    } finally {
      setLoading((prev) => ({ ...prev, initial: false }));
    }
  }

  async function loadSavedCandidates() {
    try {
      const res = await api.get('/virlo/candidates');
      setSavedCandidates(Array.isArray(res.data?.items) ? res.data.items : []);
    } catch (candidateError) {
      setError(buildErrorMessage(candidateError, 'Failed to load saved candidates'));
    } finally {
      setLoading((prev) => ({ ...prev, initial: false }));
    }
  }

  async function loadCometBundle(cometId) {
    const id = safeText(cometId);
    if (!id) return;

    setLoading((prev) => ({ ...prev, cometVideos: true }));
    setError('');
    setNotice(`Loading Comet ${id} videos (Free endpoint)...`);

    try {
      const [detailRes, videosRes, outliersRes, soundsRes] = await Promise.allSettled([
        api.get(`/virlo/data/comets/${id}`),
        api.get(`/virlo/data/comets/${id}/videos?limit=120&order_by=views&sort=desc`),
        api.get(`/virlo/data/comets/${id}/outliers?limit=20`),
        api.get(`/virlo/data/comets/${id}/sounds?limit=20`)
      ]);

      const nextRaw = { ...(rawResponse || {}) };

      if (detailRes.status === 'fulfilled') {
        nextRaw.cometDetail = detailRes.value.data;
        setSelectedCometMeta(detailRes.value.data || null);
      }

      if (videosRes.status === 'fulfilled') {
        nextRaw.cometVideos = videosRes.value.data;
        const extracted = extractVideosWithDebug(videosRes.value.data);
        setCometVideoDebug({ selectedPath: extracted.selectedPath, candidates: extracted.candidates });
        const rows = extracted.videos.map((row, idx) => normalizeVideoResult(row, idx, {
          sourceQuery: `comet:${id}`,
          presetId: selectedPreset.id,
          presetName: selectedPreset.name,
          keywords: queryKeywords,
          excludeKeywords: queryExcludeKeywords
        }));
        setCometVideos(rows);
        setPhase1({ searchResults: { videos: rows }, orbitStatus: 'completed' });
      } else {
        setCometVideos([]);
      }

      if (outliersRes.status === 'fulfilled') {
        nextRaw.cometOutliers = outliersRes.value.data;
        setCometOutliers(normalizeOutlierCreators(outliersRes.value.data));
      } else {
        setCometOutliers([]);
      }

      if (soundsRes.status === 'fulfilled') {
        nextRaw.cometSounds = soundsRes.value.data;
        setCometSounds(normalizeSounds(soundsRes.value.data));
      } else {
        setCometSounds([]);
      }

      setRawResponse(nextRaw);
      setNotice(`Comet ${id} loaded.`);
    } catch (loadError) {
      setError(buildErrorMessage(loadError, 'Failed to load Comet data'));
    } finally {
      setLoading((prev) => ({ ...prev, cometVideos: false }));
    }
  }

  async function lookupOrbitVideos() {
    const id = safeText(orbitLookupId);
    if (!id) {
      setError('Enter an existing orbit id first.');
      return;
    }

    setLoading((prev) => ({ ...prev, orbitVideos: true }));
    setError('');
    setNotice(`Loading orbit ${id} videos (Free endpoint)...`);

    try {
      const res = await api.get(`/virlo/data/orbits/${id}/videos?limit=120&order_by=views&sort=desc`);
      const extracted = extractVideosWithDebug(res.data);
      setOrbitVideoDebug({ selectedPath: extracted.selectedPath, candidates: extracted.candidates });
      const rows = extracted.videos.map((row, idx) => normalizeVideoResult(row, idx, {
        sourceQuery: `orbit:${id}`,
        presetId: selectedPreset.id,
        presetName: selectedPreset.name,
        keywords: queryKeywords,
        excludeKeywords: queryExcludeKeywords
      }));
      setOrbitVideos(rows);
      setRawResponse((prev) => ({ ...(prev || {}), orbitVideos: res.data }));
      setNotice(`Loaded ${rows.length} videos from orbit ${id}.`);
      setActiveTab('orbit-read');
    } catch (lookupError) {
      setError(buildErrorMessage(lookupError, 'Failed to load orbit videos'));
    } finally {
      setLoading((prev) => ({ ...prev, orbitVideos: false }));
    }
  }

  async function runOrbitSearch() {
    if (isActiveSearchStatus(status) || loading.orbitCreate) return;

    const keywords = queryKeywords;
    const selectedPlatforms = queryPlatforms;

    if (keywords.length === 0) {
      setError('Add at least one keyword.');
      return;
    }
    if (selectedPlatforms.length === 0) {
      setError('Select at least one platform.');
      return;
    }

    const ok = window.confirm('New Orbit Search calls POST /v1/orbit ($0.50). Continue?');
    if (!ok) return;

    setLoading((prev) => ({ ...prev, orbitCreate: true }));
    setError('');
    setNotice('Creating new orbit search ($0.50)...');
    setStatus('creating');

    const payload = {
      keywords,
      excludeKeywords: queryExcludeKeywords,
      platforms: selectedPlatforms,
      minViews: Number(minViews) || 0,
      timePeriod,
      runAnalysis,
      presetId: selectedPreset.id
    };

    try {
      const createRes = await api.post('/virlo/search', payload);
      const id = extractOrbitId(createRes.data);

      if (!id) {
        throw new Error('Orbit id not found in create response.');
      }

      setOrbitId(id);
      setPhase1({ orbitId: id, orbitStatus: createRes.data?.status || 'queued' });
      setRawResponse((prev) => ({ ...(prev || {}), orbitCreate: createRes.data }));
      setStatus('queued');
      setNotice(`Orbit created: ${id}. Polling every 12 seconds...`);

      const maxPoll = 40;
      let completed = false;

      for (let i = 0; i < maxPoll; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 12000));
        setStatus('polling');
        const pollRes = await api.get(`/virlo/search/${id}`);
        const pollStatus = safeText(pollRes.data?.status || pollRes.data?.state || '').toLowerCase();
        setRawResponse((prev) => ({ ...(prev || {}), orbitPoll: pollRes.data }));

        if (pollStatus === 'completed') {
          completed = true;
          break;
        }

        if (pollStatus === 'failed' || pollStatus === 'error') {
          throw new Error(`Orbit job ended with status: ${pollStatus}`);
        }
      }

      if (!completed) {
        throw new Error('Orbit polling timeout (about 8 minutes).');
      }

      setStatus('fetching_videos');
      const videosRes = await api.get(`/virlo/search/${id}/videos?limit=120&order_by=views&sort=desc`);
      const extracted = extractVideosWithDebug(videosRes.data);
      const rows = extracted.videos.map((row, idx) => normalizeVideoResult(row, idx, {
        sourceQuery: `orbit-search:${id}`,
        presetId: selectedPreset.id,
        presetName: selectedPreset.name,
        keywords,
        excludeKeywords: queryExcludeKeywords
      }));

      setRecentSearchVideos(rows);
      setOrbitVideoDebug({ selectedPath: extracted.selectedPath, candidates: extracted.candidates });
      setRawResponse((prev) => ({ ...(prev || {}), orbitSearchVideos: videosRes.data }));
      setStatus('completed');
      setPhase1({ searchResults: { videos: rows }, orbitStatus: 'completed' });
      setNotice(`Orbit search completed. ${rows.length} videos loaded.`);
      setActiveTab('orbit-create');
    } catch (searchError) {
      setStatus('failed');
      setError(buildErrorMessage(searchError, 'Orbit search failed'));
    } finally {
      setLoading((prev) => ({ ...prev, orbitCreate: false }));
      setTimeout(() => setStatus('idle'), 0);
    }
  }

  async function callPaidEndpoint(item) {
    if (loading.paid) return;
    const ok = window.confirm(`${item.label} uses ${item.endpoint} (${item.price}) and may cost API balance. Continue?`);
    if (!ok) return;

    setLoading((prev) => ({ ...prev, paid: true }));
    setError('');
    setNotice(`Calling paid endpoint ${item.endpoint} (${item.price})...`);

    try {
      const res = await api.get(item.route);
      setPaidResults((prev) => ({ ...prev, [item.key]: res.data }));
      setRawResponse((prev) => ({ ...(prev || {}), [`paid_${item.key}`]: res.data }));
      setNotice(`${item.label} loaded.`);
    } catch (paidError) {
      setError(buildErrorMessage(paidError, `Paid endpoint ${item.label} failed`));
    } finally {
      setLoading((prev) => ({ ...prev, paid: false }));
    }
  }

  function applyYoutubeScoutParams(params) {
    setYoutubeHashtag(params.hashtag || '#shorts');
    setYoutubePeriod(params.period || 'older_6m');
    setYoutubeSort(params.sort || 'views');
    setYoutubeMinViews(Number(params.minViews || 1000000));
  }

  function selectYoutubeScoutTab(tabId) {
    const tab = youtubeScoutTabs.find((item) => item.id === tabId);
    if (!tab) return;
    setActiveYoutubeScoutTabId(tab.id);
    setYoutubeVideos(tab.videos || []);
    applyYoutubeScoutParams(tab.params || {});
    setActiveTab('youtube-scout');
  }

  function closeYoutubeScoutTab(tabId) {
    setYoutubeScoutTabs((prev) => {
      const next = prev.filter((item) => item.id !== tabId);
      if (activeYoutubeScoutTabId === tabId) {
        const fallback = next[0] || null;
        setActiveYoutubeScoutTabId(fallback?.id || '');
        setYoutubeVideos(fallback?.videos || []);
      }
      return next;
    });
  }

  function saveYoutubeScoutFavorite() {
    const params = {
      hashtag: safeText(youtubeHashtag) || '#shorts',
      period: youtubePeriod,
      sort: youtubeSort,
      minViews: Number(youtubeMinViews || 1000000)
    };
    const favorite = {
      id: `fav_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: buildScoutTabTitle(params),
      params,
      savedAt: new Date().toISOString()
    };
    setYoutubeScoutFavorites((prev) => {
      const next = [favorite, ...prev.filter((item) => {
        const p = item.params || {};
        return !(p.hashtag === params.hashtag && p.period === params.period && p.sort === params.sort && Number(p.minViews || 0) === params.minViews);
      })].slice(0, 20);
      writeStoredScoutFavorites(next);
      return next;
    });
    setNotice('\uC2A4\uCE74\uC6B0\uD2B8 \uC870\uAC74\uC744 \uC990\uACA8\uCC3E\uAE30\uC5D0 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.');
  }

  function removeYoutubeScoutFavorite(favoriteId) {
    setYoutubeScoutFavorites((prev) => {
      const next = prev.filter((item) => item.id !== favoriteId);
      writeStoredScoutFavorites(next);
      return next;
    });
  }

  async function runYoutubeScout(overrides = {}) {
    const params = {
      hashtag: safeText(overrides.hashtag ?? youtubeHashtag),
      period: overrides.period || youtubePeriod,
      sort: overrides.sort || youtubeSort,
      minViews: Number(overrides.minViews ?? youtubeMinViews ?? 1000000)
    };
    const tag = safeText(params.hashtag);
    if (!tag) {
      setError('\uD574\uC2DC\uD0DC\uADF8\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694.');
      return;
    }

    applyYoutubeScoutParams(params);
    setLoading((prev) => ({ ...prev, youtubeScout: true }));
    setError('');
    setNotice('\uCD5C\uB300 60\uAC1C\uC758 YouTube Shorts\uB97C \uC870\uD68C\uD558\uB294 \uC911\uC785\uB2C8\uB2E4...');

    try {
      const res = await api.get('/youtube/scout', {
        params: {
          hashtag: tag,
          period: params.period,
          sort: params.sort,
          minViews: params.minViews,
          limit: 50
        }
      });
      const rows = Array.isArray(res.data?.videos) ? res.data.videos : [];
      const nextTab = createScoutTab(params, rows, res.data);
      setYoutubeScoutTabs((prev) => [nextTab, ...prev].slice(0, 12));
      setActiveYoutubeScoutTabId(nextTab.id);
      setYoutubeVideos(rows);
      setRawResponse((prev) => ({ ...(prev || {}), youtubeScout: res.data }));
      setPhase1({ searchResults: { videos: rows }, orbitStatus: 'youtube_scout' });
      setNotice(`\uAC80\uC0C9 \uC644\uB8CC: \uC870\uAC74\uC5D0 \uB9DE\uB294 \uC601\uC0C1 ${rows.length}\uAC1C\uB97C \uCC3E\uC558\uC2B5\uB2C8\uB2E4.`);
      setActiveTab('youtube-scout');
    } catch (scoutError) {
      setError(buildErrorMessage(scoutError, '\uC2A4\uCE74\uC6B0\uD2B8 \uAC80\uC0C9\uC744 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4'));
    } finally {
      setLoading((prev) => ({ ...prev, youtubeScout: false }));
    }
  }

  async function saveCandidate(video) {
    try {
      const payload = buildCandidatePayload(video);
      const res = await api.post('/virlo/candidates', payload);
      const savedItem = res.data?.item;
      if (savedItem) {
        setSavedCandidates((prev) => {
          const exists = prev.some((item) => safeText(item.id) === safeText(savedItem.id));
          if (exists) return prev;
          return [savedItem, ...prev];
        });
      }
      setNotice(res.data?.duplicate ? 'Already saved candidate.' : 'Candidate saved.');
    } catch (saveError) {
      setError(buildErrorMessage(saveError, 'Failed to save candidate'));
    }
  }

  async function removeCandidate(video) {
    const saved = findSavedCandidate(video);
    if (!saved) return;

    try {
      await api.delete(`/virlo/candidates/${saved.id}`);
      setSavedCandidates((prev) => prev.filter((item) => safeText(item.id) !== safeText(saved.id)));
      setNotice('Candidate removed.');
    } catch (removeError) {
      setError(buildErrorMessage(removeError, 'Failed to remove candidate'));
    }
  }

  function addVideoUrlToBatchDraft(video) {
    const url = safeText(video?.url || video?.videoUrl || video?.watchUrl || video?.source_url || video?.raw?.url || video?.raw?.video_url);
    if (!url) {
      setError('담을 수 있는 영상 URL이 없습니다.');
      return;
    }

    const pendingVideo = {
      id: safeText(video?.id || url),
      url,
      title: safeText(video?.title || video?.description || '유튜브 소재'),
      description: safeText(video?.description || ''),
      thumbnail: safeText(video?.thumbnail || ''),
      creator: safeText(video?.creator || ''),
      handle: safeText(video?.handle || ''),
      platform: safeText(video?.platform || 'youtube'),
      views: safeNum(video?.views),
      publishedAt: safeText(video?.publishedAt || ''),
      hashtags: Array.isArray(video?.hashtags) ? video.hashtags : [],
      addedAt: new Date().toISOString()
    };

    const current = Array.isArray(phase5.pendingSourceVideos) ? phase5.pendingSourceVideos : [];
    const next = [
      pendingVideo,
      ...current.filter((item) => safeText(item.url) !== url)
    ].slice(0, 100);

    setPhase1({ selectedVideo: video });
    setPhase5({ pendingSourceVideos: next });
    setCurrentPhase(2);
    setNotice('배치 드래프트에 URL을 담았습니다.');
    navigate('/phase-5');
  }

  function togglePlatform(key) {
    setPlatforms((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function applyPreset(preset) {
    setSelectedPresetId(preset.id);
    setKeywordsText(preset.keywords.join('\n'));
    setExcludeKeywordsText(preset.excludeKeywords.join('\n'));
    setPlatforms(toPlatformState(preset.platforms));
    setMinViews(preset.minViews);
    setTimePeriod(preset.timePeriod);
    setRunAnalysis(Boolean(preset.runAnalysis));
  }

  function resetPreset() {
    applyPreset(defaultPreset);
  }

  const emptyWarnings = useMemo(() => {
    const list = [];
    if (filteredVideos.length > 0) return list;

    if (activeTab === 'comet') {
      list.push('No videos available for the selected Comet.');
      if (selectedCometId) list.push(`Selected Comet ID: ${selectedCometId}`);
      if (selectedSourceDebug.selectedPath) {
        list.push(`Detected path: ${selectedSourceDebug.selectedPath}`);
      } else {
        list.push('No video array path detected from /v1/comet/:id/videos response.');
      }
    }
    if (activeTab === 'orbit-read') {
      list.push('No videos for the selected orbit id.');
      if (selectedSourceDebug.selectedPath) {
        list.push(`Detected path: ${selectedSourceDebug.selectedPath}`);
      } else {
        list.push('No video array path detected from /v1/orbit/:id/videos response.');
      }
    }
    if (activeTab === 'tracking') list.push('Tracking videos are empty in this account.');
    if (activeTab === 'saved') list.push('No saved candidates yet.');
    if (activeTab === 'orbit-create') list.push('No recent orbit-search videos. Run new orbit search manually from this tab.');
    if (activeTab === 'youtube-scout') list.push('아직 불러온 유튜브 쇼츠가 없습니다. 해시태그를 입력하고 스카우트를 실행하세요.');
    return list;
  }, [activeTab, filteredVideos.length, selectedCometId, selectedSourceDebug.selectedPath]);

  const btnPrimary = 'rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700';
  const btnGhost = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50';
  const btnDanger = 'rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 transition hover:bg-rose-100';

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">3분 오뚝이영상 · Phase 1</p>
        <h1 className="text-3xl font-bold text-slate-900">소재 발굴</h1>
        <p className="text-sm text-slate-600">
          유튜브 스카우트로 후보를 찾고, 쓸 영상은 URL 담기로 배치 드래프트 큐에 바로 넘깁니다.
        </p>
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">YouTube Scout API</span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">1분 미만 쇼츠 필터</span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">URL 담기 → 배치 큐</span>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Preset Summary</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowSearchPanel((prev) => !prev)} className={btnGhost}>
              {showSearchPanel ? '검색 조건 닫기' : '검색 조건 열기'}
            </button>
            <button type="button" onClick={resetPreset} className={btnGhost}>프리셋 초기화</button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-sm md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">프리셋</p><p className="font-semibold text-slate-900">{selectedPreset.name}</p></div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">플랫폼</p><p className="font-semibold text-slate-900">{queryPlatforms.map((p) => PLATFORM_LABEL[p] || p).join(', ') || '-'}</p></div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">기간 / 최소 조회수</p><p className="font-semibold text-slate-900">{timePeriod} / {compactNumber(minViews)}</p></div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs text-slate-500">키워드</p><p className="font-semibold text-slate-900 line-clamp-2">{queryKeywords.join(', ') || '-'}</p></div>
        </div>

        {showSearchPanel ? (
          <div className="mt-4 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {PRESETS.map((preset) => {
                const active = preset.id === selectedPreset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`rounded-xl border p-3 text-left ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-900 hover:bg-slate-100'}`}
                  >
                    <p className="font-semibold">{preset.name}</p>
                    <p className={`mt-1 text-xs ${active ? 'text-slate-200' : 'text-slate-600'}`}>{preset.description}</p>
                    <p className={`mt-2 text-xs ${active ? 'text-slate-300' : 'text-slate-500'}`}>최소 조회수 {compactNumber(preset.minViews)} / {preset.timePeriod}</p>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">키워드 (쉼표 또는 줄바꿈)</span>
                <textarea rows={5} value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">제외 키워드</span>
                <textarea rows={5} value={excludeKeywordsText} onChange={(e) => setExcludeKeywordsText(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 text-sm"><span className="font-medium text-slate-700">최소 조회수</span><input type="number" value={minViews} onChange={(e) => setMinViews(Number(e.target.value) || 0)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" /></label>
              <label className="space-y-1 text-sm"><span className="font-medium text-slate-700">기간</span><select value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"><option value="today">오늘</option><option value="this_week">이번 주</option><option value="this_month">이번 달</option></select></label>
              <div className="space-y-1 text-sm"><span className="font-medium text-slate-700">분석 포함</span><button type="button" onClick={() => setRunAnalysis((prev) => !prev)} className={`${runAnalysis ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-white text-slate-700'} w-full rounded-lg border px-3 py-2 text-sm`}>{runAnalysis ? 'ON' : 'OFF'}</button><p className="text-xs text-slate-500">ON이면 검색 작업이 더 오래 걸릴 수 있습니다.</p></div>
              <div className="space-y-1 text-sm"><span className="font-medium text-slate-700">플랫폼</span><div className="flex flex-wrap gap-2">{['youtube', 'tiktok', 'instagram'].map((p) => (<button key={p} type="button" onClick={() => togglePlatform(p)} className={`${platforms[p] ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'} rounded-full border px-3 py-1 text-xs`}>{platforms[p] ? 'ON' : 'OFF'} {p}</button>))}</div></div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={`rounded-xl border px-3 py-2 text-sm font-medium ${activeTab === tab.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {tab.label}
              <span className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] ${activeTab === tab.id ? 'border-white/30 bg-white/10 text-white' : badgeColor(tab.cost)}`}>{tab.cost}</span>
            </button>
          ))}
        </div>
      </section>

      {activeTab === 'youtube-scout' ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-red-950">유튜브 스카우트</h3>
              <p className="text-sm text-red-800">
                해시태그로 공개 유튜브 쇼츠 후보를 찾습니다. 60초 미만 영상만 걸러서 보여주고, 원본 열기로 크롬에서 vidIQ 그래프를 확인하면 됩니다.
              </p>
            </div>
            <span className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-700">YouTube Data API</span>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.75fr_0.7fr_auto]">
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">해시태그</span>
              <input
                value={youtubeHashtag}
                onChange={(e) => setYoutubeHashtag(e.target.value)}
                placeholder="#worker"
                className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">업로드 시점</span>
              <select value={youtubePeriod} onChange={(e) => setYoutubePeriod(e.target.value)} className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm">
                <option value="24h">최근 24시간</option>
                <option value="3d">최근 3일</option>
                <option value="7d">최근 7일</option>
                <option value="14d">최근 14일</option>
                <option value="30d">최근 30일</option>
                <option value="older_3m">3개월 이상</option>
                <option value="older_6m">6개월 이상</option>
                <option value="older_1y">1년 이상</option>
                <option value="older_2y">2년 이상</option>
                <option value="all">전체 기간</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">정렬</span>
              <select value={youtubeSort} onChange={(e) => setYoutubeSort(e.target.value)} className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm">
                <option value="views">조회수순</option>
                <option value="date">최신순</option>
                <option value="views_per_hour">시간당 조회수순</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">최소 조회수</span>
              <input
                type="number"
                value={youtubeMinViews}
                onChange={(e) => setYoutubeMinViews(Number(e.target.value) || 0)}
                className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm"
              />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={() => runYoutubeScout()} disabled={loading.youtubeScout} className={`${btnPrimary} w-full whitespace-nowrap`}>
                {loading.youtubeScout ? '검색 중...' : '쇼츠 스카우트'}
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-red-100 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">검색 조건 즐겨찾기</p>
                <p className="text-xs text-slate-500">자주 보는 해시태그와 조건을 저장해두고 원클릭으로 다시 불러옵니다.</p>
              </div>
              <button type="button" onClick={saveYoutubeScoutFavorite} className={btnGhost}>현재 조건 저장</button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {youtubeScoutFavorites.length === 0 ? (
                <p className="text-xs text-slate-500">아직 저장된 조건이 없습니다.</p>
              ) : youtubeScoutFavorites.map((favorite) => (
                <div key={favorite.id} className="flex items-center overflow-hidden rounded-full border border-red-200 bg-red-50 text-xs">
                  <button
                    type="button"
                    onClick={() => runYoutubeScout(favorite.params)}
                    className="px-3 py-1.5 font-semibold text-red-800 hover:bg-red-100"
                  >
                    {favorite.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeYoutubeScoutFavorite(favorite.id)}
                    className="border-l border-red-200 px-2 py-1.5 text-red-500 hover:bg-red-100"
                    aria-label={`${favorite.name} 삭제`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-red-100 bg-white p-3">
              <p className="text-xs text-slate-500">불러온 쇼츠</p>
              <p className="text-2xl font-semibold text-slate-900">{youtubeVideos.length}</p>
            </div>
            <div className="rounded-xl border border-red-100 bg-white p-3">
              <p className="text-xs text-slate-500">길이 조건</p>
              <p className="text-sm font-semibold text-slate-900">60초 미만만 표시</p>
            </div>
            <div className="rounded-xl border border-red-100 bg-white p-3">
              <p className="text-xs text-slate-500">조회수 조건</p>
              <p className="text-sm font-semibold text-slate-900">{compactNumber(youtubeMinViews)} 이상</p>
            </div>
            <div className="rounded-xl border border-red-100 bg-white p-3">
              <p className="text-xs text-slate-500">vidIQ 그래프</p>
              <p className="text-sm font-semibold text-slate-900">원본 열기로 크롬에서 확인</p>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-red-100 bg-white p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">스카우트 결과 탭</p>
              <p className="text-xs text-slate-500">검색할 때마다 새 탭으로 보관됩니다.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {youtubeScoutTabs.length === 0 ? (
                <p className="text-xs text-slate-500">아직 열린 결과 탭이 없습니다.</p>
              ) : youtubeScoutTabs.map((tab) => (
                <div key={tab.id} className={`flex items-center overflow-hidden rounded-full border text-xs ${tab.id === activeYoutubeScoutTabId ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
                  <button
                    type="button"
                    onClick={() => selectYoutubeScoutTab(tab.id)}
                    className="px-3 py-1.5 font-semibold"
                  >
                    {tab.title} · {tab.videos?.length || 0}개
                  </button>
                  <button
                    type="button"
                    onClick={() => closeYoutubeScoutTab(tab.id)}
                    className={`border-l px-2 py-1.5 ${tab.id === activeYoutubeScoutTabId ? 'border-white/20 text-white/80' : 'border-slate-200 text-slate-400'}`}
                    aria-label={`${tab.title} 닫기`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === 'comet' ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xl font-semibold text-emerald-900">내 Niche / Comet (Free)</h3>
              <p className="text-sm text-emerald-800">Use web-refreshed Custom Niche/Comet results via free read endpoints.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setIncludeInactiveComets((prev) => !prev)}
                className={`${includeInactiveComets ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'} rounded-lg border px-3 py-2 text-xs`}
              >
                Paused 포함 {includeInactiveComets ? 'ON' : 'OFF'}
              </button>
              <button type="button" className={btnGhost} onClick={loadInitialFreeData} disabled={loading.initial}>
                {loading.initial ? 'Refreshing...' : 'Refresh Free Data'}
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[1.2fr_1fr_1fr]">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="font-semibold text-slate-900">Comet List</h4>
                <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">GET /v1/comet Free</span>
              </div>
              <select value={selectedCometId} onChange={(e) => setSelectedCometId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" disabled={comets.length === 0}>
                {comets.length === 0 ? <option value="">No Comet Found</option> : comets.map((comet) => <option key={comet.id} value={comet.id}>{comet.name} ({normalizeCometStatus(comet.status)})</option>)}
              </select>
              {selectedCometId ? <p className="mt-2 text-xs text-slate-500">Selected ID: {selectedCometId}</p> : null}
              {comets.length > 0 ? (
                <div className="mt-3 max-h-44 space-y-2 overflow-auto">
                  {comets.slice(0, 10).map((comet) => (
                    <button
                      key={`meta-${comet.id}`}
                      type="button"
                      onClick={() => setSelectedCometId(comet.id)}
                      className={`w-full rounded-lg border p-2 text-left text-xs ${comet.id === selectedCometId ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold">{comet.name}</p>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cometStatusBadgeClass(normalizeCometStatus(comet.status))}`}>
                          {normalizeCometStatus(comet.status)}
                        </span>
                      </div>
                      <p className={comet.id === selectedCometId ? 'text-slate-200' : 'text-slate-500'}>id: {comet.id}</p>
                      <p className={comet.id === selectedCometId ? 'text-slate-200' : 'text-slate-500'}>status: {normalizeCometStatus(comet.status)}</p>
                      <p className={comet.id === selectedCometId ? 'text-slate-200' : 'text-slate-500'}>last_run: {comet.lastRun || comet.updatedAt || '-'}</p>
                      <p className={comet.id === selectedCometId ? 'text-slate-200' : 'text-slate-500'}>videos: {comet.videosCount || 0} / views: {compactNumber(comet.totalViews || 0)}</p>
                      <p className={`line-clamp-2 ${comet.id === selectedCometId ? 'text-slate-300' : 'text-slate-500'}`}>platforms: {(comet.platforms || []).join(', ') || '-'}</p>
                      <p className={`line-clamp-2 ${comet.id === selectedCometId ? 'text-slate-300' : 'text-slate-500'}`}>keywords: {(comet.keywords || []).join(', ') || '-'}</p>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">Comets</p><p className="text-2xl font-semibold text-slate-900">{comets.length}</p></div>
            <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">Comet Videos</p><p className="text-2xl font-semibold text-slate-900">{cometVideos.length}</p></div>
          </div>

          {selectedCometMeta ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
              <p className="font-semibold text-slate-900">Comet Metadata</p>
              <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                <p><span className="text-slate-500">Name:</span> {safeText(selectedCometMeta?.name || selectedCometMeta?.title) || '-'}</p>
                <p><span className="text-slate-500">Status:</span> {selectedCometStatus}</p>
                <p><span className="text-slate-500">Updated:</span> {prettyDate(safeText(selectedCometMeta?.updated_at || selectedCometMeta?.last_run))}</p>
                <p className="md:col-span-2 xl:col-span-3"><span className="text-slate-500">Keywords:</span> {Array.isArray(selectedCometMeta?.keywords) ? selectedCometMeta.keywords.join(', ') : safeText(selectedCometMeta?.keywords || '-')}</p>
              </div>
            </div>
          ) : null}

          {selectedCometId && (selectedCometStatus === 'paused' || selectedCometStatus === 'inactive') ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              웹에서 Resume해야 새 데이터가 갱신됩니다. 기존 수집 영상은 조회 가능합니다.
            </div>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'orbit-read' ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="text-xl font-semibold text-emerald-900">기존 Orbit 조회 (Free)</h3>
          <p className="text-sm text-emerald-800">Read existing orbit result using orbit id. No new job is created.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input value={orbitLookupId} onChange={(e) => setOrbitLookupId(e.target.value)} placeholder="Existing orbit id" className="min-w-[260px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
            <button type="button" onClick={lookupOrbitVideos} className={btnPrimary} disabled={loading.orbitVideos}>{loading.orbitVideos ? 'Loading...' : 'Load Orbit Videos'}</button>
            <span className="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-2 text-xs text-emerald-700">GET /v1/orbit/:id/videos Free</span>
          </div>
        </section>
      ) : null}

      {activeTab === 'tracking' ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="text-xl font-semibold text-emerald-900">Tracking (Free)</h3>
          <p className="text-sm text-emerald-800">GET /v1/tracking/creators and GET /v1/tracking/videos.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">Tracking Videos</p><p className="text-2xl font-semibold text-slate-900">{trackingVideos.length}</p></div>
            <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">Tracking Creators</p><p className="text-2xl font-semibold text-slate-900">{trackingCreators.length}</p></div>
          </div>
        </section>
      ) : null}

      {activeTab === 'saved' ? (
        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-xl font-semibold text-slate-900">저장 후보</h3>
          <p className="text-sm text-slate-600">Candidates persisted in server/data/candidates.json</p>
        </section>
      ) : null}

      {activeTab === 'orbit-create' ? (
        <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div>
            <h3 className="text-xl font-semibold text-amber-900">고급 검색 / 새 Orbit 생성</h3>
            <p className="text-sm text-amber-800">POST /v1/orbit costs $0.50. Use only when existing Comet results are insufficient.</p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="mb-2 text-sm font-semibold text-slate-900">New Orbit Search ($0.50)</p>
              <button type="button" onClick={runOrbitSearch} disabled={loading.orbitCreate || isActiveSearchStatus(status)} className={`${btnPrimary} ${loading.orbitCreate || isActiveSearchStatus(status) ? 'cursor-not-allowed bg-slate-400 hover:bg-slate-400' : ''}`}>
                {loading.orbitCreate || isActiveSearchStatus(status) ? 'Search in progress...' : 'Search Orbit ($0.50)'}
              </button>
              {orbitId ? <p className="mt-2 text-xs text-slate-500">Last orbit id: {orbitId}</p> : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="mb-2 text-sm font-semibold text-slate-900">Paid Endpoints (manual only)</p>
              <div className="flex flex-wrap gap-2">
                {PAID_CALLS.map((item) => (
                  <button key={item.key} type="button" className={btnGhost} onClick={() => callPaidEndpoint(item)} disabled={loading.paid}>
                    {item.label} {item.price}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold text-slate-900">Most Viral Videos</h2>
              <span className="text-sm text-slate-500">{mostViralVideos.length} items</span>
            </div>

            <div className="mt-3 grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {mostViralVideos.map((video) => {
                const viewMeta = getViewScaleMeta(video.views);
                const ageMeta = getAgeScaleMeta(video.publishedAt);
                return (
                  <article
                    key={`${video.id}-${video.url || video.publishedAt}`}
                    className="overflow-hidden rounded-xl border-2 bg-white hover:shadow-md"
                    style={viewMeta.borderStyle}
                  >
                    <button type="button" onClick={() => setDetailVideo(video)} className="w-full text-left">
                      <div className="relative aspect-[9/16] w-full bg-slate-100">
                        {video.thumbnail ? <img src={video.thumbnail} alt={video.title || 'video'} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-slate-400">썸네일 없음</div>}
                        <div className="absolute left-2 top-2 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white">{PLATFORM_LABEL[video.platform] || video.platform || '알 수 없음'}</div>
                        <div className="absolute right-2 top-2 rounded-md px-2 py-1 text-[11px] font-bold" style={viewMeta.badgeStyle}>{viewMeta.label}</div>
                        {ageMeta ? <div className={`absolute left-2 top-9 rounded-md border px-2 py-1 font-bold ${ageMeta.className}`}>{ageMeta.label}</div> : null}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-2 text-[11px] text-white">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold">조회 {compactNumber(video.views)}</span>
                            <span>좋아요 {compactNumber(video.likes)}</span>
                            <span>댓글 {compactNumber(video.comments)}</span>
                          </div>
                          {video.durationSec ? <div className="mt-0.5 flex items-center gap-2"><span>{Math.round(video.durationSec)}초</span>{video.viewsPerHour ? <span>{compactNumber(Math.round(video.viewsPerHour))}/h</span> : null}</div> : null}
                        </div>
                      </div>
                    </button>

                    <div className="space-y-2 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold" style={viewMeta.textStyle}>조회수 단계 {viewMeta.label}</p>
                        {ageMeta ? <p className={`rounded-full border px-2 py-0.5 font-bold ${ageMeta.className}`}>{ageMeta.label}</p> : null}
                      </div>
                      <p className="line-clamp-2 text-sm font-semibold text-slate-900">{video.title || video.description || '제목 없음'}</p>
                      <p className="text-xs text-slate-600">{video.creator || '-'} {video.handle ? `(${video.handle})` : ''}</p>
                      <p className="text-xs text-slate-500">{prettyDate(video.publishedAt)}</p>
                      <div className="flex flex-wrap gap-1">{(video.hashtags || []).slice(0, 3).map((tag) => (<span key={`${video.id}-${tag}`} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{tag}</span>))}</div>
                      <div className="grid grid-cols-3 gap-1 text-xs">
                        <button type="button" disabled={!video.url} onClick={() => video.url && window.open(video.url, '_blank', 'noopener,noreferrer')} className={`${btnGhost} rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40`}>원본 열기</button>
                        <button type="button" onClick={() => (isSavedVideo(video) ? removeCandidate(video) : saveCandidate(video))} className={`rounded-md px-2 py-1 text-xs ${isSavedVideo(video) ? btnDanger : btnGhost}`}>{isSavedVideo(video) ? '저장 해제' : '후보 저장'}</button>
                        <button type="button" onClick={() => addVideoUrlToBatchDraft(video)} className={`${btnPrimary} rounded-md px-2 py-1 text-xs`}>URL 담기</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {mostViralVideos.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                {emptyWarnings.map((line) => <p key={line}>- {line}</p>)}
                {selectedSourceDebug.candidates?.length ? (
                  <div className="mt-2 text-xs text-slate-500">
                    <p>Detected array candidates:</p>
                    {selectedSourceDebug.candidates.map((item) => <p key={`${item.path}-${item.count}`}>{item.path}: {item.count}</p>)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">전체 영상</h2>
              <span className="text-xs text-slate-500">{filteredVideos.length}개</span>
              <input value={videoQuery} onChange={(e) => setVideoQuery(e.target.value)} placeholder="제목/설명/크리에이터/해시태그 검색" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs sm:ml-auto sm:min-w-[220px] sm:w-auto" />
              <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs sm:w-auto"><option value="all">전체 플랫폼</option><option value="youtube">YouTube</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></select>
              <select value={sortMode} onChange={(e) => setSortMode(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs sm:w-auto"><option value="most_views">조회수순</option><option value="virality">바이럴 점수순</option><option value="most_recent">최신순</option></select>
              <button type="button" onClick={() => setSavedOnly((prev) => !prev)} className={`w-full rounded-lg border px-3 py-2 text-xs sm:w-auto ${savedOnly ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 text-slate-600'}`}>저장 후보만</button>
            </div>

            <div className="mt-3 hidden overflow-x-auto md:block">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr><th className="px-3 py-2 text-left">영상</th><th className="px-3 py-2 text-left">크리에이터</th><th className="px-3 py-2 text-right">조회수</th><th className="px-3 py-2 text-right">좋아요</th><th className="px-3 py-2 text-right">댓글</th><th className="px-3 py-2 text-center">플랫폼</th><th className="px-3 py-2 text-center">바이럴</th><th className="px-3 py-2 text-right">작업</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredVideos.slice(0, 120).map((video) => (
                    <tr key={`row-${video.id}-${video.url || video.publishedAt}`} className="hover:bg-slate-50">
                      <td className="px-3 py-2"><button type="button" className="max-w-[360px] text-left" onClick={() => setDetailVideo(video)}><p className="line-clamp-1 font-medium text-slate-900">{video.title || video.description || '제목 없음'}</p><p className="line-clamp-1 text-xs text-slate-500">{video.description || '-'}</p></button></td>
                      <td className="px-3 py-2 text-slate-700">{video.creator || '-'} {video.handle ? `(${video.handle})` : ''}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{compactNumber(video.views)}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{compactNumber(video.likes)}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{compactNumber(video.comments)}</td>
                      <td className="px-3 py-2 text-center text-slate-700">{PLATFORM_LABEL[video.platform] || '-'}</td>
                      <td className="px-3 py-2 text-center text-slate-700">{safeNum(video.viralityScore)}</td>
                      <td className="px-3 py-2"><div className="flex justify-end gap-1 text-xs"><button type="button" onClick={() => addVideoUrlToBatchDraft(video)} className={`${btnPrimary} rounded-md px-2 py-1 text-xs`}>URL 담기</button><button type="button" onClick={() => (isSavedVideo(video) ? removeCandidate(video) : saveCandidate(video))} className={`rounded-md px-2 py-1 text-xs ${isSavedVideo(video) ? btnDanger : btnGhost}`}>{isSavedVideo(video) ? '저장 해제' : '후보 저장'}</button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(activeTab === 'comet' || activeTab === 'orbit-create') ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-base font-semibold text-slate-900">인기 해시태그</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {hashtags.length === 0 ? <p className="text-sm text-slate-500">표시할 해시태그가 없습니다.</p> : hashtags.map((item) => (
                    <button key={item.tag} type="button" onClick={() => setKeywordsText((prev) => `${prev}\n${item.tag.replace(/^#/, '')}`.trim())} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100">
                      {item.tag} ({item.count})
                    </button>
                  ))}
                </div>
              </div>

              {activeTab === 'comet' ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-base font-semibold text-slate-900">아웃라이어 크리에이터</h3>
                    <div className="mt-2 space-y-2">
                      {cometOutliers.length === 0 ? <p className="text-sm text-slate-500">표시할 아웃라이어 크리에이터가 없습니다.</p> : cometOutliers.slice(0, 8).map((item) => (<div key={item.id} className="rounded-md border border-slate-200 p-2"><p className="text-sm font-medium text-slate-800">{item.creator} {item.handle ? `(${item.handle})` : ''}</p><p className="text-xs text-slate-500">팔로워 {compactNumber(item.followers)} / 평균 조회수 {compactNumber(item.avgViews)} / 점수 {item.score.toFixed(2)}</p></div>))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-base font-semibold text-slate-900">Trending Sounds</h3>
                    <div className="mt-2 space-y-2">
                      {cometSounds.length === 0 ? <p className="text-sm text-slate-500">No sounds data.</p> : cometSounds.slice(0, 8).map((item) => (<div key={item.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5"><span className="line-clamp-1 pr-2 text-sm text-slate-700">{item.title}</span><span className="text-xs text-slate-500">{item.platform || '-'} / {compactNumber(item.usage)}</span></div>))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <button type="button" onClick={() => setShowRaw((prev) => !prev)} className={btnGhost}>{showRaw ? '원본 응답 숨기기' : '원본 응답 보기'}</button>
            {showRaw ? <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{JSON.stringify(rawResponse, null, 2)}</pre> : null}
          </div>
        </div>

        <aside className="rounded-2xl border border-slate-200 bg-white p-4 xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)] xl:overflow-auto">
          <h3 className="text-xl font-semibold text-slate-900">영상 상세</h3>
          {detailVideo ? (
            <div className="mt-3 space-y-3">
              <div className="aspect-[9/16] overflow-hidden rounded-xl bg-slate-100">{detailVideo.thumbnail ? <img src={detailVideo.thumbnail} alt={detailVideo.title || 'video'} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-slate-400">썸네일 없음</div>}</div>
              <div><p className="text-sm font-semibold text-slate-900">{detailVideo.title || detailVideo.description || '제목 없음'}</p><p className="mt-1 text-xs text-slate-600">{detailVideo.creator || '-'} {detailVideo.handle ? `(${detailVideo.handle})` : ''}</p></div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-slate-50 p-2"><dt className="text-slate-500">플랫폼</dt><dd className="font-medium text-slate-800">{PLATFORM_LABEL[detailVideo.platform] || detailVideo.platform || '-'}</dd></div>
                <div className="rounded-md bg-slate-50 p-2"><dt className="text-slate-500">업로드일</dt><dd className="font-medium text-slate-800">{prettyDate(detailVideo.publishedAt)}</dd></div>
                <div className="rounded-md bg-slate-50 p-2"><dt className="text-slate-500">조회수</dt><dd className="font-medium text-slate-800">{compactNumber(detailVideo.views)}</dd></div>
                <div className="rounded-md bg-slate-50 p-2"><dt className="text-slate-500">바이럴</dt><dd className="font-medium text-slate-800">{safeNum(detailVideo.viralityScore)}</dd></div>
                <div className="rounded-md bg-slate-50 p-2"><dt className="text-slate-500">좋아요</dt><dd className="font-medium text-slate-800">{compactNumber(detailVideo.likes)}</dd></div>
                <div className="rounded-md bg-slate-50 p-2"><dt className="text-slate-500">댓글</dt><dd className="font-medium text-slate-800">{compactNumber(detailVideo.comments)}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-1">{(detailVideo.hashtags || []).map((tag) => <span key={`detail-${tag}`} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-700">{tag}</span>)}</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <button type="button" disabled={!detailVideo.url} onClick={() => detailVideo.url && window.open(detailVideo.url, '_blank', 'noopener,noreferrer')} className={`${btnGhost} px-2 py-2 text-xs disabled:opacity-40`}>원본 열기</button>
                <button type="button" onClick={() => (isSavedVideo(detailVideo) ? removeCandidate(detailVideo) : saveCandidate(detailVideo))} className={`px-2 py-2 text-xs ${isSavedVideo(detailVideo) ? btnDanger : btnGhost}`}>{isSavedVideo(detailVideo) ? '저장 해제' : '후보 저장'}</button>
                <button type="button" onClick={() => addVideoUrlToBatchDraft(detailVideo)} className={`${btnPrimary} px-2 py-2 text-xs`}>URL 담기</button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">영상 카드를 클릭하면 상세 정보가 여기에 표시됩니다.</p>
          )}

          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-semibold text-slate-700">Niche Summary</p>
            <p className="mt-1 text-slate-600">videos {summary.totalVideos} / views {compactNumber(summary.totalViews)} / avg {compactNumber(summary.averageViews)}</p>
            <p className="text-slate-600">creators {summary.creatorsCount} / hashtags {summary.hashtagsCount}</p>
            <p className="text-slate-600">period {summary.period || '-'} / preset {summary.preset || '-'}</p>
          </div>

          {Object.keys(paidResults).length > 0 ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <p className="font-semibold">Paid endpoint result cache</p>
              {Object.keys(paidResults).map((key) => <p key={key}>- {key}</p>)}
            </div>
          ) : null}
        </aside>
      </section>

      {loading.initial || loading.cometVideos || loading.orbitVideos ? <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">Loading...</div> : null}
      {notice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div> : null}
      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
    </div>
  );
}
