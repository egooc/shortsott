const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAutoEscalationDecision,
  buildGeneratedContextMarkdown,
  buildNormalizedRequest,
  buildStoryBeatmap,
  normalizeAnalysisMode,
  normalizeResumeStage,
  parseTemplateFile,
  runMidformTemplateBatch,
  _test: { manualReviewRequiredSummary }
} = require('../server/services/midformRunTemplateService');

function writeTempTemplate(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-template-'));
  const filePath = path.join(dir, 'request.md');
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function baseManualReviewPayload(workspaceDir, gateResults = { status: 'failed', failed: ['first_30_conflict_clarity'], warnings: [], results: [] }) {
  fs.mkdirSync(path.join(workspaceDir, 'draft_ko'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'draft_ja'), { recursive: true });
  return {
    summary: {
      run_id: 'run-manual-review',
      workspace_dir: workspaceDir,
      output_paths: {
        draft_folder_ko: path.join(workspaceDir, 'draft_ko'),
        draft_folder_ja: path.join(workspaceDir, 'draft_ja'),
        template_body_ko: path.join(workspaceDir, 'template_body.ko.md'),
        template_body_ja: path.join(workspaceDir, 'template_body.ja.md'),
        evidence_pack: path.join(workspaceDir, 'evidence_pack.json')
      },
      warnings: []
    },
    qa: {
      gateResults,
      outputPaths: {
        acceptance_gates: path.join(workspaceDir, 'acceptance_gates.json'),
        edit_manifest: path.join(workspaceDir, 'edit_manifest.json')
      }
    },
    localeDrafts: { finalOverlapReport: { final_status: 'pass' } },
    finalPipelineState: { artifacts: { draft: { draftPath: path.join(workspaceDir, 'draft_root') } } },
    analysisRun: { auto_escalation: { provider: 'vertex' } }
  };
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
  assert.equal(normalized.analysis.mode, 'auto');
  assert.equal(normalized.editorial.subtitle_limits.max_chars, 22);
  assert.equal(normalized.editorial.subtitle_limits.max_units_per_segment, 6);
  assert.equal(normalized.render.preview_frame_proof, true);
});

test('buildNormalizedRequest accepts explicit analysis mode from CLI or template', () => {
  const parsedTemplate = {
    templatePath: 'C:/project/template.md',
    frontmatter: {
      analysis_mode: 'compression',
      source: { url: 'https://youtu.be/from-template' },
      output: { target_length_sec: 150 }
    },
    body: ''
  };

  assert.equal(buildNormalizedRequest(parsedTemplate).analysis.mode, 'compression');
  assert.equal(buildNormalizedRequest(parsedTemplate, { analysisMode: 'multimodal' }).analysis.mode, 'multimodal');
  assert.equal(normalizeAnalysisMode('unsupported'), 'auto');
});

test('buildAutoEscalationDecision escalates only multimodal-worthy quality failures', () => {
  const escalated = buildAutoEscalationDecision({
    gateResults: {
      failed: ['high_context_teaser_recovery', 'rendered_speaker_color_match'],
      warnings: ['subtitle_readability']
    },
    pipelineState: { qualityWarnings: [] }
  });
  assert.equal(escalated.should_escalate, true);
  assert.equal(escalated.escalated, true);
  assert.deepEqual(escalated.relevant_gate_failures, [{ gate_id: 'high_context_teaser_recovery', reason: 'high_context' }]);

  const notEscalated = buildAutoEscalationDecision({
    gateResults: {
      failed: ['rendered_speaker_color_match'],
      warnings: ['subtitle_readability']
    },
    pipelineState: { qualityWarnings: [] }
  });
  assert.equal(notEscalated.should_escalate, false);

  const diagnosticOnly = buildAutoEscalationDecision({
    gateResults: {
      failed: ['rebuttal_only_opener', 'dramatic_engagement_timing'],
      warnings: []
    },
    pipelineState: { qualityWarnings: [] }
  });
  assert.equal(diagnosticOnly.should_escalate, false);
  assert.deepEqual(diagnosticOnly.relevant_gate_failures, []);

  const warningEscalated = buildAutoEscalationDecision({
    gateResults: { failed: [], warnings: [] },
    pipelineState: { qualityWarnings: [{ code: 'TRANSCRIPT_GROUNDING_WEAK' }] }
  });
  assert.equal(warningEscalated.should_escalate, true);
});

