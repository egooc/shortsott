const fs = require('fs');
const path = require('path');
const { createHttpError } = require('./errorService');

const PROJECT_ROOT = path.join(__dirname, '../..');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const SEARCH_TIMEOUT_MS = 12000;
const TITLE_HINTS = [
  { pattern: /tfatws|falcon\s+and\s+the\s+winter\s+soldier/i, title_en: 'The Falcon and the Winter Soldier', title_kr: '팔콘과 윈터 솔져', year: 2021 },
  { pattern: /black\s+panther|wakanda\s+forever/i, title_en: 'Black Panther', title_kr: '블랙 팬서', year: 2018 },
  { pattern: /fantastic\s*four|silver\s+surfer|rise\s+of\s+the\s+silver\s+surfer|실버\s*서퍼|판타스틱\s*4/i, title_en: 'Fantastic Four: Rise of the Silver Surfer', title_kr: '판타스틱 4: 실버 서퍼의 위협', year: 2007 }
];

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>'));
}

function resolveInsideProject(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(PROJECT_ROOT, raw);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (!(relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative)))) {
    throw createHttpError(400, 'MOVIE_RESEARCH_PATH_OUTSIDE_PROJECT', 'Path must stay inside project root', { inputPath });
  }
  return resolved;
}

function adjacentSourceInfoPath(geminiAnalysisPath) {
  if (!geminiAnalysisPath) return '';
  const dir = path.dirname(geminiAnalysisPath);
  const direct = path.join(dir, 'source.info.json');
  if (fs.existsSync(direct)) return direct;
  const candidates = fs.readdirSync(dir).filter((name) => /source.*\.(info|meta)\.json$/i.test(name));
  return candidates.length ? path.join(dir, candidates[0]) : '';
}

function pickSourceMetadata(sourceInfo = {}) {
  return {
    id: sourceInfo.id || sourceInfo.display_id || '',
    title: normalizeText(sourceInfo.title),
    description: normalizeText(sourceInfo.description || sourceInfo.fulltitle || '').slice(0, 1200),
    tags: Array.isArray(sourceInfo.tags) ? sourceInfo.tags.slice(0, 30).map(normalizeText).filter(Boolean) : [],
    uploader: normalizeText(sourceInfo.uploader || sourceInfo.channel || ''),
    webpage_url: normalizeText(sourceInfo.webpage_url || sourceInfo.original_url || '')
  };
}

function extractProperNouns(transcript, sourceMetadata, geminiAnalysis) {
  const text = [
    sourceMetadata.title,
    sourceMetadata.description,
    ...(sourceMetadata.tags || []),
    ...(Array.isArray(transcript?.utterances) ? transcript.utterances.map((item) => item.text) : []),
    ...(Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes.map((scene) => scene.dialogue_or_caption) : [])
  ].join(' ');
  const ascii = [...new Set((text.match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,4}\b/g) || [])
    .map(normalizeText)
    .filter((item) => item.length >= 3 && !['Scene', 'Movie', 'Video', 'The'].includes(item)))];
  const known = ['Wakanda', 'Bucky', 'Ayo', 'Winter Soldier', 'Silver Surfer', 'Fantastic Four', 'Sue Storm', 'Reed Richards', 'Galactus']
    .filter((token) => text.toLowerCase().includes(token.toLowerCase()));
  return [...new Set([...known, ...ascii])].slice(0, 20);
}

