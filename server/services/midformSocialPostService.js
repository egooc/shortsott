// Per-platform publish packages (owner directive 2026-08-11): each channel gets its OWN
// title/caption/hashtags written to social_posts.<locale>.txt alongside the draft - no
// cross-posting, so the hook must ride whatever field that platform actually surfaces
// (YouTube: the title; TikTok/IG/FB: the caption's first line before the fold; Threads:
// the text itself; Naver Clip: title + tags).
const fs = require('fs');
const path = require('path');
const { generateVertexJson } = require('./geminiMidformService');

const SPEC_PATH = path.join(__dirname, '..', '..', 'midform', 'config', 'platform_post_specs.json');

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function truncateAt(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
}

function cleanCaption(text) {
  // The model tends to indent continuation lines and to inline the hashtag block inside the
  // caption even though tags are listed separately - the .txt is a paste-ready package, so
  // the caption must be clean body text only.
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s+/, ''))
    .filter((line) => !/^(#[^\s#]+)(\s+#[^\s#]+)*$/.test(line.trim()) || line.trim() === '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeHashtags(tags, spec) {
  const seen = new Set();
  const cleaned = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    let value = String(tag || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(`#${value}`);
    if (cleaned.length >= (spec.hashtags?.max ?? 5)) break;
  }
  return cleaned;
}

function collectSourceFacts({ compressionRunDir, workspaceDir, locale }) {
  const bootstrap = readJsonSafe(path.join(compressionRunDir || '', 'bootstrap_script.json')) || {};
  const baseTitleBlock = bootstrap.title_block || {};
  const baseCandidates = (bootstrap.metadata || {}).title_candidates || [];
  const fillsFile = locale === 'ja' ? 'compression_slot_fills.ja.json' : 'compression_slot_fills.json';
  const fills = readJsonSafe(path.join(compressionRunDir || '', fillsFile)) || {};
  // The locale fills carry locale-NATIVE upload text (ja title candidates, ja overlay, the
  // local release title in the description) - always prefer it over the ko bootstrap block.
  const uploadText = fills.upload_text || {};
  const candidates = (uploadText.title_candidates || []).length ? uploadText.title_candidates : baseCandidates;
  const overlay = uploadText.overlay_title || baseTitleBlock.overlay_title || {};
  const description = String(uploadText.description || '');
  const releaseTitleMatch = description.match(/『([^』]+)』/);
  // What SHIPS is the manifest, not the fills: ghost narrations on inactive slots (an action
  // beat's unused fill still said "invisible enemy") poisoned the caption facts.
  const manifest = readJsonSafe(path.join(workspaceDir || '', `draft_${locale}`, 'edit_manifest.json')) || {};
  const quotes = [];
  const narrations = [];
  const seenRows = new Set();
  for (const segment of manifest.segments || []) {
    const rowKey = `${segment.segment_id}|${segment.caption_id || ''}`;
    if (seenRows.has(rowKey)) continue;
    seenRows.add(rowKey);
    const text = String(segment.caption_text || '').trim();
    if (!text) continue;
    if (['dialogue_quote', 'dialogue'].includes(String(segment.segment_type || ''))) quotes.push(text);
    else if (String(segment.segment_type || '') === 'recap') narrations.push(text);
  }
  const sourceInfo = readJsonSafe(path.join(compressionRunDir || '', 'source_info.json')) || {};
  const normalized = readJsonSafe(path.join(workspaceDir || '', 'normalized_request.json')) || {};
  const prohibitions = ((normalized.editorial || {}).prohibitions || []).map(String);
  const spoilerBoundary = String((normalized.editorial || {}).spoiler_boundary || '');
  return {
    prohibitions,
    spoilerBoundary,
    fullTitle: String(candidates[0] || baseTitleBlock.full_title || ''),
    overlayTop: String(overlay.top || ''),
    overlayBottom: String(overlay.bottom || ''),
    titleCandidates: candidates.map(String),
    releaseTitle: releaseTitleMatch ? releaseTitleMatch[1] : '',
    quotes: quotes.slice(0, 10),
    narrations: narrations.slice(0, 10),
    sourceTitle: String(sourceInfo.title || '')
  };
}

function buildPrompt({ locale, facts, specDoc, platformIds }) {
  const langName = locale === 'ja' ? 'Japanese' : 'Korean';
  const specLines = platformIds.map((id) => {
    const spec = specDoc.platforms[id];
    return `- ${id} (${spec.label}): has_title=${spec.has_title}${spec.has_title ? ` title_max=${spec.title_max} hook_zone=${spec.title_hook_zone}` : ''}, caption_max=${spec.caption_max}${spec.fold_chars ? `, first ${spec.fold_chars} chars visible before the fold` : ''}, hashtags ${spec.hashtags.min}-${spec.hashtags.max}, hook_carrier=${spec.hook_carrier}. ${spec.notes}`;
  }).join('\n');
  return [
    `You are writing PUBLISH PACKAGES for a movie-recap short video, one package per platform, all in natural ${langName} (native platform tone, never translated-sounding).`,
    locale === 'ja'
      ? 'CRITICAL: every title, caption and hashtag MUST be written in Japanese (日本語). The source facts below are partly Korean - translate their MEANING into native Japanese; outputting Korean text is a hard failure. Hashtags in Japanese or English only.'
      : '',
    '',
    'Source facts (use ONLY these - never invent plot facts beyond them; do NOT import outside film knowledge, e.g. if the facts never call the monster invisible, it is NOT invisible in this clip):',
    `- Working title (hook-pattern engineered): ${facts.fullTitle}`,
    `- Alternate title candidates: ${facts.titleCandidates.join(' / ')}`,
    `- On-screen overlay pair: "${facts.overlayTop}" / "${facts.overlayBottom}"`,
    `- Key quoted lines from the clip: ${facts.quotes.join(' | ')}`,
    `- Narration lines (the recap's own sentences): ${facts.narrations.join(' | ')}`,
    facts.sourceTitle ? `- Source video: ${facts.sourceTitle}` : '',
    facts.releaseTitle ? `- Film title in this locale (USE THIS for the film hashtag): ${facts.releaseTitle}` : '',
    '',
    facts.prohibitions?.length ? 'Editorial prohibitions (they bind captions exactly as they bind the video itself):' : '',
    ...(facts.prohibitions || []).map((rule) => `- ${rule}`),
    facts.spoilerBoundary ? `- Spoiler boundary: ${facts.spoilerBoundary}` : '',
    '- Attribute qualities ONLY stated in the facts: if the facts never call something invisible, hidden, or unseen, it is not - film trivia you know from elsewhere does not apply to this clip.',
    '',
    'Platform specs (hard limits - obey exactly):',
    specLines,
    '',
    'Rules:',
    '- hook_carrier=title: pour the hook into the title; front-load the strongest words inside the hook zone. Caption supports search.',
    '- hook_carrier=caption_first_line: the FIRST LINE alone must hook (it is all that shows before the fold); then one context line; blank line; hashtags at the end.',
    '- hook_carrier=text (Threads): one or two conversation-starting sentences (question or hot-take angle), max one topic tag inline or none.',
    '- Captions NEVER retell the plot beat-by-beat: after the hook line, at most TWO short context sentences, then stop. Long plot summaries are a failure.',
    '- Do not spoil the payoff or the outcome: never reveal who survives, what the final answer was, or what happens at the end, and NEVER quote or paraphrase the closing narration lines. Tease, do not resolve.',
    '- The titles are built on an INFO GAP (e.g. "the answer she gave..."): captions must preserve that gap. You may quote a SETUP line (the demand), but NEVER the line that answers it - quoting the answer collapses the whole hook.',
    '- Hashtags: include the film title tag (from the source video line) plus genre/discovery tags natural to that platform and language. Respect min/max counts.',
    '- Put hashtags ONLY in the hashtags array, never inside the caption text. No indentation in captions.',
    '- No emoji spam: at most 1-2 emoji where the platform culture expects it (TikTok/IG ok, YouTube title none).',
    '',
    'Also return "film_title_local": the film\'s release title in this locale\'s language (for the info tag and film hashtag).',
    'Actor/franchise name hashtags ARE allowed (discovery metadata, not plot claims) - e.g. the lead actors\' names in this locale\'s spelling - but never let film trivia leak into caption TEXT.',
    'Return JSON: {"film_title_local":"<string>","posts":[{"platform":"<id>","title":"<string or empty>","caption":"<string>","hashtags":["#..."]}]} with one entry per platform id in this exact order: ' + platformIds.join(', ')
  ].filter(Boolean).join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    film_title_local: { type: 'string' },
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          title: { type: 'string' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } }
        },
        required: ['platform', 'caption', 'hashtags']
      }
    }
  },
  required: ['posts']
};

