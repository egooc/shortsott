const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECT_ROOT } = require('../services/pipelinePaths');

const WIN = process.platform === 'win32';

function exeName(baseName) {
  if (!WIN) return baseName;
  return baseName.toLowerCase().endsWith('.exe') ? baseName : `${baseName}.exe`;
}

function candidateRoots() {
  const roots = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'tools'));
  }
  roots.push(path.join(PROJECT_ROOT, 'tools'));
  return roots;
}

function bundledCandidates(baseName) {
  const name = exeName(baseName);
  const candidates = [];
  for (const root of candidateRoots()) {
    candidates.push(path.join(root, 'bin', name));
    candidates.push(path.join(root, name));
    if (baseName === 'python') {
      candidates.push(path.join(root, 'python', name));
      candidates.push(path.join(root, 'python', 'python.exe'));
    }
  }
  return candidates;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function findOnPath(command) {
  const finder = WIN ? 'where.exe' : 'which';
  const result = spawnSync(finder, [command], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function resolveTool(baseName, options = {}) {
  const envKey = options.envKey || `${String(baseName).toUpperCase().replace(/-/g, '_')}_PATH`;
  const envValue = process.env[envKey];
  if (envValue && fs.existsSync(envValue)) return envValue;

  const bundled = firstExisting(bundledCandidates(baseName));
  if (bundled) return bundled;

  const command = options.command || exeName(baseName);
  return findOnPath(command) || command;
}

function getToolEnv(extra = {}) {
  const toolsBin = firstExisting(candidateRoots().map((root) => path.join(root, 'bin')));
  const nextEnv = {
    ...process.env,
    FFMPEG_PATH: resolveTool('ffmpeg'),
    FFPROBE_PATH: resolveTool('ffprobe'),
    YT_DLP_PATH: resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' }),
    PYTHON_PATH: resolveTool('python'),
    ...extra
  };
  if (toolsBin) {
    nextEnv.PATH = `${toolsBin}${path.delimiter}${nextEnv.PATH || ''}`;
  }
  return nextEnv;
}

module.exports = {
  resolveTool,
  getToolEnv,
  findOnPath
};
