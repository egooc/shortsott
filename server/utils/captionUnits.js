const MAX_CAPTION_CHARS_DEFAULT = 34;
const HARD_CAPTION_CHARS_DEFAULT = 38;

const { buildSpeakerMetadata, resolveCaptionColor } = require('./captionColorConfig');

function normalizeNarration(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sanitizeDisplayCaptionText(text) {
  return normalizeNarration(text)
    .replace(/\s*(?:—|–|ㅡ)\s*/g, ' ')
    .replace(/(?:^|\s)>>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitDisplayCaptionSources(text, segmentType = '') {
  const sanitized = sanitizeDisplayCaptionText(text);
  if (!sanitized) return [];
  if (['dialogue_quote', 'dialogue'].includes(String(segmentType || ''))) {
    return sanitized
      .split(/\s*\/\s*/)
      .map((part) => sanitizeDisplayCaptionText(part))
      .filter(Boolean);
  }
  return [sanitized];
}

function protectSensitiveNumericTokens(text) {
  const protectedTokens = [];
  let idx = 0;
  let next = text;

  const patterns = [
    /\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b/g,
    /\b\d+\.\d+\b/g
  ];

  patterns.forEach((pattern) => {
    next = next.replace(pattern, (match) => {
      const token = `__CAPTOK_${idx}__`;
      protectedTokens.push({ token, value: match });
      idx += 1;
      return token;
    });
  });

  return { text: next, protectedTokens };
}

function restoreSensitiveNumericTokens(text, protectedTokens) {
  let restored = text;
  (protectedTokens || []).forEach(({ token, value }) => {
    restored = restored.replaceAll(token, value);
  });
  return restored;
}

function splitBySentencePunctuation(text) {
  const { text: protectedText, protectedTokens } = protectSensitiveNumericTokens(text);
  const chunks = protectedText
    .split(/(?<=[.!?])\s+/)
    .map((chunk) => restoreSensitiveNumericTokens(chunk, protectedTokens).trim())
    .filter(Boolean);
  return chunks.length ? chunks : [text];
}

function hasSentenceEndingBoundary(fullText, endIndexExclusive) {
  if (endIndexExclusive >= fullText.length) return true;
  const next = fullText[endIndexExclusive];
  return /\s|[.!?,]/.test(next);
}

function splitByKoreanEndings(text) {
  const endings = ['겁니다', '합니다', '군요', '다', '요', '죠', '까', '네'];
  const out = [];
  let cursor = 0;

  while (cursor < text.length) {
    let best = null;
    endings.forEach((ending) => {
      const idx = text.indexOf(ending, cursor);
      if (idx === -1) return;
      const endIndex = idx + ending.length;
      if (!hasSentenceEndingBoundary(text, endIndex)) return;
      if (!best || idx < best.idx) {
        best = { idx, endIndex };
      }
    });

    if (!best) break;
    let finalEndIndex = best.endIndex;
    while (finalEndIndex < text.length && /[.!?,]/.test(text[finalEndIndex])) {
      finalEndIndex += 1;
    }

    const piece = text.slice(cursor, finalEndIndex).trim();
    if (piece) out.push(piece);
    cursor = finalEndIndex;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }

  const remain = text.slice(cursor).trim();
  if (remain) out.push(remain);
  return out.length ? out : [text];
}

function endsWithAwkwardKoreanParticle(text) {
  const trimmed = normalizeNarration(text);
  if (!trimmed) return true;
  const words = trimmed.split(' ');
  const lastWord = words[words.length - 1] || '';
  if (!/[,.!?，]$/.test(trimmed) && /^[가-힣]{1,2}$/.test(lastWord)) return true;
  const awkwardEndings = [
    '의', '은', '는', '이', '가', '을', '를', '와', '과', '에', '에서', '에게',
    '로', '으로', '만', '도', '부터', '까지', '보다', '처럼', '쪽으로', '넘어가', '준비를'
  ];
  return awkwardEndings.some((ending) => trimmed.endsWith(ending));
}

function startsWithContinuation(text) {
  const trimmed = normalizeNarration(text);
  if (!trimmed) return false;
  return /^(의|은|는|이|가|을|를|와|과|에|에서|에게|로|으로|만|도|부터|까지|않은|않는|않다|있는|없는|위한|때문|자린은)/.test(trimmed);
}

function scoreBreakCandidate(text, index, maxChars, hardChars) {
  const left = text.slice(0, index).trim();
  const right = text.slice(index).trim();
  if (!left || !right) return -Infinity;
  if (left.length < 12) return -Infinity;
  if (left.length > hardChars) return -Infinity;

  let score = 100;
  score -= Math.abs(maxChars - left.length) * 2;

  const before = text[index - 1] || '';
  const after = text[index] || '';
  if (/[,.!?，]/.test(before)) score += 80;
  if (/\s/.test(after)) score += 20;
  if (/(그리고|하지만|그래서|그런데|결국|이제)$/.test(left)) score += 70;
  if (/^(그리고|하지만|그래서|그런데|이어|결국|이제|오늘의|과연)\b/.test(right)) score += 35;
  if (endsWithAwkwardKoreanParticle(left)) score -= 90;
  if (startsWithContinuation(right)) score -= 60;
  if (left.length <= maxChars) score += 12;
  return score;
}

function findNaturalBreakPoint(text, maxChars, hardChars) {
  const normalized = normalizeNarration(text);
  const searchEnd = Math.min(normalized.length - 1, hardChars);
  if (searchEnd <= 0) return -1;

  const candidateIndexes = new Set();
  for (let i = 1; i <= searchEnd; i += 1) {
    const char = normalized[i - 1];
    const next = normalized[i] || '';
    if (/[,.!?，]/.test(char)) candidateIndexes.add(i);
    if (/\s/.test(char)) candidateIndexes.add(i);
    if (/\s/.test(next)) candidateIndexes.add(i);
  }

  let best = { index: -1, score: -Infinity };
  candidateIndexes.forEach((index) => {
    const score = scoreBreakCandidate(normalized, index, maxChars, hardChars);
    if (score > best.score) best = { index, score };
  });

  return best.score > -20 ? best.index : -1;
}

function splitLongCaption(text, maxChars, hardChars) {
  const chunks = [];
  const warnings = [];
  let remain = text.trim();

  while (remain.length > hardChars) {
    const breakPoint = findNaturalBreakPoint(remain, maxChars, hardChars);
    if (breakPoint > 0) {
      const left = remain.slice(0, breakPoint).trim();
      const right = remain.slice(breakPoint).trim();
      if (left) chunks.push(left);
      remain = right;
      continue;
    }

    let fallbackCut = Math.min(maxChars, remain.length);
    while (fallbackCut > 12 && !/\s/.test(remain[fallbackCut] || '') && !/\s/.test(remain[fallbackCut - 1] || '')) {
      fallbackCut -= 1;
    }
    if (fallbackCut <= 12) fallbackCut = Math.min(maxChars, remain.length);
    const left = remain.slice(0, fallbackCut).trim();
    const right = remain.slice(fallbackCut).trim();
    if (left) chunks.push(left);
    remain = right;
    warnings.push('caption split by hard limit; semantic boundary may be imperfect');
  }

  if (remain) chunks.push(remain);
  return { chunks: chunks.filter(Boolean), warnings };
}

function buildCaptionUnits(segments, options = {}) {
  const maxChars = Number(options.maxChars || MAX_CAPTION_CHARS_DEFAULT);
  const hardChars = Number(options.hardChars || HARD_CAPTION_CHARS_DEFAULT);
  const captionUnits = [];
  const warnings = [];
  const segmentToCaptionMap = {};

  (segments || []).forEach((segment, segmentIndex) => {
    const segmentId = String(segment?.segment_id || segment?.segmentId || `seg_${String(segmentIndex + 1).padStart(3, '0')}`);
    const sourceOrder = Number(segment?.order || segmentIndex + 1);
    const segmentType = String(segment?.segment_type || segment?.segmentType || 'recap');
    const isDialogue = segmentType === 'dialogue_quote' || segmentType === 'dialogue';
    const ttsEnabled = segment?.tts_enabled !== false && segment?.ttsEnabled !== false && segmentType !== 'dialogue_quote';
    const narration = normalizeNarration(
      segmentType === 'dialogue_quote'
        ? (segment?.translated_caption_ko || segment?.caption_text || segment?.text || '')
        : (segment?.text || segment?.narration || segment?.caption_text || '')
    );
    segmentToCaptionMap[segmentId] = [];

    if (!narration) {
      return;
    }

    const perSegmentTexts = [];
    if (isDialogue) {
      perSegmentTexts.push(sanitizeDisplayCaptionText(narration));
    } else {
      const displaySources = splitDisplayCaptionSources(narration, segmentType);
      const sentenceCandidates = displaySources.flatMap((displayNarration) => splitBySentencePunctuation(displayNarration))
        .flatMap((sentence) => splitByKoreanEndings(sentence))
        .map((s) => sanitizeDisplayCaptionText(s))
        .filter((s) => Boolean(s) && !/^[.!?,]+$/.test(s));

      sentenceCandidates.forEach((sentence) => {
        if (sentence.length <= hardChars) {
          perSegmentTexts.push(sentence);
          return;
        }

        const { chunks, warnings: chunkWarnings } = splitLongCaption(sentence, maxChars, hardChars);
        perSegmentTexts.push(...chunks);
        if (chunkWarnings.length) {
          warnings.push({
            segment_id: segmentId,
            reason: 'long_sentence_split',
            message: chunkWarnings.join('; ')
          });
        }
      });
    }

    perSegmentTexts
      .filter((text) => !/^[.!?,]+$/.test(text))
      .forEach((text, idx) => {
      const captionId = `${segmentId}_cap_${String(idx + 1).padStart(3, '0')}`;
      const unit = {
        caption_id: captionId,
        segment_id: segmentId,
        segment_type: segmentType,
        caption_kind: isDialogue ? 'dialogue' : 'narration',
        tts_enabled: ttsEnabled,
        order: idx + 1,
        text: sanitizeDisplayCaptionText(text),
        source_segment_order: sourceOrder
      };
      if (isDialogue) {
        const speakerMetadata = buildSpeakerMetadata(segment, { segment_type: segmentType, utt_id: segment?.utt_id || segmentId });
        Object.assign(unit, speakerMetadata);
        if (speakerMetadata.speaker_alias) unit.speaker = speakerMetadata.speaker_alias;
        const captionColor = resolveCaptionColor({ speakerAlias: unit.speaker_alias || unit.speaker, speakerColorKey: unit.speaker_color_key });
        if (captionColor) unit.caption_color = captionColor;
        if (Number.isFinite(Number(segment?.caption_timeline_offset_sec))) {
          unit.caption_timeline_offset_sec = Number(segment.caption_timeline_offset_sec);
        }
        if (Number.isFinite(Number(segment?.duration_override_sec)) && Number(segment.duration_override_sec) > 0) {
          unit.duration_override_sec = Number(segment.duration_override_sec);
        }
        if (Array.isArray(segment?.dialogue_speech_range_sec)) {
          unit.dialogue_speech_range_sec = segment.dialogue_speech_range_sec;
        }
        if (segment?.dialogue_timing_adjustment && typeof segment.dialogue_timing_adjustment === 'object') {
          unit.dialogue_timing_adjustment = segment.dialogue_timing_adjustment;
        }
      }
      captionUnits.push(unit);
      segmentToCaptionMap[segmentId].push(captionId);
      });
  });

  return {
    captionUnits,
    warnings,
    segmentToCaptionMap,
    maxCaptionChars: maxChars
  };
}

module.exports = {
  buildCaptionUnits,
  sanitizeDisplayCaptionText,
  splitDisplayCaptionSources,
  MAX_CAPTION_CHARS_DEFAULT,
  HARD_CAPTION_CHARS_DEFAULT
};
