const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertCodexLoginStatus } = require('../server/services/gptMidformCliService');
const {
  normalizeMultimodalProvider,
  runMidformMultimodalReview,
  shouldRunMultimodalReview,
  _test: { classifyVertexError, parseReviewJson }
} = require('../server/services/midformMultimodalReviewService');

function baseContext(workspaceDir) {
  return {
    workspaceDir,
    normalizedRequest: {
      profile: 'production',
      source: { url: 'https://youtu.be/abcdefghijk' },
      output: { target_length_sec: 160 }
    },
    finalPipelineState: { runId: 'pipe-1', runDir: 'C:/runs/pipe-1' },
    autoDecision: {
      reason_codes: ['gate:first_30_conflict_clarity:weak_clarity'],
      relevant_gate_failures: [{ gate_id: 'first_30_conflict_clarity', reason: 'weak_clarity' }]
    }
  };
}

test('multimodal provider defaults to vertex and validates supported values', () => {
  assert.equal(normalizeMultimodalProvider(''), 'vertex');
  assert.equal(normalizeMultimodalProvider('vertex'), 'vertex');
  assert.equal(normalizeMultimodalProvider('gpt_cli'), 'gpt_cli');
  assert.equal(normalizeMultimodalProvider('disabled'), 'disabled');
  assert.equal(normalizeMultimodalProvider('unknown'), 'vertex');
});

test('passed required gates do not call any multimodal provider', () => {
  const shouldReview = shouldRunMultimodalReview({
    provider: 'vertex',
    qa: { gateResults: { status: 'passed', failed: [], warnings: [] } },
    localeDrafts: { finalOverlapReport: { final_status: 'pass' } },
    autoDecision: { relevant_gate_failures: [], relevant_quality_warnings: [{ code: 'TRANSCRIPT_GROUNDING_WEAK' }] }
  });
  assert.equal(shouldReview, false);
});

test('failed required gates trigger provider review even without old escalation reason codes', () => {
  const shouldReview = shouldRunMultimodalReview({
    provider: 'vertex',
    qa: { gateResults: { status: 'failed', failed: ['rendered_speaker_color_match'], warnings: [] } },
    localeDrafts: { finalOverlapReport: { final_status: 'pass' } },
    autoDecision: { relevant_gate_failures: [], relevant_quality_warnings: [] }
  });
  assert.equal(shouldReview, true);
});

test('provider=vertex records structured successful review without GPT CLI', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-review-vertex-'));
  fs.writeFileSync(path.join(workspaceDir, 'evidence_pack.json'), '{"coverage":true}\n', 'utf8');
  const context = baseContext(workspaceDir);
  let vertexCalled = 0;
  let gptCalled = 0;
  const review = await runMidformMultimodalReview({
    ...context,
    provider: 'vertex',
    required: true,
    qa: { gateResults: { status: 'failed', failed: ['first_30_conflict_clarity'], warnings: [] } },
    localeDrafts: { finalOverlapReport: { final_status: 'pass' } },
    options: {
      vertexReview: async () => {
        vertexCalled += 1;
        return { result: { status: 'pass', findings: ['reviewed'], required_repairs: [], confidence: 0.8 }, stdout: '{"status":"pass"}', stderr: '', report: { provider: 'vertex' } };
      },
      gptReview: async () => {
        gptCalled += 1;
        throw new Error('GPT should not be called');
      }
    }
  });

  assert.equal(vertexCalled, 1);
  assert.equal(gptCalled, 0);
  assert.equal(review.status, 'completed');
  assert.equal(review.result.status, 'pass');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'multimodal_review_report.json')), true);
});

test('optional Vertex failure is representable as provider failure artifact without deleting drafts', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-review-optional-fail-'));
  fs.writeFileSync(path.join(workspaceDir, 'edit_manifest.json'), '{"kept":true}\n', 'utf8');
  const context = baseContext(workspaceDir);
  const review = await runMidformMultimodalReview({
    ...context,
    provider: 'vertex',
    required: false,
    qa: { gateResults: { status: 'passed', failed: [], warnings: [] } },
    localeDrafts: { finalOverlapReport: { final_status: 'pass' } },
    options: {
      vertexReview: async () => {
        const error = new Error('ADC missing');
        error.status = 401;
        error.code = 'VERTEX_AUTH_FAILED';
        throw error;
      }
    }
  });

  assert.equal(review.status, 'failed');
  assert.equal(review.error.code, 'VERTEX_AUTH_FAILED');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'edit_manifest.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'multimodal_review_report.json')), true);
});

test('provider=disabled skips review and leaves core pipeline artifacts untouched', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-review-disabled-'));
  fs.writeFileSync(path.join(workspaceDir, 'draft_input.json'), '{"draft":true}\n', 'utf8');
  const context = baseContext(workspaceDir);
  const review = await runMidformMultimodalReview({
    ...context,
    provider: 'disabled',
    required: true,
    qa: { gateResults: { status: 'failed', failed: ['first_30_conflict_clarity'], warnings: [] } },
    localeDrafts: { finalOverlapReport: { final_status: 'pass' } }
  });

  assert.equal(review.status, 'skipped');
  assert.equal(review.provider, 'disabled');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_input.json')), true);
});

test('provider=gpt_cli authentication preflight reports explicit auth failure', () => {
  assert.throws(
    () => assertCodexLoginStatus({
      baseCommand: { command: process.execPath, argsPrefix: ['-e', 'process.exit(1)'] },
      timeoutMs: 5000
    }),
    (error) => error.code === 'GPT_CLI_AUTH_FAILED' && /codex login/.test(error.message)
  );
});

test('Vertex error classifier and review JSON parser expose expected failure codes', () => {
  assert.equal(classifyVertexError({ status: 401, message: 'unauthorized' }), 'VERTEX_AUTH_FAILED');
  assert.equal(classifyVertexError({ status: 404, message: 'model not found' }), 'VERTEX_MODEL_UNAVAILABLE');
  assert.equal(classifyVertexError({ status: 408, message: 'timeout' }), 'VERTEX_TIMEOUT');
  assert.throws(() => parseReviewJson('{"status":"pass"}', 'vertex'), (error) => error.code === 'VERTEX_SCHEMA_FAILED');
});
