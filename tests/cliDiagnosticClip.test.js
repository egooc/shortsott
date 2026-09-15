'use strict';

// A CLI puts its verdict on the last line. Codex echoes the whole prompt to stderr first, so
// clipping from the front keeps the prompt and throws away the reason. On 2026-09-15 a run died
// on "You've hit your usage limit ... try again at 8:01 PM" and the captured stderr ended
// mid-prompt at "All of upload_tex" - so nightly-batch's quota guard, which reads exactly that
// text, returned false on a real quota exhaustion.

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = path.join(__dirname, '..', 'server', 'services', 'gptMidformCliService.js');
const source = fs.readFileSync(SERVICE, 'utf8');
const clipDiagnostic = new Function(
  `${source.slice(source.indexOf('function clipDiagnostic('), source.indexOf('function runCodexCli('))}; return clipDiagnostic;`
)();

const QUOTA_LINE = "ERROR: You've hit your usage limit. Upgrade to Pro, or try again at 8:01 PM.";

test('short output is returned whole', () => {
  assert.strictEqual(clipDiagnostic('short'), 'short');
  assert.strictEqual(clipDiagnostic(''), '');
  assert.strictEqual(clipDiagnostic(null), '');
});

test('the verdict survives a prompt echo that overflows the limit', () => {
  const stderr = `OpenAI Codex v0.149.1\n${'프롬프트 규칙 '.repeat(2000)}\n${QUOTA_LINE}`;
  assert.ok(stderr.length > 4000);
  assert.ok(!/usage limit/i.test(stderr.slice(0, 4000)), 'the old head-clip loses it');
  assert.ok(/usage limit/i.test(clipDiagnostic(stderr)), 'the tail-clip keeps it');
});

test('enough of the head survives to identify the tool', () => {
  const stderr = `OpenAI Codex v0.149.1\n${'x'.repeat(50000)}\n${QUOTA_LINE}`;
  const clipped = clipDiagnostic(stderr);
  assert.ok(clipped.startsWith('OpenAI Codex v0.149.1'));
  assert.ok(/omitted/.test(clipped), 'the clip says that it clipped');
});

test('the clip stays within its budget', () => {
  const clipped = clipDiagnostic('y'.repeat(100000), 2000);
  assert.ok(clipped.length < 2000 + 80, `got ${clipped.length}`);
});

test('the nightly quota guard fires on the clipped text', () => {
  const nightly = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'nightly-batch.js'), 'utf8');
  const { isQuotaExhausted, failureWhy } = new Function(
    `${nightly.slice(nightly.indexOf('const QUOTA_EXHAUSTED'), nightly.indexOf('function isFillsRegenerable'))}; return { isQuotaExhausted, failureWhy };`
  )();
  const stderr = `OpenAI Codex v0.149.1\n${'프롬프트 규칙 '.repeat(2000)}\n${QUOTA_LINE}`;
  const headClipped = { failure_reason: { details: { stderr: stderr.slice(0, 4000) } } };
  const tailClipped = { failure_reason: { details: { stderr: clipDiagnostic(stderr) } } };
  assert.strictEqual(isQuotaExhausted(headClipped), false, 'this is the bug that shipped');
  assert.strictEqual(isQuotaExhausted(tailClipped), true);
  assert.match(failureWhy(tailClipped), /usage limit/i);
});
