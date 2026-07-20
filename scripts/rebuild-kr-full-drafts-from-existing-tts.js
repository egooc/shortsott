const fs = require('fs');
const path = require('path');
const { createProcessDraft } = require('../server/services/processEditService');
const { __test } = require('../server/services/processQueueService');

const SUMMARY_PATH = path.join(__dirname, '..', 'server', 'output', 'process_batches', 'kr_full_tts_approved_1784104661174', 'approved_kr_full_tts_summary.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function buildCaptionUnitsFromSentences(sentences = []) {
  const units = [];
  for (const sentence of sentences) {
    const sentenceId = sentence.sentence_id || sentence.id;
    const slices = __test.splitKoreanTtsSentenceIntoCaptionSlices(sentence.text || '');
    slices.forEach((text, index) => {
      units.push({
        caption_id: `${sentenceId}_unit_${String(index + 1).padStart(2, '0')}`,
        block_id: `${sentenceId}_unit_${String(index + 1).padStart(2, '0')}`,
        segment_id: sentenceId,
        tts_caption_id: sentenceId,
        text,
        start_sec: 0,
        end_sec: 0,
        order: units.length + 1
      });
    });
  }
  return units;
}

async function rebuildItem(item, preflightItem, stamp) {
  console.error(`rebuild start: ${item.item_id}`);
  const oldManifestPath = path.join(item.output_folder, 'edit_manifest.json');
  const oldManifest = readJson(oldManifestPath);
  const captionUnits = buildCaptionUnitsFromSentences(preflightItem.sentences || []);
  const plan = {
    sentences: (preflightItem.sentences || []).map((sentence) => ({ id: sentence.sentence_id, text: sentence.text })),
    captionUnits
  };
  __test.assertCaptionUnitsMatchTtsSentences(plan);

  const ttsFiles = item.draft.tts_files.map((file) => ({
    caption_id: file.caption_id,
    segment_id: file.caption_id,
    filename: path.basename(file.mp3_path),
    filepath: file.mp3_path,
    duration_sec: file.duration_sec,
    text: file.text,
    success: true
  }));

  const config = {
    source_video: oldManifest.source_video_path,
    target_duration_sec: oldManifest.target_duration_sec,
    upload_title: oldManifest.upload_title || '',
    upload_description: oldManifest.upload_description || '',
    upload_hashtags: oldManifest.upload_hashtags || [],
    use_tts: true,
    use_bgm: oldManifest.use_bgm !== false,
    bgm_preset: oldManifest.bgm_preset || 'process_satisfying',
    custom_bgm_path: oldManifest.bgm_source_path || '',
    bgm_volume: 0.18,
    channel_asset: oldManifest.channel_asset_overlay || { enabled: false },
    channel_frame_asset: { enabled: false },
    video_transform_preset: oldManifest.video_transform_preset_id || 'steady_zoom_process',
    capcut_template_id: oldManifest.capcut_template_id || 'process_default',
    capcut_template_draft_name: oldManifest.template_draft_name || '',
    output_language: 'ko',
    direct_render: { enabled: false, create_final_mp4: false },
    source_preprocess: {
      enabled: true,
      scene_tail_trim_sec: oldManifest.scene_tail_trim?.tail_trim_sec || 0,
      scene_detection: { enabled: true }
    },
    ocr_mask_overlay: oldManifest.ocr_mask_overlay || { enabled: false },
    explainer_blocks: captionUnits.map((unit) => ({
      block_id: unit.block_id,
      text: unit.text,
      start_sec: 0,
      end_sec: 0,
      output_language: 'ko',
      language: 'ko'
    }))
  };

  const result = await createProcessDraft({
    config,
    useExistingConfig: false,
    createZip: false,
    ttsFiles,
    captionUnits,
    captionWarnings: [],
    srtFile: ''
  });
  console.error(`rebuild draft created: ${item.item_id} ${result.draftPath}`);
  return {
    item_id: item.item_id,
    original_output_folder: item.output_folder,
    rebuilt_source_draft: result.draftPath,
    rebuilt_output_folder: result.draftPath,
    copied_to_capcut_root: false,
    copy_error: 'not attempted; server draft is used for zero-credit caption verification',
    caption_units_count: captionUnits.length,
    tts_files_count: ttsFiles.length,
    manifest_path: path.join(result.draftPath, 'edit_manifest.json')
  };
}

async function main() {
  console.error(`reading summary: ${SUMMARY_PATH}`);
  const summary = readJson(SUMMARY_PATH);
  const stamp = Date.now();
  const rebuilt = [];
  for (const itemId of ['item_012', 'item_009']) {
    console.error(`queue rebuild item: ${itemId}`);
    const item = summary.items.find((entry) => entry.item_id === itemId);
    const preflightItem = summary.preflight.items.find((entry) => entry.item_id === itemId);
    if (!item || !preflightItem) throw new Error(`missing summary data for ${itemId}`);
    rebuilt.push(await rebuildItem(item, preflightItem, stamp));
  }
  const outputPath = path.join(path.dirname(SUMMARY_PATH), `captionfix_rebuild_${stamp}.json`);
  writeJson(outputPath, { rebuilt });
  console.log(JSON.stringify({ outputPath, rebuilt }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', code: error.code || '', message: error.message, details: error.details || null }, null, 2));
  process.exit(1);
});
