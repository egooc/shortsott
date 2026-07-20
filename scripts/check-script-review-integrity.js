const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const queueService = require('../server/services/processQueueService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertFailureHasReasons(error, expectedCheck = '') {
  const details = error?.details || {};
  const validationIssues = Array.isArray(details.validation_issues) ? details.validation_issues : [];
  const failedChecks = Array.isArray(details.failed_checks) ? details.failed_checks : [];
  assert(validationIssues.length > 0, 'expected non-empty validation_issues on SCRIPT_REVIEW_VALIDATION_FAILED');
  assert(failedChecks.length > 0, 'expected non-empty failed_checks on SCRIPT_REVIEW_VALIDATION_FAILED');
  validationIssues.forEach((issue, index) => {
    assert(String(issue.check || '').trim(), `validation issue ${index + 1} missing check`);
    assert(String(issue.reason || '').trim() || String(issue.message || '').trim(), `validation issue ${index + 1} missing reason/message`);
  });
  if (expectedCheck) {
    assert(failedChecks.includes(expectedCheck), `expected failed_checks to include ${expectedCheck}, got ${failedChecks.join(', ')}`);
  }
}

function normalizeSceneAssignment(sceneAssignment = {}) {
  return {
    scenes: (sceneAssignment.scenes || []).map((scene) => ({
      scene_id: scene.scene_id || '',
      guide_chars: Number(scene.guide_chars || 0),
      assigned_chars: Number(scene.assigned_chars || 0),
      remaining_chars: Number(scene.remaining_chars || 0),
      over_guide: scene.over_guide === true
    })),
    unknown_scene_chars: (sceneAssignment.unknown_scene_chars || []).map((scene) => ({
      scene_id: scene.scene_id || '',
      assigned_chars: Number(scene.assigned_chars || 0)
    }))
  };
}

function normalizeAnchorSimulation(anchorSimulation = {}) {
  return {
    enabled: anchorSimulation.enabled === true,
    anchored_sentence_count: Number(anchorSimulation.anchored_sentence_count || 0),
    sentence_count: Number(anchorSimulation.sentence_count || 0),
    max_delay_sec: Number(anchorSimulation.max_delay_sec || 0),
    cumulative_positive_delay_sec: Number(anchorSimulation.cumulative_positive_delay_sec || 0),
    max_scene_invasion_sec: Number(anchorSimulation.max_scene_invasion_sec || 0),
    cumulative_scene_invasion_sec: Number(anchorSimulation.cumulative_scene_invasion_sec || 0),
    max_allowed_delay_sec: Number(anchorSimulation.max_allowed_delay_sec || 0),
    max_allowed_cumulative_delay_sec: Number(anchorSimulation.max_allowed_cumulative_delay_sec || 0),
    block_real_tts: anchorSimulation.block_real_tts === true,
    sentence_timeline: (anchorSimulation.sentence_timeline || []).map((sentence) => ({
      caption_id: sentence.caption_id || '',
      anchor_scene_id: sentence.anchor_scene_id || '',
      anchor_scene_ids: sentence.anchor_scene_ids || [],
      target_start_sec: Number(sentence.target_start_sec || 0),
      actual_start_sec: Number(sentence.actual_start_sec || 0),
      actual_end_sec: Number(sentence.actual_end_sec || 0),
      estimated_duration_sec: Number(sentence.estimated_duration_sec || 0),
      delay_sec: Number(sentence.delay_sec || 0),
      scene_invasion_sec: Number(sentence.scene_invasion_sec || 0)
    }))
  };
}

