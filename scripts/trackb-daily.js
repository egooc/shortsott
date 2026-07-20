const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv = []) {
  const options = {
    limitPairs: 6,
    targetReady: 30,
    maxNewSources: 30,
    sourceIds: []
  };
  argv.forEach((arg) => {
    if (arg.startsWith('--limitPairs=')) {
      const value = Number(arg.split('=')[1]);
      options.limitPairs = Number.isFinite(value) ? Math.max(0, value) : 6;
    } else if (arg.startsWith('--targetReady=')) {
      const value = Number(arg.split('=')[1]);
      options.targetReady = Number.isFinite(value) ? Math.max(0, value) : 30;
    } else if (arg.startsWith('--maxNewSources=')) {
      const value = Number(arg.split('=')[1]);
      options.maxNewSources = Number.isFinite(value) ? Math.max(0, value) : 30;
    }
    else if (arg.startsWith('--sourceIds=')) options.sourceIds = String(arg.split('=')[1] || '').split(',').map((id) => id.trim()).filter(Boolean);
  });
  return options;
}

function runNodeScript(scriptName, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, scriptName), ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    stdio: 'pipe'
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    throw new Error(`${scriptName} failed (${result.status}): ${stderr || stdout}`);
  }
  const trimmed = stdout.trim();
  const candidates = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '{' || char === '[') candidates.push(trimmed.slice(index));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning for the JSON payload
    }
  }
  throw new Error(`${scriptName} did not emit a JSON payload. Output: ${stdout}`);
}

function flattenCreatedPairIds(createdPairs = []) {
  return (Array.isArray(createdPairs) ? createdPairs : [])
    .map((entry) => entry?.pair?.pairId)
    .filter(Boolean);
}

function flattenRenderedPairs(outputs = []) {
  const byPair = new Map();
  (Array.isArray(outputs) ? outputs : []).forEach((item) => {
    if (!item?.pairId) return;
    if (!byPair.has(item.pairId)) byPair.set(item.pairId, []);
    byPair.get(item.pairId).push(item);
  });
  return [...byPair.entries()].map(([pairId, drafts]) => ({ pairId, drafts }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const setup = runNodeScript('trackb-setup.js');

  const topupArgs = [
    `--targetReady=${options.targetReady}`,
    `--maxNewSources=${options.maxNewSources}`
  ];
  if (options.sourceIds.length) topupArgs.push(`--sourceIds=${options.sourceIds.join(',')}`);
  const topup = runNodeScript('trackb-topup-sources.js', topupArgs);

  const createPairs = runNodeScript('trackb-create-pairs.js', [`--limitPairs=${options.limitPairs}`]);
  const createdPairIds = flattenCreatedPairIds(createPairs.createdPairs);

  const renderArgs = createdPairIds.length ? [`--pairIds=${createdPairIds.join(',')}`] : [];
  const rendered = runNodeScript('trackb-render-pairs.js', renderArgs);

  const renderedPairs = flattenRenderedPairs(rendered.outputs || []);
  const slotSchedule = renderedPairs
    .flatMap((pair) => pair.drafts.map((draft) => ({
      pairId: pair.pairId,
      assignmentId: draft.assignmentId,
      groupLabel: draft.groupLabel,
      targetDurationGroup: draft.targetDurationGroup,
      scheduledPublishAt: draft.scheduledPublishAt,
      outputFolder: draft.outputFolder
    })))
    .sort((a, b) => String(a.scheduledPublishAt).localeCompare(String(b.scheduledPublishAt)));

  console.log(JSON.stringify({
    channel: setup.channel,
    smokeExcluded: setup.smokeExcluded,
    partialExcluded: setup.partialExcluded,
    pool: topup,
    createdPairs: createPairs.createdPairs || [],
    renderedPairs,
    summary: {
      pairsCreatedToday: createdPairIds.length,
      renderedPairCount: renderedPairs.length,
      cumulativePairCount: createPairs.summary?.cumulativePairCount || 0,
      targetPairCount: createPairs.summary?.targetPairCount || 30,
      slotSchedule
    }
  }, null, 2));
}

main();
