const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const { refreshCompressionPlan } = require('../server/services/midformCompressionService');
const { assembleBootstrapArtifacts } = require('../server/services/midformBootstrapAdapterService');

const sourceRunDir = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'compress_20260727142327_luMBOVwyNzo');
const wave3RunDir = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'offline_wave3_20260727_steve_sculley');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function uploadTextMarkdown(uploadText) {
  return [
    '# Upload Text',
    '',
    '## 제목 후보 3개',
    '',
    ...uploadText.title_candidates.map((title, index) => `${index + 1}. ${title}`),
    '',
    '## 화면 오버레이 제목',
    '',
    `top: ${uploadText.overlay_title.top}`,
    `bottom: ${uploadText.overlay_title.bottom}`,
    '',
    '## 설명란',
    '',
    uploadText.description,
    '',
    '## 고정댓글',
    '',
    uploadText.pinned_comment,
    ''
  ].join('\n');
}

function setDialogue(fill, captions, speakers) {
  return {
    ...fill,
    narration: '',
    caption_units: [],
    caption_kr: '',
    caption_kr_dialogue: captions,
    speakers,
    translation_mode: 'faithful_dialogue'
  };
}

function buildWave3SlotFills(previous) {
  const replacements = new Map([
    ['slot_01', (fill) => setDialogue(fill, [
      '탄산음료나 팔던 사람이, 뭘 알겠냐는 거였지.',
      '난 그 광고를 죽이지 않았어, 스티브. 방송까지 간 건 나 때문이야.'
    ], ['Scully', 'Scully'])],
    ['slot_03', (fill) => setDialogue(fill, [
      '우리가 사는 행성이랑은 전혀 다른 얘기 같았어.',
      '너무 어둡고, 브랜드와 반대였고, 제품도 안 보여줬잖아.',
      '“고객은 항상 옳다”는 말, 분명 고객이 만든 말일 거야.'
    ], ['Scully', 'Scully', 'Jobs'])],
    ['slot_04', (fill) => setDialogue(fill, [
      '상영 뒤 이사회는 광고비를 회수하라 했어.',
      '그래서 남은 광고 시간을 팔라고 했지.',
      '마지막 자리만 너무 열심히 팔지 말라 했고,',
      '그 광고를 지킨 건 나였어.'
    ], ['Scully', 'Scully', 'Scully', 'Scully'])],
    ['slot_05', (fill) => setDialogue(fill, [
      '자네가 애플을 떠난 이야기는 이제 신화처럼 변했지만,',
      '사실은 달라. 난 이 문제를 이사회에 올리겠다고 했어.',
      '그러지 말라고 경고했는데도.',
      '이사회는 자네가 더는 필요 없다고 봤어.'
    ], ['Scully', 'Scully', 'Scully', 'Scully'])],
    ['slot_06', (fill) => setDialogue(fill, [
      '그게 당신 이력서야. 그 전엔 뭘 팔았지?',
      '탄산 설탕물, 맞지? 난 차고에서...',
      '난 워즈니악과 차고에서 미래를 발명했어. 예술가는 이끌고, 사기꾼은 손만 들게 하지.',
      '내가 남으려면, 스티브는 안 됩니다.'
    ], ['Jobs', 'Jobs', 'Jobs', 'Scully'])],
    ['slot_07', (fill) => setDialogue(fill, [
      '자네가 이사회를 몰아붙인 거야.',
      '내가 결과를 정확히 말했는데도 밀어붙였고, 그들은 그대로 만장일치로 결정했어.',
      '나도 사람들이 진실을 알았으면 해.',
      '날 끝내려는 거지, 그렇지?'
    ], ['Scully', 'Scully', 'Scully', 'Jobs'])]
  ]);

  return {
    ...previous,
    script_id: 'steve-vs-scully-wave3-offline',
    upload_text: {
      title_candidates: [
        '잡스가 믿은 해고의 진실은 왜 뒤집혔을까?',
        '스컬리는 왜 잡스 앞에서 광고의 진실을 꺼냈을까?',
        '발표 직전 두 사람은 왜 서로를 끝내려 했을까?'
      ],
      overlay_title: {
        top: '해고의진실',
        bottom: '두남자충돌'
      },
      description: '영화 Steve Jobs (2015)는 세 번의 제품 발표 직전 백스테이지에서 잡스의 삶을 압축해 보여줍니다. 이 장면은 NeXT 발표 직전, 잡스와 존 스컬리가 해고와 1984 광고의 책임을 두고 정면으로 충돌하는 대목입니다.',
      pinned_comment: 'Steve Jobs (2015) — 잡스와 존 스컬리가 Apple 축출 서사를 두고 맞붙는 백스테이지 장면입니다.'
    },
    slot_fills: previous.slot_fills.map((fill) => {
      const rewrite = replacements.get(String(fill.slot_id || ''));
      return rewrite ? rewrite(fill) : fill;
    })
  };
}

