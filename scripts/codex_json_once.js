#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { runCodexCli } = require('../server/services/gptMidformCliService');

async function main() {
  const [promptPath, schemaPath] = process.argv.slice(2);
  if (!promptPath || !schemaPath) {
    throw new Error('Usage: node scripts/codex_json_once.js <promptPath> <schemaPath>');
  }

  const resolvedPromptPath = path.resolve(promptPath);
  const resolvedSchemaPath = path.resolve(schemaPath);
  const prompt = fs.readFileSync(resolvedPromptPath, 'utf8');
  const result = await runCodexCli(prompt, { outputSchemaPath: resolvedSchemaPath });
  process.stdout.write(JSON.stringify({
    stdout: result.stdout,
    stderr: result.stderr,
    outputText: result.outputText,
    outputPath: result.outputPath,
    promptPath: result.promptPath,
    command: result.command,
    args: result.args
  }));
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({
    message: error.message || 'codex_json_once failed',
    code: error.code || 'CODEX_JSON_ONCE_FAILED',
    details: error.details || {}
  }));
  process.exit(1);
});
