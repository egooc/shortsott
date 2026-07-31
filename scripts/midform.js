#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const {
  exportChannelSheetCsv,
  listUnusedChannelsFromSheet
} = require('../server/services/midformMaterialsService');
const {
  runCompression,
  runCompressionApply,
  refreshCompressionPlan
} = require('../server/services/midformCompressionService');
const { runBootstrapToPipeline } = require('../server/services/midformBootstrapAdapterService');
const { runMidformTemplateAttemptBatch, runMidformTemplateWorkflow } = require('../server/services/midformRunTemplateService');
const { runMidformFullAutoWorkflow } = require('../server/services/midformFullAutoService');

const DEFAULT_CHANNEL_SHEET_PATH = path.join(PROJECT_ROOT, 'midform', 'materials', 'channels_sheet.csv');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

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
    if (flag === '--preflight-only') {
      options.preflightOnly = true;
      continue;
    }
    if (flag === '--force-download') {
      options.forceDownload = true;
      continue;
    }
    const nextValue = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (flag === '--profile') options.profile = nextValue;
    if (flag === '--analysis-mode') options.analysisMode = nextValue;
    if (flag === '--template') options.template = nextValue;
    if (flag === '--manifest') options.manifest = nextValue;
    if (flag === '--resume') options.resume = nextValue;
    if (flag === '--csv') options.csv = nextValue;
    if (flag === '--context-file') options.contextFile = nextValue;
    if (flag === '--out') options.out = nextValue;
    if (flag === '--source') options.source = nextValue;
    if (flag === '--target') options.target = nextValue;
    if (flag === '--mode') options.mode = nextValue;
    if (flag === '--name') options.name = nextValue;
    if (flag === '--option') options.option = nextValue;
    if (flag === '--variant') options.variant = nextValue;
    if (flag === '--reason') options.reason = nextValue;
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
     '  node scripts/midform.js compress --source https://youtu.be/ngYmFVO_bzM --target 160',
      '  node scripts/midform.js compress-refresh <runId>',
      '  node scripts/midform.js compress-apply <runId>',
      '  node scripts/midform.js run --source https://youtu.be/xxxx',
      '  node scripts/midform.js run --source https://youtu.be/xxxx --mode full_auto',
      '  node scripts/midform.js run --template midform/skills/midform-run/templates/production_base.md',
      '  node scripts/midform.js run --template midform/skills/midform-run/templates/production_base.md --profile production',
      '  node scripts/midform.js run --template midform/skills/midform-run/templates/production_base.md --analysis-mode auto',
      '  node scripts/midform.js batch --manifest midform/batch_manifest.json',
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
  if (command === 'run') {
    const templatePath = options.template || subcommand;
    if (!templatePath && options.source) {
      const result = await runMidformFullAutoWorkflow({
        source: options.source,
        target: options.target,
        profile: options.profile,
        analysisMode: options.analysisMode,
        mode: options.mode || 'full_auto'
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (!templatePath) throw new Error('run requires --template <path/to/template.md> or --source <YOUTUBE_URL>');
    const result = await runMidformTemplateWorkflow({
      templatePath,
      profile: options.profile,
      analysisMode: options.analysisMode,
      source: options.source,
      resume: options.resume,
      target: options.target
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'batch') {
    if (!options.manifest) throw new Error('batch requires --manifest <path/to/batch_manifest.json>');
    const result = await runMidformTemplateAttemptBatch({
      manifestPath: options.manifest,
      templatePath: options.template || subcommand,
      profile: options.profile,
      analysisMode: options.analysisMode,
      target: options.target
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'compress-apply') {
    const result = await runCompressionApply(subcommand, { contextFile: options.contextFile });
    const lines = [
      `slot_fills_path: ${path.relative(PROJECT_ROOT, result.slotFillsPath).replace(/\\/g, '/')}`,
      `upload_text_path: ${path.relative(PROJECT_ROOT, result.uploadTextPath).replace(/\\/g, '/')}`,
      `edit_plan_path: ${path.relative(PROJECT_ROOT, result.editPlanPath).replace(/\\/g, '/')}`,
      `slot_qc_report_path: ${path.relative(PROJECT_ROOT, result.slotQcReportPath).replace(/\\/g, '/')}`,
      `apply_state_path: ${path.relative(PROJECT_ROOT, path.join(result.runDir, 'compress_apply_state.json')).replace(/\\/g, '/')}`,
      `pipeline_bootstrap_connected: ${result.pipelineBootstrapConnected}`,
      `context_provided: ${result.contextProvided === true}${result.contextFile ? ` (${path.relative(PROJECT_ROOT, result.contextFile).replace(/\\/g, '/')})` : ''}`,
      result.note
    ];
    if (Array.isArray(result.durationWarnings) && result.durationWarnings.length) {
      lines.push('', 'DURATION WARNINGS (narration exceeds available teaser footage):');
      for (const warning of result.durationWarnings) {
        lines.push(`- ${warning.slot_id} (${warning.role}): ${warning.duration_check.suggested_action}`);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }
  if (command === 'compress-refresh') {
    const result = await refreshCompressionPlan(subcommand);
    process.stdout.write([
      `edit_plan_path: ${path.relative(PROJECT_ROOT, result.editPlanPath).replace(/\\/g, '/')}`,
      `narrative_beats_md: ${path.relative(PROJECT_ROOT, result.markdownPath).replace(/\\/g, '/')}`,
      `teaser_visual_beat_id: ${result.coldOpenSelection?.teaser_visual_beat_id || ''}`,
      `estimated_total_sec: ${result.durationBudget?.estimated_total_sec || ''}`
    ].join('\n') + '\n');
    return;
  }
  if (command === 'bootstrap') {
    const result = await runBootstrapToPipeline(subcommand, {
      preflightOnly: options.preflightOnly === true,
      forceDownload: options.forceDownload === true
    });
    const lines = [
      `run_dir: ${path.relative(PROJECT_ROOT, result.runDir).replace(/\\/g, '/')}`,
      `source_video_path: ${result.sourceVideoPath ? path.relative(PROJECT_ROOT, result.sourceVideoPath).replace(/\\/g, '/') : '(none)'}`,
      `script_path: ${path.relative(PROJECT_ROOT, result.paths.outScriptPath).replace(/\\/g, '/')}`,
      `preflight_ok: ${result.preflight.ok}`
    ];
    for (const check of result.preflight.checks) {
      lines.push(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    if (Array.isArray(result.warnings) && result.warnings.length) {
      lines.push('', 'WARNINGS:');
      for (const warning of result.warnings.slice(0, 25)) lines.push(`- ${warning}`);
    }
    if (result.rendered) {
      lines.push('', `pipeline_run_id: ${result.pipelineRunId}`, `pipeline_run_dir: ${path.relative(PROJECT_ROOT, result.pipelineRunDir).replace(/\\/g, '/')}`);
    } else if (result.ok) {
      lines.push('', 'preflight-only: passed, startRun NOT invoked (drop --preflight-only to render)');
    } else {
      lines.push('', `BLOCKED: ${result.blocked}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
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
