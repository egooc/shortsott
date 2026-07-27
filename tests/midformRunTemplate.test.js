const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildGeneratedContextMarkdown,
  buildNormalizedRequest,
  buildStoryBeatmap,
  normalizeResumeStage,
  parseTemplateFile
} = require('../server/services/midformRunTemplateService');

function writeTempTemplate(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-template-'));
  const filePath = path.join(dir, 'request.md');
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

test('parseTemplateFile accepts a minimal YAML-front-matter template', () => {
  const templatePath = writeTempTemplate([
    '---',
    'source:',
    '  url: https://youtu.be/example123',
    'output:',
    '  target_length_sec: 160',
    '---',
    '',
    'keep the recap tense'
  ].join('\n'));

  const parsed = parseTemplateFile(templatePath);
  assert.equal(parsed.frontmatter.source.url, 'https://youtu.be/example123');
  assert.equal(parsed.frontmatter.output.target_length_sec, 160);
  assert.equal(parsed.body, 'keep the recap tense');
});

test('buildNormalizedRequest applies overrides and profile defaults', () => {
  const parsedTemplate = {
    templatePath: 'C:/project/template.md',
    frontmatter: {
      source: { url: 'https://youtu.be/from-template' },
      output: { target_length_sec: 150 },
      subtitle_limits: { max_chars: 22 }
    },
    body: 'body notes'
  };

  const normalized = buildNormalizedRequest(parsedTemplate, {
    source: 'https://youtu.be/from-cli',
    profile: 'audit'
  });

  assert.equal(normalized.source.url, 'https://youtu.be/from-cli');
  assert.equal(normalized.profile, 'audit');
  assert.equal(normalized.editorial.subtitle_limits.max_chars, 22);
  assert.equal(normalized.editorial.subtitle_limits.max_units_per_segment, 6);
  assert.equal(normalized.render.preview_frame_proof, true);
});

test('normalizeResumeStage validates supported stages', () => {
  assert.equal(normalizeResumeStage('slot_fill'), 'slot_fill');
  assert.equal(normalizeResumeStage(''), '');
  assert.throws(() => normalizeResumeStage('unknown_stage'), /Unsupported resume stage/);
});

test('buildGeneratedContextMarkdown preserves explicit overrides and body notes', () => {
  const markdown = buildGeneratedContextMarkdown({
    profile: 'production',
    source: { url: 'https://youtu.be/example123' },
    output: { target_length_sec: 180 },
    editorial: {
      tone: 'urgent',
      must_keep: ['opening accusation'],
      prohibitions: ['no spoiler ending'],
      opener_policy: 'incident first',
      callback_required: true,
      spoiler_boundary: 'do not reveal ending before callback',
      subtitle_limits: { max_chars: 18, max_units_per_segment: 6 }
    },
    body_markdown: 'Use a sharp, curiosity-led cold open.'
  });

  assert.match(markdown, /source\.url: https:\/\/youtu\.be\/example123/);
  assert.match(markdown, /opening accusation/);
  assert.match(markdown, /no spoiler ending/);
  assert.match(markdown, /Use a sharp, curiosity-led cold open\./);
});

test('buildStoryBeatmap emits stable beat and timeline structure', () => {
  const beatmap = buildStoryBeatmap(
    {
      profile: 'production',
      source: { url: 'https://youtu.be/example123' },
      output: { target_length_sec: 180 }
    },
    {
      beats: [{ beat_id: 'B001', summary: 'opening clash' }]
    },
    {
      scene_type: 'dialogue_confrontation',
      editorial_pattern: 'cold_open_callback',
      cold_open_selection: { beat_id: 'B001' },
      timeline: [{ slot_id: 'slot_01', decision: 'KEEP_DIALOGUE' }]
    }
  );

  assert.equal(beatmap.artifact_type, 'midform_story_beatmap');
  assert.equal(beatmap.scene_type, 'dialogue_confrontation');
  assert.equal(beatmap.editorial_pattern, 'cold_open_callback');
  assert.equal(beatmap.beats.length, 1);
  assert.equal(beatmap.timeline.length, 1);
});
