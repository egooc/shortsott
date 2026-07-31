function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function segmentKind(segment) {
  return ['dialogue_quote', 'dialogue'].includes(String(segment?.segment_type || '')) ? 'dialogue' : 'narration';
}

function segmentStart(segment) {
  return Number(segment?.timeline_start_sec ?? segment?.start_sec ?? 0) || 0;
}

function segmentEnd(segment) {
  return Number(segment?.timeline_end_sec ?? segment?.end_sec ?? segmentStart(segment)) || segmentStart(segment);
}

function textForSegment(segment) {
  return normalizeText(segment?.caption_text || segment?.translated_caption_ko || segment?.narration || segment?.text || '');
}

function activeTimeline(input = {}) {
  const source = Array.isArray(input.segments) ? input.segments : [];
  return source
    .map((segment) => ({ ...segment, text: textForSegment(segment), start: segmentStart(segment), end: segmentEnd(segment) }))
    .filter((segment) => segment.text || segmentKind(segment) === 'dialogue')
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function firstDialogueStart(segments) {
  const first = segments.find((segment) => segmentKind(segment) === 'dialogue');
  return first ? first.start : null;
}

function callbackDialogueStart(segments) {
  const dialogueBlocks = [];
  const seen = new Set();
  for (const segment of segments) {
    if (segmentKind(segment) !== 'dialogue') continue;
    const blockId = String(segment.parent_slot_id || segment.segment_id || '').replace(/_L\d+.*$/, '');
    if (seen.has(blockId)) continue;
    seen.add(blockId);
    dialogueBlocks.push(segment);
  }
  return dialogueBlocks[1] ? dialogueBlocks[1].start : null;
}

function maxNarrationRunBeforeDialogue(segments) {
  let total = 0;
  let max = 0;
  for (const segment of segments) {
    if (segmentKind(segment) === 'dialogue') break;
    const duration = Math.max(0, segment.end - segment.start);
    total += duration;
    max = Math.max(max, total);
  }
  return max;
}

function hasConflictCue(text) {
  return /(왜|아니|죽|끝|책임|미끼|인질|사냥|위험|표적|좋아|의무|해고|광고|빼내|뒤집|진실|상처|사라|쫓|보호|스낵|간식|연쇄살인마|용의자|형사|알리바이|추궁|피\s*묻|칼|살인|범인|수사|의심|증거|刑事|容疑者|アリバイ|追及|尋問|証拠|血|ナイフ|殺人|犯人|捜査|疑い)/.test(text);
}

function isRebuttalOnlyOpener(openingText) {
  const text = normalizeText(openingText);
  if (!text) return false;
  const rebuttalCue = /(아니|않았|안 했|그게 아니라|죽이지|내가 아니|때문이야|책임이야|ではない|ではありませ|じゃない|殺していない|殺し|違う)/.test(text);
  const contextCue = /(왜|누가|무엇|어쩌다|아버지|아들|잡스|스컬리|보안관|벨라|인간|광고|해고|사랑|책임)/.test(text);
  return rebuttalCue && !contextCue;
}

function openingContextUnits(segments, maxSeconds = 12, maxUnits = 3) {
  const firstStart = segments[0] ? segments[0].start : 0;
  return segments
    .filter((segment) => segment.start < firstStart + maxSeconds)
    .slice(0, maxUnits)
    .map((segment) => ({ text: segment.text, start: segment.start, end: segment.end, id: segment.segment_id || '' }));
}

function hasNamedAccusationTarget(text) {
  const normalized = normalizeText(text);
  const direct = normalized.match(/(조디악|연쇄살인마|살인마|살인범|범인|용의자|Zodiac|ゾディアック|連続殺人犯|殺人犯|犯人|容疑者)/i);
  if (direct) return { matched: true, target: direct[1] };
  const victimObject = normalized.match(/([가-힣]{1,8}|그 사람|그녀|피해자|あの人|彼|彼女|被害者)(?:을|를|を)\s*죽이(?:지|진)?\s*(?:않|안|못|なかった|ていない)/);
  if (victimObject) return { matched: true, target: victimObject[1] };
  return { matched: false, target: '' };
}

function supportingInvestigationCues(text) {
  const cues = [];
  const patterns = [
    ['형사', /형사/],
    ['알리바이', /알리바이/],
    ['추궁', /추궁/],
    ['취조', /취조/],
    ['수사', /수사/],
    ['용의자', /용의자/],
    ['혐의', /혐의/],
    ['증거', /증거/],
    ['피 묻은 칼', /피\s*묻은?\s*칼/],
    ['칼', /칼/],
    ['연쇄살인', /연쇄살인/],
    ['범인', /범인/],
    ['刑事', /刑事/],
    ['アリバイ', /アリバイ/],
    ['追及', /追及/],
    ['尋問', /尋問/],
    ['捜査', /捜査/],
    ['容疑者', /容疑者/],
    ['証拠', /証拠/],
    ['血', /血/],
    ['ナイフ', /ナイフ/],
    ['犯人', /犯人/]
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text) && !cues.includes(label)) cues.push(label);
  }
  return cues;
}