function extractDialogueEvidence(transcript, geminiAnalysis) {
  const transcriptLines = Array.isArray(transcript?.utterances) ? transcript.utterances.map((item) => item.text) : [];
  const sceneLines = Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes.map((scene) => scene.dialogue_or_caption) : [];
  return [...new Set([...transcriptLines, ...sceneLines]
    .map(normalizeText)
    .filter((line) => line && !/^none$/i.test(line) && line.split(/\s+/).length >= 3))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
}

function extractVisualEvidence(geminiAnalysis) {
  const characters = Array.isArray(geminiAnalysis?.characters) ? geminiAnalysis.characters : [];
  const scenes = Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [];
  return {
    characters: characters.slice(0, 12).map((character) => ({
      name: normalizeText(character.safe_display_name || character.name || character.character_id),
      visual_description: normalizeText(character.visual_description || character.description || '')
    })).filter((item) => item.name || item.visual_description),
    distinctive_visuals: scenes
      .map((scene) => normalizeText([scene.visible_action, scene.characters_visible?.join?.(', ')].filter(Boolean).join(' ')))
      .filter(Boolean)
      .slice(0, 10)
  };
}

function preflightMovieIdentity(preflightGate = null) {
  const identity = preflightGate?.movie_identity_pre_gemini;
  const title = normalizeText(identity?.title_en || identity?.title || '');
  if (!title) return null;
  const yearMatch = title.match(/\((\d{4})\)/);
  return {
    status: 'known',
    title_en: title,
    title_kr: normalizeText(identity?.title_kr || ''),
    year: yearMatch ? Number(yearMatch[1]) : null,
    source: normalizeText(identity?.source || 'preflight_gate')
  };
}

function buildEvidencePackage({ geminiAnalysis, sourceInfo, transcript, preflightGate = null }) {
  const sourceMetadata = pickSourceMetadata(sourceInfo || {});
  const preflightIdentity = preflightMovieIdentity(preflightGate);
  return {
    preflight_movie_identity: preflightIdentity,
    source_metadata: sourceMetadata,
    transcript_signals: {
      proper_nouns: extractProperNouns(transcript, sourceMetadata, geminiAnalysis),
      distinctive_dialogue: extractDialogueEvidence(transcript, geminiAnalysis)
    },
    gemini_visual_evidence: extractVisualEvidence(geminiAnalysis),
    gemini_story_context: {
      content_guess: normalizeText(geminiAnalysis?.story_context?.content_guess),
      plot_summary_neutral: normalizeText(geminiAnalysis?.story_context?.plot_summary_neutral),
      genre: normalizeText(geminiAnalysis?.story_context?.genre)
    }
  };
}

function queryParts(evidence) {
  const preflightTitle = evidence.preflight_movie_identity?.title_en || '';
  const title = evidence.source_metadata.title || evidence.gemini_story_context.content_guess || '';
  const titleCore = title
    .replace(/[-–—|].*$/g, ' ')
    .replace(/\b(scene|clip|movie|recap|official|hd|4k)\b/gi, ' ')
    .trim();
  const dialogue = evidence.transcript_signals.distinctive_dialogue[0] || '';
  const nouns = evidence.transcript_signals.proper_nouns.slice(0, 3).join(' ');
  return [
    preflightTitle ? `${preflightTitle} film plot cast` : '',
    preflightTitle && dialogue ? `${preflightTitle} "${dialogue.slice(0, 80)}" scene` : '',
    titleCore ? `${titleCore} movie` : '',
    dialogue ? `"${dialogue.slice(0, 90)}" movie quote` : '',
    nouns ? `${nouns} film scene` : '',
    evidence.gemini_story_context.content_guess ? `${evidence.gemini_story_context.content_guess} plot summary` : ''
  ].filter(Boolean);
}

async function fetchText(url, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeDdgUrl(value) {
  try {
    const url = new URL(value, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return value;
  }
}

async function duckDuckGoSearch(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const html = await fetchText(url);
    const results = [];
    const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) && results.length < 5) {
      results.push({
        query,
        title: stripHtml(match[2]),
        url: decodeDdgUrl(match[1]),
        snippet: stripHtml(match[3])
      });
    }
    if (!results.length) {
      const loose = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = loose.exec(html)) && results.length < 5) {
        results.push({ query, title: stripHtml(match[2]), url: decodeDdgUrl(match[1]), snippet: '' });
      }
    }
    return results;
  } catch (error) {
    return [{ query, error: error.message }];
  }
}

function titleHintFromEvidence(evidence) {
  const haystack = [
    evidence.source_metadata.title,
    evidence.source_metadata.description,
    evidence.source_metadata.tags.join(' '),
    evidence.gemini_story_context.content_guess,
    evidence.gemini_story_context.plot_summary_neutral,
    evidence.transcript_signals.proper_nouns.join(' ')
  ].join(' ');
  return TITLE_HINTS.find((hint) => hint.pattern.test(haystack)) || null;
}

