const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'midform', 'scripts', 'clip_baseline.js');

function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const manifest = (clips) => ({
  draft_name: 'test',
  segments: clips.map(([id, start, end, speaker]) => ({
    segment_id: id,
    segment_type: 'dialogue_quote',
    speaker: speaker || '남주',
    source_clips: [{ start, end }],
  })),
});

function cli(dir, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: dir });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('an unchanged rebuild passes its baseline', () => {
  withTemp((dir) => {
    const manifestPath = path.join(dir, 'm.json');
    const baselinePath = path.join(dir, 'b.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest([['slot_01_L01', '00:06:36.700', '00:06:39.300']])));
    assert.equal(cli(dir, ['write', manifestPath, baselinePath]).status, 0);
    const { status, out } = cli(dir, ['check', manifestPath, baselinePath]);
    assert.equal(status, 0);
    assert.match(out, /drift 0/);
  });
});

test('a clip that moved is reported and fails', () => {
  // The shape of a silent lineage fallback: the build still passes its gates, but the clips are not
  // the ones that were approved.
  withTemp((dir) => {
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    const baselinePath = path.join(dir, 'b.json');
    fs.writeFileSync(before, JSON.stringify(manifest([['slot_08_L01', '00:06:39.940', '00:06:41.400']])));
    fs.writeFileSync(after, JSON.stringify(manifest([['slot_08_L01', '00:06:39.940', '00:06:46.020']])));
    cli(dir, ['write', before, baselinePath]);
    const { status, out } = cli(dir, ['check', after, baselinePath]);
    assert.equal(status, 1);
    assert.match(out, /DRIFT slot_08_L01/);
  });
});

test('a dropped clip and a new clip are both drift', () => {
  withTemp((dir) => {
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    const baselinePath = path.join(dir, 'b.json');
    fs.writeFileSync(before, JSON.stringify(manifest([['slot_01_L01', '00:00:10.000', '00:00:12.000']])));
    fs.writeFileSync(after, JSON.stringify(manifest([['slot_02_L01', '00:00:20.000', '00:00:22.000']])));
    cli(dir, ['write', before, baselinePath]);
    const { status, out } = cli(dir, ['check', after, baselinePath]);
    assert.equal(status, 1);
    assert.match(out, /slot_01_L01: clip is gone/);
    assert.match(out, /slot_02_L01: new clip/);
  });
});

test('a speaker reassignment is drift even when the range holds', () => {
  // Speaker drives the caption colour, and a collapsed colour has shipped before.
  withTemp((dir) => {
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    const baselinePath = path.join(dir, 'b.json');
    fs.writeFileSync(before, JSON.stringify(manifest([['slot_01_L01', '00:00:10.000', '00:00:12.000', '톰']])));
    fs.writeFileSync(after, JSON.stringify(manifest([['slot_01_L01', '00:00:10.000', '00:00:12.000', '소니']])));
    cli(dir, ['write', before, baselinePath]);
    const { status, out } = cli(dir, ['check', after, baselinePath]);
    assert.equal(status, 1);
    assert.match(out, /speaker 톰 -> 소니/);
  });
});

test('a sub-tolerance rounding difference is not drift', () => {
  withTemp((dir) => {
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    const baselinePath = path.join(dir, 'b.json');
    fs.writeFileSync(before, JSON.stringify(manifest([['slot_01_L01', '00:00:10.000', '00:00:12.000']])));
    fs.writeFileSync(after, JSON.stringify(manifest([['slot_01_L01', '00:00:10.020', '00:00:12.010']])));
    cli(dir, ['write', before, baselinePath]);
    assert.equal(cli(dir, ['check', after, baselinePath]).status, 0);
  });
});
