require('dotenv').config();

const fs = require('fs');
const path = require('path');
const svc = require('../server/services/processQueueService');

const itemId = process.argv[2] || 'item_008';
const voiceId = process.env.ELEVENLABS_VOICE_ID || 'Xb7hH8MSUJpSbSDYk0k2';
const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarizeManifest(manifestPath, reportItem = {}) {
  const manifest = manifestPath && fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const processTts = manifest.process_tts || {};
  return {
    manifest_path: manifestPath,
    korean_full_sync_evidence: manifest.korean_full_sync_evidence || reportItem.korean_full_sync_evidence || null,
    process_tts: processTts.total_tts_duration_sec ? {
      total_tts_duration_sec: processTts.total_tts_duration_sec,
      audio_track_count: processTts.audio_track_count,
      files_count: Array.isArray(processTts.files) ? processTts.files.length : 0
    } : null
  };
}

async function main() {
  const queueConfigPath = svc.QUEUE_CONFIG_PATH;
  const itemConfigPath = path.join(svc.QUEUE_ROOT, itemId, 'item_config.json');
  const originalQueueConfigText = fs.readFileSync(queueConfigPath, 'utf8');
  const originalItemConfigText = fs.readFileSync(itemConfigPath, 'utf8');

  const preview = await svc.previewKoreanFullDraftTts([itemId]);
  const previewItem = preview.items[0];
  if (!previewItem) throw new Error(`dry-run item not found: ${itemId}`);
  if (previewItem.warning_count !== 0) {
    throw new Error(`dry-run warnings detected: ${JSON.stringify(previewItem.warnings)}`);
  }
  if (previewItem.tts_call_count <= 0) {
    throw new Error(`dry-run has no TTS sentences: ${itemId}`);
  }

  const batchName = `kr_full_budget_gate_${Date.now()}`;
  try {
    const queueConfig = readJson(queueConfigPath);
    const itemConfig = readJson(itemConfigPath);
    writeJson(itemConfigPath, {
      ...itemConfig,
      tts_voice_id: voiceId,
      tts_model_id: modelId
    });
    writeJson(queueConfigPath, {
      ...queueConfig,
      batch_name: batchName,
      use_tts: true,
      output: {
        ...(queueConfig.output || {}),
        create_zip: false,
        create_individual_zips: false
      }
    });

    const result = await svc.generateQueue({
      batch_name: batchName,
      item_ids: [itemId],
      stop_on_error: true,
      draft_variant_mode: 'full_only'
    });
    const reportItem = result.report.items[0] || {};
    const manifestPath = reportItem.output_folder ? path.join(reportItem.output_folder, 'edit_manifest.json') : '';
    console.log(JSON.stringify({
      item_id: itemId,
      batch_id: result.batchId,
      report_path: result.reportPath,
      status: reportItem.status,
      error: reportItem.error || '',
      output_folder: reportItem.output_folder || '',
      dry_run: previewItem,
      ...summarizeManifest(manifestPath, reportItem)
    }, null, 2));
  } finally {
    fs.writeFileSync(queueConfigPath, originalQueueConfigText.endsWith('\n') ? originalQueueConfigText : `${originalQueueConfigText}\n`, 'utf8');
    fs.writeFileSync(itemConfigPath, originalItemConfigText.endsWith('\n') ? originalItemConfigText : `${originalItemConfigText}\n`, 'utf8');
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    code: error.code || error.name || 'ERROR',
    message: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