function summarizeCopyDiff(beforeFills, afterFills) {
  const beforeById = new Map(beforeFills.slot_fills.map((fill) => [fill.slot_id, fill]));
  return afterFills.slot_fills
    .map((after) => {
      const before = beforeById.get(after.slot_id) || {};
      const beforeText = Array.isArray(before.caption_kr_dialogue) ? before.caption_kr_dialogue : before.caption_units || [];
      const afterText = Array.isArray(after.caption_kr_dialogue) ? after.caption_kr_dialogue : after.caption_units || [];
      return {
        slot_id: after.slot_id,
        changed: JSON.stringify(beforeText) !== JSON.stringify(afterText),
        before: beforeText,
        after: afterText
      };
    })
    .filter((entry) => entry.changed);
}

if (!fs.existsSync(sourceRunDir)) throw new Error(`Missing source run: ${sourceRunDir}`);
fs.rmSync(wave3RunDir, { recursive: true, force: true });
fs.cpSync(sourceRunDir, wave3RunDir, { recursive: true });

refreshCompressionPlan(wave3RunDir);

const slotFillsPath = path.join(wave3RunDir, 'compression_slot_fills.json');
const beforeFills = readJson(slotFillsPath);
const afterFills = buildWave3SlotFills(beforeFills);
writeJson(slotFillsPath, afterFills);
writeText(path.join(wave3RunDir, 'upload_text.md'), uploadTextMarkdown(afterFills.upload_text));

const assembled = assembleBootstrapArtifacts(wave3RunDir, { sourceVideoPath: path.join(wave3RunDir, 'source.mp4') });
fs.copyFileSync(assembled.paths.outSlotMapPath, path.join(wave3RunDir, 'slot_map.json'));
fs.copyFileSync(assembled.paths.outScriptPath, path.join(wave3RunDir, 'script.json'));
fs.copyFileSync(assembled.paths.outTranscriptPath, path.join(wave3RunDir, 'source_transcript.json'));

writeJson(path.join(wave3RunDir, 'wave3_copy_comparison.json'), {
  source: path.relative(PROJECT_ROOT, sourceRunDir).replace(/\\/g, '/'),
  after: path.relative(PROJECT_ROOT, wave3RunDir).replace(/\\/g, '/'),
  offline_constraints: {
    live_llm: false,
    live_tts: false,
    narration_audio_text_preserved_for_tts_reuse: true,
    visible_dialogue_captions_rewritten: true
  },
  changed_slots: summarizeCopyDiff(beforeFills, afterFills)
});

writeJson(path.join(wave3RunDir, 'offline_wave3_manifest.json'), {
  generated_at: new Date().toISOString(),
  run_dir: path.relative(PROJECT_ROOT, wave3RunDir).replace(/\\/g, '/'),
  source_run_dir: path.relative(PROJECT_ROOT, sourceRunDir).replace(/\\/g, '/'),
  artifacts: {
    edit_plan: 'edit_plan.json',
    slot_fills: 'compression_slot_fills.json',
    slot_map: 'slot_map.json',
    script: 'script.json',
    source_transcript: 'source_transcript.json',
    editorial_review: 'bootstrap_editorial_review.json',
    copy_comparison: 'wave3_copy_comparison.json'
  }
});

process.stdout.write(JSON.stringify({
  wave3RunDir,
  changedSlots: summarizeCopyDiff(beforeFills, afterFills).map((entry) => entry.slot_id),
  scriptPath: path.join(wave3RunDir, 'script.json'),
  transcriptPath: path.join(wave3RunDir, 'source_transcript.json')
}, null, 2));
