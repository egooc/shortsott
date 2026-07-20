require('dotenv').config();

const fs = require('fs');
const path = require('path');
const queueService = require('../server/services/processQueueService');
const metadataService = require('../server/services/processMetadataService');

const itemId = process.argv[2] || 'item_012';
const shouldGenerateMetadata = process.argv.includes('--generate-metadata');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sceneBudgets(guide = {}) {
  return (Array.isArray(guide.scene_transitions) ? guide.scene_transitions : [])
    .map((scene) => {
      const start = Number(scene.start_sec || 0);
      const end = Number(scene.end_sec || 0);
      const duration = end > start ? end - start : Number(scene.duration_sec || 0);
      if (!scene.scene_id || !duration) return null;
      return {
        scene_id: scene.scene_id,
        start_sec: Number(start.toFixed(3)),
        end_sec: Number(end.toFixed(3)),
        duration_sec: Number(duration.toFixed(3)),
        guide_chars: Math.max(1, Math.floor(duration * 5.0 * 0.90))
      };
    })
    .filter(Boolean);
}

function countKo(text = '') {
  return metadataService.countKoreanVisibleCharsNoSpaces(text);
}

function buildPieceSceneTotals(fullCaptionScript = []) {
  const totals = new Map();
  const pieces = (Array.isArray(fullCaptionScript) ? fullCaptionScript : [])
    .map((piece, index) => {
      const sceneId = String(piece?.scene_id || '').trim();
      const text = String(piece?.text || '').trim();
      const chars = countKo(text);
      if (sceneId) totals.set(sceneId, (totals.get(sceneId) || 0) + chars);
      return {
        piece_index: index,
        scene_id: sceneId,
        role: String(piece?.role || '').trim(),
        chars,
        text
      };
    })
    .filter((piece) => piece.text);
  return { totals, pieces };
}

function buildSceneAssignmentReport(previewItem = {}, budgets = [], fullCaptionScript = []) {
  const budgetByScene = new Map(budgets.map((budget) => [budget.scene_id, budget]));
  const { totals: sceneTotals, pieces } = buildPieceSceneTotals(fullCaptionScript);
  const sentences = (previewItem.sentences || []).map((sentence) => {
    const chars = countKo(sentence.text || '');
    const sceneId = sentence.anchor_scene_id || '';
    return {
      sentence_id: sentence.sentence_id,
      anchor_scene_id: sceneId,
      anchor_scene_ids: sentence.anchor_scene_ids || [],
      anchor_scene_index: sentence.anchor_scene_index,
      anchor_start_sec: sentence.anchor_start_sec,
      anchor_end_sec: sentence.anchor_end_sec,
      anchor_source: sentence.anchor_source,
      chars,
      text: sentence.text
    };
  });
  const scenes = budgets.map((budget) => {
    const chars = sceneTotals.get(budget.scene_id) || 0;
    return {
      ...budget,
      assigned_chars: chars,
      remaining_chars: budget.guide_chars - chars,
      over_guide: chars > budget.guide_chars
    };
  });
  const unknownSceneChars = [...sceneTotals.entries()]
    .filter(([sceneId]) => !budgetByScene.has(sceneId))
    .map(([scene_id, assigned_chars]) => ({ scene_id, assigned_chars }));
  return { sentences, scenes, pieces, unknown_scene_chars: unknownSceneChars };
}

async function regenerateMetadata(item) {
  const itemConfig = item.item_config || {};
  const sourceInfo = queueService.getQueueItemSourceInfo(item.item_id);
  const sourceUrl = String(itemConfig.source_url || '').trim();
  const durationSec = Number(itemConfig.video_metadata?.duration_sec || itemConfig.target_duration_sec || 0);
  const assignedHookType = metadataService.selectKoreanFullHookType({
    seed: `gate-b:${item.item_id}:${sourceUrl || sourceInfo.filename || ''}`,
    itemId: item.item_id,
    sourceUrl,
    filename: sourceInfo.filename,
    sourceType: itemConfig.source_type || 'unknown',
    sourceWorkflowMode: itemConfig.source_workflow_mode || 'unknown',
    detectedSubject: itemConfig.ottogi_guide_output?.detected_subject || itemConfig.upload_title || '',
    sourceText: JSON.stringify({
      title: itemConfig.upload_title || '',
      description: itemConfig.upload_description || '',
      classification: itemConfig.source_classification || null
    })
  });

  console.error(JSON.stringify({
    stage: 'metadata_start',
    item_id: item.item_id,
    duration_sec: durationSec,
    source_path: sourceInfo.sourcePath,
    filename: sourceInfo.filename,
    assigned_hook_type: assignedHookType
  }, null, 2));

  const guide = await metadataService.analyzeOttogiProcessMetadata({
    filePath: sourceInfo.sourcePath,
    sourceUrl,
    apiKey: metadataService.isVertexAdcMode() ? '' : process.env.GEMINI_API_KEY,
    durationSec,
    originalFilename: sourceInfo.filename,
    sourceType: itemConfig.source_type || 'unknown',
    sourceWorkflowMode: itemConfig.source_workflow_mode || 'unknown',
    metadataVariantMode: 'full_only',
    existingGuide: null,
    assignedHookType,
    fullDraftStagesDir: path.join(queueService.QUEUE_ROOT, itemId, 'full_draft_stages'),
    onProgress: (message, data = {}) => {
      console.error(JSON.stringify({ stage: 'metadata_progress', message, data }, null, 2));
    }
  });
  return queueService.applyOttogiGuideToItem(item.item_id, guide, sourceUrl);
}

async function main() {
  let queue = queueService.listQueue();
  let item = queue.queueItems.find((entry) => entry.item_id === itemId);
  if (!item) throw new Error(`queue item not found: ${itemId}`);

  let metadataResult = null;
  if (shouldGenerateMetadata) {
    metadataResult = await regenerateMetadata(item);
    queue = queueService.listQueue();
    item = queue.queueItems.find((entry) => entry.item_id === itemId);
  }

  const preview = await queueService.previewKoreanFullDraftTts([itemId]);
  const previewItem = preview.items[0] || null;
  if (!previewItem) throw new Error(`dry-run preview failed: ${itemId}`);
  const guide = item.item_config?.ottogi_guide_output || {};
  const budgets = sceneBudgets(guide);
  const scene_assignment = buildSceneAssignmentReport(previewItem, budgets, guide.full_caption_script_ko || []);
  const report = {
    item_id: itemId,
    metadata_generated: shouldGenerateMetadata,
    metadata_saved_path: metadataResult?.savedPath || '',
    title: item.item_config?.upload_title || '',
    duration_sec: Number(item.item_config?.video_metadata?.duration_sec || item.item_config?.target_duration_sec || 0),
    scene_count: budgets.length,
    script_count: previewItem.sentences?.length || 0,
    dry_run: previewItem,
    scene_assignment,
    approval_required_before_real_tts: true
  };
  const outputPath = path.join(__dirname, '..', 'server', 'output', `gate_b_${itemId}_dry_run_${Date.now()}.json`);
  writeJson(outputPath, report);
  console.log(JSON.stringify({ ...report, report_path: outputPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'failed',
    code: error.code || error.name || '',
    message: error.message,
    details: error.details || error.data || null
  }, null, 2));
  process.exit(1);
});
