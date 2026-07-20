const { __test } = require('../server/services/processQueueService');
const { __test: capcutTest } = require('../server/services/capcutService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const validPlan = {
  sentences: [
    {
      id: 'tts_sent_001',
      text: '여러 단계를 거쳐 정교하게 다듬습니다'
    }
  ],
  captionUnits: [
    { caption_id: 'cap_001', tts_caption_id: 'tts_sent_001', text: '여러 단계를 거쳐' },
    { caption_id: 'cap_002', tts_caption_id: 'tts_sent_001', text: '정교하게 다듬습니다' }
  ]
};

assert(__test.assertCaptionUnitsMatchTtsSentences(validPlan) === true, 'expected aligned caption units to pass');

let mismatchCode = '';
try {
  __test.assertCaptionUnitsMatchTtsSentences({
    ...validPlan,
    captionUnits: [
      validPlan.captionUnits[0],
      { ...validPlan.captionUnits[1], text: '정교하게 다듬어요' }
    ]
  });
} catch (error) {
  mismatchCode = error.code || '';
}

assert(mismatchCode === 'CAPTION_TTS_TEXT_MISMATCH', `expected CAPTION_TTS_TEXT_MISMATCH, got ${mismatchCode || 'no error'}`);

assert(capcutTest.assertCaptionUnitsMatchTtsFiles([
  { caption_id: 'tts_sent_001', text: validPlan.sentences[0].text }
], validPlan.captionUnits) === true, 'expected draft assembly guard to pass aligned units');

let assemblyMismatchCode = '';
try {
  capcutTest.assertCaptionUnitsMatchTtsFiles([
    { caption_id: 'tts_sent_001', text: validPlan.sentences[0].text }
  ], [
    validPlan.captionUnits[0],
    { ...validPlan.captionUnits[1], text: '정교하게 다듬어요' }
  ]);
} catch (error) {
  assemblyMismatchCode = error.code || '';
}

assert(assemblyMismatchCode === 'CAPTION_TTS_TEXT_MISMATCH', `expected assembly CAPTION_TTS_TEXT_MISMATCH, got ${assemblyMismatchCode || 'no error'}`);

const sliceExamples = [
  {
    input: '여러 단계를 거쳐 정교하게 다듬습니다',
    expected: ['여러 단계를 거쳐', '정교하게 다듬습니다']
  },
  {
    input: '재료 특성을 이해하고 힘을 조절하는 게 아주 중요합니다',
    expected: ['재료 특성을 이해하고', '힘을 조절하는 게', '아주 중요합니다']
  }
];

for (const example of sliceExamples) {
  const slices = __test.splitKoreanTtsSentenceIntoCaptionSlices(example.input);
  assert(JSON.stringify(slices) === JSON.stringify(example.expected), `unexpected slices for ${example.input}: ${JSON.stringify(slices)}`);
  assert(slices.every((slice) => slice.length >= 3 && slice.length <= 15), `slice length out of range: ${JSON.stringify(slices)}`);
  assert(slices.join(' ') === example.input, `slices must reconstruct input: ${JSON.stringify(slices)}`);
}

console.log('caption/TTS alignment guard ok');
