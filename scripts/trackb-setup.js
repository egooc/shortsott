const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const highlightDb = require('../server/services/highlightPatternDbService');
const abExperimentService = require('../server/services/abExperimentService');
const youtubeUploadService = require('../server/services/youtubeUploadService');

const DEFAULT_BASELINE_MEDIAN = 2000;
const SMOKE_PAIR_ID = 'b66150ea-8179-424e-885f-efae49284716';

function nowIso() {
  return new Date().toISOString();
}

function ensureAirpointSingleChannel() {
  const profiles = youtubeUploadService.listYouTubeUploadProfiles();
  const airpoint = (profiles.profiles || []).find((profile) => String(profile.name || '').toLowerCase() === 'airpoint')
    || (profiles.profiles || []).find((profile) => String(profile.channelTitle || '').toUpperCase() === 'AIR POINT');
  if (!airpoint?.channelId) {
    const error = new Error('AIR POINT upload profile was not found in stored YouTube upload profiles.');
    error.code = 'AIRPOINT_CHANNEL_NOT_FOUND';
    throw error;
  }
  highlightDb.upsertExperimentChannel({
    channelId: airpoint.channelId,
    channelName: airpoint.channelTitle || airpoint.name || 'AIR POINT',
    role: 'A',
    baselineMedian: DEFAULT_BASELINE_MEDIAN,
    active: 1,
    now: nowIso()
  });
  highlightDb.setActiveExperimentChannelIds([airpoint.channelId]);
  return {
    channelId: airpoint.channelId,
    channelTitle: airpoint.channelTitle || airpoint.name || 'AIR POINT',
    baselineMedian: DEFAULT_BASELINE_MEDIAN,
    baselineSource: 'fallback_fixed_2000'
  };
}

function excludePair(pairId, reason) {
  const pair = highlightDb.getAbPair(pairId) || [];
  return pair.map((member) => member.status === 'dropped' && member.dropped_reason === reason
    ? member
    : abExperimentService.markDropped(member.id, { reason }));
}

function excludeBrokenAssignedPairs() {
  const assignments = highlightDb.listAbAssignments();
  const byPair = new Map();
  assignments.forEach((row) => {
    if (!row?.pair_id) return;
    if (!byPair.has(row.pair_id)) byPair.set(row.pair_id, []);
    byPair.get(row.pair_id).push(row);
  });
  const excluded = [];
  for (const [pairId, members] of byPair.entries()) {
    const activeMembers = members.filter((member) => member.status !== 'dropped');
    if (activeMembers.length > 0 && activeMembers.length < 2) {
      excluded.push(...excludePair(pairId, 'partial_pair_excluded'));
    }
  }
  return excluded;
}

function excludeInvalidDurationPairs() {
  const assignments = highlightDb.listAbAssignments();
  const byPair = new Map();
  assignments.forEach((row) => {
    if (!row?.pair_id || row.status === 'dropped') return;
    if (!byPair.has(row.pair_id)) byPair.set(row.pair_id, []);
    byPair.get(row.pair_id).push(row);
  });
  const excluded = [];
  for (const [pairId, members] of byPair.entries()) {
    const invalid = members.some((member) => {
      const duration = Number(member.end_sec || 0) - Number(member.start_sec || 0);
      if (member.target_duration_group === 'SHORT') return duration < 3 || duration > 5;
      if (member.target_duration_group === 'LONG') return duration < 6 || duration > 10;
      return true;
    });
    if (invalid) {
      excluded.push(...excludePair(pairId, 'invalid_duration_window'));
    }
  }
  return excluded;
}

function main() {
  const channel = ensureAirpointSingleChannel();
  const smokeExcluded = excludePair(SMOKE_PAIR_ID, 'smoke_test_excluded');
  const partialExcluded = excludeBrokenAssignedPairs();
  const invalidDurationExcluded = excludeInvalidDurationPairs();
  console.log(JSON.stringify({ channel, smokeExcluded, partialExcluded, invalidDurationExcluded }, null, 2));
}

main();
