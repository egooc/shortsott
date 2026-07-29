const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  readJson,
  extractSubtitleTextMaterials,
  validateManifestMaterialColors,
  rgbFloatMatchesHex
} = require('./artifactQaHelpers');

const CAPCUT_DRAFT_SCRIPT = path.join(__dirname, '..', 'scripts', 'capcut_draft.py');

function textMaterial({ id = 'mat_1', text, hex = '#37FF3D', rgb = [0.2156862745, 1, 0.2392156863], useLetterColor = true, useEffectDefaultColor = false }) {
  return {
    id,
    type: 'subtitle',
    name: text,
    recognize_text: text,
    base_content: text,
    text_color: hex,
    use_effect_default_color: useEffectDefaultColor,
    content: JSON.stringify({
      text,
      styles: [{
        fill: {
          content: {
            render_type: 'solid',
            solid: { color: rgb, alpha: 1 }
          },
          alpha: 1
        },
        useLetterColor
      }]
    })
  };
}

test('material color helper parses CapCut subtitle text fill state', () => {
  const draftContent = { materials: { texts: [textMaterial({ text: '테스트 자막' })] } };
  const materials = extractSubtitleTextMaterials(draftContent);

  assert.equal(materials.length, 1);
  assert.equal(materials[0].text, '테스트 자막');
  assert.equal(materials[0].useLetterColor, true);
  assert.equal(materials[0].use_effect_default_color, false);
  assert.equal(rgbFloatMatchesHex(materials[0].fill_rgb, '#37FF3D'), true);
});

test('material color validator catches manifest color without matching material fill', () => {
  const manifest = {
    caption_units: [{
      caption_id: 'cap_001',
      segment_id: 'slot_01_L01',
      segment_type: 'dialogue_quote',
      speaker: 'Scully',
      text: '틀린 색상',
      caption_color: '#37FF3D'
    }]
  };
  const draftContent = { materials: { texts: [textMaterial({ text: '틀린 색상', hex: '#FFFFFF', rgb: [1, 1, 1] })] } };
  const validation = validateManifestMaterialColors(manifest, draftContent);

  assert.equal(validation.checked, 1);
  assert.equal(validation.passed, 0);
  assert.equal(validation.failed[0].caption_id, 'cap_001');
  assert.equal(validation.failed[0].fill_matches, false);
});

test('material color validator ignores orphan materials and consumes duplicate text matches once', () => {
  const manifest = {
    caption_units: [
      { caption_id: 'cap_001', segment_id: 'slot_01_L01', segment_type: 'dialogue_quote', speaker: 'Jobs', text: '같은 말', caption_color: '#00A9F7' },
      { caption_id: 'cap_002', segment_id: 'slot_01_L02', segment_type: 'dialogue_quote', speaker: 'Sculley', text: '같은 말', caption_color: '#37FF3D' }
    ]
  };
  const draftContent = {
    tracks: [{ type: 'text', name: 'subtitle', segments: [{ material_id: 'active_blue' }] }],
    materials: {
      texts: [
        textMaterial({ id: 'active_blue', text: '같은 말', hex: '#00A9F7', rgb: [0, 0.662745098, 0.968627451] }),
        textMaterial({ id: 'orphan_green', text: '같은 말', hex: '#37FF3D', rgb: [0.2156862745, 1, 0.2392156863] })
      ]
    }
  };

  const validation = validateManifestMaterialColors(manifest, draftContent);

  assert.equal(validation.checked, 2);
  assert.equal(validation.passed, 1);
  assert.equal(validation.failed.length, 1);
  assert.equal(validation.failed[0].caption_id, 'cap_002');
  assert.equal(validation.failed[0].material_id, '');
});

test('latest Steve Jobs draft has material-level colors matching dialogue manifest colors', () => {
  const manifest = readJson('server/output/drafts/pipeline_1785150227/edit_manifest.json');
  const draftContent = readJson('server/output/drafts/pipeline_1785150227/draft_content.json');
  const validation = validateManifestMaterialColors(manifest, draftContent);

  assert.ok(validation.checked > 0);
  assert.deepEqual(validation.failed, []);
});

test('CapCut reusable midform preset keeps 9:16 layout and dialogue glow inheritance', () => {
  const source = fs.readFileSync(CAPCUT_DRAFT_SCRIPT, 'utf8');

  assert.match(source, /MIDFORM_FIXED_TITLE_Y = 0\.7004421221864953/);
  assert.match(source, /MIDFORM_FIXED_SUBTITLE_Y = 0\.5416639871382638/);
  assert.match(source, /MIDFORM_CAPTION_Y = -0\.35/);
  assert.match(source, /preserve_glow_effect_layers_for_colored_caption/);
  assert.doesNotMatch(source, /ref_type in \{"text_effect", "bloom"\}/);
  assert.match(source, /material\["use_effect_default_color"\] = False/);
});
