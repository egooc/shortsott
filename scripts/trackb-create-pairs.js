const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const highlightDb = require('../server/services/highlightPatternDbService');
const highlightSlicerService = require('../server/services/highlightSlicerService');
const abExperimentService = require('../server/services/abExperimentService');

const TARGET_PAIR_COUNT = 30;
const DAILY_LIMIT_DEFAULT = 6;

function parseArgs(argv = []) {
  const options = { limitPairs: DAILY_LIMIT_DEFAULT };
  argv.forEach((arg) => {
    if (arg.startsWith('--limitPairs=')) {
      const value = Number(arg.split('=')[1]);
      options.limitPairs = Number.isFinite(value) ? Math.max(0, value) : DAILY_LIMIT_DEFAULT;
    }
  });
  return options;
}

function experimentPairCount(assignments = []) {
  const byPair = new Map();
  assignments.forEach((row) => {
    if (!row?.pair_id) return;
    if (!byPair.has(row.pair_id)) byPair.set(row.pair_id, []);
    byPair.get(row.pair_id).push(row);
  });
  let count = 0;
  for (const members of byPair.values()) {
    const allDropped = members.length > 0 && members.every((member) => member.status === 'dropped');
    if (allDropped) continue;
    count += 1;
  }
  return count;
}

function chooseReadySources(limitPairs) {
  const all = highlightDb.listAll().items;
  const ready = all.filter((item) => item.analysis_mode === 'slice_source' && item.video_path && Array.isArray(item.segments) && item.segments.length > 0);
  const usedSourceIds = new Set(highlightDb.listAbAssignments().filter((row) => row.status !== 'dropped').map((row) => row.source_video_id).filter(Boolean));
  const ranked = highlightSlicerService.rankSourcesForCutSelection(ready.map((item) => item.id))
    .filter((row) => !usedSourceIds.has(row.videoId));
  return ranked.slice(0, limitPairs).map((row) => ({
    ...row,
    source: ready.find((item) => item.id === row.videoId)
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const assignments = highlightDb.listAbAssignments();
  const currentPairCount = experimentPairCount(assignments);
  const remainingPairs = Math.max(0, TARGET_PAIR_COUNT - currentPairCount);
  const createLimit = Math.min(options.limitPairs, remainingPairs);
  const chosenSources = chooseReadySources(createLimit);
  const createdPairs = [];
  for (const source of chosenSources) {
    const pair = await abExperimentService.createPair(source.videoId);
    createdPairs.push({
      source: {
        videoId: source.videoId,
        title: source.title,
        score: source.score,
        tier: source.tier,
        hardMatchCount: source.hardMatchCount
      },
      pair
    });
  }
  const afterAssignments = highlightDb.listAbAssignments();
  const afterPairCount = experimentPairCount(afterAssignments);
  console.log(JSON.stringify({
    createdPairs,
    summary: {
      pairsCreatedToday: createdPairs.length,
      cumulativePairCount: afterPairCount,
      targetPairCount: TARGET_PAIR_COUNT
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: true, message: error.message, code: error.code || '', details: error.details || null }, null, 2));
  process.exit(1);
});