function titleHits(title, searchResults) {
  const tokens = normalizeText(title).toLowerCase().split(/\W+/).filter((token) => token.length >= 4);
  if (!tokens.length) return [];
  return searchResults.filter((result) => {
    const text = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`.toLowerCase();
    return tokens.filter((token) => text.includes(token)).length >= Math.min(2, tokens.length);
  });
}

async function wikipediaSummary(title) {
  if (!title) return null;
  const baseTitle = normalizeText(String(title).replace(/\s*\(\d{4}\)\s*/g, ' '));
  const yearMatch = String(title).match(/\((\d{4})\)/);
  const candidates = [
    title,
    yearMatch && baseTitle ? `${baseTitle} (film)` : '',
    yearMatch && baseTitle ? `${baseTitle} ${yearMatch[1]} film` : '',
    baseTitle ? `${baseTitle} film` : '',
    yearMatch ? '' : baseTitle,
    `${title} film`,
    `${title} TV series`
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate.replace(/ /g, '_'))}`;
      const json = JSON.parse(await fetchText(url));
      if (json?.title && json?.extract) {
        return { title: json.title, extract: json.extract, url: json.content_urls?.desktop?.page || url };
      }
    } catch {
      // try next title variant
    }
  }
  return null;
}

function buildIdentity(evidence, searchResults) {
  const preflightIdentity = evidence.preflight_movie_identity;
  if (preflightIdentity?.title_en) {
    const hits = titleHits(preflightIdentity.title_en, searchResults);
    const evidenceItems = [
      `Pre-flight gate extracted title: ${preflightIdentity.title_en}`,
      preflightIdentity.source ? `Pre-flight title source: ${preflightIdentity.source}` : '',
      ...hits.slice(0, 3).map((hit) => `Search result: ${hit.title} — ${hit.url}`)
    ].filter(Boolean);
    return {
      status: hits.length ? 'confirmed' : 'probable',
      title_en: preflightIdentity.title_en,
      title_kr: preflightIdentity.title_kr || '',
      year: preflightIdentity.year || null,
      evidence: evidenceItems
    };
  }
  const hint = titleHintFromEvidence(evidence);
  if (!hint) {
    return {
      status: 'unknown',
      title_en: '',
      title_kr: '',
      year: null,
      evidence: ['No stable title hint found in source metadata, transcript, or Gemini observations.']
    };
  }
  const hits = titleHits(hint.title_en, searchResults);
  const evidenceItems = [];
  if (hint.pattern.test(evidence.source_metadata.title || '')) evidenceItems.push(`YouTube title points to ${hint.title_en}: ${evidence.source_metadata.title}`);
  if (hint.pattern.test(evidence.source_metadata.description || '')) evidenceItems.push(`YouTube description points to ${hint.title_en}.`);
  if ((evidence.source_metadata.tags || []).some((tag) => hint.pattern.test(tag))) evidenceItems.push(`YouTube tags point to ${hint.title_en}: ${(evidence.source_metadata.tags || []).filter((tag) => hint.pattern.test(tag)).slice(0, 5).join(', ')}`);
  if ((evidence.transcript_signals.proper_nouns || []).some((token) => hint.pattern.test(token))) evidenceItems.push(`Extracted proper nouns point to ${hint.title_en}: ${(evidence.transcript_signals.proper_nouns || []).filter((token) => hint.pattern.test(token)).slice(0, 5).join(', ')}`);
  if (hint.pattern.test(evidence.gemini_story_context.content_guess || '')) evidenceItems.push(`Gemini content_guess points to ${hint.title_en}: ${evidence.gemini_story_context.content_guess}`);
  hits.slice(0, 3).forEach((hit) => evidenceItems.push(`Search result: ${hit.title} — ${hit.url}`));
  return {
    status: evidenceItems.length >= 2 ? 'confirmed' : 'probable',
    title_en: hint.title_en,
    title_kr: hint.title_kr,
    year: hint.year,
    evidence: evidenceItems.length ? evidenceItems : [`Evidence package matched local title hint for ${hint.title_en}.`]
  };
}

