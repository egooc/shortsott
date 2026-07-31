const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PROJECT_ROOT = path.join(__dirname, '..');
const CAPCUT_DRAFT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'capcut_draft.py');

function runHybridAnalysis(usages) {
  const python = `
import importlib.util, json, sys, types
cc = types.ModuleType("pyCapCut")
sys.modules["pyCapCut"] = cc
sys.modules["pycapcut"] = cc
spec = importlib.util.spec_from_file_location("capcut_draft", ${JSON.stringify(CAPCUT_DRAFT_SCRIPT)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
usages = json.loads(${JSON.stringify(JSON.stringify(usages))})
print(json.dumps(module.analyze_hybrid_source_usages(usages), ensure_ascii=False))
`;
  const result = spawnSync('python', ['-c', python], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function runPlacementUsage(placements) {
  const python = `
import importlib.util, json, sys, types
cc = types.ModuleType("pyCapCut")
sys.modules["pyCapCut"] = cc
sys.modules["pycapcut"] = cc
spec = importlib.util.spec_from_file_location("capcut_draft", ${JSON.stringify(CAPCUT_DRAFT_SCRIPT)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
placements = json.loads(${JSON.stringify(JSON.stringify(placements))})
usages = [module.hybrid_source_usage_from_placement(item, {}) for item in placements]
print(json.dumps({"usages": usages, "report": module.analyze_hybrid_source_usages(usages)}, ensure_ascii=False))
`;
  const result = spawnSync('python', ['-c', python], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('hybrid source validation ignores freeze-frame padding as non-advancing source', () => {
  const payload = runPlacementUsage([
    {
      segment_id: 'slot_01',
      segment_type: 'recap',
      source_start: '00:10.000',
      source_end: '00:12.000',
      timeline_start_sec: 0,
      timeline_end_sec: 2,
      video_duration_sec: 2
    },
    {
      segment_id: 'slot_02',
      segment_type: 'recap',
      source_start: 'freeze_last_frame',
      source_end: 'freeze_last_frame',
      timeline_start_sec: 2,
      timeline_end_sec: 5,
      video_duration_sec: 3
    },
    {
      segment_id: 'slot_03',
      segment_type: 'recap',
      source_start: '00:11.000',
      source_end: '00:13.000',
      timeline_start_sec: 5,
      timeline_end_sec: 7,
      video_duration_sec: 2
    }
  ]);

  assert.equal(payload.usages[1].padding.mode, 'freeze_frame');
  assert.equal(payload.usages[1].source_advances, false);
  assert.equal(payload.report.ignored_non_advancing_usage_count, 1);
  assert.equal(payload.report.status, 'failed');
  assert.equal(payload.report.failures.length, 1);
  assert.equal(payload.report.failures[0].physical_segment_id, 'slot_01');
  assert.equal(payload.report.failures[0].overlapping_counterpart_id, 'slot_03');
});

test('hybrid source validation keeps same source range replay padding as failure', () => {
  const report = runHybridAnalysis([
    {
      physical_segment_id: 'slot_01',
      segment_kind: 'recap',
      dialogue_or_narration: 'narration',
      rendered_source_range: { start_sec: 10, end_sec: 12 },
      planned_source_range: { start_sec: 10, end_sec: 12 },
      padding: { mode: 'none', duration_sec: 0, source_advances: true },
      source_advances: true
    },
    {
      physical_segment_id: 'slot_02',
      segment_kind: 'recap',
      dialogue_or_narration: 'narration',
      rendered_source_range: { start_sec: 10, end_sec: 12 },
      planned_source_range: { start_sec: 10, end_sec: 12 },
      padding: { mode: 'repeat_last', duration_sec: 2, source_advances: true },
      source_advances: true
    }
  ]);

  assert.equal(report.status, 'failed');
  assert.equal(report.failures[0].reason_code, 'HYBRID_ACTUAL_SOURCE_OVERLAP');
  assert.equal(report.failures[0].overlap_duration_sec, 2);
});