function hasNearbyInvestigationOrEvidenceCue(openingUnits) {
  const supportingText = openingUnits.slice(1).map((unit) => unit.text).join(' ');
  const cues = supportingInvestigationCues(supportingText);
  return { matched: cues.length > 0, cues };
}

function analyzeRebuttalOpener(segments, firstThirtyHasConflict) {
  const firstText = segments[0] ? segments[0].text : '';
  const openingUnits = openingContextUnits(segments);
  const detail = {
    first_text: firstText,
    opening_context_text: openingUnits.map((unit) => unit.text).join(' ').slice(0, 260)
  };
  if (!isRebuttalOnlyOpener(firstText)) {
    return { is_rebuttal: false, supported: true, detail: { ...detail, reason: 'not_rebuttal_opener' } };
  }

  const target = hasNamedAccusationTarget(firstText);
  const nearby = hasNearbyInvestigationOrEvidenceCue(openingUnits);
  const supported = target.matched && nearby.matched && firstThirtyHasConflict;
  return {
    is_rebuttal: true,
    supported,
    detail: {
      ...detail,
      reason: supported ? 'named_denial_with_immediate_investigation_context' : 'unsupported_rebuttal_only_opener',
      matched_target: target.target,
      supporting_cues: nearby.cues,
      first_30_conflict_clarity_passed: firstThirtyHasConflict
    }
  };
}

function captionReadabilityIssues(captionUnits = [], limits = {}) {
  const maxChars = Number(limits.maxChars || 18);
  const maxUnitsPerSegment = Number(limits.maxUnitsPerSegment || 6);
  const issues = [];
  const bySegment = new Map();
  for (const unit of Array.isArray(captionUnits) ? captionUnits : []) {
    const text = normalizeText(unit?.text || unit?.caption || '');
    const compactLength = text.replace(/\s+/g, '').length;
    if (compactLength > maxChars) {
      issues.push({ type: 'overlong_caption', caption_id: String(unit?.caption_id || ''), text, compact_length: compactLength, limit: maxChars });
    }
    const segmentId = String(unit?.segment_id || '');
    if (segmentId) bySegment.set(segmentId, (bySegment.get(segmentId) || 0) + 1);
  }
  for (const [segmentId, count] of bySegment.entries()) {
    if (count > maxUnitsPerSegment) issues.push({ type: 'dense_segment', segment_id: segmentId, caption_units: count, limit: maxUnitsPerSegment });
  }
  return issues;
}

