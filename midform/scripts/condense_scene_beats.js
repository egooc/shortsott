#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { condenseGeminiAnalysis } = require('../../server/services/midformSceneCondensationService');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: node midform/scripts/condense_scene_beats.js <run_dir> [target_beats]');
  process.exit(2);
}

const targetBeats = process.argv[3] ? Number(process.argv[3]) : undefined;
const analysisPath = path.join(runDir, 'gemini_analysis.json');
if (!fs.existsSync(analysisPath)) {
  console.error(`gemini_analysis.json not found: ${analysisPath}`);
  process.exit(1);
}

const condensed = condenseGeminiAnalysis(readJson(analysisPath), {
  ...(Number.isFinite(targetBeats) ? { targetBeats } : {})
});
const outputPath = path.join(runDir, 'scene_beats.json');
writeJson(outputPath, condensed);

const summary = {
  outputPath,
  original_scene_count: condensed.scene_condensation.original_scene_count,
  condensed_beat_count: condensed.scene_condensation.condensed_beat_count,
  content_guess: condensed.story_context.content_guess || '',
  dialogue_beats: condensed.scene_beats.filter((beat) => beat.key_dialogue_or_caption.length > 0).length,
  safety_beats: condensed.scene_beats.filter((beat) => beat.safety_flags.length > 0).length,
  beat_ranges: condensed.scene_beats.map((beat) => ({
    beat_id: beat.beat_id,
    story_role: beat.story_role,
    start_sec: beat.start_sec,
    end_sec: beat.end_sec,
    scene_count: beat.source_scene_ids.length
  }))
};

console.log(JSON.stringify(summary, null, 2));
