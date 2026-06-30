const MAX_CAPTION_CHARS_DEFAULT = 42;
const HARD_CAPTION_CHARS_DEFAULT = 45;

function normalizeNarration(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
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

function findNaturalBreakPoint(text, maxChars, hardChars) {
  const start = Math.max(10, maxChars - 12);
  const end = Math.min(text.length, hardChars);
  const window = text.slice(start, end + 1);
  if (!window) return -1;

  const delimiterRegex = /,|，| 그리고 | 하지만 | 그래서 | 그런데 | 및 | /g;
  let lastMatch = null;
  let match = delimiterRegex.exec(window);
  while (match) {
    lastMatch = match;
    match = delimiterRegex.exec(window);
  }
  if (!lastMatch) return -1;

  return start + lastMatch.index + lastMatch[0].length;
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

    const fallbackCut = Math.min(maxChars, remain.length);
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
    const narration = normalizeNarration(segment?.text || segment?.narration || '');
    segmentToCaptionMap[segmentId] = [];

    if (!narration) {
      return;
    }

    const sentenceCandidates = splitBySentencePunctuation(narration)
      .flatMap((sentence) => splitByKoreanEndings(sentence))
      .map((s) => normalizeNarration(s))
      .filter((s) => Boolean(s) && !/^[.!?,]+$/.test(s));

    const perSegmentTexts = [];
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

    perSegmentTexts
      .filter((text) => !/^[.!?,]+$/.test(text))
      .forEach((text, idx) => {
      const captionId = `${segmentId}_cap_${String(idx + 1).padStart(3, '0')}`;
      const unit = {
        caption_id: captionId,
        segment_id: segmentId,
        order: idx + 1,
        text,
        source_segment_order: sourceOrder
      };
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
  MAX_CAPTION_CHARS_DEFAULT,
  HARD_CAPTION_CHARS_DEFAULT
};
