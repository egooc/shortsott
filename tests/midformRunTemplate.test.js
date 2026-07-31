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
  normalizeBatchManifest,
  normalizeAnalysisMode,
  normalizeResumeStage,
  parseTemplateFile,
  runMidformTemplateAttemptBatch,
  runMidformTemplateAttempts,
  runMidformTemplateBatch,
  _test: { isRetryableBeforeDraftFailure, manualReviewRequiredSummary, selectBestAttempt }
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

test('attempt runner retries pre-draft preflight failure and selects second draft success', async () => {
  const templatePath = writeTempTemplate([
    '---',
    'source:',
    '  url: https://youtu.be/from-template',
    'output:',
    '  target_length_sec: 150',
    '---',
    ''
  ].join('\n'));
  const runSetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-attempt-set-'));
  fs.rmSync(runSetDir, { recursive: true, force: true });
  const calls = [];
  const result = await runMidformTemplateAttempts({
    templatePath,
    source: 'https://youtu.be/retry111111',
    runSetDirOverride: runSetDir,
    runner: async ({ attempt, workspaceDirOverride }) => {
      calls.push({ attempt, workspaceDirOverride });
      fs.mkdirSync(workspaceDirOverride, { recursive: true });
      const summary = attempt === 1
        ? {
            status: 'failed',
            workspace_dir: workspaceDirOverride,
            failure_reason: { code: 'MIDFORM_BOOTSTRAP_PREFLIGHT_FAILED', message: 'Bootstrap preflight failed' },
            output_paths: {}
          }
        : {
            status: 'passed',
            workspace_dir: workspaceDirOverride,
            output_paths: { draft_folder_ko: path.join(workspaceDirOverride, 'draft_ko'), draft_folder_ja: path.join(workspaceDirOverride, 'draft_ja') }
          };
      fs.writeFileSync(path.join(workspaceDirOverride, 'run_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      return summary;
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(result.selected_attempt.selected_attempt, 2);
  assert.equal(result.selected_attempt.selection_reason, 'passed');
  assert.equal(fs.existsSync(path.join(runSetDir, 'attempt_1', 'run_summary.json')), true);
  assert.equal(fs.existsSync(path.join(runSetDir, 'attempt_2', 'run_summary.json')), true);
  assert.equal(fs.existsSync(path.join(runSetDir, 'delivery_package', 'run_summary.json')), true);
  assert.equal(fs.existsSync(path.join(runSetDir, 'delivery_package', 'selected_attempt.json')), true);
});

test('attempt selection prefers draft-bearing failed attempt over later draftless failure', () => {
  const attemptOneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-draft-bearing-'));
  fs.mkdirSync(path.join(attemptOneDir, 'draft_ko'), { recursive: true });
  fs.mkdirSync(path.join(attemptOneDir, 'draft_ja'), { recursive: true });
  const selected = selectBestAttempt([
    {
      attempt: 1,
      summary: {
        status: 'failed',
        workspace_dir: attemptOneDir,
        failure_reason: { code: 'MIDFORM_DETERMINISTIC_INTEGRITY_FAILED' },
        output_paths: { draft_folder_ko: path.join(attemptOneDir, 'draft_ko'), draft_folder_ja: path.join(attemptOneDir, 'draft_ja') }
      }
    },
    {
      attempt: 2,
      summary: {
        status: 'failed',
        failure_reason: { code: 'MIDFORM_BOOTSTRAP_PREFLIGHT_FAILED' },
        output_paths: {}
      }
    }
  ]);

  assert.equal(selected.attempt, 1);
  assert.equal(selected.selectionReason, 'physical_drafts_available');
});

test('attempt runner preserves two draftless failed attempts and reports final failure', async () => {
  const templatePath = writeTempTemplate([
    '---',
    'source:',
    '  url: https://youtu.be/from-template',
    'output:',
    '  target_length_sec: 150',
    '---',
    ''
  ].join('\n'));
  const runSetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-attempt-failed-'));
  fs.rmSync(runSetDir, { recursive: true, force: true });
  const result = await runMidformTemplateAttempts({
    templatePath,
    source: 'https://youtu.be/failonly111',
    runSetDirOverride: runSetDir,
    runner: async ({ attempt, workspaceDirOverride }) => {
      fs.mkdirSync(workspaceDirOverride, { recursive: true });
      return {
        status: 'failed',
        workspace_dir: workspaceDirOverride,
        failure_reason: attempt === 1
          ? { code: 'MIDFORM_BOOTSTRAP_PREFLIGHT_FAILED', message: 'preflight failed' }
          : { code: 'MIDFORM_TEMPLATE_VALIDATION_FAILED', message: 'template validation failed' },
        output_paths: {}
      };
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.attempts.length, 2);
  assert.equal(fs.existsSync(path.join(runSetDir, 'attempt_1', 'run_summary.json')), true);
  assert.equal(fs.existsSync(path.join(runSetDir, 'attempt_2', 'run_summary.json')), true);
});

test('attempt runner refuses to overwrite an existing attempt run folder', async () => {
  const templatePath = writeTempTemplate([
    '---',
    'source:',
    '  url: https://youtu.be/from-template',
    'output:',
    '  target_length_sec: 150',
    '---',
    ''
  ].join('\n'));
  const runSetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-attempt-existing-'));

  await assert.rejects(
    () => runMidformTemplateAttempts({
      templatePath,
      source: 'https://youtu.be/existing111',
      runSetDirOverride: runSetDir,
      runner: async () => ({ status: 'passed', output_paths: {} })
    }),
    /Attempt run folder already exists/
  );
});

test('attempt batch manifest continues after one URL failure and does not invent sources', async () => {
  const calls = [];
  const manifest = normalizeBatchManifest({
    urls: ['https://youtu.be/fail1111111', 'https://youtu.be/pass2222222'],
    max_attempts_per_url: 2,
    continue_on_failure: true,
    template_path: 'template.md'
  });
  const result = await runMidformTemplateAttemptBatch({
    manifest,
    runner: async ({ source }) => {
      calls.push(source);
      if (/fail/.test(source)) throw Object.assign(new Error('item failed'), { code: 'ITEM_FAILED' });
      return { status: 'passed', source_url: source };
    }
  });

  assert.deepEqual(calls, ['https://youtu.be/fail1111111', 'https://youtu.be/pass2222222']);
  assert.equal(result.status, 'completed');
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[1].status, 'passed');
});

test('retry policy only retries transient pre-draft failures', () => {
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'MIDFORM_BOOTSTRAP_PREFLIGHT_FAILED' }, output_paths: {} }), true);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { message: 'edit plan is missing bridge role' }, output_paths: {} }), true);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'MIDFORM_TEMPLATE_VALIDATION_FAILED', message: 'template validation failed' }, output_paths: {} }), true);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'VERTEX_DNS_FAILED' }, output_paths: {} }), true);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'SUBTITLE_NOT_FOUND' }, output_paths: {} }), false);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'YTDLP_DOWNLOAD_FAILED' }, output_paths: {} }), false);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'SOURCE_VIDEO_NOT_FOUND' }, output_paths: {} }), false);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'DIALOGUE_SOURCE_REFERENCE_MISMATCH' }, output_paths: {} }), false);
  assert.equal(isRetryableBeforeDraftFailure({ status: 'failed', failure_reason: { code: 'MIDFORM_ACCEPTANCE_FAILED' }, output_paths: { draft_folder_ko: 'draft_ko' } }), false);
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
