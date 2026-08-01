const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PROJECT_ROOT = path.join(__dirname, '..');
const CAPCUT_DRAFT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'capcut_draft.py');

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makeDraftContent() {
  return {
    duration: 12_000_000,
    materials: { images: [] },
    tracks: [
      { id: 'source_track', type: 'video', name: 'source_video', segments: [], visible: true },
      { id: 'title_track', type: 'text', name: 'title', segments: [], visible: true },
      { id: 'subtitle_track', type: 'text', name: 'subtitle', segments: [], visible: true }
    ]
  };
}

function runPresetCase({ top = false, bottom = false, topSize = [800, 120], bottomSize = [800, 120] }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-preset-images-'));
  const draftPath = path.join(tempRoot, 'draft');
  const assetsDir = path.join(tempRoot, 'assets');
  fs.mkdirSync(draftPath, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  const draftContentPath = path.join(draftPath, 'draft_content.json');
  fs.writeFileSync(draftContentPath, `${JSON.stringify(makeDraftContent(), null, 2)}\n`, 'utf8');
  if (top) fs.writeFileSync(path.join(assetsDir, 'top_image.png'), pngHeader(topSize[0], topSize[1]));
  if (bottom) fs.writeFileSync(path.join(assetsDir, 'bottom_image.png'), pngHeader(bottomSize[0], bottomSize[1]));

  const python = `
import importlib.util, json, sys, types
cc = types.ModuleType("pyCapCut")
sys.modules["pyCapCut"] = cc
sys.modules["pycapcut"] = cc
spec = importlib.util.spec_from_file_location("capcut_draft", ${JSON.stringify(CAPCUT_DRAFT_SCRIPT)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
warnings = []
summary = module.apply_midform_run_preset_image_overlays(${JSON.stringify(draftContentPath)}, ${JSON.stringify(draftPath)}, 12.0, 1080, 1920, warnings, ${JSON.stringify(assetsDir)})
print(json.dumps({"summary": summary, "warnings": warnings}, ensure_ascii=False))
`;
  const result = spawnSync('python', ['-c', python], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  const draftContent = JSON.parse(fs.readFileSync(draftContentPath, 'utf8'));
  return { ...payload, draftContent };
}

function renderedCenterYToPx(transformY, canvasHeight = 1920) {
  return ((1 - transformY) * canvasHeight) / 2;
}

test('midform preset images skip cleanly when no assets exist', () => {
  const { summary, warnings, draftContent } = runPresetCase({});

  assert.equal(summary.applied, false);
  assert.equal(summary.segments_count, 0);
  assert.equal(summary.slots.length, 2);
  assert.ok(summary.slots.every((slot) => slot.reason === 'skipped_missing_asset'));
  assert.deepEqual(warnings, []);
  assert.equal(draftContent.tracks.some((track) => track.name === 'midform_preset_images'), false);
});

test('midform preset images apply only the top asset with top-center edge anchoring', () => {
  const { summary, warnings, draftContent } = runPresetCase({ top: true, topSize: [900, 90] });
  const top = summary.slots.find((slot) => slot.slot === 'top');
  const bottom = summary.slots.find((slot) => slot.slot === 'bottom');

  assert.equal(summary.applied, true);
  assert.equal(summary.segments_count, 1);
  assert.equal(top.applied, true);
  assert.equal(top.anchor, 'top-center');
  assert.equal(bottom.applied, false);
  assert.deepEqual(warnings, []);
  const presetTrackIndex = draftContent.tracks.findIndex((track) => track.name === 'midform_preset_images');
  assert.equal(presetTrackIndex, 1);
  const segment = draftContent.tracks[presetTrackIndex].segments[0];
  assert.equal(segment.clip.transform.x, 0);
  assert.ok(segment.clip.transform.y > 0);
  const centerY = renderedCenterYToPx(segment.clip.transform.y);
  const topEdge = centerY - top.layout.rendered_height_px / 2;
  assert.ok(Math.abs(topEdge - top.layout.safe_margin_px) < 1.0);
});

test('midform preset images apply only the bottom asset with bottom-center edge anchoring', () => {
  const { summary, warnings, draftContent } = runPresetCase({ bottom: true, bottomSize: [120, 900] });
  const top = summary.slots.find((slot) => slot.slot === 'top');
  const bottom = summary.slots.find((slot) => slot.slot === 'bottom');

  assert.equal(summary.applied, true);
  assert.equal(summary.segments_count, 1);
  assert.equal(top.applied, false);
  assert.equal(bottom.applied, true);
  assert.equal(bottom.anchor, 'bottom-center');
  assert.deepEqual(warnings, []);
  const presetTrack = draftContent.tracks.find((track) => track.name === 'midform_preset_images');
  const segment = presetTrack.segments[0];
  assert.equal(segment.clip.transform.x, 0);
  assert.ok(segment.clip.transform.y < 0);
  const centerY = renderedCenterYToPx(segment.clip.transform.y);
  const bottomEdge = centerY + bottom.layout.rendered_height_px / 2;
  assert.ok(Math.abs(bottomEdge - (1920 - bottom.layout.safe_margin_px)) < 1.0);
});

test('midform preset images apply both assets between source video and text tracks', () => {
  const { summary, warnings, draftContent } = runPresetCase({ top: true, bottom: true });
  const trackNames = draftContent.tracks.map((track) => track.name);
  const presetTrack = draftContent.tracks.find((track) => track.name === 'midform_preset_images');

  assert.equal(summary.applied, true);
  assert.equal(summary.segments_count, 2);
  assert.equal(summary.slots.filter((slot) => slot.applied).length, 2);
  assert.deepEqual(warnings, []);
  assert.deepEqual(trackNames, ['source_video', 'midform_preset_images', 'title', 'subtitle']);
  assert.equal(presetTrack.type, 'image');
  assert.equal(presetTrack.segments.length, 2);
  assert.equal(draftContent.materials.images.length, 2);
});
