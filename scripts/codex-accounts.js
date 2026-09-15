'use strict';

// Swap the active Codex login when the one in use runs out of allowance.
//
// The night of 2026-09-13 lost 51 sources to a single exhausted account: every one paid for its
// download and analysis first, 40 to 57 minutes each, and the report said only "GPT CLI exited
// with code 1". Stopping the night (nightly-batch's quota guard) keeps the clock from being burnt,
// but it still gives up the whole window. If another login is on file, use it.
//
// Accounts live as copies of ~/.codex/auth.json under ~/.codex/accounts/<name>.json. Put one there
// with:
//
//     node scripts/codex-accounts.js save <name>      # snapshot the login in use right now
//     node scripts/codex-accounts.js list             # what is on file, and what is spent
//     node scripts/codex-accounts.js use <name>       # switch by hand
//
// An exhausted account is remembered with the reset time the provider stated, so a rotation does
// not hand back a login that is still spent. State lives beside the accounts, not in the repo.

const fs = require('fs');
const os = require('os');
const path = require('path');

// codex honours CODEX_HOME; this machine sets it to an orca-managed directory, and a hardcoded
// ~/.codex reads a file the CLI never touches - which is exactly how a login that had already
// succeeded got reported as "not changed" (2026-09-15).
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AUTH_PATH = path.join(CODEX_DIR, 'auth.json');
const ACCOUNTS_DIR = path.join(CODEX_DIR, 'accounts');
const STATE_PATH = path.join(ACCOUNTS_DIR, '.rotation-state.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function accountIdOf(auth) {
  return String(auth?.tokens?.account_id || auth?.account_id || '');
}

function listAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs.readdirSync(ACCOUNTS_DIR)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => {
      const file = path.join(ACCOUNTS_DIR, name);
      const auth = readJson(file, null);
      return { name: name.replace(/\.json$/, ''), file, accountId: accountIdOf(auth), ok: !!auth };
    })
    .filter((entry) => entry.ok)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function currentAccountId() {
  return accountIdOf(readJson(AUTH_PATH, null));
}

// "Sep 19th, 2026 5:09 PM" - the wording the provider actually used. Anything unparseable becomes a
// 24h cool-off rather than a permanent write-off, because a wrong "never" is worse than a wrong wait.
function parseResetAt(text) {
  const match = /try again (?:at|in)\s+([^.\n]+)/i.exec(String(text || ''));
  if (match) {
    const cleaned = match[1].replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
    const parsed = Date.parse(cleaned);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function loadState() {
  const state = readJson(STATE_PATH, {});
  return state && typeof state === 'object' ? state : {};
}

function isSpent(state, accountId) {
  const until = state[accountId]?.exhausted_until;
  return !!until && Date.parse(until) > Date.now();
}

function markExhausted(accountId, failureText) {
  if (!accountId) return null;
  const state = loadState();
  const until = parseResetAt(failureText);
  state[accountId] = { exhausted_until: until, noted_at: new Date().toISOString() };
  writeJson(STATE_PATH, state);
  return until;
}

function activate(entry) {
  const auth = readJson(entry.file, null);
  if (!auth) throw new Error(`${entry.name}: unreadable account file`);
  if (fs.existsSync(AUTH_PATH)) {
    fs.copyFileSync(AUTH_PATH, path.join(ACCOUNTS_DIR, `.previous-auth.json`));
  }
  writeJson(AUTH_PATH, auth);
  return entry;
}

// The next login on file that is not spent. Returns null when there is nothing left to try, and the
// caller should do what it did before: stop the night.
function rotate(failureText) {
  const spentId = currentAccountId();
  if (spentId) markExhausted(spentId, failureText);
  const state = loadState();
  const next = listAccounts().find((entry) => entry.accountId
    && entry.accountId !== spentId && !isSpent(state, entry.accountId));
  if (!next) return null;
  activate(next);
  return next;
}

function saveCurrent(name) {
  const auth = readJson(AUTH_PATH, null);
  if (!auth) throw new Error(`no login to save at ${AUTH_PATH}`);
  const id = accountIdOf(auth);
  if (!id) throw new Error('the login in use has no account_id - refusing to save it unnamed');
  const file = path.join(ACCOUNTS_DIR, `${name}.json`);
  writeJson(file, auth);
  return { name, file, accountId: id };
}

function describe() {
  const state = loadState();
  const active = currentAccountId();
  return listAccounts().map((entry) => ({
    ...entry,
    active: entry.accountId === active,
    spentUntil: state[entry.accountId]?.exhausted_until || ''
  }));
}

if (require.main === module) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'list') {
    const rows = describe();
    if (!rows.length) {
      console.log(`no accounts on file. Snapshot the current login with:\n  node ${path.relative(process.cwd(), __filename)} save <name>`);
    }
    for (const row of rows) {
      const spent = row.spentUntil && Date.parse(row.spentUntil) > Date.now()
        ? ` spent until ${row.spentUntil}` : '';
      console.log(`${row.active ? '*' : ' '} ${row.name}  ${row.accountId}${spent}`);
    }
    const active = currentAccountId();
    if (active && !rows.some((row) => row.accountId === active)) {
      console.log(`  (the login in use, ${active}, is not saved under any name yet)`);
    }
  } else if (command === 'save') {
    if (!argument) throw new Error('usage: codex-accounts.js save <name>');
    const saved = saveCurrent(argument);
    console.log(`saved ${saved.name} (${saved.accountId}) -> ${saved.file}`);
  } else if (command === 'use') {
    const entry = listAccounts().find((row) => row.name === argument);
    if (!entry) throw new Error(`no account named ${argument}`);
    activate(entry);
    console.log(`active: ${entry.name} (${entry.accountId})`);
  } else {
    console.log('usage: codex-accounts.js <list|save <name>|use <name>>');
  }
}

module.exports = { listAccounts, currentAccountId, rotate, markExhausted, saveCurrent, describe,
  parseResetAt, ACCOUNTS_DIR, AUTH_PATH };
