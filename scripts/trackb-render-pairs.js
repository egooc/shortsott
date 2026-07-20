const path = require('path');
const { spawnSync } = require('child_process');
const highlightDb = require('../server/services/highlightPatternDbService');

function parseArgs(argv = []) {
  const pairIds = [];
  argv.forEach((arg) => {
    if (arg.startsWith('--pairIds=')) {
      pairIds.push(...String(arg.split('=')[1] || '').split(',').map((id) => id.trim()).filter(Boolean));
    }
  });
  return { pairIds };
}

function parseJsonPayload(stdout = '') {
  const text = String(stdout || '').trim();
  const chunks = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{' || char === '[') chunks.push(text.slice(index));
  }
  for (const chunk of chunks) {
    try {
      return JSON.parse(chunk);
    } catch {
      // try next chunk
    }
  }
  throw new Error(`No JSON payload found in output: ${text}`);
}

async function main() {
  const { pairIds } = parseArgs(process.argv.slice(2));
  const requestedPairIds = pairIds.length
    ? pairIds
    : [...new Set(highlightDb.listAbAssignments().filter((row) => row.status === 'assigned').map((row) => row.pair_id))];
  const outputs = [];

  for (const pairId of requestedPairIds) {
    const pair = highlightDb.getAbPair(pairId) || [];
    for (const member of pair) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'trackb-render-assignment.js'), `--assignmentId=${member.id}`], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        stdio: 'pipe'
      });
      const stdout = String(result.stdout || '').trim();
      const stderr = String(result.stderr || '').trim();
      if (result.status !== 0) {
        throw new Error(`trackb-render-assignment failed (${result.status}) for ${member.id}: ${stderr || stdout}`);
      }
      const parsed = parseJsonPayload(stdout);
      if (parsed.validDuration) {
        highlightDb.updateAbAssignmentStatus(parsed.assignmentId, {
          status: 'produced',
          jobId: `trackb_daily_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
          now: new Date().toISOString()
        });
      }
      outputs.push(parsed);
    }
  }

  console.log(JSON.stringify({ outputs }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: true, message: error.message, code: error.code || '', details: error.details || null }, null, 2));
  process.exit(1);
});
