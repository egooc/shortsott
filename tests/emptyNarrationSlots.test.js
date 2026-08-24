const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../server/services/midformCompressionService');
const { emptyNarrationSlots } = _test;

function plan(...items) { return { timeline: items }; }
function fills(...items) { return { slot_fills: items }; }

test('a body NARRATE slot left empty is caught', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's8', narration: '' }),
    plan({ slot_id: 's8', decision: 'NARRATE', role: 'body', visual_source_mode: 'source_audio_teaser' })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /s8/);
});

test('the ending is caught too - a payoff slot is where an empty slot costs the most', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's12', narration: '   ' }),
    plan({ slot_id: 's12', decision: 'NARRATE', role: 'payoff', visual_source_mode: 'source_audio_teaser' })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /payoff/);
});

test('the cold-open scene hook stays wordless by design', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's1', narration: '' }),
    plan({ slot_id: 's1', decision: 'NARRATE', role: 'cold_open', visual_source_mode: 'source_audio_teaser' })
  );
  assert.deepEqual(problems, []);
});

test('a measured action peak plays its own audio and needs no voice', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's5', narration: '' }),
    plan({ slot_id: 's5', decision: 'NARRATE', role: 'body', visual_source_mode: 'source_audio_action' })
  );
  assert.deepEqual(problems, []);
});

test('a KEEP_DIALOGUE slot is not expected to narrate', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's3', narration: '' }),
    plan({ slot_id: 's3', decision: 'KEEP_DIALOGUE', role: 'body' })
  );
  assert.deepEqual(problems, []);
});

test('a slot missing from the fills entirely is still a hole', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's2', narration: '전제를 세운다.' }),
    plan({ slot_id: 's8', decision: 'NARRATE', role: 'body' })
  );
  assert.equal(problems.length, 1);
});

test('a filled slot passes', () => {
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's8', narration: '하지만 협상은 군의 습격으로 중단됩니다.' }),
    plan({ slot_id: 's8', decision: 'NARRATE', role: 'body', visual_source_mode: 'source_audio_teaser' })
  );
  assert.deepEqual(problems, []);
});

test('the closing may be empty - the prompt offers that as a choice', () => {
  // "leave the closing narration EMPTY and let the source audio finish". The benchmark channel
  // ends on the peak scene itself, so this rule must not contradict the brief the model is given.
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's12', narration: '' }),
    plan({ slot_id: 's12', decision: 'NARRATE', role: 'closing' })
  );
  assert.deepEqual(problems, []);
});

test('a payoff slot is still not allowed to be empty', () => {
  // The exemption is for role "closing" only - an empty payoff loses the ending (casebook 21).
  const problems = emptyNarrationSlots(
    fills({ slot_id: 's12', narration: '' }),
    plan({ slot_id: 's12', decision: 'NARRATE', role: 'payoff' })
  );
  assert.equal(problems.length, 1);
});