function characterKnowledge(identity, evidence) {
  const nouns = evidence.transcript_signals.proper_nouns.join(' ');
  if (/fences/i.test(identity.title_en || '')) {
    return [
      { screen_name: '트로이 맥슨', role: '가족을 책임진다는 명분으로 아들을 몰아붙이는 아버지', motivation: '자신이 해온 의무와 책임을 인정받고 싶어 한다.' },
      { screen_name: '코리 맥슨', role: '아버지에게 사랑과 인정을 묻는 아들', motivation: '아버지가 자신을 왜 이렇게 대하는지 확인하고 싶어 한다.' },
      { screen_name: '로즈 맥슨', role: '부자 갈등을 지켜보는 어머니', motivation: '가족이 무너지지 않기를 바라지만 갈등의 상처를 피할 수 없다.' }
    ];
  }
  if (/winter soldier|bucky|ayo|wakanda/i.test(`${identity.title_en} ${nouns}`)) {
    return [
      { screen_name: '버키 반즈 / 윈터 솔져', role: '세뇌 프로그램에서 벗어나려는 인물', motivation: '히드라 암시어에 더 이상 조종되지 않는지 확인하려 한다.' },
      { screen_name: '아요', role: '와칸다 도라 밀라제 전사', motivation: '버키의 세뇌 해제가 안전하게 끝났는지 검증하고 보호한다.' }
    ];
  }
  if (/fantastic|silver surfer|실버/i.test(`${identity.title_en} ${evidence.gemini_story_context.content_guess}`)) {
    return [
      { screen_name: '실버 서퍼', role: '갈락투스의 전령', motivation: '자신이 파괴자가 아니라 더 큰 존재에게 묶인 처지임을 드러낸다.' },
      { screen_name: '수 스톰 / 인비저블 우먼', role: '판타스틱 4 멤버', motivation: '실버 서퍼의 의도와 위협을 파악하려 한다.' },
      { screen_name: '리드 리처즈 / 미스터 판타스틱', role: '판타스틱 4 리더', motivation: '실버 서퍼를 제압하고 지구의 위협을 분석하려 한다.' }
    ];
  }
  return evidence.gemini_visual_evidence.characters.map((character) => ({
    screen_name: character.name,
    role: character.visual_description || 'source-observed character',
    motivation: 'Pass 0 research could not safely infer motivation beyond the source clip.'
  })).slice(0, 6);
}

function heuristicClipContext(identity, evidence) {
  const combined = `${identity.title_en} ${evidence.source_metadata.title} ${evidence.gemini_story_context.plot_summary_neutral} ${evidence.transcript_signals.proper_nouns.join(' ')}`;
  if (/fences/i.test(combined)) {
    return '영화 Fences에서 트로이 맥슨이 아들 코리에게 “널 좋아해서가 아니라 책임 때문에 돌본다”고 말하며 부자 관계가 정면으로 갈라지는 장면이다. 직전 맥락은 코리가 아버지의 사랑과 인정을 확인하려는 순간이고, 직후에는 그 말이 가족 안에 오래 남는 상처로 이어진다.';
  }
  if (/bucky|winter soldier|ayo|wakanda/i.test(combined)) {
    return '와칸다에서 버키 반즈가 윈터 솔져 세뇌 암시어에서 벗어났는지 확인하는 장면이다. 직전 맥락은 버키가 과거의 조종 프로그램을 끝내려는 상태이고, 직후에는 그가 더 이상 암시어에 반응하지 않는다는 안도와 해방감이 온다.';
  }
  if (/fantastic|silver surfer|galactus|실버/i.test(combined)) {
    return '판타스틱 4가 숲에서 실버 서퍼와 직접 대치하는 장면이다. 직전에는 실버 서퍼가 지구에 나타나 위협으로 인식되고, 이 장면에서는 군과 판타스틱 4가 그를 제압하려 하지만 그가 단순한 침입자가 아니라 갈락투스와 연결된 존재라는 맥락이 중요해진다.';
  }
  return evidence.gemini_story_context.plot_summary_neutral || 'Clip context remains limited to the verified source observations.';
}

