// The day's harvest total, shared by everything that harvests.
//
// Sources are now taken a few at a time as the queue drains rather than all at
// midnight (user, 2026-08-17), which means two callers can harvest on the same
// day - the producer topping up, and the daily pipeline seeding. Without a
// shared count they would each work to their own budget and the day would take
// twice what it was planned to.
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'data', 'harvest_daily_state.json');

// LOCAL date, not UTC. The schedule fires at local midnight, so a UTC day
// boundary nine hours later meant the cap was still yesterday's when the new day
// started: at 00:15 local the state read 24/24 and the daily seed harvest was
// skipped as "already done today" (2026-08-18).
function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function readState() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { /* first run */ }
  if (state.date !== today()) return { date: today(), imported: 0 };
  return { date: state.date, imported: Number(state.imported) || 0 };
}

function remainingToday(dailyCap) {
  return Math.max(0, (Number(dailyCap) || 0) - readState().imported);
}

function recordHarvested(count) {
  const state = readState();
  state.imported += Math.max(0, Number(count) || 0);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

module.exports = { readState, remainingToday, recordHarvested, STATE_PATH };
