const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '../..');

const PROJECT_DIRS = {
  analysis: path.join(PROJECT_ROOT, 'analysis'),
  script: path.join(PROJECT_ROOT, 'script'),
  input: path.join(PROJECT_ROOT, 'input'),
  output: path.join(PROJECT_ROOT, 'output'),
  work: path.join(PROJECT_ROOT, 'work'),
  config: path.join(PROJECT_ROOT, 'config'),
  assets: path.join(PROJECT_ROOT, 'assets'),
  bgmProcess: path.join(PROJECT_ROOT, 'assets', 'bgm', 'process')
};

function ensureProjectFolders() {
  Object.values(PROJECT_DIRS).forEach((dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  });
}

function timestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function writeJsonWithBackup(targetPath, data) {
  ensureProjectFolders();

  const dirPath = path.dirname(targetPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let backupPath = null;
  if (fs.existsSync(targetPath)) {
    const parsed = path.parse(targetPath);
    backupPath = path.join(parsed.dir, `${parsed.name}.backup.${timestamp()}${parsed.ext || '.json'}`);
    fs.copyFileSync(targetPath, backupPath);
  }

  fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { targetPath, path: targetPath, backupPath };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  PROJECT_ROOT,
  PROJECT_DIRS,
  ensureProjectFolders,
  writeJsonWithBackup,
  readJsonIfExists
};
