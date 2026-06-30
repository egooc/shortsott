#!/usr/bin/env node
const { ensureProjectFolders } = require('../server/services/pipelinePaths');
const { generateClaudeScript } = require('../server/services/claudeCliService');

async function main() {
  ensureProjectFolders();
  const result = await generateClaudeScript();
  console.log(`Saved: ${result.savedPath}`);
  if (result.backupPath) {
    console.log(`Backup: ${result.backupPath}`);
  }
  console.log(
    JSON.stringify(
      {
        summary: result.summary
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.message || String(error));
  if (error?.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exit(1);
});
