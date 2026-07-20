const fs = require('fs');
const path = require('path');
const { createProcessDraft } = require('../server/services/processEditService');

const INPUT_PATH = path.join(__dirname, '..', 'server', 'output', 'process_draft_input.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sceneTransitionsFromPayload(payload = {}) {
  const processConfig = payload.processConfig || {};
  return (processConfig.source_preprocess?.scene_detection?.gemini_scene_transitions || [])
    .map((scene, index) => ({
      scene_id: String(scene.scene_id || '').trim(),
      scene_index: index,
      start_sec: Number(scene.start_sec || 0),
      end_sec: Number(scene.end_sec || 0)
    }))
    .filter((scene) => scene.scene_id && scene.end_sec > scene.start_sec);
}

function stripAnchors(items = []) {
  return items.map((item) => {
    const next = { ...item };
    delete next.anchor_scene_id;
    delete next.anchor_scene_index;
    delete next.anchor_start_sec;
    delete next.anchor_end_sec;
    delete next.anchor_source;
    return next;
  });
}

function applyProportionalAnchors(ttsFiles = [], captionUnits = [], scenes = []) {
  const anchorForIndex = (index, count) => {
    if (!scenes.length || !count) return {};
    const scene = scenes[Math.min(scenes.length - 1, Math.floor(index * scenes.length / count))];
    return {
      anchor_scene_id: scene.scene_id,
      anchor_scene_index: scene.scene_index,
      anchor_start_sec: scene.start_sec,
      anchor_end_sec: scene.end_sec,
      anchor_source: 'temporary_proportional_gate_anchor'
    };
  };
  const anchorBySentence = new Map();
  const anchoredTtsFiles = ttsFiles.map((file, index) => {
    const anchor = anchorForIndex(index, ttsFiles.length);
    const sentenceId = String(file.caption_id || file.segment_id || '');
    if (sentenceId) anchorBySentence.set(sentenceId, anchor);
    return { ...file, ...anchor };
  });
  const anchoredCaptionUnits = captionUnits.map((unit) => ({
    ...unit,
    ...(anchorBySentence.get(String(unit.tts_caption_id || unit.segment_id || '')) || {})
  }));
  return { anchoredTtsFiles, anchoredCaptionUnits };
}

async function buildDraft(payload, label, ttsFiles, captionUnits) {
  const config = {
    ...(payload.processConfig || {}),
    upload_title: `${payload.processConfig?.upload_title || 'KR Full'} ${label}`,
    use_tts: true,
    korean_full_sync_evidence: {}
  };
  return createProcessDraft({
    config,
    useExistingConfig: false,
    createZip: false,
    ttsFiles,
    captionUnits,
    captionWarnings: payload.captionWarnings || [],
    srtFile: payload.srtFile || ''
  });
}

async function main() {
  const payload = readJson(INPUT_PATH);
  const ttsFiles = payload.ttsFiles || [];
  const captionUnits = payload.captionUnits || [];
  const scenes = sceneTransitionsFromPayload(payload);
  if (!ttsFiles.length) throw new Error('No existing TTS files in process_draft_input.json');
  if (!scenes.length) throw new Error('No scene transitions in process_draft_input.json');

  const continuous = await buildDraft(payload, '[continuous-compare]', stripAnchors(ttsFiles), stripAnchors(captionUnits));
  const { anchoredTtsFiles, anchoredCaptionUnits } = applyProportionalAnchors(ttsFiles, captionUnits, scenes);
  const anchored = await buildDraft(payload, '[anchored-compare]', anchoredTtsFiles, anchoredCaptionUnits);

  const summary = {
    input_path: INPUT_PATH,
    source: 'item_008_existing_mp3_zero_credit_gate',
    scenes,
    continuous_draft_path: continuous.draftPath,
    anchored_draft_path: anchored.draftPath,
    continuous_manifest_path: path.join(continuous.draftPath, 'edit_manifest.json'),
    anchored_manifest_path: path.join(anchored.draftPath, 'edit_manifest.json')
  };
  const outputPath = path.join(path.dirname(INPUT_PATH), `item008_anchor_comparison_${Date.now()}.json`);
  writeJson(outputPath, summary);
  console.log(JSON.stringify({ ...summary, summary_path: outputPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', code: error.code || error.name || '', message: error.message, details: error.details || null }, null, 2));
  process.exit(1);
});
