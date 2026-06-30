const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '../..');
const EXPORT_ROOT = path.join(__dirname, '../output/process_exports');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_error) {
    return false;
  }
}

function findCapCutExecutable() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'CapCut', 'Apps', 'CapCut.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'CapCut', 'CapCut.exe'),
    path.join(process.env.PROGRAMFILES || '', 'CapCut', 'CapCut.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'CapCut', 'CapCut.exe')
  ].filter(Boolean);

  return candidates.find(fileExists) || '';
}

function resolveDraftFolder(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const error = new Error('draftFolder is required');
    error.status = 400;
    throw error;
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(REPO_ROOT, raw);
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function maybeOpenPath(targetPath) {
  if (process.platform !== 'win32' || !targetPath) return false;
  spawn('explorer.exe', [targetPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref();
  return true;
}

function maybeLaunchCapCut(capcutExe) {
  if (!capcutExe || process.platform !== 'win32') return false;
  spawn(capcutExe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref();
  return true;
}

function createCapcutExportRequest(options = {}) {
  ensureDir(EXPORT_ROOT);
  const draftFolder = resolveDraftFolder(options.draftFolder);
  const draftContentPath = path.join(draftFolder, 'draft_content.json');
  const draftMetaPath = path.join(draftFolder, 'draft_meta_info.json');
  if (!fileExists(draftContentPath) || !fileExists(draftMetaPath)) {
    const error = new Error('CapCut draft folder must contain draft_content.json and draft_meta_info.json');
    error.status = 400;
    error.details = { draftFolder };
    throw error;
  }

  const timestamp = Date.now();
  const requestId = `capcut_export_${timestamp}`;
  const outputFile = String(options.outputFile || '').trim()
    || path.join(EXPORT_ROOT, `${path.basename(draftFolder)}.mp4`);
  const capcutExe = findCapCutExecutable();
  const shouldOpen = options.openCapCut === true;
  const openedDraftFolder = shouldOpen ? maybeOpenPath(draftFolder) : false;
  const launchedCapCut = shouldOpen ? maybeLaunchCapCut(capcutExe) : false;

  const report = {
    requestId,
    status: 'manual_action_required',
    fullyAutomated: false,
    reason: 'CapCut does not expose a verified local CLI export command in this project yet.',
    draftFolder,
    outputFile,
    capcutExecutable: capcutExe,
    openedDraftFolder,
    launchedCapCut,
    createdAt: new Date(timestamp).toISOString(),
    nextManualSteps: [
      'Open the generated draft in CapCut.',
      'Confirm video transforms, BGM, channel tag, and explainer captions.',
      `Export manually to: ${outputFile}`
    ]
  };

  const jsonPath = path.join(EXPORT_ROOT, `${requestId}.json`);
  const notesPath = path.join(EXPORT_ROOT, `${requestId}.md`);
  writeText(jsonPath, JSON.stringify(report, null, 2));
  writeText(notesPath, [
    '# CapCut Export Automation Request',
    '',
    `- Request ID: ${requestId}`,
    `- Status: ${report.status}`,
    `- Fully Automated: ${String(report.fullyAutomated)}`,
    `- Draft Folder: ${draftFolder}`,
    `- Output File: ${outputFile}`,
    `- CapCut Executable: ${capcutExe || 'not found'}`,
    `- Reason: ${report.reason}`,
    '',
    '## Manual Steps',
    ...report.nextManualSteps.map((step) => `- ${step}`)
  ].join('\n'));

  return {
    ...report,
    reportPath: jsonPath,
    notesPath
  };
}

module.exports = {
  createCapcutExportRequest
};
