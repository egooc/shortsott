'use strict';

// A saved login can be dead rather than spent. On 2026-09-15 the rotation switched into an
// account whose auth.json parsed fine and whose `codex login status` said "Logged in using
// ChatGPT", and every request answered 401 token_revoked - the run died at the vision step with
// "GPT CLI exited with code 1". Rotating into a dead login is worse than not rotating: the night
// keeps going and each remaining source pays its download and analysis before failing the same way.

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'codex-accounts.js'), 'utf8');

test('rotate probes a candidate before activating it', () => {
  const rotate = SOURCE.slice(SOURCE.indexOf('function rotate('), SOURCE.indexOf('function markRevoked('));
  assert.ok(/isLive\(entry\.file\)/.test(rotate), 'a candidate must be probed');
  assert.ok(rotate.indexOf('isLive') < rotate.indexOf('activate(entry)'),
    'the probe must come before activation, not after');
  assert.ok(/markRevoked\(entry\.accountId\)/.test(rotate),
    'a dead candidate must be recorded so the next rotation skips it');
});

test('a revoked login is parked, not merely cooled off', () => {
  const revoked = SOURCE.slice(SOURCE.indexOf('function markRevoked('));
  assert.ok(/revoked: true/.test(revoked), 'the state must distinguish revoked from spent');
  assert.ok(/365 \* 24 \* 60 \* 60 \* 1000/.test(revoked),
    'waiting does not revive a revoked token, so it must not come back in a day');
});

test('the probe treats only a server rejection as death', () => {
  const live = SOURCE.slice(SOURCE.indexOf('function isLive('), SOURCE.indexOf('function activate('));
  assert.ok(/token_revoked\|refresh_token_invalidated/.test(live));
  assert.ok(/401 Unauthorized\|auth error: 401/.test(live));
  assert.ok(/return true;\s*\n\s*} catch \{\s*\n\s*return true;/.test(live.replace(/\r/g, '')),
    'a local failure must not retire a good login');
  assert.ok(/timeout: 25000/.test(live), 'a slow network must time out rather than hang the night');
});

test('the probe actually spawns - a shim that cannot start is the silent failure', () => {
  const live = SOURCE.slice(SOURCE.indexOf('function isLive('), SOURCE.indexOf('function activate('));
  // .cmd needs a shell on Windows; without it the spawn ENOENTs and every login reads "live".
  assert.ok(/codex\.cmd exec --sandbox read-only -/.test(live), 'the Windows shim must be named');
  assert.ok(/shell: true/.test(live));
  assert.ok(!/spawnSync\(command,\s*\[/.test(live),
    'no argv array alongside shell:true - the command is one fixed string with no interpolation');
});

test('isLive tells the two real saved logins apart', { skip: !fs.existsSync(
  path.join(process.env.CODEX_HOME || '', 'accounts')) }, () => {
  const { listAccounts, isLive } = require('../scripts/codex-accounts');
  const accounts = listAccounts();
  if (accounts.length < 2) return;
  const verdicts = accounts.map((entry) => isLive(entry.file));
  assert.ok(verdicts.some((v) => v === true), 'at least one saved login must probe live');
});
