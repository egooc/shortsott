const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareFinalDraftClipChains,
  extractVideoClipChainFromDraftContent
} = require('../server/services/midformFinalDraftOverlapService');

function videoSegment(id, sourceStartSec, sourceDurationSec, targetStartSec, targetDurationSec = sourceDurationSec) {
  return {
    id,
    material_id: 'source-video-material',
    source_timerange: { start: Math.round(sourceStartSec * 1_000_000), duration: Math.round(sourceDurationSec * 1_000_000) },
    target_timerange: { start: Math.round(targetStartSec * 1_000_000), duration: Math.round(targetDurationSec * 1_000_000) }
  };
}

function draftContent(segments) {
  return { tracks: [{ type: 'video', name: 'source_video', segments }] };
}

test('extractVideoClipChainFromDraftContent reads source and target timeranges from source_video track', () => {
  const chain = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('clip_a', 10, 3, 0),
    videoSegment('clip_b', 20, 4, 3)
  ]));

  assert.equal(chain.length, 2);
  assert.deepEqual(chain[0].source_range, [10, 13]);
  assert.deepEqual(chain[0].timeline_range, [0, 3]);
  assert.deepEqual(chain[1].source_range, [20, 24]);
});

test('final draft overlap guard fails identical video source chains', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ko_a', 10, 3, 0),
    videoSegment('ko_b', 20, 3, 3),
    videoSegment('ko_c', 30, 3, 6)
  ]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 10, 3, 0),
    videoSegment('ja_b', 20, 3, 3),
    videoSegment('ja_c', 30, 3, 6)
  ]));

  const report = compareFinalDraftClipChains(ko, ja);

  assert.equal(report.final_status, 'failed');
  assert.equal(report.three_shot_identical_chain_detected, true);
  assert.ok(report.failed_gates.includes('exact_physical_timeline_clone'));
  assert.ok(report.pairwise_overlap_score > report.thresholds.pairwise_overlap_score);
});

test('first frame difference passes despite otherwise identical source reuse', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ko_a', 10, 3, 0),
    videoSegment('ko_b', 20, 3, 3),
    videoSegment('ko_c', 30, 3, 6)
  ]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 11, 3, 0),
    videoSegment('ja_b', 20, 3, 3),
    videoSegment('ja_c', 30, 3, 6)
  ]));

  const report = compareFinalDraftClipChains(ko, ja);

  assert.equal(report.final_status, 'passed_with_warnings');
  assert.deepEqual(report.failed_gates, []);
});

test('first clip in-point difference passes', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([videoSegment('ko_a', 10, 3, 0)]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([videoSegment('ja_a', 10.1, 3, 0)]));
  const report = compareFinalDraftClipChains(ko, ja);

  assert.notEqual(report.final_status, 'failed');
});

test('one scene or clip difference passes', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ko_a', 10, 3, 0),
    videoSegment('ko_b', 20, 3, 3),
    videoSegment('ko_c', 30, 3, 6)
  ]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 10, 3, 0),
    videoSegment('ja_b', 20, 3, 3),
    videoSegment('ja_c', 31, 3, 6)
  ]));
  const report = compareFinalDraftClipChains(ko, ja);

  assert.notEqual(report.final_status, 'failed');
});

test('final draft file comparison fails only when physical and textual tracks are identical', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-final-overlap-'));
  const koPath = path.join(directory, 'ko.json');
  const jaPath = path.join(directory, 'ja.json');
  const segments = [videoSegment('clip', 10, 3, 0)];
  fs.writeFileSync(koPath, JSON.stringify({ tracks: [{ type: 'video', name: 'source_video', segments }, { type: 'text', segments: [{ text: '같은 자막', target_timerange: { start: 0, duration: 3000000 } }] }] }), 'utf8');
  fs.writeFileSync(jaPath, JSON.stringify({ tracks: [{ type: 'video', name: 'source_video', segments: segments.map((segment) => ({ ...segment, id: 'ja_clip' })) }, { type: 'text', segments: [{ text: '다른 자막', target_timerange: { start: 0, duration: 3000000 } }] }] }), 'utf8');

  const { compareFinalDraftFiles } = require('../server/services/midformFinalDraftOverlapService');
  const report = compareFinalDraftFiles(koPath, jaPath);

  assert.notEqual(report.final_status, 'failed');
  assert.equal(report.clone_signals.identical_narration_dialogue_subtitle_content, false);
});

test('final draft overlap guard passes divergent source chains', () => {
  const ko = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ko_a', 10, 3, 0),
    videoSegment('ko_b', 20, 3, 3),
    videoSegment('ko_c', 30, 3, 6)
  ]));
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 60, 3, 0),
    videoSegment('ja_b', 80, 3, 3),
    videoSegment('ja_c', 100, 3, 6)
  ]));

  const report = compareFinalDraftClipChains(ko, ja);

  assert.equal(report.final_status, 'passed');
  assert.equal(report.three_shot_identical_chain_detected, false);
  assert.equal(report.source_range_overlap_ratio, 0);
});

test('final draft overlap guard fails missing video clip chains', () => {
  const ja = extractVideoClipChainFromDraftContent(draftContent([
    videoSegment('ja_a', 60, 3, 0)
  ]));

  const report = compareFinalDraftClipChains([], ja);

  assert.equal(report.final_status, 'failed');
  assert.deepEqual(report.failed_gates, ['missing_video_clip_chain']);
});