function makeFixtureGuide() {
  return {
    detected_subject: '정밀 계단 구조물',
    duration_sec: 29,
    korean_full_speech_budget: {
      target_duration_sec: 29,
      available_sec: 25.5,
      target_chars: 114,
      min_chars: 85,
      max_chars: 125,
      target_sentence_count: 8
    },
    scene_transitions: [
      { scene_id: 'S01', start_sec: 0, end_sec: 5, transition_at_sec: 5, visual_summary: '기준 측정', caption_text_ko: '기준 측정' },
      { scene_id: 'S02', start_sec: 5, end_sec: 11, transition_at_sec: 11, visual_summary: '철판 이동', caption_text_ko: '철판 이동' },
      { scene_id: 'S03', start_sec: 11, end_sec: 17, transition_at_sec: 17, visual_summary: '각도 조정', caption_text_ko: '각도 조정' },
      { scene_id: 'S04', start_sec: 17, end_sec: 23, transition_at_sec: 23, visual_summary: '용접 고정', caption_text_ko: '용접 고정' },
      { scene_id: 'S05', start_sec: 23, end_sec: 29, transition_at_sec: 29, visual_summary: '마감 점검', caption_text_ko: '마감 점검' }
    ],
    short_description_ko: '기준 측정부터 마감 점검까지 정밀하게 진행합니다.',
    explainer_text_ko: '기준을 맞추고 옮기고 고정하는 과정을 차분하게 보여줍니다.',
    full_caption_script_ko: [
      { scene_id: 'S01', role: 'hook', text: '기준 잡죠.' },
      { scene_id: 'S02', role: 'method', text: '옮겨요.' },
      { scene_id: 'S03', role: 'method', text: '맞춰요.' },
      { scene_id: 'S04', role: 'method', text: '고정해요.' },
      { scene_id: 'S05', role: 'quality_reason', text: '막아요.' },
      { scene_id: 'S05', role: 'closing', text: '끝나요.' }
    ],
    full_metadata_ko: {
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: [
        '기준 잡죠.',
        '옮겨 맞춰요.',
        '고정해 막아요.',
        '끝나요.'
      ],
      short_description: '기준 측정부터 마감 점검까지 정밀하게 진행합니다.',
      summary_caption: '기준을 맞추고 옮기고 고정하는 과정을 차분하게 보여줍니다.',
      report_description: '정밀한 구조물 제작 과정입니다.',
      upload_title: '정밀 구조물 제작 과정 #worker #process #metalwork #precision #factory',
      recommended_titles: [
        {
          title: '정밀 구조물 제작 과정 #worker #process #metalwork #precision #factory',
          hashtags: ['#worker', '#process', '#metalwork', '#precision', '#factory']
        }
      ]
    }
  };
}

function makeFixtureItemConfig(itemId) {
  const guide = makeFixtureGuide();
  return {
    item_id: itemId,
    target_duration_sec: 29,
    upload_title: '정밀 구조물 제작 과정',
    upload_description: guide.full_metadata_ko.report_description,
    upload_hashtags: ['#worker', '#process', '#metalwork', '#precision', '#factory'],
    source_type: 'longform',
    source_type_origin: 'fixture',
    source_workflow_mode: 'longform_to_shorts',
    source_classification: {
      duration_sec: 29,
      width: 1080,
      height: 1920,
      orientation: 'vertical',
      requested_mode: 'auto',
      reason: 'fixture',
      confidence: 'high',
      classified_at: '2026-07-17T00:00:00.000Z'
    },
    output_language: 'ko',
    review_language: 'ko',
    korean_review: {
      short_description: guide.full_metadata_ko.short_description,
      explainer_text: guide.explainer_text_ko,
      recommended_titles: guide.full_metadata_ko.recommended_titles,
      report_description: guide.full_metadata_ko.report_description
    },
    video_metadata: {
      duration_sec: 29,
      width: 1080,
      height: 1920
    },
    ottogi_guide_output: guide,
    explainer_blocks: [
      { block_id: 'exp_001', text: '기준 잡죠.', start_sec: 0, end_sec: 7, style_role: 'main_explainer', anchor_zone: 'lower_third', animation: 'pop_in' },
      { block_id: 'exp_002', text: '옮겨 맞춰요.', start_sec: 7, end_sec: 17, style_role: 'main_explainer', anchor_zone: 'lower_third', animation: 'pop_in' },
      { block_id: 'exp_003', text: '고정해 막아요.', start_sec: 17, end_sec: 24, style_role: 'main_explainer', anchor_zone: 'lower_third', animation: 'pop_in' },
      { block_id: 'exp_004', text: '끝나요.', start_sec: 24, end_sec: 29, style_role: 'main_explainer', anchor_zone: 'lower_third', animation: 'pop_in' }
    ]
  };
}

