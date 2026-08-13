// Channel-level memory for the daily harvest (approved 2026-08-13).
//
// Why: the eligibility gate rejects narration-led TV documentaries one video
// at a time, but they arrive in clusters because a whole channel produces
// them ("How It's Made" style). Meanwhile the sources that DO pass cluster
// just as hard - the two survivors of the 2026-08-13 batches were both from
// the same Taiwanese factory channel. Remembering the channel turns both
// facts into leverage: stop paying download+probe cost on channels that keep
// failing, and keep mining channels that keep working.
//
// Two-sided ledger:
//   blocked  - skipped >= BLOCK_AFTER_SKIPS and never produced an ok source
//   asset    - produced at least one ok source, not blocked, not exhausted
//
// An asset channel is "exhausted" once a back-catalogue sweep turns up no new
// qualifying video; the harvest then falls back to keyword search, which is
// how the next asset channel gets discovered in the first place.
//
// Blocking is deliberately reversible: every decision keeps its counts and
// reasons so `npm run channels:report` can show why, and clearing a channel
// is a single edit.

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'source_channel_ledger.json');

// One bad video can appear on an otherwise good channel, so a single gate
// failure is not a pattern. Two is.
const BLOCK_AFTER_SKIPS = 2;

function emptyLedger() {
  return { created_at: new Date().toISOString(), channels: {} };
}

function loadChannelLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyLedger();
    if (!parsed.channels || typeof parsed.channels !== 'object') parsed.channels = {};
    return parsed;
  } catch (error) {
    return emptyLedger();
  }
}

function saveChannelLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

// Channel names are the only identifier that survives the whole pipeline
// today (harvest -> item_config.creator), so normalize rather than assume an
// id is present. channel_id is recorded when available for later migration.
function channelKey(creator) {
  return String(creator || '').trim().toLowerCase();
}

function ensureEntry(ledger, creator) {
  const key = channelKey(creator);
  if (!key) return null;
  if (!ledger.channels[key]) {
    ledger.channels[key] = {
      creator: String(creator).trim(),
      channel_id: '',
      channel_url: '',
      ok: 0,
      skipped: 0,
      last_ok_at: '',
      last_skip_at: '',
      skip_reasons: [],
      ok_video_ids: [],
      exhausted_at: ''
    };
  }
  return ledger.channels[key];
}

/**
 * Record how one harvested source turned out for its channel.
 * outcome: 'ok' (passed the gate and produced usable analysis) | 'skipped'
 * Fail-soft by design: ledger bookkeeping must never break a batch.
 */
function recordChannelOutcome({ creator, channelId = '', channelUrl = '', videoId = '', outcome, reasons = [] } = {}) {
  try {
    if (!channelKey(creator)) return null;
    const ledger = loadChannelLedger();
    const entry = ensureEntry(ledger, creator);
    if (!entry) return null;

    if (channelId && !entry.channel_id) entry.channel_id = String(channelId);
    if (channelUrl && !entry.channel_url) entry.channel_url = String(channelUrl);

    const now = new Date().toISOString();
    if (outcome === 'ok') {
      entry.ok += 1;
      entry.last_ok_at = now;
      // A channel that produces again is no longer exhausted.
      entry.exhausted_at = '';
      if (videoId && !entry.ok_video_ids.includes(videoId)) {
        entry.ok_video_ids.push(videoId);
        if (entry.ok_video_ids.length > 50) entry.ok_video_ids.shift();
      }
    } else if (outcome === 'skipped') {
      entry.skipped += 1;
      entry.last_skip_at = now;
      for (const reason of reasons.slice(0, 3)) {
        const text = String(reason).slice(0, 160);
        if (!entry.skip_reasons.includes(text)) entry.skip_reasons.push(text);
      }
      if (entry.skip_reasons.length > 10) entry.skip_reasons = entry.skip_reasons.slice(-10);
    }

    saveChannelLedger(ledger);
    return entry;
  } catch (error) {
    return null;
  }
}

// A channel that has ever produced a usable source is never blocked - the
// point is to drop channels that only ever cost us download+probe time.
function isChannelBlocked(creator, ledger = loadChannelLedger()) {
  const entry = ledger.channels[channelKey(creator)];
  if (!entry) return false;
  return entry.ok === 0 && entry.skipped >= BLOCK_AFTER_SKIPS;
}

function blockedChannels(ledger = loadChannelLedger()) {
  return Object.values(ledger.channels)
    .filter((entry) => entry.ok === 0 && entry.skipped >= BLOCK_AFTER_SKIPS)
    .sort((a, b) => b.skipped - a.skipped);
}

function assetChannels(ledger = loadChannelLedger()) {
  return Object.values(ledger.channels)
    .filter((entry) => entry.ok > 0 && !entry.exhausted_at)
    .sort((a, b) => b.ok - a.ok || String(b.last_ok_at).localeCompare(String(a.last_ok_at)));
}

function markChannelExhausted(creator) {
  try {
    const ledger = loadChannelLedger();
    const entry = ledger.channels[channelKey(creator)];
    if (!entry) return false;
    entry.exhausted_at = new Date().toISOString();
    saveChannelLedger(ledger);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  LEDGER_PATH,
  BLOCK_AFTER_SKIPS,
  loadChannelLedger,
  saveChannelLedger,
  recordChannelOutcome,
  isChannelBlocked,
  blockedChannels,
  assetChannels,
  markChannelExhausted,
  channelKey
};
