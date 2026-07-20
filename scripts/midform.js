#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const {
  exportChannelSheetCsv,
  listUnusedChannelsFromSheet
} = require('../server/services/midformMaterialsService');
const {
  runCompression,
  runCompressionApply
} = require('../server/services/midformCompressionService');

const DEFAULT_CHANNEL_SHEET_PATH = path.join(PROJECT_ROOT, 'midform', 'materials', 'channels_sheet.csv');

function encodeCsvValue(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [flag, inlineValue] = token.split('=', 2);
    if (flag === '--help') {
      options.help = true;
      continue;
    }
    const nextValue = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (flag === '--csv') options.csv = nextValue;
    if (flag === '--out') options.out = nextValue;
    if (flag === '--source') options.source = nextValue;
    if (flag === '--target') options.target = nextValue;
  }
  return { positionals, options };
}

function resolveProjectPath(value, fallback) {
  const target = value ? String(value).trim() : fallback;
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.join(PROJECT_ROOT, target);
}

function printUsage() {
  const lines = [
    'Usage:',
    '  node scripts/midform.js channels',
    '  node scripts/midform.js channels --csv path/to/channels_sheet.csv',
    '  node scripts/midform.js channels export',
    '  node scripts/midform.js channels export --out path/to/channels_sheet.csv',
    '  node scripts/midform.js compress --source https://youtu.be/ngYmFVO_bzM --target 180',
    '  node scripts/midform.js compress-apply <runId>',
    '',
    'Default sheet path:',
    `  ${path.relative(PROJECT_ROOT, DEFAULT_CHANNEL_SHEET_PATH).replace(/\\/g, '/')}`
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printUnusedChannels(rows) {
  process.stdout.write('channel_name,channel_url\n');
  for (const row of rows) {
    const channelName = row.channelName || row.channelHandle || '';
    process.stdout.write(`${encodeCsvValue(channelName)},${encodeCsvValue(row.channelUrl)}\n`);
  }
}

function requireExistingFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Channel sheet not found: ${path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/')}\n` +
      'Run `node scripts/midform.js channels export` first, then import that CSV into Google Sheets and export it back to the same path or pass `--csv`.'
    );
  }
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command, subcommand] = positionals;
  if (options.help || !command) {
    printUsage();
    return;
  }
  if (command === 'compress') {
    const result = await runCompression(options.source, { target: options.target });
    process.stdout.write([
      `Phase 1 artifacts ready for review: ${result.runId}`,
      `run_dir: ${path.relative(PROJECT_ROOT, result.paths.runDir).replace(/\\/g, '/')}`,
      `narrative_beats_md: ${path.relative(PROJECT_ROOT, result.paths.markdownPath).replace(/\\/g, '/')}`,
      `edit_plan_json: ${path.relative(PROJECT_ROOT, result.paths.editPlanPath).replace(/\\/g, '/')}`,
      `heatmap_status: ${result.heatmapStatus}`,
      `pipeline_bootstrap_connected: ${result.pipelineBootstrapConnected}`
    ].join('\n') + '\n');
    return;
  }
  if (command === 'compress-apply') {
    const result = await runCompressionApply(subcommand);
    process.stdout.write([
      `slot_fills_path: ${path.relative(PROJECT_ROOT, result.slotFillsPath).replace(/\\/g, '/')}`,
      `apply_state_path: ${path.relative(PROJECT_ROOT, path.join(result.runDir, 'compress_apply_state.json')).replace(/\\/g, '/')}`,
      `pipeline_bootstrap_connected: ${result.pipelineBootstrapConnected}`,
      result.note
    ].join('\n') + '\n');
    return;
  }
  if (command !== 'channels') {
    throw new Error(`Unknown command: ${command}`);
  }

  if (subcommand === 'export') {
    const outputPath = resolveProjectPath(options.out, DEFAULT_CHANNEL_SHEET_PATH);
    const result = exportChannelSheetCsv(outputPath);
    process.stdout.write(`Exported ${result.rows} channels to ${path.relative(PROJECT_ROOT, result.filePath).replace(/\\/g, '/')}\n`);
    return;
  }

  const csvPath = resolveProjectPath(options.csv || process.env.MIDFORM_CHANNELS_CSV, DEFAULT_CHANNEL_SHEET_PATH);
  requireExistingFile(csvPath);
  printUnusedChannels(listUnusedChannelsFromSheet(csvPath));
}

try {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