function removeDirRecursive(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) removeDirRecursive(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(targetDir);
}

function makeFixtureSourceVideo() {
  const tempPath = path.join(os.tmpdir(), `script-review-integrity-${Date.now()}.mp4`);
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=1080x1920:d=29',
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    tempPath
  ], { stdio: 'ignore' });
  return tempPath;
}

async function main() {
  const itemId = `item_script_review_integrity_case_${Date.now()}`;
  const itemDir = path.join(queueService.QUEUE_ROOT, itemId);

  let fixtureSourcePath = '';

  try {
    const fixture = makeFixtureItemConfig(itemId);
    fixtureSourcePath = makeFixtureSourceVideo();
    queueService.addQueueItem({ item_id: itemId, item_config: fixture, source_path: fixtureSourcePath });

    const dryRun = await queueService.createKoreanFullDraftScriptReview([itemId]);
    const item = dryRun.items[0];
    assert(item && item.script_review_status === 'awaiting_script_review', 'expected script review artifact generation');

    const validationPath = path.join(itemDir, 'script_review_validation.json');
    const reviewTextPath = path.join(itemDir, 'script_review.txt');
    assert(fs.existsSync(validationPath), 'expected script_review_validation.json');
    assert(fs.existsSync(reviewTextPath), 'expected script_review.txt');

    const before = readJson(validationPath);
    const approve = await queueService.approveKoreanFullDraftScriptReview(itemId);
    assert(approve.status === 'approved_for_tts', `expected approved_for_tts, got ${approve.status}`);
    const after = readJson(validationPath);
    const approvedItemConfigPath = path.join(itemDir, 'item_config.json');
    const approvedItemConfig = readJson(approvedItemConfigPath);
    const approvedReview = approvedItemConfig.script_review || {};

    const beforeSceneAssignment = normalizeSceneAssignment(before.scene_assignment || {});
    const afterSceneAssignment = normalizeSceneAssignment(after.scene_assignment || {});
    const beforeAnchorSimulation = normalizeAnchorSimulation(before.anchor_simulation || {});
    const afterAnchorSimulation = normalizeAnchorSimulation(after.anchor_simulation || {});

    assert(
      JSON.stringify(beforeSceneAssignment) === JSON.stringify(afterSceneAssignment),
      `scene assignment metrics changed across no-edit approve:\nBEFORE=${JSON.stringify(beforeSceneAssignment)}\nAFTER=${JSON.stringify(afterSceneAssignment)}`
    );
    assert(
      JSON.stringify(beforeAnchorSimulation) === JSON.stringify(afterAnchorSimulation),
      `anchor simulation metrics changed across no-edit approve:\nBEFORE=${JSON.stringify(beforeAnchorSimulation)}\nAFTER=${JSON.stringify(afterAnchorSimulation)}`
    );

    const reviewText = fs.readFileSync(reviewTextPath, 'utf8');
    assert(reviewText.includes('[S02] 옮겨요.'), 'expected multi-scene sentence review line');

    const retainedPreview = await queueService.createKoreanFullDraftScriptReview([itemId]);
    const retainedItem = retainedPreview.items[0] || null;
    const retainedItemConfig = readJson(approvedItemConfigPath);
    assert(retainedItem && retainedItem.script_review_status === 'approved_for_tts', 'expected same-content dry-run to retain approved_for_tts');
    assert(retainedItem.approval_retained === true, 'expected same-content dry-run to mark approval_retained');
    assert(retainedItemConfig.script_review?.status === 'approved_for_tts', 'item_config status should stay approved_for_tts after unchanged dry-run');
    assert(retainedItemConfig.script_review?.approval_basis_hash === approvedReview.approval_basis_hash, 'approval basis hash should remain identical after unchanged dry-run');
    assert(!retainedItemConfig.script_review?.approval_invalidated_reason, 'unchanged dry-run must not set approval_invalidated_reason');

    const invalidatedBase = readJson(approvedItemConfigPath);
    invalidatedBase.ottogi_guide_output.full_caption_script_ko[0].text = `${String(invalidatedBase.ottogi_guide_output.full_caption_script_ko[0].text || '')}!`;
    writeJson(approvedItemConfigPath, invalidatedBase);
    const invalidatedPreview = await queueService.createKoreanFullDraftScriptReview([itemId]);
    const invalidatedItem = invalidatedPreview.items[0] || null;
    const invalidatedItemConfig = readJson(approvedItemConfigPath);
    assert(invalidatedItem && invalidatedItem.script_review_status === 'awaiting_script_review', 'expected changed-content dry-run to reset status to awaiting_script_review');
    assert(invalidatedItemConfig.script_review?.status === 'awaiting_script_review', 'item_config status should reset to awaiting_script_review after basis change');
    assert(invalidatedItemConfig.script_review?.approval_invalidated_reason === 'approval_basis_changed_after_dry_run', 'expected explicit approval invalidation reason after basis change');
    assert(invalidatedItemConfig.script_review?.approval_basis_hash !== approvedReview.approval_basis_hash, 'approval basis hash should change after basis mutation');

    const originalFailureText = fs.readFileSync(reviewTextPath, 'utf8');
    const sentenceFailureLines = originalFailureText.split(/\r?\n/);
    const firstSentenceIndex = sentenceFailureLines.findIndex((line) => line.startsWith('[S01] '));
    assert(firstSentenceIndex >= 0, 'expected first sentence line in fixture review text');
    sentenceFailureLines[firstSentenceIndex] = '[S01] 미완성';
    fs.writeFileSync(reviewTextPath, `${sentenceFailureLines.join('\n')}\n`, 'utf8');
    let sentenceFailure = null;
    try {
      await queueService.approveKoreanFullDraftScriptReview(itemId);
    } catch (error) {
      sentenceFailure = error;
    }
    assert(sentenceFailure && sentenceFailure.code === 'SCRIPT_REVIEW_VALIDATION_FAILED', 'expected sentence-ending failure');
    assertFailureHasReasons(sentenceFailure, 'sentence_validation');

    const timelineFailureLines = originalFailureText.split(/\r?\n/);
    const s01Index = timelineFailureLines.findIndex((line) => line.startsWith('[S01] '));
    const s02Index = timelineFailureLines.findIndex((line) => line.startsWith('[S02] '));
    const s03Index = timelineFailureLines.findIndex((line) => line.startsWith('[S03] '));
    assert(s01Index >= 0 && s02Index >= 0 && s03Index >= 0, 'expected fixture anchor lines for timeline failure case');
    timelineFailureLines[s01Index] = '[S01] 기준을 아주 자세히 다시 또 길게 설명하면서도 끝까지 차분히 확인해요.';
    timelineFailureLines[s02Index] = '[S02] 천천히 여러 번 옮기고 또 맞추고 다시 살펴보면서 한 번 더 정리해요.';
    timelineFailureLines[s03Index] = '[S03] 각도도 다시 세밀하게 맞추고 작은 차이까지 계속 확인해요.';
    const s04Index = timelineFailureLines.findIndex((line) => line.startsWith('[S04] '));
    assert(s04Index >= 0, 'expected fixture S04 line for timeline failure case');
    timelineFailureLines[s04Index] = '[S04] 단단히 고정한 뒤에도 흔들림이 없는지 여러 번 반복해서 확인해요.';
    fs.writeFileSync(reviewTextPath, `${timelineFailureLines.join('\n')}\n`, 'utf8');
    let timelineFailure = null;
    try {
      await queueService.approveKoreanFullDraftScriptReview(itemId);
    } catch (error) {
      timelineFailure = error;
    }
    assert(timelineFailure && timelineFailure.code === 'SCRIPT_REVIEW_VALIDATION_FAILED', 'expected non-empty machine-readable failure payload for overflowing review text');
    assertFailureHasReasons(timelineFailure);

    console.log('script review integrity guard ok');
  } finally {
    removeDirRecursive(itemDir);
    if (fixtureSourcePath && fs.existsSync(fixtureSourcePath)) {
      fs.unlinkSync(fixtureSourcePath);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
