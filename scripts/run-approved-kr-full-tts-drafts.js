require('dotenv').config();

const fs = require('fs');
const path = require('path');
const svc = require('../server/services/processQueueService');

const APPROVED_ITEM_IDS = ['item_012', 'item_009'];
const APPROVED_TTS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'Xb7hH8MSUJpSbSDYk0k2';
const APPROVED_TTS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function inspectDraft(outputFolder) {
  const manifestPath = path.join(outputFolder, 'edit_manifest.json');
  const notesPath = path.join(outputFolder, 'capcut_notes.md');
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const processTts = manifest.process_tts || {};
  const syncEvidence = manifest.korean_full_sync_evidence || {};
  const ttsFiles = Array.isArray(processTts.files) ? processTts.files : [];
  const warnings = Array.isArray(manifest.warnings) ? manifest.warnings : [];
  const clampWarnings = warnings.filter((warning) => /clamped|exceeds material/i.test(String(warning || '')));
  const zeroDurationWarnings = warnings.filter((warning) => /zero-duration|zero duration|duration is zero|duration invalid|zero-byte/i.test(String(warning || '')));
  return {
    output_folder: outputFolder,
    manifest_path: manifestPath,
    notes_path: notesPath,
    source_video_path: manifest.source_video_path || '',
    source_duration_sec: manifest.source_duration_sec || 0,
    target_duration_sec: manifest.target_duration_sec || 0,
    actual_timeline_duration_sec: manifest.actual_timeline_duration_sec || 0,
    requested_tts_duration_sec: manifest.requested_tts_duration_sec || 0,
    tts_total_duration_sec: processTts.total_tts_duration_sec || 0,
    korean_full_sync_evidence: syncEvidence,
    budget_vs_actual_tts_delta_sec: syncEvidence.actual_tts_vs_budget_delta_sec ?? null,
    budget_vs_actual_tts_ratio: syncEvidence.actual_tts_vs_budget_ratio ?? null,
    tts_audio_track_count: processTts.audio_track_count || 0,
    tts_pitfalls: processTts.pitfalls || {},
    tts_files: ttsFiles.map((file) => ({
      caption_id: file.caption_id || '',
      duration_sec: file.duration_sec || 0,
      mp3_path: file.mp3_path || '',
      text: file.text || '',
      warnings: file.warnings || []
    })),
    process_tts_caption_timing: manifest.process_tts_caption_timing || {},
    warnings,
    ffprobe_clamp_triggered: clampWarnings.length > 0,
    zero_duration_guard_triggered: zeroDurationWarnings.length > 0,
    clamp_warnings: clampWarnings,
    zero_duration_warnings: zeroDurationWarnings
  };
}

async function main() {
  const queueConfigPath = svc.QUEUE_CONFIG_PATH;
  const originalQueueConfigText = fs.readFileSync(queueConfigPath, 'utf8');
  const originalQueueConfig = JSON.parse(originalQueueConfigText);
  const itemConfigSnapshots = new Map();
  const batchName = `kr_full_tts_approved_${Date.now()}`;
  const preflight = await svc.previewKoreanFullDraftTts(APPROVED_ITEM_IDS);
  const missing = APPROVED_ITEM_IDS.filter((itemId) => !preflight.items.some((item) => item.item_id === itemId));
  if (missing.length) {
    throw new Error(`approved items missing from dry-run preview: ${missing.join(', ')}`);
  }
  for (const item of preflight.items) {
    if (item.warning_count !== 0) {
      throw new Error(`${item.item_id} has dry-run warnings; refusing real TTS`);
    }
    if (item.tts_call_count !== 10) {
      throw new Error(`${item.item_id} expected 10 TTS calls, got ${item.tts_call_count}`);
    }
  }

  const runConfig = {
    ...originalQueueConfig,
    batch_name: batchName,
    use_tts: true,
    output: {
      ...(originalQueueConfig.output || {}),
      create_zip: false,
      create_individual_zips: false
    }
  };

  let result;
  try {
    for (const itemId of APPROVED_ITEM_IDS) {
      const itemConfigPath = path.join(svc.QUEUE_ROOT, itemId, 'item_config.json');
      const originalItemConfigText = fs.readFileSync(itemConfigPath, 'utf8');
      itemConfigSnapshots.set(itemConfigPath, originalItemConfigText);
      const itemConfig = JSON.parse(originalItemConfigText);
      writeJson(itemConfigPath, {
        ...itemConfig,
        tts_voice_id: APPROVED_TTS_VOICE_ID,
        tts_model_id: APPROVED_TTS_MODEL_ID
      });
    }
    writeJson(queueConfigPath, runConfig);
    result = await svc.generateQueue({
      batch_name: batchName,
      item_ids: APPROVED_ITEM_IDS,
      stop_on_error: true,
      draft_variant_mode: 'full_only'
    });
  } finally {
    fs.writeFileSync(queueConfigPath, originalQueueConfigText.endsWith('\n') ? originalQueueConfigText : `${originalQueueConfigText}\n`, 'utf8');
    for (const [itemConfigPath, originalItemConfigText] of itemConfigSnapshots.entries()) {
      fs.writeFileSync(itemConfigPath, originalItemConfigText.endsWith('\n') ? originalItemConfigText : `${originalItemConfigText}\n`, 'utf8');
    }
  }

  const items = result.report.items.map((item) => ({
    item_id: item.item_id,
    status: item.status,
    output_folder: item.output_folder || '',
    error: item.error || '',
    korean_full_tts: item.korean_full_tts || {},
    draft: item.output_folder ? inspectDraft(item.output_folder) : null,
    warnings: item.warnings || []
  }));
  const summary = {
    approved_item_ids: APPROVED_ITEM_IDS,
    tts_voice_id: APPROVED_TTS_VOICE_ID,
    tts_model_id: APPROVED_TTS_MODEL_ID,
    preflight,
    batch_id: result.batchId,
    report_dir: result.reportDir,
    report_path: result.reportPath,
    notes_path: result.notesPath,
    success_count: result.report.success_count,
    failed_count: result.report.failed_count,
    items
  };
  const summaryPath = path.join(result.reportDir, 'approved_kr_full_tts_summary.json');
  writeJson(summaryPath, summary);
  console.log(JSON.stringify({ ...summary, summary_path: summaryPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'failed',
    name: error.name,
    code: error.code,
    status_code: error.status,
    message: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
