#!/usr/bin/env node
'use strict';

// Give every character a colour of their own, and never move a character who has already shipped.
//
// Until now colour identified a ROLE: four role colours plus four fallbacks, shared by 155
// speakers. That is why 제이콥 was green in one video and teal in the next - editing his role
// edited his colour. The owner's decision is that colour follows the PERSON, so each name gets
// its own hex written straight into caption_colors.json `speakers`, which resolveCaptionColor
// already honours ahead of any role lookup.
//
// Two constraints pull against each other. Per-person stability wants a fixed colour per name
// forever; legibility limits how many colours are actually distinguishable over video. They only
// truly conflict WITHIN a cut, where 3-6 speakers must differ - across films, two characters
// sharing a colour is invisible. So the palette is built as wide as it can be while staying
// readable, and characters are laid out on it so that people who appear together are far apart.
//
//   node midform/scripts/assign_speaker_colors.js            # dry run
//   node midform/scripts/assign_speaker_colors.js --apply

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COLORS_PATH = path.join(ROOT, 'midform', 'config', 'caption_colors.json');
const LEDGER_PATH = path.join(ROOT, 'midform', 'config', 'speaker_color_ledger.json');
const DRAFTS_DIR = 'C:/midform_drafts';

// Readable over video with the black outline the captions carry. Two lightness bands double the
// hue count without dropping either band into "too dark to read" or "washed out".
const HUE_COUNT = 24;
const LIGHTNESS_BANDS = [0.66, 0.52];
const SATURATION = 0.95;

function hslToHex(hueDeg, saturation, lightness) {
  const hue = ((hueDeg % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
      : hue < 180 ? [0, chroma, secondary]
        : hue < 240 ? [0, secondary, chroma]
          : hue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const channel = (value) => Math.round((value + match) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// Hues in golden-angle order rather than 0,15,30...: consecutive assignments land on opposite
// sides of the wheel, so the characters most likely to share a cut (assigned together) are the
// ones furthest apart.
function buildPalette() {
  const step = 360 / HUE_COUNT;
  const hues = [];
  for (let i = 0; i < HUE_COUNT; i += 1) hues.push(Math.round(((i * 137.508) % 360) / step) * step);
  const seen = new Set();
  const ordered = hues.filter((h) => (seen.has(h) ? false : seen.add(h)));
  for (let h = 0; h < 360; h += step) if (!seen.has(h)) { ordered.push(h); seen.add(h); }
  const palette = [];
  for (const lightness of LIGHTNESS_BANDS) {
    for (const hue of ordered) palette.push(hslToHex(hue, SATURATION, lightness));
  }
  return palette;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

// Who shares a cut with whom - the only place a colour clash is actually visible.
function coAppearance() {
  const pairs = new Map();
  const appearances = new Map();
  if (!fs.existsSync(DRAFTS_DIR)) return { pairs, appearances };
  for (const entry of fs.readdirSync(DRAFTS_DIR)) {
    const m = readJson(path.join(DRAFTS_DIR, entry, 'edit_manifest.json'), null);
    if (!m) continue;
    const cast = new Set();
    for (const row of m.segments || []) {
      if (row.caption_kind !== 'dialogue') continue;
      const name = String(row.speaker || '').trim();
      if (name) cast.add(name);
    }
    for (const a of cast) {
      appearances.set(a, (appearances.get(a) || 0) + 1);
      if (!pairs.has(a)) pairs.set(a, new Set());
      for (const b of cast) if (a !== b) pairs.get(a).add(b);
    }
  }
  return { pairs, appearances };
}

function main() {
  const apply = process.argv.includes('--apply');
  const cfg = readJson(COLORS_PATH, null);
  if (!cfg) { console.error('caption_colors.json unreadable'); process.exitCode = 2; return; }
  const ledger = readJson(LEDGER_PATH, { speakers: {} });
  const palette = buildPalette();
  const { pairs: together, appearances } = coAppearance();

  const names = Object.keys(cfg.speakers || {});
  const assigned = new Map();
  const frozen = [];

  // Already shipped: frozen. Moving them is the exact defect this change exists to stop.
  for (const name of names) {
    const shipped = ledger.speakers?.[name]?.color;
    if (shipped) { assigned.set(name, shipped); frozen.push(name); }
  }

  // ...except when the shipped state itself carries the clash. 재스퍼 and 칼라일 both shipped
  // #37FF3D - they are two of the six men who were sharing 남조연, which is the collision that
  // started all of this. Freezing both would preserve it forever, so the one seen in FEWER
  // published cuts moves: that is the smaller break in what a viewer already remembers.
  const unfroze = [];
  for (const [name, others] of together) {
    for (const other of others) {
      if (name >= other) continue;
      if (!assigned.has(name) || assigned.get(name) !== assigned.get(other)) continue;
      const loser = (appearances.get(name) || 0) <= (appearances.get(other) || 0) ? name : other;
      unfroze.push({ name: loser, was: assigned.get(loser), kept: loser === name ? other : name });
      assigned.delete(loser);
    }
  }

  const used = new Set(assigned.values());
  let cursor = 0;
  const nextFree = (avoid) => {
    for (let i = 0; i < palette.length; i += 1) {
      const c = palette[(cursor + i) % palette.length];
      if (!used.has(c) && !avoid.has(c)) { cursor = (cursor + i + 1) % palette.length; return c; }
    }
    // Palette exhausted: reuse, but never a colour someone in the same cut already has.
    for (let i = 0; i < palette.length; i += 1) {
      const c = palette[(cursor + i) % palette.length];
      if (!avoid.has(c)) { cursor = (cursor + i + 1) % palette.length; return c; }
    }
    return palette[0];
  };

  for (const name of names) {
    if (assigned.has(name)) continue;
    const avoid = new Set();
    for (const other of together.get(name) || []) {
      const c = assigned.get(other);
      if (c) avoid.add(c);
    }
    const color = nextFree(avoid);
    assigned.set(name, color);
    used.add(color);
  }

  // Verify: nobody who shares a cut shares a colour.
  const clashes = [];
  for (const [name, others] of together) {
    for (const other of others) {
      if (name < other && assigned.get(name) && assigned.get(name) === assigned.get(other)) {
        clashes.push(`${name} / ${other} -> ${assigned.get(name)}`);
      }
    }
  }

  console.log(`palette ${palette.length} colours | speakers ${names.length} | frozen ${frozen.length} | distinct ${new Set(assigned.values()).size}`);
  for (const u of unfroze) {
    console.log(`  moved off a shipped colour: ${u.name} (${u.was}) -> ${assigned.get(u.name)} because ${u.kept} shares a cut and appears more often`);
  }
  if (clashes.length) console.log(`CLASH within a cut (${clashes.length}): ${clashes.join(', ')}`);
  else console.log('no two speakers who share a cut share a colour');

  const shipped = new Set(frozen);
  const sample = names.filter((n) => shipped.has(n)).slice(0, 6).concat(names.filter((n) => !shipped.has(n)).slice(0, 6));
  console.log('\nsample:');
  for (const n of sample) console.log(`  ${n.padEnd(12)} ${assigned.get(n)}${shipped.has(n) ? '  (frozen - already shipped)' : ''}`);

  if (!apply) { console.log('\ndry run - pass --apply to write'); return; }
  const next = { ...cfg, speakers: {} };
  for (const name of names) next.speakers[name] = assigned.get(name);
  fs.copyFileSync(COLORS_PATH, `${COLORS_PATH}.bak-per-person`);
  fs.writeFileSync(COLORS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`\nwritten (backup at ${path.basename(COLORS_PATH)}.bak-per-person)`);
}

main();