test('provider failure with deterministic drafts becomes manual_review_required and preserves review artifacts', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-manual-provider-'));
  const payload = baseManualReviewPayload(workspaceDir, {
    status: 'failed',
    failed: ['first_30_conflict_clarity'],
    warnings: [],
    results: [{ id: 'first_30_conflict_clarity', status: 'fail', first_30_sec_text: 'opening needs review' }]
  });
  const summary = manualReviewRequiredSummary({
    ...payload,
    review: {
      provider: 'vertex',
      status: 'failed',
      error: { code: 'VERTEX_DNS_FAILED', message: 'getaddrinfo ENOTFOUND oauth2.googleapis.com', details: {} },
      outputPaths: { multimodal_review_report: path.join(workspaceDir, 'multimodal_review_report.json') }
    },
    reasonCode: 'VERTEX_DNS_FAILED'
  });

  assert.equal(summary.status, 'manual_review_required');
  assert.equal(summary.failure_reason, null);
  assert.equal(summary.manual_review.provider_error.code, 'VERTEX_DNS_FAILED');
  assert.ok(summary.output_paths.draft_folder_ko.endsWith('draft_ko'));
  assert.ok(summary.output_paths.draft_folder_ja.endsWith('draft_ja'));
  assert.equal(fs.existsSync(path.join(workspaceDir, 'manual_review.md')), true);
  assert.match(fs.readFileSync(path.join(workspaceDir, 'manual_review.md'), 'utf8'), /provider_failure_code: VERTEX_DNS_FAILED/);
});

test('provider disabled keeps core draft as manual review instead of deleting artifacts', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-provider-disabled-'));
  const payload = baseManualReviewPayload(workspaceDir);
  const summary = manualReviewRequiredSummary({
    ...payload,
    reasonCode: 'provider_disabled_manual_review',
    reasonMessage: 'Draft generated with provider disabled'
  });

  assert.equal(summary.status, 'manual_review_required');
  assert.equal(summary.manual_review.reason, 'provider_disabled_manual_review');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_ko')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_ja')), true);
});

test('deterministic integrity failure remains a hard fail', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-integrity-fail-'));
  const payload = baseManualReviewPayload(workspaceDir, {
    status: 'failed',
    failed: ['dialogue_speaker_metadata_present'],
    warnings: [],
    results: []
  });
  const summary = manualReviewRequiredSummary({
    ...payload,
    reasonCode: 'VERTEX_PROVIDER_ERROR'
  });

  assert.equal(summary.status, 'failed');
  assert.equal(summary.failure_reason.code, 'MIDFORM_DETERMINISTIC_INTEGRITY_FAILED');
});

test('batch runner continues after one provider failure item', async () => {
  const calls = [];
  const batch = await runMidformTemplateBatch({
    templatePath: 'template.md',
    urls: ['https://youtu.be/fail1111111', 'https://youtu.be/pass2222222'],
    runner: async ({ source }) => {
      calls.push(source);
      if (/fail/.test(source)) {
        const error = new Error('provider failed');
        error.code = 'VERTEX_PROVIDER_ERROR';
        throw error;
      }
      return { status: 'passed', source_url: source };
    }
  });

  assert.deepEqual(calls, ['https://youtu.be/fail1111111', 'https://youtu.be/pass2222222']);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.results[0].status, 'failed');
  assert.equal(batch.results[1].status, 'passed');
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
