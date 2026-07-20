const fs = require('fs');
const path = require('path');
const highlightDb = require('../server/services/highlightPatternDbService');
const { getVideoMetadata } = require('../server/utils/ffprobe');

const TRACKB_ROOT = 'C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/trackb';

function durationRangeForGroup(group = '') {
  return String(group || '').toUpperCase() === 'LONG'
    ? { min: 6, max: 10 }
    : { min: 3, max: 5 };
}

function findDraftDirForAssignment(assignment = {}) {
  const root = TRACKB_ROOT;
  if (!fs.existsSync(root)) return '';
  const pairId = String(assignment.pair_id || '').trim();
  const suffix = `_${String(assignment.group_label || '').trim()}_${String(assignment.target_duration_group || '').trim()}`;
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const match = entries.find((name) => name.startsWith(pairId) && name.endsWith(suffix));
  return match ? path.join(root, match) : '';
}

function readManifest(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const produced = highlightDb.listAbAssignments().filter((row) => row.status === 'produced');
  const audited = [];
  const dropped = [];
  for (const row of produced) {
    const dir = findDraftDirForAssignment(row);
    const manifestPath = dir ? path.join(dir, 'edit_manifest.json') : '';
    const manifest = readManifest(manifestPath);
    const renderedTimelineSec = Number(manifest?.actual_timeline_duration_sec || manifest?.target_duration_sec || 0);
    const renderedSourceSec = dir ? Number(getVideoMetadata(path.join(dir, 'video', 'source.mp4')).duration_sec || 0) : 0;
    const expected = durationRangeForGroup(row.target_duration_group);
    const validDuration = renderedTimelineSec >= expected.min && renderedTimelineSec <= expected.max;
    const audit = {
      assignmentId: row.id,
      pairId: row.pair_id,
      groupLabel: row.group_label,
      targetDurationGroup: row.target_duration_group,
      ledgerWindowSec: Number((Number(row.end_sec || 0) - Number(row.start_sec || 0)).toFixed(3)),
      renderedTimelineSec,
      renderedSourceSec,
      expected,
      validDuration,
      manifestPath
    };
    audited.push(audit);
    if (!validDuration) {
      dropped.push(highlightDb.updateAbAssignmentStatus(row.id, {
        status: 'dropped',
        droppedReason: 'invalid_duration_window',
        now: new Date().toISOString()
      }));
    }
  }

  const assignments = highlightDb.listAbAssignments();
  const validPairs = new Map();
  assignments.filter((row) => row.status !== 'dropped').forEach((row) => {
    if (!validPairs.has(row.pair_id)) validPairs.set(row.pair_id, []);
    validPairs.get(row.pair_id).push(row);
  });

  console.log(JSON.stringify({
    audited,
    dropped,
    validPairCount: [...validPairs.entries()].filter(([, rows]) => rows.length === 2).length,
    remainingActiveAssignments: assignments.filter((row) => row.status !== 'dropped').length
  }, null, 2));
}

main();