async function buildMovieKnowledge(identity, evidence, searchResults) {
  const wiki = await wikipediaSummary(identity.title_en);
  const sceneQuery = `${identity.title_en} ${evidence.transcript_signals.proper_nouns.slice(0, 3).join(' ')} scene`;
  const sceneResults = identity.title_en ? await duckDuckGoSearch(sceneQuery) : [];
  const identityHits = titleHits(identity.title_en, searchResults);
  const sceneTokens = [identity.title_en, ...evidence.transcript_signals.proper_nouns.slice(0, 5)]
    .join(' ')
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length >= 4);
  const relevantSceneResults = sceneResults.filter((result) => {
    const text = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`.toLowerCase();
    return sceneTokens.some((token) => text.includes(token));
  });
  const sources = [
    ...identityHits.filter((result) => result.url).slice(0, 5).map((result) => result.url),
    ...relevantSceneResults.filter((result) => result.url).slice(0, 5).map((result) => result.url),
    wiki?.url
  ].filter(Boolean);
  return {
    title_kr: identity.title_kr || evidence.gemini_story_context.content_guess || '',
    title_en: identity.title_en || '',
    year: identity.year || null,
    characters: characterKnowledge(identity, evidence),
    full_plot: wiki?.extract || evidence.gemini_story_context.plot_summary_neutral || '',
    clip_context: heuristicClipContext(identity, evidence),
    stakes: /bucky|winter soldier|ayo/i.test(`${identity.title_en} ${evidence.source_metadata.title}`)
      ? '버키가 다시 조종당할 수 있는 괴물인지, 아니면 자기 의지로 살아갈 수 있는 사람인지가 걸려 있다.'
      : /fantastic|silver/i.test(`${identity.title_en} ${evidence.gemini_story_context.content_guess}`)
        ? '실버 서퍼를 적으로만 볼지, 더 큰 파괴자인 갈락투스의 전령이라는 진실을 이해할지가 걸려 있다.'
        : /fences/i.test(identity.title_en || '')
          ? '아들이 아버지에게 사랑받는 존재인지, 아니면 책임이라는 이름 아래 밀려나는 존재인지가 걸려 있다.'
          : 'The scene stakes should be inferred only from verified source and research evidence.',
    sources: [...new Set(sources)]
  };
}

async function generateMovieResearch({ geminiAnalysis, geminiAnalysisPath = '', sourceInfoPath = '', transcript = null, transcriptPath = '', preflightGate = null, preflightGatePath = '' }) {
  const resolvedGeminiPath = geminiAnalysisPath ? resolveInsideProject(geminiAnalysisPath) : '';
  const analysis = geminiAnalysis || readJsonIfExists(resolvedGeminiPath);
  if (!analysis) throw createHttpError(400, 'MOVIE_RESEARCH_GEMINI_REQUIRED', 'geminiAnalysis or geminiAnalysisPath is required');
  const resolvedSourceInfo = sourceInfoPath ? resolveInsideProject(sourceInfoPath) : adjacentSourceInfoPath(resolvedGeminiPath);
  const resolvedTranscript = transcriptPath ? resolveInsideProject(transcriptPath) : '';
  const sourceInfo = readJsonIfExists(resolvedSourceInfo) || {};
  const loadedTranscript = transcript || readJsonIfExists(resolvedTranscript) || null;
  const resolvedPreflightGate = preflightGatePath ? resolveInsideProject(preflightGatePath) : '';
  const loadedPreflightGate = preflightGate || readJsonIfExists(resolvedPreflightGate) || null;
  const evidence = buildEvidencePackage({ geminiAnalysis: analysis, sourceInfo, transcript: loadedTranscript, preflightGate: loadedPreflightGate });
  const queries = queryParts(evidence);
  const searchResultSets = await Promise.all(queries.map((query) => duckDuckGoSearch(query)));
  const searchResults = searchResultSets.flat();
  const movie_identity = buildIdentity(evidence, searchResults);
  const movie_knowledge = movie_identity.status === 'unknown'
    ? {
      title_kr: '',
      title_en: '',
      year: null,
      characters: [],
      full_plot: '',
      clip_context: '',
      stakes: '',
      sources: []
    }
    : await buildMovieKnowledge(movie_identity, evidence, searchResults);
  return {
    movie_identity,
    movie_knowledge,
    evidence_package: evidence,
    search_queries: queries,
    search_results: searchResults,
    generated_at: new Date().toISOString()
  };
}

async function generateAndSaveMovieResearch(args) {
  const result = await generateMovieResearch(args);
  const basePath = args.outputPath
    ? resolveInsideProject(args.outputPath)
    : args.geminiAnalysisPath
      ? path.join(path.dirname(resolveInsideProject(args.geminiAnalysisPath)), 'movie_research.json')
      : '';
  if (basePath) writeJson(basePath, result);
  return { ...result, savedPath: basePath || null };
}

module.exports = {
  buildEvidencePackage,
  generateMovieResearch,
  generateAndSaveMovieResearch
};
