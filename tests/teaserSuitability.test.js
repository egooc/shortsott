const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

test('teaser suitability scoring exposes clarity, pronoun risk, balance, curiosity, and payoff fields', () => {
  assert.equal(typeof _test.buildTeaserSuitabilityScore, 'function');

  const beat = {
    summary: 'A confrontation where one person accuses the other and the truth reverses the blame.',
    hook_potential: 5,
    dramatic_weight: 5,
    dialogue_quality: 'high',
    key_dialogue: ['Why did you kill it?', "I didn't kill it, I protected it."]
  };
  const score = _test.buildTeaserSuitabilityScore(beat, ['Why did you kill it?', "I didn't kill it, I protected it."]);

  assert.equal(score.context_clarity, 5);
  assert.equal(score.pronoun_dependency_risk, false);
  assert.equal(score.accusation_response_balance, 5);
  assert.equal(score.standalone_comprehension, 5);
  assert.equal(score.curiosity_gap, 5);
  assert.equal(score.callback_payoff_strength, 5);
  assert.ok(score.total > 0);
});

test('teaser suitability penalizes unsupported high-context single-line rebuttals', () => {
  const beat = {
    summary: 'A sharp rebuttal arrives late in a confrontation.',
    hook_potential: 5,
    dramatic_weight: 5,
    dialogue_quality: 'high',
    key_dialogue: ['Because it was the only thing protecting it.']
  };
  const score = _test.buildTeaserSuitabilityScore(beat, ['Because it was the only thing protecting it.']);

  assert.equal(score.context_dependency, 'high');
  assert.equal(score.pronoun_dependency_risk, true);
  assert.equal(score.standalone_comprehension < 3, true);
  assert.equal(score.required_support_action, 'bridge_required');
});