function evaluateEditorialAcceptance(input = {}, options = {}) {
  const sceneType = normalizeText(input.scene_type || options.sceneType || '');
  const editorialPattern = normalizeText(input.editorial_pattern || options.editorialPattern || '');
  const segments = activeTimeline(input);
  const captionUnits = Array.isArray(input.caption_units) ? input.caption_units : [];
  const materialValidation = input.material_validation && typeof input.material_validation === 'object' ? input.material_validation : null;
  const speakerColorValidation = input.speaker_color_validation && typeof input.speaker_color_validation === 'object' ? input.speaker_color_validation : null;
  const results = [];
  const add = (id, status, detail = {}) => results.push({ id, status, ...detail });

  const firstDialogue = firstDialogueStart(segments);
  const callbackStart = callbackDialogueStart(segments);
  const firstText = segments[0] ? segments[0].text : '';
  const firstTwenty = segments.filter((segment) => segment.start < 20).map((segment) => segment.text).join(' ');
  const firstThirty = segments.filter((segment) => segment.start < 30).map((segment) => segment.text).join(' ');
  const firstThirtyHasConflict = hasConflictCue(firstThirty);

  const rebuttalOpener = analyzeRebuttalOpener(segments, firstThirtyHasConflict);
  if (sceneType === 'dialogue_confrontation' && rebuttalOpener.is_rebuttal && !rebuttalOpener.supported) {
    add('rebuttal_only_opener', 'fail', rebuttalOpener.detail);
  } else {
    add('rebuttal_only_opener', 'pass', rebuttalOpener.detail);
  }

  if (editorialPattern === 'cold_open_callback') {
    const ok = callbackStart != null && callbackStart <= 35;
    add('callback_strength', ok ? 'pass' : 'fail', { callback_dialogue_start_sec: callbackStart, limit_sec: 35 });
  } else {
    add('callback_strength', 'not_applicable', { editorial_pattern: editorialPattern });
  }

  const preDialogueRun = maxNarrationRunBeforeDialogue(segments);
  const engagementLimit = sceneType === 'dialogue_confrontation' ? 20 : 30;
  add('dramatic_engagement_timing', firstDialogue != null && preDialogueRun <= engagementLimit ? 'pass' : 'fail', {
    first_dialogue_start_sec: firstDialogue,
    narration_run_before_first_dialogue_sec: Number(preDialogueRun.toFixed(3)),
    limit_sec: engagementLimit
  });

  const readability = captionReadabilityIssues(captionUnits, options.readability || {});
  add('subtitle_readability', readability.length ? 'warning' : 'pass', { issue_count: readability.length, issues: readability.slice(0, 20) });

  const highContextTeaser = sceneType === 'dialogue_confrontation' && /(그|그녀|그게|그건|그 광고|자네|당신)/.test(firstText) && !hasConflictCue(firstTwenty);
  add('high_context_teaser_recovery', highContextTeaser ? 'fail' : 'pass', { first_20_sec_text: firstTwenty.slice(0, 240) });

  if (materialValidation) {
    const ok = Number(materialValidation.checked || 0) > 0 && Number(materialValidation.failed?.length || 0) === 0 && Number(materialValidation.passed || 0) === Number(materialValidation.checked || 0);
    add('rendered_speaker_color_match', ok ? 'pass' : 'fail', {
      checked: Number(materialValidation.checked || 0),
      passed: Number(materialValidation.passed || 0),
      failed: Array.isArray(materialValidation.failed) ? materialValidation.failed.slice(0, 10) : []
    });
  } else {
    add('rendered_speaker_color_match', 'human_review_required', { reason: 'rendered/material color proof not supplied' });
  }

  if (speakerColorValidation) {
    const checks = [
      ['dialogue_speaker_metadata_present', !(speakerColorValidation.failed || []).includes('dialogue_speaker_metadata_present')],
      ['same_speaker_same_color', !(speakerColorValidation.failed || []).includes('same_speaker_same_color')],
      ['distinct_speakers_not_collapsed', !(speakerColorValidation.failed || []).includes('distinct_speakers_not_collapsed')],
      ['narration_dialogue_color_separation', !(speakerColorValidation.failed || []).includes('narration_dialogue_color_separation')]
    ];
    for (const [id, ok] of checks) {
      add(id, ok ? 'pass' : 'fail', { speaker_color_validation: speakerColorValidation });
    }
  } else {
    add('dialogue_speaker_metadata_present', 'not_applicable', { reason: 'speaker color validation not supplied' });
  }

  if (sceneType === 'dialogue_confrontation') {
    add('first_30_conflict_clarity', firstThirtyHasConflict ? 'pass' : 'fail', { first_30_sec_text: firstThirty.slice(0, 260) });
  } else {
    add('first_30_conflict_clarity', firstThirtyHasConflict ? 'pass' : 'warning', { first_30_sec_text: firstThirty.slice(0, 260) });
  }

  const failed = results.filter((result) => result.status === 'fail');
  const warnings = results.filter((result) => ['warning', 'human_review_required'].includes(result.status));
  return {
    status: failed.length ? 'failed' : (warnings.length ? 'passed_with_warnings' : 'passed'),
    scene_type: sceneType,
    editorial_pattern: editorialPattern,
    failed: failed.map((result) => result.id),
    warnings: warnings.map((result) => result.id),
    results
  };
}

module.exports = {
  evaluateEditorialAcceptance,
  _test: {
    isRebuttalOnlyOpener,
    hasNamedAccusationTarget,
    hasNearbyInvestigationOrEvidenceCue,
    analyzeRebuttalOpener,
    captionReadabilityIssues,
    activeTimeline,
    callbackDialogueStart
  }
};
