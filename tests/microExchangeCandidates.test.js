const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

function cue(id, startSec, endSec, speaker, text) {
  return { id, start_sec: startSec, end_sec: endSec, speaker, text };
}

test('buildMicroExchangeCandidates recognizes core adjacent exchange relation types', () => {
  assert.equal(typeof _test.buildMicroExchangeCandidates, 'function');

  const transcript = [
    cue('q1', 0, 1.2, 'A', 'Why did you lie to them?'),
    cue('a1', 1.4, 2.8, 'B', 'Because I had no other way to protect them.'),
    cue('acc1', 5, 6.3, 'A', 'You tried to kill the ad.'),
    cue('reb1', 6.5, 8.1, 'B', "I didn't kill the ad, I saved it."),
    cue('claim1', 11, 12.1, 'A', 'Everyone thinks the story is true.'),
    cue('rev1', 12.3, 13.9, 'B', "That isn't true at all."),
    cue('threat1', 17, 18.2, 'A', 'Stay away or I will destroy everything.'),
    cue('push1', 18.4, 20.2, 'B', "No, don't threaten him like that.")
  ];

  const candidates = _test.buildMicroExchangeCandidates(transcript, { maxGapSec: 1, maxDurationSec: 6 });
  const relationTypes = candidates.map((candidate) => candidate.relation_type);

  assert.ok(relationTypes.includes('question_answer'));
  assert.ok(relationTypes.includes('accusation_rebuttal'));
  assert.ok(relationTypes.includes('claim_reversal'));
  assert.ok(relationTypes.includes('threat_pushback'));
});

test('buildMicroExchangeCandidates preserves line-level source ids and duration bounds', () => {
  const transcript = [
    cue('line_a', 10, 11.5, 'Jobs', 'You tried to kill it.'),
    cue('line_b', 11.7, 13.6, 'Sculley', "I didn't kill it, Steve."),
    cue('line_c', 30, 45, 'Jobs', 'Why would the board do that?'),
    cue('line_d', 45.5, 47, 'Sculley', 'Because they had no choice.')
  ];

  const candidates = _test.buildMicroExchangeCandidates(transcript, { maxGapSec: 1, maxDurationSec: 8 });
  const exchange = candidates.find((candidate) => candidate.relation_type === 'accusation_rebuttal');

  assert.ok(exchange);
  assert.deepEqual(exchange.source_line_ids, ['line_a', 'line_b']);
  assert.deepEqual(exchange.lines, ['You tried to kill it.', "I didn't kill it, Steve."]);
  assert.equal(exchange.start_sec, 10);
  assert.equal(exchange.end_sec, 13.6);
  assert.ok(exchange.duration_sec <= 8);
  assert.equal(candidates.some((candidate) => candidate.source_line_ids.includes('line_c')), false);
});
