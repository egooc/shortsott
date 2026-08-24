#!/usr/bin/env node
'use strict';

// What colour each character has ALREADY SHIPPED in, and whether the next cut would change it.
//
// The palette is eight colours (four roles, four fallbacks) shared by 155 registered speakers, so
// colour identifies a ROLE, not a person. That is a deliberate design, but it means every edit to
// caption_colors.json silently repaints a character in every future cut, and nothing compared the
// result against what the channel already published. Measured across the installed drafts:
// 제이콥 shipped #37FF3D on 2026-08-22 and #4DDCCB on 2026-08-24 (a real fix - six men were
// colliding on 남조연 - but an invisible one), and 프랭키 moved #FF8A5C -> #B48CFF when I
// registered him. A viewer sees the same character change colour between videos.
//
// This does not decide whether colour should follow the role or the person. It records what
// shipped and reports what would change, so the decision is made on purpose rather than by
// accident.
//
//   node midform/scripts/speaker_color_ledger.js check [--drafts <dir>] [--workspace <dir>]
//   node midform/scripts/speaker_color_ledger.js record [--drafts <dir>] [--accept <name,...>]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'midform', 'config', 'speaker_color_ledger.json');
const COLORS_PATH = path.join(ROOT, 'midform', 'config', 'caption_colors.json');
const DEFAULT_DRAFTS = 'C:/midform_drafts';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function roleNameFor(color) {
  const cfg = readJson(COLORS_PATH, {});
  const all = { ...(cfg.roles || {}), ...(cfg.fallback_roles || {}) };
  return Object.entries(all).find(([, value]) => value === color)?.[0] || '';
}

// One colour per speaker per draft: the first caption wins, which is what the viewer meets first.
function speakerColorsInDraft(draftDir) {
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return null;
  const found = new Map();
  for (const row of manifest.segments || []) {
    if (row.caption_kind !== 'dialogue') continue;
    const name = String(row.speaker || '').trim();
    const color = String(row.caption_color || '').trim();
    if (!name || !color || found.has(name)) continue;
    found.set(name, color);
  }
  return found;
}

function collectFromDrafts(draftsDir) {
  const out = new Map(); // name -> Map(color -> draft names)
  if (!fs.existsSync(draftsDir)) return out;
  for (const entry of fs.readdirSync(draftsDir)) {
    const colors = speakerColorsInDraft(path.join(draftsDir, entry));
    if (!colors) continue;
    for (const [name, color] of colors) {
      if (!out.has(name)) out.set(name, new Map());
      const byColor = out.get(name);
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(entry);
    }
  }
  return out;
}

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadLedger() {
  return readJson(LEDGER_PATH, { speakers: {}, updated_at: '' });
}

function check() {
  const ledger = loadLedger();
  const draftsDir = argValue('--drafts', DEFAULT_DRAFTS);
  const workspace = argValue('--workspace', '');

  // A workspace check looks at one pending cut; without it, audit everything installed.
  const observed = workspace
    ? (() => {
      const out = new Map();
      for (const loc of ['ko', 'ja']) {
        const colors = speakerColorsInDraft(path.join(workspace, `draft_${loc}`));
        if (!colors) continue;
        for (const [name, color] of colors) {
          if (!out.has(name)) out.set(name, new Map());
          if (!out.get(name).has(color)) out.get(name).set(color, []);
          out.get(name).get(color).push(`draft_${loc}`);
        }
      }
      return out;
    })()
    : collectFromDrafts(draftsDir);

  // A colour that differs from the ledger is only a PROBLEM when it is about to ship. An already
  // published cut carrying the old colour is history: the ledger records that the palette moved,
  // and re-flagging it every run would train everyone to ignore this check. So a difference is
  // drift only when the ledger has never recorded that colour as shipped.
  const drift = [];
  const history = [];
  const unseen = [];
  for (const [name, byColor] of observed) {
    const known = ledger.speakers?.[name];
    const colors = [...byColor.keys()];
    if (!known) { unseen.push({ name, colors }); continue; }
    const shipped = new Set([known.color, ...(known.shipped_colors || [])]);
    for (const color of colors) {
      if (color === known.color) continue;
      const where = byColor.get(color);
      if (shipped.has(color)) history.push({ name, color, where });
      else drift.push({ name, was: known.color, now: [color], where });
    }
  }

  console.log(`ledger ${Object.keys(ledger.speakers || {}).length} speakers | observed ${observed.size}`);
  if (drift.length) {
    console.log(`\nCOLOUR CHANGED for ${drift.length} speaker(s) - they already shipped in another colour:`);
    for (const d of drift) {
      console.log(`  ${d.name}`);
      console.log(`     shipped ${d.was} ${roleNameFor(d.was) ? `(${roleNameFor(d.was)})` : ''}`);
      for (const c of d.now) console.log(`     now     ${c} ${roleNameFor(c) ? `(${roleNameFor(c)})` : ''}  in ${d.where.join(', ')}`);
    }
    console.log('\nIf the change is deliberate, accept it: speaker_color_ledger.js record --accept "<name>"');
  } else {
    console.log('\nno colour changed against the ledger');
  }
  if (history.length) {
    console.log(`\nalready-published cuts still carrying a previous colour (${history.length}) - history, not a problem:`);
    for (const h of history) console.log(`  ${h.name} ${h.color} in ${h.where.join(', ')}`);
  }
  if (unseen.length) {
    console.log(`\nnot in the ledger yet (${unseen.length}): ${unseen.map((u) => `${u.name}=${u.colors.join('/')}`).join(', ')}`);
  }
  process.exitCode = drift.length ? 1 : 0;
}

function record() {
  const ledger = loadLedger();
  ledger.speakers = ledger.speakers || {};
  const draftsDir = argValue('--drafts', DEFAULT_DRAFTS);
  const accept = new Set(String(argValue('--accept', '')).split(',').map((s) => s.trim()).filter(Boolean));
  const observed = collectFromDrafts(draftsDir);

  let added = 0;
  let updated = 0;
  const conflicts = [];
  for (const [name, byColor] of observed) {
    const colors = [...byColor.entries()].sort((a, b) => b[1].length - a[1].length);
    const [topColor, drafts] = colors[0];
    const known = ledger.speakers[name];
    if (!known) {
      ledger.speakers[name] = {
        color: topColor,
        role: roleNameFor(topColor),
        shipped_colors: colors.map(([c]) => c),
        first_seen: drafts[0],
        updated_at: new Date().toISOString()
      };
      added += 1;
      if (colors.length > 1) conflicts.push(`${name}: shipped in ${colors.length} colours, recorded the most common (${topColor})`);
      continue;
    }
    if (known.color !== topColor && accept.has(name)) {
      const shipped = new Set([...(known.shipped_colors || []), known.color, topColor]);
      ledger.speakers[name] = {
        ...known,
        color: topColor,
        role: roleNameFor(topColor),
        shipped_colors: [...shipped],
        updated_at: new Date().toISOString()
      };
      updated += 1;
    }
  }
  ledger.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  console.log(`ledger written: ${Object.keys(ledger.speakers).length} speakers (+${added} new, ${updated} accepted)`);
  for (const c of conflicts) console.log(`  ! ${c}`);
}

const cmd = process.argv[2];
if (cmd === 'check') check();
else if (cmd === 'record') record();
else {
  console.error('usage: speaker_color_ledger.js <check|record> [--drafts <dir>] [--workspace <dir>] [--accept "<name>"]');
  process.exitCode = 2;
}