function formatLength(totalSec) {
  if (!(totalSec > 0)) return '—';
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec - minutes * 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderTxt({ locale, specDoc, platformIds, posts, facts, videoMeta, filmTitleLocal }) {
  const guide = (specDoc.upload_guide || {})[locale] || {};
  const bar = '='.repeat(46);
  const lines = [];
  lines.push(`# ${locale.toUpperCase()} 발행 패키지 — ${facts.fullTitle}`);
  lines.push(`# 생성 규칙: 크로스포스트 없음, 플랫폼별 개별 작성. 길이는 코드로 검증됨.`);
  lines.push('');
  lines.push(bar);
  lines.push('[영상 드래프트]');
  lines.push(bar);
  lines.push(`FILE       : ${videoMeta.fileName}`);
  lines.push(`LENGTH     : ${formatLength(videoMeta.lengthSec)}`);
  lines.push('RATIO      : 9:16 / 1080x1920');
  lines.push('FILE_FB90  : —              ← 페북 90초 캡 계정으로 확인되면 별도 컷 경로 기입');
  lines.push(`SLOT       : ${guide.slot || '—'}      ← ${guide.slot_note || ''}`.trimEnd());
  lines.push('');
  if ((guide.preflight || []).length) {
    lines.push(bar);
    lines.push('[프리플라이트 — 공개 전 필수]');
    lines.push(bar);
    for (const step of guide.preflight) lines.push(step);
    lines.push('');
  }
  lines.push(bar);
  lines.push(`[업로드 순서]  기기: ${guide.devices || '—'}`);
  lines.push(bar);
  for (const step of guide.steps || []) lines.push(step);
  lines.push('');
  if (guide.warnings) {
    lines.push(guide.warnings);
    lines.push('');
  }
  for (const id of platformIds) {
    const spec = specDoc.platforms[id];
    const post = posts.find((p) => String(p.platform) === id) || {};
    lines.push(bar);
    lines.push(`[${spec.label}]  후킹 캐리어: ${spec.hook_carrier}`);
    lines.push(bar);
    if (spec.has_title) {
      lines.push(`(제목, ${String(post.title || '').length}/${spec.title_max}자)`);
      lines.push(post.title || '');
      lines.push('');
    }
    lines.push(`(캡션, ${String(post.caption || '').length}/${spec.caption_max}자${spec.fold_chars && spec.fold_chars < spec.caption_max ? ` — 접힘 전 ~${spec.fold_chars}자` : ''})`);
    lines.push(post.caption || '');
    lines.push('');
    if (spec.info_tag) {
      lines.push('(정보태그 — 필수, 검색 유입의 핵심)');
      lines.push(filmTitleLocal ? `영화 <${filmTitleLocal}>` : '영화 <          >  ← 작품명 기입');
      lines.push('');
    }
    lines.push(`(해시태그 ${post.hashtags?.length || 0}개 — 권장 ${spec.hashtags.min}~${spec.hashtags.max})`);
    lines.push((post.hashtags || []).join(' '));
    lines.push('');
    if (spec.sound_field) {
      lines.push('(SOUND)');
      lines.push(locale === 'ja' && id === 'instagram' ? '—              ← 일본 트렌드 음원' : '—');
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function buildSocialPosts({ workspaceDir, compressionRunDir, locale }) {
  const specDoc = readJsonSafe(SPEC_PATH);
  if (!specDoc) throw new Error('platform_post_specs.json missing or invalid');
  const platformIds = (specDoc.locales || {})[locale] || [];
  if (!platformIds.length) throw new Error(`no platforms configured for locale ${locale}`);
  const facts = collectSourceFacts({ compressionRunDir, workspaceDir, locale });
  const prompt = buildPrompt({ locale, facts, specDoc, platformIds });
  const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : (raw || {}));
  // Post-generation validation with ONE named-failure retry per rule: the model reliably
  // slips on (a) answering ja packages in Korean and (b) importing film trivia the facts
  // exclude (Hollow Man's invisibility - the clip shows the monster plainly).
  const factBlob = JSON.stringify(facts);
  const violations = (result) => {
    const joined = JSON.stringify(result.posts || []);
    const found = [];
    if (locale === 'ja' && /[가-힣]/.test(joined)) found.push('it contained Korean text - EVERYTHING must be natural Japanese');
    if (!/見えな|invisible|보이지\s*않/.test(factBlob) && /見えな|invisible|보이지\s*않/.test(joined)) {
      found.push('it described something as invisible/unseen, which the source facts never state - drop that claim entirely');
    }
    const closing = facts.narrations[facts.narrations.length - 1] || '';
    const closingHead = closing.replace(/\s+/g, '').slice(0, 10);
    if (closingHead && (result.posts || []).some((p) => String(p.caption || '').replace(/\s+/g, '').includes(closingHead))) {
      found.push('it quoted the closing narration, revealing the ending - captions must tease, never resolve');
    }
    return found;
  };
  let result = parse(await generateVertexJson({ prompt, responseSchema: RESPONSE_SCHEMA, temperature: 0.4 }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const found = violations(result);
    if (!found.length) break;
    result = parse(await generateVertexJson({
      prompt: `${prompt}\n\nYOUR PREVIOUS ATTEMPT FAILED because ${found.join('; and ')}. Rewrite ALL packages fixing this.`,
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3
    }));
  }
  // Deterministic last resort for the invisibility import (the model's film prior keeps
  // re-inserting it through two named retries): strip only the "invisible + noun" pattern
  // so legitimate phrasings like 先が見えない展開 survive.
  if (!/見えな|invisible|보이지\s*않/.test(factBlob)) {
    for (const post of result.posts || []) {
      for (const field of ['title', 'caption']) {
        post[field] = String(post[field] || '')
          .replace(/(姿の)?見えない(怪物|敵|存在|相手|何か)/g, '$2')
          .replace(/보이지\s*않는\s*(괴물|적|존재|무언가)/g, '$1');
      }
    }
  }
  const posts = [];
  for (const id of platformIds) {
    const spec = specDoc.platforms[id];
    const raw = (result.posts || []).find((p) => String(p.platform) === id) || {};
    posts.push({
      platform: id,
      title: spec.has_title ? truncateAt(raw.title, spec.title_max) : '',
      caption: truncateAt(cleanCaption(raw.caption), spec.caption_max),
      hashtags: normalizeHashtags(raw.hashtags, spec)
    });
  }
  // video meta from the shipped manifest: file naming {yymmdd}_{locale}_01.mp4, length mm:ss
  let lengthSec = 0;
  const manifestForMeta = readJsonSafe(path.join(workspaceDir || '', `draft_${locale}`, 'edit_manifest.json')) || {};
  for (const segment of manifestForMeta.segments || []) {
    lengthSec = Math.max(lengthSec, Number(segment.video_timeline_end_sec || 0));
  }
  const now = new Date();
  const yymmdd = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const videoMeta = { fileName: `${yymmdd}_${locale}_01.mp4`, lengthSec };
  const filmTitleLocal = String(result.film_title_local || facts.releaseTitle || '').trim();
  const txt = renderTxt({ locale, specDoc, platformIds, posts, facts, videoMeta, filmTitleLocal });
  const outPath = path.join(workspaceDir, `social_posts.${locale}.txt`);
  fs.writeFileSync(outPath, `${txt}\n`, 'utf8');
  // travels with the CapCut draft on install
  const draftDir = path.join(workspaceDir, `draft_${locale}`);
  if (fs.existsSync(draftDir)) fs.copyFileSync(outPath, path.join(draftDir, `social_posts.${locale}.txt`));
  return { path: outPath, posts };
}

module.exports = { buildSocialPosts };
