const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  extractJson,
  _test: {
    buildGptCliFailureDetails,
    classifyGptCliFailure,
    isRetryableGptCliFailure,
    summarizeCliText
  }
} = require('../server/services/gptMidformCliService');

test('GPT CLI classifier separates schema, auth, binary, timeout, invalid JSON, and transient failures', () => {
  assert.equal(classifyGptCliFailure({ stderr: 'invalid_json_schema: schema must include required properties', exitCode: 1 }), 'GPT_CLI_SCHEMA_FAILED');
  assert.equal(classifyGptCliFailure({ stderr: 'AuthRequired: login required', exitCode: 1 }), 'GPT_CLI_AUTH_FAILED');
  assert.equal(classifyGptCliFailure({ error: { code: 'ENOENT', message: 'spawn codex ENOENT' } }), 'GPT_CLI_BINARY_NOT_FOUND');
  assert.equal(classifyGptCliFailure({ timedOut: true, signal: 'SIGTERM' }), 'GPT_CLI_TIMEOUT');
  assert.equal(classifyGptCliFailure({ stderr: 'rate limit temporarily unavailable', exitCode: 1 }), 'GPT_CLI_PROVIDER_FAILED');
  assert.equal(classifyGptCliFailure({ stdout: '', outputText: '', exitCode: 0 }), 'GPT_CLI_EMPTY_OUTPUT');

  assert.equal(isRetryableGptCliFailure('GPT_CLI_TIMEOUT'), true);
  assert.equal(isRetryableGptCliFailure('GPT_CLI_PROVIDER_FAILED'), true);
  assert.equal(isRetryableGptCliFailure('GPT_CLI_EMPTY_OUTPUT'), true);
  assert.equal(isRetryableGptCliFailure('GPT_CLI_SCHEMA_FAILED'), false);
  assert.equal(isRetryableGptCliFailure('GPT_CLI_AUTH_FAILED'), false);
  assert.equal(isRetryableGptCliFailure('GPT_CLI_BINARY_NOT_FOUND'), false);
});

test('GPT CLI failure details preserve command context and redact sensitive stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-cli-failure-'));
  const promptPath = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptPath, 'prompt body', 'utf8');
  const { code, report, details } = buildGptCliFailureDetails({
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'codex', 'exec', '--model', 'gpt-5.5'],
    promptPath,
    outputPath: path.join(dir, 'missing-output.txt'),
    stderr: 'invalid_json_schema Authorization: Bearer secret-token',
    stdout: 'stdout text',
    exitCode: 1,
    startedAt: Date.now() - 50
  });

  assert.equal(code, 'GPT_CLI_SCHEMA_FAILED');
  assert.equal(report.command, 'cmd.exe');
  assert.equal(report.binary, 'codex');
  assert.equal(report.model, 'gpt-5.5');
  assert.equal(report.exit_code, 1);
  assert.equal(report.input_size_bytes, Buffer.byteLength('prompt body'));
  assert.equal(report.output_exists, false);
  assert.equal(report.stderr_summary.includes('secret-token'), false);
  assert.equal(details.stderr.includes('secret-token'), false);
});

test('extractJson raises explicit invalid JSON and empty output reason codes', () => {
  assert.deepEqual(extractJson('```json\n{"ok": true}\n```'), { ok: true });
  assert.throws(() => extractJson(''), (error) => error.code === 'GPT_CLI_EMPTY_OUTPUT');
  assert.throws(() => extractJson('not json'), (error) => error.code === 'GPT_CLI_INVALID_JSON');
  assert.equal(summarizeCliText('token=secret-value').includes('secret-value'), false);
});
